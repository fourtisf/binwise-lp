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
/**
 * The Telegram bot, when the site should point people to it: NEXT_PUBLIC_TELEGRAM_BOT is its username (no @).
 * Unset, nothing on the site links to a bot (Telegram-only mode, NEXT_PUBLIC_WALLET_LOGIN=false, needs it set).
 */
export const BOT_URL: string | null = process.env.NEXT_PUBLIC_TELEGRAM_BOT ? `https://t.me/${process.env.NEXT_PUBLIC_TELEGRAM_BOT}` : null;

const originOf = (url?: string) => {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
};

/** Where the site lives, for absolute links in share cards: NEXT_PUBLIC_SITE_URL, else the API's origin. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || originOf(process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:3000';

/** The project's X account. */
export const X_HANDLE = '@kovrasol';
export const X_URL = 'https://x.com/kovrasol';

/**
 * The token's contract address: NEXT_PUBLIC_TOKEN_CA, set once the token exists (then the landing page shows it
 * with a copy button). Until then the page says "Coming soon".
 */
export const TOKEN_CA: string | null = process.env.NEXT_PUBLIC_TOKEN_CA?.trim() || null;
