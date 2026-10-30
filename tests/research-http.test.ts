import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createResearchApp } from '../src/api/research-http.js';
import { createSearchProvider } from '../src/research/provider/registry.js';
import { ResearchRepository } from '../src/research/repository.js';
import { ResearchService } from '../src/research/research-service.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SIGNAL_TYPES } from '../src/research/types.js';

async function buildApp(options?: { apiToken?: string; mode?: 'offline' | 'online' }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const cfg = loadConfig();
  const config = {
    ...cfg,
    searchMode: (options?.mode ?? 'offline') as 'offline' | 'online',
    ...(options?.mode === 'online' ? { searchBaseUrl: undefined, searchApiKey: undefined } : {}),
  };
  const service = new ResearchService({
    repo: new ResearchRepository(driver),
    provider: createSearchProvider(config),
    scoring: config.scoring,
  });
  return createResearchApp({ service, ...(options?.apiToken ? { apiToken: options.apiToken } : {}) });
}

describe('research HTTP API', () => {
  it('healthz', async () => {
    const app = await buildApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('creates a topic and runs research, then fetches the report', async () => {
    const app = await buildApp();

    const create = await app.request('/api/v1/research/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Demand for AI CRM', keywords: ['ai crm', 'outreach'], signalTypes: [...SIGNAL_TYPES] }),
    });
    expect(create.status).toBe(201);
    const topic = (await create.json()) as { id: string };

    const run = await app.request('/api/v1/research/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: topic.id }),
    });
    expect(run.status).toBe(200);
    const result = (await run.json()) as { report: { id: string; mode: string }; signals: unknown[] };
    expect(result.report.mode).toBe('offline');
    expect(result.signals.length).toBeGreaterThan(0);

    const report = await app.request(`/api/v1/research/reports/${result.report.id}`);
    expect(report.status).toBe(200);
  });

  it('rejects invalid topic with 400', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/research/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', keywords: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('requires a bearer token when configured', async () => {
    const app = await buildApp({ apiToken: 'secret' });
    const noToken = await app.request('/api/v1/research/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', keywords: ['x'] }),
    });
    expect(noToken.status).toBe(401);

    const ok = await app.request('/api/v1/research/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ title: 't', keywords: ['x'] }),
    });
    expect(ok.status).toBe(201);
  });

  it('returns 422 when online mode has no credentials', async () => {
    const app = await buildApp({ mode: 'online' });
    const create = await app.request('/api/v1/research/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', keywords: ['ai crm'] }),
    });
    const topic = (await create.json()) as { id: string };
    const run = await app.request('/api/v1/research/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: topic.id }),
    });
    expect(run.status).toBe(422);
    expect((await run.json()) as { code: string }).toMatchObject({ code: 'CREDENTIAL_MISSING' });
  });

  it('returns a generic 500 and logs internally when a non-GrowthError escapes', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = await buildApp();
      const res = await app.request('/api/v1/research/topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"title": malformed',
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; message: string; retryable: boolean };
      // The response must stay generic: no SyntaxError text, no driver details.
      expect(body).toEqual({ code: 'INTERNAL', message: 'internal error', retryable: false });
      // The original error only goes to the server log.
      expect(errSpy).toHaveBeenCalledTimes(1);
      const logged = errSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      expect(logged).toContain('unhandled error');
      expect(logged).toContain('Unexpected token');
    } finally {
      errSpy.mockRestore();
    }
  });
});
