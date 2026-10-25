// growth-os G5 matching engine: score a buyer demand against a supplier offer
// across five explainable dimensions. Pure functions, no IO.

import type { BuyerDemand, SupplierOffer } from './types.js';

export interface MatchScore {
  score: number;
  reasons: Record<string, number>;
}

const CATEGORY_WEIGHT = 40;
const QUANTITY_WEIGHT = 20;
const PRICE_WEIGHT = 20;
const DEADLINE_WEIGHT = 10;
const REGION_WEIGHT = 10;

export function scoreMatch(demand: BuyerDemand, offer: SupplierOffer): MatchScore {
  const category = scoreCategory(demand.category, offer.category);
  const quantity = scoreQuantity(demand.quantity, offer);
  const price = scorePrice(demand, offer);
  const deadline = scoreDeadline(demand.deadline);
  const region = scoreRegion(demand.region, offer.region);
  return {
    score: category + quantity + price + deadline + region,
    reasons: { category, quantity, price, deadline, region },
  };
}

export function scoreCategory(demandCategory: string, offerCategory: string): number {
  if (demandCategory === offerCategory && demandCategory !== 'general') return CATEGORY_WEIGHT;
  if (demandCategory === 'general' || offerCategory === 'general') return CATEGORY_WEIGHT / 2;
  return 0;
}

export function scoreQuantity(demandQuantity: string | undefined, offer: SupplierOffer): number {
  const qty = parseNumber(demandQuantity);
  const moq = offer.moq;
  if (qty === undefined || moq === undefined) return QUANTITY_WEIGHT / 2;
  if (qty >= moq) return QUANTITY_WEIGHT;
  if (qty >= moq * 0.5) return QUANTITY_WEIGHT / 2;
  return 0;
}

export function scorePrice(demand: BuyerDemand, offer: SupplierOffer): number {
  const price = offer.price;
  if (price === undefined || demand.priceMin === undefined) return PRICE_WEIGHT / 2;
  const min = demand.priceMin;
  const max = demand.priceMax ?? min;
  if (price >= min && price <= max) return PRICE_WEIGHT;
  if (price >= min * 0.8 && price <= max * 1.2) return PRICE_WEIGHT / 2;
  return 0;
}

export function scoreDeadline(deadline: string | undefined): number {
  // Supplier delivery lead-time is not modeled yet; a deadline is scored
  // neutral and left for human review.
  void deadline;
  return DEADLINE_WEIGHT / 2;
}

export function scoreRegion(
  demandRegion: string | undefined,
  offerRegion: string | undefined,
): number {
  if (demandRegion === undefined || offerRegion === undefined) return REGION_WEIGHT / 2;
  if (demandRegion === offerRegion) return REGION_WEIGHT;
  return REGION_WEIGHT / 2;
}

function parseNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = text.match(/\d[\d,.]*/);
  return m ? Number(m[0].replace(/,/g, '')) : undefined;
}
