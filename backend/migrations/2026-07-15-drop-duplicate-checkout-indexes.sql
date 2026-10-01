-- Keep one unique index for each checkout uniqueness invariant.
-- The June performance migration added new index names even when an equivalent
-- unique key already existed, making every sale maintain duplicate B-trees.

DELIMITER //

DROP PROCEDURE IF EXISTS `_ps_20260715_drop_duplicate_checkout_indexes`//
CREATE PROCEDURE `_ps_20260715_drop_duplicate_checkout_indexes`()
BEGIN
  IF 1 = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
      AND INDEX_NAME = 'uq_orders_idempotency'
      AND NON_UNIQUE = 0
  ) AND EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
      AND INDEX_NAME = 'uq_orders_idempotency'
      AND COLUMN_NAME = 'idempotency_key'
  ) AND 1 = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
      AND INDEX_NAME = 'idx_orders_idempotency_key'
      AND NON_UNIQUE = 0
  ) AND EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
      AND INDEX_NAME = 'idx_orders_idempotency_key'
      AND COLUMN_NAME = 'idempotency_key'
  ) THEN
    ALTER TABLE orders DROP INDEX idx_orders_idempotency_key;
  END IF;

  IF 1 = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'
      AND INDEX_NAME = 'phone'
      AND NON_UNIQUE = 0
  ) AND EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'
      AND INDEX_NAME = 'phone'
      AND COLUMN_NAME = 'phone'
  ) AND 1 = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'
      AND INDEX_NAME = 'idx_customers_phone'
      AND NON_UNIQUE = 0
  ) AND EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers'
      AND INDEX_NAME = 'idx_customers_phone'
      AND COLUMN_NAME = 'phone'
  ) THEN
    ALTER TABLE customers DROP INDEX idx_customers_phone;
  END IF;
END//

CALL `_ps_20260715_drop_duplicate_checkout_indexes`()//
DROP PROCEDURE `_ps_20260715_drop_duplicate_checkout_indexes`//

DELIMITER ;
