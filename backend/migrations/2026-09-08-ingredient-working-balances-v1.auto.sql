-- 2026-09-08-ingredient-working-balances-v1
-- Requires migration: 2026-09-08-stock-report-count-intervals-v1
-- Requires checksum: 6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4
-- Legacy ingredient projection. Activated ingredients read their physical ledger.
-- Historical initialization is bounded background work, not an upgrade-wide scan.
CREATE TABLE IF NOT EXISTS ingredient_working_balances (
 ingredient_id INT NOT NULL PRIMARY KEY,
 quantity DECIMAL(28,6) NOT NULL DEFAULT 0,
 quantity_known TINYINT(1) NOT NULL DEFAULT 0,
 last_count_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
 period_usage DECIMAL(28,6) NOT NULL DEFAULT 0,
 variance_qty DECIMAL(28,6) NULL,
 initialized TINYINT(1) NOT NULL DEFAULT 0,
 CONSTRAINT fk_ingredient_working_balance FOREIGN KEY(ingredient_id) REFERENCES ingredients(id) ON DELETE CASCADE
) ENGINE=InnoDB;
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-ingredient-working-balances-v1','bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
