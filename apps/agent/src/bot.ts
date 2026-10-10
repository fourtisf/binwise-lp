import { assessPool, positionSizeUsd, type AgentParams } from '@binwise/core';
import { liveLimits } from '@binwise/chain';
import {
  activeParams,
  assessmentInput,
  strategySettings,
  strategyWeights,
  vaultValue,
  type PrismaClient,
  type Strategy,
  type Vault,
} from '@binwise/db';
import { MIN_POSITION_USD } from './agent';
import type { Keyboard, TelegramApi, TgCallback, TgMessage, TgUpdate } from './telegram';

/**
 * The Binwise Telegram bot: one simple button menu.
 *   📊 Status · ➕ Add LP · 💼 Positions · ⏸ Pause / ▶️ Resume
 * The agent runs on its own; the bot lets the owner check on it and add or close LP by hand.
 * Every trade goes through the agent's own queue and checks (same as the website).
 */

/** A manual request for the agent worker (shared with the website's Claim / Close). */
export interface ManualRequest {
  id: string;
  action: 'claim' | 'close' | 'deploy';
  positionId?: string;
  poolId?: string;
  /** Deploy size in USD; 0 = let the agent pick */
  usd?: number;
  /** Telegram chat to report the result to */
  chatId?: string;
}

export interface BotDeps {
  db: PrismaClient;
  tg: TelegramApi;
  /** Queue a manual request for the agent worker. */
  enqueue: (vaultId: string, req: ManualRequest) => Promise<void>;
  /** Tell the app a vault was paused (so its live cycle card updates). */
  onPaused?: (vault: Vault) => Promise<void>;
  /** e.g. https://binwise.org */
  appUrl: string;
  params?: () => Promise<AgentParams>;
  now?: () => number;
}

type Ctx = { chatId: string; vault: Vault & { strategy: Strategy | null } };
type Screen = { text: string; keyboard?: Keyboard };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const usd = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });
const pct = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
const AMOUNTS = [50, 100, 250, 500, 1000];

export const BOT_COMMANDS = [
  { command: 'menu', description: 'Show the menu' },
  { command: 'status', description: 'Vault value and what the agent is doing' },
  { command: 'add', description: 'Add liquidity to a pool' },
  { command: 'positions', description: 'Your open positions' },
];

export function makeBot(d: BotDeps) {
  const { db, tg } = d;
  const now = () => (d.now ?? Date.now)();

  const modeLabel = (v: Vault) => (v.mode === 'live' ? '🔴 LIVE (real funds)' : '🧪 Paper (simulated money)');

  const menu = (v: Vault): Keyboard => [
    [
      { text: '📊 Status', callback_data: 'st' },
      { text: '➕ Add LP', callback_data: 'add' },
    ],
    [
      { text: '💼 Positions', callback_data: 'pos' },
      v.status === 'running' ? { text: '⏸ Pause agent', callback_data: 'pause' } : { text: '▶️ Resume agent', callback_data: 'resume' },
    ],
    [{ text: '🌐 Open app', url: `${d.appUrl}/app` }],
  ];
  const back: Keyboard = [[{ text: '⬅️ Menu', callback_data: 'menu' }]];

  async function context(chatId: string): Promise<Ctx | null> {
    const user = await db.user.findFirst({ where: { telegramChatId: chatId } });
    if (!user) return null;
    const vault = await db.vault.findFirst({ where: { userId: user.id, isDemo: false }, include: { strategy: true }, orderBy: { createdAt: 'asc' } });
    return vault ? { chatId, vault } : null;
  }

  const notLinked: Screen = {
    text: `👋 <b>Welcome to Binwise</b>\n\nThis chat isn't connected to a vault yet.\n\n1. Open ${esc(d.appUrl)}/app and connect your wallet\n2. Go to <b>Strategy</b> → turn on <b>Telegram alerts</b>\n3. Press <b>Start</b> in the chat that opens`,
  };

  // ---------------------------------------------------------------- screens

  const welcome = (c: Ctx): Screen => ({
    text:
      `👋 <b>Binwise</b> · ${esc(c.vault.name)}\n${modeLabel(c.vault)}\n\n` +
      `The agent runs by itself every minute: it picks pools, adds liquidity, rebalances when it pays and exits before downtrends.\n\n` +
      `Use the buttons to check on it, or add LP yourself.`,
    keyboard: menu(c.vault),
  });

  async function money(vaultId: string) {
    const v = await vaultValue(db, vaultId);
    const open = await db.position.findMany({ where: { vaultId, status: 'open' }, include: { pool: true }, orderBy: { openedAt: 'asc' } });
    const inPositions = open.reduce((s, p) => s + p.valueUsd + p.feesUnclaimedUsd, 0);
    return { ...v, open, idle: Math.max(0, v.value - inPositions), netVsHold: v.hold > 0 ? (v.value / v.hold - 1) * 100 : 0 };
  }

  async function status(c: Ctx): Promise<Screen> {
    const m = await money(c.vault.id);
    const last = await db.decision.findFirst({ where: { vaultId: c.vault.id, NOT: { type: 'scan' } }, orderBy: { ts: 'desc' } });
    const agent = c.vault.status === 'running' ? `▶️ Running · cycle ${c.vault.cycle}` : `⏸ Paused${c.vault.pausedReason ? ` (${esc(c.vault.pausedReason)})` : ''}`;
    return {
      text:
        `📊 <b>${esc(c.vault.name)}</b>\n${modeLabel(c.vault)}\nAgent: ${agent}\n\n` +
        `Value: <b>${usd(m.value)}</b>\n` +
        `Net vs holding: <b>${pct(m.netVsHold)}</b>\n` +
        `Idle (not in a pool): ${usd(m.idle)}\n` +
        `Positions: ${m.open.length} (${m.open.filter((p) => p.inRange).length} in range)\n` +
        (last ? `\n🕒 Last: <b>${esc(last.title)}</b>\n${esc(last.reason).slice(0, 300)}` : ''),
      keyboard: menu(c.vault),
    };
  }

  /** Pools the agent rates safe to enter right now for this vault's strategy (best first). */
  async function eligiblePools(c: Ctx) {
    const params = d.params ? await d.params() : await activeParams(db);
    const snaps = await db.poolSnapshot.findMany({
      where: { ts: { gte: new Date(now() - 10 * 60_000) } },
      distinct: ['poolId'],
      orderBy: [{ poolId: 'asc' }, { ts: 'desc' }],
      include: { pool: true },
    });
    const mints = [...new Set(snaps.flatMap((s) => [s.pool.mintA, s.pool.mintB]))];
    const tokens = new Map((await db.token.findMany({ where: { mint: { in: mints } } })).map((t) => [t.mint, t]));
    const held = new Set((await db.position.findMany({ where: { vaultId: c.vault.id, status: 'open' }, select: { poolId: true } })).map((p) => p.poolId));
    const out = [];
    for (const s of snaps) {
      const tx = tokens.get(s.pool.mintA);
      const ty = tokens.get(s.pool.mintB);
      if (held.has(s.poolId) || tx?.priceUsd == null || ty?.priceUsd == null) continue;
      const a = assessPool(await assessmentInput(s, tx, ty, params), strategySettings(c.vault.strategy!), strategyWeights(c.vault.strategy!), params);
      if (a.eligible) out.push({ snap: s, score: a.score, pair: `${s.pool.tokenA} / ${s.pool.tokenB}` });
    }
    return { pools: out.sort((x, y) => y.score - x.score).slice(0, 5), params };
  }

  async function pools(c: Ctx): Promise<Screen> {
    const { pools } = await eligiblePools(c);
    if (!pools.length)
      return { text: '➕ <b>Add LP</b>\n\nNo pool passes the agent\'s safety checks right now. It keeps watching and will deploy by itself when one does.', keyboard: back };
    const lines = pools.map(
      (p, i) =>
        `${i + 1}. <b>${esc(p.pair)}</b> · score ${p.score}\n    Vol/TVL ${(p.snap.volume24h / Math.max(1, p.snap.tvl)).toFixed(1)}x · 7d ${p.snap.trend7d != null ? pct(p.snap.trend7d) : 'n/a'}`,
    );
    return {
      text: `➕ <b>Add LP</b>\n\nPools the agent rates safe to enter now (higher score = better):\n\n${lines.join('\n')}\n\nPick one:`,
      keyboard: [...pools.map((p) => [{ text: `${p.pair} · ${p.score}`, callback_data: `p|${p.snap.poolId}` }]), ...back],
    };
  }

  /** The size the agent would pick, and the most this vault may put in now. */
  async function sizing(c: Ctx, poolId: string) {
    const { pools, params } = await eligiblePools(c);
    const p = pools.find((x) => x.snap.poolId === poolId);
    if (!p) return null;
    const m = await money(c.vault.id);
    let max = Math.min(m.idle * 0.98, positionSizeUsd(m.value, strategySettings(c.vault.strategy!).maxAllocPct, p.snap.tvl, params));
    if (c.vault.mode === 'live') {
      const live = liveLimits();
      max = m.open.length >= live.maxPositions ? 0 : Math.min(max, live.maxUsd - m.open.reduce((s, x) => s + x.valueUsd, 0));
    }
    return { p, idle: m.idle, max: Math.max(0, max) };
  }

  async function amount(c: Ctx, poolId: string): Promise<Screen> {
    const z = await sizing(c, poolId);
    if (!z) return { text: "This pool doesn't pass the agent's checks anymore. Pick another one.", keyboard: [[{ text: '⬅️ Pools', callback_data: 'add' }]] };
    if (z.max < MIN_POSITION_USD)
      return {
        text: `<b>${esc(z.p.pair)}</b>\n\nNot enough idle funds within your limits (at least ${usd(MIN_POSITION_USD)} is needed; you can add up to ${usd(z.max)} now). Deposit in the app first.`,
        keyboard: back,
      };
    const options = AMOUNTS.filter((a) => a <= z.max);
    return {
      text: `<b>${esc(z.p.pair)}</b> · score ${z.p.score}\n\nHow much? Idle: ${usd(z.idle)} · max for this pool now: ${usd(z.max)}`,
      keyboard: [
        ...(options.length ? [options.map((a) => ({ text: usd(a), callback_data: `a|${poolId}|${a}` }))] : []),
        [{ text: `🤖 Let the agent decide (${usd(z.max)})`, callback_data: `a|${poolId}|0` }],
        [{ text: '⬅️ Pools', callback_data: 'add' }],
      ],
    };
  }

  async function confirmAdd(c: Ctx, poolId: string, amt: number): Promise<Screen> {
    const z = await sizing(c, poolId);
    if (!z) return { text: "This pool doesn't pass the agent's checks anymore.", keyboard: [[{ text: '⬅️ Pools', callback_data: 'add' }]] };
    const size = amt > 0 ? Math.min(amt, z.max) : z.max;
    return {
      text:
        `Add <b>${usd(size)}</b> to <b>${esc(z.p.pair)}</b>?\n\n` +
        `• The agent swaps what's needed and opens the position.\n` +
        `• Then it manages it 24/7: rebalances when it pays, exits on downtrends.\n` +
        `• ${modeLabel(c.vault)}` +
        (c.vault.mode === 'live' ? '\n\n⚠️ This uses real funds. No strategy is guaranteed to profit.' : ''),
      keyboard: [
        [
          { text: '✅ Confirm', callback_data: `go|${poolId}|${amt}` },
          { text: '✖️ Cancel', callback_data: 'menu' },
        ],
      ],
    };
  }

  async function positions(c: Ctx): Promise<Screen> {
    const m = await money(c.vault.id);
    if (!m.open.length) return { text: '💼 <b>Positions</b>\n\nNo open positions yet. Tap ➕ Add LP, or let the agent deploy by itself.', keyboard: menu(c.vault) };
    const lines = m.open.map(
      (p, i) =>
        `${i + 1}. <b>${esc(p.pool.tokenA)} / ${esc(p.pool.tokenB)}</b> ${p.inRange ? '🟢 in range' : '🟠 out of range'}\n` +
        `    Value ${usd(p.valueUsd)} · fees ${usd(p.feesUnclaimedUsd + p.feesClaimedUsd)} · vs hold ${pct(p.netVsHold)}`,
    );
    return {
      text: `💼 <b>Positions</b>\n\n${lines.join('\n')}`,
      keyboard: [
        ...m.open.map((p, i) => [
          { text: `💰 Claim fees #${i + 1}`, callback_data: `f|${p.id}` },
          { text: `✖️ Close #${i + 1}`, callback_data: `c|${p.id}` },
        ]),
        ...back,
      ],
    };
  }

  // ---------------------------------------------------------------- input

  async function link(chatId: string, code: string) {
    const user = await db.user.findUnique({ where: { telegramLinkCode: code } });
    if (!user) return tg.send(chatId, 'That link code is not valid or was already used. In the app, turn Telegram alerts off and on again to get a new one.');
    // One chat per wallet: unlink this chat from anyone else first.
    await db.user.updateMany({ where: { telegramChatId: chatId, NOT: { id: user.id } }, data: { telegramChatId: null } });
    await db.user.update({ where: { id: user.id }, data: { telegramChatId: chatId, telegramLinkCode: null } });
    const c = await context(chatId);
    if (c) {
      const w = welcome(c);
      await tg.send(chatId, `✅ Connected.\n\n${w.text}`, { html: true, keyboard: w.keyboard });
    }
  }

  async function onMessage(m: TgMessage) {
    if (m.chat.type !== 'private') return; // never act in groups
    const chatId = String(m.chat.id);
    const text = (m.text ?? '').trim();
    const code = text.match(/^\/start\s+(\S+)/)?.[1];
    if (code) return link(chatId, code);
    const c = await context(chatId);
    if (!c) return tg.send(chatId, notLinked.text, { html: true });
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    const screen =
      cmd === '/status' ? await status(c) : cmd === '/add' ? await pools(c) : cmd === '/positions' ? await positions(c) : welcome(c);
    await tg.send(chatId, screen.text, { html: true, keyboard: screen.keyboard });
  }

  async function onCallback(q: TgCallback) {
    const msg = q.message;
    if (!msg || msg.chat.type !== 'private' || !q.data) return tg.answer(q.id);
    const chatId = String(msg.chat.id);
    const c = await context(chatId);
    if (!c) {
      await tg.answer(q.id);
      return tg.edit(chatId, msg.message_id, notLinked.text, { html: true });
    }
    const [op, a, b] = q.data.split('|');
    const show = async (s: Screen, toast?: string) => {
      await tg.answer(q.id, toast);
      await tg.edit(chatId, msg.message_id, s.text, { html: true, keyboard: s.keyboard });
    };
    const requestId = `tg-${chatId}-${msg.message_id}`;

    switch (op) {
      case 'menu':
        return show(welcome(c));
      case 'st':
        return show(await status(c));
      case 'add':
        return show(await pools(c));
      case 'p':
        return show(await amount(c, a));
      case 'a':
        return show(await confirmAdd(c, a, Number(b) || 0));
      case 'go': {
        const z = await sizing(c, a);
        if (!z || z.max < MIN_POSITION_USD) return show(await amount(c, a), "Can't add here right now");
        const amt = Number(b) || 0;
        await d.enqueue(c.vault.id, { id: requestId, action: 'deploy', poolId: a, usd: amt > 0 ? Math.min(amt, z.max) : 0, chatId });
        return show({ text: `⏳ Adding LP to <b>${esc(z.p.pair)}</b>…\n\nYou'll get a message here when it's done (usually under a minute).` }, 'Sent to the agent');
      }
      case 'pos':
        return show(await positions(c));
      case 'f':
      case 'c':
      case 'cx': {
        const p = await db.position.findFirst({ where: { id: a, vaultId: c.vault.id, status: 'open' }, include: { pool: true } });
        if (!p) return show(await positions(c), 'That position is already closed');
        const pair = `${p.pool.tokenA} / ${p.pool.tokenB}`;
        if (op === 'c')
          return show({
            text: `Close <b>${esc(pair)}</b> (${usd(p.valueUsd)})?\n\nFunds and fees go back to your vault as idle balance. The agent may deploy them again later.`,
            keyboard: [
              [
                { text: '✅ Close it', callback_data: `cx|${p.id}` },
                { text: '✖️ Keep it', callback_data: 'pos' },
              ],
            ],
          });
        await d.enqueue(c.vault.id, { id: requestId + (op === 'f' ? `-f-${p.id}` : ''), action: op === 'f' ? 'claim' : 'close', positionId: p.id, chatId });
        if (op === 'f') return tg.answer(q.id, 'Claiming fees…');
        return show({ text: `⏳ Closing <b>${esc(pair)}</b>…\n\nYou'll get a message here when it's done.` }, 'Sent to the agent');
      }
      case 'pause':
      case 'resume': {
        const paused = op === 'pause';
        const v = await db.vault.update({
          where: { id: c.vault.id },
          data: { status: paused ? 'paused' : 'running', pausedReason: paused ? 'Paused from Telegram.' : null },
        });
        await db.decision.create({
          data: {
            vaultId: v.id,
            type: 'hold',
            title: paused ? 'Agent paused' : 'Agent resumed',
            reason: paused ? 'Paused from Telegram. Open positions stay as they are.' : 'Resumed from Telegram.',
            inputs: { manual: true },
          },
        });
        if (paused) await d.onPaused?.(v);
        return show(await status({ ...c, vault: { ...c.vault, ...v } }), paused ? 'Agent paused' : 'Agent resumed');
      }
      default:
        return show(welcome(c));
    }
  }

  return async (u: TgUpdate) => {
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  };
}

/** Message sent when the agent finishes a request from Telegram. */
export const resultMessage = (r: { title: string; text: string } | null, err?: string) =>
  err ? `❌ Couldn't do that: ${err}` : r ? `✅ ${r.title}\n\n${r.text}` : 'ℹ️ That was already done.';
