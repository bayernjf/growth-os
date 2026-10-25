// ZeusDecisionAdapter: DecisionPort over zeus-client (transport-only bearer
// client for the Decision API v1). Maps zeus-client errors into growth-os
// GrowthError so the send flow can fail closed without leaking zeus internals.

import { ZeusClient, ZeusClientError } from 'zeus-client';
import type { DecisionRecord, DecisionRequest, DecisionResponse } from 'zeus-client';
import { Errors } from '../research/errors.js';
import type { DecisionPort } from './types.js';

export class ZeusDecisionAdapter implements DecisionPort {
  readonly name = 'zeus';
  readonly online = true;
  private readonly client: ZeusClient;

  constructor(baseUrl: string, token: string) {
    this.client = new ZeusClient({ baseUrl, token });
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    try {
      return await this.client.decide(request);
    } catch (err) {
      throw mapZeusError(err);
    }
  }

  async getDecision(id: string): Promise<DecisionRecord> {
    try {
      return await this.client.getDecision(id);
    } catch (err) {
      throw mapZeusError(err);
    }
  }
}

function mapZeusError(err: unknown): never {
  if (err instanceof ZeusClientError) {
    // Network error, timeout, 401/5xx and any non-2xx all mean the decision
    // backend is unavailable: fail closed (503, retryable) rather than guessing.
    throw Errors.decisionUnavailable(
      `zeus decision backend unavailable: ${err.code} (${err.status})`,
    );
  }
  throw err;
}
