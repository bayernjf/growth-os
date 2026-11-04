import type { StorageDriver, StorageTxn } from '../driver.js';

/**
 * Minimal structural surface of a `pg` pool client (the `pg` package is an
 * optional dependency that is NOT installed in local CI, so its types are
 * intentionally absent here).
 */
export interface PgClientLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  release: () => void;
}

/** Minimal structural surface of `pg.Pool` used by this driver. */
export interface PgPoolLike {
  connect: () => Promise<PgClientLike>;
  query: PgClientLike['query'];
  end: () => Promise<void>;
}

/**
 * Postgres driver for production. The `pg` package is an optional
 * dependency that is NOT installed in local CI: constructing this driver
 * without it fails closed with an actionable error instead of silently
 * falling back to another dialect.
 *
 * Business SQL uses `?` placeholders; this driver converts them to `$1..$n`.
 *
 * Transactions (2026-11-02 review P1-2): every transaction checks out its OWN
 * connection from the pool and releases it in `finally`. The previous
 * single-client driver interleaved BEGIN/COMMIT across concurrent requests,
 * letting one request's ROLLBACK abort another's in-flight work.
 */
export class PostgresDriver implements StorageDriver {
  readonly dialect = 'postgres' as const;

  private constructor(private readonly pool: PgPoolLike) {}

  static async connect(connectionString: string): Promise<PostgresDriver> {
    let pg: { Pool: new (config: { connectionString: string }) => PgPoolLike };
    try {
      // `pg` is an optional production dependency that is not installed in
      // local CI; its types are intentionally absent here.
      // @ts-expect-error -- optional runtime dependency, see class doc
      pg = (await import('pg')) as typeof pg;
    } catch {
      throw new Error(
        'Postgres driver requested but the optional `pg` dependency is not installed. Run `npm install pg` in the production environment.',
      );
    }
    const pool = new pg.Pool({ connectionString });
    await pool.query('SELECT 1');
    return new PostgresDriver(pool);
  }

  /**
   * Composition seam: build a driver over an existing pool. Used by
   * `connect()` in production and by tests with an instrumented fake pool
   * (the optional `pg` package is absent in CI).
   */
  static fromPool(pool: PgPoolLike): PostgresDriver {
    return new PostgresDriver(pool);
  }

  private static toDollarParams(sql: string): { text: string; count: number } {
    let count = 0;
    const text = sql.replace(/\?/g, () => `$${++count}`);
    return { text, count };
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const { text } = PostgresDriver.toDollarParams(sql);
    const result = await this.pool.query(text, [...params]);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, params);
    return rows[0];
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<{ changes: number }> {
    const { text } = PostgresDriver.toDollarParams(sql);
    const result = await this.pool.query(text, [...params]);
    return { changes: result.rowCount };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: StorageTxn) => Promise<T>): Promise<T> {
    const { toDollarParams } = PostgresDriver;
    // Dedicated connection per transaction: its BEGIN/COMMIT/ROLLBACK can
    // never interleave with another request's transaction on the same wire.
    const client = await this.pool.connect();
    const txn: StorageTxn = {
      all: async (sql, params = []) => {
        const { text } = toDollarParams(sql);
        const result = await client.query(text, [...params]);
        return result.rows as never;
      },
      get: async (sql, params = []) => {
        const { text } = toDollarParams(sql);
        const result = await client.query(text, [...params]);
        return result.rows[0] as never;
      },
      run: async (sql, params = []) => {
        const { text } = toDollarParams(sql);
        const result = await client.query(text, [...params]);
        return { changes: result.rowCount };
      },
      exec: async (sql) => {
        await client.query(sql);
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(txn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
