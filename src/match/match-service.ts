// growth-os G5 matching use-case orchestration: create demands/offers, run the
// matching engine, list/accept/reject matches, and ingest signals into entities.

import { Errors } from '../research/errors.js';
import type { Signal } from '../research/types.js';
import { scoreMatch } from './matcher.js';
import type { MatchRepository } from './repository.js';
import { structureSignal, type StructuredEntity } from './structurer.js';
import type {
  BuyerDemand,
  BuyerDemandInput,
  Match,
  SupplierOffer,
  SupplierOfferInput,
} from './types.js';

export interface ContactDraftSink {
  createContactDraft(toEmail: string, subject: string, text: string, leadTitle: string): Promise<{ id: string }>;
}

export interface MatchServiceDeps {
  repo: MatchRepository;
  outreach?: ContactDraftSink;
  minScore?: number;
  now?: () => string;
}

export class MatchService {
  private readonly repo: MatchRepository;
  private readonly outreach: ContactDraftSink | undefined;
  private readonly minScore: number;
  private readonly now: () => string;

  constructor(deps: MatchServiceDeps) {
    this.repo = deps.repo;
    this.outreach = deps.outreach;
    this.minScore = deps.minScore ?? 60;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async createDemand(input: BuyerDemandInput): Promise<BuyerDemand> {
    if (!input.title || input.title.trim().length === 0) {
      throw Errors.validation('demand title is required');
    }
    if (!input.category || input.category.trim().length === 0) {
      throw Errors.validation('demand category is required');
    }
    return this.repo.createBuyerDemand(input, this.now());
  }

  async createOffer(input: SupplierOfferInput): Promise<SupplierOffer> {
    if (!input.title || input.title.trim().length === 0) {
      throw Errors.validation('offer title is required');
    }
    if (!input.category || input.category.trim().length === 0) {
      throw Errors.validation('offer category is required');
    }
    return this.repo.createSupplierOffer(input, this.now());
  }

  listDemands(): Promise<BuyerDemand[]> {
    return this.repo.listBuyerDemands();
  }

  listOffers(): Promise<SupplierOffer[]> {
    return this.repo.listSupplierOffers();
  }

  /** Score every demand × offer and create matches above the threshold (idempotent). */
  async runMatch(): Promise<Match[]> {
    const demands = await this.repo.listBuyerDemands();
    const offers = await this.repo.listSupplierOffers();
    const created: Match[] = [];
    for (const demand of demands) {
      for (const offer of offers) {
        const { score, reasons } = scoreMatch(demand, offer);
        if (score < this.minScore) continue;
        const existing = await this.repo.findMatchByPair(demand.id, offer.id);
        if (existing) continue;
        created.push(await this.repo.createMatch(demand.id, offer.id, score, reasons, this.now()));
      }
    }
    return created;
  }

  listMatches(): Promise<Match[]> {
    return this.repo.listMatches();
  }

  async acceptMatch(id: string): Promise<Match> {
    return this.setMatchStatus(id, 'accepted');
  }

  async rejectMatch(id: string): Promise<Match> {
    return this.setMatchStatus(id, 'rejected');
  }

  /** Classify + structure a signal into a demand/offer and persist it. */
  async ingestSignal(signal: Signal): Promise<StructuredEntity | undefined> {
    const entity = structureSignal(signal);
    if (!entity) return undefined;
    if (entity.kind === 'demand') {
      await this.repo.createBuyerDemand(entity.input, this.now());
    } else {
      await this.repo.createSupplierOffer(entity.input, this.now());
    }
    return entity;
  }

  /** Build an explainable introduction for a match (feeds the outreach flow). */
  async buildIntroduction(matchId: string): Promise<{ subject: string; text: string }> {
    const match = await this.repo.getMatch(matchId);
    if (!match) throw Errors.notFound(`match ${matchId}`);
    const demand = await this.repo.getBuyerDemand(match.buyerDemandId);
    const offer = await this.repo.getSupplierOffer(match.supplierOfferId);
    if (!demand || !offer) throw Errors.notFound(`match ${matchId} entity missing`);

    const reasons = Object.entries(match.reasons)
      .map(([dimension, value]) => `${dimension}: ${value}`)
      .join(', ');

    return {
      subject: `Match: ${demand.title} ↔ ${offer.title}`,
      text: [
        'Buyer demand:',
        `  ${demand.title}`,
        `  category: ${demand.category}, quantity: ${demand.quantity ?? '-'}, price: ${formatPrice(demand.priceMin, demand.priceMax, demand.currency)}, region: ${demand.region ?? '-'}`,
        '',
        'Supplier offer:',
        `  ${offer.title}`,
        `  category: ${offer.category}, price: ${formatPrice(offer.price, undefined, offer.currency)}, MOQ: ${offer.moq ?? '-'}, region: ${offer.region ?? '-'}`,
        '',
        `Match score: ${match.score} / 100`,
        `  ${reasons}`,
      ].join('\n'),
    };
  }

  /** Route a match into the outreach flow by creating a contact draft. */
  async contactMatch(matchId: string, ownerEmail: string): Promise<{ to: string; draft: { id: string } }> {
    if (!this.outreach) throw Errors.conflict('outreach is not configured for match contact');
    const match = await this.repo.getMatch(matchId);
    if (!match) throw Errors.notFound(`match ${matchId}`);
    const demand = await this.repo.getBuyerDemand(match.buyerDemandId);
    const offer = await this.repo.getSupplierOffer(match.supplierOfferId);
    if (!demand || !offer) throw Errors.notFound(`match ${matchId} entity missing`);
    const to = demand.email ?? offer.email ?? ownerEmail;
    const { subject, text } = await this.buildIntroduction(matchId);
    const draft = await this.outreach.createContactDraft(to, subject, text, subject);
    return { to, draft };
  }

  private async setMatchStatus(id: string, status: 'accepted' | 'rejected'): Promise<Match> {
    const changes = await this.repo.setMatchStatus(id, status, this.now());
    if (changes === 0) throw Errors.notFound(`match ${id}`);
    const updated = await this.repo.getMatch(id);
    if (!updated) throw Errors.notFound(`match ${id}`);
    return updated;
  }
}

function formatPrice(min: number | undefined, max: number | undefined, currency: string): string {
  if (min === undefined && max === undefined) return '-';
  if (min !== undefined && max !== undefined && min !== max) return `${min}-${max} ${currency}`;
  return `${min ?? max} ${currency}`;
}
