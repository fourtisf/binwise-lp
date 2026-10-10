import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@binwise/core';
import { approveProposal, createVault, ensureUser, getDb, rejectProposal } from '@binwise/db';
import { collectOnce, DEFAULT_COLLECTOR } from './collector';
import { runApprovedProposal, runVaultCycle, type AgentDeps, type VaultWithStrategy } from './agent';
import { FakeMeteora, JUP, POOL, USDC, asMeteora, resetDb } from './test-helpers';
import { PaperExecutor, SetupTooCostly, type Holdings } from '@binwise/chain';

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

  it('reads the trend of the risky token when the stablecoin is X', async () => {
    meteora.flip = true; // USDC/JUP: JUP rising makes the pool price fall
    await collect();
    const snap = await db.poolSnapshot.findFirstOrThrow();
    expect(snap.trend7d!).toBeGreaterThan(0);
    expect(snap.call).toBe('in');
  });

  it('keeps snapshotting a pool with open positions even below the TVL floor', async () => {
    await collect();
    const v = await db.vault.findFirstOrThrow();
    await db.position.create({
      data: { vaultId: v.id, poolId: POOL, binStep: 20, lowerBin: 0, upperBin: 10, shape: 'spot', entryAmountA: 0, entryAmountB: 100, entryPriceA: 1, entryPriceB: 1, entryValueUsd: 100, price: 1, valueUsd: 100 },
    });
    meteora.tvl = 100_000; // far below the floors
    now += 60_000;
    await collect();
    expect(await db.poolSnapshot.count({ where: { poolId: POOL } })).toBe(2);
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

  it('skips a pool whose setup rent is too high and tries it again only after the cooldown', async () => {
    let opens = 0;
    const base = deps();
    const d = (): AgentDeps => ({
      ...base,
      executorFor: async (v) => {
        const ex = new PaperExecutor({ ...(v.cash as Holdings) });
        ex.open = async () => {
          opens++;
          throw new SetupTooCostly('Opening here needs 2 new bin array(s) costing $21.00 in rent.');
        };
        return ex;
      },
    });
    await collect();
    await runVaultCycle(d(), await vault());
    const skip = await db.decision.findFirstOrThrow({ where: { type: 'skip' } });
    expect(skip.reason).toMatch(/retried in 6h/);
    advance(1);
    await collect();
    await runVaultCycle(d(), await vault());
    expect(opens).toBe(1);
    advance(6 * 60 + 1);
    await collect();
    await runVaultCycle(d(), await vault());
    expect(opens).toBe(2);
  });

  it('never deploys more than LIVE_MAX_USD in a live vault', async () => {
    const prev = process.env.LIVE_MAX_USD;
    process.env.LIVE_MAX_USD = '300';
    try {
      const d = (): AgentDeps => ({
        ...deps(),
        // Same fills as paper, but reported as the live executor so live limits apply.
        executorFor: async (v) => Object.defineProperty(new PaperExecutor({ ...(v.cash as Holdings) }), 'mode', { value: 'live' }),
      });
      await collect();
      await runVaultCycle(d(), await vault());
      const pos = await db.position.findFirstOrThrow();
      expect(pos.entryValueUsd).toBeLessThanOrEqual(300);
      expect(pos.entryValueUsd).toBeGreaterThan(250); // normally 25% of $10k = $2,500
      advance(1);
      await collect();
      await runVaultCycle(d(), await vault());
      expect(await db.position.count({ where: { status: 'open' } })).toBe(1); // LIVE_MAX_POSITIONS defaults to 1
    } finally {
      if (prev === undefined) delete process.env.LIVE_MAX_USD;
      else process.env.LIVE_MAX_USD = prev;
    }
  });

  describe('manual mode (ask before trading)', () => {
    const manualMode = async () => {
      const st = await db.strategy.findFirstOrThrow();
      await db.strategy.update({ where: { id: st.id }, data: { toggles: { ...(st.toggles as object), askBeforeTrading: true } } });
    };

    it('proposes a deploy instead of trading, and carries it out once approved', async () => {
      await manualMode();
      const proposals: string[] = [];
      const d = (): AgentDeps => ({ ...deps(), onProposal: async (_v, p) => void proposals.push(p.title) });
      await collect();
      const c1 = await runVaultCycle(d(), await vault());
      expect(c1.short).toBe('Waiting for approval');
      expect(await db.position.count()).toBe(0);
      const p = await db.proposal.findFirstOrThrow();
      expect(p).toMatchObject({ kind: 'deploy', status: 'pending', poolId: POOL });
      expect(p.title).toMatch(/^Deploy \$2,\d{3} to JUP \/ USDC$/);
      expect(proposals).toEqual([p.title]);
      expect(events.some((e) => e.type === 'proposals')).toBe(true);

      // Next cycle: same proposal, no duplicate and no second message.
      advance(1);
      await collect();
      await runVaultCycle(d(), await vault());
      expect(await db.proposal.count()).toBe(1);
      expect(proposals).toHaveLength(1);

      await approveProposal(db, p.vaultId, p.id, now);
      const r = await runApprovedProposal(d(), await vault(), p.id, `approve-${p.id}`);
      expect(r?.title).toMatch(/^Deployed \$2,\d{3} to JUP \/ USDC$/);
      expect(r?.text).toMatch(/Approved by you/);
      expect(await db.position.count({ where: { status: 'open' } })).toBe(1);
      expect((await db.proposal.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('done');
      // Running it again does nothing.
      expect(await runApprovedProposal(d(), await vault(), p.id, `approve-${p.id}`)).toBeNull();
      expect(await db.position.count()).toBe(1);
    });

    it("doesn't ask again for a while after a rejection", async () => {
      await manualMode();
      await collect();
      await cycle();
      const p = await db.proposal.findFirstOrThrow();
      await rejectProposal(db, p.vaultId, p.id, now);
      expect((await db.decision.findFirstOrThrow({ where: { title: { startsWith: 'You rejected' } } })).reason).toMatch(/won't propose this again/);
      advance(1);
      await collect();
      const c = await cycle();
      expect(c.short).toBe('Hold all positions');
      expect(await db.proposal.count({ where: { status: 'pending' } })).toBe(0);
      expect(await db.position.count()).toBe(0);
    });

    it('lets a proposal lapse after an hour; approving it then is refused', async () => {
      await manualMode();
      await collect();
      await cycle();
      const p = await db.proposal.findFirstOrThrow();
      await expect(approveProposal(db, p.vaultId, p.id, now + 61 * 60_000)).rejects.toThrow(/expired/);
      await expect(approveProposal(db, p.vaultId, p.id, now)).rejects.toThrow(/already expired/);
    });

    it('still exits on its own when a risk alarm fires, without waiting for approval', async () => {
      await collect();
      await cycle(); // automatic deploy first
      await manualMode();
      advance(60);
      meteora.tvl = 2_000_000; // −60% in an hour
      await collect();
      const c = await cycle();
      expect(c.short).toBe('Exit JUP / USDC');
      expect((await db.position.findFirstOrThrow()).status).toBe('closed');
      expect(await db.proposal.count()).toBe(0);
    });
  });

  it('keeps all live vaults together under LIVE_MAX_TOTAL_USD', async () => {
    const prev = { one: process.env.LIVE_MAX_USD, all: process.env.LIVE_MAX_TOTAL_USD };
    process.env.LIVE_MAX_USD = '300';
    process.env.LIVE_MAX_TOTAL_USD = '180';
    try {
      await collect();
      const main = await vault();
      // Someone else's live vault already holds $100 in a position.
      const other = await ensureUser(db, 'Other111111111111111111111111111111111111111');
      const ov = await createVault(db, other.id);
      await db.vault.update({ where: { id: ov.id }, data: { mode: 'live' } });
      await db.position.create({
        data: { vaultId: ov.id, poolId: POOL, binStep: 20, lowerBin: 0, upperBin: 10, shape: 'spot', entryAmountA: 0, entryAmountB: 100, entryPriceA: 1, entryPriceB: 1, entryValueUsd: 100, price: 1, valueUsd: 100 },
      });
      const d = (): AgentDeps => ({
        ...deps(),
        executorFor: async (v) => Object.defineProperty(new PaperExecutor({ ...(v.cash as Holdings) }), 'mode', { value: 'live' }),
      });
      await runVaultCycle(d(), main);
      const mine = await db.position.findFirstOrThrow({ where: { vaultId: main.id } });
      expect(mine.entryValueUsd).toBeLessThanOrEqual(80.01);
      expect(mine.entryValueUsd).toBeGreaterThan(70);
    } finally {
      for (const [k, v] of [['LIVE_MAX_USD', prev.one], ['LIVE_MAX_TOTAL_USD', prev.all]] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  describe('failure safety (audit)', () => {
    it('records a rebalance close even when re-opening fails, and keeps cycling afterwards', async () => {
      await collect();
      await cycle();
      meteora.price *= 1.15;
      meteora.volume24h *= 3;
      advance(1);
      await collect();
      await cycle(); // first tick out: wait
      advance(1);
      await collect();
      let opens = 0;
      const d = (): AgentDeps => ({
        ...deps(),
        executorFor: async (v) => {
          const ex = new PaperExecutor({ ...(v.cash as Holdings) });
          const open = ex.open.bind(ex);
          ex.open = async (req) => {
            if (req.key.endsWith(':reopen')) {
              opens++;
              throw new Error('simulated reopen failure');
            }
            return open(req);
          };
          return ex;
        },
      });
      const r = await runVaultCycle(d(), await vault());
      expect(opens).toBe(1);
      expect(r.text).toMatch(/re-opening failed/);
      const pos = await db.position.findFirstOrThrow();
      expect(pos.status).toBe('closed');
      // The money is back as idle cash, not lost and not counted twice.
      const cash = (await vault()).cash as Record<string, number>;
      expect(Object.values(cash).reduce((a, b) => a + b, 0)).toBeGreaterThan(9000);
      advance(1);
      await collect();
      await expect(runVaultCycle(deps(), await vault())).resolves.toBeTruthy();
    });

    it("keeps managing other positions when one can't be read, and closes one that is gone on-chain", async () => {
      await collect();
      await cycle();
      advance(1);
      await collect();
      const failing = (): AgentDeps => ({
        ...deps(),
        executorFor: async (v) => Object.assign(new PaperExecutor({ ...(v.cash as Holdings) }), { mark: async () => Promise.reject(new Error('rpc down')) }),
      });
      await expect(runVaultCycle(failing(), await vault())).resolves.toBeTruthy();
      expect((await db.position.findFirstOrThrow()).status).toBe('open');

      advance(1);
      await collect();
      const gone = (): AgentDeps => ({
        ...deps(),
        executorFor: async (v) =>
          Object.assign(new PaperExecutor({ ...(v.cash as Holdings) }), {
            mark: async () => ({ amountX: 0, amountY: 0, valueUsd: 0, feesUsd: 0, inRange: false, gone: true }),
          }),
      });
      await runVaultCycle(gone(), await vault());
      expect((await db.position.findFirstOrThrow()).status).toBe('closed');
      expect((await db.decision.findFirstOrThrow({ where: { reason: { contains: 'no longer exists on-chain' } } })).type).toBe('exit');
    });

    it("doesn't treat a withdrawal as a loss for the daily stop", async () => {
      await collect();
      const v = await vault();
      // A day ago the vault held $10,000; the owner has since withdrawn $3,000 of it.
      await db.vaultSnapshot.create({ data: { vaultId: v.id, ts: new Date(now - 24 * 3600_000), value: 10_000, holdValue: 10_000, feesTotal: 0, netVsHold: 0 } });
      await db.vault.update({ where: { id: v.id }, data: { cash: { [USDC]: 7_000 } } });
      await db.decision.create({ data: { vaultId: v.id, ts: new Date(now - 3600_000), type: 'exit', title: 'Withdrew 3,000 USDC', reason: '', inputs: { flowUsd: -3000 } } });
      const r = await cycle();
      expect(r.short).not.toMatch(/^Exit/);
      expect((await vault()).status).toBe('running');
    });

    it('exits a held pool that stops getting market data', async () => {
      await collect();
      await cycle();
      // Another pool keeps the collector "alive"; ours goes silent for 20 minutes.
      await db.pool.create({ data: { id: 'Other1111111111111111111111111111111111111', name: 'X-USDC', tokenA: 'X', tokenB: 'USDC', mintA: JUP, mintB: USDC, binStep: 20, baseFee: 0.2 } });
      advance(20);
      const last = await db.poolSnapshot.findFirstOrThrow({ where: { poolId: POOL }, orderBy: { ts: 'desc' } });
      await db.poolSnapshot.create({ data: { ...last, id: undefined, poolId: 'Other1111111111111111111111111111111111111', ts: new Date(now), riskFlags: [], scoreBreakdown: last.scoreBreakdown ?? [] } });
      const r = await cycle();
      expect(r.short).toBe('Exit JUP / USDC');
      expect((await db.decision.findFirstOrThrow({ where: { type: 'exit' } })).reason).toMatch(/No fresh market data for this pool/);
    });
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
