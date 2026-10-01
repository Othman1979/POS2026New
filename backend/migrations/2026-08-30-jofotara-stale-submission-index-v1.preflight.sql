-- Read-only preflight for 2026-08-30-jofotara-stale-submission-index-v1.
-- Accept only the exact predecessor, target table/columns, and absent or exact index shape.

SELECT CASE WHEN (
  predecessor_row_count = 1
  AND predecessor_exact_count = 1
  AND target_table_count = 1
  AND required_column_count = 2
  AND (
    named_index_column_count = 0
    OR (
      named_index_column_count = 2
      AND named_index_nonunique_column_count = 2
      AND named_index_status_first_count = 1
      AND named_index_attempt_second_count = 1
    )
  )
)
THEN 1 ELSE 0 END AS ok
FROM (
  SELECT
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-08-23-audit-browser-preview-v1') AS predecessor_row_count,
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-08-23-audit-browser-preview-v1'
        AND checksum = 'e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af') AS predecessor_exact_count,
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'jofotara_documents'
        AND TABLE_TYPE = 'BASE TABLE') AS target_table_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'jofotara_documents'
        AND COLUMN_NAME IN ('status', 'last_attempt_at')) AS required_column_count,
    (SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'jofotara_documents'
        AND INDEX_NAME = 'idx_jofotara_status_attempt') AS named_index_column_count,
    (SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'jofotara_documents'
        AND INDEX_NAME = 'idx_jofotara_status_attempt'
        AND NON_UNIQUE = 1) AS named_index_nonunique_column_count,
    (SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'jofotara_documents'
        AND INDEX_NAME = 'idx_jofotara_status_attempt'
        AND COLUMN_NAME = 'status'
        AND SEQ_IN_INDEX = 1) AS named_index_status_first_count,
    (SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'jofotara_documents'
        AND INDEX_NAME = 'idx_jofotara_status_attempt'
        AND COLUMN_NAME = 'last_attempt_at'
        AND SEQ_IN_INDEX = 2) AS named_index_attempt_second_count
) AS authority;
