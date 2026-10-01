-- Both canonical index names must exist with exactly one expected column.
SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_in_order
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'orders'
  AND INDEX_NAME IN ('idx_orders_waiter_id', 'idx_orders_order_type_id')
GROUP BY INDEX_NAME
ORDER BY INDEX_NAME;
