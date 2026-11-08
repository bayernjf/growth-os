#!/usr/bin/env node
// @ts-check
/**
 * growth-os SQLite backup (2026-11-08: the repo had no backup at all, and the
 * leads / quotes / orders / invoices in this file cannot be rebuilt upstream).
 *
 * `VACUUM INTO` writes a consistent snapshot while the service keeps serving
 * (node:sqlite, so no sqlite3 CLI is needed in the backup sidecar). Any failure
 * exits non-zero and prints FAILED: a sidecar that swallowed errors would keep
 * reporting "running" while backups had silently stopped.
 *
 * Env:
 *   GROWTH_SQLITE_PATH  live database (default /data/growth-os.db)
 *   BACKUP_DIR          snapshot directory (default /backups)
 *   RETENTION_DAYS      delete snapshots older than N days (default 7)
 *
 * Usage:
 *   node --experimental-sqlite scripts/backup-growth-os.mjs
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

const DB_PATH = process.env.GROWTH_SQLITE_PATH ?? '/data/growth-os.db';
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? '7');
const PREFIX = 'growth-os-';

/** `YYYYMMDD-HHMMSS` in UTC, matching the growth-agent dump naming. */
function stamp(now) {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
}

/** Drop snapshots older than RETENTION_DAYS; keep the report in the log. */
function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
  for (const name of readdirSync(BACKUP_DIR)) {
    if (!name.startsWith(PREFIX) || !name.endsWith('.db')) continue;
    const full = join(BACKUP_DIR, name);
    const mtime = statSync(full).mtimeMs;
    if (mtime < cutoff) {
      unlinkSync(full);
      console.log(`pruned ${full} (older than ${RETENTION_DAYS} days)`);
    }
  }
}

function main() {
  if (!Number.isInteger(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error(`RETENTION_DAYS must be a positive integer, got ${process.env.RETENTION_DAYS}`);
  }
  if (!existsSync(DB_PATH)) throw new Error(`database not found: ${DB_PATH}`);

  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const out = join(BACKUP_DIR, `${PREFIX}${stamp(new Date())}.db`);
  // VACUUM INTO refuses to overwrite; failing here is safer than picking a
  // different name and leaving the operator guessing which snapshot is new.
  if (existsSync(out)) throw new Error(`snapshot already exists: ${out}`);

  const db = new sqlite.DatabaseSync(DB_PATH);
  try {
    db.exec(`VACUUM INTO '${out.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }

  chmodSync(out, 0o600);
  console.log(`wrote ${out} (${statSync(out).size} bytes, retention ${RETENTION_DAYS} days)`);
  prune();
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('backup-growth-os.mjs') || process.argv[1].endsWith('backup-growth-os'));

if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    console.error(`[backup-growth-os] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
