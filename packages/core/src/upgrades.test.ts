import { describe, expect, it } from 'vitest';
import {
  effectiveFeePct,
  efficiencyRatio,
  medianDailyVolume,
  regimeOf,
  volumeForScoring,
} from './indicators';
import { DEFAULT_PARAMS, DEFAULT_WEIGHTS, assessPool, edgeBpsPerDay, lvrDailyPct, scorePool } from './scoring';
import { composition, openPosition } from './dlmm';
import { exposureHeadroomUsd, rangeHalfWidth, sideForRegime, singleSidedAfterExit, useSingleRebalance } from './rules';
import { riskFlags } from './risk';
import { runBacktest, type BacktestBar, type BacktestPool } from './backtest';
import { optimizeParams } from './optimize';
import { DEFAULT_STRATEGY } from './strategy';
import { gaussFrom } from './testing';

describe('fees vs volatility (LVR edge)', () => {
  it('LVR is σ²/8 per day', () => {
    expect(lvrDailyPct(4)).toBeCloseTo(0.02); // 4% daily vol → 0.02%/day
  });
  it('rewards pools whose fee yield beats volatility loss and penalises the rest', () => {
    const base = { tvl: 5e6, volume24h: 5e6, baseFeePct: 0.2, volatilityPct: 4, trend7d: 2, holderQuality: 1 };
    const good = scorePool({ ...base, feeYieldDailyPct: 0.3 }, DEFAULT_WEIGHTS.balanced);
    const bad = scorePool({ ...base, feeYieldDailyPct: 0.005, volatilityPct: 12 }, DEFAULT_WEIGHTS.balanced);
    expect(edgeBpsPerDay(0.3, 4)).toBeCloseTo(28);
    expect(good.breakdown.find((c) => c.label === 'Fees vs volatility')!.value).toBeGreaterThan(0);
    expect(bad.breakdown.find((c) => c.label === 'Fees vs volatility')!.value).toBeLessThan(0);
  });
  it('counts farm rewards', () => {
    const r = scorePool({ tvl: 1e6, volume24h: 1e6, baseFeePct: 0.2, volatilityPct: 3, trend7d: 0, holderQuality: 1, farmAprPct: 40 }, DEFAULT_WEIGHTS.balanced);
    expect(r.breakdown.find((c) => c.label === 'Farm rewards')!.value).toBe(4);
  });
});

describe('dynamic fee and volume quality', () => {
  it('uses the fee actually paid when it is higher than the base fee', () => {
    expect(effectiveFeePct(3_000, 1_000_000, 0.2)).toBeCloseTo(0.3);
    expect(effectiveFeePct(null, 1_000_000, 0.2)).toBe(0.2);
    expect(effectiveFeePct(500_000, 1_000_000, 0.2)).toBe(10);
  });
  it('caps one-off volume spikes at twice the 7-day median', () => {
    const hourly = Array(24 * 7).fill(1000); // $24k a day
    expect(medianDailyVolume(hourly)).toBe(24_000);
    expect(volumeForScoring(200_000, 24_000)).toEqual({ volume: 48_000, spike: true });
    expect(volumeForScoring(30_000, 24_000)).toEqual({ volume: 30_000, spike: false });
  });
});

describe('market regime', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.004, i));
  const chop = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  it('measures trend efficiency', () => {
    expect(efficiencyRatio(up)).toBeCloseTo(1);
    expect(efficiencyRatio(chop)).toBeLessThan(0.1);
  });
  it('labels trends and chop', () => {
    expect(regimeOf(up)).toBe('up');
    expect(regimeOf(up.map((p) => 1 / p))).toBe('down');
    expect(regimeOf(chop)).toBe('range');
  });
  it('goes one-sided above price in an uptrend and stays out of downtrends', () => {
    expect(sideForRegime('range')).toBe('both');
    expect(sideForRegime('up')).toBe('x');
    expect(sideForRegime('down')).toBeNull();
    expect(sideForRegime('up', { ...DEFAULT_PARAMS, useRegime: false })).toBe('both');
  });
  it('does not call a one-tick move in a flat market a trend', () => {
    // A stable pair stepping one 1-bp bin: perfectly "efficient", but only −0.01%.
    const flat = [...Array.from({ length: 49 }, () => 1), 0.9999];
    expect(efficiencyRatio(flat)).toBeCloseTo(1);
    expect(regimeOf(flat)).toBe('range');
  });
  it('holds the risky token on the right side when it is Y', () => {
    expect(sideForRegime('up', DEFAULT_PARAMS, true)).toBe('y');
    expect(sideForRegime('down', DEFAULT_PARAMS, true)).toBeNull();
  });
  it('uses the cheap one-sided rebalance only in ranging markets, unless the regime filter is off', () => {
    const single = { ...DEFAULT_PARAMS, rebalanceMode: 'single' as const };
    expect(useSingleRebalance('range', single)).toBe(true);
    expect(useSingleRebalance('up', single)).toBe(false);
    expect(useSingleRebalance('up', { ...single, useRegime: false })).toBe(true);
    expect(useSingleRebalance('range', DEFAULT_PARAMS)).toBe(false);
  });
});

describe('one-sided positions', () => {
  it('x-side holds only the base token and starts at the active bin', () => {
    const p = openPosition(1000, 100, 10, 5, 'spot', 'x');
    const c = composition(p, 100 * 0.999);
    expect(c.y).toBe(0);
    expect(p.upperBin - p.lowerBin).toBe(10);
  });
  it('y-side holds only the quote token', () => {
    expect(composition(openPosition(1000, 100, 10, 5, 'spot', 'y'), 100 * 1.002).x).toBe(0);
  });
  it('cheap rebalance re-opens with the token already held', () => {
    expect(singleSidedAfterExit(true)).toBe('y');
    expect(singleSidedAfterExit(false)).toBe('x');
  });
});

describe('portfolio and risk', () => {
  it('caps exposure to one token', () => {
    expect(exposureHeadroomUsd(4000, 10_000, 60, false)).toBe(2000);
    expect(exposureHeadroomUsd(7000, 10_000, 60, false)).toBe(0);
    expect(exposureHeadroomUsd(9000, 10_000, 60, true)).toBe(Infinity);
  });
  it('flags depegs, drained pools, price deviation and unlocks', () => {
    const f = riskFlags({
      stablePrices: [{ symbol: 'USDC', priceUsd: 0.97 }],
      priceDeviationPct: 4,
      tvlChange1hPct: -55,
      upcomingUnlocks: [{ symbol: 'JUP', at: new Date('2026-10-12T00:00:00Z'), note: 'team' }],
    });
    expect(f).toHaveLength(4);
    const a = assessPool(
      { tvl: 5e6, volume24h: 9e6, baseFeePct: 0.2, volatilityPct: 3, trend7d: 3, holderQuality: 1, mcapM: 1000, bothAllowed: true, emaBearish: false, riskFlags: f },
      DEFAULT_STRATEGY,
      DEFAULT_WEIGHTS.balanced,
    );
    expect(a.call).toBe('out');
    expect(a.callLabel).toBe('Avoid, risk');
  });
  it('range width follows the tunable multiplier', () => {
    expect(rangeHalfWidth('balanced', 4, false, { ...DEFAULT_PARAMS, rangeMult: 2 })).toBeCloseTo(2 * rangeHalfWidth('balanced', 4, false));
  });
});

const pool: BacktestPool = { id: 'p', pair: 'T / USDC', binStep: 20, baseFeePct: 0.2, tvlUsd: 5e6, stablePair: false, mcapM: 2000, holderQuality: 1, bothAllowed: true };
function bars(n: number, drift: number, vol: number, volumeUsd: number, seed = 3): BacktestBar[] {
  const g = gaussFrom(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p *= Math.exp(drift + vol * g());
    return { ts: i * 3600_000, price: p, quoteUsd: 1, volumeUsd, feesUsd: volumeUsd * 0.0025 };
  });
}

describe('regime-aware backtest', () => {
  it('loses less than a two-sided LP in a steady uptrend by going one-sided', () => {
    const b = bars(24 * 40, 0.0015, 0.002, 2e6);
    const smart = runBacktest({ pool, strategy: DEFAULT_STRATEGY }, b).stats;
    const naive = runBacktest({ pool, strategy: DEFAULT_STRATEGY, thresholds: { ...DEFAULT_PARAMS, useRegime: false } }, b).stats;
    expect(smart.regimeBars.up).toBeGreaterThan(0);
    expect(smart.netVsHoldPct).toBeGreaterThan(naive.netVsHoldPct);
  });
});

describe('walk-forward optimiser', () => {
  it('scores candidates on unseen data and only recommends a real improvement', () => {
    const data = [1, 2].map((seed) => ({ pool: { ...pool, id: String(seed) }, bars: bars(24 * 40, 0, 0.004, 1.5e6, seed) }));
    const r = optimizeParams({ pools: data, strategy: DEFAULT_STRATEGY, candidates: 8, seed: 1 });
    expect(r.pools).toBe(2);
    expect(r.top).toHaveLength(5);
    expect(r.trainDays).toBeGreaterThan(15);
    expect(r.testDays).toBeGreaterThan(9);
    expect(typeof r.recommend).toBe('boolean');
    if (r.recommend) expect(r.best.test).toBeGreaterThan(r.baseline.test);
  });
});
