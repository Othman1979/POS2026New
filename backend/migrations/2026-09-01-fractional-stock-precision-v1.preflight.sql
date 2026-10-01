-- Read-only preflight for 2026-09-01-fractional-stock-precision-v1.
-- Accept the exact legacy INT shapes or the exact DECIMAL(16,6) target shapes.

SELECT CASE WHEN (
  predecessor_row_count = 1
  AND predecessor_exact_count = 1
  AND target_table_count = 1
  AND (
    legacy_shape_count = 3
    OR target_shape_count = 3
  )
)
THEN 1 ELSE 0 END AS ok
FROM (
  SELECT
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-09-01-product-price-override-lock-v1') AS predecessor_row_count,
    (SELECT COUNT(*) FROM schema_migrations
      WHERE migration_name = '2026-09-01-product-price-override-lock-v1'
        AND checksum = 'e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8') AS predecessor_exact_count,
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND TABLE_TYPE = 'BASE TABLE') AS target_table_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND COLUMN_NAME IN ('stock', 'min_stock_level', 'max_stock_level')
        AND DATA_TYPE = 'int'
        AND COLUMN_TYPE = 'int(11)'
        AND NUMERIC_PRECISION = 10
        AND NUMERIC_SCALE = 0
        AND IS_NULLABLE = 'YES'
        AND (
          (COLUMN_NAME = 'stock' AND (COLUMN_DEFAULT IS NULL OR COLUMN_DEFAULT IN ('NULL', '''NULL''')))
          OR (COLUMN_NAME = 'min_stock_level' AND COLUMN_DEFAULT IN ('10', '''10'''))
          OR (COLUMN_NAME = 'max_stock_level' AND COLUMN_DEFAULT IN ('100', '''100'''))
        )) AS legacy_shape_count,
    (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'products'
        AND COLUMN_NAME IN ('stock', 'min_stock_level', 'max_stock_level')
        AND DATA_TYPE = 'decimal'
        AND COLUMN_TYPE = 'decimal(16,6)'
        AND NUMERIC_PRECISION = 16
        AND NUMERIC_SCALE = 6
        AND IS_NULLABLE = 'YES'
        AND (
          (COLUMN_NAME = 'stock' AND (COLUMN_DEFAULT IS NULL OR COLUMN_DEFAULT IN ('NULL', '''NULL''')))
          OR (COLUMN_NAME = 'min_stock_level' AND COLUMN_DEFAULT IN ('10', '10.000000', '''10''', '''10.000000'''))
          OR (COLUMN_NAME = 'max_stock_level' AND COLUMN_DEFAULT IN ('100', '100.000000', '''100''', '''100.000000'''))
        )) AS target_shape_count
) AS authority;
