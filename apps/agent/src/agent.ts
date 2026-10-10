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
  type AgentParams,
  type LiquiditySide,
  type Regime,
  emaSignal,
  exposureHeadroomUsd,
  isUrgent,
  sideForRegime,
  singleSidedAfterExit,
  useSingleRebalance,
} from '@binwise/core';
import { SetupTooCostly, TX_COUNT, type Executor, type Holdings, type KillSwitch, type PoolCtx, type PositionRef } from '@binwise/chain';
import {
  activeParams,
  assessmentInput,
  isStable,
  latestSnapshots,
  startOfUtcDay,
  vaultValue,
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
  /** Active agent parameters (defaults to the database's active ParamSet) */
  params?: () => Promise<AgentParams>;
}

interface PoolView {
  snap: SnapshotWithPool;
  a: PoolAssessment;
  regime: Regime;
  /** Risk signals (depeg, TVL drain, price deviation, unlock) */
  flags: string[];
  /** X is the stablecoin and Y the risky token (regime and trend then describe Y) */
  riskyIsY: boolean;
  ctx: PoolCtx;
  stablePair: boolean;
  quoteMint: string;
  riskyMint: string | null;
}

type Plan =
  | { kind: 'exit'; pos: Position; view: PoolView; reason: string; manual?: boolean }
  | { kind: 'claim'; pos: Position; view: PoolView; reason: string }
  | { kind: 'rebalance'; pos: Position; view: PoolView; reason: string; binsEachSide: number; side: LiquiditySide }
  | { kind: 'compound'; pos: Position; view: PoolView; reason: string }
  | { kind: 'deploy'; view: PoolView; sizeUsd: number; shape: LiquidityShape; binsEachSide: number; side: LiquiditySide; reason: string };

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

async function poolView(
  snap: SnapshotWithPool,
  tokens: Map<string, Token>,
  s: StrategySettings,
  w: ReturnType<typeof strategyWeights>,
  params: AgentParams,
): Promise<PoolView | null> {
  const tx = tokens.get(snap.pool.mintA);
  const ty = tokens.get(snap.pool.mintB);
  if (!tx || !ty || tx.priceUsd == null || ty.priceUsd == null) return null;
  const input = await assessmentInput(snap, tx, ty, params);
  const a = assessPool(input, s, w, params);
  const sx = isStable(tx);
  const sy = isStable(ty);
  return {
    snap,
    a,
    regime: input.regime ?? 'range',
    flags: input.riskFlags,
    riskyIsY: sx && !sy,
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
      // The fee rate LPs were actually paid (includes the dynamic fee), not just the base fee.
      baseFeePct: snap.feeRatePct ?? snap.pool.baseFee,
      volume24hUsd: snap.volume24h,
      protocolFeePct: snap.pool.protocolFeePct,
      activeBinLiqUsd: snap.activeBinLiqUsd,
      farmAprPct: snap.farmAprPct,
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
  const params = deps.params ? await deps.params() : await activeParams(db);

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
  const views = (await Promise.all(snaps.map((x) => poolView(x, tokens, s, w, params)))).filter((v): v is PoolView => !!v);
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
  /** Open positions with their current USD value in X and Y (for the exposure cap) */
  const marked: { pos: Position; view: PoolView | null; xUsd: number; yUsd: number }[] = [];
  for (const p of positions) {
    const view = byPool.get(p.poolId) ?? null;
    if (!view) {
      marked.push({ pos: p, view: null, xUsd: 0, yUsd: 0 });
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
        lowScoreStreak: view.a.score < params.exitScore ? p.lowScoreStreak + 1 : 0,
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
    marked.push({ pos: updated, view, xUsd: m.amountX * view.ctx.usdX, yUsd: m.amountY * view.ctx.usdY });
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

  // Exposure per token: idle cash plus what each position actually holds right now.
  const exposure = new Map<string, number>();
  const addExposure = (mint: string, usdAmt: number) => exposure.set(mint, (exposure.get(mint) ?? 0) + usdAmt);
  for (const [mint, amt] of Object.entries(cash)) addExposure(mint, amt * (tokens.get(mint)?.priceUsd ?? 0));
  for (const x of marked)
    if (x.view) {
      addExposure(x.view.ctx.mintX, x.xUsd);
      addExposure(x.view.ctx.mintY, x.yUsd);
    }
  const stableMint = (m: string) => {
    const t = tokens.get(m);
    return !!t && isStable(t);
  };
  const headroom = (mint: string) => exposureHeadroomUsd(exposure.get(mint) ?? 0, vaultValue, params.maxTokenExposurePct, stableMint(mint));

  if (killed) {
    holds.push('Kill switch is on. No trades this cycle.');
  } else if (stopHit) {
    for (const x of marked) if (x.view) plans.push({ kind: 'exit', pos: x.pos, view: x.view, reason: `Vault fell more than ${s.dailyStopPct}% in 24 hours. Daily loss stop.` });
  } else {
    for (const { pos, view, xUsd, yUsd } of marked) {
      if (!view) {
        holds.push(`No fresh data for one position's pool, so it is left as is.`);
        continue;
      }
      const urgent = view.flags.filter(isUrgent);
      if (urgent.length) {
        plans.push({ kind: 'exit', pos, view, reason: urgent.join(' ') });
        continue;
      }
      const marks24 = await db.positionMark.findMany({ where: { positionId: pos.id, ts: { gte: new Date(now - 24 * 3600_000) } }, select: { netVsHold: true } });
      const oldEnough = now - pos.openedAt.getTime() >= 24 * 3600_000;
      const why = exitReason(
        {
          trend7d: view.snap.trend7d,
          trendExitPct: s.trendExitPct,
          emaBearish: emaSignal(view.snap.emaBearish, view.regime, params),
          netVsHoldMax24h: oldEnough && marks24.length ? Math.max(...marks24.map((m) => m.netVsHold)) : null,
          lowScoreStreak: pos.lowScoreStreak,
        },
        params,
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
        const halfWidth = rangeHalfWidth(s.profile, view.snap.volatility, view.stablePair, params);
        const binsEachSide = Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(halfWidth, view.ctx.binStep));
        const regimeSide = sideForRegime(view.regime, params, view.riskyIsY);
        if (!regimeSide) {
          holds.push(`${pairOf(view)} is out of range in a downtrend. Not re-entering until the trend turns.`);
          continue;
        }
        const { hi } = rangePrices(pos, view.ctx);
        const priceAbove = view.ctx.price >= hi;
        // In a ranging market the cheap mode re-opens one-sided with what we hold (no swap).
        let side: LiquiditySide = useSingleRebalance(view.regime, params) ? singleSidedAfterExit(priceAbove) : regimeSide;
        // A one-sided re-open that buys a token must stay within its exposure cap; otherwise go 50/50.
        if (side !== 'both') {
          const mint = side === 'x' ? view.ctx.mintX : view.ctx.mintY;
          const added = pos.valueUsd - (side === 'x' ? xUsd : yUsd);
          if (added > 1 && added > headroom(mint)) side = 'both';
        }
        const needsSwap = side === 'both' || (side === 'x') === priceAbove;
        const swapUsd = side === 'both' ? pos.valueUsd / 2 : needsSwap ? pos.valueUsd : 0;
        const probe = openPosition(pos.valueUsd / view.ctx.usdY, view.ctx.price, view.ctx.binStep, binsEachSide, pos.shape, side);
        const fees6h = feesEarnedUsd({
          pos: probe,
          price: view.ctx.price,
          quoteUsd: view.ctx.usdY,
          volumeUsd: view.ctx.volume24hUsd / 4,
          baseFeePct: view.ctx.baseFeePct,
          poolTvlUsd: view.ctx.tvlUsd,
          poolActiveLiqUsd: view.ctx.activeBinLiqUsd,
        });
        const v = shouldRebalance({
          ticksOutOfRange: pos.ticksOut,
          minutesSinceLastRebalance: pos.lastRebalanceAt ? (now - pos.lastRebalanceAt.getTime()) / 60_000 : null,
          expectedFees6hUsd: fees6h,
          costs: {
            txFeesUsd: executor.txCostUsd(TX_COUNT.close + TX_COUNT.open + (swapUsd > 0 ? TX_COUNT.swap : 0)),
            slippageUsd: swapUsd > 0 ? slippageUsd(swapUsd, view.ctx.tvlUsd) : 0,
            priorityUsd: 0,
          },
          onlyWhenProfitable: s.toggles.rebalanceOnlyProfitable,
          feeMultiple: params.rebalanceFeeMultiple,
          cooldownMin: params.rebalanceCooldownMin,
        });
        if (v.act) {
          const newX = side === 'both' ? pos.valueUsd / 2 : side === 'x' ? pos.valueUsd : 0;
          addExposure(view.ctx.mintX, newX - xUsd);
          addExposure(view.ctx.mintY, pos.valueUsd - newX - yUsd);
        }
        if (v.act) plans.push({ kind: 'rebalance', pos, view, reason: v.reason + (side !== 'both' ? ` Re-opened one-sided (${side === 'x' ? 'above' : 'below'} price).` : ''), binsEachSide, side });
        else holds.push(`${pairOf(view)}: ${v.reason}`);
        continue;
      }
      const gas = executor.txCostUsd(TX_COUNT.claim + 1);
      if (pos.feesUnclaimedUsd >= 1 && shouldCompound(pos.feesUnclaimedUsd, gas, s.toggles.autoCompound))
        plans.push({ kind: 'compound', pos, view, reason: `Gas (${usd(gas, 2)}) is under 1% of the claim, so fees go back into the same bins.` });
    }

    // Deploy idle funds into the best eligible pools, within the per-token exposure cap.
    const held = new Set(marked.map((x) => x.pos.poolId));
    const maxPositions = Math.max(1, Math.floor(100 / s.maxAllocPct));
    let openCount = marked.length;
    let idleUsd = holdingsUsd(cash, tokens);
    // Pools recently exited, or where opening was skipped because setup rent was too high, wait out the cooldown.
    const recentExits = await db.decision.findMany({
      where: {
        vaultId: vault.id,
        ts: { gte: new Date(now - params.reentryCooldownHours * 3600_000) },
        OR: [{ type: 'exit' }, { type: 'skip', inputs: { path: ['setupTooCostly'], equals: true } }],
      },
      select: { poolId: true },
    });
    const cooling = new Set(recentExits.map((d) => d.poolId));
    for (const v of eligible) {
      if (openCount >= maxPositions) break;
      if (held.has(v.snap.poolId) || cooling.has(v.snap.poolId)) continue;
      if (s.toggles.pauseOnVolSpikes && v.snap.volSpike) continue;
      const side = sideForRegime(v.regime, params, v.riskyIsY);
      if (!side) continue;
      let size = Math.min(positionSizeUsd(vaultValue, s.maxAllocPct, v.ctx.tvlUsd, params), idleUsd * 0.98);
      // Respect the exposure cap for each non-stable token this position would add.
      const shareX = side === 'both' ? 0.5 : side === 'x' ? 1 : 0;
      for (const [mint, share] of [[v.ctx.mintX, shareX], [v.ctx.mintY, 1 - shareX]] as const) {
        if (share <= 0) continue;
        size = Math.min(size, headroom(mint) / share);
      }
      if (size < MIN_POSITION_USD) continue;
      const shape = shapeFor(s.profile, v.stablePair, v.snap.volatility);
      const binsEachSide = Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(rangeHalfWidth(s.profile, v.snap.volatility, v.stablePair, params), v.ctx.binStep));
      plans.push({ kind: 'deploy', view: v, sizeUsd: size, shape, binsEachSide, side, reason: v.a.reason });
      addExposure(v.ctx.mintX, size * shareX);
      addExposure(v.ctx.mintY, size * (1 - shareX));
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
      const r = await execute(deps, vault, executor, plan, key, s, tokens, now, params);
      sentTx = sentTx || r.sent;
      texts.push(r.text);
      await record(plan.kind === 'claim' ? 'compound' : plan.kind, r.title, r.text, {
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
      const costly = e instanceof SetupTooCostly;
      await record(
        'skip',
        `Skipped ${plan.kind} on ${pairOf(plan.view)}`,
        costly ? `${msg} Trying other pools; this one is retried in ${params.reentryCooldownHours}h.` : `${msg} Will retry next cycle if the reason still holds.`,
        { poolId: plan.view.snap.poolId, inputs: costly ? { setupTooCostly: true } : {} },
      );
      if (!costly) await deps.notify?.(vault, `Action failed on ${pairOf(plan.view)}: ${msg}`).catch(() => {});
    }
  }

  if (stopHit && !killed) {
    await db.vault.update({ where: { id: vault.id }, data: { status: 'paused', pausedReason: `Daily loss stop: down more than ${s.dailyStopPct}% in 24h.` } });
    texts.push(`Vault fell more than ${s.dailyStopPct}% in 24 hours. Closed positions and paused the agent.`);
    await deps.notify?.(vault, `Daily loss stop hit. Binwise closed positions and paused your vault.`).catch(() => {});
  }

  const text = texts.length ? texts.join(' ') : holds.join(' ');
  if (!plans.length) await record(killed ? 'skip' : 'hold', killed ? 'Trading halted' : 'Holding', text);

  // Persist idle balances: paper keeps them in the database; live mirrors the vault wallet on-chain
  // so vault value, the daily loss stop and the dashboard all see the same numbers.
  cash = executor.mode === 'paper' && 'balances' in executor ? (executor as unknown as { balances: Holdings }).balances : await executor.holdings();
  await db.vault.update({ where: { id: vault.id }, data: { cash } });
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
  params: AgentParams,
): Promise<ExecResult> {
  const { db } = deps;
  const v = plan.view;
  const pair = pairOf(v);
  const sigs: string[] = [];
  // Prices for idle tokens outside this pool, so the executor can fund positions by swapping.
  if ('knownPrices' in ex)
    (ex as unknown as { knownPrices: Record<string, number> }).knownPrices = Object.fromEntries(
      [...tokens.values()].filter((t) => t.priceUsd).map((t) => [t.mint, t.priceUsd!]),
    );

  if (plan.kind === 'deploy') {
    const r = await ex.open({ pool: v.ctx, valueUsd: plan.sizeUsd, binsEachSide: plan.binsEachSide, shape: plan.shape, side: plan.side, maxBinArrayCostPct: params.maxBinArrayCostPct, key });
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
      text: `${plan.side === 'x' ? 'Trending up, so liquidity sits above price. ' : plan.side === 'y' ? 'Trending up, so liquidity sits below price. ' : ''}Score ${v.a.score}, trend ${v.snap.trend7d != null ? (v.snap.trend7d >= 0 ? '+' : '−') + Math.abs(v.snap.trend7d).toFixed(1) + '%' : 'n/a'}, inside the ${s.maxAllocPct}% pool cap. ${plan.shape === 'bidask' ? 'Bid-ask' : plan.shape === 'curve' ? 'Curve' : 'Spot'} over ${plan.binsEachSide * 2 + 1} bins.`,
      txSigs: sigs,
      sent: sigs.length > 0,
      inputs: { positionId: pos.id, sizeUsd: plan.sizeUsd, costUsd: r.costUsd },
    };
  }

  const pos = plan.pos;
  if (plan.kind === 'claim') {
    const r = await ex.claim(ref(pos), v.ctx, key);
    await db.position.update({ where: { id: pos.id }, data: { feesUnclaimedUsd: 0, feesClaimedUsd: { increment: r.feesUsd }, costsUsd: { increment: r.costUsd } } });
    return { title: `Claimed fees from ${pair}`, text: `${usd(r.feesUsd, 2)} claimed. ${plan.reason}`, txSigs: r.txSigs, sent: r.txSigs.length > 0, inputs: { positionId: pos.id } };
  }
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
    if (v.riskyMint && !plan.manual) {
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
      text: `${plan.reason} ${usd(backUsd)} back in the vault${v.riskyMint && !plan.manual ? ` as ${quoteSym}` : ''}.`,
      txSigs: sigs,
      sent: sigs.length > 0,
      inputs: { positionId: pos.id },
    };
  }

  // rebalance: re-open centred on the current price, keeping the position's history
  const valueUsd = closed.amountX * v.ctx.usdX + closed.amountY * v.ctx.usdY + closed.feesUsd - closed.costUsd;
  const r = await ex.open({ pool: v.ctx, valueUsd, binsEachSide: plan.binsEachSide, shape: pos.shape, side: plan.side, key: `${key}:reopen` });
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

export type ManualAction = 'claim' | 'close';

/** Runs a user's manual Claim / Close from the Positions page, with the same executor and logging. */
export async function runManualAction(deps: AgentDeps, vault: VaultWithStrategy, positionId: string, action: ManualAction, requestId: string) {
  const { db } = deps;
  const pos = await db.position.findFirst({ where: { id: positionId, vaultId: vault.id, status: 'open' } });
  if (!pos) return;
  const snap = await db.poolSnapshot.findFirst({ where: { poolId: pos.poolId }, orderBy: { ts: 'desc' }, include: { pool: true } });
  if (!snap) throw new Error('No market data for this pool yet.');
  const tokens = new Map((await db.token.findMany({ where: { mint: { in: [snap.pool.mintA, snap.pool.mintB] } } })).map((t) => [t.mint, t]));
  const params = deps.params ? await deps.params() : await activeParams(db);
  const view = await poolView(snap, tokens, strategySettings(vault.strategy!), strategyWeights(vault.strategy!), params);
  if (!view) throw new Error('Token prices are missing for this pool.');
  const key = `${vault.id}:manual:${requestId}`;
  if (!(await deps.claimKey(key))) return;
  const executor = await deps.executorFor(vault);
  const plan: Plan =
    action === 'close'
      ? { kind: 'exit', pos, view, reason: 'Manual close. Funds returned to your vault.', manual: true }
      : { kind: 'claim', pos, view, reason: 'Manual claim. Sent to your vault balance.' };
  const r = await execute(deps, vault, executor, plan, key, strategySettings(vault.strategy!), tokens, (deps.now ?? Date.now)(), params);
  const d = await db.decision.create({
    data: { vaultId: vault.id, poolId: pos.poolId, type: action === 'close' ? 'exit' : 'compound', title: r.title, reason: r.text, inputs: { manual: true }, idempotencyKey: key },
  });
  const txSig = executor.mode === 'paper' ? `sim-${d.id}` : r.txSigs.at(-1);
  if (txSig) await db.decision.update({ where: { id: d.id }, data: { txSig } });
  if (executor.mode === 'paper') await db.vault.update({ where: { id: vault.id }, data: { cash: (executor as unknown as { balances: Holdings }).balances } });
  deps.emit(vault.id, { type: 'decision', decision: { id: d.id, vaultId: vault.id, poolId: pos.poolId, ts: d.ts.getTime(), type: d.type, title: d.title, reason: d.reason, txSig } });
}
