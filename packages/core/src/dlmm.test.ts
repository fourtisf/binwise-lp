import { describe, expect, it } from 'vitest';
import { binIdForPrice, binPrice, binsForHalfWidth, composition, customRangeError, feesEarnedUsd, inRange, openPosition, positionValueY, rangeFromPrices, sideOfRange } from './dlmm';

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

describe('custom ranges (Add LP by hand)', () => {
  it('turns a min/max price into bins below and above the price, snapped to whole bins', () => {
    const price = 150;
    const r = rangeFromPrices(price, 10, 135, 165);
    // ±10% at 0.1% per bin is about 105 bins each side... capped later; here: count the bins exactly.
    expect(r.below).toBe(binIdForPrice(price, 10) - binIdForPrice(135, 10));
    expect(r.above).toBe(binIdForPrice(165, 10) - binIdForPrice(price, 10));
    expect(r.minPrice).toBeLessThanOrEqual(135.2);
    expect(r.maxPrice).toBeGreaterThanOrEqual(165);
    expect(customRangeError(r)).toMatch(/at most 69 bins/);
    const narrow = rangeFromPrices(price, 100, 140, 160);
    expect(customRangeError(narrow)).toBeNull();
    expect(narrow.bins).toBe(narrow.below + narrow.above + 1);
  });

  it('one-sided ranges start at the price', () => {
    const x = rangeFromPrices(150, 100, 100, 180, 'x');
    expect(x.below).toBe(0);
    expect(x.above).toBeGreaterThan(0);
    expect(sideOfRange(x)).toBe('x');
    const y = rangeFromPrices(150, 100, 120, 999, 'y');
    expect(y.above).toBe(0);
    expect(sideOfRange(y)).toBe('y');
    // A one-sided range always has at least one bin past the price.
    expect(rangeFromPrices(150, 100, 150, 150, 'x').above).toBe(1);
  });

  it('opens an asymmetric position over exactly the chosen bins', () => {
    const pos = openPosition(1000, 150, 100, 0, 'spot', 'both', { below: 8, above: 3 });
    const active = binIdForPrice(150, 100);
    expect(pos.lowerBin).toBe(active - 8);
    expect(pos.upperBin).toBe(active + 3);
    expect(pos.liquidity).toHaveLength(12);
    // More bins below the price: more of the value sits in the quote token.
    const c = composition(pos, 150);
    expect(c.y).toBeGreaterThan(c.x * 150);
    expect(positionValueY(pos, 150)).toBeCloseTo(1000, 0);
    // All above the price: X, apart from the active bin's share (the model splits that bin evenly).
    const up = openPosition(1000, 150, 100, 0, 'curve', 'both', { below: 0, above: 5 });
    const cu = composition(up, 150);
    expect(cu.y).toBeLessThan(up.liquidity[0]);
    expect(cu.x * 150).toBeGreaterThan(cu.y * 10);
  });
});
