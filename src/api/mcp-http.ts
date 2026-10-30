import { Hono } from 'hono';
import type { LeadService } from '../crm/lead-service.js';
import { secureEqual } from '../util/hash.js';

export interface McpAppDeps {
  service: LeadService;
  mcpToken?: string | undefined;
}

const PROTOCOL_VERSION = '2025-03-26';

// Minimal MCP streamable-HTTP server (JSON-RPC 2.0 over POST). Exposes exactly
// one read-only tool — crm.listDueFollowups — for the zeus connector watch.
// tools/call returns a structured result (not content-wrapped) so zeus can read
// `dueCount` through its bounded dot-path reader.
export function createMcpApp(deps: McpAppDeps): Hono {
  const app = new Hono();

  app.post('/mcp', async (c) => {
    if (deps.mcpToken) {
      const header = c.req.header('Authorization') ?? '';
      if (!secureEqual(header, `Bearer ${deps.mcpToken}`)) {
        return c.json(
          { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } },
          401,
        );
      }
    }

    const body = (await c.req.json().catch(() => null)) as {
      id?: number | string | null;
      method?: string;
      params?: Record<string, unknown>;
    } | null;
    const id = body?.id ?? null;
    const method = body?.method ?? '';

    const result = (value: unknown) => c.json({ jsonrpc: '2.0', id, result: value });
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        return result({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'growth-os', version: '0.1.0' },
        });
      case 'notifications/initialized':
        // Notification: no id, empty 202.
        return new Response(null, { status: 202 });
      case 'tools/list':
        return result({
          tools: [
            {
              name: 'crm.listDueFollowups',
              description: 'List due (past due_at, not yet done) CRM followups.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      case 'tools/call': {
        const name = body?.params?.name;
        if (name !== 'crm.listDueFollowups') {
          return rpcError(-32602, `unknown tool: ${String(name)}`);
        }
        const followups = await deps.service.listDueFollowups();
        return result({ dueCount: followups.length, followups });
      }
      default:
        return rpcError(-32601, `method not found: ${method}`);
    }
  });

  return app;
}
