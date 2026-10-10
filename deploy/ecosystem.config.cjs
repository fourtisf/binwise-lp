// PM2 process list for the VPS. Start with: pm2 start deploy/ecosystem.config.cjs
// Each app reads the repo-root .env.
module.exports = {
  apps: [
    { name: 'binwise-web', cwd: './apps/web', script: 'pnpm', args: 'start', env: { PORT: 3000, NODE_ENV: 'production' }, max_memory_restart: '600M' },
    { name: 'binwise-api', cwd: './apps/api', script: 'pnpm', args: 'start', env: { NODE_ENV: 'production' }, max_memory_restart: '500M' },
    // Pool snapshots every minute (build step 3)
    { name: 'binwise-collector', cwd: './apps/agent', script: 'pnpm', args: 'collector', env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
    // Agent loop for every vault, price ticks, Telegram (build step 5)
    { name: 'binwise-agent', cwd: './apps/agent', script: 'pnpm', args: 'agent', env: { NODE_ENV: 'production' }, max_memory_restart: '800M' },
  ],
};
