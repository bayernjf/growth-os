import { createHash, randomUUID } from 'node:crypto';

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
