'use client';

import { useEffect } from 'react';
import { PositionChart } from '@/components/PositionChart';
import { PairIcon } from '@/components/Tokens';
import { pct, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';
import { useUi } from '@/lib/ui';

const SHAPE = { spot: 'Spot', curve: 'Curve', bidask: 'Bid-ask' } as const;

export default function PositionsPage() {
  const { overview, positions, claim, close } = useAppData();
  const { scrollTarget } = useUi();

  // Arriving from a sidebar position: bring that card into view.
  useEffect(() => {
    const id = scrollTarget.current;
    if (!id || !positions.length) return;
    scrollTarget.current = null;
    setTimeout(() => document.getElementById('pc-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  }, [positions.length, scrollTarget]);

  return (
    <div className="page on" id="p-positions">
      <div className="poslist" id="posGrid">
        {positions.map((x) => (
          <div className="posr card spot" id={'pc-' + x.id} key={x.id}>
            <div className="posr-id">
              <span className="pairname">
                <PairIcon a={x.tokenA} b={x.tokenB} />
                {x.pair}
              </span>
              <span className="posr-meta">
                Meteora DLMM · {SHAPE[x.shape]}
                <span className={`pill ${x.inRange ? 'in' : 'out'}`}>
                  <span className="d"></span>
                  {x.inRange ? 'In range' : 'Out of range'}
                </span>
              </span>
              <div className="posr-net">
                <b className={`num ${x.netVsHold >= 0 ? 'up' : 'down'}`}>{pct(x.netVsHold, 1)}</b>
                <span>
                  Net vs hold<small className="rowhint">vs just holding the tokens, fees included</small>
                </span>
              </div>
            </div>
            <PositionChart className="posr-chart" positionId={x.id} bins={21} shape={x.shape} />
            <div className="posr-side">
              <div className="rows">
                <div>
                  <span>Value</span>
                  <b className="num">{usd(x.value)}</b>
                </div>
                <div>
                  <span>Fees earned</span>
                  <b className="num up">{usd(x.fees, 2)}</b>
                </div>
                <div>
                  <span>
                    Impermanent loss<small className="rowhint">vs just holding the tokens, before fees</small>
                  </span>
                  <b className={`num ${x.il >= 0 ? 'up' : 'down'}`}>{pct(x.il, 1)}</b>
                </div>
              </div>
              <div className="acts">
                <button className="btn btn-dark btn-sm" onClick={() => claim(x)}>
                  Claim fees
                </button>
                <button className="btn btn-dark btn-sm" onClick={() => close(x)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {overview && !positions.length && (
        <p className="muted" style={{ padding: '20px 0' }}>
          No open positions yet. The agent deploys when a pool clears your filters.
        </p>
      )}
    </div>
  );
}
