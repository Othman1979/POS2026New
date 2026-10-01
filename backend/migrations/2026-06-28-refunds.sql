-- مرتجع (refund/return) feature schema

CREATE TABLE refunds (
  id                INT NOT NULL AUTO_INCREMENT,
  kind              ENUM('void','refund') NOT NULL,
  invoice_id        INT NOT NULL,
  scope             ENUM('order','item') NOT NULL DEFAULT 'order',
  subtotal_refunded DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  tax_refunded      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  amount_refunded   DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  refund_method     VARCHAR(20) DEFAULT NULL,
  reason            TEXT DEFAULT NULL,
  restocked         TINYINT(1) NOT NULL DEFAULT 0,
  user_id           INT NOT NULL,
  shift_id          INT DEFAULT NULL,
  table_id          INT DEFAULT NULL,
  ip_address        VARCHAR(64) DEFAULT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_refunds_invoice (invoice_id),
  KEY idx_refunds_kind (kind),
  KEY idx_refunds_created (created_at),
  KEY idx_refunds_user (user_id),
  KEY idx_refunds_shift (shift_id),
  CONSTRAINT fk_refunds_invoice FOREIGN KEY (invoice_id) REFERENCES orders (invoice_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE refund_items (
  id            INT NOT NULL AUTO_INCREMENT,
  refund_id     INT NOT NULL,
  order_item_id INT DEFAULT NULL,
  product_id    INT DEFAULT NULL,
  item_name     VARCHAR(255) DEFAULT NULL,
  note          VARCHAR(255) DEFAULT NULL,
  quantity      DECIMAL(10,3) NOT NULL,
  unit_price    DECIMAL(10,6) NOT NULL,
  line_subtotal DECIMAL(10,2) NOT NULL,
  line_tax      DECIMAL(10,2) NOT NULL,
  line_total    DECIMAL(10,2) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_refund_items_refund (refund_id),
  KEY idx_refund_items_order_item (order_item_id),
  KEY idx_refund_items_product (product_id),
  CONSTRAINT fk_refund_items_refund FOREIGN KEY (refund_id) REFERENCES refunds (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refund_status ENUM('none','partial','full') NOT NULL DEFAULT 'none';

-- Rename the unimplemented ajram.view placeholder into the real refund permission.
UPDATE user_permissions SET perm_key='pos.refund' WHERE perm_key='ajram.view';
UPDATE permissions
   SET perm_key='pos.refund',
       label='Process Refunds / Returns', label_ar='مرتجع',
       description='Void open table orders and refund paid orders.',
       description_ar='إلغاء طلبات الطاولات المفتوحة وإرجاع الطلبات المدفوعة.',
       category='pos', sort_order=140,
       implemented=1, default_cashier=0, overridable=0
 WHERE perm_key='ajram.view';
