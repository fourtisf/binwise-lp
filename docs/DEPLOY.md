# Deploying Binwise to the VPS

Two ways to run it:

- **Website only (simulation):** the site runs on built-in simulated data. No database needed. Good for showing the design.
- **Full system (real data, paper mode):** collector + agent + API + website on real Meteora data. Paper mode is the default: simulated funds, real prices.

Live trading is **off** in both. It needs `LIVE_TRADING_ENABLED=true` *and* the owner switching a vault to live with an explicit confirmation. Only turn the flag on with the owner's approval (build step 6).

You need: SSH access as root to the VPS (Ubuntu 22.04/24.04), and a domain whose `A` record points at the VPS IP.

## 1. Install (one command)

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/fourtisf/binwise-lp/refs/heads/claude/new-session-ll75nf/deploy/install.sh
bash install.sh binwise.org
```

It takes about 10 minutes and does everything:

- Installs Node 22, pnpm, PM2, PostgreSQL, Redis, Nginx and certbot. Adds swap on small servers.
- Creates a `binwise` system user and puts the code in `/home/binwise/binwise`.
- Creates the database and `/home/binwise/binwise/.env` with fresh random secrets (readable by that user only). `LIVE_TRADING_ENABLED=false`.
- Installs dependencies, migrates the database, and builds the website for `https://binwise.org`.
- Starts web, API, collector and agent under PM2, set to restart on reboot, with log rotation.
- Schedules the weekly backtest and settings search with cron (Monday 03:00 and 03:30).
- Firewall: only SSH, HTTP and HTTPS are open. Ports 3000/4000, Postgres and Redis stay private.
- Nginx with `www` redirecting to the bare domain, plus an HTTPS certificate from Let's Encrypt that renews automatically.
- Waits for the first real Meteora data, creates the public demo vault, and runs health checks.

If DNS hasn't reached the server yet, the script says so and skips HTTPS. Run it again later.

**Back up** the `AGENT_KEY_ENCRYPTION_SECRET` and `ADMIN_TOKEN` lines from `.env` somewhere offline.

Optional keys (edit `.env`, then `sudo -u binwise pm2 restart all`):

| Variable | Why |
|---|---|
| `JUPITER_API_KEY` | free at portal.jup.ag; keyless price requests are heavily rate-limited |
| `RPC_URL` | Helius mainnet RPC; adds real active-bin liquidity to fee estimates |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` | alerts, from @BotFather |

## 2. Everyday commands

```bash
sudo -u binwise pm2 ls                      # status
sudo -u binwise pm2 logs binwise-agent      # live agent log (also: binwise-collector, binwise-api, binwise-web)
bash install.sh binwise.org                 # update to the latest code (keeps .env and data)
```

The site's NEXT_PUBLIC_* settings are baked in at build time; the install script rebuilds every time.

## 3. Backtest report (build step 4)

```bash
sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/agent backtest'   # 38 days, top 15 pools, balanced
sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/agent backtest --profile conservative --days 45'
```

The report is saved to `reports/backtest-YYYY-MM-DD.md` and shown in the app: press ⌘K → **Backtest report**.

### Settings search (optimiser)

Cron runs a backtest and a settings search every Monday at 03:00 and 03:30 server time (installed by `deploy/install.sh`; logs in `/home/binwise/backtest.log` and `optimize.log`). Both reports appear under ⌘K → **Backtest report**. The weekly search never changes settings by itself; to switch to the recommended settings, run:

```bash
sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/agent optimize --days 60 --apply'   # activates only if it beats the current settings on unseen data
```

## Emergency stop (kill switch)

Stops every trade, paper and live, at the next transaction:

```bash
sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/agent kill on'   # off / status
# or over HTTP:
curl -X POST https://binwise.org/api/admin/kill -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"on":true}'
```

## Going live (build step 6, owner approval required)

Live mode sends real transactions from a per-vault agent wallet. Safety rails, all on by default:

- `LIVE_TRADING_ENABLED=true` **and** the wallet listed in `LIVE_WALLETS` **and** the owner confirming in the app.
- `LIVE_MAX_USD` (default 200) and `LIVE_MAX_POSITIONS` (default 1): the agent never deploys more, whatever is deposited.
- A private `RPC_URL` is required. Every transaction is simulated first, checked against the program allowlist, and the kill switch is checked before sending.
- Withdrawals go only to the wallet that signed in, and keep working even if `LIVE_TRADING_ENABLED` is switched off again.

Steps:

1. Put a Helius mainnet URL in `RPC_URL` and `NEXT_PUBLIC_RPC_URL`, a Jupiter key in `JUPITER_API_KEY`, your wallet address in `LIVE_WALLETS`, and set `LIVE_TRADING_ENABLED=true`.
2. Rebuild the site and restart: `sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/web build && pm2 restart all'`.
3. In the app: Connect wallet → switch **Live** → confirm. Deposit a small amount of SOL (keep at least 0.25 SOL for fees and rent) and/or USDC.
4. Watch Activity. Test **Withdraw** and the kill switch with the small amount before adding more.
5. To stop at once: `sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/agent kill on'`.
