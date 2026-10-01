-- 2026-08-13-split-quantity-precision-v1
-- Requires migration: 2026-08-11-receipt-tax-display-v1
-- Requires checksum: 90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3
-- Requires normalized SQL SHA-256: 8871974f40069bca8cdb92f6bc5a986578c365fec505d9cc67efa4528836d794
-- Preserve fractional split quantities through paid child and refund rows.
-- Widening scale is non-destructive; existing three-decimal values remain exact.

SET NAMES utf8mb4;

ALTER TABLE order_items
  MODIFY COLUMN quantity DECIMAL(12,6) NOT NULL;

ALTER TABLE refund_items
  MODIFY COLUMN quantity DECIMAL(12,6) NOT NULL;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-13-split-quantity-precision-v1',
  'eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
