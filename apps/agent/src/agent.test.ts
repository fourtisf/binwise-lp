import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@binwise/core';
import { createVault, ensureUser, getDb } from '@binwise/db';
import { collectOnce, DEFAULT_COLLECTOR } from './collector';
import { runVaultCycle, type AgentDeps, type VaultWithStrategy } from './agent';
import { FakeMeteora, JUP, POOL, USDC, asMeteora, resetDb } from './test-helpers';
import { PaperExecutor, type Holdings } from '@binwise/chain';

const db = getDb();
let meteora: FakeMeteora;
let killed = false;
const events: StreamEvent[] = [];
let now = Date.UTC(2026, 9, 10, 12);
const usedKeys = new Set<string>();

const deps = (): AgentDeps => ({
  db,
  killSwitch: { isKilled: async () => killed },
  claimKey: async (k) => !usedKeys.has(k) && !!usedKeys.add(k),
  executorFor: async (v) => new PaperExecutor({ ...(v.cash as Holdings) }),
  emit: (_id, e) => void events.push(e),
  now: () => now,
});

const collect = () => collectOnce({ db, meteora: asMeteora(meteora), now: () => now }, DEFAULT_COLLECTOR);
const vault = async (): Promise<VaultWithStrategy> => db.vault.findFirstOrThrow({ include: { strategy: true } });
const cycle = async () => runVaultCycle(deps(), await vault());
const advance = (minutes: number) => (now += minutes * 60_000);

beforeAll(async () => {
  // Use a dedicated test database.
  const { execSync } = await import('node:child_process');
  const dbName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  execSync(`psql -h localhost -U binwise -d postgres -c "create database ${dbName}" 2>/dev/null || true`, { stdio: 'ignore' });
  execSync('pnpm --filter @binwise/db exec prisma migrate deploy', { stdio: 'ignore', env: { ...process.env } });
});

beforeEach(async () => {
  await resetDb();
  meteora = new FakeMeteora();
  killed = false;
  events.length = 0;
  usedKeys.clear();
  now = Date.UTC(2026, 9, 10, 12);
  const user = await ensureUser(db, 'Wallet1111111111111111111111111111111111111');
  const v = await createVault(db, user.id, { cash: { [USDC]: 10_000 } });
  await db.vault.update({ where: { id: v.id }, data: { deposits: { [USDC]: 10_000 } } });
});

afterAll(async () => {
  await db.$disconnect();
});

describe('collector', () => {
  it('stores tokens, the pool, candles and a scored snapshot', async () => {
    const r = await collect();
    expect(r).toMatchObject({ scanned: 1, stored: 1, tracked: 1, eligible: 1 });
    const snap = await db.poolSnapshot.findFirstOrThrow();
    expect(snap.score).toBeGreaterThan(62);
    expect(snap.call).toBe('in');
    expect(snap.trend7d!).toBeGreaterThan(0);
    expect((snap.scoreBreakdown as unknown[]).length).toBe(7);
    expect(await db.candle.count({ where: { timeframe: '1h' } })).toBeGreaterThan(150);
    expect((await db.token.findUniqueOrThrow({ where: { mint: JUP } })).holderQuality).toBe(1);
  });

  it('marks downtrending pools as Avoid', async () => {
    meteora.drift = -0.002;
    await collect();
    expect((await db.poolSnapshot.findFirstOrThrow()).call).toBe('out');
  });
});

describe('agent cycle (paper)', () => {
  it('waits when there is no market data', async () => {
    const d = await cycle();
    expect(d.short).toBe('Waiting for data');
    expect((await db.decision.findFirstOrThrow()).type).toBe('skip');
  });

  it('deploys idle funds into an eligible pool and logs the reason', async () => {
    await collect();
    const d = await cycle();
    expect(d.short).toBe('Deploy to JUP / USDC');
    const pos = await db.position.findFirstOrThrow();
    expect(pos.poolId).toBe(POOL);
    expect(pos.entryValueUsd).toBeCloseTo(2500, -1); // 25% of a $10k vault
    const dec = await db.decision.findFirstOrThrow({ where: { type: 'deploy' } });
    expect(dec.title).toMatch(/^Deployed \$2,\d{3} to JUP \/ USDC$/);
    expect(dec.txSig).toMatch(/^sim-/);
    const cash = (await vault()).cash as Record<string, number>;
    expect(cash[USDC]).toBeLessThan(7600);
    const steps = events.filter((e) => e.type === 'cycle').map((e) => (e.type === 'cycle' ? e.cycle.step : -9));
    expect(steps).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('holds when everything is in range and logs a hold decision every cycle', async () => {
    await collect();
    await cycle();
    advance(1);
    await collect();
    const d = await cycle();
    expect(d.short).toBe('Hold all positions');
    const pos = await db.position.findFirstOrThrow();
    expect(pos.feesUnclaimedUsd).toBeGreaterThan(0);
    expect(await db.decision.count({ where: { type: 'hold' } })).toBe(1);
  });

  it('waits a tick after price leaves the range, then rebalances when fees cover costs', async () => {
    await collect();
    await cycle();
    meteora.price *= 1.15;
    advance(1);
    await collect();
    expect((await cycle()).short).toBe('Hold all positions'); // first tick out: wait
    advance(1);
    await collect();
    // The jump reads as an uptrend, so the agent would re-open one-sided above price. That needs
    // swapping the whole position, and at this volume 6h of fees don't cover 1.5× the cost.
    const held = await cycle();
    expect(held.short).toBe('Hold all positions');
    expect(held.text).toMatch(/don't cover 1.5× the move cost/);
    // With more volume the move pays for itself.
    meteora.volume24h *= 3;
    advance(1);
    await collect();
    const d = await cycle();
    expect(d.short).toBe('Rebalance JUP / USDC');
    expect(d.text).toMatch(/one-sided \(above price\)/);
    const pos = await db.position.findFirstOrThrow();
    expect(pos.rebalances).toBe(1);
    expect(pos.inRange).toBe(true);
    // One-sided above price: the range starts at the active bin.
    expect(pos.lowerBin).toBeLessThanOrEqual(Math.floor(Math.log(1.15) / Math.log(1 + pos.binStep / 10_000)) + 1);
    expect(events.some((e) => e.type === 'tick' && e.tick.marker)).toBe(true);
  });

  it('exits a pool when its 7-day trend breaks the rule and steps aside into USDC', async () => {
    await collect();
    await cycle();
    // A week-long slide: replace the stored history with a downtrend.
    meteora.drift = -0.002;
    meteora.price *= 0.7;
    await db.candle.deleteMany();
    advance(5);
    await collect();
    const d = await cycle();
    expect(d.short).toBe('Exit JUP / USDC');
    expect((await db.position.findFirstOrThrow()).status).toBe('closed');
    const cash = (await vault()).cash as Record<string, number>;
    expect(cash[JUP] ?? 0).toBeLessThan(1);
    expect(cash[USDC]).toBeGreaterThan(9000);
  });

  it('exits at once when the pool is drained, then waits out the re-entry cooldown', async () => {
    await collect();
    await cycle();
    advance(60);
    meteora.tvl = 2_000_000; // −60% in an hour
    await collect();
    const d = await cycle();
    expect(d.short).toBe('Exit JUP / USDC');
    expect((await db.decision.findFirstOrThrow({ where: { type: 'exit' } })).reason).toMatch(/TVL fell 60% in the last hour/);
    // An hour later TVL is steady again and the pool is eligible, but the agent waits before re-entering.
    advance(60);
    await collect();
    expect((await db.poolSnapshot.findFirstOrThrow({ orderBy: { ts: 'desc' } })).call).toBe('in');
    await cycle();
    expect(await db.position.count({ where: { status: 'open' } })).toBe(0);
    advance(6 * 60);
    await collect();
    expect((await cycle()).short).toBe('Deploy to JUP / USDC');
  });

  it('stays out of a pool with a token unlock coming up', async () => {
    await db.tokenEvent.create({ data: { mint: JUP, at: new Date(now + 24 * 3600_000), kind: 'unlock', note: '5% of supply' } });
    await collect();
    const snap = await db.poolSnapshot.findFirstOrThrow();
    expect(snap.callLabel).toBe('Avoid, risk');
    expect(snap.reason).toMatch(/JUP unlock on .* \(5% of supply\)/);
    await cycle();
    expect(await db.position.count()).toBe(0);
  });

  it('uses the active parameter set from the database', async () => {
    await db.paramSet.create({ data: { params: { deployScore: 99 }, source: 'manual', active: true } });
    await collect();
    await cycle();
    expect(await db.position.count()).toBe(0);
  });

  it('does nothing while the kill switch is on', async () => {
    await collect();
    killed = true;
    const d = await cycle();
    expect(d.short).toBe('Trading halted');
    expect(await db.position.count()).toBe(0);
  });

  it('closes everything and pauses on the daily loss stop', async () => {
    await collect();
    await cycle();
    const v = await vault();
    await db.vaultSnapshot.create({ data: { vaultId: v.id, ts: new Date(now - 24 * 3600_000), value: 20_000, holdValue: 20_000, feesTotal: 0, netVsHold: 0 } });
    advance(1);
    await collect();
    await cycle();
    const after = await vault();
    expect(after.status).toBe('paused');
    expect(after.pausedReason).toMatch(/Daily loss stop/);
    expect(await db.position.count({ where: { status: 'open' } })).toBe(0);
  });

  it('never runs the same action twice (idempotency)', async () => {
    await collect();
    const v = await vault();
    usedKeys.add(`${v.id}:${v.cycle + 1}:0:deploy`);
    await cycle();
    expect(await db.position.count()).toBe(0);
  });
});
