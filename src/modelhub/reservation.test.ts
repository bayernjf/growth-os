import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createReservedModelKit,
  ModelHubNotOptedIn,
  readModelHubReservation,
} from './reservation.js';

describe('readModelHubReservation (W7-1 opt-in placeholder)', () => {
  it('defaults to off with no env', () => {
    const r = readModelHubReservation({});
    expect(r.configured).toBe(false);
    expect(r.projectSlug).toBe('growth-os');
    expect(r.url).toBeUndefined();
    expect(r.cachePath).toBe('./data/model-hub-cache.json');
  });

  it('turns on only when both url and token are present', () => {
    expect(
      readModelHubReservation({ MODEL_HUB_URL: 'http://hub:8791' }).configured,
    ).toBe(false);
    const on = readModelHubReservation({
      MODEL_HUB_URL: 'http://hub:8791',
      MODEL_HUB_TOKEN: 't',
    });
    expect(on.configured).toBe(true);
    expect(on.url).toBe('http://hub:8791');
  });

  it('honors the kill switch even when fully configured', () => {
    for (const off of ['1', 'true', 'YES', 'on']) {
      expect(
        readModelHubReservation({
          MODEL_HUB_URL: 'http://hub:8791',
          MODEL_HUB_TOKEN: 't',
          MODEL_HUB_DISABLED: off,
        }).configured,
      ).toBe(false);
    }
  });

  it('honors a custom cache path', () => {
    const r = readModelHubReservation({
      MODEL_HUB_URL: 'http://hub:8791',
      MODEL_HUB_TOKEN: 't',
      MODEL_HUB_CACHE_PATH: '/tmp/x.json',
    });
    expect(r.cachePath).toBe('/tmp/x.json');
  });
});

describe('createReservedModelKit (W7-1 opt-in entry point)', () => {
  it('fails closed when the reservation is off', async () => {
    await expect(
      createReservedModelKit(readModelHubReservation({}), {}),
    ).rejects.toBeInstanceOf(ModelHubNotOptedIn);
  });

  it('builds a kit when opted in, without touching the network', async () => {
    const cachePath = join(mkdtempSync(join(tmpdir(), 'gos-hub-')), 'cache.json');
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.endsWith('/pub/v1/models')) throw new Error('unexpected url ' + url);
      return new Response(
        JSON.stringify({
          project: 'growth-os',
          revision: 1,
          fetched_at: '2026-10-28T00:00:00Z',
          models: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const kit = await createReservedModelKit(
      readModelHubReservation({
        MODEL_HUB_URL: 'http://hub:8791',
        MODEL_HUB_TOKEN: 'secret',
        MODEL_HUB_CACHE_PATH: cachePath,
      }),
      {},
      fakeFetch,
    );
    expect(kit.revision).toBe(1);
    expect(kit.list()).toEqual([]);
    // The opt-in path is wired; nothing else in the app calls it.
  });
});
