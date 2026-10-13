/**
 * The colour palette lives in one place: the CSS tokens on :root in globals.css.
 * SVG presentation attributes can't use var(), so the SVG charts resolve tokens here
 * (once per build, not per frame).
 */
export function token(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 'var(--up)' becomes the token's value; any other colour passes through unchanged. */
export function resolveColor(c: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(c.trim());
  return m ? token(m[1]) || c : c;
}

/** `rgba()` from a `--x-rgb` channel token, e.g. alpha('--up-rgb', 0.45). */
export function alpha(rgbToken: string, a: number): string {
  return `rgba(${token(rgbToken) || '255,255,255'},${a})`;
}
