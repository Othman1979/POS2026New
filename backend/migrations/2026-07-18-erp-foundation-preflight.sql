-- READ-ONLY PREFLIGHT. Select the client database, then run this whole file in phpMyAdmin.
-- Import the apply file only when the final blocking_findings value is 0.

SET @ps_required_tables := (
    SELECT COUNT(*) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('products', 'product_bundle_items', 'print_queue', 'printers')
);
SET @ps_missing_tables := 4 - @ps_required_tables;

SET @ps_nonpositive_bundles := IF(@ps_required_tables = 4,
    (SELECT COUNT(*) FROM product_bundle_items WHERE NOT (qty > 0)), 0);

SET @ps_bundle_orphans := IF(@ps_required_tables = 4,
    (SELECT COUNT(*)
       FROM product_bundle_items definition
       LEFT JOIN products bundle ON bundle.id = definition.bundle_id
       LEFT JOIN products component ON component.id = definition.product_id
      WHERE bundle.id IS NULL OR component.id IS NULL), 0);

SET @ps_fk_conflicts := (
    SELECT COUNT(*)
      FROM information_schema.KEY_COLUMN_USAGE kcu
      LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
       AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
       AND kcu.TABLE_NAME = 'product_bundle_items'
       AND kcu.CONSTRAINT_NAME IN ('fk_pbi_bundle', 'fk_pbi_product')
       AND NOT (
           (kcu.CONSTRAINT_NAME = 'fk_pbi_bundle' AND kcu.COLUMN_NAME = 'bundle_id'
            AND kcu.REFERENCED_TABLE_NAME = 'products' AND kcu.REFERENCED_COLUMN_NAME = 'id'
            AND rc.DELETE_RULE = 'CASCADE')
           OR
           (kcu.CONSTRAINT_NAME = 'fk_pbi_product' AND kcu.COLUMN_NAME = 'product_id'
            AND kcu.REFERENCED_TABLE_NAME = 'products' AND kcu.REFERENCED_COLUMN_NAME = 'id'
            AND rc.DELETE_RULE = 'RESTRICT')
       )
);

SET @ps_index_conflicts := (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'print_queue'
           AND INDEX_NAME IN (
               'uq_print_queue_idempotency', 'idx_print_queue_claim', 'idx_print_queue_state_locked',
               'idx_print_queue_state_created', 'idx_print_queue_reprint_of'
           )
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) <> CASE INDEX_NAME
            WHEN 'uq_print_queue_idempotency' THEN 'idempotency_key'
            WHEN 'idx_print_queue_claim' THEN 'status,locked_until,id'
            WHEN 'idx_print_queue_state_locked' THEN 'status,locked_until'
            WHEN 'idx_print_queue_state_created' THEN 'status,created_at'
            WHEN 'idx_print_queue_reprint_of' THEN 'reprint_of_queue_id'
        END
           OR (INDEX_NAME = 'uq_print_queue_idempotency' AND MIN(NON_UNIQUE) <> 0)
    ) conflicts
);

SET @ps_has_ledger := (
    SELECT COUNT(*) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'
);
SET @ps_ledger_conflict := 0;
SET @ps_sql := IF(
    @ps_has_ledger = 1,
    "SELECT COUNT(*) INTO @ps_ledger_conflict FROM schema_migrations WHERE migration_name = '2026-07-18-erp-foundation-v1' AND checksum <> 'c8ba2e8b9d0543048e6cf0b90e90779aa7bc89823a2fbd3ecfd540b64f0dbfd8'",
    'SET @ps_ledger_conflict := 0'
);
PREPARE ps_statement FROM @ps_sql;
EXECUTE ps_statement;
DEALLOCATE PREPARE ps_statement;

SELECT DATABASE() AS selected_database, VERSION() AS database_version;
SELECT @ps_missing_tables AS missing_required_tables;
SELECT @ps_nonpositive_bundles AS nonpositive_bundle_quantities;
SELECT @ps_bundle_orphans AS orphan_bundle_definitions_to_remove;
SELECT @ps_fk_conflicts AS foreign_key_name_conflicts;
SELECT @ps_index_conflicts AS print_queue_index_name_conflicts;
SELECT @ps_ledger_conflict AS migration_checksum_conflicts;
SELECT (
    @ps_missing_tables + @ps_nonpositive_bundles + @ps_fk_conflicts +
    @ps_index_conflicts + @ps_ledger_conflict
) AS blocking_findings;
