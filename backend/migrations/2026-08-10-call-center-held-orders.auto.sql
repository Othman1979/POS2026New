-- 2026-08-10-call-center-held-orders-v1
-- Requires migration: 2026-08-10-held-order-lifecycle-v1
-- Requires checksum: af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160
-- Requires normalized SQL SHA-256: a5ecfe94d542e5672dbc95d10877b38ceb75f10987e5e97c1720728e440b2185
-- Add the fixed call-center role and nullable server-owned phone-order source links.
-- Existing rows are preserved; new source columns remain NULL for historical data.

SET NAMES utf8mb4;

ALTER TABLE users
  MODIFY role ENUM('admin','cashier','programmer','waiter','table_manager','call_center') NOT NULL DEFAULT 'cashier';

ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS call_center_user_id INT NULL;

ALTER TABLE held_orders
  ADD INDEX IF NOT EXISTS idx_held_orders_call_center_user (call_center_user_id);

ALTER TABLE held_orders
  ADD CONSTRAINT fk_held_orders_call_center_user FOREIGN KEY IF NOT EXISTS (call_center_user_id)
    REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS call_center_user_id INT NULL;

ALTER TABLE orders
  ADD INDEX IF NOT EXISTS idx_orders_call_center_user (call_center_user_id);

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_call_center_user FOREIGN KEY IF NOT EXISTS (call_center_user_id)
    REFERENCES users (id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-call-center-held-orders-v1',
  'f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
