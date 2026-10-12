import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execSync } from 'node:child_process';
import bs58 from 'bs58';
import WebSocket from 'ws';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { REDIS_KEYS, DEFAULT_STRATEGY } from '@binwise/core';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
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
  return {
    address: bs58.encode(Buffer.from(raw, 'base64url')),
    signMsg: (m: string) => bs58.encode(sign(null, Buffer.from(m), privateKey)),
    /** The same key as a Solana keypair, to sign transactions. */
    keypair: () => Keypair.fromSeed(Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')),
  };
}

/** `remoteAddress`: sign in from another address, so a test doesn't spend the others' sign-in rate limit. */
async function signIn(w = wallet(), remoteAddress?: string) {
  const ip = remoteAddress ? { remoteAddress } : {};
  const { message } = (await app.inject({ url: `/auth/nonce?wallet=${w.address}`, ...ip })).json();
  const res = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: w.address, message, signature: w.signMsg(message) }, ...ip });
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

  it('accepts the standard Sign In With Solana message for the issued nonce, once', async () => {
    const w = wallet();
    const c = (await app.inject(`/auth/nonce?wallet=${w.address}`)).json();
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    const siws = `${c.domain} wants you to sign in with your Solana account:\n${w.address}\n\n${c.statement}\n\nURI: https://${c.domain}\nVersion: 1\nChain ID: mainnet\nNonce: ${c.nonce}\nIssued At: ${c.issuedAt}`;
    const ok = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: w.address, message: siws, signature: w.signMsg(siws) } });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: w.address, message: siws, signature: w.signMsg(siws) } });
    expect(again.statusCode).toBe(400);
    // Another wallet can't use this nonce, even with its own valid signature.
    const other = wallet();
    const c2 = (await app.inject(`/auth/nonce?wallet=${w.address}`)).json();
    const forged = siws.replaceAll(w.address, other.address).replace(c.nonce, c2.nonce);
    const bad = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: other.address, message: forged, signature: other.signMsg(forged) } });
    expect(bad.statusCode).toBe(400);
  });

  it('signs in in one step: Sign In With Solana on a nonce issued before the wallet is known', async () => {
    // Own address, so this test doesn't spend the other tests' sign-in rate limit.
    const ip = { remoteAddress: '10.9.9.9' };
    const nonce = async () => (await app.inject({ url: '/auth/nonce', ...ip })).json();
    const verify = (wallet: string, message: string, signature: string) =>
      app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, message, signature }, ...ip });
    const siwsFor = (c: { domain: string; statement: string; nonce: string; issuedAt: string }, address: string, domain = c.domain) =>
      `${domain} wants you to sign in with your Solana account:\n${address}\n\n${c.statement}\n\nURI: https://${domain}\nVersion: 1\nChain ID: mainnet\nNonce: ${c.nonce}\nIssued At: ${c.issuedAt}`;
    const w = wallet();

    const c = await nonce();
    expect(c.message).toBeNull();
    const siws = siwsFor(c, w.address);
    // Only with the signer's own signature.
    expect((await verify(w.address, siws, wallet().signMsg(siws))).statusCode).toBe(401);

    // Only the standard message counts: there was no message of ours to sign for this nonce.
    const c2 = await nonce();
    const ours = `${c2.domain} wants you to sign in to Binwise with your Solana wallet.\n\nWallet: ${w.address}\nNonce: ${c2.nonce}\nIssued at: ${c2.issuedAt}`;
    expect((await verify(w.address, ours, w.signMsg(ours))).statusCode).toBe(400);

    // Only for this site's domain.
    const c3 = await nonce();
    const phish = siwsFor(c3, w.address, 'evil.example');
    expect((await verify(w.address, phish, w.signMsg(phish))).statusCode).toBe(400);

    const c4 = await nonce();
    const ok = await verify(w.address, siwsFor(c4, w.address), w.signMsg(siwsFor(c4, w.address)));
    expect(ok.statusCode).toBe(200);
    expect(ok.cookies.some((k) => k.name === 'bw_session')).toBe(true);
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

  it('allows live mode only for approved wallets (self-custody: no key at Binwise), and lets vault wallets withdraw even with the flag off', async () => {
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
      expect(ok.json()).toMatchObject({ mode: 'live', custody: 'wallet' });
      // Self-custody: no vault wallet, no key, nothing to withdraw from Binwise.
      const row = await db.vault.findUniqueOrThrow({ where: { id } });
      expect([row.agentPubkey, row.encSecret]).toEqual([null, null]);
      expect((await app.inject({ method: 'POST', url: `/vaults/${id}/withdraw`, headers, payload: { token: 'SOL', amount: 1 } })).json().error).toBe('self_custody');
      // A vault wallet from before (Binwise holds its key): turning the global flag off must not trap its funds.
      await db.vault.update({ where: { id }, data: { custody: 'agent', agentPubkey: owner.address.split('').reverse().join(''), encSecret: new Uint8Array(8) } });
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
      // Self-custody: the funds stay in the owner's wallet, Binwise holds no key.
      const row = await db.vault.findUniqueOrThrow({ where: { id: v.id } });
      expect(row.custody).toBe('wallet');
      expect([row.agentPubkey, row.encSecret]).toEqual([null, null]);
      expect(JSON.stringify(row.paperWallet)).toBe('{}');

      // A vault that was still simulated moves to mainnet on the next visit: no simulated money or history left.
      const old = (await db.vault.findFirstOrThrow({ where: { user: { wallet: paper.w.address } } })).id;
      await db.vault.update({ where: { id: old }, data: { cash: { X: 10_000 }, deposits: { X: 10_000 } } });
      await db.vaultSnapshot.create({ data: { vaultId: old, value: 10_000, holdValue: 10_000, feesTotal: 0, netVsHold: 0 } });
      expect((await app.inject({ url: '/me', headers: paper.headers })).json().vaults[0].mode).toBe('live');
      const moved = await db.vault.findUniqueOrThrow({ where: { id: old } });
      expect(moved.cash).toEqual({});
      expect(moved.deposits).toEqual({});
      expect([moved.custody, moved.agentPubkey, moved.encSecret]).toEqual(['wallet', null, null]);
      expect(await db.vaultSnapshot.count({ where: { vaultId: old } })).toBe(0);
      expect((await db.decision.findFirstOrThrow({ where: { vaultId: old }, orderBy: { ts: 'desc' } })).title).toBe('Moved to mainnet');
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

    // Add LP by hand from the pool drawer: queued with the owner's risk choice.
    const d = await app.inject({ method: 'POST', url: `/vaults/${id}/deploy`, headers, payload: { poolId: 'P1', usd: 120, override: true } });
    expect(d.statusCode).toBe(202);
    expect(d.json().pair).toBe('SOL / USDC');
    expect(JSON.parse((await redis.lindex(REDIS_KEYS.actions(id), 0))!)).toMatchObject({ action: 'deploy', poolId: 'P1', usd: 120, override: true });
    expect((await app.inject({ method: 'POST', url: `/vaults/${id}/deploy`, headers, payload: { poolId: 'nope', usd: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/vaults/${id}/deploy`, payload: { poolId: 'P1', usd: 1 } })).statusCode).toBe(401);
  });
});

describe('vault balance (Add LP)', () => {
  const snapshot = (poolId: string, tvl: number) =>
    db.poolSnapshot.create({ data: { poolId, tvl, volume24h: tvl, price: 150, volatility: 3, score: 70, scoreBreakdown: [], call: 'in', callLabel: 'Enter', reason: 'ok' } });

  it('shows the idle funds and the most Add LP puts into a pool, sized like the agent', async () => {
    const { headers } = await signIn();
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    await app.inject({ method: 'POST', url: `/vaults/${id}/deposit`, headers, payload: { token: 'SOL', amount: 10 } });
    await db.pool.create({ data: { id: 'PB1', name: 'SOL-USDC', tokenA: 'SOL', tokenB: 'USDC', mintA: SOL, mintB: USDC, binStep: 10, baseFee: 0.1 } });
    await snapshot('PB1', 1e6);

    const b = (await app.inject({ url: `/vaults/${id}/balance?pool=PB1`, headers })).json();
    expect(b.availableUsd).toBeCloseTo(1500);
    expect(b.assets).toEqual([{ symbol: 'SOL', mint: SOL, amount: 10, usd: 1500 }]);
    expect(b).toMatchObject({ reserveSol: 0, source: 'agent' });
    // Add LP by hand isn't held to the strategy's share per pool: all idle funds (2% kept for fees), within 2% of the pool.
    expect(b.pool).toEqual({ maxUsd: 1470, limit: 'balance', minUsd: 50, ceilingUsd: 20_000 });
    // Without a pool: just the balance.
    expect((await app.inject({ url: `/vaults/${id}/balance`, headers })).json().pool).toBeUndefined();

    await db.position.create({
      data: { vaultId: id, poolId: 'PB1', binStep: 10, lowerBin: 0, upperBin: 10, shape: 'spot', entryAmountA: 1, entryAmountB: 150, entryPriceA: 150, entryPriceB: 1, entryValueUsd: 300, price: 150, valueUsd: 300 },
    });
    expect((await app.inject({ url: `/vaults/${id}/balance?pool=PB1`, headers })).json().pool).toMatchObject({ maxUsd: 0, limit: 'held' });
    // Someone else's vault stays private.
    expect((await app.inject({ url: `/vaults/${id}/balance` })).statusCode).toBe(404);
  });

  it('live: reads the vault wallet on Solana and leaves out the SOL kept for fees', async () => {
    const agent = wallet().address;
    const conn = {
      getBalance: async () => 2.25e9,
      getParsedTokenAccountsByOwner: async (_o: unknown, f: { programId: { toBase58(): string } }) => ({
        value: f.programId.toBase58().startsWith('Tokenz')
          ? []
          : [{ account: { data: { parsed: { info: { mint: USDC, tokenAmount: { uiAmount: 40 } } } } } }],
      }),
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const liveApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never });
    try {
      const owner = wallet();
      const user = await ensureUser(db, owner.address);
      const v = await createVault(db, user.id, { live: { agentPubkey: agent, encSecret: new Uint8Array(8) } });
      await db.vault.update({ where: { id: v.id }, data: { cash: { [SOL]: 9 } } });
      const nonce = (await liveApp.inject({ url: `/auth/nonce?wallet=${owner.address}`, remoteAddress: '10.9.9.8' })).json();
      const login = await liveApp.inject({ method: 'POST', url: '/auth/verify', remoteAddress: '10.9.9.8', payload: { wallet: owner.address, message: nonce.message, signature: owner.signMsg(nonce.message) } });
      const headers = { cookie: `bw_session=${login.cookies.find((c) => c.name === 'bw_session')!.value}` };

      const b = (await liveApp.inject({ url: `/vaults/${v.id}/balance`, headers })).json();
      expect(b.source).toBe('chain');
      expect(b.reserveSol).toBe(0.25);
      expect(b.assets).toEqual([
        { symbol: 'SOL', mint: SOL, amount: 2, usd: 300 },
        { symbol: 'USDC', mint: USDC, amount: 40, usd: 40 },
      ]);
      expect(b.availableUsd).toBeCloseTo(340);

      // Solana unreachable: the agent's last reading (which includes the reserve) minus the reserve.
      conn.getBalance = async () => {
        throw new Error('down');
      };
      const cached = (await liveApp.inject({ url: `/vaults/${v.id}/balance`, headers })).json();
      expect(cached).toMatchObject({ source: 'agent', reserveSol: 0.25, availableUsd: 1312.5 });
    } finally {
      await liveApp.close(); // also closes sub2
    }
  });
});

describe('portfolio', () => {
  it('shows holdings, net vs hold since the start, fees, closed positions and money in and out', async () => {
    const { w, headers } = await signIn(wallet(), '10.9.9.7');
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    await app.inject({ method: 'POST', url: `/vaults/${id}/deposit`, headers, payload: { token: 'SOL', amount: 10 } });
    await db.pool.create({ data: { id: 'PP1', name: 'SOL-USDC', tokenA: 'SOL', tokenB: 'USDC', mintA: SOL, mintB: USDC, binStep: 10, baseFee: 0.1 } });
    const base = { vaultId: id, poolId: 'PP1', binStep: 10, lowerBin: 0, upperBin: 10, shape: 'spot' as const, entryAmountA: 1, entryAmountB: 150, entryPriceA: 150, entryPriceB: 1, entryValueUsd: 300, price: 150 };
    const open = await db.position.create({ data: { ...base, valueUsd: 300, feesUnclaimedUsd: 5, costsUsd: 0.4 } });
    await db.position.create({
      data: { ...base, valueUsd: 290, feesClaimedUsd: 7, costsUsd: 0.6, netVsHold: 2, status: 'closed', openedAt: new Date(Date.now() - 86_400_000), closedAt: new Date() },
    });

    const res = await app.inject({ url: `/vaults/${id}/portfolio`, headers });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p).toMatchObject({ wallet: w.address, vaultWallet: null, mode: 'paper', telegramLinked: false, closedCount: 1, beatHold: 1 });
    // 10 SOL idle ($1,500) + the open position with its unclaimed fees ($305), against holding the 10 SOL.
    expect(p.value).toBeCloseTo(1805);
    expect(p.holdValue).toBeCloseTo(1500);
    expect(p.netVsHold).toBeCloseTo((1805 / 1500 - 1) * 100);
    expect(p.fees).toBeCloseTo(12);
    expect(p.costs).toBeCloseTo(1);
    expect(p.holdings.map((h: { kind: string; value: number }) => [h.kind, Math.round(h.value)])).toEqual([
      ['token', 1500],
      ['position', 305],
    ]);
    expect(p.holdings[1]).toMatchObject({ positionId: open.id, pair: 'SOL / USDC', inRange: true });
    expect(p.closed[0]).toMatchObject({ pair: 'SOL / USDC', entryValue: 300, exitValue: 290, fees: 7, netVsHold: 2 });
    expect(p.flows[0]).toMatchObject({ title: 'Deposited 10.00 SOL', usd: 1500 });
    // Private to the owner.
    expect((await app.inject({ url: `/vaults/${id}/portfolio` })).statusCode).toBe(404);
  });
});

describe('portfolio (live)', () => {
  it('reads the vault wallet on Solana, flags funds not yet recorded, and shows the owner wallet apart', async () => {
    const owner = wallet();
    const agent = wallet().address;
    // 3 SOL in the owner's own wallet; 3.25 SOL just arrived in the vault wallet (the agent hasn't seen it yet).
    const sol: Record<string, number> = { [owner.address]: 3, [agent]: 3.25 };
    const conn = {
      getBalance: async (pk: { toBase58(): string }) => (sol[pk.toBase58()] ?? 0) * 1e9,
      getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const liveApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never });
    try {
      const user = await ensureUser(db, owner.address);
      const v = await createVault(db, user.id, { live: { agentPubkey: agent, encSecret: new Uint8Array(8) } });
      const ip = { remoteAddress: '10.9.9.6' };
      const nonce = (await liveApp.inject({ url: `/auth/nonce?wallet=${owner.address}`, ...ip })).json();
      const login = await liveApp.inject({ method: 'POST', url: '/auth/verify', ...ip, payload: { wallet: owner.address, message: nonce.message, signature: owner.signMsg(nonce.message) } });
      const headers = { cookie: `bw_session=${login.cookies.find((c) => c.name === 'bw_session')!.value}` };

      const p = (await liveApp.inject({ url: `/vaults/${v.id}/portfolio`, headers })).json();
      expect(p.source).toBe('chain');
      expect(p.value).toBeCloseTo(487.5);
      expect(p.holdings[0]).toMatchObject({ kind: 'token', amount: 3.25, reserve: 0.25 });
      expect(p.pendingUsd).toBeCloseTo(487.5);
      // No deposit recorded yet: no net vs hold to show (not a misleading +0%).
      expect(p.netVsHold).toBeNull();
      expect(p.ownWallet).toHaveLength(1);
      expect(p.ownWallet[0]).toMatchObject({ amount: 3, value: 450 });
      expect(p.ownWallet[0].token.symbol).toBe('SOL');

      // Solana unreachable: the agent's last reading, nothing pending.
      conn.getBalance = async () => {
        throw new Error('down');
      };
      const cached = (await liveApp.inject({ url: `/vaults/${v.id}/portfolio`, headers })).json();
      expect(cached).toMatchObject({ source: 'agent', value: 0, pendingUsd: 0, ownWallet: [] });
    } finally {
      await liveApp.close(); // also closes sub2
    }
  });
});

describe('portfolio tokens', () => {
  it('lists every token in both wallets: names and prices from Jupiter for tokens we do not track, cached', async () => {
    const owner = wallet();
    const agent = wallet().address;
    const BONK = wallet().address;
    const MYSTERY = wallet().address;
    const accounts: Record<string, { mint: string; uiAmount: number; decimals: number }[]> = {
      [owner.address]: [
        { mint: BONK, uiAmount: 1_500_000, decimals: 5 },
        { mint: MYSTERY, uiAmount: 42, decimals: 6 },
        { mint: USDC, uiAmount: 25, decimals: 6 },
      ],
      [agent]: [{ mint: BONK, uiAmount: 2_000_000, decimals: 5 }],
    };
    const conn = {
      getBalance: async (pk: { toBase58(): string }) => (pk.toBase58() === owner.address ? 3 : 0.5) * 1e9,
      getParsedTokenAccountsByOwner: async (pk: { toBase58(): string }, f: { programId: { toBase58(): string } }) => ({
        value: f.programId.toBase58().startsWith('Tokenz')
          ? []
          : (accounts[pk.toBase58()] ?? []).map((a) => ({ account: { data: { parsed: { info: { mint: a.mint, tokenAmount: { uiAmount: a.uiAmount, decimals: a.decimals } } } } } })),
      }),
    };
    let lookups = 0;
    const jupiter = {
      tokens: async (mints: string[]) => {
        lookups++;
        return mints.includes(BONK) ? [{ id: BONK, name: 'Bonk', symbol: 'BONK', icon: 'https://example.com/bonk.png', decimals: 5, usdPrice: 0.00002 }] : [];
      },
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const liveApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never, jupiter });
    try {
      const user = await ensureUser(db, owner.address);
      const v = await createVault(db, user.id, { live: { agentPubkey: agent, encSecret: new Uint8Array(8) } });
      const ip = { remoteAddress: '10.9.9.5' };
      const nonce = (await liveApp.inject({ url: `/auth/nonce?wallet=${owner.address}`, ...ip })).json();
      const login = await liveApp.inject({ method: 'POST', url: '/auth/verify', ...ip, payload: { wallet: owner.address, message: nonce.message, signature: owner.signMsg(nonce.message) } });
      const headers = { cookie: `bw_session=${login.cookies.find((c) => c.name === 'bw_session')!.value}` };

      const p = (await liveApp.inject({ url: `/vaults/${v.id}/portfolio`, headers })).json();
      // Own wallet: every token, largest value first, unknown ones last without a price.
      const cents = (x: number | null) => (x == null ? null : Math.round(x * 100) / 100);
      expect(p.ownWallet.map((w: { token: { symbol: string }; amount: number; value: number | null }) => [w.token.symbol, w.amount, cents(w.value)])).toEqual([
        ['SOL', 3, 450],
        ['BONK', 1_500_000, 30],
        ['USDC', 25, 25],
        [`${MYSTERY.slice(0, 4)}…${MYSTERY.slice(-4)}`, 42, null],
      ]);
      expect(p.ownWallet[1].token.logo).toBe('https://example.com/bonk.png');
      // Vault wallet: BONK counts at its Jupiter price, next to the SOL.
      expect(p.holdings.map((h: { token: { symbol: string }; value: number }) => [h.token.symbol, cents(h.value)])).toEqual([
        ['SOL', 75],
        ['BONK', 40],
      ]);
      expect(p.value).toBeCloseTo(115);
      // Looked up once, then cached (unknown mints too).
      const before = lookups;
      await liveApp.inject({ url: `/vaults/${v.id}/portfolio`, headers });
      expect(lookups).toBe(before);
    } finally {
      await liveApp.close(); // also closes sub2
    }
  });
});

describe('add LP by hand: options and funding from the wallet', () => {
  it('queues the owner\'s own shape and range, refuses ranges a position cannot hold, and tells the drawer the price and bins', async () => {
    const { headers } = await signIn(wallet(), '10.9.9.4');
    const id = (await app.inject({ url: '/me', headers })).json().vaults[0].id;
    await db.pool.create({ data: { id: 'PL1', name: 'SOL-USDC', tokenA: 'SOL', tokenB: 'USDC', mintA: SOL, mintB: USDC, binStep: 25, baseFee: 0.1 } });
    await db.poolSnapshot.create({ data: { poolId: 'PL1', tvl: 1e6, volume24h: 2e6, price: 150, volatility: 3, score: 70, scoreBreakdown: [], call: 'in', callLabel: 'Enter', reason: 'ok' } });

    const detail = (await app.inject({ url: `/pools/PL1?vault=${id}`, headers })).json();
    expect(detail.lp).toMatchObject({ price: 150, binStep: 25, maxBins: 69 });
    expect(['spot', 'curve', 'bidask']).toContain(detail.lp.shape);
    expect(detail.lp.binsEachSide).toBeGreaterThan(0);
    // The agent's own recommendation: a ranging market (no trend data) means both tokens.
    expect(detail.lp).toMatchObject({ side: 'both', regime: 'range', volatility: 3, profile: 'balanced', stable: false });
    // An efficient move up above EMA50: one-sided in SOL above the price. Down: the agent adds nothing (null).
    await db.poolSnapshot.create({ data: { poolId: 'PL1', tvl: 1e6, volume24h: 2e6, price: 156, volatility: 3, score: 70, scoreBreakdown: [], call: 'in', callLabel: 'Enter', reason: 'ok', efficiency: 0.8, change24hPct: 4, aboveEma50: true } });
    expect((await app.inject({ url: `/pools/PL1?vault=${id}`, headers })).json().lp).toMatchObject({ side: 'x', regime: 'up' });
    await db.poolSnapshot.create({ data: { poolId: 'PL1', tvl: 1e6, volume24h: 2e6, price: 144, volatility: 3, score: 70, scoreBreakdown: [], call: 'in', callLabel: 'Enter', reason: 'ok', efficiency: 0.8, change24hPct: -4, aboveEma50: false } });
    expect((await app.inject({ url: `/pools/PL1?vault=${id}`, headers })).json().lp).toMatchObject({ side: null, regime: 'down' });
    await db.poolSnapshot.create({ data: { poolId: 'PL1', tvl: 1e6, volume24h: 2e6, price: 150, volatility: 3, score: 70, scoreBreakdown: [], call: 'in', callLabel: 'Enter', reason: 'ok' } });
    // Mints come along even for tokens missing from the token table: the app searches pools by contract address.
    const NEW = 'NewTokenMint11111111111111111111111111111111';
    await db.pool.create({ data: { id: 'PL9', name: 'NEW-USDC', tokenA: 'NEW', tokenB: 'USDC', mintA: NEW, mintB: USDC, binStep: 25, baseFee: 0.1 } });
    await db.poolSnapshot.create({ data: { poolId: 'PL9', tvl: 1e6, volume24h: 2e6, price: 1, volatility: 3, score: 50, scoreBreakdown: [], call: 'watch', callLabel: 'Watch', reason: 'ok' } });
    const unknown = (await app.inject({ url: `/pools/PL9?vault=${id}`, headers })).json();
    expect([unknown.tokenA.mint, unknown.tokenB.mint]).toEqual([NEW, USDC]);

    const ok = await app.inject({ method: 'POST', url: `/vaults/${id}/deploy`, headers, payload: { poolId: 'PL1', usd: 50, shape: 'curve', range: { below: 10, above: 4 } } });
    expect(ok.statusCode).toBe(202);
    expect(JSON.parse((await redis.lindex(REDIS_KEYS.actions(id), 0))!)).toMatchObject({ action: 'deploy', poolId: 'PL1', usd: 50, shape: 'curve', range: { below: 10, above: 4 } });
    const wide = await app.inject({ method: 'POST', url: `/vaults/${id}/deploy`, headers, payload: { poolId: 'PL1', usd: 50, range: { below: 40, above: 40 } } });
    expect(wide.statusCode).toBe(400);
    expect(wide.json().message).toMatch(/at most 69 bins/);
    expect((await app.inject({ method: 'POST', url: `/vaults/${id}/deploy`, headers, payload: { poolId: 'PL1', usd: 50, shape: 'zigzag' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/vaults/${id}/deploy`, headers, payload: { poolId: 'PL1', usd: 50, range: { below: 1.5, above: 2 } } })).statusCode).toBe(400);
  });

  it('takes no new money into a vault Binwise holds the key for: the drawer still shows balances, new LP is refused', async () => {
    const owner = wallet();
    const agent = wallet().address;
    const conn = {
      getBalance: async (pk: { toBase58(): string }) => (pk.toBase58() === owner.address ? 3 : 0.4) * 1e9,
      getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const liveApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never });
    try {
      const user = await ensureUser(db, owner.address);
      const v = await createVault(db, user.id, { live: { agentPubkey: agent, encSecret: new Uint8Array(8) } });
      const ip = { remoteAddress: '10.9.9.3' };
      const nonce = (await liveApp.inject({ url: `/auth/nonce?wallet=${owner.address}`, ...ip })).json();
      const login = await liveApp.inject({ method: 'POST', url: '/auth/verify', ...ip, payload: { wallet: owner.address, message: nonce.message, signature: owner.signMsg(nonce.message) } });
      const headers = { cookie: `bw_session=${login.cookies.find((c) => c.name === 'bw_session')!.value}` };

      const bal = (await liveApp.inject({ url: `/vaults/${v.id}/balance`, headers })).json();
      expect(bal.wallet).toMatchObject({ address: owner.address, sol: 3, solPriceUsd: 150 });
      expect(bal.vaultSol).toBe(0.4);
      expect(bal.vaultWallet).toBe(agent);

      // No new LP from the vault wallet, and no way left to move money into it from the page.
      const deploy = await liveApp.inject({ method: 'POST', url: `/vaults/${v.id}/deploy`, headers, payload: { poolId: 'PL1', usd: 50 } });
      expect(deploy.statusCode).toBe(409);
      expect(deploy.json()).toMatchObject({ error: 'custody_closing', message: expect.stringMatching(/Withdraw/) });
      expect(await redis.llen(REDIS_KEYS.actions(v.id))).toBe(0);
      expect((await liveApp.inject({ method: 'POST', url: `/vaults/${v.id}/deposit/tx`, headers, payload: { sol: 1 } })).statusCode).toBe(404);
      expect((await liveApp.inject({ method: 'POST', url: `/vaults/${v.id}/deposit/send`, headers, payload: { tx: 'AA==' } })).statusCode).toBe(404);
    } finally {
      await liveApp.close(); // also closes sub2
    }
  });

  it('records SOL the owner sent to the vault address by hand, once, and nothing from anyone else', async () => {
    const owner = wallet();
    const agent = wallet().address;
    const now = Math.floor(Date.now() / 1000);
    const parsed = (source: string, lamports: number) => ({
      meta: { err: null },
      transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source, destination: agent, lamports } } }], accountKeys: [] } },
    });
    const onChain: Record<string, { blockTime: number; parsed: object }> = {
      BYHAND: { blockTime: now - 20, parsed: parsed(owner.address, 1_500_000_000) },
      STRANGER: { blockTime: now - 30, parsed: parsed(wallet().address, 2_000_000_000) },
      LASTWEEK: { blockTime: now - 7 * 86_400, parsed: parsed(owner.address, 9_000_000_000) },
    };
    const conn = {
      getSignaturesForAddress: async () => Object.entries(onChain).map(([signature, t]) => ({ signature, err: null, blockTime: t.blockTime })),
      getParsedTransaction: async (sig: string) => onChain[sig]?.parsed ?? null,
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const liveApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never });
    try {
      const user = await ensureUser(db, owner.address);
      const v = await createVault(db, user.id, { live: { agentPubkey: agent, encSecret: new Uint8Array(8) } });
      const ip = { remoteAddress: '10.9.9.5' };
      const nonce = (await liveApp.inject({ url: `/auth/nonce?wallet=${owner.address}`, ...ip })).json();
      const login = await liveApp.inject({ method: 'POST', url: '/auth/verify', ...ip, payload: { wallet: owner.address, message: nonce.message, signature: owner.signMsg(nonce.message) } });
      const headers = { cookie: `bw_session=${login.cookies.find((c) => c.name === 'bw_session')!.value}` };
      const scan = () => liveApp.inject({ method: 'POST', url: `/vaults/${v.id}/deposit/scan`, headers });

      // Only the owner's recent transfer counts: not a stranger's, not one from last week.
      const first = await scan();
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ recorded: { [SOL]: 1.5 } });
      expect((await db.vault.findUniqueOrThrow({ where: { id: v.id } })).deposits).toEqual({ [SOL]: 1.5 });
      expect(await db.decision.findUnique({ where: { idempotencyKey: 'deposit:BYHAND' } })).toMatchObject({ title: 'Deposited 1.5 SOL', txSig: 'BYHAND' });
      // Asked again: nothing new, nothing counted twice.
      expect((await scan()).json()).toEqual({ recorded: {} });
      // A second transfer adds to the first.
      onChain.AGAIN = { blockTime: now - 5, parsed: parsed(owner.address, 250_000_000) };
      expect((await scan()).json()).toEqual({ recorded: { [SOL]: 0.25 } });
      expect((await db.vault.findUniqueOrThrow({ where: { id: v.id } })).deposits).toEqual({ [SOL]: 1.75 });
      expect((await liveApp.inject({ method: 'POST', url: `/vaults/${v.id}/deposit/scan` })).statusCode).toBe(401);
    } finally {
      await liveApp.close(); // also closes sub2
    }
  });
});

describe('self-custody: the owner\'s wallet signs, Binwise holds nothing', () => {
  it('prepares Add LP for the owner\'s wallet, relays only what that wallet signed, and records what the chain shows', async () => {
    const owner = wallet();
    const kp = owner.keypair();
    const POS = Keypair.generate().publicKey.toBase58();
    const sent: Buffer[] = [];
    let simErr: unknown = null;
    const conn = {
      getBalance: async () => 5e9,
      simulateTransaction: async () => ({ value: { err: simErr, logs: [] } }),
      sendRawTransaction: async (raw: Buffer) => {
        sent.push(Buffer.from(raw));
        return `SIG${sent.length}`;
      },
      getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    };
    // What the chain shows for each position address (null: not there).
    const chainPositions: Record<string, { owner: string; lowerBin: number; upperBin: number; amountX: number; amountY: number; feesUsd: number } | null> = {};
    const asked: Record<string, unknown[]> = { open: [], close: [] };
    const step = (kind: string) => ({ label: kind, tx: 'AQ==', kind });
    const planner = {
      open: async (_d: unknown, req: unknown) => {
        asked.open.push(req);
        return { steps: [step('swap'), step('open')], swaps: [], position: { address: POS, lowerBin: -10, upperBin: 10, amountX: 0.5, amountY: 75 }, rentSol: 0.06, newBinArrays: 0 };
      },
      close: async (_d: unknown, req: unknown) => {
        asked.close.push(req);
        return { steps: [step('close')], swaps: [], out: { [SOL]: 0.5, [USDC]: 76 }, feesUsd: 1 };
      },
      claim: async () => ({ steps: [step('claim')], feesUsd: 2 }),
      compound: async () => ({ steps: [step('claim')], feesUsd: 2 }),
      rebalance: async () => ({ steps: [] }),
      read: async (_c: unknown, _p: unknown, address: string) => chainPositions[address] ?? null,
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const scApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never, planner: planner as never });
    const prev = process.env.LIVE_TRADING_ENABLED;
    process.env.LIVE_TRADING_ENABLED = 'true';
    try {
      const user = await ensureUser(db, owner.address);
      const v = await createVault(db, user.id, { selfCustody: true });
      expect([v.mode, v.custody, v.agentPubkey, v.encSecret]).toEqual(['live', 'wallet', null, null]);
      const ip = { remoteAddress: '10.9.9.8' };
      const nonce = (await scApp.inject({ url: `/auth/nonce?wallet=${owner.address}`, ...ip })).json();
      const login = await scApp.inject({ method: 'POST', url: '/auth/verify', ...ip, payload: { wallet: owner.address, message: nonce.message, signature: owner.signMsg(nonce.message) } });
      const headers = { cookie: `bw_session=${login.cookies.find((c) => c.name === 'bw_session')!.value}` };
      await db.pool.create({ data: { id: 'PS1', name: 'SOL-USDC', tokenA: 'SOL', tokenB: 'USDC', mintA: SOL, mintB: USDC, binStep: 25, baseFee: 0.1 } });
      await db.poolSnapshot.create({ data: { poolId: 'PS1', tvl: 1e6, volume24h: 2e6, price: 150, volatility: 3, score: 70, scoreBreakdown: [], call: 'in', callLabel: 'Enter', reason: 'ok' } });
      const prepare = (payload: object) => scApp.inject({ method: 'POST', url: `/vaults/${v.id}/wallet/prepare`, headers, payload });
      const relay = (tx: Buffer | string) => scApp.inject({ method: 'POST', url: `/vaults/${v.id}/wallet/send`, headers, payload: { tx: typeof tx === 'string' ? tx : tx.toString('base64') } });
      const done = (planId: string, signatures: string[]) => scApp.inject({ method: 'POST', url: `/vaults/${v.id}/wallet/plans/${planId}/done`, headers, payload: { signatures } });

      // The old ways in are closed: nothing is ever sent to a Binwise wallet, the agent never queues a deploy.
      expect((await scApp.inject({ method: 'POST', url: `/vaults/${v.id}/deploy`, headers, payload: { poolId: 'PS1', usd: 50 } })).json().error).toBe('approve_in_wallet');
      expect((await scApp.inject({ method: 'POST', url: `/vaults/${v.id}/deposit`, headers, payload: { signature: 'x' } })).json().error).toBe('self_custody');

      // Add LP: transactions for the owner's own wallet, the position in the owner's name.
      // Against the agent's call only when the owner ticks the risk box.
      expect((await prepare({ action: 'open', poolId: 'PS1', sol: 1 })).json().error).toBe('not_recommended');
      const open = await prepare({ action: 'open', poolId: 'PS1', sol: 1, override: true });
      expect(open.statusCode).toBe(200);
      const plan = open.json();
      expect(plan.steps.map((x: { kind: string }) => x.kind)).toEqual(['swap', 'open']);
      expect(plan.summary.join(' ')).toMatch(/belongs to your wallet/);
      expect(asked.open[0]).toMatchObject({ owner: owner.address, pool: { address: 'PS1', mintX: SOL, mintY: USDC, price: 150 }, side: 'both' });
      const budget = (asked.open[0] as { budget: Record<string, number> }).budget[SOL];
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(1);
      expect((await scApp.inject({ url: `/vaults/${v.id}/wallet/pending`, headers })).json()).toEqual([expect.objectContaining({ planId: plan.planId, action: 'open', pair: 'SOL / USDC' })]);
      expect((await prepare({ action: 'open', poolId: 'PS1', sol: 0 })).json().error).toBe('invalid_amount');
      expect((await prepare({ action: 'open', poolId: 'PS1', sol: 1, shape: 'zigzag' })).json().error).toBe('invalid_shape');

      // The relay: only transactions the owner's wallet paid for and signed, calling Binwise's programs.
      const blockhash = Keypair.generate().publicKey.toBase58();
      const build = (payer: Keypair, program = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })) =>
        new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [program] }).compileToV0Message());
      const signed = build(kp);
      signed.sign([kp]);
      const ok = await relay(Buffer.from(signed.serialize()));
      expect(ok.json()).toEqual({ signature: 'SIG1', status: 'confirmed' });
      expect(sent).toEqual([Buffer.from(signed.serialize())]);
      expect((await relay(Buffer.from(build(kp).serialize()))).json().error).toBe('unsigned');
      const stranger = Keypair.generate();
      const theirs = build(stranger);
      theirs.sign([stranger]);
      expect((await relay(Buffer.from(theirs.serialize()))).json().error).toBe('bad_tx');
      const other = build(kp, new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) }));
      other.sign([kp]);
      expect((await relay(Buffer.from(other.serialize()))).json().error).toBe('bad_tx');
      // Phantom's own guard instructions (Lighthouse) may ride along.
      const guarded = build(kp, new TransactionInstruction({ programId: new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'), keys: [], data: Buffer.alloc(1) }));
      guarded.sign([kp]);
      expect((await relay(Buffer.from(guarded.serialize()))).json()).toEqual({ signature: 'SIG2', status: 'confirmed' });
      sent.pop();
      expect((await relay('bm90IGEgdHJhbnNhY3Rpb24=')).json().error).toBe('bad_tx');
      simErr = { InstructionError: [0, { Custom: 6004 }] };
      expect((await relay(Buffer.from(signed.serialize()))).json().error).toBe('sim_failed');
      simErr = null;
      expect(sent).toHaveLength(1);
      expect((await scApp.inject({ method: 'POST', url: `/vaults/${v.id}/wallet/send`, payload: { tx: 'AQ==' } })).statusCode).toBe(401);

      // Recorded from the chain, not from the page: nothing until the position is there, in the owner's name.
      expect((await done(plan.planId, ['SIG1'])).json().error).toBe('not_yet');
      chainPositions[POS] = { owner: Keypair.generate().publicKey.toBase58(), lowerBin: -10, upperBin: 10, amountX: 0.5, amountY: 75, feesUsd: 0 };
      expect((await done(plan.planId, ['SIG1'])).json().error).toBe('not_yours');
      chainPositions[POS] = { owner: owner.address, lowerBin: -10, upperBin: 10, amountX: 0.5, amountY: 75, feesUsd: 0 };
      const rec = await done(plan.planId, ['SIG1']);
      expect(rec.json()).toMatchObject({ ok: true, title: 'Added LP to SOL / USDC' });
      const pos = await db.position.findFirstOrThrow({ where: { vaultId: v.id } });
      expect(pos).toMatchObject({ address: POS, status: 'open', lowerBin: -10, upperBin: 10, entryAmountA: 0.5, entryAmountB: 75, entryValueUsd: 150 });
      expect((await db.vault.findUniqueOrThrow({ where: { id: v.id } })).deposits).toEqual({ [SOL]: 0.5, [USDC]: 75 });
      expect(await db.decision.findUnique({ where: { idempotencyKey: `wplan:${plan.planId}` } })).toMatchObject({ type: 'deploy', txSig: 'SIG1' });
      // Once only, and the plan is no longer pending.
      expect((await done(plan.planId, ['SIG1'])).json()).toEqual({ ok: true, already: true });
      expect(await db.position.count({ where: { vaultId: v.id } })).toBe(1);
      expect((await scApp.inject({ url: `/vaults/${v.id}/wallet/pending`, headers })).json()).toEqual([]);
      expect((await prepare({ action: 'open', poolId: 'PS1', sol: 1, override: true })).json().error).toBe('held');

      // Claim: recorded once the fees have left the position.
      chainPositions[POS] = { ...chainPositions[POS]!, feesUsd: 2 };
      const claim = (await prepare({ action: 'claim', positionId: pos.id })).json();
      expect((await done(claim.planId, ['SIG3'])).json().error).toBe('not_yet');
      chainPositions[POS] = { ...chainPositions[POS]!, feesUsd: 0 };
      expect((await done(claim.planId, ['SIG3'])).json()).toMatchObject({ ok: true, title: 'Claimed fees from SOL / USDC' });
      expect((await db.position.findUniqueOrThrow({ where: { id: pos.id } })).feesClaimedUsd).toBe(2);

      // Close: the money comes back to the owner's wallet; recorded once the position is gone.
      const close = (await prepare({ action: 'close', positionId: pos.id })).json();
      expect(asked.close[0]).toMatchObject({ owner: owner.address, position: POS });
      expect(close.summary.join(' ')).toMatch(/comes back to your wallet/);
      expect((await done(close.planId, ['SIG2'])).json().error).toBe('not_yet');
      chainPositions[POS] = null;
      expect((await done(close.planId, ['SIG2'])).json()).toMatchObject({ ok: true, title: 'Closed SOL / USDC' });
      expect(await db.position.findUniqueOrThrow({ where: { id: pos.id } })).toMatchObject({ status: 'closed', valueUsd: 151 });
      expect((await db.decision.findUnique({ where: { idempotencyKey: `wplan:${close.planId}` } }))?.inputs).toMatchObject({ flowUsd: -151 });

      // A plan the wallet never carried out: after a few minutes nothing can land any more, so it is dropped.
      const never = (await prepare({ action: 'open', poolId: 'PS1', sol: 1, override: true })).json();
      expect((await done(never.planId, [])).json().error).toBe('not_yet');
      const stored = JSON.parse((await redis.get(`binwise:wplan:${never.planId}`))!);
      await redis.set(`binwise:wplan:${never.planId}`, JSON.stringify({ ...stored, createdAt: Date.now() - 4 * 60_000 }));
      expect((await done(never.planId, [])).json()).toMatchObject({ ok: false, dropped: true });
      expect((await scApp.inject({ url: `/vaults/${v.id}/wallet/pending`, headers })).json()).toEqual([]);
      expect(await db.position.count({ where: { vaultId: v.id, status: 'open' } })).toBe(0);

      // The global switches stop everything before anything is prepared or sent.
      await redis.set(REDIS_KEYS.kill, '1');
      expect((await prepare({ action: 'open', poolId: 'PS1', sol: 1 })).json().error).toBe('kill_switch');
      expect((await relay(Buffer.from(signed.serialize()))).json().error).toBe('kill_switch');
      await redis.del(REDIS_KEYS.kill);
      process.env.LIVE_TRADING_ENABLED = 'false';
      expect((await prepare({ action: 'open', poolId: 'PS1', sol: 1 })).json().error).toBe('live_disabled');
      expect(sent).toHaveLength(1);

      // Someone else's vault: not theirs to prepare for.
      process.env.LIVE_TRADING_ENABLED = 'true';
      const { headers: strangerHeaders } = await signIn(wallet(), '10.9.9.9');
      const foreign = await scApp.inject({ method: 'POST', url: `/vaults/${v.id}/wallet/prepare`, headers: strangerHeaders, payload: { action: 'open', poolId: 'PS1', sol: 1 } });
      expect([403, 404]).toContain(foreign.statusCode);
    } finally {
      process.env.LIVE_TRADING_ENABLED = prev;
      if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED;
      await redis.del(REDIS_KEYS.kill);
      await scApp.close(); // also closes sub2
    }
  });
});

describe('ending custody of an old vault wallet', () => {
  it('deletes the vault key only once the vault wallet is empty, then works from the owner\'s wallet', async () => {
    const owner = wallet();
    const agent = Keypair.generate().publicKey.toBase58();
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    let lamports = 1.2e9;
    let usdcLeft = 5;
    let positions: unknown[] = [];
    const conn = {
      getBalance: async () => lamports,
      getParsedTokenAccountsByOwner: async (_o: unknown, { programId }: { programId: { toBase58(): string } }) => ({
        value:
          programId.toBase58() === TOKEN_PROGRAM && usdcLeft > 0
            ? [{ account: { data: { parsed: { info: { mint: USDC, tokenAmount: { uiAmount: usdcLeft, decimals: 6 } } } } } }]
            : [],
      }),
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const relApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never, positionsOf: async () => positions });
    try {
      const user = await ensureUser(db, owner.address);
      const v = await createVault(db, user.id, { live: { agentPubkey: agent, encSecret: new Uint8Array(8) } });
      const ip = { remoteAddress: '10.9.9.11' };
      const nonce = (await relApp.inject({ url: `/auth/nonce?wallet=${owner.address}`, ...ip })).json();
      const login = await relApp.inject({ method: 'POST', url: '/auth/verify', ...ip, payload: { wallet: owner.address, message: nonce.message, signature: owner.signMsg(nonce.message) } });
      const headers = { cookie: `bw_session=${login.cookies.find((c) => c.name === 'bw_session')!.value}` };
      const release = (confirm = true) => relApp.inject({ method: 'POST', url: `/vaults/${v.id}/custody/release`, headers, payload: { confirm } });

      expect((await release(false)).json().error).toBe('confirm_required');
      // Anything still in the vault wallet keeps the key: deleting it would lose those funds.
      const full = await release();
      expect(full.statusCode).toBe(409);
      expect(full.json()).toMatchObject({ error: 'funds_left', message: expect.stringMatching(/1\.2 SOL.*5 USDC|5 USDC.*1\.2 SOL/) });
      lamports = 0.001e9;
      expect((await release()).json().message).toMatch(/5 USDC/);
      usdcLeft = 0;
      positions = [{ address: 'P' }];
      expect((await release()).json().error).toBe('positions_open');
      positions = [];
      expect((await db.vault.findUniqueOrThrow({ where: { id: v.id } })).encSecret).not.toBeNull();

      const ok = await release();
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ mode: 'live', custody: 'wallet' });
      const row = await db.vault.findUniqueOrThrow({ where: { id: v.id } });
      expect([row.custody, row.agentPubkey, row.encSecret]).toEqual(['wallet', null, null]);
      expect((await db.decision.findFirstOrThrow({ where: { vaultId: v.id, title: 'Switched to your own wallet' } })).reason).toMatch(/0\.001 SOL/);
      // Nothing left to release; another owner can't release someone else's vault.
      expect((await release()).json().error).toBe('no_custody');
    } finally {
      await relApp.close(); // also closes sub2
    }
  });
});

describe('withdraw (live)', () => {
  it('says what can come out to the owner: SOL keeps 0.001, or the fee reserve while a position is open', async () => {
    const owner = wallet();
    const agent = wallet().address;
    const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const conn = {
      getBalance: async (pk: { toBase58(): string }) => (pk.toBase58() === agent ? 1.2 : 5) * 1e9,
      getParsedTokenAccountsByOwner: async (_pk: unknown, f: { programId: { toBase58(): string } }) => ({
        value: f.programId.toBase58() === TOKEN_PROGRAM ? [{ account: { data: { parsed: { info: { mint: USDC, tokenAmount: { uiAmount: 40, decimals: 6 } } } } } }] : [],
      }),
    };
    const sub2 = new Redis(process.env.REDIS_URL!);
    const liveApp = await buildDbApp({ db, redis, sub: sub2, domain: 'test.binwise', rpc: () => conn as never });
    const login = async (w: ReturnType<typeof wallet>, remoteAddress: string) => {
      const nonce = (await liveApp.inject({ url: `/auth/nonce?wallet=${w.address}`, remoteAddress })).json();
      const r = await liveApp.inject({ method: 'POST', url: '/auth/verify', remoteAddress, payload: { wallet: w.address, message: nonce.message, signature: w.signMsg(nonce.message) } });
      return { cookie: `bw_session=${r.cookies.find((c) => c.name === 'bw_session')!.value}` };
    };
    try {
      const v = await createVault(db, (await ensureUser(db, owner.address)).id, { live: { agentPubkey: agent, encSecret: new Uint8Array(8) } });
      const headers = await login(owner, '10.9.9.6');
      const read = async () => (await liveApp.inject({ url: `/vaults/${v.id}/withdrawable`, headers })).json();

      const idle = await read();
      expect(idle).toMatchObject({ to: owner.address, openPositions: 0, keptSol: 0.001 });
      expect(idle.tokens.map((t: { symbol: string; amount: number; decimals: number }) => [t.symbol, t.amount, t.decimals])).toEqual([
        ['SOL', 1.199, 9],
        ['USDC', 40, 6],
      ]);
      expect(idle.tokens[1].usd).toBe(40);

      // An open position: the fee reserve stays.
      await db.pool.create({ data: { id: 'PLW', name: 'SOL-USDC', tokenA: 'SOL', tokenB: 'USDC', mintA: SOL, mintB: USDC, binStep: 25, baseFee: 0.1 } });
      await db.position.create({
        data: { vaultId: v.id, poolId: 'PLW', binStep: 25, lowerBin: -10, upperBin: 10, shape: 'spot', entryAmountA: 1, entryAmountB: 100, entryPriceA: 150, entryPriceB: 1, entryValueUsd: 250, price: 150, valueUsd: 250 },
      });
      const busy = await read();
      expect(busy).toMatchObject({ openPositions: 1, keptSol: 0.25 });
      expect(busy.tokens[0].amount).toBeCloseTo(0.95);

      expect((await liveApp.inject({ url: `/vaults/${v.id}/withdrawable` })).statusCode).toBe(401);

      // A wallet made in Telegram is the vault itself: "to your wallet" would go nowhere.
      const self = wallet();
      const own = await createVault(db, (await ensureUser(db, self.address)).id, { live: { agentPubkey: self.address, encSecret: new Uint8Array(8) } });
      const selfHeaders = await login(self, '10.9.9.7');
      expect((await liveApp.inject({ url: `/vaults/${own.id}/withdrawable`, headers: selfHeaders })).json().error).toBe('same_wallet');
      expect((await liveApp.inject({ method: 'POST', url: `/vaults/${own.id}/withdraw`, headers: selfHeaders, payload: { token: 'SOL', amount: 0.1 } })).json().error).toBe('same_wallet');
    } finally {
      await liveApp.close(); // also closes sub2
    }
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
