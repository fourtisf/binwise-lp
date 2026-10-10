import { Redis } from 'ioredis';
import { REDIS_KEYS, type StreamEvent } from '@binwise/core';
import type { IdempotencyGuard, KillSwitch } from '@binwise/chain';

/** Redis keys and channels shared with the API. */
export const KEYS = REDIS_KEYS;

export function makeRedis(url = process.env.REDIS_URL || 'redis://localhost:6379') {
  return new Redis(url, { maxRetriesPerRequest: 3 });
}

/** Global kill switch: when set, nothing is sent on-chain and no paper action runs. */
export const redisKillSwitch = (r: Redis): KillSwitch => ({
  isKilled: async () => (await r.get(KEYS.kill)) === '1',
});

/** Each action key can run once (kept 7 days). */
export const redisIdempotency = (r: Redis): IdempotencyGuard => ({
  claim: async (key) => (await r.set(KEYS.idem(key), '1', 'EX', 7 * 86400, 'NX')) === 'OK',
});

/** Per-vault lock so two agent processes never run the same vault at once. */
export async function withVaultLock<T>(r: Redis, vaultId: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const token = Math.random().toString(36).slice(2);
  if ((await r.set(KEYS.lock(vaultId), token, 'PX', ttlMs, 'NX')) !== 'OK') return null;
  try {
    return await fn();
  } finally {
    // Release only our own lock.
    await r.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, KEYS.lock(vaultId), token);
  }
}

export const publish = (r: Redis, vaultId: string, e: StreamEvent) => r.publish(KEYS.events(vaultId), JSON.stringify(e));
