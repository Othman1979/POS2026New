-- Hostinger-safe automatic form of 2026-07-31-platform-held-order-settlement.sql.
-- The runner owns ledger and predecessor checks, locking, and failure handling.

SET NAMES utf8mb4;

ALTER TABLE order_types
  ADD COLUMN IF NOT EXISTS is_deferred_settlement TINYINT(1) NOT NULL DEFAULT 0 AFTER requires_hash;

ALTER TABLE orders
  MODIFY payment_method ENUM('cash','card','split','receivable','platform','unpaid_table','voided') NOT NULL;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-07-31-platform-held-order-settlement-v1', 'cf94e76c83a78255bcce22b443b105692d081db2d717717191ea921181799b85');
