import { describe, expect, it } from 'vitest';
import { MatchRepository } from '../src/match/repository.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const FIXED_NOW = '2026-10-25T00:00:00Z';

async function makeRepo(): Promise<MatchRepository> {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  return new MatchRepository(driver);
}

describe('MatchRepository', () => {
  it('creates and reads a buyer demand', async () => {
    const repo = await makeRepo();
    const d = await repo.createBuyerDemand(
      {
        title: 'Need 1000 units of stainless steel bottles',
        category: 'kitchenware',
        quantity: '1000 units',
        priceMin: 2,
        priceMax: 3,
        currency: 'USD',
        region: 'US',
        description: 'looking for supplier',
      },
      FIXED_NOW,
    );
    expect(await repo.getBuyerDemand(d.id)).toMatchObject({
      category: 'kitchenware',
      priceMin: 2,
      priceMax: 3,
      status: 'new',
    });
    expect((await repo.listBuyerDemands()).length).toBe(1);
  });

  it('creates and reads a supplier offer', async () => {
    const repo = await makeRepo();
    const o = await repo.createSupplierOffer(
      { title: 'Factory supplies stainless steel bottles', category: 'kitchenware', price: 2.5, moq: 500, region: 'CN' },
      FIXED_NOW,
    );
    expect(await repo.getSupplierOffer(o.id)).toMatchObject({ category: 'kitchenware', price: 2.5, moq: 500 });
  });

  it('creates, lists and updates a match', async () => {
    const repo = await makeRepo();
    const d = await repo.createBuyerDemand({ title: 'need bottles', category: 'kitchenware' }, FIXED_NOW);
    const o = await repo.createSupplierOffer({ title: 'supply bottles', category: 'kitchenware' }, FIXED_NOW);

    const m = await repo.createMatch(d.id, o.id, 85, { category: 40, price: 20, region: 10 }, FIXED_NOW);
    expect(m.score).toBe(85);
    expect(m.reasons).toEqual({ category: 40, price: 20, region: 10 });

    const listed = await repo.listMatches();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('pending');

    await repo.setMatchStatus(m.id, 'accepted', FIXED_NOW);
    expect((await repo.getMatch(m.id))?.status).toBe('accepted');
  });
});
