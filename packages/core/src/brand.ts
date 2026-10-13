/**
 * The product name users see: website, Telegram bot, wallet sign-in, reports.
 *
 * Internal identifiers keep the original "binwise" on purpose and must not follow a rename: the
 * @binwise/* packages, Redis keys (the kill switch among them), the session cookie, the database,
 * PM2 process names and server paths. Renaming those would break a running install.
 */
export const BRAND = 'Kovra';
