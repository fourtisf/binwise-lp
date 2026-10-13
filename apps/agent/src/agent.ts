import {
  BRAND,
  DEFAULT_THRESHOLDS,
  MAX_BINS_EACH_SIDE,
  assessPool,
  binsForHalfWidth,
  dailyStopHit,
  exitReason,
  customRangeError,
  feesEarnedUsd,
  manualDeployLimit,
  openPosition,
  positionCapUsd,
  positionSizeUsd,
  rangeHalfWidth,
  shapeFor,
  shouldCompound,
  shouldRebalance,
  sideOfRange,
  slippageUsd,
  type CustomRange,
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
} from '@kovra/core';
import { SetupTooCostly, TX_COUNT, liveLimits, minPositionUsd, type Executor, type Holdings, type KillSwitch, type PoolCtx, type PositionRef } from '@kovra/chain';
import {
  activeParams,
  assessmentInput,
  isSelfCustody,
  isStable,
  latestSnapshots,
  liveTotalUsd,
  startOfUtcDay,
  vaultValue,
  strategySettings,
  strategyWeights,
  REJECT_QUIET_HOURS,
  PROPOSAL_TTL_MIN,
  shrinkDeposits,
  type Position,
  type PrismaClient,
  type Proposal as ProposalRow,
  type SnapshotWithPool,
  type Strategy,
  type Token,
  type Vault,
} from '@kovra/db';

/**
 * The agent loop (CLAUDE.md §2): Scan → Score → Check positions → Decide → Execute,
 * once per cycle per vault. Paper and live share all of this; only the Executor differs.
 */

export const CYCLE_MS = 60_000;
/** Below this, a deploy isn't worth its fees. MIN_POSITION_USD in .env (default $50, never below $1). */
export const MIN_POSITION_USD = minPositionUsd();

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
  emit: (vaultId: string, e: import('@kovra/core').StreamEvent) => void;
  notify?: (vault: VaultWithStrategy, text: string) => Promise<void>;
  log?: (msg: string) => void;
  now?: () => number;
  /** Active agent parameters (defaults to the database's active ParamSet) */
  params?: () => Promise<AgentParams>;
  /** Runs `fn` under one lock shared by all vaults (live deploys and the LIVE_MAX_TOTAL_USD check) */
  liveCapacityLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Self-custody: positions a plan prepared for the owner's wallet is changing right now (closing, moving).
   * The website records those once they land; the agent leaves them alone meanwhile.
   */
  pendingPlanPositions?: (vaultId: string) => Promise<Set<string>>;
  /** Manual mode: a new proposal needs the owner's approval (e.g. a Telegram message with buttons) */
  onProposal?: (vault: VaultWithStrategy, proposal: ProposalRow) => Promise<void>;
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
  | { kind: 'exit'; pos: Position; view: PoolView; reason: string; manual?: boolean; urgent?: boolean }
  | { kind: 'claim'; pos: Position; view: PoolView; reason: string }
  | { kind: 'rebalance'; pos: Position; view: PoolView; reason: string; binsEachSide: number; side: LiquiditySide; range?: CustomRange }
  | { kind: 'compound'; pos: Position; view: PoolView; reason: string }
  | { kind: 'deploy'; view: PoolView; sizeUsd: number; shape: LiquidityShape; binsEachSide: number; side: LiquiditySide; reason: string; manual?: boolean; range?: CustomRange };

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
  // A missing or zero price would make every size and cost NaN or infinite.
  const priced = (t: Token | undefined): t is Token => !!t && t.priceUsd != null && Number.isFinite(t.priceUsd) && t.priceUsd > 0;
  if (!priced(tx) || !priced(ty)) return null;
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
      usdX: tx.priceUsd!,
      usdY: ty.priceUsd!,
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

/** The range a position's owner chose by hand (bins below / above the price), if any. */
const customRangeOf = (p: Pick<Position, 'rangeBelow' | 'rangeAbove'>): CustomRange | null =>
  p.rangeBelow != null && p.rangeAbove != null ? { below: p.rangeBelow, above: p.rangeAbove } : null;

const holdingsUsd = (h: Holdings, tokens: Map<string, Token>) =>
  Object.entries(h).reduce((sum, [mint, amt]) => sum + amt * (tokens.get(mint)?.priceUsd ?? 0), 0);

/** Runs one full cycle for a vault. Returns the decision shown in the UI. */
/** A live vault whose key Kovra still holds (from before self-custody): it takes no new money. */
const keyHeldHere = (v: Vault) => v.mode === 'live' && v.custody === 'agent' && !!v.encSecret;

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
        ts: new Date(now),
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
  const snaps = await latestSnapshots(db, 10, now);
  if (!snaps.length) {
    const text = "No fresh market data. The collector hasn't reported in the last 10 minutes, so the agent waits.";
    await record('skip', 'Skipped cycle', text);
    return { short: 'Waiting for data', text, tx: false };
  }
  // Pools we hold a position in are always valued and managed, even if they dropped out of the
  // collector's list: use their latest snapshot, and exit if it gets too old (see below).
  const positions = await db.position.findMany({ where: { vaultId: vault.id, status: 'open' } });
  const fresh = new Set(snaps.map((x) => x.poolId));
  const staleSnaps = (
    await Promise.all(
      [...new Set(positions.map((p) => p.poolId))]
        .filter((id) => !fresh.has(id))
        .map((poolId) => db.poolSnapshot.findFirst({ where: { poolId, ts: { gte: new Date(now - 24 * 3600_000) } }, orderBy: { ts: 'desc' }, include: { pool: true } })),
    )
  ).filter((x): x is SnapshotWithPool => !!x);
  const cashMints = Object.keys(vault.cash as Record<string, number>);
  const mints = [...new Set([...snaps, ...staleSnaps].flatMap((x) => [x.pool.mintA, x.pool.mintB]).concat(cashMints))];
  const tokens = new Map((await db.token.findMany({ where: { mint: { in: mints } } })).map((t) => [t.mint, t]));
  const views = (await Promise.all(snaps.map((x) => poolView(x, tokens, s, w, params)))).filter((v): v is PoolView => !!v);
  const byPool = new Map(views.map((v) => [v.snap.poolId, v]));
  for (const v of (await Promise.all(staleSnaps.map((x) => poolView(x, tokens, s, w, params)))).filter((v): v is PoolView => !!v)) byPool.set(v.snap.poolId, v);
  const eligible = views.filter((v) => v.a.eligible).sort((a, b) => b.a.score - a.a.score);
  steps[0].done = `${views.length} pools, ${eligible.length} passed filters`;

  // ---- Score
  emitStep(1);
  const top = [...views].sort((a, b) => b.a.score - a.a.score).slice(0, 2);
  steps[1].done = top.length ? 'Top: ' + top.map((v) => `${pairOf(v)} ${v.a.score}`).join(', ') : 'No pools to rank';

  // ---- Check positions
  emitStep(2);
  // Self-custody: the funds and positions are in the owner's wallet. The agent only reads them and proposes.
  const selfCustody = isSelfCustody(vault);
  const custodyClosing = keyHeldHere(vault);
  const executor = await deps.executorFor(vault);
  const inPlans = selfCustody && deps.pendingPlanPositions ? await deps.pendingPlanPositions(vault.id).catch(() => new Set<string>()) : new Set<string>();
  if (executor.mode === 'live' && cycle % 5 === 0)
    await reconcileLive(deps, vault, executor, now).catch((e) => log(`[agent] vault ${vault.id} reconcile: ${(e as Error).message}`));
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
    let m: Awaited<ReturnType<Executor['mark']>>;
    try {
      m = await executor.mark(ref(p), view.ctx, minutes);
    } catch (e) {
      // One unreadable position must not stop exits and the loss stop for the others.
      log(`[agent] vault ${vault.id} mark ${p.id} failed: ${(e as Error).message}`);
      marked.push({ pos: p, view: null, xUsd: 0, yUsd: 0 });
      continue;
    }
    if (m.gone && inPlans.has(p.id)) {
      // Closed or moved by a plan the owner just approved: the website records it once Solana shows it.
      marked.push({ pos: p, view: null, xUsd: 0, yUsd: 0 });
      continue;
    }
    if (m.gone) {
      // Closed on-chain already (e.g. an earlier action stopped halfway): its funds are back in the wallet.
      await db.position.update({ where: { id: p.id }, data: { status: 'closed', closedAt: new Date(now), feesUnclaimedUsd: 0 } });
      if (selfCustody) {
        // Closed from the owner's wallet outside Kovra: what came out left the vault's view, like a withdrawal.
        const outUsd = p.valueUsd + p.feesUnclaimedUsd;
        const v = await db.vault.findUniqueOrThrow({ where: { id: vault.id } });
        await db.vault.update({ where: { id: vault.id }, data: { deposits: await shrinkDeposits(db, v.deposits as Holdings, outUsd) } });
        await record('exit', `Closed ${pairOf(view)}`, `This position was closed from your wallet. About ${usd(outUsd)} is back in your wallet.`, {
          poolId: p.poolId,
          inputs: { flowUsd: -outUsd },
        });
      } else await record('exit', `Closed ${pairOf(view)}`, 'This position no longer exists on-chain, so it is marked closed. Its funds are back in the vault wallet.', { poolId: p.poolId });
      continue;
    }
    const holdUsd = p.entryAmountA * view.ctx.usdX + p.entryAmountB * view.ctx.usdY;
    // Reinvested fees (compound, rebalance) are already inside the position value: don't count them twice.
    const net = holdUsd > 0 ? ((m.valueUsd + m.feesUsd + p.feesClaimedUsd - p.feesReinvestedUsd) / holdUsd - 1) * 100 : 0;
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
    await db.positionMark.create({ data: { positionId: p.id, ts: new Date(now), price: view.ctx.price, lo, hi, valueUsd: m.valueUsd, holdUsd, netVsHold: net, inRange: m.inRange } });
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
  // Value counts everything the vault owns (live: including the SOL kept for fees), as the snapshots do.
  const valueCash = executor.mode === 'live' ? await executor.holdings({ includeReserve: true }) : cash;
  const unpriced = Object.keys(valueCash).filter((m) => !tokens.has(m));
  if (unpriced.length) for (const t of await db.token.findMany({ where: { mint: { in: unpriced } } })) tokens.set(t.mint, t);
  const positionsUsd = marked.reduce((sum, x) => sum + x.pos.valueUsd + x.pos.feesUnclaimedUsd, 0);
  const vaultValue = holdingsUsd(valueCash, tokens) + positionsUsd;

  // Daily loss stop, net of money deposited or withdrawn since the snapshot (those aren't gains or losses).
  const dayAgo = await db.vaultSnapshot.findFirst({ where: { vaultId: vault.id, ts: { lte: new Date(now - 23 * 3600_000) } }, orderBy: { ts: 'desc' } });
  const flows = dayAgo
    ? await db.decision.findMany({ where: { vaultId: vault.id, ts: { gt: dayAgo.ts }, type: { in: ['deploy', 'exit'] } }, select: { inputs: true } })
    : [];
  const netFlowUsd = flows.reduce((sum, d) => {
    const f = (d.inputs as { flowUsd?: unknown } | null)?.flowUsd;
    return sum + (typeof f === 'number' && Number.isFinite(f) ? f : 0);
  }, 0);
  const stopHit = !!dayAgo && dailyStopHit(vaultValue - netFlowUsd, dayAgo.value, s.dailyStopPct);

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
    for (const x of marked)
      if (x.view) plans.push({ kind: 'exit', pos: x.pos, view: x.view, reason: `Vault fell more than ${s.dailyStopPct}% in 24 hours. Daily loss stop.`, urgent: true });
  } else {
    for (const { pos, view, xUsd, yUsd } of marked) {
      if (!view) {
        holds.push(`No fresh data for one position's pool, so it is left as is.`);
        continue;
      }
      const staleMin = (now - view.snap.ts.getTime()) / 60_000;
      if (staleMin > 15) {
        plans.push({
          kind: 'exit',
          pos,
          view,
          reason: `No fresh market data for this pool for ${Math.round(staleMin)} minutes (it may have lost liquidity or volume). Exiting to be safe.`,
          urgent: true,
        });
        continue;
      }
      const urgent = view.flags.filter(isUrgent);
      if (urgent.length) {
        plans.push({ kind: 'exit', pos, view, reason: urgent.join(' '), urgent: true });
        continue;
      }
      const marks24 = await db.positionMark.findMany({ where: { positionId: pos.id, ts: { gte: new Date(now - 24 * 3600_000) } }, select: { netVsHold: true } });
      const oldEnough = now - pos.openedAt.getTime() >= 24 * 3600_000;
      // A position opened by hand against the agent's call stays until its owner closes it: only the
      // safety exits above (stale data, pool risk) and the daily loss stop apply.
      const why = pos.manual
        ? null
        : exitReason(
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
        // A range chosen by hand moves with the price but keeps its bins, side and shape.
        const custom = customRangeOf(pos);
        // In a ranging market the cheap mode re-opens one-sided with what we hold (no swap).
        let side: LiquiditySide = custom ? sideOfRange(custom) : useSingleRebalance(view.regime, params) ? singleSidedAfterExit(priceAbove) : regimeSide;
        // A one-sided re-open that buys a token must stay within its exposure cap; otherwise go 50/50.
        if (side !== 'both' && !custom) {
          const mint = side === 'x' ? view.ctx.mintX : view.ctx.mintY;
          const added = pos.valueUsd - (side === 'x' ? xUsd : yUsd);
          if (added > 1 && added > headroom(mint)) side = 'both';
        }
        const needsSwap = side === 'both' || (side === 'x') === priceAbove;
        const swapUsd = side === 'both' ? pos.valueUsd / 2 : needsSwap ? pos.valueUsd : 0;
        const probe = openPosition(pos.valueUsd / view.ctx.usdY, view.ctx.price, view.ctx.binStep, binsEachSide, pos.shape, side, custom ?? undefined);
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
        if (v.act)
          plans.push({
            kind: 'rebalance',
            pos,
            view,
            reason: v.reason + (custom ? ' Same width and shape as you chose.' : side !== 'both' ? ` Re-opened one-sided (${side === 'x' ? 'above' : 'below'} price).` : ''),
            binsEachSide,
            side,
            ...(custom ? { range: custom } : {}),
          });
        else holds.push(`${pairOf(view)}: ${v.reason}`);
        continue;
      }
      const gas = executor.txCostUsd(TX_COUNT.claim + 1);
      if (pos.feesUnclaimedUsd >= 1 && shouldCompound(pos.feesUnclaimedUsd, gas, s.toggles.autoCompound))
        plans.push({ kind: 'compound', pos, view, reason: `Gas (${usd(gas, 2)}) is under 1% of the claim, so fees go back into the same bins.` });
    }

    // Deploy idle funds into the best eligible pools, within the per-token exposure cap.
    const held = new Set(marked.map((x) => x.pos.poolId));
    // Live vaults also respect the hard limits set in .env (LIVE_MAX_USD, LIVE_MAX_POSITIONS).
    const live = executor.mode === 'live' ? liveLimits() : null;
    const maxPositions = Math.min(Math.max(1, Math.floor(100 / s.maxAllocPct)), live?.maxPositions ?? Infinity);
    let openCount = marked.length;
    // A vault whose key Kovra holds takes no new LP: its owner moves the idle funds to their own wallet.
    let idleUsd = custodyClosing ? 0 : holdingsUsd(cash, tokens);
    let liveRoomUsd = live
      ? Math.min(live.maxUsd - marked.reduce((sum, x) => sum + x.pos.valueUsd, 0), live.maxTotalUsd - (await liveTotalUsd(db)))
      : Infinity;
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
      let size = Math.min(positionSizeUsd(vaultValue, s.maxAllocPct, v.ctx.tvlUsd, params), positionCapUsd(s), idleUsd * 0.98, liveRoomUsd);
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
      liveRoomUsd -= size;
      openCount++;
      held.add(v.snap.poolId);
    }
    if (!plans.length) {
      if (!marked.length && !eligible.length) holds.push(`No pool clears your filters right now. Watching ${views.length} pools.`);
      else if (!marked.length && selfCustody) holds.push('No positions yet. Add LP from Pools: you pay from your own wallet and approve it there.');
      else if (custodyClosing && holdingsUsd(cash, tokens) >= MIN_POSITION_USD)
        holds.push(`${BRAND} no longer keeps funds for you, so idle funds aren't deployed. Withdraw them to your own wallet (Portfolio → Withdraw) and add LP from there.`);
      else if (!marked.length && holdingsUsd(cash, tokens) < MIN_POSITION_USD) holds.push('No idle funds to deploy. Deposit to start.');
      else if (!holds.length) holds.push('All positions are in range and trends are healthy. Moving anything now would cost more than it earns.');
    }
  }

  // ---- Manual mode: the agent proposes and waits. Only protective exits (risk alarms,
  // daily loss stop) still run on their own, so a missed message can't cost the vault.
  // Self-custody: everything is a proposal, protective exits too: only the owner's wallet can sign.
  const waiting: string[] = [];
  if ((s.toggles.askBeforeTrading || selfCustody) && !killed) {
    await db.proposal.updateMany({ where: { vaultId: vault.id, status: 'pending', expiresAt: { lt: new Date(now) } }, data: { status: 'expired' } });
    const runsItself = (x: Plan) => !selfCustody && x.kind === 'exit' && !!x.urgent;
    // Self-custody never deploys by itself: the owner adds LP from their wallet.
    for (const p of plans.filter((x) => !runsItself(x) && !(selfCustody && x.kind === 'deploy'))) {
      const title = await propose(deps, vault, p, now);
      if (title) waiting.push(title);
    }
    plans.splice(0, plans.length, ...plans.filter(runsItself));
    if (waiting.length) {
      holds.unshift(`Waiting for your approval: ${waiting.join('; ')}.`);
      deps.emit(vault.id, { type: 'proposals', pending: await db.proposal.count({ where: { vaultId: vault.id, status: 'pending' } }) });
    }
  }

  const first = plans[0];
  const short = !plans.length
    ? killed
      ? 'Trading halted'
      : waiting.length
        ? 'Waiting for approval'
        : 'Hold all positions'
    : first.kind === 'deploy'
      ? `Deploy to ${pairOf(first.view)}`
      : `${first.kind[0].toUpperCase()}${first.kind.slice(1)} ${pairOf(first.view)}`;
  steps[3].done = plans.length > 1 ? `${short} +${plans.length - 1} more` : short;

  // ---- Execute
  emitStep(4);
  const texts: string[] = [];
  let sentTx = false;
  let failedExits = 0;
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
      if (plan.kind === 'exit') failedExits++;
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

  if (stopHit && !killed && selfCustody) {
    // Nothing closes without the owner's wallet: the exits wait as proposals (sent to Telegram when new).
    texts.push(`Vault fell more than ${s.dailyStopPct}% in 24 hours. Daily loss stop: approve closing your positions in your wallet.`);
  } else if (stopHit && !killed && failedExits) {
    // Pausing now would leave positions nobody manages: keep running and retry the exits.
    texts.push(`Daily loss stop: ${failedExits} position(s) couldn't be closed yet. Retrying next cycle before pausing.`);
    await deps.notify?.(vault, `Daily loss stop hit, but ${failedExits} position(s) couldn't be closed yet. Retrying every minute.`).catch(() => {});
  } else if (stopHit && !killed) {
    await db.vault.update({ where: { id: vault.id }, data: { status: 'paused', pausedReason: `Daily loss stop: down more than ${s.dailyStopPct}% in 24h.` } });
    await db.proposal.updateMany({ where: { vaultId: vault.id, status: 'pending' }, data: { status: 'expired' } });
    texts.push(`Vault fell more than ${s.dailyStopPct}% in 24 hours. Closed positions and paused the agent.`);
    await deps.notify?.(vault, `Daily loss stop hit. ${BRAND} closed positions and paused your vault.`).catch(() => {});
  }

  const text = texts.length ? texts.join(' ') : holds.join(' ');
  if (!plans.length) await record(killed ? 'skip' : 'hold', killed ? 'Trading halted' : waiting.length ? 'Waiting for approval' : 'Holding', text);

  // Persist idle balances: paper keeps them in the database; live mirrors the vault wallet on-chain
  // so vault value, the daily loss stop and the dashboard all see the same numbers.
  cash = executor.mode === 'paper' && 'balances' in executor ? (executor as unknown as { balances: Holdings }).balances : await executor.holdings({ includeReserve: true });
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
    // Live: re-check the all-vaults cap and open inside one global lock, so vaults running in
    // parallel can't each see room and together exceed LIVE_MAX_TOTAL_USD.
    const openAndRecord = async () => {
      let size = plan.sizeUsd;
      if (ex.mode === 'live') {
        size = Math.min(size, liveLimits().maxTotalUsd - (await liveTotalUsd(db)));
        if (size < MIN_POSITION_USD) throw new Error('Live capacity is full (LIVE_MAX_TOTAL_USD). Nothing was opened.');
      }
      const r = await ex.open({ pool: v.ctx, valueUsd: size, binsEachSide: plan.binsEachSide, shape: plan.shape, side: plan.side, range: plan.range, maxBinArrayCostPct: params.maxBinArrayCostPct, key });
      sigs.push(...r.txSigs);
      const pos = await db.position.create({
        data: {
          vaultId: vault.id,
          openedAt: new Date(now),
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
          manual: plan.manual ?? false,
          ...(plan.range ? { rangeBelow: plan.range.below, rangeAbove: plan.range.above } : {}),
        },
      });
      return { r, pos };
    };
    const { r, pos } = ex.mode === 'live' && deps.liveCapacityLock ? await deps.liveCapacityLock(openAndRecord) : await openAndRecord();
    const value = pos.entryValueUsd;
    return {
      title: `Deployed ${usd(value)} to ${pair}`,
      text: `${plan.side === 'x' ? 'Trending up, so liquidity sits above price. ' : plan.side === 'y' ? 'Trending up, so liquidity sits below price. ' : ''}Score ${v.a.score}, trend ${v.snap.trend7d != null ? (v.snap.trend7d >= 0 ? '+' : '−') + Math.abs(v.snap.trend7d).toFixed(1) + '%' : 'n/a'}, inside the ${s.maxAllocPct}% pool cap. ${plan.shape === 'bidask' ? 'Bid-ask' : plan.shape === 'curve' ? 'Curve' : 'Spot'} over ${plan.range ? plan.range.below + plan.range.above + 1 : plan.binsEachSide * 2 + 1} bins${plan.range ? ', the range you chose' : ''}.`,
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
      data: {
        feesUnclaimedUsd: 0,
        feesClaimedUsd: { increment: r.feesUsd },
        feesReinvestedUsd: { increment: r.feesUsd },
        costsUsd: { increment: r.costUsd },
        ...(r.bins ? { bins: r.bins } : {}),
      },
    });
    return { title: `Compounded ${usd(r.feesUsd, 2)} in fees`, text: `Claimed from ${pair} and added back to the same bins. ${plan.reason}`, txSigs: r.txSigs, sent: r.txSigs.length > 0, inputs: { positionId: pos.id } };
  }

  // exit and rebalance both start by closing the position. Record the close right away, so a
  // failure in the next step (swap, reopen) can never leave the database pointing at a closed position.
  const closed = await ex.close(ref(pos), v.ctx, key);
  sigs.push(...closed.txSigs);
  await db.position.update({
    where: { id: pos.id },
    data: { status: 'closed', closedAt: new Date(now), feesUnclaimedUsd: 0, feesClaimedUsd: { increment: closed.feesUsd }, costsUsd: { increment: closed.costUsd } },
  });

  if (plan.kind === 'exit') {
    // Step aside: move the risky token into the pair's quote/stable token.
    let swapNote = '';
    if (v.riskyMint && !plan.manual) {
      const risky = v.riskyMint;
      try {
        // Sell the whole idle balance of the falling token, not just what this position returned.
        const amt = (await ex.holdings())[risky] ?? 0;
        const pr = (m: string) => (m === v.ctx.mintX ? v.ctx.usdX : v.ctx.usdY);
        if (amt * pr(risky) > 1) {
          const sw = await ex.swap(risky, v.quoteMint, amt, { from: pr(risky), to: pr(v.quoteMint), poolTvlUsd: v.ctx.tvlUsd }, key);
          sigs.push(...sw.txSigs);
          await db.position.update({ where: { id: pos.id }, data: { costsUsd: { increment: sw.costUsd } } });
        }
      } catch (e) {
        swapNote = ` Couldn't swap into the stable token (${(e as Error).message}); the tokens stay in the vault.`;
      }
    }
    const backUsd = closed.amountX * v.ctx.usdX + closed.amountY * v.ctx.usdY + closed.feesUsd;
    const quoteSym = v.quoteMint === v.ctx.mintX ? v.snap.pool.tokenA : v.snap.pool.tokenB;
    return {
      title: `Closed ${pair}`,
      text: `${plan.reason} ${usd(backUsd)} back in the vault${v.riskyMint && !plan.manual && !swapNote ? ` as ${quoteSym}` : ''}.${swapNote}`,
      txSigs: sigs,
      sent: sigs.length > 0,
      inputs: { positionId: pos.id },
    };
  }

  // rebalance: re-open centred on the current price, keeping the position's history
  const valueUsd = closed.amountX * v.ctx.usdX + closed.amountY * v.ctx.usdY + closed.feesUsd - closed.costUsd;
  let r: Awaited<ReturnType<Executor['open']>>;
  try {
    r = await ex.open({ pool: v.ctx, valueUsd, binsEachSide: plan.binsEachSide, shape: pos.shape, side: plan.side, range: plan.range, maxBinArrayCostPct: params.maxBinArrayCostPct, key: `${key}:reopen` });
  } catch (e) {
    // The old range is closed and recorded; its funds wait in the vault for the next deploy.
    return {
      title: `Closed ${pair}`,
      text: `Price left the range, so the position was closed, but re-opening failed (${(e as Error).message}). ${usd(valueUsd)} is idle in the vault and the agent will deploy it again.`,
      txSigs: sigs,
      sent: sigs.length > 0,
      inputs: { positionId: pos.id, reopenFailed: true },
    };
  }
  sigs.push(...r.txSigs);
  await db.position.update({
    where: { id: pos.id },
    data: {
      status: 'open',
      closedAt: null,
      address: r.address,
      lowerBin: r.lowerBin,
      upperBin: r.upperBin,
      bins: r.bins ?? undefined,
      inRange: true,
      ticksOut: 0,
      rebalances: { increment: 1 },
      lastRebalanceAt: new Date(now),
      // The claimed fees went into the new range.
      feesReinvestedUsd: { increment: closed.feesUsd },
      costsUsd: { increment: r.costUsd },
    },
  });
  const { lo, hi } = rangePrices({ binStep: pos.binStep, lowerBin: r.lowerBin, upperBin: r.upperBin, address: r.address }, v.ctx);
  await db.positionMark.create({
    data: { positionId: pos.id, ts: new Date(now), price: v.ctx.price, lo, hi, valueUsd: r.amountX * v.ctx.usdX + r.amountY * v.ctx.usdY, holdUsd: pos.entryAmountA * v.ctx.usdX + pos.entryAmountB * v.ctx.usdY, netVsHold: pos.netVsHold, inRange: true, rebalanced: true },
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

/**
 * Manual mode: turns a plan into a proposal for the owner. One open proposal per action;
 * nothing is re-asked for a while after the owner rejects it, and a lapsed proposal is
 * re-created quietly (no new message) so the owner isn't nagged.
 * Returns the title when a proposal is waiting, or null when the owner said no recently.
 */
async function propose(deps: AgentDeps, vault: VaultWithStrategy, plan: Plan, now: number): Promise<string | null> {
  const { db } = deps;
  const kind = plan.kind === 'claim' ? 'compound' : plan.kind;
  const poolId = plan.view.snap.poolId;
  const positionId = 'pos' in plan ? plan.pos.id : null;
  const pair = pairOf(plan.view);
  const same = { vaultId: vault.id, kind, poolId, positionId };
  const quiet = await db.proposal.findFirst({ where: { ...same, status: 'rejected', decidedAt: { gte: new Date(now - REJECT_QUIET_HOURS * 3600_000) } } });
  if (quiet) return null;
  const title =
    plan.kind === 'deploy'
      ? `Deploy ${usd(plan.sizeUsd)} to ${pair}`
      : plan.kind === 'rebalance'
        ? `Rebalance ${pair}`
        : plan.kind === 'exit'
          ? `Exit ${pair}`
          : `Compound fees in ${pair}`;
  const details =
    plan.kind === 'deploy'
      ? { pair, sizeUsd: plan.sizeUsd, binsEachSide: plan.binsEachSide, side: plan.side, shape: plan.shape }
      : plan.kind === 'rebalance'
        ? { pair, binsEachSide: plan.binsEachSide, side: plan.side }
        : { pair };
  const open = await db.proposal.findFirst({ where: { ...same, status: 'pending', expiresAt: { gte: new Date(now) } } });
  if (open) {
    // Keep the original expiry; refresh what it says so it reflects the latest data.
    await db.proposal.update({ where: { id: open.id }, data: { title, reason: plan.reason, plan: details } });
    return title;
  }
  const askedRecently = await db.proposal.findFirst({ where: { ...same, createdAt: { gte: new Date(now - REJECT_QUIET_HOURS * 3600_000) } } });
  const created = await db.proposal.create({
    data: { ...same, title, reason: plan.reason, plan: details, createdAt: new Date(now), expiresAt: new Date(now + PROPOSAL_TTL_MIN * 60_000) },
  });
  if (!askedRecently) await deps.onProposal?.(vault, created).catch((e) => deps.log?.(`[agent] proposal notice: ${(e as Error).message}`));
  return title;
}

type LiveChain = {
  recentSignatures(limit?: number): Promise<string[]>;
  depositIn(signature: string): Promise<Record<string, number>>;
  listPositions(): Promise<{ address: string; pool: string; lowerBin: number; upperBin: number; amountX: string; amountY: string }[]>;
};

/**
 * Live vaults, every few cycles: make the database match the chain.
 * - Deposits the app never reported (the user closed the tab before it confirmed) are recorded.
 * - Positions the agent opened but never saved (the process stopped mid-action) are adopted.
 */
async function reconcileLive(deps: AgentDeps, vault: VaultWithStrategy, executor: Executor, now: number) {
  const live = executor as unknown as LiveChain;
  if (typeof live.recentSignatures !== 'function') return;
  const { db } = deps;

  const sigs = await live.recentSignatures(15);
  const seen = new Set([
    ...(await db.decision.findMany({ where: { idempotencyKey: { in: sigs.map((x) => `deposit:${x}`) } }, select: { idempotencyKey: true } })).map((d) => d.idempotencyKey!.slice(8)),
    // The agent's own transactions are never deposits.
    ...(await db.tx.findMany({ where: { sig: { in: sigs } }, select: { sig: true } })).map((t) => t.sig!),
  ]);
  for (const sig of sigs) {
    if (seen.has(sig)) continue;
    const credited = await live.depositIn(sig);
    if (!Object.keys(credited).length) continue;
    const toks = await db.token.findMany({ where: { mint: { in: Object.keys(credited) } } });
    const flowUsd = Object.entries(credited).reduce((sum, [m, a]) => sum + a * (toks.find((t) => t.mint === m)?.priceUsd ?? 0), 0);
    const label = Object.entries(credited)
      .map(([m, a]) => `${a.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${toks.find((t) => t.mint === m)?.symbol ?? m.slice(0, 4)}`)
      .join(' + ');
    const v = await db.vault.findUniqueOrThrow({ where: { id: vault.id } });
    const deposits = { ...(v.deposits as Record<string, number>) };
    for (const [m, a] of Object.entries(credited)) deposits[m] = (deposits[m] ?? 0) + a;
    try {
      await db.$transaction([
        db.decision.create({
          data: {
            vaultId: vault.id,
            ts: new Date(now),
            type: 'deploy',
            title: `Deposited ${label}`,
            reason: 'Found in the vault wallet on-chain. The agent places it on the next cycle.',
            inputs: { flowUsd },
            txSig: sig,
            idempotencyKey: `deposit:${sig}`,
          },
        }),
        db.vault.update({ where: { id: vault.id }, data: { deposits } }),
      ]);
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e; // recorded by the app meanwhile
    }
  }

  const known = new Set((await db.position.findMany({ where: { vaultId: vault.id, address: { not: null } }, select: { address: true, status: true } })).map((p) => p.address!));
  for (const op of await live.listPositions()) {
    if (known.has(op.address)) {
      // Marked closed but still on-chain: manage it again.
      await db.position.updateMany({ where: { vaultId: vault.id, address: op.address, status: 'closed' }, data: { status: 'open', closedAt: null } });
      continue;
    }
    const snap = await db.poolSnapshot.findFirst({ where: { poolId: op.pool }, orderBy: { ts: 'desc' }, include: { pool: true } });
    if (!snap) {
      deps.log?.(`[agent] vault ${vault.id}: untracked position ${op.address} in unknown pool ${op.pool}`);
      continue;
    }
    const [tx, ty] = await Promise.all([db.token.findUnique({ where: { mint: snap.pool.mintA } }), db.token.findUnique({ where: { mint: snap.pool.mintB } })]);
    if (!tx?.priceUsd || !ty?.priceUsd) continue;
    const ax = Number(op.amountX) / 10 ** tx.decimals;
    const ay = Number(op.amountY) / 10 ** ty.decimals;
    const valueUsd = ax * tx.priceUsd + ay * ty.priceUsd;
    await db.position.create({
      data: {
        vaultId: vault.id,
        poolId: op.pool,
        address: op.address,
        binStep: snap.pool.binStep,
        lowerBin: op.lowerBin,
        upperBin: op.upperBin,
        shape: 'spot',
        entryAmountA: ax,
        entryAmountB: ay,
        entryPriceA: tx.priceUsd,
        entryPriceB: ty.priceUsd,
        entryValueUsd: valueUsd,
        price: snap.price,
        valueUsd,
        openedAt: new Date(now),
      },
    });
    await db.decision.create({
      data: {
        vaultId: vault.id,
        poolId: op.pool,
        ts: new Date(now),
        type: 'deploy',
        title: `Found a ${snap.pool.tokenA} / ${snap.pool.tokenB} position`,
        reason: `A position worth about ${usd(valueUsd)} was open on-chain but missing from the records (an action was interrupted). The agent manages it from now on.`,
        inputs: { adopted: op.address },
      },
    });
  }
}

export type ManualAction = 'claim' | 'close';

/** Outcome of a manual request, for the person who made it (app or Telegram). */
export interface ManualResult {
  title: string;
  text: string;
}

/** Records a manual action's decision, persists paper cash and streams it to the app. */
async function recordManual(
  deps: AgentDeps,
  vault: VaultWithStrategy,
  executor: Executor,
  poolId: string,
  type: 'deploy' | 'exit' | 'compound' | 'rebalance',
  r: ExecResult,
  key: string,
  inputs: object,
) {
  const { db } = deps;
  const d = await db.decision.create({
    data: { vaultId: vault.id, ts: new Date((deps.now ?? Date.now)()), poolId, type, title: r.title, reason: r.text, inputs: { manual: true, ...inputs }, idempotencyKey: key },
  });
  const txSig = executor.mode === 'paper' ? `sim-${d.id}` : r.txSigs.at(-1);
  if (txSig) await db.decision.update({ where: { id: d.id }, data: { txSig } });
  if (executor.mode === 'paper') await db.vault.update({ where: { id: vault.id }, data: { cash: (executor as unknown as { balances: Holdings }).balances } });
  deps.emit(vault.id, { type: 'decision', decision: { id: d.id, vaultId: vault.id, poolId, ts: d.ts.getTime(), type: d.type, title: d.title, reason: d.reason, txSig } });
}

/** Runs a user's manual Claim / Close (Positions page or Telegram), with the same executor and logging. */
export function runManualAction(deps: AgentDeps, vault: VaultWithStrategy, positionId: string, action: ManualAction, requestId: string) {
  return runPositionAction(deps, vault, positionId, action === 'close' ? 'exit' : 'claim', requestId);
}

type PositionActionOpts = { reason?: string; binsEachSide?: number; side?: LiquiditySide; stepAside?: boolean };

/** Close / claim / compound / rebalance one open position on the owner's request or approval. */
async function runPositionAction(
  deps: AgentDeps,
  vault: VaultWithStrategy,
  positionId: string,
  kind: 'exit' | 'claim' | 'compound' | 'rebalance',
  requestId: string,
  opts: PositionActionOpts = {},
): Promise<ManualResult | null> {
  const { db } = deps;
  const key = `${vault.id}:manual:${requestId}`;
  const pos = await db.position.findFirst({ where: { id: positionId, vaultId: vault.id, status: 'open' } });
  if (!pos) return opts.reason ? { title: 'Nothing to do', text: 'That position is already closed.' } : null;
  if (kind === 'rebalance' && pos.inRange) return { title: 'No rebalance needed', text: 'Price came back into range, so nothing was done.' };
  const snap = await db.poolSnapshot.findFirst({ where: { poolId: pos.poolId }, orderBy: { ts: 'desc' }, include: { pool: true } });
  if (!snap) throw new Error('No market data for this pool yet.');
  const tokens = new Map((await db.token.findMany({ where: { mint: { in: [snap.pool.mintA, snap.pool.mintB] } } })).map((t) => [t.mint, t]));
  const params = deps.params ? await deps.params() : await activeParams(db);
  const s = strategySettings(vault.strategy!);
  const view = await poolView(snap, tokens, s, strategyWeights(vault.strategy!), params);
  if (!view) throw new Error('Token prices are missing for this pool.');
  if (!(await deps.claimKey(key))) return null;
  const executor = await deps.executorFor(vault);
  const plan: Plan =
    kind === 'exit'
      ? { kind: 'exit', pos, view, reason: opts.reason ?? 'Manual close. Funds returned to your vault.', manual: !opts.stepAside }
      : kind === 'claim'
        ? { kind: 'claim', pos, view, reason: opts.reason ?? 'Manual claim. Sent to your vault balance.' }
        : kind === 'compound'
          ? { kind: 'compound', pos, view, reason: opts.reason ?? 'Fees go back into the same bins.' }
          : {
              kind: 'rebalance',
              pos,
              view,
              reason: opts.reason ?? 'Manual rebalance.',
              binsEachSide: opts.binsEachSide ?? Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(rangeHalfWidth(s.profile, view.snap.volatility, view.stablePair, params), view.ctx.binStep)),
              // A range chosen by hand keeps its bins and side.
              ...(customRangeOf(pos) ? { side: sideOfRange(customRangeOf(pos)!), range: customRangeOf(pos)! } : { side: opts.side ?? 'both' }),
            };
  const r = await execute(deps, vault, executor, plan, key, s, tokens, (deps.now ?? Date.now)(), params);
  await recordManual(deps, vault, executor, pos.poolId, kind === 'claim' ? 'compound' : kind, r, key, {});
  return { title: r.title, text: r.text };
}

/** Carries out a proposal the owner approved (manual mode), re-checking it against the market now. */
export async function runApprovedProposal(deps: AgentDeps, vault: VaultWithStrategy, proposalId: string, requestId: string): Promise<ManualResult | null> {
  const { db } = deps;
  const p = await db.proposal.findFirst({ where: { id: proposalId, vaultId: vault.id } });
  if (!p || p.status !== 'approved') return null;
  const plan = p.plan as { sizeUsd?: number; binsEachSide?: number; side?: LiquiditySide };
  const note = `Approved by you. ${p.reason}`;
  try {
    const r =
      p.kind === 'deploy'
        ? await runManualDeploy(deps, vault, p.poolId!, plan.sizeUsd ?? 0, requestId, 'Approved by you')
        : // An approved exit is the agent's own exit, so it also steps aside into the stable token.
          await runPositionAction(deps, vault, p.positionId!, p.kind as 'exit' | 'compound' | 'rebalance', requestId, { reason: note, stepAside: true, ...plan });
    await db.proposal.update({ where: { id: p.id }, data: { status: 'done', result: r ? `${r.title}. ${r.text}` : 'Already done.' } });
    return r;
  } catch (e) {
    await db.proposal.update({ where: { id: p.id }, data: { status: 'failed', result: (e as Error).message } });
    throw e;
  } finally {
    deps.emit(vault.id, { type: 'proposals', pending: await db.proposal.count({ where: { vaultId: vault.id, status: 'pending' } }) });
  }
}

/**
 * Adds liquidity to one pool on request (Telegram "Add LP"). Same safety as the agent's own
 * deploys: the pool must pass every check right now, the size stays within the strategy's
 * pool cap and the live limits, and the agent manages the position afterwards.
 * `requestedUsd` 0 means "let the agent pick the size".
 */
export async function runManualDeploy(
  deps: AgentDeps,
  vault: VaultWithStrategy,
  poolId: string,
  requestedUsd: number,
  requestId: string,
  source = 'Requested from Telegram',
  /**
   * override: the owner chose a pool the agent wouldn't enter (after a risk warning).
   * shape / range: the owner's own strategy shape and price range (bins below / above the price).
   */
  opts: { override?: boolean; shape?: LiquidityShape; range?: CustomRange } = {},
): Promise<ManualResult | null> {
  const { db } = deps;
  const now = (deps.now ?? Date.now)();
  // A repeated request (double tap) is dropped before anything else.
  const key = `${vault.id}:manual:${requestId}`;
  if (!(await deps.claimKey(key))) return null;
  const snap = await db.poolSnapshot.findFirst({ where: { poolId }, orderBy: { ts: 'desc' }, include: { pool: true } });
  if (!snap) throw new Error('No market data for this pool yet.');
  if (now - snap.ts.getTime() > 10 * 60_000) throw new Error('Market data for this pool is out of date. Try again in a minute.');
  const tokens = new Map((await db.token.findMany()).map((t) => [t.mint, t]));
  const params = deps.params ? await deps.params() : await activeParams(db);
  const s = strategySettings(vault.strategy!);
  const view = await poolView(snap, tokens, s, strategyWeights(vault.strategy!), params);
  if (!view) throw new Error('Token prices are missing for this pool.');
  if (vault.status !== 'running') throw new Error(`The agent is paused${vault.pausedReason ? ` (${vault.pausedReason})` : ''}. Resume it first.`);
  if (keyHeldHere(vault)) throw new Error(`${BRAND} no longer keeps funds for you. Withdraw this vault's funds to your own wallet, then add LP from there on the website.`);
  const override = !!opts.override && !view.a.eligible;
  if (!override) {
    if (!view.a.eligible) throw new Error(`The agent won't enter this pool right now. ${view.a.reason}`);
    if (strategySettings(vault.strategy!).toggles.pauseOnVolSpikes && view.snap.volSpike) throw new Error('Volatility is spiking in this pool. The agent waits it out.');
    const recentExit = await db.decision.findFirst({
      where: { vaultId: vault.id, poolId, type: 'exit', ts: { gte: new Date(now - params.reentryCooldownHours * 3600_000) } },
    });
    if (recentExit) throw new Error(`The agent left this pool less than ${params.reentryCooldownHours}h ago and waits before going back in.`);
  }
  if (opts.range) {
    const bad = customRangeError(opts.range);
    if (bad) throw new Error(bad);
  }
  // By hand against the agent's call: a balanced position, whatever the regime.
  const regimeSide = sideForRegime(view.regime, params, view.riskyIsY) ?? (override ? 'both' : null);
  if (!regimeSide) throw new Error('This pool is in a downtrend. The agent waits for the trend to turn.');
  // The owner's own range sets the side (all above the price: the first token; all below: the second).
  const side = opts.range ? sideOfRange(opts.range) : regimeSide;
  const open = await db.position.findMany({ where: { vaultId: vault.id, status: 'open' } });
  if (open.some((p) => p.poolId === poolId)) throw new Error('You already have a position in this pool.');

  if (await deps.killSwitch.isKilled()) throw new Error('Trading is halted right now (kill switch).');
  const executor = await deps.executorFor(vault);
  const idleUsd = holdingsUsd(await executor.holdings(), tokens);
  const positionsUsd = open.reduce((sum, p) => sum + p.valueUsd, 0);
  const live = executor.mode === 'live' ? liveLimits() : null;
  const limit = manualDeployLimit({
    idleUsd,
    positionsUsd,
    openPositions: open.length,
    poolTvlUsd: view.ctx.tvlUsd,
    capUsd: positionCapUsd(s),
    params,
    live: live ? { maxUsd: live.maxUsd, maxPositions: live.maxPositions, roomTotalUsd: live.maxTotalUsd - (await liveTotalUsd(db)) } : undefined,
  });
  if (limit.limit === 'positions') throw new Error(`Live vaults can hold ${live!.maxPositions} position(s) for now (LIVE_MAX_POSITIONS).`);
  let size = limit.maxUsd;
  if (requestedUsd > 0) size = Math.min(size, requestedUsd);
  if (size < MIN_POSITION_USD) throw new Error(`Not enough idle funds within your limits: at least ${usd(MIN_POSITION_USD)} is needed.`);
  const binsEachSide = Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(rangeHalfWidth(s.profile, view.snap.volatility, view.stablePair, params), view.ctx.binStep));
  const plan: Plan = {
    kind: 'deploy',
    view,
    sizeUsd: size,
    shape: opts.shape ?? shapeFor(s.profile, view.stablePair, view.snap.volatility),
    binsEachSide,
    side,
    reason: override ? `Opened by hand although the agent's call is "${view.a.callLabel}": ${view.a.reason}` : view.a.reason,
    manual: override,
    ...(opts.range ? { range: opts.range } : {}),
  };
  const r = await execute(deps, vault, executor, plan, key, s, tokens, now, params);
  const reduced = requestedUsd > 0 && size < requestedUsd - 1 ? ` Sized down from ${usd(requestedUsd)} to stay within your limits.` : '';
  const result = {
    title: r.title,
    text: override
      ? `${r.text}${reduced} ${source} at your own risk. The agent rebalances and claims fees, but won't close it on its trend rules: close it yourself when you want out.`
      : `${r.text}${reduced} ${source}; the agent manages it from here.`,
  };
  await recordManual(deps, vault, executor, poolId, 'deploy', { ...r, text: result.text }, key, { requestedUsd, sizeUsd: size });
  return result;
}
