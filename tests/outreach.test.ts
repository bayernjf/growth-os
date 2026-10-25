import { describe, expect, it } from 'vitest';
import type { DecisionRecord, DecisionRequest, DecisionResponse } from 'zeus-client';
import { loadConfig } from '../src/config.js';
import { CrmRepository } from '../src/crm/repository.js';
import { createDecisionPort } from '../src/decision/registry.js';
import type { DecisionPort } from '../src/decision/types.js';
import type { MailPort, OutboundEmail } from '../src/mail/types.js';
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

async function makeStack(options?: { decision?: DecisionPort }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const crmRepo = new CrmRepository(driver);
  const outreachRepo = new OutreachRepository(driver);
  const decision = options?.decision ?? new FakeDecisionPort();
  const mail = new FakeMailPort();
  const service = new OutreachService({
    repo: outreachRepo,
    leads: crmRepo,
    writer: new TemplateDraftWriter(),
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
