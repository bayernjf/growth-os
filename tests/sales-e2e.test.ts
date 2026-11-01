import { describe, expect, it } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { SalesRepository } from '../src/sales/repository.js';
import { SalesService } from '../src/sales/sales-service.js';
import { SalesDecisionGate } from '../src/sales/decision.js';
import { CrmRepository } from '../src/crm/repository.js';
import type { DecisionPort } from '../src/decision/types.js';
import type { DecisionRecord, DecisionRequest, DecisionResponse } from 'zeus-client';

const NOW = '2026-11-01T00:00:00Z';

function items() {
  return [
    { description: 'Setup', qty: 1, unitAmountCents: 100_000, currency: 'CNY' },
    { description: 'Seat', qty: 2, unitAmountCents: 50_000, currency: 'CNY' },
  ]; // 2000.00 CNY total
}

/** High-value threshold so the quote takes the D2 path; parked until flipped. */
class ApprovingD2 implements DecisionPort {
  readonly name = 'zeus';
  readonly online = true;
  calls: DecisionRequest[] = [];
  decided = false;
  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    this.calls.push(req);
    return {
      decisionId: 'dec_e2e',
      grade: 'D2',
      mode: 'approve-sync',
      status: 'awaiting_approval',
      ruleId: 'r1',
      auditSeq: 1,
    };
  }
  async getDecision(): Promise<DecisionRecord> {
    return {
      id: 'dec_e2e',
      intent: 'sales_quote_send',
      domain: 'sales',
      impact: 'external',
      reversibility: 'hard',
      grade: 'D2',
      mode: 'approve-sync',
      status: this.decided ? 'decided' : 'awaiting_approval',
      ruleId: 'r1',
      gradeReason: '',
      policyVersion: 1,
      auditSeq: this.decided ? 2 : 1,
      createdAt: NOW,
      updatedAt: NOW,
      approvals: [],
      ...(this.decided ? { result: { outcome: 'approved' as const, at: NOW } } : {}),
    } as DecisionRecord;
  }
}

async function stack() {
  const driver = new SqliteDriver(':memory:');
  await migrateUp(driver);
  const crm = new CrmRepository(driver);
  const repo = new SalesRepository(driver);
  const zeus = new ApprovingD2();
  const gate = new SalesDecisionGate({ decision: zeus, thresholdCents: 100_000 });
  const service = new SalesService({
    repo,
    gate,
    leads: {
      async getLeadCustomer(leadId) {
        const lead = await crm.getLead(leadId);
        return lead ? { name: 'Acme', email: 'buyer@acme.test' } : undefined;
      },
    },
    now: () => NOW,
  });
  return { driver, crm, repo, service, zeus };
}

/** lead -> quote(D2 approve) -> accept -> contract -> sign -> order. */
async function signedOrder(service: SalesService, crm: CrmRepository, zeus?: ApprovingD2) {
  const lead = await crm.createLead({ title: 'Acme AI rollout' }, NOW);
  const quote = await service.createQuoteFromLead(lead.id, items());
  expect(quote.amountCents).toBe(200_000);

  const parked = await service.sendQuote(quote.id);
  expect('pendingApproval' in parked).toBe(true);
  if (zeus) zeus.decided = true;
  await service.resolveQuoteApproval(quote.id);
  await service.acceptQuote(quote.id);

  const contract = await service.createContract(quote.id, { terms: 'net-30' });
  await service.sendContract(contract.id);
  await service.signContract(contract.id);

  return service.createOrder(contract.id);
}

describe('GATE-W2 full chain (OP-17)', () => {
  it('runs lead -> quote(D2) -> contract -> order -> delivered -> verified -> invoice', async () => {
    const { crm, service, zeus } = await stack();
    const order = await signedOrder(service, crm, zeus);
    expect(order.deliveryStatus).toBe('pending');

    const delivered = await service.markDelivered(order.id, 'shipped');
    expect(delivered.deliveryStatus).toBe('delivered');
    expect(delivered.deliveredAt).toBe(NOW);

    const verified = await service.markVerified(order.id, 'accepted by customer');
    expect(verified.deliveryStatus).toBe('verified');
    expect(verified.verifiedAt).toBe(NOW);

    const orderEvents = await service.listOrderEvents(order.id);
    expect(orderEvents.map((e) => e.toStatus)).toEqual(['delivered', 'verified']);

    const invoice = await service.issueInvoice(order.id, 'ext-bill-1');
    expect(invoice.amountCents).toBe(200_000);
    expect(invoice.currency).toBe('CNY');
    expect(invoice.status).toBe('open');
    expect(invoice.externalRef).toBe('ext-bill-1');

    const afterInvoice = await service.getOrder(order.id);
    expect(afterInvoice.invoiceRef).toBe(invoice.id);
    const stored = await service.getInvoiceForOrder(order.id);
    expect(stored?.id).toBe(invoice.id);

    // invoice_created audit event landed after the two delivery events
    const allEvents = await service.listOrderEvents(order.id);
    expect(allEvents.map((e) => e.kind)).toEqual(['delivery', 'delivery', 'invoice']);
  });

  it('refuses to verify an order that has not been delivered (verified terminal)', async () => {
    const { crm, service, zeus } = await stack();
    const order = await signedOrder(service, crm, zeus);
    await expect(service.markVerified(order.id)).rejects.toThrow(/cannot move order delivery/);
    expect((await service.getOrder(order.id)).deliveryStatus).toBe('pending');
  });

  it('does not roll back delivered/verified and rejects a second delivery', async () => {
    const { crm, service, zeus } = await stack();
    const order = await signedOrder(service, crm, zeus);
    await service.markDelivered(order.id);
    await expect(service.markDelivered(order.id)).rejects.toThrow(/illegal delivery transition|cannot move/);
    await service.markVerified(order.id);
    await expect(service.markVerified(order.id)).rejects.toThrow(/cannot move order delivery/);
  });

  it('issues at most one invoice and keeps money identical to the order', async () => {
    const { crm, service, zeus } = await stack();
    const order = await signedOrder(service, crm, zeus);
    const first = await service.issueInvoice(order.id);
    const second = await service.issueInvoice(order.id);
    expect(second.id).toBe(first.id);
    expect(second.amountCents).toBe(order.amountCents);
    expect(second.currency).toBe(order.currency);
  });

  it('cannot order from an unsigned contract', async () => {
    const driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    const repo = new SalesRepository(driver);
    const service = new SalesService({ repo, now: () => NOW });
    const q = await service.createQuote({ customerName: 'A', lineItems: items() });
    await service.sendQuote(q.id);
    await service.acceptQuote(q.id);
    const c = await service.createContract(q.id);
    await service.sendContract(c.id); // not signed
    await expect(service.createOrder(c.id)).rejects.toThrow(/signed/);
  });
});
