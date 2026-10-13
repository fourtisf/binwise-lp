import type { CSSProperties } from 'react';

/** Bins round the ring; the lit ones are the share of time the vault's positions stayed in range. */
const N = 72;
const R0 = 88;
/** Fixed bin heights, so the ring reads as liquidity bins (the landing hero's language) and never jumps. */
const noise = (i: number) => 0.5 + 0.5 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414);

/** Overview gauge: time in range over 30 days as a ring of bins round the figure. */
export function RangeRing({ value }: { value: number | null }) {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const lit = v == null ? 0 : Math.round((v / 100) * N);
  return (
    <div className="rr">
      <svg viewBox="-140 -140 280 280" role="img" aria-label={v == null ? 'No time in range yet' : `${Math.round(v)}% time in range over 30 days`}>
        <circle r="80" className="rr-track" />
        <circle r="132" className="rr-orbit" />
        {Array.from({ length: N }, (_, i) => {
          const a = (i / N) * Math.PI * 2 - Math.PI / 2;
          const len = 14 + 22 * noise(i);
          const on = i < lit;
          return (
            <line
              key={i}
              className={on ? (i === lit - 1 ? 'on head' : 'on') : undefined}
              style={on ? ({ '--o': (0.25 + (0.6 * i) / N).toFixed(2), transitionDelay: `${i * 8}ms` } as CSSProperties) : undefined}
              x1={(Math.cos(a) * R0).toFixed(1)}
              y1={(Math.sin(a) * R0).toFixed(1)}
              x2={(Math.cos(a) * (R0 + len)).toFixed(1)}
              y2={(Math.sin(a) * (R0 + len)).toFixed(1)}
            />
          );
        })}
      </svg>
      <div className="rr-c">
        <b className="num">{v == null ? '—' : `${Math.round(v)}%`}</b>
        <small>time in range, 30d</small>
      </div>
    </div>
  );
}
