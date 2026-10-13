import { describe, expect, it } from 'vitest';
import { runBacktest, type BacktestBar, type BacktestPool } from './backtest';
import { DEFAULT_STRATEGY } from './strategy';
import { gaussFrom } from './testing';

const pool: BacktestPool = {
  id: 'test',
  pair: 'TEST / USDC',
  binStep: 20,
  baseFeePct: 0.2,
  tvlUsd: 5e6,
  stablePair: false,
  mcapM: 2000,
  holderQuality: 1,
  bothAllowed: true,
};

function bars(n: number, drift: number, vol: number, volumeUsd: number, seed = 1): BacktestBar[] {
  const g = gaussFrom(seed);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    p *= Math.exp(drift + vol * g());
    return { ts: i * 3600_000, price: p, quoteUsd: 1, volumeUsd };
  });
}

describe('runBacktest', () => {
  it('needs enough history', () => {
    expect(() => runBacktest({ pool, strategy: DEFAULT_STRATEGY }, bars(100, 0, 0.005, 1e6))).toThrow(RangeError);
  });

  it('earns fees and beats holding in a busy sideways market', () => {
    const r = runBacktest({ pool, strategy: DEFAULT_STRATEGY }, bars(24 * 40, 0, 0.004, 600_000));
    expect(r.stats.days).toBeGreaterThan(30);
    expect(r.stats.deploys).toBeGreaterThan(0);
    expect(r.stats.feesUsd).toBeGreaterThan(0);
    expect(r.stats.costsUsd).toBeGreaterThan(0);
    expect(r.stats.netVsHoldPct).toBeGreaterThan(0);
  });

  it('stays out of a steady downtrend instead of farming a falling token', () => {
    const r = runBacktest({ pool, strategy: DEFAULT_STRATEGY }, bars(24 * 40, -0.002, 0.003, 600_000, 7));
    expect(r.stats.deployedPct).toBeLessThan(10);
    expect(r.stats.agentUsd).toBeGreaterThanOrEqual(r.stats.holdUsd * 0.99);
  });

  it('beats an unmanaged LP when volume is high', () => {
    const r = runBacktest({ pool, strategy: DEFAULT_STRATEGY }, bars(24 * 40, 0, 0.004, 2e6));
    expect(r.stats.netVsHoldPct).toBeGreaterThan(r.stats.unmanagedVsHoldPct);
  });

  it('reports a series with one point per bar after warm-up', () => {
    const r = runBacktest({ pool, strategy: DEFAULT_STRATEGY }, bars(24 * 35, 0, 0.004, 600_000));
    expect(r.series).toHaveLength(24 * 35 - 24 * 7);
  });
});
