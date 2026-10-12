/** Redis keys and channels shared by the agent and the API. */
export const REDIS_KEYS = {
  kill: 'binwise:kill',
  idem: (k: string) => `binwise:idem:${k}`,
  lock: (vaultId: string) => `binwise:lock:vault:${vaultId}`,
  events: (vaultId: string) => `binwise:events:${vaultId}`,
  /** Manual requests (Claim / Close / Add LP / approved proposals), one list per vault */
  actions: (vaultId: string) => `binwise:actions:${vaultId}`,
  nonce: (wallet: string) => `binwise:nonce:${wallet}`,
  /** Self-custody: a plan prepared for the owner's wallet, until recorded */
  walletPlan: (planId: string) => `binwise:wplan:${planId}`,
  /** Self-custody: the plans prepared for one vault */
  walletPlans: (vaultId: string) => `binwise:wplan:vault:${vaultId}`,
};
