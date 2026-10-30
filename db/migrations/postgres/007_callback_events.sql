-- 007_callback_events.sql (postgres dialect)
-- Tier0 review 2026-10-30 (P1): bounce/reply receipt callbacks mutate the
-- suppress list and CRM. Each processed callback event id is recorded here
-- with a snapshot of the first response, so a replayed callback returns the
-- original result instead of applying its side effects again.

CREATE TABLE IF NOT EXISTS outreach_callback_events (
  id TEXT PRIMARY KEY,             -- caller-supplied callback event id
  kind TEXT NOT NULL,              -- bounce|reply
  result TEXT NOT NULL,            -- JSON snapshot of the first response body
  created_at TEXT NOT NULL
);
