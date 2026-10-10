/**
 * Agent worker: Scan → Score → Check positions → Decide → Execute, every 60s
 * per active vault (CLAUDE.md §2). The loop body arrives in build steps 3–5;
 * until then this process only starts, reports its mode and idles.
 */
const CYCLE_MS = 60_000;
const live = process.env.LIVE_TRADING_ENABLED === 'true';

console.log(`[agent] starting. Live trading ${live ? 'ENABLED by env flag' : 'off'}; paper mode is the default.`);

let cycle = 0;
const timer = setInterval(() => {
  cycle++;
  console.log(`[agent] cycle ${cycle}: no vaults wired yet (build step 5).`);
}, CYCLE_MS);

const stop = () => {
  clearInterval(timer);
  console.log('[agent] stopped.');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
