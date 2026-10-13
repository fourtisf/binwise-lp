import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MeteoraClient } from '@kovra/chain';
import { DEFAULT_PARAMS, optimizeParams, type RiskProfile } from '@kovra/core';
import { DEFAULT_BACKTEST, loadBacktestData } from './backtest';
import { renderOptimizeReport, searchable } from './optimize';

/**
 * pnpm --filter @kovra/agent optimize [--days 60] [--pools 15] [--profile balanced] [--candidates 60] [--apply]
 * Searches agent settings on past data (walk-forward: tune on the first part, judge on the rest).
 * Writes reports/optimize-YYYY-MM-DD.md. With DATABASE_URL, stores the result; `--apply` makes the new
 * settings active only if they beat the current ones on unseen data.
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const apply = process.argv.includes('--apply');
const meteora = new MeteoraClient();
const sol = (await meteora.topPools(50)).find((p) => p.token_x.symbol === 'SOL');
const opts = {
  ...DEFAULT_BACKTEST,
  days: Number(arg('days') ?? 60),
  pools: Number(arg('pools') ?? DEFAULT_BACKTEST.pools),
  profile: (arg('profile') ?? DEFAULT_BACKTEST.profile) as RiskProfile,
  costs: { ...DEFAULT_BACKTEST.costs, solUsd: sol?.token_x.price ?? DEFAULT_BACKTEST.costs.solUsd },
  log: console.log,
};
const candidates = Number(arg('candidates') ?? 60);

const db = process.env.DATABASE_URL ? (await import('@kovra/db')).getDb() : null;
const base = db ? await (await import('@kovra/db')).activeParams(db) : DEFAULT_PARAMS;

const data = await loadBacktestData(meteora, opts);
console.log(`Searching ${candidates} setting combinations over ${data.pools.length} pools…`);
const result = optimizeParams({ pools: data.pools, strategy: data.strategy, base, candidates, costs: opts.costs });
const applied = apply && result.recommend && !!db;
const report = renderOptimizeReport(result, { days: opts.days, profile: opts.profile, candidates, applied });

const dir = resolve(process.cwd(), '../../reports');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `optimize-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(file, report);
console.log(`\nReport written to ${file}`);

if (db) {
  const metrics = {
    baseline: { train: result.baseline.train, test: result.baseline.test, testNetVsHoldPct: result.baseline.testNetVsHoldPct },
    best: { train: result.best.train, test: result.best.test, testNetVsHoldPct: result.best.testNetVsHoldPct },
    recommend: result.recommend,
    pools: result.pools,
    days: opts.days,
  };
  await db.$transaction(async (tx) => {
    if (applied) await tx.paramSet.updateMany({ where: { active: true }, data: { active: false } });
    await tx.paramSet.create({ data: { params: searchable(result.best.params), source: 'optimizer', active: applied, metrics } });
    // Shown to the owner at ⌘K → Backtest report.
    await tx.backtestRun.create({
      data: { params: { kind: 'optimize', days: opts.days, pools: opts.pools, profile: opts.profile, candidates } as object, results: [], summary: metrics, report },
    });
  });
  await db.$disconnect();
  console.log(applied ? 'New settings are now active.' : result.recommend ? 'Saved. Re-run with --apply to activate.' : 'Saved. Current settings stay active.');
}
