-- 011_sales_contracts_orders.sql (sqlite dialect)
-- OP-11: contracts (draft -> sent -> signed) and orders (quote -> order with a
-- delivery status reserved for OP-15 and an invoice reference for OP-16).
-- A contract can only exist for an accepted quote; an order only for a signed
-- contract (enforced by the sales service).

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  terms_snapshot TEXT NOT NULL DEFAULT '{}',  -- JSON terms/snapshot
  status TEXT NOT NULL DEFAULT 'draft',       -- draft|sent|signed
  decision_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  signed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (quote_id) REFERENCES quotes(id)
);
CREATE INDEX IF NOT EXISTS idx_contracts_quote ON contracts(quote_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  quote_id TEXT NOT NULL,
  contract_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',  -- pending|delivered|verified (OP-15)
  invoice_ref TEXT,                                  -- reserved for OP-16
  note TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (quote_id) REFERENCES quotes(id),
  FOREIGN KEY (contract_id) REFERENCES contracts(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_quote ON orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery ON orders(delivery_status);
