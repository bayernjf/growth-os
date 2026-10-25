// growth-os G3 decision port: submit outbound actions to the zeus kernel for
// grading. Transport-only: growth-os never grades a decision locally (design §13.2).

import type { DecisionRecord, DecisionRequest, DecisionResponse } from 'zeus-client';

export interface DecisionPort {
  readonly name: string;
  readonly online: boolean;
  /** Create a graded decision for an outbound action. */
  decide(request: DecisionRequest): Promise<DecisionResponse>;
  /** Fetch the current record (status/outcome) for an existing decision. */
  getDecision(id: string): Promise<DecisionRecord>;
}
