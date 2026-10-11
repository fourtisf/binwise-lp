'use client';

import { useEffect, useState } from 'react';
import type { PoolDetail, VaultBalance } from '@binwise/core';
import { fmt, fmtM, usd } from '@/lib/format';
import { BOT_URL } from '@/lib/site';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';
import { Icon } from '../Sprite';
import { PairIcon } from '../Tokens';

/** Why Add LP can't put more into this pool (VaultBalance.pool.limit), in plain words. */
const LIMIT_TEXT: Record<NonNullable<VaultBalance['pool']>['limit'], string> = {
  balance: 'Limited by the idle funds in your vault.',
  strategy: 'Limited by your strategy: its max share of the vault per pool, and never more than 2% of the pool.',
  cap: 'Limited by your max per position (Strategy).',
  live: 'Limited by the live trading limits for now.',
  positions: 'Live vaults can hold a limited number of positions for now. Close one in Positions first.',
  held: 'You already have a position in this pool.',
};

/** Token amounts: more decimals for small ones (0.0421 SOL, 12.50 USDC, 1,250 BONK). */
const amount = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 4 });

/** Slide-out with how the agent scored a pool. */
export function PoolDrawer() {
  const { layer, drawerPoolId, closeLayers, toast } = useUi();
  const copy = (label: string, value: string) =>
    navigator.clipboard
      .writeText(value)
      .then(() => toast(`${label} copied`))
      .catch(() => toast(value));
  const { client, pools, positions, overview, deploy } = useAppData();
  const [x, setX] = useState<PoolDetail | null>(null);
  const [amt, setAmt] = useState('');
  const [risk, setRisk] = useState(false);
  const [bal, setBal] = useState<VaultBalance | null>(null);
  const [balErr, setBalErr] = useState(false);
  const on = layer === 'drawer';
  const canAdd = client?.kind === 'http' && !!overview && !overview.readOnly;
  useEffect(() => {
    setAmt('');
    setRisk(false);
    setBal(null);
    setBalErr(false);
  }, [drawerPoolId]);

  // The vault's idle funds and the most Add LP puts into this pool: on open, every 20s, and when positions change.
  useEffect(() => {
    if (!on || !canAdd || !client || !drawerPoolId) return;
    let live = true;
    const load = () =>
      client
        .balance(drawerPoolId)
        .then((b) => {
          if (!live) return;
          setBal(b);
          setBalErr(false);
        })
        .catch(() => live && setBalErr(true));
    void load();
    const t = setInterval(load, 20_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [on, canAdd, client, drawerPoolId, positions.length]);

  const want = Number(amt) || 0;
  const lim = bal?.pool;
  /** Nothing can be added here now (empty vault, limits, or a position already open). */
  const blocked = !!lim && lim.maxUsd < lim.minUsd;
  const tooSmall = !!lim && !blocked && want > 0 && want < lim.minUsd;
  const over = !!lim && !blocked && want > lim.maxUsd;

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
          {canAdd && (
            <>
              <div className="dsec">Add LP by hand</div>
              {x.call !== 'in' && (
                <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 10 }}>
                  The agent won&apos;t enter this pool by itself ({x.callLabel}). If you add LP here, it rebalances and claims fees, but won&apos;t
                  close it on its trend rules: you close it yourself in Positions. The daily loss stop still applies.
                </p>
              )}
              <div className="rows">
                <div>
                  <span>Vault balance</span>
                  <b className="num" id="dBal">
                    {bal ? usd(bal.availableUsd, 2) : balErr ? '—' : 'Checking…'}
                  </b>
                </div>
                {lim && (
                  <div>
                    <span>Most you can add here</span>
                    <b className="num" id="dMax">
                      {usd(lim.maxUsd, 2)}
                    </b>
                  </div>
                )}
              </div>
              {bal && (
                <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
                  {bal.assets.length ? bal.assets.map((a) => `${amount(a.amount)} ${a.symbol}`).join(' · ') : 'No idle funds'}
                  {bal.reserveSol > 0 && ` · ${amount(bal.reserveSol)} SOL kept for network fees`}
                  {bal.source === 'agent' && overview?.mode === 'live' && ' · as of the agent’s last check'}
                  {lim && !blocked && (
                    <>
                      <br />
                      {LIMIT_TEXT[lim.limit]}
                    </>
                  )}
                </p>
              )}
              {balErr && !bal && (
                <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 8 }}>
                  Couldn&apos;t read the vault balance right now. The agent still checks it before adding.
                </p>
              )}
              {blocked && lim && bal && (
                <div className="verdict wt" id="dBlocked">
                  {lim.limit === 'held' || lim.limit === 'positions' ? (
                    LIMIT_TEXT[lim.limit]
                  ) : (
                    <>
                      {lim.limit === 'balance'
                        ? `Not enough in your vault: Add LP needs at least ${usd(lim.minUsd)} idle.`
                        : `You can add up to ${usd(lim.maxUsd, 2)} here now, below the ${usd(lim.minUsd)} minimum. ${LIMIT_TEXT[lim.limit]}`}{' '}
                      Deposit SOL or USDC to your vault in the{' '}
                      <a href={BOT_URL} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                        Telegram bot
                      </a>{' '}
                      (💳 Wallet).
                    </>
                  )}
                </div>
              )}
              <div style={{ position: 'relative' }}>
                <input
                  className="capin"
                  inputMode="decimal"
                  placeholder="Amount in USD (empty: the agent sizes it)"
                  aria-label="Amount in USD"
                  value={amt}
                  disabled={blocked}
                  style={{ paddingRight: lim && !blocked ? 64 : undefined }}
                  onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ''))}
                />
                {lim && !blocked && (
                  <button
                    className="btn btn-dark btn-sm"
                    style={{ position: 'absolute', right: 6, top: 16, height: 26, padding: '0 10px', fontSize: 12.5 }}
                    onClick={() => setAmt(String(Math.floor(lim.maxUsd * 100) / 100))}
                  >
                    Max
                  </button>
                )}
              </div>
              {tooSmall && lim && (
                <p className="down" style={{ fontSize: 12.5, marginTop: 8 }}>
                  At least {usd(lim.minUsd)}.
                </p>
              )}
              {over && lim && (
                <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                  The agent adds at most {usd(lim.maxUsd, 2)} here; it sizes your amount down.
                </p>
              )}
              {x.call !== 'in' && (
                <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12, fontSize: 12.5, lineHeight: 1.45, color: 'var(--muted)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} style={{ marginTop: 2, accentColor: '#4BE3CF' }} />
                  <span>I add this against the agent&apos;s call, at my own risk. No strategy is guaranteed to profit.</span>
                </label>
              )}
              <button
                className="btn btn-white"
                style={{ width: '100%', marginTop: 12 }}
                disabled={(x.call !== 'in' && !risk) || blocked || tooSmall}
                onClick={() => deploy(x.id, Math.min(want, lim?.maxUsd ?? want), x.call !== 'in')}
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
