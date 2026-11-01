-- 011_sales_contracts_orders.sql (postgres dialect)
-- OP-11: contracts (draft -> sent -> signed) and orders (quote -> order with a
-- delivery status reserved for OP-15 and an invoice reference for OP-16).
-- A contract can only exist for an accepted quote; an order only for a signed
-- contract (enforced by the sales service).

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  terms_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  decision_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  signed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_quote ON contracts(quote_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  contract_id TEXT REFERENCES contracts(id),
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  invoice_ref TEXT,
  note TEXT NOT NULL DEFAULT '',
  delivered_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_quote ON orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_delivery ON orders(delivery_status);
