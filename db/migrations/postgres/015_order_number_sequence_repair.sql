-- 015_order_number_sequence_repair.sql (postgres dialect)
-- Repair the 014 seed when COUNT(*) undercounted the existing order numbers
-- (deleted orders, manual renumbering, or otherwise non-contiguous numbers).
--
-- 014 seeds next_value with COUNT(*) and the allocator in
-- src/sales/repository.ts takes next_value + 1, so a seed below
-- MAX(order_no suffix) makes the next allocation collide with an existing
-- order_no (orders.order_no UNIQUE rejects the write).
--
-- Idempotent and raise-only: the INSERT recreates the row if it went missing,
-- and GREATEST(next_value, MAX(order_no suffix)) never lowers the counter.
-- No schema change, so the runner applies it at serve startup like any other
-- migration (src/serve.ts calls migrateUp before listening).
-- Only order_no values shaped like ORD-<digits> participate in MAX; malformed
-- historical numbers are ignored instead of aborting the cast.
--
-- AUDIT (do this before the deploy restart, while the old value still exists):
--   SELECT name, next_value FROM order_number_sequence WHERE name = 'order';
-- Copy that value into the release notes. The runner applies 015 during boot,
-- after which the previous value is no longer observable.
--
-- ROLLBACK: do not lower the counter. Restoring the old next_value reintroduces
-- exactly the collisions this migration removes. If the release itself must be
-- rolled back, leave order_number_sequence untouched and treat 015 as
-- forward-only (safe: it only raises a number).

INSERT INTO order_number_sequence (name, next_value)
VALUES ('order', 0)
ON CONFLICT (name) DO NOTHING;

UPDATE order_number_sequence
   SET next_value = GREATEST(
         next_value,
         (
           SELECT COALESCE(
                    MAX(CAST(substr(order_no, 5) AS bigint))
                      FILTER (WHERE order_no ~ '^ORD-[0-9]+$'),
                    0
                  )
             FROM orders
         )
       )
 WHERE name = 'order';
