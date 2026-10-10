import {
  DEFAULT_STRATEGY,
  DEFAULT_WEIGHTS,
  type RiskProfile,
  type ScoreWeights,
  type StrategySettings,
  type StrategyToggles,
} from '@binwise/core';
import type { Prisma, PrismaClient, Strategy, Token } from './generated/prisma/client';

/** Shared rules about tokens, strategies and vaults used by the agent and the API. */

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'PYUSD', 'USDS', 'USDG', 'FDUSD', 'USDE']);

/** A verified token with a dollar-stablecoin symbol, whatever its price (used to spot depegs). */
export const isStableSymbol = (t: Pick<Token, 'symbol' | 'isVerified'>) => t.isVerified && STABLE_SYMBOLS.has(t.symbol.toUpperCase());

/** A verified dollar stablecoin trading near $1. */
export const isStable = (t: Pick<Token, 'symbol' | 'isVerified' | 'priceUsd'>) =>
  t.isVerified && STABLE_SYMBOLS.has(t.symbol.toUpperCase()) && t.priceUsd != null && Math.abs(t.priceUsd - 1) < 0.02;

/** Allowlist: manual override wins; otherwise verified tokens without a live freeze authority pass. */
export const isAllowed = (t: Pick<Token, 'allowed' | 'isVerified' | 'freezeAuthorityDisabled'>) =>
  t.allowed ?? (t.isVerified && t.freezeAuthorityDisabled !== false);

export function strategySettings(s: Strategy): StrategySettings {
  return {
    profile: s.profile as RiskProfile,
    maxAllocPct: s.maxAllocPct,
    minMcapM: s.minMcap,
    trendExitPct: s.trendExitPct,
    dailyStopPct: s.dailyStopPct,
    toggles: { ...DEFAULT_STRATEGY.toggles, ...(s.toggles as Partial<StrategyToggles>) },
  };
}

export const strategyWeights = (s: Strategy): ScoreWeights => ({
  ...DEFAULT_WEIGHTS[s.profile as RiskProfile],
  ...(s.weights as Partial<ScoreWeights>),
});

export function strategyData(s: StrategySettings): Omit<Prisma.StrategyUncheckedCreateInput, 'vaultId'> {
  return {
    profile: s.profile,
    maxAllocPct: s.maxAllocPct,
    minMcap: s.minMcapM,
    trendExitPct: s.trendExitPct,
    dailyStopPct: s.dailyStopPct,
    weights: { ...DEFAULT_WEIGHTS[s.profile] },
    toggles: { ...s.toggles },
  };
}

export async function ensureUser(db: PrismaClient, wallet: string) {
  return db.user.upsert({ where: { wallet }, update: {}, create: { wallet } });
}

/** New vault in paper mode with the default (balanced) strategy. */
export async function createVault(db: PrismaClient, userId: string, opts: { name?: string; isDemo?: boolean; cash?: Record<string, number> } = {}) {
  return db.vault.create({
    data: {
      userId,
      name: opts.name ?? 'Main vault',
      isDemo: opts.isDemo ?? false,
      cash: opts.cash ?? {},
      strategy: { create: strategyData(DEFAULT_STRATEGY) },
    },
    include: { strategy: true },
  });
}

/** Latest snapshot per pool, no older than `maxAgeMin` minutes. */
export async function latestSnapshots(db: PrismaClient, maxAgeMin = 10) {
  return db.poolSnapshot.findMany({
    where: { ts: { gte: new Date(Date.now() - maxAgeMin * 60_000) } },
    distinct: ['poolId'],
    orderBy: [{ poolId: 'asc' }, { ts: 'desc' }],
    include: { pool: true },
  });
}

export type SnapshotWithPool = Awaited<ReturnType<typeof latestSnapshots>>[number];

/** The active agent parameter set, or the defaults. */
export async function activeParams(db: PrismaClient) {
  const { DEFAULT_PARAMS } = await import('@binwise/core');
  const row = await db.paramSet.findFirst({ where: { active: true }, orderBy: { createdAt: 'desc' } });
  return { ...DEFAULT_PARAMS, ...((row?.params as object) ?? {}) } as typeof DEFAULT_PARAMS;
}

export const startOfUtcDay = (now: number) => new Date(Math.floor(now / 86_400_000) * 86_400_000);

/**
 * Vault value = idle cash + positions + unclaimed fees.
 * Hold value = everything ever deposited, valued at today's prices (CLAUDE.md §2).
 */
export async function vaultValue(db: PrismaClient, vaultId: string, tokens?: Map<string, Token>) {
  const vault = await db.vault.findUniqueOrThrow({ where: { id: vaultId }, include: { positions: { where: { status: 'open' } } } });
  const cash = vault.cash as Record<string, number>;
  const deposits = vault.deposits as Record<string, number>;
  const mints = [...new Set([...Object.keys(cash), ...Object.keys(deposits)])].filter((m) => !tokens?.has(m));
  const extra = mints.length ? await db.token.findMany({ where: { mint: { in: mints } } }) : [];
  const price = (m: string) => tokens?.get(m)?.priceUsd ?? extra.find((t) => t.mint === m)?.priceUsd ?? 0;
  const cashUsd = Object.entries(cash).reduce((s, [m, a]) => s + a * price(m), 0);
  const posUsd = vault.positions.reduce((s, p) => s + p.valueUsd + p.feesUnclaimedUsd, 0);
  const hold = Object.entries(deposits).reduce((s, [m, a]) => s + a * price(m), 0);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const recent = await db.position.findMany({ where: { vaultId, OR: [{ status: 'open' }, { closedAt: { gte: since } }] }, select: { feesClaimedUsd: true, feesUnclaimedUsd: true } });
  const fees = recent.reduce((s, p) => s + p.feesClaimedUsd + p.feesUnclaimedUsd, 0);
  return { value: cashUsd + posUsd, hold, fees, mode: vault.mode, status: vault.status, cycle: vault.cycle };
}

type SnapshotLike = {
  tvl: number;
  volume24h: number;
  scoringVolume: number | null;
  volatility: number;
  trend7d: number | null;
  emaBearish: boolean;
  holderQuality: number | null;
  mcapM: number | null;
  feeYieldDailyPct: number | null;
  farmAprPct: number | null;
  efficiency: number | null;
  change24hPct: number | null;
  aboveEma50: boolean | null;
  riskFlags: unknown;
  pool: { baseFee: number };
};

/** Turns a stored snapshot into scoring input, so the collector, agent and API judge pools identically. */
export async function assessmentInput(
  snap: SnapshotLike,
  tokenX: Pick<Token, 'allowed' | 'isVerified' | 'freezeAuthorityDisabled'> | undefined,
  tokenY: Pick<Token, 'allowed' | 'isVerified' | 'freezeAuthorityDisabled'> | undefined,
  params: { regimeEr: number; regimeMinMovePct: number },
) {
  const { regimeFrom } = await import('@binwise/core');
  // Missing inputs (stable pairs, too little history) count as a ranging market.
  const regime =
    snap.efficiency != null && snap.change24hPct != null && snap.aboveEma50 != null
      ? regimeFrom({ efficiency: snap.efficiency, changePct: snap.change24hPct, aboveEma50: snap.aboveEma50 }, params.regimeEr, params.regimeMinMovePct)
      : 'range';
  return {
    tvl: snap.tvl,
    volume24h: snap.scoringVolume ?? snap.volume24h,
    baseFeePct: snap.pool.baseFee,
    volatilityPct: snap.volatility,
    trend7d: snap.trend7d,
    holderQuality: snap.holderQuality,
    feeYieldDailyPct: snap.feeYieldDailyPct,
    farmAprPct: snap.farmAprPct,
    mcapM: snap.mcapM,
    bothAllowed: !!tokenX && !!tokenY && isAllowed(tokenX) && isAllowed(tokenY),
    emaBearish: snap.emaBearish,
    riskFlags: Array.isArray(snap.riskFlags) ? (snap.riskFlags as string[]) : [],
    regime,
  };
}
