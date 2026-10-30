import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { growthOnError } from '../src/api/on-error.js';
import { Errors } from '../src/research/errors.js';

function app(): Hono {
  const app = new Hono();
  app.onError(growthOnError);
  app.get('/growth', () => {
    throw Errors.notFound('lead');
  });
  app.get('/boom', () => {
    throw new Error('ECONNREFUSED 10.0.0.5:5432 — relation contact_messages missing');
  });
  return app;
}

describe('growthOnError (shared HTTP error handler)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes GrowthError bodies through with their status', async () => {
    const res = await app().request('/growth');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'lead not found', retryable: false });
  });

  it('returns a generic 500 body without echoing the original error text', async () => {
    const res = await app().request('/boom');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string; retryable: boolean };
    expect(body).toEqual({ code: 'INTERNAL', message: 'internal error', retryable: false });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('contact_messages');
  });

  it('logs the original error server-side only', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app().request('/boom');
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).toContain('GET /boom');
    expect(logged).toContain('ECONNREFUSED');
    expect(logged).toContain('relation contact_messages missing');
  });
});
