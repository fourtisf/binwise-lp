import { Redis } from 'ioredis';
import { MockEngine } from '@kovra/mock';
import { getDb } from '@kovra/db';
import { BRAND } from '@kovra/core';
import { buildApp } from './mock-app';
import { buildDbApp } from './db-app';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '127.0.0.1';
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Real data when a database is configured; the simulator only when asked for (API_MODE=mock).
const mock = process.env.API_MODE === 'mock' || !process.env.DATABASE_URL;

let close: () => Promise<void>;
let app;
if (mock) {
  const engine = new MockEngine({ liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true' }).start();
  app = await buildApp({ engine, corsOrigins, logger: true });
  close = async () => engine.stop();
} else {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const redis = new Redis(url);
  const sub = new Redis(url);
  app = await buildDbApp({
    db: getDb(),
    redis,
    sub,
    corsOrigins,
    logger: true,
    domain: process.env.PUBLIC_DOMAIN || BRAND,
  });
  close = async () => {
    await redis.quit();
    await getDb().$disconnect();
  };
}

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port, host });
app.log.info(`${BRAND} API in ${mock ? 'MOCK' : 'database'} mode`);
