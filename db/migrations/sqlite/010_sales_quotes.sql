-- 010_sales_quotes.sql (sqlite dialect)
-- OP-10: sales quotes for the M1 sales->delivery loop. A quote belongs to an
-- optional lead (direct creation is allowed), carries line items as JSON and a
-- money total in integer cents. Lifecycle: draft -> sent -> accepted|rejected.
-- State transitions are audited in quote_events (mirrors lead_events).

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  lead_id TEXT,
  customer_name TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  line_items TEXT NOT NULL DEFAULT '[]',   -- JSON [{description,qty,unit_amount_cents,currency}]
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft|sent|accepted|rejected
  decision_id TEXT,                         -- zeus decision for the sent gate
  note TEXT NOT NULL DEFAULT '',
  sent_at TEXT,
  accepted_at TEXT,
  rejected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
);
CREATE INDEX IF NOT EXISTS idx_quotes_lead ON quotes(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);

CREATE TABLE IF NOT EXISTS quote_events (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  decision_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (quote_id) REFERENCES quotes(id)
);
CREATE INDEX IF NOT EXISTS idx_quote_events_quote ON quote_events(quote_id);
