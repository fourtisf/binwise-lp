import { describe, expect, it } from 'vitest';
import { bestPerPair, isBridgedSymbol, pairKey } from './universe';

describe('pool universe', () => {
  it('leaves out tokens bridged from other chains, keeps Solana ones', () => {
    for (const s of ['wNEAR', 'cbBTC', 'WBTC', 'ETH', 'DOGE']) expect(isBridgedSymbol(s)).toBe(true);
    for (const s of ['SOL', 'JUP', 'Bonk', 'RAY', 'PENGU', 'JitoSOL', 'MET', 'USDC']) expect(isBridgedSymbol(s)).toBe(false);
  });
  it('keeps one pool per pair, whatever the token order', () => {
    const pools = [
      { a: 'MET', b: 'SOL', tvl: 103e3 },
      { a: 'SOL', b: 'MET', tvl: 1.9e6 },
      { a: 'MET', b: 'SOL', tvl: 544e3 },
      { a: 'JUP', b: 'SOL', tvl: 2.2e6 },
    ];
    const one = bestPerPair(pools, (p) => pairKey(p.a, p.b), (x, y) => x.tvl > y.tvl);
    expect(one.map((p) => p.tvl).sort((x, y) => x - y)).toEqual([1.9e6, 2.2e6]);
  });
});
