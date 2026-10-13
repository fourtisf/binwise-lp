import { clamp } from '../format';
import { resolveColor, token } from '../theme';

let uid = 0;

export interface Series {
  name: string;
  color: string;
  values: number[];
  area?: boolean;
  w?: number;
  dash?: string;
}

/**
 * Clean y-axis ticks (steps of 1, 2, 2.5 or 5 × 10^k) covering [lo, hi] in about `count` steps. A flat
 * series (an empty vault: all zeros) still gets a real range, and values that are never negative never
 * get an axis below zero.
 */
export function niceTicks(lo: number, hi: number, count = 4): { ticks: number[]; step: number } {
  const floorAtZero = lo >= 0;
  if (!(hi > lo)) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.05;
    lo -= pad;
    hi += pad;
  } else {
    const sp = hi - lo;
    lo -= sp * 0.08;
    hi += sp * 0.08;
  }
  if (floorAtZero) lo = Math.max(0, lo);
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw * 0.999)!;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { ticks, step };
}

/** Decimals a tick step needs: 0 for 5, 1 for 2.5, 2 for 0.25. */
export const stepDecimals = (step: number) => (String(Number(step.toPrecision(6))).split('.')[1] ?? '').length;

/** Static multi-series line chart with hover tooltip, ported from the prototype. */
export function lineChart(
  el: HTMLElement,
  {
    series: input,
    labels,
    fmtY,
    fmtTip,
  }: {
    series: Series[];
    labels: string[];
    /** Axis label; `step` is the tick step, to pick the decimals. */
    fmtY: (v: number, step: number) => string;
    fmtTip?: (v: number) => string;
  },
): void {
  const W = el.clientWidth;
  const H = el.clientHeight;
  if (!W || !H) return;
  // Series colours may be theme tokens (var(--c-vault)); SVG attributes need the resolved value.
  const series = input.map((s) => ({ ...s, color: resolveColor(s.color) }));
  const ring = token('--card');
  const pad = { t: 10, r: 8, b: 26, l: 50 };
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const { ticks, step } = niceTicks(Math.min(...all), Math.max(...all));
  const mn = ticks[0];
  const mx = ticks[ticks.length - 1];
  const n = labels.length;
  // One point (a brand-new vault) sits in the middle instead of dividing by zero.
  const X = (i: number) => pad.l + (n > 1 ? ((W - pad.l - pad.r) * i) / (n - 1) : (W - pad.l - pad.r) / 2);
  const Y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - mn) / (mx - mn));
  const gid = 'lg' + uid++;
  let g = '';
  for (const v of ticks) {
    const y = Y(v);
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.045)"/><text x="${pad.l - 10}" y="${y + 4}" text-anchor="end">${fmtY(v, step)}</text>`;
  }
  // X labels at distinct points only (a young vault has few), and never the same text twice.
  const xt = Math.min(W < 500 ? 3 : 5, n);
  const shown = new Set<string>();
  for (let k = 0; k < xt; k++) {
    const i = xt > 1 ? Math.round(((n - 1) * k) / (xt - 1)) : 0;
    if (shown.has(labels[i])) continue;
    shown.add(labels[i]);
    g += `<text x="${X(i)}" y="${H - 6}" text-anchor="${xt == 1 ? 'middle' : k == 0 ? 'start' : k == xt - 1 ? 'end' : 'middle'}">${labels[i]}</text>`;
  }
  let paths = '';
  series
    .slice()
    .reverse()
    .forEach((s) => {
      const d = s.values.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join('');
      if (s.area) paths += `<path d="${d}L${X(n - 1)} ${H - pad.b}L${X(0)} ${H - pad.b}Z" fill="url(#${gid})"/>`;
      paths += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.8}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    });
  el.innerHTML = `<svg class="lc" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${series[0].color}" stop-opacity=".2"/><stop offset="1" stop-color="${series[0].color}" stop-opacity="0"/></linearGradient></defs>${g}${paths}
    <line class="xh" y1="${pad.t}" y2="${H - pad.b}" stroke="rgba(255,255,255,.22)" style="opacity:0"/>${series.map((s, k) => `<circle class="hc${k}" r="4.5" fill="${s.color}" stroke="${ring}" stroke-width="2" style="opacity:0"/>`).join('')}
    <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" class="hit"/></svg><div class="tip"></div>`;
  const svg = el.firstChild as SVGSVGElement;
  const tip = el.querySelector('.tip') as HTMLDivElement;
  const xh = svg.querySelector('.xh') as SVGLineElement;
  const circle = (k: number) => svg.querySelector('.hc' + k) as SVGCircleElement;
  const move = (ev: MouseEvent | TouchEvent) => {
    const rc = svg.getBoundingClientRect();
    const cx = ('touches' in ev ? ev.touches[0].clientX : ev.clientX) - rc.left;
    const i = clamp(Math.round(((cx - pad.l) / (W - pad.l - pad.r)) * (n - 1)), 0, n - 1);
    const x = X(i);
    xh.setAttribute('x1', String(x));
    xh.setAttribute('x2', String(x));
    xh.style.opacity = '1';
    series.forEach((s, k) => {
      const c = circle(k);
      c.setAttribute('cx', String(x));
      c.setAttribute('cy', String(Y(s.values[i])));
      c.style.opacity = '1';
    });
    tip.innerHTML =
      `<div class="tt">${labels[i]}</div>` +
      series
        .map(
          (s) =>
            `<div class="r"><span><i style="background:${s.color}"></i>${s.name}</span><b class="num">${fmtTip ? fmtTip(s.values[i]) : fmtY(s.values[i], step)}</b></div>`,
        )
        .join('');
    tip.classList.add('on');
    const tw = tip.offsetWidth;
    tip.style.left = (x + 14 + tw > W ? x - tw - 14 : x + 14) + 'px';
    tip.style.top = '8px';
  };
  const leave = () => {
    xh.style.opacity = '0';
    tip.classList.remove('on');
    series.forEach((_, k) => (circle(k).style.opacity = '0'));
  };
  const hit = svg.querySelector('.hit')!;
  hit.addEventListener('mousemove', move as EventListener);
  hit.addEventListener('touchmove', move as EventListener, { passive: true });
  hit.addEventListener('mouseleave', leave);
  hit.addEventListener('touchend', leave);
}

export function sparkPath(vals: number[], w: number, h: number): string {
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const n = vals.length;
  return vals
    .map((v, i) => (i ? 'L' : 'M') + ((n > 1 ? i / (n - 1) : 0.5) * w).toFixed(1) + ' ' + (h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4)).toFixed(1))
    .join('');
}

export const dayLabel = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const dayLabels = (n: number) => {
  const out: string[] = [];
  const t = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(dayLabel(t - i * 864e5));
  return out;
};
