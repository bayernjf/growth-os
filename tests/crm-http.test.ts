import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createCrmApp } from '../src/api/crm-http.js';
import { createResearchApp } from '../src/api/research-http.js';
import { CrmRepository } from '../src/crm/repository.js';
import { LeadService } from '../src/crm/lead-service.js';
import { LocalWatch } from '../src/crm/watch.js';
import { OfflineSearchProvider } from '../src/research/provider/offline.js';
import { ResearchRepository } from '../src/research/repository.js';
import { ResearchService } from '../src/research/research-service.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SIGNAL_TYPES } from '../src/research/types.js';

async function buildApp(options?: { apiToken?: string }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const cfg = loadConfig();
  const researchRepo = new ResearchRepository(driver);
  const researchService = new ResearchService({
    repo: researchRepo,
    provider: new OfflineSearchProvider(),
    scoring: cfg.scoring,
  });
  const crmRepo = new CrmRepository(driver);
  const leadService = new LeadService({
    repo: crmRepo,
    signals: researchRepo,
    watch: new LocalWatch(crmRepo),
    leadMinScore: cfg.leadMinScore,
  });
  const app = new Hono();
  app.route('/', createResearchApp({ service: researchService, ...(options?.apiToken ? { apiToken: options.apiToken } : {}) }));
  app.route('/', createCrmApp({ service: leadService, ...(options?.apiToken ? { apiToken: options.apiToken } : {}) }));
  return { app, researchService, leadService };
}

describe('crm HTTP API (mounted alongside research)', () => {
  it('creates and reads a lead, then fails closed on an illegal transition', async () => {
    const { app } = await buildApp();
    const create = await app.request('/api/v1/crm/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Manual lead' }),
    });
    expect(create.status).toBe(201);
    const lead = (await create.json()) as { id: string; status: string };
    expect(lead.status).toBe('new');

    const get = await app.request(`/api/v1/crm/leads/${lead.id}`);
    expect(get.status).toBe(200);

    const bad = await app.request(`/api/v1/crm/leads/${lead.id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'won' }),
    });
    expect(bad.status).toBe(409);
    expect((await bad.json()) as { code: string }).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('returns 404 for a missing lead', async () => {
    const { app } = await buildApp();
    const res = await app.request('/api/v1/crm/leads/lead_missing');
    expect(res.status).toBe(404);
  });

  it('promotes research signals into leads end to end', async () => {
    const { app } = await buildApp();
    const create = await app.request('/api/v1/research/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Demand for AI CRM', keywords: ['ai crm', 'outreach'], signalTypes: [...SIGNAL_TYPES] }),
    });
    const topic = (await create.json()) as { id: string };

    const run = await app.request('/api/v1/research/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: topic.id }),
    });
    expect(run.status).toBe(200);

    const promote = await app.request('/api/v1/crm/leads/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: topic.id }),
    });
    expect(promote.status).toBe(200);
    const leads = (await promote.json()) as unknown[];
    expect(leads.length).toBeGreaterThan(0);

    // idempotent across the HTTP boundary
    const again = await app.request('/api/v1/crm/leads/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicId: topic.id }),
    });
    expect(((await again.json()) as unknown[]).length).toBe(0);
  });

  it('requires a bearer token when configured', async () => {
    const { app } = await buildApp({ apiToken: 'secret' });
    const res = await app.request('/api/v1/crm/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }),
    });
    expect(res.status).toBe(401);
  });
});
