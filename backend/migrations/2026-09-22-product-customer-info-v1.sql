-- 2026-09-22-product-customer-info-v1
-- Requires migration: 2026-09-20-order-intake-requests-v1
-- Requires checksum: 8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab
-- Optional customer-facing information; no price, stock or order changes.
SET NAMES utf8mb4;
ALTER TABLE products ADD COLUMN IF NOT EXISTS customer_info TEXT DEFAULT NULL, ALGORITHM=INSTANT, LOCK=NONE;
INSERT INTO schema_migrations (migration_name, checksum)
VALUES ('2026-09-22-product-customer-info-v1', 'e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
