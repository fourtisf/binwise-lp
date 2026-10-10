import { createVault, ensureUser, getDb } from '@binwise/db';

/**
 * Creates the public demo paper vault shown on the landing page.
 * Run after the collector has stored tokens: `pnpm --filter @binwise/agent seed`
 */
const db = getDb();
const DEMO_WALLET = 'binwise-demo-vault';
const usdc = await db.token.findFirst({ where: { symbol: 'USDC', isVerified: true }, orderBy: { mcapUsd: 'desc' } });
if (!usdc) {
  console.error('USDC is not in the token table yet. Start the collector first, then run seed again.');
  process.exit(1);
}
const user = await ensureUser(db, DEMO_WALLET);
const existing = await db.vault.findFirst({ where: { userId: user.id, isDemo: true } });
if (existing) {
  console.log(`Demo vault already exists: ${existing.id}`);
} else {
  const cash = { [usdc.mint]: 10_000 };
  const v = await createVault(db, user.id, { name: 'Demo vault', isDemo: true, cash });
  await db.vault.update({ where: { id: v.id }, data: { deposits: cash } });
  console.log(`Created demo paper vault ${v.id} with 10,000 simulated USDC.`);
}
await db.$disconnect();
