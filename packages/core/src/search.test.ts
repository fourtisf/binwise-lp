import { describe, expect, it } from 'vitest';
import { poolMatches } from './search';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CARDS = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp';
const ref = (symbol: string, mint?: string) => ({ symbol, letter: symbol[0], color: '#fff', ...(mint ? { mint } : {}) });
const cardsUsdc = { id: 'BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y', tokenA: ref('CARDS', CARDS), tokenB: ref('USDC', USDC) };
const solUsdc = { id: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6', tokenA: ref('SOL', SOL), tokenB: ref('USDC', USDC) };

describe('poolMatches', () => {
  it('matches everything on an empty query', () => {
    expect(poolMatches(cardsUsdc, '  ')).toBe(true);
  });

  it('finds tickers in any case, with $, in either order and with separators', () => {
    for (const q of ['cards', 'CARDS', '$cards', 'car', 'cards usdc', 'usdc cards', 'CARDS/USDC', 'cards / usdc', '$CARDS-$USDC']) expect(poolMatches(cardsUsdc, q)).toBe(true);
    expect(poolMatches(cardsUsdc, 'sol')).toBe(false);
    expect(poolMatches(cardsUsdc, 'cards sol')).toBe(false);
  });

  it("finds a pool by either token's contract address, whole or in part", () => {
    expect(poolMatches(cardsUsdc, CARDS)).toBe(true);
    expect(poolMatches(cardsUsdc, ` ${CARDS} `)).toBe(true);
    expect(poolMatches(cardsUsdc, CARDS.slice(0, 10))).toBe(true);
    expect(poolMatches(solUsdc, USDC)).toBe(true);
    expect(poolMatches(solUsdc, CARDS)).toBe(false);
  });

  it("finds a pool by its own address", () => {
    expect(poolMatches(cardsUsdc, cardsUsdc.id)).toBe(true);
    expect(poolMatches(solUsdc, cardsUsdc.id)).toBe(false);
  });

  it('works when a token has no known mint', () => {
    expect(poolMatches({ ...cardsUsdc, tokenA: ref('CARDS') }, 'cards')).toBe(true);
    expect(poolMatches({ ...cardsUsdc, tokenA: ref('CARDS') }, CARDS)).toBe(false);
  });
});
