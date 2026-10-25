-- 002_crm.sql (postgres dialect)
-- growth-os G2 customer mining & CRM schema: contacts, leads, followups, events.
-- JSON stored as JSONB; application-generated ids; timestamps ISO-8601 text.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'manual',   -- signal|form|order|manual
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,                     -- signal|form|order|manual
  source_signal_id TEXT REFERENCES signals(id),
  contact_id TEXT REFERENCES contacts(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'new',            -- new|qualified|contacted|won|lost
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_signal_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS lead_followups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  action TEXT NOT NULL,                          -- next action (call|email_draft|note|...)
  note TEXT NOT NULL DEFAULT '',
  source_signal_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  due_at TEXT,
  done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_lead ON lead_followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_due ON lead_followups(due_at);

CREATE TABLE IF NOT EXISTS lead_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(lead_id);
