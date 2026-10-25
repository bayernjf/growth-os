import { describe, expect, it } from 'vitest';
import { MatchRepository } from '../src/match/repository.js';
import { MatchService } from '../src/match/match-service.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const FIXED_NOW = '2026-10-25T00:00:00Z';

async function makeService(options?: { minScore?: number }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const repo = new MatchRepository(driver);
  const service = new MatchService({ repo, minScore: options?.minScore ?? 60, now: () => FIXED_NOW });
  return { driver, repo, service };
}

describe('MatchService', () => {
  it('creates demands and offers with validation', async () => {
    const { service } = await makeService();
    const d = await service.createDemand({ title: 'Need bottles', category: 'kitchenware' });
    expect(d.status).toBe('new');
    await expect(service.createDemand({ title: '', category: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(service.createOffer({ title: 'x', category: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('runs matching idempotently above threshold', async () => {
    const { service } = await makeService();
    await service.createDemand({
      title: 'Need bottles',
      category: 'kitchenware',
      quantity: '1000 units',
      priceMin: 2,
      priceMax: 3,
      region: 'US',
    });
    await service.createOffer({ title: 'Supply bottles', category: 'kitchenware', price: 2.5, moq: 500, region: 'CN' });

    const first = await service.runMatch();
    expect(first).toHaveLength(1);
    expect(first[0]?.score).toBeGreaterThanOrEqual(60);

    const second = await service.runMatch();
    expect(second).toHaveLength(0); // idempotent
    expect((await service.listMatches())).toHaveLength(1);
  });

  it('does not match below threshold', async () => {
    const { service } = await makeService();
    await service.createDemand({ title: 'Need electronics', category: 'electronics' });
    await service.createOffer({ title: 'Supply kitchenware', category: 'kitchenware' });
    expect(await service.runMatch()).toHaveLength(0);
  });

  it('accepts a match and fails closed on unknown id', async () => {
    const { service } = await makeService();
    await service.createDemand({ title: 'Need bottles', category: 'kitchenware', quantity: '1000 units', priceMin: 2, priceMax: 3 });
    await service.createOffer({ title: 'Supply bottles', category: 'kitchenware', price: 2.5, moq: 500 });
    const created = await service.runMatch();
    const accepted = await service.acceptMatch(created[0]!.id);
    expect(accepted.status).toBe('accepted');
    await expect(service.acceptMatch('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ingests a demand signal into a buyer demand', async () => {
    const { driver, service } = await makeService();
    await driver.run(
      `INSERT INTO research_topics (id,title,description,keywords,signal_types,language,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ['tp_1', 't', '', '[]', '["need"]', 'en', 'done', FIXED_NOW, FIXED_NOW],
    );
    await driver.run(
      `INSERT INTO signals (id,topic_id,provider,source_type,signal_type,title,content,url,fingerprint,score,score_breakdown,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['sig_1', 'tp_1', 'offline', 'web', 'need', 'Looking for stainless steel bottle supplier', 'We want to buy 1000 units, budget $2-$3, ship to USA.', 'https://example.com', 'fp_1', 80, '{}', FIXED_NOW],
    );
    const entity = await service.ingestSignal({
      id: 'sig_1',
      topicId: 'tp_1',
      provider: 'offline',
      sourceType: 'web',
      signalType: 'need',
      title: 'Looking for stainless steel bottle supplier',
      content: 'We want to buy 1000 units, budget $2-$3, ship to USA.',
      url: 'https://example.com',
      fingerprint: 'fp_1',
      score: 80,
      scoreBreakdown: { type: 40, source: 10, fresh: 10, keyword: 20, total: 80 },
      createdAt: FIXED_NOW,
    });
    expect(entity?.kind).toBe('demand');
    expect(await service.listDemands()).toHaveLength(1);
  });
});
