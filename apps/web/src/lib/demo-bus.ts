import type { DemoStats, LiquidityShape } from '@binwise/core';

/** What the landing page's live demo window shows right now; the hero ring and its chips follow it. */
export interface DemoFrame {
  pair: string;
  shape: LiquidityShape;
  price: number;
  lo: number;
  hi: number;
  decimals: number;
  stats: DemoStats;
}

let last: DemoFrame | null = null;
const listeners = new Set<(f: DemoFrame) => void>();

export function emitDemo(f: DemoFrame): void {
  last = f;
  listeners.forEach((fn) => fn(f));
}

/** Calls `fn` with the latest frame right away (if there is one) and on every new one. */
export function onDemo(fn: (f: DemoFrame) => void): () => void {
  listeners.add(fn);
  if (last) fn(last);
  return () => {
    listeners.delete(fn);
  };
}
