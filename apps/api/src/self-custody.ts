import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import {
  BRAND,
  REDIS_KEYS,
  customRangeError,
  sideOfRange,
  type CustomRange,
  type LiquidityShape,
  type LiquiditySide,
  type StreamEvent,
} from '@binwise/core';
import {
  ALLOWED_PROGRAMS,
  PolicyViolation,
  SwapRefused,
  checkSwapEffects,
  planClaim,
  planClose,
  planCompound,
  planOpen,
  planRebalance,
  readWalletPosition,
  walletBalances,
  type Amounts,
  type PoolCtx,
  type SwapCheck,
  type WalletPlanDeps,
  type WalletStep,
} from '@binwise/chain';
import { isSelfCustody, shrinkDeposits, type Decision, type PrismaClient, type Strategy, type User, type Vault } from '@binwise/db';
import { ApiError } from './errors';

const SOL = 'So11111111111111111111111111111111111111112';
/** SOL left in the owner's wallet for a new position's rent and the network fees (Add LP sizes from the rest) */
export const WALLET_KEEP_SOL = 0.1;
/** How long a prepared plan can still be recorded (the transactions themselves expire in about a minute) */
const PLAN_TTL_S = 6 * 3600;
/** After this, none of a plan's transactions can land any more (a blockhash lives about a minute). */
const PLAN_LANDS_MS = 3 * 60_000;
/**
 * Programs a signed transaction may call on its way through the relay: Binwise's own, plus Lighthouse, the guard
 * program Phantom may add to a transaction when it signs (github.com/Jac0xb/lighthouse, same id on mainnet).
 */
const RELAY_PROGRAMS = new Set([...ALLOWED_PROGRAMS, 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95']);
const planKey = REDIS_KEYS.walletPlan;
const vaultPlansKey = REDIS_KEYS.walletPlans;

/** The builders, swappable in tests (the real ones read Meteora pools on Solana). */
export interface Planner {
  open: typeof planOpen;
  close: typeof planClose;
  claim: typeof planClaim;
  compound: typeof planCompound;
  rebalance: typeof planRebalance;
  read: typeof readWalletPosition;
}
export const realPlanner: Planner = { open: planOpen, close: planClose, claim: planClaim, compound: planCompound, rebalance: planRebalance, read: readWalletPosition };

/** What the agent itself would do in a pool for this vault (the pool drawer's recommendation). */
export interface PoolAdvice {
  call: string;
  callLabel: string;
  reason: string;
  shape: LiquidityShape;
  binsEachSide: number;
  side: LiquiditySide | null;
  stableMints: string[];
}

type OwnedVault = Vault & { strategy: Strategy | null; user: User };

export interface SelfCustodyCtx {
  db: PrismaClient;
  redis: Redis;
  writable(req: FastifyRequest, id: string): Promise<OwnedVault>;
  chain(): Connection;
  killed(): Promise<boolean>;
  logDecision(vaultId: string, type: Decision['type'], title: string, reason: string, extra?: { txSig?: string; key?: string; inputs?: object }): Promise<Decision>;
  publish(vaultId: string, e: StreamEvent): Promise<unknown>;
  poolAdvice(poolId: string, strategy: Strategy | null): Promise<PoolAdvice | null>;
  /** The most Add LP may put into this pool for this vault with `budgetUsd` to spend, like the agent sizes it */
  addLimit(vault: OwnedVault, poolId: string, budgetUsd: number): Promise<{ maxUsd: number; minUsd: number; limit: string; ceilingUsd: number | null }>;
  jupiter: WalletPlanDeps['jupiter'];
  planner?: Planner;
  /** The vault lock the agent's cycle takes too: recording a plan never interleaves with a cycle */
  withVaultLock<T>(vaultId: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}

/** A prepared plan, kept until the owner's wallet has carried it out and it is recorded. */
interface StoredPlan {
  id: string;
  vaultId: string;
  owner: string;
  action: 'open' | 'close' | 'claim' | 'compound' | 'rebalance' | 'exit';
  poolId: string;
  pair: string;
  /** The position this plan closes, claims, compounds or moves */
  positionId?: string;
  /** The position this plan opens (open, rebalance) */
  opens?: { address: string; lowerBin: number; upperBin: number; amountX: number; amountY: number; shape: LiquidityShape; range?: CustomRange; manual: boolean };
  /** Estimated value coming back to the wallet (close, exit), and fees claimed */
  outUsd?: number;
  feesUsd?: number;
  proposalId?: string;
  /** Per step: what a swap may take and must deliver, checked again right before it is sent */
  checks?: ((SwapCheck & { blockhash?: string }) | null)[];
  /** Compound: the position's amounts before, to tell an added-back claim from a claim alone */
  before?: { amountX: number; amountY: number };
  createdAt: number;
}

const pairOf = (p: { tokenA: string; tokenB: string }) => `${p.tokenA} / ${p.tokenB}`;
const usdText = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Self-custody routes: Binwise never holds the funds or a key. It prepares the transactions for an action
 * (Add LP, close, claim, an approved proposal), the owner's own wallet signs them all in one approval, the
 * page sends them in order through POST /wallet/send, and POST /wallet/plans/:id/done records what the
 * chain shows happened.
 */
export function registerSelfCustody(app: FastifyInstance, c: SelfCustodyCtx) {
  const { db, redis } = c;
  const planner = c.planner ?? realPlanner;

  async function selfVault(req: FastifyRequest, id: string) {
    const v = await c.writable(req, id);
    if (!isSelfCustody(v)) throw new ApiError(400, 'not_self_custody', 'This vault keeps its funds in a vault wallet, not in your own wallet.');
    return v;
  }

  /** Real-money actions need live mode switched on for the site (LIVE_TRADING_ENABLED) and no kill switch. */
  async function mayTrade(nothing: string) {
    if (process.env.LIVE_TRADING_ENABLED !== 'true') throw new ApiError(403, 'live_disabled', `Live mode is switched off right now. ${nothing}`);
    if (await c.killed()) throw new ApiError(423, 'kill_switch', `Trading is halted right now. ${nothing}`);
  }

  /** The pool as the builders need it, from the latest snapshot (fresh) and known token prices. */
  async function poolCtx(poolId: string) {
    const snap = await db.poolSnapshot.findFirst({ where: { poolId }, orderBy: { ts: 'desc' }, include: { pool: true } });
    if (!snap) throw new ApiError(404, 'not_found', 'No market data for that pool.');
    if (Date.now() - snap.ts.getTime() > 10 * 60_000) throw new ApiError(409, 'stale', 'Market data for this pool is out of date. Try again in a minute.');
    const tokens = await db.token.findMany({ where: { mint: { in: [snap.pool.mintA, snap.pool.mintB, SOL] } } });
    const t = (m: string) => tokens.find((x) => x.mint === m);
    const [tx, ty, sol] = [t(snap.pool.mintA), t(snap.pool.mintB), t(SOL)];
    if (!tx?.priceUsd || !ty?.priceUsd || !sol?.priceUsd) throw new ApiError(409, 'no_price', 'Token prices are missing for this pool right now. Try again in a minute.');
    const ctx: PoolCtx = {
      address: snap.pool.id,
      binStep: snap.pool.binStep,
      mintX: snap.pool.mintA,
      mintY: snap.pool.mintB,
      decimalsX: tx.decimals,
      decimalsY: ty.decimals,
      price: snap.price,
      usdX: tx.priceUsd,
      usdY: ty.priceUsd,
      tvlUsd: snap.tvl,
      baseFeePct: snap.pool.baseFee,
      volume24hUsd: snap.volume24h,
    };
    const prices: Amounts = { [SOL]: sol.priceUsd, [ctx.mintX]: ctx.usdX, [ctx.mintY]: ctx.usdY };
    const symbols = { [ctx.mintX]: snap.pool.tokenA, [ctx.mintY]: snap.pool.tokenB };
    return { ctx, prices, symbols, pair: pairOf(snap.pool) };
  }

  const deps = (legacyOnly: boolean, symbols: Record<string, string>): WalletPlanDeps => ({ conn: c.chain(), jupiter: c.jupiter, legacyOnly, symbols });

  /** Turns a builder's refusal into a plain answer; anything else stays a 500. */
  const plainly = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      const m = (e as Error)?.message ?? '';
      // The builders' own messages are written for the owner.
      if (e instanceof Error && !/^(fetch failed|.*ECONN|.*timeout)/i.test(m)) throw new ApiError(400, 'cannot_prepare', m);
      throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Nothing was sent; try again in a moment.');
    }
  };

  async function store(plan: StoredPlan, steps: WalletStep[], summary: string[]) {
    // The swap's blockhash too: it tells the swap apart when a page sends it without saying which step it is.
    plan.checks = steps.map((st) => (st.check ? { ...st.check, blockhash: VersionedTransaction.deserialize(Buffer.from(st.tx, 'base64')).message.recentBlockhash } : null));
    await redis.set(planKey(plan.id), JSON.stringify(plan), 'EX', PLAN_TTL_S);
    await redis.sadd(vaultPlansKey(plan.vaultId), plan.id);
    await redis.expire(vaultPlansKey(plan.vaultId), PLAN_TTL_S);
    return { planId: plan.id, steps, summary };
  }

  async function openPositionOf(vaultId: string, positionId: string) {
    const p = await db.position.findUnique({ where: { id: positionId }, include: { pool: true } });
    if (!p || p.vaultId !== vaultId || p.status !== 'open' || !p.address) throw new ApiError(404, 'not_found', 'No open position with that id.');
    return p;
  }

  app.post<{
    Params: { id: string };
    Body: {
      action?: string;
      poolId?: string;
      sol?: number;
      shape?: string;
      range?: { below?: unknown; above?: unknown };
      override?: boolean;
      positionId?: string;
      proposalId?: string;
      legacyOnly?: boolean;
      /** Open: pool tokens already in the wallet to put in too (an Add LP that stopped half way), by mint, UI amounts */
      use?: Record<string, number>;
    };
  }>('/vaults/:id/wallet/prepare', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const v = await selfVault(req, req.params.id);
    await mayTrade('Nothing was prepared; try again later.');
    const b = req.body ?? {};
    const legacyOnly = b.legacyOnly === true;
    const base = { id: randomUUID(), vaultId: v.id, owner: v.user.wallet, createdAt: Date.now() };

    if (b.action === 'open') {
      if (v.status !== 'running') throw new ApiError(409, 'paused', 'The agent is paused. Resume it first.');
      const poolId = String(b.poolId ?? '');
      const sol = Number(b.sol ?? 0);
      if (!Number.isFinite(sol) || sol < 0 || (sol === 0 && !Object.keys(b.use ?? {}).length)) throw new ApiError(400, 'invalid_amount', 'Enter how much SOL to use.');
      const shape = b.shape as LiquidityShape | undefined;
      if (shape != null && !['spot', 'curve', 'bidask'].includes(shape)) throw new ApiError(400, 'invalid_shape', 'Shape must be spot, curve or bidask.');
      const range = b.range != null ? ({ below: Number(b.range.below), above: Number(b.range.above) } as CustomRange) : undefined;
      const bad = range && customRangeError(range);
      if (bad) throw new ApiError(400, 'invalid_range', bad);
      const advice = await c.poolAdvice(poolId, v.strategy);
      if (!advice) throw new ApiError(404, 'not_found', 'No recent data for that pool.');
      const override = advice.call !== 'in';
      if (override && b.override !== true) throw new ApiError(409, 'not_recommended', `The agent won't enter this pool right now: ${advice.reason} Tick the risk box to add anyway.`);
      // The owner's own range sets the side; else the agent's (balanced when adding against its call).
      const side = range ? sideOfRange(range) : (advice.side ?? (override ? 'both' : null));
      if (!side) throw new ApiError(409, 'downtrend', 'This pool is in a downtrend. The agent waits for the trend to turn.');
      if (await db.position.count({ where: { vaultId: v.id, poolId, status: 'open' } })) throw new ApiError(409, 'held', 'You already have a position in this pool.');
      // One Add LP per pool at a time: another one prepared moments ago may still be signed and sent.
      if ((await pendingPlans(v.id)).some((p) => p.action === 'open' && p.poolId === poolId && Date.now() - p.createdAt < PLAN_LANDS_MS))
        throw new ApiError(409, 'pending', 'An Add LP for this pool is already waiting in your wallet. Approve or reject it there first.');
      const { ctx, prices, symbols, pair } = await poolCtx(poolId);
      // Sized like the pool drawer shows it: from what the wallet can spend, after rent and fees.
      const lamports = await c
        .chain()
        .getBalance(new PublicKey(v.user.wallet))
        .catch(() => {
          throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Nothing was prepared; try again in a moment.');
        });
      const spendable = Math.max(0, lamports / 1e9 - WALLET_KEEP_SOL);
      // Pool tokens already in the wallet (what an Add LP that stopped half way swapped into), never more than it holds.
      const use: Amounts = {};
      for (const [m, a] of Object.entries(b.use ?? {})) {
        if ((m !== ctx.mintX && m !== ctx.mintY) || m === SOL) throw new ApiError(400, 'invalid_use', "Only this pool's tokens can be added from your wallet.");
        if (Number(a) > 0) use[m] = Number(a);
      }
      if (Object.keys(use).length) {
        const held = await walletBalances(c.chain(), v.user.wallet).catch(() => {
          throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Nothing was prepared; try again in a moment.');
        });
        for (const m of Object.keys(use)) use[m] = Math.min(use[m], held[m] ?? 0);
      }
      const useUsd = Object.entries(use).reduce((sum, [m, a]) => sum + a * prices[m], 0);
      if (!(sol > 0) && !(useUsd > 0)) throw new ApiError(400, 'invalid_amount', Object.keys(b.use ?? {}).length ? "Your wallet doesn't hold those tokens any more." : 'Enter how much SOL to use.');
      const lim = await c.addLimit(v, poolId, spendable * prices[SOL] + useUsd);
      if (lim.maxUsd < lim.minUsd)
        throw new ApiError(409, 'too_small', `This pool can take ${usdText(Math.max(0, lim.maxUsd))} from you now, below the ${usdText(lim.minUsd)} minimum.`);
      // Never more than the pool, your max per position and the live limits allow: all of it scaled down alike.
      const scale = Math.min(1, lim.maxUsd / (sol * prices[SOL] + useUsd));
      const decimalsOf = (m: string) => (m === ctx.mintX ? ctx.decimalsX : ctx.decimalsY);
      const floorTo = (n: number, d: number) => Math.floor(n * 10 ** d) / 10 ** d;
      const useSol = floorTo(sol * scale, 9);
      const useTokens = Object.fromEntries(Object.entries(use).map(([m, a]) => [m, floorTo(a * scale, decimalsOf(m))]).filter(([, a]) => (a as number) > 0)) as Amounts;
      const capNote = scale >= 1 ? '' : lim.limit === 'balance' ? `, what your wallet can spend after ${WALLET_KEEP_SOL} SOL for rent and fees` : ', the most this pool takes from you';
      const paying = [
        ...(useSol > 0 ? [`${useSol.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`] : []),
        ...Object.entries(useTokens).map(([m, a]) => `${a.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${symbols[m] ?? m.slice(0, 4)}`),
      ].join(' + ');
      const plan = await plainly(
        planner.open(deps(legacyOnly, symbols), {
          owner: v.user.wallet,
          pool: ctx,
          budget: { ...(useSol > 0 ? { [SOL]: useSol } : {}), ...useTokens },
          prices,
          shape: shape ?? advice.shape,
          side,
          binsEachSide: advice.binsEachSide,
          range,
        }),
      );
      const valueUsd = plan.position.amountX * ctx.usdX + plan.position.amountY * ctx.usdY;
      const summary = [
        `Into ${pair}: about ${usdText(valueUsd)} (${paying}${capNote}).`,
        `${plan.rentSol.toFixed(3)} SOL more for the position's rent and fees; the rent comes back when it closes${plan.newBinArrays ? ` (except ${plan.newBinArrays} new bin array${plan.newBinArrays > 1 ? 's' : ''})` : ''}.`,
        `The position belongs to your wallet. ${BRAND} never holds it.`,
      ];
      const stored = await store(
        {
          ...base,
          action: 'open',
          poolId,
          pair,
          opens: { ...plan.position, shape: shape ?? advice.shape, range, manual: override },
        },
        plan.steps,
        summary,
      );
      // The swaps, in step order: if the page stops after some of them, it can finish with what they brought in.
      return { ...stored, budget: { sol: useSol, use: useTokens }, swaps: plan.swaps };
    }

    if (b.action === 'close' || b.action === 'claim') {
      const p = await openPositionOf(v.id, String(b.positionId ?? ''));
      const { ctx, prices, symbols, pair } = await poolCtx(p.poolId);
      if (b.action === 'close') {
        const plan = await plainly(planner.close(deps(legacyOnly, symbols), { owner: v.user.wallet, pool: ctx, position: p.address!, prices }));
        const outUsd = Object.entries(plan.out).reduce((s, [m, a]) => s + a * (prices[m] ?? 0), 0);
        return store({ ...base, action: 'close', poolId: p.poolId, pair, positionId: p.id, outUsd, feesUsd: plan.feesUsd }, plan.steps, [
          `About ${usdText(outUsd)} comes back to your wallet, fees included, plus the position's rent.`,
        ]);
      }
      const plan = await plainly(planner.claim(deps(legacyOnly, symbols), { owner: v.user.wallet, pool: ctx, position: p.address! }));
      if (plan.feesUsd < 0.01) throw new ApiError(409, 'no_fees', 'No fees to claim yet.');
      return store({ ...base, action: 'claim', poolId: p.poolId, pair, positionId: p.id, feesUsd: plan.feesUsd }, plan.steps, [`About ${usdText(plan.feesUsd)} of fees to your wallet.`]);
    }

    if (b.action === 'proposal') {
      const pr = await db.proposal.findUnique({ where: { id: String(b.proposalId ?? '') } });
      if (!pr || pr.vaultId !== v.id || pr.status !== 'pending') throw new ApiError(404, 'not_found', 'That proposal is no longer waiting.');
      if (pr.expiresAt.getTime() < Date.now()) throw new ApiError(410, 'expired', 'That proposal expired. The agent proposes again if it still applies.');
      if (!pr.positionId) throw new ApiError(400, 'unsupported', 'Add LP by hand from the pool instead.');
      const p = await openPositionOf(v.id, pr.positionId);
      const { ctx, prices, symbols, pair } = await poolCtx(p.poolId);
      const d = deps(legacyOnly, symbols);
      const plan = pr.plan as { binsEachSide?: number; side?: LiquiditySide };
      const ref = { ...base, poolId: p.poolId, pair, positionId: p.id, proposalId: pr.id };
      if (pr.kind === 'exit') {
        // Step aside into the stable token, as the agent does on its own exits.
        const advice = await c.poolAdvice(p.poolId, v.strategy);
        const stable = advice?.stableMints ?? [];
        const quote = [ctx.mintX, ctx.mintY].find((m) => stable.includes(m));
        const risky = quote && [ctx.mintX, ctx.mintY].find((m) => !stable.includes(m));
        const out = await plainly(planner.close(d, { owner: v.user.wallet, pool: ctx, position: p.address!, prices, ...(risky && quote ? { stepAside: { risky, quote } } : {}) }));
        const outUsd = Object.entries(out.out).reduce((s, [m, a]) => s + a * (prices[m] ?? 0), 0);
        return store({ ...ref, action: 'exit', outUsd, feesUsd: out.feesUsd }, out.steps, [
          `Closes ${pair}: about ${usdText(outUsd)} back to your wallet${out.swaps.length ? `, swapped into ${symbols[quote!]}` : ''}.`,
        ]);
      }
      if (pr.kind === 'rebalance') {
        const range = p.rangeBelow != null && p.rangeAbove != null ? { below: p.rangeBelow, above: p.rangeAbove } : undefined;
        const r = await plainly(
          planner.rebalance(d, {
            owner: v.user.wallet,
            pool: ctx,
            position: p.address!,
            prices,
            shape: p.shape,
            side: range ? sideOfRange(range) : (plan.side ?? 'both'),
            binsEachSide: plan.binsEachSide ?? Math.max(1, Math.floor((p.upperBin - p.lowerBin) / 2)),
            range,
          }),
        );
        return store({ ...ref, action: 'rebalance', opens: { ...r.open.position, shape: p.shape, range, manual: p.manual }, feesUsd: r.close.feesUsd }, r.steps, [
          `Moves ${pair} to a new range around the price, same shape and width. Nothing leaves your wallet.`,
        ]);
      }
      if (pr.kind === 'compound') {
        const r = await plainly(planner.compound(d, { owner: v.user.wallet, pool: ctx, position: p.address!, lowerBin: p.lowerBin, upperBin: p.upperBin, shape: p.shape }));
        const now = await plainly(planner.read(c.chain(), ctx, p.address!));
        return store({ ...ref, action: 'compound', feesUsd: r.feesUsd, ...(now ? { before: { amountX: now.amountX, amountY: now.amountY } } : {}) }, r.steps, [`Puts about ${usdText(r.feesUsd)} of earned fees back into ${pair}.`]);
      }
      throw new ApiError(400, 'unsupported', 'Add LP by hand from the pool instead.');
    }
    throw new ApiError(400, 'invalid_action', 'Unknown action.');
  });

  /**
   * Sends one transaction the owner's wallet signed, in the order the page gives them, and waits a little
   * for Solana to confirm it. Only the owner's own transactions pass: the fee payer is their wallet and its
   * signature checks out (a simulation with signature checks), so nothing else can go through this route.
   */
  /** The swap check of the plan step `tx` is (named by the page, else found by its blockhash), if it is a swap. */
  async function swapCheckFor(vaultId: string, tx: VersionedTransaction, planId?: string, step?: number) {
    const plans = planId ? [await redis.get(planKey(planId))].filter((x): x is string => !!x).map((x) => JSON.parse(x) as StoredPlan) : await pendingPlans(vaultId);
    for (const p of plans.filter((x) => x.vaultId === vaultId)) {
      const named = planId && step != null ? p.checks?.[step] : null;
      if (named) return named;
      const byHash = p.checks?.find((ch) => ch?.blockhash && ch.blockhash === tx.message.recentBlockhash);
      if (byHash) return byHash;
    }
    return null;
  }

  app.post<{ Params: { id: string }; Body: { tx?: string; planId?: string; step?: number } }>('/vaults/:id/wallet/send', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req) => {
    const v = await selfVault(req, req.params.id);
    await mayTrade('Nothing was sent; try again later.');
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(String(req.body?.tx ?? ''), 'base64'));
    } catch {
      throw new ApiError(400, 'bad_tx', 'That is not a transaction.');
    }
    if (!tx.message.staticAccountKeys[0]?.equals(new PublicKey(v.user.wallet))) throw new ApiError(400, 'bad_tx', 'Only transactions paid by your own wallet can be sent here.');
    if (tx.signatures[0].every((b) => b === 0)) throw new ApiError(400, 'unsigned', 'Your wallet did not sign this transaction. Nothing was sent.');
    // Only the programs Binwise's own transactions use (programs always sit in the static keys, never in lookup tables).
    const keys = tx.message.staticAccountKeys;
    if (tx.message.compiledInstructions.some((ix) => !RELAY_PROGRAMS.has(keys[ix.programIdIndex]?.toBase58() ?? '')))
      throw new ApiError(400, 'bad_tx', `${BRAND} only sends its own liquidity transactions. Nothing was sent.`);
    const conn = c.chain();
    const unreachable = () => {
      throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Nothing was sent; try again in a moment.');
    };
    // A swap is checked again now, as signed and with the wallet as it is after the steps before it: only its
    // input leaves, at least its minimum arrives. Anything else is simulated as signed.
    const check = await swapCheckFor(v.id, tx, req.body?.planId ? String(req.body.planId) : undefined, Number.isInteger(req.body?.step) ? Number(req.body!.step) : undefined);
    if (check) {
      try {
        await checkSwapEffects(conn, new PublicKey(v.user.wallet), tx, check, true);
      } catch (e) {
        if (e instanceof PolicyViolation) throw new ApiError(400, 'swap_refused', `${e.message} Nothing more was sent.`);
        if (e instanceof SwapRefused) throw new ApiError(400, 'sim_failed', refusal(e.err, e.logs));
        unreachable();
      }
    } else {
      const sim = await conn.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' }).catch(unreachable);
      if (sim.value.err) throw new ApiError(400, 'sim_failed', refusal(sim.value.err, sim.value.logs));
    }
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 }).catch(unreachable);
    // Confirmations take a few seconds; the page asks again (GET …/tx/:sig) if it takes longer.
    for (let i = 0; i < 20; i++) {
      const st = (await conn.getSignatureStatuses([signature]).catch(() => null))?.value[0];
      if (st?.err) return { signature, status: 'failed', error: refusal(st.err, null) };
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return { signature, status: 'confirmed' };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { signature, status: 'pending' };
  });

  app.get<{ Params: { id: string; sig: string } }>('/vaults/:id/wallet/tx/:sig', async (req) => {
    await selfVault(req, req.params.id);
    const st = (await c.chain().getSignatureStatuses([req.params.sig], { searchTransactionHistory: true }).catch(() => null))?.value[0];
    if (!st) return { status: 'pending' };
    if (st.err) return { status: 'failed', error: refusal(st.err, null) };
    return { status: st.confirmationStatus === 'processed' ? 'pending' : 'confirmed' };
  });

  /** Plans prepared for this vault and not recorded yet (the page finishes them after a reload). */
  async function pendingPlans(vaultId: string) {
    const ids = await redis.smembers(vaultPlansKey(vaultId));
    return (await Promise.all(ids.map((id) => redis.get(planKey(id))))).filter((x): x is string => !!x).map((x) => JSON.parse(x) as StoredPlan);
  }

  app.get<{ Params: { id: string } }>('/vaults/:id/wallet/pending', async (req) => {
    const v = await selfVault(req, req.params.id);
    const plans = await pendingPlans(v.id);
    return plans.map((p) => ({ planId: p.id, action: p.action, pair: p.pair, createdAt: p.createdAt }));
  });

  /**
   * Records what an approved plan did, from what the chain shows now (not from what the page says): a new
   * position must exist in the owner's wallet; a closed one must be gone; claimed fees must have left the
   * position. Once only per plan, and under the vault lock the agent's cycle takes, so the agent never records
   * the same change. A plan that changed nothing after PLAN_LANDS_MS never will: it is dropped.
   */
  app.post<{ Params: { id: string; planId: string }; Body: { signatures?: string[] } }>('/vaults/:id/wallet/plans/:planId/done', async (req) => {
    const vaultId = (await selfVault(req, req.params.id)).id;
    return c.withVaultLock(vaultId, 60_000, () => recordPlan(req, req.params.planId, (req.body?.signatures ?? []).filter((x) => typeof x === 'string').slice(0, 20)));
  });

  async function recordPlan(req: FastifyRequest<{ Params: { id: string } }>, planId: string, sigs: string[]) {
    const v = await selfVault(req, req.params.id);
    const key = `wplan:${planId}`;
    if (await db.decision.findUnique({ where: { idempotencyKey: key } })) return { ok: true, already: true };
    const raw = await redis.get(planKey(planId));
    if (!raw) throw new ApiError(404, 'unknown_plan', 'That plan expired. If your wallet approved it, the agent picks it up on its next check.');
    const plan = JSON.parse(raw) as StoredPlan;
    if (plan.vaultId !== v.id) throw new ApiError(404, 'unknown_plan', 'No such plan.');
    const txSig = sigs.at(-1);
    const { ctx, prices } = await poolCtx(plan.poolId).catch(async () => poolCtxLoose(plan.poolId));
    const late = Date.now() - plan.createdAt > PLAN_LANDS_MS;
    const dropped = new Error('dropped');
    const waiting = () => new ApiError(409, 'not_yet', "Solana hasn't shown the result yet. Trying again in a moment.");
    const notYet = () => (late ? dropped : waiting());
    const fees = plan.feesUsd ?? 0;
    const read = (address: string) => planner.read(c.chain(), ctx, address);
    let title = '';

    /** The fees left the position (claimed), read from the chain with known prices; the position as it is now. */
    const feesClaimed = async (address: string) => {
      // Without prices the fees can't be told apart: wait rather than guess (never dropped for this).
      if (!(ctx.usdX > 0 && ctx.usdY > 0)) throw waiting();
      const onChain = await read(address);
      if (!onChain || onChain.feesUsd > Math.max(0.01, fees * 0.5)) throw notYet();
      return onChain;
    };

    const recorded = await (async (): Promise<'agent' | void> => {
      if (plan.action === 'open' && plan.opens) {
        const onChain = await read(plan.opens.address);
        if (!onChain) throw notYet();
        if (onChain.owner !== v.user.wallet) throw new ApiError(400, 'not_yours', 'That position is not in your wallet.');
        const valueUsd = onChain.amountX * ctx.usdX + onChain.amountY * ctx.usdY;
        title = `Added LP to ${plan.pair}`;
        await db.$transaction([
          db.position.create({
            data: {
              vaultId: v.id,
              poolId: plan.poolId,
              address: plan.opens.address,
              manual: plan.opens.manual,
              rangeBelow: plan.opens.range?.below ?? null,
              rangeAbove: plan.opens.range?.above ?? null,
              binStep: ctx.binStep,
              lowerBin: onChain.lowerBin,
              upperBin: onChain.upperBin,
              shape: plan.opens.shape,
              entryAmountA: onChain.amountX,
              entryAmountB: onChain.amountY,
              entryPriceA: ctx.usdX,
              entryPriceB: ctx.usdY,
              entryValueUsd: valueUsd,
              price: ctx.price,
              valueUsd,
            },
          }),
          db.vault.update({ where: { id: v.id }, data: { deposits: addDeposits(v.deposits as Amounts, ctx, onChain) } }),
          db.decision.create({
            data: { vaultId: v.id, poolId: plan.poolId, type: 'deploy', title, reason: `${usdText(valueUsd)}, ${plan.opens.shape}, approved in your wallet. The position is yours; the agent watches it and asks before any change.`, inputs: { flowUsd: valueUsd, manual: true, signatures: sigs }, txSig, idempotencyKey: key },
          }),
        ]);
      } else if ((plan.action === 'close' || plan.action === 'exit') && plan.positionId) {
        const pos = await db.position.findUniqueOrThrow({ where: { id: plan.positionId } });
        title = `${plan.action === 'exit' ? 'Exited' : 'Closed'} ${plan.pair}`;
        // The agent already saw it gone and recorded the money coming back: nothing more to count.
        if (pos.status !== 'open') return 'agent';
        if (await read(pos.address!)) throw notYet();
        const outUsd = plan.outUsd ?? pos.valueUsd + fees;
        await db.$transaction([
          // Like the agent's own closes: the position's value without its fees, the fees as claimed.
          db.position.update({ where: { id: pos.id }, data: { status: 'closed', closedAt: new Date(), valueUsd: Math.max(0, outUsd - fees), feesUnclaimedUsd: 0, feesClaimedUsd: { increment: fees } } }),
          db.vault.update({ where: { id: v.id }, data: { deposits: await shrinkDeposits(db, v.deposits as Amounts, outUsd) } }),
          db.decision.create({
            data: { vaultId: v.id, poolId: plan.poolId, type: 'exit', title, reason: `About ${usdText(outUsd)} back in your wallet, approved by you.`, inputs: { flowUsd: -outUsd, manual: true, signatures: sigs }, txSig, idempotencyKey: key },
          }),
        ]);
      } else if (plan.action === 'claim' && plan.positionId) {
        const pos = await db.position.findUniqueOrThrow({ where: { id: plan.positionId } });
        await feesClaimed(pos.address!);
        title = `Claimed fees from ${plan.pair}`;
        await recordClaim(pos.id, `About ${usdText(fees)} to your wallet.`);
      } else if (plan.action === 'compound' && plan.positionId) {
        const pos = await db.position.findUniqueOrThrow({ where: { id: plan.positionId } });
        const now = await feesClaimed(pos.address!);
        // Added back only if the position grew by the fees; else the claim landed without the add.
        const grewUsd = plan.before ? (now.amountX - plan.before.amountX) * ctx.usdX + (now.amountY - plan.before.amountY) * ctx.usdY : fees;
        if (grewUsd < fees * 0.5) {
          if (!late) throw waiting();
          title = `Claimed fees from ${plan.pair}`;
          await recordClaim(pos.id, `About ${usdText(fees)} of fees went to your wallet; adding them back didn't go through.`);
          return;
        }
        title = `Compounded fees in ${plan.pair}`;
        await db.$transaction([
          // Like the agent's compounds: claimed, and reinvested into the same range.
          db.position.update({ where: { id: pos.id }, data: { feesClaimedUsd: { increment: fees }, feesReinvestedUsd: { increment: fees }, feesUnclaimedUsd: 0 } }),
          db.decision.create({ data: { vaultId: v.id, poolId: plan.poolId, type: 'compound', title, reason: `About ${usdText(fees)} of fees added back, approved by you.`, inputs: { manual: true, signatures: sigs }, txSig, idempotencyKey: key } }),
        ]);
      } else if (plan.action === 'rebalance' && plan.positionId && plan.opens) {
        const pos = await db.position.findUniqueOrThrow({ where: { id: plan.positionId } });
        // The agent may have recorded the old range's close already (money back in the wallet).
        const closedByAgent = pos.status !== 'open';
        const onChain = await read(plan.opens.address);
        const old = await read(pos.address!);
        if (!onChain && !old && late) {
          title = `Closed ${plan.pair}`;
          if (closedByAgent) return 'agent';
          // The old range closed but the new one never opened: what came out is in the owner's wallet.
          const outUsd = pos.valueUsd + fees;
          await db.$transaction([
            db.position.update({ where: { id: pos.id }, data: { status: 'closed', closedAt: new Date(), feesUnclaimedUsd: 0, feesClaimedUsd: { increment: fees } } }),
            db.vault.update({ where: { id: v.id }, data: { deposits: await shrinkDeposits(db, v.deposits as Amounts, outUsd) } }),
            db.decision.create({
              data: { vaultId: v.id, poolId: plan.poolId, type: 'exit', title, reason: `The move closed the old range, but the new one didn't open. About ${usdText(outUsd)} is back in your wallet.`, inputs: { flowUsd: -outUsd, manual: true, signatures: sigs }, txSig, idempotencyKey: key },
            }),
          ]);
          return;
        }
        if (!onChain || old) throw notYet();
        const valueUsd = onChain.amountX * ctx.usdX + onChain.amountY * ctx.usdY;
        title = `Rebalanced ${plan.pair}`;
        await db.$transaction([
          db.position.update({
            where: { id: pos.id },
            data: {
              status: 'open',
              closedAt: null,
              address: plan.opens.address,
              lowerBin: onChain.lowerBin,
              upperBin: onChain.upperBin,
              price: ctx.price,
              valueUsd,
              inRange: true,
              ticksOut: 0,
              rebalances: { increment: 1 },
              lastRebalanceAt: new Date(),
              // Like the agent's rebalances: the fees were claimed and went into the new range.
              feesClaimedUsd: { increment: fees },
              feesReinvestedUsd: { increment: fees },
              feesUnclaimedUsd: 0,
            },
          }),
          // Counted as money out when the agent recorded the close: back in now, in the new range.
          ...(closedByAgent ? [db.vault.update({ where: { id: v.id }, data: { deposits: addDeposits(v.deposits as Amounts, ctx, onChain) } })] : []),
          db.positionMark.create({
            data: { positionId: pos.id, price: ctx.price, ...rangePrices(onChain, ctx), valueUsd, holdUsd: pos.entryAmountA * ctx.usdX + pos.entryAmountB * ctx.usdY, netVsHold: pos.netVsHold, inRange: true, rebalanced: true },
          }),
          db.decision.create({
            data: { vaultId: v.id, poolId: plan.poolId, type: 'rebalance', title, reason: 'Moved to a new range around the price, approved by you.', inputs: { manual: true, signatures: sigs, ...(closedByAgent ? { flowUsd: valueUsd } : {}) }, txSig, idempotencyKey: key },
          }),
        ]);
      } else throw new ApiError(400, 'invalid_plan', 'That plan cannot be recorded.');

      /** Fees claimed into the owner's wallet: money out of the vault, as the agent counts a withdrawal. */
      async function recordClaim(positionId: string, reason: string) {
        await db.$transaction([
          db.position.update({ where: { id: positionId }, data: { feesClaimedUsd: { increment: fees }, feesUnclaimedUsd: 0 } }),
          db.vault.update({ where: { id: v.id }, data: { deposits: await shrinkDeposits(db, v.deposits as Amounts, fees) } }),
          db.decision.create({ data: { vaultId: v.id, poolId: plan.poolId, type: 'compound', title, reason, inputs: { flowUsd: -fees, manual: true, signatures: sigs }, txSig, idempotencyKey: key } }),
        ]);
      }
    })().catch((e) => {
      if (e === dropped) return 'dropped' as const;
      // Recorded by a request that ran at the same time: the decision key is unique.
      if ((e as { code?: string })?.code === 'P2002') return 'already' as const;
      throw e;
    });
    if (recorded === 'already') return { ok: true, already: true };
    if (recorded === 'dropped') {
      await forget(plan);
      return { ok: false, dropped: true, message: 'Nothing changed on Solana for this, so nothing was recorded. Your funds are in your wallet.' };
    }

    if (plan.proposalId) await db.proposal.updateMany({ where: { id: plan.proposalId, status: { in: ['pending', 'approved'] } }, data: { status: 'done', decidedAt: new Date(), result: title } });
    await forget(plan);
    if (recorded === 'agent') return { ok: true, already: true, title };
    const d = await db.decision.findUnique({ where: { idempotencyKey: key } });
    if (d) await c.publish(v.id, { type: 'decision', decision: { id: d.id, vaultId: v.id, poolId: d.poolId ?? undefined, ts: d.ts.getTime(), type: d.type, title: d.title, reason: d.reason, txSig: d.txSig ?? undefined } });
    if (plan.proposalId) await c.publish(v.id, { type: 'proposals', pending: await db.proposal.count({ where: { vaultId: v.id, status: 'pending' } }) });
    return { ok: true, title, prices: Object.keys(prices).length };
  }

  /**
   * Drops a plan the owner's wallet never carried out (rejected, or the page stopped before sending anything):
   * its transactions only reach Solana through the page, so nothing of it can land any more.
   */
  app.post<{ Params: { id: string; planId: string } }>('/vaults/:id/wallet/plans/:planId/cancel', async (req) => {
    const v = await selfVault(req, req.params.id);
    const raw = await redis.get(planKey(req.params.planId));
    const plan = raw ? (JSON.parse(raw) as StoredPlan) : null;
    if (plan?.vaultId === v.id) await forget(plan);
    return { ok: true };
  });

  async function forget(plan: StoredPlan) {
    await redis.del(planKey(plan.id));
    await redis.srem(vaultPlansKey(plan.vaultId), plan.id);
  }

  /** For recording only: the pool even when its market data is a little old. */
  async function poolCtxLoose(poolId: string) {
    const snap = await db.poolSnapshot.findFirst({ where: { poolId }, orderBy: { ts: 'desc' }, include: { pool: true } });
    if (!snap) throw new ApiError(404, 'not_found', 'No market data for that pool.');
    const tokens = await db.token.findMany({ where: { mint: { in: [snap.pool.mintA, snap.pool.mintB] } } });
    const t = (m: string) => tokens.find((x) => x.mint === m);
    const ctx: PoolCtx = {
      address: snap.pool.id,
      binStep: snap.pool.binStep,
      mintX: snap.pool.mintA,
      mintY: snap.pool.mintB,
      decimalsX: t(snap.pool.mintA)?.decimals ?? 9,
      decimalsY: t(snap.pool.mintB)?.decimals ?? 6,
      price: snap.price,
      usdX: t(snap.pool.mintA)?.priceUsd ?? 0,
      usdY: t(snap.pool.mintB)?.priceUsd ?? 0,
      tvlUsd: snap.tvl,
      baseFeePct: snap.pool.baseFee,
      volume24hUsd: snap.volume24h,
    };
    return { ctx, prices: { [ctx.mintX]: ctx.usdX, [ctx.mintY]: ctx.usdY } as Amounts };
  }
}

/** Deposits plus a position's token amounts (money into the vault's view). */
function addDeposits(deposits: Amounts, ctx: PoolCtx, p: { amountX: number; amountY: number }): Amounts {
  const out = { ...deposits };
  out[ctx.mintX] = (out[ctx.mintX] ?? 0) + p.amountX;
  out[ctx.mintY] = (out[ctx.mintY] ?? 0) + p.amountY;
  return out;
}

/** Range bounds in UI price from on-chain bin ids (per-lamport prices), as the agent's rangePrices does. */
function rangePrices(p: { lowerBin: number; upperBin: number }, ctx: PoolCtx) {
  const f = 10 ** (ctx.decimalsX - ctx.decimalsY);
  const base = 1 + ctx.binStep / 10_000;
  return { lo: base ** p.lowerBin * f, hi: base ** (p.upperBin + 1) * f };
}

/** Why Solana refuses or failed a transaction, in plain words. */
function refusal(err: unknown, logs: string[] | null | undefined): string {
  const text = `${JSON.stringify(err)} ${(logs ?? []).join(' ')}`;
  if (/BlockhashNotFound|blockhash/i.test(text)) return 'It was approved after about a minute, so Solana no longer takes it. Nothing more was sent; try again.';
  if (/InsufficientFundsForRent/.test(text)) return 'Your wallet needs a little more SOL to stay open after this. Nothing more was sent.';
  // Custom error 1 is "insufficient funds" in both the System and the Token program.
  if (/insufficient (lamports|funds)|0x1\b|custom program error: 0x1\b|"Custom":1\}/i.test(text)) return "Your wallet doesn't hold enough for this step any more. Nothing more was sent.";
  if (/slippage|ExceededBinSlippageTolerance|0x1771|SlippageToleranceExceeded/i.test(text)) return 'The price moved too much before it landed. Nothing more was sent; try again.';
  return `Solana refused it (${JSON.stringify(err)}). Nothing more was sent.`;
}
