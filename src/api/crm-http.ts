import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { GrowthError } from '../research/errors.js';
import type { LeadService } from '../crm/lead-service.js';
import type { LeadStatus } from '../crm/types.js';

export interface CrmAppDeps {
  service: LeadService;
  apiToken?: string | undefined;
}

export function createCrmApp(deps: CrmAppDeps): Hono {
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

  // contacts
  app.post('/api/v1/crm/contacts', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const contact = await deps.service.createContact({
      name: String(body.name ?? ''),
      ...(body.company !== undefined ? { company: String(body.company) } : {}),
      ...(body.email !== undefined ? { email: String(body.email) } : {}),
      ...(body.title !== undefined ? { title: String(body.title) } : {}),
      ...(body.sourceType !== undefined ? { sourceType: String(body.sourceType) as never } : {}),
      ...(Array.isArray(body.sourceRefs) ? { sourceRefs: body.sourceRefs.map(String) } : {}),
    });
    return c.json(contact, 201);
  });

  app.get('/api/v1/crm/contacts', async (c) => c.json(await deps.service.listContacts()));
  app.get('/api/v1/crm/contacts/:id', async (c) =>
    c.json(await deps.service.getContact(c.req.param('id'))),
  );

  // leads
  app.post('/api/v1/crm/leads', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const lead = await deps.service.createLead({
      title: String(body.title ?? ''),
      ...(body.sourceType !== undefined ? { sourceType: String(body.sourceType) as never } : {}),
      ...(body.sourceSignalId !== undefined ? { sourceSignalId: String(body.sourceSignalId) } : {}),
      ...(body.contactId !== undefined ? { contactId: String(body.contactId) } : {}),
      ...(body.summary !== undefined ? { summary: String(body.summary) } : {}),
      ...(body.score !== undefined ? { score: Number(body.score) } : {}),
    });
    return c.json(lead, 201);
  });

  app.get('/api/v1/crm/leads', async (c) => {
    const status = c.req.query('status');
    return c.json(await deps.service.listLeads(status as LeadStatus | undefined));
  });

  // promote high-intent signals -> leads (idempotent)
  app.post('/api/v1/crm/leads/promote', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const topicId = String(body.topicId ?? '');
    if (!topicId) throw new GrowthError('VALIDATION_FAILED', 'topicId is required', 400);
    return c.json(await deps.service.promoteSignalsToLeads(topicId));
  });

  app.get('/api/v1/crm/leads/:id', async (c) =>
    c.json(await deps.service.getLead(c.req.param('id'))),
  );

  app.post('/api/v1/crm/leads/:id/transition', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const status = String(body.status ?? '');
    return c.json(
      await deps.service.transitionLead(
        c.req.param('id'),
        status as LeadStatus,
        body.note !== undefined ? String(body.note) : '',
      ),
    );
  });

  app.post('/api/v1/crm/leads/:id/contact', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const contactId = String(body.contactId ?? '');
    if (!contactId) throw new GrowthError('VALIDATION_FAILED', 'contactId is required', 400);
    return c.json(await deps.service.attachContact(c.req.param('id'), contactId));
  });

  app.get('/api/v1/crm/leads/:id/events', async (c) =>
    c.json(await deps.service.listLeadEvents(c.req.param('id'))),
  );

  app.post('/api/v1/crm/leads/:id/followups', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const followup = await deps.service.addFollowup(c.req.param('id'), {
      action: String(body.action ?? ''),
      ...(body.note !== undefined ? { note: String(body.note) } : {}),
      ...(Array.isArray(body.sourceSignalIds) ? { sourceSignalIds: body.sourceSignalIds.map(String) } : {}),
      ...(body.dueAt !== undefined ? { dueAt: String(body.dueAt) } : {}),
    });
    return c.json(followup, 201);
  });

  app.get('/api/v1/crm/leads/:id/followups', async (c) =>
    c.json(await deps.service.listFollowups(c.req.param('id'))),
  );

  app.post('/api/v1/crm/followups/:id/complete', async (c) => {
    await deps.service.completeFollowup(c.req.param('id'));
    return c.json({ ok: true });
  });

  // watch tick (stub): due followups
  app.get('/api/v1/crm/watch/due', async (c) => c.json(await deps.service.listDueFollowups()));

  return app;
}
