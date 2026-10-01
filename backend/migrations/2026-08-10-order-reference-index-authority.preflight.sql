-- Read-only preflight for 2026-08-10-order-reference-index-authority-v1.
SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND INDEX_NAME IN (
    'idx_orders_waiter_id', 'idx_orders_order_type_id',
    'fk_orders_waiter', 'fk_orders_order_type'
  )
ORDER BY INDEX_NAME, SEQ_IN_INDEX;
