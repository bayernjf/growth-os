#!/bin/sh
# growth-os SQLite backup sidecar (2026-11-08 baseline gap: no backup existed).
# Runs in node:22-slim next to the app, reads the data volume read-only and
# writes VACUUM INTO snapshots to the `backups` volume.
#
# Failure is visible: a failed snapshot exits non-zero, which `docker compose ps`
# shows as Restarting and logs as "[db-backup] backup failed". The sidecar must
# never keep running as if backups were fine.
#
# Env: GROWTH_SQLITE_PATH (/data/growth-os.db)
#      BACKUP_DIR (/backups) RETENTION_DAYS (7) BACKUP_INTERVAL_SECONDS (86400)
#      BACKUP_ONCE=1 runs one snapshot and exits (drill / manual use).
set -eu
umask 077

export GROWTH_SQLITE_PATH="${GROWTH_SQLITE_PATH:-/data/growth-os.db}"
export BACKUP_DIR="${BACKUP_DIR:-/backups}"
export RETENTION_DAYS="${RETENTION_DAYS:-7}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

mkdir -p "$BACKUP_DIR"

backup_once() {
  echo "[db-backup] snapshot start $(date -Iseconds)"
  # node:sqlite is still behind the experimental flag on Node 22.
  node --experimental-sqlite /scripts/backup-growth-os.mjs
}

if [ "${BACKUP_ONCE:-0}" = "1" ]; then
  backup_once
  exit 0
fi

while true; do
  if ! backup_once; then
    echo "[db-backup] backup failed; exiting for restart-policy visibility" >&2
    exit 1
  fi
  sleep "$INTERVAL"
done
