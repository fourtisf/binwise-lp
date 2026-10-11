import {
  assessPool,
  feeAprPct,
  type Decision as DecisionView,
  type DepositAsset,
  type PoolDetail,
  type PoolRow,
  type PositionView,
  type AgentParams,
  type StrategySettings,
  type TokenRef,
} from '@binwise/core';
import {
  activeParams,
  assessmentInput,
  isStable,
  latestSnapshots,
  startOfUtcDay,
  strategySettings,
  strategyWeights,
  vaultValue,
  type Decision,
  type PrismaClient,
  type SnapshotWithPool,
  type Strategy,
  type Token,
} from '@binwise/db';

/** Maps database rows to the API shapes the website renders. */

const PALETTE = ['#4BE3CF', '#A19BFF', '#5B95FF', '#B9F2E6', '#F6A93B', '#D9B38C', '#9ADFFF', '#C792FF', '#FF9EC3'];
const FIXED: Record<string, string> = { SOL: '#A19BFF', USDC: '#5B95FF', USDT: '#4BE3CF', JUP: '#4BE3CF' };

/** Logos bundled with the website for well-known mints (Trust Wallet assets), used when the API has none. */
const BUNDLED: Record<string, string> = {
  So11111111111111111111111111111111111111112: '/tokens/SOL.png',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: '/tokens/USDC.png',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: '/tokens/USDT.png',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: '/tokens/JUP.png',
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: '/tokens/JTO.png',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: '/tokens/BONK.png',
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: '/tokens/WIF.png',
  '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv': '/tokens/PENGU.png',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': '/tokens/RAY.png',
  '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr': '/tokens/POPCAT.png',
};

export function tokenRef(symbol: string, token?: Pick<Token, 'mint' | 'logoUrl'> | null): TokenRef {
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const logo = token?.logoUrl ?? (token ? BUNDLED[token.mint] : undefined);
  return {
    symbol,
    letter: (symbol[0] ?? '?').toUpperCase(),
    color: FIXED[symbol.toUpperCase()] ?? PALETTE[h % PALETTE.length],
    ...(logo ? { logo } : {}),
    ...(token ? { mint: token.mint } : {}),
  };
}

export const decimalsFor = (price: number) => (price >= 100 ? 2 : price >= 1 ? 4 : price >= 0.01 ? 6 : 8);

/** Pool rows, with the agent call computed for this vault's strategy when one is given. */
export async function poolRows(db: PrismaClient, strategy: Strategy | null): Promise<(PoolRow & { breakdown: PoolDetail['breakdown']; reason: string })[]> {
  const snaps = await latestSnapshots(db, 15);
  const mints = [...new Set(snaps.flatMap((s) => [s.pool.mintA, s.pool.mintB]))];
  const tokens = new Map((await db.token.findMany({ where: { mint: { in: mints } } })).map((t) => [t.mint, t]));
  const sparks = await sparkSeries(db, snaps.map((s) => s.poolId));
  const params = strategy ? await activeParams(db) : null;
  return Promise.all(snaps.map((s) => row(s, tokens, strategy, params, sparks.get(s.poolId) ?? [s.price, s.price])));
}

async function sparkSeries(db: PrismaClient, poolIds: string[]) {
  const since = new Date(Date.now() - 24 * 3600_000);
  const candles = await db.candle.findMany({ where: { poolId: { in: poolIds }, timeframe: '1h', ts: { gte: since } }, orderBy: { ts: 'asc' }, select: { poolId: true, close: true } });
  const m = new Map<string, number[]>();
  for (const c of candles) m.set(c.poolId, [...(m.get(c.poolId) ?? []), c.close]);
  return m;
}

/** FDV of the pool's smaller non-stable token, $M (0 when unknown or a stable pair). */
function fdvM(a: Token | undefined, b: Token | undefined): number {
  const risky = [a, b].filter((t): t is Token => !!t && !isStable(t));
  const v = risky.map((t) => t.fdvUsd);
  if (!risky.length || v.some((x) => x == null)) return 0;
  return Math.round((Math.min(...(v as number[])) / 1e6) * 100) / 100;
}

async function row(s: SnapshotWithPool, tokens: Map<string, Token>, strategy: Strategy | null, params: AgentParams | null, spark: number[]) {
  const base = {
    call: s.call,
    callLabel: s.callLabel,
    reason: s.reason,
    score: s.score,
    breakdown: s.scoreBreakdown as unknown as PoolDetail['breakdown'],
  };
  let v = base;
  if (strategy && params) {
    // Same inputs the agent and collector use, re-assessed with this vault's strategy.
    const a = assessPool(await assessmentInput(s, tokens.get(s.pool.mintA), tokens.get(s.pool.mintB), params), strategySettings(strategy), strategyWeights(strategy), params);
    v = { call: a.call, callLabel: a.callLabel, reason: a.reason, score: a.score, breakdown: a.breakdown };
  }
  return {
    id: s.poolId,
    pair: `${s.pool.tokenA} / ${s.pool.tokenB}`,
    tokenA: tokenRef(s.pool.tokenA, tokens.get(s.pool.mintA)),
    tokenB: tokenRef(s.pool.tokenB, tokens.get(s.pool.mintB)),
    tvl: s.tvl,
    volume24h: s.volume24h,
    volTvl: s.tvl > 0 ? s.volume24h / s.tvl : 0,
    // Fee rate actually paid (includes the dynamic fee) when known.
    feeApr: feeAprPct(s.volume24h, s.tvl, s.feeRatePct ?? s.pool.baseFee),
    baseFee: s.pool.baseFee,
    trend7d: s.trend7d ?? 0,
    volatility: Math.round(s.volatility * 10) / 10,
    mcapM: s.mcapM != null ? Math.round(s.mcapM * 100) / 100 : 0,
    fdvM: fdvM(tokens.get(s.pool.mintA), tokens.get(s.pool.mintB)),
    spark,
    score: v.score,
    call: v.call as PoolRow['call'],
    callLabel: v.callLabel,
    reason: v.reason,
    breakdown: v.breakdown,
  };
}

export function decisionView(d: Decision): DecisionView {
  return { id: d.id, vaultId: d.vaultId, poolId: d.poolId ?? undefined, ts: d.ts.getTime(), type: d.type, title: d.title, reason: d.reason, txSig: d.txSig ?? undefined };
}

export async function positionViews(db: PrismaClient, vaultId: string): Promise<PositionView[]> {
  const ps = await db.position.findMany({ where: { vaultId, status: 'open' }, include: { pool: true }, orderBy: { openedAt: 'asc' } });
  const tokens = await tokenMap(db, ps.flatMap((p) => [p.pool.mintA, p.pool.mintB]));
  const out: PositionView[] = [];
  for (const p of ps) {
    const marks = (await db.positionMark.findMany({ where: { positionId: p.id }, orderBy: { ts: 'desc' }, take: 70 })).reverse();
    const last = marks.at(-1);
    const history = marks.length >= 3 ? marks.map((m) => m.price) : [p.price, p.price, p.price];
    out.push({
      id: p.id,
      poolId: p.poolId,
      pair: `${p.pool.tokenA} / ${p.pool.tokenB}`,
      tokenA: tokenRef(p.pool.tokenA, tokens.get(p.pool.mintA)),
      tokenB: tokenRef(p.pool.tokenB, tokens.get(p.pool.mintB)),
      shape: p.shape,
      value: p.valueUsd,
      fees: p.feesClaimedUsd + p.feesUnclaimedUsd,
      il: p.entryValueUsd > 0 && last ? (last.valueUsd / last.holdUsd - 1) * 100 : 0,
      netVsHold: p.netVsHold,
      rebalances: p.rebalances,
      inRange: p.inRange,
      chart: {
        history,
        lo: last?.lo ?? p.price * 0.98,
        hi: last?.hi ?? p.price * 1.02,
        markers: marks.flatMap((m, i) => (m.rebalanced ? [i] : [])),
        decimals: decimalsFor(p.price),
      },
    });
  }
  return out;
}

async function paperAssets(db: PrismaClient, wallet: Record<string, number>): Promise<DepositAsset[]> {
  const tokens = await db.token.findMany({ where: { mint: { in: Object.keys(wallet) } } });
  return tokens
    .filter((t) => t.priceUsd != null)
    .sort((a, b) => (a.symbol === 'SOL' ? -1 : b.symbol === 'SOL' ? 1 : 0))
    .map((t) => ({ ...tokenRef(t.symbol, t), mint: t.mint, decimals: t.decimals, priceUsd: t.priceUsd!, balance: wallet[t.mint] ?? 0 }));
}

export async function overview(db: PrismaClient, vaultId: string, opts: { readOnly: boolean; walletAssets?: DepositAsset[] }) {
  const vault = await db.vault.findUniqueOrThrow({ where: { id: vaultId } });
  const v = await vaultValue(db, vaultId);
  const now = Date.now();
  const today = await db.vaultSnapshot.findFirst({ where: { vaultId, ts: { gte: startOfUtcDay(now) } }, orderBy: { ts: 'asc' } });
  const ago30 = await db.vaultSnapshot.findFirst({ where: { vaultId, ts: { lte: new Date(now - 30 * 86_400_000) } }, orderBy: { ts: 'desc' } });
  const ratio = v.hold > 0 ? v.value / v.hold : 1;
  const net30 = ago30 && ago30.holdValue > 0 ? (ratio / (ago30.value / ago30.holdValue) - 1) * 100 : (ratio - 1) * 100;
  const marks = await db.positionMark.groupBy({
    by: ['inRange'],
    where: { position: { vaultId }, ts: { gte: new Date(now - 30 * 86_400_000) } },
    _count: true,
  });
  const total = marks.reduce((s, m) => s + m._count, 0);
  const inR = marks.find((m) => m.inRange)?._count ?? 0;
  const spark = (await db.vaultSnapshot.findMany({ where: { vaultId }, orderBy: { ts: 'desc' }, take: 30, select: { value: true } })).map((x) => x.value).reverse();
  return {
    id: vault.id,
    name: vault.name,
    mode: vault.mode,
    status: vault.status,
    cycle: vault.cycle,
    value: v.value,
    openValue: today?.value ?? v.value,
    fees30d: v.fees,
    netVsHold30d: net30,
    timeInRange30d: total ? (inR / total) * 100 : null,
    spark: spark.length >= 2 ? spark : [v.value, v.value],
    depositAssets: vault.mode === 'paper' ? await paperAssets(db, vault.paperWallet as Record<string, number>) : opts.walletAssets ?? [],
    depositAddress: vault.mode === 'live' ? vault.agentPubkey : null,
    readOnly: opts.readOnly,
    pausedReason: vault.pausedReason,
  };
}

/** Daily vault vs hold points; hourly when the vault is younger than two days. */
export async function performance(db: PrismaClient, vaultId: string, range: 7 | 30 | 90) {
  const since = new Date(Date.now() - range * 86_400_000);
  const snaps = await db.vaultSnapshot.findMany({ where: { vaultId, ts: { gte: since } }, orderBy: { ts: 'asc' } });
  const spanDays = snaps.length ? (snaps.at(-1)!.ts.getTime() - snaps[0].ts.getTime()) / 86_400_000 : 0;
  const pick = spanDays < 2 ? snaps : [...new Map(snaps.map((s) => [s.ts.toISOString().slice(0, 10), s])).values()];
  return { range, ts: pick.map((s) => s.ts.getTime()), vault: pick.map((s) => s.value), hold: pick.map((s) => s.holdValue) };
}

export function strategyView(s: Strategy): StrategySettings {
  return strategySettings(s);
}

export async function tokenMap(db: PrismaClient, mints: string[]) {
  return new Map((await db.token.findMany({ where: { mint: { in: [...new Set(mints)] } } })).map((t) => [t.mint, t]));
}
