import { effectiveFeePct, medianDailyVolume, realizedVolatilityPct, regimeOf, trendState, volumeForScoring } from './indicators';
import {
  DEFAULT_FEE_MODEL,
  binsForHalfWidth,
  composition,
  farmRewardsUsd,
  feesEarnedUsd,
  inRange,
  openPosition,
  positionValueY,
  type FeeModel,
  type PositionBins,
} from './dlmm';
import {
  MAX_BINS_EACH_SIDE,
  dailyStopHit,
  exitReason,
  rangeHalfWidth,
  shapeFor,
  shouldCompound,
  shouldRebalance,
  sideForRegime,
  singleSidedAfterExit,
  useSingleRebalance,
  slippageUsd,
  type LiquiditySide,
} from './rules';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, assessPool, emaSignal, type AgentThresholds, type ScoreWeights } from './scoring';
import type { LiquidityShape, StrategySettings } from './types';

/** One historical bar of a pool. Price is quote (Y) per base (X). */
export interface BacktestBar {
  ts: number;
  price: number;
  /** USD price of the quote token Y at this bar */
  quoteUsd: number;
  /** Pool volume during the bar, USD */
  volumeUsd: number;
  /** Fees paid to LPs during the bar, USD (includes the dynamic fee); optional */
  feesUsd?: number;
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
  /** Liquidity-mining reward APR, percent (current value used for every bar) */
  farmAprPct?: number | null;
  /** True when X is the stablecoin and Y the risky token: trends are read on 1/price */
  riskyIsY?: boolean;
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
  agent: number;
  hold: number;
  unmanaged: number;
}

export interface BacktestStats {
  days: number;
  startUsd: number;
  agentUsd: number;
  holdUsd: number;
  unmanagedUsd: number;
  /** Headline: (agent / hold − 1) × 100 */
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
  /** Bars spent in each market regime */
  regimeBars: Record<'range' | 'up' | 'down', number>;
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
  let feesY = 0; // unclaimed fees + rewards, Y units
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
  const regimeBars = { range: 0, up: 0, down: 0 };
  let barsDeployed = 0;
  let barsInRange = 0;
  const events: BacktestEvent[] = [];
  const series: BacktestPoint[] = [];

  const txUsd = (n: number) => (n * (costs.lamportsPerTx + costs.tipLamports) * costs.solUsd) / 1e9;
  const pay = (usd: number, quoteUsd: number, price: number) => {
    costsUsd += usd;
    const y = usd / quoteUsd;
    // Pay from the quote token; if short, from the base token.
    if (cashY >= y) cashY -= y;
    else {
      cashX -= (y - cashY) / price;
      cashY = 0;
    }
  };
  /** Swap idle cash so `targetXShare` of it is in X; pays slippage. */
  const rebalanceCash = (price: number, quoteUsd: number, targetXShare: number) => {
    const total = cashX * price + cashY;
    const wantX = (total * targetXShare) / price;
    const deltaY = Math.abs(wantX - cashX) * price;
    if (deltaY * quoteUsd < 1) return;
    const slip = slippageUsd(deltaY * quoteUsd, pool.tvlUsd, costs.swapFixedBps) + txUsd(TX.swap);
    cashX = wantX;
    cashY = total - wantX * price;
    pay(slip, quoteUsd, price);
  };
  const closePos = (price: number) => {
    if (!pos) return;
    const c = composition(pos, price);
    cashX += c.x;
    cashY += c.y + feesY;
    feesY = 0;
    pos = null;
  };
  /** Opens a position from cash; `side` decides which tokens it needs. Uses all cash up to `capY`. */
  const openFromCash = (price: number, binsSide: number, side: LiquiditySide, capY: number) => {
    const valueY = Math.min(cashX * price + cashY, capY);
    pos = openPosition(valueY, price, pool.binStep, binsSide, shape, side);
    const c = composition(pos, price);
    cashX -= c.x;
    cashY -= c.y;
    entry = c;
    netHistory.length = 0;
  };
  const vaultY = (price: number) => cashX * price + cashY + (pos ? positionValueY(pos, price) + feesY : 0);

  // Unmanaged LP baseline: opened alongside the agent's first deploy, never touched.
  let unmanaged: PositionBins | null = null;
  let unmanagedFeesY = 0;
  let unmanagedCashY = 0;

  let peak = 0;
  let maxDd = 0;
  const feeRate = (b: BacktestBar) => effectiveFeePct(b.feesUsd, b.volumeUsd, pool.baseFeePct);

  for (let i = warm; i < bars.length; i++) {
    const b = bars[i];
    const closes = bars.slice(Math.max(0, i - 60 * perDay), i + 1).map((x) => x.price);
    const dayBars = bars.slice(Math.max(0, i - perDay + 1), i + 1);
    const volume24h = dayBars.reduce((sum, x) => sum + x.volumeUsd, 0);
    const fees24h = dayBars.reduce((sum, x) => sum + (x.feesUsd ?? (x.volumeUsd * pool.baseFeePct) / 100), 0);
    const median = medianDailyVolume(bars.slice(Math.max(0, i - 7 * perDay + 1), i + 1).map((x) => x.volumeUsd));
    const vol = realizedVolatilityPct(dayBars.map((x) => x.price), perDay);
    // Trend and regime describe the risky token, so invert the pool price when it is Y.
    const riskyCloses = pool.riskyIsY ? closes.map((c) => 1 / c) : closes;
    const trend = trendState(riskyCloses);
    const regime = pool.stablePair ? 'range' : regimeOf(riskyCloses, t.regimeEr, 24, t.regimeMinMovePct);
    regimeBars[regime]++;
    const assessment = assessPool(
      {
        tvl: pool.tvlUsd,
        volume24h: volumeForScoring(volume24h, median).volume,
        baseFeePct: pool.baseFeePct,
        volatilityPct: vol,
        trend7d: trend.trend7d,
        holderQuality: pool.holderQuality,
        feeYieldDailyPct: pool.tvlUsd > 0 ? (fees24h / pool.tvlUsd) * 100 : null,
        farmAprPct: pool.farmAprPct ?? null,
        mcapM: pool.mcapM,
        bothAllowed: pool.bothAllowed,
        emaBearish: trend.emaBearish,
        regime,
      },
      s,
      w,
      t,
    );
    lowScoreStreak = assessment.score < t.exitScore ? lowScoreStreak + 1 : 0;
    const halfWidth = rangeHalfWidth(s.profile, vol, pool.stablePair, t);
    const binsSide = Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(halfWidth, pool.binStep));
    const fee = (p: PositionBins, volumeUsd: number) =>
      feesEarnedUsd({ pos: p, price: b.price, quoteUsd: b.quoteUsd, volumeUsd, baseFeePct: feeRate(b), poolTvlUsd: pool.tvlUsd, model: fm });

    // Fees and farm rewards for this bar.
    if (pos) {
      barsDeployed++;
      if (inRange(pos, b.price)) {
        barsInRange++;
        const f = fee(pos, b.volumeUsd) + farmRewardsUsd(positionValueY(pos, b.price) * b.quoteUsd, pool.farmAprPct ?? 0, (24 * 60) / perDay, true);
        feesY += f / b.quoteUsd;
        feesTotalUsd += f;
        ticksOut = 0;
      } else ticksOut++;
    }
    if (unmanaged && inRange(unmanaged, b.price)) unmanagedFeesY += fee(unmanaged, b.volumeUsd) / b.quoteUsd;

    // Daily loss stop.
    if (series.length >= perDay) {
      const dayAgoUsd = series[series.length - perDay].agent;
      if (dailyStopHit(vaultY(b.price) * b.quoteUsd, dayAgoUsd, s.dailyStopPct) && pos) {
        closePos(b.price);
        pay(txUsd(TX.close), b.quoteUsd, b.price);
        rebalanceCash(b.price, b.quoteUsd, 0);
        pausedUntil = i + perDay;
        counts.exits++;
        events.push({ ts: b.ts, type: 'stop', reason: `Vault fell more than ${s.dailyStopPct}% in 24h. Closed everything and paused.` });
      }
    }

    if (pos) {
      const p0: PositionBins = pos;
      const netNow = ((positionValueY(p0, b.price) + feesY) / (entry.x * b.price + entry.y) - 1) * 100;
      netHistory.push(netNow);
      const recent = netHistory.slice(-perDay);
      const why = exitReason(
        {
          trend7d: trend.trend7d,
          trendExitPct: s.trendExitPct,
          emaBearish: emaSignal(trend.emaBearish, regime, t),
          netVsHoldMax24h: recent.length >= perDay ? Math.max(...recent) : null,
          lowScoreStreak,
        },
        t,
      );
      if (why) {
        closePos(b.price);
        pay(txUsd(TX.close), b.quoteUsd, b.price);
        rebalanceCash(b.price, b.quoteUsd, pool.riskyIsY ? 1 : 0); // step aside into the stable/quote token
        pausedUntil = i + Math.round((t.reentryCooldownHours * perDay) / 24);
        counts.exits++;
        events.push({ ts: b.ts, type: 'exit', reason: why });
      } else if (ticksOut > 0) {
        const value = positionValueY(p0, b.price);
        const priceAbove = b.price > Math.pow(1 + pool.binStep / 10_000, p0.upperBin + 1);
        const regimeSide = sideForRegime(regime, t, pool.riskyIsY);
        // Cheap mode re-opens with the token we already hold (ranging market only); otherwise follow the regime.
        const side: LiquiditySide = useSingleRebalance(regime, t) ? singleSidedAfterExit(priceAbove) : regimeSide ?? 'both';
        const probe = openPosition(value, b.price, pool.binStep, binsSide, shape, side);
        const fees6h = fee(probe, volume24h / 4);
        const swapUsd = side === 'both' ? (value / 2) * b.quoteUsd : side === 'x' && priceAbove ? value * b.quoteUsd : side === 'y' && !priceAbove ? value * b.quoteUsd : 0;
        const v = shouldRebalance({
          ticksOutOfRange: ticksOut,
          minutesSinceLastRebalance: lastRebalanceBar == null ? null : ((i - lastRebalanceBar) * 24 * 60) / perDay,
          expectedFees6hUsd: fees6h,
          costs: {
            txFeesUsd: txUsd(TX.close + TX.deploy + (swapUsd > 0 ? TX.swap : 0)),
            slippageUsd: swapUsd > 0 ? slippageUsd(swapUsd, pool.tvlUsd, costs.swapFixedBps) : 0,
            priorityUsd: 0,
          },
          onlyWhenProfitable: s.toggles.rebalanceOnlyProfitable,
          feeMultiple: t.rebalanceFeeMultiple,
          cooldownMin: t.rebalanceCooldownMin,
        });
        if (v.act && regimeSide !== null) {
          closePos(b.price);
          pay(txUsd(TX.close + TX.deploy), b.quoteUsd, b.price);
          if (side === 'both') rebalanceCash(b.price, b.quoteUsd, 0.5);
          else if (side === 'x') rebalanceCash(b.price, b.quoteUsd, 1);
          else rebalanceCash(b.price, b.quoteUsd, 0);
          openFromCash(b.price, binsSide, side, Infinity);
          ticksOut = 0;
          lastRebalanceBar = i;
          counts.rebalances++;
          events.push({ ts: b.ts, type: 'rebalance', reason: v.reason });
        }
      }
      // Compound once a day when gas is under 1% of the claim.
      if (pos && i % perDay === 0 && shouldCompound(feesY * b.quoteUsd, txUsd(TX.compound), s.toggles.autoCompound)) {
        const p1: PositionBins = pos;
        const add = feesY;
        feesY = 0;
        pos = { ...p1, liquidity: p1.liquidity.map((L) => L * (1 + add / Math.max(1e-9, positionValueY(p1, b.price)))) };
        pay(txUsd(TX.compound), b.quoteUsd, b.price);
        counts.compounds++;
      }
    } else if (i > pausedUntil && assessment.eligible) {
      const side = sideForRegime(regime, t, pool.riskyIsY);
      if (side) {
        shape = shapeFor(s.profile, pool.stablePair, vol);
        rebalanceCash(b.price, b.quoteUsd, side === 'both' ? 0.5 : side === 'x' ? 1 : 0);
        pay(txUsd(TX.deploy), b.quoteUsd, b.price);
        const capY = (pool.tvlUsd * t.maxPoolShare) / b.quoteUsd;
        openFromCash(b.price, binsSide, side, capY);
        ticksOut = 0;
        counts.deploys++;
        events.push({ ts: b.ts, type: 'deploy', reason: `${assessment.reason}${side !== 'both' ? ' Trending up: one-sided above price.' : ''}` });
        if (!unmanaged) {
          const v0 = holdX * b.price + holdY;
          const lp = Math.min(v0, capY);
          unmanaged = openPosition(lp, b.price, pool.binStep, binsSide, shape);
          unmanagedCashY = v0 - lp;
        }
      }
    }

    const agentUsd = vaultY(b.price) * b.quoteUsd;
    const holdUsd = (holdX * b.price + holdY) * b.quoteUsd;
    const unmanagedUsd = unmanaged ? (positionValueY(unmanaged, b.price) + unmanagedFeesY + unmanagedCashY) * b.quoteUsd : holdUsd;
    series.push({ ts: b.ts, agent: agentUsd, hold: holdUsd, unmanaged: unmanagedUsd });
    peak = Math.max(peak, agentUsd);
    if (peak > 0) maxDd = Math.max(maxDd, (1 - agentUsd / peak) * 100);
  }

  const last = series.at(-1)!;
  return {
    pool,
    series,
    events,
    stats: {
      days: (series.length - 1) / perDay,
      startUsd: series[0].agent,
      agentUsd: last.agent,
      holdUsd: last.hold,
      unmanagedUsd: last.unmanaged,
      netVsHoldPct: (last.agent / last.hold - 1) * 100,
      unmanagedVsHoldPct: (last.unmanaged / last.hold - 1) * 100,
      feesUsd: feesTotalUsd,
      costsUsd,
      ...counts,
      timeInRangePct: barsDeployed ? (barsInRange / barsDeployed) * 100 : 0,
      deployedPct: (barsDeployed / series.length) * 100,
      maxDrawdownPct: maxDd,
      regimeBars,
    },
  };
}
