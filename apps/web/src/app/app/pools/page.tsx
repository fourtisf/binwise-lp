'use client';

import { useState } from 'react';
import type { AgentCall } from '@binwise/core';
import { Chips } from '@/components/Chips';
import { Icon } from '@/components/Sprite';
import { PairIcon } from '@/components/Tokens';
import { sparkPath } from '@/lib/charts/lineChart';
import { fmt, pct, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';

export default function PoolsPage() {
  const { pools, ready } = useAppData();
  const { openPool } = useUi();
  const [filter, setFilter] = useState<'all' | AgentCall>('all');
  const [q, setQ] = useState('');
  const cnt = (k: AgentCall) => pools.filter((r) => r.call === k).length;
  const rows = pools
    .filter((r) => (filter === 'all' || r.call === filter) && r.pair.toLowerCase().includes(q))
    .sort((a, b) => b.score - a.score);

  return (
    <div className="page on" id="p-pools">
      <div className="toolbar">
        <Chips
          id="poolChips"
          items={[
            ['all', 'All', pools.length],
            ['in', 'Deploy', cnt('in')],
            ['watch', 'Watch', cnt('watch')],
            ['out', 'Avoid', cnt('out')],
          ]}
          current={filter}
          onPick={(k) => setFilter(k as typeof filter)}
        />
        <label className="search">
          <Icon id="i-search" />
          <input
            id="poolSearch"
            placeholder="Filter by token"
            aria-label="Filter pools"
            onChange={(e) => setQ(e.target.value.toLowerCase().trim())}
          />
        </label>
      </div>
      <div className="card" style={{ padding: 4 }}>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Pool</th>
                <th className="r">TVL</th>
                <th className="r">Volume 24h</th>
                <th className="r">Vol / TVL</th>
                <th className="r">Fee APR</th>
                <th>7-day trend</th>
                <th>Score</th>
                <th>Agent call</th>
              </tr>
            </thead>
            <tbody id="poolRows">
              {rows.length ? (
                rows.map((x) => {
                  const col = x.score >= 62 ? 'var(--aqua)' : x.score >= 40 ? '#A9ABFF' : 'var(--red)';
                  return (
                    <tr key={x.id} onClick={() => openPool(x.id)}>
                      <td>
                        <span className="pairname">
                          <PairIcon a={x.tokenA} b={x.tokenB} />
                          {x.pair}
                        </span>
                      </td>
                      <td className="r num">{usd(x.tvl / 1e6, 1)}M</td>
                      <td className="r num">{usd(x.volume24h / 1e6, 1)}M</td>
                      <td className="r num">{fmt(x.volTvl, 2)}x</td>
                      <td className="r num">{fmt(x.feeApr)}%</td>
                      <td>
                        <span className="sp">
                          <svg width="64" height="22" viewBox="0 0 64 22">
                            <path
                              d={sparkPath(x.spark, 64, 22)}
                              fill="none"
                              stroke={x.trend7d >= 0 ? '#4BE3CF' : '#FF6B81'}
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span className={`num ${x.trend7d >= 0 ? 'up' : 'down'}`}>{pct(x.trend7d, 1)}</span>
                        </span>
                      </td>
                      <td>
                        <span className="scr">
                          <span className="sring" style={{ ['--p' as string]: x.score, ['--c' as string]: col }}></span>
                          <span className="num">{x.score}</span>
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${x.call}`}>
                          <span className="d"></span>
                          {x.callLabel}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={8} className="muted" style={{ padding: '28px 16px', cursor: 'default' }}>
                    {pools.length ? 'No pools match. Clear the filter or pick another tab.' : ready ? 'No pool data yet. The agent refreshes pools every minute.' : 'Loading pools…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="dim" style={{ fontSize: 13, marginTop: 12 }}>
        Select a pool to see how the agent scored it.
      </p>
    </div>
  );
}
