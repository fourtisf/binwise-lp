import { DEFAULT_COSTS } from '@binwise/core';
import {
  JitoClient,
  LiveExecutor,
  PaperExecutor,
  assertLiveTradingAllowed,
  loadAgentKey,
  makeConnection,
  type Executor,
  type Holdings,
} from '@binwise/chain';
import { getDb, type PrismaClient } from '@binwise/db';
import { PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import { publish, redisIdempotency, redisKillSwitch } from './redis';
import type { AgentDeps, VaultWithStrategy } from './agent';
import { Telegram } from './telegram';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Wires the agent to Postgres, Redis, the RPC and (optionally) Telegram. */
export function makeAgentDeps(redis: Redis, db: PrismaClient = getDb(), telegram: Telegram | null = null): AgentDeps {
  const killSwitch = redisKillSwitch(redis);
  const idem = redisIdempotency(redis);
  const solUsd = async () => (await db.token.findUnique({ where: { mint: SOL_MINT } }))?.priceUsd ?? DEFAULT_COSTS.solUsd;
  return {
    db,
    killSwitch,
    claimKey: idem.claim,
    emit: (vaultId, e) => void publish(redis, vaultId, e),
    log: (m) => console.log(m),
    notify: telegram
      ? async (vault, text) => {
          const user = await db.user.findUnique({ where: { id: vault.userId } });
          if (user?.telegramChatId) await telegram.send(user.telegramChatId, `${vault.name}: ${text}`);
        }
      : undefined,
    executorFor: async (vault: VaultWithStrategy): Promise<Executor> => {
      const costs = { ...DEFAULT_COSTS, solUsd: await solUsd() };
      if (vault.mode !== 'live') return new PaperExecutor({ ...(vault.cash as Holdings) }, costs);
      assertLiveTradingAllowed(vault);
      if (!vault.encSecret) throw new Error('Live vault has no agent key.');
      const user = await db.user.findUniqueOrThrow({ where: { id: vault.userId } });
      return new LiveExecutor({
        conn: makeConnection(),
        agent: loadAgentKey(vault.encSecret),
        ownerWallet: new PublicKey(user.wallet),
        killSwitch,
        idempotency: idem,
        jito: process.env.JITO_BLOCK_ENGINE_URL ? new JitoClient(process.env.JITO_BLOCK_ENGINE_URL) : null,
        tipLamports: Number(process.env.JITO_TIP_LAMPORTS ?? 10_000),
        costs,
      });
    },
  };
}
