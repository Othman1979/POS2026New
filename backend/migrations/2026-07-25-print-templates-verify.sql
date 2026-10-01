-- Print-template schema verification (read-only, phpMyAdmin-safe).
SET NAMES utf8mb4;

SET @ps_print_template_tables := 3 - (
    SELECT COUNT(*) FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN ('print_templates', 'print_template_revisions', 'print_template_revision_tests')
       AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_general_ci'
);
SET @ps_print_template_columns := 28 - (
    SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (
            (TABLE_NAME='print_templates' AND COLUMN_NAME='id' AND COLUMN_TYPE='bigint(20) unsigned' AND IS_NULLABLE='NO' AND EXTRA='auto_increment') OR
            (TABLE_NAME='print_templates' AND COLUMN_NAME='document_type' AND COLUMN_TYPE='varchar(16)' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_templates' AND COLUMN_NAME IN ('active_revision_id','draft_revision_id') AND COLUMN_TYPE='bigint(20) unsigned' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_templates' AND COLUMN_NAME='lock_version' AND COLUMN_TYPE='int(10) unsigned' AND IS_NULLABLE='NO' AND COLUMN_DEFAULT='0') OR
            (TABLE_NAME='print_templates' AND COLUMN_NAME='created_at' AND COLUMN_TYPE='datetime' AND IS_NULLABLE='NO' AND COLUMN_DEFAULT='current_timestamp()') OR
            (TABLE_NAME='print_templates' AND COLUMN_NAME='updated_at' AND COLUMN_TYPE='datetime' AND IS_NULLABLE='NO' AND COLUMN_DEFAULT='current_timestamp()' AND EXTRA='on update current_timestamp()') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='id' AND COLUMN_TYPE='bigint(20) unsigned' AND IS_NULLABLE='NO' AND EXTRA='auto_increment') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='template_id' AND COLUMN_TYPE='bigint(20) unsigned' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='revision_no' AND COLUMN_TYPE='int(10) unsigned' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='schema_version' AND COLUMN_TYPE='smallint(5) unsigned' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='definition_json' AND DATA_TYPE='longtext' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_bin') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='definition_hash' AND COLUMN_TYPE='char(64)' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='created_by' AND COLUMN_TYPE='int(11)' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='created_at' AND COLUMN_TYPE='datetime' AND IS_NULLABLE='NO' AND COLUMN_DEFAULT='current_timestamp()') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='last_compile_error_code' AND COLUMN_TYPE='varchar(64)' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='last_compile_error_message' AND COLUMN_TYPE='varchar(500)' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_template_revisions' AND COLUMN_NAME='last_compile_failed_at' AND COLUMN_TYPE='datetime' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='id' AND COLUMN_TYPE='bigint(20) unsigned' AND IS_NULLABLE='NO' AND EXTRA='auto_increment') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='revision_id' AND COLUMN_TYPE='bigint(20) unsigned' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='printer_id' AND COLUMN_TYPE='int(11)' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='printer_name' AND COLUMN_TYPE='varchar(200)' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='printer_endpoint_key' AND COLUMN_TYPE='varchar(255)' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='queue_id' AND COLUMN_TYPE='int(11)' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='spooler_version' AND COLUMN_TYPE='varchar(64)' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='acknowledged_at' AND COLUMN_TYPE='datetime' AND IS_NULLABLE='NO') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='confirmed_by' AND COLUMN_TYPE='int(11)' AND IS_NULLABLE='YES') OR
            (TABLE_NAME='print_template_revision_tests' AND COLUMN_NAME='confirmed_at' AND COLUMN_TYPE='datetime' AND IS_NULLABLE='NO' AND COLUMN_DEFAULT='current_timestamp()')
       )
);
SET @ps_print_template_primary_keys := 3 - (
    SELECT COUNT(*) FROM (
        SELECT TABLE_NAME, INDEX_NAME, MIN(NON_UNIQUE) AS non_unique,
               CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) AS columns_in_order
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA=DATABASE()
           AND TABLE_NAME IN ('print_templates','print_template_revisions','print_template_revision_tests')
           AND INDEX_NAME='PRIMARY'
         GROUP BY TABLE_NAME, INDEX_NAME
        HAVING non_unique=0 AND columns_in_order='id'
    ) AS verified_primary_keys
);
SET @ps_print_template_indexes := 6 - (
    SELECT COUNT(*) FROM (
        SELECT TABLE_NAME, INDEX_NAME, MIN(NON_UNIQUE) AS non_unique,
               CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) AS columns_in_order
          FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND (TABLE_NAME, INDEX_NAME) IN (
               ('print_templates','uq_print_templates_document_type'),
               ('print_template_revisions','uq_print_template_revision_no'),
               ('print_template_revisions','uq_print_template_revision_hash'),
               ('print_template_revisions','idx_print_template_revisions_history'),
               ('print_template_revision_tests','uq_print_template_revision_test_queue'),
               ('print_template_revision_tests','idx_print_template_tests_revision_printer')
           )
         GROUP BY TABLE_NAME, INDEX_NAME
        HAVING (TABLE_NAME='print_templates' AND INDEX_NAME='uq_print_templates_document_type' AND non_unique=0 AND columns_in_order='document_type')
            OR (TABLE_NAME='print_template_revisions' AND INDEX_NAME='uq_print_template_revision_no' AND non_unique=0 AND columns_in_order='template_id,revision_no')
            OR (TABLE_NAME='print_template_revisions' AND INDEX_NAME='uq_print_template_revision_hash' AND non_unique=0 AND columns_in_order='template_id,definition_hash')
            OR (TABLE_NAME='print_template_revisions' AND INDEX_NAME='idx_print_template_revisions_history' AND non_unique=1 AND columns_in_order='template_id,created_at,id')
            OR (TABLE_NAME='print_template_revision_tests' AND INDEX_NAME='uq_print_template_revision_test_queue' AND non_unique=0 AND columns_in_order='queue_id')
            OR (TABLE_NAME='print_template_revision_tests' AND INDEX_NAME='idx_print_template_tests_revision_printer' AND non_unique=1 AND columns_in_order='revision_id,printer_id,confirmed_at,id')
    ) AS verified_indexes
);
SET @ps_print_template_foreign_keys := 8 - (
    SELECT COUNT(*)
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
       AND rc.TABLE_NAME = kcu.TABLE_NAME
       AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
       AND (
            (kcu.TABLE_NAME='print_templates' AND kcu.CONSTRAINT_NAME='fk_print_templates_active_revision' AND kcu.COLUMN_NAME='active_revision_id' AND kcu.REFERENCED_TABLE_NAME='print_template_revisions' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
            (kcu.TABLE_NAME='print_templates' AND kcu.CONSTRAINT_NAME='fk_print_templates_draft_revision' AND kcu.COLUMN_NAME='draft_revision_id' AND kcu.REFERENCED_TABLE_NAME='print_template_revisions' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
            (kcu.TABLE_NAME='print_template_revisions' AND kcu.CONSTRAINT_NAME='fk_print_template_revisions_template' AND kcu.COLUMN_NAME='template_id' AND kcu.REFERENCED_TABLE_NAME='print_templates' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
            (kcu.TABLE_NAME='print_template_revisions' AND kcu.CONSTRAINT_NAME='fk_print_template_revisions_creator' AND kcu.COLUMN_NAME='created_by' AND kcu.REFERENCED_TABLE_NAME='users' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL') OR
            (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_revision' AND kcu.COLUMN_NAME='revision_id' AND kcu.REFERENCED_TABLE_NAME='print_template_revisions' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
            (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_printer' AND kcu.COLUMN_NAME='printer_id' AND kcu.REFERENCED_TABLE_NAME='printers' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL') OR
            (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_queue' AND kcu.COLUMN_NAME='queue_id' AND kcu.REFERENCED_TABLE_NAME='print_queue' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL') OR
            (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_confirmer' AND kcu.COLUMN_NAME='confirmed_by' AND kcu.REFERENCED_TABLE_NAME='users' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL')
       )
);
SET @ps_print_template_checks := 3 - (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
     WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK'
       AND (
            (tc.TABLE_NAME='print_templates' AND tc.CONSTRAINT_NAME='chk_print_templates_document_type' AND REPLACE(cc.CHECK_CLAUSE, '`', '')='document_type in (''receipt'',''kitchen'')') OR
            (tc.TABLE_NAME='print_template_revisions' AND tc.CONSTRAINT_NAME='chk_print_template_revision_no' AND REPLACE(cc.CHECK_CLAUSE, '`', '')='revision_no > 0') OR
            (tc.TABLE_NAME='print_template_revisions' AND tc.CONSTRAINT_NAME='chk_print_template_revision_json' AND REPLACE(cc.CHECK_CLAUSE, '`', '')='json_valid(definition_json)')
       )
);
SET @ps_print_template_verify_sql := IF(
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='print_template_revisions')=1,
    'SELECT COUNT(*) INTO @ps_print_template_json_validity FROM print_template_revisions WHERE NOT JSON_VALID(definition_json)',
    'SELECT 1 INTO @ps_print_template_json_validity'
);
PREPARE ps_print_template_verify FROM @ps_print_template_verify_sql;
EXECUTE ps_print_template_verify;
DEALLOCATE PREPARE ps_print_template_verify;
SET @ps_print_template_verify_sql := IF(
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='print_templates')=1,
    'SELECT ABS(2 - COUNT(*)) INTO @ps_print_template_seed_rows FROM print_templates WHERE document_type IN (''receipt'',''kitchen'')',
    'SELECT 1 INTO @ps_print_template_seed_rows'
);
PREPARE ps_print_template_verify FROM @ps_print_template_verify_sql;
EXECUTE ps_print_template_verify;
DEALLOCATE PREPARE ps_print_template_verify;
SET @ps_print_template_verify_sql := IF(
    (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='schema_migrations')=1,
    'SELECT 1 - COUNT(*) INTO @ps_print_template_ledger FROM schema_migrations WHERE migration_name=''2026-07-25-print-templates-v1'' AND checksum=''d5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07''',
    'SELECT 1 INTO @ps_print_template_ledger'
);
PREPARE ps_print_template_verify FROM @ps_print_template_verify_sql;
EXECUTE ps_print_template_verify;
DEALLOCATE PREPARE ps_print_template_verify;

SELECT 'print_template_tables' AS check_name, @ps_print_template_tables AS blocking_findings
UNION ALL SELECT 'print_template_required_columns', @ps_print_template_columns
UNION ALL SELECT 'print_template_primary_keys', @ps_print_template_primary_keys
UNION ALL SELECT 'print_template_required_indexes', @ps_print_template_indexes
UNION ALL SELECT 'print_template_foreign_keys', @ps_print_template_foreign_keys
UNION ALL SELECT 'print_template_required_checks', @ps_print_template_checks
UNION ALL SELECT 'print_template_json_validity', @ps_print_template_json_validity
UNION ALL SELECT 'print_template_seed_rows', @ps_print_template_seed_rows
UNION ALL SELECT 'print_template_ledger', @ps_print_template_ledger;
SELECT @ps_print_template_tables + @ps_print_template_columns + @ps_print_template_primary_keys +
       @ps_print_template_indexes + @ps_print_template_foreign_keys + @ps_print_template_checks +
       @ps_print_template_json_validity + @ps_print_template_seed_rows + @ps_print_template_ledger AS blocking_findings;
