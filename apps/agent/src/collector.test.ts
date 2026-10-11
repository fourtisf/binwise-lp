import { describe, expect, it } from 'vitest';
import type { MeteoraPool, MeteoraToken } from '@binwise/chain';
import { bigCapPools } from './collector';

const tok = (symbol: string, market_cap: number | null, is_verified = true): MeteoraToken => ({
  address: symbol === 'SOL' ? 'So11111111111111111111111111111111111111112' : `${symbol}-mint`,
  name: symbol,
  symbol,
  decimals: 6,
  is_verified,
  holders: null,
  freeze_authority_disabled: true,
  total_supply: null,
  price: 1,
  market_cap,
});
const SOL = tok('SOL', 80e9);
const USDC = tok('USDC', 60e9);
const JUP = tok('JUP', 1.5e9);
const MEME = tok('MEME', 5e6);
const FAKE = tok('BIG', 9e9, false);
const pool = (x: MeteoraToken, y: MeteoraToken, tvl: number) => ({ address: `${x.symbol}-${y.symbol}-${tvl}`, token_x: x, token_y: y, tvl }) as MeteoraPool;

describe('big-cap pools', () => {
  it('always tracks the largest pools of big verified tokens against SOL, stables or other big caps', () => {
    const pools = [
      pool(JUP, SOL, 3e6),
      pool(JUP, USDC, 8e6),
      pool(JUP, SOL, 1e6), // third JUP pool: only the 2 largest per token
      pool(JUP, MEME, 20e6), // paired with a small token: not a big-cap pool for JUP
      pool(SOL, USDC, 9e6),
      pool(MEME, SOL, 30e6), // small cap
      pool(FAKE, SOL, 30e6), // unverified
    ];
    const picked = bigCapPools(pools, { bigCapMinUsd: 250e6, bigCapPoolsPerToken: 2 }).map((p) => p.address).sort();
    expect(picked).toEqual(['JUP-SOL-3000000', 'JUP-USDC-8000000', 'SOL-USDC-9000000'].sort());
  });
});
