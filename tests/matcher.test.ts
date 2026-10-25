import { describe, expect, it } from 'vitest';
import { scoreMatch } from '../src/match/matcher.js';
import type { BuyerDemand, SupplierOffer } from '../src/match/types.js';

const baseDemand: BuyerDemand = {
  id: 'bdr_1',
  title: 'Need bottles',
  category: 'kitchenware',
  currency: 'USD',
  description: '',
  status: 'new',
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T00:00:00Z',
};

const baseOffer: SupplierOffer = {
  id: 'sup_1',
  title: 'Supply bottles',
  category: 'kitchenware',
  currency: 'USD',
  description: '',
  status: 'new',
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T00:00:00Z',
};

describe('scoreMatch', () => {
  it('scores a well-aligned pair high', () => {
    const demand: BuyerDemand = {
      ...baseDemand,
      quantity: '1000 units',
      priceMin: 2,
      priceMax: 3,
      region: 'US',
      deadline: '2026-12-01',
    };
    const offer: SupplierOffer = { ...baseOffer, moq: 500, price: 2.5, region: 'CN' };
    const result = scoreMatch(demand, offer);
    // category 40 + quantity 20 + price 20 + deadline 5 + region 5 = 90
    expect(result.score).toBe(90);
    expect(result.reasons).toEqual({ category: 40, quantity: 20, price: 20, deadline: 5, region: 5 });
  });

  it('scores category mismatch zero', () => {
    const result = scoreMatch({ ...baseDemand, category: 'electronics' }, { ...baseOffer, category: 'kitchenware' });
    expect(result.reasons.category).toBe(0);
  });

  it('treats general category as partial', () => {
    const result = scoreMatch({ ...baseDemand, category: 'general' }, { ...baseOffer, category: 'kitchenware' });
    expect(result.reasons.category).toBe(20);
  });

  it('scores price far out of range zero', () => {
    const demand: BuyerDemand = { ...baseDemand, priceMin: 2, priceMax: 3 };
    const offer: SupplierOffer = { ...baseOffer, price: 10 };
    expect(scoreMatch(demand, offer).reasons.price).toBe(0);
  });

  it('scores quantity below MOQ zero', () => {
    const demand: BuyerDemand = { ...baseDemand, quantity: '100 units' };
    const offer: SupplierOffer = { ...baseOffer, moq: 500 };
    expect(scoreMatch(demand, offer).reasons.quantity).toBe(0);
  });

  it('scores same region full, cross-border neutral', () => {
    const same = scoreMatch({ ...baseDemand, region: 'US' }, { ...baseOffer, region: 'US' });
    expect(same.reasons.region).toBe(10);
    const cross = scoreMatch({ ...baseDemand, region: 'US' }, { ...baseOffer, region: 'CN' });
    expect(cross.reasons.region).toBe(5);
  });

  it('gives neutral scores for missing fields', () => {
    const result = scoreMatch({ ...baseDemand, category: 'general' }, { ...baseOffer, category: 'general' });
    // category 20 + quantity 10 + price 10 + deadline 5 + region 5 = 50
    expect(result.score).toBe(50);
  });
});
