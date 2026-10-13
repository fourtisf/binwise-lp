# Deploying Kovra to the VPS

Server names keep the project's code name `binwise` (system user, folder, database, PM2 processes): only what users see is called Kovra.

Two ways to run it:

- **Website only (simulation):** the site runs on built-in simulated data. No database needed. Good for showing the design.
- **Full system (real data, paper mode):** collector + agent + API + website on real Meteora data. Paper mode is the default: simulated funds, real prices.

Live trading is **off** in both. It needs `LIVE_TRADING_ENABLED=true` *and* the owner switching a vault to live with an explicit confirmation. Only turn the flag on with the owner's approval (build step 6).

You need: SSH access as root to the VPS (Ubuntu 22.04/24.04), and a domain whose `A` record points at the VPS IP.

## 1. Install (one command)

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/fourtisf/binwise-lp/refs/heads/main/deploy/install.sh
bash install.sh binwise.org
```

It takes about 10 minutes and does everything:

- Installs Node 22, pnpm, PM2, PostgreSQL, Redis, Nginx and certbot. Adds swap on small servers.
- Creates a `binwise` system user and puts the code in `/home/binwise/binwise`.
- Creates the database and `/home/binwise/binwise/.env` with fresh random secrets (readable by that user only). `LIVE_TRADING_ENABLED=false`.
- Installs dependencies, migrates the database, and builds the website for `https://binwise.org`.
- Starts web, API, collector and agent under PM2, set to restart on reboot, with log rotation.
- Schedules the weekly backtest and settings search with cron (Monday 03:00 and 03:30).
- Private ports: the website and API (3100/4100), Postgres and Redis listen on 127.0.0.1 only; nginx is the only way in.
  Firewall: if ufw is already on, it allows SSH, HTTP and HTTPS. If it's off, it's left as found (other apps on a shared server may need their ports).
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
bash install.sh binwise.org                 # re-install (keeps .env and data)
bash /home/binwise/binwise/deploy/update.sh   # update to the latest code: asks nothing, keeps .env and data
```

The site's NEXT_PUBLIC_* settings are baked in at build time; the install script rebuilds every time.

## Automatic or manual trading

**Strategy → Manual approval** (or 🤖/✋ Mode in the Telegram bot) switches how the agent acts:

- **Off (automatic):** the agent scans, decides and trades by itself every minute.
- **On (manual):** the agent still scans and decides every minute, but each trade (deploy, rebalance, compound, exit)
  becomes a proposal: a card on Overview and a Telegram message with ✅ Approve / ❌ Reject. Nothing runs until you approve.
  Proposals lapse after 60 minutes; after a rejection the agent doesn't ask about the same thing for 6 hours.
  Protective exits (stablecoin depeg, TVL drain, pool price far from market, daily loss stop) still run on their own.

## Telegram bot

One bot does alerts and control: 📊 Status, ➕ Add LP, 💼 Positions (claim / close), 💳 Wallet (deposit, withdraw, private key), ⏸ Pause / ▶️ Resume.
Add LP only offers pools that pass the agent's checks right now, asks for confirmation, respects the live limits,
and the agent manages the position afterwards. The bot only answers private chats.

1. In Telegram, open @BotFather → `/newbot` → pick a name and a username ending in `bot`. Copy the token.
2. Put `TELEGRAM_BOT_TOKEN=<token>` and `TELEGRAM_BOT_USERNAME=<username without @>` in `.env`, then `sudo -u binwise pm2 restart all`.
3. In the app: **Strategy** → turn on **Telegram alerts** → Telegram opens → press **Start**. The link code works for 15 minutes.

To disconnect a chat, send `/unlink` to the bot.

### Wallets in the bot (closed: funds stay in owners' own wallets)

Binwise no longer creates, imports or keeps wallets. In an unlinked chat the bot points to the website, where people
connect their own wallet; linking Telegram there gives alerts and proposals in the chat. A private key pasted in the bot
is still deleted at once.

Wallets made in the bot before keep working: **💳 Wallet** shows the balance, **💸 Withdraw** sends idle funds out, and
**🔐 Move to my wallet app** walks the owner through saving the key (**🔑 Private key**, imports into Phantom) and then
deleting it from Binwise (only after the key was shown). The vault then works from the owner's own wallet.

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

## Go live (one command)

```bash
bash /home/binwise/binwise/deploy/go-live.sh
```

Asks for the Helius key, Jupiter key, the owner's wallet address, who may trade live (only the owner, or everyone)
and the Telegram bot token; checks each one works; updates the code, rebuilds the site and restarts everything. Keys already saved in `.env` that still work are not asked again, and each key is saved as soon as it checks out; `bash deploy/go-live.sh --ubah` asks everything again (Enter keeps the saved value).
Keys are typed on the server and stored only in `.env` (a backup of the previous `.env` is kept next to it).
Run it again to change keys or to open live mode to everyone.

## Mainnet for everyone

To let any visitor connect a wallet and have the agent trade real funds:

```
LIVE_TRADING_ENABLED=true
LIVE_WALLETS=*                  # everyone may use live mode
DEFAULT_VAULT_MODE=live         # new wallets start on mainnet
NEXT_PUBLIC_DEFAULT_VAULT_MODE=live
LIVE_MAX_USD=200                # per vault
LIVE_MAX_TOTAL_USD=2000         # all vaults together
```

Rebuild the site after changing `NEXT_PUBLIC_*`. New wallets get a **self-custody** live vault: Binwise stores no key and
holds no funds. Add LP, close, claim and the agent's proposals (rebalance, exit, compound) are built by the API and signed
in the owner's own wallet, all steps in one approval; the agent only reads the wallet and proposes. Anyone can still
switch their vault to Paper. The landing-page demo stays a simulated paper vault.

Vaults from before, whose agent wallet Binwise holds the key of, take no new money and open no new positions; open ones
are still managed until closed. Their owners withdraw to their wallet, then **Switch to my own wallet** (Overview) deletes
the key, only once the vault wallet is empty.

## Going live (build step 6, owner approval required)

Live mode uses real funds, which stay in each owner's own wallet (self-custody): every transaction is signed there.
Safety rails, all on by default:

- `LIVE_TRADING_ENABLED=true` **and** the wallet listed in `LIVE_WALLETS` **and** the owner confirming in the app.
- `LIVE_MAX_USD` (default 200) and `LIVE_MAX_POSITIONS` (default 1): the agent never deploys more, whatever is deposited.
  `0` means no limit (also for `LIVE_MAX_TOTAL_USD`); `deploy/go-live.sh` asks. `MIN_POSITION_USD` (default 50, at least 1)
  is the smallest position the agent opens. The strategy's own sizing (max % of the vault per pool, at most 2% of a pool's TVL)
  always applies.
- A private `RPC_URL` is required. Every transaction is simulated first, checked against the program allowlist, and the kill switch is checked before sending.
- Withdrawals go only to the wallet that signed in, and keep working even if `LIVE_TRADING_ENABLED` is switched off again.

Steps:

1. Put a Helius mainnet URL in `RPC_URL` and `NEXT_PUBLIC_RPC_URL`, a Jupiter key in `JUPITER_API_KEY`, your wallet address in `LIVE_WALLETS`, and set `LIVE_TRADING_ENABLED=true`.
2. Rebuild the site and restart: `sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/web build && pm2 restart all'`.
3. In the app: Connect wallet → switch **Live** → confirm. Open a pool → Add LP with a small amount of SOL from your wallet
   (about 0.1 SOL more stays in the wallet for the position's rent and fees) → approve once in the wallet.
4. Watch Activity. Test **Close** on the position and the kill switch with the small amount before adding more.
5. To stop at once: `sudo -u binwise -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/agent kill on'`.
