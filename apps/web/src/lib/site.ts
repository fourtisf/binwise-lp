/**
 * Build-time site settings. NEXT_PUBLIC_DEFAULT_VAULT_MODE=live means new wallets start on
 * Solana mainnet (real funds), so the copy must not promise a simulation.
 */
export const LIVE_DEFAULT = process.env.NEXT_PUBLIC_DEFAULT_VAULT_MODE === 'live';

/**
 * Wallet sign-in and deposits on the website. Off (default): vaults are created, funded and managed
 * in the Telegram bot; the website shows pools, the agent and its decisions. NEXT_PUBLIC_WALLET_LOGIN=true
 * turns the wallet flow back on.
 */
export const WALLET_LOGIN = process.env.NEXT_PUBLIC_WALLET_LOGIN === 'true';
export const BOT_URL = `https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT || 'binwiselpbot'}`;
