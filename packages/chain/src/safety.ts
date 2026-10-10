import type { VaultMode } from '@binwise/core';

export class LiveTradingBlocked extends Error {}

/**
 * Live trading needs BOTH the global env flag and the vault's own opt-in
 * (CLAUDE.md §3). Paper vaults never reach a real executor.
 */
export function assertLiveTradingAllowed(
  vault: { mode: VaultMode },
  env: Record<string, string | undefined> = process.env,
): void {
  if (env.LIVE_TRADING_ENABLED !== 'true') throw new LiveTradingBlocked('LIVE_TRADING_ENABLED is not "true".');
  if (vault.mode !== 'live') throw new LiveTradingBlocked('This vault has not opted in to live mode.');
}
