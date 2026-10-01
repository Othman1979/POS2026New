-- Print-template schema preflight (read-only, phpMyAdmin-safe).
-- Require blocking_findings = 0 before importing 2026-07-25-print-templates.sql.
SET NAMES utf8mb4;

SET @ps_print_templates_database := IF(DATABASE() IS NULL, 1, 0);
SET @ps_print_templates_dependencies := 12 - (
    SELECT COUNT(*)
      FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND (
            (TABLE_NAME = 'users' AND COLUMN_NAME = 'id' AND DATA_TYPE = 'int') OR
            (TABLE_NAME = 'printers' AND COLUMN_NAME = 'id' AND DATA_TYPE = 'int') OR
            (TABLE_NAME = 'print_queue' AND COLUMN_NAME = 'id' AND DATA_TYPE = 'int') OR
            (TABLE_NAME = 'settings' AND COLUMN_NAME IN ('setting_key', 'setting_value') AND DATA_TYPE = 'varchar') OR
            (TABLE_NAME = 'audit_events' AND COLUMN_NAME = 'id' AND DATA_TYPE = 'bigint') OR
            (TABLE_NAME = 'audit_events' AND COLUMN_NAME IN ('event_type', 'entity_type') AND DATA_TYPE = 'varchar') OR
            (TABLE_NAME = 'audit_events' AND COLUMN_NAME = 'entity_id' AND DATA_TYPE = 'bigint') OR
            (TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'migration_name' AND COLUMN_TYPE = 'varchar(190)') OR
            (TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'checksum' AND COLUMN_TYPE = 'char(64)') OR
            (TABLE_NAME = 'schema_migrations' AND COLUMN_NAME = 'applied_at' AND DATA_TYPE = 'datetime')
       )
);

SELECT 'selected_database' AS check_name, @ps_print_templates_database AS blocking_findings
UNION ALL SELECT 'required_dependencies', @ps_print_templates_dependencies;
SELECT @ps_print_templates_database + @ps_print_templates_dependencies AS blocking_findings;
