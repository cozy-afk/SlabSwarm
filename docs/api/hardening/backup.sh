#!/usr/bin/env bash
# Slabswarm data product — operator-run backup of the three durable assets:
#   1. Postgres canonical database (pg_dump, custom format)
#   2. Parquet lake (/opt/slabswarm/data/lake)
#   3. Encrypted LLM/provider settings (.env — credentials stay server-side)
#
# OPERATIONAL HARDENING ARTIFACT / PROPOSAL. Not executed by the productization
# lane. No listener, firewall, DNS or container changes. All Docker operations
# use `sudo -n docker` per the global constraint.
#
# Usage:
#   BACKUP_ROOT=/opt/slabswarm/backups \
#   PG_CONTAINER=slabswarm-postgres \
#   PG_DATABASE=slabswarm \
#   ./docs/api/hardening/backup.sh
#
# Container/database names default to common values and are overridable because
# the persistence lane owns final naming. Adjust before production use.

set -euo pipefail
umask 077

BACKUP_ROOT="${BACKUP_ROOT:-/opt/slabswarm/backups}"
PG_CONTAINER="${PG_CONTAINER:-slabswarm-postgres}"
PG_DATABASE="${PG_DATABASE:-slabswarm}"
LAKE_DIR="${LAKE_DIR:-/opt/slabswarm/data/lake}"
ENV_FILE="${ENV_FILE:-/opt/slabswarm/.env}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_ROOT}/${STAMP}"

log() { printf '[backup %s] %s\n' "$STAMP" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

mkdir -p "$DEST"
log "backup destination: $DEST"

# --- 1. Postgres canonical database ----------------------------------------
if [ -z "$(sudo -n docker ps -q -f "name=^/${PG_CONTAINER}$" 2>/dev/null)" ]; then
  die "Postgres container '$PG_CONTAINER' is not running. Set PG_CONTAINER."
fi
log "dumping Postgres database '$PG_DATABASE' from '$PG_CONTAINER'"
sudo -n docker exec "$PG_CONTAINER" pg_dump -U postgres -Fc "$PG_DATABASE" \
  > "${DEST}/postgres-${PG_DATABASE}.dump"

# --- 2. Parquet lake --------------------------------------------------------
if [ ! -d "$LAKE_DIR" ]; then
  die "Parquet lake directory '$LAKE_DIR' does not exist. Set LAKE_DIR."
fi
log "archiving Parquet lake from $LAKE_DIR"
tar -C "$(dirname "$LAKE_DIR")" -czf "${DEST}/parquet-lake.tgz" "$(basename "$LAKE_DIR")"

# --- 3. Encrypted LLM/provider settings (credentials server-side only) -----
# The .env file contains secrets. Store it with 0600 under the 077 umask and
# never print its contents. Operators should additionally encrypt at rest.
if [ -f "$ENV_FILE" ]; then
  log "copying server-side settings with restrictive permissions"
  cp -p "$ENV_FILE" "${DEST}/env.settings"
  chmod 600 "${DEST}/env.settings"
else
  log "WARN: no settings file at $ENV_FILE — record as UNKNOWN, do not substitute"
fi

# --- manifest + checksums ---------------------------------------------------
{
  echo "stamp: $STAMP"
  echo "contract_version: 2026-11-22.1"
  echo "pg_container: $PG_CONTAINER"
  echo "pg_database: $PG_DATABASE"
  echo "lake_dir: $LAKE_DIR"
  echo "correction_policy: APPEND_ONLY"
} > "${DEST}/manifest.txt"

( cd "$DEST" && sha256sum ./* > SHA256SUMS )
log "checksums written to ${DEST}/SHA256SUMS"
log "backup complete: $DEST"
log "NEXT: run restore-drill.sh against a disposable target to prove restorability"
