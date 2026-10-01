-- POST-IMPORT VERIFICATION for 2026-07-31-tax-exempt-checks.sql.

SET @ps_missing_order_column := 1 - (
    SELECT COUNT(*)
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'tax_exempt_at_sale'
       AND DATA_TYPE = 'tinyint'
       AND COLUMN_TYPE = 'tinyint(1)'
       AND IS_NULLABLE = 'NO'
       AND COLUMN_DEFAULT IN ('0', '''0''')
);
SET @ps_missing_item_column := 1 - (
    SELECT COUNT(*)
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_items'
       AND COLUMN_NAME = 'price_before_tax_exemption'
       AND DATA_TYPE = 'decimal'
       AND COLUMN_TYPE = 'decimal(10,6)'
       AND IS_NULLABLE = 'YES'
);
SET @ps_missing_permission := 1 - (
    SELECT COUNT(*)
      FROM permissions
     WHERE perm_key = 'pos.tax_exempt'
       AND label_ar = 'إعفاء ضريبي'
       AND implemented = 1
       AND default_cashier = 0
       AND overridable = 0
);
SET @ps_unexpected_grants := (
    SELECT COUNT(*) FROM user_permissions WHERE perm_key = 'pos.tax_exempt'
);
SET @ps_missing_ledger := 1 - (
    SELECT COUNT(*)
      FROM schema_migrations
     WHERE migration_name = '2026-07-31-tax-exempt-checks-v1'
       AND checksum = '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3'
);

SELECT 'tax_exempt_order_column' AS check_name, @ps_missing_order_column AS missing_count
UNION ALL SELECT 'tax_exempt_original_price_column', @ps_missing_item_column
UNION ALL SELECT 'tax_exempt_permission', @ps_missing_permission
UNION ALL SELECT 'tax_exempt_automatic_grants', @ps_unexpected_grants
UNION ALL SELECT 'tax_exempt_migration_ledger', @ps_missing_ledger;

SELECT (
    @ps_missing_order_column + @ps_missing_item_column + @ps_missing_permission +
    @ps_unexpected_grants + @ps_missing_ledger
) AS verification_failures;
