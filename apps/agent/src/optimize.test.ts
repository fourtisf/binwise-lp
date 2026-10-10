import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, type OptimizeResult } from '@binwise/core';
import { renderOptimizeReport, searchable } from './optimize';

const score = (test: number, params = DEFAULT_PARAMS) => ({ params, train: test + 1, test, testNetVsHoldPct: test, testBeatHold: 3 });

describe('optimiser report', () => {
  const best = { ...DEFAULT_PARAMS, deployScore: 70, rebalanceMode: 'single' as const };
  const r: OptimizeResult = { baseline: score(1), best: score(2, best), top: [], recommend: true, pools: 5, trainDays: 27, testDays: 18 };

  it('says plainly whether the new settings are active and highlights what changed', () => {
    const applied = renderOptimizeReport(r, { days: 60, profile: 'balanced', candidates: 60, applied: true, now: Date.UTC(2026, 9, 10) });
    expect(applied).toContain('# Binwise settings search — 2026-10-10');
    expect(applied).toContain('they are now active');
    expect(applied).toContain('| Deploy at score | 62 | **70** |');
    expect(applied).toContain('| Rebalance mode | balanced | **single** |');
    expect(applied).toContain('No strategy is guaranteed to profit.');
    expect(renderOptimizeReport(r, { days: 60, profile: 'balanced', candidates: 60, applied: false })).toContain('not active');
    expect(renderOptimizeReport({ ...r, recommend: false }, { days: 60, profile: 'balanced', candidates: 60, applied: false })).toContain('nothing changes');
  });

  it('stores only the searchable settings', () => {
    const s = searchable(best);
    expect(s.deployScore).toBe(70);
    expect('minTvl' in s).toBe(false);
  });
});
