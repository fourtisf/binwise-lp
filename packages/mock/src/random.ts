/** Seeded PRNG (mulberry32), identical to the prototype so charts look the same. */
export function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample (Box–Muller). */
export function gauss(r: () => number): number {
  let u = 0;
  let v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Geometric random walk. */
export function walk(seed: number, n: number, drift: number, vol: number, start = 100): number[] {
  const r = rng(seed);
  const a = [start];
  for (let i = 1; i < n; i++) a.push(a[i - 1] * (1 + drift + vol * gauss(r)));
  return a;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
