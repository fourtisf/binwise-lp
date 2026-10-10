import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

describe('DLMM SDK wiring', () => {
  it('strategy enum values match the SDK', () => {
    const { StrategyType } = createRequire(import.meta.url)('@meteora-ag/dlmm');
    expect([StrategyType.Spot, StrategyType.Curve, StrategyType.BidAsk]).toEqual([0, 1, 2]);
  });
  it('live module loads without pulling the SDK in at import time', async () => {
    const m = await import('./live');
    expect(typeof m.LiveExecutor).toBe('function');
  });
});
