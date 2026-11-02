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
import { signUnsubscribeToken } from '../src/mail/unsubscribe-token.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const SECRET = 'callback-secret';
const BOUNCE_URL = '/pub/v1/outreach/receipts/bounce';
const REPLY_URL = '/pub/v1/outreach/receipts/reply';

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Signature v2: HMAC over "<unixSeconds>.<rawBody>" (2026-11-02 review P1-1). */
function sign(body: string, timestamp: string, secret: string = SECRET): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

function signedHeaders(body: string, timestamp: string = nowSeconds()): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Growth-Timestamp': timestamp,
    'X-Growth-Signature': sign(body, timestamp),
  };
}

async function buildApp(options?: { apiToken?: string; callbackSecret?: string; unsubscribeSecret?: string }) {
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
      ...(options?.apiToken ? { apiToken: options.apiToken } : {}),
      ...(options?.callbackSecret ? { callbackSecret: options.callbackSecret } : {}),
      ...(options?.unsubscribeSecret ? { unsubscribeSecret: options.unsubscribeSecret } : {}),
    }),
  );
  return { app, crmRepo, outreachRepo, service };
}

describe('signed receipt callbacks (2026-11-02 review P1-1)', () => {
  it('accepts a signed callback without a Bearer token in production posture', async () => {
    // The exact production combination from the review: apiToken is set (so
    // the /api/v1 Bearer guard is active) and the ESP webhook carries only
    // its signature. The old code returned 401 here.
    const { app, outreachRepo } = await buildApp({ apiToken: 'main-token', callbackSecret: SECRET });
    const guarded = await app.request('/api/v1/outreach/campaigns', { method: 'GET' });
    expect(guarded.status).toBe(401);

    const body = JSON.stringify({ eventId: 'evt_p1', email: 'jane@acme.com' });
    const res = await app.request(BOUNCE_URL, { method: 'POST', headers: signedHeaders(body), body });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await outreachRepo.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'bounce', createdAt: expect.any(String) },
    ]);
  });

  it('no longer serves the callbacks under the Bearer-guarded /api/v1 prefix', async () => {
    const { app } = await buildApp({ apiToken: 'main-token', callbackSecret: SECRET });
    const body = JSON.stringify({ eventId: 'evt_gone', email: 'jane@acme.com' });
    const res = await app.request('/api/v1/outreach/receipts/bounce', {
      method: 'POST',
      headers: { ...signedHeaders(body), Authorization: 'Bearer main-token' },
      body,
    });
    expect(res.status).toBe(404);
  });

  it('fails closed when no callback secret is configured', async () => {
    const { app, outreachRepo } = await buildApp();
    const body = JSON.stringify({ eventId: 'evt_1', email: 'jane@acme.com' });
    const res = await app.request(BOUNCE_URL, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(401);
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('rejects a bounce without a valid signature', async () => {
    const { app, outreachRepo } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ eventId: 'evt_1', email: 'jane@acme.com' });
    const ts = nowSeconds();
    const noSig = await app.request(BOUNCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Growth-Timestamp': ts },
      body,
    });
    expect(noSig.status).toBe(401);
    const badSig = await app.request(BOUNCE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Growth-Timestamp': ts, 'X-Growth-Signature': 'v1=deadbeef' },
      body,
    });
    expect(badSig.status).toBe(401);
    const wrongKey = await app.request(BOUNCE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Growth-Timestamp': ts,
        'X-Growth-Signature': sign(body, ts, 'other-secret'),
      },
      body,
    });
    expect(wrongKey.status).toBe(401);
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('rejects stale, future and malformed timestamps even with a matching signature', async () => {
    const { app, outreachRepo } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ eventId: 'evt_t', email: 'jane@acme.com' });
    const now = Math.floor(Date.now() / 1000);
    for (const ts of [String(now - 301), String(now + 301), 'not-a-number']) {
      const res = await app.request(BOUNCE_URL, {
        method: 'POST',
        headers: signedHeaders(body, ts),
        body,
      });
      expect(res.status).toBe(401);
    }
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('rejects an exact signature replay but stays idempotent for a re-signed retry', async () => {
    const { app, outreachRepo } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ eventId: 'evt_b1', email: 'jane@acme.com' });
    const headers = signedHeaders(body);

    const first = await app.request(BOUNCE_URL, { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    // Byte-identical replay (captured request resent as-is): rejected.
    const replay = await app.request(BOUNCE_URL, { method: 'POST', headers, body });
    expect(replay.status).toBe(401);

    // ESP retry re-signs with a fresh timestamp: same eventId replays the
    // first result without duplicating suppression work.
    const retry = await app.request(BOUNCE_URL, {
      method: 'POST',
      headers: signedHeaders(body, String(Math.floor(Date.now() / 1000) + 1)),
      body,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    expect(await outreachRepo.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'bounce', createdAt: expect.any(String) },
    ]);
  });

  it('requires eventId on signed callbacks', async () => {
    const { app, outreachRepo } = await buildApp({ callbackSecret: SECRET });
    const body = JSON.stringify({ email: 'jane@acme.com' });
    const res = await app.request(BOUNCE_URL, {
      method: 'POST',
      headers: signedHeaders(body),
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

    const first = await app.request(REPLY_URL, { method: 'POST', headers: signedHeaders(body), body });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; leadId: string; action: string };
    expect(firstBody).toMatchObject({ leadId: lead.id, action: 'reply' });

    const replay = await app.request(REPLY_URL, {
      method: 'POST',
      headers: signedHeaders(body, String(Math.floor(Date.now() / 1000) + 1)),
      body,
    });
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
    const res = await app.request(REPLY_URL, {
      method: 'POST',
      headers: signedHeaders(body),
      body,
    });
    expect(res.status).toBe(404);
  });
});

describe('multilingual campaign locale (T-G3-07)', () => {
  it('accepts a valid locale and rejects unknown ones', async () => {
    const { app, crmRepo } = await buildApp();
    const contact = await crmRepo.createContact({ name: 'Jane Doe', email: 'jane@acme.com' });
    const lead = await crmRepo.createLead({ title: 'AI outreach', contactId: contact.id });

    const ok = await app.request('/api/v1/outreach/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'zh intro', leadIds: [lead.id], locale: 'zh' }),
    });
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { drafts: Array<{ locale: string }> };
    expect(okBody.drafts[0]?.locale).toBe('zh');

    const bad = await app.request('/api/v1/outreach/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'fr intro', leadIds: [lead.id], locale: 'fr' }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('one-click unsubscribe endpoint (T-G3-07)', () => {
  it('fails closed without a configured secret', async () => {
    const { app, outreachRepo } = await buildApp();
    const res = await app.request('/pub/v1/outreach/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'anything' }),
    });
    expect(res.status).toBe(422);
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('suppresses the address bound to a valid token, idempotently', async () => {
    const { app, outreachRepo } = await buildApp({ unsubscribeSecret: SECRET });
    const token = signUnsubscribeToken('jane@acme.com', SECRET);
    const body = JSON.stringify({ token });
    const headers = { 'Content-Type': 'application/json' };

    const first = await app.request('/pub/v1/outreach/unsubscribe', { method: 'POST', headers, body });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    const again = await app.request('/pub/v1/outreach/unsubscribe', { method: 'POST', headers, body });
    expect(again.status).toBe(200);
    expect(await outreachRepo.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'unsubscribe', createdAt: expect.any(String) },
    ]);
  });

  it('rejects an invalid or tampered token without suppressing anything', async () => {
    const { app, outreachRepo } = await buildApp({ unsubscribeSecret: SECRET });
    const token = signUnsubscribeToken('jane@acme.com', SECRET);
    const tampered = `${token.split('.')[0] ?? ''}.deadbeef`;
    const res = await app.request('/pub/v1/outreach/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tampered }),
    });
    expect(res.status).toBe(400);
    expect(await outreachRepo.listSuppressed()).toEqual([]);
  });

  it('is public: no bearer token is required under /pub/v1', async () => {
    const { app } = await buildApp({ unsubscribeSecret: SECRET });
    const token = signUnsubscribeToken('jane@acme.com', SECRET);
    const res = await app.request('/pub/v1/outreach/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
  });
});
