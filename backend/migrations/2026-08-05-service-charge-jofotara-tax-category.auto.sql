-- Hostinger-safe automatic repair for 2026-08-05-service-charge-jofotara-tax-category-v1.
-- Sets a positive-rate service charge to JoFotara category S; preserves O/Z at zero rate.

SET NAMES utf8mb4;

UPDATE settings AS category
JOIN settings AS rate
  ON rate.setting_key = 'service_charge_tax_rate'
SET category.setting_value = 'S'
WHERE category.setting_key = 'service_charge_jofotara_tax_category'
  AND CAST(COALESCE(NULLIF(TRIM(rate.setting_value), ''), '0') AS DECIMAL(10,2)) > 0
  AND category.setting_value <> 'S'
  AND NOT EXISTS (
    SELECT 1
    FROM schema_migrations
    WHERE migration_name = '2026-08-05-service-charge-jofotara-tax-category-v1'
  );

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-05-service-charge-jofotara-tax-category-v1',
  '9004d8ce5f3de65e3a90e2576d04a58e467b575e1b3bcd257ed11ea376ee8678'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
