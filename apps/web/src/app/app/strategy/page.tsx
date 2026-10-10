'use client';

import { STRATEGY_LIMITS, STRATEGY_PRESETS, type RiskProfile, type StrategySettings, type StrategyToggles } from '@binwise/core';
import { Switch } from '@/components/Switch';
import { fmt, fmtM, usd } from '@/lib/format';
import { useAppData } from '@/lib/store';

const PROFILES: { key: RiskProfile; name: string; text: string; risk: number; note: string }[] = [
  { key: 'conservative', name: 'Conservative', text: 'Stable and blue-chip pools, wide ranges, few rebalances.', risk: 1, note: 'Lower fees, smaller swings' },
  { key: 'balanced', name: 'Balanced', text: 'Large-cap Solana tokens paired with SOL, medium ranges.', risk: 3, note: 'The default for most vaults' },
  { key: 'aggressive', name: 'Aggressive', text: 'Adds high-volume mid-caps, tight ranges, frequent moves.', risk: 5, note: 'Highest fees, biggest drawdowns' },
];

const TOGGLES: { key: keyof StrategyToggles; title: string; text: string }[] = [
  { key: 'autoCompound', title: 'Auto-compound fees', text: 'Adds claimed fees back into the position.' },
  { key: 'rebalanceOnlyProfitable', title: 'Rebalance only when profitable', text: 'Skips moves that cost more than they earn.' },
  { key: 'holderSafety', title: 'Holder safety check', text: 'Skips bundled or dev-heavy tokens.' },
  { key: 'pauseOnVolSpikes', title: 'Pause on volatility spikes', text: 'Waits out moves above 3x normal.' },
  { key: 'telegramAlerts', title: 'Telegram alerts', text: 'Deploys, rebalances and exits in your chat.' },
];

type NumKey = keyof typeof STRATEGY_LIMITS;

const SLIDERS: { key: NumKey; id: string; label: string; text: string; step?: number; out: (v: number) => string }[] = [
  { key: 'maxAllocPct', id: 'rAlloc', label: 'Max per pool', text: 'Share of the vault one pool can hold.', out: (v) => v + '%' },
  { key: 'minMcapM', id: 'rMcap', label: 'Minimum market cap', text: 'Smaller tokens are never farmed.', step: 50, out: fmtM },
  { key: 'trendExitPct', id: 'rTrend', label: 'Exit when 7-day trend is below', text: 'Stops the agent from collecting a falling token.', out: (v) => '−' + Math.abs(v) + '%' },
  { key: 'dailyStopPct', id: 'rStop', label: 'Daily loss stop', text: 'Pauses the agent after this drop in one day.', out: (v) => v + '%' },
];

export default function StrategyPage() {
  const { draft, setDraft, saveStrategy, pools, overview } = useAppData();
  if (!draft) return <div className="page on" id="p-strategy" />;

  const S = draft;
  const set = (patch: Partial<StrategySettings>) => setDraft({ ...S, ...patch });
  const ok = (x: { mcapM: number; trend7d: number }) => x.mcapM >= S.minMcapM && x.trend7d > S.trendExitPct;
  const v = overview?.value ?? 0;

  return (
    <div className="page on" id="p-strategy">
      <div className="profiles">
        {PROFILES.map((p) => (
          <button
            className="prof card"
            key={p.key}
            aria-pressed={S.profile === p.key}
            onClick={() => {
              const { rebalancesPerDay: _r, ...preset } = STRATEGY_PRESETS[p.key];
              set({ profile: p.key, ...preset });
            }}
          >
            <span className="rd"></span>
            <b>{p.name}</b>
            <p>{p.text}</p>
            <div className="risk">
              {[1, 2, 3, 4, 5].map((i) => (
                <i key={i} className={i <= p.risk ? 'on' : undefined}></i>
              ))}
            </div>
            <small>{p.note}</small>
          </button>
        ))}
      </div>
      <div className="g3">
        <div className="panel card">
          <div className="ph">
            <h3>Limits</h3>
          </div>
          {SLIDERS.map((s) => {
            const [min, max] = STRATEGY_LIMITS[s.key];
            const val = S[s.key];
            return (
              <div className="field" key={s.key}>
                <div className="ft">
                  <label htmlFor={s.id}>{s.label}</label>
                  <output>{s.out(val)}</output>
                </div>
                <p>{s.text}</p>
                <input
                  type="range"
                  id={s.id}
                  min={min}
                  max={max}
                  step={s.step}
                  value={val}
                  style={{ ['--f' as string]: ((val - min) / (max - min)) * 100 + '%' }}
                  onChange={(e) => set({ [s.key]: +e.target.value })}
                />
              </div>
            );
          })}
        </div>
        <div className="panel card">
          <div className="ph">
            <h3>Behavior</h3>
          </div>
          {TOGGLES.map((t) => (
            <div className="tg" key={t.key}>
              <div>
                <b>{t.title}</b>
                <p>{t.text}</p>
              </div>
              <Switch label={t.title} checked={S.toggles[t.key]} onChange={(on) => set({ toggles: { ...S.toggles, [t.key]: on } })} />
            </div>
          ))}
        </div>
        <div className="panel card preview">
          <div className="ph">
            <div>
              <h3>What changes</h3>
              <p>Updates as you adjust</p>
            </div>
          </div>
          <div className="pv">
            <div>
              <span>Eligible pools</span>
              <b className="num">
                {pools.filter(ok).length} of {pools.length}
              </b>
            </div>
            <div>
              <span>Est. rebalances per day</span>
              <b className="num">{fmt(STRATEGY_PRESETS[S.profile].rebalancesPerDay * (1 + (S.maxAllocPct - 25) / 80), 1)}</b>
            </div>
            <div>
              <span>Max in one pool</span>
              <b className="num">{usd((v * S.maxAllocPct) / 100)}</b>
            </div>
            <div>
              <span>Auto-pause below</span>
              <b className="num">{usd(v * (1 - S.dailyStopPct / 100))}</b>
            </div>
          </div>
          <div className="pvpools">
            {pools.map((x) => (
              <span key={x.id} className={ok(x) ? 'ok' : 'no'}>
                {x.pair}
              </span>
            ))}
          </div>
          <button className="btn btn-white" id="saveStrat" style={{ width: '100%', marginTop: 18 }} onClick={saveStrategy}>
            Save strategy
          </button>
        </div>
      </div>
    </div>
  );
}
