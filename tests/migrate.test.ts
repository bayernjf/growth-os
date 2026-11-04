import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StorageDriver, StorageTxn } from '../src/storage/driver.js';
import { migrateUp, migrationStatus } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

/** Fails after the migration DDL ran but before its schema_migrations row. */
class FailOnRecordDriver implements StorageDriver {
  readonly dialect = 'sqlite' as const;
  constructor(private readonly inner: StorageDriver) {}
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.inner.all<T>(sql, params);
  }
  get<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined> {
    return this.inner.get<T>(sql, params);
  }
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }> {
    return this.inner.run(sql, params);
  }
  exec(sql: string): Promise<void> {
    return this.inner.exec(sql);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  transaction<T>(fn: (tx: StorageTxn) => Promise<T>): Promise<T> {
    return this.inner.transaction((tx) =>
      fn({
        all: (sql, params) => tx.all(sql, params),
        get: (sql, params) => tx.get(sql, params),
        run: (sql, params) => {
          if (sql.includes('INSERT INTO schema_migrations')) {
            throw new Error('simulated migration record failure');
          }
          return tx.run(sql, params);
        },
        exec: (sql) => tx.exec(sql),
      }),
    );
  }
}

describe('migration atomicity (2026-11-02 review P3-8)', () => {
  it('rolls back DDL when registration fails and reruns idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gos-migrate-'));
    const dbPath = join(dir, 'migrate.db');
    const primary = new SqliteDriver(dbPath);
    try {
      await expect(migrateUp(new FailOnRecordDriver(primary))).rejects.toThrow(
        'simulated migration record failure',
      );

      const reader = new SqliteDriver(dbPath);
      try {
        const failedStatus = await migrationStatus(reader);
        expect(failedStatus.applied).toEqual([]);
        expect(failedStatus.pending.length).toBeGreaterThan(0);
        const leaked = await reader.get<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='research_topics'",
        );
        expect(leaked).toBeUndefined();

        // Re-entrant: a clean rerun applies every migration, then is a no-op.
        expect(await migrateUp(reader)).toEqual(failedStatus.pending);
        expect(await migrateUp(reader)).toEqual([]);
        expect(
          await reader.get<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='research_topics'",
          ),
        ).toEqual({ name: 'research_topics' });
      } finally {
        await reader.close();
      }
    } finally {
      await primary.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
