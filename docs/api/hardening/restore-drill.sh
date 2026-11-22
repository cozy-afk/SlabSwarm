#!/usr/bin/env bash
# Slabswarm data product — restore DRILL: prove a backup can be restored into a
# disposable target WITHOUT touching production canonical data.
#
# OPERATIONAL HARDENING ARTIFACT / PROPOSAL. Not executed by the productization
# lane. The drill is deliberately non-destructive:
#   - Postgres is restored into a NEW throwaway database named by DRILL_DB,
#     never into the production database.
#   - The Parquet lake is extracted to a temp directory, never over /app/data.
#   - The settings file is extracted and permission-checked, never installed.
#
# All Docker operations use `sudo -n docker` per the global constraint.
# No listener, firewall, DNS or production container changes.

set -euo pipefail
umask 077

BACKUP_DIR="${1:-}"
[ -n "$BACKUP_DIR" ] || { echo "usage: $0 <backup-dir>" >&2; exit 2; }
[ -f "${BACKUP_DIR}/SHA256SUMS" ] || { echo "missing SHA256SUMS in $BACKUP_DIR" >&2; exit 2; }

PG_CONTAINER="${PG_CONTAINER:-slabswarm-postgres}"
PG_DATABASE="${PG_DATABASE:-slabswarm}"
DRILL_DB="${DRILL_DB:-slabswarm_restore_drill}"
LAKE_DIR="${LAKE_DIR:-/opt/slabswarm/data/lake}"

log() { printf '[restore-drill] %s\n' "$*"; }

# --- 0. verify integrity before any restore --------------------------------
log "verifying backup checksums"
( cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS )

DUMP="$(find "$BACKUP_DIR" -maxdepth 1 -name 'postgres-*.dump' -print -quit)"
LAKE_TGZ="${BACKUP_DIR}/parquet-lake.tgz"
[ -n "$DUMP" ] || { echo "no Postgres dump in backup" >&2; exit 2; }
[ -f "$LAKE_TGZ" ] || { echo "no Parquet lake archive in backup" >&2; exit 2; }

# --- 1. Postgres restore into a throwaway DB -------------------------------
if [ -z "$(sudo -n docker ps -q -f "name=^/${PG_CONTAINER}$" 2>/dev/null)" ]; then
  echo "Postgres container '$PG_CONTAINER' not running; set PG_CONTAINER." >&2
  exit 2
fi
log "dropping any stale drill database '$DRILL_DB' (throwaway target only)"
sudo -n docker exec "$PG_CONTAINER" psql -U postgres -c \
  "DROP DATABASE IF EXISTS ${DRILL_DB};"
log "creating drill database '$DRILL_DB'"
sudo -n docker exec "$PG_CONTAINER" psql -U postgres -c \
  "CREATE DATABASE ${DRILL_DB};"
log "restoring dump into drill database"
sudo -n docker exec -i "$PG_CONTAINER" pg_restore -U postgres -d "$DRILL_DB" --clean --if-exists \
  < "$DUMP"
COUNT="$(sudo -n docker exec "$PG_CONTAINER" psql -U postgres -d "$DRILL_DB" -Atc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
log "drill database restored; public table count = $COUNT"
[ "$COUNT" -gt 0 ] || { echo "restore produced no tables" >&2; exit 1; }

# --- 2. Parquet lake extract into a temp dir -------------------------------
DRILL_LAKE="$(mktemp -d)"
log "extracting Parquet lake to disposable $DRILL_LAKE"
tar -C "$DRILL_LAKE" -xzf "$LAKE_TGZ"
if find "$DRILL_LAKE" -type f -name '*.parquet' -print -quit | grep -q .; then
  log "Parquet files present in drill extract"
else
  log "WARN: no .parquet files found (lake may have been empty — record as UNKNOWN)"
fi

# --- 3. settings file permission check -------------------------------------
SETTINGS="${BACKUP_DIR}/env.settings"
if [ -f "$SETTINGS" ]; then
  PERM="$(stat -c '%a' "$SETTINGS")"
  log "settings file present with mode $PERM (must be 600)"
  [ "$PERM" = "600" ] || { echo "settings file permissions too open" >&2; exit 1; }
else
  log "no settings file in backup — UNKNOWN, nothing to check"
fi

# --- cleanup ---------------------------------------------------------------
log "dropping drill database '$DRILL_DB'"
sudo -n docker exec "$PG_CONTAINER" psql -U postgres -c "DROP DATABASE IF EXISTS ${DRILL_DB};"
rm -rf "$DRILL_LAKE"
log "restore drill PASSED — production canonical data was never touched"
