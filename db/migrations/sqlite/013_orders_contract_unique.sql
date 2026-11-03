-- 013_orders_contract_unique.sql (sqlite dialect)
-- 2026-11-02 review P2-4: at most one order per signed contract. The sales
-- service pre-checks and answers 409; this partial unique index is the
-- backstop so a lost race can never persist a duplicate order.

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_contract_unique
  ON orders(contract_id)
  WHERE contract_id IS NOT NULL;
