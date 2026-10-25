-- 001_research.sql (sqlite dialect)
-- growth-os G1 read-only research schema (design §3).
-- Application-generated ids; timestamps are ISO-8601 text; JSON stored as TEXT.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL,              -- JSON array
  signal_types TEXT NOT NULL,           -- JSON array
  language TEXT NOT NULL DEFAULT 'zh',
  status TEXT NOT NULL,                 -- draft|running|done
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  source_type TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  fingerprint TEXT NOT NULL,
  score INTEGER NOT NULL,
  score_breakdown TEXT NOT NULL,        -- JSON object
  created_at TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES research_topics(id),
  UNIQUE (topic_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_signals_topic ON signals(topic_id);
CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(topic_id, score);

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  category TEXT NOT NULL,               -- need|pain|comparison
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  signal_ids TEXT NOT NULL,             -- JSON array
  status TEXT NOT NULL,                 -- pending_review|confirmed|rejected
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  FOREIGN KEY (topic_id) REFERENCES research_topics(id)
);
CREATE INDEX IF NOT EXISTS idx_insights_topic ON insights(topic_id);

CREATE TABLE IF NOT EXISTS research_reports (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  stats TEXT NOT NULL,                  -- JSON object
  top_signals TEXT NOT NULL,            -- JSON array
  insight_ids TEXT NOT NULL,            -- JSON array
  markdown TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  FOREIGN KEY (topic_id) REFERENCES research_topics(id),
  UNIQUE (topic_id, version)
);
