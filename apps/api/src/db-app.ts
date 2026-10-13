import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  BRAND,
  DEFAULT_STRATEGY,
  MAX_BINS_EACH_SIDE,
  MAX_POSITION_BINS,
  REDIS_KEYS,
  bestPerPair,
  binsForHalfWidth,
  customRangeError,
  rangeHalfWidth,
  shapeFor,
  sideForRegime,
  isBridgedSymbol,
  manualDeployLimit,
  pairKey,
  positionCapUsd,
  validateStrategy,
  type CustomRange,
  type DecisionType,
  type DemoEvent,
  type LiquidityShape,
  type DepositAsset,
  type StrategySettings,
  type Portfolio,
  type PortfolioHolding,
  type StreamEvent,
  type TokenRef,
  type VaultBalance,
  type Withdrawable,
} from '@binwise/core';
import {
  JupiterClient,
  LiveExecutor,
  DuplicateAction,
  PolicyViolation,
  SimulationFailed,
  TradingHalted,
  TxFailed,
  SOL_RESERVE,
  isLiveWallet,
  liveLimits,
  minPositionUsd,
  walletBalances,
  walletTokens,
  WalletReader,
  parseDeposit,
  createAgentKey,
  loadAgentKey,
  makeConnection,
} from '@binwise/chain';
import {
  ProposalError,
  activeParams,
  approveProposal,
  assessmentInput,
  createVault,
  ensureUser,
  pendingProposals,
  proposalView,
  rejectProposal,
  isStable,
  liveTotalUsd,
  shrinkDeposits as shrinkDepositsOf,
  strategySettings as strategySettingsOf,
  strategyData,
  isSelfCustody,
  type PrismaClient,
  type Strategy,
  type Vault,
} from '@binwise/db';
import { SESSION_COOKIE, SIGN_IN_STATEMENT, SESSION_DAYS, makeSession, newNonce, readSession, signInMessage, verifyWalletSignature } from './auth';
import { ApiError } from './errors';
import { EventHub } from './events';
import { WALLET_KEEP_SOL, registerSelfCustody, type Planner } from './self-custody';
import { decisionView, overview, performance, poolRows, positionViews, tokenMap, tokenRef } from './views';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TYPES: DecisionType[] = ['scan', 'deploy', 'rebalance', 'exit', 'compound', 'hold', 'skip'];
const CYCLE_MS = 60_000;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** SOL a vault wallet may still hold when its key is deleted: what a withdrawal leaves behind */
const RELEASE_DUST_SOL = 0.003;

export { ApiError };

export interface DbAppOptions {
  db: PrismaClient;
  redis: Redis;
  /** Separate connection for pub/sub */
  sub: Redis;
  corsOrigins?: string[];
  logger?: boolean;
  /** e.g. binwise.org, shown in the sign-in message */
  domain?: string;
  secureCookies?: boolean;
  rpc?: () => Connection;
  /** Token names, logos and prices for mints the collector doesn't track (Jupiter) */
  jupiter?: Pick<JupiterClient, 'tokens'>;
  /** Self-custody: Jupiter quotes and swap transactions for the owner's wallet */
  swaps?: Pick<JupiterClient, 'quote' | 'swap'>;
  /** Self-custody transaction builders (tests swap them for stand-ins) */
  planner?: Planner;
  /** DLMM positions a wallet holds on Solana (tests swap it for a stand-in) */
  positionsOf?: (conn: Connection, owner: string) => Promise<unknown[]>;
}

/**
 * Production API (CLAUDE.md §5): Postgres + Redis, Sign-In With Solana,
 * per-user vaults, and a public read-only demo vault for the landing page.
 */
export async function buildDbApp(o: DbAppOptions): Promise<FastifyInstance> {
  const { db, redis } = o;
  const hub = new EventHub(o.sub);
  await hub.start();
  const rpc = o.rpc ?? (() => makeConnection());
  /** RPC for money routes: a missing or unreachable node is a clear, retryable error, not a 500. */
  const chain = () => {
    try {
      return rpc();
    } catch {
      throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Nothing was sent; try again in a moment.');
    }
  };
  const liveEnabled = () => process.env.LIVE_TRADING_ENABLED === 'true';
  /** DEFAULT_VAULT_MODE=live: new wallets start on mainnet (needs live trading on, an RPC, and the wallet allowed). */
  const liveByDefault = (wallet: string) =>
    process.env.DEFAULT_VAULT_MODE === 'live' && liveEnabled() && !!process.env.RPC_URL && isLiveWallet(wallet);

  // Only nginx on this machine may set X-Forwarded-For; otherwise clients could spoof their IP past rate limits.
  const app = Fastify({ logger: o.logger ?? false, trustProxy: '127.0.0.1' });
  await app.register(cors, { origin: o.corsOrigins?.length ? o.corsOrigins : false, credentials: true });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(websocket);
  app.addHook('onClose', async () => hub.stop());

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? 'internal' : 'bad_request', message: status >= 500 ? 'Something went wrong.' : e.message });
  });

  // ---------- helpers ----------

  const userId = (req: FastifyRequest) => readSession(req.cookies[SESSION_COOKIE]);
  const requireUser = (req: FastifyRequest) => {
    const uid = userId(req);
    if (!uid) throw new ApiError(401, 'unauthenticated', 'Connect your wallet to do that.');
    return uid;
  };
  const demoVault = () => db.vault.findFirst({ where: { isDemo: true }, orderBy: { createdAt: 'asc' } });

  /** Read access: owner, or anyone for the demo vault. */
  async function readable(req: FastifyRequest, id: string) {
    const v = await db.vault.findUnique({ where: { id }, include: { strategy: true } });
    if (!v) throw new ApiError(404, 'not_found', 'No vault with that id.');
    if (v.isDemo) return { vault: v, readOnly: v.userId !== userId(req) };
    if (v.userId !== userId(req)) throw new ApiError(404, 'not_found', 'No vault with that id.');
    return { vault: v, readOnly: false };
  }
  async function writable(req: FastifyRequest, id: string) {
    const uid = requireUser(req);
    const v = await db.vault.findUnique({ where: { id }, include: { strategy: true, user: true } });
    if (!v || v.userId !== uid) throw new ApiError(404, 'not_found', 'No vault with that id.');
    if (v.isDemo) throw new ApiError(403, 'read_only', 'The demo vault is read-only.');
    return v;
  }

  /** Self-custody: the funds are in the owner's own wallet, so vault deposits and withdrawals don't apply. */
  const notSelfCustody = (v: { mode: string; custody: string }) => {
    if (isSelfCustody(v)) throw new ApiError(400, 'self_custody', `Your funds stay in your own wallet: nothing to deposit to or withdraw from ${BRAND}.`);
  };
  /**
   * Vault wallets Binwise holds the key of are winding down: no new money goes in and no new positions open.
   * Owners withdraw to their own wallet; open positions are still looked after until they close them.
   */
  const noNewCustody = (v: { mode: string; custody: string; encSecret: unknown }) => {
    if (v.mode === 'live' && v.custody === 'agent' && v.encSecret)
      throw new ApiError(
        409,
        'custody_closing',
        `${BRAND} no longer keeps funds for you: your money stays in your own wallet. Withdraw this vault's funds to your wallet (Portfolio → Withdraw); then add LP straight from your wallet.`,
      );
  };

  async function walletAssets(wallet: string): Promise<DepositAsset[]> {
    if (!o.rpc && !process.env.RPC_URL) return [];
    const conn = rpc();
    const owner = new PublicKey(wallet);
    const tokens = await db.token.findMany({ where: { OR: [{ mint: SOL_MINT }, { symbol: 'USDC', isVerified: true }] }, orderBy: { mcapUsd: 'desc' } });
    const out: DepositAsset[] = [];
    for (const t of tokens.filter((t, i, a) => a.findIndex((x) => x.symbol === t.symbol) === i)) {
      // One token that can't be read doesn't hide the others.
      try {
        let balance = 0;
        if (t.mint === SOL_MINT) balance = (await conn.getBalance(owner)) / 1e9;
        else {
          const accs = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(t.mint) });
          balance = accs.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
        }
        out.push({ ...tokenRef(t.symbol, t), mint: t.mint, decimals: t.decimals, priceUsd: t.priceUsd ?? 0, balance });
      } catch {
        continue;
      }
    }
    return out;
  }

  const publish = (vaultId: string, e: StreamEvent) => redis.publish(REDIS_KEYS.events(vaultId), JSON.stringify(e));
  const killed = async () => (await redis.get(REDIS_KEYS.kill)) === '1';

  /**
   * Same per-vault lock the agent worker takes, so money moves from the app (deposit, withdraw,
   * mode switch) never interleave with an agent cycle. Waits up to ~15s for a running cycle.
   */
  async function withVaultLock<T>(vaultId: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const token = randomUUID();
    for (let i = 0; i < 60; i++) {
      if ((await redis.set(REDIS_KEYS.lock(vaultId), token, 'PX', ttlMs, 'NX')) === 'OK') {
        const renew = setInterval(
          () =>
            void redis
              .eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end", 1, REDIS_KEYS.lock(vaultId), token, ttlMs)
              .catch(() => {}),
          Math.max(1000, Math.floor(ttlMs / 3)),
        );
        try {
          return await fn();
        } finally {
          clearInterval(renew);
          await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, REDIS_KEYS.lock(vaultId), token);
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new ApiError(409, 'vault_busy', 'The agent is working on this vault right now. Try again in a few seconds.');
  }

  /**
   * Token amounts with symbols, logos and USD values: the total, and the ones worth listing (no dust or
   * unknown tokens), largest first with SOL on top.
   */
  async function pricedTokens(amounts: Record<string, number>) {
    const tokens = await tokenMap(db, Object.keys(amounts));
    const all = Object.entries(amounts).map(([mint, amount]) => {
      const t = tokens.get(mint);
      const symbol = mint === SOL_MINT ? 'SOL' : (t?.symbol ?? `${mint.slice(0, 4)}…`);
      return { symbol, mint, amount, usd: amount * (t?.priceUsd ?? 0), token: tokenRef(symbol, t) };
    });
    const shown = all
      .filter((a) => a.amount > 1e-9 && (a.mint === SOL_MINT || a.usd >= 0.01))
      .sort((a, b) => (a.mint === SOL_MINT ? -1 : b.mint === SOL_MINT ? 1 : b.usd - a.usd));
    return { totalUsd: all.reduce((sum, a) => sum + a.usd, 0), shown };
  }

  const jupiter = o.jupiter ?? new JupiterClient();
  type TokenInfo = { ref: TokenRef; priceUsd: number | null };
  /**
   * Symbol, logo and USD price for any mints: our token table first (what the agent prices with), then
   * Jupiter for the rest, cached 10 minutes. A mint nobody knows shows as its short address, unpriced.
   */
  async function tokenInfo(mints: string[]): Promise<Map<string, TokenInfo>> {
    const out = new Map<string, TokenInfo>();
    const known = await tokenMap(db, mints);
    for (const m of mints) {
      const t = known.get(m);
      if (t) out.set(m, { ref: tokenRef(m === SOL_MINT ? 'SOL' : t.symbol, t), priceUsd: t.priceUsd ?? null });
    }
    const missing = mints.filter((m) => !out.has(m));
    const cacheKey = (m: string) => `binwise:tokinfo:${m}`;
    const cached = missing.length ? await redis.mget(...missing.map(cacheKey)) : [];
    const lookup: string[] = [];
    missing.forEach((m, i) => {
      if (cached[i] == null) return void lookup.push(m);
      const c = JSON.parse(cached[i]!) as { symbol: string; icon?: string; usdPrice?: number } | null;
      if (c) out.set(m, { ref: tokenRef(c.symbol, { mint: m, logoUrl: c.icon ?? null }), priceUsd: c.usdPrice ?? null });
    });
    if (lookup.length) {
      const found = await jupiter.tokens(lookup, { timeoutMs: 4000, retries: 0 }).catch(() => null);
      if (found) {
        const byMint = new Map(found.map((t) => [t.id, t]));
        for (const m of lookup) {
          const t = byMint.get(m);
          const c = t ? { symbol: t.symbol, icon: t.icon, usdPrice: t.usdPrice } : null;
          await redis.set(cacheKey(m), JSON.stringify(c), 'EX', 600);
          if (c) out.set(m, { ref: tokenRef(c.symbol, { mint: m, logoUrl: c.icon ?? null }), priceUsd: c.usdPrice ?? null });
        }
      }
    }
    for (const m of mints) if (!out.has(m)) out.set(m, { ref: tokenRef(`${m.slice(0, 4)}…${m.slice(-4)}`, { mint: m, logoUrl: null }), priceUsd: null });
    return out;
  }

  /** Every token in an amount map (above zero) with what we know about it: priced ones by value, then the rest. */
  async function describeTokens(amounts: Record<string, number>) {
    const mints = Object.keys(amounts).filter((m) => amounts[m] > 1e-12);
    const info = await tokenInfo(mints);
    const list = mints.map((mint) => {
      const t = info.get(mint)!;
      return { mint, amount: amounts[mint], token: t.ref, value: t.priceUsd != null ? amounts[mint] * t.priceUsd : null };
    });
    list.sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.token.symbol.localeCompare(b.token.symbol));
    return { list, totalUsd: list.reduce((sum, a) => sum + (a.value ?? 0), 0) };
  }

  /** USD value of a token map at current prices. */
  async function usdValue(amounts: Record<string, number>) {
    const tokens = await db.token.findMany({ where: { mint: { in: Object.keys(amounts) } } });
    return Object.entries(amounts).reduce((s, [m, a]) => s + a * (tokens.find((t) => t.mint === m)?.priceUsd ?? 0), 0);
  }

  /** See shrinkDeposits in @binwise/db. */
  const shrinkDeposits = (deposits: Record<string, number>, withdrawnUsd: number) => shrinkDepositsOf(db, deposits, withdrawnUsd);

  const moneyLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  const fmt = (n: number, d = 2) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  async function logDecision(
    vaultId: string,
    type: DecisionType,
    title: string,
    reason: string,
    extra: { txSig?: string; key?: string; inputs?: object } = {},
  ) {
    const d = await db.decision.create({ data: { vaultId, type, title, reason, inputs: extra.inputs ?? {}, txSig: extra.txSig, idempotencyKey: extra.key } });
    await publish(vaultId, { type: 'decision', decision: decisionView(d) });
    return d;
  }

  // ---------- health ----------

  app.get('/health', async () => ({ ok: true, mode: 'db', liveTrading: liveEnabled(), killSwitch: await killed() }));

  // ---------- auth ----------

  const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  app.get<{ Querystring: { wallet?: string } }>('/auth/nonce', authLimit, async (req) => {
    // The wallet is optional: a standard Sign In With Solana request connects and signs in one step,
    // so the address is only known once the wallet answers (the signature then proves it).
    const wallet = req.query.wallet || null;
    if (wallet)
      try {
        new PublicKey(wallet);
      } catch {
        throw new ApiError(400, 'bad_wallet', 'That is not a Solana wallet address.');
      }
    const nonce = newNonce();
    const issuedAt = new Date().toISOString();
    const domain = o.domain ?? BRAND;
    const message = wallet ? signInMessage(wallet, nonce, issuedAt, domain) : null;
    // Keyed by the nonce itself, so requesting a new message can't invalidate someone else's.
    await redis.set(REDIS_KEYS.nonce(nonce), JSON.stringify({ message, wallet }), 'EX', 300);
    // `message` for signMessage; the rest for wallets that sign in with the standard Sign In With Solana flow.
    return { message, nonce, domain, issuedAt, statement: SIGN_IN_STATEMENT };
  });

  app.post<{ Body: { wallet?: string; message?: string; signature?: string } }>('/auth/verify', authLimit, async (req, reply) => {
    const { wallet = '', message = '', signature = '' } = req.body ?? {};
    const nonce = /\nNonce: ([0-9a-f]{32})(?:\n|$)/.exec(message)?.[1];
    // GETDEL: a nonce can be used exactly once, even by two requests at the same time.
    const raw = nonce ? await redis.getdel(REDIS_KEYS.nonce(nonce)) : null;
    let issued: { message: string | null; wallet: string | null } | null = null;
    try {
      issued = raw ? (JSON.parse(raw) as { message: string | null; wallet: string | null }) : null;
    } catch {
      issued = null;
    }
    // Either our own message exactly, or the standard Sign In With Solana message the wallet built
    // for this domain, this wallet and this nonce. A nonce issued for one wallet only works for it.
    const ok =
      !!issued &&
      (issued.wallet === null || issued.wallet === wallet) &&
      ((issued.message !== null && message === issued.message) ||
        message.startsWith(`${o.domain ?? BRAND} wants you to sign in with your Solana account:\n${wallet}\n`));
    if (!ok) throw new ApiError(400, 'bad_nonce', 'Sign-in request expired. Try again.');
    if (!verifyWalletSignature(wallet, message, signature)) throw new ApiError(401, 'bad_signature', 'Signature check failed.');
    const user = await ensureUser(db, wallet);
    if (!(await db.vault.count({ where: { userId: user.id } }))) {
      if (liveByDefault(wallet)) {
        // Mainnet by default, self-custody: the funds stay in the owner's own wallet and Binwise holds no key.
        const v = await createVault(db, user.id, { selfCustody: true });
        await logDecision(v.id, 'scan', 'Vault created', `Your funds stay in your own wallet: ${BRAND} holds no key. Add LP from a pool and approve it in your wallet; the agent watches your positions and asks before any change.`);
      } else {
        const usdc = await db.token.findFirst({ where: { symbol: 'USDC', isVerified: true }, orderBy: { mcapUsd: 'desc' } });
        const v = await createVault(db, user.id);
        await db.vault.update({ where: { id: v.id }, data: { paperWallet: { [SOL_MINT]: 100, ...(usdc ? { [usdc.mint]: 10_000 } : {}) } } });
      }
    }
    reply.setCookie(SESSION_COOKIE, makeSession(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: o.secureCookies ?? process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: SESSION_DAYS * 86400,
    });
    return { ok: true };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /**
   * Mainnet site (DEFAULT_VAULT_MODE=live): an owner's simulated (paper) vault becomes a real mainnet
   * vault. Its simulated balance, open simulated positions and performance history are dropped, so
   * every number shown afterwards comes from the chain.
   */
  async function moveToMainnet(userId: string, wallet: string) {
    if (!liveByDefault(wallet)) return;
    for (const { id } of await db.vault.findMany({ where: { userId, mode: 'paper', isDemo: false }, select: { id: true } })) {
      await withVaultLock(id, 60_000, async () => {
        const v = await db.vault.findUnique({ where: { id } });
        if (!v || v.mode !== 'paper') return;
        // A vault that already has a vault wallet keeps it (its funds must stay reachable); any other goes self-custody.
        const hasKey = !!(v.agentPubkey && v.encSecret);
        await db.$transaction([
          db.position.updateMany({ where: { vaultId: id, status: 'open' }, data: { status: 'closed', closedAt: new Date() } }),
          db.vaultSnapshot.deleteMany({ where: { vaultId: id } }),
          db.proposal.updateMany({ where: { vaultId: id, status: 'pending' }, data: { status: 'expired' } }),
          db.vault.update({ where: { id }, data: { mode: 'live', cash: {}, deposits: {}, paperWallet: {}, ...(hasKey ? {} : { custody: 'wallet' as const }) } }),
        ]);
        await redis.del(REDIS_KEYS.actions(id));
        await logDecision(
          id,
          'scan',
          'Moved to mainnet',
          hasKey
            ? 'This vault now uses real funds on Solana mainnet. The simulated balance was removed.'
            : `This vault now uses real funds on Solana mainnet, kept in your own wallet: ${BRAND} holds no key. Add LP from a pool and approve it in your wallet.`,
        );
      }).catch(() => {}); // busy right now: tried again on the next page load
    }
  }

  app.get('/me', async (req) => {
    const uid = requireUser(req);
    const owner = await db.user.findUniqueOrThrow({ where: { id: uid } });
    await moveToMainnet(uid, owner.wallet);
    const user = await db.user.findUniqueOrThrow({ where: { id: uid }, include: { vaults: { orderBy: { createdAt: 'asc' } } } });
    return {
      wallet: user.wallet,
      vaults: user.vaults.map((v) => ({ id: v.id, name: v.name, mode: v.mode })),
      telegramLinked: !!user.telegramChatId,
    };
  });

  app.post('/me/telegram/link', async (req) => {
    const uid = requireUser(req);
    const code = randomUUID().replace(/-/g, '').slice(0, 16);
    await db.user.update({ where: { id: uid }, data: { telegramLinkCode: code, telegramLinkCodeAt: new Date() } });
    const bot = process.env.TELEGRAM_BOT_USERNAME;
    return { code, url: bot ? `https://t.me/${bot}?start=${code}` : null };
  });

  // ---------- public ----------

  app.get('/vaults/demo', async () => {
    const v = await demoVault();
    if (!v) throw new ApiError(404, 'no_demo', 'The demo vault has not been created yet.');
    return { id: v.id };
  });

  app.get('/backtests/latest', async () => {
    // Latest backtest, with the latest settings search (optimiser) appended when there is one.
    const runs = await db.backtestRun.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const isOpt = (x: (typeof runs)[number]) => (x.params as { kind?: string } | null)?.kind === 'optimize';
    const r = runs.find((x) => !isOpt(x));
    const opt = runs.find(isOpt);
    if (!r && !opt) throw new ApiError(404, 'no_backtest', 'No backtest has been run yet.');
    const main = r ?? opt!;
    const report = r && opt ? `${r.report}\n\n---\n\n${opt.report}` : main.report;
    return { createdAt: main.createdAt.getTime(), report, summary: main.summary };
  });

  app.get<{ Querystring: { vault?: string } }>('/pools', async (req) => {
    const strategy = req.query.vault ? (await readable(req, req.query.vault)).vault.strategy : null;
    const rows = (await poolRows(db, strategy)).filter((r) => !isBridgedSymbol(r.tokenA.symbol) && !isBridgedSymbol(r.tokenB.symbol));
    // One row per pair: its most liquid pool (a pair can have several pools with different bin steps and fees).
    const side = (t: { mint?: string; symbol: string }) => t.mint ?? t.symbol;
    // A pool the agent would enter wins over a deeper one it wouldn't.
    const better = (a: (typeof rows)[number], b: (typeof rows)[number]) => ((a.call === 'in') !== (b.call === 'in') ? a.call === 'in' : a.tvl > b.tvl);
    return bestPerPair(rows, (r) => pairKey(side(r.tokenA), side(r.tokenB)), better).map(({ breakdown: _b, reason: _r, ...row }) => row);
  });

  /**
   * For Add LP by hand: the pool row (the agent's call with this strategy), and the price, bins, shape, width
   * and side the agent itself would use here. Null without recent data.
   */
  async function poolDetail(poolId: string, strategy: Strategy | null) {
    const row = (await poolRows(db, strategy)).find((r) => r.id === poolId);
    if (!row) return null;
    const snap = await db.poolSnapshot.findFirst({ where: { poolId: row.id }, orderBy: { ts: 'desc' }, include: { pool: true } });
    if (!snap) return { row, lp: null, stableMints: [] as string[] };
    const toks = await tokenMap(db, [snap.pool.mintA, snap.pool.mintB]);
    const a = toks.get(snap.pool.mintA);
    const b = toks.get(snap.pool.mintB);
    const stablePair = !!a && !!b && isStable(a) && isStable(b);
    const profile = strategy ? strategySettingsOf(strategy).profile : DEFAULT_STRATEGY.profile;
    const params = await activeParams(db);
    // The side the agent picks from the risky token's regime (one-sided in an uptrend, nothing in a downtrend).
    const { regime } = await assessmentInput(snap, a, b, params);
    const riskyIsY = !!a && !!b && isStable(a) && !isStable(b);
    return {
      row,
      stableMints: [a, b].filter((t): t is NonNullable<typeof t> => !!t && isStable(t)).map((t) => t.mint),
      lp: {
        price: snap.price,
        binStep: snap.pool.binStep,
        shape: shapeFor(profile, stablePair, snap.volatility),
        binsEachSide: Math.min(MAX_BINS_EACH_SIDE, binsForHalfWidth(rangeHalfWidth(profile, snap.volatility, stablePair, params), snap.pool.binStep)),
        maxBins: MAX_POSITION_BINS,
        side: sideForRegime(regime, params, riskyIsY),
        regime,
        volatility: snap.volatility,
        profile,
        stable: stablePair,
      },
    };
  }

  app.get<{ Params: { id: string }; Querystring: { vault?: string } }>('/pools/:id', async (req) => {
    const strategy = req.query.vault ? (await readable(req, req.query.vault)).vault.strategy : null;
    const d = await poolDetail(req.params.id, strategy);
    if (!d) throw new ApiError(404, 'not_found', 'No recent data for that pool.');
    return d.lp ? { ...d.row, lp: d.lp } : d.row;
  });

  // ---------- vault reads ----------

  type VP = { Params: { id: string } };

  app.get<VP>('/vaults/:id/overview', async (req) => {
    const { vault, readOnly } = await readable(req, req.params.id);
    const user = vault.mode === 'live' ? await db.user.findUnique({ where: { id: vault.userId } }) : null;
    return overview(db, vault.id, { readOnly, walletAssets: user && !readOnly ? await walletAssets(user.wallet).catch(() => []) : undefined });
  });

  /**
   * What Add LP can draw on: the vault's idle funds. Live: read from the vault wallet on Solana now (a
   * deposit shows at once), or as of the agent's last cycle when Solana can't be reached; the SOL kept
   * for fees and rent doesn't count. With ?pool: the most Add LP puts in that pool now, sized exactly
   * as the agent will (manualDeployLimit).
   */
  app.get<VP & { Querystring: { pool?: string } }>('/vaults/:id/balance', async (req): Promise<VaultBalance> => {
    const { vault, readOnly } = await readable(req, req.params.id);
    if (isSelfCustody(vault)) return selfCustodyBalance(vault, readOnly, req.query.pool);
    const live = vault.mode === 'live';
    let held = vault.cash as Record<string, number>;
    let source: VaultBalance['source'] = 'agent';
    if (live && vault.agentPubkey && (o.rpc || process.env.RPC_URL)) {
      const onChain = await Promise.resolve()
        .then(() => walletBalances(rpc(), vault.agentPubkey!))
        .catch(() => null);
      if (onChain) {
        held = onChain;
        source = 'chain';
      }
    }
    const reserveSol = live ? Math.min(held[SOL_MINT] ?? 0, SOL_RESERVE) : 0;
    const idle = await pricedTokens({ ...held, ...(live ? { [SOL_MINT]: Math.max(0, (held[SOL_MINT] ?? 0) - SOL_RESERVE) } : {}) });
    const availableUsd = idle.totalUsd;
    const assets = idle.shown.map(({ symbol, mint, amount, usd }) => ({ symbol, mint, amount, usd }));
    const out: VaultBalance = { availableUsd, assets, reserveSol, source, ...(live && source === 'chain' ? { vaultSol: held[SOL_MINT] ?? 0 } : {}) };
    // The owner's own SOL, which Add LP can move into the vault first (a wallet made in Telegram is the vault itself).
    if (live && !readOnly && vault.agentPubkey && (o.rpc || process.env.RPC_URL)) {
      const owner = await db.user.findUnique({ where: { id: vault.userId } });
      if (owner && owner.wallet !== vault.agentPubkey) {
        const lamports = await Promise.resolve()
          .then(() => rpc().getBalance(new PublicKey(owner.wallet)))
          .catch(() => null);
        const sol = await db.token.findUnique({ where: { mint: SOL_MINT } });
        if (lamports != null) {
          out.wallet = { address: owner.wallet, sol: lamports / 1e9, solPriceUsd: sol?.priceUsd ?? 0 };
          out.vaultWallet = vault.agentPubkey;
        }
      }
    }
    const poolId = req.query.pool;
    if (poolId) out.pool = (await addLimit(vault, poolId, availableUsd)) ?? undefined;
    return out;
  });

  /**
   * Self-custody: nothing idle in a vault; Add LP pays with SOL from the owner's own wallet, keeping a little
   * for the position's rent and the network fees. The most it puts into the pool is sized from that SOL.
   */
  async function selfCustodyBalance(vault: Vault & { strategy: Strategy | null }, readOnly: boolean, poolId?: string): Promise<VaultBalance> {
    const out: VaultBalance = { availableUsd: 0, assets: [], reserveSol: 0, source: 'chain' };
    if (readOnly || !(o.rpc || process.env.RPC_URL)) return { ...out, source: 'agent' };
    const owner = await db.user.findUniqueOrThrow({ where: { id: vault.userId } });
    const lamports = await Promise.resolve()
      .then(() => rpc().getBalance(new PublicKey(owner.wallet)))
      .catch(() => null);
    if (lamports == null) return { ...out, source: 'agent' };
    const solUsd = (await db.token.findUnique({ where: { mint: SOL_MINT } }))?.priceUsd ?? 0;
    out.wallet = { address: owner.wallet, sol: lamports / 1e9, solPriceUsd: solUsd };
    if (poolId) out.pool = (await addLimit(vault, poolId, Math.max(0, lamports / 1e9 - WALLET_KEEP_SOL) * solUsd)) ?? undefined;
    return out;
  }

  /**
   * The most Add LP puts into `poolId` for this vault with `idleUsd` to spend, sized exactly as the agent
   * will (manualDeployLimit), the limit that decides it, the minimum, and what more funds can't raise.
   */
  async function addLimit(vault: Vault & { strategy: Strategy | null }, poolId: string, idleUsd: number): Promise<VaultBalance['pool'] | null> {
    const snap = vault.strategy ? await db.poolSnapshot.findFirst({ where: { poolId }, orderBy: { ts: 'desc' } }) : null;
    if (!snap || !vault.strategy) return null;
    const live = vault.mode === 'live';
    const open = await db.position.findMany({ where: { vaultId: vault.id, status: 'open' }, select: { poolId: true, valueUsd: true } });
    const s = strategySettingsOf(vault.strategy);
    const limits = live ? liveLimits() : null;
    const params = await activeParams(db);
    const positionsUsd = open.reduce((sum, p) => sum + p.valueUsd, 0);
    const room = limits ? Math.min(limits.maxUsd - positionsUsd, limits.maxTotalUsd - (await liveTotalUsd(db))) : Infinity;
    const ceiling = Math.max(0, Math.min(snap.tvl * params.maxPoolShare, positionCapUsd(s), room));
    const lim = open.some((p) => p.poolId === poolId)
      ? { maxUsd: 0, limit: 'held' as const }
      : manualDeployLimit({
          idleUsd,
          positionsUsd,
          openPositions: open.length,
          poolTvlUsd: snap.tvl,
          capUsd: positionCapUsd(s),
          params,
          live: limits ? { maxUsd: limits.maxUsd, maxPositions: limits.maxPositions, roomTotalUsd: limits.maxTotalUsd - (await liveTotalUsd(db)) } : undefined,
        });
    return { ...lim, minUsd: minPositionUsd(), ceilingUsd: Number.isFinite(ceiling) ? ceiling : null };
  }

  /**
   * The owner's portfolio: what the vault holds (idle tokens and positions), how it did against holding
   * since the start, fees and costs all time, closed positions and money in and out, and what the
   * owner's own wallet holds (not in the vault). Live vaults read the vault wallet on Solana, so funds
   * show as soon as they arrive, even before the agent records them as a deposit (`pendingUsd`).
   */
  app.get<VP>('/vaults/:id/portfolio', async (req): Promise<Portfolio> => {
    const { vault, readOnly } = await readable(req, req.params.id);
    const owner = await db.user.findUniqueOrThrow({ where: { id: vault.userId } });
    const live = vault.mode === 'live';
    const canRead = !!(o.rpc || process.env.RPC_URL);
    const mirror = await describeTokens(vault.cash as Record<string, number>);
    const onChain =
      live && vault.agentPubkey && canRead
        ? await Promise.resolve()
            .then(() => walletBalances(rpc(), vault.agentPubkey!))
            .catch(() => null)
        : null;
    const cash = onChain ? await describeTokens(onChain) : mirror;
    // The owner's own wallet, every token (a wallet made in Telegram is the vault wallet itself: nothing separate).
    const ownTokens =
      !readOnly && live && canRead && owner.wallet !== vault.agentPubkey
        ? await Promise.resolve()
            .then(() => walletTokens(rpc(), owner.wallet))
            .catch(() => [])
        : [];
    const own = await describeTokens(Object.fromEntries(ownTokens.map((t) => [t.mint, t.amount])));
    // Hold baseline at the same prices as the value, so the two always compare like for like.
    const deposits = vault.deposits as Record<string, number>;
    const depositInfo = await tokenInfo(Object.keys(deposits));
    const holdValue = Object.entries(deposits).reduce((sum, [m, a]) => sum + a * (depositInfo.get(m)?.priceUsd ?? 0), 0);
    const [open, closed, closedCount, beatHold, totals, flowRows] = await Promise.all([
      db.position.findMany({ where: { vaultId: vault.id, status: 'open' }, include: { pool: true } }),
      db.position.findMany({ where: { vaultId: vault.id, status: 'closed' }, include: { pool: true }, orderBy: { closedAt: 'desc' }, take: 50 }),
      db.position.count({ where: { vaultId: vault.id, status: 'closed' } }),
      db.position.count({ where: { vaultId: vault.id, status: 'closed', netVsHold: { gt: 0 } } }),
      db.position.aggregate({ where: { vaultId: vault.id }, _sum: { feesClaimedUsd: true, feesUnclaimedUsd: true, costsUsd: true } }),
      db.decision.findMany({ where: { vaultId: vault.id, type: { in: ['deploy', 'exit'] } }, orderBy: { ts: 'desc' }, take: 300, select: { ts: true, title: true, inputs: true, txSig: true } }),
    ]);
    const tokens = await tokenMap(db, [...open, ...closed].flatMap((p) => [p.pool.mintA, p.pool.mintB]));
    const pairOf = (p: (typeof open)[number]) => ({
      pair: `${p.pool.tokenA} / ${p.pool.tokenB}`,
      tokenA: tokenRef(p.pool.tokenA, tokens.get(p.pool.mintA)),
      tokenB: tokenRef(p.pool.tokenB, tokens.get(p.pool.mintB)),
    });
    const holdings: PortfolioHolding[] = [
      ...cash.list.map((a) => ({
        kind: 'token' as const,
        token: a.token,
        amount: a.amount,
        value: a.value,
        ...(live && a.mint === SOL_MINT ? { reserve: Math.min(a.amount, SOL_RESERVE) } : {}),
      })),
      ...open.map((p) => ({
        kind: 'position' as const,
        positionId: p.id,
        ...pairOf(p),
        value: p.valueUsd + p.feesUnclaimedUsd,
        inRange: p.inRange,
        manual: p.manual,
      })),
    ].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    const positionsUsd = open.reduce((sum, p) => sum + p.valueUsd + p.feesUnclaimedUsd, 0);
    const value = cash.totalUsd + positionsUsd;
    const flows = flowRows
      .flatMap((d) => {
        const usd = (d.inputs as { flowUsd?: unknown } | null)?.flowUsd;
        return typeof usd === 'number' && usd !== 0 ? [{ ts: d.ts.getTime(), title: d.title, usd, ...(d.txSig ? { txSig: d.txSig } : {}) }] : [];
      })
      .slice(0, 30);
    return {
      wallet: owner.wallet,
      vaultWallet: live ? vault.agentPubkey : null,
      name: vault.name,
      mode: vault.mode,
      since: vault.createdAt.getTime(),
      telegramLinked: !!owner.telegramChatId,
      value,
      source: onChain ? 'chain' : 'agent',
      holdValue,
      netVsHold: holdValue > 0 ? (value / holdValue - 1) * 100 : null,
      pendingUsd: onChain ? Math.max(0, cash.totalUsd - mirror.totalUsd) : 0,
      ownWallet: own.list.map((a) => ({ token: a.token, amount: a.amount, value: a.value })),
      fees: (totals._sum.feesClaimedUsd ?? 0) + (totals._sum.feesUnclaimedUsd ?? 0),
      costs: totals._sum.costsUsd ?? 0,
      holdings,
      closed: closed.map((p) => ({
        id: p.id,
        ...pairOf(p),
        openedAt: p.openedAt.getTime(),
        closedAt: (p.closedAt ?? p.openedAt).getTime(),
        entryValue: p.entryValueUsd,
        exitValue: p.valueUsd,
        fees: p.feesClaimedUsd + p.feesUnclaimedUsd,
        netVsHold: p.netVsHold,
        manual: p.manual,
      })),
      closedCount,
      beatHold,
      flows,
    };
  });

  app.get<VP & { Querystring: { range?: string } }>('/vaults/:id/performance', async (req) => {
    const { vault } = await readable(req, req.params.id);
    const range = Number(req.query.range ?? 30);
    if (range !== 7 && range !== 30 && range !== 90) throw new ApiError(400, 'invalid_range', 'Range must be 7d, 30d or 90d.');
    return performance(db, vault.id, range);
  });

  app.get<VP>('/vaults/:id/positions', async (req) => positionViews(db, (await readable(req, req.params.id)).vault.id));

  app.get<VP & { Querystring: { type?: string; exclude?: string } }>('/vaults/:id/decisions', async (req) => {
    const { vault } = await readable(req, req.params.id);
    const types = (req.query.type ?? '').split(',').filter(Boolean) as DecisionType[];
    const exclude = (req.query.exclude ?? '').split(',').filter(Boolean) as DecisionType[];
    if ([...types, ...exclude].some((t) => !TYPES.includes(t))) throw new ApiError(400, 'invalid_type', 'Unknown decision type.');
    const ds = await db.decision.findMany({
      where: { vaultId: vault.id, ...(types.length ? { type: { in: types } } : {}), ...(exclude.length ? { NOT: { type: { in: exclude } } } : {}) },
      orderBy: { ts: 'desc' },
      take: 60,
    });
    return ds.map(decisionView);
  });

  app.get<VP>('/vaults/:id/cycle', async (req) => {
    const { vault } = await readable(req, req.params.id);
    return hub.cycle(vault.id, CYCLE_MS, vault.status === 'paused');
  });

  app.get<VP>('/vaults/:id/strategy', async (req) => {
    const { vault } = await readable(req, req.params.id);
    const { strategySettings } = await import('@binwise/db');
    return strategySettings(vault.strategy!);
  });

  // ---------- vault writes ----------

  app.put<VP & { Body: StrategySettings }>('/vaults/:id/strategy', async (req) => {
    const v = await writable(req, req.params.id);
    const errors = validateStrategy(req.body);
    if (errors.length) throw new ApiError(400, 'invalid_strategy', errors.join(' '));
    // Clients that don't send the per-position cap (older pages) keep the one already set (e.g. from Telegram).
    const s = { ...req.body, maxPositionUsd: req.body.maxPositionUsd ?? (v.strategy ? strategySettingsOf(v.strategy).maxPositionUsd : 0) };
    const data = strategyData(s);
    await db.strategy.update({ where: { vaultId: v.id }, data: { ...data, weights: data.weights as object, toggles: data.toggles as object } });
    await logDecision(v.id, 'scan', 'Strategy updated', `Pool cap ${s.maxAllocPct}%${s.maxPositionUsd > 0 ? ` (max $${s.maxPositionUsd.toLocaleString('en-US')} per position)` : ''}, min cap $${s.minMcapM}M, trend exit −${Math.abs(s.trendExitPct)}%, loss stop ${s.dailyStopPct}%.`);
    return s;
  });

  app.post<VP>('/vaults/:id/pause', async (req) => {
    const v = await writable(req, req.params.id);
    await db.vault.update({ where: { id: v.id }, data: { status: 'paused', pausedReason: 'Paused by you.' } });
    // Nothing proposed before the pause may be approved into a paused vault.
    await db.proposal.updateMany({ where: { vaultId: v.id, status: 'pending' }, data: { status: 'expired' } });
    await publish(v.id, { type: 'cycle', cycle: { cycle: v.cycle, step: -1, paused: true, intervalMs: CYCLE_MS, elapsedMs: 0, steps: [] } });
    return overview(db, v.id, { readOnly: false });
  });

  app.post<VP>('/vaults/:id/resume', async (req) => {
    const v = await writable(req, req.params.id);
    await db.vault.update({ where: { id: v.id }, data: { status: 'running', pausedReason: null } });
    return overview(db, v.id, { readOnly: false });
  });

  app.post<VP & { Body: { mode?: string; confirm?: boolean } }>('/vaults/:id/mode', moneyLimit, async (req) => {
    const v0 = await writable(req, req.params.id);
    const mode = req.body?.mode;
    if (mode !== 'paper' && mode !== 'live') throw new ApiError(400, 'invalid_mode', 'Mode must be paper or live.');
    if (mode === v0.mode) return overview(db, v0.id, { readOnly: false });
    if (mode === 'live') {
      if (!liveEnabled()) throw new ApiError(403, 'live_disabled', "Live mode isn't available yet. Paper mode stays on.");
      if (req.body?.confirm !== true) throw new ApiError(400, 'confirm_required', 'Confirm that real funds will be used.');
      if (!isLiveWallet(v0.user.wallet)) throw new ApiError(403, 'live_not_allowed', 'Live mode is limited to approved wallets while it is being tested.');
    }
    await withVaultLock(v0.id, 60_000, async () => {
      // Re-read inside the lock: the agent may have just opened or closed something.
      const v = await writable(req, req.params.id);
      if (v.mode === mode) return;
      if (await db.position.count({ where: { vaultId: v.id, status: 'open' } }))
        throw new ApiError(409, 'positions_open', 'Close all positions before switching modes.');
      if (v.mode === 'live' && v.encSecret) {
        // Leaving live with money still in the agent wallet would hide real funds from the app.
        const ex = new LiveExecutor({
          conn: chain(),
          agent: loadAgentKey(v.encSecret, undefined, v.agentPubkey),
          ownerWallet: new PublicKey(v.user.wallet),
          killSwitch: { isKilled: killed },
          idempotency: { claim: async () => false },
        });
        const left = await usdValue(await ex.holdings());
        if (left > 1) throw new ApiError(409, 'funds_in_vault', `Withdraw the ${'$' + fmt(left, 2)} still in the vault wallet before switching to paper.`);
      }
      // Live without an existing vault wallet means self-custody: the funds stay in the owner's wallet, no key here.
      await db.vault.update({
        where: { id: v.id },
        data: { mode, cash: {}, deposits: {}, ...(mode === 'live' && !v.encSecret ? { custody: 'wallet' as const } : {}) },
      });
      // Nothing queued or proposed under the old mode may run under the new one.
      await db.proposal.updateMany({ where: { vaultId: v.id, status: 'pending' }, data: { status: 'expired' } });
      await redis.del(REDIS_KEYS.actions(v.id));
      await logDecision(
        v.id,
        'scan',
        mode === 'live' ? 'Live mode on' : 'Paper mode on',
        mode === 'live' ? (v.encSecret ? 'Real funds will be used.' : 'Real funds, kept in your own wallet: you approve every transaction.') : 'Simulated funds only.',
      );
    });
    return overview(db, v0.id, { readOnly: false });
  });

  app.post<VP & { Body: { token?: string; amount?: number; signature?: string } }>('/vaults/:id/deposit', moneyLimit, async (req) => {
    const id = (await writable(req, req.params.id)).id;
    return withVaultLock(id, 30_000, async () => {
      const v = await writable(req, req.params.id);
      notSelfCustody(v);
      if (v.mode === 'paper') return paperDeposit(v, String(req.body?.token ?? ''), Number(req.body?.amount));
      return liveDeposit(v, String(req.body?.signature ?? ''), v.user.wallet);
    });
  });

  /**
   * Live: records transfers from the owner's wallet that reached the vault wallet in the last half hour but
   * aren't recorded yet: SOL the owner sent by hand to the vault address, when their wallet couldn't approve
   * on this page. The agent finds those too, but only every few cycles. Same checks as POST
   * /vaults/:id/deposit. Returns what it recorded now, by mint.
   */
  app.post<VP>('/vaults/:id/deposit/scan', moneyLimit, async (req) => {
    const id = (await writable(req, req.params.id)).id;
    notSelfCustody(await writable(req, req.params.id));
    return withVaultLock(id, 30_000, async () => {
      const v = await writable(req, req.params.id);
      if (v.mode !== 'live' || !v.agentPubkey) throw new ApiError(400, 'not_live', 'Only a live vault has a vault wallet to send to.');
      const since = Date.now() / 1000 - 1800;
      const recent = await chain()
        .getSignaturesForAddress(new PublicKey(v.agentPubkey), { limit: 15 }, 'confirmed')
        .catch(() => {
          throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Try again in a moment.');
        });
      const sigs = recent.filter((s) => !s.err && (s.blockTime == null || s.blockTime >= since)).map((s) => s.signature);
      const seen = new Set([
        ...(await db.decision.findMany({ where: { idempotencyKey: { in: sigs.map((s) => `deposit:${s}`) } }, select: { idempotencyKey: true } })).map((d) => d.idempotencyKey!.slice(8)),
        // The agent's own transactions are never deposits.
        ...(await db.tx.findMany({ where: { sig: { in: sigs } }, select: { sig: true } })).map((t) => t.sig!),
      ]);
      const recorded: Record<string, number> = {};
      for (const sig of sigs.filter((s) => !seen.has(s))) {
        let credited: Record<string, number> | null;
        try {
          credited = await recordLiveDeposit(v, sig, v.user.wallet);
        } catch (e) {
          if (e instanceof ApiError) continue; // not a transfer from the owner's wallet
          throw e;
        }
        for (const [m, a] of Object.entries(credited ?? {})) recorded[m] = (recorded[m] ?? 0) + a;
      }
      return { recorded };
    });
  });

  /**
   * A withdrawal the executor stopped, in plain words, saying whether anything left the vault. Only a
   * transfer sent but not yet confirmed is uncertain: the owner checks before trying again.
   */
  function withdrawRefusal(e: unknown): Error {
    const m = (e as Error)?.message ?? '';
    if (e instanceof SimulationFailed)
      return /InsufficientFundsForRent|insufficient/i.test(`${m} ${(e.logs ?? []).join(' ')}`)
        ? new ApiError(400, 'insufficient_balance', 'Solana needs a little more SOL to stay in the vault for this withdrawal. Nothing was sent; try a slightly smaller amount.')
        : new ApiError(400, 'sim_failed', `Solana would reject this withdrawal (${m.replace(/^Simulation failed: /, '')}). Nothing was sent.`);
    if (e instanceof PolicyViolation) return new ApiError(400, 'blocked', `${BRAND}'s safety check stopped this withdrawal: ${m}. Nothing was sent.`);
    if (e instanceof TradingHalted) return new ApiError(423, 'kill_switch', 'Trading is halted right now. Nothing was sent; try again later.');
    if (e instanceof DuplicateAction) return new ApiError(409, 'duplicate', 'This withdrawal already ran. Check Activity.');
    // Failed on-chain or expired before landing: nothing moved.
    if (e instanceof TxFailed) return new ApiError(502, 'tx_failed', 'Solana did not take the withdrawal, so nothing left the vault. Try again.');
    if (/still unconfirmed/.test(m)) return new ApiError(504, 'unconfirmed', 'The withdrawal was sent but is not confirmed yet. Check Activity or your wallet in a minute before trying again.');
    return e as Error;
  }

  async function symbolMint(symbol: string, wallet: Record<string, number>) {
    const tokens = await db.token.findMany({ where: { mint: { in: Object.keys(wallet) } } });
    const t = tokens.find((x) => x.symbol === symbol);
    if (!t) throw new ApiError(400, 'unknown_token', 'That token can’t be deposited.');
    return t;
  }

  async function paperDeposit(v: Vault, symbol: string, amount: number) {
    const wallet = v.paperWallet as Record<string, number>;
    const t = await symbolMint(symbol, wallet);
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, 'invalid_amount', 'Enter an amount.');
    if (amount > (wallet[t.mint] ?? 0)) throw new ApiError(400, 'insufficient_balance', `Not enough ${symbol}`);
    const add = (h: Record<string, number>, n: number) => ({ ...h, [t.mint]: (h[t.mint] ?? 0) + n });
    await db.vault.update({
      where: { id: v.id },
      data: { paperWallet: add(wallet, -amount), cash: add(v.cash as Record<string, number>, amount), deposits: add(v.deposits as Record<string, number>, amount) },
    });
    const usd = amount * (t.priceUsd ?? 0);
    await logDecision(v.id, 'deploy', `Deposited ${fmt(amount)} ${symbol}`, `Added $${fmt(usd, 0)} to the vault. The agent places it on the next cycle.`, { inputs: { flowUsd: usd } });
    return overview(db, v.id, { readOnly: false });
  }

  /** Live: the user's wallet already sent the transfer; verify it on-chain, then record it. */
  async function liveDeposit(v: Vault, signature: string, ownerWallet: string) {
    await recordLiveDeposit(v, signature, ownerWallet);
    return overview(db, v.id, { readOnly: false });
  }

  /**
   * Records one transfer from the owner's wallet into the vault wallet, checked on-chain; once per signature.
   * Returns what it credited by mint, or null when that signature was already recorded.
   */
  async function recordLiveDeposit(v: Vault, signature: string, ownerWallet: string) {
    if (!v.agentPubkey) throw new ApiError(400, 'no_agent', 'This vault has no agent wallet yet.');
    if (!signature) throw new ApiError(400, 'missing_signature', 'Send the deposit from your wallet first.');
    const key = `deposit:${signature}`;
    if (await db.decision.findUnique({ where: { idempotencyKey: key } })) return null;
    const tx = await rpc().getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx || !tx.meta) throw new ApiError(400, 'tx_not_found', 'That transaction is not confirmed yet. Try again in a moment.');
    if (tx.meta.err) throw new ApiError(400, 'tx_failed', 'That transaction failed on-chain, so nothing was deposited.');
    const credited = parseDeposit(tx, ownerWallet, v.agentPubkey);
    if (!Object.keys(credited).length) throw new ApiError(400, 'no_transfer', 'No transfer from your wallet to the vault was found in that transaction.');
    // Read now, under the vault lock: an earlier deposit recorded in the same request is already in.
    const deposits = { ...((await db.vault.findUniqueOrThrow({ where: { id: v.id }, select: { deposits: true } })).deposits as Record<string, number>) };
    for (const [m, a] of Object.entries(credited)) deposits[m] = (deposits[m] ?? 0) + a;
    const tokens = await db.token.findMany({ where: { mint: { in: Object.keys(credited) } } });
    // Small amounts keep their digits (0.784 SOL, not 0.78), like the agent's own deposit records.
    const label = Object.entries(credited)
      .map(([m, a]) => `${a.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${tokens.find((t) => t.mint === m)?.symbol ?? m.slice(0, 4)}`)
      .join(' + ');
    const flowUsd = await usdValue(credited);
    // One transaction: the idempotency key (unique) and the credit land together or not at all.
    try {
      const [d] = await db.$transaction([
        db.decision.create({
          data: { vaultId: v.id, type: 'deploy', title: `Deposited ${label}`, reason: 'Received in the vault wallet. The agent places it on the next cycle.', inputs: { flowUsd }, txSig: signature, idempotencyKey: key },
        }),
        db.vault.update({ where: { id: v.id }, data: { deposits } }),
      ]);
      await publish(v.id, { type: 'decision', decision: decisionView(d) });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e; // already credited
      return null;
    }
    return credited;
  }

  /**
   * Live: what the owner can withdraw to their own wallet now, by token, with the same rule POST /withdraw
   * applies: SOL keeps 0.001 for the transfer's fee when no position is open, the fee reserve while one is.
   */
  app.get<VP>('/vaults/:id/withdrawable', async (req): Promise<Withdrawable> => {
    const v = await writable(req, req.params.id);
    notSelfCustody(v);
    if (v.mode !== 'live' || !v.agentPubkey) throw new ApiError(400, 'not_live', 'Only a live vault holds funds on Solana.');
    if (v.user.wallet === v.agentPubkey) throw new ApiError(400, 'same_wallet', 'This vault wallet is your own wallet: use 💸 Withdraw in the Telegram bot to send funds elsewhere.');
    const conn = chain();
    const openPositions = await db.position.count({ where: { vaultId: v.id, status: 'open' } });
    const [lamports, held] = await Promise.all([conn.getBalance(new PublicKey(v.agentPubkey)), walletTokens(conn, v.agentPubkey)]).catch(() => {
      throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Try again in a moment.');
    });
    const keptSol = openPositions ? SOL_RESERVE : 0.001;
    // Native SOL only (what a SOL withdrawal sends); wrapped SOL isn't sent as SOL.
    const amounts = [
      { mint: SOL_MINT, amount: Math.max(0, lamports / 1e9 - keptSol), decimals: 9 },
      ...held.filter((t) => t.mint !== SOL_MINT && t.amount > 0),
    ];
    const info = await tokenInfo(amounts.map((t) => t.mint));
    const tokens = amounts
      .map(({ mint, amount, decimals }) => {
        const i = info.get(mint);
        const symbol = mint === SOL_MINT ? 'SOL' : (i?.ref.symbol ?? `${mint.slice(0, 4)}…`);
        return { mint, symbol, amount, decimals, usd: amount * (i?.priceUsd ?? 0), token: i?.ref ?? tokenRef(symbol, { mint, logoUrl: null }) };
      })
      .sort((a, b) => (a.mint === SOL_MINT ? -1 : b.mint === SOL_MINT ? 1 : b.usd - a.usd));
    return { to: v.user.wallet, openPositions, keptSol, tokens };
  });

  /**
   * Ends Binwise's custody of a vault wallet from before self-custody: deletes the vault's key, and from then on
   * the vault works from the owner's own wallet (they approve every change there). Only once the vault wallet is
   * empty: no position, no tokens, at most dust SOL. A key deleted with funds behind it would lose them.
   */
  app.post<VP & { Body: { confirm?: boolean } }>('/vaults/:id/custody/release', moneyLimit, async (req) => {
    const id = (await writable(req, req.params.id)).id;
    await withVaultLock(id, 60_000, async () => {
      const v = await writable(req, req.params.id);
      if (v.mode !== 'live' || v.custody !== 'agent' || !v.encSecret || !v.agentPubkey) throw new ApiError(400, 'no_custody', `${BRAND} holds no key for this vault.`);
      // A wallet made in Telegram is the owner's only wallet: its key must be saved first (the bot does that).
      if (v.user.wallet === v.agentPubkey)
        throw new ApiError(400, 'same_wallet', `This is the wallet made in Telegram. Save its private key there first (🔑 Wallet), then remove it from ${BRAND} in the bot.`);
      if (req.body?.confirm !== true) throw new ApiError(400, 'confirm_required', `Confirm that ${BRAND} should delete this vault's key.`);
      if (await db.position.count({ where: { vaultId: v.id, status: 'open' } }))
        throw new ApiError(409, 'positions_open', 'Close your positions first (Positions), then withdraw everything to your wallet.');
      const conn = chain();
      const [held, onChain] = await Promise.all([walletTokens(conn, v.agentPubkey), (o.positionsOf ?? ((c, owner) => new WalletReader({ conn: c, owner }).listPositions()))(conn, v.agentPubkey)]).catch(() => {
        throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Nothing changed; try again in a moment.');
      });
      if (onChain.length) throw new ApiError(409, 'positions_open', 'The vault wallet still has a position on Solana. Close it first (Positions).');
      const info = await tokenInfo(held.map((t) => t.mint));
      const left = held.filter((t) => (t.mint === SOL_MINT ? t.amount > RELEASE_DUST_SOL : t.amount > 0));
      if (left.length) {
        const names = left.map((t) => `${t.amount.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${t.mint === SOL_MINT ? 'SOL' : (info.get(t.mint)?.ref.symbol ?? `${t.mint.slice(0, 4)}…`)}`).join(', ');
        throw new ApiError(409, 'funds_left', `Withdraw the ${names} still in the vault wallet first (Withdraw to wallet).`);
      }
      // Left behind for good: SOL dust, and the rent in empty token accounts (about 0.002 SOL each).
      const empty = await Promise.all(
        [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((programId) => conn.getParsedTokenAccountsByOwner(new PublicKey(v.agentPubkey!), { programId: new PublicKey(programId) }).then((r) => r.value.length, () => 0)),
      );
      const dust = (held.find((t) => t.mint === SOL_MINT)?.amount ?? 0) + (empty[0] + empty[1]) * 0.00203928;
      await db.vault.update({ where: { id: v.id }, data: { custody: 'wallet', agentPubkey: null, encSecret: null, cash: {} } });
      await logDecision(
        v.id,
        'hold',
        'Switched to your own wallet',
        `${BRAND} deleted this vault's key. Your funds stay in your own wallet now, and you approve every change there.${dust > 0 ? ` About ${dust.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL of dust and account rent, too little to recover, stays at the old vault address.` : ''}`,
      );
    });
    return overview(db, id, { readOnly: false });
  });

  app.post<VP & { Body: { token?: string; mint?: string; amount?: number } }>('/vaults/:id/withdraw', moneyLimit, async (req) => {
    const id = (await writable(req, req.params.id)).id;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, 'invalid_amount', 'Enter an amount.');
    return withVaultLock(id, 120_000, async () => {
      const v = await writable(req, req.params.id);
      notSelfCustody(v);
      const symbol = String(req.body?.token ?? '');
      const cash = v.cash as Record<string, number>;
      const deposits = v.deposits as Record<string, number>;
      if (v.mode === 'paper') {
        const t = await symbolMint(symbol, { ...cash, ...(v.paperWallet as Record<string, number>) });
        if (amount > (cash[t.mint] ?? 0)) throw new ApiError(400, 'insufficient_balance', `Only ${fmt(cash[t.mint] ?? 0)} ${symbol} is idle in the vault.`);
        const wallet = v.paperWallet as Record<string, number>;
        const flowUsd = amount * (t.priceUsd ?? 0);
        await db.vault.update({
          where: { id: v.id },
          data: {
            cash: { ...cash, [t.mint]: cash[t.mint] - amount },
            paperWallet: { ...wallet, [t.mint]: (wallet[t.mint] ?? 0) + amount },
            deposits: await shrinkDeposits(deposits, flowUsd),
          },
        });
        await logDecision(v.id, 'exit', `Withdrew ${fmt(amount)} ${symbol}`, 'Back in your paper wallet.', { inputs: { flowUsd: -flowUsd } });
        return overview(db, v.id, { readOnly: false });
      }
      // Live: only to the owner's registered wallet, enforced by the executor's transaction policy.
      // Deliberately not gated on LIVE_TRADING_ENABLED, so turning live trading off never traps funds.
      // The kill switch does block it (CLAUDE.md: checked before every transaction).
      if (v.mode !== 'live') throw new ApiError(400, 'not_live', 'This vault is not in live mode.');
      // A wallet made in Telegram is the vault itself: "to your wallet" would send it to itself.
      if (v.user.wallet === v.agentPubkey) throw new ApiError(400, 'same_wallet', 'This vault wallet is your own wallet: use 💸 Withdraw in the Telegram bot to send funds elsewhere.');
      if (await killed()) throw new ApiError(423, 'kill_switch', 'Trading is halted right now. Try again later.');
      if (!v.encSecret) throw new ApiError(400, 'no_agent', 'This vault has no agent wallet.');
      const ex = new LiveExecutor({
        conn: chain(),
        agent: loadAgentKey(v.encSecret, undefined, v.agentPubkey),
        ownerWallet: new PublicKey(v.user.wallet),
        killSwitch: { isKilled: killed },
        idempotency: { claim: async (k) => (await redis.set(REDIS_KEYS.idem(k), '1', 'EX', 7 * 86400, 'NX')) === 'OK' },
      });
      const holdings = await ex.holdings().catch(() => {
        throw new ApiError(502, 'rpc_unavailable', 'Could not reach Solana right now. Nothing was sent; try again in a moment.');
      });
      // By mint when given (any token the vault holds); otherwise by symbol.
      const mint =
        req.body?.mint && holdings[req.body.mint] != null
          ? req.body.mint
          : symbol === 'SOL'
            ? SOL_MINT
            : (await db.token.findMany({ where: { symbol, mint: { in: Object.keys(holdings) } } })).sort((x, y) => (holdings[y.mint] ?? 0) - (holdings[x.mint] ?? 0))[0]?.mint;
      if (!mint) throw new ApiError(400, 'unknown_token', 'The vault holds no such token.');
      // SOL comes out as native lamports; the reserve for fees and rent is released once nothing is deployed.
      const have =
        mint === SOL_MINT ? await ex.withdrawableSol(!(await db.position.count({ where: { vaultId: v.id, status: 'open' } }))) : (holdings[mint] ?? 0);
      if (amount > have) throw new ApiError(400, 'insufficient_balance', `Only ${fmt(have)} ${symbol || 'of that token'} is idle in the vault.`);
      const sig = await ex.withdraw(mint, amount, `withdraw:${v.id}:${randomUUID()}`).catch((e: unknown) => {
        throw withdrawRefusal(e);
      });
      const flowUsd = await usdValue({ [mint]: amount });
      await db.vault.update({ where: { id: v.id }, data: { deposits: await shrinkDeposits(deposits, flowUsd) } });
      // Small amounts keep their digits (0.999 SOL, not 1.00), like deposits.
      const shown = amount.toLocaleString('en-US', { maximumFractionDigits: 4 });
      await logDecision(v.id, 'exit', `Withdrew ${shown} ${symbol || mint.slice(0, 4)}`, 'Sent to your registered wallet.', { txSig: sig, inputs: { flowUsd: -flowUsd } });
      // The signature, so the page can link the transfer on Solscan.
      return { ...(await overview(db, v.id, { readOnly: false })), signature: sig };
    });
  });

  // Add LP by hand: queued for the agent, which re-checks everything (limits, data, kill switch) before opening.
  app.post<VP & { Body: { poolId?: string; usd?: number; override?: boolean; shape?: string; range?: { below?: unknown; above?: unknown } } }>('/vaults/:id/deploy', moneyLimit, async (req, reply) => {
    const v = await writable(req, req.params.id);
    const poolId = String(req.body?.poolId ?? '');
    const usd = Number(req.body?.usd ?? 0);
    if (!Number.isFinite(usd) || usd < 0) throw new ApiError(400, 'invalid_amount', 'Enter an amount.');
    // The owner's own strategy shape and price range (bins below / above the price); the agent picks when absent.
    const shape = req.body?.shape;
    if (shape != null && !['spot', 'curve', 'bidask'].includes(shape)) throw new ApiError(400, 'invalid_shape', 'Shape must be spot, curve or bidask.');
    const range = req.body?.range != null ? ({ below: Number(req.body.range.below), above: Number(req.body.range.above) } as CustomRange) : undefined;
    const bad = range && customRangeError(range);
    if (bad) throw new ApiError(400, 'invalid_range', bad);
    const pool = await db.pool.findUnique({ where: { id: poolId } });
    if (!pool) throw new ApiError(404, 'not_found', 'No pool with that id.');
    if (v.status !== 'running') throw new ApiError(409, 'paused', 'The agent is paused. Resume it first.');
    if (isSelfCustody(v)) throw new ApiError(409, 'approve_in_wallet', 'Add LP from your wallet: approve it there.');
    noNewCustody(v);
    await redis.lpush(
      REDIS_KEYS.actions(v.id),
      JSON.stringify({ id: randomUUID(), action: 'deploy', poolId, usd, override: req.body?.override === true, ...(shape ? { shape: shape as LiquidityShape } : {}), ...(range ? { range } : {}) }),
    );
    return reply.status(202).send({ queued: true, pair: `${pool.tokenA} / ${pool.tokenB}` });
  });

  // Manual Claim / Close: queued for the agent so execution stays in one place.
  const queueAction = (action: 'claim' | 'close') => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const uid = requireUser(req);
    const p = await db.position.findUnique({ where: { id: req.params.id }, include: { vault: true, pool: true } });
    if (!p || p.vault.userId !== uid || p.status !== 'open') throw new ApiError(404, 'not_found', 'No open position with that id.');
    if (p.vault.isDemo) throw new ApiError(403, 'read_only', 'The demo vault is read-only.');
    if (isSelfCustody(p.vault)) throw new ApiError(409, 'approve_in_wallet', 'This position is in your wallet: approve it there.');
    await redis.lpush(REDIS_KEYS.actions(p.vaultId), JSON.stringify({ id: randomUUID(), positionId: p.id, action }));
    return reply.status(202).send({ queued: true, pair: `${p.pool.tokenA} / ${p.pool.tokenB}` });
  };
  app.post<{ Params: { id: string } }>('/positions/:id/claim', queueAction('claim'));
  app.post<{ Params: { id: string } }>('/positions/:id/close', queueAction('close'));

  // ---------- self-custody: the owner's wallet signs every transaction ----------

  registerSelfCustody(app, {
    db,
    redis,
    writable,
    chain,
    killed,
    logDecision,
    publish,
    jupiter: o.swaps ?? new JupiterClient(),
    planner: o.planner,
    withVaultLock,
    poolAdvice: async (poolId, strategy) => {
      const d = await poolDetail(poolId, strategy);
      if (!d?.lp) return null;
      return { call: d.row.call, callLabel: d.row.callLabel, reason: d.row.reason, shape: d.lp.shape, binsEachSide: d.lp.binsEachSide, side: d.lp.side, stableMints: d.stableMints };
    },
    addLimit: async (vault, poolId, budgetUsd) => (await addLimit(vault, poolId, budgetUsd)) ?? { maxUsd: 0, minUsd: minPositionUsd(), limit: 'pool', ceilingUsd: 0 },
  });

  // ---------- manual mode: proposals waiting for the owner's approval ----------

  app.get<VP>('/vaults/:id/proposals', async (req) => {
    const { vault } = await readable(req, req.params.id);
    return (await pendingProposals(db, vault.id)).map(proposalView);
  });

  const decide = (approve: boolean) => async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const p = await db.proposal.findUnique({ where: { id: req.params.id } });
    if (!p) throw new ApiError(404, 'not_found', 'No such proposal.');
    const v = await writable(req, p.vaultId);
    // Self-custody: approving means signing the transactions in the owner's wallet (POST /wallet/prepare).
    if (approve && isSelfCustody(v)) throw new ApiError(409, 'approve_in_wallet', 'Approve this in your wallet.');
    try {
      if (approve) {
        await approveProposal(db, v.id, p.id);
        // Carried out by the agent worker, like every other trade.
        await redis.lpush(REDIS_KEYS.actions(v.id), JSON.stringify({ id: `approve-${p.id}`, action: 'proposal', proposalId: p.id }));
      } else await rejectProposal(db, v.id, p.id);
    } catch (e) {
      if (!(e instanceof ProposalError)) throw e;
      throw new ApiError(e.code === 'not_found' ? 404 : 409, e.code, e.message);
    }
    await publish(v.id, { type: 'proposals', pending: await db.proposal.count({ where: { vaultId: v.id, status: 'pending' } }) });
    return (await pendingProposals(db, v.id)).map(proposalView);
  };
  app.post<{ Params: { id: string } }>('/proposals/:id/approve', decide(true));
  app.post<{ Params: { id: string } }>('/proposals/:id/reject', decide(false));

  // ---------- admin ----------

  app.post<{ Body: { on?: boolean } }>('/admin/kill', async (req) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token || req.headers['x-admin-token'] !== token) throw new ApiError(401, 'unauthorized', 'Admin token required.');
    if (req.body?.on) await redis.set(REDIS_KEYS.kill, '1');
    else await redis.del(REDIS_KEYS.kill);
    return { killSwitch: await killed() };
  });

  // ---------- realtime ----------

  app.register(async (ws) => {
    ws.get<{ Querystring: { vault?: string } }>('/stream', { websocket: true }, async (socket, req) => {
      try {
        const { vault } = await readable(req, req.query.vault ?? '');
        if (socket.readyState !== socket.OPEN) return; // closed while we were checking access
        const off = hub.on(vault.id, (e) => socket.send(JSON.stringify(e)));
        socket.on('close', off);
      } catch {
        socket.close(4404, 'unknown vault');
      }
    });

    /** Landing page window: one position of the public demo vault, with the agent's reasoning. */
    ws.get<{ Querystring: { pair?: string } }>('/demo', { websocket: true }, async (socket, req) => {
      const demo = await demoVault();
      const pos = demo ? await db.position.findFirst({ where: { id: req.query.pair ?? '', vaultId: demo.id, status: 'open' }, include: { pool: true } }) : null;
      if (!demo || !pos) {
        socket.close(4404, 'unknown pair');
        return;
      }
      const marks = (await db.positionMark.findMany({ where: { positionId: pos.id }, orderBy: { ts: 'desc' }, take: 70 })).reverse();
      const recent = await db.decision.findMany({ where: { vaultId: demo.id, NOT: { type: 'hold' } }, orderBy: { ts: 'desc' }, take: 3 });
      const lastThought = await db.decision.findFirst({ where: { vaultId: demo.id }, orderBy: { ts: 'desc' } });
      const tir = marks.length ? Math.round((marks.filter((m) => m.inRange).length / marks.length) * 100) : 100;
      const stats = (fees: number, net: number, reb: number, inRange: boolean) => ({ fees, netVsHold: net, rebalances: reb, timeInRange: tir, inRange });
      const view = (await positionViews(db, demo.id)).find((p) => p.id === pos.id)!;
      const snapshot: DemoEvent = {
        type: 'demo:snapshot',
        chart: view.chart,
        stats: stats(view.fees, view.netVsHold, view.rebalances, view.inRange),
        mode: pos.inRange ? 'Holding position' : 'Evaluating a rebalance',
        thought: lastThought?.reason ?? 'Watching the pool.',
        log: recent.reverse().map((d) => [d.title.split(' ')[0], d.title.split(' ').slice(1).join(' ')] as [string, string]),
      };
      socket.send(JSON.stringify(snapshot));
      const off = hub.on(demo.id, (e) => {
        if (e.type === 'tick' && e.tick.positionId === pos.id) {
          const t = e.tick;
          socket.send(
            JSON.stringify({
              type: 'demo:tick',
              price: t.price,
              lo: t.lo,
              hi: t.hi,
              marker: t.marker,
              stats: stats(t.fees, t.netVsHold, t.rebalances, t.inRange),
              mode: t.event === 'rebalance' ? 'Rebalanced' : t.inRange ? 'Holding position' : 'Evaluating a rebalance',
            } satisfies DemoEvent),
          );
        }
        if (e.type === 'decision' || (e.type === 'cycle' && e.cycle.decision && e.cycle.step === 5)) {
          const text = e.type === 'decision' ? e.decision.reason : e.cycle.decision!.text;
          const title = e.type === 'decision' ? e.decision.title : undefined;
          socket.send(
            JSON.stringify({
              type: 'demo:thought',
              mode: pos.inRange ? 'Holding position' : 'Evaluating a rebalance',
              thought: text,
              log: title ? ([title.split(' ')[0], title.split(' ').slice(1).join(' ')] as [string, string]) : undefined,
            } satisfies DemoEvent),
          );
        }
      });
      socket.on('close', off);
    });
  });

  app.get('/demo/pairs', async () => {
    const demo = await demoVault();
    if (!demo) return [];
    const ps = await db.position.findMany({ where: { vaultId: demo.id, status: 'open' }, include: { pool: true }, orderBy: { valueUsd: 'desc' }, take: 3 });
    const tokens = await tokenMap(db, ps.flatMap((p) => [p.pool.mintA, p.pool.mintB]));
    return ps.map((p) => ({
      id: p.id,
      pair: `${p.pool.tokenA} / ${p.pool.tokenB}`,
      tokenA: tokenRef(p.pool.tokenA, tokens.get(p.pool.mintA)),
      tokenB: tokenRef(p.pool.tokenB, tokens.get(p.pool.mintB)),
      shape: p.shape,
    }));
  });

  return app;
}
