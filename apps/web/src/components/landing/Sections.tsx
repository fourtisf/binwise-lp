import { BRAND } from '@binwise/core/brand';
import { Switch } from '../Switch';
import { BentoChart, BentoFeed, TgChat, VsChart } from './Bento';

/** Product bento grid. Interactive pieces are client islands. */
export function Bento() {
  return (
    <div className="bento">
      <div className="b card spot s4">
        <h3>Reasons, not a black box</h3>
        <p>Each deploy, rebalance and exit is logged in plain language with the numbers behind it.</p>
        <div className="vis">
          <BentoFeed />
        </div>
      </div>
      <div className="b card spot s2">
        <h3>Stays in range</h3>
        <p>Follows price only when the fees pay for the move.</p>
        <div className="vis">
          <BentoChart />
        </div>
      </div>
      <div className="b card spot s2">
        <h3>Scores every pool</h3>
        <p>Fees per dollar, volatility and trend, weighed every minute.</p>
        <div className="vis">
          <div className="ringbig">
            <b className="num">82</b>
          </div>
          <div className="mbars">
            <div>
              <span>Volume / TVL</span>
              <i style={{ ['--w' as string]: '85%' }}></i>
              <b className="up">+34</b>
            </div>
            <div>
              <span>Trend</span>
              <i style={{ ['--w' as string]: '40%' }}></i>
              <b className="up">+7</b>
            </div>
            <div>
              <span>Volatility</span>
              <i style={{ ['--w' as string]: '30%', ['--c' as string]: 'var(--down)' }}></i>
              <b className="down">−10</b>
            </div>
          </div>
        </div>
      </div>
      <div className="b card spot s2">
        <h3>Guardrails that always win</h3>
        <p>Set your limits once. The agent is clever inside them, never outside.</p>
        <div className="vis glist">
          <div>
            <span>Max 25% per pool</span>
            <Switch label="Pool cap" defaultChecked />
          </div>
          <div>
            <span>Exit on −12% trend</span>
            <Switch label="Downtrend exit" defaultChecked />
          </div>
          <div>
            <span>Holder safety check</span>
            <Switch label="Holder check" defaultChecked />
          </div>
          <div>
            <span>4% daily loss stop</span>
            <Switch label="Loss stop" defaultChecked />
          </div>
        </div>
      </div>
      <div className="b card spot s2 last">
        <h3>Alerts where you are</h3>
        <p>Every action lands in Telegram the moment it happens.</p>
        <TgChat />
      </div>
      <div className="b card spot s6">
        <div className="vsrow">
          <div className="vsnums">
            <h3 style={{ fontSize: 26, letterSpacing: '-.04em' }}>Measured against holding, not APR.</h3>
            <p style={{ marginBottom: 24 }}>
              A pool can show 400% APR and still lose you money. {BRAND} reports one honest number: how you did versus just
              holding.
            </p>
            <div>
              <span className="muted">{BRAND}</span>
              <b className="up num">+6.8%</b>
            </div>
            <div>
              <span className="muted">Unmanaged LP</span>
              <b className="num">+1.2%</b>
            </div>
            <div>
              <span className="muted">Hold</span>
              <b className="num muted">0.0%</b>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="keys">
              <span>
                <i style={{ background: 'var(--c-vault)' }}></i>{BRAND}
              </span>
              <span>
                <i style={{ background: 'var(--c-lp)' }}></i>Unmanaged LP
              </span>
              <span>
                <i style={{ background: 'var(--c-hold)' }}></i>Hold
              </span>
            </div>
            <VsChart />
          </div>
        </div>
      </div>
    </div>
  );
}
