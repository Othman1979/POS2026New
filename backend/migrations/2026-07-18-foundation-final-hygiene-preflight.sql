-- READ-ONLY PREFLIGHT. Import the apply file only when blocking_findings = 0.

SET @ps_required_tables := (
    SELECT COUNT(*) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('products', 'qr_table_drafts', 'restaurant_tables', 'schema_migrations')
);
SET @ps_missing_tables := 4 - @ps_required_tables;

SET @ps_foundation_ledger_invalid := 1;
SET @ps_sql := IF(
    @ps_required_tables = 4,
    "SELECT 1 - COUNT(*) INTO @ps_foundation_ledger_invalid FROM schema_migrations WHERE migration_name = '2026-07-18-erp-foundation-v1' AND checksum = 'c8ba2e8b9d0543048e6cf0b90e90779aa7bc89823a2fbd3ecfd540b64f0dbfd8'",
    'SET @ps_foundation_ledger_invalid := 1'
);
PREPARE ps_statement FROM @ps_sql;
EXECUTE ps_statement;
DEALLOCATE PREPARE ps_statement;

SET @ps_qr_index_conflicts := (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'qr_table_drafts'
           AND INDEX_NAME = 'idx_qr_drafts_table'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) <> 'table_id'
           OR MIN(NON_UNIQUE) <> 0
    ) conflicts
);
SET @ps_table_index_conflicts := (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'restaurant_tables'
           AND INDEX_NAME = 'section_id'
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) <> 'section_id,table_number'
           OR MIN(NON_UNIQUE) <> 0
    ) conflicts
);

SET @ps_checksum_conflicts := 0;
SET @ps_sql := IF(
    @ps_required_tables = 4,
    "SELECT COUNT(*) INTO @ps_checksum_conflicts FROM schema_migrations WHERE migration_name = '2026-07-18-foundation-final-hygiene-v1' AND checksum <> 'c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021'",
    'SET @ps_checksum_conflicts := 0'
);
PREPARE ps_statement FROM @ps_sql;
EXECUTE ps_statement;
DEALLOCATE PREPARE ps_statement;

SELECT DATABASE() AS selected_database, VERSION() AS database_version;
SELECT @ps_missing_tables AS missing_required_tables;
SELECT @ps_foundation_ledger_invalid AS missing_or_invalid_foundation_migration;
SELECT @ps_qr_index_conflicts AS qr_index_name_conflicts;
SELECT @ps_table_index_conflicts AS restaurant_table_index_name_conflicts;
SELECT @ps_checksum_conflicts AS migration_checksum_conflicts;
SELECT (
    @ps_missing_tables + @ps_foundation_ledger_invalid + @ps_qr_index_conflicts +
    @ps_table_index_conflicts + @ps_checksum_conflicts
) AS blocking_findings;
