import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { OfflineSearchProvider } from '../src/research/provider/offline.js';
import { ResearchRepository } from '../src/research/repository.js';
import { ResearchService } from '../src/research/research-service.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { Errors, GrowthError } from '../src/research/errors.js';
import { SIGNAL_TYPES, type RawMention } from '../src/research/types.js';

const FIXED_NOW = '2026-10-25T00:00:00Z';

const KEYWORDS = [
  'ai crm',
  'cold email',
  'outreach',
  'personal agent',
  'follow up',
  'lead generation',
  'sales',
];

async function makeService() {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const repo = new ResearchRepository(driver);
  const service = new ResearchService({
    repo,
    provider: new OfflineSearchProvider(),
    scoring: loadConfig().scoring,
    now: () => FIXED_NOW,
  });
  return { service, driver };
}

async function runOnce() {
  const { service, driver } = await makeService();
  const topic = await service.createTopic({
    title: 'AI growth tooling demand',
    description: 'research',
    keywords: KEYWORDS,
    signalTypes: [...SIGNAL_TYPES],
    language: 'en',
  });
  const result = await service.run(topic.id);
  return { service, driver, topic, result };
}

describe('research end-to-end (offline, sqlite)', () => {
  it('validates topic input', async () => {
    const { service } = await makeService();
    await expect(service.createTopic({ title: '', keywords: ['x'] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
    await expect(service.createTopic({ title: 't', keywords: [] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      service.createTopic({ title: 't', keywords: ['x'], signalTypes: ['nope' as never] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('collects, dedupes, scores, clusters and reports in one run', async () => {
    const { result, topic } = await runOnce();
    expect(result.topic.status).toBe('done');
    const { signals, insights, report } = result;

    expect(signals.length).toBeGreaterThan(10);
    // duplicate fixture row (same url+title) collapses to one fingerprint
    const urls = new Set(signals.map((s) => s.url));
    expect(urls.size).toBe(signals.length);

    for (const s of signals) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
      expect(s.scoreBreakdown).toBeDefined();
      expect(s.fingerprint).toHaveLength(16);
      expect(s.url).toMatch(/^https?:\/\//);
      expect(s.topicId).toBe(topic.id);
    }

    expect(insights.length).toBeGreaterThanOrEqual(4);
    expect(insights.every((i) => i.status === 'pending_review')).toBe(true);
    const insightTitles = new Set(insights.map((i) => i.title));
    expect(insightTitles.size).toBe(insights.length);

    expect(report.version).toBe(1);
    expect(report.mode).toBe('offline');
    expect(report.stats.totalSignals).toBe(signals.length);
    expect(report.topSignals.length).toBeLessThanOrEqual(loadConfig().scoring.reportTopN);
    // offline watermark is present so demo data is never passed off as real
    expect(report.markdown).toContain('离线演示数据');
    expect(report.markdown).toContain(topic.title);
  });

  it('is idempotent across runs: signals dedup, insights dedup, report version increments', async () => {
    const { service, topic } = await runOnce();
    const first = await service.run(topic.id);
    const second = await service.run(topic.id);

    expect(second.signals.length).toBe(first.signals.length);
    expect(second.insights.length).toBe(first.insights.length);
    expect(first.report.version).toBe(2);
    expect(second.report.version).toBe(3);
  });

  it('enforces the human review gate and 409 on re-review', async () => {
    const { service, result } = await runOnce();
    const target = result.insights[0];
    expect(target).toBeDefined();

    const confirmed = await service.reviewInsight(target!.id, 'confirm');
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.reviewedAt).toBe(FIXED_NOW);

    await expect(service.reviewInsight(target!.id, 'reject')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });

    // a confirmed insight is not re-created as pending on a subsequent run
    const rerun = await service.run(result.topic.id);
    const same = rerun.insights.find((i) => i.id === target!.id);
    expect(same?.status).toBe('confirmed');
  });

  it('supports rejection and surfaces 404s', async () => {
    const { service, result } = await runOnce();
    const target = result.insights[1];
    const rejected = await service.reviewInsight(target!.id, 'reject');
    expect(rejected.status).toBe('rejected');

    await expect(service.getTopic('topic_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.getReport('rpt_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('fetches a stored report with hydrated insights and evidence', async () => {
    const { service, result } = await runOnce();
    const stored = await service.getReport(result.report.id);
    expect(stored.id).toBe(result.report.id);
    expect(stored.topSignals[0]?.url).toBeDefined();
    for (const i of stored.insights) {
      for (const sid of i.signalIds) {
        expect(result.signals.some((s) => s.id === sid)).toBe(true);
      }
    }
  });
});

describe('online missing credentials fail closed', () => {
  it('run returns 422 CREDENTIAL_MISSING instead of silent offline', async () => {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const repo = new ResearchRepository(driver);
    const cfg = {
      ...loadConfig(),
      searchMode: 'online' as const,
      searchBaseUrl: undefined,
      searchApiKey: undefined,
    };
    const { createSearchProvider } = await import('../src/research/provider/registry.js');
    const service = new ResearchService({
      repo,
      provider: createSearchProvider(cfg),
      scoring: cfg.scoring,
    });
    const topic = await service.createTopic({ title: 't', keywords: ['ai crm'] });
    const err = await service.run(topic.id).catch((e) => e);
    expect(err).toBeInstanceOf(GrowthError);
    expect(err.status).toBe(422);
    expect(err.code).toBe('CREDENTIAL_MISSING');
    // P2-1: the failed run must surface as 'failed', not stay 'running'.
    expect((await service.getTopic(topic.id)).status).toBe('failed');
  });
});

describe('failed runs surface as topic status failed (2026-11-02 review P2-1)', () => {
  /** Provider that fails a fixed number of searches, then serves one mention. */
  class FlakyProvider {
    readonly name = 'flaky';
    readonly online = true;
    failuresLeft: number;

    constructor(failures: number) {
      this.failuresLeft = failures;
    }

    async search(): Promise<RawMention[]> {
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
        throw Errors.searchUnavailable('provider down');
      }
      return [
        {
          sourceType: 'web',
          signalType: 'need',
          title: 'looking for an ai crm for cold email outreach',
          content: 'we need a personal agent for lead generation and follow up',
          url: 'https://example.com/need-1',
          publishedAt: FIXED_NOW,
        },
      ];
    }
  }

  async function makeFlakyStack(failures: number) {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const repo = new ResearchRepository(driver);
    const provider = new FlakyProvider(failures);
    const service = new ResearchService({
      repo,
      provider,
      scoring: loadConfig().scoring,
      now: () => FIXED_NOW,
    });
    return { service, provider };
  }

  it('marks the topic failed when the provider throws mid-run', async () => {
    const { service } = await makeFlakyStack(1);
    const topic = await service.createTopic({ title: 't', keywords: KEYWORDS });

    await expect(service.run(topic.id)).rejects.toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
      status: 503,
    });
    expect((await service.getTopic(topic.id)).status).toBe('failed');
  });

  it('allows a retry after failure and reaches done', async () => {
    const { service } = await makeFlakyStack(1);
    const topic = await service.createTopic({ title: 't', keywords: KEYWORDS });

    await expect(service.run(topic.id)).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
    expect((await service.getTopic(topic.id)).status).toBe('failed');

    const result = await service.run(topic.id);
    expect(result.topic.status).toBe('done');
    expect(result.signals.length).toBeGreaterThan(0);
  });
});
