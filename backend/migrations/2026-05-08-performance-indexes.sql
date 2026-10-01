-- Targeted indexes for POS/admin production workloads.
-- Apply once after checking for existing index names in deployment.

ALTER TABLE products
  ADD INDEX idx_products_active_name (is_active, name),
  ADD INDEX idx_products_active_id (is_active, id),
  ADD INDEX idx_products_active_category (is_active, category_id),
  ADD INDEX idx_products_stock_alert (is_active, stock);

ALTER TABLE orders
  ADD INDEX idx_orders_created_at (created_at),
  ADD INDEX idx_orders_payment_created (payment_method, created_at),
  ADD INDEX idx_orders_shift_payment (shift_id, payment_method),
  ADD INDEX idx_orders_customer_payment (customer_id, payment_method),
  ADD INDEX idx_orders_order_id (order_id);

ALTER TABLE customers
  ADD INDEX idx_customers_name (name);
