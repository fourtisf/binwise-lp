'use client';

import { useEffect, useState } from 'react';
import type { PoolDetail } from '@binwise/core';
import { fmt, fmtM, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { ErrorBoundary } from '../ErrorBoundary';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { PairIcon } from '../Tokens';
import { AddLp } from './AddLp';

/** Slide-out with how the agent scored a pool. */
export function PoolDrawer() {
  const { layer, drawerPoolId, closeLayers, toast } = useUi();
  const copy = (label: string, value: string) =>
    navigator.clipboard
      .writeText(value)
      .then(() => toast(`${label} copied`))
      .catch(() => toast(value));
  const { client, pools, overview } = useAppData();
  const [x, setX] = useState<PoolDetail | null>(null);
  const on = layer === 'drawer';
  const canAdd = client?.kind === 'http' && !!overview && !overview.readOnly;

  // Re-fetch when the pool changes or the pool list refreshes (e.g. after saving a strategy).
  useEffect(() => {
    if (!client || !drawerPoolId) return;
    let live = true;
    client
      .pool(drawerPoolId)
      .then((d) => live && setX(d))
      .catch(() => live && setX(null));
    return () => {
      live = false;
    };
  }, [client, drawerPoolId, pools]);

  return (
    <aside className={`drawer${on ? ' on' : ''}`} id="drawer" aria-label="Pool details" aria-hidden={!on}>
      <ErrorBoundary area="pool details" key={drawerPoolId ?? ''}>
        {x && (
          <>
            <div className="dh">
              <span className="pairname" style={{ fontSize: 17 }}>
                <PairIcon a={x.tokenA} b={x.tokenB} />
                {x.pair}
              </span>
              <button className="x" onClick={closeLayers} aria-label="Close">
                <Icon id="i-x" />
              </button>
            </div>
            <div className="versus">
              <div>
                <small>Agent score</small>
                <b className="num">{x.score}</b>
              </div>
              <div>
                <small>Agent call</small>
                <div style={{ marginTop: 10 }}>
                  <span className={`pill ${x.call}`}>
                    <span className="d"></span>
                    {x.callLabel}
                  </span>
                </div>
              </div>
            </div>
            <div className={`verdict ${x.call === 'out' ? 'stop' : x.call === 'in' ? 'go' : 'wt'}`}>{x.reason}</div>
            <div className="dsec">How the score was built</div>
            <div className="breakdown">
              {x.breakdown.map(({ label, value: v }) => (
                <div className="bk" key={label}>
                  <span className="muted">{label}</span>
                  <div className="track">
                    <div
                      className="fill"
                      style={
                        v >= 0
                          ? { background: 'var(--aqua)', left: '50%', width: `${Math.min(50, (v / 40) * 50)}%` }
                          : { background: 'var(--red)', right: '50%', width: `${Math.min(50, (-v / 40) * 50)}%` }
                      }
                    ></div>
                  </div>
                  <b className={`num ${v >= 0 ? 'up' : 'down'}`}>
                    {v >= 0 ? '+' : '−'}
                    {Math.abs(v).toFixed(0)}
                  </b>
                </div>
              ))}
            </div>
            <div className="dsec">Pool data</div>
            <div className="rows">
              <div>
                <span>TVL</span>
                <b className="num">{usd(x.tvl)}</b>
              </div>
              <div>
                <span>Volume 24h</span>
                <b className="num">{usd(x.volume24h)}</b>
              </div>
              <div>
                <span>Volume / TVL</span>
                <b className="num">{fmt(x.volTvl, 2)}x</b>
              </div>
              <div>
                <span>Base fee</span>
                <b className="num">{x.baseFee}%</b>
              </div>
              <div>
                <span>Daily volatility</span>
                <b className="num">{x.volatility}%</b>
              </div>
              <div>
                <span>Market cap (fully diluted)</span>
                <b className="num">{x.fdvM > 0 ? fmtM(x.fdvM) : '—'}</b>
              </div>
              <div>
                <span>Market cap (circulating)</span>
                <b className="num">{x.mcapM > 0 && x.mcapM < 1e6 ? fmtM(x.mcapM) : '—'}</b>
              </div>
            </div>
            <div className="dsec">Contract addresses</div>
            <div className="rows">
              {[
                [x.tokenA.symbol, x.tokenA.mint],
                [x.tokenB.symbol, x.tokenB.mint],
                ['Pool', x.id],
              ]
                .filter((r): r is [string, string] => !!r[1])
                .map(([label, ca]) => (
                  <div key={label + ca}>
                    <span>{label}</span>
                    <button
                      className="num"
                      title={`Copy ${ca}`}
                      onClick={() => copy(`${label} address`, ca)}
                      style={{ background: 'none', border: 0, color: 'var(--text)', cursor: 'pointer', font: 'inherit', fontWeight: 600, display: 'inline-flex', gap: 6, alignItems: 'center' }}
                    >
                      {ca.slice(0, 4)}…{ca.slice(-4)}
                      <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>Copy</span>
                    </button>
                  </div>
                ))}
            </div>
            {canAdd && x.id === drawerPoolId && (
              <ErrorBoundary area="Add LP">
                <AddLp pool={x} active={on} />
              </ErrorBoundary>
            )}
          </>
        )}
      </ErrorBoundary>
    </aside>
  );
}
