import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createOutreachApp } from '../src/api/outreach-http.js';
import { CrmRepository } from '../src/crm/repository.js';
import { createDecisionPort } from '../src/decision/registry.js';
import { TemplateDraftWriter } from '../src/outreach/content.js';
import { OutreachRepository } from '../src/outreach/repository.js';
import { OutreachService } from '../src/outreach/outreach-service.js';
import { loadConfig } from '../src/config.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const SECRET = 'callback-secret';

function sign(body: string): string {
  return `v1=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

async function buildApp(options?: { callbackSecret?: string }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const crmRepo = new CrmRepository(driver);
  const outreachRepo = new OutreachRepository(driver);
  const service = new OutreachService({
    repo: outreachRepo,
    leads: crmRepo,
    writer: new TemplateDraftWriter(),
    decision: createDecisionPort({ ...loadConfig(), zeusMode: 'off' as const }),
    mail: { name: 'fake', online: true, send: async () => ({ messageId: 'msg_1' }) },
  });
  const app = new Hono();
  app.route(
    '/',
    createOutreachApp({
      service,
      ...(options?.callbackSecret ? { callbackSecret: options.callbackSecret } : {}),
    }),
  );
  return { app, crmRepo, outreachRepo, service };
}

describe('signed receipt callbacks (Tier0 review P1)', () => {
  it('fails closed when no callback secret is configured', async () => {
    const { app, outreachRepo } = await buildApp();
    const body = JSON.stringify({ eventId: 'evt_1', email: 'jane@acme.com' });
    const res = await app.request('/api/v1/outreach/receipts/bounce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Growth-Signature': sign(body) },
      body,
    });
    expect(res.status).toBe(401);
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('rejects a bounce without a valid signature', async () => {
    const { app, outreachRepo } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ eventId: 'evt_1', email: 'jane@acme.com' });
    const noSig = await app.request('/api/v1/outreach/receipts/bounce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(noSig.status).toBe(401);
    const badSig = await app.request('/api/v1/outreach/receipts/bounce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Growth-Signature': 'v1=deadbeef' },
      body,
    });
    expect(badSig.status).toBe(401);
    const wrongKey = await app.request('/api/v1/outreach/receipts/bounce', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Growth-Signature': `v1=${createHmac('sha256', 'other-secret').update(body).digest('hex')}`,
      },
      body,
    });
    expect(wrongKey.status).toBe(401);
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('suppresses a signed bounce and replays the first result by eventId', async () => {
    const { app, outreachRepo } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ eventId: 'evt_b1', email: 'jane@acme.com' });
    const headers = { 'Content-Type': 'application/json', 'X-Growth-Signature': sign(body) };

    const first = await app.request('/api/v1/outreach/receipts/bounce', { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    // Replay with the same eventId: same result, no duplicate suppression work.
    const replay = await app.request('/api/v1/outreach/receipts/bounce', { method: 'POST', headers, body });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true });
    expect(await outreachRepo.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'bounce', createdAt: expect.any(String) },
    ]);
  });

  it('requires eventId on signed callbacks', async () => {
    const { app, outreachRepo } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ email: 'jane@acme.com' });
    const res = await app.request('/api/v1/outreach/receipts/bounce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Growth-Signature': sign(body) },
      body,
    });
    expect(res.status).toBe(400);
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('reflows a signed reply into one followup and replays it by eventId', async () => {
    const { app, crmRepo, outreachRepo, service } = await buildApp({ callbackSecret: SECRET });
    const contact = await crmRepo.createContact({ name: 'Jane Doe', email: 'jane@acme.com' });
    const lead = await crmRepo.createLead({ title: 'AI outreach', contactId: contact.id });
    const { drafts } = await service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    // Seed the sent messageId directly: recordReply resolves the lead via the
    // draft's messageId, mirroring a delivered campaign.
    await outreachRepo.markSent(draft.id, 'msg_1', new Date().toISOString());

    const body = JSON.stringify({
      eventId: 'evt_r1',
      messageId: 'msg_1',
      from: 'jane@acme.com',
      text: 'Interested, call me.',
    });
    const headers = { 'Content-Type': 'application/json', 'X-Growth-Signature': sign(body) };

    const first = await app.request('/api/v1/outreach/receipts/reply', { method: 'POST', headers, body });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; leadId: string; action: string };
    expect(firstBody).toMatchObject({ leadId: lead.id, action: 'reply' });

    const replay = await app.request('/api/v1/outreach/receipts/reply', { method: 'POST', headers, body });
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as { id: string };
    expect(replayBody).toEqual(firstBody);

    const followups = await crmRepo.listFollowups(lead.id);
    expect(followups).toHaveLength(1);
    expect(followups[0]?.id).toBe(firstBody.id);
  });

  it('fails closed on a signed reply for an unknown messageId', async () => {
    const { app } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ eventId: 'evt_x', messageId: 'unknown', from: 'x@y.com', text: 'hi' });
    const res = await app.request('/api/v1/outreach/receipts/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Growth-Signature': sign(body) },
      body,
    });
    expect(res.status).toBe(404);
  });
});
