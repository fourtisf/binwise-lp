import { BRAND, PARAM_SPACE, type AgentParams, type OptimizeResult } from '@binwise/core';

/** Settings the optimiser can change, with plain-language names for the report. */
const LABELS: Record<keyof typeof PARAM_SPACE, string> = {
  deployScore: 'Deploy at score',
  exitScore: 'Exit below score',
  rangeMult: 'Range width ×',
  rebalanceFeeMultiple: 'Rebalance when 6h fees > costs ×',
  rebalanceCooldownMin: 'Rebalance cooldown (min)',
  rebalanceMode: 'Rebalance mode',
  useRegime: 'Follow market regime',
  regimeEr: 'Trend strength threshold',
  netVsHoldExitPct: 'Exit when net vs hold below (%)',
  reentryCooldownHours: 'Wait before re-entering (h)',
  emaExitMode: 'EMA exit',
};

const pct = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

export function renderOptimizeReport(r: OptimizeResult, o: { days: number; profile: string; candidates: number; applied: boolean; now?: number }): string {
  const date = new Date(o.now ?? Date.now()).toISOString().slice(0, 10);
  const keys = Object.keys(PARAM_SPACE) as (keyof typeof PARAM_SPACE)[];
  const changed = keys.filter((k) => r.best.params[k] !== r.baseline.params[k]);
  const rows = keys
    .map((k) => `| ${LABELS[k]} | ${show(r.baseline.params[k])} | ${changed.includes(k) ? `**${show(r.best.params[k])}**` : show(r.best.params[k])} |`)
    .join('\n');
  const verdict = r.recommend
    ? o.applied
      ? 'The new settings did better on data they never saw, so **they are now active**. The agent uses them from its next cycle.'
      : 'The new settings did better on data they never saw. They are saved but **not active**. Run the optimiser again with `--apply` to switch.'
    : 'The new settings did **not** clearly beat the current ones on unseen data, so nothing changes. That is the safe outcome: the search found no reliable improvement.';
  return `# ${BRAND} settings search — ${date}

**Question:** can different agent settings beat the current ones, on data they were not tuned on?

## Result

${verdict}

| | Current settings | Best found |
|---|---|---|
| Score on tuning data | ${r.baseline.train.toFixed(2)} | ${r.best.train.toFixed(2)} |
| **Score on unseen data** | **${r.baseline.test.toFixed(2)}** | **${r.best.test.toFixed(2)}** |
| Net vs hold on unseen data (average per pool) | ${pct(r.baseline.testNetVsHoldPct)} | ${pct(r.best.testNetVsHoldPct)} |
| Pools that beat holding (unseen data) | ${r.baseline.testBeatHold} of ${r.pools} | ${r.best.testBeatHold} of ${r.pools} |

Score = average net vs hold minus a quarter of the average worst drop, so risky settings rank lower.

## Settings

| Setting | Current | Best found |
|---|---|---|
${rows}

## How this was tested

- ${r.pools} pools, ${o.days} days of hourly Meteora data, ${o.profile} profile. ${o.candidates} random setting combinations plus the current one.
- Each pool's history is split: the first ${r.trainDays.toFixed(0)} days pick the best settings, the last ${r.testDays.toFixed(0)} days check them. Only the check counts.
- New settings are only recommended when they beat the current ones on the check by more than 0.25 points.
- Same rules, costs and fee model as the backtest report.

No strategy is guaranteed to profit. Past results don't guarantee future returns.
`;
}

/** Only the searchable keys, for storing in ParamSet. */
export const searchable = (p: AgentParams) => Object.fromEntries((Object.keys(PARAM_SPACE) as (keyof AgentParams)[]).map((k) => [k, p[k]]));
