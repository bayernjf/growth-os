import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SalesRepository } from '../src/sales/repository.js';
import { SalesService } from '../src/sales/sales-service.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const NOW = '2026-11-04T00:00:00Z';

function lineItems() {
  return [{ description: 'Setup', qty: 1, unitAmountCents: 100_000, currency: 'CNY' }];
}

function openConnection(path: string): SqliteDriver {
  return new SqliteDriver(path);
}

describe('concurrent order creation (2026-11-02 review P2-4)', () => {
  it('allocates unique order numbers across independent connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gos-orders-'));
    const dbPath = join(dir, 'orders.db');
    const drivers: SqliteDriver[] = [];
    try {
      const primary = openConnection(dbPath);
      drivers.push(primary);
      await migrateUp(primary);

      const repo = new SalesRepository(primary);
      const service = new SalesService({ repo, now: () => NOW });
      const contractIds: string[] = [];
      const contracts = 4;
      for (let i = 0; i < contracts; i += 1) {
        const quote = await service.createQuote({ lineItems: lineItems() });
        await service.sendQuote(quote.id);
        await service.acceptQuote(quote.id);
        const contract = await service.createContract(quote.id);
        await service.sendContract(contract.id);
        await service.signContract(contract.id);
        contractIds.push(contract.id);
      }

      // One service/repository per independent sqlite connection so each
      // createOrder transaction really runs concurrently on its own writer.
      const services = contractIds.map((_, index) => {
        const driver = index === 0 ? primary : openConnection(dbPath);
        if (index !== 0) drivers.push(driver);
        return new SalesService({ repo: new SalesRepository(driver), now: () => NOW });
      });
      const concurrent = await Promise.all(
        services.map((service, index) => service.createOrder(contractIds[index]!)),
      );

      const orderNos = concurrent.map((order) => order.orderNo);
      expect(orderNos).toHaveLength(contracts);
      expect(new Set(orderNos).size).toBe(contracts);
      expect([...orderNos].sort()).toEqual([
        'ORD-00001',
        'ORD-00002',
        'ORD-00003',
        'ORD-00004',
      ]);
      expect(await new SalesRepository(primary).listOrders()).toHaveLength(contracts);
    } finally {
      for (const driver of drivers) await driver.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
