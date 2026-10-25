// growth-os error codes (aligned with the Tier0 error body convention).

export type GrowthErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'CREDENTIAL_MISSING'
  | 'SEARCH_UNAVAILABLE'
  | 'DECISION_UNAVAILABLE'
  | 'MAIL_UNAVAILABLE'
  | 'INVALID_TRANSITION';

export class GrowthError extends Error {
  readonly code: GrowthErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: GrowthErrorCode,
    message: string,
    status: number,
    retryable = false,
    details?: unknown,
  ) {
    super(message);
    this.name = 'GrowthError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }

  toBody(): { code: string; message: string; retryable: boolean; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export const Errors = {
  validation: (message: string, details?: unknown) =>
    new GrowthError('VALIDATION_FAILED', message, 400, false, details),
  notFound: (what: string) => new GrowthError('NOT_FOUND', `${what} not found`, 404),
  conflict: (message: string) => new GrowthError('CONFLICT', message, 409),
  invalidTransition: (message: string) => new GrowthError('INVALID_TRANSITION', message, 409),
  credentialMissing: (message: string) =>
    new GrowthError('CREDENTIAL_MISSING', message, 422),
  searchUnavailable: (message: string) =>
    new GrowthError('SEARCH_UNAVAILABLE', message, 503, true),
  decisionUnavailable: (message: string) =>
    new GrowthError('DECISION_UNAVAILABLE', message, 503, true),
  mailUnavailable: (message: string) =>
    new GrowthError('MAIL_UNAVAILABLE', message, 503, true),
};
