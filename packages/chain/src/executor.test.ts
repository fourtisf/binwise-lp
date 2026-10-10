import { describe, expect, it } from 'vitest';
import { PaperExecutor, type PoolCtx, type PositionRef } from './executor';

const pool: PoolCtx = {
  address: 'pool',
  binStep: 20,
  mintX: 'SOL',
  mintY: 'USDC',
  decimalsX: 9,
  decimalsY: 6,
  price: 150,
  usdX: 150,
  usdY: 1,
  tvlUsd: 5e6,
  baseFeePct: 0.2,
  volume24hUsd: 10e6,
};

const valueOf = (h: Record<string, number>, px: number) => (h.SOL ?? 0) * px + (h.USDC ?? 0);

describe('PaperExecutor', () => {
  it('opens from one-sided cash by simulating a swap, paying slippage and fees', async () => {
    const ex = new PaperExecutor({ USDC: 10_000 });
    const r = await ex.open({ pool, valueUsd: 2_000, binsEachSide: 10, shape: 'spot', key: 'k' });
    expect(r.amountX).toBeGreaterThan(0);
    expect(r.amountY).toBeGreaterThan(0);
    expect(r.costUsd).toBeGreaterThan(0);
    const left = valueOf(await ex.holdings(), 150);
    expect(left + r.amountX * 150 + r.amountY).toBeCloseTo(10_000 - r.costUsd, 0);
  });

  it('opens one-sided above price with X only, without swapping X it already holds', async () => {
    const ex = new PaperExecutor({ SOL: 20 });
    const r = await ex.open({ pool, valueUsd: 2_000, binsEachSide: 10, shape: 'spot', side: 'x', key: 'k' });
    // Range starts at the active bin and covers 21 bins upward.
    expect(r.upperBin - r.lowerBin).toBe(20);
    expect(r.lowerBin).toBe(Math.floor(Math.log(150) / Math.log(1.002)));
    expect(r.amountX * 150).toBeGreaterThan(1_900);
    // Only network fees: no swap was needed.
    expect(r.costUsd).toBeLessThan(0.1);
  });

  it('opens one-sided below price with Y only', async () => {
    const ex = new PaperExecutor({ USDC: 5_000 });
    const r = await ex.open({ pool, valueUsd: 2_000, binsEachSide: 10, shape: 'spot', side: 'y', key: 'k' });
    expect(r.amountY).toBeGreaterThan(1_900);
    expect(r.costUsd).toBeLessThan(0.1);
  });

  it('adds farm rewards to unclaimed fees while in range', async () => {
    const ex = new PaperExecutor({ SOL: 10, USDC: 1500 });
    const r = await ex.open({ pool, valueUsd: 3_000, binsEachSide: 10, shape: 'spot', key: 'k' });
    const ref: PositionRef = { address: null, lowerBin: r.lowerBin, upperBin: r.upperBin, binStep: 20, shape: 'spot', bins: r.bins, feesUnclaimedUsd: 0 };
    const plain = await ex.mark(ref, pool, 60);
    const farmed = await ex.mark(ref, { ...pool, farmAprPct: 50 }, 60);
    // 50% APR on ~$3,000 for an hour ≈ $0.17
    expect(farmed.feesUsd - plain.feesUsd).toBeCloseTo((plain.valueUsd * 0.5) / (365 * 24), 3);
  });

  it('accrues fees in range and pays them back on close', async () => {
    const ex = new PaperExecutor({ SOL: 10, USDC: 1500 });
    const r = await ex.open({ pool, valueUsd: 3_000, binsEachSide: 10, shape: 'spot', key: 'k' });
    const ref: PositionRef = { address: null, lowerBin: r.lowerBin, upperBin: r.upperBin, binStep: 20, shape: 'spot', bins: r.bins, feesUnclaimedUsd: 0 };
    const m = await ex.mark(ref, pool, 60);
    expect(m.inRange).toBe(true);
    expect(m.feesUsd).toBeGreaterThan(0);
    const before = valueOf(await ex.holdings(), 150);
    const c = await ex.close({ ...ref, feesUnclaimedUsd: m.feesUsd }, pool, 'k2');
    const after = valueOf(await ex.holdings(), 150);
    expect(after - before).toBeCloseTo(m.valueUsd + m.feesUsd - c.costUsd, 4);
  });

  it('earns nothing out of range', async () => {
    const ex = new PaperExecutor({ SOL: 10, USDC: 1500 });
    const r = await ex.open({ pool, valueUsd: 3_000, binsEachSide: 5, shape: 'spot', key: 'k' });
    const ref: PositionRef = { address: null, lowerBin: r.lowerBin, upperBin: r.upperBin, binStep: 20, shape: 'spot', bins: r.bins, feesUnclaimedUsd: 0 };
    const m = await ex.mark(ref, { ...pool, price: 170, usdX: 170 }, 60);
    expect(m.inRange).toBe(false);
    expect(m.feesUsd).toBe(0);
  });
});
