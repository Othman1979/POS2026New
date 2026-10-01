-- READ-ONLY PREFLIGHT for 2026-07-31-tax-exempt-checks.sql.
-- Run against the selected client database before importing the apply file.

SET @ps_required_tables := (
    SELECT COUNT(*)
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('orders', 'order_items', 'permissions', 'user_permissions', 'schema_migrations')
);
SET @ps_missing_tables := 5 - @ps_required_tables;

SET @ps_missing_order_column := 1 - (
    SELECT COUNT(*)
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'tax_registration_type_at_sale'
);
SET @ps_missing_item_column := 1 - (
    SELECT COUNT(*)
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_items'
       AND COLUMN_NAME = 'price_at_sale'
);

SET @ps_has_ledger := (
    SELECT COUNT(*)
      FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'
);
SET @ps_ledger_conflict := 0;
SET @ps_sql := IF(
    @ps_has_ledger = 1,
    "SELECT COUNT(*) INTO @ps_ledger_conflict FROM schema_migrations WHERE migration_name = '2026-07-31-tax-exempt-checks-v1' AND checksum <> '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3'",
    'SET @ps_ledger_conflict := 0'
);
PREPARE ps_statement FROM @ps_sql;
EXECUTE ps_statement;
DEALLOCATE PREPARE ps_statement;

SELECT DATABASE() AS selected_database, VERSION() AS database_version;
SELECT @ps_required_tables AS required_tables_found;
SELECT @ps_missing_tables AS missing_required_tables;
SELECT @ps_missing_order_column AS missing_order_prerequisite;
SELECT @ps_missing_item_column AS missing_item_prerequisite;
SELECT @ps_ledger_conflict AS migration_checksum_conflicts;
SELECT (
    @ps_missing_tables + @ps_missing_order_column + @ps_missing_item_column + @ps_ledger_conflict
) AS blocking_findings;
