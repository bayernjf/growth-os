// sales/sales-service.ts: quote -> contract -> order workflow with strict
// money validation, state machines and a zeus approval gate on high-value
// quotes (OP-12/13/18). growth-os never grades locally; when the decision
// backend is unavailable a high-value quote fails closed and is not sent.

import { Errors } from '../research/errors.js';
import { newId } from '../util/hash.js';
import type { SalesDecisionGate } from './decision.js';
import { SalesRepository } from './repository.js';
import {
  CONTRACT_TRANSITIONS,
  DELIVERY_TRANSITIONS,
  QUOTE_TRANSITIONS,
  type Contract,
  type Invoice,
  type Order,
  type Quote,
  type QuoteInput,
  type QuoteLineItem,
  type QuoteStatus,
} from './types.js';

/** Minimal lead customer lookup (OP-18); satisfied by CrmRepository in serve. */
export interface LeadCustomerLookup {
  getLeadCustomer(leadId: string): Promise<{ name: string; email: string } | undefined>;
}

export interface SalesServiceDeps {
  repo: SalesRepository;
  gate?: SalesDecisionGate | undefined;
  leads?: LeadCustomerLookup | undefined;
  now?: () => string;
}

export interface PendingApproval {
  pendingApproval: true;
  decisionId: string;
  grade?: string | undefined;
}

export class SalesService {
  private readonly repo: SalesRepository;
  private readonly gate: SalesDecisionGate | undefined;
  private readonly leads: LeadCustomerLookup | undefined;
  private readonly now: () => string;

  constructor(deps: SalesServiceDeps) {
    this.repo = deps.repo;
    this.gate = deps.gate;
    this.leads = deps.leads;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // ---------- quotes ----------

  async createQuote(input: QuoteInput & { leadId?: string }): Promise<Quote> {
    const items = this.normalizeItems(input.lineItems);
    const amountCents = items.reduce((sum, i) => sum + i.qty * i.unitAmountCents, 0);
    const first = items[0];
    if (!first) throw Errors.validation('quote requires at least one line item');
    const now = this.now();
    return this.repo.insertQuote({
      id: newId('quote'),
      ...(input.leadId ? { leadId: input.leadId } : {}),
      customerName: input.customerName?.trim() ?? '',
      customerEmail: input.customerEmail?.trim() ?? '',
      lineItems: items,
      amountCents,
      currency: first.currency,
      note: input.note?.trim() ?? '',
      now,
    });
  }

  /** OP-18: convert a CRM lead directly into a quote, prefilling the customer. */
  async createQuoteFromLead(leadId: string, lineItems: QuoteInput['lineItems']): Promise<Quote> {
    const customer = await this.leads?.getLeadCustomer(leadId);
    if (customer === undefined) {
      throw Errors.notFound(`lead ${leadId}`);
    }
    return this.createQuote({ leadId, customerName: customer.name, customerEmail: customer.email, lineItems });
  }

  async getQuote(id: string): Promise<Quote> {
    const q = await this.repo.getQuote(id);
    if (!q) throw Errors.notFound(`quote ${id}`);
    return q;
  }

  listQuotes(): Promise<Quote[]> {
    return this.repo.listQuotes();
  }

  listQuoteEvents(id: string) {
    return this.repo.listQuoteEvents(id);
  }

  /**
   * Send a quote. Low-value quotes go out immediately; quotes at/above the
   * threshold are graded by zeus first. A D2 grade parks the quote in draft
   * pending human approval (no email goes out); resolveQuoteApproval advances
   * it once zeus returns a verdict.
   */
  async sendQuote(id: string, note = ''): Promise<Quote | PendingApproval> {
    const quote = await this.mustTransitionQuote(id, 'draft', 'sent');
    if (this.gate) {
      const verdict = await this.gate.gateSendQuote({
        quoteId: quote.id,
        ...(quote.leadId ? { leadId: quote.leadId } : {}),
        amountCents: quote.amountCents,
        currency: quote.currency,
      });
      if (verdict.required) {
        const decided = await this.gate.isApproved(verdict.decisionId!);
        if (!decided) {
          // Park in draft awaiting human approval; record the decision but
          // send nothing until resolveQuoteApproval sees a final approval.
          await this.repo.attachQuoteDecision(
            quote.id,
            verdict.decisionId!,
            `grade ${verdict.grade}: awaiting approval`,
            this.now(),
          );
          return { pendingApproval: true, decisionId: verdict.decisionId!, grade: verdict.grade };
        }
      }
    }
    await this.repo.transitionQuote({
      id,
      toStatus: 'sent',
      note,
      stampColumn: 'sent_at',
      now: this.now(),
    });
    return this.getQuote(id);
  }

  /** Poll zeus for a high-value quote parked by sendQuote; advance when decided. */
  async resolveQuoteApproval(id: string): Promise<Quote> {
    const quote = await this.getQuote(id);
    if (quote.status !== 'draft' || !quote.decisionId) {
      throw Errors.conflict(`quote ${id} is not waiting on a decision`);
    }
    if (!this.gate) throw Errors.decisionUnavailable('sales decision gate not configured');
    const approved = await this.gate.isApproved(quote.decisionId);
    if (!approved) {
      throw Errors.conflict(`decision ${quote.decisionId} has no final approval yet`);
    }
    await this.repo.transitionQuote({
      id,
      toStatus: 'sent',
      note: `approved via ${quote.decisionId}`,
      decisionId: quote.decisionId,
      stampColumn: 'sent_at',
      now: this.now(),
    });
    return this.getQuote(id);
  }

  async acceptQuote(id: string, note = ''): Promise<Quote> {
    await this.mustTransitionQuote(id, 'sent', 'accepted');
    await this.repo.transitionQuote({ id, toStatus: 'accepted', note, stampColumn: 'accepted_at', now: this.now() });
    return this.getQuote(id);
  }

  async rejectQuote(id: string, note = ''): Promise<Quote> {
    await this.mustTransitionQuote(id, 'sent', 'rejected');
    await this.repo.transitionQuote({ id, toStatus: 'rejected', note, stampColumn: 'rejected_at', now: this.now() });
    return this.getQuote(id);
  }

  // ---------- contracts ----------

  async createContract(quoteId: string, terms: Record<string, unknown> = {}, note = ''): Promise<Contract> {
    const quote = await this.getQuote(quoteId);
    if (quote.status !== 'accepted') {
      throw Errors.invalidTransition(`cannot contract a ${quote.status} quote (must be accepted)`);
    }
    const existing = await this.repo.findContractForQuote(quoteId);
    if (existing) throw Errors.conflict(`quote ${quoteId} already has contract ${existing.id}`);
    const now = this.now();
    return this.repo.insertContract({
      id: newId('contract'),
      quoteId,
      termsSnapshot: { ...terms, quoteAmountCents: quote.amountCents, currency: quote.currency },
      note,
      now,
    });
  }

  async getContract(id: string): Promise<Contract> {
    const c = await this.repo.getContract(id);
    if (!c) throw Errors.notFound(`contract ${id}`);
    return c;
  }

  async sendContract(id: string, note = ''): Promise<Contract> {
    await this.mustTransitionContract(id, 'draft', 'sent');
    await this.repo.transitionContract({ id, toStatus: 'sent', note, stampColumn: 'sent_at', now: this.now() });
    return this.getContract(id);
  }

  async signContract(id: string, note = ''): Promise<Contract> {
    await this.mustTransitionContract(id, 'sent', 'signed');
    await this.repo.transitionContract({ id, toStatus: 'signed', note, stampColumn: 'signed_at', now: this.now() });
    return this.getContract(id);
  }

  // ---------- orders ----------

  async createOrder(contractId: string, note = ''): Promise<Order> {
    const contract = await this.getContract(contractId);
    if (contract.status !== 'signed') {
      throw Errors.invalidTransition(`cannot order from a ${contract.status} contract (must be signed)`);
    }
    const quote = await this.getQuote(contract.quoteId);
    // One order per signed contract (P2-4): pre-check answers a clean 409 and
    // the partial unique index idx_orders_contract_unique (migration 013) is
    // the backstop so a lost race fails instead of duplicating money.
    const existingForContract = await this.repo.findOrderByContract(contractId);
    if (existingForContract) throw Errors.conflict(`contract ${contractId} already has order ${existingForContract.id}`);
    // The database allocates the number under a write lock (migration 014);
    // a lost race fails on orders.order_no UNIQUE instead of duplicating.
    return this.repo.insertOrderWithNextNo({
      id: newId('order'),
      quoteId: quote.id,
      contractId: contract.id,
      amountCents: quote.amountCents,
      currency: quote.currency,
      note,
      now: this.now(),
    });
  }

  async getOrder(id: string): Promise<Order> {
    const o = await this.repo.getOrder(id);
    if (!o) throw Errors.notFound(`order ${id}`);
    return o;
  }

  listOrders(): Promise<Order[]> {
    return this.repo.listOrders();
  }

  // ---------- fulfillment (OP-15) ----------

  async markDelivered(orderId: string, note = ''): Promise<Order> {
    await this.mustTransitionDelivery(orderId, 'pending', 'delivered');
    await this.repo.transitionOrderDelivery({
      id: orderId,
      toStatus: 'delivered',
      note,
      stampColumn: 'delivered_at',
      now: this.now(),
    });
    return this.getOrder(orderId);
  }

  async markVerified(orderId: string, note = ''): Promise<Order> {
    await this.mustTransitionDelivery(orderId, 'delivered', 'verified');
    await this.repo.transitionOrderDelivery({
      id: orderId,
      toStatus: 'verified',
      note,
      stampColumn: 'verified_at',
      now: this.now(),
    });
    return this.getOrder(orderId);
  }

  listOrderEvents(orderId: string) {
    return this.repo.listOrderEvents(orderId);
  }

  // ---------- invoices (OP-16) ----------

  /**
   * Issue the single local invoice for an order. Amount/currency are copied
   * from the persisted order server-side; a client cannot set them. Issuing
   * twice returns the existing invoice (idempotent).
   */
  async issueInvoice(orderId: string, externalRef?: string): Promise<Invoice> {
    const order = await this.getOrder(orderId);
    return this.repo.issueInvoiceForOrder({
      order,
      ...(externalRef?.trim() ? { externalRef: externalRef.trim() } : {}),
      now: this.now(),
    });
  }

  async getInvoiceForOrder(orderId: string): Promise<Invoice | undefined> {
    await this.getOrder(orderId);
    return this.repo.getInvoiceForOrder(orderId);
  }

  // ---------- internals ----------

  private normalizeItems(raw: QuoteInput['lineItems']): QuoteLineItem[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw Errors.validation('quote requires at least one line item');
    }
    const items: QuoteLineItem[] = raw.map((rawItem) => {
      const description = String(rawItem.description ?? '').trim();
      const qty = Number(rawItem.qty);
      const unit = Number(rawItem.unitAmountCents);
      const currency = String(rawItem.currency ?? '').trim().toUpperCase();
      if (!description) throw Errors.validation('line item requires a description');
      if (!Number.isInteger(qty) || qty <= 0) throw Errors.validation('line item qty must be a positive integer');
      if (!Number.isInteger(unit) || unit < 0) throw Errors.validation('unit amount must be a non-negative integer (cents)');
      if (!currency) throw Errors.validation('line item requires a currency');
      return { description, qty, unitAmountCents: unit, currency };
    });
    const currency = items[0]?.currency;
    if (!currency) throw Errors.validation('quote requires at least one line item');
    if (items.some((i) => i.currency !== currency)) {
      throw Errors.validation('all line items must share one currency');
    }
    return items;
  }

  private async mustTransitionQuote(id: string, from: QuoteStatus, to: QuoteStatus): Promise<Quote> {
    const quote = await this.getQuote(id);
    if (quote.status !== from) {
      throw Errors.invalidTransition(`cannot move quote from ${quote.status} to ${to}`);
    }
    if (!QUOTE_TRANSITIONS[quote.status].includes(to)) {
      throw Errors.invalidTransition(`illegal quote transition ${quote.status} -> ${to}`);
    }
    return quote;
  }

  private async mustTransitionContract(id: string, from: Contract['status'], to: Contract['status']): Promise<Contract> {
    const contract = await this.getContract(id);
    if (contract.status !== from) {
      throw Errors.invalidTransition(`cannot move contract from ${contract.status} to ${to}`);
    }
    if (!CONTRACT_TRANSITIONS[contract.status].includes(to)) {
      throw Errors.invalidTransition(`illegal contract transition ${contract.status} -> ${to}`);
    }
    return contract;
  }

  private async mustTransitionDelivery(
    id: string,
    from: Order['deliveryStatus'],
    to: Order['deliveryStatus'],
  ): Promise<Order> {
    const order = await this.getOrder(id);
    if (order.deliveryStatus !== from) {
      throw Errors.invalidTransition(`cannot move order delivery from ${order.deliveryStatus} to ${to}`);
    }
    if (!DELIVERY_TRANSITIONS[order.deliveryStatus].includes(to)) {
      throw Errors.invalidTransition(`illegal delivery transition ${order.deliveryStatus} -> ${to}`);
    }
    return order;
  }
}
