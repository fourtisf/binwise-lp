import { trendState, realizedVolatilityPct } from './indicators';
import {
  DEFAULT_FEE_MODEL,
  binsForHalfWidth,
  composition,
  feesEarnedUsd,
  inRange,
  openPosition,
  positionValueY,
  type FeeModel,
  type PositionBins,
} from './dlmm';
import { MAX_BINS_EACH_SIDE, dailyStopHit, exitReason, rangeHalfWidth, shapeFor, shouldCompound, shouldRebalance, slippageUsd } from './rules';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, assessPool, type AgentThresholds, type ScoreWeights } from './scoring';
import type { LiquidityShape, StrategySettings } from './types';

/** One historical bar of a pool. Price is quote (Y) per base (X). */
export interface BacktestBar {
  ts: number;
  price: number;
  /** USD price of the quote token Y at this bar */
  quoteUsd: number;
  /** Pool volume during the bar, USD */
  volumeUsd: number;
}

export interface BacktestPool {
  id: string;
  pair: string;
  binStep: number;
  baseFeePct: number;
  /** Pool TVL, USD. Historical TVL is rarely available, so the current value is used for every bar. */
  tvlUsd: number;
  stablePair: boolean;
  mcapM: number | null;
  holderQuality: number | null;
  bothAllowed: boolean;
}

export interface CostModel {
  solUsd: number;
  /** Lamports per transaction: base fee + priority fee */
  lamportsPerTx: number;
  /** Optional Jito tip per transaction, lamports */
  tipLamports: number;
  /** Route fee + fixed slippage on swaps, bps (size impact is added on top) */
  swapFixedBps: number;
}

export const DEFAULT_COSTS: CostModel = { solUsd: 150, lamportsPerTx: 105_000, tipLamports: 10_000, swapFixedBps: 10 };

export interface BacktestConfig {
  pool: BacktestPool;
  strategy: StrategySettings;
  weights?: ScoreWeights;
  thresholds?: AgentThresholds;
  startValueUsd?: number;
  /** Bars used to warm up indicators before trading starts (default 7 days of hourly bars) */
  warmupBars?: number;
  barsPerDay?: number;
  costs?: CostModel;
  feeModel?: FeeModel;
}

export interface BacktestEvent {
  ts: number;
  type: 'deploy' | 'rebalance' | 'exit' | 'compound' | 'stop';
  reason: string;
}

export interface BacktestPoint {
  ts: number;
  binwise: number;
  hold: number;
  unmanaged: number;
}

export interface BacktestStats {
  days: number;
  startUsd: number;
  binwiseUsd: number;
  holdUsd: number;
  unmanagedUsd: number;
  /** Headline: (binwise / hold − 1) × 100 */
  netVsHoldPct: number;
  unmanagedVsHoldPct: number;
  feesUsd: number;
  costsUsd: number;
  deploys: number;
  rebalances: number;
  exits: number;
  compounds: number;
  /** Share of deployed bars that were in range */
  timeInRangePct: number;
  /** Share of bars with liquidity deployed */
  deployedPct: number;
  maxDrawdownPct: number;
}

export interface BacktestResult {
  pool: BacktestPool;
  stats: BacktestStats;
  series: BacktestPoint[];
  events: BacktestEvent[];
}

const TX = { deploy: 2, close: 2, swap: 1, compound: 2 };

/**
 * Replays the agent's rules over historical bars, using the same scoring and
 * decision functions as paper and live mode. Values are tracked in quote (Y)
 * units and reported in USD.
 */
export function runBacktest(cfg: BacktestConfig, bars: BacktestBar[]): BacktestResult {
  const s = cfg.strategy;
  const w = cfg.weights ?? DEFAULT_WEIGHTS[s.profile];
  const t = cfg.thresholds ?? DEFAULT_THRESHOLDS;
  const costs = cfg.costs ?? DEFAULT_COSTS;
  const fm = cfg.feeModel ?? DEFAULT_FEE_MODEL;
  const perDay = cfg.barsPerDay ?? 24;
  const warm = cfg.warmupBars ?? 7 * perDay;
  const pool = cfg.pool;
  if (bars.length <= warm + perDay) throw new RangeError(`Need more than ${warm + perDay} bars, got ${bars.length}.`);

  const start = bars[warm];
  const startY = (cfg.startValueUsd ?? 10_000) / start.quoteUsd;
  // Hold baseline and the vault both start 50/50 in X and Y.
  const holdX = startY / 2 / start.price;
  const holdY = startY / 2;

  let cashX = holdX;
  let cashY = holdY;
  let pos: PositionBins | null = null;
  let feesY = 0; // unclaimed fees, Y units
  let feesTotalUsd = 0;
  let costsUsd = 0;
  let ticksOut = 0;
  let lastRebalanceBar: number | null = null;
  let lowScoreStreak = 0;
  let pausedUntil = -1;
  // Tokens the current position started with: its own hold baseline for net vs hold.
  let entry = { x: 0, y: 0 };
  let shape: LiquidityShape = 'spot';
  const netHistory: number[] = [];
  const counts = { deploys: 0, rebalances: 0, exits: 0, compounds: 0 };
  let barsDeployed = 0;
  let barsInRange = 0;
  const events: BacktestEvent[] = [];
  const series: BacktestPoint[] = [];

  const txUsd = (n: number) => (n * (costs.lamportsPerTx + costs.tipLamports) * costs.solUsd) / 1e9;
  const pay = (usd: number, quoteUsd: number) => {
    costsUsd += usd;
    cashY -= usd / quoteUsd;
  };
  /** Swap to reach a 50/50 split; returns nothing, adjusts cash and pays slippage. */
  const rebalanceCash = (price: number, quoteUsd: number, targetXShare: number) => {
    const total = cashX * price + cashY;
    const wantX = (total * targetXShare) / price;
    const deltaY = Math.abs(wantX - cashX) * price;
    if (deltaY * quoteUsd < 1) return;
    const slip = slippageUsd(deltaY * quoteUsd, pool.tvlUsd, costs.swapFixedBps) + txUsd(TX.swap);
    cashX = wantX;
    cashY = total - wantX * price;
    pay(slip, quoteUsd);
  };
  const closePos = (price: number) => {
    if (!pos) return;
    const c = composition(pos, price);
    cashX += c.x;
    cashY += c.y + feesY;
    feesY = 0;
    pos = null;
  };
  const vaultY = (price: number) => cashX * price + cashY + (pos ? positionValueY(pos, price) + feesY : 0);

  // Unmanaged LP baseline: opened alongside the agent's first deploy, never touched.
  let unmanaged: PositionBins | null = null;
  let unmanagedFeesY = 0;
  let unmanagedCashY = 0;

  let peak = 0;
  let maxDd = 0;

  for (let i = warm; i < bars.length; i++) {
    const b = bars[i];
    const closes = bars.slice(Math.max(0, i - 60 * perDay), i + 1).map((x) => x.price);
    const dayBars = bars.slice(Math.max(0, i - perDay + 1), i + 1);
    const volume24h = dayBars.reduce((sum, x) => sum + x.volumeUsd, 0);
    const vol = realizedVolatilityPct(dayBars.map((x) => x.price), perDay);
    const trend = trendState(closes);
    const assessment = assessPool(
      {
        tvl: pool.tvlUsd,
        volume24h,
        baseFeePct: pool.baseFeePct,
        volatilityPct: vol,
        trend7d: trend.trend7d,
        holderQuality: pool.holderQuality,
        mcapM: pool.mcapM,
        bothAllowed: pool.bothAllowed,
        emaBearish: trend.emaBearish,
      },
      s,
      w,
      t,
    );
    lowScoreStreak = assessment.score < t.exitScore ? lowScoreStreak + 1 : 0;
    const halfWidth = rangeHalfWidth(s.profile, vol, pool.stablePair);
    const binsSide = Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(halfWidth, pool.binStep));

    // Fees for this bar.
    if (pos) {
      barsDeployed++;
      if (inRange(pos, b.price)) {
        barsInRange++;
        const f = feesEarnedUsd({ pos, price: b.price, quoteUsd: b.quoteUsd, volumeUsd: b.volumeUsd, baseFeePct: pool.baseFeePct, poolTvlUsd: pool.tvlUsd, model: fm });
        feesY += f / b.quoteUsd;
        feesTotalUsd += f;
        ticksOut = 0;
      } else ticksOut++;
    }
    if (unmanaged && inRange(unmanaged, b.price))
      unmanagedFeesY +=
        feesEarnedUsd({ pos: unmanaged, price: b.price, quoteUsd: b.quoteUsd, volumeUsd: b.volumeUsd, baseFeePct: pool.baseFeePct, poolTvlUsd: pool.tvlUsd, model: fm }) /
        b.quoteUsd;

    // Daily loss stop.
    if (i - perDay >= warm && series.length >= perDay) {
      const dayAgoUsd = series[series.length - perDay].binwise;
      if (dailyStopHit(vaultY(b.price) * b.quoteUsd, dayAgoUsd, s.dailyStopPct) && pos) {
        closePos(b.price);
        pay(txUsd(TX.close), b.quoteUsd);
        rebalanceCash(b.price, b.quoteUsd, 0);
        pausedUntil = i + perDay;
        counts.exits++;
        events.push({ ts: b.ts, type: 'stop', reason: `Vault fell more than ${s.dailyStopPct}% in 24h. Closed everything and paused.` });
      }
    }

    if (pos) {
      const netNow = ((positionValueY(pos, b.price) + feesY) / (entry.x * b.price + entry.y) - 1) * 100;
      netHistory.push(netNow);
      const recent = netHistory.slice(-perDay);
      const why = exitReason(
        {
          trend7d: trend.trend7d,
          trendExitPct: s.trendExitPct,
          emaBearish: trend.emaBearish,
          netVsHoldMax24h: recent.length >= perDay ? Math.max(...recent) : null,
          lowScoreStreak,
        },
        t,
      );
      if (why) {
        closePos(b.price);
        pay(txUsd(TX.close), b.quoteUsd);
        rebalanceCash(b.price, b.quoteUsd, 0); // step aside into the quote token
        pausedUntil = i + 6; // re-entry cooldown
        counts.exits++;
        events.push({ ts: b.ts, type: 'exit', reason: why });
      } else if (ticksOut > 0) {
        const value = positionValueY(pos, b.price);
        const probe = openPosition(value, b.price, pool.binStep, binsSide, shape);
        const fees6h =
          feesEarnedUsd({ pos: probe, price: b.price, quoteUsd: b.quoteUsd, volumeUsd: volume24h / 4, baseFeePct: pool.baseFeePct, poolTvlUsd: pool.tvlUsd, model: fm });
        const swapUsd = (value / 2) * b.quoteUsd;
        const v = shouldRebalance({
          ticksOutOfRange: ticksOut,
          minutesSinceLastRebalance: lastRebalanceBar == null ? null : ((i - lastRebalanceBar) * 24 * 60) / perDay,
          expectedFees6hUsd: fees6h,
          costs: { txFeesUsd: txUsd(TX.close + TX.swap + TX.deploy), slippageUsd: slippageUsd(swapUsd, pool.tvlUsd, costs.swapFixedBps), priorityUsd: 0 },
          onlyWhenProfitable: s.toggles.rebalanceOnlyProfitable,
        });
        if (v.act) {
          closePos(b.price);
          pay(txUsd(TX.close + TX.deploy), b.quoteUsd);
          rebalanceCash(b.price, b.quoteUsd, 0.5);
          const valueY = cashX * b.price + cashY;
          pos = openPosition(valueY, b.price, pool.binStep, binsSide, shape);
          entry = composition(pos, b.price);
          netHistory.length = 0;
          cashX = 0;
          cashY = 0;
          ticksOut = 0;
          lastRebalanceBar = i;
          counts.rebalances++;
          events.push({ ts: b.ts, type: 'rebalance', reason: v.reason });
        }
      }
      // Compound once a day when gas is under 1% of the claim.
      if (pos && i % perDay === 0 && shouldCompound(feesY * b.quoteUsd, txUsd(TX.compound), s.toggles.autoCompound)) {
        const add = feesY;
        feesY = 0;
        pos = { ...pos, liquidity: pos.liquidity.map((L) => L * (1 + add / Math.max(1e-9, positionValueY(pos!, b.price)))) };
        pay(txUsd(TX.compound), b.quoteUsd);
        counts.compounds++;
      }
    } else if (i > pausedUntil && assessment.eligible) {
      shape = shapeFor(s.profile, pool.stablePair, vol);
      rebalanceCash(b.price, b.quoteUsd, 0.5);
      pay(txUsd(TX.deploy), b.quoteUsd);
      const valueY = cashX * b.price + cashY;
      const capY = (pool.tvlUsd * t.maxPoolShare) / b.quoteUsd;
      const useY = Math.min(valueY, capY);
      pos = openPosition(useY, b.price, pool.binStep, binsSide, shape);
      entry = composition(pos, b.price);
      const used = useY / valueY;
      cashX *= 1 - used;
      cashY *= 1 - used;
      ticksOut = 0;
      netHistory.length = 0;
      counts.deploys++;
      events.push({ ts: b.ts, type: 'deploy', reason: assessment.reason });
      if (!unmanaged) {
        const v0 = holdX * b.price + holdY;
        const lp = Math.min(v0, capY);
        unmanaged = openPosition(lp, b.price, pool.binStep, binsSide, shape);
        unmanagedCashY = v0 - lp;
      }
    }

    const binwiseUsd = vaultY(b.price) * b.quoteUsd;
    const holdUsd = (holdX * b.price + holdY) * b.quoteUsd;
    const unmanagedUsd = unmanaged
      ? (positionValueY(unmanaged, b.price) + unmanagedFeesY + unmanagedCashY) * b.quoteUsd
      : holdUsd;
    series.push({ ts: b.ts, binwise: binwiseUsd, hold: holdUsd, unmanaged: unmanagedUsd });
    peak = Math.max(peak, binwiseUsd);
    if (peak > 0) maxDd = Math.max(maxDd, (1 - binwiseUsd / peak) * 100);
  }

  const last = series.at(-1)!;
  return {
    pool,
    series,
    events,
    stats: {
      days: (series.length - 1) / perDay,
      startUsd: series[0].binwise,
      binwiseUsd: last.binwise,
      holdUsd: last.hold,
      unmanagedUsd: last.unmanaged,
      netVsHoldPct: (last.binwise / last.hold - 1) * 100,
      unmanagedVsHoldPct: (last.unmanaged / last.hold - 1) * 100,
      feesUsd: feesTotalUsd,
      costsUsd,
      ...counts,
      timeInRangePct: barsDeployed ? (barsInRange / barsDeployed) * 100 : 0,
      deployedPct: (barsDeployed / series.length) * 100,
      maxDrawdownPct: maxDd,
    },
  };
}
