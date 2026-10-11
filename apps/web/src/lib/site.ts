/**
 * Build-time site settings. NEXT_PUBLIC_DEFAULT_VAULT_MODE=live means new wallets start on
 * Solana mainnet (real funds), so the copy must not promise a simulation.
 */
export const LIVE_DEFAULT = process.env.NEXT_PUBLIC_DEFAULT_VAULT_MODE === 'live';

/**
 * Wallet sign-in and deposits on the website (on by default). NEXT_PUBLIC_WALLET_LOGIN=false hides
 * them and points visitors to the Telegram bot instead.
 */
export const WALLET_LOGIN = process.env.NEXT_PUBLIC_WALLET_LOGIN !== 'false';
export const BOT_URL = `https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT || 'binwiselpbot'}`;
