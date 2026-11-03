import type { Context } from 'hono';
import { GrowthError } from '../research/errors.js';

/**
 * Parse a required JSON request body. A malformed body is a client error, not
 * a server fault: answer 400 VALIDATION_FAILED instead of letting the
 * SyntaxError reach growthOnError as a generic 500 (2026-11-02 review P2-6).
 * Endpoints with an intentionally optional body keep their own
 * `.catch(() => ({}))` fallback; JSON-RPC (/mcp) keeps its id-preserving
 * parse so protocol errors can be answered in-band.
 */
export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    throw new GrowthError('VALIDATION_FAILED', 'request body must be valid JSON', 400);
  }
}
