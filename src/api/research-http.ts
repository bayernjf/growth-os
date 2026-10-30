import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { GrowthError } from '../research/errors.js';
import type { ResearchService } from '../research/research-service.js';
import type { SignalType } from '../research/types.js';
import { secureEqual } from '../util/hash.js';

export interface ResearchAppDeps {
  service: ResearchService;
  apiToken?: string | undefined;
}

export function createResearchApp(deps: ResearchAppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/api/v1/*', async (c, next) => {
    if (deps.apiToken) {
      const header = c.req.header('Authorization') ?? '';
      if (!secureEqual(header, `Bearer ${deps.apiToken}`)) {
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

  // topics
  app.post('/api/v1/research/topics', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const topic = await deps.service.createTopic({
      title: String(body.title ?? ''),
      ...(body.description ? { description: String(body.description) } : {}),
      keywords: Array.isArray(body.keywords) ? body.keywords.map(String) : [],
      ...(Array.isArray(body.signalTypes)
        ? { signalTypes: body.signalTypes.map(String) as SignalType[] }
        : {}),
      ...(body.language ? { language: String(body.language) } : {}),
    });
    return c.json(topic, 201);
  });

  app.get('/api/v1/research/topics', async (c) => c.json(await deps.service.listTopics()));
  app.get('/api/v1/research/topics/:id', async (c) =>
    c.json(await deps.service.getTopic(c.req.param('id'))),
  );

  // run
  app.post('/api/v1/research/run', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const topicId = String(body.topicId ?? '');
    if (!topicId) throw new GrowthError('VALIDATION_FAILED', 'topicId is required', 400);
    return c.json(await deps.service.run(topicId));
  });

  // signals
  app.get('/api/v1/research/signals', async (c) => {
    const topicId = c.req.query('topicId');
    if (!topicId) throw new GrowthError('VALIDATION_FAILED', 'topicId query is required', 400);
    return c.json(await deps.service.listSignals(topicId));
  });

  // insights review
  app.post('/api/v1/research/insights/:id/review', async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const action = body.action === 'confirm' || body.action === 'reject' ? body.action : undefined;
    if (!action) throw new GrowthError('VALIDATION_FAILED', "action must be 'confirm' or 'reject'", 400);
    return c.json(await deps.service.reviewInsight(c.req.param('id'), action));
  });

  // reports
  app.get('/api/v1/research/reports/:id', async (c) =>
    c.json(await deps.service.getReport(c.req.param('id'))),
  );

  return app;
}
