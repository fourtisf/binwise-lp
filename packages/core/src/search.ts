import type { TokenRef } from './types';

/** Looks like a Solana address being typed or pasted: base58, no spaces, long enough not to be a ticker. */
const ADDRESSISH = /^[1-9A-HJ-NP-Za-km-z]{8,44}$/;

/**
 * Whether a pool matches what was typed in a search box: tickers in any order and case, with or
 * without "$" or a separator ("cards", "$SOL", "jup/sol", "usdc sol"), or a contract address, whole
 * or in part: either token's mint or the pool's own address (its id).
 */
export function poolMatches(pool: { id: string; tokenA: TokenRef; tokenB: TokenRef }, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (ADDRESSISH.test(q)) {
    const s = q.toLowerCase();
    if ([pool.id, pool.tokenA.mint, pool.tokenB.mint].some((a) => a?.toLowerCase().includes(s))) return true;
  }
  const symbols = [pool.tokenA.symbol.toLowerCase(), pool.tokenB.symbol.toLowerCase()];
  const terms = q.toLowerCase().replace(/\$/g, '').split(/[\s/,\-]+/).filter(Boolean);
  return terms.length > 0 && terms.every((t) => symbols.some((s) => s.includes(t)));
}
