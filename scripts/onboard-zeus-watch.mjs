#!/usr/bin/env node
// Onboard growth-os's crm.listDueFollowups as a zeus connector watch.
// Idempotent: re-running skips an already-declared connector.
//
// Env:
//   ZEUS_URL            zeus base url (e.g. http://127.0.0.1:8400)
//   ZEUS_TOKEN          zeus bearer token
//   GROWTH_MCP_URL      growth-os mcp endpoint (e.g. http://127.0.0.1:8788/mcp)
//   GROWTH_MCP_TOKEN    (optional) growth-os mcp bearer token
//   WATCH_SKILL         (optional) skill for the reminder intent, default 'review'
//   WATCH_INTERVAL_S    (optional) poll interval seconds, default 60
//   WATCH_FIRES         (optional) fire budget, default 100

const zeusUrl = process.env.ZEUS_URL;
const zeusToken = process.env.ZEUS_TOKEN;
const mcpUrl = process.env.GROWTH_MCP_URL;
const mcpToken = process.env.GROWTH_MCP_TOKEN;
const skill = process.env.WATCH_SKILL ?? 'review';
const intervalSeconds = Number(process.env.WATCH_INTERVAL_S ?? 60);
const fires = Number(process.env.WATCH_FIRES ?? 100);

if (!zeusUrl || !zeusToken || !mcpUrl) {
  console.error('ZEUS_URL, ZEUS_TOKEN, GROWTH_MCP_URL are required');
  process.exit(1);
}

const base = zeusUrl.replace(/\/+$/, '');
const headers = {
  authorization: `Bearer ${zeusToken}`,
  'content-type': 'application/json',
};

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`POST ${path} -> ${res.status}: ${text}`);
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const connector = {
  id: 'growth-os',
  name: 'Growth OS',
  endpoint: mcpUrl,
  permissions: ['mcp:crm.listDueFollowups'],
  ...(mcpToken ? { token: mcpToken } : {}),
};

// 1. declare (idempotent)
try {
  await post('/api/connectors', connector);
  console.log('1. connector declared');
} catch (e) {
  if (String(e.message).includes('already declared')) {
    console.log('1. connector already declared (skip)');
  } else {
    throw e;
  }
}

// 2. connect (MCP handshake)
await post('/api/connectors/growth-os/connect', {});
console.log('2. connector connected (handshake ok)');

// 3. register the source=connector watch
const now = new Date();
const watch = {
  owner: 'operator',
  realm: 'personal',
  predicate: { source: 'connector', op: 'present', field: 'dueCount' },
  connector: { id: 'growth-os', tool: 'crm.listDueFollowups' },
  intent: { skill, subject: 'CRM 回访提醒：有到期跟进', mode: 'plan', maxFanOut: 1 },
  intervalSeconds,
  startsAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 30 * 24 * 3600_000).toISOString(),
  budget: { fires, executes: 0 },
};
const reg = await post('/api/watches', watch);
console.log(`3. watch registered: ${reg.watch.id}`);

console.log('done: growth-os followup watch onboarded to zeus');
