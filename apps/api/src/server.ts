import { MockEngine } from '@binwise/mock';
import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '127.0.0.1';
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const engine = new MockEngine({ liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true' }).start();
const app = await buildApp({ engine, corsOrigins, logger: true });

const shutdown = async () => {
  engine.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port, host });
