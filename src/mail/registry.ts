// Mail port registry. GROWTH_MAIL_MODE=off (default) returns a rejecting port
// so any send fails closed (503); smtp requires host + from, otherwise it also
// rejects (422). Mirrors the search provider and decision port registries.

import type { AppConfig } from '../config.js';
import { Errors, type GrowthError } from '../research/errors.js';
import { SmtpMailAdapter } from './smtp.js';
import type { MailPort } from './types.js';

type ErrorFactory = (message: string) => GrowthError;

class RejectingMailPort implements MailPort {
  readonly name = 'smtp';

  constructor(
    private readonly message: string,
    private readonly makeError: ErrorFactory,
    readonly online: boolean,
  ) {}

  send(): Promise<never> {
    return Promise.reject(this.makeError(this.message));
  }
}

export function createMailPort(config: AppConfig): MailPort {
  if (config.mailMode === 'smtp') {
    if (!config.mailHost || !config.mailFrom) {
      return new RejectingMailPort(
        'GROWTH_MAIL_MODE=smtp requires GROWTH_MAIL_HOST and GROWTH_MAIL_FROM',
        Errors.credentialMissing,
        true,
      );
    }
    return new SmtpMailAdapter({
      host: config.mailHost,
      port: config.mailPort,
      from: config.mailFrom,
      ...(config.mailUser !== undefined ? { user: config.mailUser } : {}),
      ...(config.mailPass !== undefined ? { pass: config.mailPass } : {}),
    });
  }
  return new RejectingMailPort(
    'mail channel disabled (GROWTH_MAIL_MODE=off)',
    Errors.mailUnavailable,
    false,
  );
}
