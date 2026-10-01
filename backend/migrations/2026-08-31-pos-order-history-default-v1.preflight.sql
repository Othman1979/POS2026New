-- Read-only preflight for 2026-08-31-pos-order-history-default-v1.
-- Require the exact predecessor, permissions table, and complete catalog columns.

SELECT CASE WHEN (
  predecessor_row_count = 1
  AND predecessor_exact_count = 1
  AND permissions_table_count = 1
  AND required_column_count = 10
)
THEN 1 ELSE 0 END AS ok
FROM (
  SELECT
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-08-30-jofotara-stale-submission-index-v1') AS predecessor_row_count,
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-08-30-jofotara-stale-submission-index-v1'
        AND checksum = '5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed') AS predecessor_exact_count,
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'permissions'
        AND TABLE_TYPE = 'BASE TABLE') AS permissions_table_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'permissions'
        AND COLUMN_NAME IN (
          'perm_key', 'label', 'label_ar', 'description', 'description_ar',
          'category', 'sort_order', 'implemented', 'default_cashier', 'overridable'
        )) AS required_column_count
) AS authority;
