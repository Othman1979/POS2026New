-- 2026-09-12-held-report-date-index-v1
-- Requires migration: 2026-09-12-unified-stock-movements-v1
-- Requires checksum: 91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99
-- Date access for Y reports; no held content or order identity changes.
SET NAMES utf8mb4;

ALTER TABLE held_orders
  ADD INDEX IF NOT EXISTS idx_held_orders_created_id (created_at, id),
  ALGORITHM=INPLACE, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-12-held-report-date-index-v1', '46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034')
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
