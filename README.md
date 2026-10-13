# Kovra

(The GitHub repository is still named `binwise-lp`; code, packages, database and server all use `kovra`.)

Autonomous LP agent for Solana Meteora DLMM pools, plus the website where users watch and control it.
The full brief is in [CLAUDE.md](CLAUDE.md); the approved design is [design/original-prototype.html](design/original-prototype.html).

**Status:** the code for build steps 1–6 is in place and tested; what's left is running it.

- **Real data (step 3):** a collector stores Meteora DLMM pool snapshots, candles, token safety and scores every minute.
- **Scoring + backtester (step 4):** pure functions in `packages/core` with unit tests; `pnpm --filter @kovra/agent backtest` writes an owner-readable report.
- **Paper mode (step 5):** the agent runs Scan → Score → Check → Decide → Execute every 60s per vault on live prices, with simulated fills, and logs every decision with a reason.
- **Live mode (step 6):** the executor is written (DLMM SDK, Jupiter, Jito, simulate-first, program allowlist, kill switch, withdraw only to the owner). It stays off until `LIVE_TRADING_ENABLED=true` and the owner confirms in the app.
- **Smarter decisions:** the score weighs real fees (including Meteora's dynamic fee) against volatility loss, caps one-day volume spikes, and counts farm rewards. The agent reads the market regime (ranging, trending up or down), uses one-sided ranges in uptrends, stays out of downtrends, caps exposure to any one token, waits before re-entering a pool it just left, and exits immediately on a stablecoin depeg, a sudden TVL drain or a pool price far from the market. See [How the agent decides](#how-the-agent-decides).
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
pnpm --filter @kovra/db migrate:deploy
pnpm --filter @kovra/agent collector   # terminal 1
pnpm --filter @kovra/agent agent       # terminal 2
pnpm dev                                  # web :3000 + API :4000
pnpm --filter @kovra/agent seed        # once, after the first collector run
```

## How the agent decides

Tunable settings (deploy/exit score, range width, rebalance rule and mode, regime, exposure cap, re-entry wait, EMA exit mode) live in `AgentParams` in `packages/core/src/scoring.ts`. The agent uses the active row in the `ParamSet` table, or the built-in defaults when there is none.

```bash
# Search for better settings on past data. Tunes on the first 60% of each pool's history and
# judges on the rest, which it never saw. Writes reports/optimize-YYYY-MM-DD.md and stores the result.
pnpm --filter @kovra/agent optimize --days 60 --pools 15
# Same, but make the new settings active, only if they beat the current ones on unseen data.
pnpm --filter @kovra/agent optimize --days 60 --apply
```

The report also appears in the app at ⌘K → Backtest report, under the latest backtest.

Known token unlocks keep the agent out of a pool for the 48 hours before them. Add them by hand for now:

```sql
INSERT INTO "TokenEvent" (id, mint, at, kind, note) VALUES (gen_random_uuid()::text, '<mint>', '2026-11-01T00:00:00Z', 'unlock', '5% of supply');
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
