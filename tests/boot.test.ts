import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertFailClosedBoot, assertMailCompliance, authPosture } from '../src/util/boot.js';

describe('fail-closed boot gate (Tier0 review H1)', () => {
  it('refuses to boot when GROWTH_API_TOKEN is unset', () => {
    expect(() => assertFailClosedBoot(undefined)).toThrowError(/GROWTH_API_TOKEN/);
  });

  it('refuses to boot when GROWTH_API_TOKEN is an empty string', () => {
    expect(() => assertFailClosedBoot('')).toThrowError(/fail-closed/);
  });

  it('accepts boot when a token is configured', () => {
    expect(() => assertFailClosedBoot('tok')).not.toThrow();
  });
});

describe('auth posture log line', () => {
  it('reports set guards and channel modes from config', () => {
    const posture = authPosture({
      ...loadConfig(),
      apiToken: 'tok',
      outreachCallbackSecret: 'sec',
      mailUnsubscribeSecret: 'usec',
      mcpToken: 'mtok',
    });
    expect(posture).toEqual({
      mode: 'fail-closed',
      researchBearer: 'set',
      callbackSecret: 'set',
      unsubscribe: 'set',
      mcp: 'set',
      search: 'offline',
      zeus: 'off',
      mail: 'off',
    });
  });

  it('reports unset guards so operators can spot a degraded posture', () => {
    const posture = authPosture({
      ...loadConfig(),
      apiToken: undefined,
      outreachCallbackSecret: undefined,
      mailUnsubscribeSecret: undefined,
      mcpToken: undefined,
      searchMode: 'online',
      zeusMode: 'online',
      mailMode: 'smtp',
    });
    expect(posture).toEqual({
      mode: 'fail-closed',
      researchBearer: 'unset',
      callbackSecret: 'unset',
      unsubscribe: 'unset',
      mcp: 'unset',
      search: 'online',
      zeus: 'online',
      mail: 'smtp',
    });
  });
});

describe('mail compliance gate (T-G3-07, design §14.2.1)', () => {
  it('passes when the mail channel is off', () => {
    expect(() => assertMailCompliance(loadConfig())).not.toThrow();
  });

  it('refuses to boot with smtp but no sender identity', () => {
    const config = {
      ...loadConfig(),
      mailMode: 'smtp' as const,
      mailIdentity: undefined,
      mailUnsubscribeBaseUrl: 'https://x.test/pub/v1/outreach/unsubscribe',
      mailUnsubscribeSecret: 's',
    };
    expect(() => assertMailCompliance(config)).toThrowError(/GROWTH_MAIL_IDENTITY/);
  });

  it('refuses to boot with smtp but no unsubscribe base URL', () => {
    const config = {
      ...loadConfig(),
      mailMode: 'smtp' as const,
      mailIdentity: 'BayJF',
      mailUnsubscribeBaseUrl: undefined,
      mailUnsubscribeSecret: 's',
    };
    expect(() => assertMailCompliance(config)).toThrowError(/GROWTH_MAIL_UNSUBSCRIBE_BASE_URL/);
  });

  it('refuses to boot with smtp but no unsubscribe secret', () => {
    const config = {
      ...loadConfig(),
      mailMode: 'smtp' as const,
      mailIdentity: 'BayJF',
      mailUnsubscribeBaseUrl: 'https://x.test/pub/v1/outreach/unsubscribe',
      mailUnsubscribeSecret: undefined,
    };
    expect(() => assertMailCompliance(config)).toThrowError(/GROWTH_MAIL_UNSUBSCRIBE_SECRET/);
  });

  it('accepts smtp boot when all compliance settings are present', () => {
    const config = {
      ...loadConfig(),
      mailMode: 'smtp' as const,
      mailIdentity: 'BayJF',
      mailUnsubscribeBaseUrl: 'https://x.test/pub/v1/outreach/unsubscribe',
      mailUnsubscribeSecret: 's',
    };
    expect(() => assertMailCompliance(config)).not.toThrow();
  });
});
