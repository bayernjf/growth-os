import { createRequire } from 'node:module';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { StorageDriver, StorageTxn } from '../driver.js';

// Loaded via createRequire so bundlers/test runners that predate the
// experimental node:sqlite module (and strip the `node:` prefix) leave it
// to the Node runtime instead of trying to resolve a bare "sqlite" import.
const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/**
 * SQLite driver for local development and tests (built-in node:sqlite,
 * no native dependency). Accepts ':memory:' for ephemeral databases.
 */
export class SqliteDriver implements StorageDriver {
  readonly dialect = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new sqlite.DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const result = this.db.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: StorageTxn) => Promise<T>): Promise<T> {
    // IMMEDIATE acquires the write lock up front so two writers fail fast
    // instead of deadlocking inside the callback.
    const txn: StorageTxn = {
      all: (sql, params = []) =>
        Promise.resolve(
          this.db.prepare(sql).all(...(params as SQLInputValue[])) as never,
        ),
      get: (sql, params = []) =>
        Promise.resolve(
          this.db.prepare(sql).get(...(params as SQLInputValue[])) as never,
        ),
      run: (sql, params = []) => {
        const result = this.db.prepare(sql).run(...(params as SQLInputValue[]));
        return Promise.resolve({ changes: Number(result.changes ?? 0) });
      },
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(txn);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
