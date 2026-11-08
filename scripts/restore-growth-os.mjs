#!/usr/bin/env node
// @ts-check
/**
 * Restore path for growth-os snapshots produced by
 * `scripts/backup-growth-os.mjs`. A backup that was never restored is not a
 * backup, so this script refuses to be optimistic:
 *
 *   1. verify the snapshot: `PRAGMA integrity_check` plus the key-table counts;
 *   2. refuse to overwrite a live database without `--force`;
 *   3. with `--force`, keep the current file as `.pre-restore-<stamp>` (0600);
 *   4. re-verify the copied file and fail if any key-table count moved.
 *
 * The snapshot never contains `GROWTH_API_TOKEN` or supplier credentials; those
 * live in env and must be restored from their own custodian.
 *
 * CLI:
 *   node --experimental-sqlite scripts/restore-growth-os.mjs \
 *     --snapshot /backups/growth-os-20261108-000000.db \
 *     [--target-db /data/growth-os.db] [--force]
 */
import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite');

/** Tables that must exist after a restore, in blast-radius order. */
const KEY_TABLES = [
  'schema_migrations',
  'research_topics',
  'signals',
  'contacts',
  'leads',
  'quotes',
  'orders',
  'invoices',
];

class RestoreError extends Error {}

/** `YYYYMMDD-HHMMSS` in UTC, matching the snapshot naming. */
function stamp(now) {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
}

/**
 * @param {string} dbFile
 * @returns {Record<string, number>}
 */
function verify(dbFile) {
  const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const value = integrity === undefined ? '' : String(Object.values(integrity)[0] ?? '');
    if (value !== 'ok') throw new RestoreError(`integrity_check failed: ${value}`);

    /** @type {Record<string, number>} */
    const counts = {};
    for (const table of KEY_TABLES) {
      let row;
      try {
        row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get();
      } catch {
        throw new RestoreError(
          `${dbFile} has no ${table} table; it is not a migrated growth-os database`,
        );
      }
      counts[table] = Number(row?.c ?? 0);
    }
    return counts;
  } finally {
    db.close();
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{snapshot?: string, target?: string, force: boolean}} */
  const parsed = { force: argv.includes('--force') };
  for (const [flag, key] of /** @type {const} */ ([
    ['--snapshot', 'snapshot'],
    ['--target-db', 'target'],
  ])) {
    const index = argv.indexOf(flag);
    if (index >= 0) {
      const value = argv[index + 1];
      if (value === undefined) throw new RestoreError(`${flag} requires a value`);
      parsed[key] = value;
    }
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.snapshot === undefined) {
    throw new RestoreError(
      'usage: restore-growth-os.mjs --snapshot <file.db> [--target-db <path>] [--force]',
    );
  }
  if (!existsSync(args.snapshot)) throw new RestoreError(`snapshot not found: ${args.snapshot}`);

  const snapshotCounts = verify(args.snapshot);
  const target = args.target ?? process.env.GROWTH_SQLITE_PATH ?? '/data/growth-os.db';

  if (existsSync(target)) {
    if (!args.force) {
      throw new RestoreError(
        `target exists: ${target} — re-run with --force to overwrite (it will be kept as .pre-restore)`,
      );
    }
    const keepPath = `${target}.pre-restore-${stamp(new Date())}`;
    copyFileSync(target, keepPath);
    chmodSync(keepPath, 0o600);
    console.log(`kept previous db at ${keepPath}`);
  }

  copyFileSync(args.snapshot, target);
  chmodSync(target, 0o600);

  const restored = verify(target);
  for (const [table, expected] of Object.entries(snapshotCounts)) {
    if (restored[table] !== expected) {
      throw new RestoreError(
        `restored file does not match the snapshot: ${table} expected ${expected}, found ${String(restored[table])}`,
      );
    }
  }

  const counts = Object.entries(restored)
    .map(([table, count]) => `${table}=${count}`)
    .join(' ');
  console.log(`restored ${target} from ${args.snapshot} (${counts})`);
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('restore-growth-os.mjs') || process.argv[1].endsWith('restore-growth-os'));

if (invokedAsScript) {
  try {
    main();
  } catch (err) {
    console.error(`restore-growth-os: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
