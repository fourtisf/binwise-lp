#!/usr/bin/env bash
# Kovra: a read-only health report of the running install. Changes nothing (the database session is read-only).
# Run as root on the server and paste the output back:
#
#   bash /home/kovra/kovra/deploy/check-live.sh
#
# Shows: processes, kill switch, every vault (value vs holding), open and closed positions with fees and
# net vs hold, deposits and withdrawals, the last actions with their transactions, failed transactions,
# and whether the agent and the pool collector are still ticking. No keys, secrets or wallet owners are printed.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/home/kovra/kovra}"
ENV_FILE="${APP_DIR}/.env"
env_of() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }

DB_URL="$(env_of DATABASE_URL)"
DB_NAME="$(sed -n 's#^postgres[a-z]*://[^/]*/\([^?]*\).*#\1#p' <<<"$DB_URL")"
DB_NAME="${DB_NAME:-kovra}"
# PSQL can be overridden for testing elsewhere; on the server the postgres superuser reads the database.
PSQL="${PSQL:-sudo -u postgres psql}"
q() { PGOPTIONS='-c default_transaction_read_only=on' $PSQL -d "$DB_NAME" -X -q -v ON_ERROR_STOP=1 -P pager=off -P footer=off "$@"; }
h() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

h "Kovra live check  $(date -u '+%Y-%m-%d %H:%M UTC')"
LT="$(env_of LIVE_TRADING_ENABLED)"; SITE="$(env_of PUBLIC_DOMAIN)"
echo "Live trading flag: ${LT:-unset}    Site: ${SITE:-unset}"
REDIS_URL_V="$(env_of REDIS_URL)"
if command -v redis-cli >/dev/null 2>&1; then
  ks="$(redis-cli -u "${REDIS_URL_V:-redis://localhost:6379}" GET kovra:kill 2>/dev/null || true)"
  echo "Kill switch: ${ks:-off}"
fi

h "Processes"
if id kovra >/dev/null 2>&1; then
  sudo -u kovra -H bash -lc 'pm2 ls' 2>/dev/null || echo "(pm2 not readable for user kovra)"
else
  echo "(no user kovra on this machine)"
fi

h "Is it ticking? (last agent decision per vault, last pool snapshot)"
q -c "SELECT left(\"vaultId\",8) AS vault, to_char(max(ts),'MM-DD HH24:MI:SS') AS last_decision, date_trunc('second', now()-max(ts)) AS ago FROM \"Decision\" GROUP BY 1 ORDER BY 2 DESC;"
q -c "SELECT to_char(max(ts),'MM-DD HH24:MI:SS') AS last_pool_snapshot, date_trunc('second', now()-max(ts)) AS ago, count(*) FILTER (WHERE ts > now()-interval '1 hour') AS snapshots_last_hour FROM \"PoolSnapshot\";"

h "Vaults"
q -c "SELECT left(v.id,8) AS vault, v.name, v.mode, v.custody, v.status, coalesce(v.\"pausedReason\",'') AS paused_reason, v.cycle, v.\"isDemo\" AS demo,
        CASE WHEN v.\"agentPubkey\" IS NULL THEN '' ELSE left(v.\"agentPubkey\",6)||'…'||right(v.\"agentPubkey\",4) END AS agent_wallet,
        to_char(v.\"createdAt\",'YYYY-MM-DD') AS created
      FROM \"Vault\" v ORDER BY v.\"isDemo\", v.\"createdAt\";"

h "Value vs simply holding (latest, and change over 24h / 7d)"
q -c "WITH last AS (SELECT DISTINCT ON (\"vaultId\") * FROM \"VaultSnapshot\" ORDER BY \"vaultId\", ts DESC)
      SELECT left(l.\"vaultId\",8) AS vault, to_char(l.ts,'MM-DD HH24:MI') AS at,
        round(l.value::numeric,2) AS value_usd, round(l.\"holdValue\"::numeric,2) AS hold_usd, round(l.\"feesTotal\"::numeric,2) AS fees_usd,
        round((l.\"netVsHold\"*100)::numeric,2) AS net_vs_hold_pct,
        round((l.value - d1.value)::numeric,2) AS value_change_24h, round((l.value - d7.value)::numeric,2) AS value_change_7d
      FROM last l
      LEFT JOIN LATERAL (SELECT value FROM \"VaultSnapshot\" s WHERE s.\"vaultId\"=l.\"vaultId\" AND s.ts <= l.ts - interval '24 hours' ORDER BY s.ts DESC LIMIT 1) d1 ON true
      LEFT JOIN LATERAL (SELECT value FROM \"VaultSnapshot\" s WHERE s.\"vaultId\"=l.\"vaultId\" AND s.ts <= l.ts - interval '7 days' ORDER BY s.ts DESC LIMIT 1) d7 ON true
      ORDER BY 1;"
echo "(value changes include deposits and withdrawals; net vs hold is the fair comparison)"

h "Open positions"
q -c "SELECT left(p.\"vaultId\",8) AS vault, pl.name AS pool, p.shape, round(p.\"entryValueUsd\"::numeric,2) AS entry_usd, round(p.\"valueUsd\"::numeric,2) AS value_usd,
        round((p.\"feesUnclaimedUsd\"+p.\"feesClaimedUsd\")::numeric,2) AS fees_usd, round(p.\"costsUsd\"::numeric,2) AS costs_usd,
        round(p.\"netVsHold\"::numeric,2) AS net_vs_hold_pct, p.\"inRange\" AS in_range, p.rebalances,
        to_char(p.\"openedAt\",'MM-DD HH24:MI') AS opened, CASE WHEN p.address IS NULL THEN '(paper)' ELSE left(p.address,6)||'…' END AS on_chain
      FROM \"Position\" p JOIN \"Pool\" pl ON pl.id=p.\"poolId\" WHERE p.status='open' ORDER BY p.\"openedAt\";"

h "Closed positions, last 30 days"
q -c "SELECT left(p.\"vaultId\",8) AS vault, pl.name AS pool, round(p.\"entryValueUsd\"::numeric,2) AS entry_usd,
        round((p.\"feesUnclaimedUsd\"+p.\"feesClaimedUsd\")::numeric,2) AS fees_usd, round(p.\"costsUsd\"::numeric,2) AS costs_usd,
        round(p.\"netVsHold\"::numeric,2) AS net_vs_hold_pct, p.rebalances,
        to_char(p.\"openedAt\",'MM-DD HH24:MI') AS opened, to_char(p.\"closedAt\",'MM-DD HH24:MI') AS closed
      FROM \"Position\" p JOIN \"Pool\" pl ON pl.id=p.\"poolId\" WHERE p.status='closed' AND p.\"closedAt\" > now()-interval '30 days' ORDER BY p.\"closedAt\" DESC LIMIT 30;"

h "Deposits and withdrawals"
q -c "SELECT left(\"vaultId\",8) AS vault, to_char(ts,'MM-DD HH24:MI') AS at, left(title,60) AS what, coalesce(left(\"txSig\",10)||'…','') AS tx
      FROM \"Decision\" WHERE title LIKE 'Deposited%' OR title LIKE 'Withdrew%' ORDER BY ts DESC LIMIT 30;"

h "Last 20 actions"
q -c "SELECT left(\"vaultId\",8) AS vault, to_char(ts,'MM-DD HH24:MI') AS at, type, left(title,58) AS what, coalesce(left(\"txSig\",10)||'…','') AS tx
      FROM \"Decision\" WHERE type IN ('deploy','rebalance','exit','compound') ORDER BY ts DESC LIMIT 20;"

h "Transactions, last 7 days"
q -c "SELECT status, simulated, count(*) AS n FROM \"Tx\" WHERE ts > now()-interval '7 days' GROUP BY 1,2 ORDER BY 1,2;"
q -c "SELECT to_char(ts,'MM-DD HH24:MI') AS at, left(coalesce(error,''),110) AS error FROM \"Tx\" WHERE status='failed' ORDER BY ts DESC LIMIT 10;"

h "Done (read-only: nothing was changed)"
