// growth-os G2 CRM use-case orchestration: contacts, leads (state machine),
// signal→lead promotion, follow-up timeline and watch reminders.

import { Errors } from '../research/errors.js';
import type { Signal } from '../research/types.js';
import type { CrmRepository } from './repository.js';
import {
  LEAD_SOURCE_TYPES,
  LEAD_STATUSES,
  LEAD_TRANSITIONS,
  type Contact,
  type ContactInput,
  type Lead,
  type LeadEvent,
  type LeadFollowup,
  type LeadFollowupInput,
  type LeadInput,
  type LeadStatus,
} from './types.js';
import type { WatchPort } from './watch.js';

export interface SignalSource {
  listSignals(topicId: string): Promise<Signal[]>;
}

export interface LeadServiceDeps {
  repo: CrmRepository;
  signals: SignalSource;
  watch: WatchPort;
  leadMinScore?: number;
  now?: () => string;
}

export class LeadService {
  private readonly repo: CrmRepository;
  private readonly signals: SignalSource;
  private readonly watch: WatchPort;
  private readonly leadMinScore: number;
  private readonly now: () => string;

  constructor(deps: LeadServiceDeps) {
    this.repo = deps.repo;
    this.signals = deps.signals;
    this.watch = deps.watch;
    this.leadMinScore = deps.leadMinScore ?? 60;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // ---------- contacts ----------

  async createContact(input: ContactInput): Promise<Contact> {
    if (!input.name || input.name.trim().length === 0) {
      throw Errors.validation('contact name is required');
    }
    if (input.sourceType && !LEAD_SOURCE_TYPES.includes(input.sourceType)) {
      throw Errors.validation('unknown source type', { sourceType: input.sourceType });
    }
    return this.repo.createContact(input, this.now());
  }

  async getContact(id: string): Promise<Contact> {
    const contact = await this.repo.getContact(id);
    if (!contact) throw Errors.notFound(`contact ${id}`);
    return contact;
  }

  listContacts(): Promise<Contact[]> {
    return this.repo.listContacts();
  }

  // ---------- leads ----------

  async createLead(input: LeadInput): Promise<Lead> {
    if (!input.title || input.title.trim().length === 0) {
      throw Errors.validation('lead title is required');
    }
    if (input.sourceType && !LEAD_SOURCE_TYPES.includes(input.sourceType)) {
      throw Errors.validation('unknown source type', { sourceType: input.sourceType });
    }
    if (input.score !== undefined && (input.score < 0 || input.score > 100)) {
      throw Errors.validation('score must be within 0..100');
    }
    return this.repo.createLead(input, this.now());
  }

  async getLead(id: string): Promise<Lead> {
    const lead = await this.repo.getLead(id);
    if (!lead) throw Errors.notFound(`lead ${id}`);
    return lead;
  }

  listLeads(status?: LeadStatus): Promise<Lead[]> {
    return this.repo.listLeads(status);
  }

  /**
   * Promote high-intent signals (signalType=intent, score >= leadMinScore)
   * into leads. Idempotent: a signal already promoted is skipped (one lead per
   * source signal, enforced by the unique source_signal_id).
   */
  async promoteSignalsToLeads(topicId: string): Promise<Lead[]> {
    const signals = await this.signals.listSignals(topicId);
    const created: Lead[] = [];
    for (const s of signals) {
      if (s.signalType !== 'intent') continue;
      if (s.score < this.leadMinScore) continue;
      const existing = await this.repo.findLeadBySignal(s.id);
      if (existing) continue;
      created.push(
        await this.repo.createLead(
          {
            sourceType: 'signal',
            sourceSignalId: s.id,
            title: s.title,
            summary: s.content,
            score: s.score,
            scoreBreakdown: s.scoreBreakdown,
          },
          this.now(),
        ),
      );
    }
    return created;
  }

  /** Move a lead through the state machine; illegal transitions fail closed. */
  async transitionLead(id: string, toStatus: LeadStatus, note = ''): Promise<Lead> {
    const lead = await this.repo.getLead(id);
    if (!lead) throw Errors.notFound(`lead ${id}`);
    if (!LEAD_STATUSES.includes(toStatus)) {
      throw Errors.validation('unknown lead status', { status: toStatus });
    }
    const allowed = LEAD_TRANSITIONS[lead.status];
    if (!allowed.includes(toStatus)) {
      throw Errors.invalidTransition(`cannot move lead from ${lead.status} to ${toStatus}`);
    }
    const now = this.now();
    const { changes } = await this.repo.transitionLeadStatus(
      id,
      lead.status,
      toStatus,
      note,
      now,
    );
    if (changes === 0) throw Errors.notFound(`lead ${id}`);
    const updated = await this.repo.getLead(id);
    if (!updated) throw Errors.notFound(`lead ${id}`);
    return updated;
  }

  listLeadEvents(id: string): Promise<LeadEvent[]> {
    return this.repo.listLeadEvents(id);
  }

  async attachContact(leadId: string, contactId: string): Promise<Lead> {
    const lead = await this.repo.getLead(leadId);
    if (!lead) throw Errors.notFound(`lead ${leadId}`);
    const contact = await this.repo.getContact(contactId);
    if (!contact) throw Errors.notFound(`contact ${contactId}`);
    const changes = await this.repo.attachContact(leadId, contactId, this.now());
    if (changes === 0) throw Errors.notFound(`lead ${leadId}`);
    const updated = await this.repo.getLead(leadId);
    if (!updated) throw Errors.notFound(`lead ${leadId}`);
    return updated;
  }

  // ---------- followups / watch ----------

  async addFollowup(leadId: string, input: LeadFollowupInput): Promise<LeadFollowup> {
    const lead = await this.repo.getLead(leadId);
    if (!lead) throw Errors.notFound(`lead ${leadId}`);
    if (!input.action || input.action.trim().length === 0) {
      throw Errors.validation('followup action is required');
    }
    return this.repo.addFollowup(leadId, input, this.now());
  }

  listFollowups(leadId: string): Promise<LeadFollowup[]> {
    return this.repo.listFollowups(leadId);
  }

  async completeFollowup(id: string): Promise<void> {
    const changes = await this.repo.completeFollowup(id, this.now());
    if (changes === 0) throw Errors.notFound(`followup ${id}`);
  }

  /** Watch tick (stub): followups due now and not yet done. */
  listDueFollowups(): Promise<LeadFollowup[]> {
    return this.watch.listDue(this.now());
  }
}
