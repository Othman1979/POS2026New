-- 2026-09-08-stock-report-ingredient-rebuild-v1
-- Requires migration: 2026-09-08-stock-item-projections-v1
-- Requires checksum: 6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b
-- Withdraw facts built by the old ingredient streamer. Physical ledgers are untouched.
-- Replaying after a partial migration is safe: only live pointers are invalidated.
-- Revoke the current worker lease before withdrawing published pointers.
UPDATE stock_report_worker SET lease_owner=NULL,lease_until=NULL WHERE id=1 AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-ingredient-rebuild-v1');
UPDATE stock_report_dirty SET generation=generation+1,pending=1,dirty_at=CURRENT_TIMESTAMP(6),
 published_build_id=NULL,published_generation=NULL,as_of=NULL,
 active_build_id=NULL,lease_owner=NULL,lease_until=NULL
 WHERE (published_build_id IS NOT NULL OR active_build_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-ingredient-rebuild-v1');
UPDATE stock_report_builds b LEFT JOIN stock_report_dirty d
 ON d.published_build_id=b.id OR d.active_build_id=b.id
 SET b.state=IF(b.state='building','abandoned','obsolete')
 WHERE d.day IS NULL AND b.state IN ('building','published') AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-ingredient-rebuild-v1');
INSERT INTO schema_migrations(migration_name,checksum) VALUES ('2026-09-08-stock-report-ingredient-rebuild-v1','73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329')
ON DUPLICATE KEY UPDATE migration_name=VALUES(migration_name);
