-- Hostinger-safe automatic form of 2026-07-31-tax-exempt-checks.sql.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tax_exempt_at_sale TINYINT(1) NOT NULL DEFAULT 0
  AFTER tax_registration_type_at_sale;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS price_before_tax_exemption DECIMAL(10,6) NULL
  AFTER price_at_sale;

DELETE FROM user_permissions WHERE perm_key = 'pos.tax_exempt';

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES
  ('pos.tax_exempt', 'Tax Exempt', 'إعفاء ضريبي',
   'Apply tax exemption to the current unpaid check.',
   'تطبيق الإعفاء الضريبي على الفاتورة غير المدفوعة الحالية.',
   'pos', 100, 1, 0, 0)
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

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-07-31-tax-exempt-checks-v1', '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3');
