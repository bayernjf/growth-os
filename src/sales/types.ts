// growth-os M1 sales domain (OP-10~14, OP-18): quotes, contracts and orders.
// Money is integer cents with an explicit ISO currency; line items are the
// source of truth and the quote total must equal their sum.

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected';
export type ContractStatus = 'draft' | 'sent' | 'signed';
export type DeliveryStatus = 'pending' | 'delivered' | 'verified';

export interface QuoteLineItem {
  description: string;
  qty: number;
  unitAmountCents: number;
  currency: string;
}

export interface QuoteEvent {
  id: string;
  quoteId: string;
  fromStatus: QuoteStatus;
  toStatus: QuoteStatus;
  note: string;
  decisionId?: string;
  createdAt: string;
}

export interface Quote {
  id: string;
  leadId?: string;
  customerName: string;
  customerEmail: string;
  lineItems: QuoteLineItem[];
  amountCents: number;
  currency: string;
  status: QuoteStatus;
  decisionId?: string;
  note: string;
  sentAt?: string;
  acceptedAt?: string;
  rejectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteInput {
  leadId?: string;
  customerName?: string;
  customerEmail?: string;
  lineItems: Array<{
    description?: string;
    qty?: number;
    unitAmountCents?: number;
    currency?: string;
  }>;
  note?: string;
}

export interface Contract {
  id: string;
  quoteId: string;
  termsSnapshot: Record<string, unknown>;
  status: ContractStatus;
  decisionId?: string;
  note: string;
  sentAt?: string;
  signedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Order {
  id: string;
  orderNo: string;
  quoteId: string;
  contractId?: string;
  amountCents: number;
  currency: string;
  deliveryStatus: DeliveryStatus;
  invoiceRef?: string;
  note: string;
  deliveredAt?: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Legal status transitions for a quote. */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['sent'],
  sent: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
};

/** Legal status transitions for a contract. */
export const CONTRACT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  draft: ['sent'],
  sent: ['signed'],
  signed: [],
};
