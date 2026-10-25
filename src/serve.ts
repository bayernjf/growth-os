import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createResearchApp } from './api/research-http.js';
import { createCrmApp } from './api/crm-http.js';
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
  const config = loadConfig();
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
  const matchService = new MatchService({ repo: matchRepo });

  const app = new Hono();
  app.route('/', createResearchApp({ service: researchService, apiToken: config.apiToken }));
  app.route('/', createCrmApp({ service: crmService, apiToken: config.apiToken }));
  app.route('/', createOutreachApp({ service: outreachService, apiToken: config.apiToken }));
  app.route('/', createMatchApp({ service: matchService, apiToken: config.apiToken }));

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    console.log(
      `growth-os listening on http://${config.host}:${config.port} (search=${config.searchMode}, db=${config.dbDriver})`,
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
