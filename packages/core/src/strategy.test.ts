import { describe, expect, it } from 'vitest';
import { DEFAULT_STRATEGY, validateStrategy } from './strategy';

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
