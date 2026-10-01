-- 2026-09-17-print-queue-timings-v1
-- Requires migration: 2026-09-14-permission-catalog-v2
-- Requires checksum: a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408
-- Store bounded per-job renderer and local transport timing without another write or table.
SET NAMES utf8mb4;

ALTER TABLE print_queue
  ADD COLUMN IF NOT EXISTS render_duration_ms INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS local_duration_ms INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS renderer VARCHAR(16) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS transport_mode VARCHAR(24) DEFAULT NULL,
  ALGORITHM=INSTANT, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-17-print-queue-timings-v1', '3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
