import { runBacktest, type BacktestBar, type BacktestPool, type CostModel } from './backtest';
import type { FeeModel } from './dlmm';
import { DEFAULT_PARAMS, type AgentParams } from './scoring';
import type { StrategySettings } from './types';

/**
 * Walk-forward parameter search. Candidates are scored on the first part of the
 * history (train) and judged on the rest (test), which they never saw, so a
 * parameter set only wins if it generalises instead of memorising the past.
 */

export interface OptimizeInput {
  pools: { pool: BacktestPool; bars: BacktestBar[] }[];
  strategy: StrategySettings;
  base?: AgentParams;
  /** Random candidates to try (besides the base set) */
  candidates?: number;
  seed?: number;
  /** Share of post-warm-up bars used for training */
  trainFraction?: number;
  barsPerDay?: number;
  costs?: CostModel;
  feeModel?: FeeModel;
  /** Weight of max drawdown in the objective (risk penalty) */
  drawdownPenalty?: number;
}

export interface CandidateScore {
  params: AgentParams;
  /** Objective on training data: mean net-vs-hold − penalty × mean max drawdown (percent points) */
  train: number;
  /** Same objective on unseen test data */
  test: number;
  testNetVsHoldPct: number;
  testBeatHold: number;
}

export interface OptimizeResult {
  baseline: CandidateScore;
  best: CandidateScore;
  top: CandidateScore[];
  /** True when the best set beats the current one on unseen data by a margin */
  recommend: boolean;
  pools: number;
  trainDays: number;
  testDays: number;
}

/** The search space. Every value here is something the agent actually uses. */
export const PARAM_SPACE = {
  deployScore: [50, 75],
  exitScore: [30, 55],
  rangeMult: [0.5, 2.5],
  rebalanceFeeMultiple: [1, 3],
  rebalanceCooldownMin: [15, 120],
  rebalanceMode: ['balanced', 'single'],
  useRegime: [true, false],
  regimeEr: [0.25, 0.6],
  netVsHoldExitPct: [-6, -1],
  reentryCooldownHours: [2, 24],
  emaExitMode: ['always', 'trending'],
} as const;

function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleParams(base: AgentParams, r: () => number): AgentParams {
  const num = ([a, b]: readonly [number, number], int = false) => {
    const v = a + (b - a) * r();
    return int ? Math.round(v) : Math.round(v * 100) / 100;
  };
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  return {
    ...base,
    deployScore: num(PARAM_SPACE.deployScore, true),
    exitScore: num(PARAM_SPACE.exitScore, true),
    rangeMult: num(PARAM_SPACE.rangeMult),
    rebalanceFeeMultiple: num(PARAM_SPACE.rebalanceFeeMultiple),
    rebalanceCooldownMin: num(PARAM_SPACE.rebalanceCooldownMin, true),
    rebalanceMode: pick(PARAM_SPACE.rebalanceMode),
    useRegime: pick(PARAM_SPACE.useRegime),
    regimeEr: num(PARAM_SPACE.regimeEr),
    netVsHoldExitPct: num(PARAM_SPACE.netVsHoldExitPct),
    reentryCooldownHours: num(PARAM_SPACE.reentryCooldownHours, true),
    emaExitMode: pick(PARAM_SPACE.emaExitMode),
  };
}

export function optimizeParams(o: OptimizeInput): OptimizeResult {
  const perDay = o.barsPerDay ?? 24;
  const warm = 7 * perDay;
  const base = o.base ?? DEFAULT_PARAMS;
  const penalty = o.drawdownPenalty ?? 0.25;
  const frac = o.trainFraction ?? 0.6;
  const r = rng(o.seed ?? 42);

  // Split every pool: train = warm-up + first part; test = its own warm-up + the rest.
  const splits = o.pools
    .map(({ pool, bars }) => {
      const usable = bars.length - warm;
      const cut = warm + Math.floor(usable * frac);
      return { pool, train: bars.slice(0, cut), test: bars.slice(cut - warm) };
    })
    .filter((x) => x.train.length > warm + perDay && x.test.length > warm + perDay);
  if (!splits.length) throw new RangeError('Not enough history to optimise: each pool needs more than 9 days per split.');

  const evaluate = (params: AgentParams, part: 'train' | 'test') => {
    const runs = splits.map((x) =>
      runBacktest({ pool: x.pool, strategy: o.strategy, thresholds: params, costs: o.costs, feeModel: o.feeModel, barsPerDay: perDay }, x[part]).stats,
    );
    const net = runs.reduce((s, x) => s + x.netVsHoldPct, 0) / runs.length;
    const dd = runs.reduce((s, x) => s + x.maxDrawdownPct, 0) / runs.length;
    return { score: net - penalty * dd, net, beat: runs.filter((x) => x.netVsHoldPct > 0).length };
  };

  const score = (params: AgentParams): CandidateScore => {
    const tr = evaluate(params, 'train');
    const te = evaluate(params, 'test');
    return { params, train: tr.score, test: te.score, testNetVsHoldPct: te.net, testBeatHold: te.beat };
  };

  const baseline = score(base);
  const tried = [baseline];
  for (let i = 0; i < (o.candidates ?? 60); i++) tried.push(score(sampleParams(base, r)));
  // Choose by training score only; the test score is the honest check.
  const byTrain = [...tried].sort((a, b) => b.train - a.train);
  const best = byTrain[0];
  return {
    baseline,
    best,
    top: byTrain.slice(0, 5),
    recommend: best !== baseline && best.test > baseline.test + 0.25,
    pools: splits.length,
    trainDays: (splits[0].train.length - warm) / perDay,
    testDays: (splits[0].test.length - warm) / perDay,
  };
}
