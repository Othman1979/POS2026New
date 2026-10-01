-- POST-IMPORT VERIFICATION. Every missing_count and verification_failures must be 0.

SET @ps_missing_printer_columns := 2 - (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'printers'
       AND COLUMN_NAME IN ('spooler_id', 'active_endpoint_key')
);
SET @ps_bad_queue_printer_type := 1 - (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'print_queue'
       AND COLUMN_NAME = 'printer_id' AND DATA_TYPE = 'int'
);
SET @ps_missing_owner_indexes := 3 - (
    SELECT COUNT(DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME))
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (
           (TABLE_NAME = 'printers' AND INDEX_NAME IN ('idx_printers_spooler', 'uq_printers_active_endpoint'))
           OR (TABLE_NAME = 'print_queue' AND INDEX_NAME = 'idx_print_queue_owner_claim')
       )
);
SET @ps_duplicate_active_endpoints := (
    SELECT COUNT(*) FROM (
        SELECT active_endpoint_key
          FROM printers
         WHERE active_endpoint_key IS NOT NULL
         GROUP BY active_endpoint_key
        HAVING COUNT(*) > 1
    ) duplicate_endpoints
);
SET @ps_missing_ledger := 1 - (
    SELECT COUNT(*) FROM schema_migrations
     WHERE migration_name = '2026-07-19-multi-spooler-printer-ownership-v1'
       AND checksum = '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d'
);

SELECT 'printer_owner_columns' AS check_name, @ps_missing_printer_columns AS missing_count
UNION ALL SELECT 'queue_printer_type', @ps_bad_queue_printer_type
UNION ALL SELECT 'owner_indexes', @ps_missing_owner_indexes
UNION ALL SELECT 'duplicate_active_endpoints', @ps_duplicate_active_endpoints
UNION ALL SELECT 'migration_ledger', @ps_missing_ledger;

SELECT (
    @ps_missing_printer_columns + @ps_bad_queue_printer_type + @ps_missing_owner_indexes +
    @ps_duplicate_active_endpoints + @ps_missing_ledger
) AS verification_failures;
