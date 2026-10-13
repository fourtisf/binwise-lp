'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BRAND } from '@kovra/core/brand';
import type { PerformanceRange, PerformanceSeries } from '@kovra/core';
import { FeedItem } from '@/components/FeedItem';
import { CustodyNotice } from '@/components/app/CustodyNotice';
import { PositionChart } from '@/components/PositionChart';
import { Icon } from '@/components/Sprite';
import { PairIcon } from '@/components/Tokens';
import { dayLabel, lineChart, sparkPath, stepDecimals } from '@/lib/charts/lineChart';
import { fmt, hhmm, pct, usd } from '@/lib/format';
import { useUi } from '@/lib/ui';
import { BOT_URL, LIVE_DEFAULT, WALLET_LOGIN } from '@/lib/site';
import { useAppData } from '@/lib/store';

const SHAPE_LABEL = { spot: 'spot', curve: 'curve', bidask: 'bid-ask' } as const;

/** Dollar axis labels that fit the vault's size: $0, $25, $2.5, $1.2K, $12K. */
const axisUsd = (v: number, step: number) =>
  Math.abs(v) >= 1000 || step >= 1000 ? `$${fmt(v / 1000, stepDecimals(step / 1000))}K` : `$${fmt(v, stepDecimals(step))}`;
const chartNote = (text: string) =>
  `<p class="muted" style="height:100%;display:flex;align-items:center;justify-content:center;text-align:center;padding:0 20px;font-size:14px;line-height:1.5">${text}</p>`;
const PROPOSAL_ICON = { deploy: 'i-plus', rebalance: 'i-swap', exit: 'i-exit', compound: 'i-comp' } as const;

export default function OverviewPage() {
  const { overview: o, positions, decisions, proposals, approve, reject, cycle, decisionText, client, empty, selfCustody } = useAppData();
  const { openConnect } = useUi();
  const [range, setRange] = useState<PerformanceRange>(30);
  const [perf, setPerf] = useState<PerformanceSeries | null>(null);
  const eq = useRef<HTMLDivElement>(null);
  const today = o ? (o.value / o.openValue - 1) * 100 : 0;
  const inRange = positions.filter((p) => p.inRange).length;
  const main = positions[0];

  useEffect(() => {
    let live = true;
    if (!o?.id) return;
    client
      ?.performance(range)
      .then((p) => live && setPerf(p))
      .catch(() => live && setPerf(null));
    return () => {
      live = false;
    };
  }, [client, range, o?.id]);

  useEffect(() => {
    if (!perf || !eq.current) return;
    if (perf.ts.length < 2) {
      eq.current.innerHTML = chartNote('Not enough history yet. The chart fills in as the agent runs.');
      return;
    }
    // Nothing deposited yet: a flat line at $0 says nothing.
    if (perf.vault.every((v) => v === 0) && perf.hold.every((v) => v === 0)) {
      eq.current.innerHTML = chartNote(
        selfCustody
          ? 'No positions yet. The chart starts with your first LP:<br>open a pool in Pools and add LP from your own wallet.'
          : 'No funds in the vault yet. The chart starts with your first deposit:<br>send SOL or USDC to your vault from the Telegram bot (💳 Wallet).',
      );
      return;
    }
    // Young vaults have hourly points; label those with the time.
    const hourly = perf.ts.at(-1)! - perf.ts[0] < 2 * 86_400_000;
    const draw = () =>
      eq.current &&
      lineChart(eq.current, {
        labels: perf.ts.map((t) => (hourly ? hhmm(t) : dayLabel(t))),
        series: [
          { name: `${BRAND} vault`, color: 'var(--c-vault)', values: perf.vault, area: true, w: 2.2 },
          { name: 'Hold', color: 'var(--c-hold)', values: perf.hold, dash: '4 4' },
        ],
        fmtY: axisUsd,
        fmtTip: (v) => usd(v, 2),
      });
    draw();
    let rt: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(draw, 150);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [perf, selfCustody]);

  const step = cycle?.paused ? -1 : (cycle?.step ?? -1);

  if (empty)
    return (
      <div className="page on" id="p-overview">
        <div className="panel card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <h3 style={{ fontSize: 19 }}>{WALLET_LOGIN ? 'Connect a wallet to start' : 'Start in Telegram'}</h3>
          <p className="muted" style={{ margin: '8px auto 20px', maxWidth: '44ch' }}>
            {!WALLET_LOGIN
              ? `Create or import a wallet in the ${BRAND} bot, deposit SOL and add LP. The agent runs on Solana mainnet with real funds: start small. This page shows the pools and every decision.`
              : LIVE_DEFAULT
              ? 'Your vault runs on Solana mainnet with real funds. Start small and watch every decision.'
              : 'You get a paper vault with simulated funds. Watch every decision before risking anything.'}
          </p>
          {WALLET_LOGIN ? (
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-white" onClick={openConnect}>
                Connect wallet
              </button>
              {BOT_URL && (
                <a className="btn btn-dark" href={BOT_URL} target="_blank" rel="noreferrer">
                  Or use the Telegram bot
                </a>
              )}
            </div>
          ) : (
            BOT_URL && (
              <a className="btn btn-white" href={BOT_URL} target="_blank" rel="noreferrer">
                Open Telegram bot
              </a>
            )
          )}
        </div>
      </div>
    );

  return (
    <div className="page on" id="p-overview">
      <CustodyNotice />
      {proposals.length > 0 && (
        <div className="panel card" id="approvals" style={{ marginBottom: 12 }}>
          <div className="ph">
            <div>
              <h3>Waiting for your approval</h3>
              <p>
                {selfCustody
                  ? 'The agent found these changes to your positions. Approve one and your wallet asks you to sign it; nothing moves without that.'
                  : 'Manual mode: the agent found these trades. Nothing runs until you approve.'}
              </p>
            </div>
          </div>
          <div className="feed" style={{ maxHeight: 'none' }}>
            {proposals.map((p) => (
              <div className="fi" key={p.id}>
                <span className={`fic ${p.kind}`}>
                  <Icon id={PROPOSAL_ICON[p.kind]} />
                </span>
                <div>
                  <b>{p.title}</b>
                  <span>{p.reason}</span>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button className="btn btn-white btn-sm" onClick={() => approve(p)}>
                      {selfCustody ? 'Approve in wallet' : 'Approve'}
                    </button>
                    <button className="btn btn-dark btn-sm" onClick={() => reject(p)}>
                      Reject
                    </button>
                  </div>
                </div>
                <time>{Math.max(0, Math.round((p.expiresAt - Date.now()) / 60_000))}m left</time>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="kpis">
        <div className="kpi card">
          <small>Vault value</small>
          <div className="v num">{o ? usd(o.value, 2) : '—'}</div>
          <div className="s">
            <b className={`num ${today >= 0 ? 'up' : 'down'}`}>{pct(today)}</b> today
          </div>
          <svg className="spark" viewBox="0 0 84 32" preserveAspectRatio="none">
            {o && <path d={sparkPath(o.spark, 84, 32)} fill="none" style={{ stroke: 'var(--up)' }} strokeWidth="1.5" strokeLinecap="round" />}
          </svg>
        </div>
        <div className="kpi card">
          <small>Fees earned, 30d</small>
          <div className="v num">{o ? usd(o.fees30d) : '—'}</div>
          <div className="s">Auto-compounded</div>
        </div>
        <div className="kpi card">
          <small>Net vs hold, 30d</small>
          <div className={`v num ${!o || o.netVsHold30d >= 0 ? 'up' : 'down'}`}>{o ? pct(o.netVsHold30d, 1) : '—'}</div>
          <div className="s">After impermanent loss</div>
        </div>
        <div className="kpi card">
          <small>Positions in range</small>
          <div className="v num">
            {inRange} / {positions.length}
          </div>
          <div className="s">
            <b className="num">{o && o.timeInRange30d != null ? `${Math.round(o.timeInRange30d)}%` : '—'}</b> time in range, 30d
          </div>
        </div>
      </div>

      <div className="g2">
        <div className="panel card">
          <div className="ph">
            <div>
              <h3>Vault performance</h3>
              <p>{BRAND} compared with holding the same tokens</p>
            </div>
            <div className="seg" id="eqSeg">
              {([7, 30, 90] as const).map((r) => (
                <button key={r} aria-pressed={r === range} onClick={() => setRange(r)}>
                  {r}D
                </button>
              ))}
            </div>
          </div>
          <div className="keys">
            <span>
              <i style={{ background: 'var(--c-vault)' }}></i>{BRAND} vault
            </span>
            <span>
              <i style={{ background: 'var(--c-hold)' }}></i>Hold
            </span>
          </div>
          <div className="eq" id="eqChart" ref={eq}></div>
        </div>
        <div className="panel card">
          <div className="ph">
            <div>
              <h3>Agent reasoning</h3>
              <p>Current cycle, step by step</p>
            </div>
          </div>
          <div className="brain" id="brain">
            {(cycle?.steps ?? []).map((b, i) => {
              const st = i < step ? 'done' : i === step ? 'run' : 'wait';
              return (
                <div className={`bstep ${st}`} key={b.title}>
                  <span className="bico">
                    <Icon id={st === 'done' ? 'i-check' : st === 'run' ? 'i-spin' : 'i-dot'} />
                  </span>
                  <div>
                    <b>{b.title}</b>
                    <span>{st === 'done' ? b.done || b.running : b.running}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="decision" id="decision">
            <small>Decision</small>
            <span>{decisionText}</span>
          </div>
        </div>
      </div>

      <div className="g2">
        <div className="panel card">
          {main ? (
            <>
              <div className="ph">
                <div className="pairname">
                  <PairIcon a={main.tokenA} b={main.tokenB} />
                  {main.pair}
                  <span className="dim" style={{ fontWeight: 400, fontSize: 13 }}>
                    Meteora DLMM, {SHAPE_LABEL[main.shape]}
                  </span>
                </div>
                <span className={`pill live ${main.inRange ? 'in' : 'out'}`} id="aStatus">
                  <span className="d"></span>
                  {main.inRange ? 'In range' : 'Out of range'}
                </span>
              </div>
              <PositionChart className="lp" id="appChart" positionId={main.id} bins={21} shape={main.shape} />
              <div className="lpfoot">
                <div>
                  <small>Position</small>
                  <b className="num">{usd(main.value)}</b>
                </div>
                <div>
                  <small>Fees earned</small>
                  <b className="num up">{usd(main.fees, 2)}</b>
                </div>
                <div>
                  <small>Net vs hold</small>
                  <b className={`num ${main.netVsHold >= 0 ? 'up' : 'down'}`}>{pct(main.netVsHold)}</b>
                </div>
                <div>
                  <small>Rebalances</small>
                  <b className="num">{main.rebalances}</b>
                </div>
              </div>
            </>
          ) : (
            <div className="ph">
              <div>
                <h3>No open positions</h3>
                <p>The agent deploys on the next cycle when a pool clears your filters.</p>
              </div>
            </div>
          )}
        </div>
        <div className="panel card">
          <div className="ph">
            <div>
              <h3>Activity</h3>
              <p>Every action, with the reason</p>
            </div>
            <Link className="btn btn-dark btn-sm" href="/app/activity">
              View all
            </Link>
          </div>
          <div className="feed" id="feedMini">
            {decisions.slice(0, 7).map((d) => (
              <FeedItem d={d} key={d.id} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
