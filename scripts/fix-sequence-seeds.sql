-- fix-sequence-seeds.sql
-- 生产序列播种修复（2026-11-06）。仅 Postgres 侧 setval 部分需要本文件；
-- SQLite 生产形态只用文末的等价 UPDATE。
--
-- 背景：
--   1) 014_order_number_sequence 用 COUNT(*) 播种 next_value。若历史上出现删单、
--      手工改号或非连续编号，MAX(order_no 后缀) 会大于 COUNT(*)，播种值偏小，
--      新订单号与历史号冲突，orders.order_no UNIQUE 拒写（repository 重试 10 次后失败）。
--      src/sales/repository.ts:365-374 的分配语义是「next_value = next_value + 1 后取该值」，
--      因此 next_value 必须等于已完成的最大序号（下一次分配得到 max + 1）。
--   2) growth_event_sequence 不是本仓迁移创建的对象（仓内 001-014 均无 CREATE SEQUENCE），
--      只存在于生产库。它是否需要上调、以及最大已用值从哪张表取，必须先跑第 0 步确认。
--
-- 执行前置（来自 bayjf/docs/ops/prod-migrations-execution-cards-2026-11-05.md §三）：
--   * 先停应用（serve.ts 启动会自动迁移，CLI 与服务进程不得并发写）；
--   * 建议先备份，并在同一停服窗口内完成「014 迁移 → 本文件」；
--   * 使用能读写该库的 owner 角色执行；
--   * 本文件所有写操作都是「只上调、不下调」且可重复执行，不删除任何数据。
--
-- 执行顺序：第 0 步预检 → 第 1 步 order_number_sequence → 第 2 步 growth_event_sequence
--          → 第 3 步逐条验收。每步的验收不通过就不要进入下一步。
--
-- 占位符 <MAX_EVENT_SEQ>：用第 0 步 P3（或 P4 找到的归属表）查到的事件最大已用值，
-- 替换为十进制字面量后再执行第 2 步。未确认归属表时不要猜，直接跳过第 2 步。

-- =============================================================================
-- 第 0 步：预检（只读，不改任何数据）
-- =============================================================================

-- P1) orders 规模与最大序号。仅统计形如 ORD-<数字> 的单号，避免历史脏数据让 CAST 失败。
--     记录 max_order_seq，后面所有修正都以它为准。
SELECT COUNT(*) AS order_rows,
       COALESCE(
         MAX(CAST(substr(order_no, 5) AS bigint))
           FILTER (WHERE order_no ~ '^ORD-[0-9]+$'),
         0
       ) AS max_order_seq,
       MAX(order_no) AS max_order_no
  FROM orders;

-- P2) 当前订单序号行（014 之后应存在 name='order'）。没有行时第 1 步会补建。
SELECT name, next_value
  FROM order_number_sequence
 WHERE name = 'order';

-- P3) growth_event_sequence 是否存在及其当前值。无输出 = 该对象不存在，跳过第 2 步。
--     last_value 为 NULL 表示序列从未被 nextval 使用。
SELECT schemaname,
       sequencename,
       COALESCE(last_value, 0) AS last_value,
       is_called
  FROM pg_sequences
 WHERE sequencename = 'growth_event_sequence';

-- P4) 找出 growth_event_sequence 的归属表/列，用来确定 <MAX_EVENT_SEQ> 的真实来源。
--     无输出说明是独立序列（无 owning column），必须向维护者确认消费方后再取值。
SELECT c.relname AS table_name,
       a.attname AS column_name
  FROM pg_class s
  JOIN pg_depend d
    ON d.objid = s.oid
   AND d.deptype IN ('a', 'i')
  JOIN pg_class c
    ON c.oid = d.refobjid
  JOIN pg_attribute a
    ON a.attrelid = c.oid
   AND a.attnum = d.refobjsubid
 WHERE s.relname = 'growth_event_sequence'
   AND s.relkind = 'S';

-- 若 P4 返回 table_name/column_name（例如 some_events.id），用下面这条取最大已用值，
-- 替换 <table> 与 <id_column>：
--   SELECT COALESCE(MAX(<id_column>), 0) AS max_event_seq FROM <table>;

-- =============================================================================
-- 第 1 步：order_number_sequence 按 MAX(order_no) 上调（Postgres）
-- =============================================================================

-- 1a) 保证序列行存在（014 已建表；重跑/账本半执行时兜底）。
INSERT INTO order_number_sequence (name, next_value)
VALUES ('order', 0)
ON CONFLICT (name) DO NOTHING;

-- 1b) 只上调：next_value = GREATEST(当前值, orders 的最大后缀)。
--     repository 取 next_value + 1，因此设成 max_seq 时下一单正好是 max_seq + 1。
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

-- =============================================================================
-- 第 2 步：growth_event_sequence 的 setval（仅当 P3 有输出且已确定 <MAX_EVENT_SEQ>）
-- =============================================================================
-- 把下面的 <MAX_EVENT_SEQ> 替换为十进制字面量后执行。
-- 序列不存在时只打印 NOTICE 并跳过；当前值已不小于目标值时同样不改动。
-- 注意：3 参数 setval 的 is_called=true 表示「下一次 nextval 返回 target + 1」，
-- 对应「最大已用 id = target」。
DO $$
DECLARE
  v_target bigint := <MAX_EVENT_SEQ>;
  v_last bigint;
  v_exists boolean;
BEGIN
  SELECT EXISTS (
           SELECT 1
             FROM pg_class s
            WHERE s.relname = 'growth_event_sequence'
              AND s.relkind = 'S'
         )
    INTO v_exists;

  IF NOT v_exists THEN
    RAISE NOTICE 'growth_event_sequence not present; step 2 skipped';
    RETURN;
  END IF;

  SELECT COALESCE(last_value, 0)
    INTO v_last
    FROM pg_sequences
   WHERE sequencename = 'growth_event_sequence';

  IF v_target > v_last THEN
    PERFORM setval('growth_event_sequence', v_target, true);
    RAISE NOTICE 'growth_event_sequence raised: % -> %', v_last, v_target;
  ELSE
    RAISE NOTICE 'growth_event_sequence unchanged: target % <= current %', v_target, v_last;
  END IF;
END $$;

-- =============================================================================
-- 第 3 步：逐条验收（只读）
-- =============================================================================

-- V1) 订单序号必须是「上调后」的值，且不小于 P1 的 max_order_seq。
SELECT name, next_value
  FROM order_number_sequence
 WHERE name = 'order';

-- V2) 下一次将分配的单号（复用 repository 的 next_value + 1 语义）。
SELECT 'ORD-' || lpad(((next_value + 1)::text), 5, '0') AS next_order_no
  FROM order_number_sequence
 WHERE name = 'order';

-- V3) 该「下一次单号」不得与任何历史单号冲突，期望 0。
SELECT COUNT(*) AS next_order_no_collisions
  FROM orders
 WHERE order_no = 'ORD-' || lpad(
          ((SELECT next_value FROM order_number_sequence WHERE name = 'order') + 1)::text,
          5, '0'
        );

-- V4) 历史单号本身不得重复（UNIQUE 兜底应保证，期望 0 行）。
SELECT order_no, COUNT(*) AS n
  FROM orders
 GROUP BY order_no
HAVING COUNT(*) > 1;

-- V5) 事件序列终态（与 P3 对比，只允许不变或变大；期望 last_value >= <MAX_EVENT_SEQ>）。
SELECT sequencename,
       COALESCE(last_value, 0) AS last_value,
       is_called
  FROM pg_sequences
 WHERE sequencename = 'growth_event_sequence';

-- =============================================================================
-- 附：SQLite 生产形态的等价修正（无 setval；growth_event_sequence 不适用）
-- =============================================================================
-- INSERT OR IGNORE INTO order_number_sequence (name, next_value) VALUES ('order', 0);
--
-- UPDATE order_number_sequence
--    SET next_value = MAX(
--          next_value,
--          (
--            SELECT COALESCE(MAX(CAST(substr(order_no, 5) AS INTEGER)), 0)
--              FROM orders
--             WHERE order_no GLOB 'ORD-[0-9]*'
--          )
--        )
--  WHERE name = 'order';
--
-- 验收：
--   SELECT name, next_value FROM order_number_sequence WHERE name = 'order';
--   SELECT COUNT(*) FROM orders
--    WHERE order_no = 'ORD-' || printf('%05d',
--          (SELECT next_value FROM order_number_sequence WHERE name = 'order') + 1);
