-- 004_outreach.sql (sqlite dialect)
-- growth-os G3 receipt handling: suppressed emails (bounce/complaint).

CREATE TABLE IF NOT EXISTS suppressed_emails (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT 'bounce',   -- bounce|complaint|manual
  created_at TEXT NOT NULL
);
