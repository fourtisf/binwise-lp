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
  ];
  const score = Math.round(clamp(30 + breakdown.reduce((s, c) => s + c.value, 0), 0, 100));
  return { score, breakdown };
}

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
}

export const DEFAULT_THRESHOLDS: AgentThresholds = {
  minTvl: 500_000,
  deployScore: 62,
  exitScore: 45,
  exitScoreStreak: 3,
  maxPoolShare: 0.02,
  netVsHoldExitPct: -3,
  minHolderQuality: 0.5,
};

export interface PoolAssessmentInput extends PoolMetrics {
  /** Smallest market cap of the pair's non-stable tokens, $M (null if unknown) */
  mcapM: number | null;
  bothAllowed: boolean;
  emaBearish: boolean;
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
  if (p.trend7d != null && p.trend7d <= s.trendExitPct)
    return out('out', 'Avoid, downtrend', `7-day trend ${pct1(p.trend7d)} is below your ${s.trendExitPct}% exit rule. The agent won't farm a falling token.`);
  if (p.emaBearish)
    return out('out', 'Avoid, downtrend', 'EMA20 is below EMA50 on the hourly chart. The agent waits for the trend to turn.');
  if (!p.bothAllowed) return out('watch', 'Not on allowlist', 'One of the tokens is not on the allowlist yet.');
  if (s.toggles.holderSafety && p.holderQuality != null && p.holderQuality < t.minHolderQuality)
    return out('out', 'Avoid, holders', 'Holder check failed: supply is too concentrated in a few wallets.');
  if (p.tvl < t.minTvl) return out('watch', 'Below TVL floor', `TVL is under the ${mcapLabel(t.minTvl / 1e6)} floor.`);
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
