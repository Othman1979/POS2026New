-- 2026-09-19-customer-phone-index-v1
-- Requires migration: 2026-09-17-print-queue-timings-v1
-- Requires checksum: 3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e
-- Index the existing customer-phone normalization without changing raw values or uniqueness.
SET NAMES utf8mb4;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS phone_normalized VARCHAR(20)
    GENERATED ALWAYS AS (
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), '')
    ) STORED AFTER phone;

ALTER TABLE customers
  ADD INDEX IF NOT EXISTS idx_customers_phone_normalized (phone_normalized, id);

INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-19-customer-phone-index-v1', '3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
