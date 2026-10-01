-- 2026-09-02-expense-zero-amount-v1
-- Requires migration: 2026-09-01-fractional-stock-precision-v1
-- Requires checksum: b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e
-- Requires normalized SQL SHA-256: 5b0429ee51ce38fcabcb723f53ef25b65527af5c58f19cabe3f1b766cced1ecb
-- Allow zero-valued expense entries while continuing to reject negative amounts.
-- This metadata-only change preserves all existing expense rows.

SET NAMES utf8mb4;

ALTER TABLE expenses
  DROP CONSTRAINT IF EXISTS chk_expenses_amount,
  ADD CONSTRAINT chk_expenses_amount CHECK (amount >= 0);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-02-expense-zero-amount-v1',
  '264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);

