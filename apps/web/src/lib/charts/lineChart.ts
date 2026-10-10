import { clamp } from '../format';

let uid = 0;

export interface Series {
  name: string;
  color: string;
  values: number[];
  area?: boolean;
  w?: number;
  dash?: string;
}

/** Static multi-series line chart with hover tooltip, ported from the prototype. */
export function lineChart(
  el: HTMLElement,
  {
    series,
    labels,
    fmtY,
    fmtTip,
  }: { series: Series[]; labels: string[]; fmtY: (v: number) => string; fmtTip?: (v: number) => string },
): void {
  const W = el.clientWidth;
  const H = el.clientHeight;
  if (!W || !H) return;
  const pad = { t: 10, r: 8, b: 26, l: 50 };
  const all = series.flatMap((s) => s.values);
  let mn = Math.min(...all);
  let mx = Math.max(...all);
  const sp = mx - mn;
  mn -= sp * 0.08;
  mx += sp * 0.08;
  const n = labels.length;
  const X = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / (n - 1);
  const Y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - mn) / (mx - mn));
  const gid = 'lg' + uid++;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = mn + ((mx - mn) * i) / 4;
    const y = Y(v);
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.045)"/><text x="${pad.l - 10}" y="${y + 4}" text-anchor="end">${fmtY(v)}</text>`;
  }
  const xt = W < 500 ? 3 : 5;
  for (let k = 0; k < xt; k++) {
    const i = Math.round(((n - 1) * k) / (xt - 1));
    g += `<text x="${X(i)}" y="${H - 6}" text-anchor="${k == 0 ? 'start' : k == xt - 1 ? 'end' : 'middle'}">${labels[i]}</text>`;
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
    <line class="xh" y1="${pad.t}" y2="${H - pad.b}" stroke="rgba(255,255,255,.22)" style="opacity:0"/>${series.map((s, k) => `<circle class="hc${k}" r="4.5" fill="${s.color}" stroke="#0D0E15" stroke-width="2" style="opacity:0"/>`).join('')}
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
            `<div class="r"><span><i style="background:${s.color}"></i>${s.name}</span><b class="num">${(fmtTip || fmtY)(s.values[i])}</b></div>`,
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
    .map((v, i) => (i ? 'L' : 'M') + ((i / (n - 1)) * w).toFixed(1) + ' ' + (h - 2 - ((v - mn) / (mx - mn || 1)) * (h - 4)).toFixed(1))
    .join('');
}

export const dayLabel = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const dayLabels = (n: number) => {
  const out: string[] = [];
  const t = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(dayLabel(t - i * 864e5));
  return out;
};
