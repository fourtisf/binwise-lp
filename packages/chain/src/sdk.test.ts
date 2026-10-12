import { describe, expect, it } from 'vitest';
import { dlmmClass, sdk } from './sdk';

// The real @meteora-ag/dlmm package, not a stand-in: its CommonJS build must give us what the code calls.
describe('DLMM SDK loading', () => {
  it('finds the DLMM class and the helpers the builders use', () => {
    const DLMM = dlmmClass();
    expect(typeof DLMM.create).toBe('function');
    expect(typeof DLMM.getAllLbPairPositionsByUser).toBe('function');
    expect(typeof sdk().autoFillYByStrategy).toBe('function');
    expect(Number(sdk().POSITION_FEE)).toBeGreaterThan(0);
    expect(sdk().StrategyType.Spot).toBeDefined();
  });
});
