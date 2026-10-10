# Binwise

Autonomous LP agent for Solana Meteora DLMM pools, plus the website where users watch and control it.
The full brief is in [CLAUDE.md](CLAUDE.md); the approved design is [design/binwise-prototype.html](design/binwise-prototype.html).

**Status:** the code for build steps 1–6 is in place and tested; what's left is running it.

- **Real data (step 3):** a collector stores Meteora DLMM pool snapshots, candles, token safety and scores every minute.
- **Scoring + backtester (step 4):** pure functions in `packages/core` with unit tests; `pnpm --filter @binwise/agent backtest` writes an owner-readable report.
- **Paper mode (step 5):** the agent runs Scan → Score → Check → Decide → Execute every 60s per vault on live prices, with simulated fills, and logs every decision with a reason.
- **Live mode (step 6):** the executor is written (DLMM SDK, Jupiter, Jito, simulate-first, program allowlist, kill switch, withdraw only to the owner). It stays off until `LIVE_TRADING_ENABLED=true` and the owner confirms in the app.
- **Website:** a rebuild of the approved prototype, with wallet sign-in (Phantom, Backpack, Solflare) and one vault per wallet. Without an API it falls back to its built-in simulation.

## Layout

```
apps/web       Next.js 14 — landing page + app (Overview, Pools, Positions, Strategy, Activity)
apps/api       Fastify REST + WebSocket on Postgres/Redis; Sign-In With Solana (API_MODE=mock serves the simulator)
apps/agent     Collector, agent loop, price ticker, Telegram bot, backtest / kill / seed scripts
packages/core  Shared API types, net-vs-hold, strategy limits
packages/mock  Simulated vault for the website's standalone demo
packages/chain Meteora/Jupiter/Jito clients, paper + live executors, key custody, tx policy
packages/db    Prisma 7 schema, migrations and client
deploy/        PM2 + Nginx config for the VPS (see docs/DEPLOY.md)
```

## Run locally

```bash
pnpm install
pnpm dev:web          # http://localhost:3000 — works on its own, with simulated data
```

Full system locally:

```bash
cp .env.example .env   # set SESSION_SECRET, NEXT_PUBLIC_API_URL=http://localhost:4000, NEXT_PUBLIC_WS_URL=ws://localhost:4000
pnpm db:up             # Postgres + Redis in Docker
pnpm --filter @binwise/db migrate:deploy
pnpm --filter @binwise/agent collector   # terminal 1
pnpm --filter @binwise/agent agent       # terminal 2
pnpm dev                                  # web :3000 + API :4000
pnpm --filter @binwise/agent seed        # once, after the first collector run
```

## Checks

```bash
pnpm test        # unit + integration tests (integration tests need local Postgres + Redis)
pnpm typecheck
pnpm lint
pnpm build
```

## Credits

- Token logos in `apps/web/public/tokens` come from [Trust Wallet assets](https://github.com/trustwallet/assets) (MIT). In production the collector also pulls each token's logo from the Jupiter Tokens API.
- Wallet logos in `apps/web/public/wallets` come from [web3icons](https://github.com/0xa3k5/web3icons) (MIT). Installed wallets show the icon they provide themselves.
