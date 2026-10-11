import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY } from './strategy';
import { DEFAULT_WEIGHTS, assessPool, feeAprPct, scorePool, type PoolAssessmentInput } from './scoring';
import { ema, realizedVolatilityPct, trendState } from './indicators';

const jupSol: PoolAssessmentInput = {
  tvl: 8.4e6,
  volume24h: 16.1e6,
  baseFeePct: 0.25,
  volatilityPct: 3.1,
  trend7d: 4.2,
  holderQuality: 1,
  mcapM: 1300,
  bothAllowed: true,
  emaBearish: false,
};

describe('scorePool', () => {
  it('matches the approved design for JUP / SOL when fee and farm data are absent', () => {
    const r = scorePool(jupSol, DEFAULT_WEIGHTS.balanced);
    expect(r.breakdown.map((c) => c.label)).toEqual([
      'Volume / TVL',
      'Fee tier',
      'Volatility',
      '7-day trend',
      'Holder quality',
      'Fees vs volatility',
      'Farm rewards',
    ]);
    expect(r.score).toBe(Math.round(30 + Math.min(40, (16.1 / 8.4) * 13) + 7.5 - 6.2 + 4.2 * 1.4 + 11));
  });

  it('caps each component', () => {
    const r = scorePool({ ...jupSol, volume24h: 1e9, baseFeePct: 5, trend7d: 80 }, DEFAULT_WEIGHTS.balanced);
    expect(r.breakdown[0].value).toBe(40);
    expect(r.breakdown[1].value).toBe(16);
    expect(r.breakdown[3].value).toBe(12);
  });

  it('penalises volatility harder for conservative vaults', () => {
    const c = scorePool(jupSol, DEFAULT_WEIGHTS.conservative).score;
    const a = scorePool(jupSol, DEFAULT_WEIGHTS.aggressive).score;
    expect(c).toBeLessThan(a);
  });

  it('computes fee APR from volume, TVL and base fee', () => {
    expect(feeAprPct(2e6, 1e6, 0.25)).toBeCloseTo(182.5);
  });
});

describe('assessPool', () => {
  const s = DEFAULT_STRATEGY;
  const w = DEFAULT_WEIGHTS.balanced;
  it('deploys a healthy high-score pool', () => {
    const a = assessPool(jupSol, s, w);
    expect(a.call).toBe('in');
    expect(a.eligible).toBe(true);
  });
  it('avoids a pool whose 7-day trend breaks the exit rule', () => {
    const a = assessPool({ ...jupSol, trend7d: -14.6 }, s, w);
    expect(a.call).toBe('out');
    expect(a.reason).toContain('−14.6%');
  });
  it('avoids when EMA20 is under EMA50', () => {
    expect(assessPool({ ...jupSol, emaBearish: true }, s, w).call).toBe('out');
  });
  it('watches pools below the market-cap floor', () => {
    expect(assessPool({ ...jupSol, mcapM: 0.5 }, s, w).callLabel).toBe('Below cap floor');
    expect(assessPool({ ...jupSol, mcapM: 300 }, { ...s, minMcapM: 500 }, w).callLabel).toBe('Below cap floor');
  });
  it('skips tokens that fail the holder check when the toggle is on', () => {
    expect(assessPool({ ...jupSol, holderQuality: 0.2 }, s, w).call).toBe('out');
    const off = { ...s, toggles: { ...s.toggles, holderSafety: false } };
    expect(assessPool({ ...jupSol, holderQuality: 0.2 }, off, w).call).toBe('in');
  });
  it('never deploys below the TVL floor', () => {
    expect(assessPool({ ...jupSol, tvl: 40_000, volume24h: 80_000 }, s, w).eligible).toBe(false);
    expect(assessPool({ ...jupSol, tvl: 40_000, volume24h: 80_000 }, s, w).reason).toMatch(/\$50k floor/);
  });
});

describe('indicators', () => {
  it('flat prices have zero volatility', () => {
    expect(realizedVolatilityPct([1, 1, 1, 1], 24)).toBe(0);
  });
  it('scales volatility with the number of candles per day', () => {
    const closes = [1, 1.01, 1, 1.01, 1, 1.01];
    expect(realizedVolatilityPct(closes, 288)).toBeCloseTo(realizedVolatilityPct(closes, 24) * Math.sqrt(12));
  });
  it('EMA needs enough history', () => {
    expect(ema([1, 2, 3], 20)).toBeNull();
  });
  it('detects a downtrend: EMA20 below EMA50 and negative 7-day trend', () => {
    const falling = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(0.998, i));
    const st = trendState(falling);
    expect(st.emaBearish).toBe(true);
    expect(st.trend7d!).toBeLessThan(0);
  });
});
