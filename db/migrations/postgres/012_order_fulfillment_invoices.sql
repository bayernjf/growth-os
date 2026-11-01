-- 012_order_fulfillment_invoices.sql (postgres dialect)
-- OP-15: order delivery lifecycle (pending -> delivered -> verified) with the
-- same event-audit discipline as quote_events; OP-16: a local invoice record
-- referencing an order (one invoice per order). Amount is copied from the
-- order server-side; no payment gateway/Stripe is wired here.

CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'delivery',   -- delivery|invoice
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',     -- open|paid|void
  external_ref TEXT,                       -- future external billing system
  issued_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
