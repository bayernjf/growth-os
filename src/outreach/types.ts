// growth-os G3 outbound email domain types (campaigns / zeus-gated drafts /
// audit events). A draft only becomes sendable after zeus sign-off.

import type { EmailLocale } from '../mail/templates.js';

export type DraftStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'sent' | 'failed';
export type CampaignStatus = 'draft' | 'ready' | 'sending' | 'done';
export type OutreachEventType = 'created' | 'submitted' | 'approved' | 'rejected' | 'sent' | 'failed';

export interface Campaign {
  id: string;
  name: string;
  topicId?: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignInput {
  name: string;
  topicId?: string;
  /** Rendering language for the drafts of this campaign (T-G3-07; default en). */
  locale?: EmailLocale;
}

export interface OutreachDraft {
  id: string;
  campaignId: string;
  leadId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  /** Language used to render this draft (T-G3-07). */
  locale: string;
  /** Optional HTML rendering of the same draft, sent alongside the text part. */
  bodyHtml?: string;
  status: DraftStatus;
  decisionId?: string;
  messageId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutreachEvent {
  id: string;
  draftId: string;
  type: OutreachEventType;
  decisionId?: string;
  messageId?: string;
  note: string;
  createdAt: string;
}

export interface SuppressedEmail {
  email: string;
  reason: string;
  createdAt: string;
}

/** Kind of a signed receipt callback (bounce/reply), see outreach-http. */
export type CallbackEventKind = 'bounce' | 'reply';

/**
 * Record of an already-processed signed callback. `result` is the snapshot of
 * the first response body; replays return it instead of re-applying effects.
 */
export interface CallbackEvent {
  id: string;
  kind: CallbackEventKind;
  result: unknown;
  createdAt: string;
}
