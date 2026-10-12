import type { LiquidityShape } from '@binwise/core';

const NAME: Record<LiquidityShape, string> = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-Ask' };

/** What each shape does, in plain words. */
const TEXT: Record<LiquidityShape, string> = {
  spot: 'The same amount in every bin. Fees come in evenly wherever price moves inside the range. A good default for most pairs.',
  curve: 'Most of it close to the current price. Earns the most while price stays near, less once it drifts. Suits stable or slow pairs.',
  bidask: 'More at the edges of the range. It buys more as price falls and sells more as it rises. Suits volatile pairs.',
};

/**
 * Liquidity per bin, anchored on the price's bin like Meteora's strategies: even for Spot, peaking at the
 * price for Curve, growing away from it for Bid-Ask (same curves as the paper model's shapeWeights).
 */
function weights(shape: LiquidityShape, below: number, above: number): number[] {
  const span = Math.max(1, below, above);
  return Array.from({ length: below + above + 1 }, (_, i) => {
    const d = Math.abs(i - below) / span;
    if (shape === 'curve') return Math.exp(-(d * d) / 0.5);
    if (shape === 'bidask') return 0.2 + d;
    return 1;
  });
}

const W = 390;
const H = 78;

/**
 * A picture of the position Add LP opens: its bins across the range, how the chosen shape spreads the
 * liquidity, which token sits on each side of the price, and what that shape is for.
 */
export function LpShape({
  shape,
  agentShape,
  below,
  above,
  symA,
  symB,
  lo,
  hi,
  now,
}: {
  shape: 'agent' | LiquidityShape;
  agentShape: LiquidityShape;
  below: number;
  above: number;
  symA: string;
  symB: string;
  lo: string;
  hi: string;
  now: string;
}) {
  const s = shape === 'agent' ? agentShape : shape;
  const w = weights(s, below, above);
  const top = Math.max(...w);
  const slot = W / w.length;
  const gap = Math.min(2, slot * 0.25);
  const priceX = (below + 0.5) * slot;
  const key = (c: string) => <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: c, marginRight: 6 }} />;
  return (
    <div id="dShape" style={{ marginTop: 10, padding: '12px 12px 11px', borderRadius: 11, background: 'rgba(255,255,255,.025)', border: '1px solid var(--line)' }}>
      <svg viewBox={`0 0 ${W} ${H + 4}`} width="100%" height={H + 4} preserveAspectRatio="none" role="img" aria-label={`${NAME[s]}: liquidity across ${w.length} bins`}>
        {w.map((v, i) => {
          const h = 6 + (H - 12) * (v / top);
          const fill = i === below ? 'var(--text)' : i < below ? 'var(--aqua)' : 'var(--indigo)';
          return <rect key={i} x={i * slot + gap / 2} y={H - h} width={Math.max(1, slot - gap)} height={h} rx={Math.min(2.5, (slot - gap) / 2)} fill={fill} opacity={i === below ? 1 : 0.85} />;
        })}
        <line x1={priceX} x2={priceX} y1={0} y2={H + 4} stroke="rgba(255,255,255,.35)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      </svg>
      {/* Range ends, and "now" under the price line (at an end when the range is one-sided). */}
      <div className="num" style={{ position: 'relative', height: 16, fontSize: 11.5, color: 'var(--dim)', marginTop: 4, whiteSpace: 'nowrap' }}>
        {below > 0 && <span style={{ position: 'absolute', left: 0 }}>{lo}</span>}
        {above > 0 && <span style={{ position: 'absolute', right: 0 }}>{hi}</span>}
        <span
          style={{
            position: 'absolute',
            color: 'var(--soft)',
            ...(below === 0 ? { left: 0 } : above === 0 ? { right: 0 } : { left: `${Math.min(78, Math.max(22, (priceX / W) * 100))}%`, transform: 'translateX(-50%)' }),
          }}
        >
          now {now}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
        {below > 0 && (
          <span>
            {key('var(--aqua)')}
            {symB} below the price
          </span>
        )}
        {above > 0 && (
          <span>
            {key('var(--indigo)')}
            {symA} above the price
          </span>
        )}
      </div>
      <p style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--muted)', marginTop: 8 }}>
        {shape === 'agent' ? (
          <>
            <b style={{ color: 'var(--soft)', fontWeight: 500 }}>The agent picks {NAME[s]} here</b> (Curve for stable pairs, Bid-Ask for volatile ones or the Aggressive profile,
            Spot otherwise). {TEXT[s]}
          </>
        ) : (
          <>
            <b style={{ color: 'var(--soft)', fontWeight: 500 }}>{NAME[s]}:</b> {TEXT[s]}
          </>
        )}
      </p>
    </div>
  );
}
