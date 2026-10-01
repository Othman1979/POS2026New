-- Issue D: the daily order_id resets per business date in shared-sequence mode,
-- so (shift_id, order_id) is the wrong uniqueness scope (a shift spanning the
-- business-date rollover would falsely collide). Scope the backstop by the actual
-- sequence partition: order_seq_scope = 'date:<business_date>' (shared mode) or
-- 'shift:<shift_id>' (per-shift mode), written at checkout. Legacy/kept order_ids
-- use 'legacy:<invoice_id>' (per-row unique).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_seq_scope VARCHAR(40) NULL AFTER order_id;

-- Backfill historical paid rows with a per-row-unique scope so the new UNIQUE adds
-- cleanly regardless of which mode minted them; new orders get a real date:/shift:
-- scope at checkout (the going-forward invariant).
UPDATE orders SET order_seq_scope = CONCAT('legacy:', invoice_id)
  WHERE order_id IS NOT NULL AND order_seq_scope IS NULL;

-- Replace the mis-scoped backstop. (DROP IF EXISTS handles DBs that applied the
-- intermediate uq_orders_shift_order; on a fresh deploy that index was added by
-- 2026-06-30-order-id-unique-scope.sql and is dropped here.)
ALTER TABLE orders DROP INDEX IF EXISTS uq_orders_shift_order;
ALTER TABLE orders ADD UNIQUE KEY IF NOT EXISTS uq_orders_seq_scope (order_seq_scope, order_id);
