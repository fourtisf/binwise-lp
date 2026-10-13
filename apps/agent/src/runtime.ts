import { DEFAULT_COSTS, REDIS_KEYS } from '@kovra/core';
import {
  JitoClient,
  LiveExecutor,
  PaperExecutor,
  WalletReader,
  assertLiveTradingAllowed,
  assertLiveOwner,
  loadAgentKey,
  makeConnection,
  type Executor,
  type Holdings,
} from '@kovra/chain';
import { getDb, isSelfCustody, type PrismaClient } from '@kovra/db';
import { PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import { publish, redisIdempotency, redisKillSwitch, withVaultLock } from './redis';
import type { WithdrawChain } from './wallet';
import type { AgentDeps, VaultWithStrategy } from './agent';
import { Telegram } from './telegram';
import { proposalMessage } from './bot';

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
    liveCapacityLock: async (fn) => {
      for (let i = 0; i < 360; i++) {
        const r = await withVaultLock(redis, 'live-capacity', 60_000, fn);
        if (r !== null) return r;
        await new Promise((res) => setTimeout(res, 500));
      }
      throw new Error('Timed out waiting for other live deploys to finish.');
    },
    pendingPlanPositions: async (vaultId) => {
      const ids = await redis.smembers(REDIS_KEYS.walletPlans(vaultId));
      const plans = await Promise.all(ids.map((id) => redis.get(REDIS_KEYS.walletPlan(id))));
      return new Set(plans.flatMap((raw) => (raw ? [(JSON.parse(raw) as { positionId?: string }).positionId ?? ''] : [])).filter(Boolean));
    },
    // Manual mode: each new proposal goes to the owner's chat with Approve / Reject buttons.
    onProposal: telegram
      ? async (vault, proposal) => {
          const user = await db.user.findUnique({ where: { id: vault.userId } });
          if (!user?.telegramChatId) return;
          const m = proposalMessage(proposal, Date.now(), isSelfCustody(vault) ? `https://${process.env.PUBLIC_DOMAIN || 'kovra.live'}/app` : undefined);
          await telegram.send(user.telegramChatId, m.text, { html: true, keyboard: m.keyboard });
        }
      : undefined,
    executorFor: async (vault: VaultWithStrategy): Promise<Executor> => {
      const costs = { ...DEFAULT_COSTS, solUsd: await solUsd() };
      if (vault.mode !== 'live') return new PaperExecutor({ ...(vault.cash as Holdings) }, costs);
      assertLiveTradingAllowed(vault);
      const user = await db.user.findUniqueOrThrow({ where: { id: vault.userId } });
      assertLiveOwner(user, vault.agentPubkey);
      // Self-custody: no key here. The agent reads the owner's wallet and proposes; the owner signs.
      if (isSelfCustody(vault)) return new WalletReader({ conn: makeConnection(), owner: user.wallet, costs });
      if (!vault.encSecret) throw new Error('Live vault has no agent key.');
      return new LiveExecutor({
        conn: makeConnection(),
        agent: loadAgentKey(vault.encSecret, undefined, vault.agentPubkey),
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

/**
 * Withdrawals from Telegram: a live executor that sends to `to` (the registered wallet, or for a
 * wallet created in Telegram the address its owner typed). Like the app's withdraw, not gated on
 * LIVE_TRADING_ENABLED, so turning live trading off never traps funds; the kill switch still applies.
 */
export function makeWithdrawChain(redis: Redis): (vault: { encSecret: Uint8Array | null; agentPubkey: string | null }, to: string) => Promise<WithdrawChain> {
  return async (vault, to) => {
    if (!vault.encSecret) throw new Error('This vault has no agent wallet.');
    return new LiveExecutor({
      conn: makeConnection(),
      agent: loadAgentKey(vault.encSecret, undefined, vault.agentPubkey),
      ownerWallet: new PublicKey(to),
      killSwitch: redisKillSwitch(redis),
      idempotency: redisIdempotency(redis),
    });
  };
}
