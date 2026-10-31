import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createResearchApp } from './api/research-http.js';
import { createCrmApp } from './api/crm-http.js';
import { createLeadImportApp } from './api/lead-import-http.js';
import { CrmRepository } from './crm/repository.js';
import { LeadService } from './crm/lead-service.js';
import { LocalWatch } from './crm/watch.js';
import { PostgresDriver } from './storage/postgres/postgres-driver.js';
import { migrateUp } from './storage/migrate.js';
import type { StorageDriver } from './storage/driver.js';
import { SqliteDriver } from './storage/sqlite/sqlite-driver.js';
import { createSearchProvider } from './research/provider/registry.js';
import { ResearchRepository } from './research/repository.js';
import { ResearchService } from './research/research-service.js';
import { createOutreachApp } from './api/outreach-http.js';
import { createDecisionPort } from './decision/registry.js';
import { createMailPort } from './mail/registry.js';
import { TemplateDraftWriter } from './outreach/content.js';
import { OutreachRepository } from './outreach/repository.js';
import { OutreachService } from './outreach/outreach-service.js';
import { createMatchApp } from './api/match-http.js';
import { MatchRepository } from './match/repository.js';
import { MatchService } from './match/match-service.js';
import { createMcpApp } from './api/mcp-http.js';
import { assertFailClosedBoot, authPosture } from './util/boot.js';

async function createDriver(): Promise<StorageDriver> {
  const config = loadConfig();
  if (config.dbDriver === 'postgres') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for GROWTH_DB_DRIVER=postgres');
    return PostgresDriver.connect(url);
  }
  if (config.sqlitePath !== ':memory:') {
    mkdirSync(dirname(config.sqlitePath), { recursive: true });
  }
  return new SqliteDriver(config.sqlitePath);
}

async function main(): Promise<void> {
  // Load a local .env if present so GROWTH_* settings can live in a file.
  // Kept out of config.ts so unit tests import config without env side effects.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const config = loadConfig();
  // Fail-closed boot gate (Tier0 review 2026-10-30 H1): without a configured
  // bearer token the /api/v1 surface would start wide open, so refuse to boot.
  assertFailClosedBoot(config.apiToken);
  const driver = await createDriver();
  await migrateUp(driver);

  const repo = new ResearchRepository(driver);
  const provider = createSearchProvider(config);
  const researchService = new ResearchService({ repo, provider, scoring: config.scoring });

  const crmRepo = new CrmRepository(driver);
  const crmService = new LeadService({
    repo: crmRepo,
    signals: repo,
    watch: new LocalWatch(crmRepo),
    leadMinScore: config.leadMinScore,
  });

  const outreachRepo = new OutreachRepository(driver);
  const outreachService = new OutreachService({
    repo: outreachRepo,
    leads: crmRepo,
    writer: new TemplateDraftWriter(),
    decision: createDecisionPort(config),
    mail: createMailPort(config),
  });

  const matchRepo = new MatchRepository(driver);
  const matchService = new MatchService({ repo: matchRepo, outreach: outreachService });

  const app = new Hono();
  app.route('/', createResearchApp({ service: researchService, apiToken: config.apiToken }));
  app.route('/', createCrmApp({ service: crmService, apiToken: config.apiToken }));
  app.route('/', createLeadImportApp({ service: crmService, apiToken: config.apiToken }));
  app.route('/', createOutreachApp({ service: outreachService, apiToken: config.apiToken, callbackSecret: config.outreachCallbackSecret }));
  app.route('/', createMatchApp({ service: matchService, apiToken: config.apiToken }));
  app.route('/', createMcpApp({ service: crmService, mcpToken: config.mcpToken }));

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    // One line stating the current authorization posture so operators can
    // tell from boot logs which guards are active (Tier0 review H1).
    const posture = authPosture(config);
    console.log(
      `growth-os auth posture: mode=${posture.mode} researchBearer=${posture.researchBearer} ` +
        `callbackSecret=${posture.callbackSecret} search=${posture.search} zeus=${posture.zeus} mail=${posture.mail}`,
    );
    console.log(
      `growth-os listening on http://${config.host}:${config.port} (search=${config.searchMode}, db=${config.dbDriver})`,
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
