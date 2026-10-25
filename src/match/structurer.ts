// growth-os G5 structurer: classify a signal as a buyer demand or supplier
// offer, and extract structured fields (category/quantity/price/region) with
// rules first. Missing fields are left unset (never hard-filled).

import type { Signal } from '../research/types.js';
import type { BuyerDemandInput, SupplierOfferInput } from './types.js';

export type EntityKind = 'demand' | 'offer';

export interface StructuredEntity {
  kind: EntityKind;
  input: BuyerDemandInput | SupplierOfferInput;
}

const DEMAND_KEYWORDS = [
  'looking for', 'want to buy', 'need to buy', 'wish to buy', 'buying', 'purchase',
  'sourcing', 'procurement', 'supplier wanted', '采购', '求购', '找供应商', '寻找供应商', '寻源', '需要',
];

const OFFER_KEYWORDS = [
  'we supply', 'we sell', 'we produce', 'we manufacture', 'factory', 'manufacturer',
  'wholesale', 'we are supplier', 'supplier of', '供应', '厂家', '供货', '生产', '批发', '工厂', '制造商',
];

const CATEGORY_KEYWORDS: ReadonlyArray<{ category: string; keywords: string[] }> = [
  { category: 'kitchenware', keywords: ['stainless steel', 'bottle', 'cup', 'cookware', 'kitchen', 'tumbler', '保温杯', '水杯', '餐具'] },
  { category: 'electronics', keywords: ['electronics', 'battery', 'charger', 'led', 'circuit', '电子', '电池', '充电器'] },
  { category: 'furniture', keywords: ['furniture', 'chair', 'table', 'sofa', 'desk', '家具', '椅子', '桌子'] },
  { category: 'textile', keywords: ['textile', 'garment', 'clothing', 'fabric', 'apparel', '服装', '面料', '纺织'] },
  { category: 'machinery', keywords: ['machine', 'machinery', 'equipment', 'motor', 'pump', '机械', '设备', '电机'] },
];

const REGION_KEYWORDS: ReadonlyArray<{ region: string; keywords: string[] }> = [
  { region: 'US', keywords: ['united states', 'usa', 'america', 'u.s.'] },
  { region: 'UK', keywords: ['united kingdom', 'britain'] },
  { region: 'EU', keywords: ['europe', 'germany', 'france', 'spain', 'italy', 'netherlands'] },
  { region: 'CN', keywords: ['china', 'chinese', '中国', '广州', '深圳', '义乌', '浙江', '广东'] },
  { region: 'JP', keywords: ['japan', 'japanese'] },
];

/** Classify a signal as a buyer demand, supplier offer, or unknown. */
export function classifySignal(signal: Signal): EntityKind | 'unknown' {
  const text = `${signal.title} ${signal.content}`.toLowerCase();
  const demandHit = DEMAND_KEYWORDS.some((k) => text.includes(k));
  const offerHit = OFFER_KEYWORDS.some((k) => text.includes(k));
  if (demandHit && !offerHit) return 'demand';
  if (offerHit && !demandHit) return 'offer';
  return 'unknown';
}

export function extractCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return category;
  }
  return 'general';
}

export function extractQuantity(text: string): string | undefined {
  const m = text.match(/(\d[\d,.]*)\s*(units?|pcs?|pieces?|sets?|kgs?|tons?|mts?)\b/i);
  return m ? `${m[1]} ${m[2]}` : undefined;
}

export function extractPrices(text: string): number[] {
  const prices: number[] = [];
  const re = /\$\s*(\d[\d,.]*)|(\d[\d,.]*)\s*(?:usd|rmb|cny|eur)|[€¥]\s*(\d[\d,.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (raw !== undefined) {
      const n = Number(raw.replace(/,/g, ''));
      if (Number.isFinite(n)) prices.push(n);
    }
  }
  return prices;
}

export function extractMoq(text: string): number | undefined {
  const m = text.match(/moq\s*[:=]?\s*(\d[\d,.]*)|minimum\s+order\s*(?:quantity|qty)?\s*[:=]?\s*(\d[\d,.]*)/i);
  const raw = m?.[1] ?? m?.[2];
  return raw !== undefined ? Number(raw.replace(/,/g, '')) : undefined;
}

export function extractRegion(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const { region, keywords } of REGION_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return region;
  }
  return undefined;
}

export function structureDemand(signal: Signal): BuyerDemandInput {
  const text = `${signal.title} ${signal.content}`;
  const prices = extractPrices(text);
  const quantity = extractQuantity(text);
  const region = extractRegion(text);
  return {
    title: signal.title,
    category: extractCategory(text),
    ...(quantity ? { quantity } : {}),
    ...(prices.length > 0 ? { priceMin: Math.min(...prices) } : {}),
    ...(prices.length > 1 ? { priceMax: Math.max(...prices) } : {}),
    ...(region ? { region } : {}),
    description: signal.content,
    sourceSignalId: signal.id,
  };
}

export function structureOffer(signal: Signal): SupplierOfferInput {
  const text = `${signal.title} ${signal.content}`;
  const prices = extractPrices(text);
  const region = extractRegion(text);
  const moq = extractMoq(text);
  return {
    title: signal.title,
    category: extractCategory(text),
    ...(prices[0] !== undefined ? { price: prices[0] } : {}),
    ...(moq !== undefined ? { moq } : {}),
    ...(region ? { region } : {}),
    description: signal.content,
    sourceSignalId: signal.id,
  };
}

/** Classify + structure a signal; returns undefined for unknown signals. */
export function structureSignal(signal: Signal): StructuredEntity | undefined {
  const kind = classifySignal(signal);
  if (kind === 'demand') return { kind, input: structureDemand(signal) };
  if (kind === 'offer') return { kind, input: structureOffer(signal) };
  return undefined;
}
