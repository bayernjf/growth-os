// sales/decision.ts: sales-side zeus grading policy (OP-13). Quotes at or above
// a configurable threshold require a zeus decision (D2 human approval); below
// the threshold they proceed automatically (D0). growth-os never grades
// locally: an unavailable/misconfigured decision backend fails closed.

import type { DecisionPort } from '../decision/types.js';
import type { Amount } from 'zeus-client';

export interface SalesGateResult {
  required: boolean;
  decisionId?: string;
  grade?: string;
}

export interface SalesGateDeps {
  decision: DecisionPort;
  /** Quotes with amount_cents >= this threshold go through zeus grading. */
  thresholdCents: number;
}

export interface SalesGateSendInput {
  quoteId: string;
  leadId?: string | undefined;
  amountCents: number;
  currency: string;
}

export class SalesDecisionGate {
  private readonly decision: DecisionPort;
  private readonly thresholdCents: number;

  constructor(deps: SalesGateDeps) {
    this.decision = deps.decision;
    this.thresholdCents = deps.thresholdCents;
  }

  /**
   * Submit the "send quote" action for grading. Low-value quotes auto-pass with
   * no outbound call. High-value quotes always call zeus; when zeus is
   * unavailable the port rejects (503) so the quote is never sent unapproved.
   */
  async gateSendQuote(input: SalesGateSendInput): Promise<SalesGateResult> {
    if (input.amountCents < this.thresholdCents) {
      return { required: false };
    }
    const amount: Amount = { value: input.amountCents / 100, currency: input.currency };
    const decision = await this.decision.decide({
      intent: 'sales_quote_send',
      domain: 'sales',
      amount,
      impact: 'external',
      reversibility: 'hard',
      riskTags: ['quote', 'commercial_offer'],
      proposal: { quoteId: input.quoteId, leadId: input.leadId, amountCents: input.amountCents },
      idempotencyKey: `quote-send:${input.quoteId}`,
    });
    return { required: true, decisionId: decision.decisionId, grade: decision.grade };
  }

  /** True when a submitted zeus decision has reached a final "approved" state. */
  async isApproved(decisionId: string): Promise<boolean> {
    const record = await this.decision.getDecision(decisionId);
    if (record.status === 'decided') {
      return record.result?.outcome === 'approved' || record.result?.outcome === 'auto';
    }
    return false;
  }
}
