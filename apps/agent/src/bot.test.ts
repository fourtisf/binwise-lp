import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVault, ensureUser, getDb } from '@binwise/db';
import { PaperExecutor, SOL_MINT, createAgentKey, exportAgentSecret, sealImportedKey, type Holdings } from '@binwise/chain';
import { Keypair } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { collectOnce, DEFAULT_COLLECTOR } from './collector';
import { runManualAction, runManualDeploy, runVaultCycle, type AgentDeps, type VaultWithStrategy } from './agent';
import { makeBot, memoryChatState, proposalMessage, resultMessage, type ManualRequest } from './bot';
import { runWithdraw, type WithdrawChain } from './wallet';
import type { Keyboard, TelegramApi, TgUpdate } from './telegram';
import { FakeMeteora, POOL, USDC, asMeteora, resetDb } from './test-helpers';

const db = getDb();
const CHAT = 4242;
let now = Date.UTC(2026, 9, 10, 12);
let meteora: FakeMeteora;
let queue: ManualRequest[];
let sent: { chatId: string; text: string; keyboard?: Keyboard; messageId?: number }[];
let answers: string[];
let updateId = 0;
const usedKeys = new Set<string>();

const KEY_SECRET = randomBytes(32).toString('base64');
/** A fresh wallet's address and its private key as wallets export it (base58). */
const freshKey = () => {
  const k = createAgentKey(KEY_SECRET);
  return { pubkey: k.pubkey, b58: exportAgentSecret(k.encSecret, k.pubkey, KEY_SECRET) };
};
let deleted: number[];
let chatState = memoryChatState();
let liveOk = true;
/** Production: Binwise keeps no wallets any more */
let keysClosed = false;
let walletBalances: Record<string, number> = {};
const tg: TelegramApi = {
  send: async (chatId, text, o) => {
    sent.push({ chatId, text, keyboard: o?.keyboard });
    return 900 + sent.length;
  },
  edit: async (chatId, messageId, text, o) => void sent.push({ chatId, text, keyboard: o?.keyboard, messageId }),
  answer: async (_id, text) => void answers.push(text ?? ''),
};
const bot = () =>
  makeBot({
    db,
    tg,
    enqueue: async (_v, r) => void queue.push(r),
    appUrl: 'https://binwise.org',
    now: () => now,
    balances: async () => walletBalances,
    newWallet: () => {
      const k = createAgentKey(KEY_SECRET);
      return { pubkey: k.pubkey, encSecret: new Uint8Array(k.encSecret) };
    },
    importWallet: (input) => {
      const k = sealImportedKey(input, KEY_SECRET);
      return k && { pubkey: k.pubkey, encSecret: new Uint8Array(k.encSecret) };
    },
    exportKey: async () => 'SECRET-KEY-BASE58',
    deleteMessage: async (_c, id) => void deleted.push(id),
    liveAllowed: () => liveOk,
    keysClosed,
    state: chatState,
    keyMessageMs: 5,
  });
const say = (text: string, chatType: 'private' | 'group' = 'private') =>
  bot()({ update_id: ++updateId, message: { message_id: updateId, chat: { id: CHAT, type: chatType }, text } } as TgUpdate);
const press = (data: string, messageId = 77) =>
  bot()({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, data, message: { message_id: messageId, chat: { id: CHAT, type: 'private' } } } });
const last = () => sent.at(-1)!;
const buttons = () => (last().keyboard ?? []).flat();
const callbackOf = (text: string) => {
  const b = buttons().find((x) => x.text === text);
  return b && 'callback_data' in b ? b.callback_data : undefined;
};

const agentDeps = (): AgentDeps => ({
  db,
  killSwitch: { isKilled: async () => false },
  claimKey: async (k) => !usedKeys.has(k) && !!usedKeys.add(k),
  executorFor: async (v) => new PaperExecutor({ ...(v.cash as Holdings) }),
  emit: () => {},
  now: () => now,
});
const vault = async (): Promise<VaultWithStrategy> => db.vault.findFirstOrThrow({ where: { isDemo: false }, include: { strategy: true } });

beforeAll(async () => {
  const { execSync } = await import('node:child_process');
  const dbName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  execSync(`psql -h localhost -U binwise -d postgres -c "create database ${dbName}" 2>/dev/null || true`, { stdio: 'ignore' });
  execSync('pnpm --filter @binwise/db exec prisma migrate deploy', { stdio: 'ignore', env: { ...process.env } });
});

beforeEach(async () => {
  await resetDb();
  meteora = new FakeMeteora();
  queue = [];
  sent = [];
  answers = [];
  deleted = [];
  chatState = memoryChatState();
  liveOk = true;
  keysClosed = false;
  walletBalances = {};
  usedKeys.clear();
  now = Date.UTC(2026, 9, 10, 12);
  const user = await ensureUser(db, 'Wallet1111111111111111111111111111111111111');
  await db.user.update({ where: { id: user.id }, data: { telegramLinkCode: 'code123', telegramLinkCodeAt: new Date(now) } });
  const v = await createVault(db, user.id, { cash: { [USDC]: 10_000 } });
  await db.vault.update({ where: { id: v.id }, data: { deposits: { [USDC]: 10_000 } } });
  await collectOnce({ db, meteora: asMeteora(meteora), now: () => now }, DEFAULT_COLLECTOR);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('telegram bot', () => {
  it('asks unlinked chats to connect, and links with the code from the app', async () => {
    await say('/menu');
    expect(last().text).toMatch(/isn't connected to a vault yet/);
    await say('/start code123');
    expect(last().text).toMatch(/^✅ Connected/);
    expect(buttons().map((b) => b.text)).toEqual(['📊 Status', '➕ Add LP', '💼 Positions', '💳 Wallet', '🗳 Approvals', '🤖 Mode: Auto', '⚙️ Settings', '⏸ Pause agent', '🌐 Open app']);
    expect(callbackOf('🤖 Mode: Auto')).toBe('mode|manual');
    // The code works once.
    await say('/start code123');
    expect(last().text).toMatch(/not valid or was already used/);
  });

  it('refuses link codes older than 15 minutes', async () => {
    now += 16 * 60_000;
    await say('/start code123');
    expect(last().text).toMatch(/expired/);
    expect(await db.user.count({ where: { telegramChatId: String(CHAT) } })).toBe(0);
  });

  it('unlinks the chat with /unlink', async () => {
    await say('/start code123');
    await say('/unlink');
    expect(last().text).toMatch(/Disconnected/);
    expect(await db.user.count({ where: { telegramChatId: String(CHAT) } })).toBe(0);
    await say('/status');
    expect(last().text).toMatch(/isn't connected to a vault yet/);
  });

  it('ignores group chats', async () => {
    await say('/start code123', 'group');
    expect(sent).toHaveLength(0);
  });

  it('adds LP step by step: pool → amount → confirm → agent executes and reports back', async () => {
    await say('/start code123');
    await press('add');
    expect(last().text).toMatch(/JUP \/ USDC/);
    await press(`p|${POOL}`);
    expect(buttons().map((b) => b.text)).toContain('$100');
    await press(`a|${POOL}|100`);
    expect(last().text).toMatch(/Add <b>\$100<\/b> to <b>JUP \/ USDC<\/b>\?/);
    expect(last().text).toMatch(/Paper \(simulated money\)/);
    await press(`go|${POOL}|100`);
    expect(last().text).toMatch(/Adding LP to/);
    expect(queue).toEqual([{ id: `tg-${CHAT}-77`, action: 'deploy', poolId: POOL, usd: 100, chatId: String(CHAT) }]);

    const r = await runManualDeploy(agentDeps(), await vault(), POOL, 100, queue[0].id);
    expect(resultMessage(r)).toMatch(/^✅ Deployed \$\d+ to JUP \/ USDC/);
    const pos = await db.position.findFirstOrThrow();
    expect(pos.entryValueUsd).toBeGreaterThan(95);
    expect(pos.entryValueUsd).toBeLessThanOrEqual(100.01);
    expect((await db.decision.findFirstOrThrow({ where: { type: 'deploy' } })).reason).toMatch(/Requested from Telegram/);
    // A double tap is never executed twice.
    expect(await runManualDeploy(agentDeps(), await vault(), POOL, 100, queue[0].id)).toBeNull();
    expect(await db.position.count()).toBe(1);
    // The pool is no longer offered once held.
    await press('add');
    expect(last().text).not.toMatch(/JUP \/ USDC/);
  });

  it('refuses pools the agent would not enter', async () => {
    meteora.drift = -0.002; // downtrend
    await db.candle.deleteMany();
    now += 60_000;
    await collectOnce({ db, meteora: asMeteora(meteora), now: () => now }, DEFAULT_COLLECTOR);
    await say('/start code123');
    await press('add');
    expect(last().text).toMatch(/No pool passes the agent's safety checks/);
    await expect(runManualDeploy(agentDeps(), await vault(), POOL, 100, 'x')).rejects.toThrow(/won't enter this pool/);

    // By hand, at the owner's own risk: listed under Other pools, with a warning, then opened as a manual position.
    expect(callbackOf('🧭 Other pools (manual)')).toBe('pox');
    await press('pox');
    expect(last().text).toMatch(/JUP \/ USDC/);
    expect(callbackOf(buttons().find((x) => x.text.includes('JUP / USDC'))!.text)).toBe(`px|${POOL}`);
    await press(`px|${POOL}`);
    expect(last().text).toMatch(/Agent's call: <b>Avoid/);
    await press(`ax|${POOL}|100`);
    expect(last().text).toMatch(/won't close it/);
    await press(`gx|${POOL}|100`, 91);
    expect(queue.at(-1)).toMatchObject({ action: 'deploy', poolId: POOL, usd: 100, override: true });
    const r = await runManualDeploy(agentDeps(), await vault(), POOL, 100, 'manual-1', 'Requested from Telegram', { override: true });
    expect(resultMessage(r)).toMatch(/at your own risk/);
    const pos = await db.position.findFirstOrThrow();
    expect(pos.manual).toBe(true);

    // The agent keeps it through the downtrend: no trend exit for a manual position.
    for (let i = 0; i < 3; i++) {
      now += 60_000;
      await collectOnce({ db, meteora: asMeteora(meteora), now: () => now }, DEFAULT_COLLECTOR);
      await runVaultCycle(agentDeps(), await vault());
    }
    expect((await db.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe('open');

    // Search by token name.
    await press('psx');
    await say('jup');
    expect(last().text).toMatch(/Pools with "jup"/);
  });

  it('adds LP with the owner\'s own shape and range, and rebalances keep that width and shape', async () => {
    // Big enough that a rebalance pays for itself (fees over 6h > 1.5 × its cost).
    const r = await runManualDeploy(agentDeps(), await vault(), POOL, 2000, 'custom-1', 'Requested from the app', { shape: 'bidask', range: { below: 2, above: 6 } });
    expect(resultMessage(r)).toMatch(/Bid-ask over 9 bins, the range you chose/);
    const pos = await db.position.findFirstOrThrow();
    expect(pos).toMatchObject({ shape: 'bidask', rangeBelow: 2, rangeAbove: 6 });
    expect(pos.upperBin - pos.lowerBin).toBe(8);
    // Ranges a position can't hold are refused before anything happens.
    await expect(runManualDeploy(agentDeps(), await vault(), POOL, 100, 'custom-2', 'Requested from the app', { range: { below: 50, above: 50 } })).rejects.toThrow(/at most 69 bins/);

    // Price runs above the range: the agent moves it, same bins on each side and same shape.
    meteora.price *= 1.15;
    for (let i = 0; i < 6; i++) {
      now += 31 * 60_000;
      await collectOnce({ db, meteora: asMeteora(meteora), now: () => now }, DEFAULT_COLLECTOR);
      await runVaultCycle(agentDeps(), await vault());
      if ((await db.position.findUniqueOrThrow({ where: { id: pos.id } })).rebalances > 0) break;
    }
    const moved = await db.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(moved.rebalances).toBeGreaterThan(0);
    expect(moved.lowerBin).toBeGreaterThan(pos.upperBin - 1);
    expect(moved.upperBin - moved.lowerBin).toBe(8);
    expect(moved).toMatchObject({ shape: 'bidask', rangeBelow: 2, rangeAbove: 6, inRange: true });
  });

  it('shows positions with Close, asks before closing, and only touches this chat\'s vault', async () => {
    await say('/start code123');
    await runManualDeploy(agentDeps(), await vault(), POOL, 200, 'seed');
    const pos = await db.position.findFirstOrThrow();
    await press('pos');
    expect(last().text).toMatch(/JUP \/ USDC/);
    // Claim fees can be pressed again on the same message later: each press is its own request.
    await press(`f|${pos.id}`);
    await press(`f|${pos.id}`);
    expect(queue.map((r) => r.action)).toEqual(['claim', 'claim']);
    expect(queue[0].id).not.toBe(queue[1].id);
    await press(`c|${pos.id}`);
    expect(last().text).toMatch(/^Close <b>JUP \/ USDC<\/b>/);
    await press(`cx|${pos.id}`);
    expect(queue.at(-1)).toMatchObject({ action: 'close', positionId: pos.id, chatId: String(CHAT) });
    const r = await runManualAction(agentDeps(), await vault(), pos.id, 'close', queue.at(-1)!.id);
    expect(resultMessage(r)).toMatch(/^✅/);

    // Someone else's position id from this chat: refused.
    const other = await ensureUser(db, 'Other111111111111111111111111111111111111111');
    const ov = await createVault(db, other.id, { cash: { [USDC]: 1_000 } });
    const foreign = await db.position.create({
      data: { ...pos, id: undefined, vaultId: ov.id, status: 'open', bins: pos.bins ?? undefined, closedAt: null },
    });
    queue = [];
    await press(`cx|${foreign.id}`);
    expect(queue).toEqual([]);
    expect(answers.at(-1)).toMatch(/already closed/);
  });

  it('switches between automatic and manual, and approves proposals with buttons', async () => {
    await say('/start code123');
    await press('mode|manual');
    expect(last().text).toMatch(/✋ Manual: the agent asks before every trade/);
    expect(callbackOf('✋ Mode: Manual')).toBe('mode|auto');
    const st = await db.strategy.findFirstOrThrow();
    expect((st.toggles as { askBeforeTrading: boolean }).askBeforeTrading).toBe(true);
    // A double tap sets the same mode again instead of flipping back.
    await press('mode|manual');
    expect(answers.at(-1)).toMatch(/Already in manual mode/);
    expect(((await db.strategy.findFirstOrThrow()).toggles as { askBeforeTrading: boolean }).askBeforeTrading).toBe(true);

    const v = await vault();
    const p = await db.proposal.create({
      data: { vaultId: v.id, kind: 'deploy', poolId: POOL, title: 'Deploy $2,500 to JUP / USDC', reason: 'Score 80.', plan: { pair: 'JUP / USDC', sizeUsd: 2500 }, expiresAt: new Date(now + 3600_000) },
    });
    const msg = proposalMessage(p, now);
    expect(msg.text).toMatch(/Approval needed/);
    expect(msg.text).toMatch(/Expires in 60 min/);
    // Self-custody: Approve opens the website, where the owner's wallet signs.
    const own = proposalMessage(p, now, 'https://binwise.org/app');
    expect(own.keyboard[0][0]).toEqual({ text: '✍️ Approve in wallet', url: 'https://binwise.org/app' });
    expect(own.text).toMatch(/your wallet signs it/);
    await press('apv');
    expect(last().text).toMatch(/Waiting for your approval/);
    await press(`ok|${p.id}`);
    expect(last().text).toMatch(/^✅ Approved/);
    expect(queue.at(-1)).toEqual({ id: `approve-${p.id}`, action: 'proposal', proposalId: p.id, chatId: String(CHAT) });
    // A second tap can't approve twice.
    queue = [];
    await press(`ok|${p.id}`);
    expect(queue).toEqual([]);
    expect(last().text).toMatch(/already approved/);

    // Back to automatic: anything still waiting is dropped (the agent now acts by itself).
    await db.proposal.create({ data: { vaultId: v.id, kind: 'exit', title: 'Exit X', reason: 'r', expiresAt: new Date(now + 3600_000) } });
    await press('mode|auto');
    expect(await db.proposal.count({ where: { status: 'pending' } })).toBe(0);
    expect(((await db.strategy.findFirstOrThrow()).toggles as { askBeforeTrading: boolean }).askBeforeTrading).toBe(false);
  });

  it('pauses and resumes the agent', async () => {
    await say('/start code123');
    await press('pause');
    expect((await vault()).status).toBe('paused');
    expect(last().text).toMatch(/⏸ Paused/);
    expect(buttons().map((b) => b.text)).toContain('▶️ Resume agent');
    await press('resume');
    expect((await vault()).status).toBe('running');
  });

  it('shows status with net vs hold as the headline', async () => {
    await say('/start code123');
    await say('/status');
    expect(last().text).toMatch(/Value: <b>\$10,000<\/b>/);
    expect(last().text).toMatch(/Net vs holding: <b>\+0\.00%<\/b>/);
  });

  it('creates a wallet in the chat: live vault, deposit address, no website needed', async () => {
    await say('/start');
    expect(last().text).toMatch(/isn't connected to a vault yet/);
    expect(callbackOf('🆕 Create wallet')).toBe('cw');
    await press('cw');
    expect(last().text).toMatch(/real funds/);
    expect(last().text).toMatch(/No strategy is guaranteed to profit/);
    walletBalances = { [SOL_MINT]: 0.05 };
    await press('cwx');
    expect(last().text).toMatch(/Wallet created/);
    const user = await db.user.findFirstOrThrow({ where: { telegramChatId: String(CHAT) } });
    const v = await db.vault.findFirstOrThrow({ where: { userId: user.id } });
    expect(v.mode).toBe('live');
    // The wallet is its own owner: deposits from anywhere count, withdrawals go where its owner says.
    expect(user.wallet).toBe(v.agentPubkey);
    expect(v.encSecret).not.toBeNull();
    expect(last().text).toContain(`<code>${v.agentPubkey}</code>`);
    expect(last().text).toMatch(/Needs at least 0.3 SOL/);
    // A second tap doesn't make a second wallet.
    await press('cwx');
    expect(await db.vault.count({ where: { userId: user.id } })).toBe(1);
    // It can't be unlinked (this chat is the only way to reach it).
    await say('/unlink');
    expect(last().text).toMatch(/stays connected/);
    expect(await db.user.count({ where: { telegramChatId: String(CHAT) } })).toBe(1);
    // Linking a website wallet here would cut it off: refused.
    await say('/start code123');
    expect(last().text).toMatch(/already has a Binwise wallet/);
  });

  it("doesn't create wallets while live is limited to other users, and shows the Telegram id to allow", async () => {
    liveOk = false;
    await press('cw');
    expect(last().text).toMatch(/isn't open yet/);
    expect(last().text).toContain(`<code>${CHAT}</code>`);
    await press('cwx');
    expect(await db.user.count({ where: { telegramChatId: String(CHAT) } })).toBe(0);
  });

  it('shows the private key only after a warning, then deletes the message', async () => {
    await press('cwx');
    await press('wal');
    await press('key');
    expect(last().text).toMatch(/Anyone with this key controls the wallet/);
    expect(sent.some((m) => m.text.includes('SECRET-KEY-BASE58'))).toBe(false);
    await press('keyx');
    const keyMsg = sent.find((m) => m.text.includes('SECRET-KEY-BASE58'))!;
    expect(keyMsg.text).toMatch(/<tg-spoiler><code>SECRET-KEY-BASE58<\/code><\/tg-spoiler>/);
    await new Promise((r) => setTimeout(r, 20));
    expect(deleted).toEqual([900 + sent.indexOf(keyMsg) + 1]);
    // Logged for the owner, without the key.
    const d = await db.decision.findFirstOrThrow({ where: { title: 'Private key shown' } });
    expect(JSON.stringify(d)).not.toContain('SECRET');
  });

  it('paper vaults have no wallet to show', async () => {
    await say('/start code123');
    await press('wal');
    expect(last().text).toMatch(/simulated money/);
    await press('keyx');
    expect(sent.some((m) => m.text.includes('SECRET-KEY-BASE58'))).toBe(false);
  });

  it('withdraws from a bot wallet to a pasted address, once', async () => {
    await press('cwx');
    walletBalances = { [SOL_MINT]: 2, [USDC]: 50 };
    await press('wd');
    expect(buttons().map((b) => b.text)).toEqual(['SOL · 2', 'USDC · 50', '⬅️ Wallet']);
    await press(`wt|${SOL_MINT}`);
    await press(`wp|${SOL_MINT}|50`);
    expect(last().text).toMatch(/Paste the Solana address/);
    await say('not-an-address');
    expect(last().text).toMatch(/isn't a Solana wallet address/);
    const dest = Keypair.generate().publicKey.toBase58();
    await say(dest);
    expect(last().text).toMatch(/Withdraw <b>50%<\/b> of the idle <b>SOL<\/b>/);
    expect(last().text).toContain(dest);
    await press('wx', 88);
    expect(queue).toEqual([{ id: `tg-${CHAT}-88`, action: 'withdraw', mint: SOL_MINT, pct: 50, to: dest, chatId: String(CHAT) }]);
    // The confirmation can't be used again.
    await press('wx', 88);
    expect(queue).toHaveLength(1);

    // The agent sends it: half of the withdrawable SOL, to the typed address, baseline shrunk.
    const v = await db.vault.findFirstOrThrow({ where: { mode: 'live' } });
    await db.vault.update({ where: { id: v.id }, data: { deposits: { [SOL_MINT]: 2 } } });
    await db.token.upsert({ where: { mint: SOL_MINT }, update: { priceUsd: 100 }, create: { mint: SOL_MINT, symbol: 'SOL', decimals: 9, priceUsd: 100, isVerified: true } });
    const calls: { mint: string; amount: number; to: string; key: string }[] = [];
    const used = new Set<string>();
    const chainFor = async (_v: unknown, to: string): Promise<WithdrawChain> => ({
      holdings: async () => ({ [USDC]: 50 }),
      withdrawableSol: async () => 1.999,
      withdraw: async (mint, amount, key) => {
        if (used.has(key)) throw new (await import('@binwise/chain')).DuplicateAction('dup');
        used.add(key);
        calls.push({ mint, amount, to, key });
        return 'SIG';
      },
    });
    const wd = { db, killSwitch: { isKilled: async () => false }, chainFor, now: () => now };
    const r = await runWithdraw(wd, v, { id: queue[0].id, mint: SOL_MINT, pct: 50, to: dest });
    expect(calls).toEqual([{ mint: SOL_MINT, amount: 0.9995, to: dest, key: `withdraw:${queue[0].id}` }]);
    expect(resultMessage(r)).toMatch(/^✅ Withdrew 0.9995 SOL/);
    expect(((await db.vault.findUniqueOrThrow({ where: { id: v.id } })).deposits as Record<string, number>)[SOL_MINT]).toBeCloseTo(2 - 0.9995, 6);
    expect(await runWithdraw(wd, v, { id: queue[0].id, mint: SOL_MINT, pct: 50, to: dest })).toBeNull();
    // A bad address never reaches the chain; the kill switch stops everything.
    await expect(runWithdraw(wd, v, { id: 'x', mint: SOL_MINT, pct: 100, to: 'nope' })).rejects.toThrow(/not a wallet address/);
    await expect(runWithdraw({ ...wd, killSwitch: { isKilled: async () => true } }, v, { id: 'y', mint: SOL_MINT, pct: 100, to: dest })).rejects.toThrow(/halted/);
    expect(calls).toHaveLength(1);
  });

  it('website vaults withdraw only to the registered wallet, whatever the request says', async () => {
    await say('/start code123');
    const v = await vault();
    const k = createAgentKey(KEY_SECRET);
    await db.vault.update({ where: { id: v.id }, data: { mode: 'live', agentPubkey: k.pubkey, encSecret: new Uint8Array(k.encSecret) } });
    walletBalances = { [SOL_MINT]: 1 };
    await press(`wp|${SOL_MINT}|100`);
    expect(last().text).toMatch(/This is your registered wallet/);
    expect(last().text).toContain('Wallet1111111111111111111111111111111111111');
    const tos: string[] = [];
    const chainFor = async (_v: unknown, to: string): Promise<WithdrawChain> => ({
      holdings: async () => ({}),
      withdrawableSol: async () => 1,
      withdraw: async () => {
        tos.push(to);
        return 'SIG';
      },
    });
    await runWithdraw({ db, killSwitch: { isKilled: async () => false }, chainFor }, await vault(), { id: 'w1', mint: SOL_MINT, pct: 100, to: Keypair.generate().publicKey.toBase58() });
    expect(tos).toEqual(['Wallet1111111111111111111111111111111111111']);
  });

  it('imports a wallet from a pasted private key, deletes the message, and counts its balance as the starting deposit', async () => {
    await say('/start');
    expect(callbackOf('📥 Import wallet')).toBe('iw');
    await press('iw');
    expect(last().text).toMatch(/Use a wallet just for Binwise/);
    await say('not a key');
    expect(deleted).toEqual([updateId]);
    expect(last().text).toMatch(/isn't a valid Solana private key/);
    const kp = freshKey();
    walletBalances = { [SOL_MINT]: 1.5, [USDC]: 40 };
    await say(kp.b58);
    expect(deleted.at(-1)).toBe(updateId);
    expect(last().text).toMatch(/Wallet imported/);
    expect(sent.some((m) => m.text.includes(kp.b58))).toBe(false);
    const user = await db.user.findFirstOrThrow({ where: { telegramChatId: String(CHAT) } });
    expect(user.wallet).toBe(kp.pubkey);
    const v = await db.vault.findFirstOrThrow({ where: { userId: user.id } });
    expect(v.mode).toBe('live');
    expect(v.agentPubkey).toBe(kp.pubkey);
    expect(v.deposits).toEqual({ [SOL_MINT]: 1.5, [USDC]: 40 });

    // The same wallet can't be imported into a second chat.
    const other = (text: string) =>
      bot()({ update_id: ++updateId, message: { message_id: updateId, chat: { id: 999, type: 'private' }, text } } as TgUpdate);
    await bot()({ update_id: ++updateId, callback_query: { id: 'x', data: 'iw', message: { message_id: 5, chat: { id: 999, type: 'private' } } } });
    await other(kp.b58);
    expect(last().text).toMatch(/already used on Binwise/);
    expect(await db.vault.count({ where: { agentPubkey: kp.pubkey } })).toBe(1);
  });

  it('deletes a private key pasted without Import, and imports nothing while wallets are closed', async () => {
    const kp = freshKey();
    await say(kp.b58);
    expect(deleted).toEqual([updateId]);
    expect(last().text).toMatch(/looked like a private key/);
    liveOk = false;
    await press('iw');
    expect(last().text).toMatch(/isn't open yet/);
    await say(kp.b58);
    expect(await db.user.count({ where: { telegramChatId: String(CHAT) } })).toBe(0);
  });

  it('sets risk, max per position and pool share from the bot; Add LP and the agent respect the cap', async () => {
    await say('/start code123');
    await press('set');
    expect(last().text).toMatch(/Max per position: <b>no cap/);
    await press('sm|100');
    expect(answers.at(-1)).toBe('Saved');
    expect(last().text).toMatch(/Max per position: <b>\$100<\/b>/);
    expect(callbackOf('✅ $100')).toBe('sm|100');
    // Add LP offers at most the cap.
    await press(`p|${POOL}`);
    expect(last().text).toMatch(/max for this pool now: \$100/);
    // The agent's own sizing respects it too.
    await runManualDeploy(agentDeps(), await vault(), POOL, 0, 'cap');
    expect((await db.position.findFirstOrThrow()).entryValueUsd).toBeLessThanOrEqual(100.01);

    // Typed amount.
    await press('smx');
    await say('abc');
    expect(last().text).toMatch(/Send a dollar amount/);
    await say('$1,250');
    expect(last().text).toMatch(/Max per position: <b>\$1,250<\/b>/);
    // Risk profile applies its preset limits but keeps the cap.
    await press('sr|conservative');
    const st = await db.strategy.findFirstOrThrow();
    expect(st.profile).toBe('conservative');
    expect(st.maxPositionUsd).toBe(1250);
    await press('sc|100');
    expect((await db.strategy.findFirstOrThrow()).minMcap).toBe(100);
    expect(last().text).toMatch(/Minimum token market cap: <b>\$100M<\/b>/);
    await press('sc|7000'); // outside the allowed range
    expect((await db.strategy.findFirstOrThrow()).minMcap).toBe(100);
    await press('sa|40');
    expect((await db.strategy.findFirstOrThrow()).maxAllocPct).toBe(40);
    await press('sm|0');
    expect((await db.strategy.findFirstOrThrow()).maxPositionUsd).toBe(0);
    expect(await db.decision.count({ where: { title: 'Strategy updated' } })).toBe(6);
  });

  it('keeps no new wallets once funds stay in owners\' wallets, and moves a wallet made here into the owner\'s app', async () => {
    // Made here earlier, while Binwise still kept wallets.
    await press('cw');
    walletBalances = { [SOL_MINT]: 1 };
    await press('cwx');
    const v0 = await db.vault.findFirstOrThrow({ where: { user: { telegramChatId: String(CHAT) } } });
    expect(v0.encSecret).not.toBeNull();

    keysClosed = true;
    await press('wal');
    expect(last().text).toMatch(/no longer keeps funds/);
    expect(callbackOf('🔐 Move to my wallet app')).toBe('own');
    await press('own');
    expect(last().text).toContain(`<code>${v0.agentPubkey}</code>`);
    // The key must be saved first: deleting it unseen would lose the wallet.
    await press('ownx');
    expect(last().text).toMatch(/First tap <b>Private key<\/b>/);
    await press('ownxx');
    expect((await db.vault.findUniqueOrThrow({ where: { id: v0.id } })).encSecret).not.toBeNull();
    await press('keyx');
    await press('ownx');
    expect(last().text).toMatch(/Delete the key from Binwise\?/);
    await press('ownxx');
    expect(last().text).toMatch(/no longer has this wallet's key/);
    const v1 = await db.vault.findUniqueOrThrow({ where: { id: v0.id } });
    expect([v1.mode, v1.custody, v1.agentPubkey, v1.encSecret]).toEqual(['live', 'wallet', null, null]);
    // From now on it is the owner's own wallet: the bot sends them to the website to approve.
    await press('wal');
    expect(last().text).toMatch(/Binwise holds no key/);

    // A new chat: no Create / Import, and a pasted key is still deleted, never imported.
    const other = (data: string) => bot()({ update_id: ++updateId, callback_query: { id: 'x', data, message: { message_id: 5, chat: { id: 999, type: 'private' } } } });
    await bot()({ update_id: ++updateId, message: { message_id: updateId, chat: { id: 999, type: 'private' }, text: '/start' } } as TgUpdate);
    expect(last().text).toMatch(/Your funds stay in your own wallet/);
    expect(buttons().map((b) => b.text)).toEqual(['🌐 Open website']);
    await other('cw');
    expect(last().text).toMatch(/no longer keeps wallets/);
    await other('cwx');
    await other('iw');
    expect(last().text).toMatch(/no longer keeps wallets/);
    const kp = freshKey();
    await bot()({ update_id: ++updateId, message: { message_id: updateId, chat: { id: 999, type: 'private' }, text: kp.b58 } } as TgUpdate);
    expect(deleted.at(-1)).toBe(updateId);
    expect(await db.user.count({ where: { telegramChatId: '999' } })).toBe(0);
  });
});
