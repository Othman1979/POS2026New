-- 2026-08-31-pos-order-history-default-v1
-- Requires migration: 2026-08-30-jofotara-stale-submission-index-v1
-- Requires checksum: 5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed
-- Restrict POS Order Notes history to cashiers with an explicit orders.view grant.

SET NAMES utf8mb4;

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
VALUES (
  'orders.view',
  'POS Order History',
  'سجل طلبات نقطة البيع',
  'View recent orders, totals, and receipts in the POS Order Notes history. Does not grant Admin Orders access.',
  'عرض الطلبات الأخيرة والإجماليات والإيصالات في سجل ملاحظات الطلبات بنقطة البيع. لا يمنح الوصول إلى طلبات لوحة الإدارة.',
  'orders',
  100,
  1,
  0,
  0
)
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
VALUES (
  '2026-08-31-pos-order-history-default-v1',
  '862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
