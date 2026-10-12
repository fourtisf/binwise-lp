#!/usr/bin/env bash
# Binwise: switch a running install to Solana mainnet (live trading) and turn on the Telegram bot.
# Run as root on the server, after deploy/install.sh:
#
#   bash /home/binwise/binwise/deploy/go-live.sh
#
# It asks only for keys that aren't saved yet (they are typed here and stored only in the server's .env),
# checks that each one works, updates the code, rebuilds and restarts. Safe to run again; to change keys
# or choices: bash deploy/go-live.sh --ubah
set -Eeuo pipefail
# The whole script is one block, so bash reads it completely before running: the git checkout below
# may replace this file while it runs.
{

APP_USER="binwise"
APP_DIR="/home/${APP_USER}/binwise"
ENV_FILE="${APP_DIR}/.env"
BRANCH="${BRANCH:-main}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "Gagal di baris $LINENO: $BASH_COMMAND"' ERR

as_app() { sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && $*"; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
# Sets KEY=VALUE in .env without a shell or sed touching the value (keys can contain ? = / &).
env_set() {
  KEY="$1" VALUE="$2" FILE="$ENV_FILE" node -e '
    const fs = require("fs");
    const { KEY, VALUE, FILE } = process.env;
    const lines = fs.readFileSync(FILE, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith(KEY + "="));
    if (i >= 0) lines[i] = KEY + "=" + VALUE; else lines.splice(lines.length - (lines.at(-1) === "" ? 1 : 0), 0, KEY + "=" + VALUE);
    fs.writeFileSync(FILE, lines.join("\n"));
  '
}

[[ $EUID -eq 0 ]] || die "Jalankan sebagai root."
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE tidak ada. Jalankan deploy/install.sh dulu."
command -v node >/dev/null || die "Node.js belum terpasang."

# ---------------------------------------------------------------- code
step "Ambil kode terbaru (branch ${BRANCH})"
sudo -u "$APP_USER" -H git -C "$APP_DIR" fetch -q origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
sudo -u "$APP_USER" -H git -C "$APP_DIR" checkout -q -f -B "$BRANCH" "origin/$BRANCH"
ok "Kode: $(sudo -u "$APP_USER" -H git -C "$APP_DIR" log -1 --format='%h %s')"
as_app "pnpm install --frozen-lockfile --reporter=silent"
as_app "pnpm --filter @binwise/db migrate:deploy" >/dev/null 2>&1 || die "Migrasi database gagal: jalankan  sudo -u $APP_USER -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/db migrate:deploy'  untuk melihat pesannya."
ok "Dependencies dan database terbaru"

# ---------------------------------------------------------------- keys
# Saved keys that still work are not asked again. `--ubah` asks everything (Enter keeps the saved value).
ASK_ALL=false
[[ "${1:-}" == "--ubah" || "${1:-}" == "--change" ]] && ASK_ALL=true
step "Kunci (disimpan hanya di .env server ini; yang sudah tersimpan tidak ditanya lagi)"
backup="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$backup" && chmod 600 "$backup"
# Each key is saved as soon as it checks out, so stopping halfway never loses what was typed.
save() { env_set "$1" "$2"; chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"; }

rpc_ok() { [[ "$(curl -fsS --max-time 15 -X POST "$1" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || true)" == *'"result":"ok"'* ]]; }
jup_ok() { [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "x-api-key: $1" "https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112" || true)" == 200 ]]; }
tg_name() { curl -fsS --max-time 15 "https://api.telegram.org/bot$1/getMe" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.ok?j.result.username:"")}catch{}})' || true; }

# Helius
rpc=$(env_get RPC_URL)
if ! $ASK_ALL && [[ -n "$rpc" ]] && rpc_ok "$rpc"; then
  ok "Helius: tersimpan dan berfungsi"
else
  [[ -n "$rpc" ]] && ! rpc_ok "$rpc" && warn "Helius yang tersimpan tidak menjawab."
  while true; do
    read -r -s -p "    Helius API key$( [[ -n "$rpc" ]] && echo ' (Enter = pakai yang tersimpan)'): " helius; echo
    if [[ -z "$helius" ]]; then cand="$rpc"; elif [[ "$helius" == https://* ]]; then cand="$helius"; else cand="https://mainnet.helius-rpc.com/?api-key=${helius}"; fi
    [[ -n "$cand" ]] || { warn "Isi Helius API key (gratis di dashboard.helius.dev)."; continue; }
    rpc_ok "$cand" && { rpc="$cand"; break; }
    warn "Helius tidak menjawab. Cek lagi key-nya."
  done
  save RPC_URL "$rpc"; save NEXT_PUBLIC_RPC_URL "$rpc"
  ok "Helius tersambung dan disimpan"
fi

# Jupiter
jup=$(env_get JUPITER_API_KEY)
if ! $ASK_ALL && [[ -n "$jup" ]] && jup_ok "$jup"; then
  ok "Jupiter: tersimpan dan berfungsi"
else
  while true; do
    read -r -s -p "    Jupiter API key dari portal.jup.ag$( [[ -n "$jup" ]] && echo ' (Enter = pakai yang tersimpan)'): " cand; echo
    cand="${cand:-$jup}"
    [[ -n "$cand" ]] || { warn "Isi Jupiter API key (gratis di portal.jup.ag)."; continue; }
    jup_ok "$cand" && { jup="$cand"; break; }
    warn "Jupiter menolak key ini. Cek lagi."
  done
  save JUPITER_API_KEY "$jup"
  ok "Jupiter berfungsi dan disimpan"
fi

# Telegram (optional)
tg=$(env_get TELEGRAM_BOT_TOKEN)
tg_user=""
[[ -n "$tg" ]] && tg_user=$(tg_name "$tg")
if ! $ASK_ALL && [[ -n "$tg_user" ]]; then
  ok "Bot Telegram: @${tg_user} (tersimpan)"
else
  while true; do
    read -r -s -p "    Token bot Telegram dari @BotFather (Enter = $( [[ -n "$tg" ]] && echo 'pakai yang tersimpan' || echo 'lewati')): " cand; echo
    cand="${cand:-$tg}"
    [[ -z "$cand" ]] && { warn "Bot Telegram dilewati."; tg=""; break; }
    tg_user=$(tg_name "$cand")
    [[ -n "$tg_user" ]] && { tg="$cand"; save TELEGRAM_BOT_TOKEN "$tg"; save TELEGRAM_BOT_USERNAME "$tg_user"; ok "Bot Telegram: @${tg_user}"; break; }
    warn "Token bot tidak valid. Salin lagi dari @BotFather."
  done
fi

# ---------------------------------------------------------------- choices
cur_wallets=$(env_get LIVE_WALLETS)
tg_ids=$(env_get LIVE_TELEGRAM_IDS)
if ! $ASK_ALL && [[ "$(env_get LIVE_TRADING_ENABLED)" == true ]]; then
  # Already live: keep the saved choices.
  if [[ "$cur_wallets" == '*' ]]; then who=2; wallet=""; else who=1; wallet="$cur_wallets"; fi
  if [[ "$(env_get LIVE_MAX_USD)" == 0 ]]; then limits=1; else limits=2; fi
  ok "Pilihan tersimpan dipakai (ubah dengan: bash deploy/go-live.sh --ubah)"
else
  echo "    Siapa yang boleh memakai mode live (dana asli)?"
  echo "      1) Hanya saya dulu (disarankan untuk uji pertama)"
  echo "      2) Semua orang, lewat bot maupun website (tanpa alamat wallet)"
  while true; do
    read -r -p "    Pilih 1 atau 2: " who
    [[ "$who" == 1 || "$who" == 2 ]] && break
  done
  wallet=""
  if [[ "$who" == 1 ]]; then
    [[ "$cur_wallets" == '*' ]] && cur_wallets=""
    while true; do
      read -r -p "    Alamat publik Phantom untuk login website (Enter = ${cur_wallets:-lewati, hanya pakai bot}): " wallet
      wallet="${wallet:-$cur_wallets}"
      [[ -z "$wallet" ]] && { ok "Tanpa wallet website: pakai bot Telegram"; break; }
      [[ "$wallet" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}(,[1-9A-HJ-NP-Za-km-z]{32,44})*$ ]] && { ok "Alamat wallet valid"; break; }
      warn "Itu bukan alamat Solana. Salin alamat dari Phantom (contoh: 7xKX...), atau tekan Enter untuk lewati."
    done
    echo "    Wallet yang dibuat di bot Telegram: hanya untuk ID Telegram yang diizinkan (lihat ID: @userinfobot)."
    while true; do
      read -r -p "    ID Telegram Anda (Enter = ${tg_ids:-lewati}): " tgid
      tgid="${tgid:-$tg_ids}"
      [[ -z "$tgid" && -z "$wallet" ]] && { warn "Isi ID Telegram, karena wallet website dilewati."; continue; }
      [[ -z "$tgid" || "$tgid" =~ ^[0-9]+(,[0-9]+)*$ ]] && break
      warn "ID Telegram hanya angka (contoh: 123456789)."
    done
    tg_ids="$tgid"
  fi

  echo "    Batas dana yang boleh dipakai agent:"
  echo "      1) Tanpa batas: agent memakai seluruh deposit (sesuai strategi), posisi berapa pun"
  echo "      2) Aman untuk uji: maks \$200 per wallet, 1 posisi, \$2.000 total semua pengguna, posisi min \$50"
  while true; do
    read -r -p "    Pilih 1 atau 2: " limits
    [[ "$limits" == 1 || "$limits" == 2 ]] && break
  done
fi

# ---------------------------------------------------------------- write settings
step "Simpan pengaturan"
ok "Cadangan pengaturan lama: $backup"
env_set LIVE_TRADING_ENABLED true
# 0 = no limit (see liveLimits); MIN_POSITION_USD never goes below $1.
if [[ "$limits" == 1 ]]; then
  env_set LIVE_MAX_USD 0; env_set LIVE_MAX_POSITIONS 0; env_set LIVE_MAX_TOTAL_USD 0; env_set MIN_POSITION_USD 1
else
  env_set LIVE_MAX_USD 200; env_set LIVE_MAX_POSITIONS 1; env_set LIVE_MAX_TOTAL_USD 2000; env_set MIN_POSITION_USD 50
fi
if [[ "$who" == 1 ]]; then env_set LIVE_WALLETS "$wallet"; else env_set LIVE_WALLETS '*'; fi
env_set LIVE_TELEGRAM_IDS "$tg_ids"
env_set DEFAULT_VAULT_MODE live
env_set NEXT_PUBLIC_DEFAULT_VAULT_MODE live
chown "$APP_USER:$APP_USER" "$ENV_FILE" && chmod 600 "$ENV_FILE"
ok "Live: ON · $( [[ "$limits" == 1 ]] && echo 'tanpa batas dana' || echo "batas \$$(env_get LIVE_MAX_USD) per vault, \$$(env_get LIVE_MAX_TOTAL_USD) total") · $( [[ "$who" == 1 ]] && echo 'hanya wallet Anda' || echo 'semua wallet')"

# ---------------------------------------------------------------- build + restart
step "Build website dan nyalakan ulang (± 3 menit)"
as_app "pnpm --filter @binwise/web build" >/tmp/binwise-web-build.log 2>&1 || { tail -20 /tmp/binwise-web-build.log; die "Build website gagal."; }
ok "Website dibangun untuk mainnet"
# Older installs: take the client address from nginx itself, not from the request.
if [[ -f /etc/nginx/sites-available/binwise ]] && grep -q 'proxy_add_x_forwarded_for' /etc/nginx/sites-available/binwise; then
  sed -i 's#X-Forwarded-For $proxy_add_x_forwarded_for#X-Forwarded-For $remote_addr#g' /etc/nginx/sites-available/binwise
  nginx -t -q && systemctl reload nginx && ok "Nginx diperbarui"
fi
if as_app "pm2 describe binwise-api" >/dev/null 2>&1; then as_app "pm2 restart all --update-env" >/dev/null; else as_app "pm2 start deploy/ecosystem.config.cjs" >/dev/null; fi
as_app "pm2 save" >/dev/null

# ---------------------------------------------------------------- checks
step "Cek"
api_port=$(env_get API_PORT); api_port=${api_port:-4000}
health=""
for _ in $(seq 1 30); do
  health=$(curl -fsS --max-time 5 "http://127.0.0.1:${api_port}/health" 2>/dev/null || true)
  [[ "$health" == *'"mode":"db"'* ]] && break
  sleep 2
done
[[ "$health" == *'"liveTrading":true'* ]] && ok "API: live trading aktif" || die "API belum menjawab dengan benar: ${health:-tidak ada jawaban}. Lihat: sudo -u $APP_USER pm2 logs binwise-api"
if [[ -n "$tg" ]]; then
  sleep 5
  logs=$(as_app "pm2 logs binwise-agent --lines 60 --nostream" 2>/dev/null || true)
  [[ "$logs" == *'[telegram] bot running'* ]] && ok "Bot Telegram berjalan (@${tg_user})" || warn "Bot belum terlihat di log. Cek: sudo -u $APP_USER pm2 logs binwise-agent"
fi
as_app "pm2 ls"

domain=$(env_get PUBLIC_DOMAIN)
cat <<EOF

$(printf '\033[1;32m')Binwise LIVE di https://${domain}  (Solana mainnet, dana asli)$(printf '\033[0m')

Langkah berikutnya:
  1. Bot: buka @${tg_user:-bot Anda} → /start → 🆕 Create wallet.$( [[ -n "$wallet" ]] && echo " Atau website: https://${domain}/app → Connect wallet (${wallet:0:4}…${wallet: -4})." )
  2. Deposit kecil dulu ke alamat di 💳 Wallet: 0,3 SOL (biaya & sewa) + \$50–200.
  3. Tunggu agent menambah LP (atau ➕ Add LP sendiri), lalu uji 💸 Withdraw.
$( [[ -n "$wallet" && -n "$tg" ]] && echo "  Website: vault lama masih Paper → klik \"Live\"; Strategy → \"Telegram alerts\" untuk menghubungkan bot." )
$( [[ "$who" == 1 ]] && echo "  Setelah uji lancar, buka untuk semua orang: jalankan script ini lagi dan pilih 2." )

Rem darurat (hentikan semua transaksi):
  sudo -u ${APP_USER} -H bash -lc 'cd ~/binwise && pnpm --filter @binwise/agent kill on'
EOF
exit 0
}
