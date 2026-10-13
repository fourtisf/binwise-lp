import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DecisionType, PerformanceRange, StrategySettings, VaultMode } from '@kovra/core';
import { DEMO_IDS, MockEngine, MockError, startDemo } from '@kovra/mock';

export interface AppOptions {
  engine: MockEngine;
  corsOrigins?: string[];
  logger?: boolean;
}

const RANGES: PerformanceRange[] = [7, 30, 90];
const TYPES: DecisionType[] = ['scan', 'deploy', 'rebalance', 'exit', 'compound', 'hold', 'skip'];

/**
 * REST + WebSocket API (CLAUDE.md §5). Build step 2 serves it from the
 * simulated paper vault; steps 3–5 swap the engine for Postgres + the agent.
 */
export async function buildApp({ engine, corsOrigins = [], logger = false }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(cors, { origin: corsOrigins.length ? corsOrigins : false });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof MockError) return reply.status(err.status).send({ error: err.code, message: err.message });
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply
      .status(status)
      .send({ error: status >= 500 ? 'internal' : 'bad_request', message: status >= 500 ? 'Something went wrong.' : e.message });
  });

  const vault = (id: string) => {
    if (id !== engine.vaultId) throw new MockError('not_found', 'No vault with that id.', 404);
    return engine;
  };

  type VaultParams = { Params: { id: string } };

  app.get('/health', async () => ({ ok: true, mode: 'mock' }));

  app.get('/pools', async () => engine.getPools());
  app.get<{ Params: { id: string } }>('/pools/:id', async (req) => engine.getPool(req.params.id));

  app.get<VaultParams>('/vaults/:id/overview', async (req) => vault(req.params.id).getOverview());
  app.get<VaultParams & { Querystring: { range?: string } }>('/vaults/:id/performance', async (req) => {
    const range = Number.parseInt(req.query.range ?? '30', 10) as PerformanceRange;
    if (!RANGES.includes(range)) throw new MockError('invalid_range', 'Range must be 7d, 30d or 90d.');
    return vault(req.params.id).getPerformance(range);
  });
  app.get<VaultParams>('/vaults/:id/positions', async (req) => vault(req.params.id).getPositions());
  app.get<VaultParams & { Querystring: { type?: string } }>('/vaults/:id/decisions', async (req) => {
    const type = req.query.type as DecisionType | undefined;
    if (type && !TYPES.includes(type)) throw new MockError('invalid_type', 'Unknown decision type.');
    return vault(req.params.id).getDecisions(type);
  });
  app.get<VaultParams>('/vaults/:id/cycle', async (req) => vault(req.params.id).getCycle());
  app.get<VaultParams>('/vaults/:id/strategy', async (req) => vault(req.params.id).getStrategy());
  app.put<VaultParams & { Body: StrategySettings }>('/vaults/:id/strategy', async (req) =>
    vault(req.params.id).putStrategy(req.body),
  );

  app.post<VaultParams>('/vaults/:id/pause', async (req) => vault(req.params.id).pause());
  app.post<VaultParams>('/vaults/:id/resume', async (req) => vault(req.params.id).resume());
  app.post<VaultParams & { Body: { mode?: VaultMode } }>('/vaults/:id/mode', async (req) =>
    vault(req.params.id).setMode(req.body?.mode as VaultMode),
  );
  app.post<VaultParams & { Body: { token?: string; amount?: number } }>('/vaults/:id/deposit', async (req) =>
    vault(req.params.id).deposit(String(req.body?.token), Number(req.body?.amount)),
  );
  app.post<VaultParams>('/vaults/:id/withdraw', async (req) => {
    vault(req.params.id);
    throw new MockError('not_available', 'Withdrawals open with live mode. Paper funds are simulated.', 501);
  });

  app.post<{ Params: { id: string } }>('/positions/:id/claim', async (req) => engine.claim(req.params.id));
  app.post<{ Params: { id: string } }>('/positions/:id/close', async (req) => engine.close(req.params.id));

  app.register(async (ws) => {
    ws.get<{ Querystring: { vault?: string } }>('/stream', { websocket: true }, (socket, req) => {
      if ((req.query.vault ?? engine.vaultId) !== engine.vaultId) {
        socket.close(4404, 'unknown vault');
        return;
      }
      const off = engine.subscribe((e) => socket.send(JSON.stringify(e)));
      socket.on('close', off);
    });

    // Public read-only demo for the landing page window.
    ws.get<{ Querystring: { pair?: string } }>('/demo', { websocket: true }, (socket, req) => {
      const pair = req.query.pair ?? 'jup-sol';
      if (!DEMO_IDS.includes(pair)) {
        socket.close(4404, 'unknown pair');
        return;
      }
      const stop = startDemo(pair, (e) => socket.send(JSON.stringify(e)));
      socket.on('close', stop);
    });
  });

  return app;
}
