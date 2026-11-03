// growth-os G2 CRM persistence (dialect-agnostic; JSON serialized at the edge).

import type { StorageDriver, StorageTxn } from '../storage/driver.js';
import type { ScoreBreakdown } from '../research/types.js';
import { newId } from '../util/hash.js';
import type {
  Contact,
  ContactInput,
  Lead,
  LeadEvent,
  LeadFollowup,
  LeadFollowupInput,
  LeadInput,
  LeadStatus,
} from './types.js';

interface ContactRow {
  id: string;
  name: string;
  company: string;
  email: string;
  title: string;
  source_type: string;
  source_refs: string;
  created_at: string;
  updated_at: string;
}

interface LeadRow {
  id: string;
  source_type: string;
  source_signal_id: string | null;
  source_ref: string | null;
  contact_id: string | null;
  title: string;
  summary: string;
  score: number;
  score_breakdown: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface FollowupRow {
  id: string;
  lead_id: string;
  action: string;
  note: string;
  source_signal_ids: string;
  due_at: string | null;
  done_at: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  lead_id: string;
  from_status: string;
  to_status: string;
  note: string;
  created_at: string;
}

function parse<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

const EMPTY_BREAKDOWN: ScoreBreakdown = { type: 0, source: 0, fresh: 0, keyword: 0, total: 0 };

export class CrmRepository {
  constructor(private readonly driver: StorageDriver) {}

  /** Run a unit of work across contacts/leads in one transaction (batch import). */
  transaction<T>(fn: (tx: StorageTxn) => Promise<T>): Promise<T> {
    return this.driver.transaction(fn);
  }

  // ---------- contacts ----------

  async createContact(input: ContactInput, now?: string): Promise<Contact> {
    return this.insertContact(this.driver, input, now);
  }

  /** Insert a contact on an explicit transaction (used by batch import). */
  createContactOnTx(tx: StorageTxn, input: ContactInput, now?: string): Promise<Contact> {
    return this.insertContact(tx, input, now);
  }

  private async insertContact(
    runner: StorageTxn,
    input: ContactInput,
    now?: string,
  ): Promise<Contact> {
    const ts = now ?? new Date().toISOString();
    const contact: Contact = {
      id: newId('contact'),
      name: input.name,
      company: input.company ?? '',
      email: input.email ?? '',
      title: input.title ?? '',
      sourceType: input.sourceType ?? 'manual',
      sourceRefs: input.sourceRefs ?? [],
      createdAt: ts,
      updatedAt: ts,
    };
    await runner.run(
      `INSERT INTO contacts
        (id,name,company,email,title,source_type,source_refs,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        contact.id,
        contact.name,
        contact.company,
        contact.email,
        contact.title,
        contact.sourceType,
        JSON.stringify(contact.sourceRefs),
        contact.createdAt,
        contact.updatedAt,
      ],
    );
    return contact;
  }

  async getContact(id: string): Promise<Contact | undefined> {
    const row = await this.driver.get<ContactRow>('SELECT * FROM contacts WHERE id = ?', [id]);
    return row ? this.mapContact(row) : undefined;
  }

  async listContacts(): Promise<Contact[]> {
    const rows = await this.driver.all<ContactRow>(
      'SELECT * FROM contacts ORDER BY created_at DESC',
    );
    return rows.map((r) => this.mapContact(r));
  }

  private mapContact(row: ContactRow): Contact {
    return {
      id: row.id,
      name: row.name,
      company: row.company,
      email: row.email,
      title: row.title,
      sourceType: row.source_type as Contact['sourceType'],
      sourceRefs: parse<string[]>(row.source_refs),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- leads ----------

  async createLead(input: LeadInput, now?: string): Promise<Lead> {
    return this.insertLead(this.driver, input, now);
  }

  /** Insert a lead on an explicit transaction (used by batch import). */
  createLeadOnTx(tx: StorageTxn, input: LeadInput, now?: string): Promise<Lead> {
    return this.insertLead(tx, input, now);
  }

  private async insertLead(
    runner: StorageTxn,
    input: LeadInput,
    now?: string,
  ): Promise<Lead> {
    const ts = now ?? new Date().toISOString();
    const lead: Lead = {
      id: newId('lead'),
      sourceType: input.sourceType ?? 'manual',
      ...(input.sourceSignalId ? { sourceSignalId: input.sourceSignalId } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.contactId ? { contactId: input.contactId } : {}),
      title: input.title,
      summary: input.summary ?? '',
      score: input.score ?? 0,
      scoreBreakdown: input.scoreBreakdown ?? EMPTY_BREAKDOWN,
      status: 'new',
      createdAt: ts,
      updatedAt: ts,
    };
    await runner.run(
      `INSERT INTO leads
        (id,source_type,source_signal_id,source_ref,contact_id,title,summary,score,score_breakdown,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        lead.id,
        lead.sourceType,
        lead.sourceSignalId ?? null,
        lead.sourceRef ?? null,
        lead.contactId ?? null,
        lead.title,
        lead.summary,
        lead.score,
        JSON.stringify(lead.scoreBreakdown),
        lead.status,
        lead.createdAt,
        lead.updatedAt,
      ],
    );
    return lead;
  }

  async getLead(id: string): Promise<Lead | undefined> {
    const row = await this.driver.get<LeadRow>('SELECT * FROM leads WHERE id = ?', [id]);
    return row ? this.mapLead(row) : undefined;
  }

  async listLeads(status?: LeadStatus): Promise<Lead[]> {
    const rows = status
      ? await this.driver.all<LeadRow>(
          'SELECT * FROM leads WHERE status = ? ORDER BY score DESC, created_at ASC',
          [status],
        )
      : await this.driver.all<LeadRow>(
          'SELECT * FROM leads ORDER BY score DESC, created_at ASC',
        );
    return rows.map((r) => this.mapLead(r));
  }

  async findLeadBySignal(signalId: string): Promise<Lead | undefined> {
    const row = await this.driver.get<LeadRow>(
      'SELECT * FROM leads WHERE source_signal_id = ?',
      [signalId],
    );
    return row ? this.mapLead(row) : undefined;
  }

  /**
   * Update lead status and append its transition event in one transaction.
   * Returns 0 (with nothing written) when the lead does not exist, preserving
   * the previous setLeadStatus not-found semantics.
   */
  async transitionLeadStatus(
    id: string,
    fromStatus: LeadStatus,
    toStatus: LeadStatus,
    note: string,
    now: string,
  ): Promise<{ changes: number; event?: LeadEvent }> {
    return this.driver.transaction(async (tx) => {
      const result = await tx.run(
        'UPDATE leads SET status = ?, updated_at = ? WHERE id = ?',
        [toStatus, now, id],
      );
      if (result.changes === 0) return { changes: 0 };
      const event: LeadEvent = {
        id: newId('evt'),
        leadId: id,
        fromStatus,
        toStatus,
        note,
        createdAt: now,
      };
      await tx.run(
        `INSERT INTO lead_events
          (id,lead_id,from_status,to_status,note,created_at)
         VALUES (?,?,?,?,?,?)`,
        [event.id, event.leadId, event.fromStatus, event.toStatus, event.note, event.createdAt],
      );
      return { changes: result.changes, event };
    });
  }

  async attachContact(id: string, contactId: string, now: string): Promise<number> {
    const result = await this.driver.run(
      'UPDATE leads SET contact_id = ?, updated_at = ? WHERE id = ?',
      [contactId, now, id],
    );
    return result.changes;
  }

  private mapLead(row: LeadRow): Lead {
    return {
      id: row.id,
      sourceType: row.source_type as Lead['sourceType'],
      ...(row.source_signal_id ? { sourceSignalId: row.source_signal_id } : {}),
      ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
      ...(row.contact_id ? { contactId: row.contact_id } : {}),
      title: row.title,
      summary: row.summary,
      score: Number(row.score),
      scoreBreakdown: parse<ScoreBreakdown>(row.score_breakdown),
      status: row.status as LeadStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- followups ----------

  async addFollowup(leadId: string, input: LeadFollowupInput, now?: string): Promise<LeadFollowup> {
    return this.insertFollowup(this.driver, leadId, input, now);
  }

  /** Insert a followup on an explicit transaction (signed reply callbacks, P2-3). */
  addFollowupOnTx(
    tx: StorageTxn,
    leadId: string,
    input: LeadFollowupInput,
    now?: string,
  ): Promise<LeadFollowup> {
    return this.insertFollowup(tx, leadId, input, now);
  }

  private async insertFollowup(
    runner: StorageTxn,
    leadId: string,
    input: LeadFollowupInput,
    now?: string,
  ): Promise<LeadFollowup> {
    const ts = now ?? new Date().toISOString();
    const followup: LeadFollowup = {
      id: newId('fup'),
      leadId,
      action: input.action,
      note: input.note ?? '',
      sourceSignalIds: input.sourceSignalIds ?? [],
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      createdAt: ts,
    };
    await runner.run(
      `INSERT INTO lead_followups
        (id,lead_id,action,note,source_signal_ids,due_at,done_at,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        followup.id,
        followup.leadId,
        followup.action,
        followup.note,
        JSON.stringify(followup.sourceSignalIds),
        followup.dueAt ?? null,
        null,
        followup.createdAt,
      ],
    );
    return followup;
  }

  async listFollowups(leadId: string): Promise<LeadFollowup[]> {
    const rows = await this.driver.all<FollowupRow>(
      'SELECT * FROM lead_followups WHERE lead_id = ? ORDER BY created_at ASC',
      [leadId],
    );
    return rows.map((r) => this.mapFollowup(r));
  }

  async listDueFollowups(now: string): Promise<LeadFollowup[]> {
    const rows = await this.driver.all<FollowupRow>(
      'SELECT * FROM lead_followups WHERE due_at IS NOT NULL AND due_at <= ? AND done_at IS NULL ORDER BY due_at ASC',
      [now],
    );
    return rows.map((r) => this.mapFollowup(r));
  }

  async completeFollowup(id: string, now: string): Promise<number> {
    const result = await this.driver.run(
      'UPDATE lead_followups SET done_at = ? WHERE id = ? AND done_at IS NULL',
      [now, id],
    );
    return result.changes;
  }

  private mapFollowup(row: FollowupRow): LeadFollowup {
    return {
      id: row.id,
      leadId: row.lead_id,
      action: row.action,
      note: row.note,
      sourceSignalIds: parse<string[]>(row.source_signal_ids),
      ...(row.due_at ? { dueAt: row.due_at } : {}),
      ...(row.done_at ? { doneAt: row.done_at } : {}),
      createdAt: row.created_at,
    };
  }

  // ---------- events ----------

  async listLeadEvents(leadId: string): Promise<LeadEvent[]> {
    const rows = await this.driver.all<EventRow>(
      'SELECT * FROM lead_events WHERE lead_id = ? ORDER BY created_at ASC',
      [leadId],
    );
    return rows.map((r) => this.mapEvent(r));
  }

  private mapEvent(row: EventRow): LeadEvent {
    return {
      id: row.id,
      leadId: row.lead_id,
      fromStatus: row.from_status as LeadStatus,
      toStatus: row.to_status as LeadStatus,
      note: row.note,
      createdAt: row.created_at,
    };
  }
}
