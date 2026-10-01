-- Read-only preflight for 2026-09-01-product-price-override-lock-v1.
-- Require the exact predecessor, products table, and absent or exact target column.

SELECT CASE WHEN (
  predecessor_row_count = 1
  AND predecessor_exact_count = 1
  AND target_table_count = 1
  AND (
    target_column_count = 0
    OR (
      target_column_count = 1
      AND exact_column_count = 1
    )
  )
)
THEN 1 ELSE 0 END AS ok
FROM (
  SELECT
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-08-31-pos-order-history-default-v1') AS predecessor_row_count,
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-08-31-pos-order-history-default-v1'
        AND checksum = '862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b') AS predecessor_exact_count,
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND TABLE_TYPE = 'BASE TABLE') AS target_table_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND COLUMN_NAME = 'price_override_locked') AS target_column_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND COLUMN_NAME = 'price_override_locked'
        AND DATA_TYPE = 'tinyint'
        AND COLUMN_TYPE = 'tinyint(1)'
        AND IS_NULLABLE = 'NO'
        AND COLUMN_DEFAULT IN ('0', '''0''')) AS exact_column_count
) AS authority;
