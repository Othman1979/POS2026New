-- Per-shift order_id counter (write-based, race-safe under REPEATABLE READ).
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS last_order_seq INT NOT NULL DEFAULT 0;

-- Seed each shift's counter from its existing max so post-deploy mints continue
-- without colliding with already-issued order_ids.
UPDATE shifts s
SET s.last_order_seq = (
  SELECT COALESCE(MAX(o.order_id), 0) FROM orders o WHERE o.shift_id = s.id
);
