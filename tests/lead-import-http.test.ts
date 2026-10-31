import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createLeadImportApp } from '../src/api/lead-import-http.js';
import { CrmRepository } from '../src/crm/repository.js';
import { LeadService } from '../src/crm/lead-service.js';
import { LocalWatch } from '../src/crm/watch.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';

async function buildApp(options?: { apiToken?: string }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const crmRepo = new CrmRepository(driver);
  const leadService = new LeadService({
    repo: crmRepo,
    signals: { listSignals: async () => [] },
    watch: new LocalWatch(crmRepo),
  });
  const app = new Hono();
  app.route(
    '/',
    createLeadImportApp({ service: leadService, ...(options?.apiToken ? { apiToken: options.apiToken } : {}) }),
  );
  return { app, leadService };
}

describe('lead import HTTP API', () => {
  it('accepts a webhook payload and records the source origin', async () => {
    const { app } = await buildApp();
    const res = await app.request('/api/v1/crm/imports/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Source-Name': 'webhook:rfq-form' },
      body: JSON.stringify({ title: 'RFQ inbound', body: 'details', email: 'b@x.com' }),
    });
    expect(res.status).toBe(201);
    const lead = (await res.json()) as Record<string, unknown>;
    expect(lead).toMatchObject({ status: 'new', sourceType: 'import', sourceRef: 'webhook:rfq-form' });
  });

  it('falls back to body.source then "webhook" for the source ref', async () => {
    const { app } = await buildApp();
    const withBody = await app.request('/api/v1/crm/imports/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', source: 'external-system' }),
    });
    expect((await withBody.json()) as Record<string, unknown>).toMatchObject({ sourceRef: 'external-system' });

    const defaulted = await app.request('/api/v1/crm/imports/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T2' }),
    });
    expect((await defaulted.json()) as Record<string, unknown>).toMatchObject({ sourceRef: 'webhook' });
  });

  it('returns 400 for malformed JSON and for a missing title', async () => {
    const { app } = await buildApp();
    const malformed = await app.request('/api/v1/crm/imports/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{',
    });
    expect(malformed.status).toBe(400);

    const noTitle = await app.request('/api/v1/crm/imports/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'no title' }),
    });
    expect(noTitle.status).toBe(400);
  });

  it('imports CSV rows and reports the count', async () => {
    const { app } = await buildApp();
    const csv = 'title,contact_email,score\nLead A,a@x.com,70\nLead B,b@y.com,20';
    const res = await app.request('/api/v1/crm/imports/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', 'X-Source-Name': 'csv:upload-1' },
      body: csv,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ imported: 2, sourceRef: 'csv:upload-1' });
    expect((body.leads as unknown[])).toHaveLength(2);
  });

  it('returns imported 0 for an empty CSV', async () => {
    const { app } = await buildApp();
    const res = await app.request('/api/v1/crm/imports/csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: '',
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ imported: 0 });
  });

  it('rejects requests without a valid bearer token when token is configured', async () => {
    const { app } = await buildApp({ apiToken: 'secret-token' });
    const denied = await app.request('/api/v1/crm/imports/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T' }),
    });
    expect(denied.status).toBe(401);

    const allowed = await app.request('/api/v1/crm/imports/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
      body: JSON.stringify({ title: 'T' }),
    });
    expect(allowed.status).toBe(201);
  });
});
