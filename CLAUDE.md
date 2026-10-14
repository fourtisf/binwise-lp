# Kovra (formerly Binwise) — Build Brief for Claude Code

Kovra is an autonomous LP (liquidity provider) agent for **Solana Meteora DLMM pools**, plus a website (landing page + web app) where users watch and control the agent.

The agent scans pools, scores them, deploys liquidity, rebalances only when it pays, and exits before downtrends. It must **actually work on-chain**, not just look good. Success metric shown everywhere: **net return vs simply holding the same tokens** (not APR).

The owner is non-technical. Work autonomously, make sensible decisions, and report progress in plain language. Ask only when a decision is irreversible or involves real funds.

---

## 0. Source of truth for UI

The look is **Kovra direction B, "cinematic"** (owner's choice, Oct 2026; reference: `design/kovra-direction-b.html`). It replaced the Binwise prototype's layout because the owner wanted the site to stop looking like Binwise.
- Landing: headline bottom-left with a **live bin ring** (chrome core, the demo vault's liquidity bin by bin, following the live window) on the right; centred section heads with pill kickers; the live demo in its own section as an **agent console** (the reasoning in big type, the live chart, one readout strip; no fake browser frame or mini-app); steps as a timeline; one glass panel of example metrics; FAQ in two columns; the final call to action inside a ring of bins.
- App shell (owner, Oct 2026: "still looks the same", so the Binwise sidebar is gone): no sidebar. A floating glass top bar (name back to the site, page tabs with a white pill for the current page, ⌘K search, mode, account), a big page head (vault + mode kicker, title, live-position chips), and a floating agent capsule at the bottom (state, next-cycle ring, pause). On tablets and phones the page tabs move to a floating dock and the agent shows as a compact pill in the top bar (pause is in ⌘K there). Pill buttons and segmented controls, 24px cards.
- App pages: Overview leads with net vs hold in big type beside a ring of bins for time in range, then the agent cycle as a horizontal pipeline with the decision, full-width performance, then position + activity. Pools put the three best scores on a podium above the ranked list. Positions are wide rows (net vs hold, live chart, numbers + actions). Activity is a timeline. Don't bring back the old Binwise layout (left sidebar, four KPI boxes, chart beside a reasoning card, three position cards).
- Premium black with a titanium (silver) accent, mint for gains and red for losses, Space Grotesk for headings and big numbers, Inter for body text. Every color is a token on `:root` in `apps/web/src/app/globals.css`; charts read the same tokens (`apps/web/src/lib/theme.ts`). Don't hardcode colors in components.
- `design/original-prototype.html` is still the source for content: copy, labels, data shown, empty/error wording and interactions. Don't drop features or disclaimers from it.
- The name users see comes from `BRAND` in `packages/core/src/brand.ts` (web imports `@kovra/core/brand`). Everything else is `kovra` too: `@kovra/*` packages, Redis keys, database, server user `kovra`, `/home/kovra/kovra`, PM2 `kovra-*`. Only the GitHub repo is still `binwise-lp`, and applied database migrations are never edited.
- Logo: **A, "Bin Ring"** (owner's pick, Oct 2026): bins round a chrome core, the in-range arc in mint. On the site it is `BrandMark` (`apps/web/src/components/BrandMark.tsx`); favicons, app icons and the share card are in `apps/web/public` and `apps/web/src/app/icon.svg`; the X profile picture and header are in `design/brand/`. The other proposals stay in `design/logos/`.
- Socials: X is [@kovrasol](https://x.com/kovrasol) (`X_URL` in `apps/web/src/lib/site.ts`). The token's contract address comes from `NEXT_PUBLIC_TOKEN_CA`; until it is set the landing page shows "CA: Coming soon".
- Every simulated number must be replaced by real data from the backend (see §5).
- Owner dislikes: black-and-gold palettes and white/light backgrounds. Keep the dark theme. Don't restyle again without the owner asking.

Pages:
- **Landing**: hero (headline + live bin ring), live demo window (live chart + agent reasoning), "Built on" strip, bento features, how it works, metrics, pricing, FAQ, final CTA, footer.
- **App**: top bar (name, nav, ⌘K search, mode, account), page head (vault, live positions), agent capsule (status, pause), Overview, Pools (+ score drawer), Positions, Strategy, Activity, Deposit modal, Command palette (⌘K).
- **Public portfolio** `/p/<publicId>` (owner's opt-in, off by default; switch and "show dollar amounts" on Portfolio → Public portfolio): a read-only page anyone can open without a wallet. It never shows the owner's wallet, the vault id or transaction signatures (an explorer would lead back to the wallet), and leaves deposits and withdrawals out of the moves. With amounts hidden, dollar and token amounts are masked and the chart is indexed to 100. Demo vaults can't be shared. The link stays the same when switched off and on again.

---

## 1. Stack (use this, it matches the owner's other production projects)

- **Frontend**: Next.js 14 (App Router), TypeScript, plain CSS with tokens (see §0)
- **API**: Fastify (TypeScript)
- **Agent worker**: separate Node process (TypeScript), managed by PM2
- **DB**: PostgreSQL + Prisma
- **Cache / queue / pubsub**: Redis
- **Realtime to browser**: WebSocket or SSE from API (live chart, decision feed, agent cycle state)
- **Chain**: `@solana/web3.js`, `@meteora-ag/dlmm` SDK, Jupiter API for swaps, Jito for bundles/priority, Helius (or Triton) RPC + websockets
- **Wallet connect**: Solana wallet adapter (Phantom, Backpack, Solflare)
- **Hosting**: Hostinger VPS, Nginx reverse proxy, PM2, HTTPS via Let's Encrypt

Always verify SDK method names against the **current** docs/npm versions. Do not guess APIs.

### Monorepo layout
```
kovra/
  apps/
    web/        # Next.js (landing + app)
    api/        # Fastify REST + WS/SSE
    agent/      # agent worker (scan, score, decide, execute)
  packages/
    core/       # shared types, scoring, strategy math (pure, unit-tested)
    chain/      # Meteora/Jupiter/Jito wrappers, tx builder, simulator
    db/         # Prisma schema + client
  design/original-prototype.html
  .env.example
```

---

## 2. Agent loop (runs every 60s per active vault)

1. **Scan** — fetch all DLMM pools (Meteora API + on-chain). Store snapshot. Filter:
   - TVL ≥ strategy floor (default $500k)
   - Both tokens on allowlist, token market cap ≥ strategy floor
   - Holder safety check passes (no bundled supply, no dev wallet above X%). Make this a pluggable module; owner has his own tools (BundleScan, DevRadar) that can be wired in later.
2. **Score** each eligible pool (0–100), pure function in `packages/core`:
   - `volTvl = volume24h / tvl` (most important)
   - `feeApr = volTvl * baseFee * 365`
   - `volatility` = 24h realized vol from 5m candles
   - `trend7d` = 7d price change, plus EMA20 vs EMA50 on 1h
   - `score = 30 + w1*volTvl + w2*baseFee − w3*volatility + w4*clamp(trend7d) + w5*holderQuality`
   - Weights live in DB per risk profile. Store the per-component breakdown — the UI shows it in the pool drawer.
3. **Decide** for each vault:
   - **Deploy** into top pools with score ≥ 62 (configurable), size = `min(vault * maxAllocPct, poolTvl * 2%)`. Strategy shape by profile: Spot (balanced), Curve (stable pairs), Bid-Ask (volatile). Range width scales with volatility.
   - **Rebalance** when active bin leaves range, only if `expectedFees(next 6h) > 1.5 × (tx fees + slippage + priority fee)`. Wait at least 1 tick (price often returns). Cooldown 30 min per pool.
   - **Exit** if: 7d trend < user exit threshold, OR EMA20 crosses below EMA50 on 1h, OR net-vs-hold < −X% for 24h, OR score below exit threshold 3 scans in a row.
   - **Compound** claimed fees when gas < 1% of claim.
   - **Daily loss stop**: if vault drops past user limit in 24h → close all, pause agent, notify.
4. **Execute** — build tx, **simulate first**, send (Jito when enabled), confirm, record.
5. **Log** every decision (including "hold" and "skip") with a plain-language reason. This feed is the product's main selling point.

### Net vs hold (core metric)
On each position open, store entry token amounts. `holdValue = entryA*priceA + entryB*priceB`. `netVsHold = (positionValue + claimedFees) / holdValue − 1`. Compute hourly; also at vault level.

---

## 3. Modes and safety (non-negotiable)

- **Paper mode is the default** and must be fully functional: same agent logic on live prices, simulated fills (include fees + slippage model). Paper and live share 100% of decision code; only the executor differs.
- **Live mode** requires an env flag `LIVE_TRADING_ENABLED=true` AND per-vault opt-in. Never enable by default.
- Custody, phase 1: per-user agent keypair, encrypted at rest (KMS or libsodium sealed box with key from env, never plaintext in DB or logs). User deposits into it and can withdraw anytime.
- Agent may only call: DLMM add/remove liquidity, claim fees, Jupiter swap (for rebalancing). Withdrawals only to the user's registered wallet. Enforce in the executor with an allowlist of program IDs.
- Global kill switch in Redis, checked before every tx.
- Simulate every transaction. Abort on simulation failure.
- Rate-limit and retry RPC with backoff. Never double-send a tx (idempotency key per decision).

---

## 4. Database (Prisma, starting point)

```
User(id, wallet, createdAt)
Vault(id, userId, name, mode[paper|live], status[running|paused], agentPubkey, encSecret?, createdAt)
Strategy(id, vaultId, profile[conservative|balanced|aggressive], maxAllocPct, minMcap, trendExitPct, dailyStopPct, weights Json, toggles Json)
Pool(id, address, tokenA, tokenB, binStep, baseFee, updatedAt)
PoolSnapshot(id, poolId, ts, tvl, volume24h, price, volatility, trend7d, score, scoreBreakdown Json)
Position(id, vaultId, poolId, address?, lowerBin, upperBin, shape, entryAmountA, entryAmountB, entryPriceA, entryPriceB, openedAt, closedAt?, status)
Decision(id, vaultId, poolId?, ts, type[scan|deploy|rebalance|exit|compound|hold|skip], title, reason, inputs Json, txSig?)
Tx(id, decisionId, sig, status, feeLamports, simulated Bool, ts)
VaultSnapshot(id, vaultId, ts, value, holdValue, feesTotal, netVsHold)
```

---

## 5. API (map to prototype screens)

- `GET /pools` — table rows: pair, TVL, vol24h, vol/TVL, fee APR, trend7d + sparkline, score, agent call
- `GET /pools/:id` — drawer: score breakdown, pool data, reason text
- `GET /vaults/:id/overview` — KPIs: value, today %, fees 30d, net vs hold 30d, positions in range, time in range
- `GET /vaults/:id/performance?range=7d|30d|90d` — vault vs hold series
- `GET /vaults/:id/positions` — positions with live bins, fees, IL, net vs hold
- `GET /vaults/:id/decisions?type=` — activity feed
- `PUT /vaults/:id/strategy`, `POST /vaults/:id/pause|resume`, `POST /vaults/:id/mode`
- `POST /vaults/:id/deposit`, `POST /vaults/:id/withdraw`, `POST /positions/:id/claim|close`
- `PUT /vaults/:id/public` (owner: `{enabled, showAmounts?}`), `GET /public/:publicId` (anyone; 404 when off or unknown)
- `WS /stream?vault=` — price ticks for open positions, agent cycle steps (Scan → Score → Check positions → Decide → Execute), new decisions
- Landing hero "live window": public read-only demo stream from a paper vault.

---

## 6. Build order (do not skip steps)

1. **Repo + infra**: monorepo, Prisma schema, docker-compose for Postgres/Redis locally, `.env.example`.
2. **Frontend from prototype** with mocked API (owner wants to deploy the website first). Deploy landing + app shell to VPS.
3. **Data collector**: pool snapshots every minute into Postgres.
4. **Scoring + backtester** in `packages/core`. Backtest on ≥30 days of stored/historical data, report strategy vs hold after costs. Owner must see this report.
5. **Paper mode** end-to-end: agent loop, decision log, live UI. Run 2–4 weeks.
6. **Live mode** behind flag, one pool, small capital ($100–500), owner approval required.
7. Open to users, Telegram alerts, pricing (10% of profit above hold — placeholder, owner to confirm).

### Acceptance checks per step
- Frontend: screenshots at 1440px and 390px follow §0; no horizontal scroll on mobile; ⌘K palette works.
- Scoring: unit tests for score, net-vs-hold, rebalance-cost rule, exit rules.
- Paper mode: every cycle produces a logged decision; feed shows reasons; numbers reconcile with snapshots.
- Live: every tx simulated first; kill switch tested; withdraw-to-owner tested on devnet before mainnet.

---

## 7. Env vars (.env.example)
```
DATABASE_URL=
REDIS_URL=
RPC_URL=                # Helius/Triton mainnet
RPC_WS_URL=
DEVNET_RPC_URL=
JUPITER_API_URL=
JITO_BLOCK_ENGINE_URL=
AGENT_KEY_ENCRYPTION_SECRET=
LIVE_TRADING_ENABLED=false
TELEGRAM_BOT_TOKEN=
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_WS_URL=
```

---

## 8. Honesty rules for copy and data

- No strategy is guaranteed to profit. Keep the prototype's disclaimers.
- Metrics on the landing page (+6.8%, 93%, etc.) are **examples**. Replace with real backtest/paper results once available, and keep the "example/simulated" label until then.
- Never display APR as the headline number; net vs hold is the headline.
