-- POST-IMPORT VERIFICATION. Every missing_count and verification_failures must be 0.

SET @ps_warehouse_columns := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'warehouse_id'
);
SET @ps_redundant_indexes := (
    SELECT COUNT(DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME))
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (
           (TABLE_NAME = 'qr_table_drafts' AND INDEX_NAME = 'idx_qr_drafts_table')
           OR (TABLE_NAME = 'restaurant_tables' AND INDEX_NAME = 'section_id')
       )
);
SET @ps_missing_qr_primary := 1 - (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'qr_table_drafts' AND INDEX_NAME = 'PRIMARY'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'table_id'
           AND MIN(NON_UNIQUE) = 0
    ) required_index
);
SET @ps_missing_table_unique := 1 - (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurant_tables' AND INDEX_NAME = 'uq_table_section_number'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'section_id,table_number'
           AND MIN(NON_UNIQUE) = 0
    ) required_index
);
SET @ps_missing_ledger := 1 - (
    SELECT COUNT(*) FROM schema_migrations
     WHERE migration_name = '2026-07-18-foundation-final-hygiene-v1'
       AND checksum = 'c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021'
);

SELECT 'unused_warehouse_column' AS check_name, @ps_warehouse_columns AS missing_count
UNION ALL SELECT 'redundant_indexes', @ps_redundant_indexes
UNION ALL SELECT 'qr_primary_index', @ps_missing_qr_primary
UNION ALL SELECT 'restaurant_table_unique_index', @ps_missing_table_unique
UNION ALL SELECT 'migration_ledger', @ps_missing_ledger;

SELECT (
    @ps_warehouse_columns + @ps_redundant_indexes + @ps_missing_qr_primary +
    @ps_missing_table_unique + @ps_missing_ledger
) AS verification_failures;
