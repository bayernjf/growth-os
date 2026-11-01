import { describe, expect, it } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SalesRepository } from '../src/sales/repository.js';
import { SalesService, type LeadCustomerLookup } from '../src/sales/sales-service.js';
import { SalesDecisionGate } from '../src/sales/decision.js';
import { CrmRepository } from '../src/crm/repository.js';
import type { DecisionPort } from '../src/decision/types.js';
import type { DecisionRecord, DecisionRequest, DecisionResponse } from 'zeus-client';

const NOW = '2026-11-01T00:00:00Z';

function items() {
  return [
    { description: 'Setup', qty: 1, unitAmountCents: 100_000, currency: 'CNY' },
    { description: 'Seat', qty: 2, unitAmountCents: 50_000, currency: 'CNY' },
  ];
}

async function stack(thresholdCents = 500_000, port?: DecisionPort, leads?: LeadCustomerLookup) {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const repo = new SalesRepository(driver);
  const gate = port ? new SalesDecisionGate({ decision: port, thresholdCents }) : undefined;
  const service = new SalesService({ repo, gate, leads, now: () => NOW });
  return { driver, repo, service };
}

class FakeDecision implements DecisionPort {
  readonly name = 'zeus';
  readonly online = true;
  calls: DecisionRequest[] = [];
  constructor(
    private readonly response: Partial<DecisionResponse> & Pick<DecisionResponse, 'decisionId'>,
    private readonly recordStatus: DecisionRecord['status'] = 'decided',
    private readonly outcome: 'approved' | 'auto' | 'rejected' = 'approved',
  ) {}
  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    this.calls.push(req);
    return {
      grade: 'D2',
      mode: 'approve-sync',
      status: 'awaiting_approval',
      ruleId: 'r1',
      auditSeq: 1,
      ...this.response,
    };
  }
  async getDecision(): Promise<DecisionRecord> {
    return {
      id: this.response.decisionId,
      intent: 'sales_quote_send',
      domain: 'sales',
      impact: 'external',
      reversibility: 'hard',
      grade: 'D2',
      mode: 'approve-sync',
      status: this.recordStatus,
      ruleId: 'r1',
      gradeReason: '',
      policyVersion: 1,
      auditSeq: 1,
      createdAt: NOW,
      updatedAt: NOW,
      approvals: [],
      ...(this.recordStatus === 'decided' ? { result: { outcome: this.outcome, at: NOW } } : {}),
    } as DecisionRecord;
  }
}

class RejectingDecision implements DecisionPort {
  readonly name = 'zeus';
  readonly online = false;
  async decide(): Promise<never> {
    throw new Error('503 DECISION_UNAVAILABLE zeus off');
  }
  async getDecision(): Promise<never> {
    throw new Error('503 DECISION_UNAVAILABLE zeus off');
  }
}

const leads: LeadCustomerLookup = {
  async getLeadCustomer(leadId: string) {
    if (leadId === 'lead_1') return { name: 'Acme', email: 'buyer@acme.test' };
    return undefined;
  },
};

describe('quote money validation', () => {
  it('computes the total from line items', async () => {
    const { service } = await stack();
    const q = await service.createQuote({ customerName: 'A', lineItems: items() });
    expect(q.amountCents).toBe(200_000);
    expect(q.currency).toBe('CNY');
    expect(q.status).toBe('draft');
  });

  it('rejects empty/negative/mismatched line items', async () => {
    const { service } = await stack();
    await expect(service.createQuote({ lineItems: [] })).rejects.toThrow(/at least one/);
    await expect(
      service.createQuote({ lineItems: [{ description: 'x', qty: 0, unitAmountCents: 10, currency: 'CNY' }] }),
    ).rejects.toThrow(/qty/);
    await expect(
      service.createQuote({ lineItems: [{ description: 'x', qty: 1, unitAmountCents: -1, currency: 'CNY' }] }),
    ).rejects.toThrow(/non-negative/);
    await expect(
      service.createQuote({
        lineItems: [
          { description: 'a', qty: 1, unitAmountCents: 10, currency: 'CNY' },
          { description: 'b', qty: 1, unitAmountCents: 10, currency: 'USD' },
        ],
      }),
    ).rejects.toThrow(/one currency/);
    await expect(
      service.createQuote({ lineItems: [{ qty: 1, unitAmountCents: 10, currency: 'CNY' }] }),
    ).rejects.toThrow(/description/);
  });
});

describe('quote lifecycle', () => {
  it('sends a low-value quote without calling zeus', async () => {
    const fake = new FakeDecision({ decisionId: 'dec_low' });
    const { service } = await stack(500_000, fake);
    const q = await service.createQuote({ lineItems: items() }); // 2000 CNY < 5000
    const sent = await service.sendQuote(q.id);
    expect('status' in sent && sent.status).toBe('sent');
    expect(fake.calls).toHaveLength(0);
    expect((await service.listQuoteEvents(q.id)).at(-1)?.toStatus).toBe('sent');
  });

  it('parks a high-value quote pending D2 approval, then resolves', async () => {
    const fake = new FakeDecision({ decisionId: 'dec_d2' }, 'awaiting_approval');
    const { service } = await stack(100_000, fake);
    const q = await service.createQuote({ lineItems: items() }); // 2000 >= 1000
    const parked = await service.sendQuote(q.id);
    expect(parked).toMatchObject({ pendingApproval: true, decisionId: 'dec_d2' });
    expect(fake.calls).toHaveLength(1);
    expect((await service.getQuote(q.id)).status).toBe('draft');

    // now zeus decides
    (fake as unknown as { recordStatus: string }).recordStatus = 'decided';
    const sent = await service.resolveQuoteApproval(q.id);
    expect(sent.status).toBe('sent');
    expect(sent.decisionId).toBe('dec_d2');
  });

  it('fails closed: high-value quote with zeus unavailable is not sent', async () => {
    const { service } = await stack(100_000, new RejectingDecision());
    const q = await service.createQuote({ lineItems: items() });
    await expect(service.sendQuote(q.id)).rejects.toThrow(/UNAVAILABLE|unavailable/i);
    expect((await service.getQuote(q.id)).status).toBe('draft');
  });

  it('rejects illegal transitions', async () => {
    const { service } = await stack();
    const q = await service.createQuote({ lineItems: items() });
    await expect(service.acceptQuote(q.id)).rejects.toThrow(/cannot move/);
    await service.sendQuote(q.id);
    await expect(service.sendQuote(q.id)).rejects.toThrow(/cannot move/);
    await service.rejectQuote(q.id);
    await expect(service.acceptQuote(q.id)).rejects.toThrow(/cannot move/);
  });
});

describe('contracts and orders gates', () => {
  async function acceptedQuote(service: SalesService) {
    const q = await service.createQuote({ lineItems: items() });
    await service.sendQuote(q.id);
    await service.acceptQuote(q.id);
    return q.id;
  }

  it('cannot contract a non-accepted quote or order from an unsigned contract', async () => {
    const { service } = await stack();
    const draft = await service.createQuote({ lineItems: items() });
    await expect(service.createContract(draft.id)).rejects.toThrow(/accepted/);
    const quoteId = await acceptedQuote(service);
    const c = await service.createContract(quoteId);
    await expect(service.createOrder(c.id)).rejects.toThrow(/signed/);
    await expect(service.createContract(quoteId)).rejects.toThrow(/already has contract/);
  });

  it('runs quote -> accepted -> contract -> signed -> order', async () => {
    const { service } = await stack();
    const quoteId = await acceptedQuote(service);
    const c = await service.createContract(quoteId, { terms: 'net-30' });
    await service.sendContract(c.id);
    await service.signContract(c.id);
    const order = await service.createOrder(c.id, 'first deal');
    expect(order.orderNo).toMatch(/^ORD-\d+$/);
    expect(order.deliveryStatus).toBe('pending');
    expect(order.amountCents).toBe(200_000);
    expect((await service.listOrders()).length).toBe(1);
  });
});

describe('lead conversion (OP-18)', () => {
  it('creates a quote from an existing lead', async () => {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const crm = new CrmRepository(driver);
    const lead = await crm.createLead({ title: 'Acme AI project' }, NOW);
    const repo = new SalesRepository(driver);
    const lookup: LeadCustomerLookup = {
      async getLeadCustomer(id) {
        if (id !== lead.id) return undefined;
        return { name: 'Acme', email: 'buyer@acme.test' };
      },
    };
    const service = new SalesService({ repo, leads: lookup, now: () => NOW });
    const q = await service.createQuoteFromLead(lead.id, items());
    expect(q.leadId).toBe(lead.id);
    expect(q.customerName).toBe('Acme');
    expect(q.customerEmail).toBe('buyer@acme.test');
  });

  it('404s on an unknown lead', async () => {
    const { service } = await stack(500_000, undefined, leads);
    await expect(service.createQuoteFromLead('nope', items())).rejects.toThrow(/not found/);
  });
});
