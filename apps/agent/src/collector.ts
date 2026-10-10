import {
  DEFAULT_PARAMS,
  DEFAULT_STRATEGY,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  RISK_LIMITS,
  assessPool,
  effectiveFeePct,
  medianDailyVolume,
  realizedVolatilityPct,
  regimeParts,
  riskFlags,
  trendState,
  volumeForScoring,
  type AgentParams,
} from '@binwise/core';
import { JupiterClient, MeteoraClient, metadataCheck, runHolderChecks, type HolderCheck, type MeteoraPool, type MeteoraToken } from '@binwise/chain';
import { assessmentInput, isAllowed, isStable, isStableSymbol, type PrismaClient, type Token } from '@binwise/db';

/**
 * Data collector (build step 3): every minute, scan Meteora DLMM pools,
 * keep candles fresh for the pools that matter, score them and store a snapshot.
 */

export interface CollectorDeps {
  db: PrismaClient;
  meteora: MeteoraClient;
  /** Token logos and holder audit (Jupiter Tokens API); optional */
  jupiter?: JupiterClient;
  holderChecks?: HolderCheck[];
  /** Reads real active-bin liquidity (USD) from chain; refreshed every 10 minutes per pool */
  activeBinLiq?: (pool: { address: string; decimalsX: number; decimalsY: number; usdX: number; usdY: number }) => Promise<number>;
  log?: (msg: string) => void;
  now?: () => number;
  /** Active agent parameters (regime threshold etc.) */
  params?: AgentParams;
}

export interface CollectorOptions {
  /** Pools fetched from the API each run */
  scanLimit: number;
  /** Store pools at or above this TVL */
  storeMinTvl: number;
  /** Track candles and score pools at or above this TVL (the strategy floor) */
  trackMinTvl: number;
  /** Max pools with candles */
  trackLimit: number;
}

export const DEFAULT_COLLECTOR: CollectorOptions = {
  scanLimit: 400,
  storeMinTvl: 100_000,
  trackMinTvl: DEFAULT_THRESHOLDS.minTvl,
  trackLimit: 60,
};

const H = 3600_000;

async function upsertToken(db: PrismaClient, t: MeteoraToken) {
  await db.token.upsert({
    where: { mint: t.address },
    update: {
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      isVerified: !!t.is_verified,
      holders: t.holders ?? null,
      freezeAuthorityDisabled: t.freeze_authority_disabled ?? null,
      priceUsd: t.price ?? null,
      mcapUsd: t.market_cap ?? null,
    },
    create: {
      mint: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      isVerified: !!t.is_verified,
      holders: t.holders ?? null,
      freezeAuthorityDisabled: t.freeze_authority_disabled ?? null,
      priceUsd: t.price ?? null,
      mcapUsd: t.market_cap ?? null,
    },
  });
}

/** Fetch candles newer than what we have; 1h covers 8 days, 5m covers 1 day. */
async function refreshCandles(deps: CollectorDeps, poolId: string, timeframe: '1h' | '5m') {
  const { db, meteora } = deps;
  const now = (deps.now ?? Date.now)();
  const span = timeframe === '1h' ? 8 * 24 * H : 25 * H;
  const step = timeframe === '1h' ? H : 5 * 60_000;
  const last = await db.candle.findFirst({ where: { poolId, timeframe }, orderBy: { ts: 'desc' } });
  // Re-fetch the latest stored candle too, since it may have been partial.
  const from = last ? Math.max(last.ts.getTime(), now - span) : now - span;
  if (last && now - last.ts.getTime() < step) return;
  const rows = await meteora.ohlcv(poolId, timeframe, from / 1000, now / 1000);
  for (const c of rows) {
    const ts = new Date(c.timestamp * 1000);
    const data = { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    await db.candle.upsert({
      where: { poolId_timeframe_ts: { poolId, timeframe, ts } },
      update: data,
      create: { poolId, timeframe, ts, ...data },
    });
  }
}

async function closes(db: PrismaClient, poolId: string, timeframe: '1h' | '5m', since: number) {
  const rows = await db.candle.findMany({ where: { poolId, timeframe, ts: { gte: new Date(since) } }, orderBy: { ts: 'asc' }, select: { close: true } });
  return rows.map((r) => r.close).filter((c) => c > 0);
}

/** Holder check once a day per token. */
async function refreshHolders(deps: CollectorDeps, token: Token) {
  const day = 24 * H;
  if (token.holderCheckedAt && Date.now() - token.holderCheckedAt.getTime() < day) return token;
  const v = await runHolderChecks(deps.holderChecks ?? [metadataCheck], {
    mint: token.mint,
    isVerified: token.isVerified,
    freezeAuthorityDisabled: token.freezeAuthorityDisabled,
    holders: token.holders,
    topHoldersPct: token.topHoldersPct,
  });
  return deps.db.token.update({ where: { mint: token.mint }, data: { holderQuality: v.quality, topHoldersPct: v.topHoldersPct ?? null, holderCheckedAt: new Date() } });
}

const activeCache = new Map<string, { usd: number; at: number }>();

async function activeLiquidity(deps: CollectorDeps, p: MeteoraPool, now: number): Promise<number | null> {
  if (!deps.activeBinLiq) return null;
  const hit = activeCache.get(p.address);
  if (hit && now - hit.at < 10 * 60_000) return hit.usd;
  try {
    const usd = await deps.activeBinLiq({
      address: p.address,
      decimalsX: p.token_x.decimals,
      decimalsY: p.token_y.decimals,
      usdX: p.token_x.price ?? 0,
      usdY: p.token_y.price ?? 0,
    });
    activeCache.set(p.address, { usd, at: now });
    return usd;
  } catch {
    return hit?.usd ?? null;
  }
}

let lastEnrich = 0;

/** Once an hour: logos and top-holder share from Jupiter for tokens we store. Best effort. */
async function enrichTokens(deps: CollectorDeps, mints: string[]) {
  const now = (deps.now ?? Date.now)();
  if (!deps.jupiter || now - lastEnrich < 3600_000) return;
  lastEnrich = now;
  try {
    for (const t of await deps.jupiter.tokens(mints)) {
      await deps.db.token.updateMany({
        where: { mint: t.id },
        data: {
          ...(t.icon ? { logoUrl: t.icon } : {}),
          ...(t.audit?.topHoldersPercentage != null ? { topHoldersPct: t.audit.topHoldersPercentage, holderCheckedAt: null } : {}),
        },
      });
    }
  } catch (e) {
    (deps.log ?? (() => {}))(`[collector] token metadata: ${(e as Error).message}`);
  }
}

export interface CollectResult {
  scanned: number;
  stored: number;
  tracked: number;
  eligible: number;
}

export async function collectOnce(deps: CollectorDeps, o: CollectorOptions = DEFAULT_COLLECTOR): Promise<CollectResult> {
  const { db, meteora } = deps;
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? Date.now)();
  const pools = await meteora.topPools(o.scanLimit);
  // Pools holding open positions are always stored and snapshotted, whatever their TVL or rank:
  // a draining pool is exactly the one the agent must keep watching (and exit).
  const held = new Set((await db.position.findMany({ where: { status: 'open' }, select: { poolId: true }, distinct: ['poolId'] })).map((p) => p.poolId));
  const stored = pools.filter((p) => (p.tvl >= o.storeMinTvl || held.has(p.address)) && p.token_x && p.token_y);

  for (const p of stored) {
    await upsertToken(db, p.token_x);
    await upsertToken(db, p.token_y);
    const data = {
      name: p.name,
      tokenA: p.token_x.symbol,
      tokenB: p.token_y.symbol,
      mintA: p.token_x.address,
      mintB: p.token_y.address,
      binStep: p.pool_config.bin_step,
      baseFee: p.pool_config.base_fee_pct,
      protocolFeePct: p.pool_config.protocol_fee_pct,
      isBlacklisted: p.is_blacklisted,
    };
    await db.pool.upsert({ where: { id: p.address }, update: data, create: { id: p.address, ...data } });
  }

  await enrichTokens(deps, [...new Set(stored.flatMap((p) => [p.token_x.address, p.token_y.address]))]);

  const top = stored
    .filter((p) => p.tvl >= o.trackMinTvl)
    .sort((a, b) => (b.volume['24h'] ?? 0) - (a.volume['24h'] ?? 0))
    .slice(0, o.trackLimit);
  const tracked = [...top, ...stored.filter((p) => held.has(p.address) && !top.includes(p))];

  let eligible = 0;
  for (const p of tracked) {
    try {
      eligible += (await snapshotPool(deps, p, now)) ? 1 : 0;
    } catch (e) {
      log(`[collector] ${p.name}: ${(e as Error).message}`);
    }
  }
  log(`[collector] scanned ${pools.length}, stored ${stored.length}, tracked ${tracked.length}, ${eligible} eligible`);
  return { scanned: pools.length, stored: stored.length, tracked: tracked.length, eligible };
}

async function snapshotPool(deps: CollectorDeps, p: MeteoraPool, now: number): Promise<boolean> {
  const { db } = deps;
  await refreshCandles(deps, p.address, '1h');
  await refreshCandles(deps, p.address, '5m');
  const hourlyRows = await db.candle.findMany({
    where: { poolId: p.address, timeframe: '1h', ts: { gte: new Date(now - 8 * 24 * H) } },
    orderBy: { ts: 'asc' },
    select: { close: true, volume: true },
  });
  const hourly = hourlyRows.map((r) => r.close).filter((c) => c > 0);
  const fiveMin = await closes(db, p.address, '5m', now - 24 * H);
  const volatility = fiveMin.length >= 12 ? realizedVolatilityPct(fiveMin, 288) : realizedVolatilityPct(hourly.slice(-25), 24);
  // Trend and regime describe the risky token: when X is the stablecoin, read them on 1/price.
  const stableX = isStableSymbol({ symbol: p.token_x.symbol, isVerified: p.token_x.is_verified });
  const stableY = isStableSymbol({ symbol: p.token_y.symbol, isVerified: p.token_y.is_verified });
  const riskyHourly = stableX && !stableY ? hourly.map((c) => 1 / c) : hourly;
  const trend = trendState(riskyHourly);
  // Stable pairs never trend; leaving the regime inputs empty makes them count as ranging.
  const parts = hourly.length > 25 && !(stableX && stableY) ? regimeParts(riskyHourly) : null;
  // Volatility spike: the last 6 hours move more than 3x the 7-day norm.
  const recentVol = realizedVolatilityPct(hourly.slice(-7), 24);
  const normalVol = realizedVolatilityPct(hourly, 24);
  const volSpike = hourly.length > 48 && normalVol > 0 && recentVol > 3 * normalVol;

  // Volume quality and the fees LPs were actually paid (dynamic fee included).
  const volume24h = p.volume['24h'] ?? 0;
  const fees24h = p.fees['24h'] ?? null;
  const vq = volumeForScoring(volume24h, medianDailyVolume(hourlyRows.map((r) => r.volume)));
  const feeRatePct = effectiveFeePct(fees24h, volume24h, p.pool_config.base_fee_pct);
  const feeYieldDailyPct = fees24h != null && p.tvl > 0 ? (fees24h / p.tvl) * 100 : null;

  const [tx, ty] = await Promise.all([
    db.token.findUniqueOrThrow({ where: { mint: p.token_x.address } }),
    db.token.findUniqueOrThrow({ where: { mint: p.token_y.address } }),
  ]);
  const [hx, hy] = [await refreshHolders(deps, tx), await refreshHolders(deps, ty)];
  const risky = [hx, hy].filter((t) => !isStable(t));
  const mcaps = risky.map((t) => (t.mcapUsd != null ? t.mcapUsd / 1e6 : null));
  const mcapM = risky.length === 0 ? 1e6 : mcaps.some((m) => m == null) ? null : Math.min(...(mcaps as number[]));
  const holderQuality = Math.min(hx.holderQuality ?? 0.5, hy.holderQuality ?? 0.5);

  // Risk signals.
  const hourAgo = await db.poolSnapshot.findFirst({
    where: { poolId: p.address, ts: { gte: new Date(now - 75 * 60_000), lte: new Date(now - 45 * 60_000) } },
    orderBy: { ts: 'asc' },
    select: { tvl: true },
  });
  const implied = p.token_x.price && p.token_y.price ? p.token_x.price / p.token_y.price : null;
  const unlocks = await db.tokenEvent.findMany({
    where: { mint: { in: [hx.mint, hy.mint] }, kind: 'unlock', at: { gte: new Date(now), lte: new Date(now + RISK_LIMITS.unlockWarnHours * H) } },
  });
  const flags = riskFlags({
    stablePrices: [hx, hy].filter(isStableSymbol).map((t) => ({ symbol: t.symbol, priceUsd: t.priceUsd ?? 1 })),
    priceDeviationPct: implied && p.current_price > 0 ? (p.current_price / implied - 1) * 100 : null,
    tvlChange1hPct: hourAgo && hourAgo.tvl > 0 ? (p.tvl / hourAgo.tvl - 1) * 100 : null,
    upcomingUnlocks: unlocks.map((u) => ({ symbol: u.mint === hx.mint ? hx.symbol : hy.symbol, at: u.at, note: u.note })),
  });

  const params = deps.params ?? DEFAULT_PARAMS;
  const snap = {
    tvl: p.tvl,
    volume24h,
    scoringVolume: vq.volume,
    volatility,
    trend7d: trend.trend7d,
    emaBearish: trend.emaBearish,
    holderQuality,
    mcapM,
    feeYieldDailyPct,
    farmAprPct: p.has_farm ? (p.farm_apr ?? null) : null,
    efficiency: parts?.efficiency ?? null,
    change24hPct: parts?.changePct ?? null,
    aboveEma50: parts?.aboveEma50 ?? null,
    riskFlags: flags,
    pool: { baseFee: p.pool_config.base_fee_pct },
  };
  const a = assessPool(await assessmentInput(snap, hx, hy, params), DEFAULT_STRATEGY, DEFAULT_WEIGHTS.balanced, params);

  await db.poolSnapshot.create({
    data: {
      poolId: p.address,
      ts: new Date(now),
      tvl: p.tvl,
      volume24h,
      fees24h,
      activeBinLiqUsd: await activeLiquidity(deps, p, now),
      price: p.current_price,
      volatility,
      trend7d: trend.trend7d,
      emaBearish: trend.emaBearish,
      volSpike,
      feeRatePct,
      dynamicFeePct: p.dynamic_fee_pct ?? null,
      feeYieldDailyPct,
      farmAprPct: snap.farmAprPct,
      scoringVolume: vq.volume,
      volumeSpike: vq.spike,
      efficiency: snap.efficiency,
      change24hPct: snap.change24hPct,
      aboveEma50: snap.aboveEma50,
      riskFlags: flags,
      mcapM,
      holderQuality,
      score: a.score,
      scoreBreakdown: a.breakdown as unknown as object,
      call: a.call,
      callLabel: a.callLabel,
      reason: a.reason,
      eligible: a.eligible,
    },
  });
  return a.eligible;
}

/** Keeps tables bounded: 35 days of snapshots and 1h candles for 180 days, 5m for 3 days. */
export async function prune(db: PrismaClient, now = Date.now()) {
  await db.poolSnapshot.deleteMany({ where: { ts: { lt: new Date(now - 35 * 24 * H) } } });
  await db.candle.deleteMany({ where: { timeframe: '5m', ts: { lt: new Date(now - 3 * 24 * H) } } });
  await db.candle.deleteMany({ where: { timeframe: '1h', ts: { lt: new Date(now - 180 * 24 * H) } } });
}
