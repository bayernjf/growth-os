import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createCrmApp } from '../src/api/crm-http.js';
import { createLeadImportApp } from '../src/api/lead-import-http.js';
import { createMatchApp } from '../src/api/match-http.js';
import { createOutreachApp } from '../src/api/outreach-http.js';
import { createResearchApp } from '../src/api/research-http.js';
import { createSalesApp } from '../src/api/sales-http.js';
import { loadConfig } from '../src/config.js';
import { CrmRepository } from '../src/crm/repository.js';
import { LeadService } from '../src/crm/lead-service.js';
import { LocalWatch } from '../src/crm/watch.js';
import { createDecisionPort } from '../src/decision/registry.js';
import { MatchRepository } from '../src/match/repository.js';
import { MatchService } from '../src/match/match-service.js';
import { TemplateDraftWriter } from '../src/outreach/content.js';
import { OutreachRepository } from '../src/outreach/repository.js';
import { OutreachService } from '../src/outreach/outreach-service.js';
import { OfflineSearchProvider } from '../src/research/provider/offline.js';
import { ResearchRepository } from '../src/research/repository.js';
import { ResearchService } from '../src/research/research-service.js';
import { SalesRepository } from '../src/sales/repository.js';
import { SalesService } from '../src/sales/sales-service.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

/**
 * 2026-11-02 review P2-6: a malformed JSON body is a client error. Every
 * route that requires a JSON body must answer 400 VALIDATION_FAILED through
 * the shared readJsonBody helper instead of a generic 500.
 */
async function buildApp(options?: { apiToken?: string }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const cfg = loadConfig();
  const apiToken = options?.apiToken;

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
  const outreachService = new OutreachService({
    repo: new OutreachRepository(driver),
    leads: crmRepo,
    writer: new TemplateDraftWriter(),
    decision: createDecisionPort({ ...cfg, zeusMode: 'off' as const }),
    mail: { name: 'fake', online: true, send: async () => ({ messageId: 'msg_1' }) },
  });
  const salesService = new SalesService({ repo: new SalesRepository(driver) });
  const matchService = new MatchService({ repo: new MatchRepository(driver) });

  const app = new Hono();
  app.route('/', createResearchApp({ service: researchService, ...(apiToken ? { apiToken } : {}) }));
  app.route('/', createCrmApp({ service: leadService, ...(apiToken ? { apiToken } : {}) }));
  app.route('/', createLeadImportApp({ service: leadService, ...(apiToken ? { apiToken } : {}) }));
  app.route('/', createOutreachApp({ service: outreachService, ...(apiToken ? { apiToken } : {}) }));
  app.route('/', createSalesApp({ service: salesService, ...(apiToken ? { apiToken } : {}) }));
  app.route('/', createMatchApp({ service: matchService, ...(apiToken ? { apiToken } : {}) }));
  return app;
}

function postBadJson(app: Hono, path: string, token?: string) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: '{bad json',
  });
}

const ROUTES = [
  '/api/v1/research/topics',
  '/api/v1/research/run',
  '/api/v1/crm/contacts',
  '/api/v1/crm/leads',
  '/api/v1/crm/leads/promote',
  '/api/v1/crm/leads/lead_x/transition',
  '/api/v1/crm/leads/lead_x/contact',
  '/api/v1/crm/leads/lead_x/followups',
  '/api/v1/crm/imports/webhook',
  '/api/v1/outreach/campaigns',
  '/api/v1/outreach/suppress',
  '/api/v1/match/demands',
  '/api/v1/match/offers',
  '/api/v1/match/matches/match_x/contact',
  '/api/v1/sales/quotes',
  '/api/v1/sales/contracts',
  '/api/v1/sales/orders',
];

describe('malformed JSON request bodies (2026-11-02 review P2-6)', () => {
  it('every body-reading route answers 400 VALIDATION_FAILED, never 500', async () => {
    const app = await buildApp();
    for (const path of ROUTES) {
      const res = await postBadJson(app, path);
      const body = (await res.json()) as { code?: string };
      expect({ path, status: res.status, code: body.code }).toEqual({
        path,
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('still answers 400 behind the production Bearer guard', async () => {
    const app = await buildApp({ apiToken: 'main-token' });
    const res = await postBadJson(app, '/api/v1/sales/quotes', 'main-token');
    expect(res.status).toBe(400);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('valid bodies still parse (happy path guard)', async () => {
    const app = await buildApp();
    const res = await app.request('/api/v1/crm/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Jane', email: 'jane@acme.com' }),
    });
    expect(res.status).toBe(201);
  });
});
