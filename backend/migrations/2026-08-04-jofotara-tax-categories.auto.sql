-- Hostinger-safe automatic form of 2026-08-04-jofotara-tax-categories-v1.
-- Preconditions, checksum conflicts, file integrity, and serialization are enforced by runPendingMigrations.js.

SET NAMES utf8mb4;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS jofotara_tax_category CHAR(1) NOT NULL DEFAULT 'O'
  AFTER tax_rate;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS jofotara_tax_category CHAR(1) NOT NULL DEFAULT 'O'
  AFTER tax_rate;

ALTER TABLE service_charge_snapshots
  ADD COLUMN IF NOT EXISTS jofotara_tax_category CHAR(1) NOT NULL DEFAULT 'O'
  AFTER tax_rate;

UPDATE products
SET jofotara_tax_category = CASE WHEN tax_rate > 0 THEN 'S' ELSE 'O' END
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE migration_name = '2026-08-04-jofotara-tax-categories-v1'
);

UPDATE order_items AS oi
LEFT JOIN orders AS o ON o.invoice_id = oi.invoice_id
SET oi.jofotara_tax_category = CASE
  WHEN o.tax_exempt_at_sale = 1 THEN 'Z'
  WHEN oi.tax_rate > 0 THEN 'S'
  ELSE 'O'
END
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE migration_name = '2026-08-04-jofotara-tax-categories-v1'
);

UPDATE service_charge_snapshots
SET jofotara_tax_category = CASE WHEN tax_rate > 0 THEN 'S' ELSE 'O' END
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE migration_name = '2026-08-04-jofotara-tax-categories-v1'
);

ALTER TABLE products
  ADD CONSTRAINT IF NOT EXISTS chk_products_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

ALTER TABLE order_items
  ADD CONSTRAINT IF NOT EXISTS chk_order_items_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

ALTER TABLE service_charge_snapshots
  ADD CONSTRAINT IF NOT EXISTS chk_service_charge_snapshots_jofotara_tax_category
  CHECK (jofotara_tax_category IN ('S','Z','O'));

INSERT INTO settings (setting_key, setting_value)
VALUES ('service_charge_jofotara_tax_category', 'O')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-04-jofotara-tax-categories-v1',
  'dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
