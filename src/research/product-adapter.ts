import type { Signal } from './types.js';
import type { ProductObservation } from './product-research.js';

/**
 * Adapt research-domain Signals into ProductObservations for J5 product
 * research. Price is not part of the generic Signal contract: callers that
 * have a parsed price (e.g. from a future 1688 provider) pass a lookup keyed
 * by signal id; without it the observation simply has no price and is excluded
 * from price-band math while still counting toward supply/demand.
 */
export function toProductObservations(
  signals: readonly Signal[],
  priceById: ReadonlyMap<string, number> = new Map(),
): ProductObservation[] {
  return signals.map((s) => ({
    title: s.title,
    url: s.url,
    signalType: s.signalType,
    priceCny: priceById.get(s.id),
    score: s.score,
    publishedAt: s.publishedAt,
  }));
}
