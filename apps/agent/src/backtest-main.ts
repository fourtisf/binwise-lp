import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MeteoraClient } from '@binwise/chain';
import type { RiskProfile } from '@binwise/core';
import { DEFAULT_BACKTEST, runPoolBacktests } from './backtest';

/**
 * pnpm --filter @binwise/agent backtest [--days 38] [--pools 15] [--profile balanced]
 * Writes reports/backtest-YYYY-MM-DD.md and stores the run in the database (if DATABASE_URL is set).
 */
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const meteora = new MeteoraClient();
const sol = (await meteora.topPools(50)).find((p) => p.token_x.symbol === 'SOL');
const opts = {
  ...DEFAULT_BACKTEST,
  days: Number(arg('days') ?? DEFAULT_BACKTEST.days),
  pools: Number(arg('pools') ?? DEFAULT_BACKTEST.pools),
  profile: (arg('profile') ?? DEFAULT_BACKTEST.profile) as RiskProfile,
  costs: { ...DEFAULT_BACKTEST.costs, solUsd: sol?.token_x.price ?? DEFAULT_BACKTEST.costs.solUsd },
  log: console.log,
};
const run = await runPoolBacktests(meteora, opts);
const dir = resolve(process.cwd(), '../../reports');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `backtest-${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(file, run.report);
console.log(`\nReport written to ${file}`);

if (process.env.DATABASE_URL) {
  const { getDb } = await import('@binwise/db');
  const db = getDb();
  await db.backtestRun.create({
    data: {
      params: { days: opts.days, pools: opts.pools, profile: opts.profile, costs: opts.costs } as object,
      results: run.results.map((r) => ({ pool: r.pool, stats: r.stats })) as object,
      summary: run.summary,
      report: run.report,
    },
  });
  await db.$disconnect();
  console.log('Saved to the database (open the app, press ⌘K → Backtest report).');
}
