-- 003_outreach.sql (postgres dialect)
-- growth-os G3 outbound email: campaigns, zeus-gated drafts and audit events.

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft|ready|sending|done
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',   -- draft|submitted|approved|rejected|sent|failed
  decision_id TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_campaign ON outreach_drafts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON outreach_drafts(status);

CREATE TABLE IF NOT EXISTS outreach_events (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES outreach_drafts(id),
  type TEXT NOT NULL,                     -- created|submitted|approved|rejected|sent|failed
  decision_id TEXT,
  message_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_events_draft ON outreach_events(draft_id);
