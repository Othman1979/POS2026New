-- 2026-09-13-paid-split-parent-index-v1
-- Requires migration: 2026-09-13-table-action-recovery-v1
-- Requires checksum: 00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92
-- Read the matching preflight before manual application. Index only; no bill changes.
SET NAMES utf8mb4;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_parent_payment (parent_invoice_id, payment_method),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-13-paid-split-parent-index-v1', 'ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
