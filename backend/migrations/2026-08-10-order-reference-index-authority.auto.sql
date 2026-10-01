-- 2026-08-10-order-reference-index-authority-v1
-- Give the two historical-order foreign-key indexes their canonical baseline names.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_waiter_id (waiter_id);

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_order_type_id (order_type_id);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-order-reference-index-authority-v1',
  '8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
