-- 2026-09-08-stock-sale-snapshots-v1
-- Requires migration: 2026-09-08-stock-ledger-core-v1
-- Requires checksum: 39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4
-- NULL snapshots identify historical lines whose original mapping is unknown.
-- Never backfill them from today's catalog configuration.
ALTER TABLE order_items
 ADD COLUMN IF NOT EXISTS stock_authority varchar(24) NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS stock_snapshot JSON DEFAULT NULL;
ALTER TABLE subscription_redemption_items
 ADD COLUMN IF NOT EXISTS stock_authority varchar(24) NOT NULL DEFAULT 'legacy',
 ADD COLUMN IF NOT EXISTS stock_snapshot JSON DEFAULT NULL;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-08-stock-sale-snapshots-v1', 'b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
