import { describe, it, expect, vi } from 'vitest';
import { createMcpApp } from '../src/api/mcp-http.js';

// The default's `never[]` return type poisons object-literal fixtures passed
// in later tests (TS2322), so pin the structural shape instead (Tier0 review
// 2026-10-30 H3: the branch went red because typecheck never ran on it).
type FollowupSource = { listDueFollowups: () => Promise<unknown[]> };

function app(service: FollowupSource = { listDueFollowups: async () => [] }, mcpToken: string | undefined = 'tok') {
  return createMcpApp({ service: service as never, mcpToken });
}

async function rpc(
  a: ReturnType<typeof app>,
  body: Record<string, unknown>,
  token: string | undefined = 'tok',
) {
  const res = await a.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('mcp streamable-http server', () => {
  it('initialize returns protocol version and server info', async () => {
    const { status, body } = await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(status).toBe(200);
    expect((body.result as Record<string, unknown>).protocolVersion).toBe('2025-03-26');
    expect(((body.result as Record<string, unknown>).serverInfo as Record<string, unknown>).name).toBe('growth-os');
  });

  it('tools/list exposes only crm.listDueFollowups', async () => {
    const { body } = await rpc(app(), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['crm.listDueFollowups']);
  });

  it('tools/call returns structured dueCount + followups', async () => {
    const followups = [
      { id: 'fu1', leadId: 'lead1', action: 'call', note: '', sourceSignalIds: [], createdAt: '2026-10-29T00:00:00Z' },
    ];
    const { body } = await rpc(app({ listDueFollowups: async () => followups }), {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'crm.listDueFollowups' },
    });
    const result = body.result as { dueCount: number; followups: unknown[] };
    expect(result.dueCount).toBe(1);
    expect(result.followups).toHaveLength(1);
  });

  it('rejects an unknown tool', async () => {
    const { body } = await rpc(app(), {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'other.tool' },
    });
    expect(body.error).toBeDefined();
  });

  it('returns a generic ProblemDetails 500 without echoing unknown exception text', async () => {
    // Tier0 review 2026-10-30 H2: a service exception escaping tools/call
    // must not leak driver or table details through the JSON-RPC body.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = app({
      listDueFollowups: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:5432 — relation leads missing');
      },
    });
    try {
      const { status, body } = await rpc(failing, {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'crm.listDueFollowups' },
      });
      expect(status).toBe(500);
      const raw = JSON.stringify(body);
      expect(body).toMatchObject({ type: 'about:blank', status: 500, detail: 'internal error' });
      expect(raw).not.toContain('ECONNREFUSED');
      expect(raw).not.toContain('leads missing');
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls.map((args) => args.map(String).join(' ')).join(' ')).toContain('relation leads missing');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('fails closed when no mcp token is configured (P2-2)', async () => {
    const open = createMcpApp({
      service: { listDueFollowups: async () => [] } as never,
      mcpToken: undefined,
    });
    const { status, body } = await rpc(open, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined);
    expect(status).toBe(401);
    expect(body.error).toMatchObject({ code: -32001, message: expect.stringContaining('not configured') });
  });

  it('rejects a wrong mcp token', async () => {
    const { status } = await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'wrong');
    expect(status).toBe(401);
  });

  it('accepts the configured mcp token', async () => {
    const { status, body } = await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'tok');
    expect(status).toBe(200);
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['crm.listDueFollowups']);
  });
});
