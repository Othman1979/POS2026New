-- Align the database schema with workflows already implemented in the POS UI.
-- Safe to run once. Check column definitions before reapplying in deployment.

ALTER TABLE orders
  MODIFY payment_method ENUM('cash','card','split','unpaid_table') NOT NULL;

UPDATE orders
SET payment_method = 'unpaid_table'
WHERE payment_method = '';

ALTER TABLE order_items
  MODIFY product_id INT(11) NULL;

ALTER TABLE order_items
  MODIFY quantity DECIMAL(10,3) NOT NULL;
