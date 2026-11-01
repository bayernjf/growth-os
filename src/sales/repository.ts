// sales/repository.ts: dialect-agnostic persistence for quotes, contracts and
// orders. State transitions and their audit events are written in one
// transaction (same discipline as CrmRepository.transitionLeadStatus).

import type { StorageDriver } from '../storage/driver.js';
import { newId } from '../util/hash.js';
import type {
  Contract,
  ContractStatus,
  Invoice,
  Order,
  OrderEvent,
  Quote,
  QuoteEvent,
  QuoteLineItem,
  QuoteStatus,
} from './types.js';

interface QuoteRow {
  id: string;
  lead_id: string | null;
  customer_name: string;
  customer_email: string;
  line_items: string;
  amount_cents: number;
  currency: string;
  status: string;
  decision_id: string | null;
  note: string;
  sent_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface QuoteEventRow {
  id: string;
  quote_id: string;
  from_status: string;
  to_status: string;
  note: string;
  decision_id: string | null;
  created_at: string;
}

interface ContractRow {
  id: string;
  quote_id: string;
  terms_snapshot: string;
  status: string;
  decision_id: string | null;
  note: string;
  sent_at: string | null;
  signed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  order_no: string;
  quote_id: string;
  contract_id: string | null;
  amount_cents: number;
  currency: string;
  delivery_status: string;
  invoice_ref: string | null;
  note: string;
  delivered_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderEventRow {
  id: string;
  order_id: string;
  from_status: string;
  to_status: string;
  kind: string;
  note: string;
  created_at: string;
}

interface InvoiceRow {
  id: string;
  order_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  external_ref: string | null;
  issued_at: string;
  created_at: string;
  updated_at: string;
}

function mapItems(raw: string): QuoteLineItem[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((i) => {
    const o = (i ?? {}) as Record<string, unknown>;
    return {
      description: String(o.description ?? ''),
      qty: Number(o.qty),
      unitAmountCents: Number(o.unitAmountCents ?? o.unit_amount_cents),
      currency: String(o.currency),
    };
  });
}

export class SalesRepository {
  constructor(private readonly driver: StorageDriver) {}

  // ---------- quotes ----------

  async insertQuote(input: {
    id: string;
    leadId?: string;
    customerName: string;
    customerEmail: string;
    lineItems: QuoteLineItem[];
    amountCents: number;
    currency: string;
    note: string;
    now: string;
  }): Promise<Quote> {
    await this.driver.run(
      `INSERT INTO quotes
        (id,lead_id,customer_name,customer_email,line_items,amount_cents,currency,status,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'draft',?,?,?)`,
      [
        input.id,
        input.leadId ?? null,
        input.customerName,
        input.customerEmail,
        JSON.stringify(input.lineItems),
        input.amountCents,
        input.currency,
        input.note,
        input.now,
        input.now,
      ],
    );
    return this.getQuote(input.id).then((q) => {
      if (!q) throw new Error(`quote ${input.id} vanished after insert`);
      return q;
    });
  }

  async getQuote(id: string): Promise<Quote | undefined> {
    const row = await this.driver.get<QuoteRow>('SELECT * FROM quotes WHERE id = ?', [id]);
    return row ? this.mapQuote(row) : undefined;
  }

  async listQuotes(): Promise<Quote[]> {
    const rows = await this.driver.all<QuoteRow>('SELECT * FROM quotes ORDER BY created_at DESC');
    return rows.map((r) => this.mapQuote(r));
  }

  /**
   * Transition a quote and append its event atomically. Returns 0 (nothing
   * written) when the quote is missing, preserving update-count semantics.
   */
  async transitionQuote(input: {
    id: string;
    toStatus: QuoteStatus;
    note: string;
    decisionId?: string;
    stampColumn?: 'sent_at' | 'accepted_at' | 'rejected_at';
    now: string;
  }): Promise<{ changes: number; fromStatus?: QuoteStatus }> {
    return this.driver.transaction(async (tx) => {
      const row = await tx.get<QuoteRow>('SELECT * FROM quotes WHERE id = ?', [input.id]);
      if (!row) return { changes: 0 };
      const fromStatus = row.status as QuoteStatus;
      const stamp = input.stampColumn ? `, ${input.stampColumn} = ?` : '';
      const params: unknown[] = [input.toStatus];
      if (input.stampColumn) params.push(input.now);
      if (input.decisionId) params.push(input.decisionId);
      params.push(input.note, input.now, input.id);
      const result = await tx.run(
        `UPDATE quotes SET status = ?${stamp}${input.decisionId ? ', decision_id = ?' : ''}, note = ?, updated_at = ? WHERE id = ?`,
        params,
      );
      await tx.run(
        `INSERT INTO quote_events (id,quote_id,from_status,to_status,note,decision_id,created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          newId('qev'),
          input.id,
          fromStatus,
          input.toStatus,
          input.note,
          input.decisionId ?? null,
          input.now,
        ],
      );
      return { changes: result.changes, fromStatus };
    });
  }

  /** Persist a zeus decision id without changing quote status (pending gate). */
  async attachQuoteDecision(id: string, decisionId: string, note: string, now: string): Promise<number> {
    const result = await this.driver.run(
      'UPDATE quotes SET decision_id = ?, note = ?, updated_at = ? WHERE id = ?',
      [decisionId, note, now, id],
    );
    await this.driver.run(
      `INSERT INTO quote_events (id,quote_id,from_status,to_status,note,decision_id,created_at)
       VALUES (?,?, 'draft', 'draft', ?, ?, ?)`,
      [newId('qev'), id, note, decisionId, now],
    );
    return result.changes;
  }

  async listQuoteEvents(quoteId: string): Promise<QuoteEvent[]> {    const rows = await this.driver.all<QuoteEventRow>(
      'SELECT * FROM quote_events WHERE quote_id = ? ORDER BY created_at ASC',
      [quoteId],
    );
    return rows.map((r) => ({
      id: r.id,
      quoteId: r.quote_id,
      fromStatus: r.from_status as QuoteStatus,
      toStatus: r.to_status as QuoteStatus,
      note: r.note,
      ...(r.decision_id ? { decisionId: r.decision_id } : {}),
      createdAt: r.created_at,
    }));
  }

  // ---------- contracts ----------

  async insertContract(input: {
    id: string;
    quoteId: string;
    termsSnapshot: Record<string, unknown>;
    note: string;
    now: string;
  }): Promise<Contract> {
    await this.driver.run(
      `INSERT INTO contracts (id,quote_id,terms_snapshot,status,note,created_at,updated_at)
       VALUES (?,?,?,'draft',?,?,?)`,
      [input.id, input.quoteId, JSON.stringify(input.termsSnapshot), input.note, input.now, input.now],
    );
    return this.getContract(input.id).then((c) => {
      if (!c) throw new Error(`contract ${input.id} vanished after insert`);
      return c;
    });
  }

  async getContract(id: string): Promise<Contract | undefined> {
    const row = await this.driver.get<ContractRow>('SELECT * FROM contracts WHERE id = ?', [id]);
    return row ? this.mapContract(row) : undefined;
  }

  async findContractForQuote(quoteId: string): Promise<Contract | undefined> {
    const row = await this.driver.get<ContractRow>(
      'SELECT * FROM contracts WHERE quote_id = ? ORDER BY created_at DESC LIMIT 1',
      [quoteId],
    );
    return row ? this.mapContract(row) : undefined;
  }

  async transitionContract(input: {
    id: string;
    toStatus: ContractStatus;
    note: string;
    decisionId?: string;
    stampColumn?: 'sent_at' | 'signed_at';
    now: string;
  }): Promise<{ changes: number; fromStatus?: ContractStatus }> {
    return this.driver.transaction(async (tx) => {
      const row = await tx.get<ContractRow>('SELECT * FROM contracts WHERE id = ?', [input.id]);
      if (!row) return { changes: 0 };
      const fromStatus = row.status as ContractStatus;
      const stamp = input.stampColumn ? `, ${input.stampColumn} = ?` : '';
      const params: unknown[] = [input.toStatus];
      if (input.stampColumn) params.push(input.now);
      if (input.decisionId) params.push(input.decisionId);
      params.push(input.note, input.now, input.id);
      const result = await tx.run(
        `UPDATE contracts SET status = ?${stamp}${input.decisionId ? ', decision_id = ?' : ''}, note = ?, updated_at = ? WHERE id = ?`,
        params,
      );
      return { changes: result.changes, fromStatus };
    });
  }

  // ---------- orders ----------

  async insertOrder(input: {
    id: string;
    orderNo: string;
    quoteId: string;
    contractId?: string;
    amountCents: number;
    currency: string;
    note: string;
    now: string;
  }): Promise<Order> {
    await this.driver.run(
      `INSERT INTO orders
        (id,order_no,quote_id,contract_id,amount_cents,currency,delivery_status,note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'pending',?,?,?)`,
      [
        input.id,
        input.orderNo,
        input.quoteId,
        input.contractId ?? null,
        input.amountCents,
        input.currency,
        input.note,
        input.now,
        input.now,
      ],
    );
    return this.getOrder(input.id).then((o) => {
      if (!o) throw new Error(`order ${input.id} vanished after insert`);
      return o;
    });
  }

  async getOrder(id: string): Promise<Order | undefined> {
    const row = await this.driver.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [id]);
    return row ? this.mapOrder(row) : undefined;
  }

  async findOrderByNo(orderNo: string): Promise<Order | undefined> {
    const row = await this.driver.get<OrderRow>('SELECT * FROM orders WHERE order_no = ?', [orderNo]);
    return row ? this.mapOrder(row) : undefined;
  }

  async listOrders(): Promise<Order[]> {
    const rows = await this.driver.all<OrderRow>('SELECT * FROM orders ORDER BY created_at DESC');
    return rows.map((r) => this.mapOrder(r));
  }

  async countOrders(): Promise<number> {
    const row = await this.driver.get<{ c: number }>('SELECT COUNT(*) AS c FROM orders');
    return row?.c ?? 0;
  }

  // ---------- order fulfillment (OP-15) ----------

  /**
   * Advance an order's delivery status and append the event atomically.
   * Returns 0 when the order is missing, preserving update-count semantics.
   */
  async transitionOrderDelivery(input: {
    id: string;
    toStatus: Order['deliveryStatus'];
    note: string;
    stampColumn?: 'delivered_at' | 'verified_at';
    now: string;
  }): Promise<{ changes: number; fromStatus?: Order['deliveryStatus'] }> {
    return this.driver.transaction(async (tx) => {
      const row = await tx.get<OrderRow>('SELECT * FROM orders WHERE id = ?', [input.id]);
      if (!row) return { changes: 0 };
      const fromStatus = row.delivery_status as Order['deliveryStatus'];
      const stamp = input.stampColumn ? `, ${input.stampColumn} = ?` : '';
      const params: unknown[] = [input.toStatus];
      if (input.stampColumn) params.push(input.now);
      params.push(input.note, input.now, input.id);
      const result = await tx.run(
        `UPDATE orders SET delivery_status = ?${stamp}, note = ?, updated_at = ? WHERE id = ?`,
        params,
      );
      await tx.run(
        `INSERT INTO order_events (id,order_id,from_status,to_status,kind,note,created_at)
         VALUES (?,?,?,?, 'delivery', ?,?)`,
        [newId('oev'), input.id, fromStatus, input.toStatus, input.note, input.now],
      );
      return { changes: result.changes, fromStatus };
    });
  }

  async listOrderEvents(orderId: string): Promise<OrderEvent[]> {
    const rows = await this.driver.all<OrderEventRow>(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC',
      [orderId],
    );
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      fromStatus: r.from_status as OrderEvent['fromStatus'],
      toStatus: r.to_status as OrderEvent['toStatus'],
      kind: r.kind as OrderEvent['kind'],
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  // ---------- invoices (OP-16) ----------

  async getInvoiceForOrder(orderId: string): Promise<Invoice | undefined> {
    const row = await this.driver.get<InvoiceRow>('SELECT * FROM invoices WHERE order_id = ?', [orderId]);
    return row ? this.mapInvoice(row) : undefined;
  }

  /**
   * Create the invoice from the order's own money fields and link it back in
   * one transaction. Money is server-derived (the caller passes the order);
   * client-supplied amounts never reach this method.
   */
  async issueInvoiceForOrder(input: {
    order: Order;
    externalRef?: string;
    now: string;
  }): Promise<Invoice> {
    return this.driver.transaction(async (tx) => {
      const existing = await tx.get<InvoiceRow>('SELECT * FROM invoices WHERE order_id = ?', [input.order.id]);
      if (existing) return this.mapInvoice(existing);
      const invoice: Invoice = {
        id: newId('inv'),
        orderId: input.order.id,
        amountCents: input.order.amountCents,
        currency: input.order.currency,
        status: 'open',
        ...(input.externalRef ? { externalRef: input.externalRef } : {}),
        issuedAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      };
      await tx.run(
        `INSERT INTO invoices
          (id,order_id,amount_cents,currency,status,external_ref,issued_at,created_at,updated_at)
         VALUES (?,?,?,?,'open',?,?,?,?)`,
        [
          invoice.id,
          invoice.orderId,
          invoice.amountCents,
          invoice.currency,
          invoice.externalRef ?? null,
          invoice.issuedAt,
          invoice.createdAt,
          invoice.updatedAt,
        ],
      );
      await tx.run('UPDATE orders SET invoice_ref = ?, updated_at = ? WHERE id = ?', [
        invoice.id,
        input.now,
        input.order.id,
      ]);
      await tx.run(
        `INSERT INTO order_events (id,order_id,from_status,to_status,kind,note,created_at)
         VALUES (?,?,?,?, 'invoice', ?,?)`,
        [
          newId('oev'),
          input.order.id,
          input.order.deliveryStatus,
          input.order.deliveryStatus,
          `invoice ${invoice.id} issued`,
          input.now,
        ],
      );
      return invoice;
    });
  }

  // ---------- mappers ----------

  private mapQuote(r: QuoteRow): Quote {
    return {
      id: r.id,
      ...(r.lead_id ? { leadId: r.lead_id } : {}),
      customerName: r.customer_name,
      customerEmail: r.customer_email,
      lineItems: mapItems(r.line_items),
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      status: r.status as QuoteStatus,
      ...(r.decision_id ? { decisionId: r.decision_id } : {}),
      note: r.note,
      ...(r.sent_at ? { sentAt: r.sent_at } : {}),
      ...(r.accepted_at ? { acceptedAt: r.accepted_at } : {}),
      ...(r.rejected_at ? { rejectedAt: r.rejected_at } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private mapContract(r: ContractRow): Contract {
    let terms: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(r.terms_snapshot) as unknown;
      if (parsed && typeof parsed === 'object') terms = parsed as Record<string, unknown>;
    } catch {
      terms = {};
    }
    return {
      id: r.id,
      quoteId: r.quote_id,
      termsSnapshot: terms,
      status: r.status as ContractStatus,
      ...(r.decision_id ? { decisionId: r.decision_id } : {}),
      note: r.note,
      ...(r.sent_at ? { sentAt: r.sent_at } : {}),
      ...(r.signed_at ? { signedAt: r.signed_at } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private mapOrder(r: OrderRow): Order {
    return {
      id: r.id,
      orderNo: r.order_no,
      quoteId: r.quote_id,
      ...(r.contract_id ? { contractId: r.contract_id } : {}),
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      deliveryStatus: r.delivery_status as Order['deliveryStatus'],
      ...(r.invoice_ref ? { invoiceRef: r.invoice_ref } : {}),
      note: r.note,
      ...(r.delivered_at ? { deliveredAt: r.delivered_at } : {}),
      ...(r.verified_at ? { verifiedAt: r.verified_at } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private mapInvoice(r: InvoiceRow): Invoice {
    return {
      id: r.id,
      orderId: r.order_id,
      amountCents: Number(r.amount_cents),
      currency: r.currency,
      status: r.status as Invoice['status'],
      ...(r.external_ref ? { externalRef: r.external_ref } : {}),
      issuedAt: r.issued_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
