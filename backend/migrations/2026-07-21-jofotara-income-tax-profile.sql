-- Adds immutable tax-registration profile snapshots and isolates JoFotara credentials.
-- Safe to rerun: guarded DDL, explicit backfills, and non-destructive scoped upserts.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tax_registration_type_at_sale ENUM('sales_tax','income_tax') NULL
  AFTER tax_inclusive_at_sale;

UPDATE orders
   SET tax_registration_type_at_sale = 'sales_tax'
 WHERE tax_registration_type_at_sale IS NULL;

ALTER TABLE orders
  MODIFY COLUMN tax_registration_type_at_sale ENUM('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax';

ALTER TABLE jofotara_documents
  ADD COLUMN IF NOT EXISTS tax_registration_type ENUM('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax'
  AFTER document_kind;

UPDATE jofotara_documents
   SET tax_registration_type = 'sales_tax'
 WHERE tax_registration_type IS NULL;

INSERT INTO settings (setting_key, setting_value)
SELECT 'jofotara_sales_tax_client_id', legacy.setting_value
  FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_client_id') legacy
ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

INSERT INTO settings (setting_key, setting_value)
SELECT 'jofotara_sales_tax_secret_key', legacy.setting_value
  FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_secret_key') legacy
ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

INSERT INTO settings (setting_key, setting_value)
SELECT 'jofotara_sales_tax_income_source_sequence', legacy.setting_value
  FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_income_source_sequence') legacy
ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

INSERT INTO settings (setting_key, setting_value)
SELECT 'jofotara_sales_tax_seller_tax_number', legacy.setting_value
  FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_seller_tax_number') legacy
ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

INSERT INTO settings (setting_key, setting_value)
SELECT 'jofotara_sales_tax_seller_registered_name', legacy.setting_value
  FROM (SELECT setting_value FROM settings WHERE setting_key = 'jofotara_seller_registered_name') legacy
ON DUPLICATE KEY UPDATE setting_value = IF(settings.setting_value = '', VALUES(setting_value), settings.setting_value);

INSERT INTO settings (setting_key, setting_value) VALUES
  ('tax_registration_type', 'sales_tax'),
  ('jofotara_sales_tax_client_id', ''),
  ('jofotara_sales_tax_secret_key', ''),
  ('jofotara_sales_tax_income_source_sequence', ''),
  ('jofotara_sales_tax_seller_tax_number', ''),
  ('jofotara_sales_tax_seller_registered_name', ''),
  ('jofotara_income_tax_client_id', ''),
  ('jofotara_income_tax_secret_key', ''),
  ('jofotara_income_tax_income_source_sequence', ''),
  ('jofotara_income_tax_seller_tax_number', ''),
  ('jofotara_income_tax_seller_registered_name', '')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

DELETE FROM settings
 WHERE setting_key IN (
    'jofotara_client_id',
    'jofotara_secret_key',
    'jofotara_income_source_sequence',
    'jofotara_seller_tax_number',
    'jofotara_seller_registered_name'
 );
