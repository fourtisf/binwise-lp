import { describe, expect, it } from 'vitest';
import { dailyStopHit, exitReason, manualDeployLimit, positionSizeUsd, rangeHalfWidth, shapeFor, shouldCompound, shouldRebalance } from './rules';

const costs = { txFeesUsd: 0.05, slippageUsd: 0.2, priorityUsd: 0.05 }; // $0.30 total

describe('rebalance cost rule', () => {
  const base = { ticksOutOfRange: 2, minutesSinceLastRebalance: null, expectedFees6hUsd: 10, costs, onlyWhenProfitable: true };
  it('waits at least one tick after leaving the range', () => {
    expect(shouldRebalance({ ...base, ticksOutOfRange: 1 }).act).toBe(false);
  });
  it('rebalances when 6h fees beat 1.5× costs', () => {
    const v = shouldRebalance(base);
    expect(v.act).toBe(true);
    expect(v.ratio).toBeCloseTo(33.3, 0);
  });
  it('holds when fees do not cover 1.5× costs', () => {
    expect(shouldRebalance({ ...base, expectedFees6hUsd: 0.44 }).act).toBe(false);
    expect(shouldRebalance({ ...base, expectedFees6hUsd: 0.46 }).act).toBe(true);
  });
  it('respects the 30-minute cooldown', () => {
    expect(shouldRebalance({ ...base, minutesSinceLastRebalance: 12 }).act).toBe(false);
    expect(shouldRebalance({ ...base, minutesSinceLastRebalance: 31 }).act).toBe(true);
  });
  it('ignores profitability when the toggle is off', () => {
    expect(shouldRebalance({ ...base, expectedFees6hUsd: 0, onlyWhenProfitable: false }).act).toBe(true);
  });
});

describe('exit rules', () => {
  const ok = { trend7d: 2, trendExitPct: -12, emaBearish: false, netVsHoldMax24h: 1, lowScoreStreak: 0 };
  it('stays when nothing is wrong', () => expect(exitReason(ok)).toBeNull());
  it('exits when the 7-day trend breaks the user threshold', () => expect(exitReason({ ...ok, trend7d: -14.6 })).toMatch(/7-day trend/));
  it('exits on an EMA20/EMA50 bearish cross', () => expect(exitReason({ ...ok, emaBearish: true })).toMatch(/EMA20/));
  it('exits when net vs hold stayed below −3% for 24h', () => {
    expect(exitReason({ ...ok, netVsHoldMax24h: -3.5 })).toMatch(/Net vs hold/);
    expect(exitReason({ ...ok, netVsHoldMax24h: -2 })).toBeNull();
  });
  it('exits after three low scores in a row', () => expect(exitReason({ ...ok, lowScoreStreak: 3 })).toMatch(/Score/));
});

describe('sizing, shape and range', () => {
  it('sizes to min(vault × cap, 2% of pool TVL)', () => {
    expect(positionSizeUsd(10_000, 25, 1e6)).toBe(2500);
    expect(positionSizeUsd(1e6, 25, 1e6)).toBe(20_000);
  });
  it('uses curve for stables, bid-ask for volatile, spot otherwise', () => {
    expect(shapeFor('balanced', true, 1)).toBe('curve');
    expect(shapeFor('balanced', false, 8)).toBe('bidask');
    expect(shapeFor('balanced', false, 3)).toBe('spot');
  });
  it('widens the range with volatility', () => {
    expect(rangeHalfWidth('balanced', 6, false)).toBeGreaterThan(rangeHalfWidth('balanced', 2, false));
  });
});

describe('compound and daily stop', () => {
  it('compounds only when gas < 1% of the claim', () => {
    expect(shouldCompound(100, 0.5)).toBe(true);
    expect(shouldCompound(10, 0.5)).toBe(false);
  });
  it('trips the daily loss stop', () => {
    expect(dailyStopHit(9500, 10_000, 4)).toBe(true);
    expect(dailyStopHit(9700, 10_000, 4)).toBe(false);
  });
});

describe('manual Add LP limit', () => {
  const base = { idleUsd: 1000, positionsUsd: 0, openPositions: 0, poolTvlUsd: 1e7, capUsd: Infinity };
  it('is the smallest of idle funds, the pool depth and the per-position cap, not the strategy share per pool', () => {
    // The owner's chosen amount into the owner's chosen pool: all the idle funds (2% kept for fees).
    expect(manualDeployLimit(base)).toEqual({ maxUsd: 980, limit: 'balance' });
    expect(manualDeployLimit({ ...base, capUsd: 120 })).toEqual({ maxUsd: 120, limit: 'cap' });
    // At most 2% of the pool's liquidity.
    expect(manualDeployLimit({ ...base, poolTvlUsd: 10_000 })).toEqual({ maxUsd: 200, limit: 'pool' });
  });
  it('counts open positions in the vault value but only spends idle funds', () => {
    expect(manualDeployLimit({ ...base, idleUsd: 100, positionsUsd: 900 })).toEqual({ maxUsd: 98, limit: 'balance' });
  });
  it('applies the live limits', () => {
    const live = { maxUsd: 200, maxPositions: 2, roomTotalUsd: 1000 };
    expect(manualDeployLimit({ ...base, live })).toEqual({ maxUsd: 200, limit: 'live' });
    expect(manualDeployLimit({ ...base, positionsUsd: 150, openPositions: 1, live })).toEqual({ maxUsd: 50, limit: 'live' });
    expect(manualDeployLimit({ ...base, live: { ...live, roomTotalUsd: 30 } })).toEqual({ maxUsd: 30, limit: 'live' });
    expect(manualDeployLimit({ ...base, openPositions: 2, live })).toEqual({ maxUsd: 0, limit: 'positions' });
    expect(manualDeployLimit({ ...base, positionsUsd: 300, openPositions: 1, live }).maxUsd).toBe(0);
  });
});
