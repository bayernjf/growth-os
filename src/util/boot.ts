// Fail-closed boot gate and auth-posture description (Tier0 review
// 2026-10-30, H1). /api/v1 routes are guarded by a Bearer token, so the
// server must refuse to boot when no token is configured instead of
// starting wide open. Both helpers are side-effect-free and unit-testable;
// serve.ts turns a gate throw into a non-zero exit.

import type { AppConfig } from '../config.js';

export function assertFailClosedBoot(apiToken: string | undefined): asserts apiToken is string {
  if (!apiToken) {
    throw new Error(
      'GROWTH_API_TOKEN is not configured: /api/v1 auth is fail-closed, refusing to start with the HTTP API open',
    );
  }
}

export interface AuthPosture {
  mode: 'fail-closed';
  /** Bearer guard on /api/v1 (research/crm/outreach/match). */
  researchBearer: 'set' | 'unset';
  /** HMAC secret for bounce/reply receipt callbacks. */
  callbackSecret: 'set' | 'unset';
  search: 'offline' | 'online';
  zeus: 'off' | 'online';
  mail: 'off' | 'smtp';
}

/** Pure description of the boot authorization posture for the startup log. */
export function authPosture(
  config: Pick<AppConfig, 'apiToken' | 'outreachCallbackSecret' | 'searchMode' | 'zeusMode' | 'mailMode'>,
): AuthPosture {
  return {
    mode: 'fail-closed',
    researchBearer: config.apiToken ? 'set' : 'unset',
    callbackSecret: config.outreachCallbackSecret ? 'set' : 'unset',
    search: config.searchMode,
    zeus: config.zeusMode,
    mail: config.mailMode,
  };
}
