-- 2026-09-08-procurement-request-integrity-v1
-- Requires migration: 2026-09-08-stock-procurement-v1
-- Requires checksum: a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d
ALTER TABLE stock_purchase_orders ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_vendor_returns ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_price_adjustments ADD COLUMN IF NOT EXISTS request_hash CHAR(64) DEFAULT NULL;
ALTER TABLE stock_receipt_lines ADD COLUMN IF NOT EXISTS returned_qty DECIMAL(16,6) NOT NULL DEFAULT 0;
UPDATE stock_receipt_lines l LEFT JOIN (
 SELECT rl.receipt_line_id,SUM(rl.quantity) quantity FROM stock_vendor_return_lines rl
 JOIN stock_vendor_returns r ON r.id=rl.vendor_return_id WHERE r.status='posted' GROUP BY rl.receipt_line_id
) returned ON returned.receipt_line_id=l.id SET l.returned_qty=COALESCE(returned.quantity,0);
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-procurement-request-integrity-v1','257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
