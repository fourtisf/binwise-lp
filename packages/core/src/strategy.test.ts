import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, positionCapUsd, validateStrategy } from './strategy';

describe('validateStrategy', () => {
  it('accepts the default strategy', () => {
    expect(validateStrategy(DEFAULT_STRATEGY)).toEqual([]);
  });

  it('rejects values outside the slider limits', () => {
    const errors = validateStrategy({ ...DEFAULT_STRATEGY, maxAllocPct: 90, trendExitPct: 5 });
    expect(errors).toHaveLength(2);
  });

  it('rejects unknown profiles and missing toggles', () => {
    const { toggles: _t, ...rest } = DEFAULT_STRATEGY;
    expect(validateStrategy({ ...rest, profile: 'yolo' })).toHaveLength(2);
  });
});

describe('max per position', () => {
  it('is optional, never negative, and 0 means no cap', () => {
    const { maxPositionUsd: _m, ...older } = DEFAULT_STRATEGY;
    expect(validateStrategy(older)).toEqual([]);
    expect(validateStrategy({ ...DEFAULT_STRATEGY, maxPositionUsd: 250 })).toEqual([]);
    expect(validateStrategy({ ...DEFAULT_STRATEGY, maxPositionUsd: -1 })).toHaveLength(1);
    expect(positionCapUsd({ maxPositionUsd: 0 })).toBe(Infinity);
    expect(positionCapUsd({ maxPositionUsd: 250 })).toBe(250);
  });
});
