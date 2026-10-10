'use client';

import { useEffect, useRef, useState } from 'react';
import { gauss, rng, walk } from '@binwise/mock';
import { getDemoSource } from '@/lib/api/demo';
import { LiveChart } from '@/lib/charts/LiveChart';
import { dayLabels, lineChart } from '@/lib/charts/lineChart';
import { hhmm, pct, prefersReducedMotion } from '@/lib/format';
import { Icon, type IconId } from '../Sprite';

type FeedType = 'deploy' | 'rebalance' | 'exit' | 'compound' | 'scan';
const ICON: Record<FeedType, IconId> = { deploy: 'i-plus', rebalance: 'i-swap', exit: 'i-exit', compound: 'i-comp', scan: 'i-search' };

// Example decisions for the marketing card. The live app shows the vault's real feed.
const EXAMPLES: [FeedType, string, string][] = [
  ['rebalance', 'Rebalanced JUP / SOL', 'Fees over 6h ($14.20) beat the move cost ($0.38).'],
  ['exit', 'Closed WIF / SOL', '7-day trend −14.6% broke your −12% rule.'],
  ['deploy', 'Deployed $2,200 to PENGU / SOL', 'Score 71, trend +6.8%, inside the 25% cap.'],
  ['compound', 'Compounded $41.80 in fees', 'Gas was under 1% of the claim.'],
  ['scan', 'Skipped POPCAT / SOL', 'Volatility 9.8% is too high for Balanced.'],
];

export function BentoFeed() {
  const [items, setItems] = useState<{ k: number; f: (typeof EXAMPLES)[number]; t: string }[]>([]);
  useEffect(() => {
    let i = 0;
    const push = () => {
      const k = i++;
      setItems((xs) => [{ k, f: EXAMPLES[k % EXAMPLES.length], t: hhmm() }, ...xs].slice(0, 3));
    };
    push();
    push();
    push();
    const t = setInterval(push, 3800);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="feed3" id="bFeed">
      {items.map(({ k, f, t }, i) => (
        <div className="fe" key={k} style={i ? { animation: 'none' } : undefined}>
          <span className={`fic ${f[0]}`}>
            <Icon id={ICON[f[0]]} />
          </span>
          <div>
            <b>{f[1]}</b>
            <span>{f[2]}</span>
          </div>
          <time>{t}</time>
        </div>
      ))}
    </div>
  );
}

/** Compact live chart in the "Stays in range" card, from the public demo stream. */
export function BentoChart() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const chart = new LiveChart(el.current, { bins: 13, compact: true });
    let off: (() => void) | undefined;
    let cancelled = false;
    getDemoSource().then((d) => {
      if (cancelled) return;
      off = d.subscribe(d.bentoId, (e) => {
        if (e.type === 'demo:snapshot') chart.load(e.chart);
        else if (e.type === 'demo:tick') chart.push(e.price, e.lo, e.hi, e.marker);
      });
    });
    return () => {
      cancelled = true;
      off?.();
      chart.destroy();
    };
  }, []);
  return <div className="bchart" id="bChart" ref={el}></div>;
}

export function TgChat() {
  const el = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (!e.isIntersecting) return;
          const reduce = prefersReducedMotion();
          [1, 2, 3].forEach((n, i) => timers.push(setTimeout(() => setShown(n), reduce ? 0 : i * 600)));
          io.disconnect();
        }),
      { threshold: 0.4 },
    );
    io.observe(node);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);
  const bubbles = [
    ['Rebalanced JUP / SOL. Fees cover the move 31x.', '14:02'],
    ['Closed WIF / SOL. Trend −14.6% broke your rule. 5,210 USDC back in the vault.', '14:09'],
    ['Compounded $41.80 in fees.', '14:15'],
  ];
  return (
    <div className="vis tg-chat" id="tgChat" ref={el}>
      {bubbles.map(([text, t], i) => (
        <div className={`bubble${i < shown ? ' on' : ''}`} key={t}>
          <b>Binwise</b>
          {text}
          <time>{t}</time>
        </div>
      ))}
    </div>
  );
}

/** Example 30-day comparison: Binwise vs unmanaged LP vs hold (simulated, labelled as such on the page). */
export function VsChart() {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const draw = () => {
      if (!el.current) return;
      const hold = walk(5, 31, 0.0004, 0.018, 100);
      const r = rng(9);
      const bw = hold.map((v, i) => v * (1 + (0.068 * i) / 30 + 0.002 * gauss(r)));
      const un = hold.map((v, i) => v * (1 + (0.012 * i) / 30 + 0.006 * Math.sin(i / 3)));
      const toP = (a: number[]) => a.map((v) => (v / hold[0] - 1) * 100);
      lineChart(el.current, {
        labels: dayLabels(31),
        series: [
          { name: 'Binwise', color: '#4BE3CF', values: toP(bw), area: true, w: 2.2 },
          { name: 'Unmanaged LP', color: '#8B8DFF', values: toP(un) },
          { name: 'Hold', color: '#5D6072', values: toP(hold), dash: '4 4' },
        ],
        fmtY: (v) => (v >= 0 ? '+' : '') + v.toFixed(0) + '%',
        fmtTip: (v) => pct(v, 1),
      });
    };
    draw();
    let rt: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(draw, 150);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return <div className="vschart" id="vsChart" ref={el}></div>;
}
