-- POST-IMPORT VERIFICATION. Every missing_count and final verification_failures must be 0.

SET @ps_bad_bundles := (
    SELECT COUNT(*)
      FROM product_bundle_items definition
      LEFT JOIN products bundle ON bundle.id = definition.bundle_id
      LEFT JOIN products component ON component.id = definition.product_id
     WHERE NOT (definition.qty > 0) OR bundle.id IS NULL OR component.id IS NULL
);
SET @ps_missing_bundle_fks := 2 - (
    SELECT COUNT(*)
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
       AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
       AND kcu.TABLE_NAME = 'product_bundle_items'
       AND kcu.REFERENCED_TABLE_NAME = 'products'
       AND kcu.REFERENCED_COLUMN_NAME = 'id'
       AND (
           (kcu.CONSTRAINT_NAME = 'fk_pbi_bundle' AND kcu.COLUMN_NAME = 'bundle_id' AND rc.DELETE_RULE = 'CASCADE')
           OR
           (kcu.CONSTRAINT_NAME = 'fk_pbi_product' AND kcu.COLUMN_NAME = 'product_id' AND rc.DELETE_RULE = 'RESTRICT')
       )
);
SET @ps_missing_print_columns := 20 - (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_queue'
       AND COLUMN_NAME IN (
           'status', 'idempotency_key', 'payload_hash', 'printer_id', 'print_type',
           'claimed_by', 'spooler_id', 'spooler_version', 'locked_until', 'attempts',
           'max_attempts', 'first_attempt_at', 'last_error', 'device_status', 'sent_at',
           'acknowledged_at', 'duration_ms', 'next_retry_at', 'reprint_of_queue_id', 'last_seen_at'
       )
);
SET @ps_missing_printer_columns := 4 - (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'printers'
       AND COLUMN_NAME IN ('status_capability', 'device_status', 'status_checked_at', 'status_source')
);
SET @ps_missing_print_indexes := 5 - (
    SELECT COUNT(*) FROM (
        SELECT INDEX_NAME
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_queue'
           AND INDEX_NAME IN (
               'uq_print_queue_idempotency', 'idx_print_queue_claim', 'idx_print_queue_state_locked',
               'idx_print_queue_state_created', 'idx_print_queue_reprint_of'
           )
         GROUP BY INDEX_NAME
        HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = CASE INDEX_NAME
            WHEN 'uq_print_queue_idempotency' THEN 'idempotency_key'
            WHEN 'idx_print_queue_claim' THEN 'status,locked_until,id'
            WHEN 'idx_print_queue_state_locked' THEN 'status,locked_until'
            WHEN 'idx_print_queue_state_created' THEN 'status,created_at'
            WHEN 'idx_print_queue_reprint_of' THEN 'reprint_of_queue_id'
        END
           AND (INDEX_NAME <> 'uq_print_queue_idempotency' OR MIN(NON_UNIQUE) = 0)
    ) required_indexes
);
SET @ps_duplicate_print_index := (
    SELECT COUNT(*) FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_queue'
       AND INDEX_NAME = 'idx_print_queue_status_created'
);
SET @ps_missing_ledger := 1 - (
    SELECT COUNT(*) FROM schema_migrations
     WHERE migration_name = '2026-07-18-erp-foundation-v1'
       AND checksum = 'c8ba2e8b9d0543048e6cf0b90e90779aa7bc89823a2fbd3ecfd540b64f0dbfd8'
);

SELECT 'bundle_definitions' AS check_name, @ps_bad_bundles AS missing_count
UNION ALL SELECT 'bundle_foreign_keys', @ps_missing_bundle_fks
UNION ALL SELECT 'print_queue_columns', @ps_missing_print_columns
UNION ALL SELECT 'printer_status_columns', @ps_missing_printer_columns
UNION ALL SELECT 'print_queue_indexes', @ps_missing_print_indexes
UNION ALL SELECT 'duplicate_print_queue_index', @ps_duplicate_print_index
UNION ALL SELECT 'migration_ledger', @ps_missing_ledger;

SELECT (
    @ps_bad_bundles + @ps_missing_bundle_fks + @ps_missing_print_columns +
    @ps_missing_printer_columns + @ps_missing_print_indexes +
    @ps_duplicate_print_index + @ps_missing_ledger
) AS verification_failures;
