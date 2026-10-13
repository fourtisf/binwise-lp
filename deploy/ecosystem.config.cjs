// PM2 process list for the VPS. Start with: pm2 start deploy/ecosystem.config.cjs
// Each app reads the repo-root .env. Paths are absolute so PM2 can be run from any directory.
// Weekly backtest / settings search run from cron (see deploy/install.sh), not PM2.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Read only WEB_PORT from the root .env (so secrets never end up in PM2's saved process list).
const envText = fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '';
const webPort = Number(/^WEB_PORT=(\d+)/m.exec(envText)?.[1] ?? 3000);
const app = (name, dir, args, mem) => ({
  name,
  cwd: path.join(root, dir),
  script: 'pnpm',
  args,
  env: { NODE_ENV: 'production' },
  max_memory_restart: mem,
  // Back off on repeated crashes instead of restarting in a tight loop.
  exp_backoff_restart_delay: 1000,
  time: true,
});

module.exports = {
  apps: [
    { ...app('kovra-web', 'apps/web', 'start', '600M'), env: { NODE_ENV: 'production', PORT: webPort } },
    app('kovra-api', 'apps/api', 'start', '500M'),
    // Pool snapshots every minute (build step 3)
    app('kovra-collector', 'apps/agent', 'collector', '600M'),
    // Agent loop for every vault, price ticks, Telegram (build step 5)
    app('kovra-agent', 'apps/agent', 'agent', '800M'),
  ],
};
