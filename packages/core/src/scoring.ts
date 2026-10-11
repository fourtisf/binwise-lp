import type { AgentCall, RiskProfile, ScoreComponent, StrategySettings } from './types';

/**
 * Score weights (CLAUDE.md §2):
 * score = 30 + w1*volTvl + w2*baseFee − w3*volatility + w4*clamp(trend7d) + w5*holderQuality
 * Each term is capped so one metric can't dominate. Stored per vault in Strategy.weights.
 */
export interface ScoreWeights {
  /** points per 1.0x of volume/TVL */
  volTvl: number;
  volTvlCap: number;
  /** points per 1% base fee */
  baseFee: number;
  baseFeeCap: number;
  /** penalty per 1% daily volatility */
  volatility: number;
  /** points per 1% of 7-day trend, clamped to [trendMin, trendMax] */
  trend: number;
  trendMin: number;
  trendMax: number;
  /** points at holderQuality = 1 */
  holder: number;
  /** points per 1 bps/day of fee yield above volatility loss (LVR), clamped */
  edge: number;
  edgeMin: number;
  edgeMax: number;
  /** points per 1% farm reward APR, capped */
  farm: number;
  farmCap: number;
}

const BASE: ScoreWeights = {
  volTvl: 13,
  volTvlCap: 40,
  baseFee: 30,
  baseFeeCap: 16,
  volatility: 2,
  trend: 1.4,
  trendMin: -25,
  trendMax: 12,
  holder: 11,
  edge: 0.4,
  edgeMin: -20,
  edgeMax: 15,
  farm: 0.1,
  farmCap: 8,
};

export const DEFAULT_WEIGHTS: Record<RiskProfile, ScoreWeights> = {
  conservative: { ...BASE, volatility: 3, trendMin: -30 },
  balanced: BASE,
  aggressive: { ...BASE, volatility: 1.2, volTvlCap: 45 },
};

export interface PoolMetrics {
  tvl: number;
  volume24h: number;
  /** percent, e.g. 0.25 */
  baseFeePct: number;
  /** daily realized volatility, percent */
  volatilityPct: number;
  /** 7-day price change, percent (null if unknown) */
  trend7d: number | null;
  /** 0 (worst) … 1 (clean holder distribution). null = not checked */
  holderQuality: number | null;
  /** Real fees paid to LPs over 24h ÷ TVL, percent per day (includes DLMM's dynamic fee). null = unknown */
  feeYieldDailyPct?: number | null;
  /** Liquidity-mining reward APR, percent */
  farmAprPct?: number | null;
}

export interface ScoreResult {
  score: number;
  breakdown: ScoreComponent[];
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function scorePool(m: PoolMetrics, w: ScoreWeights): ScoreResult {
  const volTvl = m.tvl > 0 ? m.volume24h / m.tvl : 0;
  const breakdown: ScoreComponent[] = [
    { label: 'Volume / TVL', value: Math.min(w.volTvlCap, w.volTvl * volTvl) },
    { label: 'Fee tier', value: Math.min(w.baseFeeCap, w.baseFee * m.baseFeePct) },
    { label: 'Volatility', value: -w.volatility * m.volatilityPct },
    { label: '7-day trend', value: clamp(w.trend * (m.trend7d ?? 0), w.trendMin, w.trendMax) },
    { label: 'Holder quality', value: w.holder * (m.holderQuality ?? 0.5) },
    { label: 'Fees vs volatility', value: m.feeYieldDailyPct == null ? 0 : clamp(w.edge * edgeBpsPerDay(m.feeYieldDailyPct, m.volatilityPct), w.edgeMin, w.edgeMax) },
    { label: 'Farm rewards', value: Math.min(w.farmCap, w.farm * (m.farmAprPct ?? 0)) },
  ];
  const score = Math.round(clamp(30 + breakdown.reduce((s, c) => s + c.value, 0), 0, 100));
  return { score, breakdown };
}

/**
 * Loss-versus-rebalancing (LVR) of a constant-product position, percent per day:
 * σ²/8 with σ the daily volatility as a fraction. Fees and LVR scale the same way with
 * concentration, so fee yield − LVR on the same liquidity is the pool's edge for an LP.
 */
export const lvrDailyPct = (volatilityDailyPct: number) => (volatilityDailyPct / 100) ** 2 / 8 * 100;

/** Fee yield minus LVR, in basis points per day. Positive = fees outpace volatility losses. */
export const edgeBpsPerDay = (feeYieldDailyPct: number, volatilityDailyPct: number) =>
  (feeYieldDailyPct - lvrDailyPct(volatilityDailyPct)) * 100;

/** Whether the EMA20/EMA50 signal counts, given the configured mode and the market regime. */
export const emaSignal = (emaBearish: boolean, regime: 'range' | 'up' | 'down' | undefined, t: AgentThresholds = DEFAULT_THRESHOLDS) =>
  emaBearish && (t.emaExitMode === 'always' || regime === 'down');

export const feeAprPct = (volume24h: number, tvl: number, baseFeePct: number) =>
  tvl > 0 ? (volume24h / tvl) * baseFeePct * 365 : 0;

/** Thresholds that aren't per-user settings. */
export interface AgentThresholds {
  /** Minimum TVL for a pool to be considered */
  minTvl: number;
  /** Deploy only at or above this score */
  deployScore: number;
  /** Exit after this many consecutive scans below it */
  exitScore: number;
  exitScoreStreak: number;
  /** Max share of pool TVL one position may take */
  maxPoolShare: number;
  /** Exit when net vs hold stays below this (percent) for 24h */
  netVsHoldExitPct: number;
  /** Holder quality below this fails the safety check */
  minHolderQuality: number;
  /** Multiplies the profile's range width */
  rangeMult: number;
  minHalfWidth: number;
  maxHalfWidth: number;
  /** Rebalance only when expected 6h fees exceed this multiple of the move cost */
  rebalanceFeeMultiple: number;
  rebalanceCooldownMin: number;
  /** balanced = swap back to 50/50; single = re-open one-sided with the token already held (no swap) */
  rebalanceMode: 'balanced' | 'single';
  /** Trending up → one-sided liquidity above price; trending down → no new deploys */
  useRegime: boolean;
  /** Efficiency ratio above which the market counts as trending (0–1) */
  regimeEr: number;
  /** Minimum 24h move, percent, before a market can count as trending */
  regimeMinMovePct: number;
  /** Max share of the vault in any one non-stable token, percent */
  maxTokenExposurePct: number;
  /** Hours to wait before re-entering a pool after an exit */
  reentryCooldownHours: number;
  /** Abort a live open if new bin-array rent exceeds this share of the position, percent */
  maxBinArrayCostPct: number;
  /**
   * EMA20 < EMA50 exit: 'always' (as in the brief) or 'trending' (only when the regime is a
   * confirmed downtrend, which filters out whipsaws in choppy markets).
   */
  emaExitMode: 'always' | 'trending';
}

export const DEFAULT_THRESHOLDS: AgentThresholds = {
  minTvl: 50_000,
  deployScore: 62,
  exitScore: 45,
  exitScoreStreak: 3,
  maxPoolShare: 0.02,
  netVsHoldExitPct: -3,
  minHolderQuality: 0.5,
  rangeMult: 1,
  minHalfWidth: 0.01,
  maxHalfWidth: 0.3,
  rebalanceFeeMultiple: 1.5,
  rebalanceCooldownMin: 30,
  rebalanceMode: 'balanced',
  useRegime: true,
  regimeEr: 0.35,
  regimeMinMovePct: 1,
  maxTokenExposurePct: 60,
  reentryCooldownHours: 6,
  maxBinArrayCostPct: 2,
  emaExitMode: 'always',
};

/** All tunable agent parameters (what the optimizer searches over). */
export type AgentParams = AgentThresholds;
export const DEFAULT_PARAMS = DEFAULT_THRESHOLDS;

export interface PoolAssessmentInput extends PoolMetrics {
  /** Smallest market cap of the pair's non-stable tokens, $M (null if unknown) */
  mcapM: number | null;
  bothAllowed: boolean;
  emaBearish: boolean;
  /** Plain-language risk signals (depeg, TVL drain, price deviation, unlock); any one blocks the pool */
  riskFlags?: string[];
  /** Market regime from hourly candles, when known */
  regime?: 'range' | 'up' | 'down';
}

export interface PoolAssessment extends ScoreResult {
  eligible: boolean;
  call: AgentCall;
  callLabel: string;
  reason: string;
}

const pct1 = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1) + '%';
const mcapLabel = (v: number) => (v >= 1000 ? '$' + (v / 1000).toFixed(1).replace('.0', '') + 'B' : '$' + v + 'M');

/** Scores a pool and turns it into the agent call + the plain-language reason shown in the UI. */
export function assessPool(
  p: PoolAssessmentInput,
  s: StrategySettings,
  w: ScoreWeights,
  t: AgentThresholds = DEFAULT_THRESHOLDS,
): PoolAssessment {
  const r = scorePool(p, w);
  const out = (call: AgentCall, callLabel: string, reason: string, eligible = false): PoolAssessment => ({
    ...r,
    call,
    callLabel,
    reason,
    eligible,
  });
  if (p.riskFlags?.length) return out('out', 'Avoid, risk', `${p.riskFlags.join(' ')} The agent stays out until it clears.`);
  if (p.trend7d != null && p.trend7d <= s.trendExitPct)
    return out('out', 'Avoid, downtrend', `7-day trend ${pct1(p.trend7d)} is below your ${s.trendExitPct}% exit rule. The agent won't farm a falling token.`);
  if (emaSignal(p.emaBearish, p.regime, t))
    return out('out', 'Avoid, downtrend', 'EMA20 is below EMA50 on the hourly chart. The agent waits for the trend to turn.');
  if (!p.bothAllowed) return out('watch', 'Not on allowlist', 'One of the tokens is not on the allowlist yet.');
  if (s.toggles.holderSafety && p.holderQuality != null && p.holderQuality < t.minHolderQuality)
    return out('out', 'Avoid, holders', 'Holder check failed: supply is too concentrated in a few wallets.');
  if (p.tvl < t.minTvl) return out('watch', 'Below TVL floor', `TVL is under the ${t.minTvl >= 1e6 ? mcapLabel(t.minTvl / 1e6) : '$' + Math.round(t.minTvl / 1000) + 'k'} floor.`);
  if (p.mcapM == null) return out('watch', 'Watch', 'Market cap is unknown, so the agent keeps watching.');
  if (p.mcapM < s.minMcapM) return out('watch', 'Below cap floor', `Market cap is below your ${mcapLabel(s.minMcapM)} floor.`);
  if (r.score >= t.deployScore)
    return out(
      'in',
      'Deploy',
      `Score ${r.score} clears the ${t.deployScore} threshold and the trend is healthy. Eligible for up to ${s.maxAllocPct}% of the vault.`,
      true,
    );
  return out('watch', 'Watch', `Score ${r.score} is under ${t.deployScore}. The agent keeps watching and deploys if volume picks up.`);
}
