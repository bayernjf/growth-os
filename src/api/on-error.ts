import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { GrowthError } from '../research/errors.js';

/**
 * Shared Hono error handler (Tier0 review 2026-10-30 H2/P2): `GrowthError`
 * bodies are intentional API errors and pass through unchanged, but any
 * other exception must not leak driver, table or stack details to the
 * client. The original error is logged server-side only and the response
 * is a generic ProblemDetails (RFC 9457) body.
 */
export function growthOnError(err: Error, c: Context): Response {
  if (err instanceof GrowthError) {
    return c.json(err.toBody(), err.status as ContentfulStatusCode);
  }
  console.error(
    `[growth-os] unhandled error on ${c.req.method} ${c.req.path}: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`,
  );
  return c.json(
    {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail: 'internal error',
      instance: c.req.path,
    },
    500,
  );
}
