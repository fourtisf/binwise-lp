// Number and text formatting, identical to the prototype's helpers.
export const fmt = (n: number, d = 0) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd = (n: number, d = 0) => (n < 0 ? '−$' : '$') + fmt(Math.abs(n), d);
export const pct = (n: number, d = 2) => {
  // Round first so a tiny negative doesn't show as "−0.00%".
  const r = Number(n.toFixed(d));
  return (r >= 0 ? '+' : '−') + fmt(Math.abs(r), d) + '%';
};
export const fmtM = (v: number) => (v >= 1000 ? '$' + (v / 1000).toFixed(1).replace('.0', '') + 'B' : v < 1 ? '$' + Math.round(v * 1000) + 'K' : '$' + v + 'M');
/** Dollar amounts in K / M / B: $85K, $2.4M, $1.2B. */
export const compactUsd = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e9 ? (a / 1e9).toFixed(1).replace('.0', '') + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1).replace('.0', '') + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'K' : fmt(a);
  return (n < 0 ? '−$' : '$') + s;
};
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => 1 - Math.pow(1 - t, 3);
/** Local time as HH:MM. */
export const hhmm = (ts: number = Date.now()) => new Date(ts).toTimeString().slice(0, 5);
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
