import { describe, expect, it } from 'vitest';
import { PostgresDriver, type PgClientLike, type PgPoolLike } from '../src/storage/postgres/postgres-driver.js';

/**
 * P1-2 回归：并发事务必须各自占用独立连接，BEGIN/COMMIT 不得在同一连接上交错。
 * pg 为可选依赖（CI 不装），用仪表化 fake pool 驱动真实 driver。
 */

interface FakeClient extends PgClientLike {
  id: number;
  log: string[];
  released: boolean;
}

function createFakePool() {
  const events: string[] = [];
  const clients: FakeClient[] = [];
  let nextId = 0;
  const pool: PgPoolLike = {
    async connect() {
      const id = ++nextId;
      const client: FakeClient = {
        id,
        log: [],
        released: false,
        async query(sql: string) {
          client.log.push(sql);
          events.push(`c${id}:${sql}`);
          return { rows: [], rowCount: 0 };
        },
        release() {
          client.released = true;
          events.push(`c${id}:RELEASE`);
        },
      };
      clients.push(client);
      return client;
    },
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  return { pool, clients, events };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('PostgresDriver transaction isolation (P1-2)', () => {
  it('concurrent transactions check out distinct connections without interleaved BEGIN/COMMIT', async () => {
    const { pool, clients, events } = createFakePool();
    const driver = PostgresDriver.fromPool(pool);

    const gate = deferred<void>();
    const first = driver.transaction(async (tx) => {
      await tx.run('UPDATE leads SET status = ?', ['contacted']);
      await gate.promise; // hold the transaction open until the second one is mid-flight
      return 'first';
    });
    // Let the first transaction reach its critical section before starting the second.
    await new Promise((resolve) => setImmediate(resolve));
    const second = driver.transaction(async (tx) => {
      await tx.run('UPDATE quotes SET status = ?', ['sent']);
      return 'second';
    });
    await new Promise((resolve) => setImmediate(resolve));
    gate.resolve();

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');

    // Two independent connections were checked out and both released.
    expect(clients).toHaveLength(2);
    expect(clients[0]?.released).toBe(true);
    expect(clients[1]?.released).toBe(true);

    // Per-connection order: exactly one BEGIN and one COMMIT, strictly nested.
    for (const client of clients) {
      expect(client.log[0]).toBe('BEGIN');
      expect(client.log.at(-1)).toBe('COMMIT');
      expect(client.log.filter((sql) => sql === 'BEGIN')).toHaveLength(1);
      expect(client.log.filter((sql) => sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK'))).toHaveLength(1);
    }
    // No connection ever saw a second BEGIN before its own COMMIT (the old
    // single-client failure mode: BEGIN; BEGIN; …; COMMIT; COMMIT).
    const begins = events.filter((e) => e.endsWith(':BEGIN'));
    expect(new Set(begins)).toEqual(new Set(['c1:BEGIN', 'c2:BEGIN']));
  });

  it('rolls back and releases the connection when the callback throws', async () => {
    const { pool, clients } = createFakePool();
    const driver = PostgresDriver.fromPool(pool);

    await expect(
      driver.transaction(async (tx) => {
        await tx.run('UPDATE leads SET status = ?', ['won']);
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    expect(clients).toHaveLength(1);
    expect(clients[0]?.log).toEqual(['BEGIN', 'UPDATE leads SET status = $1', 'ROLLBACK']);
    expect(clients[0]?.released).toBe(true);
  });

  it('non-transactional reads/writes go through the pool, not a pinned client', async () => {
    const { pool } = createFakePool();
    let poolQueries = 0;
    pool.query = async () => {
      poolQueries += 1;
      return { rows: [], rowCount: 0 };
    };
    const driver = PostgresDriver.fromPool(pool);

    await driver.all('SELECT 1');
    await driver.run('UPDATE t SET x = ?', [1]);
    expect(poolQueries).toBe(2);
  });
});
