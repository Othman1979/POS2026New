-- 2026-09-03-y-order-type-setting-v1
-- Requires migration: 2026-09-02-expense-zero-amount-v1
-- Requires checksum: 264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75
-- Ensure the DB-only Y held-order setting exists without changing a configured value.

SET NAMES utf8mb4;

INSERT IGNORE INTO settings (setting_key, setting_value)
VALUES ('y_order_type_id', '');

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-03-y-order-type-setting-v1',
  '4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
