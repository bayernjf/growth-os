// growth-os G2 CRM domain types (leads/contacts/followups/events).

import type { ScoreBreakdown } from '../research/types.js';

export type LeadStatus = 'new' | 'qualified' | 'contacted' | 'won' | 'lost';
export type LeadSourceType = 'signal' | 'form' | 'order' | 'manual';

export const LEAD_STATUSES: readonly LeadStatus[] = [
  'new',
  'qualified',
  'contacted',
  'won',
  'lost',
];
export const LEAD_SOURCE_TYPES: readonly LeadSourceType[] = [
  'signal',
  'form',
  'order',
  'manual',
];

/** Valid state-machine transitions; anything else fails closed (409). */
export const LEAD_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ['qualified', 'lost'],
  qualified: ['contacted', 'lost'],
  contacted: ['won', 'lost'],
  won: [],
  lost: [],
};

export interface Contact {
  id: string;
  name: string;
  company: string;
  email: string;
  title: string;
  sourceType: LeadSourceType;
  sourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ContactInput {
  name: string;
  company?: string;
  email?: string;
  title?: string;
  sourceType?: LeadSourceType;
  sourceRefs?: string[];
}

export interface Lead {
  id: string;
  sourceType: LeadSourceType;
  sourceSignalId?: string;
  contactId?: string;
  title: string;
  summary: string;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  status: LeadStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LeadInput {
  sourceType?: LeadSourceType;
  sourceSignalId?: string;
  contactId?: string;
  title: string;
  summary?: string;
  score?: number;
  scoreBreakdown?: ScoreBreakdown;
}

export interface LeadFollowup {
  id: string;
  leadId: string;
  action: string;
  note: string;
  sourceSignalIds: string[];
  dueAt?: string;
  doneAt?: string;
  createdAt: string;
}

export interface LeadFollowupInput {
  action: string;
  note?: string;
  sourceSignalIds?: string[];
  dueAt?: string;
}

export interface LeadEvent {
  id: string;
  leadId: string;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  note: string;
  createdAt: string;
}
