-- Adds the pos.service_charge catalog key. Applying a service charge was ungated
-- (anyone could add it); this introduces an explicit permission. Default OFF for
-- everyone (default_cashier=0, no backfill) — admin grants it per cashier in the
-- users page. Apply through a utf8mb4 client (apply-service-charge-permission.js or
-- mysql --default-character-set=utf8mb4) so the Arabic text is not mangled.
SET NAMES utf8mb4;

INSERT INTO permissions
  (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable) VALUES
('pos.service_charge', 'Apply Service Charge', 'تطبيق رسوم الخدمة', 'Add the auto-gratuity service charge to an order.', 'إضافة رسوم الخدمة (الإكرامية التلقائية) إلى الطلب.', 'pos', 85, 1, 0, 0)
ON DUPLICATE KEY UPDATE label=VALUES(label), label_ar=VALUES(label_ar), description=VALUES(description), description_ar=VALUES(description_ar), category=VALUES(category), sort_order=VALUES(sort_order);
