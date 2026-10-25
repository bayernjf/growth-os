// growth-os G2 watch port (回访提醒). G2 ships a local stub; the real
// integration reuses zeus DelegationContract / daemon tick and escalates
// back to the human on limit breach.

import type { LeadFollowup } from './types.js';

export interface WatchPort {
  /** Followups that are due (due_at <= now) and not yet done. */
  listDue(now: string): Promise<LeadFollowup[]>;
}

export class LocalWatch implements WatchPort {
  constructor(
    private readonly repo: {
      listDueFollowups(now: string): Promise<LeadFollowup[]>;
    },
  ) {}

  listDue(now: string): Promise<LeadFollowup[]> {
    return this.repo.listDueFollowups(now);
  }
}
