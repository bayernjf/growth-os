-- preflight-014-order-sequence.sql (postgres dialect)
-- Read-only preflight for 014_order_number_sequence. Writes nothing.
--
-- 014 只新增 order_number_sequence 表并插入 name='order' 的种子行，不改 orders。
-- 需要提前确认两类风险：
--   * 账本与对象不一致（半执行：表/行已存在但没有 schema_migrations 记录，
--     或账本已记但表缺失）；
--   * 种子值与历史单号不一致（COUNT(*) 播种偏小，下一次分配会撞上已有单号）。
--
-- 判读顺序：P0 → P1 → P4 → P5。P5 的 verdict 为 STOP 时不要执行 014/修复脚本，
-- 先按提示处理。修复使用 scripts/fix-sequence-seeds.sql（只上调、不下调）。

-- P0) 账本是否存在，以及 011（orders）/013/014 的登记状态。
SELECT to_regclass('public.schema_migrations') AS schema_migrations_table;

SELECT version, applied_at
  FROM schema_migrations
 WHERE version IN (
         '011_sales_contracts_orders',
         '012_order_fulfillment_invoices',
         '013_orders_contract_unique',
         '014_order_number_sequence'
       )
 ORDER BY version;

-- P1) orders 与 014 目标表/种子行现状。表不存在时 to_regclass 返回 NULL，
--     后续查询会报错，属正常（说明 014 尚未执行）。
SELECT to_regclass('public.orders') AS orders_table,
       to_regclass('public.order_number_sequence') AS sequence_table;

SELECT name, next_value
  FROM order_number_sequence
 WHERE name = 'order';

-- P2) 订单规模与最大序号。仅统计形如 ORD-<数字> 的单号；malformed 单独计数，
--     避免历史脏数据让 CAST 失败。
SELECT COUNT(*) AS order_rows,
       COUNT(*) FILTER (WHERE order_no !~ '^ORD-[0-9]+$') AS malformed_rows,
       COALESCE(
         MAX(CAST(substr(order_no, 5) AS bigint))
           FILTER (WHERE order_no ~ '^ORD-[0-9]+$'),
         0
       ) AS max_order_seq,
       MAX(order_no) AS max_order_no
  FROM orders;

-- P3) 历史单号重复检查（011 已建 UNIQUE，正常应为 0 行；有输出说明约束被绕过）。
SELECT order_no, COUNT(*) AS duplicate_rows
  FROM orders
 GROUP BY order_no
HAVING COUNT(*) > 1;

-- P4) 014 当前会分配的下一个单号（复用 repository 的 next_value + 1 语义）。
--     sequence_table 为 NULL 时本查询会报错，属预期（先执行 014）。
SELECT 'ORD-' || lpad(((next_value + 1)::text), 5, '0') AS next_order_no
  FROM order_number_sequence
 WHERE name = 'order';

-- P5a) 账本与表是否一致。本查询不引用 order_number_sequence 列，
--      因此在表尚未创建时也能安全执行。
--      next_value 的语义是「下一次分配 = next_value + 1」，种子值在 P5b 判定。
WITH state AS (
  SELECT
    EXISTS (
      SELECT 1 FROM schema_migrations WHERE version = '014_order_number_sequence'
    ) AS ledger_applied,
    to_regclass('public.order_number_sequence') IS NOT NULL AS table_exists
)
SELECT ledger_applied,
       table_exists,
       CASE
         WHEN NOT table_exists AND NOT ledger_applied
           THEN 'OK: 014 not applied yet; sequence table absent'
         WHEN table_exists AND NOT ledger_applied
           THEN 'STOP: table exists without a ledger row (half-applied); backfill or drop before re-run'
         WHEN NOT table_exists AND ledger_applied
           THEN 'STOP: ledger says applied but the table is missing; inspect schema drift'
         ELSE 'OK: ledger and table agree; run P5b for the seed check'
       END AS verdict
  FROM state;

-- P5b) 种子值与 MAX(order_no) 是否自洽。仅在 P5a 的 table_exists = true 时执行；
--      表不存在时本查询会报 "relation does not exist"，属预期。
--      健康值：next_value >= max_order_seq（等于时下一次分配正好 max + 1；
--      大于只会跳号，安全；小于则迟早撞号，STOP）。
WITH seed AS (
  SELECT
    COALESCE(
      (SELECT next_value FROM order_number_sequence WHERE name = 'order'),
      -1
    ) AS next_value,
    COALESCE(
      (SELECT MAX(CAST(substr(order_no, 5) AS bigint))
         FROM orders
        WHERE order_no ~ '^ORD-[0-9]+$'),
      0
    ) AS max_order_seq
)
SELECT next_value,
       max_order_seq,
       CASE
         WHEN next_value = -1
           THEN 'STOP: order row missing; run the 014 seed insert'
         WHEN next_value < max_order_seq
           THEN 'STOP: seed < MAX(order_no); next allocation would collide. Run scripts/fix-sequence-seeds.sql'
         WHEN next_value > max_order_seq
           THEN 'OK: applied; seed > MAX (numbering gaps only, no collisions)'
         ELSE 'OK: applied; seed == MAX(order_no), next allocation is safe'
       END AS verdict
  FROM seed;

-- P6) 可选：生产库若存在 growth_event_sequence（本仓迁移不创建），一并看当前值。
--     归属表可用 fix-sequence-seeds.sql 的 P4 查询确认；确认前不要 setval。
SELECT schemaname,
       sequencename,
       COALESCE(last_value, 0) AS last_value,
       is_called
  FROM pg_sequences
 WHERE sequencename = 'growth_event_sequence';

-- =============================================================================
-- 附：SQLite 生产形态的等价预检（无 to_regclass / FILTER / 正则 ~）
-- =============================================================================
-- SELECT name, next_value FROM order_number_sequence WHERE name = 'order';
--
-- SELECT COUNT(*) AS order_rows,
--        COALESCE(MAX(CAST(substr(order_no, 5) AS INTEGER)), 0) AS max_order_seq,
--        MAX(order_no) AS max_order_no
--   FROM orders
--  WHERE order_no GLOB 'ORD-[0-9]*';
--
-- SELECT order_no, COUNT(*) AS duplicate_rows
--   FROM orders
--  GROUP BY order_no
-- HAVING COUNT(*) > 1;
--
-- SELECT 'ORD-' || printf('%05d', next_value + 1) AS next_order_no
--   FROM order_number_sequence
--  WHERE name = 'order';
