import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVault, ensureUser, getDb } from '@binwise/db';
import { PaperExecutor, type Holdings } from '@binwise/chain';
import { collectOnce, DEFAULT_COLLECTOR } from './collector';
import { runManualAction, runManualDeploy, type AgentDeps, type VaultWithStrategy } from './agent';
import { makeBot, proposalMessage, resultMessage, type ManualRequest } from './bot';
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

const tg: TelegramApi = {
  send: async (chatId, text, o) => void sent.push({ chatId, text, keyboard: o?.keyboard }),
  edit: async (chatId, messageId, text, o) => void sent.push({ chatId, text, keyboard: o?.keyboard, messageId }),
  answer: async (_id, text) => void answers.push(text ?? ''),
};
const bot = () => makeBot({ db, tg, enqueue: async (_v, r) => void queue.push(r), appUrl: 'https://binwise.org', now: () => now });
const say = (text: string, chatType: 'private' | 'group' = 'private') =>
  bot()({ update_id: ++updateId, message: { message_id: updateId, chat: { id: CHAT, type: chatType }, text } } as TgUpdate);
const press = (data: string, messageId = 77) =>
  bot()({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, data, message: { message_id: messageId, chat: { id: CHAT, type: 'private' } } } });
const last = () => sent.at(-1)!;
const buttons = () => (last().keyboard ?? []).flat();

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
  usedKeys.clear();
  now = Date.UTC(2026, 9, 10, 12);
  const user = await ensureUser(db, 'Wallet1111111111111111111111111111111111111');
  await db.user.update({ where: { id: user.id }, data: { telegramLinkCode: 'code123' } });
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
    expect(buttons().map((b) => b.text)).toEqual(['📊 Status', '➕ Add LP', '💼 Positions', '🗳 Approvals', '🤖 Mode: Auto', '⏸ Pause agent', '🌐 Open app']);
    // The code works once.
    await say('/start code123');
    expect(last().text).toMatch(/not valid or was already used/);
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
  });

  it('shows positions with Close, asks before closing, and only touches this chat\'s vault', async () => {
    await say('/start code123');
    await runManualDeploy(agentDeps(), await vault(), POOL, 200, 'seed');
    const pos = await db.position.findFirstOrThrow();
    await press('pos');
    expect(last().text).toMatch(/JUP \/ USDC/);
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
    await press('mode');
    expect(last().text).toMatch(/✋ Manual: the agent asks before every trade/);
    expect(buttons().map((b) => b.text)).toContain('✋ Mode: Manual');
    const st = await db.strategy.findFirstOrThrow();
    expect((st.toggles as { askBeforeTrading: boolean }).askBeforeTrading).toBe(true);

    const v = await vault();
    const p = await db.proposal.create({
      data: { vaultId: v.id, kind: 'deploy', poolId: POOL, title: 'Deploy $2,500 to JUP / USDC', reason: 'Score 80.', plan: { pair: 'JUP / USDC', sizeUsd: 2500 }, expiresAt: new Date(now + 3600_000) },
    });
    const msg = proposalMessage(p, now);
    expect(msg.text).toMatch(/Approval needed/);
    expect(msg.text).toMatch(/Expires in 60 min/);
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
    await press('mode');
    expect(await db.proposal.count({ where: { status: 'pending' } })).toBe(0);
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
});
