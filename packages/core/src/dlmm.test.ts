import { describe, expect, it } from 'vitest';
import { binIdForPrice, binPrice, binsForHalfWidth, composition, feesEarnedUsd, inRange, openPosition, positionValueY } from './dlmm';

describe('DLMM bin math', () => {
  it('matches the SDK price formula (bin 100, step 25 → 1.28362…)', () => {
    expect(binPrice(100, 25)).toBeCloseTo(1.2836248887384677, 12);
  });
  it('maps a price back to its bin', () => {
    expect(binIdForPrice(binPrice(-321, 10), 10)).toBe(-321);
  });
  it('sizes the range from a half width', () => {
    expect(binsForHalfWidth(0.02, 10)).toBe(20);
  });
});

describe('position', () => {
  const price = 150;
  const pos = openPosition(10_000, price, 10, 20, 'spot');

  it('is worth what was put in at the opening price', () => {
    expect(positionValueY(pos, price)).toBeCloseTo(10_000, 4);
  });
  it('holds both tokens when centred', () => {
    const c = composition(pos, price);
    expect(c.x * price).toBeGreaterThan(4000);
    expect(c.y).toBeGreaterThan(4000);
  });
  it('ends up holding only the falling token after price drops through the range', () => {
    const c = composition(pos, price * 0.9);
    expect(c.y).toBe(0);
    expect(c.x).toBeGreaterThan(0);
    expect(inRange(pos, price * 0.9)).toBe(false);
  });
  it('ends up holding only the quote token after price rises through the range', () => {
    expect(composition(pos, price * 1.1).x).toBe(0);
  });
  it('loses against holding when price moves (impermanent loss)', () => {
    const entry = composition(pos, price);
    for (const p of [price * 0.95, price * 1.05]) {
      const hold = entry.x * p + entry.y;
      expect(positionValueY(pos, p)).toBeLessThan(hold);
    }
  });
  it('earns fees only in range', () => {
    const args = { pos, quoteUsd: 1, volumeUsd: 1e6, baseFeePct: 0.25, poolTvlUsd: 5e6 };
    expect(feesEarnedUsd({ ...args, price })).toBeGreaterThan(0);
    expect(feesEarnedUsd({ ...args, price: price * 1.2 })).toBe(0);
  });
  it('concentrates liquidity in the middle for curve and at the edges for bid-ask', () => {
    const curve = openPosition(1000, price, 10, 10, 'curve').liquidity;
    const bidask = openPosition(1000, price, 10, 10, 'bidask').liquidity;
    expect(curve[10]).toBeGreaterThan(curve[0]);
    expect(bidask[0]).toBeGreaterThan(bidask[10]);
  });
});
