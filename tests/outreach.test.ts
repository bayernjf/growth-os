import { describe, expect, it } from 'vitest';
import type { DecisionRecord, DecisionRequest, DecisionResponse } from 'zeus-client';
import { loadConfig } from '../src/config.js';
import { CrmRepository } from '../src/crm/repository.js';
import { createDecisionPort } from '../src/decision/registry.js';
import type { DecisionPort } from '../src/decision/types.js';
import type { MailPort, OutboundEmail } from '../src/mail/types.js';
import type { DraftWriter } from '../src/outreach/content.js';
import { TemplateDraftWriter } from '../src/outreach/content.js';
import { OutreachRepository } from '../src/outreach/repository.js';
import { OutreachService } from '../src/outreach/outreach-service.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';

const FIXED_NOW = '2026-10-25T00:00:00Z';

class FakeDecisionPort implements DecisionPort {
  readonly name = 'fake';
  readonly online = true;
  submissions: DecisionRequest[] = [];
  verdicts: Record<string, 'approved' | 'rejected' | undefined> = {};

  decide(request: DecisionRequest): Promise<DecisionResponse> {
    this.submissions.push(request);
    return Promise.resolve({
      decisionId: 'dec_1',
      grade: 'D2',
      mode: 'approve-sync',
      status: 'awaiting_approval',
      ruleId: 'r1',
      auditSeq: 1,
    });
  }

  getDecision(id: string): Promise<DecisionRecord> {
    const verdict = this.verdicts[id];
    const record: DecisionRecord = {
      id,
      intent: 'email_outreach',
      domain: 'outreach',
      impact: 'external',
      reversibility: 'irreversible',
      grade: 'D2',
      mode: 'approve-sync',
      status: verdict ? 'decided' : 'awaiting_approval',
      ruleId: 'r1',
      gradeReason: 'outbound email',
      policyVersion: 1,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      auditSeq: 1,
      approvals: [],
      ...(verdict ? { result: { outcome: verdict, at: FIXED_NOW } } : {}),
    };
    return Promise.resolve(record);
  }
}

class FakeMailPort implements MailPort {
  readonly name = 'fake';
  readonly online = true;
  sent: OutboundEmail[] = [];

  send(message: OutboundEmail): Promise<{ messageId: string }> {
    this.sent.push(message);
    return Promise.resolve({ messageId: 'msg_1' });
  }
}

async function makeStack(options?: { decision?: DecisionPort; writer?: DraftWriter }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const crmRepo = new CrmRepository(driver);
  const outreachRepo = new OutreachRepository(driver);
  const decision = options?.decision ?? new FakeDecisionPort();
  const mail = new FakeMailPort();
  const service = new OutreachService({
    repo: outreachRepo,
    leads: crmRepo,
    writer: options?.writer ?? new TemplateDraftWriter(),
    decision,
    mail,
    now: () => FIXED_NOW,
  });
  return { driver, crmRepo, outreachRepo, decision, mail, service };
}

async function seedLead(crmRepo: CrmRepository) {
  const contact = await crmRepo.createContact({
    name: 'Jane Doe',
    company: 'Acme',
    email: 'jane@acme.com',
  });
  const lead = await crmRepo.createLead({
    title: 'Looking for an AI sales agent',
    summary: 'We need outbound automation.',
    contactId: contact.id,
  });
  return { contact, lead };
}

describe('campaign and draft creation', () => {
  it('creates one draft per lead with a contact email', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { campaign, drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);

    expect(campaign.status).toBe('draft');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ leadId: lead.id, toEmail: 'jane@acme.com', status: 'draft' });
    expect(drafts[0]?.subject).toContain(lead.title);

    const events = await stack.service.listEvents(drafts[0]!.id);
    expect(events.map((e) => e.type)).toEqual(['created']);
  });

  it('skips leads without a contact email', async () => {
    const stack = await makeStack();
    const lead = await stack.crmRepo.createLead({ title: 'no email lead' });
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    expect(drafts).toHaveLength(0);
  });
});

describe('zeus-gated send flow', () => {
  it('submits, approves, sends and records the full audit trail', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;

    const submitted = await stack.service.submitDraft(draft.id);
    expect(submitted.status).toBe('submitted');
    expect(submitted.decisionId).toBe('dec_1');

    const decision = stack.decision as FakeDecisionPort;
    expect(decision.submissions[0]).toMatchObject({ intent: 'email_outreach', domain: 'outreach' });

    // Not yet approved -> sending must fail closed and never touch mail.
    await expect(stack.service.sendDraft(draft.id)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(stack.mail.sent).toHaveLength(0);

    decision.verdicts['dec_1'] = 'approved';
    const approved = await stack.service.checkApproval(draft.id);
    expect(approved.status).toBe('approved');

    const sent = await stack.service.sendDraft(draft.id);
    expect(sent.status).toBe('sent');
    expect(sent.messageId).toBe('msg_1');
    expect(stack.mail.sent).toHaveLength(1);
    expect(stack.mail.sent[0]).toMatchObject({ to: 'jane@acme.com', leadId: lead.id });

    const events = await stack.service.listEvents(draft.id);
    expect(events.map((e) => e.type)).toEqual(['created', 'submitted', 'approved', 'sent']);
    expect(events[3]?.messageId).toBe('msg_1');
  });

  it('marks rejected when zeus declines', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    await stack.service.submitDraft(draft.id);

    const decision = stack.decision as FakeDecisionPort;
    decision.verdicts['dec_1'] = 'rejected';
    const rejected = await stack.service.checkApproval(draft.id);
    expect(rejected.status).toBe('rejected');
    await expect(stack.service.sendDraft(draft.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(stack.mail.sent).toHaveLength(0);
  });
});

describe('zero outbound without zeus (strong negative proof)', () => {
  it('fails closed when zeus is disabled: no sign-off, no mail ever', async () => {
    const rejecting = createDecisionPort({ ...loadConfig(), zeusMode: 'off' as const });
    const stack = await makeStack({ decision: rejecting });
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;

    await expect(stack.service.submitDraft(draft.id)).rejects.toMatchObject({
      code: 'DECISION_UNAVAILABLE',
      status: 503,
    });
    const still = await stack.outreachRepo.getDraft(draft.id);
    expect(still?.status).toBe('draft');
    expect(still?.decisionId).toBeUndefined();

    await expect(stack.service.sendDraft(draft.id)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(stack.mail.sent).toHaveLength(0);
  });
});

describe('receipts and suppression (T-G3-05)', () => {
  it('suppresses a bounced address so a later send fails closed', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    await stack.service.submitDraft(draft.id);
    (stack.decision as FakeDecisionPort).verdicts['dec_1'] = 'approved';
    await stack.service.checkApproval(draft.id);

    await stack.service.recordBounce('jane@acme.com');
    await expect(stack.service.sendDraft(draft.id)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(stack.mail.sent).toHaveLength(0);
    expect(await stack.service.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'bounce', createdAt: FIXED_NOW },
    ]);
  });

  it('matches suppression case-insensitively (2026-11-02 review P3-7)', async () => {
    const stack = await makeStack();
    await stack.outreachRepo.addSuppressed('Jane@ACME.com', 'bounce', FIXED_NOW);
    expect(await stack.outreachRepo.isSuppressed('jane@acme.com')).toBe(true);
    expect(await stack.outreachRepo.isSuppressed(' JANE@Acme.COM ')).toBe(true);
    expect(await stack.service.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'bounce', createdAt: FIXED_NOW },
    ]);
  });

  it('blocks a send when the bounce only differs by case', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    await stack.service.submitDraft(draft.id);
    (stack.decision as FakeDecisionPort).verdicts['dec_1'] = 'approved';
    await stack.service.checkApproval(draft.id);

    await stack.service.recordBounce('Jane@ACME.com');
    await expect(stack.service.sendDraft(draft.id)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(stack.mail.sent).toHaveLength(0);
  });

  it('records a reply as a lead follow-up for review', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    await stack.service.submitDraft(draft.id);
    (stack.decision as FakeDecisionPort).verdicts['dec_1'] = 'approved';
    await stack.service.checkApproval(draft.id);
    await stack.service.sendDraft(draft.id);

    const followup = await stack.service.recordReply('msg_1', 'jane@acme.com', 'Interested, call me.');
    expect(followup).toMatchObject({ leadId: lead.id, action: 'reply' });
    expect(followup.note).toContain('Interested, call me.');
    expect(followup.note).toContain('[intent=interest, locale=en]');
  });

  it('fails closed on a reply for an unknown message id', async () => {
    const stack = await makeStack();
    await expect(stack.service.recordReply('unknown', 'x@y.com', 'hi')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('signed callback idempotency, insert-first-wins (2026-11-02 review P2-3)', () => {
  it('claims a callback event id exactly once', async () => {
    const stack = await makeStack();
    const first = await stack.outreachRepo.recordCallbackEvent('evt_p', 'bounce', { ok: true });
    const dupe = await stack.outreachRepo.recordCallbackEvent('evt_p', 'bounce', { ok: true });
    expect(first).toBe(true);
    expect(dupe).toBe(false);
  });

  it('bounce callback replays the first result and suppresses exactly once', async () => {
    const stack = await makeStack();
    const first = await stack.service.recordBounceCallback('evt_b', 'jane@acme.com');
    const replay = await stack.service.recordBounceCallback('evt_b', 'jane@acme.com');
    expect(first).toEqual({ ok: true });
    expect(replay).toEqual({ ok: true });
    expect(await stack.service.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'bounce', createdAt: FIXED_NOW },
    ]);
  });

  it('reply callback replays the first followup without duplicating it', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    await stack.outreachRepo.markSent(drafts[0]!.id, 'msg_1', FIXED_NOW);

    const first = await stack.service.recordReplyCallback('evt_r', 'msg_1', 'jane@acme.com', 'Interested');
    const replay = await stack.service.recordReplyCallback('evt_r', 'msg_1', 'jane@acme.com', 'Interested');
    expect(replay.followup.id).toBe(first.followup.id);

    const followups = await stack.crmRepo.listFollowups(lead.id);
    expect(followups).toHaveLength(1);
    expect(followups[0]?.id).toBe(first.followup.id);
  });

  it('returns the winner’s recorded result when the event id was already claimed', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    await stack.outreachRepo.markSent(drafts[0]!.id, 'msg_1', FIXED_NOW);

    // A concurrent winner committed its claim and result first.
    const winner = { followup: { id: 'fup_winner', leadId: lead.id, action: 'reply' } };
    await stack.outreachRepo.recordCallbackEvent('evt_taken', 'reply', winner);

    const replay = await stack.service.recordReplyCallback('evt_taken', 'msg_1', 'jane@acme.com', 'hi');
    expect(replay).toEqual(winner);
    expect(await stack.crmRepo.listFollowups(lead.id)).toHaveLength(0);
  });

  it('processes distinct event ids independently', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    await stack.outreachRepo.markSent(drafts[0]!.id, 'msg_1', FIXED_NOW);

    await stack.service.recordReplyCallback('evt_1', 'msg_1', 'jane@acme.com', 'first');
    await stack.service.recordReplyCallback('evt_2', 'msg_1', 'jane@acme.com', 'second');
    expect(await stack.crmRepo.listFollowups(lead.id)).toHaveLength(2);
  });
});

describe('unsubscribe replies suppress the sender (2026-11-02 review P2-5)', () => {
  async function seedSentDraft(stack: Awaited<ReturnType<typeof makeStack>>) {
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    await stack.service.submitDraft(draft.id);
    (stack.decision as FakeDecisionPort).verdicts['dec_1'] = 'approved';
    await stack.service.checkApproval(draft.id);
    await stack.service.sendDraft(draft.id);
    return { lead, draft };
  }

  it('suppresses an unsubscribe reply, keeps the followup, and blocks the next send', async () => {
    const stack = await makeStack();
    const { lead, draft } = await seedSentDraft(stack);

    const followup = await stack.service.recordReply('msg_1', 'jane@acme.com', 'Please unsubscribe me.');
    expect(followup.leadId).toBe(lead.id);
    expect(followup.note).toContain('[intent=unsubscribe, locale=en]');

    expect(await stack.service.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'unsubscribe-reply', createdAt: FIXED_NOW },
    ]);
    // Closed loop: the send path fails closed on a suppressed address.
    await stack.outreachRepo.markApproved(draft.id, FIXED_NOW);
    await expect(stack.service.sendDraft(draft.id)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
    expect(stack.mail.sent).toHaveLength(1);
  });

  it('suppresses a zh unsubscribe reply arriving via the signed callback, idempotently', async () => {
    const stack = await makeStack();
    const { lead } = await seedSentDraft(stack);

    await stack.service.recordReplyCallback('evt_u', 'msg_1', 'jane@acme.com', '请退订，不要再发了');
    await stack.service.recordReplyCallback('evt_u', 'msg_1', 'jane@acme.com', '请退订，不要再发了');

    expect(await stack.service.listSuppressed()).toEqual([
      { email: 'jane@acme.com', reason: 'unsubscribe-reply', createdAt: FIXED_NOW },
    ]);
    expect(await stack.crmRepo.listFollowups(lead.id)).toHaveLength(1);
  });

  it('does not suppress a non-unsubscribe reply', async () => {
    const stack = await makeStack();
    await seedSentDraft(stack);

    await stack.service.recordReply('msg_1', 'jane@acme.com', 'Interested, call me.');
    expect(await stack.service.listSuppressed()).toEqual([]);
  });
});

describe('multilingual outreach (T-G3-07)', () => {
  const COMPLIANCE_WRITER = new TemplateDraftWriter(() => ({
    identity: 'BayJF · owner@example.com',
    unsubscribeUrl: 'https://growth-os.test/pub/v1/outreach/unsubscribe?token=t1',
  }));

  it('renders drafts in the campaign locale with compliance footer and html', async () => {
    const stack = await makeStack({ writer: COMPLIANCE_WRITER });
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro', locale: 'zh' }, [lead.id]);
    const draft = drafts[0]!;
    expect(draft.locale).toBe('zh');
    expect(draft.bodyText).toContain('你好');
    expect(draft.bodyText).toContain('退订');
    expect(draft.bodyText).toContain('BayJF');
    expect(draft.bodyHtml).toContain('<p>');

    const reloaded = await stack.outreachRepo.getDraft(draft.id);
    expect(reloaded?.locale).toBe('zh');
    expect(reloaded?.bodyHtml).toContain('退订');
  });

  it('defaults to en without a campaign locale', async () => {
    const stack = await makeStack({ writer: COMPLIANCE_WRITER });
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    expect(drafts[0]?.locale).toBe('en');
    expect(drafts[0]?.bodyText).toContain('Hi');
    expect(drafts[0]?.bodyText).toContain('Unsubscribe:');
  });

  it('sends the html part when the draft carries one', async () => {
    const stack = await makeStack({ writer: COMPLIANCE_WRITER });
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    await stack.service.submitDraft(draft.id);
    (stack.decision as FakeDecisionPort).verdicts['dec_1'] = 'approved';
    await stack.service.checkApproval(draft.id);
    await stack.service.sendDraft(draft.id);
    expect(stack.mail.sent[0]?.html).toBeDefined();
    expect(stack.mail.sent[0]?.html).toContain('</footer>');
  });

  it('tags reply follow-ups with intent and detected locale (offline, no fabrication)', async () => {
    const stack = await makeStack();
    const { lead } = await seedLead(stack.crmRepo);
    const { drafts } = await stack.service.createCampaign({ name: 'intro' }, [lead.id]);
    const draft = drafts[0]!;
    await stack.service.submitDraft(draft.id);
    (stack.decision as FakeDecisionPort).verdicts['dec_1'] = 'approved';
    await stack.service.checkApproval(draft.id);
    await stack.service.sendDraft(draft.id);

    const followup = await stack.service.recordReply('msg_1', 'jane@acme.com', '有兴趣，想了解一下');
    expect(followup.note).toContain('有兴趣，想了解一下');
    expect(followup.note).toContain('[intent=interest, locale=zh]');
  });
});
