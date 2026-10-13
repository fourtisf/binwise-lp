#!/usr/bin/env bash
# Kovra: update to the latest code. Asks nothing: keys and settings stay in .env, data stays in the database.
# Run as root on the server:
#
#   bash /home/kovra/kovra/deploy/update.sh
#
set -Eeuo pipefail
# One block, so bash reads it completely before running: the git checkout below may replace this file.
{
APP_USER="kovra"
APP_DIR="/home/${APP_USER}/kovra"
BRANCH="${BRANCH:-main}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "Gagal di baris $LINENO: $BASH_COMMAND"' ERR
as_app() { sudo -u "$APP_USER" -H bash -lc "cd '$APP_DIR' && $*"; }

[[ $EUID -eq 0 ]] || die "Jalankan sebagai root."
[[ -f "$APP_DIR/.env" ]] || die "$APP_DIR/.env tidak ada. Jalankan deploy/install.sh dulu."

step "Ambil kode terbaru (pengaturan di .env tidak disentuh)"
sudo -u "$APP_USER" -H git -C "$APP_DIR" fetch -q origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
sudo -u "$APP_USER" -H git -C "$APP_DIR" checkout -q -f -B "$BRANCH" "origin/$BRANCH"
ok "Kode: $(sudo -u "$APP_USER" -H git -C "$APP_DIR" log -1 --format='%h %s')"
as_app "pnpm install --frozen-lockfile --reporter=silent"
as_app "pnpm --filter @kovra/db migrate:deploy" >/dev/null 2>&1 || die "Migrasi database gagal: jalankan  sudo -u $APP_USER -H bash -lc 'cd ~/kovra && pnpm --filter @kovra/db migrate:deploy'  untuk melihat pesannya."
ok "Dependencies dan database terbaru"

step "Build website dan nyalakan ulang (± 3 menit)"
as_app "pnpm --filter @kovra/web build" >/tmp/kovra-web-build.log 2>&1 || { tail -20 /tmp/kovra-web-build.log; die "Build website gagal."; }
as_app "pm2 restart all --update-env" >/dev/null
as_app "pm2 save" >/dev/null
ok "Website, API, agent dan bot dinyalakan ulang"

step "Cek"
api_port=$(sed -n 's/^API_PORT=//p' "$APP_DIR/.env" | tail -1); api_port=${api_port:-4000}
health=""
for _ in $(seq 1 30); do
  health=$(curl -fsS --max-time 5 "http://127.0.0.1:${api_port}/health" 2>/dev/null || true)
  [[ "$health" == *'"ok":true'* ]] && break
  sleep 2
done
[[ "$health" == *'"ok":true'* ]] || die "API belum menjawab. Lihat: sudo -u $APP_USER pm2 logs kovra-api"
ok "API: $health"
as_app "pm2 ls"
exit 0
}
