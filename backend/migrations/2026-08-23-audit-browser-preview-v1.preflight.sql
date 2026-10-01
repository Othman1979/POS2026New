-- Read-only preflight for the audit browser preview status migration.
-- Accept the exact predecessor and either the legacy or already-upgraded enum.

SELECT CASE WHEN (
  predecessor_checksum = 'e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985'
  AND status_type IN (
    'enum(''queued'',''printed'',''failed'')',
    'enum(''queued'',''printed'',''failed'',''browser_ready'')'
  )
)
THEN 1 ELSE 0 END AS ok
FROM (
  SELECT
    (SELECT checksum FROM schema_migrations
      WHERE migration_name = '2026-08-17-spooler-v2-agents-v1' LIMIT 1) AS predecessor_checksum,
    (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'audit_report_documents'
        AND COLUMN_NAME = 'last_print_status' LIMIT 1) AS status_type
) AS authority;
