// Decision port registry. GROWTH_ZEUS_MODE=off (default) returns a rejecting
// port so any outbound flow fails closed (503); online requires URL + token,
// otherwise it also rejects (422). Mirrors the search provider registry.

import type { AppConfig } from '../config.js';
import { Errors, type GrowthError } from '../research/errors.js';
import { ZeusDecisionAdapter } from './zeus.js';
import type { DecisionPort } from './types.js';

type ErrorFactory = (message: string) => GrowthError;

class RejectingDecisionPort implements DecisionPort {
  readonly name = 'zeus';

  constructor(
    private readonly message: string,
    private readonly makeError: ErrorFactory,
    readonly online: boolean,
  ) {}

  decide(): Promise<never> {
    return Promise.reject(this.makeError(this.message));
  }

  getDecision(): Promise<never> {
    return Promise.reject(this.makeError(this.message));
  }
}

export function createDecisionPort(config: AppConfig): DecisionPort {
  if (config.zeusMode === 'online') {
    if (!config.zeusUrl || !config.zeusToken) {
      return new RejectingDecisionPort(
        'GROWTH_ZEUS_MODE=online requires GROWTH_ZEUS_URL and GROWTH_ZEUS_TOKEN',
        Errors.credentialMissing,
        true,
      );
    }
    return new ZeusDecisionAdapter(config.zeusUrl, config.zeusToken);
  }
  return new RejectingDecisionPort(
    'zeus decision backend disabled (GROWTH_ZEUS_MODE=off)',
    Errors.decisionUnavailable,
    false,
  );
}
