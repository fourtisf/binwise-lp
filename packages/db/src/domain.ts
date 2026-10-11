import {
  DEFAULT_STRATEGY,
  DEFAULT_WEIGHTS,
  type RiskProfile,
  type ScoreWeights,
  type StrategySettings,
  type StrategyToggles,
} from '@binwise/core';
import type { Prisma, PrismaClient, Strategy, Token } from './generated/prisma/client';
import type { Proposal as ProposalView, ProposalKind } from '@binwise/core';

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
    maxPositionUsd: s.maxPositionUsd,
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
    maxPositionUsd: s.maxPositionUsd ?? 0,
    weights: { ...DEFAULT_WEIGHTS[s.profile] },
    toggles: { ...s.toggles },
  };
}

export async function ensureUser(db: PrismaClient, wallet: string) {
  return db.user.upsert({ where: { wallet }, update: {}, create: { wallet } });
}

/** New vault in paper mode with the default (balanced) strategy. */
export async function createVault(
  db: PrismaClient,
  userId: string,
  opts: { name?: string; isDemo?: boolean; cash?: Record<string, number>; live?: { agentPubkey: string; encSecret: Uint8Array<ArrayBuffer> } } = {},
) {
  return db.vault.create({
    data: {
      userId,
      name: opts.name ?? 'Main vault',
      isDemo: opts.isDemo ?? false,
      cash: opts.cash ?? {},
      ...(opts.live ? { mode: 'live' as const, agentPubkey: opts.live.agentPubkey, encSecret: opts.live.encSecret } : {}),
      strategy: { create: strategyData(DEFAULT_STRATEGY) },
    },
    include: { strategy: true },
  });
}

/**
 * After a withdrawal, shrink the hold baseline by the same share of its value, whatever token
 * was withdrawn, so net vs hold isn't distorted by money taken out.
 */
export async function shrinkDeposits(db: PrismaClient, deposits: Record<string, number>, withdrawnUsd: number) {
  const tokens = await db.token.findMany({ where: { mint: { in: Object.keys(deposits) } } });
  const holdUsd = Object.entries(deposits).reduce((s, [m, a]) => s + a * (tokens.find((t) => t.mint === m)?.priceUsd ?? 0), 0);
  const k = holdUsd > 0 ? Math.max(0, 1 - withdrawnUsd / holdUsd) : 0;
  return Object.fromEntries(Object.entries(deposits).map(([m, a]) => [m, a * k]));
}

/** Latest snapshot per pool, no older than `maxAgeMin` minutes. */
export async function latestSnapshots(db: PrismaClient, maxAgeMin = 10, now = Date.now()) {
  return db.poolSnapshot.findMany({
    where: { ts: { gte: new Date(now - maxAgeMin * 60_000) } },
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

// ---------------------------------------------------------------- manual approval

/** How long a proposal waits for an answer before it lapses (the market moves on). */
export const PROPOSAL_TTL_MIN = 60;
/** After the owner rejects something, the agent doesn't ask about it again for this long. */
export const REJECT_QUIET_HOURS = 6;

type ProposalRow = Prisma.ProposalGetPayload<object>;

export function proposalView(p: ProposalRow): ProposalView {
  const plan = (p.plan ?? {}) as { pair?: string };
  return {
    id: p.id,
    vaultId: p.vaultId,
    kind: p.kind as ProposalKind,
    poolId: p.poolId ?? undefined,
    positionId: p.positionId ?? undefined,
    pair: plan.pair ?? '',
    title: p.title,
    reason: p.reason,
    createdAt: p.createdAt.getTime(),
    expiresAt: p.expiresAt.getTime(),
  };
}

/** Proposals still waiting for the owner, newest first (lapsed ones are marked expired). */
export async function pendingProposals(db: PrismaClient, vaultId: string, now = Date.now()) {
  await db.proposal.updateMany({ where: { vaultId, status: 'pending', expiresAt: { lt: new Date(now) } }, data: { status: 'expired' } });
  return db.proposal.findMany({ where: { vaultId, status: 'pending' }, orderBy: { createdAt: 'desc' } });
}

export class ProposalError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_pending' | 'expired',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Marks a pending proposal approved (atomically, so a double click can't approve twice).
 * The caller then queues it for the agent worker.
 */
export async function approveProposal(db: PrismaClient, vaultId: string, id: string, now = Date.now()) {
  const p = await db.proposal.findFirst({ where: { id, vaultId } });
  if (!p) throw new ProposalError('not_found', 'No such proposal.');
  if (p.status === 'pending' && p.expiresAt.getTime() < now) {
    await db.proposal.update({ where: { id }, data: { status: 'expired' } });
    throw new ProposalError('expired', 'This proposal expired. The agent will propose again if it still makes sense.');
  }
  const r = await db.proposal.updateMany({ where: { id, vaultId, status: 'pending' }, data: { status: 'approved', decidedAt: new Date(now) } });
  if (!r.count) throw new ProposalError('not_pending', `This proposal was already ${p.status}.`);
  return { ...p, status: 'approved' };
}

export async function rejectProposal(db: PrismaClient, vaultId: string, id: string, now = Date.now()) {
  const p = await db.proposal.findFirst({ where: { id, vaultId } });
  if (!p) throw new ProposalError('not_found', 'No such proposal.');
  const r = await db.proposal.updateMany({ where: { id, vaultId, status: 'pending' }, data: { status: 'rejected', decidedAt: new Date(now) } });
  if (!r.count) throw new ProposalError('not_pending', `This proposal was already ${p.status}.`);
  await db.decision.create({
    data: {
      vaultId,
      poolId: p.poolId,
      type: 'skip',
      title: `You rejected: ${p.title}`,
      reason: `The agent won't propose this again for ${REJECT_QUIET_HOURS} hours.`,
      inputs: { proposalId: p.id, manual: true },
    },
  });
  return p;
}
