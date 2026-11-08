# Backup and restore (growth-os)

Last drill: **2026-11-08** (restore executed, not just scripted).
Standard: `bayjf/docs/ops/backup-restore-baseline-2026-11-08.md`.

## 1. What is backed up

| Item | Where it lives | In the snapshot? |
|---|---|---|
| SQLite database (research, CRM, quotes, orders, invoices) | `growth-os-data` volume → `/data/growth-os.db` | yes |
| `GROWTH_API_TOKEN`, zeus token, SERP/mail credentials | env / `.env` | **no** — store them in your own secret manager |
| Postgres data (`--profile postgres`) | `growth-os-pgdata` volume | **no** — this sidecar only covers SQLite |

The database holds leads, quotes, contracts, orders and invoices. None of it can
be rebuilt from upstream, so the snapshot is the only copy.

## 2. Schedule, retention, location

- **Frequency**: one snapshot per day (`BACKUP_INTERVAL_SECONDS=86400`).
- **Retention**: 7 days (`BACKUP_RETENTION_DAYS=7`); older `growth-os-*.db`
  files are pruned after each successful snapshot.
- **Location**: the `backups` compose volume on the **same host** as the data
  volume.

> **Limitation (do not treat this as disaster recovery):** the snapshot and the
> live database sit on the same machine. If the host or its disks are lost, both
> are lost. Cross-host copies (object storage or another machine) are not
> implemented.

Snapshots are written with mode `0600`.

## 3. Backup commands

Sidecar (runs with the stack):

```bash
docker compose up -d growth-os db-backup
docker compose logs -f db-backup
```

Manual snapshot:

```bash
GROWTH_SQLITE_PATH=/data/growth-os.db BACKUP_DIR=/backups RETENTION_DAYS=7 \
  node --experimental-sqlite scripts/backup-growth-os.mjs
```

The snapshot is a consistent `VACUUM INTO` copy; the app does not need to stop.
A failed snapshot prints `[backup-growth-os] FAILED: ...` and exits non-zero.
The sidecar prints `[db-backup] backup failed` and exits 1, so
`docker compose ps` shows `Restarting` and the restart count grows — failure is
not silent.

## 4. Restore

```bash
# Restore into a live path (refuses to overwrite without --force):
node --experimental-sqlite scripts/restore-growth-os.mjs \
  --snapshot /backups/growth-os-20261108-135500.db \
  --target-db /data/growth-os.db --force

docker compose restart growth-os
```

Behaviour:

- verifies the snapshot with `PRAGMA integrity_check` (`ok` required) and the
  key tables (`schema_migrations`, `research_topics`, `signals`, `contacts`,
  `leads`, `quotes`, `orders`, `invoices`);
- if the target exists, requires `--force` and keeps the previous file as
  `<target>.pre-restore-<stamp>` (`0600`);
- re-verifies the written file and fails if any key-table count differs from the
  snapshot.

## 5. Drill record (2026-11-08, actual output)

A fresh database was migrated, seeded with one row in each key table, backed up
and restored to a temporary path.

```bash
GROWTH_SQLITE_PATH=/tmp/drill-growth-os/src.db npm run migrate:up
node --experimental-sqlite /tmp/drill-growth-os/seed.mjs /tmp/drill-growth-os/src.db
GROWTH_SQLITE_PATH=/tmp/drill-growth-os/src.db BACKUP_DIR=/tmp/drill-growth-os/backups \
  node --experimental-sqlite scripts/backup-growth-os.mjs
node --experimental-sqlite scripts/restore-growth-os.mjs \
  --snapshot /tmp/drill-growth-os/backups/growth-os-20261108-135500.db \
  --target-db /tmp/drill-growth-os/restored.db
```

Actual output (trimmed to the relevant lines):

```text
applied: 001_research, ..., 015_order_number_sequence_repair
research_topics=1
signals=1
contacts=1
leads=1
quotes=1
orders=1
invoices=1
wrote /tmp/drill-growth-os/backups/growth-os-20261108-135500.db (339968 bytes, retention 7 days)
-rw------- 339968 /tmp/drill-growth-os/backups/growth-os-20261108-135500.db
restored /tmp/drill-growth-os/restored.db from /tmp/drill-growth-os/backups/growth-os-20261108-135500.db
  (schema_migrations=15 research_topics=1 signals=1 contacts=1 leads=1 quotes=1 orders=1 invoices=1)
-rw------- 339968 /tmp/drill-growth-os/restored.db
```

Health check against the **restored** database:

```bash
GROWTH_SQLITE_PATH=/tmp/drill-growth-os/restored.db GROWTH_PORT=18788 \
  GROWTH_API_TOKEN=drill-token node --experimental-sqlite dist/serve.js
curl -s http://127.0.0.1:18788/healthz
```

```text
HTTP=200
{"ok":true}
```

What the drill proves: the snapshot is written `0600`, verifies with
`integrity_check=ok`, restores with identical key-table counts (including the
15 applied migrations), and the restored file boots the service to `/healthz`
200.

What it does not prove: that a snapshot from a real production volume restores —
this drill used a freshly migrated database. The first snapshot of the live
volume should be restored into a temporary path and checked the same way.

## 6. Code rollback anchor

Images are built locally as `growth-os:latest`; no registry tag is published.
Keep the previous build before a rebuild, then retag it back to roll out:

```bash
docker tag growth-os:latest "growth-os:$(date -u +%Y%m%d-%H%M)"    # before a rebuild
docker tag "growth-os:<stamp>" growth-os:latest && docker compose up -d   # roll back
```

This anchor only exists on the machine that holds the image. After moving
hosts, save/export the image or push it to a registry first.
