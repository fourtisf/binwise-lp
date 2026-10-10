import {
  DEFAULT_THRESHOLDS,
  MAX_BINS_EACH_SIDE,
  assessPool,
  binsForHalfWidth,
  dailyStopHit,
  exitReason,
  feesEarnedUsd,
  openPosition,
  positionSizeUsd,
  rangeHalfWidth,
  shapeFor,
  shouldCompound,
  shouldRebalance,
  slippageUsd,
  type CycleDecision,
  type CycleStep,
  type DecisionType,
  type LiquidityShape,
  type PoolAssessment,
  type StrategySettings,
} from '@binwise/core';
import { TX_COUNT, type Executor, type Holdings, type KillSwitch, type PoolCtx, type PositionRef } from '@binwise/chain';
import {
  isStable,
  latestSnapshots,
  strategySettings,
  strategyWeights,
  type Position,
  type PrismaClient,
  type SnapshotWithPool,
  type Strategy,
  type Token,
  type Vault,
} from '@binwise/db';

/**
 * The agent loop (CLAUDE.md §2): Scan → Score → Check positions → Decide → Execute,
 * once per cycle per vault. Paper and live share all of this; only the Executor differs.
 */

export const CYCLE_MS = 60_000;
/** Below this, a deploy isn't worth its fees. */
export const MIN_POSITION_USD = 50;

const STEPS: CycleStep[] = [
  { title: 'Scan', running: 'Reading DLMM pools', done: '' },
  { title: 'Score', running: 'Ranking eligible pools', done: '' },
  { title: 'Check positions', running: 'Comparing price to ranges', done: '' },
  { title: 'Decide', running: 'Weighing fees against cost', done: '' },
  { title: 'Execute', running: 'Sending to Solana', done: '' },
];

export type VaultWithStrategy = Vault & { strategy: Strategy | null };

export interface AgentDeps {
  db: PrismaClient;
  killSwitch: KillSwitch;
  /** Claims an idempotency key; false means the action already ran */
  claimKey: (key: string) => Promise<boolean>;
  executorFor: (vault: VaultWithStrategy) => Promise<Executor>;
  emit: (vaultId: string, e: import('@binwise/core').StreamEvent) => void;
  notify?: (vault: VaultWithStrategy, text: string) => Promise<void>;
  log?: (msg: string) => void;
  now?: () => number;
}

interface PoolView {
  snap: SnapshotWithPool;
  a: PoolAssessment;
  ctx: PoolCtx;
  stablePair: boolean;
  quoteMint: string;
  riskyMint: string | null;
}

type Plan =
  | { kind: 'exit'; pos: Position; view: PoolView; reason: string }
  | { kind: 'rebalance'; pos: Position; view: PoolView; reason: string; binsEachSide: number }
  | { kind: 'compound'; pos: Position; view: PoolView; reason: string }
  | { kind: 'deploy'; view: PoolView; sizeUsd: number; shape: LiquidityShape; binsEachSide: number; reason: string };

const usd = (n: number, d = 0) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pairOf = (v: PoolView) => `${v.snap.pool.tokenA} / ${v.snap.pool.tokenB}`;

/**
 * Range bounds in UI price. Live bin ids come from the SDK and are per-lamport
 * (UI price = per-lamport price × 10^(decimalsX − decimalsY)); paper bins are already UI.
 */
export function rangePrices(p: { binStep: number; lowerBin: number; upperBin: number; address: string | null }, ctx: Pick<PoolCtx, 'decimalsX' | 'decimalsY'>) {
  const f = p.address ? 10 ** (ctx.decimalsX - ctx.decimalsY) : 1;
  const base = 1 + p.binStep / 10_000;
  return { lo: base ** p.lowerBin * f, hi: base ** (p.upperBin + 1) * f };
}

const ref = (p: Position): PositionRef => ({
  address: p.address,
  lowerBin: p.lowerBin,
  upperBin: p.upperBin,
  binStep: p.binStep,
  shape: p.shape,
  bins: (p.bins as number[] | null) ?? null,
  feesUnclaimedUsd: p.feesUnclaimedUsd,
});

function poolView(snap: SnapshotWithPool, tokens: Map<string, Token>, s: StrategySettings, w: ReturnType<typeof strategyWeights>): PoolView | null {
  const tx = tokens.get(snap.pool.mintA);
  const ty = tokens.get(snap.pool.mintB);
  if (!tx || !ty || tx.priceUsd == null || ty.priceUsd == null) return null;
  const allowed = (t: Token) => t.allowed ?? (t.isVerified && t.freezeAuthorityDisabled !== false);
  const a = assessPool(
    {
      tvl: snap.tvl,
      volume24h: snap.volume24h,
      baseFeePct: snap.pool.baseFee,
      volatilityPct: snap.volatility,
      trend7d: snap.trend7d,
      holderQuality: snap.holderQuality,
      mcapM: snap.mcapM,
      bothAllowed: allowed(tx) && allowed(ty),
      emaBearish: snap.emaBearish,
    },
    s,
    w,
  );
  const sx = isStable(tx);
  const sy = isStable(ty);
  return {
    snap,
    a,
    stablePair: sx && sy,
    quoteMint: sx && !sy ? tx.mint : ty.mint,
    riskyMint: sx && sy ? null : sx ? ty.mint : tx.mint,
    ctx: {
      address: snap.poolId,
      binStep: snap.pool.binStep,
      mintX: tx.mint,
      mintY: ty.mint,
      decimalsX: tx.decimals,
      decimalsY: ty.decimals,
      price: snap.price,
      usdX: tx.priceUsd,
      usdY: ty.priceUsd,
      tvlUsd: snap.tvl,
      baseFeePct: snap.pool.baseFee,
      volume24hUsd: snap.volume24h,
      protocolFeePct: snap.pool.protocolFeePct,
    },
  };
}

const holdingsUsd = (h: Holdings, tokens: Map<string, Token>) =>
  Object.entries(h).reduce((sum, [mint, amt]) => sum + amt * (tokens.get(mint)?.priceUsd ?? 0), 0);

/** Runs one full cycle for a vault. Returns the decision shown in the UI. */
export async function runVaultCycle(deps: AgentDeps, vault: VaultWithStrategy): Promise<CycleDecision> {
  const { db } = deps;
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? (() => {});
  const started = now;
  const steps = STEPS.map((x) => ({ ...x }));
  const cycle = vault.cycle + 1;
  await db.vault.update({ where: { id: vault.id }, data: { cycle } });
  const emitStep = (step: number, decision?: CycleDecision) =>
    deps.emit(vault.id, {
      type: 'cycle',
      cycle: { cycle, step, paused: false, intervalMs: CYCLE_MS, elapsedMs: Date.now() - started, steps: steps.map((x) => ({ ...x })), decision },
    });
  const record = async (type: DecisionType, title: string, reason: string, extra: { poolId?: string; inputs?: object; txSigs?: string[]; simulated?: boolean; key?: string } = {}) => {
    const d = await db.decision.create({
      data: {
        vaultId: vault.id,
        poolId: extra.poolId,
        type,
        title,
        reason,
        inputs: extra.inputs ?? {},
        idempotencyKey: extra.key,
      },
    });
    let txSig: string | undefined;
    if (extra.simulated) {
      txSig = `sim-${d.id}`;
      await db.tx.create({ data: { decisionId: d.id, status: 'simulated', simulated: true } });
    } else if (extra.txSigs?.length) {
      txSig = extra.txSigs.at(-1);
      for (const sig of extra.txSigs) await db.tx.create({ data: { decisionId: d.id, sig, status: 'confirmed', simulated: false } });
    }
    if (txSig) await db.decision.update({ where: { id: d.id }, data: { txSig } });
    if (type !== 'hold')
      deps.emit(vault.id, { type: 'decision', decision: { id: d.id, vaultId: vault.id, poolId: extra.poolId, ts: d.ts.getTime(), type, title, reason, txSig } });
    return d;
  };

  const s = strategySettings(vault.strategy!);
  const w = strategyWeights(vault.strategy!);

  // ---- Scan
  emitStep(0);
  const snaps = await latestSnapshots(db, 10);
  if (!snaps.length) {
    const text = "No fresh market data. The collector hasn't reported in the last 10 minutes, so the agent waits.";
    await record('skip', 'Skipped cycle', text);
    return { short: 'Waiting for data', text, tx: false };
  }
  const mints = [...new Set(snaps.flatMap((x) => [x.pool.mintA, x.pool.mintB]))];
  const tokens = new Map((await db.token.findMany({ where: { mint: { in: mints } } })).map((t) => [t.mint, t]));
  const views = snaps.map((x) => poolView(x, tokens, s, w)).filter((v): v is PoolView => !!v);
  const byPool = new Map(views.map((v) => [v.snap.poolId, v]));
  const eligible = views.filter((v) => v.a.eligible).sort((a, b) => b.a.score - a.a.score);
  steps[0].done = `${views.length} pools, ${eligible.length} passed filters`;

  // ---- Score
  emitStep(1);
  const top = [...views].sort((a, b) => b.a.score - a.a.score).slice(0, 2);
  steps[1].done = top.length ? 'Top: ' + top.map((v) => `${pairOf(v)} ${v.a.score}`).join(', ') : 'No pools to rank';

  // ---- Check positions
  emitStep(2);
  const executor = await deps.executorFor(vault);
  const positions = await db.position.findMany({ where: { vaultId: vault.id, status: 'open' } });
  const marked: { pos: Position; view: PoolView | null }[] = [];
  for (const p of positions) {
    const view = byPool.get(p.poolId) ?? null;
    if (!view) {
      marked.push({ pos: p, view: null });
      continue;
    }
    const lastMark = await db.positionMark.findFirst({ where: { positionId: p.id }, orderBy: { ts: 'desc' } });
    const minutes = Math.min(10, (now - (lastMark?.ts ?? p.openedAt).getTime()) / 60_000);
    const m = await executor.mark(ref(p), view.ctx, minutes);
    const holdUsd = p.entryAmountA * view.ctx.usdX + p.entryAmountB * view.ctx.usdY;
    const net = holdUsd > 0 ? ((m.valueUsd + m.feesUsd + p.feesClaimedUsd) / holdUsd - 1) * 100 : 0;
    const { lo, hi } = rangePrices(p, view.ctx);
    const updated = await db.position.update({
      where: { id: p.id },
      data: {
        price: view.ctx.price,
        valueUsd: m.valueUsd,
        feesUnclaimedUsd: m.feesUsd,
        netVsHold: net,
        inRange: m.inRange,
        ticksOut: m.inRange ? 0 : p.ticksOut + 1,
        lowScoreStreak: view.a.score < DEFAULT_THRESHOLDS.exitScore ? p.lowScoreStreak + 1 : 0,
      },
    });
    await db.positionMark.create({ data: { positionId: p.id, price: view.ctx.price, lo, hi, valueUsd: m.valueUsd, holdUsd, netVsHold: net, inRange: m.inRange } });
    deps.emit(vault.id, {
      type: 'tick',
      tick: {
        positionId: p.id,
        price: view.ctx.price,
        lo,
        hi,
        inRange: m.inRange,
        event: m.inRange ? (p.inRange ? 'hold' : 'back') : p.inRange ? 'out' : 'wait',
        marker: false,
        fees: m.feesUsd + p.feesClaimedUsd,
        netVsHold: net,
        rebalances: p.rebalances,
      },
    });
    marked.push({ pos: updated, view });
  }
  const inRangeCount = marked.filter((x) => x.pos.inRange).length;
  steps[2].done = positions.length ? `${inRangeCount} of ${positions.length} positions in range` : 'No open positions';

  // ---- Decide
  emitStep(3);
  const holds: string[] = [];
  const plans: Plan[] = [];
  const killed = await deps.killSwitch.isKilled();
  let cash = await executor.holdings();
  const positionsUsd = marked.reduce((sum, x) => sum + x.pos.valueUsd + x.pos.feesUnclaimedUsd, 0);
  const vaultValue = holdingsUsd(cash, tokens) + positionsUsd;

  // Daily loss stop
  const dayAgo = await db.vaultSnapshot.findFirst({ where: { vaultId: vault.id, ts: { lte: new Date(now - 23 * 3600_000) } }, orderBy: { ts: 'desc' } });
  const stopHit = !!dayAgo && dailyStopHit(vaultValue, dayAgo.value, s.dailyStopPct);

  if (killed) {
    holds.push('Kill switch is on. No trades this cycle.');
  } else if (stopHit) {
    for (const x of marked) if (x.view) plans.push({ kind: 'exit', pos: x.pos, view: x.view, reason: `Vault fell more than ${s.dailyStopPct}% in 24 hours. Daily loss stop.` });
  } else {
    for (const { pos, view } of marked) {
      if (!view) {
        holds.push(`No fresh data for one position's pool, so it is left as is.`);
        continue;
      }
      const marks24 = await db.positionMark.findMany({ where: { positionId: pos.id, ts: { gte: new Date(now - 24 * 3600_000) } }, select: { netVsHold: true } });
      const oldEnough = now - pos.openedAt.getTime() >= 24 * 3600_000;
      const why = exitReason(
        {
          trend7d: view.snap.trend7d,
          trendExitPct: s.trendExitPct,
          emaBearish: view.snap.emaBearish,
          netVsHoldMax24h: oldEnough && marks24.length ? Math.max(...marks24.map((m) => m.netVsHold)) : null,
          lowScoreStreak: pos.lowScoreStreak,
        },
        DEFAULT_THRESHOLDS,
      );
      if (why) {
        plans.push({ kind: 'exit', pos, view, reason: why });
        continue;
      }
      if (!pos.inRange) {
        if (s.toggles.pauseOnVolSpikes && view.snap.volSpike) {
          holds.push(`${pairOf(view)} is out of range during a volatility spike. Waiting it out.`);
          continue;
        }
        const halfWidth = rangeHalfWidth(s.profile, view.snap.volatility, view.stablePair);
        const binsEachSide = Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(halfWidth, view.ctx.binStep));
        const probe = openPosition(pos.valueUsd / view.ctx.usdY, view.ctx.price, view.ctx.binStep, binsEachSide, pos.shape);
        const fees6h = feesEarnedUsd({
          pos: probe,
          price: view.ctx.price,
          quoteUsd: view.ctx.usdY,
          volumeUsd: view.ctx.volume24hUsd / 4,
          baseFeePct: view.ctx.baseFeePct,
          poolTvlUsd: view.ctx.tvlUsd,
        });
        const v = shouldRebalance({
          ticksOutOfRange: pos.ticksOut,
          minutesSinceLastRebalance: pos.lastRebalanceAt ? (now - pos.lastRebalanceAt.getTime()) / 60_000 : null,
          expectedFees6hUsd: fees6h,
          costs: {
            txFeesUsd: executor.txCostUsd(TX_COUNT.close + TX_COUNT.open + TX_COUNT.swap),
            slippageUsd: slippageUsd(pos.valueUsd / 2, view.ctx.tvlUsd),
            priorityUsd: 0,
          },
          onlyWhenProfitable: s.toggles.rebalanceOnlyProfitable,
        });
        if (v.act) plans.push({ kind: 'rebalance', pos, view, reason: v.reason, binsEachSide });
        else holds.push(`${pairOf(view)}: ${v.reason}`);
        continue;
      }
      const gas = executor.txCostUsd(TX_COUNT.claim + 1);
      if (pos.feesUnclaimedUsd >= 1 && shouldCompound(pos.feesUnclaimedUsd, gas, s.toggles.autoCompound))
        plans.push({ kind: 'compound', pos, view, reason: `Gas (${usd(gas, 2)}) is under 1% of the claim, so fees go back into the same bins.` });
    }

    // Deploy idle funds into the best eligible pools.
    const held = new Set(marked.map((x) => x.pos.poolId));
    const maxPositions = Math.max(1, Math.floor(100 / s.maxAllocPct));
    let openCount = marked.length;
    let idleUsd = holdingsUsd(cash, tokens);
    for (const v of eligible) {
      if (openCount >= maxPositions) break;
      if (held.has(v.snap.poolId)) continue;
      if (s.toggles.pauseOnVolSpikes && v.snap.volSpike) continue;
      const size = Math.min(positionSizeUsd(vaultValue, s.maxAllocPct, v.ctx.tvlUsd), idleUsd * 0.98);
      if (size < MIN_POSITION_USD) break;
      const shape = shapeFor(s.profile, v.stablePair, v.snap.volatility);
      const binsEachSide = Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(rangeHalfWidth(s.profile, v.snap.volatility, v.stablePair), v.ctx.binStep));
      plans.push({ kind: 'deploy', view: v, sizeUsd: size, shape, binsEachSide, reason: v.a.reason });
      idleUsd -= size;
      openCount++;
      held.add(v.snap.poolId);
    }
    if (!plans.length) {
      if (!marked.length && !eligible.length) holds.push(`No pool clears your filters right now. Watching ${views.length} pools.`);
      else if (!marked.length && holdingsUsd(cash, tokens) < MIN_POSITION_USD) holds.push('No idle funds to deploy. Deposit to start.');
      else if (!holds.length) holds.push('All positions are in range and trends are healthy. Moving anything now would cost more than it earns.');
    }
  }

  const first = plans[0];
  const short = !plans.length
    ? killed
      ? 'Trading halted'
      : 'Hold all positions'
    : first.kind === 'deploy'
      ? `Deploy to ${pairOf(first.view)}`
      : `${first.kind[0].toUpperCase()}${first.kind.slice(1)} ${pairOf(first.view)}`;
  steps[3].done = plans.length > 1 ? `${short} +${plans.length - 1} more` : short;

  // ---- Execute
  emitStep(4);
  const texts: string[] = [];
  let sentTx = false;
  for (const [i, plan] of plans.entries()) {
    const key = `${vault.id}:${cycle}:${i}:${plan.kind}`;
    if (!(await deps.claimKey(key))) continue;
    try {
      const r = await execute(deps, vault, executor, plan, key, s, tokens, now);
      sentTx = sentTx || r.sent;
      texts.push(r.text);
      await record(plan.kind === 'deploy' ? 'deploy' : plan.kind, r.title, r.text, {
        poolId: plan.view.snap.poolId,
        key,
        inputs: { score: plan.view.a.score, breakdown: plan.view.a.breakdown, ...r.inputs },
        txSigs: r.txSigs,
        simulated: executor.mode === 'paper',
      });
      if (s.toggles.telegramAlerts) await deps.notify?.(vault, `${r.title}. ${r.text}`).catch(() => {});
    } catch (e) {
      const msg = (e as Error).message;
      log(`[agent] vault ${vault.id} ${plan.kind} failed: ${msg}`);
      texts.push(`Couldn't ${plan.kind} ${pairOf(plan.view)}: ${msg}`);
      await record('skip', `Skipped ${plan.kind} on ${pairOf(plan.view)}`, `${msg} Will retry next cycle if the reason still holds.`, { poolId: plan.view.snap.poolId });
      await deps.notify?.(vault, `Action failed on ${pairOf(plan.view)}: ${msg}`).catch(() => {});
    }
  }

  if (stopHit && !killed) {
    await db.vault.update({ where: { id: vault.id }, data: { status: 'paused', pausedReason: `Daily loss stop: down more than ${s.dailyStopPct}% in 24h.` } });
    texts.push(`Vault fell more than ${s.dailyStopPct}% in 24 hours. Closed positions and paused the agent.`);
    await deps.notify?.(vault, `Daily loss stop hit. Binwise closed positions and paused your vault.`).catch(() => {});
  }

  const text = texts.length ? texts.join(' ') : holds.join(' ');
  if (!plans.length) await record(killed ? 'skip' : 'hold', killed ? 'Trading halted' : 'Holding', text);

  // Persist paper balances.
  if (executor.mode === 'paper' && 'balances' in executor) {
    cash = (executor as unknown as { balances: Holdings }).balances;
    await db.vault.update({ where: { id: vault.id }, data: { cash } });
  }
  await snapshotVault(deps, vault.id, tokens, now);

  steps[4].done = !plans.length ? 'No transaction needed' : executor.mode === 'paper' ? 'Simulated fill, paper mode' : sentTx ? 'Confirmed on Solana' : 'Nothing sent';
  const decision: CycleDecision = { short, text, tx: plans.length > 0 };
  emitStep(5, decision);
  return decision;
}

interface ExecResult {
  title: string;
  text: string;
  txSigs: string[];
  sent: boolean;
  inputs: object;
}

async function execute(
  deps: AgentDeps,
  vault: VaultWithStrategy,
  ex: Executor,
  plan: Plan,
  key: string,
  s: StrategySettings,
  tokens: Map<string, Token>,
  now: number,
): Promise<ExecResult> {
  const { db } = deps;
  const v = plan.view;
  const pair = pairOf(v);
  const sigs: string[] = [];

  if (plan.kind === 'deploy') {
    if (ex.mode === 'paper' && 'knownPrices' in ex)
      (ex as unknown as { knownPrices: Record<string, number> }).knownPrices = Object.fromEntries([...tokens.values()].filter((t) => t.priceUsd).map((t) => [t.mint, t.priceUsd!]));
    const r = await ex.open({ pool: v.ctx, valueUsd: plan.sizeUsd, binsEachSide: plan.binsEachSide, shape: plan.shape, key });
    sigs.push(...r.txSigs);
    const pos = await db.position.create({
      data: {
        vaultId: vault.id,
        poolId: v.snap.poolId,
        address: r.address,
        binStep: v.ctx.binStep,
        lowerBin: r.lowerBin,
        upperBin: r.upperBin,
        shape: plan.shape,
        bins: r.bins ?? undefined,
        entryAmountA: r.amountX,
        entryAmountB: r.amountY,
        entryPriceA: v.ctx.usdX,
        entryPriceB: v.ctx.usdY,
        entryValueUsd: r.amountX * v.ctx.usdX + r.amountY * v.ctx.usdY,
        price: v.ctx.price,
        valueUsd: r.amountX * v.ctx.usdX + r.amountY * v.ctx.usdY,
        costsUsd: r.costUsd,
      },
    });
    const value = pos.entryValueUsd;
    return {
      title: `Deployed ${usd(value)} to ${pair}`,
      text: `Score ${v.a.score}, trend ${v.snap.trend7d != null ? (v.snap.trend7d >= 0 ? '+' : '−') + Math.abs(v.snap.trend7d).toFixed(1) + '%' : 'n/a'}, inside the ${s.maxAllocPct}% pool cap. ${plan.shape === 'bidask' ? 'Bid-ask' : plan.shape === 'curve' ? 'Curve' : 'Spot'} over ${plan.binsEachSide * 2 + 1} bins.`,
      txSigs: sigs,
      sent: sigs.length > 0,
      inputs: { positionId: pos.id, sizeUsd: plan.sizeUsd, costUsd: r.costUsd },
    };
  }

  const pos = plan.pos;
  if (plan.kind === 'compound') {
    const r = await ex.compound(ref(pos), v.ctx, key);
    await db.position.update({
      where: { id: pos.id },
      data: { feesUnclaimedUsd: 0, feesClaimedUsd: { increment: r.feesUsd }, costsUsd: { increment: r.costUsd }, ...(r.bins ? { bins: r.bins } : {}) },
    });
    return { title: `Compounded ${usd(r.feesUsd, 2)} in fees`, text: `Claimed from ${pair} and added back to the same bins. ${plan.reason}`, txSigs: r.txSigs, sent: r.txSigs.length > 0, inputs: { positionId: pos.id } };
  }

  // exit and rebalance both start by closing the position
  const closed = await ex.close(ref(pos), v.ctx, key);
  sigs.push(...closed.txSigs);

  if (plan.kind === 'exit') {
    // Step aside: move the risky token into the pair's quote/stable token.
    let swapCost = 0;
    if (v.riskyMint) {
      const risky = v.riskyMint;
      // Sell the whole idle balance of the falling token, not just what this position returned.
      const amt = (await ex.holdings())[risky] ?? 0;
      const pr = (m: string) => (m === v.ctx.mintX ? v.ctx.usdX : v.ctx.usdY);
      if (amt * pr(risky) > 1) {
        const sw = await ex.swap(risky, v.quoteMint, amt, { from: pr(risky), to: pr(v.quoteMint), poolTvlUsd: v.ctx.tvlUsd }, key);
        sigs.push(...sw.txSigs);
        swapCost = sw.costUsd;
      }
    }
    await db.position.update({
      where: { id: pos.id },
      data: { status: 'closed', closedAt: new Date(now), feesUnclaimedUsd: 0, feesClaimedUsd: { increment: closed.feesUsd }, costsUsd: { increment: closed.costUsd + swapCost } },
    });
    const backUsd = closed.amountX * v.ctx.usdX + closed.amountY * v.ctx.usdY + closed.feesUsd;
    const quoteSym = v.quoteMint === v.ctx.mintX ? v.snap.pool.tokenA : v.snap.pool.tokenB;
    return {
      title: `Closed ${pair}`,
      text: `${plan.reason} ${usd(backUsd)} back in the vault${v.riskyMint ? ` as ${quoteSym}` : ''}.`,
      txSigs: sigs,
      sent: sigs.length > 0,
      inputs: { positionId: pos.id },
    };
  }

  // rebalance: re-open centred on the current price, keeping the position's history
  const valueUsd = closed.amountX * v.ctx.usdX + closed.amountY * v.ctx.usdY + closed.feesUsd - closed.costUsd;
  const r = await ex.open({ pool: v.ctx, valueUsd, binsEachSide: plan.binsEachSide, shape: pos.shape, key: `${key}:reopen` });
  sigs.push(...r.txSigs);
  await db.position.update({
    where: { id: pos.id },
    data: {
      address: r.address,
      lowerBin: r.lowerBin,
      upperBin: r.upperBin,
      bins: r.bins ?? undefined,
      inRange: true,
      ticksOut: 0,
      rebalances: { increment: 1 },
      lastRebalanceAt: new Date(now),
      feesUnclaimedUsd: 0,
      feesClaimedUsd: { increment: closed.feesUsd },
      costsUsd: { increment: closed.costUsd + r.costUsd },
    },
  });
  const { lo, hi } = rangePrices({ binStep: pos.binStep, lowerBin: r.lowerBin, upperBin: r.upperBin, address: r.address }, v.ctx);
  await db.positionMark.create({
    data: { positionId: pos.id, price: v.ctx.price, lo, hi, valueUsd: r.amountX * v.ctx.usdX + r.amountY * v.ctx.usdY, holdUsd: pos.entryAmountA * v.ctx.usdX + pos.entryAmountB * v.ctx.usdY, netVsHold: pos.netVsHold, inRange: true, rebalanced: true },
  });
  deps.emit(vault.id, {
    type: 'tick',
    tick: { positionId: pos.id, price: v.ctx.price, lo, hi, inRange: true, event: 'rebalance', marker: true, fees: pos.feesClaimedUsd + closed.feesUsd, netVsHold: pos.netVsHold, rebalances: pos.rebalances + 1 },
  });
  return {
    title: `Rebalanced ${pair}`,
    text: `Price left the range. ${plan.reason}`,
    txSigs: sigs,
    sent: sigs.length > 0,
    inputs: { positionId: pos.id, costUsd: closed.costUsd + r.costUsd },
  };
}

/** Hourly vault snapshot for charts, the daily loss stop and net vs hold. */
async function snapshotVault(deps: AgentDeps, vaultId: string, tokens: Map<string, Token>, now: number) {
  const { db } = deps;
  const last = await db.vaultSnapshot.findFirst({ where: { vaultId }, orderBy: { ts: 'desc' } });
  const v = await vaultValue(db, vaultId, tokens);
  deps.emit(vaultId, {
    type: 'vault',
    vault: {
      value: v.value,
      openValue: (await db.vaultSnapshot.findFirst({ where: { vaultId, ts: { gte: startOfUtcDay(now) } }, orderBy: { ts: 'asc' } }))?.value ?? v.value,
      fees30d: v.fees,
      netVsHold30d: v.hold > 0 ? (v.value / v.hold - 1) * 100 : 0,
      status: v.status,
      mode: v.mode,
      cycle: v.cycle,
    },
  });
  if (last && now - last.ts.getTime() < 55 * 60_000) return;
  await db.vaultSnapshot.create({
    data: { vaultId, ts: new Date(now), value: v.value, holdValue: v.hold, feesTotal: v.fees, netVsHold: v.hold > 0 ? v.value / v.hold - 1 : 0 },
  });
}

export const startOfUtcDay = (now: number) => new Date(Math.floor(now / 86_400_000) * 86_400_000);

/**
 * Vault value = idle cash + positions + unclaimed fees.
 * Hold value = everything ever deposited, valued at today's prices (CLAUDE.md §2).
 */
export async function vaultValue(db: PrismaClient, vaultId: string, tokens?: Map<string, Token>) {
  const vault = await db.vault.findUniqueOrThrow({ where: { id: vaultId }, include: { positions: { where: { status: 'open' } } } });
  const cash = vault.cash as Holdings;
  const deposits = vault.deposits as Holdings;
  const mints = [...new Set([...Object.keys(cash), ...Object.keys(deposits)])].filter((m) => !tokens?.has(m));
  const extra = mints.length ? await db.token.findMany({ where: { mint: { in: mints } } }) : [];
  const price = (m: string) => tokens?.get(m)?.priceUsd ?? extra.find((t) => t.mint === m)?.priceUsd ?? 0;
  const cashUsd = Object.entries(cash).reduce((s, [m, a]) => s + a * price(m), 0);
  const posUsd = vault.positions.reduce((s, p) => s + p.valueUsd + p.feesUnclaimedUsd, 0);
  const hold = Object.entries(deposits).reduce((s, [m, a]) => s + a * price(m), 0);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const recent = await db.position.findMany({ where: { vaultId, OR: [{ status: 'open' }, { closedAt: { gte: since } }] }, select: { feesClaimedUsd: true, feesUnclaimedUsd: true } });
  const fees = recent.reduce((s, p) => s + p.feesClaimedUsd + p.feesUnclaimedUsd, 0);
  return { value: cashUsd + posUsd, hold, fees, mode: vault.mode, status: vault.status, cycle: vault.cycle };
}
