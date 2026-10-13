#!/usr/bin/env bash
# One-time move of a server from the old code name to kovra: user binwise, /home/binwise/binwise, database
# binwise and PM2 binwise-* become user kovra, /home/kovra/kovra, database kovra and PM2 kovra-*. Run as root:
#
#   curl -fsSL -o /root/migrate-to-kovra.sh https://raw.githubusercontent.com/fourtisf/binwise-lp/refs/heads/main/deploy/migrate-to-kovra.sh
#   bash /root/migrate-to-kovra.sh kovra.live
#
# Nothing that matters is recreated. The .env (secrets, database password, the key that seals agent wallets)
# is carried over, the database and the Redis keys (kill switch, never-send-twice keys) are renamed in place,
# and a full backup goes to /root first. The old user and folder are removed only once the new install runs.
# Safe to run again if it stops halfway.
set -Eeuo pipefail

OLD_USER="binwise"
OLD_HOME="/home/${OLD_USER}"
OLD_DIR="${OLD_HOME}/binwise"
NEW_USER="kovra"
NEW_HOME="/home/${NEW_USER}"
NEW_DIR="${NEW_HOME}/kovra"
REPO="${REPO:-https://github.com/fourtisf/binwise-lp.git}"
BRANCH="${BRANCH:-main}"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m    ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

psql_q() { sudo -u postgres psql -qtAX -v ON_ERROR_STOP=1 "$@"; }
db_exists() { [[ "$(psql_q -c "SELECT 1 FROM pg_database WHERE datname='$1'")" == "1" ]]; }
role_exists() { [[ "$(psql_q -c "SELECT 1 FROM pg_roles WHERE rolname='$1'")" == "1" ]]; }
# env_of FILE KEY: the last KEY=value in FILE
env_of() { sed -n "s/^$2=//p" "$1" | tail -1; }

backup_old() {
  local dir
  dir="/root/backup-kovra-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir" && chmod 700 "$dir"
  cp -p "$OLD_DIR"/.env* "$dir"/
  if db_exists "$OLD_USER"; then
    sudo -u postgres pg_dump "$OLD_USER" | gzip > "$dir/database-${OLD_USER}.sql.gz"
    [[ -s "$dir/database-${OLD_USER}.sql.gz" ]] || die "The database backup came out empty; nothing was changed."
  fi
  local url
  url="$(env_of "$OLD_DIR/.env" REDIS_URL)"
  redis-cli -u "${url:-redis://localhost:6379}" --rdb "$dir/redis.rdb" >/dev/null 2>&1 && ok "Redis snapshot saved" || warn "Redis snapshot skipped (the keys are renamed in place anyway)"
  ok "Backup: $dir (.env, database, Redis). Keep a copy off the server."
}

stop_old() {
  id "$OLD_USER" >/dev/null 2>&1 || return 0
  sudo -u "$OLD_USER" -H bash -lc 'pm2 delete all' >/dev/null 2>&1 || true
  sudo -u "$OLD_USER" -H bash -lc 'pm2 save --force' >/dev/null 2>&1 || true
  systemctl disable --now "pm2-${OLD_USER}" >/dev/null 2>&1 || true
  sudo -u "$OLD_USER" -H bash -lc 'pm2 kill' >/dev/null 2>&1 || true
  crontab -u "$OLD_USER" -r 2>/dev/null || true
  ok "Old processes (${OLD_USER}-*) stopped, old schedule removed"
}

rename_database() {
  if db_exists "$OLD_USER" && db_exists "$NEW_USER"; then
    die "Both databases '${OLD_USER}' and '${NEW_USER}' exist. Stopping here so nothing is overwritten; ask before going on."
  fi
  if db_exists "$OLD_USER"; then
    psql_q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${OLD_USER}' AND pid <> pg_backend_pid()" >/dev/null
    psql_q -c "ALTER DATABASE ${OLD_USER} RENAME TO ${NEW_USER}"
    ok "Database renamed: ${OLD_USER} → ${NEW_USER} (same data)"
  fi
  db_exists "$NEW_USER" || die "No database '${OLD_USER}' or '${NEW_USER}' found."
  if role_exists "$OLD_USER" && role_exists "$NEW_USER"; then
    die "Both database users '${OLD_USER}' and '${NEW_USER}' exist. Stopping here; ask before going on."
  fi
  # install.sh sets the password again from .env (a rename can clear it).
  if role_exists "$OLD_USER"; then psql_q -c "ALTER ROLE ${OLD_USER} RENAME TO ${NEW_USER}"; ok "Database user renamed: ${OLD_USER} → ${NEW_USER}"; fi
  role_exists "$NEW_USER" || die "No database user '${OLD_USER}' or '${NEW_USER}' found."
  # The demo vault's owner record follows the new name (seed finds the demo vault either way).
  psql_q -d "$NEW_USER" -c "UPDATE \"User\" SET wallet='${NEW_USER}-demo-vault' WHERE wallet='${OLD_USER}-demo-vault' AND NOT EXISTS (SELECT 1 FROM \"User\" WHERE wallet='${NEW_USER}-demo-vault')" >/dev/null \
    || warn "Demo vault owner not renamed (harmless)"
}

# rename_redis URL: binwise:* keys become kovra:* (TTLs kept; an existing kovra:* key is never overwritten).
rename_redis() {
  local url="$1" k n=0
  while IFS= read -r k; do
    [[ -n "$k" ]] || continue
    if [[ "$(redis-cli -u "$url" RENAMENX "$k" "${NEW_USER}:${k#"${OLD_USER}":}")" == "1" ]]; then n=$((n + 1)); fi
  done < <(redis-cli -u "$url" --scan --pattern "${OLD_USER}:*")
  ok "Redis: ${n} keys renamed (kill switch and send-once keys included)"
}

# prepare_new DOMAIN: user kovra, the code, and the old .env pointed at the renamed database and the domain.
prepare_new() {
  local domain="$1" env="${NEW_DIR}/.env" old
  id "$NEW_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$NEW_USER"
  if [[ ! -d "${NEW_DIR}/.git" ]]; then
    sudo -u "$NEW_USER" -H git clone -q -b "$BRANCH" "$REPO" "$NEW_DIR"
  fi
  if [[ ! -f "$env" ]]; then
    install -m 600 -o "$NEW_USER" -g "$NEW_USER" "${OLD_DIR}/.env" "$env"
    for f in "${OLD_DIR}"/.env.bak-*; do
      if [[ -f "$f" ]]; then install -m 600 -o "$NEW_USER" -g "$NEW_USER" "$f" "${NEW_DIR}/"; fi
    done
  fi
  sed -i -e "s#^DATABASE_URL=postgresql://${OLD_USER}:#DATABASE_URL=postgresql://${NEW_USER}:#" \
    -e "s#^\(DATABASE_URL=postgresql://${NEW_USER}:[^@]*@[^/]*\)/${OLD_USER}\([?]\|\$\)#\1/${NEW_USER}\2#" "$env"
  grep -q "^DATABASE_URL=postgresql://${NEW_USER}:[^@]*@[^/]*/${NEW_USER}\([?]\|\$\)" "$env" \
    || die "DATABASE_URL in ${env} doesn't point at user and database '${NEW_USER}'. Check that line, then run this again."
  old="$(env_of "$env" PUBLIC_DOMAIN)"
  if [[ -n "$old" && "$old" != "$domain" ]]; then
    sed -i "/^\(PUBLIC_DOMAIN\|CORS_ORIGINS\|NEXT_PUBLIC_API_URL\|NEXT_PUBLIC_WS_URL\|NEXT_PUBLIC_SITE_URL\)=/s#${old//./\\.}#${domain}#g" "$env"
    ok "Domain in .env: ${old} → ${domain}"
  fi
  chown "$NEW_USER:$NEW_USER" "$env" && chmod 600 "$env"
  ok "User ${NEW_USER}, code in ${NEW_DIR}, settings carried over"
}

remove_old() {
  if id "$OLD_USER" >/dev/null 2>&1; then
    pkill -KILL -u "$OLD_USER" 2>/dev/null || true
    sleep 1
    userdel -r "$OLD_USER" >/dev/null 2>&1 || true
  fi
  rm -rf "$OLD_HOME" "/tmp/${OLD_USER}-web-build.log"
  rm -f "/etc/systemd/system/pm2-${OLD_USER}.service" && systemctl daemon-reload >/dev/null 2>&1 || true
  ! id "$OLD_USER" >/dev/null 2>&1 || die "Could not remove user ${OLD_USER}: run  userdel -r ${OLD_USER}"
  ok "User ${OLD_USER} and ${OLD_HOME} removed"
}

main() {
  trap 'die "Stopped at line $LINENO: $BASH_COMMAND (safe to run again after fixing it)"' ERR
  local domain="${1:-}"
  [[ $EUID -eq 0 ]] || die "Run as root."
  [[ -n "$domain" ]] || die "Usage: bash migrate-to-kovra.sh <domain>   e.g. bash migrate-to-kovra.sh kovra.live"
  [[ "$domain" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "'$domain' doesn't look like a domain."
  [[ -f "${OLD_DIR}/.env" || -f "${NEW_DIR}/.env" ]] || die "No install found in ${OLD_DIR} or ${NEW_DIR}. For a new server use install.sh."

  if [[ -f "${OLD_DIR}/.env" ]]; then
    step "Backup"
    backup_old
    step "Stop the old processes"
    stop_old
  fi
  step "Database"
  rename_database
  step "Redis"
  local env_file="${NEW_DIR}/.env"
  [[ -f "$env_file" ]] || env_file="${OLD_DIR}/.env"
  local url
  url="$(env_of "$env_file" REDIS_URL)"
  rename_redis "${url:-redis://localhost:6379}"
  step "New user and code"
  prepare_new "$domain"
  step "Old web server site off"
  rm -f "/etc/nginx/sites-enabled/${OLD_USER}" "/etc/nginx/sites-available/${OLD_USER}"
  ok "Removed the ${OLD_USER} nginx site (install.sh writes the ${NEW_USER} one)"
  step "Install as ${NEW_USER} (build and start, a few minutes)"
  BRANCH="$BRANCH" REPO="$REPO" bash "${NEW_DIR}/deploy/install.sh" "$domain"
  step "Remove the old install"
  remove_old
  printf '\n\033[1;32mDone: Kovra runs as user %s from %s (PM2: %s-web, -api, -collector, -agent).\033[0m\n' "$NEW_USER" "$NEW_DIR" "$NEW_USER"
  printf 'Status: sudo -u %s pm2 ls     Backups: ls -la /root/backup-kovra-*\n' "$NEW_USER"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
