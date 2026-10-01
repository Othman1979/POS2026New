SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS expense_categories (
  id         INT NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_by INT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_expense_categories_name (name),
  KEY idx_expense_categories_active_sort (is_active, sort_order, id),
  CONSTRAINT fk_expense_categories_user FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id INT NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  source      VARCHAR(16) NOT NULL,
  shift_id    INT DEFAULT NULL,
  note        VARCHAR(255) NOT NULL DEFAULT '',
  status      VARCHAR(16) NOT NULL DEFAULT 'active',
  created_by  INT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  canceled_by INT DEFAULT NULL,
  canceled_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_expenses_created_status (created_at, status),
  KEY idx_expenses_shift_status (shift_id, status),
  KEY idx_expenses_category_created (category_id, created_at),
  KEY idx_expenses_created_by (created_by),
  CONSTRAINT fk_expenses_category FOREIGN KEY (category_id) REFERENCES expense_categories(id),
  CONSTRAINT fk_expenses_shift FOREIGN KEY (shift_id) REFERENCES shifts(id),
  CONSTRAINT fk_expenses_created_by FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_expenses_canceled_by FOREIGN KEY (canceled_by) REFERENCES users(id),
  CONSTRAINT chk_expenses_amount CHECK (amount > 0),
  CONSTRAINT chk_expenses_source CHECK (source IN ('drawer', 'outside')),
  CONSTRAINT chk_expenses_status CHECK (status IN ('active', 'canceled')),
  CONSTRAINT chk_expenses_drawer_shift CHECK (
    (source = 'drawer' AND shift_id IS NOT NULL) OR
    (source = 'outside' AND shift_id IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
  ('pos.expenses', 'Record Expenses', 'تسجيل المصروفات',
   'Record an expense from the user''s open cash shift.',
   'تسجيل مصروف من وردية الصندوق المفتوحة للمستخدم.',
   'pos', 95, 1, 0, 0)
ON DUPLICATE KEY UPDATE
  label = VALUES(label), label_ar = VALUES(label_ar),
  description = VALUES(description), description_ar = VALUES(description_ar),
  category = VALUES(category), sort_order = VALUES(sort_order),
  implemented = VALUES(implemented), default_cashier = VALUES(default_cashier),
  overridable = VALUES(overridable);
