# Binwise

Autonomous LP agent for Solana Meteora DLMM pools, plus the website where users watch and control it.
The full brief is in [CLAUDE.md](CLAUDE.md); the approved design is [design/binwise-prototype.html](design/binwise-prototype.html).

**Status:** build steps 1–2 done. The website (landing + app) is a faithful rebuild of the prototype and
runs on a simulated paper vault until the data collector and agent land (steps 3–5).
Paper mode is the default; live trading is refused unless `LIVE_TRADING_ENABLED=true` and the vault opts in.

## Layout

```
apps/web       Next.js 14 — landing page + app (Overview, Pools, Positions, Strategy, Activity)
apps/api       Fastify REST + WebSocket (/stream, /demo), currently served by the simulator
apps/agent     Agent worker (PM2). Idle until step 5
packages/core  Shared API types, net-vs-hold, strategy limits
packages/mock  Simulated paper vault (prototype behavior) used until real data exists
packages/chain Executor safety guards; Meteora/Jupiter/Jito wrappers arrive in steps 5–6
packages/db    Prisma 7 schema, migrations and client
deploy/        PM2 + Nginx config for the VPS (see docs/DEPLOY.md)
```

## Run locally

```bash
pnpm install
pnpm dev:web          # http://localhost:3000 — works on its own, with simulated data
```

To run the site against the API instead:

```bash
cp .env.example .env  # set NEXT_PUBLIC_API_URL=http://localhost:4000 and NEXT_PUBLIC_WS_URL=ws://localhost:4000
pnpm dev              # web on :3000, API on :4000
```

Database (needed from step 3): `pnpm db:up` starts Postgres + Redis in Docker, then `pnpm db:migrate`.

## Checks

```bash
pnpm test        # unit tests (core, chain, mock, api)
pnpm typecheck
pnpm lint
pnpm build
```
