-- 001_research.sql (postgres dialect)
-- growth-os G1 read-only research schema (design §3).
-- Application-generated ids; timestamps are ISO-8601 text; JSON stored as JSONB.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  keywords JSONB NOT NULL,
  signal_types JSONB NOT NULL,
  language TEXT NOT NULL DEFAULT 'zh',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES research_topics(id),
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
  score_breakdown JSONB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (topic_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_signals_topic ON signals(topic_id);
CREATE INDEX IF NOT EXISTS idx_signals_score ON signals(topic_id, score);

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES research_topics(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  signal_ids JSONB NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_insights_topic ON insights(topic_id);

CREATE TABLE IF NOT EXISTS research_reports (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES research_topics(id),
  version INTEGER NOT NULL,
  mode TEXT NOT NULL,
  stats JSONB NOT NULL,
  top_signals JSONB NOT NULL,
  insight_ids JSONB NOT NULL,
  markdown TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  UNIQUE (topic_id, version)
);
