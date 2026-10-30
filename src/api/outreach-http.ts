import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { GrowthError } from '../research/errors.js';
import type { OutreachService } from '../outreach/outreach-service.js';
import { growthOnError } from './on-error.js';
import { secureEqual } from '../util/hash.js';

export interface OutreachAppDeps {
  service: OutreachService;
  apiToken?: string | undefined;
  /** HMAC-SHA256 secret for signed bounce/reply receipt callbacks. */
  callbackSecret?: string | undefined;
}

const SIGNATURE_HEADER = 'X-Growth-Signature';

/**
 * Verify `X-Growth-Signature: v1=<hex HMAC-SHA256(secret, rawBody)>` against
 * the exact raw request bytes (Tier0 review 2026-10-30 P1). Hex digests are
 * compared in constant time via secureEqual.
 */
function verifyCallbackSignature(rawBody: ArrayBuffer, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('v1=')) return false;
  const expected = createHmac('sha256', secret).update(Buffer.from(rawBody)).digest('hex');
  return secureEqual(expected, header.slice(3));
}

/** Parse a signed callback body from raw bytes; invalid JSON fails closed. */
function parseCallbackBody(rawBody: ArrayBuffer): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
  } catch {
    throw new GrowthError('VALIDATION_FAILED', 'callback body must be valid JSON', 400);
  }
}

export function createOutreachApp(deps: OutreachAppDeps): Hono {
  const app = new Hono();

  app.use('/api/v1/*', async (c, next) => {
    if (deps.apiToken) {
      const header = c.req.header('Authorization') ?? '';
      if (!secureEqual(header, `Bearer ${deps.apiToken}`)) {
        return c.json({ code: 'UNAUTHORIZED', message: 'missing or invalid token', retryable: false }, 401);
      }
    }
    await next();
  });

  app.onError(growthOnError);

  // campaigns
  app.post('/api/v1/outreach/campaigns', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const leadIds = Array.isArray(body.leadIds) ? body.leadIds.map(String) : [];
    const result = await deps.service.createCampaign(
      {
        name: String(body.name ?? ''),
        ...(body.topicId !== undefined ? { topicId: String(body.topicId) } : {}),
      },
      leadIds,
    );
    return c.json(result, 201);
  });

  app.get('/api/v1/outreach/campaigns', async (c) => c.json(await deps.service.listCampaigns()));

  app.get('/api/v1/outreach/campaigns/:id', async (c) =>
    c.json(await deps.service.getCampaign(c.req.param('id'))),
  );

  app.get('/api/v1/outreach/campaigns/:id/drafts', async (c) =>
    c.json(await deps.service.listDrafts(c.req.param('id'))),
  );

  // draft lifecycle (zeus-gated)
  app.post('/api/v1/outreach/drafts/:id/submit', async (c) =>
    c.json(await deps.service.submitDraft(c.req.param('id'))),
  );

  app.post('/api/v1/outreach/drafts/:id/approval', async (c) =>
    c.json(await deps.service.checkApproval(c.req.param('id'))),
  );

  app.post('/api/v1/outreach/drafts/:id/send', async (c) =>
    c.json(await deps.service.sendDraft(c.req.param('id'))),
  );

  app.get('/api/v1/outreach/drafts/:id/events', async (c) =>
    c.json(await deps.service.listEvents(c.req.param('id'))),
  );

  // receipts (T-G3-05)
  app.post('/api/v1/outreach/suppress', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const email = String(body.email ?? '');
    if (!email) throw new GrowthError('VALIDATION_FAILED', 'email is required', 400);
    await deps.service.suppressEmail(email, body.reason !== undefined ? String(body.reason) : 'manual');
    return c.json({ ok: true });
  });

  app.get('/api/v1/outreach/suppressed', async (c) => c.json(await deps.service.listSuppressed()));

  // Signed receipt callbacks (Tier0 review 2026-10-30 P1): these routes can
  // mutate the suppress list and CRM, so each request must carry an
  // HMAC-SHA256 signature over the raw body bytes and an eventId that makes
  // processing idempotent. Without a configured secret they fail closed.
  app.post('/api/v1/outreach/receipts/bounce', async (c) => {
    if (!deps.callbackSecret) {
      return c.json(
        {
          code: 'UNAUTHORIZED',
          message: 'callback secret is not configured (GROWTH_OUTREACH_CALLBACK_SECRET); callbacks fail closed',
          retryable: false,
        },
        401,
      );
    }
    const rawBody = await c.req.arrayBuffer();
    if (!verifyCallbackSignature(rawBody, c.req.header(SIGNATURE_HEADER), deps.callbackSecret)) {
      return c.json({ code: 'UNAUTHORIZED', message: 'missing or invalid callback signature', retryable: false }, 401);
    }
    const body = parseCallbackBody(rawBody);
    const eventId = String(body.eventId ?? '');
    if (!eventId) throw new GrowthError('VALIDATION_FAILED', 'eventId is required', 400);
    const email = String(body.email ?? '');
    if (!email) throw new GrowthError('VALIDATION_FAILED', 'email is required', 400);
    await deps.service.recordBounceCallback(eventId, email);
    return c.json({ ok: true });
  });

  app.post('/api/v1/outreach/receipts/reply', async (c) => {
    if (!deps.callbackSecret) {
      return c.json(
        {
          code: 'UNAUTHORIZED',
          message: 'callback secret is not configured (GROWTH_OUTREACH_CALLBACK_SECRET); callbacks fail closed',
          retryable: false,
        },
        401,
      );
    }
    const rawBody = await c.req.arrayBuffer();
    if (!verifyCallbackSignature(rawBody, c.req.header(SIGNATURE_HEADER), deps.callbackSecret)) {
      return c.json({ code: 'UNAUTHORIZED', message: 'missing or invalid callback signature', retryable: false }, 401);
    }
    const body = parseCallbackBody(rawBody);
    const eventId = String(body.eventId ?? '');
    if (!eventId) throw new GrowthError('VALIDATION_FAILED', 'eventId is required', 400);
    const messageId = String(body.messageId ?? '');
    if (!messageId) throw new GrowthError('VALIDATION_FAILED', 'messageId is required', 400);
    const { followup } = await deps.service.recordReplyCallback(
      eventId,
      messageId,
      String(body.from ?? ''),
      String(body.text ?? ''),
    );
    return c.json(followup, 201);
  });

  return app;
}
