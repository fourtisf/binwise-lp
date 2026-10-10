import {
  DEFAULT_COSTS,
  DEFAULT_FEE_MODEL,
  DEFAULT_STRATEGY,
  STRATEGY_PRESETS,
  runBacktest,
  type BacktestBar,
  type BacktestPool,
  type BacktestResult,
  type CostModel,
  type RiskProfile,
  type StrategySettings,
} from '@binwise/core';
import { metadataCheck, type MeteoraClient, type MeteoraOhlcv, type MeteoraPool } from '@binwise/chain';

/**
 * Backtest (build step 4): replay the agent's rules over ≥30 days of Meteora
 * hourly candles for the top pools and report Binwise vs hold vs unmanaged LP, after costs.
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

export interface BacktestRun {
  strategy: StrategySettings;
  results: BacktestResult[];
  skipped: { pair: string; reason: string }[];
  report: string;
  summary: Record<string, number>;
}

export async function runPoolBacktests(meteora: MeteoraClient, o: BacktestOptions): Promise<BacktestRun> {
  const log = o.log ?? (() => {});
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  const from = now - (o.days + 7) * 24 * H; // +7 days of indicator warm-up
  const strategy: StrategySettings = { ...DEFAULT_STRATEGY, profile: o.profile, ...(({ rebalancesPerDay: _r, ...p }) => p)(STRATEGY_PRESETS[o.profile]) };

  const all = await meteora.topPools(400);
  const candidates = all.filter((p) => p.tvl >= o.minTvl).slice(0, o.pools);
  // Reference SOL price series for SOL-quoted pools.
  const solUsdc = all.find((p) => p.token_x.symbol === 'SOL' && isStableToken(p.token_y));
  const solSeries = solUsdc ? new Map((await hourly(meteora, solUsdc.address, from, now)).map((c) => [c.timestamp, c.close])) : new Map<number, number>();

  const results: BacktestResult[] = [];
  const skipped: BacktestRun['skipped'] = [];
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
      const bars: BacktestBar[] = candles
        .map((c) => ({ ts: c.timestamp * 1000, price: c.close, quoteUsd: quoteUsd(c.timestamp) ?? NaN, volumeUsd: c.volume }))
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
      const pool: BacktestPool = {
        id: p.address,
        pair,
        binStep: p.pool_config.bin_step,
        baseFeePct: p.pool_config.base_fee_pct,
        tvlUsd: p.tvl,
        stablePair: risky.length === 0,
        mcapM: risky.length === 0 ? 1e6 : caps.some((c) => c == null) ? null : Math.min(...(caps as number[])),
        holderQuality: holder,
        bothAllowed: [p.token_x, p.token_y].every((t) => t.is_verified && t.freeze_authority_disabled !== false),
      };
      const r = runBacktest(
        { pool, strategy, costs: o.costs, feeModel: { ...DEFAULT_FEE_MODEL, protocolFeeShare: (p.pool_config.protocol_fee_pct ?? 5) / 100 } },
        bars,
      );
      results.push(r);
      log(`[backtest] ${pair}: net vs hold ${r.stats.netVsHoldPct.toFixed(2)}%`);
    } catch (e) {
      skipped.push({ pair, reason: (e as Error).message });
    }
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
  return `# Binwise backtest — ${date}

**Question:** would the agent's rules have beaten simply holding the same tokens, after costs?

## Summary (${s.profile} profile, ${o.days} days, $10,000 per pool)

- Pools tested: **${sum.pools}** (${skipped.length} skipped)
- Median net vs hold: **${pct(sum.medianNetVsHoldPct)}**, average ${pct(sum.meanNetVsHoldPct)}
- Beat holding in **${sum.beatHold} of ${sum.pools}** pools; beat an unmanaged LP in ${sum.beatUnmanaged} of ${sum.pools}
- Fees earned ${usd(sum.totalFeesUsd)} vs costs paid ${usd(sum.totalCostsUsd)} (all pools combined)

## Per pool

| Pool | Days | Binwise vs hold | Unmanaged LP vs hold | Fees | Costs | Rebalances | Exits | Time deployed | Time in range | Max drawdown |
|---|---|---|---|---|---|---|---|---|---|---|
${rows || '| — | | | | | | | | | | |'}

${skipped.length ? `### Skipped\n\n${skipped.map((x) => `- ${x.pair}: ${x.reason}`).join('\n')}\n` : ''}
## How this was tested

- Same scoring, entry, rebalance (6h fees > 1.5× costs, one-tick wait, 30 min cooldown), exit and compound rules as paper and live mode.
- Hourly Meteora candles; the first 7 days only warm up indicators. Both Binwise and hold start 50/50 in the pair's tokens.
- "Unmanaged LP" opens the same range once and never moves it.

## Assumptions (read before trusting the numbers)

- **Fees:** only the pool's base fee is counted (DLMM's extra volatility fee is ignored, so fees err low). Our share of each trade = our liquidity in the active bin ÷ (pool active-bin liquidity + ours), with the pool's active bin assumed to hold ${(DEFAULT_FEE_MODEL.activeBinShareOfTvl * 100).toFixed(0)}% of TVL. Protocol fee share taken from each pool's config.
- **TVL:** today's TVL is used for every hour (historical TVL isn't available from the API).
- **Costs:** ${o.costs.lamportsPerTx.toLocaleString()} lamports per transaction + ${o.costs.tipLamports.toLocaleString()} lamport tip, SOL at ${usd(o.costs.solUsd)}; swaps pay ${o.costs.swapFixedBps} bps plus size impact. New bin-array rent (0.0714 SOL) is not charged.
- **Volatility** uses hourly candles here; the live agent uses 5-minute candles.

No strategy is guaranteed to profit. Past results don't guarantee future returns.
`;
}

export const DEFAULT_BACKTEST: BacktestOptions = { days: 38, pools: 15, profile: 'balanced', minTvl: 500_000, costs: DEFAULT_COSTS };
