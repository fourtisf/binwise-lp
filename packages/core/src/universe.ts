/**
 * Which pools Kovra covers: the Solana ecosystem. Tokens bridged in from other chains (wrapped
 * BTC/ETH, wNEAR, DOGE, …) are left out, and each pair is listed once (its most liquid pool).
 */

/** Bridged or wrapped assets from other chains (symbols, case-insensitive). */
const BRIDGED = new Set(
  [
    'ETH', 'WETH', 'WETH.E', 'STETH', 'WSTETH', 'CBETH',
    'BTC', 'WBTC', 'CBBTC', 'TBTC', 'ZBTC', 'XBTC', 'LBTC', 'UBTC', 'FBTC', 'BTCB',
    'WNEAR', 'NEAR', 'DOGE', 'XRP', 'BNB', 'AVAX', 'MATIC', 'POL', 'SUI', 'APT', 'TON', 'TRX', 'ADA', 'DOT', 'ATOM', 'LTC', 'BCH',
    'LINK', 'UNI', 'AAVE', 'SHIB', 'PEPE', 'ARB', 'OP',
  ].map((s) => s.toUpperCase()),
);

export const isBridgedSymbol = (symbol: string) => BRIDGED.has(symbol.trim().toUpperCase());

/** Order-independent key for a pair of mints. */
export const pairKey = (mintA: string, mintB: string) => (mintA < mintB ? `${mintA}|${mintB}` : `${mintB}|${mintA}`);

/** One item per pair: the one `better` prefers (e.g. the most liquid pool). */
export function bestPerPair<T>(items: T[], key: (t: T) => string, better: (a: T, b: T) => boolean): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    const k = key(it);
    const cur = best.get(k);
    if (!cur || better(it, cur)) best.set(k, it);
  }
  return [...best.values()];
}
