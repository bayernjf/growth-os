// growth-os configuration: env parsing with safe defaults.

export interface ScoringConfig {
  weights: { type: number; source: number; fresh: number; keyword: number };
  typeScore: Record<string, number>;
  credibility: Record<string, number>;
  halfLifeDays: number;
  insightMinScore: number;
  reportTopN: number;
}

export interface AppConfig {
  host: string;
  port: number;
  apiToken?: string | undefined;
  dbDriver: 'sqlite' | 'postgres';
  sqlitePath: string;
  searchMode: 'offline' | 'online';
  searchBaseUrl?: string | undefined;
  searchApiKey?: string | undefined;
  zeusMode: 'off' | 'online';
  zeusUrl?: string | undefined;
  zeusToken?: string | undefined;
  mailMode: 'off' | 'smtp';
  mailHost?: string | undefined;
  mailPort: number;
  mailUser?: string | undefined;
  mailPass?: string | undefined;
  mailFrom?: string | undefined;
  /** Sender identity / physical address statement (§14.2.1), rendered in the footer. */
  mailIdentity?: string | undefined;
  /** Public base URL for the one-click unsubscribe endpoint. */
  mailUnsubscribeBaseUrl?: string | undefined;
  /** HMAC secret for one-click unsubscribe tokens (kept separate from callback signing). */
  mailUnsubscribeSecret?: string | undefined;
  leadMinScore: number;
  mcpToken?: string | undefined;
  outreachCallbackSecret?: string | undefined;
  scoring: ScoringConfig;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AppConfig {
  const dbDriver = process.env.GROWTH_DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
  const searchMode = process.env.GROWTH_SEARCH_MODE === 'online' ? 'online' : 'offline';
  const zeusMode = process.env.GROWTH_ZEUS_MODE === 'online' ? 'online' : 'off';
  const mailMode = process.env.GROWTH_MAIL_MODE === 'smtp' ? 'smtp' : 'off';
  return {
    host: process.env.GROWTH_HOST ?? '127.0.0.1',
    port: num('GROWTH_PORT', 8788),
    apiToken: process.env.GROWTH_API_TOKEN || undefined,
    dbDriver,
    sqlitePath: process.env.GROWTH_SQLITE_PATH ?? './data/growth-os.db',
    searchMode,
    searchBaseUrl: process.env.GROWTH_SEARCH_BASE_URL || undefined,
    searchApiKey: process.env.GROWTH_SEARCH_API_KEY || undefined,
    zeusMode,
    zeusUrl: process.env.GROWTH_ZEUS_URL || undefined,
    zeusToken: process.env.GROWTH_ZEUS_TOKEN || undefined,
    mailMode,
    mailHost: process.env.GROWTH_MAIL_HOST || undefined,
    mailPort: num('GROWTH_MAIL_PORT', 587),
    mailUser: process.env.GROWTH_MAIL_USER || undefined,
    mailPass: process.env.GROWTH_MAIL_PASS || undefined,
    mailFrom: process.env.GROWTH_MAIL_FROM || undefined,
    mailIdentity: process.env.GROWTH_MAIL_IDENTITY || undefined,
    mailUnsubscribeBaseUrl: process.env.GROWTH_MAIL_UNSUBSCRIBE_BASE_URL || undefined,
    mailUnsubscribeSecret: process.env.GROWTH_MAIL_UNSUBSCRIBE_SECRET || undefined,
    leadMinScore: num('LEAD_MIN_SCORE', 60),
    mcpToken: process.env.GROWTH_MCP_TOKEN || undefined,
    outreachCallbackSecret: process.env.GROWTH_OUTREACH_CALLBACK_SECRET || undefined,
    scoring: {
      weights: { type: 0.45, source: 0.2, fresh: 0.15, keyword: 0.2 },
      typeScore: {
        intent: 1.0,
        need: 1.0,
        pain: 0.85,
        comparison: 0.7,
        competitor: 0.6,
        hiring: 0.55,
        funding: 0.55,
        tech_stack: 0.55,
        trend: 0.4,
      },
      credibility: {
        official: 0.9,
        support: 0.7,
        review: 0.6,
        web: 0.5,
        social: 0.45,
      },
      halfLifeDays: num('SCORE_FRESH_HALFLIFE_DAYS', 30),
      insightMinScore: num('INSIGHT_MIN_SCORE', 60),
      reportTopN: num('REPORT_TOP_N', 10),
    },
  };
}
