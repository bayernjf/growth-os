// growth-os G3 outbound use-case orchestration. The red line is "no outbound
// without zeus sign-off": a draft must pass submit -> zeus approval before the
// mail port is ever called. growth-os never grades a decision locally.

import type { Contact, ContactInput, Lead, LeadFollowup, LeadFollowupInput, LeadInput } from '../crm/types.js';
import type { DecisionPort } from '../decision/types.js';
import type { MailPort } from '../mail/types.js';
import { Errors } from '../research/errors.js';
import type { DraftWriter } from './content.js';
import type { OutreachRepository } from './repository.js';
import type { Campaign, CampaignInput, OutreachDraft, OutreachEvent, SuppressedEmail } from './types.js';

export interface LeadSource {
  getLead(id: string): Promise<Lead | undefined>;
  getContact(id: string): Promise<Contact | undefined>;
  addFollowup(leadId: string, input: LeadFollowupInput): Promise<LeadFollowup>;
  createContact(input: ContactInput): Promise<Contact>;
  createLead(input: LeadInput): Promise<Lead>;
}

export interface OutreachServiceDeps {
  repo: OutreachRepository;
  leads: LeadSource;
  writer: DraftWriter;
  decision: DecisionPort;
  mail: MailPort;
  now?: () => string;
}

export class OutreachService {
  private readonly repo: OutreachRepository;
  private readonly leads: LeadSource;
  private readonly writer: DraftWriter;
  private readonly decision: DecisionPort;
  private readonly mail: MailPort;
  private readonly now: () => string;

  constructor(deps: OutreachServiceDeps) {
    this.repo = deps.repo;
    this.leads = deps.leads;
    this.writer = deps.writer;
    this.decision = deps.decision;
    this.mail = deps.mail;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Create a campaign and one draft per lead that has a contact email. */
  async createCampaign(
    input: CampaignInput,
    leadIds: string[],
  ): Promise<{ campaign: Campaign; drafts: OutreachDraft[] }> {
    if (!input.name || input.name.trim().length === 0) {
      throw Errors.validation('campaign name is required');
    }
    const campaign = await this.repo.createCampaign(input, this.now());
    const drafts: OutreachDraft[] = [];
    for (const leadId of leadIds) {
      const lead = await this.leads.getLead(leadId);
      if (!lead) continue;
      const contact = lead.contactId ? await this.leads.getContact(lead.contactId) : undefined;
      const email = contact?.email ?? '';
      if (!email) continue;
      const { subject, text } = await this.writer.write({ lead, ...(contact ? { contact } : {}) });
      const draft = await this.repo.createDraft(campaign.id, leadId, email, subject, text, this.now());
      await this.repo.recordEvent(draft.id, 'created', '', {}, this.now());
      drafts.push(draft);
    }
    return { campaign, drafts };
  }

  /** Create a single draft addressed to an explicit recipient (match outreach). */
  async createContactDraft(
    toEmail: string,
    subject: string,
    text: string,
    leadTitle: string,
  ): Promise<OutreachDraft> {
    const contact = await this.leads.createContact({ name: toEmail, email: toEmail });
    const lead = await this.leads.createLead({ title: leadTitle, contactId: contact.id });
    const campaign = await this.repo.createCampaign({ name: 'contact' }, this.now());
    const draft = await this.repo.createDraft(campaign.id, lead.id, toEmail, subject, text, this.now());
    await this.repo.recordEvent(draft.id, 'created', '', {}, this.now());
    return draft;
  }

  listCampaigns(): Promise<Campaign[]> {
    return this.repo.listCampaigns();
  }

  async getCampaign(id: string): Promise<Campaign> {
    const campaign = await this.repo.getCampaign(id);
    if (!campaign) throw Errors.notFound(`campaign ${id}`);
    return campaign;
  }

  listDrafts(campaignId: string): Promise<OutreachDraft[]> {
    return this.repo.listDrafts(campaignId);
  }

  /** Submit a draft to zeus for grading; the draft then awaits approval. */
  async submitDraft(draftId: string): Promise<OutreachDraft> {
    const draft = await this.mustGetDraft(draftId);
    if (draft.status !== 'draft') {
      throw Errors.conflict(`draft is already ${draft.status}`);
    }
    const decision = await this.decision.decide({
      intent: 'email_outreach',
      domain: 'outreach',
      impact: 'external',
      reversibility: 'irreversible',
      riskTags: ['outbound_email'],
      proposal: { draftId: draft.id, leadId: draft.leadId, to: draft.toEmail, subject: draft.subject },
      idempotencyKey: draft.id,
    });
    await this.repo.markSubmitted(draft.id, decision.decisionId, this.now());
    await this.repo.recordEvent(
      draft.id,
      'submitted',
      `grade ${decision.grade}`,
      { decisionId: decision.decisionId },
      this.now(),
    );
    return this.mustGetDraft(draftId);
  }

  /** Poll the decision; move the draft to approved/rejected on a final verdict. */
  async checkApproval(draftId: string): Promise<OutreachDraft> {
    const draft = await this.mustGetDraft(draftId);
    if (draft.status !== 'submitted') {
      throw Errors.conflict(`draft is ${draft.status}, not awaiting approval`);
    }
    if (!draft.decisionId) throw Errors.conflict('draft has no decision to check');
    const decision = await this.decision.getDecision(draft.decisionId);
    if (decision.status === 'decided') {
      const outcome = decision.result?.outcome;
      if (outcome === 'approved' || outcome === 'auto') {
        await this.repo.markApproved(draft.id, this.now());
        await this.repo.recordEvent(
          draft.id,
          'approved',
          `outcome ${outcome}`,
          { decisionId: draft.decisionId },
          this.now(),
        );
      } else if (outcome === 'rejected') {
        await this.repo.markRejected(draft.id, this.now());
        await this.repo.recordEvent(draft.id, 'rejected', '', { decisionId: draft.decisionId }, this.now());
      }
    }
    return this.mustGetDraft(draftId);
  }

  /** Send an approved draft via the mail port; fails closed otherwise. */
  async sendDraft(draftId: string): Promise<OutreachDraft> {
    const draft = await this.mustGetDraft(draftId);
    if (draft.status !== 'approved') {
      throw Errors.conflict('outbound requires zeus sign-off: draft is not approved');
    }
    if (await this.repo.isSuppressed(draft.toEmail)) {
      throw Errors.conflict('recipient is suppressed; will not send');
    }
    const sent = await this.mail.send({
      to: draft.toEmail,
      subject: draft.subject,
      text: draft.bodyText,
      leadId: draft.leadId,
    });
    await this.repo.markSent(draft.id, sent.messageId, this.now());
    await this.repo.recordEvent(
      draft.id,
      'sent',
      '',
      { ...(draft.decisionId ? { decisionId: draft.decisionId } : {}), messageId: sent.messageId },
      this.now(),
    );
    return this.mustGetDraft(draftId);
  }

  listEvents(draftId: string): Promise<OutreachEvent[]> {
    return this.repo.listEvents(draftId);
  }

  // ---------- receipts (T-G3-05) ----------

  suppressEmail(email: string, reason: string): Promise<void> {
    return this.repo.addSuppressed(email, reason, this.now());
  }

  listSuppressed(): Promise<SuppressedEmail[]> {
    return this.repo.listSuppressed();
  }

  /** A bounce hard-suppresses the address so it is never sent again. */
  recordBounce(email: string): Promise<void> {
    return this.repo.addSuppressed(email, 'bounce', this.now());
  }

  /** A reply reflows back to the lead as a review follow-up. */
  async recordReply(messageId: string, from: string, text: string): Promise<LeadFollowup> {
    const draft = await this.repo.findDraftByMessageId(messageId);
    if (!draft) throw Errors.notFound(`draft with messageId ${messageId}`);
    const lead = await this.leads.getLead(draft.leadId);
    if (!lead) throw Errors.notFound(`lead ${draft.leadId}`);
    return this.leads.addFollowup(lead.id, { action: 'reply', note: `from ${from}: ${text}` });
  }

  private async mustGetDraft(id: string): Promise<OutreachDraft> {
    const draft = await this.repo.getDraft(id);
    if (!draft) throw Errors.notFound(`draft ${id}`);
    return draft;
  }
}
