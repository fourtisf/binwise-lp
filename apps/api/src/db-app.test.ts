import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execSync } from 'node:child_process';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { REDIS_KEYS, DEFAULT_STRATEGY } from '@binwise/core';
import { createVault, ensureUser, getDb } from '@binwise/db';
import { buildDbApp } from './db-app';

const db = getDb();
const redis = new Redis(process.env.REDIS_URL!);
const sub = new Redis(process.env.REDIS_URL!);
let app: FastifyInstance;
let demoId: string;
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'USDCmint111111111111111111111111111111111111';

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x!;
  return { address: bs58.encode(Buffer.from(raw, 'base64url')), signMsg: (m: string) => bs58.encode(sign(null, Buffer.from(m), privateKey)) };
}

async function signIn(w = wallet()) {
  const { message } = (await app.inject(`/auth/nonce?wallet=${w.address}`)).json();
  const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: w.address, message, signature: w.signMsg(message) } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'bw_session')!;
  return { w, headers: { cookie: `bw_session=${cookie.value}` } };
}

beforeAll(async () => {
  const dbName = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  execSync(`psql -h localhost -U binwise -d postgres -c "create database ${dbName}" 2>/dev/null || true`, { stdio: 'ignore' });
  execSync('pnpm --filter @binwise/db exec prisma migrate deploy', { stdio: 'ignore', env: { ...process.env } });
  await db.$executeRawUnsafe('TRUNCATE "Tx","Decision","PositionMark","Position","VaultSnapshot","Strategy","Vault","User","Candle","PoolSnapshot","Pool","Token","BacktestRun","Proposal" CASCADE');
  await redis.flushdb();
  await db.token.createMany({
    data: [
      { mint: SOL, symbol: 'SOL', decimals: 9, isVerified: true, priceUsd: 150, mcapUsd: 7e10 },
      { mint: USDC, symbol: 'USDC', decimals: 6, isVerified: true, priceUsd: 1, mcapUsd: 6e10 },
    ],
  });
  const demoUser = await ensureUser(db, 'binwise-demo-vault');
  demoId = (await createVault(db, demoUser.id, { name: 'Demo vault', isDemo: true, cash: { [USDC]: 10_000 } })).id;
  app = await buildDbApp({ db, redis, sub, domain: 'test.binwise' });
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await db.$disconnect();
});

describe('sign-in with Solana', () => {
  it('creates a user with a paper vault and a session cookie', async () => {
    const { w, headers } = await signIn();
    const me = (await app.inject({ url: '/me', headers })).json();
    expect(me.wallet).toBe(w.address);
    expect(me.vaults).toHaveLength(1);
    expect(me.vaults[0].mode).toBe('paper');
  });

  it('rejects a signature from another wallet', async () => {
    const a = wallet();
    const b = wallet();
    const { message } = (await app.inject(`/auth/nonce?wallet=${a.address}`)).json();
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: a.address, message, signature: b.signMsg(message) } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a reused or tampered message', async () => {
    const w = wallet();
    const { message } = (await app.inject(`/auth/nonce?wallet=${w.address}`)).json();
    const bad = message.replace('Nonce:', 'Nonce: x');
    const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: w.address, message: bad, signature: w.signMsg(bad) } });
    expect(res.statusCode).toBe(400);
  });

  it('requires a session for private routes', async () => {
    expect((await app.inject('/me')).statusCode).toBe(401);
  });
});

describe('vaults', () => {
  it('deposits from the paper wallet and logs it', async () => {
    const { headers } = await signIn();
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    const before = (await app.inject({ url: `/vaults/${id}/overview`, headers })).json();
    expect(before.depositAssets.map((a: { symbol: string }) => a.symbol)).toEqual(['SOL', 'USDC']);
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/deposit`, headers, payload: { token: 'SOL', amount: 10 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().value).toBeCloseTo(1500);
    expect(res.json().depositAssets[0].balance).toBe(90);
    const ds = (await app.inject({ url: `/vaults/${id}/decisions?exclude=hold`, headers })).json();
    expect(ds[0].title).toBe('Deposited 10.00 SOL');
    const over = await app.inject({ method: 'POST', url: `/vaults/${id}/deposit`, headers, payload: { token: 'SOL', amount: 1000 } });
    expect(over.json().message).toBe('Not enough SOL');
    // Withdrawing half shrinks the hold baseline by half, so net vs hold isn't distorted.
    const w = await app.inject({ method: 'POST', url: `/vaults/${id}/withdraw`, headers, payload: { token: 'SOL', amount: 5 } });
    expect(w.statusCode).toBe(200);
    const v = await db.vault.findUniqueOrThrow({ where: { id } });
    expect(Object.values(v.deposits as Record<string, number>)[0]).toBeCloseTo(5);
  });

  it('saves a valid strategy and rejects an invalid one', async () => {
    const { headers } = await signIn();
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    const ok = await app.inject({ method: 'PUT', url: `/vaults/${id}/strategy`, headers, payload: { ...DEFAULT_STRATEGY, profile: 'aggressive', maxAllocPct: 40 } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ url: `/vaults/${id}/strategy`, headers })).json().maxAllocPct).toBe(40);
    const bad = await app.inject({ method: 'PUT', url: `/vaults/${id}/strategy`, headers, payload: { ...DEFAULT_STRATEGY, dailyStopPct: 90 } });
    expect(bad.statusCode).toBe(400);
  });

  it('pauses and resumes', async () => {
    const { headers } = await signIn();
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    expect((await app.inject({ method: 'POST', url: `/vaults/${id}/pause`, headers })).json().status).toBe('paused');
    expect((await app.inject({ method: 'POST', url: `/vaults/${id}/resume`, headers })).json().status).toBe('running');
  });

  it('refuses live mode while LIVE_TRADING_ENABLED is off', async () => {
    const { headers } = await signIn();
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    const res = await app.inject({ method: 'POST', url: `/vaults/${id}/mode`, headers, payload: { mode: 'live', confirm: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('live_disabled');
  });

  it('allows live mode only for approved wallets, and lets live vaults withdraw even with the flag off', async () => {
    const owner = wallet();
    const { headers } = await signIn(owner);
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    const prev = { flag: process.env.LIVE_TRADING_ENABLED, wallets: process.env.LIVE_WALLETS, secret: process.env.AGENT_KEY_ENCRYPTION_SECRET };
    process.env.LIVE_TRADING_ENABLED = 'true';
    process.env.AGENT_KEY_ENCRYPTION_SECRET = Buffer.alloc(32, 7).toString('base64');
    try {
      process.env.LIVE_WALLETS = 'SomeOtherWallet1111111111111111111111111111';
      const refused = await app.inject({ method: 'POST', url: `/vaults/${id}/mode`, headers, payload: { mode: 'live', confirm: true } });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toBe('live_not_allowed');
      process.env.LIVE_WALLETS = `SomeOtherWallet1111111111111111111111111111, ${owner.address}`;
      const ok = await app.inject({ method: 'POST', url: `/vaults/${id}/mode`, headers, payload: { mode: 'live', confirm: true } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().mode).toBe('live');
      // Turning the global flag off must not trap funds: the withdraw route still gets past the live gate.
      process.env.LIVE_TRADING_ENABLED = 'false';
      const w = await app.inject({ method: 'POST', url: `/vaults/${id}/withdraw`, headers, payload: { token: 'NOPE', amount: 1 } });
      // Past the live gate: it goes on to read the wallet (no Solana node in tests).
      expect(w.statusCode).toBe(502);
      expect(w.json().error).toBe('rpc_unavailable');
    } finally {
      process.env.LIVE_TRADING_ENABLED = prev.flag;
      process.env.LIVE_WALLETS = prev.wallets;
      process.env.AGENT_KEY_ENCRYPTION_SECRET = prev.secret;
      if (prev.flag === undefined) delete process.env.LIVE_TRADING_ENABLED;
      if (prev.wallets === undefined) delete process.env.LIVE_WALLETS;
      if (prev.secret === undefined) delete process.env.AGENT_KEY_ENCRYPTION_SECRET;
    }
  });

  it('lists, approves and rejects proposals (manual mode), only for the owner', async () => {
    const { headers } = await signIn();
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    const mk = (title: string) =>
      db.proposal.create({ data: { vaultId: id, kind: 'deploy', poolId: null, title, reason: 'Score 80.', plan: { pair: 'SOL / USDC' }, expiresAt: new Date(Date.now() + 3600_000) } });
    const a = await mk('Deploy $500 to SOL / USDC');
    const b = await mk('Deploy $300 to JUP / USDC');
    const list = (await app.inject({ url: `/vaults/${id}/proposals`, headers })).json();
    expect(list.map((p: { title: string }) => p.title).sort()).toEqual([a.title, b.title].sort());
    expect(list[0].pair).toBe('SOL / USDC');

    // Someone else can't approve it.
    const other = await signIn();
    expect((await app.inject({ method: 'POST', url: `/proposals/${a.id}/approve`, headers: other.headers })).statusCode).toBe(404);

    await redis.del(REDIS_KEYS.actions(id));
    const ok = await app.inject({ method: 'POST', url: `/proposals/${a.id}/approve`, headers });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().map((p: { id: string }) => p.id)).toEqual([b.id]);
    expect(JSON.parse((await redis.lindex(REDIS_KEYS.actions(id), 0))!)).toEqual({ id: `approve-${a.id}`, action: 'proposal', proposalId: a.id });
    const again = await app.inject({ method: 'POST', url: `/proposals/${a.id}/approve`, headers });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('not_pending');

    expect((await app.inject({ method: 'POST', url: `/proposals/${b.id}/reject`, headers })).json()).toEqual([]);
    expect((await db.proposal.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('rejected');
    await redis.del(REDIS_KEYS.actions(id));
  });

  it('starts new wallets on mainnet when DEFAULT_VAULT_MODE=live (and only then)', async () => {
    const keys = ['DEFAULT_VAULT_MODE', 'LIVE_TRADING_ENABLED', 'LIVE_WALLETS', 'RPC_URL', 'AGENT_KEY_ENCRYPTION_SECRET'] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      const paper = await signIn();
      expect((await app.inject({ url: '/me', headers: paper.headers })).json().vaults[0].mode).toBe('paper');
      Object.assign(process.env, {
        DEFAULT_VAULT_MODE: 'live',
        LIVE_TRADING_ENABLED: 'true',
        LIVE_WALLETS: '*',
        RPC_URL: 'http://127.0.0.1:1',
        AGENT_KEY_ENCRYPTION_SECRET: Buffer.alloc(32, 9).toString('base64'),
      });
      const live = await signIn();
      const v = (await app.inject({ url: '/me', headers: live.headers })).json().vaults[0];
      expect(v.mode).toBe('live');
      const row = await db.vault.findUniqueOrThrow({ where: { id: v.id } });
      expect(row.agentPubkey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(row.encSecret).not.toBeNull();
      expect(JSON.stringify(row.paperWallet)).toBe('{}');
    } finally {
      for (const k of keys) if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('hides other users’ vaults', async () => {
    const a = await signIn();
    const b = await signIn();
    const idA = (await app.inject({ url: '/me', headers: a.headers })).json().vaults[0].id;
    expect((await app.inject({ url: `/vaults/${idA}/overview`, headers: b.headers })).statusCode).toBe(404);
  });

  it('lets anyone read the demo vault but nobody change it', async () => {
    expect((await app.inject('/vaults/demo')).json().id).toBe(demoId);
    const o = (await app.inject(`/vaults/${demoId}/overview`)).json();
    expect(o.readOnly).toBe(true);
    const { headers } = await signIn();
    expect((await app.inject({ method: 'POST', url: `/vaults/${demoId}/pause`, headers })).statusCode).toBe(404);
  });

  it('queues manual close for the agent', async () => {
    const { headers } = await signIn();
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    await db.pool.create({ data: { id: 'P1', name: 'SOL-USDC', tokenA: 'SOL', tokenB: 'USDC', mintA: SOL, mintB: USDC, binStep: 10, baseFee: 0.1 } });
    const p = await db.position.create({
      data: { vaultId: id, poolId: 'P1', binStep: 10, lowerBin: 0, upperBin: 10, shape: 'spot', entryAmountA: 1, entryAmountB: 150, entryPriceA: 150, entryPriceB: 1, entryValueUsd: 300, price: 150, valueUsd: 300 },
    });
    const res = await app.inject({ method: 'POST', url: `/positions/${p.id}/close`, headers });
    expect(res.statusCode).toBe(202);
    const queued = JSON.parse((await redis.lindex(REDIS_KEYS.actions(id), 0))!);
    expect(queued).toMatchObject({ positionId: p.id, action: 'close' });
  });
});

describe('realtime', () => {
  it('forwards agent events to the vault stream', async () => {
    const addr = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/stream?vault=${demoId}`);
    await new Promise((r) => ws.on('open', r));
    await new Promise((r) => setTimeout(r, 100));
    const got = new Promise<{ type: string }>((r) => ws.on('message', (m) => r(JSON.parse(m.toString()))));
    await redis.publish(REDIS_KEYS.events(demoId), JSON.stringify({ type: 'cycle', cycle: { cycle: 1, step: 0, paused: false, intervalMs: 60000, elapsedMs: 0, steps: [] } }));
    expect((await got).type).toBe('cycle');
    ws.close();
  });
});

describe('admin', () => {
  it('needs the admin token for the kill switch', async () => {
    expect((await app.inject({ method: 'POST', url: '/admin/kill', payload: { on: true } })).statusCode).toBe(401);
    process.env.ADMIN_TOKEN = 'admin-token';
    const res = await app.inject({ method: 'POST', url: '/admin/kill', headers: { 'x-admin-token': 'admin-token' }, payload: { on: true } });
    expect(res.json().killSwitch).toBe(true);
    expect((await app.inject('/health')).json().killSwitch).toBe(true);
  });
});
