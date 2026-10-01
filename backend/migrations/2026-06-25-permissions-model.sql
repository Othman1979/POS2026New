-- Cashier permission system: normalized catalog + per-user grants.
-- Cashier-scope only. Waiter-specific columns are intentionally left untouched.

-- Ensures the client interprets the Arabic catalog text below as UTF-8 even when
-- applied via the Windows mysql.exe CLI (which otherwise defaults to cp850 and
-- double-encodes the bytes into mojibake). Required for the INSERT to store correctly.
SET NAMES utf8mb4;

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

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable) VALUES
('pos.checkout',          'Checkout Orders',       'إتمام الطلبات',      'Finalize an order and take payment.',                'إنهاء الطلب واستلام الدفع.',            'pos',    10, 1, 1, 0),
('pos.hold_orders',       'Hold Orders',           'تعليق الطلبات',      'Park an order to retrieve and finish later.',        'تعليق الطلب لاسترجاعه لاحقاً.',         'pos',    20, 1, 1, 0),
('pos.split_checks',      'Split Checks',          'تقسيم الفاتورة',     'Split one bill into multiple checks.',               'تقسيم الفاتورة إلى عدة شيكات.',         'pos',    30, 1, 0, 0),
('pos.discount',          'Discount Button',       'زر الخصم',           'Apply a percent or value discount.',                 'تطبيق خصم نسبة أو قيمة.',               'pos',    40, 1, 0, 1),
('pos.price_override',    'Price Override Button', 'تعديل السعر',        'Manually override an item price.',                   'تعديل سعر الصنف يدوياً.',               'pos',    50, 1, 0, 1),
('pos.void_item',         'Void Line Item',        'إلغاء صنف',          'Remove or void a line item from the order.',         'إزالة أو إلغاء صنف من الطلب.',          'pos',    60, 1, 0, 1),
('pos.void_printed_item', 'Void Printed Item',     'إلغاء صنف مطبوع',    'Void an item already sent to the kitchen printer.',  'إلغاء صنف أُرسل إلى طابعة المطبخ.',     'pos',    70, 1, 0, 1),
('pos.tax_exempt',        'Tax Exempt Toggle',     'إعفاء ضريبي',        'Mark a sale as tax exempt (zero tax).',             'تعليم الفاتورة كمعفاة من الضريبة.',      'pos',    80, 1, 0, 1),
('pos.reprint_receipt',   'Reprint Receipt',       'إعادة طباعة الإيصال','Reprint the last or a selected receipt.',            'إعادة طباعة آخر إيصال أو إيصال محدد.',  'pos',    90, 1, 0, 1),
('orders.view',           'View Orders',           'عرض الطلبات',        'View and recall past and held orders.',             'عرض واسترجاع الطلبات السابقة والمعلقة.', 'orders',100, 1, 1, 0),
('shift.open',            'Open Register',         'فتح الوردية',        'Open a register shift with a starting float.',       'فتح وردية الصندوق برصيد ابتدائي.',      'shift', 110, 1, 1, 0),
('shift.close',           'Close Own Shift (Z)',   'إغلاق الوردية',      'Close own shift and submit the cash count.',        'إغلاق الوردية وإدخال عدّ النقد.',        'shift', 120, 1, 1, 0),
('tables.access',         'Access Tables Page',    'دخول صفحة الطاولات', 'View the floor plan and cash out table orders.',     'عرض مخطط الطاولات ودفع طلبات الطاولات.', 'tables',130, 1, 0, 0),
('ajram.view',            'View عجرم Page',         'عرض صفحة عجرم',      'Placeholder — عجرم page not implemented yet.',        'عنصر نائب — صفحة عجرم غير منفذة بعد.',  'other', 900, 0, 0, 0);

-- Backfill grants from legacy columns for active non-admin users (preserve current access).
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.hold_orders'       FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND canholdorders = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.discount'          FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_apply_discount = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.void_item'         FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_void_items = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.void_printed_item' FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND bypass_printed_tables = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'orders.view'           FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_view_orders = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'shift.open'            FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND can_open_register = 1;
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.split_checks'      FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer') AND waiter_split_bill = 1;

-- Backfill capabilities everyone has today (no gate exists yet) — grant to all non-admins.
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.checkout' FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer');
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'shift.close'  FROM users WHERE is_active=1 AND role NOT IN ('admin','programmer');

-- Preserve current WAITER behavior for the new security gates (cashiers intentionally excluded — must be granted explicitly).
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.tax_exempt'      FROM users WHERE is_active=1 AND role = 'waiter';
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.reprint_receipt' FROM users WHERE is_active=1 AND role = 'waiter';
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'pos.price_override'  FROM users WHERE is_active=1 AND role = 'waiter';
INSERT IGNORE INTO user_permissions (user_id, perm_key) SELECT id, 'tables.access'       FROM users WHERE is_active=1 AND role = 'waiter';
