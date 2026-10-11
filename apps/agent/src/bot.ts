import { assessPool, positionSizeUsd, type AgentParams } from '@binwise/core';
import { SOL_MINT, isLiveTelegram, liveLimits, walletAddress } from '@binwise/chain';
import {
  ProposalError,
  activeParams,
  approveProposal,
  assessmentInput,
  createVault,
  pendingProposals,
  rejectProposal,
  strategySettings as settingsOf,
  strategySettings,
  strategyWeights,
  vaultValue,
  type PrismaClient,
  type Proposal,
  type Strategy,
  type User,
  type Vault,
} from '@binwise/db';
import { MIN_POSITION_USD } from './agent';
import { isBotWallet, shortAddress } from './wallet';
import type { Keyboard, TelegramApi, TgCallback, TgMessage, TgUpdate } from './telegram';

/**
 * The Binwise Telegram bot: one simple button menu.
 *   📊 Status · ➕ Add LP · 💼 Positions · 💳 Wallet · 🗳 Approvals · Mode · ⏸ Pause / ▶️ Resume
 * The agent runs on its own; the bot lets the owner check on it and add or close LP by hand.
 * New users can create a wallet right in the chat (no website needed), deposit to it, see its
 * private key and withdraw. Every trade and withdrawal goes through the agent's own queue and checks.
 */

/** A manual request for the agent worker (shared with the website's Claim / Close). */
export interface ManualRequest {
  id: string;
  action: 'claim' | 'close' | 'deploy' | 'proposal' | 'withdraw';
  positionId?: string;
  /** Manual mode: an approved proposal to carry out */
  proposalId?: string;
  poolId?: string;
  /** Deploy size in USD; 0 = let the agent pick */
  usd?: number;
  /** Withdraw: token, share of the idle balance (1–100) and destination */
  mint?: string;
  pct?: number;
  to?: string;
  /** Telegram chat to report the result to */
  chatId?: string;
}

/** Short-lived per-chat state (a withdrawal waiting for its address). Redis in production. */
export interface ChatState {
  get(chatId: string): Promise<string | null>;
  set(chatId: string, value: string, ttlSec: number): Promise<void>;
  del(chatId: string): Promise<void>;
}

export const memoryChatState = (): ChatState => {
  const m = new Map<string, { v: string; until: number }>();
  return {
    get: async (k) => {
      const e = m.get(k);
      return e && e.until > Date.now() ? e.v : null;
    },
    set: async (k, v, ttl) => void m.set(k, { v, until: Date.now() + ttl * 1000 }),
    del: async (k) => void m.delete(k),
  };
};

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
  /** On-chain balances of a wallet by mint (live vaults' Wallet screen). */
  balances?: (address: string) => Promise<Record<string, number>>;
  /** A new agent wallet: address + sealed secret (Create wallet). */
  newWallet?: () => { pubkey: string; encSecret: Uint8Array<ArrayBuffer> };
  /** The vault's private key in wallet-import format (only shown to its owner on request). */
  exportKey?: (vault: Vault) => Promise<string>;
  /** Delete a message (the private key message deletes itself). */
  deleteMessage?: (chatId: string, messageId: number) => Promise<void>;
  /** May this Telegram user create a live wallet here? Default: live trading on and LIVE_TELEGRAM_IDS / LIVE_WALLETS=*. */
  liveAllowed?: (chatId: string) => boolean;
  state?: ChatState;
  /** How long the private key message stays (ms) */
  keyMessageMs?: number;
}

type Ctx = { chatId: string; user: User; vault: Vault & { strategy: Strategy | null } };
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
  { command: 'wallet', description: 'Deposit, withdraw, private key' },
  { command: 'approvals', description: 'Trades waiting for your approval (manual mode)' },
  { command: 'unlink', description: 'Disconnect this chat from your vault' },
];

const KIND_ICON: Record<string, string> = { deploy: '➕', rebalance: '🔁', exit: '🚪', compound: '♻️' };
/** Link codes from the app work for this long. */
const LINK_CODE_TTL_MS = 15 * 60_000;
/** SOL kept in a live wallet for fees and rent (see the deposit advice). */
const MIN_SOL = 0.3;
const WITHDRAW_PCTS = [25, 50, 100];
const amt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 4 });
const minutesLeft = (p: Proposal, now: number) => Math.max(0, Math.round((p.expiresAt.getTime() - now) / 60_000));

/** The message the owner gets for a new proposal in manual mode. */
export function proposalMessage(p: Proposal, now = Date.now()): { text: string; keyboard: Keyboard } {
  return {
    text:
      `🗳 <b>Approval needed</b>\n\n${KIND_ICON[p.kind] ?? '•'} <b>${esc(p.title)}</b>\n${esc(p.reason)}\n\n` +
      `Nothing happens until you approve. Expires in ${minutesLeft(p, now)} min.`,
    keyboard: [
      [
        { text: '✅ Approve', callback_data: `ok|${p.id}` },
        { text: '❌ Reject', callback_data: `no|${p.id}` },
      ],
    ],
  };
}

export function makeBot(d: BotDeps) {
  const { db, tg } = d;
  const now = () => (d.now ?? Date.now)();
  const state = d.state ?? memoryChatState();
  const liveAllowed =
    d.liveAllowed ?? ((chatId: string) => process.env.LIVE_TRADING_ENABLED === 'true' && !!process.env.RPC_URL && isLiveTelegram(chatId));

  const modeLabel = (v: Vault) => (v.mode === 'live' ? '🔴 LIVE (real funds)' : '🧪 Paper (simulated money)');
  const manual = (v: { strategy: Strategy | null }) => !!v.strategy && settingsOf(v.strategy).toggles.askBeforeTrading;
  const tradingLabel = (v: { strategy: Strategy | null }) =>
    manual(v) ? '✋ Manual: the agent asks before every trade' : '🤖 Automatic: the agent trades by itself';

  const menu = (v: Vault & { strategy: Strategy | null }): Keyboard => [
    [
      { text: '📊 Status', callback_data: 'st' },
      { text: '➕ Add LP', callback_data: 'add' },
    ],
    [
      { text: '💼 Positions', callback_data: 'pos' },
      { text: '💳 Wallet', callback_data: 'wal' },
    ],
    [
      { text: '🗳 Approvals', callback_data: 'apv' },
      // The button carries the target state, so a double tap can't flip it back.
      manual(v) ? { text: '✋ Mode: Manual', callback_data: 'mode|auto' } : { text: '🤖 Mode: Auto', callback_data: 'mode|manual' },
    ],
    [
      v.status === 'running' ? { text: '⏸ Pause agent', callback_data: 'pause' } : { text: '▶️ Resume agent', callback_data: 'resume' },
      { text: '🌐 Open app', url: `${d.appUrl}/app` },
    ],
  ];
  const back: Keyboard = [[{ text: '⬅️ Menu', callback_data: 'menu' }]];

  async function context(chatId: string): Promise<Ctx | null> {
    const user = await db.user.findFirst({ where: { telegramChatId: chatId } });
    if (!user) return null;
    const vault = await db.vault.findFirst({ where: { userId: user.id, isDemo: false }, include: { strategy: true }, orderBy: { createdAt: 'asc' } });
    return vault ? { chatId, user, vault } : null;
  }

  const notLinked: Screen = {
    text:
      `👋 <b>Welcome to Binwise</b>\n\nAn AI agent that provides liquidity on Meteora (Solana) for you, and shows whether it beats simply holding.\n\n` +
      `This chat isn't connected to a vault yet.\n\n` +
      `🆕 <b>New here?</b> Tap <b>Create wallet</b>: you get your own Solana wallet in this chat, deposit SOL, and the agent does the rest.\n\n` +
      `🌐 <b>Already use the website?</b>\n1. Open ${esc(d.appUrl)}/app and connect your wallet\n2. Go to <b>Strategy</b> → turn on <b>Telegram alerts</b>\n3. Press <b>Start</b> in the chat that opens`,
    keyboard: [[{ text: '🆕 Create wallet', callback_data: 'cw' }], [{ text: '🌐 Open website', url: `${d.appUrl}/app` }]],
  };

  // ---------------------------------------------------------------- screens

  const welcome = (c: Ctx): Screen => ({
    text:
      `👋 <b>Binwise</b> · ${esc(c.vault.name)}\n${modeLabel(c.vault)}\n${tradingLabel(c.vault)}\n\n` +
      (manual(c.vault)
        ? `The agent scans pools every minute and sends you each trade it wants to make. Nothing runs until you tap ✅ Approve.\n\n`
        : `The agent runs by itself every minute: it picks pools, adds liquidity, rebalances when it pays and exits before downtrends.\n\n`) +
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
        `📊 <b>${esc(c.vault.name)}</b>\n${modeLabel(c.vault)}\n${tradingLabel(c.vault)}\nAgent: ${agent}\n\n` +
        `Value: <b>${usd(m.value)}</b>\n` +
        `Net vs holding: <b>${pct(m.netVsHold)}</b>\n` +
        `Idle (not in a pool): ${usd(m.idle)}\n` +
        `Positions: ${m.open.length} (${m.open.filter((p) => p.inRange).length} in range)\n` +
        (last ? `\n🕒 Last: <b>${esc(last.title)}</b>\n${esc(last.reason.slice(0, 300))}` : ''),
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
        text: `<b>${esc(z.p.pair)}</b>\n\nNot enough idle funds within your limits (at least ${usd(MIN_POSITION_USD)} is needed; you can add up to ${usd(z.max)} now). Deposit first: tap 💳 Wallet.`,
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

  async function approvals(c: Ctx): Promise<Screen> {
    const list = await pendingProposals(db, c.vault.id, now());
    if (!list.length)
      return {
        text: manual(c.vault)
          ? '🗳 <b>Approvals</b>\n\nNothing is waiting. The agent sends each trade here as soon as it wants to make one.'
          : '🗳 <b>Approvals</b>\n\nThe agent is in <b>Automatic</b> mode, so it trades by itself. Switch to ✋ Manual to approve each trade first.',
        keyboard: menu(c.vault),
      };
    return {
      text: `🗳 <b>Waiting for your approval</b>\n\n${list
        .map((p, i) => `${i + 1}. ${KIND_ICON[p.kind] ?? '•'} <b>${esc(p.title)}</b>\n    ${esc(p.reason.slice(0, 160))}\n    Expires in ${minutesLeft(p, now())} min`)
        .join('\n')}`,
      keyboard: [
        ...list.map((p, i) => [
          { text: `✅ Approve #${i + 1}`, callback_data: `ok|${p.id}` },
          { text: `❌ Reject #${i + 1}`, callback_data: `no|${p.id}` },
        ]),
        ...back,
      ],
    };
  }

  // ---------------------------------------------------------------- wallet

  const live = (c: Ctx) => c.vault.mode === 'live' && !!c.vault.agentPubkey && !!c.vault.encSecret;
  const paperWallet: Screen = {
    text: '💳 <b>Wallet</b>\n\nThis vault uses simulated money (🧪 Paper), so it has no real wallet. Switch it to Live in the app to deposit real funds.',
    keyboard: [[{ text: '⬅️ Menu', callback_data: 'menu' }]],
  };

  /** Balances worth showing, largest first, with symbols. Null when the RPC can't be reached. */
  async function holdings(address: string) {
    if (!d.balances) return null;
    const raw = await d.balances(address).catch(() => null);
    if (!raw) return null;
    const mints = Object.keys(raw);
    const tokens = new Map((await db.token.findMany({ where: { mint: { in: mints } } })).map((t) => [t.mint, t]));
    return mints
      .map((mint) => {
        const t = tokens.get(mint);
        const amount = raw[mint];
        return { mint, amount, symbol: mint === SOL_MINT ? 'SOL' : (t?.symbol ?? shortAddress(mint)), usd: amount * (t?.priceUsd ?? 0) };
      })
      .filter((h) => h.amount > 1e-9 && (h.mint === SOL_MINT || h.usd >= 0.01 || !tokens.has(h.mint)))
      .sort((a, b) => (a.mint === SOL_MINT ? -1 : b.mint === SOL_MINT ? 1 : b.usd - a.usd));
  }

  async function wallet(c: Ctx, header = ''): Promise<Screen> {
    if (!live(c)) return paperWallet;
    const address = c.vault.agentPubkey!;
    const h = await holdings(address);
    const sol = h?.find((x) => x.mint === SOL_MINT)?.amount ?? 0;
    const lines = h == null ? ["Couldn't read the balance right now. Tap 🔄 Refresh."] : h.length ? h.map((x) => `• ${amt(x.amount)} ${esc(x.symbol)}${x.usd >= 0.01 ? ` (${usd(x.usd)})` : ''}`) : ['• Empty'];
    const from = isBotWallet(c.user, c.vault)
      ? 'from any wallet or exchange'
      : `from your registered wallet <code>${shortAddress(c.user.wallet)}</code> (or use Deposit in the app)`;
    return {
      text:
        header +
        `💳 <b>Your agent wallet</b> · Solana mainnet\n<code>${address}</code>\n<i>(tap the address to copy)</i>\n\n` +
        `<b>Balance</b>\n${lines.join('\n')}\n\n` +
        `➕ <b>Deposit</b>: send SOL (and/or USDC) to the address above, ${from}. ` +
        `Keep at least ${MIN_SOL} SOL in it for fees and rent; the agent puts the rest to work.` +
        (h != null && sol < MIN_SOL ? `\n\n⚠️ Needs at least ${MIN_SOL} SOL before the agent can add LP.` : ''),
      keyboard: [
        [
          { text: '💸 Withdraw', callback_data: 'wd' },
          { text: '🔑 Private key', callback_data: 'key' },
        ],
        [
          { text: '🔄 Refresh', callback_data: 'wal' },
          { text: '⬅️ Menu', callback_data: 'menu' },
        ],
      ],
    };
  }

  async function withdrawPick(c: Ctx): Promise<Screen> {
    if (!live(c)) return paperWallet;
    const h = await holdings(c.vault.agentPubkey!);
    const backToWallet: Keyboard = [[{ text: '⬅️ Wallet', callback_data: 'wal' }]];
    if (h == null) return { text: "Couldn't read the balance right now. Try again in a moment.", keyboard: backToWallet };
    if (!h.length) return { text: '💸 <b>Withdraw</b>\n\nThe wallet is empty.', keyboard: backToWallet };
    const open = await db.position.count({ where: { vaultId: c.vault.id, status: 'open' } });
    return {
      text:
        `💸 <b>Withdraw</b>\n\nWhich token?` +
        (open ? `\n\nOnly idle funds can be withdrawn; ${open} position${open > 1 ? 's are' : ' is'} still open (close ${open > 1 ? 'them' : 'it'} in 💼 Positions first to take everything out).` : ''),
      keyboard: [...h.slice(0, 8).map((x) => [{ text: `${x.symbol} · ${amt(x.amount)}`, callback_data: `wt|${x.mint}` }]), ...backToWallet],
    };
  }

  function withdrawAmount(mint: string, symbol: string): Screen {
    return {
      text: `💸 <b>Withdraw ${esc(symbol)}</b>\n\nHow much of the idle ${esc(symbol)}?` + (mint === SOL_MINT ? `\n\nWhile positions are open, ${MIN_SOL} SOL stays for fees.` : ''),
      keyboard: [WITHDRAW_PCTS.map((p) => ({ text: p === 100 ? 'All' : `${p}%`, callback_data: `wp|${mint}|${p}` })), [{ text: '⬅️ Back', callback_data: 'wd' }]],
    };
  }

  type PendingWithdraw = { mint: string; pct: number; to?: string };
  const readPending = async (chatId: string): Promise<PendingWithdraw | null> => {
    const raw = await state.get(chatId);
    try {
      return raw ? (JSON.parse(raw) as PendingWithdraw) : null;
    } catch {
      return null;
    }
  };

  async function withdrawConfirm(c: Ctx, w: PendingWithdraw & { to: string }): Promise<Screen> {
    const symbol = w.mint === SOL_MINT ? 'SOL' : ((await db.token.findUnique({ where: { mint: w.mint } }))?.symbol ?? shortAddress(w.mint));
    return {
      text:
        `💸 Withdraw <b>${w.pct === 100 ? 'all' : `${w.pct}%`}</b> of the idle <b>${esc(symbol)}</b> to:\n<code>${w.to}</code>\n\n` +
        (isBotWallet(c.user, c.vault) ? '⚠️ Check the address carefully: funds sent to a wrong address cannot be recovered.' : 'This is your registered wallet.'),
      keyboard: [
        [
          { text: '✅ Withdraw', callback_data: 'wx' },
          { text: '✖️ Cancel', callback_data: 'wc' },
        ],
      ],
    };
  }

  const keyWarning: Screen = {
    text:
      '🔑 <b>Private key</b>\n\nAnyone with this key controls the wallet and every coin in it.\n\n' +
      '• Never share it, never paste it on a website. Binwise will never ask you for it.\n' +
      '• Use it to open this wallet in Phantom or Solflare (Add account → Import private key), e.g. if Binwise is ever unavailable.\n' +
      '• To take money out, prefer 💸 Withdraw here: it keeps your stats right. Moving funds yourself makes the agent see a drop, and it may close positions and pause.\n' +
      '• The message deletes itself after 60 seconds.\n\nShow it now?',
    keyboard: [
      [
        { text: '👁 Show private key', callback_data: 'keyx' },
        { text: '✖️ Cancel', callback_data: 'wal' },
      ],
    ],
  };

  // ---------------------------------------------------------------- new wallet (no website needed)

  function createWalletIntro(chatId: string): Screen {
    if (!liveAllowed(chatId) || !d.newWallet)
      return {
        text:
          `🆕 <b>Create wallet</b>\n\nCreating wallets in Telegram isn't open yet while live trading is being tested.\n\n` +
          `Your Telegram ID: <code>${esc(chatId)}</code>\n(Owner: add it with deploy/go-live.sh to allow this chat.)`,
        keyboard: [[{ text: '⬅️ Back', callback_data: 'start' }]],
      };
    const lim = liveLimits();
    return {
      text:
        `🆕 <b>Create your Binwise wallet</b>\n\n` +
        `• A new Solana wallet is made for you. The agent trades from it on mainnet with <b>real funds</b>.\n` +
        `• You can see its private key anytime (💳 Wallet → 🔑) and withdraw anytime.\n` +
        `• While live trading is new, the agent puts at most ${usd(lim.maxUsd)} into positions per wallet.\n` +
        `• No strategy is guaranteed to profit. Only deposit what you can afford to lose.\n\nCreate it?`,
      keyboard: [
        [
          { text: '✅ Create my wallet', callback_data: 'cwx' },
          { text: '✖️ Cancel', callback_data: 'start' },
        ],
      ],
    };
  }

  async function createWallet(chatId: string): Promise<Screen> {
    if (!liveAllowed(chatId) || !d.newWallet) return createWalletIntro(chatId);
    const key = d.newWallet();
    const user = await db.user.create({ data: { wallet: key.pubkey, telegramChatId: chatId } });
    const vault = await createVault(db, user.id, { live: { agentPubkey: key.pubkey, encSecret: key.encSecret } });
    await db.decision.create({
      data: {
        vaultId: vault.id,
        ts: new Date(now()),
        type: 'scan',
        title: 'Live vault created',
        reason: 'Created in Telegram. Runs on Solana mainnet with real funds. Deposit SOL to start.',
        inputs: {},
      },
    });
    const c: Ctx = { chatId, user, vault };
    const w = await wallet(c, '✅ <b>Wallet created.</b>\n\n');
    return {
      text: w.text + `\n\nWhen the deposit arrives, the agent starts by itself (🤖 Auto), or tap ➕ Add LP to pick a pool yourself.`,
      keyboard: menu(vault),
    };
  }

  // ---------------------------------------------------------------- input

  async function link(chatId: string, code: string) {
    const user = await db.user.findUnique({ where: { telegramLinkCode: code } });
    if (!user) return tg.send(chatId, 'That link code is not valid or was already used. In the app, turn Telegram alerts off and on again to get a new one.');
    if (!user.telegramLinkCodeAt || now() - user.telegramLinkCodeAt.getTime() > LINK_CODE_TTL_MS)
      return tg.send(chatId, 'That link code has expired (codes work for 15 minutes). In the app, turn Telegram alerts off and on again to get a new one.');
    // A wallet created in this chat is only reachable from here: never cut it off by linking another.
    const here = await context(chatId);
    if (here && here.user.id !== user.id && isBotWallet(here.user, here.vault))
      return tg.send(chatId, 'This chat already has a Binwise wallet created here, so it can\'t also connect a website wallet. Use another Telegram account for that one.');
    // One chat per wallet: unlink this chat from anyone else first.
    await db.user.updateMany({ where: { telegramChatId: chatId, NOT: { id: user.id } }, data: { telegramChatId: null } });
    await db.user.update({ where: { id: user.id }, data: { telegramChatId: chatId, telegramLinkCode: null, telegramLinkCodeAt: null } });
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
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === '/id') return tg.send(chatId, `Your Telegram ID: <code>${esc(chatId)}</code>`, { html: true });
    const c = await context(chatId);
    if (cmd === '/unlink') {
      if (c && isBotWallet(c.user, c.vault))
        return tg.send(
          chatId,
          'This wallet was created in this chat, so this chat is how you reach it. It stays connected.\n\nTo use it somewhere else: 💳 Wallet → 🔑 Private key, and import it into Phantom.',
        );
      const { count } = await db.user.updateMany({ where: { telegramChatId: chatId }, data: { telegramChatId: null } });
      if (!count) return tg.send(chatId, notLinked.text, { html: true, keyboard: notLinked.keyboard });
      return tg.send(chatId, '👋 Disconnected. This chat no longer gets alerts or controls your vault.\n\nTo connect again, turn Telegram alerts off and on in the app.');
    }
    if (!c) return tg.send(chatId, notLinked.text, { html: true, keyboard: notLinked.keyboard });
    // A withdrawal waiting for its address: a pasted address answers it.
    const pending = await readPending(chatId);
    if (pending && !pending.to && !text.startsWith('/')) {
      const to = walletAddress(text);
      if (!to || to === c.vault.agentPubkey)
        return tg.send(chatId, "That isn't a Solana wallet address. Paste the address to send to (e.g. from Phantom or an exchange's SOL deposit page), or tap Cancel.", {
          keyboard: [[{ text: '✖️ Cancel', callback_data: 'wc' }]],
        });
      const w = { ...pending, to };
      await state.set(chatId, JSON.stringify(w), 600);
      const s = await withdrawConfirm(c, w);
      return tg.send(chatId, s.text, { html: true, keyboard: s.keyboard });
    }
    const screen =
      cmd === '/wallet'
        ? await wallet(c)
        : cmd === '/status'
        ? await status(c)
        : cmd === '/add'
          ? await pools(c)
          : cmd === '/positions'
            ? await positions(c)
            : cmd === '/approvals'
              ? await approvals(c)
              : welcome(c);
    await tg.send(chatId, screen.text, { html: true, keyboard: screen.keyboard });
  }

  async function onCallback(q: TgCallback) {
    const msg = q.message;
    if (!msg || msg.chat.type !== 'private' || !q.data) return tg.answer(q.id);
    if (q.data === 'start') {
      await tg.answer(q.id);
      const linked = await context(String(msg.chat.id));
      const s = linked ? welcome(linked) : notLinked;
      return tg.edit(String(msg.chat.id), msg.message_id, s.text, { html: true, keyboard: s.keyboard });
    }
    const chatId = String(msg.chat.id);
    const c = await context(chatId);
    if (!c) {
      await tg.answer(q.id);
      const s = q.data === 'cw' ? createWalletIntro(chatId) : q.data === 'cwx' ? await createWallet(chatId) : notLinked;
      return tg.edit(chatId, msg.message_id, s.text, { html: true, keyboard: s.keyboard });
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
        // Claiming can be repeated later from the same message, so it keys on the press (unique per tap);
        // closing keys on the message, so a double tap is sent once.
        await d.enqueue(c.vault.id, { id: op === 'f' ? `tg-${q.id}-f` : requestId, action: op === 'f' ? 'claim' : 'close', positionId: p.id, chatId });
        if (op === 'f') return tg.answer(q.id, 'Claiming fees…');
        return show({ text: `⏳ Closing <b>${esc(pair)}</b>…\n\nYou'll get a message here when it's done.` }, 'Sent to the agent');
      }
      case 'apv':
        return show(await approvals(c));
      case 'cw':
      case 'cwx':
      case 'wal':
        return show(await wallet(c));
      case 'wd':
        await state.del(chatId);
        return show(await withdrawPick(c));
      case 'wt': {
        if (!live(c)) return show(paperWallet);
        const symbol = a === SOL_MINT ? 'SOL' : ((await db.token.findUnique({ where: { mint: a } }))?.symbol ?? shortAddress(a));
        return show(withdrawAmount(a, symbol));
      }
      case 'wp': {
        if (!live(c)) return show(paperWallet);
        const w = { mint: a, pct: Number(b) || 100 };
        if (isBotWallet(c.user, c.vault)) {
          await state.set(chatId, JSON.stringify(w), 600);
          return show({
            text: '📮 <b>Where to?</b>\n\nPaste the Solana address to send to (from Phantom, Solflare, or an exchange\'s SOL deposit page).',
            keyboard: [[{ text: '✖️ Cancel', callback_data: 'wc' }]],
          });
        }
        // Website vaults: always the registered wallet.
        const full = { ...w, to: c.user.wallet };
        await state.set(chatId, JSON.stringify(full), 600);
        return show(await withdrawConfirm(c, full));
      }
      case 'wx': {
        const w = await readPending(chatId);
        if (!w?.to || !live(c)) return show(await wallet(c), 'This withdrawal expired. Start again.');
        await state.del(chatId);
        await d.enqueue(c.vault.id, { id: requestId, action: 'withdraw', mint: w.mint, pct: w.pct, to: w.to, chatId });
        return show({ text: `⏳ Withdrawing to <code>${shortAddress(w.to)}</code>…\n\nYou'll get a message here when it's sent.` }, 'Sent to the agent');
      }
      case 'wc':
        await state.del(chatId);
        return show(await wallet(c), 'Cancelled');
      case 'key':
        return show(live(c) ? keyWarning : paperWallet);
      case 'keyx': {
        if (!live(c) || !d.exportKey) return show(paperWallet);
        const secret = await d.exportKey(c.vault);
        const id = await tg.send(
          chatId,
          `🔑 Private key of <code>${c.vault.agentPubkey}</code>\n\n<tg-spoiler><code>${secret}</code></tg-spoiler>\n\n` +
            `Tap to reveal and copy. Import in Phantom: Add account → Import private key.\n⏱ This message deletes itself in 60 seconds.`,
          { html: true },
        );
        if (id != null && d.deleteMessage) {
          const del = d.deleteMessage;
          setTimeout(() => void del(chatId, id).catch(() => {}), d.keyMessageMs ?? 60_000).unref?.();
        }
        await db.decision.create({
          data: { vaultId: c.vault.id, ts: new Date(now()), type: 'hold', title: 'Private key shown', reason: 'Shown in Telegram at the owner\'s request.', inputs: { manual: true } },
        });
        return show(await wallet(c), 'Sent. It deletes itself in 60 seconds');
      }
      case 'ok':
      case 'no': {
        try {
          const p = op === 'ok' ? await approveProposal(db, c.vault.id, a, now()) : await rejectProposal(db, c.vault.id, a, now());
          if (op === 'ok') {
            await d.enqueue(c.vault.id, { id: `approve-${p.id}`, action: 'proposal', proposalId: p.id, chatId });
            return show({ text: `✅ Approved: <b>${esc(p.title)}</b>\n\n⏳ The agent is doing it now. You'll get a message when it's done.` }, 'Approved');
          }
          return show({ text: `❌ Rejected: <b>${esc(p.title)}</b>\n\nThe agent won't propose this again for a few hours.`, keyboard: back }, 'Rejected');
        } catch (e) {
          if (!(e instanceof ProposalError)) throw e;
          return show({ text: `ℹ️ ${esc(e.message)}`, keyboard: back }, e.message.slice(0, 190));
        }
      }
      case 'mode': {
        if (!c.vault.strategy || (a !== 'manual' && a !== 'auto')) return show(welcome(c));
        const next = a === 'manual';
        if (next === manual(c.vault)) return show(welcome(c), next ? 'Already in manual mode' : 'Already in automatic mode');
        const toggles = { ...settingsOf(c.vault.strategy).toggles, askBeforeTrading: next };
        const strategy = await db.strategy.update({ where: { id: c.vault.strategy.id }, data: { toggles } });
        await db.decision.create({
          data: {
            vaultId: c.vault.id,
            type: 'hold',
            title: next ? 'Manual mode on' : 'Automatic mode on',
            reason: next ? 'Set from Telegram: the agent asks before every trade.' : 'Set from Telegram: the agent trades by itself.',
            inputs: { manual: true },
          },
        });
        if (!next) await db.proposal.updateMany({ where: { vaultId: c.vault.id, status: 'pending' }, data: { status: 'expired' } });
        return show(welcome({ ...c, vault: { ...c.vault, strategy } }), next ? 'Manual mode: approve each trade' : 'Automatic mode');
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
        if (paused) {
          await db.proposal.updateMany({ where: { vaultId: v.id, status: 'pending' }, data: { status: 'expired' } });
          await d.onPaused?.(v);
        }
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
