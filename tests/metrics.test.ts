import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDriver } from '../src/storage/sqlite/sqlite-driver.js';
import { migrateUp } from '../src/storage/migrate.js';
import { GrowthMetricsService, renderPrometheusMetrics } from '../src/observability/prometheus.js';
import { createMetricsApp } from '../src/api/metrics-http.js';

describe('growth metrics', () => {
  let driver: SqliteDriver;
  let service: GrowthMetricsService;

  beforeEach(async () => {
    driver = new SqliteDriver(':memory:');
    await migrateUp(driver);
    service = new GrowthMetricsService(driver, Date.now() - 30_000);
  });

  afterEach(async () => {
    await driver.close();
  });

  async function seed(): Promise<void> {
    await driver.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO research_topics (id,title,description,keywords,signal_types,language,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['topic-1', 'Topic', '', '[]', '[]', 'zh', 'done', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO leads (id,source_type,title,summary,score,score_breakdown,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['lead-new', 'manual', 'New lead', '', 0, '{}', 'new', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO leads (id,source_type,title,summary,score,score_breakdown,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['lead-won', 'manual', 'Won lead', '', 0, '{}', 'won', '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO lead_followups (id,lead_id,action,note,source_signal_ids,due_at,done_at,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['fup-due', 'lead-new', 'email', '', '[]', '2026-01-01T00:00:00.000Z', null, '2026-01-01T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO lead_followups (id,lead_id,action,note,source_signal_ids,due_at,done_at,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['fup-done', 'lead-won', 'call', '', '[]', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO campaigns (id,name,status,created_at,updated_at) VALUES (?,?,?,?,?)`,
        ['camp-1', 'Campaign', 'ready', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO outreach_drafts (id,campaign_id,lead_id,to_email,subject,body_text,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['draft-sent', 'camp-1', 'lead-new', 'private@example.com', 'private subject', 'private body', 'sent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
      );
      await tx.run(
        `INSERT INTO research_reports (id,topic_id,version,mode,stats,top_signals,insight_ids,markdown,generated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        ['report-1', 'topic-1', 1, 'offline', '{}', '[]', '[]', '# report', '2026-01-01T00:00:00.000Z'],
      );
    });
  }

  it('aggregates only persisted, bounded-count fields', async () => {
    await seed();
    const snapshot = await service.getMetrics(new Date('2026-11-22T12:00:00.000Z'));

    expect(snapshot.leadsTotal).toBe(2);
    expect(snapshot.leads.new).toBe(1);
    expect(snapshot.leads.won).toBe(1);
    expect(snapshot.followups).toEqual({ total: 2, due: 1, done: 1 });
    expect(snapshot.campaigns).toBe(1);
    expect(snapshot.drafts.sent).toBe(1);
    expect(snapshot.draftsTotal).toBe(1);
    expect(snapshot.reports).toBe(1);
    expect(snapshot.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const text = renderPrometheusMetrics(snapshot);
    expect(text).toContain('growth_up 1');
    expect(text).toContain('growth_leads{status="new"} 1');
    expect(text).toContain('growth_lead_followups{state="due"} 1');
    expect(text).toContain('growth_outreach_drafts{status="sent"} 1');
    expect(text).not.toContain('private@example.com');
    expect(text).not.toContain('private subject');
  });

  it('serves /metrics as Prometheus text', async () => {
    const app = createMetricsApp({ service });
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('growth_up 1');
  });
});
