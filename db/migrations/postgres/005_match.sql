-- 005_match.sql (postgres dialect)
-- growth-os G5 matching engine: buyer demands, supplier offers, matches.

CREATE TABLE IF NOT EXISTS buyer_demands (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity TEXT,
  price_min DOUBLE PRECISION,
  price_max DOUBLE PRECISION,
  currency TEXT NOT NULL DEFAULT 'USD',
  deadline TEXT,
  region TEXT,
  description TEXT NOT NULL DEFAULT '',
  source_signal_id TEXT REFERENCES signals(id),
  status TEXT NOT NULL DEFAULT 'new',   -- new|matched|closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_buyer_demands_category ON buyer_demands(category);

CREATE TABLE IF NOT EXISTS supplier_offers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  capacity TEXT,
  price DOUBLE PRECISION,
  currency TEXT NOT NULL DEFAULT 'USD',
  moq DOUBLE PRECISION,
  region TEXT,
  credentials TEXT,
  description TEXT NOT NULL DEFAULT '',
  source_signal_id TEXT REFERENCES signals(id),
  status TEXT NOT NULL DEFAULT 'new',   -- new|matched|closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_offers_category ON supplier_offers(category);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  buyer_demand_id TEXT NOT NULL REFERENCES buyer_demands(id),
  supplier_offer_id TEXT NOT NULL REFERENCES supplier_offers(id),
  score INTEGER NOT NULL DEFAULT 0,
  reasons JSONB NOT NULL DEFAULT '{}'::jsonb,   -- JSON object (dimension -> score)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_matches_buyer ON matches(buyer_demand_id);
CREATE INDEX IF NOT EXISTS idx_matches_supplier ON matches(supplier_offer_id);
