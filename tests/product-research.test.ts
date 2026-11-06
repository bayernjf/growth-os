import { describe, expect, it } from 'vitest';
import {
  buildProductResearchReport,
  DEFAULT_PRICE_BANDS,
  summarizePriceBands,
  summarizeSupplyDemand,
  type ProductObservation,
} from '../src/research/product-research.js';
import { toProductObservations } from '../src/research/product-adapter.js';
import type { Signal } from '../src/research/types.js';

function obs(partial: Partial<ProductObservation> & Pick<ProductObservation, 'title' | 'url' | 'signalType'>): ProductObservation {
  return partial;
}

const fixture: ProductObservation[] = [
  obs({ title: '买家求购便携榨汁杯', url: 'https://m.example/d1', signalType: 'need', priceCny: 35 }),
  obs({ title: '续航差是主要吐槽', url: 'https://m.example/p1', signalType: 'pain', priceCny: 80 }),
  obs({ title: '竞品 A 在售', url: 'https://m.example/c1', signalType: 'competitor', priceCny: 129 }),
  obs({ title: '品类趋势上行', url: 'https://m.example/t1', signalType: 'trend', priceCny: 259 }),
  obs({ title: '高客单竞品', url: 'https://m.example/c2', signalType: 'comparison', priceCny: 620 }),
  obs({ title: '无价格的意向帖', url: 'https://m.example/i1', signalType: 'intent' }),
];

describe('summarizePriceBands', () => {
  it('buckets priced observations and computes per-band averages', () => {
    const bands = summarizePriceBands(fixture);
    const byLabel = new Map(bands.map((b) => [b.label, b]));
    expect(byLabel.get('0–49')?.count).toBe(1);
    expect(byLabel.get('50–199')?.count).toBe(2);
    expect(byLabel.get('200–499')?.count).toBe(1);
    expect(byLabel.get('500+')?.count).toBe(1);
    expect(byLabel.get('50–199')?.averageCny).toBe(104.5); // (80+129)/2
  });

  it('returns null average for empty bands and ignores unpriced observations', () => {
    const bands = summarizePriceBands([obs({ title: 'x', url: 'u', signalType: 'need' })]);
    expect(bands.every((b) => b.averageCny === null)).toBe(true);
    expect(bands.reduce((n, b) => n + b.count, 0)).toBe(0);
  });

  it('throws when a price falls outside every band', () => {
    expect(() =>
      summarizePriceBands([obs({ title: 'x', url: 'u', signalType: 'need', priceCny: -5 })]),
    ).not.toThrow(); // negative price treated as unpriced, not an out-of-band error
    expect(() =>
      summarizePriceBands(
        [obs({ title: 'x', url: 'u', signalType: 'need', priceCny: 10 })],
        [{ minCny: 100, maxCny: 200, label: '100–200' }],
      ),
    ).toThrow(/outside every configured price band/);
  });
});

describe('summarizeSupplyDemand', () => {
  it('counts demand vs supply and computes the ratio', () => {
    const sd = summarizeSupplyDemand(fixture);
    expect(sd.demandSignals).toBe(3); // need, pain, intent
    expect(sd.supplySignals).toBe(3); // competitor, trend, comparison
    expect(sd.demandToSupplyRatio).toBe(1);
  });

  it('returns null ratio when there are no supply signals (no divide-by-zero)', () => {
    const sd = summarizeSupplyDemand([obs({ title: 'x', url: 'u', signalType: 'need' })]);
    expect(sd.supplySignals).toBe(0);
    expect(sd.demandToSupplyRatio).toBeNull();
  });
});

describe('buildProductResearchReport', () => {
  it('assembles counts, bands and a deterministic markdown report', () => {
    const report = buildProductResearchReport(fixture, { now: '2026-11-07T00:00:00.000Z' });
    expect(report.sampleCount).toBe(6);
    expect(report.pricedCount).toBe(5);
    expect(report.generatedAt).toBe('2026-11-07T00:00:00.000Z');
    expect(report.markdown).toContain('商品调研报告（离线模板）');
    expect(report.markdown).toContain('观测总数：6');
    expect(report.markdown).toContain('含价格样本：5');
    expect(report.markdown).toContain('需求/供给比：1');
  });

  it('renders placeholders when there is no priced sample or no supply', () => {
    const report = buildProductResearchReport(
      [obs({ title: 'x', url: 'u', signalType: 'need' })],
      { now: '2026-11-07T00:00:00.000Z' },
    );
    expect(report.markdown).toContain('_无含价格样本_');
    expect(report.markdown).toContain('—（无供给信号）');
  });

  it('uses the default four bands in order', () => {
    expect(DEFAULT_PRICE_BANDS.map((b) => b.label)).toEqual(['0–49', '50–199', '200–499', '500+']);
  });
});

describe('toProductObservations', () => {
  const signal: Signal = {
    id: 'sig_1',
    topicId: 'topic_1',
    provider: 'offline',
    sourceType: 'web',
    signalType: 'competitor',
    title: '竞品',
    content: 'body',
    url: 'https://m.example/c',
    publishedAt: '2026-11-01T00:00:00.000Z',
    fingerprint: 'fp',
    score: 0.8,
    scoreBreakdown: { type: 0.2, source: 0.2, fresh: 0.2, keyword: 0.2, total: 0.8 },
    createdAt: '2026-11-01T00:00:00.000Z',
  };

  it('maps Signal fields and leaves price undefined without a lookup', () => {
    const mapped = toProductObservations([signal]);
    expect(mapped[0]).toMatchObject({ title: '竞品', url: signal.url, signalType: 'competitor' });
    expect(mapped[0]?.priceCny).toBeUndefined();
  });

  it('attaches a parsed price when the lookup contains the signal id', () => {
    const mapped = toProductObservations([signal], new Map([['sig_1', 199]]));
    expect(mapped[0]?.priceCny).toBe(199);
  });
});
