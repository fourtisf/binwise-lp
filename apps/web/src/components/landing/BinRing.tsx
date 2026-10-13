'use client';

import { useEffect, useRef, useState } from 'react';
import type { LiquidityShape } from '@binwise/core';
import { onDemo, type DemoFrame } from '@/lib/demo-bus';
import { pct, prefersReducedMotion } from '@/lib/format';
import { token } from '@/lib/theme';

/** Bins round the ring; the position's range is the bright arc, clockwise = higher price. */
const N = 120;
const RANGE = 58;
const START = 16;
const R0 = 150;
const MAX = 238;

/** Liquidity per bin across the range (m = 0..1), the same shapes the agent deploys. */
function weight(shape: LiquidityShape, m: number): number {
  if (shape === 'curve') return Math.exp(-Math.pow((m - 0.5) / 0.22, 2));
  if (shape === 'bidask') return 0.35 + 0.65 * Math.pow(Math.abs(m - 0.5) * 2, 1.4);
  return 0.72 + 0.28 * Math.exp(-Math.pow((m - 0.5) / 0.35, 2));
}

/** The market's thin liquidity outside the range: fixed, so the ring keeps its silhouette. */
const noise = (i: number) => 0.5 + 0.5 * Math.sin(i * 12.9898) * Math.cos(i * 4.1414);

function lengths(shape: LiquidityShape): number[] {
  return Array.from({ length: N }, (_, i) => {
    const k = i - START;
    if (k < 0 || k >= RANGE) return 54 + 44 * noise(i);
    return 118 + (MAX - 118) * weight(shape, k / (RANGE - 1));
  });
}

/** Index of the bin holding the price; just outside the arc when the price left the range. */
function activeBin(f: DemoFrame | null): number {
  if (!f || !(f.hi > f.lo)) return START + Math.floor(RANGE / 2);
  const t = (f.price - f.lo) / (f.hi - f.lo);
  if (t < 0) return START - 1;
  if (t > 1) return START + RANGE;
  return START + Math.min(RANGE - 1, Math.floor(t * RANGE));
}

const angle = (i: number) => (i / N) * Math.PI * 2 - Math.PI / 2;

/** Hero visual: the demo vault's liquidity, bin by bin, round a chrome core, following the live window below. */
export function BinRing() {
  const [frame, setFrame] = useState<DemoFrame | null>(null);
  const bars = useRef<SVGGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const initial = lengths('spot');

  useEffect(() => onDemo(setFrame), []);

  useEffect(() => {
    const g = bars.current;
    if (!g) return;
    const lines = Array.from(g.children) as SVGLineElement[];
    const c = { up: token('--up'), down: token('--down'), accent: token('--accent') };
    const shape = frame?.shape ?? 'spot';
    const target = lengths(shape);
    const act = activeBin(frame);
    const out = act < START || act >= START + RANGE;
    lines.forEach((l, i) => {
      const inRange = i >= START && i < START + RANGE;
      const color = i === act ? (out ? c.down : '#fff') : !inRange ? 'rgba(255,255,255,.14)' : i < act ? c.up : c.accent;
      l.setAttribute('stroke', color);
      l.setAttribute('stroke-opacity', i === act ? '1' : !inRange ? '1' : i < act ? '.78' : '.5');
      l.setAttribute('stroke-width', i === act ? '6' : '4.2');
    });
    const cur = lines.map((l) => Math.hypot(+l.getAttribute('x2')!, +l.getAttribute('y2')!) - R0);
    const draw = (t: number, ease: number) => {
      lines.forEach((l, i) => {
        const breathe = 1 + 0.035 * Math.sin(t / 900 + i * 0.35);
        const want = (i === act ? target[i] + 24 : target[i]) * breathe;
        cur[i] += (want - cur[i]) * ease;
        const a = angle(i);
        l.setAttribute('x2', (Math.cos(a) * (R0 + cur[i])).toFixed(1));
        l.setAttribute('y2', (Math.sin(a) * (R0 + cur[i])).toFixed(1));
      });
    };
    if (prefersReducedMotion()) {
      draw(0, 1);
      return;
    }
    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(loop);
    });
    if (box.current) io.observe(box.current);
    function loop(t: number) {
      raf = 0;
      if (!visible || document.hidden) return;
      draw(t, 0.08);
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [frame]);

  const s = frame?.stats;
  return (
    <div className="ring" ref={box}>
      <svg viewBox="-420 -420 840 840" role="img" aria-label="The demo vault's liquidity, bin by bin, around the current price">
        <circle r="404" fill="none" stroke="rgba(255,255,255,.06)" strokeDasharray="2 7" className="ring-orbit" />
        <circle r="144" fill="none" stroke="rgba(255,255,255,.08)" />
        <g ref={bars} strokeLinecap="round">
          {initial.map((len, i) => {
            const a = angle(i);
            const inRange = i >= START && i < START + RANGE;
            return (
              <line
                key={i}
                x1={(Math.cos(a) * R0).toFixed(1)}
                y1={(Math.sin(a) * R0).toFixed(1)}
                x2={(Math.cos(a) * (R0 + len)).toFixed(1)}
                y2={(Math.sin(a) * (R0 + len)).toFixed(1)}
                stroke={inRange ? 'rgba(201,205,214,.45)' : 'rgba(255,255,255,.14)'}
                strokeWidth="4.2"
              />
            );
          })}
        </g>
      </svg>
      <span className="core" aria-hidden="true"></span>
      <div className="rchip c1">
        <small>Net vs hold</small>
        <b className={`num ${s ? (s.netVsHold >= 0 ? 'up' : 'down') : ''}`}>{s ? pct(s.netVsHold) : '—'}</b>
      </div>
      <div className="rchip c2">
        <small>Active bin</small>
        <b className="num">{frame ? frame.price.toFixed(frame.decimals) : '—'}</b>
      </div>
      <div className="rchip c3">
        <small>Time in range</small>
        <b className="num">{s ? `${s.timeInRange}%` : '—'}</b>
      </div>
      <p className="rcap">{frame ? `${frame.pair} · demo vault, simulated funds` : 'Demo vault, simulated funds'}</p>
    </div>
  );
}
