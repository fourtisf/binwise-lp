'use client';

import { useEffect, useRef, useState } from 'react';
import type { DemoStats, LiquidityShape } from '@binwise/core';
import { getClient } from '@/lib/api/client';
import { LiveChart } from '@/lib/charts/LiveChart';
import { hhmm, pct, prefersReducedMotion, usd } from '@/lib/format';
import { Icon } from '../Sprite';
import { PairIcon } from '../Tokens';

const PAIRS: { id: string; name: string; shape: LiquidityShape; a: [string, string]; b: [string, string] }[] = [
  { id: 'jup-sol', name: 'JUP / SOL', shape: 'spot', a: ['J', '#4BE3CF'], b: ['S', '#A19BFF'] },
  { id: 'sol-usdc', name: 'SOL / USDC', shape: 'curve', a: ['S', '#A19BFF'], b: ['U', '#5B95FF'] },
  { id: 'pengu-sol', name: 'PENGU / SOL', shape: 'spot', a: ['P', '#9ADFFF'], b: ['S', '#A19BFF'] },
];

const tok = ([letter, color]: [string, string]) => ({ letter, color });

/** Landing hero: a live read-only window onto a paper vault, with the agent's reasoning. */
export function HeroWindow() {
  const [pair, setPair] = useState(0);
  const [stats, setStats] = useState<DemoStats>({ fees: 0, netVsHold: 0, rebalances: 0, timeInRange: 100, inRange: true });
  const [mode, setMode] = useState('Holding position');
  const [log, setLog] = useState<[string, string, string][]>([]);
  const chartEl = useRef<HTMLDivElement>(null);
  const thoughtEl = useRef<HTMLSpanElement>(null);
  const chart = useRef<LiveChart | null>(null);
  const typeTimer = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!chartEl.current) return;
    const c = new LiveChart(chartEl.current, { bins: 21 });
    chart.current = c;
    return () => {
      c.destroy();
      clearInterval(typeTimer.current);
    };
  }, []);

  useEffect(() => {
    const think = (text: string) => {
      clearInterval(typeTimer.current);
      const el = thoughtEl.current;
      if (!el) return;
      if (prefersReducedMotion()) {
        el.textContent = text;
        return;
      }
      let i = 0;
      el.textContent = '';
      typeTimer.current = setInterval(() => {
        i += 2;
        el.textContent = text.slice(0, i);
        if (i >= text.length) clearInterval(typeTimer.current);
      }, 18);
    };
    const p = PAIRS[pair];
    let off: (() => void) | undefined;
    let cancelled = false;
    getClient().then((client) => {
      if (cancelled) return;
      off = client.demo(p.id, (e) => {
        if (e.type === 'demo:snapshot') {
          chart.current?.load(e.chart, p.shape);
          setLog(e.log.map(([a, b]) => [a, b, hhmm()]));
          think(e.thought);
        } else {
          chart.current?.push(e.price, e.lo, e.hi, e.marker);
          if (e.thought) think(e.thought);
          if (e.log) setLog((l) => [[e.log![0], e.log![1], hhmm()] as [string, string, string], ...l].slice(0, 3));
        }
        setStats(e.stats);
        setMode(e.mode);
      });
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [pair]);

  return (
    <div className="win">
      <div className="wbar">
        <div className="dots">
          <i></i>
          <i></i>
          <i></i>
        </div>
        <div className="url">
          <Icon id="i-lock" />
          app.binwise.fi
        </div>
        <div style={{ width: 47 }}></div>
      </div>
      <div className="wbody">
        <div className="wside">
          <span className="on">
            <Icon id="i-home" />
          </span>
          <span>
            <Icon id="i-pools" />
          </span>
          <span>
            <Icon id="i-pos" />
          </span>
          <span>
            <Icon id="i-strat" />
          </span>
          <span>
            <Icon id="i-act" />
          </span>
        </div>
        <div className="wmain">
          <div className="wtop">
            <div className="pairtabs" id="pairtabs" role="group" aria-label="Choose pool">
              {PAIRS.map((p, i) => (
                <button key={p.id} aria-pressed={i === pair} data-pair={i} onClick={() => setPair(i)}>
                  <PairIcon a={tok(p.a)} b={tok(p.b)} />
                  {p.name}
                </button>
              ))}
            </div>
            <span className={`pill live ${stats.inRange ? 'in' : 'out'}`} id="hStatus">
              <span className="d"></span>
              {stats.inRange ? 'In range' : 'Out of range'}
            </span>
          </div>
          <div className="wstats">
            <div className="ws">
              <small>Fees earned</small>
              <b className="num up">{usd(stats.fees, 2)}</b>
            </div>
            <div className="ws">
              <small>Net vs hold</small>
              <b className={`num ${stats.netVsHold >= 0 ? 'up' : 'down'}`}>{pct(stats.netVsHold)}</b>
            </div>
            <div className="ws">
              <small>Rebalances</small>
              <b className="num">{stats.rebalances}</b>
            </div>
            <div className="ws">
              <small>Time in range</small>
              <b className="num">{stats.timeInRange}%</b>
            </div>
          </div>
          <div className="wgrid">
            <div className="wchart" id="heroChart" ref={chartEl}></div>
            <div className="wreason">
              <div className="agent-h">
                <span className="orb"></span>
                <div>
                  <b>Binwise agent</b>
                  <span>{mode}</span>
                </div>
              </div>
              <div className="thought">
                <small>Reasoning</small>
                <span ref={thoughtEl}></span>
                <span className="caret"></span>
              </div>
              <div className="minilog">
                {log.map(([a, b, t], i) => (
                  <div key={`${t}-${a}-${b}-${i}`}>
                    <span>{a}</span>
                    <span>
                      {b}
                      <time>{t}</time>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
