import { describe, expect, it } from 'vitest';
import type { Signal } from '../src/research/types.js';
import {
  classifySignal,
  extractCategory,
  extractPrices,
  extractQuantity,
  extractRegion,
  structureSignal,
} from '../src/match/structurer.js';

function signal(overrides: Partial<Signal>): Signal {
  return {
    id: 'sig_1',
    topicId: 'tp_1',
    provider: 'offline',
    sourceType: 'web',
    signalType: 'need',
    title: '',
    content: '',
    url: 'https://example.com',
    fingerprint: 'fp_1',
    score: 80,
    scoreBreakdown: { type: 40, source: 10, fresh: 10, keyword: 20, total: 80 },
    createdAt: '2026-10-25T00:00:00Z',
    ...overrides,
  };
}

describe('classifySignal', () => {
  it('classifies a buying signal as demand', () => {
    const s = signal({
      title: 'Looking for stainless steel bottle supplier',
      content: 'We want to buy 1000 units, budget $2-$3.',
    });
    expect(classifySignal(s)).toBe('demand');
  });

  it('classifies a supplying signal as offer', () => {
    const s = signal({
      title: 'Factory supplies stainless steel bottles',
      content: 'We produce and wholesale kitchenware from China.',
    });
    expect(classifySignal(s)).toBe('offer');
  });

  it('returns unknown for unrelated signals', () => {
    const s = signal({ title: 'Weekly market trend report', content: 'Nothing actionable here.' });
    expect(classifySignal(s)).toBe('unknown');
  });
});

describe('field extraction', () => {
  it('extracts category, quantity, prices and region', () => {
    const text = 'Looking for stainless steel bottles, 1000 units, budget $2-$3, ship to USA.';
    expect(extractCategory(text)).toBe('kitchenware');
    expect(extractQuantity(text)).toBe('1000 units');
    expect(extractPrices(text)).toEqual([2, 3]);
    expect(extractRegion(text)).toBe('US');
  });

  it('leaves unknown fields unset', () => {
    const text = 'Random text without category, quantity, price or region.';
    expect(extractCategory(text)).toBe('general');
    expect(extractQuantity(text)).toBeUndefined();
    expect(extractPrices(text)).toEqual([]);
    expect(extractRegion(text)).toBeUndefined();
  });
});

describe('structureSignal', () => {
  it('structures a demand with extracted fields', () => {
    const s = signal({
      signalType: 'need',
      title: 'Looking for stainless steel bottle supplier',
      content: 'We want to buy 1000 units, budget $2-$3, ship to USA.',
    });
    const entity = structureSignal(s);
    expect(entity?.kind).toBe('demand');
    if (entity?.kind === 'demand') {
      expect(entity.input).toMatchObject({
        category: 'kitchenware',
        quantity: '1000 units',
        priceMin: 2,
        priceMax: 3,
        region: 'US',
        sourceSignalId: 'sig_1',
      });
    }
  });

  it('structures an offer with extracted fields', () => {
    const s = signal({
      signalType: 'intent',
      title: 'Factory supplies stainless steel bottles',
      content: 'Wholesale kitchenware from China, price $2.5, MOQ 500.',
    });
    const entity = structureSignal(s);
    expect(entity?.kind).toBe('offer');
    if (entity?.kind === 'offer') {
      expect(entity.input).toMatchObject({
        category: 'kitchenware',
        price: 2.5,
        region: 'CN',
      });
    }
  });

  it('returns undefined for unknown signals', () => {
    const s = signal({ title: 'Weekly market trend report', content: 'Nothing.' });
    expect(structureSignal(s)).toBeUndefined();
  });
});
