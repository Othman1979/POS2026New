-- 2026-08-11-receipt-tax-display-v1
-- Requires migration: 2026-08-10-call-center-held-orders-v1
-- Requires checksum: f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b
-- Requires normalized SQL SHA-256: f1b384472c35fc84e30d7c970582cef03964a51773e7ea61c658bd77829121bc
-- Freeze customer-receipt tax-inclusive presentation without changing sale tax accounting.
-- Existing rows remain NULL and continue using their historical receipt mode.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_tax_inclusive_at_sale TINYINT(1) NULL AFTER tax_inclusive_at_sale;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-11-receipt-tax-display-v1',
  '90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
