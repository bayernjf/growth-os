import type { StorageDriver } from '../storage/driver.js';
import { LEAD_STATUSES } from '../crm/types.js';

/**
 * Read-only metrics for the Tier0 collector.
 *
 * The snapshot is derived from persisted rows only. Emails, subjects and
 * message bodies never become labels: they are unbounded and would turn a
 * local Prometheus into a copy of the CRM.
 */

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const DRAFT_STATUSES = ['draft', 'submitted', 'approved', 'rejected', 'sent', 'failed'] as const;

export interface GrowthMetricsSnapshot {
  capturedAt: string;
  uptimeSeconds: number;
  leads: Record<string, number>;
  leadsTotal: number;
  followups: {
    total: number;
    due: number;
    done: number;
  };
  campaigns: number;
  drafts: Record<string, number>;
  draftsTotal: number;
  reports: number;
}

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class GrowthMetricsService {
  private readonly startedAtMs: number;

  constructor(
    private readonly driver: StorageDriver,
    startedAtMs = Date.now(),
  ) {
    this.startedAtMs = startedAtMs;
  }

  async getMetrics(now = new Date()): Promise<GrowthMetricsSnapshot> {
    const nowIso = now.toISOString();
    const [leadRows, followupTotal, followupDue, followupDone, campaignRows, draftRows, reportRows] =
      await Promise.all([
        this.driver.all<{ status: string; count: unknown }>(
          'SELECT status, COUNT(*) AS count FROM leads GROUP BY status',
        ),
        this.driver.get<{ count: unknown }>('SELECT COUNT(*) AS count FROM lead_followups'),
        this.driver.get<{ count: unknown }>(
          'SELECT COUNT(*) AS count FROM lead_followups WHERE due_at IS NOT NULL AND due_at <= ? AND done_at IS NULL',
          [nowIso],
        ),
        this.driver.get<{ count: unknown }>(
          'SELECT COUNT(*) AS count FROM lead_followups WHERE done_at IS NOT NULL',
        ),
        this.driver.get<{ count: unknown }>('SELECT COUNT(*) AS count FROM campaigns'),
        this.driver.all<{ status: string; count: unknown }>(
          'SELECT status, COUNT(*) AS count FROM outreach_drafts GROUP BY status',
        ),
        this.driver.get<{ count: unknown }>('SELECT COUNT(*) AS count FROM research_reports'),
      ]);

    const leads: Record<string, number> = {};
    for (const status of LEAD_STATUSES) leads[status] = 0;
    for (const row of leadRows) {
      if (LEAD_STATUSES.includes(row.status as (typeof LEAD_STATUSES)[number])) {
        leads[row.status] = count(row.count);
      }
    }

    const drafts: Record<string, number> = {};
    for (const status of DRAFT_STATUSES) drafts[status] = 0;
    for (const row of draftRows) {
      if (DRAFT_STATUSES.includes(row.status as (typeof DRAFT_STATUSES)[number])) {
        drafts[row.status] = count(row.count);
      }
    }

    return {
      capturedAt: nowIso,
      uptimeSeconds: Math.max(0, Math.floor((now.getTime() - this.startedAtMs) / 1000)),
      leads,
      leadsTotal: Object.values(leads).reduce((sum, value) => sum + value, 0),
      followups: {
        total: count(followupTotal?.count),
        due: count(followupDue?.count),
        done: count(followupDone?.count),
      },
      campaigns: count(campaignRows?.count),
      drafts,
      draftsTotal: Object.values(drafts).reduce((sum, value) => sum + value, 0),
      reports: count(reportRows?.count),
    };
  }
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labels(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return '';
  return `{${pairs.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`).join(',')}}`;
}

class Family {
  private readonly samples: string[] = [];

  constructor(
    private readonly name: string,
    private readonly help: string,
    private readonly type: 'gauge' | 'counter',
  ) {}

  add(value: number, pairs: ReadonlyArray<readonly [string, string]> = []): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(`${this.name}${labels(pairs)} ${value}`);
  }

  render(): string {
    if (this.samples.length === 0) return '';
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} ${this.type}\n${this.samples.join('\n')}\n`;
  }
}

export function renderPrometheusMetrics(snapshot: GrowthMetricsSnapshot): string {
  const blocks: string[] = [];
  const push = (family: Family): void => {
    const text = family.render();
    if (text) blocks.push(text);
  };

  const up = new Family('growth_up', 'Always 1 while the growth runtime serves a metrics snapshot.', 'gauge');
  up.add(1);
  push(up);

  const uptime = new Family('growth_uptime_seconds', 'Process uptime in seconds.', 'gauge');
  uptime.add(snapshot.uptimeSeconds);
  push(uptime);

  const captured = new Family(
    'growth_metrics_snapshot_timestamp_seconds',
    'Unix time the snapshot was captured; a stale value means the aggregation stopped advancing.',
    'gauge',
  );
  captured.add(Date.parse(snapshot.capturedAt) / 1000);
  push(captured);

  const leads = new Family('growth_leads', 'Leads in the CRM, by state.', 'gauge');
  for (const [status, value] of Object.entries(snapshot.leads)) leads.add(value, [['status', status]]);
  push(leads);

  const leadsTotal = new Family('growth_leads_total', 'Total leads across all states.', 'gauge');
  leadsTotal.add(snapshot.leadsTotal);
  push(leadsTotal);

  const followups = new Family(
    'growth_lead_followups',
    'Lead followups: total rows, currently due (due_at <= now and not done), and completed.',
    'gauge',
  );
  followups.add(snapshot.followups.total, [['state', 'total']]);
  followups.add(snapshot.followups.due, [['state', 'due']]);
  followups.add(snapshot.followups.done, [['state', 'done']]);
  push(followups);

  const campaigns = new Family('growth_campaigns', 'Outreach campaigns, all states.', 'gauge');
  campaigns.add(snapshot.campaigns);
  push(campaigns);

  const drafts = new Family('growth_outreach_drafts', 'Outreach drafts, by state.', 'gauge');
  for (const [status, value] of Object.entries(snapshot.drafts)) drafts.add(value, [['status', status]]);
  push(drafts);

  const draftsTotal = new Family('growth_outreach_drafts_total', 'Total outreach drafts across all states.', 'gauge');
  draftsTotal.add(snapshot.draftsTotal);
  push(draftsTotal);

  const reports = new Family('growth_research_reports', 'Generated research reports.', 'gauge');
  reports.add(snapshot.reports);
  push(reports);

  return blocks.join('\n');
}
