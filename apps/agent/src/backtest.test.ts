import { describe, expect, it } from 'vitest';
import { BRAND } from '@kovra/core';
import { DEFAULT_BACKTEST, runPoolBacktests } from './backtest';
import { FakeMeteora, asMeteora } from './test-helpers';

describe('runPoolBacktests', () => {
  it('backtests ≥30 days per pool and writes an owner-readable report', async () => {
    const m = new FakeMeteora();
    m.drift = 0;
    const run = await runPoolBacktests(asMeteora(m), { ...DEFAULT_BACKTEST, days: 32, pools: 5, now: Date.UTC(2026, 9, 10) });
    expect(run.results).toHaveLength(1);
    expect(run.results[0].stats.days).toBeGreaterThanOrEqual(30);
    expect(run.report).toContain(`# ${BRAND} backtest`);
    expect(run.report).toContain('JUP / USDC');
    expect(run.report).toContain('Assumptions');
    expect(run.summary.pools).toBe(1);
  });
});
