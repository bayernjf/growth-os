import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createResearchApp } from './api/research-http.js';
import { PostgresDriver } from './storage/postgres/postgres-driver.js';
import { migrateUp } from './storage/migrate.js';
import type { StorageDriver } from './storage/driver.js';
import { SqliteDriver } from './storage/sqlite/sqlite-driver.js';
import { createSearchProvider } from './research/provider/registry.js';
import { ResearchRepository } from './research/repository.js';
import { ResearchService } from './research/research-service.js';

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
  const service = new ResearchService({ repo, provider, scoring: config.scoring });
  const app = createResearchApp({ service, apiToken: config.apiToken });

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
