SET @progressive_split_columns := 2 - (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders'
     AND COLUMN_NAME IN ('parent_invoice_id','table_id')
);
SET @progressive_split_indexes := 2 - (
  SELECT COUNT(DISTINCT INDEX_NAME) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders'
     AND INDEX_NAME IN ('idx_held_orders_parent_invoice','idx_held_orders_split_table')
);
SET @progressive_split_foreign_keys := 2 - (
  SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='held_orders'
     AND CONSTRAINT_NAME IN ('fk_held_orders_parent_invoice','fk_held_orders_split_table')
);
SET @progressive_split_ledger := 1 - (
  SELECT COUNT(*) FROM schema_migrations
   WHERE migration_name='2026-07-24-progressive-split-checks-v1'
     AND checksum='14178039d66459e3b898cd2038e5570df68edd714e31fb4fb9935ce7b765c3c4'
);

SELECT 'progressive_split_columns' check_name, @progressive_split_columns blocking_findings
UNION ALL SELECT 'progressive_split_indexes', @progressive_split_indexes
UNION ALL SELECT 'progressive_split_foreign_keys', @progressive_split_foreign_keys
UNION ALL SELECT 'progressive_split_ledger', @progressive_split_ledger;
SELECT @progressive_split_columns + @progressive_split_indexes +
       @progressive_split_foreign_keys + @progressive_split_ledger AS blocking_findings;
