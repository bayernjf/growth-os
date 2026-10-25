import { describe, expect, it } from 'vitest';
import { MatchRepository } from '../src/match/repository.js';
import { MatchService } from '../src/match/match-service.js';
import type { Signal } from '../src/research/types.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const FIXED_NOW = '2026-10-25T00:00:00Z';

function makeSignal(id: string, signalType: 'need' | 'intent', title: string, content: string): Signal {
  return {
    id,
    topicId: 'tp_1',
    provider: 'offline',
    sourceType: 'web',
    signalType,
    title,
    content,
    url: `https://example.com/${id}`,
    fingerprint: `fp_${id}`,
    score: 80,
    scoreBreakdown: { type: 40, source: 10, fresh: 10, keyword: 20, total: 80 },
    createdAt: FIXED_NOW,
  };
}

async function makeStack() {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const repo = new MatchRepository(driver);
  const service = new MatchService({ repo, now: () => FIXED_NOW });
  return { driver, repo, service };
}

async function seedTopicAndSignals(driver: SqliteDriver) {
  await driver.run(
    `INSERT INTO research_topics (id,title,description,keywords,signal_types,language,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['tp_1', 't', '', '[]', '["need","intent"]', 'en', 'done', FIXED_NOW, FIXED_NOW],
  );
  await driver.run(
    `INSERT INTO signals (id,topic_id,provider,source_type,signal_type,title,content,url,fingerprint,score,score_breakdown,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['sig_buyer', 'tp_1', 'offline', 'web', 'need', 'Looking for stainless steel bottle supplier', 'We want to buy 1000 units, budget $2-$3, ship to USA.', 'https://example.com/sig_buyer', 'fp_sig_buyer', 80, '{}', FIXED_NOW],
  );
  await driver.run(
    `INSERT INTO signals (id,topic_id,provider,source_type,signal_type,title,content,url,fingerprint,score,score_breakdown,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['sig_supplier', 'tp_1', 'offline', 'web', 'intent', 'Factory supplies stainless steel bottles', 'Wholesale kitchenware from China, price $2.5, MOQ 500.', 'https://example.com/sig_supplier', 'fp_sig_supplier', 80, '{}', FIXED_NOW],
  );
}

describe('match end-to-end (GATE-G5)', () => {
  it('matches a buyer demand signal with a supplier offer signal', async () => {
    const { driver, service } = await makeStack();
    await seedTopicAndSignals(driver);

    const buyer = await service.ingestSignal(
      makeSignal('sig_buyer', 'need', 'Looking for stainless steel bottle supplier', 'We want to buy 1000 units, budget $2-$3, ship to USA.'),
    );
    const supplier = await service.ingestSignal(
      makeSignal('sig_supplier', 'intent', 'Factory supplies stainless steel bottles', 'Wholesale kitchenware from China, price $2.5, MOQ 500.'),
    );
    expect(buyer?.kind).toBe('demand');
    expect(supplier?.kind).toBe('offer');

    const matches = await service.runMatch();
    expect(matches).toHaveLength(1);
    expect(matches[0]?.score).toBeGreaterThanOrEqual(60);
    expect(matches[0]?.reasons.category).toBe(40);
    expect(matches[0]?.reasons.price).toBe(20);

    const listed = await service.listMatches();
    expect(listed[0]?.id).toBe(matches[0]?.id);
    expect(listed[0]?.status).toBe('pending');
  });

  it('builds an introduction for a match', async () => {
    const { driver, service } = await makeStack();
    await seedTopicAndSignals(driver);
    await service.ingestSignal(
      makeSignal('sig_buyer', 'need', 'Looking for stainless steel bottle supplier', 'We want to buy 1000 units, budget $2-$3, ship to USA.'),
    );
    await service.ingestSignal(
      makeSignal('sig_supplier', 'intent', 'Factory supplies stainless steel bottles', 'Wholesale kitchenware from China, price $2.5, MOQ 500.'),
    );
    const matches = await service.runMatch();
    const intro = await service.buildIntroduction(matches[0]!.id);
    expect(intro.subject).toContain('stainless steel');
    expect(intro.text).toContain('Buyer demand');
    expect(intro.text).toContain('Supplier offer');
    expect(intro.text).toContain('Match score: 90 / 100');
    expect(intro.text).toContain('category: 40');
  });
});

function makeSink() {
  const created: Array<{ toEmail: string; subject: string; text: string; leadTitle: string }> = [];
  return {
    created,
    createContactDraft(toEmail: string, subject: string, text: string, leadTitle: string) {
      created.push({ toEmail, subject, text, leadTitle });
      return Promise.resolve({ id: 'draft_1' });
    },
  };
}

describe('match contact (routing into outreach)', () => {
  it('routes a match into the outreach flow using buyer email', async () => {
    const { driver, repo } = await makeStack();
    const sink = makeSink();
    const service = new MatchService({ repo, outreach: sink, now: () => FIXED_NOW });
    await seedTopicAndSignals(driver);
    await service.ingestSignal(
      makeSignal('sig_buyer', 'need', 'Looking for stainless steel bottle supplier', 'We want to buy 1000 units, budget $2-$3. Contact: buyer@acme.com'),
    );
    await service.ingestSignal(
      makeSignal('sig_supplier', 'intent', 'Factory supplies stainless steel bottles', 'Wholesale kitchenware from China, price $2.5, MOQ 500.'),
    );
    const matches = await service.runMatch();
    const result = await service.contactMatch(matches[0]!.id, 'owner@me.com');
    expect(result.to).toBe('buyer@acme.com');
    expect(sink.created).toHaveLength(1);
    expect(sink.created[0]?.toEmail).toBe('buyer@acme.com');
    expect(sink.created[0]?.subject).toContain('stainless steel');
  });

  it('falls back to owner email when no contact email exists', async () => {
    const { driver, repo } = await makeStack();
    const sink = makeSink();
    const service = new MatchService({ repo, outreach: sink, now: () => FIXED_NOW });
    await seedTopicAndSignals(driver);
    await service.ingestSignal(
      makeSignal('sig_buyer', 'need', 'Looking for stainless steel bottle supplier', 'We want to buy 1000 units, budget $2-$3.'),
    );
    await service.ingestSignal(
      makeSignal('sig_supplier', 'intent', 'Factory supplies stainless steel bottles', 'Wholesale kitchenware from China, price $2.5, MOQ 500.'),
    );
    const matches = await service.runMatch();
    const result = await service.contactMatch(matches[0]!.id, 'owner@me.com');
    expect(result.to).toBe('owner@me.com');
  });
});
