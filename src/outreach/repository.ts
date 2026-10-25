// growth-os G3 outreach persistence (dialect-agnostic; no JSON columns).

import type { StorageDriver } from '../storage/driver.js';
import { newId } from '../util/hash.js';
import type {
  Campaign,
  CampaignInput,
  OutreachDraft,
  OutreachEvent,
  OutreachEventType,
} from './types.js';

interface CampaignRow {
  id: string;
  name: string;
  topic_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DraftRow {
  id: string;
  campaign_id: string;
  lead_id: string;
  to_email: string;
  subject: string;
  body_text: string;
  status: string;
  decision_id: string | null;
  message_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  draft_id: string;
  type: string;
  decision_id: string | null;
  message_id: string | null;
  note: string;
  created_at: string;
}

export interface OutreachEventRefs {
  decisionId?: string;
  messageId?: string;
}

export class OutreachRepository {
  constructor(private readonly driver: StorageDriver) {}

  // ---------- campaigns ----------

  async createCampaign(input: CampaignInput, now?: string): Promise<Campaign> {
    const ts = now ?? new Date().toISOString();
    const campaign: Campaign = {
      id: newId('camp'),
      name: input.name,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    };
    await this.driver.run(
      `INSERT INTO campaigns (id,name,topic_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
      [campaign.id, campaign.name, campaign.topicId ?? null, campaign.status, campaign.createdAt, campaign.updatedAt],
    );
    return campaign;
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    const row = await this.driver.get<CampaignRow>('SELECT * FROM campaigns WHERE id = ?', [id]);
    return row ? this.mapCampaign(row) : undefined;
  }

  async listCampaigns(): Promise<Campaign[]> {
    const rows = await this.driver.all<CampaignRow>('SELECT * FROM campaigns ORDER BY created_at DESC');
    return rows.map((r) => this.mapCampaign(r));
  }

  private mapCampaign(row: CampaignRow): Campaign {
    return {
      id: row.id,
      name: row.name,
      ...(row.topic_id ? { topicId: row.topic_id } : {}),
      status: row.status as Campaign['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---------- drafts ----------

  async createDraft(
    campaignId: string,
    leadId: string,
    toEmail: string,
    subject: string,
    bodyText: string,
    now?: string,
  ): Promise<OutreachDraft> {
    const ts = now ?? new Date().toISOString();
    const draft: OutreachDraft = {
      id: newId('draft'),
      campaignId,
      leadId,
      toEmail,
      subject,
      bodyText,
      status: 'draft',
      createdAt: ts,
      updatedAt: ts,
    };
    await this.driver.run(
      `INSERT INTO outreach_drafts
        (id,campaign_id,lead_id,to_email,subject,body_text,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [draft.id, campaignId, leadId, toEmail, subject, bodyText, draft.status, ts, ts],
    );
    return draft;
  }

  async getDraft(id: string): Promise<OutreachDraft | undefined> {
    const row = await this.driver.get<DraftRow>('SELECT * FROM outreach_drafts WHERE id = ?', [id]);
    return row ? this.mapDraft(row) : undefined;
  }

  async listDrafts(campaignId: string): Promise<OutreachDraft[]> {
    const rows = await this.driver.all<DraftRow>(
      'SELECT * FROM outreach_drafts WHERE campaign_id = ? ORDER BY created_at ASC',
      [campaignId],
    );
    return rows.map((r) => this.mapDraft(r));
  }

  private mapDraft(row: DraftRow): OutreachDraft {
    return {
      id: row.id,
      campaignId: row.campaign_id,
      leadId: row.lead_id,
      toEmail: row.to_email,
      subject: row.subject,
      bodyText: row.body_text,
      status: row.status as OutreachDraft['status'],
      ...(row.decision_id ? { decisionId: row.decision_id } : {}),
      ...(row.message_id ? { messageId: row.message_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async markSubmitted(id: string, decisionId: string, now: string): Promise<number> {
    const r = await this.driver.run(
      'UPDATE outreach_drafts SET status = ?, decision_id = ?, updated_at = ? WHERE id = ?',
      ['submitted', decisionId, now, id],
    );
    return r.changes;
  }

  async markApproved(id: string, now: string): Promise<number> {
    const r = await this.driver.run('UPDATE outreach_drafts SET status = ?, updated_at = ? WHERE id = ?', [
      'approved',
      now,
      id,
    ]);
    return r.changes;
  }

  async markRejected(id: string, now: string): Promise<number> {
    const r = await this.driver.run('UPDATE outreach_drafts SET status = ?, updated_at = ? WHERE id = ?', [
      'rejected',
      now,
      id,
    ]);
    return r.changes;
  }

  async markSent(id: string, messageId: string, now: string): Promise<number> {
    const r = await this.driver.run(
      'UPDATE outreach_drafts SET status = ?, message_id = ?, updated_at = ? WHERE id = ?',
      ['sent', messageId, now, id],
    );
    return r.changes;
  }

  // ---------- events ----------

  async recordEvent(
    draftId: string,
    type: OutreachEventType,
    note: string,
    refs: OutreachEventRefs,
    now?: string,
  ): Promise<OutreachEvent> {
    const ts = now ?? new Date().toISOString();
    const event: OutreachEvent = {
      id: newId('oev'),
      draftId,
      type,
      note,
      ...(refs.decisionId ? { decisionId: refs.decisionId } : {}),
      ...(refs.messageId ? { messageId: refs.messageId } : {}),
      createdAt: ts,
    };
    await this.driver.run(
      `INSERT INTO outreach_events (id,draft_id,type,decision_id,message_id,note,created_at) VALUES (?,?,?,?,?,?,?)`,
      [event.id, event.draftId, event.type, event.decisionId ?? null, event.messageId ?? null, event.note, event.createdAt],
    );
    return event;
  }

  async listEvents(draftId: string): Promise<OutreachEvent[]> {
    const rows = await this.driver.all<EventRow>(
      'SELECT * FROM outreach_events WHERE draft_id = ? ORDER BY created_at ASC',
      [draftId],
    );
    return rows.map((r) => this.mapEvent(r));
  }

  private mapEvent(row: EventRow): OutreachEvent {
    return {
      id: row.id,
      draftId: row.draft_id,
      type: row.type as OutreachEventType,
      ...(row.decision_id ? { decisionId: row.decision_id } : {}),
      ...(row.message_id ? { messageId: row.message_id } : {}),
      note: row.note,
      createdAt: row.created_at,
    };
  }
}
