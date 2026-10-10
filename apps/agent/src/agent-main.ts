import { JupiterClient } from '@binwise/chain';
import { getDb } from '@binwise/db';
import { CYCLE_MS, runManualAction, runManualDeploy, runVaultCycle, type ManualResult } from './agent';
import { BOT_COMMANDS, makeBot, resultMessage, type ManualRequest } from './bot';
import { KEYS, makeRedis, publish, withVaultLock } from './redis';
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
/** Manual Claim / Close (app or Telegram) and Add LP (Telegram) requests, picked up within a few seconds. */
async function manualActions() {
  const keys = await redis.keys(KEYS.actions('*'));
  for (const k of keys) {
    const vaultId = k.slice(KEYS.actions('').length);
    const vault = await db.vault.findUnique({ where: { id: vaultId }, include: { strategy: true } });
    if (!vault) {
      await redis.del(k);
      continue;
    }
    // Long enough for a live open (funding swaps + deposit), so a cycle can't start mid-action.
    await withVaultLock(redis, vaultId, 180_000, async () => {
      for (let raw = await redis.rpop(k); raw; raw = await redis.rpop(k)) {
        const req = JSON.parse(raw) as ManualRequest;
        let result: ManualResult | null = null;
        let error: string | undefined;
        try {
          result =
            req.action === 'deploy'
              ? await runManualDeploy(deps, vault, req.poolId!, req.usd ?? 0, req.id)
              : await runManualAction(deps, vault, req.positionId!, req.action, req.id);
        } catch (e) {
          error = (e as Error).message;
          const verb = req.action === 'deploy' ? 'add LP' : req.action;
          await db.decision.create({ data: { vaultId, poolId: req.poolId ?? null, type: 'skip', title: `Couldn't ${verb}`, reason: error, inputs: { manual: true } } });
        }
        if (req.chatId && telegram) await telegram.send(req.chatId, resultMessage(result, error)).catch((e) => console.error(`[telegram] ${(e as Error).message}`));
      }
    });
  }
}
const manualTimer = setInterval(() => manualActions().catch((e) => console.error(`[manual] ${(e as Error).message}`)), 3_000);
const tickTimer = setInterval(() => tickOnce(db, jupiter, deps.emit).catch((e) => console.error(`[ticker] ${(e as Error).message}`)), 10_000);
if (telegram) {
  const bot = makeBot({
    db,
    tg: telegram,
    enqueue: async (vaultId, req) => void (await redis.lpush(KEYS.actions(vaultId), JSON.stringify(req))),
    onPaused: async (v) => void (await publish(redis, v.id, { type: 'cycle', cycle: { cycle: v.cycle, step: -1, paused: true, intervalMs: CYCLE_MS, elapsedMs: 0, steps: [] } })),
    appUrl: `https://${process.env.PUBLIC_DOMAIN || 'binwise.org'}`,
  });
  telegram.setCommands(BOT_COMMANDS).catch((e) => console.error(`[telegram] ${(e as Error).message}`));
  void telegram.poll(bot, console.log);
  console.log('[telegram] bot running');
}

const stop = async () => {
  clearInterval(cycleTimer);
  clearInterval(tickTimer);
  clearInterval(manualTimer);
  telegram?.stop();
  await redis.quit();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
