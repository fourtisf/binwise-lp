/**
 * Build-time site settings. NEXT_PUBLIC_DEFAULT_VAULT_MODE=live means new wallets start on
 * Solana mainnet (real funds), so the copy must not promise a simulation.
 */
export const LIVE_DEFAULT = process.env.NEXT_PUBLIC_DEFAULT_VAULT_MODE === 'live';

/**
 * Wallet sign-in on the website (on by default). NEXT_PUBLIC_WALLET_LOGIN=false hides it and points
 * visitors to the Telegram bot instead. Deposits always go through the bot (💳 Wallet).
 */
export const WALLET_LOGIN = process.env.NEXT_PUBLIC_WALLET_LOGIN !== 'false';
export const BOT_URL = `https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT || 'binwiselpbot'}`;

/** The project's X account. It still has its Binwise-era handle: change both lines when it is renamed. */
export const X_HANDLE = '@binwiselp';
export const X_URL = 'https://x.com/binwiselp';

/** The project token (launched under the Binwise name): ticker and contract address (shown on the landing page with a copy button) */
export const TOKEN_TICKER = '$BWS';
export const TOKEN_CA = 'AHWEsrCE9hYNn8RomTbNNUUvgKVu6g3XU872asA4pump';

const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
};

/** The site's own host, shown in the landing page's product window: the domain it was built for. */
export const SITE_HOST = hostOf(process.env.NEXT_PUBLIC_SITE_URL) || hostOf(process.env.NEXT_PUBLIC_API_URL) || 'binwise.org';
