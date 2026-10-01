SET NAMES utf8mb4;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_available TINYINT(1) NOT NULL DEFAULT 1 AFTER is_active;

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
  ('pos.product_availability', 'Manage Product Availability', 'إدارة توفر الأصناف',
   'Mark products as sold out or return them to sale.',
   'إيقاف بيع الأصناف النافدة أو إعادتها للبيع.',
   'pos', 97, 1, 0, 0)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  label_ar = VALUES(label_ar),
  description = VALUES(description),
  description_ar = VALUES(description_ar),
  category = VALUES(category),
  sort_order = VALUES(sort_order),
  implemented = VALUES(implemented),
  default_cashier = VALUES(default_cashier),
  overridable = VALUES(overridable);
