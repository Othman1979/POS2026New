-- Hostinger-safe automatic form of 2026-08-10-order-reference-authority-v1.
SET NAMES utf8mb4;

UPDATE orders o
LEFT JOIN users u ON u.id = o.waiter_id
SET o.waiter_id = NULL
WHERE o.waiter_id IS NOT NULL AND u.id IS NULL;

UPDATE orders o
LEFT JOIN order_types ot ON ot.id = o.order_type_id
SET o.order_type_id = NULL
WHERE o.order_type_id IS NOT NULL AND ot.id IS NULL;

UPDATE orders o
LEFT JOIN customers c ON c.id = o.customer_id
SET o.customer_id = NULL
WHERE o.customer_id IS NOT NULL AND c.id IS NULL;

UPDATE orders o
LEFT JOIN restaurant_tables t ON t.id = o.table_id
SET o.table_id = NULL
WHERE o.table_id IS NOT NULL AND t.id IS NULL;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_waiter FOREIGN KEY IF NOT EXISTS (waiter_id)
    REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_order_type FOREIGN KEY IF NOT EXISTS (order_type_id)
    REFERENCES order_types(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_customer FOREIGN KEY IF NOT EXISTS (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_table FOREIGN KEY IF NOT EXISTS (table_id)
    REFERENCES restaurant_tables(id) ON DELETE RESTRICT;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-10-order-reference-authority-v1',
  'da921de3485d1d776cc4f6a23e1e3212eb17d75e1b02088e83f4eae15b4eac35'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
