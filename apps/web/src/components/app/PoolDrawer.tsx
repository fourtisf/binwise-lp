'use client';

import { useEffect, useState } from 'react';
import type { PoolDetail } from '@binwise/core';
import { fmt, fmtM, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { PairIcon } from '../Tokens';

/** Slide-out with how the agent scored a pool. */
export function PoolDrawer() {
  const { layer, drawerPoolId, closeLayers } = useUi();
  const { client, pools, overview, deploy } = useAppData();
  const [x, setX] = useState<PoolDetail | null>(null);
  const [amt, setAmt] = useState('');
  const [risk, setRisk] = useState(false);
  useEffect(() => {
    setAmt('');
    setRisk(false);
  }, [drawerPoolId]);

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

  const on = layer === 'drawer';
  return (
    <aside className={`drawer${on ? ' on' : ''}`} id="drawer" aria-label="Pool details" aria-hidden={!on}>
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
              <span>Token market cap</span>
              <b className="num">{fmtM(x.mcapM)}</b>
            </div>
          </div>
          {client?.kind === 'http' && overview && !overview.readOnly && (
            <>
              <div className="dsec">Add LP by hand</div>
              {x.call !== 'in' && (
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
                  The agent won&apos;t enter this pool by itself ({x.callLabel}). If you add LP here, it rebalances and claims fees, but won&apos;t
                  close it on its trend rules: you close it yourself in Positions. The daily loss stop still applies.
                </p>
              )}
              <input
                className="capin"
                inputMode="decimal"
                placeholder="Amount in USD (empty: the agent sizes it)"
                aria-label="Amount in USD"
                value={amt}
                onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))}
              />
              {x.call !== 'in' && (
                <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, fontSize: 12.5, lineHeight: 1.45, color: 'var(--muted)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} style={{ marginTop: 2, accentColor: '#4BE3CF' }} />
                  <span>I add this against the agent&apos;s call, at my own risk. No strategy is guaranteed to profit.</span>
                </label>
              )}
              <button
                className="btn btn-white"
                style={{ width: '100%', marginTop: 12 }}
                disabled={x.call !== 'in' && !risk}
                onClick={() => deploy(x.id, Number(amt) || 0, x.call !== 'in')}
              >
                <Icon id="i-plus" />
                Add LP to {x.pair}
              </button>
            </>
          )}
        </>
      )}
    </aside>
  );
}
