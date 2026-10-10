// PM2 process list for the VPS. Start with: pm2 start deploy/ecosystem.config.cjs
// Env comes from the repo-root .env (each app's start script loads it).
module.exports = {
  apps: [
    {
      name: 'binwise-web',
      cwd: './apps/web',
      script: 'pnpm',
      args: 'start',
      env: { PORT: 3000, NODE_ENV: 'production' },
      max_memory_restart: '600M',
    },
    {
      name: 'binwise-api',
      cwd: './apps/api',
      script: 'pnpm',
      args: 'start',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '400M',
    },
    // The agent worker idles until build step 5. Enable it then:
    // { name: 'binwise-agent', cwd: './apps/agent', script: 'pnpm', args: 'start', env: { NODE_ENV: 'production' } },
  ],
};
