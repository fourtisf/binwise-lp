import { useId } from 'react';

/** Kovra's mark (A, "Bin Ring"): liquidity bins round a chrome core, the in-range arc in mint, white where price sits. */
const N = 20;
const IN_FROM = 2;
const IN_TO = 9;
const HEAD = 6;
const noise = (i: number) => 0.5 + 0.5 * Math.sin(i * 12.9898 * 1.4) * Math.cos(i * 4.1414 * 1.4);

const TICKS = Array.from({ length: N }, (_, i) => {
  const a = (i / N) * Math.PI * 2 - Math.PI / 2;
  const on = i >= IN_FROM && i <= IN_TO;
  const len = on ? 9 + 7 * noise(i) : 5 + 3 * noise(i);
  const r0 = 15.5;
  return {
    cls: i === HEAD ? 'hd' : on ? 'on' : undefined,
    x1: (32 + Math.cos(a) * r0).toFixed(2),
    y1: (32 + Math.sin(a) * r0).toFixed(2),
    x2: (32 + Math.cos(a) * (r0 + len)).toFixed(2),
    y2: (32 + Math.sin(a) * (r0 + len)).toFixed(2),
  };
});

export function BrandMark({ className = 'bmark' }: { className?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <radialGradient id={`bm${id}`} cx=".34" cy=".28" r=".85">
          <stop offset="0" className="s0" />
          <stop offset=".42" className="s1" />
          <stop offset=".8" className="s2" />
          <stop offset="1" className="s3" />
        </radialGradient>
      </defs>
      {TICKS.map((t, i) => (
        <line key={i} className={t.cls} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
      ))}
      <circle cx="32" cy="32" r="11" fill={`url(#bm${id})`} />
    </svg>
  );
}
