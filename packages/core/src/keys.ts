/** Redis keys and channels shared by the agent and the API. */
export const REDIS_KEYS = {
  kill: 'binwise:kill',
  idem: (k: string) => `binwise:idem:${k}`,
  lock: (vaultId: string) => `binwise:lock:vault:${vaultId}`,
  events: (vaultId: string) => `binwise:events:${vaultId}`,
  /** Manual Claim / Close requests from the API, one list per vault */
  actions: (vaultId: string) => `binwise:actions:${vaultId}`,
  nonce: (wallet: string) => `binwise:nonce:${wallet}`,
};
