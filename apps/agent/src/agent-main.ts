import { JupiterClient } from '@binwise/chain';
import { getDb } from '@binwise/db';
import { CYCLE_MS, runVaultCycle } from './agent';
import { makeRedis, publish, withVaultLock } from './redis';
import { makeAgentDeps } from './runtime';
import { Telegram } from './telegram';
import { tickOnce } from './ticker';

/** Agent worker (PM2): runs every running vault once per minute, plus live price ticks and Telegram. */
const db = getDb();
const redis = makeRedis();
const telegram = process.env.TELEGRAM_BOT_TOKEN ? new Telegram(process.env.TELEGRAM_BOT_TOKEN) : null;
const deps = makeAgentDeps(redis, db, telegram);
const jupiter = new JupiterClient();
const CONCURRENCY = Number(process.env.AGENT_CONCURRENCY ?? 4);

console.log(`[agent] starting. Live trading ${process.env.LIVE_TRADING_ENABLED === 'true' ? 'ENABLED by env flag (vaults must still opt in)' : 'off'}.`);

async function cycleAll() {
  const vaults = await db.vault.findMany({ where: { status: 'running' }, include: { strategy: true } });
  const queue = [...vaults];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let v = queue.shift(); v; v = queue.shift()) {
        const vault = v;
        try {
          const r = await withVaultLock(redis, vault.id, CYCLE_MS - 5_000, () => runVaultCycle(deps, vault));
          if (r) console.log(`[agent] ${vault.id} cycle ${vault.cycle + 1}: ${r.short}`);
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`[agent] ${vault.id}: ${msg}`);
          await db.decision
            .create({ data: { vaultId: vault.id, type: 'skip', title: 'Cycle failed', reason: `${msg} The agent will try again next cycle.`, inputs: {} } })
            .catch(() => {});
        }
      }
    }),
  );
  // Paused vaults show an idle cycle in the UI.
  const paused = await db.vault.findMany({ where: { status: 'paused' }, select: { id: true, cycle: true } });
  for (const p of paused)
    await publish(redis, p.id, { type: 'cycle', cycle: { cycle: p.cycle, step: -1, paused: true, intervalMs: CYCLE_MS, elapsedMs: 0, steps: [] } });
}

let running = false;
const loop = async () => {
  if (running) return;
  running = true;
  try {
    await cycleAll();
  } finally {
    running = false;
  }
};
void loop();
const cycleTimer = setInterval(loop, CYCLE_MS);
const tickTimer = setInterval(() => tickOnce(db, jupiter, deps.emit).catch((e) => console.error(`[ticker] ${(e as Error).message}`)), 10_000);
if (telegram) void telegram.poll(db, console.log);

const stop = async () => {
  clearInterval(cycleTimer);
  clearInterval(tickTimer);
  telegram?.stop();
  await redis.quit();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
