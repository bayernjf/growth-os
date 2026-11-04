import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { CrmRepository } from '../src/crm/repository.js';
import { LeadService } from '../src/crm/lead-service.js';
import { LocalWatch } from '../src/crm/watch.js';
import { OfflineSearchProvider } from '../src/research/provider/offline.js';
import { ResearchRepository } from '../src/research/repository.js';
import { ResearchService } from '../src/research/research-service.js';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import type { StorageDriver, StorageTxn } from '../src/storage/driver.js';

const FIXED_NOW = '2026-10-25T00:00:00Z';
const KEYWORDS = ['ai crm', 'cold email', 'outreach', 'personal agent', 'follow up', 'lead generation', 'sales'];
const ALL_TYPES = ['need', 'pain', 'comparison', 'competitor', 'trend', 'intent', 'hiring', 'funding', 'tech_stack'] as const;

async function makeStack(options?: { leadMinScore?: number }) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const researchRepo = new ResearchRepository(driver);
  const researchService = new ResearchService({
    repo: researchRepo,
    provider: new OfflineSearchProvider(),
    scoring: loadConfig().scoring,
    now: () => FIXED_NOW,
  });
  const crmRepo = new CrmRepository(driver);
  const leadService = new LeadService({
    repo: crmRepo,
    signals: researchRepo,
    watch: new LocalWatch(crmRepo),
    leadMinScore: options?.leadMinScore ?? 60,
    now: () => FIXED_NOW,
  });
  return { driver, researchRepo, researchService, crmRepo, leadService };
}

async function seededStack(options?: { leadMinScore?: number }) {
  const stack = await makeStack(options);
  const topic = await stack.researchService.createTopic({
    title: 'AI growth tooling demand',
    description: 'research',
    keywords: KEYWORDS,
    signalTypes: [...ALL_TYPES],
    language: 'en',
  });
  await stack.researchService.run(topic.id);
  return { ...stack, topic };
}

describe('contacts', () => {
  it('creates and reads a contact', async () => {
    const { leadService } = await makeStack();
    const c = await leadService.createContact({ name: 'Acme Inc', email: 'a@acme.com' });
    expect(await leadService.getContact(c.id)).toMatchObject({ name: 'Acme Inc', email: 'a@acme.com' });
    expect((await leadService.listContacts()).length).toBe(1);
  });

  it('rejects an empty name', async () => {
    const { leadService } = await makeStack();
    await expect(leadService.createContact({ name: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('lead state machine', () => {
  it('moves through valid transitions and records audit events', async () => {
    const { leadService } = await makeStack();
    const lead = await leadService.createLead({ title: 'Manual lead' });
    expect(lead.status).toBe('new');

    await leadService.transitionLead(lead.id, 'qualified');
    await leadService.transitionLead(lead.id, 'contacted');
    const won = await leadService.transitionLead(lead.id, 'won', 'closed-won');
    expect(won.status).toBe('won');

    const events = await leadService.listLeadEvents(lead.id);
    expect(events.map((e) => e.toStatus)).toEqual(['qualified', 'contacted', 'won']);
    expect(events[0]?.fromStatus).toBe('new');
    expect(events[2]?.note).toBe('closed-won');
  });

  it('fails closed on illegal transitions', async () => {
    const { leadService } = await makeStack();
    const lead = await leadService.createLead({ title: 'x' });
    await expect(leadService.transitionLead(lead.id, 'contacted')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      status: 409,
    });
    await expect(leadService.transitionLead(lead.id, 'won')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('terminal states accept no further transitions', async () => {
    const { leadService } = await makeStack();
    const lead = await leadService.createLead({ title: 'x' });
    await leadService.transitionLead(lead.id, 'lost');
    await expect(leadService.transitionLead(lead.id, 'qualified')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});

describe('signal -> lead promotion', () => {
  it('promotes high-intent signals once and is idempotent', async () => {
    const { leadService, researchRepo, topic } = await seededStack();
    const signals = await researchRepo.listSignals(topic.id);
    const intent = signals.filter((s) => s.signalType === 'intent');
    expect(intent.length).toBeGreaterThan(0);

    const created = await leadService.promoteSignalsToLeads(topic.id);
    expect(created.length).toBe(intent.length);
    expect(created[0]).toMatchObject({
      sourceType: 'signal',
      sourceSignalId: intent[0]?.id,
      score: intent[0]?.score,
      status: 'new',
    });
    expect(created[0]?.scoreBreakdown).toBeDefined();

    const again = await leadService.promoteSignalsToLeads(topic.id);
    expect(again.length).toBe(0);
  });

  it('skips intent signals below the lead threshold', async () => {
    const { leadService, topic } = await seededStack({ leadMinScore: 100 });
    const created = await leadService.promoteSignalsToLeads(topic.id);
    expect(created.length).toBe(0);
  });
});

describe('followups and watch', () => {
  it('records followups and completes them', async () => {
    const { leadService } = await makeStack();
    const lead = await leadService.createLead({ title: 'x' });
    const f = await leadService.addFollowup(lead.id, {
      action: 'call',
      note: 'intro call',
      sourceSignalIds: ['sig-1'],
      dueAt: '2026-10-26T00:00:00Z',
    });
    expect((await leadService.listFollowups(lead.id)).length).toBe(1);

    await leadService.completeFollowup(f.id);
    const after = await leadService.listFollowups(lead.id);
    expect(after[0]?.doneAt).toBe(FIXED_NOW);
  });

  it('watch tick returns only due, incomplete followups', async () => {
    const { leadService } = await makeStack();
    const lead = await leadService.createLead({ title: 'x' });
    const overdue = await leadService.addFollowup(lead.id, { action: 'call', dueAt: '2026-10-24T00:00:00Z' });
    await leadService.addFollowup(lead.id, { action: 'email_draft', dueAt: '2026-10-26T00:00:00Z' });
    await leadService.addFollowup(lead.id, { action: 'note' }); // no due_at -> never due

    const due = await leadService.listDueFollowups();
    expect(due.map((f) => f.id)).toEqual([overdue.id]);

    await leadService.completeFollowup(overdue.id);
    expect(await leadService.listDueFollowups()).toHaveLength(0);
  });
});

describe('lead -> contact attachment', () => {
  it('attaches a contact to a lead', async () => {
    const { leadService } = await makeStack();
    const contact = await leadService.createContact({ name: 'Acme' });
    const lead = await leadService.createLead({ title: 'x' });
    const updated = await leadService.attachContact(lead.id, contact.id);
    expect(updated.contactId).toBe(contact.id);
  });
});

/**
 * Wraps a driver so the lead_events INSERT inside a transition transaction
 * fails — used to prove the status UPDATE rolls back with the audit event.
 */
class FailingEventDriver implements StorageDriver {
  readonly dialect = 'sqlite' as const;
  constructor(private readonly inner: StorageDriver) {}
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return this.inner.all<T>(sql, params);
  }
  get<T>(sql: string, params?: readonly unknown[]): Promise<T | undefined> {
    return this.inner.get<T>(sql, params);
  }
  run(sql: string, params?: readonly unknown[]): Promise<{ changes: number }> {
    return this.inner.run(sql, params);
  }
  exec(sql: string): Promise<void> {
    return this.inner.exec(sql);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  async transaction<T>(fn: (tx: StorageTxn) => Promise<T>): Promise<T> {
    return this.inner.transaction((tx) =>
      fn({
        all: (sql, params) => tx.all(sql, params),
        get: (sql, params) => tx.get(sql, params),
        run: (sql, params) => {
          if (sql.includes('INSERT INTO lead_events')) {
            throw new Error('simulated transition event write failure');
          }
          return tx.run(sql, params);
        },
        exec: (sql) => tx.exec(sql),
      }),
    );
  }
}

describe('lead transition atomicity', () => {
  it('commits status change and transition event together', async () => {
    const { leadService, crmRepo } = await makeStack();
    const lead = await leadService.createLead({ title: 'Atomic lead' });

    await leadService.transitionLead(lead.id, 'qualified');

    const updated = await crmRepo.getLead(lead.id);
    expect(updated?.status).toBe('qualified');
    const events = await crmRepo.listLeadEvents(lead.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStatus: 'new', toStatus: 'qualified' });
  });

  it('rolls back the status update when the transition event write fails', async () => {
    const stack = await makeStack();
    const lead = await stack.leadService.createLead({ title: 'Atomic lead' });
    const failing = new FailingEventDriver(stack.driver);
    const repo = new CrmRepository(failing);
    const service = new LeadService({
      repo,
      signals: stack.researchRepo,
      watch: new LocalWatch(repo),
      leadMinScore: 60,
      now: () => FIXED_NOW,
    });

    await expect(service.transitionLead(lead.id, 'qualified')).rejects.toThrow(
      'simulated transition event write failure',
    );

    const untouched = await stack.crmRepo.getLead(lead.id);
    expect(untouched?.status).toBe('new');
    expect(await stack.crmRepo.listLeadEvents(lead.id)).toHaveLength(0);
  });
});
