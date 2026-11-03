import { createHmac } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { GrowthError } from '../research/errors.js';
import type { OutreachService } from '../outreach/outreach-service.js';
import { isEmailLocale } from '../mail/templates.js';
import { verifyUnsubscribeToken } from '../mail/unsubscribe-token.js';
import { growthOnError } from './on-error.js';
import { readJsonBody } from './read-json.js';
import { secureEqual } from '../util/hash.js';

export interface OutreachAppDeps {
  service: OutreachService;
  apiToken?: string | undefined;
  /** HMAC-SHA256 secret for signed bounce/reply receipt callbacks. */
  callbackSecret?: string | undefined;
  /** HMAC secret for one-click unsubscribe tokens (T-G3-07); unset fails closed. */
  unsubscribeSecret?: string | undefined;
}

const SIGNATURE_HEADER = 'X-Growth-Signature';
const TIMESTAMP_HEADER = 'X-Growth-Timestamp';

/** Max accepted clock skew for callback timestamps (±5 minutes). */
const CALLBACK_TIMESTAMP_TOLERANCE_MS = 300_000;
/** Bound the in-memory replay cache; expired entries are pruned lazily. */
const REPLAY_CACHE_LIMIT = 1024;

/**
 * A callback timestamp is a unix-seconds string within the tolerance window
 * around now. Anything malformed, stale or too far in the future is rejected
 * so a captured signature cannot be replayed outside its validity window.
 */
export function isFreshCallbackTimestamp(timestamp: string | undefined, nowMs: number): timestamp is string {
  if (!timestamp || !/^\d{1,13}$/.test(timestamp)) return false;
  const tsMs = Number(timestamp) * 1000;
  return Number.isFinite(tsMs) && Math.abs(nowMs - tsMs) <= CALLBACK_TIMESTAMP_TOLERANCE_MS;
}

/**
 * Signature scheme v2 (2026-11-02 review P1-1): `X-Growth-Signature:
 * v1=<hex HMAC-SHA256(secret, "<unixSeconds>.<rawBody>")>` over the exact raw
 * request bytes, compared in constant time via secureEqual. Binding the
 * timestamp into the HMAC makes a captured pair expire with the timestamp.
 */
function verifyCallbackSignature(rawBody: ArrayBuffer, timestamp: string, header: string | undefined, secret: string): boolean {
  if (!header || !header.startsWith('v1=')) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(Buffer.from(rawBody))
    .digest('hex');
  return secureEqual(expected, header.slice(3));
}

/**
 * Returns true when this signature was already accepted and is still inside
 * its validity window; otherwise records it. Exact-signature replays are
 * rejected, while an ESP retry that re-signs with a fresh timestamp passes
 * and is then deduplicated by the eventId idempotency below.
 */
function checkAndMarkSignature(cache: Map<string, number>, key: string, nowMs: number): boolean {
  if (cache.size >= REPLAY_CACHE_LIMIT) {
    for (const [k, expiresAt] of cache) {
      if (expiresAt <= nowMs) cache.delete(k);
    }
  }
  const expiresAt = cache.get(key);
  if (expiresAt !== undefined && expiresAt > nowMs) return true;
  cache.set(key, nowMs + CALLBACK_TIMESTAMP_TOLERANCE_MS);
  return false;
}

type CallbackGate = (c: Context) => Promise<{ rawBody: ArrayBuffer } | Response>;

/**
 * Build the shared authentication gate for receipt callbacks. The gate is the
 * only credential on these public routes (no Bearer token, 2026-11-02 review
 * P1-1): it fails closed when no secret is configured, enforces a fresh
 * timestamp, verifies the HMAC in constant time and rejects replayed
 * signatures. The replay cache lives in this closure so each app instance
 * gets its own (tests stay isolated).
 */
function createCallbackGate(secret: string | undefined): CallbackGate {
  const seenSignatures = new Map<string, number>();
  return async (c) => {
    if (!secret) {
      return c.json(
        {
          code: 'UNAUTHORIZED',
          message: 'callback secret is not configured (GROWTH_OUTREACH_CALLBACK_SECRET); callbacks fail closed',
          retryable: false,
        },
        401,
      );
    }
    const unauthorized = (message: string) =>
      c.json({ code: 'UNAUTHORIZED', message, retryable: false }, 401);
    const rawBody = await c.req.arrayBuffer();
    const timestamp = c.req.header(TIMESTAMP_HEADER);
    if (!isFreshCallbackTimestamp(timestamp, Date.now())) {
      return unauthorized('missing or stale callback timestamp');
    }
    const signature = c.req.header(SIGNATURE_HEADER);
    if (!signature || !verifyCallbackSignature(rawBody, timestamp, signature, secret)) {
      return unauthorized('missing or invalid callback signature');
    }
    if (checkAndMarkSignature(seenSignatures, signature, Date.now())) {
      return unauthorized('replayed callback signature');
    }
    return { rawBody };
  };
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
  const callbackGate = createCallbackGate(deps.callbackSecret);

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
    const body = await readJsonBody(c);
    const leadIds = Array.isArray(body.leadIds) ? body.leadIds.map(String) : [];
    let locale: 'en' | 'zh' | undefined;
    if (body.locale !== undefined) {
      if (!isEmailLocale(body.locale)) {
        throw new GrowthError('VALIDATION_FAILED', 'locale must be one of en, zh', 400);
      }
      locale = body.locale;
    }
    const result = await deps.service.createCampaign(
      {
        name: String(body.name ?? ''),
        ...(body.topicId !== undefined ? { topicId: String(body.topicId) } : {}),
        ...(locale ? { locale } : {}),
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
    const body = await readJsonBody(c);
    const email = String(body.email ?? '');
    if (!email) throw new GrowthError('VALIDATION_FAILED', 'email is required', 400);
    await deps.service.suppressEmail(email, body.reason !== undefined ? String(body.reason) : 'manual');
    return c.json({ ok: true });
  });

  app.get('/api/v1/outreach/suppressed', async (c) => c.json(await deps.service.listSuppressed()));

  // Signed receipt callbacks (Tier0 review 2026-10-30 P1, moved 2026-11-02
  // review P1-1): ESP webhooks cannot send a Bearer token, so these routes
  // live under /pub/v1 outside the Bearer middleware and authenticate via the
  // callback gate alone — timestamp-bound HMAC signature over the raw body,
  // constant-time comparison, exact-signature replay rejection and an
  // eventId that makes ESP retries idempotent. Without a configured secret
  // they fail closed.
  app.post('/pub/v1/outreach/receipts/bounce', async (c) => {
    const gated = await callbackGate(c);
    if (gated instanceof Response) return gated;
    const body = parseCallbackBody(gated.rawBody);
    const eventId = String(body.eventId ?? '');
    if (!eventId) throw new GrowthError('VALIDATION_FAILED', 'eventId is required', 400);
    const email = String(body.email ?? '');
    if (!email) throw new GrowthError('VALIDATION_FAILED', 'email is required', 400);
    await deps.service.recordBounceCallback(eventId, email);
    return c.json({ ok: true });
  });

  app.post('/pub/v1/outreach/receipts/reply', async (c) => {
    const gated = await callbackGate(c);
    if (gated instanceof Response) return gated;
    const body = parseCallbackBody(gated.rawBody);
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

  // One-click unsubscribe (T-G3-07, design §14.2.1). Public on purpose: the
  // link inside sent emails must work without a Bearer token. The token binds
  // the recipient email with an HMAC, so this endpoint cannot suppress
  // arbitrary addresses. Without a configured secret it fails closed.
  app.post('/pub/v1/outreach/unsubscribe', async (c) => {
    if (!deps.unsubscribeSecret) {
      return c.json(
        {
          code: 'CREDENTIAL_MISSING',
          message: 'unsubscribe secret is not configured (GROWTH_MAIL_UNSUBSCRIBE_SECRET); fail closed',
          retryable: false,
        },
        422,
      );
    }
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const token = String(body?.token ?? '');
    if (!token) throw new GrowthError('VALIDATION_FAILED', 'token is required', 400);
    const email = verifyUnsubscribeToken(token, deps.unsubscribeSecret);
    if (!email) throw new GrowthError('VALIDATION_FAILED', 'invalid unsubscribe token', 400);
    await deps.service.suppressEmail(email, 'unsubscribe');
    return c.json({ ok: true });
  });

  return app;
}
