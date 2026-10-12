import type { LiquidityShape, RiskProfile } from './types';
import type { Regime } from './indicators';
import { DEFAULT_THRESHOLDS, type AgentThresholds } from './scoring';

/**
 * Decision rules (CLAUDE.md §2). Pure functions shared by paper mode, live
 * mode and the backtester, so all three make identical decisions.
 */

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** size = min(vault × maxAllocPct, poolTvl × 2%) */
export function positionSizeUsd(vaultValueUsd: number, maxAllocPct: number, poolTvlUsd: number, t: AgentThresholds = DEFAULT_THRESHOLDS) {
  return Math.max(0, Math.min(vaultValueUsd * (maxAllocPct / 100), poolTvlUsd * t.maxPoolShare));
}

/** Which limit decides how much a manual Add LP can put into a pool. */
export type DeployLimit = 'balance' | 'pool' | 'cap' | 'live' | 'positions';

/**
 * The most a manual Add LP puts into one pool right now, and the limit that decides it: the idle
 * funds (2% kept for fees), the pool's depth (at most a share of its TVL), the user's per-position
 * cap, and for live vaults the live limits. Not the strategy's max share of the vault per pool: that
 * spreads the agent's own deploys, while Add LP is the owner putting a chosen amount into a chosen
 * pool. The agent, the API and the website all size Add LP with this, so the amount shown is the
 * amount used.
 */
export function manualDeployLimit(i: {
  idleUsd: number;
  positionsUsd: number;
  openPositions: number;
  poolTvlUsd: number;
  /** positionCapUsd(strategy): Infinity when the user set none */
  capUsd: number;
  params?: AgentThresholds;
  /** Live vaults: LIVE_MAX_USD and LIVE_MAX_POSITIONS per vault, and what LIVE_MAX_TOTAL_USD still allows */
  live?: { maxUsd: number; maxPositions: number; roomTotalUsd: number };
}): { maxUsd: number; limit: DeployLimit } {
  if (i.live && i.openPositions >= i.live.maxPositions) return { maxUsd: 0, limit: 'positions' };
  const caps: [number, DeployLimit][] = [
    [i.idleUsd * 0.98, 'balance'],
    [i.poolTvlUsd * (i.params ?? DEFAULT_THRESHOLDS).maxPoolShare, 'pool'],
    [i.capUsd, 'cap'],
  ];
  if (i.live) caps.push([Math.min(i.live.maxUsd - i.positionsUsd, i.live.roomTotalUsd), 'live']);
  const [maxUsd, limit] = caps.reduce((a, b) => (b[0] < a[0] ? b : a));
  return { maxUsd: Math.max(0, maxUsd), limit };
}

/** Spot for balanced, Curve for stable pairs, Bid-Ask for volatile ones. */
export function shapeFor(profile: RiskProfile, stablePair: boolean, volatilityPct: number): LiquidityShape {
  if (stablePair) return 'curve';
  if (profile === 'aggressive' || volatilityPct >= 6) return 'bidask';
  return 'spot';
}

/** Half-width of the range as a fraction of price. Scales with volatility. */
export function rangeHalfWidth(profile: RiskProfile, volatilityPct: number, stablePair: boolean, t: AgentThresholds = DEFAULT_THRESHOLDS): number {
  if (stablePair) return 0.005;
  const k = (profile === 'conservative' ? 2 : profile === 'aggressive' ? 1 : 1.5) * t.rangeMult;
  return clamp((k * volatilityPct) / 100, t.minHalfWidth, t.maxHalfWidth);
}

/** Which side(s) of the price to provide liquidity on. */
export type LiquiditySide = 'both' | 'x' | 'y';

/**
 * `regime` is the risky token's trend. Trending up: one-sided, holding the risky token, on the
 * side price moves towards (X above price, or Y below price when the risky token is Y), so it
 * keeps upside and sells into strength. Ranging: both sides. Trending down: no new liquidity (null).
 */
export function sideForRegime(regime: Regime, t: AgentThresholds = DEFAULT_THRESHOLDS, riskyIsY = false): LiquiditySide | null {
  if (!t.useRegime || regime === 'range') return 'both';
  return regime === 'up' ? (riskyIsY ? 'y' : 'x') : null;
}

/** Cheap one-sided re-open (no swap) only applies when the market is ranging, or when the regime filter is off. */
export const useSingleRebalance = (regime: Regime, t: AgentThresholds = DEFAULT_THRESHOLDS) =>
  t.rebalanceMode === 'single' && (!t.useRegime || regime === 'range');

/**
 * Side for a cheap ('single') rebalance: re-open with the token the closed position left us,
 * so no swap is needed. Price above the range → we hold the quote → bid below; below → ask above.
 */
export const singleSidedAfterExit = (priceAboveRange: boolean): LiquiditySide => (priceAboveRange ? 'y' : 'x');

/** Bins per side, capped so the whole range fits one DLMM position (≤ 69 bins). */
export const MAX_BINS_EACH_SIDE = 34;

export interface CostInputs {
  /** Network + priority fee for the whole action, USD */
  txFeesUsd: number;
  /** Expected slippage on the swap needed to re-centre, USD */
  slippageUsd: number;
  /** Jito tip / extra priority, USD */
  priorityUsd: number;
}

export const totalCost = (c: CostInputs) => c.txFeesUsd + c.slippageUsd + c.priorityUsd;

/** Slippage estimate for swapping `swapUsd` in a pool: fixed route cost plus size impact. */
export function slippageUsd(swapUsd: number, poolTvlUsd: number, fixedBps = 10): number {
  const impactBps = poolTvlUsd > 0 ? (swapUsd / poolTvlUsd) * 10_000 : 100;
  return swapUsd * (Math.min(300, fixedBps + impactBps) / 10_000);
}

export interface RebalanceInput {
  /** Consecutive cycles the active bin has been outside the range */
  ticksOutOfRange: number;
  minutesSinceLastRebalance: number | null;
  expectedFees6hUsd: number;
  costs: CostInputs;
  /** Strategy toggle: rebalance only when fees beat costs */
  onlyWhenProfitable: boolean;
  feeMultiple?: number;
  cooldownMin?: number;
}

export type RebalanceVerdict =
  | { act: true; reason: string; ratio: number }
  | { act: false; reason: string; ratio?: number };

export const REBALANCE_COOLDOWN_MIN = DEFAULT_THRESHOLDS.rebalanceCooldownMin;
export const REBALANCE_FEE_MULTIPLE = DEFAULT_THRESHOLDS.rebalanceFeeMultiple;
const DEFAULT_COOLDOWN = REBALANCE_COOLDOWN_MIN;
const DEFAULT_FEE_MULTIPLE = REBALANCE_FEE_MULTIPLE;

/** Rebalance only after waiting a tick, outside cooldown, and when 6h fees > 1.5 × costs. */
export function shouldRebalance(r: RebalanceInput): RebalanceVerdict {
  const REBALANCE_COOLDOWN_MIN = r.cooldownMin ?? DEFAULT_COOLDOWN;
  const REBALANCE_FEE_MULTIPLE = r.feeMultiple ?? DEFAULT_FEE_MULTIPLE;
  const cost = totalCost(r.costs);
  const ratio = cost > 0 ? r.expectedFees6hUsd / cost : Infinity;
  if (r.ticksOutOfRange < 1) return { act: false, reason: 'In range.' };
  if (r.ticksOutOfRange < 2) return { act: false, reason: 'Just left the range. Waiting one more tick, since price often snaps back.' };
  if (r.minutesSinceLastRebalance != null && r.minutesSinceLastRebalance < REBALANCE_COOLDOWN_MIN)
    return { act: false, reason: `Rebalanced ${Math.round(r.minutesSinceLastRebalance)} min ago. Cooling down for ${REBALANCE_COOLDOWN_MIN} min.` };
  if (r.onlyWhenProfitable && r.expectedFees6hUsd <= REBALANCE_FEE_MULTIPLE * cost)
    return {
      act: false,
      ratio,
      reason: `Expected fees over 6h ($${r.expectedFees6hUsd.toFixed(2)}) don't cover ${REBALANCE_FEE_MULTIPLE}× the move cost ($${cost.toFixed(2)}). Holding.`,
    };
  return {
    act: true,
    ratio,
    reason: `Fees over 6h ($${r.expectedFees6hUsd.toFixed(2)}) beat the move cost ($${cost.toFixed(2)}) ${ratio === Infinity ? 'easily' : ratio.toFixed(0) + 'x'}.`,
  };
}

export interface ExitInput {
  trend7d: number | null;
  trendExitPct: number;
  emaBearish: boolean;
  /** Highest net-vs-hold (percent) seen over the last 24h; null if the position is younger than 24h */
  netVsHoldMax24h: number | null;
  /** Consecutive scans the pool scored below the exit score */
  lowScoreStreak: number;
}

/** Returns the exit reason, or null to stay. */
export function exitReason(e: ExitInput, t: AgentThresholds = DEFAULT_THRESHOLDS): string | null {
  if (e.trend7d != null && e.trend7d < e.trendExitPct)
    return `7-day trend ${e.trend7d.toFixed(1)}% broke your ${e.trendExitPct}% exit rule.`;
  if (e.emaBearish) return 'EMA20 crossed below EMA50 on the hourly chart.';
  if (e.netVsHoldMax24h != null && e.netVsHoldMax24h < t.netVsHoldExitPct)
    return `Net vs hold stayed below ${t.netVsHoldExitPct}% for 24 hours.`;
  if (e.lowScoreStreak >= t.exitScoreStreak) return `Score stayed under ${t.exitScore} for ${e.lowScoreStreak} scans in a row.`;
  return null;
}

/** Compound claimed fees when gas is under 1% of the claim. */
export const shouldCompound = (claimableUsd: number, gasUsd: number, enabled = true) =>
  enabled && claimableUsd > 0 && gasUsd < claimableUsd * 0.01;

/** Daily loss stop: true when the vault fell more than `stopPct` from its value 24h ago. */
export const dailyStopHit = (valueNow: number, value24hAgo: number, stopPct: number) =>
  value24hAgo > 0 && (valueNow / value24hAgo - 1) * 100 <= -stopPct;

/** Max extra USD that can go into `mint` without its share of the vault passing the cap (Infinity for stables). */
export function exposureHeadroomUsd(currentTokenUsd: number, vaultValueUsd: number, capPct: number, isStable: boolean): number {
  if (isStable || vaultValueUsd <= 0) return Infinity;
  return Math.max(0, (vaultValueUsd * capPct) / 100 - currentTokenUsd);
}
