// Number and text formatting, identical to the prototype's helpers.
export const fmt = (n: number, d = 0) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd = (n: number, d = 0) => (n < 0 ? '−$' : '$') + fmt(Math.abs(n), d);
export const pct = (n: number, d = 2) => (n >= 0 ? '+' : '−') + fmt(Math.abs(n), d) + '%';
export const fmtM = (v: number) => (v >= 1000 ? '$' + (v / 1000).toFixed(1).replace('.0', '') + 'B' : '$' + v + 'M');
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const ease = (t: number) => 1 - Math.pow(1 - t, 3);
/** Local time as HH:MM. */
export const hhmm = (ts: number = Date.now()) => new Date(ts).toTimeString().slice(0, 5);
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
