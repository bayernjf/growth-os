// sales-http.ts: /api/v1/sales/* surface (OP-14). Bearer auth mirrors crm-http;
// high-value quote sends can answer 202 with a pending decision.

import { Hono } from 'hono';
import { growthOnError } from './on-error.js';
import { secureEqual } from '../util/hash.js';
import type { SalesService } from '../sales/sales-service.js';

export interface SalesAppDeps {
  service: SalesService;
  apiToken?: string | undefined;
}

export function createSalesApp(deps: SalesAppDeps): Hono {
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

  // ---------- quotes ----------

  app.post('/api/v1/sales/quotes', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const leadId = typeof body.leadId === 'string' ? body.leadId : undefined;
    const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
    const quote = leadId
      ? await deps.service.createQuoteFromLead(leadId, lineItems as never)
      : await deps.service.createQuote({
          lineItems: lineItems as never,
          ...(typeof body.customerName === 'string' ? { customerName: body.customerName } : {}),
          ...(typeof body.customerEmail === 'string' ? { customerEmail: body.customerEmail } : {}),
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
        });
    return c.json(quote, 201);
  });

  app.get('/api/v1/sales/quotes', async (c) => c.json(await deps.service.listQuotes()));
  app.get('/api/v1/sales/quotes/:id', async (c) => c.json(await deps.service.getQuote(c.req.param('id'))));
  app.get('/api/v1/sales/quotes/:id/events', async (c) =>
    c.json(await deps.service.listQuoteEvents(c.req.param('id'))),
  );

  app.post('/api/v1/sales/quotes/:id/send', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    const result = await deps.service.sendQuote(c.req.param('id'), body.note ?? '');
    if ('pendingApproval' in result) {
      return c.json(result, 202);
    }
    return c.json(result, 200);
  });

  app.post('/api/v1/sales/quotes/:id/resolve-approval', async (c) =>
    c.json(await deps.service.resolveQuoteApproval(c.req.param('id')), 200),
  );
  app.post('/api/v1/sales/quotes/:id/accept', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(await deps.service.acceptQuote(c.req.param('id'), body.note ?? ''));
  });
  app.post('/api/v1/sales/quotes/:id/reject', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(await deps.service.rejectQuote(c.req.param('id'), body.note ?? ''));
  });

  // ---------- contracts ----------

  app.post('/api/v1/sales/contracts', async (c) => {
    const body = (await c.req.json()) as { quoteId?: string; terms?: Record<string, unknown>; note?: string };
    if (typeof body.quoteId !== 'string') {
      return c.json({ code: 'VALIDATION_FAILED', message: 'quoteId required', retryable: false }, 400);
    }
    return c.json(await deps.service.createContract(body.quoteId, body.terms ?? {}, body.note ?? ''), 201);
  });
  app.get('/api/v1/sales/contracts/:id', async (c) => c.json(await deps.service.getContract(c.req.param('id'))));
  app.post('/api/v1/sales/contracts/:id/send', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(await deps.service.sendContract(c.req.param('id'), body.note ?? ''));
  });
  app.post('/api/v1/sales/contracts/:id/sign', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(await deps.service.signContract(c.req.param('id'), body.note ?? ''));
  });

  // ---------- orders ----------

  app.post('/api/v1/sales/orders', async (c) => {
    const body = (await c.req.json()) as { contractId?: string; note?: string };
    if (typeof body.contractId !== 'string') {
      return c.json({ code: 'VALIDATION_FAILED', message: 'contractId required', retryable: false }, 400);
    }
    return c.json(await deps.service.createOrder(body.contractId, body.note ?? ''), 201);
  });
  app.get('/api/v1/sales/orders', async (c) => c.json(await deps.service.listOrders()));
  app.get('/api/v1/sales/orders/:id', async (c) => c.json(await deps.service.getOrder(c.req.param('id'))));

  return app;
}
