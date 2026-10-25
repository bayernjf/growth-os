import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawMention, SearchQuery } from '../types.js';
import type { SearchProvider } from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
// src|dist/research/provider/offline.js → repo root is three levels up
const repoRoot = process.env.GROWTH_REPO_ROOT ?? join(here, '..', '..', '..');
const FIXTURE_PATH = join(repoRoot, 'recordings', 'search', 'fixtures.json');

function loadFixtures(): RawMention[] {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { mentions: RawMention[] };
  return parsed.mentions;
}

function matches(m: RawMention, q: SearchQuery): boolean {
  if (!q.signalTypes.includes(m.signalType)) return false;
  if (q.keywords.length === 0) return true;
  const haystack = `${m.title} ${m.content}`.toLowerCase();
  return q.keywords.some((k) => haystack.includes(k.toLowerCase()));
}

/**
 * Deterministic, offline provider. Replays recorded fixtures without any
 * network access; the default mode so the whole research loop is runnable
 * and testable with zero credentials.
 */
export class OfflineSearchProvider implements SearchProvider {
  readonly name = 'offline';
  readonly online = false;
  private readonly fixtures: RawMention[];

  constructor(fixtures?: RawMention[]) {
    this.fixtures = fixtures ?? loadFixtures();
  }

  async search(q: SearchQuery): Promise<RawMention[]> {
    const hits = this.fixtures
      .filter((m) => matches(m, q))
      .slice(0, q.maxResults ?? 50)
      .map((m) => ({ ...m }));
    // Stable order regardless of fixture file ordering.
    hits.sort((a, b) => a.url.localeCompare(b.url));
    return hits;
  }
}
