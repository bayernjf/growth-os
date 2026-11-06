#!/usr/bin/env node
// Migration CLI: node scripts/migrate.mjs up|status [--driver sqlite|postgres]
// SQLite uses the built-in node:sqlite; postgres lazily requires `pg`.
import { SqliteDriver } from '../dist/storage/sqlite/sqlite-driver.js';
import { PostgresDriver } from '../dist/storage/postgres/postgres-driver.js';
import { migrateUp, migrationStatus } from '../dist/storage/migrate.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Host:port only; never echo credentials embedded in DATABASE_URL. */
function describePostgresTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * Turn a bare driver-level socket error into an actionable message. The
 * underlying code (ECONNREFUSED, ENOTFOUND, 28P01, ...) is kept so operators
 * can search it, and the sqlite fallback is spelled out for machines without
 * a Postgres instance.
 */
function explainPostgresConnectError(err, url) {
  const code = typeof err?.code === 'string' ? err.code : '';
  const target = describePostgresTarget(url);
  const sqliteHint =
    'No Postgres instance available? Use --driver sqlite (or GROWTH_SQLITE_PATH) instead.';
  switch (code) {
    case 'ECONNREFUSED':
      return `Cannot connect to Postgres at ${target} (ECONNREFUSED): the server is not listening on that host/port. Start Postgres or fix DATABASE_URL. ${sqliteHint}`;
    case 'ENOTFOUND':
      return `Cannot resolve the Postgres host for ${target} (ENOTFOUND). Check the hostname in DATABASE_URL.`;
    case 'ETIMEDOUT':
      return `Connecting to Postgres at ${target} timed out. Check network/firewall and the port.`;
    case '28P01':
      return `Postgres rejected the credentials for ${target} (28P01). Check the user/password in DATABASE_URL.`;
    case '3D000':
      return `Postgres has no such database at ${target} (3D000). Check the database name in DATABASE_URL.`;
    default:
      return `Cannot connect to Postgres at ${target}${code ? ` (${code})` : ''}: ${err?.message ?? String(err)}`;
  }
}

async function main() {
  const command = process.argv[2];
  const driverArg = process.argv.includes('--driver')
    ? process.argv[process.argv.indexOf('--driver') + 1]
    : process.env.GROWTH_DB_DRIVER || 'sqlite';

  let driver;
  if (driverArg === 'sqlite') {
    const path = process.env.GROWTH_SQLITE_PATH || './data/growth-os.db';
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    driver = new SqliteDriver(path);
  } else if (driverArg === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for --driver postgres');
    try {
      driver = await PostgresDriver.connect(url);
    } catch (err) {
      throw new Error(explainPostgresConnectError(err, url));
    }
  } else {
    throw new Error(`Unknown driver: ${driverArg}`);
  }

  try {
    if (command === 'up') {
      const applied = await migrateUp(driver);
      console.log(`applied: ${applied.length === 0 ? '(none, already up to date)' : applied.join(', ')}`);
    } else if (command === 'status') {
      const status = await migrationStatus(driver);
      console.log(`applied: ${status.applied.join(', ') || '(none)'}`);
      console.log(`pending: ${status.pending.join(', ') || '(none)'}`);
    } else {
      throw new Error('usage: migrate.mjs up|status [--driver sqlite|postgres]');
    }
  } finally {
    await driver.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
