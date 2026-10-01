-- 2026-09-01-product-price-override-lock-v1
-- Requires migration: 2026-08-31-pos-order-history-default-v1
-- Requires checksum: 862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b
-- Requires normalized SQL SHA-256: f7c795ccbc34a515d365f9135e14366b9d86a30a179fb13e5745f064f5c71983
-- Add a per-product lock for manual price entry; existing products remain overrideable.

SET NAMES utf8mb4;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS price_override_locked TINYINT(1) NOT NULL DEFAULT 0,
  ALGORITHM=INSTANT, LOCK=NONE;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-01-product-price-override-lock-v1',
  'e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
