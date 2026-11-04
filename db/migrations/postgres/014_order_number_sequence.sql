-- 014_order_number_sequence.sql (postgres dialect)
-- 2026-11-02 review P2-4: order numbers must be allocated inside the database
-- instead of a read-then-write COUNT(*)+1 outside a transaction. The sequence
-- row is bumped under the writer's transaction so concurrent orders cannot
-- collide; orders.order_no stays UNIQUE as the final backstop.
--
-- Seed with the current order count so existing numbers keep their range
-- (the previous generator was COUNT(*)+1 and orders are never deleted).

CREATE TABLE IF NOT EXISTS order_number_sequence (
  name TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL
);
INSERT INTO order_number_sequence (name, next_value)
SELECT 'order', COUNT(*) FROM orders
ON CONFLICT (name) DO NOTHING;
