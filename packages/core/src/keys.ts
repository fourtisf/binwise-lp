/** Redis keys and channels shared by the agent and the API. */
export const REDIS_KEYS = {
  kill: 'kovra:kill',
  idem: (k: string) => `kovra:idem:${k}`,
  lock: (vaultId: string) => `kovra:lock:vault:${vaultId}`,
  events: (vaultId: string) => `kovra:events:${vaultId}`,
  /** Manual requests (Claim / Close / Add LP / approved proposals), one list per vault */
  actions: (vaultId: string) => `kovra:actions:${vaultId}`,
  nonce: (wallet: string) => `kovra:nonce:${wallet}`,
  /** Self-custody: a plan prepared for the owner's wallet, until recorded */
  walletPlan: (planId: string) => `kovra:wplan:${planId}`,
  /** Self-custody: the plans prepared for one vault */
  walletPlans: (vaultId: string) => `kovra:wplan:vault:${vaultId}`,
};
