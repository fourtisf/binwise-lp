import { JupiterClient, createAgentKey, exportAgentSecret, makeConnection, sealImportedKey, walletBalances } from '@binwise/chain';
import { getDb } from '@binwise/db';
import { CYCLE_MS, runApprovedProposal, runManualAction, runManualDeploy, runVaultCycle, type ManualResult } from './agent';
import { BOT_COMMANDS, makeBot, resultMessage, type ManualRequest } from './bot';
import { KEYS, makeRedis, publish, withVaultLock } from './redis';
import { makeAgentDeps, makeWithdrawChain } from './runtime';
import { runWithdraw } from './wallet';
import { Telegram } from './telegram';
import { tickOnce } from './ticker';

/** Agent worker (PM2): runs every running vault once per minute, plus live price ticks and Telegram. */
const db = getDb();
const redis = makeRedis();
const telegram = process.env.TELEGRAM_BOT_TOKEN ? new Telegram(process.env.TELEGRAM_BOT_TOKEN) : null;
const deps = makeAgentDeps(redis, db, telegram);
const withdrawChain = makeWithdrawChain(redis);
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
          // Re-read inside the lock: the app or a manual action may have changed the vault meanwhile.
          const r = await withVaultLock(redis, vault.id, 60_000, async () => {
            const fresh = await db.vault.findUnique({ where: { id: vault.id }, include: { strategy: true } });
            return fresh?.status === 'running' ? runVaultCycle(deps, fresh) : null;
          });
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
    // The lock is renewed while each action runs, so a cycle can't start mid-action.
    await withVaultLock(redis, vaultId, 60_000, async () => {
      for (let raw = await redis.rpop(k); raw; raw = await redis.rpop(k)) {
        const req = JSON.parse(raw) as ManualRequest;
        // Fresh copy per request: the previous one may have changed cash or positions.
        const vault = await db.vault.findUnique({ where: { id: vaultId }, include: { strategy: true } });
        if (!vault) break;
        let result: ManualResult | null = null;
        let error: string | undefined;
        try {
          result =
            req.action === 'deploy'
              ? await runManualDeploy(deps, vault, req.poolId!, req.usd ?? 0, req.id)
              : req.action === 'proposal'
                ? await runApprovedProposal(deps, vault, req.proposalId!, req.id)
                : req.action === 'withdraw'
                  ? await runWithdraw({ db, killSwitch: deps.killSwitch, chainFor: withdrawChain }, vault, { id: req.id, mint: req.mint!, pct: req.pct ?? 100, to: req.to })
                  : await runManualAction(deps, vault, req.positionId!, req.action, req.id);
        } catch (e) {
          error = (e as Error).message;
          const verb = req.action === 'deploy' ? 'add LP' : req.action === 'proposal' ? 'carry out the approved trade' : req.action;
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
    balances: (address) => walletBalances(makeConnection(), address),
    newWallet: () => {
      const k = createAgentKey();
      return { pubkey: k.pubkey, encSecret: new Uint8Array(k.encSecret) };
    },
    importWallet: (input) => {
      const k = sealImportedKey(input);
      return k && { pubkey: k.pubkey, encSecret: new Uint8Array(k.encSecret) };
    },
    exportKey: async (v) => {
      if (!v.encSecret) throw new Error('This vault has no agent wallet.');
      return exportAgentSecret(v.encSecret, v.agentPubkey);
    },
    deleteMessage: (chatId, id) => telegram.deleteMessage(chatId, id),
    state: {
      get: (chatId) => redis.get(`binwise:tg:state:${chatId}`),
      set: async (chatId, value, ttl) => void (await redis.set(`binwise:tg:state:${chatId}`, value, 'EX', ttl)),
      del: async (chatId) => void (await redis.del(`binwise:tg:state:${chatId}`)),
    },
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
