-- 002_crm.sql (sqlite dialect)
-- growth-os G2 customer mining & CRM schema: contacts, leads, followups, events.
-- JSON stored as TEXT; application-generated ids; timestamps ISO-8601 text.

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'manual',   -- signal|form|order|manual
  source_refs TEXT NOT NULL DEFAULT '[]',        -- JSON array (evidence)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,                     -- signal|form|order|manual
  source_signal_id TEXT,                         -- originating signal (unique: one lead per signal)
  contact_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  score_breakdown TEXT NOT NULL DEFAULT '{}',    -- JSON object
  status TEXT NOT NULL DEFAULT 'new',            -- new|qualified|contacted|won|lost
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_signal_id) REFERENCES signals(id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  UNIQUE (source_signal_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS lead_followups (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  action TEXT NOT NULL,                          -- next action (call|email_draft|note|...)
  note TEXT NOT NULL DEFAULT '',
  source_signal_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array (evidence)
  due_at TEXT,                                   -- watch reminder time
  done_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_followups_lead ON lead_followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_due ON lead_followups(due_at);

CREATE TABLE IF NOT EXISTS lead_events (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(lead_id);
