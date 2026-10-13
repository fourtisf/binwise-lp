import {
  BRAND,
  DEFAULT_COSTS,
  DEFAULT_FEE_MODEL,
  DEFAULT_STRATEGY,
  STRATEGY_PRESETS,
  runBacktest,
  type BacktestBar,
  type BacktestPool,
  type BacktestResult,
  type AgentParams,
  type CostModel,
  type FeeModel,
  type RiskProfile,
  type StrategySettings,
} from '@kovra/core';
import { metadataCheck, type MeteoraClient, type MeteoraOhlcv, type MeteoraPool } from '@kovra/chain';

/**
 * Backtest (build step 4): replay the agent's rules over ≥30 days of Meteora
 * hourly candles for the top pools and report Kovra vs hold vs unmanaged LP, after costs.
 */

const H = 3600;
const STABLES = new Set(['USDC', 'USDT', 'PYUSD', 'USDS', 'USDG', 'FDUSD']);
const isStableToken = (t: MeteoraPool['token_x']) => t.is_verified && STABLES.has(t.symbol.toUpperCase()) && Math.abs((t.price ?? 0) - 1) < 0.02;

export interface BacktestOptions {
  days: number;
  pools: number;
  profile: RiskProfile;
  minTvl: number;
  costs: CostModel;
  /** Agent parameters to test (defaults to the built-in ones) */
  params?: AgentParams;
  now?: number;
  log?: (m: string) => void;
}

async function hourly(meteora: MeteoraClient, address: string, from: number, to: number): Promise<MeteoraOhlcv[]> {
  const out = new Map<number, MeteoraOhlcv>();
  // Ask in 7-day windows to stay within any per-request limit.
  for (let start = from; start < to; start += 7 * 24 * H) {
    const rows = await meteora.ohlcv(address, '1h', start, Math.min(to, start + 7 * 24 * H));
    for (const r of rows) out.set(r.timestamp, r);
  }
  return [...out.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Fees actually paid per hour (includes the dynamic fee), keyed by unix seconds. Empty when the API has none. */
async function hourlyFees(meteora: MeteoraClient, address: string, from: number, to: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    for (let start = from; start < to; start += 7 * 24 * H) {
      for (const r of await meteora.volumeHistory(address, '1h', start, Math.min(to, start + 7 * 24 * H))) out.set(r.timestamp, r.fees);
    }
  } catch {
    // Fee history is optional: without it the backtest falls back to the base fee.
  }
  return out;
}

export interface BacktestDataset {
  strategy: StrategySettings;
  pools: { pool: BacktestPool; bars: BacktestBar[]; feeModel: FeeModel }[];
  skipped: { pair: string; reason: string }[];
}

/** Downloads hourly candles, fee history and pool facts for the top pools. Shared by the backtest and the optimiser. */
export async function loadBacktestData(meteora: MeteoraClient, o: BacktestOptions): Promise<BacktestDataset> {
  const log = o.log ?? (() => {});
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const from = now - (o.days + 7) * 24 * H; // +7 days of indicator warm-up
  const strategy: StrategySettings = { ...DEFAULT_STRATEGY, profile: o.profile, ...(({ rebalancesPerDay: _r, ...p }) => p)(STRATEGY_PRESETS[o.profile]) };

  const all = await meteora.topPools(400);
  const candidates = all.filter((p) => p.tvl >= o.minTvl).slice(0, o.pools);
  // Reference SOL price series for SOL-quoted pools.
  const solUsdc = all.find((p) => p.token_x.symbol === 'SOL' && isStableToken(p.token_y));
  const solSeries = solUsdc ? new Map((await hourly(meteora, solUsdc.address, from, now)).map((c) => [c.timestamp, c.close])) : new Map<number, number>();

  const pools: BacktestDataset['pools'] = [];
  const skipped: BacktestDataset['skipped'] = [];
  for (const p of candidates) {
    const pair = `${p.token_x.symbol} / ${p.token_y.symbol}`;
    try {
      let quoteUsd: (ts: number) => number | undefined;
      if (isStableToken(p.token_y)) quoteUsd = () => 1;
      else if (p.token_y.symbol === 'SOL') quoteUsd = (ts) => solSeries.get(ts);
      else {
        skipped.push({ pair, reason: `No USD reference for ${p.token_y.symbol}` });
        continue;
      }
      const candles = await hourly(meteora, p.address, from, now);
      const fees = await hourlyFees(meteora, p.address, from, now);
      const bars: BacktestBar[] = candles
        .map((c) => ({ ts: c.timestamp * 1000, price: c.close, quoteUsd: quoteUsd(c.timestamp) ?? NaN, volumeUsd: c.volume, feesUsd: fees.get(c.timestamp) }))
        .filter((b) => b.price > 0 && Number.isFinite(b.quoteUsd));
      if (bars.length < (o.days * 0.9 + 7) * 24) {
        skipped.push({ pair, reason: `Only ${(bars.length / 24).toFixed(0)} days of history` });
        continue;
      }
      const risky = [p.token_x, p.token_y].filter((t) => !isStableToken(t));
      const caps = risky.map((t) => (t.market_cap != null ? t.market_cap / 1e6 : null));
      const holder = Math.min(
        ...(await Promise.all(
          [p.token_x, p.token_y].map(async (t) =>
            (await metadataCheck.check({ mint: t.address, isVerified: t.is_verified, freezeAuthorityDisabled: t.freeze_authority_disabled, holders: t.holders })).quality,
          ),
        )),
      );
      pools.push({
        pool: {
          id: p.address,
          pair,
          binStep: p.pool_config.bin_step,
          baseFeePct: p.pool_config.base_fee_pct,
          tvlUsd: p.tvl,
          stablePair: risky.length === 0,
          mcapM: risky.length === 0 ? 1e6 : caps.some((c) => c == null) ? null : Math.min(...(caps as number[])),
          holderQuality: holder,
          bothAllowed: [p.token_x, p.token_y].every((t) => t.is_verified && t.freeze_authority_disabled !== false),
          // Today's farm APR applied to the whole period (no history available).
          farmAprPct: p.has_farm ? p.farm_apr ?? 0 : 0,
          riskyIsY: isStableToken(p.token_x) && !isStableToken(p.token_y),
        },
        bars,
        feeModel: { ...DEFAULT_FEE_MODEL, protocolFeeShare: (p.pool_config.protocol_fee_pct ?? 5) / 100 },
      });
      log(`[data] ${pair}: ${(bars.length / 24).toFixed(0)} days, ${fees.size ? 'real fees' : 'base fee only'}`);
    } catch (e) {
      skipped.push({ pair, reason: (e as Error).message });
    }
  }
  return { strategy, pools, skipped };
}

export interface BacktestRun {
  strategy: StrategySettings;
  results: BacktestResult[];
  skipped: { pair: string; reason: string }[];
  report: string;
  summary: Record<string, number>;
}

export async function runPoolBacktests(meteora: MeteoraClient, o: BacktestOptions, data?: BacktestDataset): Promise<BacktestRun> {
  const log = o.log ?? (() => {});
  const { strategy, pools, skipped } = data ?? (await loadBacktestData(meteora, o));
  const results: BacktestResult[] = [];
  for (const x of pools) {
    const r = runBacktest({ pool: x.pool, strategy, costs: o.costs, feeModel: x.feeModel, thresholds: o.params }, x.bars);
    results.push(r);
    log(`[backtest] ${x.pool.pair}: net vs hold ${r.stats.netVsHoldPct.toFixed(2)}%`);
  }

  const nets = results.map((r) => r.stats.netVsHoldPct).sort((a, b) => a - b);
  const median = nets.length ? nets[Math.floor(nets.length / 2)] : 0;
  const summary = {
    pools: results.length,
    medianNetVsHoldPct: median,
    meanNetVsHoldPct: nets.length ? nets.reduce((s, x) => s + x, 0) / nets.length : 0,
    beatHold: results.filter((r) => r.stats.netVsHoldPct > 0).length,
    beatUnmanaged: results.filter((r) => r.stats.netVsHoldPct > r.stats.unmanagedVsHoldPct).length,
    totalFeesUsd: results.reduce((s, r) => s + r.stats.feesUsd, 0),
    totalCostsUsd: results.reduce((s, r) => s + r.stats.costsUsd, 0),
  };
  return { strategy, results, skipped, summary, report: renderReport(o, strategy, results, skipped, summary) };
}

const pct = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + '%';
const usd = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });

export function renderReport(
  o: BacktestOptions,
  s: StrategySettings,
  results: BacktestResult[],
  skipped: BacktestRun['skipped'],
  sum: BacktestRun['summary'],
): string {
  const date = new Date(o.now ?? Date.now()).toISOString().slice(0, 10);
  const rows = results
    .sort((a, b) => b.stats.netVsHoldPct - a.stats.netVsHoldPct)
    .map(
      (r) =>
        `| ${r.pool.pair} | ${r.stats.days.toFixed(0)} | **${pct(r.stats.netVsHoldPct)}** | ${pct(r.stats.unmanagedVsHoldPct)} | ${usd(r.stats.feesUsd)} | ${usd(r.stats.costsUsd)} | ${r.stats.rebalances} | ${r.stats.exits} | ${r.stats.deployedPct.toFixed(0)}% | ${r.stats.timeInRangePct.toFixed(0)}% | ${r.stats.maxDrawdownPct.toFixed(1)}% |`,
    )
    .join('\n');
  return `# ${BRAND} backtest — ${date}

**Question:** would the agent's rules have beaten simply holding the same tokens, after costs?

## Summary (${s.profile} profile, ${o.days} days, $10,000 per pool)

- Pools tested: **${sum.pools}** (${skipped.length} skipped)
- Median net vs hold: **${pct(sum.medianNetVsHoldPct)}**, average ${pct(sum.meanNetVsHoldPct)}
- Beat holding in **${sum.beatHold} of ${sum.pools}** pools; beat an unmanaged LP in ${sum.beatUnmanaged} of ${sum.pools}
- Fees earned ${usd(sum.totalFeesUsd)} vs costs paid ${usd(sum.totalCostsUsd)} (all pools combined)

## Per pool

| Pool | Days | ${BRAND} vs hold | Unmanaged LP vs hold | Fees | Costs | Rebalances | Exits | Time deployed | Time in range | Max drawdown |
|---|---|---|---|---|---|---|---|---|---|---|
${rows || '| — | | | | | | | | | | |'}

${skipped.length ? `### Skipped\n\n${skipped.map((x) => `- ${x.pair}: ${x.reason}`).join('\n')}\n` : ''}
## How this was tested

- Same scoring, entry, rebalance (6h fees > ${(o.params?.rebalanceFeeMultiple ?? 1.5)}× costs, one-tick wait, ${o.params?.rebalanceCooldownMin ?? 30} min cooldown), exit and compound rules as paper and live mode.
- Market regime: in a confirmed uptrend liquidity sits one-sided above price; in a confirmed downtrend the agent stays out. Fees are weighed against volatility loss (LVR) in the score.
- Hourly Meteora candles; the first 7 days only warm up indicators. Both ${BRAND} and hold start 50/50 in the pair's tokens.
- "Unmanaged LP" opens the same range once and never moves it.

## Assumptions (read before trusting the numbers)

- **Fees:** the fee rate actually paid each hour (fees ÷ volume, which includes DLMM's volatility fee) when Meteora's history has it, otherwise the base fee. Farm rewards use today's APR for the whole period. Our share of each trade = our liquidity in the active bin ÷ (pool active-bin liquidity + ours), with the pool's active bin assumed to hold ${(DEFAULT_FEE_MODEL.activeBinShareOfTvl * 100).toFixed(0)}% of TVL. Protocol fee share taken from each pool's config.
- **TVL:** today's TVL is used for every hour (historical TVL isn't available from the API).
- **Costs:** ${o.costs.lamportsPerTx.toLocaleString()} lamports per transaction + ${o.costs.tipLamports.toLocaleString()} lamport tip, SOL at ${usd(o.costs.solUsd)}; swaps pay ${o.costs.swapFixedBps} bps plus size impact. New bin-array rent (0.0714 SOL) is not charged.
- **Volatility** uses hourly candles here; the live agent uses 5-minute candles.

No strategy is guaranteed to profit. Past results don't guarantee future returns.
`;
}

export const DEFAULT_BACKTEST: BacktestOptions = { days: 38, pools: 15, profile: 'balanced', minTvl: 500_000, costs: DEFAULT_COSTS };
