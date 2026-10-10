/** Market indicators used by scoring and exit rules. All pure. */

export interface Candle {
  /** Unix ms, candle open time */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Traded volume in USD during the candle */
  volumeUsd: number;
}

/** Log returns between consecutive closes. */
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Realized daily volatility in percent.
 * @param closes candle closes, oldest first
 * @param candlesPerDay 288 for 5m candles, 24 for 1h
 */
export function realizedVolatilityPct(closes: number[], candlesPerDay: number): number {
  return stdev(logReturns(closes)) * Math.sqrt(candlesPerDay) * 100;
}

/** Exponential moving average series (same length as input; seeded with the first value). */
export function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** Last EMA value, or null when there isn't enough history to be meaningful. */
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return emaSeries(values, period).at(-1)!;
}

/** Percent change from the close `lookback` candles ago to the last close. */
export function changePct(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const from = closes[closes.length - 1 - lookback];
  const to = closes[closes.length - 1];
  return from > 0 ? (to / from - 1) * 100 : null;
}

export interface TrendState {
  /** 7-day change in percent (null when < 7 days of hourly data) */
  trend7d: number | null;
  ema20: number | null;
  ema50: number | null;
  /** True when EMA20 is below EMA50 on 1h candles: the downtrend exit signal. */
  emaBearish: boolean;
}

/** Trend inputs from hourly closes (oldest first). */
export function trendState(hourlyCloses: number[]): TrendState {
  const ema20 = ema(hourlyCloses, 20);
  const ema50 = ema(hourlyCloses, 50);
  return {
    trend7d: changePct(hourlyCloses, 7 * 24),
    ema20,
    ema50,
    emaBearish: ema20 != null && ema50 != null && ema20 < ema50,
  };
}

export type Regime = 'range' | 'up' | 'down';

/**
 * Kaufman efficiency ratio over the last `lookback` closes: |net move| ÷ total path.
 * Near 0 = choppy (LP-friendly); near 1 = one-way trend (LPs lose to holders).
 */
export function efficiencyRatio(closes: number[], lookback = 24): number {
  if (closes.length <= lookback) return 0;
  const w = closes.slice(-lookback - 1);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i] - w[i - 1]);
  return path > 0 ? Math.abs(w[w.length - 1] - w[0]) / path : 0;
}

/** Market regime from hourly closes: trending up/down when efficient and on the matching side of EMA50. */
export function regimeOf(hourlyCloses: number[], erThreshold = 0.35, lookback = 24): Regime {
  const er = efficiencyRatio(hourlyCloses, lookback);
  if (er < erThreshold) return 'range';
  const e50 = ema(hourlyCloses, 50) ?? hourlyCloses[0];
  const last = hourlyCloses[hourlyCloses.length - 1];
  const move = last - hourlyCloses[hourlyCloses.length - 1 - lookback];
  if (move > 0 && last >= e50) return 'up';
  if (move < 0 && last <= e50) return 'down';
  return 'range';
}

/** Median of daily volume sums from hourly volumes (one-day buckets, most recent last). */
export function medianDailyVolume(hourlyVolumes: number[]): number | null {
  const days: number[] = [];
  for (let end = hourlyVolumes.length; end - 24 >= 0; end -= 24) days.push(hourlyVolumes.slice(end - 24, end).reduce((s, v) => s + v, 0));
  if (days.length < 3) return null;
  const sorted = [...days].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Volume used for scoring: 24h volume, but capped at 2× the 7-day median so a one-off
 * spike (often wash trading) can't inflate the score.
 */
export function volumeForScoring(volume24h: number, medianDaily: number | null): { volume: number; spike: boolean } {
  if (medianDaily == null || medianDaily <= 0) return { volume: volume24h, spike: false };
  return { volume: Math.min(volume24h, medianDaily * 2), spike: volume24h > medianDaily * 3 };
}

/** Fee rate actually paid per trade, percent: fees ÷ volume (includes DLMM's dynamic fee). Falls back to the base fee. */
export function effectiveFeePct(fees: number | null | undefined, volume: number, baseFeePct: number): number {
  if (!fees || volume <= 0) return baseFeePct;
  const r = (fees / volume) * 100;
  // Guard against bad data: stay between the base fee and 10%.
  return Math.min(10, Math.max(baseFeePct, r));
}
