'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { PublicList, PublicListRow } from '@kovra/core';
import { BRAND } from '@kovra/core/brand';
import { Chips } from '@/components/Chips';
import { Icon } from '@/components/Sprite';
import { PairIcon } from '@/components/Tokens';
import { pct, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';

type Sort = 'nvh' | 'value' | 'new';

const day = (ts: number) =>
  new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(new Date(ts).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
const ago = (ts: number) => {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const sorted = (rows: PublicListRow[], sort: Sort) =>
  sort === 'nvh'
    ? rows // the server ranks by net vs hold
    : [...rows].sort((a, b) => (sort === 'new' ? b.since - a.since : (b.value ?? -1) - (a.value ?? -1)));

/** Every LP who made their portfolio public, ranked by net vs hold. Readable without a wallet. */
export default function PublicPage() {
  const { client } = useAppData();
  const [list, setList] = useState<PublicList | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'offline'>('loading');
  const [sort, setSort] = useState<Sort>('nvh');

  useEffect(() => {
    if (!client) return;
    if (client.kind !== 'http') return void setState('offline');
    let live = true;
    const load = () =>
      client
        .publicList()
        .then((x) => {
          if (!live) return;
          setList(x);
          setState('ok');
        })
        .catch(() => live && setState((s) => (s === 'ok' ? s : 'offline')));
    void load();
    // The agent revalues every vault each minute.
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [client]);

  const rows = sorted(list?.rows ?? [], sort);
  const ahead = rows.filter((r) => (r.netVsHold ?? 0) > 0).length;
  const open = rows.reduce((n, r) => n + r.open, 0);
  const inRange = rows.reduce((n, r) => n + r.inRange, 0);

  return (
    <div className="page on" id="p-public">
      <div className="card lp-sum">
        <div>
          <small>Public LPs</small>
          <b className="num">{list ? rows.length : '—'}</b>
          <span>Mainnet, real funds</span>
        </div>
        <div>
          <small>Ahead of holding</small>
          <b className="num up">{list && rows.length ? `${ahead} of ${rows.length}` : '—'}</b>
          <span>Net vs hold above zero</span>
        </div>
        <div>
          <small>Open positions</small>
          <b className="num">{list ? open : '—'}</b>
          <span>{open ? `${inRange} in range right now` : 'Across every public vault'}</span>
        </div>
      </div>

      <div className="toolbar">
        <Chips
          id="publicSort"
          items={[
            ['nvh', 'Net vs hold'],
            ['value', 'Value'],
            ['new', 'Newest'],
          ]}
          current={sort}
          onPick={(k) => setSort(k as Sort)}
        />
      </div>

      <div className="card lp-list">
        {rows.length ? (
          rows.map((r, i) => (
            <Link className="lp-row" href={`/p/${r.publicId}`} key={r.publicId}>
              <span className="lp-rk num">{String(i + 1).padStart(2, '0')}</span>
              <span className="lp-id">
                <span className="lp-av num" aria-hidden="true">
                  {r.label.slice(3, 5)}
                </span>
                <span>
                  <b>{r.label}</b>
                  <small>
                    Since {day(r.since)}
                    {r.lastMoveAt ? ` · moved ${ago(r.lastMoveAt)}` : ''}
                  </small>
                </span>
              </span>
              <span className="lp-pools">
                {r.pools.length ? (
                  <span className="pairname">
                    <PairIcon a={r.pools[0].tokenA} b={r.pools[0].tokenB} />
                    {r.pools[0].pair}
                    {r.open > 1 && <small>+{r.open - 1}</small>}
                  </span>
                ) : (
                  <small>No open position</small>
                )}
              </span>
              <span className="lp-stat lp-nvh">
                <small>Net vs hold</small>
                <b className={`num ${r.netVsHold == null ? '' : r.netVsHold >= 0 ? 'up' : 'down'}`}>{r.netVsHold != null ? pct(r.netVsHold, 1) : '—'}</b>
              </span>
              <span className="lp-stat lp-val">
                <small>Value</small>
                <b className="num">{r.value != null ? usd(r.value) : 'Hidden'}</b>
              </span>
              <span className="lp-stat lp-fees">
                <small>Fees earned</small>
                <b className={`num${r.fees != null ? ' up' : ''}`}>{r.fees != null ? usd(r.fees, 2) : 'Hidden'}</b>
              </span>
              <span className="lp-stat lp-pos">
                <small>Positions</small>
                <b className="num">
                  {r.open} open
                  {r.open ? (
                    <em>
                      <i> · </i>
                      {r.inRange} in range
                    </em>
                  ) : null}
                </b>
              </span>
              <Icon id="i-chev" />
            </Link>
          ))
        ) : (
          <div className="lp-empty">
            <h3>{state === 'loading' ? 'Loading public portfolios…' : state === 'offline' ? 'Public portfolios are unavailable right now' : 'No public portfolios yet'}</h3>
            <p>
              {state === 'offline'
                ? 'We could not reach the server. Try again in a moment.'
                : state === 'ok'
                  ? `LPs show here once they switch their public portfolio on and the ${BRAND} agent has added liquidity for them.`
                  : ' '}
            </p>
          </div>
        )}
      </div>

      <div className="card lp-join">
        <div>
          <h3>Put your results here</h3>
          <p>
            Open Portfolio and switch on Public portfolio. You show under a made-up name, never your wallet address, and you choose whether dollar amounts
            show. Switch it off any time.
          </p>
        </div>
        <Link className="btn btn-white btn-sm" href="/app/portfolio#pfPublic">
          Open Portfolio
        </Link>
      </div>
      <p className="dim" style={{ fontSize: 13, marginTop: 12 }}>
        Figures come from {BRAND}&apos;s records and update every agent cycle. Past results don&apos;t guarantee future returns. DeFi carries risk, including
        total loss of funds. Not financial advice.
      </p>
    </div>
  );
}
