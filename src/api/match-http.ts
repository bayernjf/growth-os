import { Hono } from 'hono';
import type { MatchService } from '../match/match-service.js';
import { growthOnError } from './on-error.js';
import { readJsonBody } from './read-json.js';
import { secureEqual } from '../util/hash.js';

export interface MatchAppDeps {
  service: MatchService;
  apiToken?: string | undefined;
}

export function createMatchApp(deps: MatchAppDeps): Hono {
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

  // buyer demands
  app.post('/api/v1/match/demands', async (c) => {
    const body = await readJsonBody(c);
    const demand = await deps.service.createDemand({
      title: String(body.title ?? ''),
      category: String(body.category ?? ''),
      ...(body.quantity !== undefined ? { quantity: String(body.quantity) } : {}),
      ...(body.priceMin !== undefined ? { priceMin: Number(body.priceMin) } : {}),
      ...(body.priceMax !== undefined ? { priceMax: Number(body.priceMax) } : {}),
      ...(body.currency !== undefined ? { currency: String(body.currency) } : {}),
      ...(body.deadline !== undefined ? { deadline: String(body.deadline) } : {}),
      ...(body.region !== undefined ? { region: String(body.region) } : {}),
      ...(body.email !== undefined ? { email: String(body.email) } : {}),
      ...(body.description !== undefined ? { description: String(body.description) } : {}),
    });
    return c.json(demand, 201);
  });

  app.get('/api/v1/match/demands', async (c) => c.json(await deps.service.listDemands()));

  // supplier offers
  app.post('/api/v1/match/offers', async (c) => {
    const body = await readJsonBody(c);
    const offer = await deps.service.createOffer({
      title: String(body.title ?? ''),
      category: String(body.category ?? ''),
      ...(body.capacity !== undefined ? { capacity: String(body.capacity) } : {}),
      ...(body.price !== undefined ? { price: Number(body.price) } : {}),
      ...(body.currency !== undefined ? { currency: String(body.currency) } : {}),
      ...(body.moq !== undefined ? { moq: Number(body.moq) } : {}),
      ...(body.region !== undefined ? { region: String(body.region) } : {}),
      ...(body.email !== undefined ? { email: String(body.email) } : {}),
      ...(body.credentials !== undefined ? { credentials: String(body.credentials) } : {}),
      ...(body.description !== undefined ? { description: String(body.description) } : {}),
    });
    return c.json(offer, 201);
  });

  app.get('/api/v1/match/offers', async (c) => c.json(await deps.service.listOffers()));

  // run matching
  app.post('/api/v1/match/run', async (c) => c.json(await deps.service.runMatch()));

  app.get('/api/v1/match/matches', async (c) => c.json(await deps.service.listMatches()));

  app.get('/api/v1/match/matches/:id/introduction', async (c) =>
    c.json(await deps.service.buildIntroduction(c.req.param('id'))),
  );

  app.post('/api/v1/match/matches/:id/contact', async (c) => {
    const body = await readJsonBody(c);
    const ownerEmail = String(body.ownerEmail ?? '');
    return c.json(await deps.service.contactMatch(c.req.param('id'), ownerEmail));
  });

  app.post('/api/v1/match/matches/:id/accept', async (c) =>
    c.json(await deps.service.acceptMatch(c.req.param('id'))),
  );

  app.post('/api/v1/match/matches/:id/reject', async (c) =>
    c.json(await deps.service.rejectMatch(c.req.param('id'))),
  );

  return app;
}
