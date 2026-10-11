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
  if (!env.RPC_URL) throw new LiveTradingBlocked('RPC_URL must be set to a private mainnet RPC for live trading.');
}

/** Wallets allowed to use live mode (LIVE_WALLETS, comma-separated). Empty = nobody: fails closed. */
export function liveWallets(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.LIVE_WALLETS ?? '').split(',').map((w) => w.trim()).filter(Boolean));
}

/** True when this wallet may use live mode. LIVE_WALLETS=* opens live mode to everyone. */
export function isLiveWallet(wallet: string, env: Record<string, string | undefined> = process.env): boolean {
  const w = liveWallets(env);
  return w.has('*') || w.has(wallet);
}

export function assertLiveWallet(wallet: string, env: Record<string, string | undefined> = process.env): void {
  if (!isLiveWallet(wallet, env)) throw new LiveTradingBlocked('Live mode is limited to approved wallets while it is being tested.');
}

/** Telegram users allowed to create a live wallet in the bot (LIVE_TELEGRAM_IDS, comma-separated). */
export function isLiveTelegram(chatId: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (liveWallets(env).has('*')) return true;
  if (!chatId) return false;
  return (env.LIVE_TELEGRAM_IDS ?? '').split(',').map((x) => x.trim()).includes(chatId);
}

/**
 * Whether a vault's owner may use live mode: a website user by wallet (LIVE_WALLETS); a wallet
 * created in Telegram (its own agent wallet is the owner) by Telegram id (LIVE_TELEGRAM_IDS).
 */
export function assertLiveOwner(
  user: { wallet: string; telegramChatId: string | null },
  agentPubkey: string | null,
  env: Record<string, string | undefined> = process.env,
): void {
  if (isLiveWallet(user.wallet, env)) return;
  if (agentPubkey && user.wallet === agentPubkey && isLiveTelegram(user.telegramChatId, env)) return;
  throw new LiveTradingBlocked('Live mode is limited to approved wallets while it is being tested.');
}

/**
 * Hard limits for live vaults while live trading is new: the agent never has more than
 * LIVE_MAX_USD in positions per vault, nor more than LIVE_MAX_POSITIONS positions (defaults $200, 1),
 * and never more than LIVE_MAX_TOTAL_USD across all live vaults together (default $2,000).
 */
export function liveLimits(env: Record<string, string | undefined> = process.env): { maxUsd: number; maxPositions: number; maxTotalUsd: number } {
  const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { maxUsd: num(env.LIVE_MAX_USD, 200), maxPositions: Math.floor(num(env.LIVE_MAX_POSITIONS, 1)), maxTotalUsd: num(env.LIVE_MAX_TOTAL_USD, 2000) };
}
