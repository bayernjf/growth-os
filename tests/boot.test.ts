import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertFailClosedBoot, authPosture } from '../src/util/boot.js';

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
    const posture = authPosture({ ...loadConfig(), apiToken: 'tok', outreachCallbackSecret: 'sec' });
    expect(posture).toEqual({
      mode: 'fail-closed',
      researchBearer: 'set',
      callbackSecret: 'set',
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
      searchMode: 'online',
      zeusMode: 'online',
      mailMode: 'smtp',
    });
    expect(posture).toEqual({
      mode: 'fail-closed',
      researchBearer: 'unset',
      callbackSecret: 'unset',
      search: 'online',
      zeus: 'online',
      mail: 'smtp',
    });
  });
});
