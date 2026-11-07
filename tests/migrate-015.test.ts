import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const repairSql = readFileSync(
  new URL('../db/migrations/sqlite/015_order_number_sequence_repair.sql', import.meta.url),
  'utf8',
);

async function nextValue(driver: SqliteDriver): Promise<number | undefined> {
  const row = await driver.get<{ next_value: number }>(
    "SELECT next_value FROM order_number_sequence WHERE name = 'order'",
  );
  return row === undefined ? undefined : Number(row.next_value);
}

async function withDatabase(
  fn: (driver: SqliteDriver) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gos-migrate-015-'));
  const driver = new SqliteDriver(join(dir, 'repair.db'));
  try {
    await fn(driver);
  } finally {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('015 order number sequence repair', () => {
  it('is applied by the runner and raises a COUNT(*)-undercounted seed', async () => {
    await withDatabase(async (driver) => {
      const applied = await migrateUp(driver);
      expect(applied).toContain('015_order_number_sequence_repair');
      expect(await nextValue(driver)).toBe(0);

      // Simulate the 014 seed being smaller than the highest historical
      // order number (deleted orders / manual renumbering).
      await driver.run("UPDATE order_number_sequence SET next_value = 0 WHERE name = 'order'");
      await driver.run(
        "INSERT INTO quotes (id, amount_cents, currency, created_at, updated_at) VALUES ('q1', 0, 'USD', '2026-01-01', '2026-01-01')",
      );
      for (const orderNo of ['ORD-00001', 'ORD-00002', 'ORD-00007']) {
        await driver.run(
          `INSERT INTO orders (id, order_no, quote_id, amount_cents, currency, created_at, updated_at)
           VALUES ('o-${orderNo}', '${orderNo}', 'q1', 0, 'USD', '2026-01-01', '2026-01-01')`,
        );
      }
      // Malformed numbers must not participate in MAX (they would abort the cast).
      for (const bad of ['ORD-XYZ', 'ORD-00021x', 'LEGACY-9']) {
        await driver.run(
          `INSERT INTO orders (id, order_no, quote_id, amount_cents, currency, created_at, updated_at)
           VALUES ('bad-${bad}', '${bad}', 'q1', 0, 'USD', '2026-01-01', '2026-01-01')`,
        );
      }

      await driver.exec(repairSql);
      expect(await nextValue(driver)).toBe(7);

      // Idempotent: a second run keeps the same value.
      await driver.exec(repairSql);
      expect(await nextValue(driver)).toBe(7);
    });
  });

  it('only raises: never lowers an already higher counter', async () => {
    await withDatabase(async (driver) => {
      await migrateUp(driver);
      await driver.run("UPDATE order_number_sequence SET next_value = 99 WHERE name = 'order'");

      await driver.exec(repairSql);
      expect(await nextValue(driver)).toBe(99);
    });
  });

  it('keeps both dialects raise-only and ORD-<digits>-only', () => {
    const pgSql = readFileSync(
      new URL('../db/migrations/postgres/015_order_number_sequence_repair.sql', import.meta.url),
      'utf8',
    );
    // Postgres: recreate the row idempotently, raise with GREATEST, and only
    // count order_no values shaped exactly like ORD-<digits>.
    expect(pgSql).toMatch(/INSERT INTO order_number_sequence/);
    expect(pgSql).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
    expect(pgSql).toMatch(/GREATEST/);
    expect(pgSql).toContain("order_no ~ '^ORD-[0-9]+$'");
    // SQLite: same guards with INSERT OR IGNORE / scalar MAX / strict GLOB pair.
    expect(repairSql).toMatch(/INSERT OR IGNORE/);
    expect(repairSql).toMatch(/MAX\(/);
    expect(repairSql).toContain("order_no GLOB 'ORD-[0-9]*'");
    expect(repairSql).toContain("NOT GLOB '*[^0-9]*'");
    // Neither dialect may lower the counter.
    expect(pgSql).not.toMatch(/SET next_value = LEAST/);
    expect(repairSql).not.toMatch(/SET next_value = MIN/);
  });

  it('recreates the sequence row when it is missing', async () => {
    await withDatabase(async (driver) => {
      await migrateUp(driver);
      await driver.run("DELETE FROM order_number_sequence WHERE name = 'order'");

      await driver.exec(repairSql);
      expect(await nextValue(driver)).toBe(0);
    });
  });
});
