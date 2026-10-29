import { describe, it, expect } from 'vitest';
import { createMcpApp } from '../src/api/mcp-http.js';

function app(service = { listDueFollowups: async () => [] as never[] }) {
  return createMcpApp({ service: service as never });
}

async function rpc(a: ReturnType<typeof app>, body: Record<string, unknown>) {
  const res = await a.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

  it('enforces the mcp token when configured', async () => {
    const guarded = createMcpApp({
      service: { listDueFollowups: async () => [] } as never,
      mcpToken: 'tok',
    });
    const res = await guarded.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});
