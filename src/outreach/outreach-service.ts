// growth-os G3 outbound use-case orchestration. The red line is "no outbound
// without zeus sign-off": a draft must pass submit -> zeus approval before the
// mail port is ever called. growth-os never grades a decision locally.

import type { Contact, ContactInput, Lead, LeadFollowup, LeadFollowupInput, LeadInput } from '../crm/types.js';
import type { DecisionPort } from '../decision/types.js';
import type { MailPort } from '../mail/types.js';
import { OfflineReplyTranslator, type ReplyTranslator, type TranslatedReply } from '../mail/reply-translator.js';
import { Errors } from '../research/errors.js';
import type { StorageTxn } from '../storage/driver.js';
import type { DraftWriter } from './content.js';
import type { OutreachRepository } from './repository.js';
import type { Campaign, CampaignInput, OutreachDraft, OutreachEvent, SuppressedEmail } from './types.js';

export interface LeadSource {
  getLead(id: string): Promise<Lead | undefined>;
  getContact(id: string): Promise<Contact | undefined>;
  addFollowup(leadId: string, input: LeadFollowupInput): Promise<LeadFollowup>;
  /** Followup insert joining an explicit transaction (signed reply callbacks). */
  addFollowupOnTx(tx: StorageTxn, leadId: string, input: LeadFollowupInput): Promise<LeadFollowup>;
  createContact(input: ContactInput): Promise<Contact>;
  createLead(input: LeadInput): Promise<Lead>;
}

/**
 * Thrown inside a callback transaction when the event id insert lost the race
 * (ON CONFLICT DO NOTHING): the whole transaction — including the followup or
 * suppression just written — rolls back and the winner's result is replayed.
 */
class CallbackReplayError extends Error {}

export interface OutreachServiceDeps {
  repo: OutreachRepository;
  leads: LeadSource;
  writer: DraftWriter;
  decision: DecisionPort;
  mail: MailPort;
  /** Reply understanding/translation (T-G3-07); defaults to the offline translator. */
  translator?: ReplyTranslator;
  now?: () => string;
}

export class OutreachService {
  private readonly repo: OutreachRepository;
  private readonly leads: LeadSource;
  private readonly writer: DraftWriter;
  private readonly decision: DecisionPort;
  private readonly mail: MailPort;
  private readonly translator: ReplyTranslator;
  private readonly now: () => string;

  constructor(deps: OutreachServiceDeps) {
    this.repo = deps.repo;
    this.leads = deps.leads;
    this.writer = deps.writer;
    this.decision = deps.decision;
    this.mail = deps.mail;
    this.translator = deps.translator ?? new OfflineReplyTranslator();
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
    const locale = input.locale ?? 'en';
    const campaign = await this.repo.createCampaign(input, this.now());
    const drafts: OutreachDraft[] = [];
    for (const leadId of leadIds) {
      const lead = await this.leads.getLead(leadId);
      if (!lead) continue;
      const contact = lead.contactId ? await this.leads.getContact(lead.contactId) : undefined;
      const email = contact?.email ?? '';
      if (!email) continue;
      const { subject, text, html } = await this.writer.write({ lead, ...(contact ? { contact } : {}), locale });
      const draft = await this.repo.createDraft(
        campaign.id,
        leadId,
        email,
        subject,
        text,
        this.now(),
        locale,
        html,
      );
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
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : {}),
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
    const { lead, note } = await this.resolveReply(messageId, from, text);
    return this.leads.addFollowup(lead.id, { action: 'reply', note });
  }

  /** Resolve the draft/lead for a reply and build the translated followup note. */
  private async resolveReply(
    messageId: string,
    from: string,
    text: string,
  ): Promise<{ draft: OutreachDraft; lead: Lead; note: string; translated: TranslatedReply }> {
    const draft = await this.repo.findDraftByMessageId(messageId);
    if (!draft) throw Errors.notFound(`draft with messageId ${messageId}`);
    const lead = await this.leads.getLead(draft.leadId);
    if (!lead) throw Errors.notFound(`lead ${draft.leadId}`);
    const translated = await this.translator.translate(text, 'en');
    const note =
      `from ${from}: ${text} [intent=${translated.intent}, locale=${translated.detectedLocale}]`;
    return { draft, lead, note, translated };
  }

  // ---------- signed receipt callbacks (Tier0 review 2026-10-30 P1) ----------

  /**
   * Signed bounce callback, idempotent by callback event id. Insert-first-wins
   * (2026-11-02 review P2-3): the suppression and the event claim commit in one
   * transaction; a concurrent replay loses the claim insert, rolls its side
   * effect back and returns the winner's recorded result.
   */
  async recordBounceCallback(eventId: string, email: string): Promise<{ ok: true }> {
    const existing = await this.repo.getCallbackEvent(eventId);
    if (existing) return existing.result as { ok: true };
    try {
      return await this.repo.transaction(async (tx) => {
        await this.repo.addSuppressedOnTx(tx, email, 'bounce', this.now());
        const result = { ok: true } as const;
        const claimed = await this.repo.recordCallbackEventOnTx(tx, eventId, 'bounce', result, this.now());
        if (!claimed) throw new CallbackReplayError();
        return result;
      });
    } catch (err) {
      const replayed = await this.replayedResult(err, eventId);
      if (replayed !== undefined) return replayed as { ok: true };
      throw err;
    }
  }

  /**
   * Signed reply callback, idempotent by callback event id: a replay returns
   * the followup created by the first delivery and must not add another one.
   * The followup insert and the event claim are one transaction (P2-3), so a
   * concurrent replay cannot persist a duplicate followup.
   */
  async recordReplyCallback(
    eventId: string,
    messageId: string,
    from: string,
    text: string,
  ): Promise<{ followup: LeadFollowup }> {
    const existing = await this.repo.getCallbackEvent(eventId);
    if (existing) return existing.result as { followup: LeadFollowup };
    const { lead, note } = await this.resolveReply(messageId, from, text);
    try {
      return await this.repo.transaction(async (tx) => {
        const followup = await this.leads.addFollowupOnTx(tx, lead.id, { action: 'reply', note });
        const claimed = await this.repo.recordCallbackEventOnTx(tx, eventId, 'reply', { followup }, this.now());
        if (!claimed) throw new CallbackReplayError();
        return { followup };
      });
    } catch (err) {
      const replayed = await this.replayedResult(err, eventId);
      if (replayed !== undefined) return replayed as { followup: LeadFollowup };
      throw err;
    }
  }

  /** On a lost claim race, fetch the result recorded by the winning delivery. */
  private async replayedResult(err: unknown, eventId: string): Promise<unknown | undefined> {
    if (!(err instanceof CallbackReplayError)) return undefined;
    const first = await this.repo.getCallbackEvent(eventId);
    return first?.result;
  }

  private async mustGetDraft(id: string): Promise<OutreachDraft> {
    const draft = await this.repo.getDraft(id);
    if (!draft) throw Errors.notFound(`draft ${id}`);
    return draft;
  }
}
