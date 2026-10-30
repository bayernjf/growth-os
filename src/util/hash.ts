import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Stable dedup key for a mention. A URL identifies a single resource, so the
 * same URL is treated as one signal regardless of title wording changes.
 */
export function fingerprint(url: string): string {
  return createHash('sha256').update(url.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Constant-time string equality (Tier0 review 2026-10-30: bearer tokens were
 * compared with `===`, leaking timing information). Both inputs are hashed
 * first so any pair of strings compares without throwing on length mismatch
 * and without early-exit prefix leaks.
 */
export function secureEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}
