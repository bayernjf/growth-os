import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { GrowthError } from '../research/errors.js';
import type { OutreachService } from '../outreach/outreach-service.js';

export interface OutreachAppDeps {
  service: OutreachService;
  apiToken?: string | undefined;
}

export function createOutreachApp(deps: OutreachAppDeps): Hono {
  const app = new Hono();

  app.use('/api/v1/*', async (c, next) => {
    if (deps.apiToken) {
      const header = c.req.header('Authorization') ?? '';
      if (header !== `Bearer ${deps.apiToken}`) {
        return c.json({ code: 'UNAUTHORIZED', message: 'missing or invalid token', retryable: false }, 401);
      }
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof GrowthError) {
      return c.json(err.toBody(), err.status as ContentfulStatusCode);
    }
    return c.json(
      { code: 'INTERNAL', message: err instanceof Error ? err.message : 'unknown error', retryable: false },
      500,
    );
  });

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

  app.post('/api/v1/outreach/receipts/bounce', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const email = String(body.email ?? '');
    if (!email) throw new GrowthError('VALIDATION_FAILED', 'email is required', 400);
    await deps.service.recordBounce(email);
    return c.json({ ok: true });
  });

  app.post('/api/v1/outreach/receipts/reply', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const messageId = String(body.messageId ?? '');
    if (!messageId) throw new GrowthError('VALIDATION_FAILED', 'messageId is required', 400);
    const followup = await deps.service.recordReply(
      messageId,
      String(body.from ?? ''),
      String(body.text ?? ''),
    );
    return c.json(followup, 201);
  });

  return app;
}
