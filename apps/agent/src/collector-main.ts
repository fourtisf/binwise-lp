import { JupiterClient, MeteoraClient, activeBinLiquidityUsd, makeConnection, metadataCheck, rpcConcentrationCheck, type HolderCheck } from '@binwise/chain';
import { activeParams, getDb } from '@binwise/db';
import { collectOnce, prune } from './collector';

/** Data collector (PM2): pool snapshots every minute into Postgres. */
const db = getDb();
const meteora = new MeteoraClient();
const jupiter = new JupiterClient();
const holderChecks: HolderCheck[] = [metadataCheck];
const conn = process.env.RPC_URL ? makeConnection() : null;
if (conn) holderChecks.push(rpcConcentrationCheck(conn));
// With an RPC, paper fees and rebalance estimates use the pool's real active-bin liquidity.
const activeBinLiq = conn ? (p: Parameters<typeof activeBinLiquidityUsd>[1]) => activeBinLiquidityUsd(conn, p) : undefined;

let running = false;
let runs = 0;
async function tick() {
  if (running) return;
  running = true;
  try {
    await collectOnce({ db, meteora, jupiter, holderChecks, activeBinLiq, params: await activeParams(db), log: console.log });
    if (++runs % 60 === 1) await prune(db);
  } catch (e) {
    const err = e as Error & { cause?: { message?: string; code?: string } };
    // Network errors hide the real reason (DNS, TLS, refused) in .cause.
    console.error(`[collector] ${err.message}${err.cause ? ` (${err.cause.code ?? ''} ${err.cause.message ?? ''})` : ''}`);
  } finally {
    running = false;
  }
}
void tick();
const timer = setInterval(tick, 60_000);
const stop = async () => {
  clearInterval(timer);
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
