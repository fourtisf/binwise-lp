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
