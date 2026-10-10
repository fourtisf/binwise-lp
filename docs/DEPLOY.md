# Deploying Binwise to the VPS

This puts the website online on your Hostinger VPS. Right now the site runs on
**built-in simulated data** (paper mode, no real funds), so you only need the
website itself. The API, database and agent are added in later build steps.

You need: SSH access to the VPS (Ubuntu 22.04 or 24.04), a domain pointed at the
VPS IP (an `A` record), and about 20 minutes.

## 1. One-time server setup

```bash
# Node 22, pnpm, PM2, Nginx, Certbot
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx git
sudo npm install -g pnpm@10 pm2
```

## 2. Get the code and build

```bash
git clone https://github.com/fourtisf/binwise-lp.git binwise
cd binwise
cp .env.example .env          # leave NEXT_PUBLIC_API_URL empty for now
pnpm install
pnpm --filter @binwise/web build
```

## 3. Start it with PM2

```bash
pm2 start deploy/ecosystem.config.cjs --only binwise-web
pm2 save
pm2 startup                   # run the command it prints, so the site survives reboots
```

Check it: `curl -I http://127.0.0.1:3000` should answer `200`.

## 4. Nginx + HTTPS

```bash
sudo cp deploy/nginx/binwise.conf /etc/nginx/sites-available/binwise
sudo sed -i 's/YOUR_DOMAIN/binwise.fi/' /etc/nginx/sites-available/binwise   # your domain
sudo ln -s /etc/nginx/sites-available/binwise /etc/nginx/sites-enabled/binwise
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d binwise.fi
```

Open `https://binwise.fi` — landing page. `https://binwise.fi/app` — the app.

## Updating after new commits

```bash
cd binwise && git pull && pnpm install && pnpm --filter @binwise/web build && pm2 restart binwise-web
```

## Later: switching the site to the API (build step 3+)

1. Start Postgres + Redis (`docker compose up -d`, or install them on the VPS).
2. In `.env` set `DATABASE_URL`, `REDIS_URL`, `CORS_ORIGINS=https://binwise.fi`, and
   `NEXT_PUBLIC_API_URL=https://binwise.fi/api`, `NEXT_PUBLIC_WS_URL=wss://binwise.fi/api`.
3. `pnpm --filter @binwise/db migrate:deploy`
4. `pnpm build && pm2 start deploy/ecosystem.config.cjs && pm2 save`

`LIVE_TRADING_ENABLED` stays `false`. Live trading is only switched on with the owner's explicit approval (build step 6).
