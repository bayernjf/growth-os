import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { GrowthError } from '../src/research/errors.js';
import { OfflineSearchProvider } from '../src/research/provider/offline.js';
import { OnlineSearchProvider } from '../src/research/provider/online.js';
import { createSearchProvider } from '../src/research/provider/registry.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OfflineSearchProvider', () => {
  it('returns deterministic, filtered results', async () => {
    const p = new OfflineSearchProvider();
    const q = { keywords: ['ai crm'], signalTypes: ['need'] as const, maxResults: 50 };
    const a = await p.search(q);
    const b = await p.search(q);
    expect(a.length).toBe(2); // original + duplicate fixture row
    expect(a.map((m) => m.url)).toEqual(b.map((m) => m.url));
    expect(a.every((m) => m.signalType === 'need')).toBe(true);
  });

  it('filters by signal type', async () => {
    const p = new OfflineSearchProvider();
    const hits = await p.search({ keywords: ['outreach'], signalTypes: ['funding'] });
    expect(hits.every((m) => m.signalType === 'funding')).toBe(true);
  });
});

describe('createSearchProvider fail-closed', () => {
  it('online without credentials rejects runs with 422, never silently offline', async () => {
    const cfg = { ...loadConfig(), searchMode: 'online' as const, searchBaseUrl: undefined, searchApiKey: undefined };
    const p = createSearchProvider(cfg);
    expect(p.online).toBe(true);
    await expect(
      p.search({ keywords: ['x'], signalTypes: ['trend'] }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING', status: 422 } satisfies Partial<GrowthError>);
  });

  it('defaults to offline', () => {
    const p = createSearchProvider(loadConfig());
    expect(p.online).toBe(false);
  });
});

describe('OnlineSearchProvider', () => {
  it('maps Tavily-shaped results and classifies types', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          results: [
            {
              title: 'Acme launches a new outbound agent',
              url: 'https://acme.example/post',
              content: 'The vendor launches competitor features for sales teams',
              published_date: '2026-10-01T00:00:00Z',
            },
          ],
        }),
      })),
    );
    const p = new OnlineSearchProvider('https://search.example', 'secret');
    const hits = await p.search({ keywords: ['outbound'], signalTypes: ['competitor'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.signalType).toBe('competitor');
    expect(hits[0]?.url).toBe('https://acme.example/post');
  });

  it('maps unreachable providers to retryable 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const p = new OnlineSearchProvider('https://search.example', 'secret');
    await expect(
      p.search({ keywords: ['x'], signalTypes: ['trend'] }),
    ).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE', status: 503, retryable: true });
  });

  it('maps non-2xx responses to 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    const p = new OnlineSearchProvider('https://search.example', 'secret');
    await expect(
      p.search({ keywords: ['x'], signalTypes: ['trend'] }),
    ).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE', status: 503 });
  });
});
