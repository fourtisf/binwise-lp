import type { LiquidityShape, PoolDetail } from '@binwise/core';

const NAME: Record<LiquidityShape, string> = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };

/** The aqua dot that marks the recommended choice in each row of options. */
export const RecDot = () => (
  <i
    title="Recommended"
    style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--up)', boxShadow: '0 0 6px var(--up)', marginRight: 6, verticalAlign: 'middle' }}
  />
);

/**
 * What the agent itself would do in this pool (shape, tokens, range) and why, with one click to use it.
 * Same rules as the agent: shapeFor (stable pairs Curve, volatile or Aggressive Bid-Ask, else Spot),
 * the side from the market regime, and a width that scales with volatility.
 */
export function LpRecommend({
  lp,
  symA,
  symB,
  lo,
  hi,
  width,
  inUse,
  onUse,
}: {
  lp: NonNullable<PoolDetail['lp']>;
  symA: string;
  symB: string;
  lo: string;
  hi: string;
  /** The recommended range's width: ±3.5% across the price, +7.1% or −6.9% one-sided */
  width: string;
  inUse: boolean;
  onUse: () => void;
}) {
  const vol = `${Number(lp.volatility.toFixed(1))}% a day`;
  const shapeWhy = lp.stable
    ? 'both tokens are stablecoins, so price barely moves and liquidity close to it earns the most.'
    : lp.shape === 'bidask'
      ? lp.volatility >= 6
        ? `the price swings a lot (${vol}): it buys dips and sells rallies.`
        : 'your Aggressive profile trades the swings.'
      : `moderate swings (${vol}): the same amount in every bin.`;
  // In an uptrend the agent holds only the risky token, on the side price moves towards.
  const risky = lp.side === 'y' ? symB : symA;
  const sideText = lp.side === 'both' ? 'Both tokens' : lp.side === 'x' ? `Only ${symA}` : lp.side === 'y' ? `Only ${symB}` : 'Wait';
  const sideWhy =
    lp.side === 'both'
      ? 'the price is moving sideways, so it earns on both sides.'
      : lp.side
        ? `trending up: holding only ${risky} keeps the upside and sells into strength.`
        : 'the pool is trending down. The agent adds no liquidity here until the trend turns.';
  const why = { fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted)', marginTop: 4 } as const;
  const b = { color: 'var(--soft)', fontWeight: 500 } as const;
  return (
    <div
      id="dRec"
      style={{ marginTop: 16, padding: '13px 14px', borderRadius: 11, background: 'linear-gradient(180deg,rgba(var(--up-rgb),.07),rgba(var(--up-rgb),.025))', border: '1px solid rgba(var(--up-rgb),.22)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text)' }}>
          <RecDot />
          Recommended for this pool
        </span>
        {lp.side === null ? null : inUse ? (
          <span className="up" style={{ fontSize: 12.5, fontWeight: 500 }}>
            ✓ In use
          </span>
        ) : (
          <button className="btn btn-dark btn-sm" style={{ height: 28, padding: '0 11px', fontSize: 12.5 }} onClick={onUse}>
            Use recommended
          </button>
        )}
      </div>
      <div className="num" style={{ fontSize: 13, color: 'var(--soft)', marginTop: 8 }}>
        {NAME[lp.shape]} · {sideText}
        {lp.side !== null && (
          <>
            {' '}
            · {lo} – {hi}
          </>
        )}
      </div>
      <p style={why}>
        <span style={b}>{NAME[lp.shape]}:</span> {shapeWhy}
      </p>
      <p style={why}>
        <span style={b}>{sideText}:</span> {sideWhy}
      </p>
      {lp.side !== null && (
        <p style={why}>
          <span style={b}>Range {width}:</span> {lp.stable ? 'kept tight, as stable pairs barely move.' : 'wide enough for a normal day at this volatility.'}
        </p>
      )}
      {lp.side !== null && (
        <p style={{ ...why, color: 'var(--dim)', marginTop: 8 }}>
          <RecDot />
          marks the recommended choice in each row below.
        </p>
      )}
    </div>
  );
}
