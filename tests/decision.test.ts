import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createDecisionPort } from '../src/decision/registry.js';
import { ZeusDecisionAdapter } from '../src/decision/zeus.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDecisionPort fail-closed', () => {
  it('off mode rejects decide with DECISION_UNAVAILABLE (no outbound)', async () => {
    const p = createDecisionPort({ ...loadConfig(), zeusMode: 'off' as const });
    expect(p.online).toBe(false);
    await expect(
      p.decide({ intent: 'email_outreach', domain: 'outreach', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE', status: 503 });
  });

  it('online without credentials rejects with CREDENTIAL_MISSING 422', async () => {
    const p = createDecisionPort({
      ...loadConfig(),
      zeusMode: 'online' as const,
      zeusUrl: undefined,
      zeusToken: undefined,
    });
    expect(p.online).toBe(true);
    await expect(
      p.decide({ intent: 'email_outreach', domain: 'outreach' }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_MISSING', status: 422 });
  });

  it('online with credentials returns a live adapter', () => {
    const p = createDecisionPort({
      ...loadConfig(),
      zeusMode: 'online' as const,
      zeusUrl: 'http://z.example',
      zeusToken: 'secret',
    });
    expect(p.online).toBe(true);
    expect(p.name).toBe('zeus');
  });
});

describe('ZeusDecisionAdapter', () => {
  it('decide returns the graded decision response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          decisionId: 'd1',
          grade: 'D2',
          mode: 'approve-sync',
          status: 'awaiting_approval',
          ruleId: 'r1',
          auditSeq: 1,
        }),
      })),
    );
    const p = new ZeusDecisionAdapter('http://z.example', 'secret');
    const res = await p.decide({ intent: 'email_outreach', domain: 'outreach' });
    expect(res.grade).toBe('D2');
    expect(res.status).toBe('awaiting_approval');
    expect(res.decisionId).toBe('d1');
  });

  it('maps network failure to DECISION_UNAVAILABLE 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))));
    const p = new ZeusDecisionAdapter('http://z.example', 'secret');
    await expect(
      p.decide({ intent: 'email_outreach', domain: 'outreach' }),
    ).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE', status: 503, retryable: true });
  });

  it('maps non-2xx responses to DECISION_UNAVAILABLE 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, text: async () => '{"code":"SERVER_ERROR"}' })),
    );
    const p = new ZeusDecisionAdapter('http://z.example', 'secret');
    await expect(
      p.decide({ intent: 'email_outreach', domain: 'outreach' }),
    ).rejects.toMatchObject({ code: 'DECISION_UNAVAILABLE', status: 503 });
  });
});
