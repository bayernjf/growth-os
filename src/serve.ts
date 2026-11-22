import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AppConfig } from './config.js';
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
import { signUnsubscribeToken } from './mail/unsubscribe-token.js';
import type { EmailCompliance } from './mail/templates.js';
import type { ComplianceFactory, DraftWriter } from './outreach/content.js';
import { TemplateDraftWriter } from './outreach/content.js';
import { OutreachRepository } from './outreach/repository.js';
import { OutreachService } from './outreach/outreach-service.js';
import { createMatchApp } from './api/match-http.js';
import { MatchRepository } from './match/repository.js';
import { MatchService } from './match/match-service.js';
import { createMcpApp } from './api/mcp-http.js';
import { SalesRepository } from './sales/repository.js';
import { SalesService, type LeadCustomerLookup } from './sales/sales-service.js';
import { SalesDecisionGate } from './sales/decision.js';
import { createSalesApp } from './api/sales-http.js';
import { assertFailClosedBoot, assertMailCompliance, authPosture } from './util/boot.js';
import { GrowthMetricsService } from './observability/prometheus.js';
import { createMetricsApp } from './api/metrics-http.js';

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

/**
 * Per-recipient compliance footer (T-G3-07, design §14.2.1): every outbound
 * email carries the sender identity and a one-click unsubscribe link bound to
 * the recipient's address with an HMAC token. The boot gate guarantees the
 * three required settings when SMTP is enabled, so the factory never yields
 * undefined in smtp mode.
 */
function complianceFactory(config: AppConfig): ComplianceFactory {
  return (email: string): EmailCompliance | undefined => {
    if (!config.mailIdentity || !config.mailUnsubscribeBaseUrl || !config.mailUnsubscribeSecret) {
      return undefined;
    }
    const token = signUnsubscribeToken(email, config.mailUnsubscribeSecret);
    const separator = config.mailUnsubscribeBaseUrl.includes('?') ? '&' : '?';
    return {
      identity: config.mailIdentity,
      unsubscribeUrl: `${config.mailUnsubscribeBaseUrl}${separator}token=${encodeURIComponent(token)}`,
    };
  };
}

function buildDraftWriter(config: AppConfig): DraftWriter {
  return new TemplateDraftWriter(complianceFactory(config));
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
  // Compliance gate (T-G3-07, design §14.2.1): an SMTP channel without the
  // identity/unsubscribe settings would send non-compliant mail; refuse to boot.
  assertMailCompliance(config);
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
    writer: buildDraftWriter(config),
    decision: createDecisionPort(config),
    mail: createMailPort(config),
  });

  const matchRepo = new MatchRepository(driver);
  const matchService = new MatchService({ repo: matchRepo, outreach: outreachService });

  const decisionPort = createDecisionPort(config);
  const salesRepo = new SalesRepository(driver);
  const leadLookup: LeadCustomerLookup = {
    async getLeadCustomer(leadId) {
      const lead = await crmRepo.getLead(leadId);
      if (!lead) return undefined;
      const contact = lead.contactId ? await crmRepo.getContact(lead.contactId) : undefined;
      return {
        name: contact?.name ?? lead.title,
        email: contact?.email ?? '',
      };
    },
  };
  const salesService = new SalesService({
    repo: salesRepo,
    gate: new SalesDecisionGate({ decision: decisionPort, thresholdCents: config.quoteApprovalThresholdCents }),
    leads: leadLookup,
  });

  const app = new Hono();
  app.route('/', createMetricsApp({ service: new GrowthMetricsService(driver) }));
  app.route('/', createResearchApp({ service: researchService, apiToken: config.apiToken }));
  app.route('/', createCrmApp({ service: crmService, apiToken: config.apiToken }));
  app.route('/', createLeadImportApp({ service: crmService, apiToken: config.apiToken }));
  app.route('/', createOutreachApp({ service: outreachService, apiToken: config.apiToken, callbackSecret: config.outreachCallbackSecret, unsubscribeSecret: config.mailUnsubscribeSecret }));
  app.route('/', createMatchApp({ service: matchService, apiToken: config.apiToken }));
  app.route('/', createSalesApp({ service: salesService, apiToken: config.apiToken }));
  app.route('/', createMcpApp({ service: crmService, mcpToken: config.mcpToken }));

  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
    // One line stating the current authorization posture so operators can
    // tell from boot logs which guards are active (Tier0 review H1).
    const posture = authPosture(config);
    console.log(
      `growth-os auth posture: mode=${posture.mode} researchBearer=${posture.researchBearer} ` +
        `callbackSecret=${posture.callbackSecret} unsubscribe=${posture.unsubscribe} ` +
        `mcp=${posture.mcp} ` +
        `search=${posture.search} zeus=${posture.zeus} mail=${posture.mail}`,
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
