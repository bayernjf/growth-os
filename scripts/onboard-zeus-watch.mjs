#!/usr/bin/env node
// Onboard growth-os's crm.listDueFollowups as a zeus connector watch.
// Idempotent: re-running keeps one live connector and one live watch.
//
// Env:
//   ZEUS_URL            zeus base url (e.g. http://127.0.0.1:8400)
//   ZEUS_TOKEN          zeus bearer token
//   GROWTH_MCP_URL      growth-os mcp endpoint (e.g. http://127.0.0.1:8788/mcp)
//   GROWTH_MCP_TOKEN    growth-os mcp bearer token (required: /mcp is fail-closed)
//   WATCH_DATA_DOMAIN   (optional) personal|enterprise, default 'personal'
//   WATCH_SKILL         (optional) skill for the reminder intent, default 'review'
//   WATCH_SUBJECT       (optional) intent subject
//   WATCH_INTERVAL_S    (optional) poll interval seconds, default 60
//   WATCH_FIRES         (optional) fire budget, default 100
//   WATCH_EXPIRES_DAYS  (optional) watch lifetime in days, default 30

const zeusUrl = process.env.ZEUS_URL;
const zeusToken = process.env.ZEUS_TOKEN;
const mcpUrl = process.env.GROWTH_MCP_URL;
const mcpToken = process.env.GROWTH_MCP_TOKEN;
const dataDomain = process.env.WATCH_DATA_DOMAIN ?? 'personal';
const skill = process.env.WATCH_SKILL ?? 'review';
const subject = process.env.WATCH_SUBJECT ?? 'CRM 回访提醒：有到期跟进';
const intervalSeconds = positiveInt('WATCH_INTERVAL_S', 60);
const fires = positiveInt('WATCH_FIRES', 100);
const expiresDays = positiveInt('WATCH_EXPIRES_DAYS', 30);

if (!zeusUrl || !zeusToken || !mcpUrl || !mcpToken) {
  console.error('ZEUS_URL, ZEUS_TOKEN, GROWTH_MCP_URL and GROWTH_MCP_TOKEN are required');
  process.exit(1);
}
if (dataDomain !== 'personal' && dataDomain !== 'enterprise') {
  console.error("WATCH_DATA_DOMAIN must be 'personal' or 'enterprise'");
  process.exit(1);
}

const base = zeusUrl.replace(/\/+$/, '');
const headers = {
  authorization: `Bearer ${zeusToken}`,
  'content-type': 'application/json',
};

async function request(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function getOptional(path) {
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

const connector = {
  id: 'growth-os',
  name: 'Growth OS',
  endpoint: mcpUrl,
  permissions: ['mcp:crm.listDueFollowups'],
  token: mcpToken,
};

// 1. declare (idempotent)
const existingConnector = await getOptional('/api/connectors/growth-os');
if (existingConnector) {
  console.log(`1. connector already declared (skip, status=${existingConnector.status})`);
} else {
  await request('POST', '/api/connectors', connector);
  console.log('1. connector declared');
}

// 2. connect (MCP handshake) — safe to rerun against a declared connector.
await request('POST', '/api/connectors/growth-os/connect', {});
console.log('2. connector connected (handshake ok)');

// 3. register the source=connector watch, unless a live one already exists.
const list = await request('GET', '/api/watches');
const now = new Date();
const existingWatch = (list.watches ?? []).find(
  watch =>
    watch.enabled !== false &&
    watch.connector?.id === 'growth-os' &&
    watch.connector?.tool === 'crm.listDueFollowups' &&
    watch.predicate?.source === 'connector' &&
    watch.predicate?.field === 'dueCount' &&
    (watch.expiresAt === undefined || Date.parse(watch.expiresAt) > now.getTime()),
);

if (existingWatch) {
  console.log(`3. watch already registered: ${existingWatch.id} (skip)`);
} else {
  const watch = {
    owner: 'operator',
    dataDomain,
    predicate: { source: 'connector', op: 'present', field: 'dueCount' },
    connector: { id: 'growth-os', tool: 'crm.listDueFollowups' },
    intent: { skill, subject, mode: 'plan', maxFanOut: 1 },
    intervalSeconds,
    startsAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresDays * 24 * 3600_000).toISOString(),
    budget: { fires, executes: 0 },
  };
  const reg = await request('POST', '/api/watches', watch);
  console.log(`3. watch registered: ${reg.watch.id}`);
}

console.log('done: growth-os followup watch onboarded to zeus');
