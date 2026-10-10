# Deploying Binwise to the VPS

Two ways to run it:

- **Website only (simulation):** the site runs on built-in simulated data. No database needed. Good for showing the design.
- **Full system (real data, paper mode):** collector + agent + API + website on real Meteora data. Paper mode is the default: simulated funds, real prices.

Live trading is **off** in both. It needs `LIVE_TRADING_ENABLED=true` *and* the owner switching a vault to live with an explicit confirmation. Only turn the flag on with the owner's approval (build step 6).

You need: SSH access to the VPS (Ubuntu 22.04/24.04), a domain pointed at the VPS IP (an `A` record), and about 30 minutes.

## 1. One-time server setup

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx git postgresql redis-server
sudo npm install -g pnpm@10 pm2
```

Create the database:

```bash
sudo -u postgres psql -c "CREATE USER binwise WITH PASSWORD 'choose-a-strong-password';"
sudo -u postgres psql -c "CREATE DATABASE binwise OWNER binwise;"
```

## 2. Get the code and configure

```bash
git clone https://github.com/fourtisf/binwise-lp.git binwise
cd binwise
cp .env.example .env
nano .env
```

Fill in at least:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://binwise:choose-a-strong-password@localhost:5432/binwise` |
| `RPC_URL` | your Helius URL: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY` |
| `SESSION_SECRET` | output of `openssl rand -hex 32` |
| `AGENT_KEY_ENCRYPTION_SECRET` | output of `openssl rand -base64 32` (keep a safe offline copy) |
| `ADMIN_TOKEN` | output of `openssl rand -hex 16` |
| `PUBLIC_DOMAIN` | `binwise.fi` (your domain) |
| `CORS_ORIGINS` | `https://binwise.fi` |
| `NEXT_PUBLIC_API_URL` | `https://binwise.fi/api` |
| `NEXT_PUBLIC_WS_URL` | `wss://binwise.fi/api` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_USERNAME` | from @BotFather (optional) |

Leave `LIVE_TRADING_ENABLED=false`.

## 3. Install, migrate, build

```bash
pnpm install
pnpm --filter @binwise/db migrate:deploy
pnpm --filter @binwise/web build
```

## 4. Start everything with PM2

```bash
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup        # run the command it prints, so it survives reboots
```

After a minute the collector has stored pools. Then create the public demo vault (shown on the landing page):

```bash
pnpm --filter @binwise/agent seed
```

Check: `pm2 logs binwise-collector` shows `scanned … eligible`, and `pm2 logs binwise-agent` shows cycles.

## 5. Nginx + HTTPS

```bash
sudo cp deploy/nginx/binwise.conf /etc/nginx/sites-available/binwise
sudo sed -i 's/YOUR_DOMAIN/binwise.fi/' /etc/nginx/sites-available/binwise
sudo ln -s /etc/nginx/sites-available/binwise /etc/nginx/sites-enabled/binwise
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d binwise.fi
```

Open `https://binwise.fi`, then **Launch app → Connect wallet**. Each wallet gets a paper vault with a simulated wallet (100 SOL + 10,000 USDC) to deposit from.

## 6. Backtest report (build step 4)

```bash
pnpm --filter @binwise/agent backtest            # 38 days, top 15 pools, balanced
pnpm --filter @binwise/agent backtest --profile conservative --days 45
```

The report is saved to `reports/backtest-YYYY-MM-DD.md` and shown in the app: press ⌘K → **Backtest report**.

### Settings search (optimiser)

PM2 runs a backtest and a settings search every Monday at 03:00 server time (`binwise-backtest` and `binwise-optimize` in `deploy/ecosystem.config.cjs`). Both reports appear under ⌘K → **Backtest report**. The weekly search never changes settings by itself; to switch to the recommended settings, run:

```bash
pnpm --filter @binwise/agent optimize --days 60 --apply   # activates only if it beats the current settings on unseen data
```

## Emergency stop (kill switch)

Stops every trade, paper and live, at the next transaction:

```bash
pnpm --filter @binwise/agent kill on       # off / status
# or over HTTP:
curl -X POST https://binwise.fi/api/admin/kill -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"on":true}'
```

## Updating after new commits

```bash
cd binwise && git pull && pnpm install && pnpm --filter @binwise/db migrate:deploy && pnpm --filter @binwise/web build && pm2 restart all
```

## Website only (no database)

Leave `DATABASE_URL`, `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` empty, then:

```bash
pnpm install && pnpm --filter @binwise/web build
pm2 start deploy/ecosystem.config.cjs --only binwise-web && pm2 save
```

## Before going live (build step 6, owner approval required)

1. Run paper mode for 2–4 weeks and read the backtest and paper results.
2. Test on devnet: set `RPC_URL` to a devnet RPC, `LIVE_TRADING_ENABLED=true`, switch a test vault to live, deposit devnet funds, check deploy / close / withdraw-to-owner and the kill switch.
3. Mainnet with one pool and $100–500, owner watching.
