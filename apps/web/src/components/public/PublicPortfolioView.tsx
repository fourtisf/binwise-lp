'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BRAND } from '@kovra/core/brand';
import type { PublicPortfolio } from '@kovra/core';
import { BrandMark } from '../BrandMark';
import { FeedItem } from '../FeedItem';
import { Icon } from '../Sprite';
import { PairIcon } from '../Tokens';
import { getClient } from '@/lib/api/client';
import { dayLabel, lineChart, stepDecimals } from '@/lib/charts/lineChart';
import { fmt, hhmm, pct, usd } from '@/lib/format';
import { SITE_URL, X_HANDLE, X_URL } from '@/lib/site';

const day = (ts: number) =>
  new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(ts).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
/** How long a position was open: 45m, 6h, 3d. */
const held = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`);
const ago = (ts: number) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const axisUsd = (v: number, step: number) =>
  Math.abs(v) >= 1000 || step >= 1000 ? `$${fmt(v / 1000, stepDecimals(step / 1000))}K` : `$${fmt(v, stepDecimals(step))}`;
const HIDDEN = 'Hidden by owner';

/** A vault's public page: the results its owner chose to share, readable by anyone, no wallet needed. */
export function PublicPortfolioView({ id }: { id: string }) {
  const [p, setP] = useState<PublicPortfolio | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'offline'>('loading');
  const [copied, setCopied] = useState(false);
  const chart = useRef<HTMLDivElement>(null);
  const url = `${SITE_URL.replace(/\/$/, '')}/p/${id}`;

  useEffect(() => {
    let live = true;
    const load = () =>
      getClient()
        .then((c) => (c.kind === 'http' ? c.publicPortfolio(id) : Promise.reject(new Error('offline'))))
        .then((x) => {
          if (!live) return;
          setP(x);
          setState('ok');
        })
        .catch((e: unknown) => {
          if (!live) return;
          const code = (e as { code?: string }).code;
          setState((s) => (s === 'ok' ? s : code === 'not_found' ? 'gone' : 'offline'));
        });
    void load();
    // The agent revalues the vault every minute.
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [id]);

  useEffect(() => {
    const el = chart.current;
    if (!p || !el) return;
    const perf = p.performance;
    if (perf.ts.length < 2) {
      el.innerHTML = `<p class="muted" style="height:100%;display:flex;align-items:center;justify-content:center;text-align:center;font-size:14px">Not enough history yet. The chart fills in as the agent runs.</p>`;
      return;
    }
    const hourly = perf.ts.at(-1)! - perf.ts[0] < 2 * 86_400_000;
    const draw = () =>
      lineChart(el, {
        labels: perf.ts.map((t) => (hourly ? hhmm(t) : dayLabel(t))),
        series: [
          { name: `${BRAND} vault`, color: 'var(--c-vault)', values: perf.vault, area: true, w: 2.2 },
          { name: 'Hold', color: 'var(--c-hold)', values: perf.hold, dash: '4 4' },
        ],
        fmtY: p.showAmounts ? axisUsd : (v, step) => fmt(v, stepDecimals(step)),
        fmtTip: (v) => (p.showAmounts ? usd(v, 2) : fmt(v, 1)),
      });
    draw();
    let rt: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(draw, 150);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [p]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* the link is on screen to copy by hand */
    }
  };
  const tweet = p
    ? `My ${BRAND} vault${p.netVsHold != null ? `: ${pct(p.netVsHold, 1)} vs just holding` : ''}, run by an autonomous LP agent on Meteora DLMM.\n\n${url}\n\n${X_HANDLE}`
    : '';

  const bar = (
    <header className="pubbar">
      <Link className="deck-brand" href="/" title={`${BRAND} home`}>
        <BrandMark />
        <b>{BRAND}</b>
      </Link>
      <div className="acts" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <a className="nav-x" href={X_URL} target="_blank" rel="noreferrer" aria-label={`${BRAND} on X (${X_HANDLE})`}>
          <Icon id="i-xlogo" />
        </a>
        <Link className="btn btn-white btn-sm" href="/app">
          Launch app
        </Link>
      </div>
    </header>
  );

  if (state !== 'ok' || !p)
    return (
      <div className="pub">
        {bar}
        <div className="pubwrap">
          <div className="panel card" style={{ textAlign: 'center', padding: '56px 22px', marginTop: 64 }}>
            <h3 style={{ fontSize: 22 }}>
              {state === 'loading' ? 'Loading portfolio…' : state === 'gone' ? 'This portfolio is private' : 'Portfolio unavailable right now'}
            </h3>
            <p className="muted" style={{ margin: '10px auto 0', maxWidth: '46ch' }}>
              {state === 'loading'
                ? ' '
                : state === 'gone'
                  ? 'Its owner switched the public page off, or the link is wrong.'
                  : 'We could not reach the server. Try again in a moment.'}
            </p>
          </div>
        </div>
      </div>
    );

  const inRange = p.open.filter((x) => x.inRange).length;
  return (
    <div className="pub">
      {bar}
      <div className="pubwrap">
        <div className="phead">
          <div className="phead-t">
            <span className="kicker">
              <i className={p.mode === 'live' ? undefined : 'paper'}></i>
              Public portfolio · {p.mode === 'live' ? 'Mainnet, real funds' : 'Paper, simulated funds'} · since {day(p.since)}
            </span>
            <h1>{p.name}</h1>
            <p>A {BRAND} vault, shared by its owner. Every number comes from the agent&apos;s own records.</p>
          </div>
          <div className="pub-share">
            <button className="btn btn-dark btn-sm" onClick={() => void copy()}>
              <Icon id="i-copy" />
              {copied ? 'Link copied' : 'Copy link'}
            </button>
            <a className="btn btn-white btn-sm" href={`https://x.com/intent/post?text=${encodeURIComponent(tweet)}`} target="_blank" rel="noreferrer">
              <Icon id="i-xlogo" />
              Share on X
            </a>
          </div>
        </div>

        <div className="ovh card pub-hero">
          <div className="ovh-main">
            <span className="kicker">
              <i></i>Net vs hold, since the start
            </span>
            <div className={`ovh-big num ${p.netVsHold == null || p.netVsHold >= 0 ? 'up' : 'down'}`}>{p.netVsHold != null ? pct(p.netVsHold, 1) : '—'}</div>
            <p className="ovh-sub">
              {p.netVsHold != null
                ? 'The vault against simply holding the same deposits at today’s prices, after impermanent loss and costs.'
                : 'Starts with the first recorded deposit.'}
            </p>
            <div className="ovh-stats">
              <div>
                <small>Vault value</small>
                <b className="num">{p.value != null ? usd(p.value, 2) : '—'}</b>
                <span>{p.value != null ? `Updated ${ago(p.updatedAt)}` : HIDDEN}</span>
              </div>
              <div>
                <small>Fees earned</small>
                <b className="num up">{p.fees != null ? usd(p.fees, 2) : '—'}</b>
                <span>{p.fees != null ? 'All positions, all time' : HIDDEN}</span>
              </div>
              <div>
                <small>Beat holding</small>
                <b className="num">{p.closedCount ? `${p.beatHold} of ${p.closedCount}` : '—'}</b>
                <span>{p.closedCount ? 'Closed positions' : 'None closed yet'}</span>
              </div>
            </div>
          </div>
          <div className="pub-side">
            <div>
              <small>Open positions</small>
              <b className="num">{p.open.length}</b>
              <span>{p.open.length ? `${inRange} in range` : 'None right now'}</span>
            </div>
            <div>
              <small>Closed positions</small>
              <b className="num">{p.closedCount}</b>
              <span>Since {day(p.since)}</span>
            </div>
          </div>
        </div>

        <div className="panel card perf">
          <div className="ph">
            <div>
              <h3>Vault vs holding, 30 days</h3>
              <p>{p.showAmounts ? `${BRAND} compared with holding the same tokens` : 'Both lines start at 100: the gap is the result, the size stays private'}</p>
            </div>
          </div>
          <div className="perf-keys">
            <span>
              <i style={{ background: 'var(--c-vault)' }}></i>
              {BRAND} vault
            </span>
            <span>
              <i style={{ background: 'var(--c-hold)' }}></i>
              Hold
            </span>
          </div>
          <div className="eq" ref={chart}></div>
        </div>

        <div className="g2">
          <div className="panel card">
            <div className="ph">
              <div>
                <h3>Open positions</h3>
                <p>Live on Meteora DLMM right now</p>
              </div>
            </div>
            {p.open.length ? (
              <div className="rows pub-rows">
                {p.open.map((x, i) => (
                  <div key={`${x.pair}-${i}`}>
                    <span className="pairname" style={{ color: 'var(--text)' }}>
                      <PairIcon a={x.tokenA} b={x.tokenB} />
                      {x.pair}
                      <span className={`pill ${x.inRange ? 'in' : 'out'}`}>
                        <span className="d"></span>
                        {x.inRange ? 'In range' : 'Out of range'}
                      </span>
                    </span>
                    <b className="num" style={{ textAlign: 'right' }}>
                      <span className={x.netVsHold >= 0 ? 'up' : 'down'}>{pct(x.netVsHold, 1)}</span>
                      {x.value != null && <span className="muted" style={{ fontWeight: 400, marginLeft: 10 }}>{usd(x.value)}</span>}
                    </b>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 14 }}>No open positions right now. The agent waits for a pool worth entering.</p>
            )}
          </div>
          <div className="panel card">
            <div className="ph">
              <div>
                <h3>Agent moves</h3>
                <p>The latest deploys, re-centers and exits, with the reason</p>
              </div>
            </div>
            <div className="feed">
              {p.activity.length ? (
                p.activity.map((d) => <FeedItem d={d} key={d.id} />)
              ) : (
                <p className="muted" style={{ fontSize: 14 }}>No moves yet.</p>
              )}
            </div>
          </div>
        </div>

        <div className="panel card" style={{ marginTop: 12 }}>
          <div className="ph">
            <div>
              <h3>Closed positions</h3>
              <p>Latest first</p>
            </div>
          </div>
          <div className="tbl">
            <table>
              <thead>
                <tr>
                  <th>Pool</th>
                  <th className="r">Net vs hold</th>
                  <th className="r">Fees</th>
                  <th className="r pub-wide">Held</th>
                  <th className="r pub-wide">Closed</th>
                </tr>
              </thead>
              <tbody>
                {p.closed.length ? (
                  p.closed.map((c, i) => (
                    <tr key={`${c.pair}-${c.closedAt}-${i}`} style={{ cursor: 'default' }}>
                      <td>
                        <span className="pairname">
                          <PairIcon a={c.tokenA} b={c.tokenB} />
                          {c.pair}
                        </span>
                      </td>
                      <td className={`r num ${c.netVsHold >= 0 ? 'up' : 'down'}`}>{pct(c.netVsHold, 1)}</td>
                      <td className="r num up">{c.fees != null ? usd(c.fees, 2) : '—'}</td>
                      <td className="r num muted pub-wide">{held(c.closedAt - c.openedAt)}</td>
                      <td className="r muted pub-wide">{day(c.closedAt)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="muted" style={{ padding: '24px 16px', cursor: 'default' }}>
                      No closed positions yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="pub-foot">
          <p>
            Shared by the vault&apos;s owner. Figures come from {BRAND}&apos;s records and update every agent cycle. Past results don&apos;t guarantee
            future returns. DeFi carries risk, including total loss of funds. Not financial advice.
          </p>
          <Link className="btn btn-white" href="/app">
            Run your own {BRAND} agent
          </Link>
        </div>
      </div>
    </div>
  );
}
