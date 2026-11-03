import { Hono } from 'hono';
import type { LeadService } from '../crm/lead-service.js';
import { csvToImportInputs, parseCsv, webhookToImportInput } from '../crm/lead-import.js';
import { growthOnError } from './on-error.js';
import { readJsonBody } from './read-json.js';
import { secureEqual } from '../util/hash.js';

export interface LeadImportAppDeps {
  service: LeadService;
  apiToken?: string | undefined;
}

export function createLeadImportApp(deps: LeadImportAppDeps): Hono {
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

  // Generic webhook intake: vendor-neutral external inbox. The source origin
  // is taken from X-Source-Name, then body.source, defaulting to "webhook".
  app.post('/api/v1/crm/imports/webhook', async (c) => {
    const body = await readJsonBody(c);
    const headerSource = c.req.header('X-Source-Name');
    const sourceRef =
      headerSource ?? (body.source !== undefined ? String(body.source) : 'webhook');
    const input = webhookToImportInput(body, sourceRef);
    const lead = await deps.service.importLead(input);
    return c.json(lead, 201);
  });

  // CSV batch intake: rows are parsed then imported atomically in one tx.
  app.post('/api/v1/crm/imports/csv', async (c) => {
    const text = await c.req.text();
    const headerSource = c.req.header('X-Source-Name');
    const sourceRef = headerSource ?? `csv:${new Date().toISOString()}`;
    const inputs = csvToImportInputs(parseCsv(text), sourceRef);
    const leads = await deps.service.importLeadsBatch(inputs);
    return c.json({ imported: leads.length, sourceRef, leads }, 201);
  });

  return app;
}
