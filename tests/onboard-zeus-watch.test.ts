import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'onboard-zeus-watch.mjs');

type Call = { method: string; path: string; body: unknown };

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => resolve(data ? JSON.parse(data) : undefined));
  });
}

async function startFakeZeus(): Promise<{ url: string; calls: Call[]; close: () => Promise<void> }> {
  const calls: Call[] = [];
  let declared = false;
  let watch: Record<string, unknown> | undefined;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const path = req.url ?? '';
    calls.push({ method: req.method ?? '', path, body });

    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (req.method === 'GET' && path === '/api/connectors/growth-os') {
      return declared
        ? json(200, { id: 'growth-os', status: 'connected' })
        : json(404, { error: 'not found' });
    }
    if (req.method === 'GET' && path === '/api/watches') {
      return json(200, { watches: watch ? [watch] : [] });
    }
    if (req.method === 'POST' && path === '/api/connectors') {
      declared = true;
      return json(201, { id: 'growth-os', status: 'declared' });
    }
    if (req.method === 'POST' && path === '/api/connectors/growth-os/connect') {
      return json(200, { id: 'growth-os', status: 'connected' });
    }
    if (req.method === 'POST' && path === '/api/watches') {
      watch = { ...(body as Record<string, unknown>), id: 'watch-1', enabled: true, used: { fires: 0, executes: 0 } };
      return json(201, { watch });
    }
    return json(404, { error: 'not found' });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake zeus did not bind a port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  };
}

async function runOnboard(url: string): Promise<string> {
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      ZEUS_URL: url,
      ZEUS_TOKEN: 'zeus-token',
      GROWTH_MCP_URL: 'http://127.0.0.1:8788/mcp',
      GROWTH_MCP_TOKEN: 'mcp-token',
      WATCH_SKILL: 'review',
    },
  });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
  });
  child.stderr.on('data', chunk => {
    output += chunk;
  });
  const [code] = (await once(child, 'close')) as [number | null];
  if (code !== 0) throw new Error(`onboard script exited ${code}: ${output}`);
  return output;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
});

describe('onboard-zeus-watch', () => {
  it('uses dataDomain, sends the MCP token, and does not duplicate a live watch on rerun', async () => {
    const fake = await startFakeZeus();
    closers.push(fake.close);

    const first = await runOnboard(fake.url);
    expect(first).toContain('connector declared');
    expect(first).toContain('watch registered: watch-1');

    const declare = fake.calls.find(call => call.method === 'POST' && call.path === '/api/connectors');
    const register = fake.calls.find(call => call.method === 'POST' && call.path === '/api/watches');
    expect(declare?.body).toMatchObject({
      id: 'growth-os',
      endpoint: 'http://127.0.0.1:8788/mcp',
      permissions: ['mcp:crm.listDueFollowups'],
      token: 'mcp-token',
    });
    expect(register?.body).toMatchObject({
      dataDomain: 'personal',
      predicate: { source: 'connector', op: 'present', field: 'dueCount' },
      connector: { id: 'growth-os', tool: 'crm.listDueFollowups' },
      intent: { skill: 'review', mode: 'plan', maxFanOut: 1 },
    });
    expect((register?.body as Record<string, unknown>).realm).toBeUndefined();

    const second = await runOnboard(fake.url);
    expect(second).toContain('connector already declared (skip');
    expect(second).toContain('watch already registered: watch-1 (skip)');
    expect(fake.calls.filter(call => call.method === 'POST' && call.path === '/api/connectors')).toHaveLength(1);
    expect(fake.calls.filter(call => call.method === 'POST' && call.path === '/api/watches')).toHaveLength(1);
  });
});
