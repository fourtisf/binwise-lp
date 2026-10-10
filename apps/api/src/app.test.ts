import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_STRATEGY } from '@binwise/core';
import { MockEngine } from '@binwise/mock';
import { buildApp } from './app';

let app: FastifyInstance;
let engine: MockEngine;

beforeAll(async () => {
  engine = new MockEngine({ tickMs: 50 }).start();
  app = await buildApp({ engine });
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  engine.stop();
  await app.close();
});

describe('REST', () => {
  it('lists pools ranked by score', async () => {
    const res = await app.inject('/pools');
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(9);
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[1].score);
  });

  it('returns a pool with its score breakdown', async () => {
    const res = await app.inject('/pools/jup-sol');
    expect(res.json().breakdown).toHaveLength(5);
    expect((await app.inject('/pools/nope')).statusCode).toBe(404);
  });

  it('serves the vault overview, positions and performance', async () => {
    expect((await app.inject('/vaults/main/overview')).json().mode).toBe('paper');
    expect((await app.inject('/vaults/main/positions')).json()).toHaveLength(3);
    const perf = (await app.inject('/vaults/main/performance?range=7')).json();
    expect(perf.vault).toHaveLength(8);
    expect((await app.inject('/vaults/main/performance?range=5')).statusCode).toBe(400);
    expect((await app.inject('/vaults/other/overview')).statusCode).toBe(404);
  });

  it('filters decisions by type', async () => {
    const res = (await app.inject('/vaults/main/decisions?type=exit')).json();
    expect(res.every((d: { type: string }) => d.type === 'exit')).toBe(true);
  });

  it('refuses live mode while LIVE_TRADING_ENABLED is off', async () => {
    const res = await app.inject({ method: 'POST', url: '/vaults/main/mode', payload: { mode: 'live' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('live_disabled');
  });

  it('validates strategy updates', async () => {
    const ok = await app.inject({ method: 'PUT', url: '/vaults/main/strategy', payload: DEFAULT_STRATEGY });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'PUT', url: '/vaults/main/strategy', payload: { ...DEFAULT_STRATEGY, maxAllocPct: 99 } });
    expect(bad.statusCode).toBe(400);
  });

  it('pauses and resumes', async () => {
    expect((await app.inject({ method: 'POST', url: '/vaults/main/pause' })).json().status).toBe('paused');
    expect((await app.inject({ method: 'POST', url: '/vaults/main/resume' })).json().status).toBe('running');
  });
});

describe('WebSocket', () => {
  const url = (path: string) => {
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    return `ws://127.0.0.1:${addr.port}${path}`;
  };

  const firstMessages = (path: string, n: number) =>
    new Promise<{ type: string }[]>((resolve, reject) => {
      const ws = new WebSocket(url(path));
      const got: { type: string }[] = [];
      ws.on('message', (m) => {
        got.push(JSON.parse(m.toString()));
        if (got.length === n) {
          ws.close();
          resolve(got);
        }
      });
      ws.on('error', reject);
    });

  it('streams price ticks', async () => {
    const msgs = await firstMessages('/stream?vault=main', 3);
    expect(msgs.some((m) => m.type === 'tick')).toBe(true);
  });

  it('streams the landing demo', async () => {
    const msgs = await firstMessages('/demo?pair=sol-usdc', 1);
    expect(msgs[0].type).toBe('demo:snapshot');
  });
});
