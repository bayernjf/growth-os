// growth-os G5 matching persistence (dialect-agnostic; JSON serialized at the edge).

import type { StorageDriver } from '../storage/driver.js';
import { newId } from '../util/hash.js';
import type {
  BuyerDemand,
  BuyerDemandInput,
  DemandStatus,
  Match,
  MatchStatus,
  SupplierOffer,
  SupplierOfferInput,
} from './types.js';

interface BuyerDemandRow {
  id: string;
  title: string;
  category: string;
  quantity: string | null;
  price_min: number | null;
  price_max: number | null;
  currency: string;
  deadline: string | null;
  region: string | null;
  description: string;
  source_signal_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SupplierOfferRow {
  id: string;
  title: string;
  category: string;
  capacity: string | null;
  price: number | null;
  currency: string;
  moq: number | null;
  region: string | null;
  credentials: string | null;
  description: string;
  source_signal_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface MatchRow {
  id: string;
  buyer_demand_id: string;
  supplier_offer_id: string;
  score: number;
  reasons: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function parse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export class MatchRepository {
  constructor(private readonly driver: StorageDriver) {}

  // ---------- buyer demands ----------

  async createBuyerDemand(input: BuyerDemandInput, now?: string): Promise<BuyerDemand> {
    const ts = now ?? new Date().toISOString();
    const demand: BuyerDemand = {
      id: newId('bdr'),
      title: input.title,
      category: input.category,
      ...(input.quantity !== undefined ? { quantity: input.quantity } : {}),
      ...(input.priceMin !== undefined ? { priceMin: input.priceMin } : {}),
      ...(input.priceMax !== undefined ? { priceMax: input.priceMax } : {}),
      currency: input.currency ?? 'USD',
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      description: input.description ?? '',
      ...(input.sourceSignalId !== undefined ? { sourceSignalId: input.sourceSignalId } : {}),
      status: 'new',
      createdAt: ts,
      updatedAt: ts,
    };
    await this.driver.run(
      `INSERT INTO buyer_demands
        (id,title,category,quantity,price_min,price_max,currency,deadline,region,description,source_signal_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        demand.id,
        demand.title,
        demand.category,
        demand.quantity ?? null,
        demand.priceMin ?? null,
        demand.priceMax ?? null,
        demand.currency,
        demand.deadline ?? null,
        demand.region ?? null,
        demand.description,
        demand.sourceSignalId ?? null,
        demand.status,
        demand.createdAt,
        demand.updatedAt,
      ],
    );
    return demand;
  }

  async getBuyerDemand(id: string): Promise<BuyerDemand | undefined> {
    const row = await this.driver.get<BuyerDemandRow>('SELECT * FROM buyer_demands WHERE id = ?', [id]);
    return row ? this.mapBuyerDemand(row) : undefined;
  }

  async listBuyerDemands(): Promise<BuyerDemand[]> {
    const rows = await this.driver.all<BuyerDemandRow>('SELECT * FROM buyer_demands ORDER BY created_at DESC');
    return rows.map((r) => this.mapBuyerDemand(r));
  }

  private mapBuyerDemand(row: BuyerDemandRow): BuyerDemand {
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      ...(row.quantity ? { quantity: row.quantity } : {}),
      ...(row.price_min !== null ? { priceMin: Number(row.price_min) } : {}),
      ...(row.price_max !== null ? { priceMax: Number(row.price_max) } : {}),
      currency: row.currency,
      ...(row.deadline ? { deadline: row.deadline } : {}),
      ...(row.region ? { region: row.region } : {}),
      description: row.description,
      ...(row.source_signal_id ? { sourceSignalId: row.source_signal_id } : {}),
      status: row.status as DemandStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- supplier offers ----------

  async createSupplierOffer(input: SupplierOfferInput, now?: string): Promise<SupplierOffer> {
    const ts = now ?? new Date().toISOString();
    const offer: SupplierOffer = {
      id: newId('sup'),
      title: input.title,
      category: input.category,
      ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      currency: input.currency ?? 'USD',
      ...(input.moq !== undefined ? { moq: input.moq } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.credentials !== undefined ? { credentials: input.credentials } : {}),
      description: input.description ?? '',
      ...(input.sourceSignalId !== undefined ? { sourceSignalId: input.sourceSignalId } : {}),
      status: 'new',
      createdAt: ts,
      updatedAt: ts,
    };
    await this.driver.run(
      `INSERT INTO supplier_offers
        (id,title,category,capacity,price,currency,moq,region,credentials,description,source_signal_id,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        offer.id,
        offer.title,
        offer.category,
        offer.capacity ?? null,
        offer.price ?? null,
        offer.currency,
        offer.moq ?? null,
        offer.region ?? null,
        offer.credentials ?? null,
        offer.description,
        offer.sourceSignalId ?? null,
        offer.status,
        offer.createdAt,
        offer.updatedAt,
      ],
    );
    return offer;
  }

  async getSupplierOffer(id: string): Promise<SupplierOffer | undefined> {
    const row = await this.driver.get<SupplierOfferRow>('SELECT * FROM supplier_offers WHERE id = ?', [id]);
    return row ? this.mapSupplierOffer(row) : undefined;
  }

  async listSupplierOffers(): Promise<SupplierOffer[]> {
    const rows = await this.driver.all<SupplierOfferRow>('SELECT * FROM supplier_offers ORDER BY created_at DESC');
    return rows.map((r) => this.mapSupplierOffer(r));
  }

  private mapSupplierOffer(row: SupplierOfferRow): SupplierOffer {
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      ...(row.capacity ? { capacity: row.capacity } : {}),
      ...(row.price !== null ? { price: Number(row.price) } : {}),
      currency: row.currency,
      ...(row.moq !== null ? { moq: Number(row.moq) } : {}),
      ...(row.region ? { region: row.region } : {}),
      ...(row.credentials ? { credentials: row.credentials } : {}),
      description: row.description,
      ...(row.source_signal_id ? { sourceSignalId: row.source_signal_id } : {}),
      status: row.status as DemandStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- matches ----------

  async createMatch(
    buyerDemandId: string,
    supplierOfferId: string,
    score: number,
    reasons: Record<string, number>,
    now?: string,
  ): Promise<Match> {
    const ts = now ?? new Date().toISOString();
    const match: Match = {
      id: newId('mtc'),
      buyerDemandId,
      supplierOfferId,
      score,
      reasons,
      status: 'pending',
      createdAt: ts,
      updatedAt: ts,
    };
    await this.driver.run(
      `INSERT INTO matches (id,buyer_demand_id,supplier_offer_id,score,reasons,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [match.id, match.buyerDemandId, match.supplierOfferId, match.score, JSON.stringify(match.reasons), match.status, match.createdAt, match.updatedAt],
    );
    return match;
  }

  async getMatch(id: string): Promise<Match | undefined> {
    const row = await this.driver.get<MatchRow>('SELECT * FROM matches WHERE id = ?', [id]);
    return row ? this.mapMatch(row) : undefined;
  }

  async listMatches(): Promise<Match[]> {
    const rows = await this.driver.all<MatchRow>('SELECT * FROM matches ORDER BY score DESC, created_at ASC');
    return rows.map((r) => this.mapMatch(r));
  }

  async setMatchStatus(id: string, status: MatchStatus, now: string): Promise<number> {
    const result = await this.driver.run('UPDATE matches SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      now,
      id,
    ]);
    return result.changes;
  }

  private mapMatch(row: MatchRow): Match {
    return {
      id: row.id,
      buyerDemandId: row.buyer_demand_id,
      supplierOfferId: row.supplier_offer_id,
      score: Number(row.score),
      reasons: parse<Record<string, number>>(row.reasons),
      status: row.status as MatchStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
