// growth-os G3 outbound email domain types (campaigns / zeus-gated drafts /
// audit events). A draft only becomes sendable after zeus sign-off.

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
}

export interface OutreachDraft {
  id: string;
  campaignId: string;
  leadId: string;
  toEmail: string;
  subject: string;
  bodyText: string;
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
