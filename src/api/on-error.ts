import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { GrowthError } from '../research/errors.js';

/**
 * Shared Hono error handler (Tier0 review 2026-10-30 H2/P2): `GrowthError`
 * bodies are intentional API errors and pass through unchanged, but any
 * other exception must not leak driver, table or stack details to the
 * client. The original error is logged server-side only and the response
 * body stays generic.
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
  return c.json({ code: 'INTERNAL', message: 'internal error', retryable: false }, 500);
}
