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

/**
 * T-G3-07 compliance gate (design §14.2.1): every outbound email must carry a
 * usable one-click unsubscribe link and a sender identity. A configured SMTP
 * channel therefore requires the unsubscribe base URL, the unsubscribe token
 * secret and the sender identity statement; without them the server refuses
 * to boot rather than sending non-compliant mail.
 */
export function assertMailCompliance(
  config: Pick<AppConfig, 'mailMode' | 'mailIdentity' | 'mailUnsubscribeBaseUrl' | 'mailUnsubscribeSecret'>,
): void {
  if (config.mailMode !== 'smtp') return;
  const missing: string[] = [];
  if (!config.mailIdentity) missing.push('GROWTH_MAIL_IDENTITY');
  if (!config.mailUnsubscribeBaseUrl) missing.push('GROWTH_MAIL_UNSUBSCRIBE_BASE_URL');
  if (!config.mailUnsubscribeSecret) missing.push('GROWTH_MAIL_UNSUBSCRIBE_SECRET');
  if (missing.length > 0) {
    throw new Error(
      `GROWTH_MAIL_MODE=smtp requires compliance config (design §14.2.1): ${missing.join(', ')}; ` +
        'every outbound email needs a sender identity and a one-click unsubscribe link',
    );
  }
}

export interface AuthPosture {
  mode: 'fail-closed';
  /** Bearer guard on /api/v1 (research/crm/outreach/match). */
  researchBearer: 'set' | 'unset';
  /** HMAC secret for bounce/reply receipt callbacks. */
  callbackSecret: 'set' | 'unset';
  /** HMAC secret for one-click unsubscribe tokens (T-G3-07). */
  unsubscribe: 'set' | 'unset';
  /**
   * Bearer guard on /mcp (2026-11-02 review P2-2). 'unset' is the documented
   * open-for-localhost default (.env.example); it is surfaced here so an
   * operator binding GROWTH_HOST beyond loopback can spot the open endpoint.
   */
  mcp: 'set' | 'unset';
  search: 'offline' | 'online';
  zeus: 'off' | 'online';
  mail: 'off' | 'smtp';
}

/** Pure description of the boot authorization posture for the startup log. */
export function authPosture(
  config: Pick<
    AppConfig,
    | 'apiToken'
    | 'outreachCallbackSecret'
    | 'mailUnsubscribeSecret'
    | 'mcpToken'
    | 'searchMode'
    | 'zeusMode'
    | 'mailMode'
  >,
): AuthPosture {
  return {
    mode: 'fail-closed',
    researchBearer: config.apiToken ? 'set' : 'unset',
    callbackSecret: config.outreachCallbackSecret ? 'set' : 'unset',
    unsubscribe: config.mailUnsubscribeSecret ? 'set' : 'unset',
    mcp: config.mcpToken ? 'set' : 'unset',
    search: config.searchMode,
    zeus: config.zeusMode,
    mail: config.mailMode,
  };
}
