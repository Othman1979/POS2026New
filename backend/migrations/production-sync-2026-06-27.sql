-- ============================================================
-- PRODUCTION SYNC — 2026-06-27
-- Run this on the Hostinger DB to bring it in line with code.
-- Covers all migrations from 2026-06-04 through 2026-06-27.
--
-- SAFE TO RE-RUN: steps 1-3 and 5-6 are idempotent.
-- STEP 4 (price conversion) is ONE-TIME — see warning there.
-- Apply through a UTF-8 client:
--   mysql --default-character-set=utf8mb4 -u <user> <db> < production-sync-2026-06-27.sql
-- ============================================================

SET NAMES utf8mb4;

-- ============================================================
-- 1. NEW TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS permissions (
  perm_key        VARCHAR(64)  NOT NULL,
  label           VARCHAR(120) NOT NULL,
  label_ar        VARCHAR(120) NOT NULL,
  description     VARCHAR(255) NOT NULL DEFAULT '',
  description_ar  VARCHAR(255) NOT NULL DEFAULT '',
  category        VARCHAR(32)  NOT NULL,
  sort_order      INT          NOT NULL DEFAULT 0,
  implemented     TINYINT(1)   NOT NULL DEFAULT 1,
  default_cashier TINYINT(1)   NOT NULL DEFAULT 0,
  overridable     TINYINT(1)   NOT NULL DEFAULT 0,
  PRIMARY KEY (perm_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id  INT         NOT NULL,
  perm_key VARCHAR(64) NOT NULL,
  PRIMARY KEY (user_id, perm_key),
  KEY idx_user_permissions_perm (perm_key),
  CONSTRAINT fk_uperm_user FOREIGN KEY (user_id)  REFERENCES users(id)            ON DELETE CASCADE,
  CONSTRAINT fk_uperm_perm FOREIGN KEY (perm_key) REFERENCES permissions(perm_key) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;


-- ============================================================
-- 2. NEW COLUMNS ON EXISTING TABLES
-- ============================================================

-- users: cashier print-check capability
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS can_print_check TINYINT(1) NULL DEFAULT 0;

-- held_orders: tracks whether kitchen receipt was fired
-- THIS IS WHY FIRE KITCHEN FROM HELD ORDERS BROKE —
-- the column was missing on production.
ALTER TABLE held_orders
  ADD COLUMN IF NOT EXISTS kitchen_fired TINYINT(1) NOT NULL DEFAULT 0;

-- restaurant_tables: allow alphanumeric table numbers (e.g. "T1", "Bar-3")
ALTER TABLE restaurant_tables
  MODIFY COLUMN table_number VARCHAR(50) NOT NULL DEFAULT '';

-- order_items: per-item tax recording for JoFotara
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10,6) NOT NULL DEFAULT 0 AFTER tax_rate;


-- ============================================================
-- 3. COLUMN PRECISION UPGRADES (safe to repeat)
-- ============================================================

ALTER TABLE products
  MODIFY COLUMN price DECIMAL(10,6) NOT NULL;

ALTER TABLE price_history
  MODIFY COLUMN old_price DECIMAL(10,6) NOT NULL;

ALTER TABLE price_history
  MODIFY COLUMN new_price DECIMAL(10,6) NOT NULL;

ALTER TABLE order_items
  MODIFY COLUMN price_at_sale DECIMAL(10,6) NOT NULL;


-- ============================================================
-- 4. ONE-TIME PRICE CONVERSION  *** READ BEFORE RUNNING ***
--
-- These UPDATE statements strip embedded tax out of product
-- prices so the POS can add it back cleanly (no double-tax).
--
-- IF YOU ALREADY APPLIED THESE ON THIS DB — SKIP THIS BLOCK.
-- Running them twice will divide prices a second time and
-- corrupt your product catalogue.
--
-- How to check: SELECT name, price, tax_rate FROM products
-- WHERE tax_rate > 0 LIMIT 5;
-- If prices look like 4.62963 (pre-tax) they are ALREADY done.
-- If prices look like 5.00 (gross, round) they still need this.
-- ============================================================

-- Step A: divide stored prices by (1 + rate/100) to get pre-tax
UPDATE products
SET price = price / (1 + tax_rate / 100)
WHERE tax_rate > 0;

-- Step B: precision backfill — reconstructs original gross at 2dp
-- then re-divides at full 6dp to avoid the 5.56→6.0048 drift bug.
UPDATE products
SET price = ROUND(price * (1 + tax_rate / 100), 2) / (1 + tax_rate / 100)
WHERE tax_rate > 0;

-- Backfill tax_amount for existing order_items rows.
-- Uses inclusive formula because old rows stored gross prices.
UPDATE order_items SET tax_amount =
    CASE
        WHEN tax_rate = 0 THEN 0
        WHEN discount_type = 'fixed' THEN
            GREATEST(0, (price_at_sale - COALESCE(discount_value, 0)) * quantity) * tax_rate / (100 + tax_rate)
        WHEN discount_type = 'percent' THEN
            price_at_sale * quantity * (1 - COALESCE(discount_value, 0) / 100) * tax_rate / (100 + tax_rate)
        ELSE
            price_at_sale * quantity * tax_rate / (100 + tax_rate)
    END;


-- ============================================================
-- 5. PERMISSION CATALOG (idempotent — ON DUPLICATE KEY UPDATE)
-- ============================================================

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable) VALUES
('pos.checkout',          'Checkout Orders',       'إتمام الطلبات',         'Finalize an order and take payment.',                 'إنهاء الطلب واستلام الدفع.',              'pos',    10, 1, 1, 0),
('pos.hold_orders',       'Hold Orders',           'تعليق الطلبات',         'Park an order to retrieve and finish later.',         'تعليق الطلب لاسترجاعه لاحقاً.',           'pos',    20, 1, 1, 0),
('pos.split_checks',      'Split Checks',          'تقسيم الفاتورة',        'Split one bill into multiple checks.',                'تقسيم الفاتورة إلى عدة شيكات.',           'pos',    30, 1, 0, 0),
('pos.discount',          'Discount Button',       'زر الخصم',              'Apply a percent or value discount.',                  'تطبيق خصم نسبة أو قيمة.',                 'pos',    40, 1, 0, 1),
('pos.price_override',    'Price Override Button', 'تعديل السعر',           'Manually override an item price.',                    'تعديل سعر الصنف يدوياً.',                 'pos',    50, 1, 0, 1),
('pos.void_item',         'Void Line Item',        'إلغاء صنف',             'Remove or void a line item from the order.',          'إزالة أو إلغاء صنف من الطلب.',            'pos',    60, 1, 0, 1),
('pos.void_printed_item', 'Void Printed Item',     'إلغاء صنف مطبوع',       'Void an item already sent to the kitchen printer.',   'إلغاء صنف أُرسل إلى طابعة المطبخ.',       'pos',    70, 1, 0, 1),
('pos.tax_exempt',        'Tax Exempt Toggle',     'إعفاء ضريبي',           'Mark a sale as tax exempt (zero tax).',               'تعليم الفاتورة كمعفاة من الضريبة.',        'pos',    80, 1, 0, 1),
('pos.reprint_receipt',   'Reprint Receipt',       'إعادة طباعة الإيصال',   'Reprint the last or a selected receipt.',             'إعادة طباعة آخر إيصال أو إيصال محدد.',    'pos',    90, 1, 0, 1),
('pos.service_charge',    'Apply Service Charge',  'تطبيق رسوم الخدمة',     'Add the auto-gratuity service charge to an order.',   'إضافة رسوم الخدمة (الإكرامية التلقائية) إلى الطلب.', 'pos', 85, 1, 0, 0),
('orders.view',           'View Orders',           'عرض الطلبات',           'View and recall past and held orders.',               'عرض واسترجاع الطلبات السابقة والمعلقة.',   'orders',100, 1, 1, 0),
('shift.open',            'Open Register',         'فتح الوردية',           'Open a register shift with a starting float.',        'فتح وردية الصندوق برصيد ابتدائي.',        'shift', 110, 1, 1, 0),
('shift.close',           'Close Own Shift (Z)',   'إغلاق الوردية',         'Close own shift and submit the cash count.',          'إغلاق الوردية وإدخال عدّ النقد.',          'shift', 120, 1, 1, 0),
('tables.access',         'Access Tables Page',    'دخول صفحة الطاولات',    'View the floor plan and cash out table orders.',      'عرض مخطط الطاولات ودفع طلبات الطاولات.',   'tables',130, 1, 0, 0),
('waiter.edit_locked',    'Edit Saved Order',      'تعديل طلب محفوظ',       'Edit or add to an order after it has been saved/sent.','تعديل أو الإضافة إلى طلب بعد حفظه/إرساله.','waiter',200, 1, 0, 0),
('waiter.override_tables','Override Others\' Tables','تجاوز طاولات الآخرين', 'Act on a table owned by another waiter.',             'العمل على طاولة يملكها نادل آخر.',         'waiter',210, 1, 0, 0),
('waiter.checkout',       'Checkout Table',        'دفع الطاولة',           'Settle and take payment for a table order.',          'تسوية واستلام دفع طلب الطاولة.',           'waiter',220, 1, 0, 0),
('waiter.transfer_table', 'Transfer Table',        'نقل الطاولة',           'Move an order from one table to another.',            'نقل الطلب من طاولة إلى أخرى.',             'waiter',230, 1, 0, 0),
('waiter.merge_tables',   'Merge Tables',          'دمج الطاولات',          'Join or merge tables together.',                     'ضم أو دمج الطاولات معاً.',                 'waiter',240, 1, 0, 0),
('ajram.view',            'View عجرم Page',          'عرض صفحة عجرم',         'Placeholder — عجرم page not implemented yet.',         'عنصر نائب — صفحة عجرم غير منفذة بعد.',    'other', 900, 0, 0, 0)
ON DUPLICATE KEY UPDATE
  label=VALUES(label), label_ar=VALUES(label_ar),
  description=VALUES(description), description_ar=VALUES(description_ar),
  category=VALUES(category), sort_order=VALUES(sort_order);


-- ============================================================
-- 6. PERMISSION GRANTS BACKFILL (idempotent — INSERT IGNORE)
-- Reads your existing users table legacy columns and grants
-- the matching normalized permission. Safe to re-run.
-- ============================================================

-- Cashier grants from legacy columns
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.hold_orders'       FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND canholdorders=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.discount'          FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_apply_discount=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.void_item'         FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_void_items=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.void_printed_item' FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND bypass_printed_tables=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'orders.view'           FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_view_orders=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'shift.open'            FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_open_register=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.split_checks'      FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND waiter_split_bill=1;

-- Everyone who could checkout/close before — keep that access
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.checkout' FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer');
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'shift.close'  FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer');

-- Waiter-specific grants from legacy columns
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.edit_locked'     FROM users WHERE is_active=1 AND role='waiter' AND can_update_table=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.override_tables' FROM users WHERE is_active=1 AND role='waiter' AND bypass_existing_tables=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.transfer_table'  FROM users WHERE is_active=1 AND role='waiter' AND can_transfer_table=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'waiter.merge_tables'    FROM users WHERE is_active=1 AND role='waiter' AND can_join_tables=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.void_printed_item'  FROM users WHERE is_active=1 AND role='waiter' AND bypass_printed_tables=1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.split_checks'       FROM users WHERE is_active=1 AND role='waiter' AND (waiter_split_bill=1 OR can_split_bills=1);
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'orders.view'            FROM users WHERE is_active=1 AND role='waiter' AND can_view_order_history=1;

-- Waiter default perms (always had these, no legacy column to check)
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.tax_exempt'      FROM users WHERE is_active=1 AND role='waiter';
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.reprint_receipt' FROM users WHERE is_active=1 AND role='waiter';
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.price_override'  FROM users WHERE is_active=1 AND role='waiter';
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'tables.access'       FROM users WHERE is_active=1 AND role='waiter';

-- Close the orders.view gap for anyone still holding legacy flag
INSERT IGNORE INTO user_permissions (user_id, perm_key)
  SELECT id, 'orders.view'
  FROM users
  WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_view_order_history=1;


-- ============================================================
-- 7. REFUNDS SCHEMA  (2026-06-28 — مرتجع feature)
-- ============================================================

CREATE TABLE IF NOT EXISTS refunds (
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

CREATE TABLE IF NOT EXISTS refund_items (
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
