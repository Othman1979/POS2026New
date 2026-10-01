-- 2026-09-08-stock-read-index-v1
-- Requires migration: 2026-09-08-stock-sale-snapshots-v1
-- Requires checksum: b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f
-- Equality filters precede the name/ID cursor; retains the existing all-status name index.
ALTER TABLE stock_items
 ADD INDEX IF NOT EXISTS idx_stock_item_active_name (tracking_state,is_active,name,id);
INSERT INTO schema_migrations (migration_name,checksum) VALUES ('2026-09-08-stock-read-index-v1','318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
