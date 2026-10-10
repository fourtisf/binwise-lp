import type { LiquidityShape, PositionChart } from '@binwise/core';
import { clamp, ease, lerp, prefersReducedMotion } from '../format';

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

export interface LiveChartOptions {
  bins?: number;
  compact?: boolean;
  shape?: LiquidityShape;
  /** Animation time between ticks, ms. */
  interval?: number;
}

/**
 * Live price chart with the liquidity range band and bin histogram.
 * Ported from the prototype; prices now come from the data stream
 * (load + push) instead of a built-in random walk.
 */
export class LiveChart {
  readonly el: HTMLElement;
  private o: Required<LiveChartOptions>;
  private id: string;
  private reduce: boolean;
  private ro: ResizeObserver;
  private data: number[] = [];
  private markers: number[] = [];
  private decimals = 2;
  private lo = 0;
  private hi = 0;
  private dlo = 0;
  private dhi = 0;
  private ymin: number | null = null;
  private ymax = 0;
  private t0 = 0;
  private W = 0;
  private H = 0;
  private pad = { t: 0, b: 0, l: 0 };
  private liqW = 0;
  private axW = 0;
  private plotR = 0;
  private svg!: SVGSVGElement;
  private gGrid!: SVGGElement;
  private band!: SVGRectElement;
  private blh!: SVGLineElement;
  private bll!: SVGLineElement;
  private area!: SVGPathElement;
  private line!: SVGPathElement;
  private mk!: SVGGElement;
  private dot!: SVGCircleElement;
  private halo!: SVGCircleElement;
  private nowl!: SVGLineElement;
  private clip!: SVGRectElement;
  private th: SVGTextElement | null = null;
  private tl: SVGTextElement | null = null;
  private pl: SVGGElement | null = null;
  private bars: SVGRectElement[] = [];

  constructor(el: HTMLElement, o: LiveChartOptions = {}) {
    this.el = el;
    this.o = { bins: 21, compact: false, shape: 'spot', interval: 1400, ...o };
    this.id = 'lc' + uid++;
    this.reduce = prefersReducedMotion();
    this.build();
    this.ro = new ResizeObserver(() => this.size());
    this.ro.observe(el);
    register(this);
  }

  /** Replace the whole series (on mount or when switching pairs). */
  load(c: PositionChart, shape?: LiquidityShape): void {
    if (shape) this.o.shape = shape;
    this.data = [...c.history];
    this.markers = [...c.markers];
    this.decimals = c.decimals;
    this.lo = this.dlo = c.lo;
    this.hi = this.dhi = c.hi;
    this.ymin = null;
    this.t0 = performance.now();
  }

  /** Append one price tick; the oldest point scrolls off. */
  push(price: number, lo: number, hi: number, marker = false): void {
    if (!this.data.length) return;
    this.data.push(price);
    this.data.shift();
    this.markers = this.markers.map((i) => i - 1).filter((i) => i >= 0);
    if (marker) this.markers.push(this.data.length - 1);
    this.lo = lo;
    this.hi = hi;
    this.t0 = performance.now();
  }

  destroy(): void {
    this.ro.disconnect();
    unregister(this);
    this.el.innerHTML = '';
  }

  private build() {
    const id = this.id;
    const c = this.o.compact;
    this.el.innerHTML = `<svg class="lc" aria-hidden="true"><defs>
      <linearGradient id="${id}a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8B8DFF" stop-opacity=".26"/><stop offset="1" stop-color="#8B8DFF" stop-opacity="0"/></linearGradient>
      <linearGradient id="${id}l" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8B8DFF" stop-opacity=".15"/><stop offset=".55" stop-color="#ABADFF"/><stop offset="1" stop-color="#F3F4F8"/></linearGradient>
      <linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4BE3CF" stop-opacity="0"/><stop offset=".6" stop-color="#4BE3CF" stop-opacity=".05"/><stop offset="1" stop-color="#4BE3CF" stop-opacity=".12"/></linearGradient>
      <linearGradient id="${id}r" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FF6B81" stop-opacity="0"/><stop offset="1" stop-color="#FF6B81" stop-opacity=".13"/></linearGradient>
      <clipPath id="${id}c"><rect class="clip"/></clipPath><filter id="${id}g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
    </defs><g class="grid"></g><rect class="band"/><line class="bl blh"/><line class="bl bll"/>
    <g clip-path="url(#${id}c)"><path class="area" fill="url(#${id}a)"/><path class="line" stroke="url(#${id}l)"/><g class="mk"></g></g>
    <circle class="halo" r="9" fill="#fff" opacity=".35" filter="url(#${id}g)"/><circle class="dot" r="4" fill="#fff"/>
    <line class="nowl" stroke="rgba(255,255,255,.22)" stroke-dasharray="2 4"/><g class="liq"></g>
    ${c ? '' : '<g class="rlabel"><text class="th"/><text class="tl"/></g><g class="plabel"><rect rx="5" height="20"/><text/></g>'}</svg>`;
    const s = this.el.firstChild as SVGSVGElement;
    this.svg = s;
    const q = <T extends Element>(k: string) => s.querySelector(k) as T;
    this.gGrid = q('.grid');
    this.band = q('.band');
    this.blh = q('.blh');
    this.bll = q('.bll');
    this.area = q('.area');
    this.line = q('.line');
    this.mk = q('.mk');
    this.dot = q('.dot');
    this.halo = q('.halo');
    this.nowl = q('.nowl');
    this.clip = q('.clip');
    this.th = s.querySelector('.th');
    this.tl = s.querySelector('.tl');
    this.pl = s.querySelector('.plabel');
    const liq = q<SVGGElement>('.liq');
    for (let i = 0; i < this.o.bins; i++) {
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('rx', '1.5');
      liq.appendChild(r);
      this.bars.push(r);
    }
    this.size();
  }

  size(): void {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W) return;
    this.W = W;
    this.H = H;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const c = this.o.compact;
    this.pad = { t: c ? 10 : 26, b: c ? 10 : 26, l: c ? 4 : 16 };
    this.liqW = c ? 40 : Math.min(100, W * 0.14);
    this.axW = c ? 0 : 70;
    this.plotR = W - this.liqW - this.axW - (c ? 6 : 14);
    const set = (el: Element, a: Record<string, string | number>) =>
      Object.entries(a).forEach(([k, v]) => el.setAttribute(k, String(v)));
    set(this.clip, { x: 0, y: 0, width: this.plotR, height: H });
    this.gGrid.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const y = this.pad.t + ((H - this.pad.t - this.pad.b) * i) / 4;
      const l = document.createElementNS(NS, 'line');
      set(l, { class: 'gl', x1: 0, x2: W, y1: y, y2: y });
      this.gGrid.appendChild(l);
    }
  }

  frame(): void {
    if (!this.W || this.data.length < 3) return;
    const { W, H, pad, plotR, liqW, axW, o } = this;
    const d = this.data;
    const n = d.length;
    const e = this.reduce ? 1 : ease(clamp((performance.now() - this.t0) / o.interval, 0, 1));
    this.dlo = lerp(this.dlo, this.lo, 0.1);
    this.dhi = lerp(this.dhi, this.hi, 0.1);
    let mn = Math.min(...d.slice(2), this.dlo);
    let mx = Math.max(...d.slice(2), this.dhi);
    const sp = mx - mn || mx * 0.01;
    mn -= sp * 0.12;
    mx += sp * 0.12;
    if (this.ymin == null) {
      this.ymin = mn;
      this.ymax = mx;
    }
    this.ymin = lerp(this.ymin, mn, 0.06);
    this.ymax = lerp(this.ymax, mx, 0.06);
    const ymin = this.ymin;
    const ymax = this.ymax;
    const Y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - ymin) / (ymax - ymin));
    const step = (plotR - pad.l) / (n - 3);
    const X = (i: number) => plotR - (n - 1 - i) * step + (1 - e) * step;
    let dp = '';
    for (let i = 0; i < n; i++) dp += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(d[i]).toFixed(1);
    this.line.setAttribute('d', dp);
    this.area.setAttribute('d', dp + `L${X(n - 1)} ${H}L${X(0)} ${H}Z`);
    const cy = lerp(Y(d[n - 2]), Y(d[n - 1]), e);
    const cp = lerp(d[n - 2], d[n - 1], e);
    [this.dot, this.halo].forEach((c) => {
      c.setAttribute('cx', String(plotR));
      c.setAttribute('cy', String(cy));
    });
    this.nowl.setAttribute('x1', String(plotR));
    this.nowl.setAttribute('x2', String(W - axW));
    this.nowl.setAttribute('y1', String(cy));
    this.nowl.setAttribute('y2', String(cy));
    const out = !(cp >= this.lo && cp <= this.hi);
    const yh = Y(this.dhi);
    const yl = Y(this.dlo);
    this.band.setAttribute('x', '0');
    this.band.setAttribute('width', String(W - axW));
    this.band.setAttribute('y', String(yh));
    this.band.setAttribute('height', String(Math.max(0, yl - yh)));
    this.band.setAttribute('fill', `url(#${this.id}${out ? 'r' : 'b'})`);
    const bc = out ? 'rgba(255,107,129,.6)' : 'rgba(75,227,207,.45)';
    (
      [
        [this.blh, yh],
        [this.bll, yl],
      ] as const
    ).forEach(([l, y]) => {
      l.setAttribute('x1', '0');
      l.setAttribute('x2', String(W - axW));
      l.setAttribute('y1', String(y));
      l.setAttribute('y2', String(y));
      l.setAttribute('stroke', bc);
    });
    this.dot.setAttribute('fill', out ? '#FF6B81' : '#fff');
    this.halo.setAttribute('fill', out ? '#FF6B81' : '#fff');
    const B = o.bins;
    const bw = (this.dhi - this.dlo) / B;
    const lx = plotR + (o.compact ? 6 : 14);
    for (let i = 0; i < B; i++) {
      const pLo = this.dlo + i * bw;
      const pHi = pLo + bw;
      const y1 = Y(pHi);
      const y2 = Y(pLo);
      const mid = (i + 0.5) / B;
      const shape =
        o.shape === 'curve'
          ? Math.exp(-Math.pow((mid - 0.5) / 0.22, 2))
          : 0.72 + 0.28 * Math.exp(-Math.pow((mid - 0.5) / 0.35, 2));
      const act = cp >= pLo && cp < pHi;
      const b = this.bars[i];
      b.setAttribute('x', String(lx));
      b.setAttribute('y', String(y1 + 0.8));
      b.setAttribute('height', String(Math.max(1, y2 - y1 - 1.6)));
      b.setAttribute('width', String((liqW - 4) * shape));
      b.setAttribute('fill', act ? '#FFFFFF' : pHi <= cp ? '#4BE3CF' : '#8B8DFF');
      b.setAttribute('opacity', String(act ? 1 : pHi <= cp ? 0.7 : 0.55));
    }
    this.mk.innerHTML = this.markers
      .map((i) => {
        const x = X(i);
        const y = Y(d[i]);
        return `<line x1="${x}" x2="${x}" y1="${y + 8}" y2="${H - pad.b + 6}" stroke="rgba(171,173,255,.3)" stroke-dasharray="2 3"/><circle cx="${x}" cy="${y}" r="5.5" fill="#0A0B11" stroke="#ABADFF" stroke-width="2"/>${o.compact ? '' : `<text x="${x + 10}" y="${y - 10}">Rebalanced</text>`}`;
      })
      .join('');
    if (!o.compact && this.th && this.tl && this.pl) {
      const ax = W - axW + 10;
      const dec = this.decimals;
      this.th.setAttribute('x', String(ax));
      this.th.setAttribute('y', String(yh + 4));
      this.th.textContent = this.dhi.toFixed(dec);
      this.th.setAttribute('fill', bc);
      this.tl.setAttribute('x', String(ax));
      this.tl.setAttribute('y', String(yl + 4));
      this.tl.textContent = this.dlo.toFixed(dec);
      this.tl.setAttribute('fill', bc);
      const t = this.pl.querySelector('text')!;
      const rc = this.pl.querySelector('rect')!;
      t.textContent = cp.toFixed(dec);
      rc.setAttribute('x', String(W - axW + 4));
      rc.setAttribute('y', String(cy - 10));
      rc.setAttribute('width', String(Math.max(54, (t.getComputedTextLength ? t.getComputedTextLength() : 50) + 14)));
      rc.setAttribute('fill', out ? '#FF6B81' : '#F3F4F8');
      t.setAttribute('x', String(W - axW + 11));
      t.setAttribute('y', String(cy + 4));
      this.th.style.opacity = Math.abs(cy - yh) < 16 ? '0' : '1';
      this.tl.style.opacity = Math.abs(cy - yl) < 16 ? '0' : '1';
    }
  }
}

// One animation loop for every chart on the page; hidden charts are skipped.
const charts = new Set<LiveChart>();
let raf = 0;
function loop() {
  charts.forEach((c) => c.el.offsetParent && c.frame());
  raf = charts.size ? requestAnimationFrame(loop) : 0;
}
function register(c: LiveChart) {
  charts.add(c);
  if (!raf) raf = requestAnimationFrame(loop);
}
function unregister(c: LiveChart) {
  charts.delete(c);
}
