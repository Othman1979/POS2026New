-- 2026-09-01-fractional-stock-precision-v1
-- Requires migration: 2026-09-01-product-price-override-lock-v1
-- Requires checksum: e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8
-- Requires normalized SQL SHA-256: 9e9bf23a05e6df78932a3e78d6df7fdea9690e2f7b5be97e139a708d5d587a64
-- Widen product stock and thresholds to six-decimal precision while preserving
-- the signed INT range and existing nullability/default semantics.
-- MariaDB 10.4 requires COPY/SHARED for this type conversion.

SET NAMES utf8mb4;

ALTER TABLE products
  MODIFY COLUMN stock DECIMAL(16,6) DEFAULT NULL,
  MODIFY COLUMN min_stock_level DECIMAL(16,6) DEFAULT 10,
  MODIFY COLUMN max_stock_level DECIMAL(16,6) DEFAULT 100,
  ALGORITHM=COPY, LOCK=SHARED;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-09-01-fractional-stock-precision-v1',
  'b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
