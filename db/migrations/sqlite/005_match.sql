-- 005_match.sql (sqlite dialect)
-- growth-os G5 matching engine: buyer demands, supplier offers, matches.

CREATE TABLE IF NOT EXISTS buyer_demands (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity TEXT,
  price_min REAL,
  price_max REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  deadline TEXT,
  region TEXT,
  description TEXT NOT NULL DEFAULT '',
  source_signal_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',   -- new|matched|closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_signal_id) REFERENCES signals(id)
);
CREATE INDEX IF NOT EXISTS idx_buyer_demands_category ON buyer_demands(category);

CREATE TABLE IF NOT EXISTS supplier_offers (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  capacity TEXT,
  price REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  moq REAL,
  region TEXT,
  credentials TEXT,
  description TEXT NOT NULL DEFAULT '',
  source_signal_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',   -- new|matched|closed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_signal_id) REFERENCES signals(id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_offers_category ON supplier_offers(category);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  buyer_demand_id TEXT NOT NULL,
  supplier_offer_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  reasons TEXT NOT NULL DEFAULT '{}',   -- JSON object (dimension -> score)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (buyer_demand_id) REFERENCES buyer_demands(id),
  FOREIGN KEY (supplier_offer_id) REFERENCES supplier_offers(id)
);
CREATE INDEX IF NOT EXISTS idx_matches_buyer ON matches(buyer_demand_id);
CREATE INDEX IF NOT EXISTS idx_matches_supplier ON matches(supplier_offer_id);
