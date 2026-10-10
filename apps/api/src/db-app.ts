import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  REDIS_KEYS,
  validateStrategy,
  type DecisionType,
  type DemoEvent,
  type DepositAsset,
  type StrategySettings,
  type StreamEvent,
} from '@binwise/core';
import {
  LiveExecutor,
  isLiveWallet,
  parseDeposit,
  createAgentKey,
  loadAgentKey,
  makeConnection,
} from '@binwise/chain';
import {
  ProposalError,
  approveProposal,
  createVault,
  ensureUser,
  pendingProposals,
  proposalView,
  rejectProposal,
  strategyData,
  type PrismaClient,
  type Vault,
} from '@binwise/db';
import { SESSION_COOKIE, SESSION_DAYS, makeSession, newNonce, readSession, signInMessage, verifyWalletSignature } from './auth';
import { EventHub } from './events';
import { decisionView, overview, performance, poolRows, positionViews, tokenMap, tokenRef } from './views';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TYPES: DecisionType[] = ['scan', 'deploy', 'rebalance', 'exit', 'compound', 'hold', 'skip'];
const CYCLE_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

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

  async function walletAssets(wallet: string): Promise<DepositAsset[]> {
    if (!process.env.RPC_URL) return [];
    const conn = rpc();
    const owner = new PublicKey(wallet);
    const tokens = await db.token.findMany({ where: { OR: [{ mint: SOL_MINT }, { symbol: 'USDC', isVerified: true }] }, orderBy: { mcapUsd: 'desc' } });
    const out: DepositAsset[] = [];
    for (const t of tokens.filter((t, i, a) => a.findIndex((x) => x.symbol === t.symbol) === i)) {
      let balance = 0;
      if (t.mint === SOL_MINT) balance = (await conn.getBalance(owner)) / 1e9;
      else {
        const accs = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(t.mint) });
        balance = accs.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
      }
      out.push({ ...tokenRef(t.symbol, t), mint: t.mint, decimals: t.decimals, priceUsd: t.priceUsd ?? 0, balance });
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

  /** USD value of a token map at current prices. */
  async function usdValue(amounts: Record<string, number>) {
    const tokens = await db.token.findMany({ where: { mint: { in: Object.keys(amounts) } } });
    return Object.entries(amounts).reduce((s, [m, a]) => s + a * (tokens.find((t) => t.mint === m)?.priceUsd ?? 0), 0);
  }

  /**
   * After a withdrawal, shrink the hold baseline by the same share of its value, whatever token
   * was withdrawn, so net vs hold isn't distorted by money taken out.
   */
  async function shrinkDeposits(deposits: Record<string, number>, withdrawnUsd: number) {
    const holdUsd = await usdValue(deposits);
    const k = holdUsd > 0 ? Math.max(0, 1 - withdrawnUsd / holdUsd) : 0;
    return Object.fromEntries(Object.entries(deposits).map(([m, a]) => [m, a * k]));
  }

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
    const wallet = req.query.wallet ?? '';
    try {
      new PublicKey(wallet);
    } catch {
      throw new ApiError(400, 'bad_wallet', 'That is not a Solana wallet address.');
    }
    const nonce = newNonce();
    const message = signInMessage(wallet, nonce, new Date().toISOString(), o.domain ?? 'Binwise');
    // Keyed by the nonce itself, so requesting a new message can't invalidate someone else's.
    await redis.set(REDIS_KEYS.nonce(nonce), message, 'EX', 300);
    return { message };
  });

  app.post<{ Body: { wallet?: string; message?: string; signature?: string } }>('/auth/verify', authLimit, async (req, reply) => {
    const { wallet = '', message = '', signature = '' } = req.body ?? {};
    const nonce = /\nNonce: ([0-9a-f]{32})\n/.exec(message)?.[1];
    // GETDEL: a message can be used exactly once, even by two requests at the same time.
    const expected = nonce ? await redis.getdel(REDIS_KEYS.nonce(nonce)) : null;
    if (!expected || expected !== message || !message.includes(`\nWallet: ${wallet}\n`)) throw new ApiError(400, 'bad_nonce', 'Sign-in request expired. Try again.');
    if (!verifyWalletSignature(wallet, message, signature)) throw new ApiError(401, 'bad_signature', 'Signature check failed.');
    const user = await ensureUser(db, wallet);
    if (!(await db.vault.count({ where: { userId: user.id } }))) {
      if (liveByDefault(wallet)) {
        // Mainnet by default: the vault gets its own agent wallet now; nothing trades until the owner deposits.
        const key = createAgentKey();
        const v = await createVault(db, user.id, { live: { agentPubkey: key.pubkey, encSecret: new Uint8Array(key.encSecret) } });
        await logDecision(v.id, 'scan', 'Live vault created', 'Runs on Solana mainnet with real funds. Deposit a small amount to start; withdrawals only go back to your wallet.');
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

  app.get('/me', async (req) => {
    const uid = requireUser(req);
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
    return (await poolRows(db, strategy)).map(({ breakdown: _b, reason: _r, ...row }) => row);
  });

  app.get<{ Params: { id: string }; Querystring: { vault?: string } }>('/pools/:id', async (req) => {
    const strategy = req.query.vault ? (await readable(req, req.query.vault)).vault.strategy : null;
    const row = (await poolRows(db, strategy)).find((r) => r.id === req.params.id);
    if (!row) throw new ApiError(404, 'not_found', 'No recent data for that pool.');
    return row;
  });

  // ---------- vault reads ----------

  type VP = { Params: { id: string } };

  app.get<VP>('/vaults/:id/overview', async (req) => {
    const { vault, readOnly } = await readable(req, req.params.id);
    const user = vault.mode === 'live' ? await db.user.findUnique({ where: { id: vault.userId } }) : null;
    return overview(db, vault.id, { readOnly, walletAssets: user && !readOnly ? await walletAssets(user.wallet).catch(() => []) : undefined });
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
    const s = req.body;
    const data = strategyData(s);
    await db.strategy.update({ where: { vaultId: v.id }, data: { ...data, weights: data.weights as object, toggles: data.toggles as object } });
    await logDecision(v.id, 'scan', 'Strategy updated', `Pool cap ${s.maxAllocPct}%, min cap $${s.minMcapM}M, trend exit −${Math.abs(s.trendExitPct)}%, loss stop ${s.dailyStopPct}%.`);
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
      const key = mode === 'live' && !v.agentPubkey ? createAgentKey() : null;
      await db.vault.update({
        where: { id: v.id },
        data: { mode, cash: {}, deposits: {}, ...(key ? { agentPubkey: key.pubkey, encSecret: new Uint8Array(key.encSecret) } : {}) },
      });
      // Nothing queued or proposed under the old mode may run under the new one.
      await db.proposal.updateMany({ where: { vaultId: v.id, status: 'pending' }, data: { status: 'expired' } });
      await redis.del(REDIS_KEYS.actions(v.id));
      await logDecision(v.id, 'scan', mode === 'live' ? 'Live mode on' : 'Paper mode on', mode === 'live' ? 'Real funds will be used. Deposit to the vault wallet to start.' : 'Simulated funds only.');
    });
    return overview(db, v0.id, { readOnly: false });
  });

  app.post<VP & { Body: { token?: string; amount?: number; signature?: string } }>('/vaults/:id/deposit', moneyLimit, async (req) => {
    const id = (await writable(req, req.params.id)).id;
    return withVaultLock(id, 30_000, async () => {
      const v = await writable(req, req.params.id);
      if (v.mode === 'paper') return paperDeposit(v, String(req.body?.token ?? ''), Number(req.body?.amount));
      return liveDeposit(v, String(req.body?.signature ?? ''), v.user.wallet);
    });
  });

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
    if (!v.agentPubkey) throw new ApiError(400, 'no_agent', 'This vault has no agent wallet yet.');
    if (!signature) throw new ApiError(400, 'missing_signature', 'Send the deposit from your wallet first.');
    const key = `deposit:${signature}`;
    if (await db.decision.findUnique({ where: { idempotencyKey: key } })) return overview(db, v.id, { readOnly: false });
    const tx = await rpc().getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx || !tx.meta) throw new ApiError(400, 'tx_not_found', 'That transaction is not confirmed yet. Try again in a moment.');
    if (tx.meta.err) throw new ApiError(400, 'tx_failed', 'That transaction failed on-chain, so nothing was deposited.');
    const credited = parseDeposit(tx, ownerWallet, v.agentPubkey);
    if (!Object.keys(credited).length) throw new ApiError(400, 'no_transfer', 'No transfer from your wallet to the vault was found in that transaction.');
    const deposits = { ...(v.deposits as Record<string, number>) };
    for (const [m, a] of Object.entries(credited)) deposits[m] = (deposits[m] ?? 0) + a;
    const tokens = await db.token.findMany({ where: { mint: { in: Object.keys(credited) } } });
    const label = Object.entries(credited)
      .map(([m, a]) => `${fmt(a)} ${tokens.find((t) => t.mint === m)?.symbol ?? m.slice(0, 4)}`)
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
    }
    return overview(db, v.id, { readOnly: false });
  }

  app.post<VP & { Body: { token?: string; mint?: string; amount?: number } }>('/vaults/:id/withdraw', moneyLimit, async (req) => {
    const id = (await writable(req, req.params.id)).id;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError(400, 'invalid_amount', 'Enter an amount.');
    return withVaultLock(id, 120_000, async () => {
      const v = await writable(req, req.params.id);
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
      const sig = await ex.withdraw(mint, amount, `withdraw:${v.id}:${randomUUID()}`);
      const flowUsd = await usdValue({ [mint]: amount });
      await db.vault.update({ where: { id: v.id }, data: { deposits: await shrinkDeposits(deposits, flowUsd) } });
      await logDecision(v.id, 'exit', `Withdrew ${fmt(amount)} ${symbol || mint.slice(0, 4)}`, 'Sent to your registered wallet.', { txSig: sig, inputs: { flowUsd: -flowUsd } });
      return overview(db, v.id, { readOnly: false });
    });
  });

  // Manual Claim / Close: queued for the agent so execution stays in one place.
  const queueAction = (action: 'claim' | 'close') => async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const uid = requireUser(req);
    const p = await db.position.findUnique({ where: { id: req.params.id }, include: { vault: true, pool: true } });
    if (!p || p.vault.userId !== uid || p.status !== 'open') throw new ApiError(404, 'not_found', 'No open position with that id.');
    if (p.vault.isDemo) throw new ApiError(403, 'read_only', 'The demo vault is read-only.');
    await redis.lpush(REDIS_KEYS.actions(p.vaultId), JSON.stringify({ id: randomUUID(), positionId: p.id, action }));
    return reply.status(202).send({ queued: true, pair: `${p.pool.tokenA} / ${p.pool.tokenB}` });
  };
  app.post<{ Params: { id: string } }>('/positions/:id/claim', queueAction('claim'));
  app.post<{ Params: { id: string } }>('/positions/:id/close', queueAction('close'));

  // ---------- manual mode: proposals waiting for the owner's approval ----------

  app.get<VP>('/vaults/:id/proposals', async (req) => {
    const { vault } = await readable(req, req.params.id);
    return (await pendingProposals(db, vault.id)).map(proposalView);
  });

  const decide = (approve: boolean) => async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const p = await db.proposal.findUnique({ where: { id: req.params.id } });
    if (!p) throw new ApiError(404, 'not_found', 'No such proposal.');
    const v = await writable(req, p.vaultId);
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
