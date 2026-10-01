-- 2026-10-01-retire-purchasing-tables-v1
-- Requires migration: 2026-09-30-purchase-invoices-v1
-- Requires checksum: d229b196f899d443ff68488c68107943028175b3cf716a067e2d36a74406e2b9
-- Retires the purchasing tables that have had no writer since 2026-09-09. Each table is dropped only when it exists and holds no rows; a table with history is kept untouched.

SET NAMES utf8mb4;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustment_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_price_adjustment_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustment_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_price_adjustment_lines'), 'DROP TABLE `stock_price_adjustment_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustments' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_price_adjustments` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_price_adjustments' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_price_adjustments'), 'DROP TABLE `stock_price_adjustments`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_return_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_vendor_return_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_return_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_vendor_return_lines'), 'DROP TABLE `stock_vendor_return_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_returns' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_vendor_returns` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_vendor_returns' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_vendor_returns'), 'DROP TABLE `stock_vendor_returns`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_receipt_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_receipt_lines'), 'DROP TABLE `stock_receipt_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipts' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_receipts` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipts' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_receipts'), 'DROP TABLE `stock_receipts`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_order_lines' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_purchase_order_lines` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_order_lines' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_purchase_order_lines'), 'DROP TABLE `stock_purchase_order_lines`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_orders' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_purchase_orders` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_purchase_orders' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_purchase_orders'), 'DROP TABLE `stock_purchase_orders`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_supplier_items' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_supplier_items` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_supplier_items' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_supplier_items'), 'DROP TABLE `stock_supplier_items`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

SET @retire_rows = 0;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_suppliers' AND TABLE_TYPE='BASE TABLE')=1, 'SELECT EXISTS(SELECT 1 FROM `stock_suppliers` LIMIT 1) INTO @retire_rows', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;
SET @retire_sql = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_suppliers' AND TABLE_TYPE='BASE TABLE')=1 AND @retire_rows=0 AND NOT EXISTS (SELECT 1 FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME='stock_suppliers'), 'DROP TABLE `stock_suppliers`', 'SELECT 1');
PREPARE retire_stmt FROM @retire_sql;
EXECUTE retire_stmt;
DEALLOCATE PREPARE retire_stmt;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-10-01-retire-purchasing-tables-v1',
  '1acb658d7fbe0b41efbb60b9d5c67f715b970e63a051e88263b43440f7c8372b'
)
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
