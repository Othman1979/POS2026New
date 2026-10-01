-- 2026-09-08-stock-availability-policy-v1
-- Requires migration: 2026-09-08-stock-report-facts-v1
-- Requires checksum: c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb
-- Strict remains the default for existing packaged-stock identities.
-- Estimate records recipe usage without inventing a counted opening balance.
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS availability_policy VARCHAR(12) NOT NULL DEFAULT 'strict';
ALTER TABLE stock_items ADD CONSTRAINT IF NOT EXISTS ck_stock_item_availability
 CHECK (availability_policy IN ('strict','estimate'));
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-availability-policy-v1','161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
