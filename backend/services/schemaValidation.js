const { catalog } = require('../config/permissionCatalog');
const { querySchemaChecks } = require('./schemaMetadata');
const MIGRATION_NAME = '2026-10-04-packaging-units-v1';
const MIGRATION_CHECKSUM = 'bac6fdbf2e9f5b3d8321c0d61c0bfdf58670dd8659e18a1e5673cc8ccaecdae6';

const REQUIRED_COUNTS = Object.freeze({
    table_access_scope_column: 1,
    customer_phone_normalized_column: 1,
    customer_phone_normalized_index: 1,
    current_permission_catalog: catalog.length,
    deleted_columns: 10,
    deleted_event_key: 1,
    deleted_invoice_index: 1,
    deleted_refund_foreign_key: 1,
    refund_nullable_invoice: 1,
    seating_parent_column: 1,
    seating_parent_index: 1,
    seating_parent_foreign_key: 1,
    paid_split_parent_index: 1,
    table_action_columns: 7,
    table_action_operation_key: 1,
    product_customer_info_column: 1,
    expense_request_key: 1,
    order_intake_request_columns: 6,
    order_intake_request_keys: 3,
    order_intake_request_checks: 1,
    print_queue_columns: 30,
    printer_status_columns: 5,
    durable_status: 1,
    bundle_foreign_keys: 2,
    baseline_authority_foreign_keys: 9,
    order_reference_foreign_keys: 4,
    order_reference_indexes: 2,
    legacy_permission_columns: 0,
    canonical_permission_tables: 2,
    print_queue_indexes: 6,
    migration_table: 1,
    warehouse_columns: 0,
    product_price_override_lock_column: 1,
    product_stock_precision: 3,
    product_stock_version: 1,
    stock_operation_columns: 8,
    stock_operation_request_key: 1,
    stock_core_columns: 30,
    retired_ingredient_movement_table: 0,
    unified_movement_columns: 24,
    unified_movement_identity_keys: 2,
    unified_movement_checks: 4,
    unified_movement_ingredient_fk: 1,

    retired_stock_dimensions: 0,
    retired_ingredient_state_tables: 0,
    ingredient_working_index: 1,
    ingredient_state_checks: 2,
    stock_identity_keys: 2,
    stock_identity_foreign_key: 1,
    stock_ab_projection_columns:37,
    stock_ab_projection_keys:9,
    stock_ab_projection_foreign_keys:3,
    stock_operation_context_columns: 3,
    stock_sale_snapshot_columns: 2,
    retired_subscription_tables: 0,
    retired_subscription_permissions: 0,
    retired_subscription_grants: 0,
    retired_subscription_setting: 0,
    stock_active_name_index: 1,
    stock_report_generation_columns: 20,
    stock_report_generation_keys: 5,
    stock_report_generation_foreign_keys: 2,
    stock_report_generation_checks: 5,
    stock_report_fact_columns: 40,
    stock_report_fact_keys: 7,
    stock_report_fact_foreign_keys: 4,
    stock_report_fact_checks: 1,
    stock_availability_policy: 1,
    stock_availability_check: 1,
    stock_ingredient_cutover_columns: 16,
    stock_ingredient_cutover_keys: 6,
    stock_ingredient_cutover_foreign_keys: 3,
    stock_ingredient_cutover_checks: 1,
    stock_item_projection_columns: 2,
    stock_item_projection_keys: 2,
    stock_item_projection_checks: 1,
    stock_movement_item_day_index: 1,
    redundant_indexes: 0,
    printer_owner_columns: 2,
    print_queue_printer_type: 1,
    printer_owner_indexes: 3,
    tax_registration_columns: 2,
    tax_registration_settings: 11,
    tax_registration_selector: 1,
    obsolete_jofotara_settings: 0,
    category_price_list_column: 1,
    category_price_list_index: 1,
    category_price_list_foreign_key: 1,
    product_price_overrides_table: 1,
    product_price_overrides_primary_key: 1,
    product_price_overrides_foreign_keys: 2,
    product_price_overrides_nonnegative_constraint: 1,
    progressive_split_columns: 2,
    progressive_split_indexes: 2,
    progressive_split_foreign_keys: 2,
    jofotara_operations_settings: 2,
    print_template_tables: 3,
    print_template_required_columns: 28,
    print_template_primary_keys: 3,
    print_template_foreign_keys: 8,
    print_template_required_indexes: 6,
    print_template_required_checks: 3,
    receivable_order_columns: 5,
    receivable_payment_method: 1,
    receivable_order_index: 1,
    receivable_order_check: 1,
    platform_order_type_column: 1,
    tax_exempt_order_column: 1,
    tax_exempt_original_price_column: 1,
    tax_exempt_permission: 1,
    orders_view_permission: 1,
    platform_remittance_tables: 3,
    platform_remittance_columns: 24,
    platform_remittance_primary_keys: 3,
    platform_remittance_foreign_keys: 5,
    platform_remittance_indexes: 8,
    platform_remittance_checks: 6,
    platform_remittance_order_index: 1
    ,jofotara_tax_category_columns: 3
    ,jofotara_tax_category_checks: 3
    ,service_charge_tax_category_setting: 1
    ,settings_value_text_column: 1
    ,refund_status_authority: 3
    ,order_type_sequence_columns: 4
    ,order_type_sequence_keys: 2
    ,held_order_lifecycle_columns: 13
    ,held_order_lifecycle_indexes: 4
    ,held_order_lifecycle_foreign_keys: 1
    ,call_center_source_columns: 2
    ,call_center_source_indexes: 2
    ,call_center_source_foreign_keys: 2
    ,receipt_tax_display_column: 1
    ,split_quantity_precision: 2
    ,webauthn_user_handle_column: 1
    ,webauthn_user_handle_index: 1
    ,webauthn_credential_table: 1
    ,webauthn_credential_columns: 20
    ,webauthn_credential_indexes: 3
    ,webauthn_ceremony_table: 1
    ,webauthn_ceremony_columns: 16
    ,webauthn_ceremony_indexes: 4
    ,webauthn_recovery_table: 1
    ,webauthn_recovery_columns: 8
    ,webauthn_recovery_indexes: 3
    ,auth_session_table: 1
    ,auth_session_columns: 11
    ,auth_session_indexes: 3
    ,legacy_session_token_column: 0
    ,device_auth_settings: 2
    ,device_auth_mode_setting: 1
    ,spooler_stations_table: 1
    ,spooler_stations_columns: 5
    ,spooler_agents_table: 1
    ,spooler_agents_columns: 13
    ,spooler_agent_statuses: 1
    ,spooler_agents_generated_column: 1
    ,spooler_agents_generated_unique: 1
    ,spooler_agents_indexes: 2
    ,jofotara_stale_submission_index: 1
    ,print_queue_v2_columns: 6
    ,print_queue_v2_statuses: 1
    ,stock_document_tables: 3
    ,stock_document_columns: 33
    ,stock_document_unique_keys: 9
    ,product_barcode_table: 1
    ,product_barcode_columns: 4
    ,product_barcode_unique_keys: 1
    ,packaging_unit_columns: 2
    ,product_pack_columns: 6
    ,product_pack_unique_keys: 2
});

function migrationError(details) {
    const error = new Error(
        `Database migration ${MIGRATION_NAME} is required before the POS server can start. ${details}`
    );
    error.code = 'SCHEMA_MIGRATION_REQUIRED';
    return error;
}

async function validateRequiredSchema(db) {
    const [[summary]] = await querySchemaChecks(db, `
        SELECT
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND COLUMN_NAME='phone_normalized'
                AND DATA_TYPE='varchar' AND CHARACTER_MAXIMUM_LENGTH=20 AND EXTRA LIKE '%STORED GENERATED%'
                AND SHA2(LOWER(REPLACE(REPLACE(REPLACE(REPLACE(GENERATION_EXPRESSION, CHAR(96), ''), ' ', ''), CHAR(10), ''), CHAR(13), '')), 256) =
                  '22746e58aecf192cac21d1da464622d07912c53aa199bccf3339ecc55614f270') AS customer_phone_normalized_column,
            (SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customers' AND INDEX_NAME='idx_customers_phone_normalized'
                 GROUP BY INDEX_NAME HAVING COUNT(*)=2 AND MIN(NON_UNIQUE)=1 AND MAX(NON_UNIQUE)=1
                   AND MIN(INDEX_TYPE)='BTREE' AND MAX(INDEX_TYPE)='BTREE' AND SUM(SUB_PART IS NOT NULL)=0
                   AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='phone_normalized,id'
            ) customer_phone_indexes) AS customer_phone_normalized_index,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deleted'
              AND COLUMN_NAME IN ('id','refund_id','source_invoice_id','source_order_item_id','source_parent_item_id',
                'product_id','item_name','quantity','item_snapshot','created_at')) AS deleted_columns,
            (SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deleted' AND INDEX_NAME='uq_deleted_event_item'
              GROUP BY INDEX_NAME HAVING COUNT(*)=2 AND MIN(NON_UNIQUE)=0 AND MAX(NON_UNIQUE)=0 AND SUM(SUB_PART IS NOT NULL)=0
                AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='refund_id,source_order_item_id') deleted_keys) AS deleted_event_key,
            (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='deleted'
              AND INDEX_NAME='idx_deleted_source_invoice' AND COLUMN_NAME='source_invoice_id' AND NON_UNIQUE=1 AND SUB_PART IS NULL) AS deleted_invoice_index,
            (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
              ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
              WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME='deleted' AND k.CONSTRAINT_NAME='fk_deleted_refund'
                AND k.COLUMN_NAME='refund_id' AND k.REFERENCED_TABLE_NAME='refunds' AND k.REFERENCED_COLUMN_NAME='id' AND r.DELETE_RULE='CASCADE') AS deleted_refund_foreign_key,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='refunds'
              AND COLUMN_NAME='invoice_id' AND DATA_TYPE='int' AND IS_NULLABLE='YES') AS refund_nullable_invoice,
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='restaurant_tables' AND COLUMN_NAME='seating_parent_id'
                AND DATA_TYPE='int' AND COLUMN_TYPE NOT LIKE '%unsigned%' AND IS_NULLABLE='YES') AS seating_parent_column,
            (SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='restaurant_tables' AND INDEX_NAME='idx_tables_seating_parent'
                 GROUP BY INDEX_NAME HAVING COUNT(*)=1 AND MIN(NON_UNIQUE)=1
                   AND MIN(INDEX_TYPE)='BTREE' AND SUM(SUB_PART IS NOT NULL)=0
                   AND MIN(COLUMN_NAME)='seating_parent_id'
            ) seating_indexes) AS seating_parent_index,
            (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k
              JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
              WHERE k.CONSTRAINT_SCHEMA=DATABASE() AND k.TABLE_NAME='restaurant_tables' AND k.CONSTRAINT_NAME='fk_tables_seating_parent'
                AND k.COLUMN_NAME='seating_parent_id' AND k.REFERENCED_TABLE_NAME='restaurant_tables'
                AND k.REFERENCED_COLUMN_NAME='id' AND r.DELETE_RULE='SET NULL') AS seating_parent_foreign_key,
            (SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_parent_payment'
                 GROUP BY INDEX_NAME
                 HAVING COUNT(*)=2 AND MIN(NON_UNIQUE)=1 AND MAX(NON_UNIQUE)=1
                    AND SUM(SUB_PART IS NOT NULL)=0 AND MIN(INDEX_TYPE)='BTREE' AND MAX(INDEX_TYPE)='BTREE'
                    AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='parent_invoice_id,payment_method'
            ) paid_split_indexes) AS paid_split_parent_index,
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='table_action_operations'
                AND COLUMN_NAME IN ('id','operation_id','user_id','action','request_hash','result_json','created_at')) AS table_action_columns,
            (SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='table_action_operations' AND NON_UNIQUE=0
                 GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='operation_id'
            ) table_action_keys) AS table_action_operation_key,
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
                AND COLUMN_NAME IN ('client_id','external_request_id','request_hash','held_order_id','result_json','created_at')) AS order_intake_request_columns,
            (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='customer_info' AND DATA_TYPE='text' AND IS_NULLABLE='YES') AS product_customer_info_column,
            (SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='expenses' AND INDEX_NAME='uq_expenses_request' GROUP BY INDEX_NAME HAVING MAX(NON_UNIQUE)=0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='created_by,request_id') expense_request_keys) AS expense_request_key,
            (SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
                   AND INDEX_NAME IN ('PRIMARY','idx_order_intake_held_order','idx_order_intake_created_at')
                 GROUP BY INDEX_NAME HAVING
                   (INDEX_NAME='PRIMARY' AND MAX(NON_UNIQUE)=0
                     AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='client_id,external_request_id')
                   OR (INDEX_NAME='idx_order_intake_held_order' AND MIN(NON_UNIQUE)=1
                     AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='held_order_id')
                   OR (INDEX_NAME='idx_order_intake_created_at' AND MIN(NON_UNIQUE)=1
                     AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='created_at')
            ) order_intake_keys) AS order_intake_request_keys,
            (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
              WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='order_intake_requests'
                AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME='chk_order_intake_result_json') AS order_intake_request_checks,
            (SELECT COUNT(*)
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'print_queue'
                AND COLUMN_NAME IN (
                    'status', 'idempotency_key', 'payload_hash', 'printer_id', 'print_type',
                    'claimed_by', 'spooler_id', 'spooler_version', 'locked_until', 'attempts',
                    'max_attempts', 'first_attempt_at', 'last_error', 'device_status', 'sent_at',
                    'acknowledged_at', 'duration_ms', 'next_retry_at', 'reprint_of_queue_id', 'last_seen_at',
                    'agent_id', 'accepted_at', 'last_error_code', 'last_failure_class', 'artifact_hash', 'artifact_bytes',
                    'render_duration_ms', 'local_duration_ms', 'renderer', 'transport_mode'
                )) AS print_queue_columns,
            (SELECT COUNT(*)
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'printers'
                AND COLUMN_NAME IN ('status_capability', 'device_status', 'status_checked_at', 'status_source', 'last_printed_at'))
                AS printer_status_columns,
            (SELECT COUNT(*)
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'print_queue'
                AND COLUMN_NAME = 'status'
                AND COLUMN_TYPE LIKE '%acknowledged%'
                AND COLUMN_TYPE LIKE '%dead_letter%'
                AND COLUMN_TYPE LIKE '%canceled%') AS durable_status,
            (SELECT COUNT(*)
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
                )) AS bundle_foreign_keys,
            (SELECT COUNT(*)
               FROM information_schema.KEY_COLUMN_USAGE kcu
               JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                 ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                AND rc.TABLE_NAME = kcu.TABLE_NAME
                AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
              WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
                AND (
                    (kcu.TABLE_NAME = 'user_permissions' AND kcu.CONSTRAINT_NAME = 'fk_uperm_user' AND kcu.COLUMN_NAME = 'user_id' AND kcu.REFERENCED_TABLE_NAME = 'users' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'CASCADE')
                    OR (kcu.TABLE_NAME = 'user_permissions' AND kcu.CONSTRAINT_NAME = 'fk_uperm_perm' AND kcu.COLUMN_NAME = 'perm_key' AND kcu.REFERENCED_TABLE_NAME = 'permissions' AND kcu.REFERENCED_COLUMN_NAME = 'perm_key' AND rc.DELETE_RULE = 'CASCADE')
                    OR (kcu.TABLE_NAME = 'restaurant_tables' AND kcu.CONSTRAINT_NAME = 'fk_parent_table' AND kcu.COLUMN_NAME = 'parent_table_id' AND kcu.REFERENCED_TABLE_NAME = 'restaurant_tables' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'SET NULL')
                    OR (kcu.TABLE_NAME = 'restaurant_tables' AND kcu.CONSTRAINT_NAME = 'restaurant_tables_ibfk_1' AND kcu.COLUMN_NAME = 'section_id' AND kcu.REFERENCED_TABLE_NAME = 'sections' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'RESTRICT')
                    OR (kcu.TABLE_NAME = 'shifts' AND kcu.CONSTRAINT_NAME = 'shifts_ibfk_1' AND kcu.COLUMN_NAME = 'user_id' AND kcu.REFERENCED_TABLE_NAME = 'users' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'RESTRICT')
                    OR (kcu.TABLE_NAME = 'order_items' AND kcu.CONSTRAINT_NAME = 'order_items_ibfk_1' AND kcu.COLUMN_NAME = 'invoice_id' AND kcu.REFERENCED_TABLE_NAME = 'orders' AND kcu.REFERENCED_COLUMN_NAME = 'invoice_id' AND rc.DELETE_RULE = 'CASCADE')
                    OR (kcu.TABLE_NAME = 'order_items' AND kcu.CONSTRAINT_NAME = 'order_items_ibfk_2' AND kcu.COLUMN_NAME = 'product_id' AND kcu.REFERENCED_TABLE_NAME = 'products' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'RESTRICT')
                    OR (kcu.TABLE_NAME = 'refund_items' AND kcu.CONSTRAINT_NAME = 'fk_refund_items_refund' AND kcu.COLUMN_NAME = 'refund_id' AND kcu.REFERENCED_TABLE_NAME = 'refunds' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'CASCADE')
                    OR (kcu.TABLE_NAME = 'qr_table_drafts' AND kcu.CONSTRAINT_NAME = 'qr_table_drafts_ibfk_1' AND kcu.COLUMN_NAME = 'table_id' AND kcu.REFERENCED_TABLE_NAME = 'restaurant_tables' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'CASCADE')
                )) AS baseline_authority_foreign_keys,
            (SELECT COUNT(*)
               FROM information_schema.KEY_COLUMN_USAGE kcu
               JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                 ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                AND rc.TABLE_NAME = kcu.TABLE_NAME
                AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
              WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
                AND (
                    (kcu.TABLE_NAME = 'orders' AND kcu.CONSTRAINT_NAME = 'fk_orders_waiter' AND kcu.COLUMN_NAME = 'waiter_id' AND kcu.REFERENCED_TABLE_NAME = 'users' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'RESTRICT')
                    OR (kcu.TABLE_NAME = 'orders' AND kcu.CONSTRAINT_NAME = 'fk_orders_order_type' AND kcu.COLUMN_NAME = 'order_type_id' AND kcu.REFERENCED_TABLE_NAME = 'order_types' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'RESTRICT')
                    OR (kcu.TABLE_NAME = 'orders' AND kcu.CONSTRAINT_NAME = 'fk_orders_customer' AND kcu.COLUMN_NAME = 'customer_id' AND kcu.REFERENCED_TABLE_NAME = 'customers' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'RESTRICT')
                    OR (kcu.TABLE_NAME = 'orders' AND kcu.CONSTRAINT_NAME = 'fk_orders_table' AND kcu.COLUMN_NAME = 'table_id' AND kcu.REFERENCED_TABLE_NAME = 'restaurant_tables' AND kcu.REFERENCED_COLUMN_NAME = 'id' AND rc.DELETE_RULE = 'RESTRICT')
                )) AS order_reference_foreign_keys,
            (SELECT COUNT(*) FROM (
                SELECT INDEX_NAME
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'orders'
                   AND INDEX_NAME IN ('idx_orders_waiter_id', 'idx_orders_order_type_id')
                 GROUP BY INDEX_NAME
                HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = CASE INDEX_NAME
                    WHEN 'idx_orders_waiter_id' THEN 'waiter_id'
                    WHEN 'idx_orders_order_type_id' THEN 'order_type_id'
                END
            ) required_order_reference_indexes) AS order_reference_indexes,
            (SELECT COUNT(*)
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'users'
                AND COLUMN_NAME IN (
                    'can_view_orders', 'canholdorders', 'can_update_table', 'can_apply_discount', 'can_void_items',
                    'can_open_register', 'can_checkout_tables', 'bypass_existing_tables', 'bypass_printed_tables',
                    'can_view_order_history', 'can_transfer_table', 'can_join_tables', 'can_split_bills',
                    'waiter_split_bill', 'can_print_check'
                )) AS legacy_permission_columns,
            (SELECT COUNT(*)
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME IN ('permissions', 'user_permissions')) AS canonical_permission_tables,
            (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='table_access_scope'
                AND COLUMN_TYPE='enum(''all'',''selected'',''none'')' AND IS_NULLABLE='NO') AS table_access_scope_column,
            (SELECT COUNT(*) FROM permissions WHERE implemented=1
                AND perm_key IN (${catalog.map(row => "'" + row.perm_key + "'").join(',')})
                AND TRIM(label)<>'' AND TRIM(label_ar)<>''
                AND TRIM(description)<>'' AND TRIM(description_ar)<>'') AS current_permission_catalog,
            (SELECT COUNT(*) FROM (
                SELECT INDEX_NAME
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'print_queue'
                   AND INDEX_NAME IN (
                       'uq_print_queue_idempotency', 'idx_print_queue_claim', 'idx_print_queue_state_locked',
                       'idx_print_queue_state_created', 'idx_print_queue_reprint_of', 'idx_print_queue_agent_claim'
                   )
                 GROUP BY INDEX_NAME
                HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = CASE INDEX_NAME
                    WHEN 'uq_print_queue_idempotency' THEN 'idempotency_key'
                    WHEN 'idx_print_queue_claim' THEN 'status,locked_until,id'
                    WHEN 'idx_print_queue_state_locked' THEN 'status,locked_until'
                    WHEN 'idx_print_queue_state_created' THEN 'status,created_at'
                    WHEN 'idx_print_queue_reprint_of' THEN 'reprint_of_queue_id'
                    WHEN 'idx_print_queue_agent_claim' THEN 'agent_id,status,locked_until,id'
                END
                   AND (INDEX_NAME <> 'uq_print_queue_idempotency' OR MIN(NON_UNIQUE) = 0)
            ) required_indexes) AS print_queue_indexes,
            (SELECT COUNT(*)
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'schema_migrations') AS migration_table,
            (SELECT COUNT(*)
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'products'
                AND COLUMN_NAME = 'warehouse_id') AS warehouse_columns,
            (SELECT COUNT(*)
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()
                AND TABLE_NAME = 'products'
                AND COLUMN_NAME = 'price_override_locked'
                AND DATA_TYPE = 'tinyint'
                AND COLUMN_TYPE = 'tinyint(1)'
                AND IS_NULLABLE = 'NO'
                AND COLUMN_DEFAULT IN ('0', '''0''')) AS product_price_override_lock_column,
            (SELECT COUNT(DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME))
               FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE()
                AND (
                    (TABLE_NAME = 'qr_table_drafts' AND INDEX_NAME = 'idx_qr_drafts_table')
                    OR (TABLE_NAME = 'restaurant_tables' AND INDEX_NAME = 'section_id')
                )) AS redundant_indexes
            ,(SELECT COUNT(*)
                FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE()
                 AND TABLE_NAME = 'printers'
                 AND COLUMN_NAME IN ('spooler_id', 'active_endpoint_key')) AS printer_owner_columns
            ,(SELECT COUNT(*)
                FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE()
                 AND TABLE_NAME = 'print_queue'
                 AND COLUMN_NAME = 'printer_id'
                 AND DATA_TYPE = 'int') AS print_queue_printer_type
            ,(SELECT COUNT(DISTINCT CONCAT(TABLE_NAME, '.', INDEX_NAME))
                FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA = DATABASE()
                 AND (
                    (TABLE_NAME = 'printers' AND INDEX_NAME IN ('idx_printers_spooler', 'uq_printers_active_endpoint'))
                    OR (TABLE_NAME = 'print_queue' AND INDEX_NAME = 'idx_print_queue_owner_claim')
                 )) AS printer_owner_indexes
            ,(SELECT COUNT(*)
                FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE()
                 AND (
                    (TABLE_NAME = 'orders'
                     AND COLUMN_NAME = 'tax_registration_type_at_sale'
                     AND COLUMN_TYPE = "enum('sales_tax','income_tax')"
                     AND IS_NULLABLE = 'NO'
                     AND COLUMN_DEFAULT IN ('sales_tax', '''sales_tax'''))
                    OR
                    (TABLE_NAME = 'jofotara_documents'
                     AND COLUMN_NAME = 'tax_registration_type'
                     AND COLUMN_TYPE = "enum('sales_tax','income_tax')"
                     AND IS_NULLABLE = 'NO'
                     AND COLUMN_DEFAULT IN ('sales_tax', '''sales_tax'''))
                 )) AS tax_registration_columns
            ,(SELECT COUNT(*)
                FROM settings
               WHERE setting_key IN (
                    'tax_registration_type',
                    'jofotara_sales_tax_client_id',
                    'jofotara_sales_tax_secret_key',
                    'jofotara_sales_tax_income_source_sequence',
                    'jofotara_sales_tax_seller_tax_number',
                    'jofotara_sales_tax_seller_registered_name',
                    'jofotara_income_tax_client_id',
                    'jofotara_income_tax_secret_key',
                    'jofotara_income_tax_income_source_sequence',
                    'jofotara_income_tax_seller_tax_number',
                    'jofotara_income_tax_seller_registered_name'
                 )) AS tax_registration_settings
            ,(SELECT COUNT(*)
                FROM settings
               WHERE setting_key = 'tax_registration_type'
                 AND setting_value IN ('sales_tax', 'income_tax')) AS tax_registration_selector
            ,(SELECT COUNT(*)
                FROM settings
               WHERE setting_key IN (
                    'jofotara_client_id', 'jofotara_secret_key',
                    'jofotara_income_source_sequence', 'jofotara_seller_tax_number',
                    'jofotara_seller_registered_name'
                 )) AS obsolete_jofotara_settings
            ,(SELECT COUNT(*)
                FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE()
                 AND TABLE_NAME = 'categories'
                 AND COLUMN_NAME = 'price_list_root_id'
                 AND DATA_TYPE = 'int'
                 AND IS_NULLABLE = 'YES') AS category_price_list_column
            ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'categories'
                   AND INDEX_NAME = 'idx_categories_price_list_tree'
                 GROUP BY INDEX_NAME
                HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'price_list_root_id,is_active,id'
            ) required_index) AS category_price_list_index
            ,(SELECT COUNT(*)
                FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                 AND rc.TABLE_NAME = kcu.TABLE_NAME
                 AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
               WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
                 AND kcu.TABLE_NAME = 'categories'
                 AND kcu.CONSTRAINT_NAME = 'fk_categories_price_list_root'
                 AND kcu.COLUMN_NAME = 'price_list_root_id'
                 AND kcu.REFERENCED_TABLE_NAME = 'categories'
                 AND kcu.REFERENCED_COLUMN_NAME = 'id'
                 AND rc.DELETE_RULE = 'SET NULL') AS category_price_list_foreign_key
            ,(SELECT COUNT(*)
                FROM information_schema.TABLES
               WHERE TABLE_SCHEMA = DATABASE()
                 AND TABLE_NAME = 'product_price_overrides') AS product_price_overrides_table
            ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'product_price_overrides'
                   AND INDEX_NAME = 'PRIMARY'
                 GROUP BY INDEX_NAME
                HAVING MIN(NON_UNIQUE) = 0
                   AND CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) = 'price_list_root_id,product_id'
            ) required_primary_key) AS product_price_overrides_primary_key
            ,(SELECT COUNT(*)
                FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                 AND rc.TABLE_NAME = kcu.TABLE_NAME
                 AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
               WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
                 AND kcu.TABLE_NAME = 'product_price_overrides'
                 AND ((kcu.CONSTRAINT_NAME = 'fk_product_price_overrides_root'
                       AND kcu.COLUMN_NAME = 'price_list_root_id'
                       AND kcu.REFERENCED_TABLE_NAME = 'categories'
                       AND kcu.REFERENCED_COLUMN_NAME = 'id'
                       AND rc.DELETE_RULE = 'CASCADE')
                   OR (kcu.CONSTRAINT_NAME = 'fk_product_price_overrides_product'
                       AND kcu.COLUMN_NAME = 'product_id'
                       AND kcu.REFERENCED_TABLE_NAME = 'products'
                       AND kcu.REFERENCED_COLUMN_NAME = 'id'
                       AND rc.DELETE_RULE = 'CASCADE'))) AS product_price_overrides_foreign_keys
            ,(SELECT COUNT(*)
                FROM information_schema.TABLE_CONSTRAINTS
               WHERE CONSTRAINT_SCHEMA = DATABASE()
                 AND TABLE_NAME = 'product_price_overrides'
                 AND CONSTRAINT_NAME = 'chk_product_price_overrides_nonnegative'
                 AND CONSTRAINT_TYPE = 'CHECK') AS product_price_overrides_nonnegative_constraint
            ,(SELECT COUNT(*) FROM information_schema.TABLES
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN
                 ('subscription_plans','subscription_plan_products','customer_subscriptions','customer_subscription_products',
                  'subscription_extensions','subscription_collections','subscription_redemptions','subscription_redemption_items')) AS retired_subscription_tables
            ,(SELECT COUNT(*) FROM permissions
               WHERE perm_key IN ('pos.subscriptions','pos.subscription_credit')) AS retired_subscription_permissions
            ,(SELECT COUNT(*) FROM user_permissions
               WHERE perm_key IN ('pos.subscriptions','pos.subscription_credit')) AS retired_subscription_grants
            ,(SELECT COUNT(*) FROM settings
               WHERE setting_key='subscription_receivables_enabled') AS retired_subscription_setting
            ,(SELECT COUNT(*)
                FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders'
                 AND COLUMN_NAME IN ('parent_invoice_id','table_id')) AS progressive_split_columns
            ,(SELECT COUNT(DISTINCT INDEX_NAME)
                FROM information_schema.STATISTICS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='held_orders'
                 AND INDEX_NAME IN ('idx_held_orders_parent_invoice','idx_held_orders_split_table')) AS progressive_split_indexes
            ,(SELECT COUNT(*)
                FROM information_schema.KEY_COLUMN_USAGE
               WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='held_orders'
                 AND CONSTRAINT_NAME IN ('fk_held_orders_parent_invoice','fk_held_orders_split_table')) AS progressive_split_foreign_keys
            ,(SELECT COUNT(*)
                FROM settings
               WHERE (setting_key='jofotara_auto_submit' AND setting_value IN ('0','1'))
                  OR setting_key='jofotara_auto_submit_since') AS jofotara_operations_settings
            ,(SELECT COUNT(*) FROM information_schema.TABLES
               WHERE TABLE_SCHEMA=DATABASE()
                 AND TABLE_NAME IN ('print_templates','print_template_revisions','print_template_revision_tests')
                 AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_general_ci') AS print_template_tables
            ,(SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE()
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
                 )) AS print_template_required_columns
            ,(SELECT COUNT(*) FROM (
                SELECT TABLE_NAME, INDEX_NAME, MIN(NON_UNIQUE) AS non_unique,
                       CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) AS columns_in_order
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE()
                   AND TABLE_NAME IN ('print_templates','print_template_revisions','print_template_revision_tests')
                   AND INDEX_NAME='PRIMARY'
                 GROUP BY TABLE_NAME, INDEX_NAME
                HAVING non_unique=0 AND columns_in_order='id'
            ) AS verified_print_template_primary_keys) AS print_template_primary_keys
            ,(SELECT COUNT(*) FROM (
                SELECT TABLE_NAME, INDEX_NAME, MIN(NON_UNIQUE) AS non_unique,
                       CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)) AS columns_in_order
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE()
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
            ) AS verified_print_template_indexes) AS print_template_required_indexes
            ,(SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
                 AND rc.TABLE_NAME=kcu.TABLE_NAME
                 AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
               WHERE kcu.CONSTRAINT_SCHEMA=DATABASE()
                 AND (
                    (kcu.TABLE_NAME='print_templates' AND kcu.CONSTRAINT_NAME='fk_print_templates_active_revision' AND kcu.COLUMN_NAME='active_revision_id' AND kcu.REFERENCED_TABLE_NAME='print_template_revisions' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
                    (kcu.TABLE_NAME='print_templates' AND kcu.CONSTRAINT_NAME='fk_print_templates_draft_revision' AND kcu.COLUMN_NAME='draft_revision_id' AND kcu.REFERENCED_TABLE_NAME='print_template_revisions' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
                    (kcu.TABLE_NAME='print_template_revisions' AND kcu.CONSTRAINT_NAME='fk_print_template_revisions_template' AND kcu.COLUMN_NAME='template_id' AND kcu.REFERENCED_TABLE_NAME='print_templates' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
                    (kcu.TABLE_NAME='print_template_revisions' AND kcu.CONSTRAINT_NAME='fk_print_template_revisions_creator' AND kcu.COLUMN_NAME='created_by' AND kcu.REFERENCED_TABLE_NAME='users' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL') OR
                    (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_revision' AND kcu.COLUMN_NAME='revision_id' AND kcu.REFERENCED_TABLE_NAME='print_template_revisions' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT') OR
                    (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_printer' AND kcu.COLUMN_NAME='printer_id' AND kcu.REFERENCED_TABLE_NAME='printers' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL') OR
                    (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_queue' AND kcu.COLUMN_NAME='queue_id' AND kcu.REFERENCED_TABLE_NAME='print_queue' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL') OR
                    (kcu.TABLE_NAME='print_template_revision_tests' AND kcu.CONSTRAINT_NAME='fk_print_template_tests_confirmer' AND kcu.COLUMN_NAME='confirmed_by' AND kcu.REFERENCED_TABLE_NAME='users' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='SET NULL')
                 )) AS print_template_foreign_keys
            ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS tc
                JOIN information_schema.CHECK_CONSTRAINTS cc
                  ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
                 AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
               WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.CONSTRAINT_TYPE='CHECK'
                 AND (
                    (tc.TABLE_NAME='print_templates' AND tc.CONSTRAINT_NAME='chk_print_templates_document_type' AND REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')='document_type in (''receipt'',''kitchen'')') OR
                    (tc.TABLE_NAME='print_template_revisions' AND tc.CONSTRAINT_NAME='chk_print_template_revision_no' AND REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')='revision_no > 0') OR
                    (tc.TABLE_NAME='print_template_revisions' AND tc.CONSTRAINT_NAME='chk_print_template_revision_json' AND REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')='json_valid(definition_json)')
                 )) AS print_template_required_checks
            ,(SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders'
                 AND COLUMN_NAME IN ('payment_due_on','receivable_reason','buyer_name_at_sale','buyer_phone_at_sale','buyer_address_at_sale')) AS receivable_order_columns
            ,(SELECT COUNT(*) FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND COLUMN_NAME='payment_method'
                 AND COLUMN_TYPE="enum('cash','card','split','receivable','platform','unpaid_table','voided')") AS receivable_payment_method
            ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND INDEX_NAME='idx_orders_receivable_due'
                 GROUP BY INDEX_NAME
                HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX))='payment_method,payment_due_on,invoice_id'
              ) verified_receivable_index) AS receivable_order_index
            ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS tc
                JOIN information_schema.CHECK_CONSTRAINTS cc
                  ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
                 AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
               WHERE tc.CONSTRAINT_SCHEMA=DATABASE() AND tc.TABLE_NAME='orders'
                 AND tc.CONSTRAINT_NAME='chk_orders_receivable_terms'
                 AND tc.CONSTRAINT_TYPE='CHECK'
                 AND LOWER(REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')) LIKE '%payment_due_on%'
                 AND LOWER(REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')) LIKE '%receivable_reason%'
                 AND LOWER(REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')) NOT LIKE '%buyer_phone_at_sale%'
                 AND LOWER(REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')) NOT LIKE '%buyer_address_at_sale%') AS receivable_order_check
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_types'
                  AND COLUMN_NAME='is_deferred_settlement' AND DATA_TYPE='tinyint'
                  AND COLUMN_TYPE='tinyint(1)' AND IS_NULLABLE='NO'
                  AND COLUMN_DEFAULT IN ('0', '''0''')) AS platform_order_type_column
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders'
                  AND COLUMN_NAME='tax_exempt_at_sale' AND DATA_TYPE='tinyint'
                  AND COLUMN_TYPE='tinyint(1)' AND IS_NULLABLE='NO'
                  AND COLUMN_DEFAULT IN ('0', '''0''')) AS tax_exempt_order_column
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_items'
                  AND COLUMN_NAME='price_before_tax_exemption' AND DATA_TYPE='decimal'
                  AND COLUMN_TYPE='decimal(10,6)' AND IS_NULLABLE='YES') AS tax_exempt_original_price_column
             ,(SELECT COUNT(*) FROM permissions
                WHERE perm_key='pos.tax_exempt' AND label_ar='إعفاء ضريبي'
                  AND implemented=1 AND default_cashier=0 AND overridable=0) AS tax_exempt_permission
             ,(SELECT COUNT(*) FROM permissions
                WHERE perm_key='orders.view'
                  AND label='POS Order History'
                  AND label_ar='سجل طلبات نقطة البيع'
                  AND description='View recent orders, totals, and receipts in the POS Order Notes history. Does not grant Admin Orders access.'
                  AND description_ar='عرض الطلبات الأخيرة والإجماليات والإيصالات في سجل ملاحظات الطلبات بنقطة البيع. لا يمنح الوصول إلى طلبات لوحة الإدارة.'
                  AND category='orders' AND sort_order=100
                  AND implemented=1 AND default_cashier=0 AND overridable=0) AS orders_view_permission
             ,(SELECT COUNT(*)
                 FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME IN ('platform_remittances','platform_remittance_lines','platform_remittance_adjustments')
                  AND ENGINE='InnoDB') AS platform_remittance_tables
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND ((TABLE_NAME='platform_remittances' AND COLUMN_NAME IN ('id','order_type_id','provider_name_at_entry','kind','statement_start_date','statement_end_date','settled_on','reference','net_received','reverses_remittance_id','reason','recorded_by','idempotency_key','created_at'))
                    OR (TABLE_NAME='platform_remittance_lines' AND COLUMN_NAME IN ('id','remittance_id','invoice_id','allocated_amount'))
                    OR (TABLE_NAME='platform_remittance_adjustments' AND COLUMN_NAME IN ('id','remittance_id','direction','category','amount','note')))) AS platform_remittance_columns
             ,(SELECT COUNT(*)
                 FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.TABLE_CONSTRAINTS tc
                  ON tc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
                 AND tc.TABLE_NAME=kcu.TABLE_NAME
                 AND tc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=DATABASE()
                  AND tc.CONSTRAINT_TYPE='PRIMARY KEY'
                  AND kcu.COLUMN_NAME='id'
                  AND ((kcu.TABLE_NAME='platform_remittances' AND kcu.CONSTRAINT_NAME='PRIMARY')
                    OR (kcu.TABLE_NAME='platform_remittance_lines' AND kcu.CONSTRAINT_NAME='PRIMARY')
                    OR (kcu.TABLE_NAME='platform_remittance_adjustments' AND kcu.CONSTRAINT_NAME='PRIMARY'))) AS platform_remittance_primary_keys
             ,(SELECT COUNT(*)
                 FROM information_schema.KEY_COLUMN_USAGE kcu
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                   ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
                  AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=DATABASE()
                  AND ((kcu.TABLE_NAME='platform_remittances' AND kcu.CONSTRAINT_NAME='fk_platform_remittances_user' AND kcu.COLUMN_NAME='recorded_by' AND kcu.REFERENCED_TABLE_NAME='users' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')
                    OR (kcu.TABLE_NAME='platform_remittances' AND kcu.CONSTRAINT_NAME='fk_platform_remittances_reversal' AND kcu.COLUMN_NAME='reverses_remittance_id' AND kcu.REFERENCED_TABLE_NAME='platform_remittances' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')
                    OR (kcu.TABLE_NAME='platform_remittance_lines' AND kcu.CONSTRAINT_NAME='fk_platform_remittance_lines_remittance' AND kcu.COLUMN_NAME='remittance_id' AND kcu.REFERENCED_TABLE_NAME='platform_remittances' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT')
                    OR (kcu.TABLE_NAME='platform_remittance_lines' AND kcu.CONSTRAINT_NAME='fk_platform_remittance_lines_order' AND kcu.COLUMN_NAME='invoice_id' AND kcu.REFERENCED_TABLE_NAME='orders' AND kcu.REFERENCED_COLUMN_NAME='invoice_id' AND rc.DELETE_RULE='RESTRICT')
                    OR (kcu.TABLE_NAME='platform_remittance_adjustments' AND kcu.CONSTRAINT_NAME='fk_platform_remittance_adjustments_remittance' AND kcu.COLUMN_NAME='remittance_id' AND kcu.REFERENCED_TABLE_NAME='platform_remittances' AND kcu.REFERENCED_COLUMN_NAME='id' AND rc.DELETE_RULE='RESTRICT'))) AS platform_remittance_foreign_keys
             ,(SELECT COUNT(DISTINCT INDEX_NAME)
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND ((TABLE_NAME='platform_remittances' AND INDEX_NAME IN ('uq_platform_remittances_idempotency','uq_platform_remittances_reversal','idx_platform_remittances_provider_date','idx_platform_remittances_date_kind'))
                    OR (TABLE_NAME='platform_remittance_lines' AND INDEX_NAME IN ('uq_platform_remittance_lines_invoice','idx_platform_remittance_lines_invoice'))
                    OR (TABLE_NAME='platform_remittance_adjustments' AND INDEX_NAME='idx_platform_remittance_adjustments_remittance')
                    OR (TABLE_NAME='orders' AND INDEX_NAME='idx_orders_platform_provider'))) AS platform_remittance_indexes
             ,(SELECT COUNT(*)
                 FROM information_schema.TABLE_CONSTRAINTS
                WHERE CONSTRAINT_SCHEMA=DATABASE()
                  AND CONSTRAINT_TYPE='CHECK'
                  AND ((TABLE_NAME='platform_remittances' AND CONSTRAINT_NAME IN ('chk_platform_remittances_net','chk_platform_remittances_statement_dates','chk_platform_remittances_reversal_shape'))
                    OR (TABLE_NAME='platform_remittance_lines' AND CONSTRAINT_NAME='chk_platform_remittance_lines_amount')
                    OR (TABLE_NAME='platform_remittance_adjustments' AND CONSTRAINT_NAME IN ('chk_platform_remittance_adjustments_amount','chk_platform_remittance_adjustments_shape')))) AS platform_remittance_checks
             ,(SELECT COUNT(*) FROM (
                 SELECT INDEX_NAME
                   FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA=DATABASE()
                    AND TABLE_NAME='orders'
                    AND INDEX_NAME='idx_orders_platform_provider'
                  GROUP BY INDEX_NAME
                 HAVING CONCAT_WS(',', GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX))='payment_method,order_type_id,invoice_id'
               ) verified_platform_order_index) AS platform_remittance_order_index
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND COLUMN_NAME='jofotara_tax_category'
                  AND DATA_TYPE='char' AND CHARACTER_MAXIMUM_LENGTH=1
                  AND IS_NULLABLE='NO'
                  AND COLUMN_DEFAULT IN ('O', '''O''')
                  AND TABLE_NAME IN ('products','order_items','service_charge_snapshots')) AS jofotara_tax_category_columns
             ,(SELECT COUNT(*)
                 FROM information_schema.TABLE_CONSTRAINTS
                WHERE CONSTRAINT_SCHEMA=DATABASE()
                  AND CONSTRAINT_TYPE='CHECK'
                  AND ((TABLE_NAME='products' AND CONSTRAINT_NAME='chk_products_jofotara_tax_category')
                    OR (TABLE_NAME='order_items' AND CONSTRAINT_NAME='chk_order_items_jofotara_tax_category')
                    OR (TABLE_NAME='service_charge_snapshots' AND CONSTRAINT_NAME='chk_service_charge_snapshots_jofotara_tax_category'))) AS jofotara_tax_category_checks
             ,(SELECT COUNT(*) FROM settings
                WHERE setting_key='service_charge_jofotara_tax_category'
                  AND setting_value IN ('S','Z','O')) AS service_charge_tax_category_setting
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='settings'
                  AND COLUMN_NAME='setting_value'
                  AND DATA_TYPE='text'
                  AND IS_NULLABLE='NO') AS settings_value_text_column
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='orders'
                  AND COLUMN_NAME='refund_status'
                  AND COLUMN_TYPE LIKE '%none%'
                  AND COLUMN_TYPE LIKE '%partial%'
                  AND COLUMN_TYPE LIKE '%full%')
              + (SELECT COUNT(*)
                   FROM information_schema.TABLES
                  WHERE TABLE_SCHEMA=DATABASE()
                    AND TABLE_NAME='refunds')
              + (SELECT COUNT(*)
                   FROM information_schema.TABLES
                  WHERE TABLE_SCHEMA=DATABASE()
                    AND TABLE_NAME='refund_items') AS refund_status_authority
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='held_orders'
                  AND COLUMN_NAME IN (
                    'version','hold_request_id','claimed_by_user_id','claim_token_hash','claim_expires_at',
                    'updated_at','kitchen_snapshot','kitchen_dispatch_version','last_operation_id',
                    'last_operation_kind','last_operation_result','order_id','order_seq_scope'
                  )) AS held_order_lifecycle_columns
             ,(SELECT COUNT(DISTINCT INDEX_NAME)
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='held_orders'
                  AND INDEX_NAME IN ('idx_held_orders_user_id','uq_held_orders_user_request','idx_held_orders_claim_owner','uq_held_order_sequence')) AS held_order_lifecycle_indexes
             ,(SELECT COUNT(*)
                 FROM information_schema.KEY_COLUMN_USAGE kcu
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                   ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
                  AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=DATABASE()
                  AND kcu.TABLE_NAME='held_orders'
                  AND kcu.CONSTRAINT_NAME='fk_held_orders_claim_user'
                  AND kcu.COLUMN_NAME='claimed_by_user_id'
                  AND kcu.REFERENCED_TABLE_NAME='users'
                  AND kcu.REFERENCED_COLUMN_NAME='id'
                  AND rc.DELETE_RULE='RESTRICT') AS held_order_lifecycle_foreign_keys
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME IN ('held_orders','orders')
                  AND COLUMN_NAME='call_center_user_id'
                  AND DATA_TYPE='int'
                  AND IS_NULLABLE='YES') AS call_center_source_columns
             ,(SELECT COUNT(*) FROM (
                 SELECT TABLE_NAME, INDEX_NAME
                   FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA=DATABASE()
                    AND ((TABLE_NAME='held_orders' AND INDEX_NAME='idx_held_orders_call_center_user')
                      OR (TABLE_NAME='orders' AND INDEX_NAME='idx_orders_call_center_user'))
                  GROUP BY TABLE_NAME, INDEX_NAME
                 HAVING COUNT(*)=1
                    AND MAX(COLUMN_NAME)='call_center_user_id'
             ) required_call_center_source_indexes) AS call_center_source_indexes
             ,(SELECT COUNT(*)
                 FROM information_schema.KEY_COLUMN_USAGE kcu
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                   ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
                  AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=DATABASE()
                  AND ((kcu.TABLE_NAME='held_orders'
                        AND kcu.CONSTRAINT_NAME='fk_held_orders_call_center_user')
                    OR (kcu.TABLE_NAME='orders'
                        AND kcu.CONSTRAINT_NAME='fk_orders_call_center_user'))
                  AND kcu.COLUMN_NAME='call_center_user_id'
                  AND kcu.REFERENCED_TABLE_NAME='users'
                  AND kcu.REFERENCED_COLUMN_NAME='id'
                  AND rc.DELETE_RULE='RESTRICT') AS call_center_source_foreign_keys
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='orders'
                  AND COLUMN_NAME='receipt_tax_inclusive_at_sale'
                  AND DATA_TYPE='tinyint'
                  AND IS_NULLABLE='YES') AS receipt_tax_display_column
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND ((TABLE_NAME='order_items' AND COLUMN_NAME='quantity')
                    OR (TABLE_NAME='refund_items' AND COLUMN_NAME='quantity'))
                  AND DATA_TYPE='decimal'
                  AND NUMERIC_PRECISION=12
                  AND NUMERIC_SCALE=6
                  AND IS_NULLABLE='NO') AS split_quantity_precision
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='users'
                  AND COLUMN_NAME='webauthn_user_handle'
                  AND DATA_TYPE='varbinary'
                  AND CHARACTER_MAXIMUM_LENGTH=64
                  AND IS_NULLABLE='YES') AS webauthn_user_handle_column
             ,(SELECT COUNT(*)
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='users'
                  AND INDEX_NAME='uq_users_webauthn_user_handle'
                  AND NON_UNIQUE=0
                  AND SEQ_IN_INDEX=1
                  AND COLUMN_NAME='webauthn_user_handle') AS webauthn_user_handle_index
             ,(SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='webauthn_credentials') AS webauthn_credential_table
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='webauthn_credentials'
                  AND COLUMN_NAME IN ('id','user_id','credential_lookup','credential_id','public_key','counter','device_type','backed_up','authenticator_attachment','transports','aaguid','attestation_format','device_label','status','registered_by_user_id','registered_at','last_used_at','revoked_at','revoked_by_user_id','revoke_reason')) AS webauthn_credential_columns
             ,(SELECT COUNT(DISTINCT INDEX_NAME)
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='webauthn_credentials'
                  AND INDEX_NAME IN ('uq_webauthn_credential_lookup','idx_webauthn_credentials_user_status','idx_webauthn_credentials_last_used')) AS webauthn_credential_indexes
             ,(SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='webauthn_ceremonies') AS webauthn_ceremony_table
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='webauthn_ceremonies'
                  AND COLUMN_NAME IN ('id','flow','user_id','requesting_user_id','replacement_credential_id','recovery_code_id','is_decoy','challenge','enrollment_token_hash','enrollment_expires_at','intended_device_label','attempt_count','issued_at','expires_at','consumed_at','terminal_state')) AS webauthn_ceremony_columns
             ,(SELECT COUNT(DISTINCT INDEX_NAME)
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='webauthn_ceremonies'
                  AND INDEX_NAME IN ('idx_webauthn_ceremonies_flow_user','idx_webauthn_ceremonies_challenge','idx_webauthn_ceremonies_token','idx_webauthn_ceremonies_recovery')) AS webauthn_ceremony_indexes
             ,(SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='webauthn_recovery_codes') AS webauthn_recovery_table
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='webauthn_recovery_codes'
                  AND COLUMN_NAME IN ('id','user_id','batch_id','code_hash','created_at','created_by_user_id','expires_at','used_at')) AS webauthn_recovery_columns
             ,(SELECT COUNT(DISTINCT INDEX_NAME)
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='webauthn_recovery_codes'
                  AND INDEX_NAME IN ('uq_webauthn_recovery_code_hash','idx_webauthn_recovery_user_batch','idx_webauthn_recovery_expiry')) AS webauthn_recovery_indexes
             ,(SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='auth_sessions') AS auth_session_table
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='auth_sessions'
                  AND COLUMN_NAME IN ('id','token_hash','user_id','credential_id','created_at','last_seen_at','idle_expires_at','absolute_expires_at','webauthn_verified_at','revoked_at','revoke_reason')) AS auth_session_columns
             ,(SELECT COUNT(DISTINCT INDEX_NAME)
                 FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='auth_sessions'
                  AND INDEX_NAME IN ('uq_auth_sessions_token_hash','idx_auth_sessions_user_active','idx_auth_sessions_credential_active')) AS auth_session_indexes
             ,(SELECT COUNT(*)
                 FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='users'
                  AND COLUMN_NAME='session_token') AS legacy_session_token_column
             ,(SELECT COUNT(*) FROM settings
                WHERE setting_key IN ('staff_device_auth_mode','webauthn_bootstrap_consumed')) AS device_auth_settings
             ,(SELECT COUNT(*) FROM settings
                WHERE setting_key='staff_device_auth_mode'
                  AND setting_value IN ('disabled','staged','enforced')) AS device_auth_mode_setting
             ,(SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='spooler_stations') AS spooler_stations_table
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='spooler_stations'
                  AND COLUMN_NAME IN ('spooler_id','delivery_protocol','v2_activated_at','first_v2_accepted_at','updated_at')) AS spooler_stations_columns
             ,(SELECT COUNT(*) FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='spooler_agents') AS spooler_agents_table
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='spooler_agents'
                  AND COLUMN_NAME IN ('agent_id','spooler_id','token_hash','name','agent_version','protocol_version','status','created_at','revoked_at','last_sync_at','last_error','local_queue_depth','health_summary')) AS spooler_agents_columns
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='spooler_agents'
                  AND COLUMN_NAME='status'
                  AND COLUMN_TYPE="enum('active','draining','revoked','decommissioned')") AS spooler_agent_statuses
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='spooler_agents'
                  AND COLUMN_NAME='active_station_key'
                  AND EXTRA LIKE '%STORED GENERATED%'
                  AND LOWER(GENERATION_EXPRESSION) LIKE '%case%status%active%draining%spooler_id%') AS spooler_agents_generated_column
             ,(SELECT COUNT(*) FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='spooler_agents'
                  AND INDEX_NAME='uq_spooler_agents_active_station'
                  AND NON_UNIQUE=0
                  AND SEQ_IN_INDEX=1
                  AND COLUMN_NAME='active_station_key') AS spooler_agents_generated_unique
             ,(SELECT COUNT(*) FROM (
                 SELECT INDEX_NAME
                   FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA=DATABASE()
                    AND TABLE_NAME='spooler_agents'
                    AND INDEX_NAME IN ('uq_spooler_agents_active_station','idx_spooler_agents_station')
                  GROUP BY INDEX_NAME
                 HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = CASE INDEX_NAME
                     WHEN 'uq_spooler_agents_active_station' THEN 'active_station_key'
                     WHEN 'idx_spooler_agents_station' THEN 'spooler_id'
                 END
                    AND (INDEX_NAME <> 'uq_spooler_agents_active_station' OR MIN(NON_UNIQUE)=0)
                    AND (INDEX_NAME <> 'idx_spooler_agents_station' OR MIN(NON_UNIQUE)=1)
             ) required_spooler_agent_indexes) AS spooler_agents_indexes
            ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE()
                   AND TABLE_NAME='jofotara_documents'
                   AND INDEX_NAME='idx_jofotara_status_attempt'
                 GROUP BY INDEX_NAME
                HAVING COUNT(*)=2
                   AND SUM(CASE WHEN SEQ_IN_INDEX=1 AND COLUMN_NAME='status' THEN 1 ELSE 0 END)=1
                   AND SUM(CASE WHEN SEQ_IN_INDEX=2 AND COLUMN_NAME='last_attempt_at' THEN 1 ELSE 0 END)=1
                   AND MIN(NON_UNIQUE)=1
                   AND MAX(NON_UNIQUE)=1
             ) required_jofotara_stale_index) AS jofotara_stale_submission_index
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='products'
                  AND COLUMN_NAME IN ('stock','min_stock_level','max_stock_level')
                  AND DATA_TYPE='decimal'
                  AND NUMERIC_PRECISION=16
                  AND NUMERIC_SCALE=6
                  AND IS_NULLABLE='YES'
                  AND (
                    (COLUMN_NAME='stock' AND (COLUMN_DEFAULT IS NULL OR REPLACE(UPPER(COLUMN_DEFAULT), CHAR(39), '')='NULL'))
                    OR (COLUMN_NAME='min_stock_level' AND CAST(COLUMN_DEFAULT AS DECIMAL(16,6))=10)
                    OR (COLUMN_NAME='max_stock_level' AND CAST(COLUMN_DEFAULT AS DECIMAL(16,6))=100)
                  )) AS product_stock_precision
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='products' AND COLUMN_NAME='stock_version' AND COLUMN_TYPE LIKE 'bigint%unsigned' AND IS_NULLABLE='NO') AS product_stock_version
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (
                 (TABLE_NAME='stock_items' AND COLUMN_NAME IN ('id','name','measure','base_unit','legacy_product_id','legacy_ingredient_id','tracking_state','is_active'))
                 OR (TABLE_NAME='stock_balances' AND COLUMN_NAME IN ('stock_item_id','location_id','lot_id','quantity','quantity_known','version','last_operation_id'))
                 OR (TABLE_NAME='stock_movements' AND COLUMN_NAME IN ('id','operation_id','line_ordinal','stock_item_id','location_id','lot_id','quantity','establishes_known','unit_snapshot','source_line','business_date'))
                 OR (TABLE_NAME='product_stock_links' AND COLUMN_NAME IN ('product_id','stock_item_id','qty_per_sale','policy_version'))
             )) AS stock_core_columns
             ,(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredient_movements') AS retired_ingredient_movement_table
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements'
                AND COLUMN_NAME IN ('movement_type','ingredient_id','kind','qty','unit_cost','reason','expected_qty','period_usage_qty','line_key','unit_qty','product_qty','source_type','source_id','source_label','product_id','product_name','user_id','user_name','occurred_at','note','client_key','corrects_movement_id','purchase_priced','cost_source')) AS unified_movement_columns
             ,(SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements'
                GROUP BY INDEX_NAME HAVING (INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='movement_type,id')
                OR (INDEX_NAME='idx_stock_movement_id' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='id')) unified_keys) AS unified_movement_identity_keys
             ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements'
                AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME IN ('ck_stock_movement_identity','ck_stock_movement_physical','chk_im_signs','chk_im_reason')) AS unified_movement_checks
             ,(SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements'
                AND CONSTRAINT_NAME='fk_stock_movement_ingredient' AND COLUMN_NAME='ingredient_id' AND REFERENCED_TABLE_NAME='ingredients' AND REFERENCED_COLUMN_NAME='id') AS unified_movement_ingredient_fk
             ,(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_locations','stock_lots')) AS retired_stock_dimensions
             ,(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_ingredient_links','ingredient_working_balances')) AS retired_ingredient_state_tables
             ,(SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND INDEX_NAME='idx_ingredient_working_init'
                GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='working_initialized,id') init_keys) AS ingredient_working_index
             ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='ingredients' AND CONSTRAINT_TYPE='CHECK'
                AND CONSTRAINT_NAME IN ('ck_ingredient_stock_link','ck_ingredient_working_state')) AS ingredient_state_checks
             ,(SELECT COUNT(*) FROM (SELECT TABLE_NAME,INDEX_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_balances','stock_movements') GROUP BY TABLE_NAME,INDEX_NAME HAVING
                 (TABLE_NAME='stock_balances' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='stock_item_id')
                 OR (TABLE_NAME='stock_movements' AND INDEX_NAME='idx_stock_movement_history' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='stock_item_id,id')) identity_keys) AS stock_identity_keys
             ,(SELECT COUNT(*) FROM (SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements' AND CONSTRAINT_NAME='fk_stock_movement_balance'
                 GROUP BY CONSTRAINT_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION)='stock_item_id'
                 AND GROUP_CONCAT(REFERENCED_TABLE_NAME ORDER BY ORDINAL_POSITION)='stock_balances'
                 AND GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION)='stock_item_id') identity_fk) AS stock_identity_foreign_key

             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (
                (TABLE_NAME='stock_report_daily' AND COLUMN_NAME IN ('build_id','stock_item_id','ingredient_id','location_id','incoming','outgoing','received','used','waste','corrections','used_cost','waste_cost','opening_id'))
                OR (TABLE_NAME='stock_report_backfill' AND COLUMN_NAME IN ('source','last_id','complete'))
                OR (TABLE_NAME='stock_report_counts' AND COLUMN_NAME IN ('build_id','ingredient_id','count_id','previous_count_id','count_at','count_qty','received','theoretical','waste'))
                OR (TABLE_NAME='stock_report_count_corrections' AND COLUMN_NAME IN ('build_id','ingredient_id','count_id','original_id','kind','qty'))
                OR (TABLE_NAME='ingredients' AND COLUMN_NAME IN ('working_quantity','working_quantity_known','working_last_count_id','working_period_usage','working_variance_qty','working_initialized')))) AS stock_ab_projection_columns
             ,(SELECT COUNT(*) FROM (SELECT TABLE_NAME,INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                AND TABLE_NAME IN ('stock_report_daily','product_stock_links','stock_report_backfill','stock_report_counts','stock_report_count_corrections')
                GROUP BY TABLE_NAME,INDEX_NAME HAVING
                (TABLE_NAME='stock_report_daily' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,stock_item_id,ingredient_id,location_id')
                OR (TABLE_NAME='stock_report_daily' AND INDEX_NAME='idx_stock_daily_ingredient' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,ingredient_id,stock_item_id')
                OR (TABLE_NAME='product_stock_links' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='product_id,stock_item_id')
                OR (TABLE_NAME='product_stock_links' AND INDEX_NAME='idx_product_stock_physical' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='stock_item_id,product_id')
                OR (TABLE_NAME='stock_report_backfill' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='source')
                OR (TABLE_NAME='stock_report_counts' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,ingredient_id,count_id')
                OR (TABLE_NAME='stock_report_counts' AND INDEX_NAME='idx_stock_report_count_interval' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='ingredient_id,count_id,build_id')
                OR (TABLE_NAME='stock_report_count_corrections' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,ingredient_id,count_id,original_id')
                OR (TABLE_NAME='stock_report_count_corrections' AND INDEX_NAME='idx_stock_report_count_correction' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='ingredient_id,count_id,original_id,build_id')
             ) ab_keys) AS stock_ab_projection_keys
             ,(SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()
                AND CONSTRAINT_NAME IN ('fk_stock_daily_build','fk_stock_report_count_build','fk_stock_report_count_correction_build')) AS stock_ab_projection_foreign_keys
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_operations' AND COLUMN_NAME IN ('state','business_date','original_operation_id')) AS stock_operation_context_columns
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='order_items' AND COLUMN_NAME IN ('stock_authority','stock_snapshot')) AS stock_sale_snapshot_columns
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_operations' AND COLUMN_NAME IN ('id','request_key','payload_hash','kind','actor_id','legacy_product_id','result_json','posted_at')) AS stock_operation_columns
             ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND INDEX_NAME='idx_stock_item_active_name'
                GROUP BY INDEX_NAME HAVING COUNT(*)=4 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tracking_state,is_active,name,id'
             ) stock_cursor_index) AS stock_active_name_index
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                AND ((TABLE_NAME='stock_report_builds' AND COLUMN_NAME IN ('id','day','scope_id','generation','state','created_at'))
                  OR (TABLE_NAME='stock_report_dirty' AND COLUMN_NAME IN ('day','scope_id','generation','pending','dirty_at','lease_owner','lease_until','active_build_id','published_build_id','published_generation','as_of'))
                  OR (TABLE_NAME='stock_report_worker' AND COLUMN_NAME IN ('id','lease_owner','lease_until')))) AS stock_report_generation_columns
             ,(SELECT COUNT(*) FROM (
                SELECT TABLE_NAME,INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                 AND TABLE_NAME IN ('stock_report_dirty','stock_report_builds','stock_report_worker')
                 AND INDEX_NAME IN ('PRIMARY','idx_stock_report_pending','idx_stock_report_build_cleanup')
                GROUP BY TABLE_NAME,INDEX_NAME
                HAVING (TABLE_NAME='stock_report_dirty' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='day,scope_id')
                 OR (TABLE_NAME IN ('stock_report_builds','stock_report_worker') AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='id')
                 OR (INDEX_NAME='idx_stock_report_pending' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='pending,dirty_at,day,scope_id')
                 OR (INDEX_NAME='idx_stock_report_build_cleanup' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='state,id')
             ) report_generation_keys) AS stock_report_generation_keys
             ,(SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()
                AND CONSTRAINT_NAME IN ('fk_stock_report_active_build','fk_stock_report_published_build')) AS stock_report_generation_foreign_keys
             ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'
                AND CONSTRAINT_NAME IN ('chk_stock_report_build_scope','chk_stock_report_build_state','chk_stock_report_dirty_scope','chk_stock_report_pending','chk_stock_report_worker_singleton')) AS stock_report_generation_checks
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (
                (TABLE_NAME='stock_report_meals' AND COLUMN_NAME IN ('build_id','product_id','name','sold','refunded','net_revenue_cents','known_cost','incomplete_lines','legacy_lines','unallocated_records','unallocated_revenue_cents','excluded_revenue_cents'))
                OR (TABLE_NAME='stock_report_ingredients' AND COLUMN_NAME IN ('build_id','product_id','ingredient_id','name','display_unit','qty','known_cost','incomplete'))
                OR (TABLE_NAME='stock_report_events' AND COLUMN_NAME IN ('build_id','kind','source_id','source_line_id','invoice_id','product_id','event_at','quantity','net_revenue_cents','known_cost','incomplete'))
                OR (TABLE_NAME='stock_report_operations' AND COLUMN_NAME IN ('build_id','stock_item_id','ingredient_id','kind','source_type','qty','known_cost','uncosted_qty','movement_count')))) AS stock_report_fact_columns
             ,(SELECT COUNT(*) FROM (
                SELECT TABLE_NAME,INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                 AND TABLE_NAME IN ('stock_report_meals','stock_report_ingredients','stock_report_events','stock_report_operations','order_items')
                GROUP BY TABLE_NAME,INDEX_NAME HAVING
                 (TABLE_NAME='stock_report_meals' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,product_id')
                 OR (TABLE_NAME='stock_report_ingredients' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,product_id,ingredient_id')
                 OR (TABLE_NAME='stock_report_events' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,kind,source_id,source_line_id')
                 OR (TABLE_NAME='stock_report_operations' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,stock_item_id,ingredient_id,kind,source_type')
                 OR (INDEX_NAME='idx_stock_report_ingredient' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,ingredient_id,product_id')
                 OR (INDEX_NAME='idx_stock_report_product_event' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='build_id,product_id,event_at,source_line_id')
                 OR (TABLE_NAME='order_items' AND INDEX_NAME='idx_order_items_parent_invoice' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='parent_item_id,invoice_id')
             ) report_fact_keys) AS stock_report_fact_keys
             ,(SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()
                AND CONSTRAINT_NAME IN ('fk_stock_report_meal_build','fk_stock_report_ingredient_build','fk_stock_report_event_build','fk_stock_report_operation_build')) AS stock_report_fact_foreign_keys
             ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'
                AND CONSTRAINT_NAME='chk_stock_report_event_kind') AS stock_report_fact_checks
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                AND TABLE_NAME='stock_items' AND COLUMN_NAME='availability_policy') AS stock_availability_policy
             ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()
                AND TABLE_NAME='stock_items' AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME='ck_stock_item_availability') AS stock_availability_check
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (
                (TABLE_NAME='ingredients' AND COLUMN_NAME IN ('stock_item_id','stock_activation_operation_id','stock_movement_watermark','stock_activation_count_id','stock_observation_token','stock_activation_quantity','stock_activation_quantity_known','stock_activation_request_key','stock_activated_at'))
                OR (TABLE_NAME='stock_operation_sources' AND COLUMN_NAME IN ('operation_id','line_ordinal','source_kind','source_type','source_id','source_line','ingredient_id')))) AS stock_ingredient_cutover_columns
             ,(SELECT COUNT(*) FROM (
                SELECT TABLE_NAME,INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
                 AND TABLE_NAME IN ('ingredients','stock_operation_sources')
                GROUP BY TABLE_NAME,INDEX_NAME HAVING
                 (INDEX_NAME='uq_stock_ingredient_item' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='stock_item_id' AND MAX(NON_UNIQUE)=0)
                 OR (INDEX_NAME='uq_stock_ingredient_request' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='stock_activation_request_key' AND MAX(NON_UNIQUE)=0)
                 OR (INDEX_NAME='idx_stock_ingredient_operation' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='stock_activation_operation_id')
                 OR (TABLE_NAME='stock_operation_sources' AND INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='operation_id,line_ordinal')
                 OR (INDEX_NAME='idx_stock_source_ingredient' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='ingredient_id,source_type,source_id')
                 OR (INDEX_NAME='idx_stock_source_document' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='source_type,source_id')
             ) cutover_keys) AS stock_ingredient_cutover_keys
             ,(SELECT COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()
                AND CONSTRAINT_NAME IN ('fk_ingredient_stock_item','fk_ingredient_stock_operation','fk_stock_source_operation')) AS stock_ingredient_cutover_foreign_keys
             ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK'
                AND CONSTRAINT_NAME IN ('ck_stock_source_kind')) AS stock_ingredient_cutover_checks
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items'
                AND COLUMN_NAME IN ('barcode','attention')) AS stock_item_projection_columns
             ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items'
                 AND INDEX_NAME IN ('uq_stock_item_barcode','idx_stock_item_attention')
                GROUP BY INDEX_NAME HAVING
                 (INDEX_NAME='uq_stock_item_barcode' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='barcode' AND MAX(NON_UNIQUE)=0)
                 OR (INDEX_NAME='idx_stock_item_attention' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='attention,name,id')
             ) projection_keys) AS stock_item_projection_keys
             ,(SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='stock_items'
                AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME='ck_stock_item_attention') AS stock_item_projection_checks
             ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_movements'
                 AND INDEX_NAME='idx_stock_movement_item_day'
                GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='stock_item_id,business_date,id'
             ) movement_day) AS stock_movement_item_day_index
             ,(SELECT COUNT(*) FROM (
                SELECT INDEX_NAME FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_operations' AND INDEX_NAME='uq_stock_operation_request'
                GROUP BY INDEX_NAME HAVING COUNT(*)=1 AND MAX(NON_UNIQUE)=0 AND MAX(COLUMN_NAME)='request_key'
             ) stock_request_identity) AS stock_operation_request_key
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='print_queue'
                  AND COLUMN_NAME IN ('agent_id','accepted_at','last_error_code','last_failure_class','artifact_hash','artifact_bytes')) AS print_queue_v2_columns
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='print_queue'
                  AND COLUMN_NAME='status'
                  AND COLUMN_TYPE="enum('pending','processing','sent','acknowledged','failed','dead_letter','canceled','local_accepted','cancel_requested')") AS print_queue_v2_statuses
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                AND TABLE_NAME='daily_order_type_sequences' AND COLUMN_NAME IN ('sequence_date','order_type_id','prefix_ordinal','current_value')) AS order_type_sequence_columns
             ,(SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='daily_order_type_sequences' GROUP BY INDEX_NAME
                HAVING MAX(NON_UNIQUE)=0 AND ((INDEX_NAME='PRIMARY' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='sequence_date,order_type_id')
                OR (INDEX_NAME='uq_daily_type_prefix' AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='sequence_date,prefix_ordinal'))) type_sequence_keys) AS order_type_sequence_keys
    ,(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME IN ('purchase_suppliers','stock_documents','stock_document_lines')) AS stock_document_tables
    ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (
        (TABLE_NAME='stock_documents' AND COLUMN_NAME IN ('doc_type','item_kind','status','supplier_id','reference','doc_date','payment_status','subtotal','tax_total','total','paper_total','cost_includes_tax','version','create_key','post_key','reverse_key','stock_result','open_count'))
        OR (TABLE_NAME='stock_document_lines' AND COLUMN_NAME IN ('document_id','line_no','product_id','ingredient_id','qty','unit_label','unit_factor','unit_price','tax_rate','line_subtotal','line_tax','line_total','expected_qty','counted_by','counted_at')))) AS stock_document_columns
    ,(SELECT COUNT(*) FROM (SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('purchase_suppliers','stock_documents','stock_document_lines') AND NON_UNIQUE=0 AND INDEX_NAME<>'PRIMARY'
        GROUP BY TABLE_NAME, INDEX_NAME) stock_document_keys
        WHERE (TABLE_NAME='purchase_suppliers' AND cols='name')
           OR (TABLE_NAME='stock_documents' AND cols IN ('supplier_id,reference,item_kind','create_key','post_key','reverse_key','open_count'))
           OR (TABLE_NAME='stock_document_lines' AND cols IN ('document_id,line_no','document_id,product_id','document_id,ingredient_id'))) AS stock_document_unique_keys
    ,(SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes') AS product_barcode_table
    ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes'
        AND COLUMN_NAME IN ('id','product_id','barcode','created_at')) AS product_barcode_columns
    ,(SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_barcodes'
        AND INDEX_NAME='uq_product_barcode' AND COLUMN_NAME='barcode' AND NON_UNIQUE=0) AS product_barcode_unique_keys
    ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (
        (TABLE_NAME='categories' AND COLUMN_NAME='hide_in_pos') OR (TABLE_NAME='stock_document_lines' AND COLUMN_NAME='bonus_qty'))) AS packaging_unit_columns
    ,(SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_packs'
        AND COLUMN_NAME IN ('id','product_id','label','factor','sort_order','sale_product_id')) AS product_pack_columns
    ,(SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_packs'
        AND INDEX_NAME IN ('uq_product_pack_label','uq_product_pack_sale_product') AND NON_UNIQUE=0 GROUP BY INDEX_NAME
        HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)=IF(INDEX_NAME='uq_product_pack_label','product_id,label','sale_product_id')) pack_keys) AS product_pack_unique_keys
    `);

    const missing = Object.entries(REQUIRED_COUNTS)
        .filter(([name, expected]) => Number(summary?.[name]) !== expected)
        .map(([name]) => name);
    if (missing.length > 0) {
        throw migrationError(`Missing or invalid requirements: ${missing.join(', ')}.`);
    }

    const [[templateRows]] = await db.query(
        "SELECT COUNT(*) AS print_template_seed_rows FROM print_templates WHERE document_type IN ('receipt', 'kitchen')"
    );
    if (Number(templateRows?.print_template_seed_rows) !== 2) {
        throw migrationError('Missing or invalid requirements: print_template_seed_rows.');
    }

    const [[migration]] = await db.query(
        'SELECT migration_name, checksum FROM schema_migrations WHERE migration_name = ? LIMIT 1',
        [MIGRATION_NAME]
    );
    if (!migration) throw migrationError('The migration ledger entry is missing.');
    if (migration.checksum !== MIGRATION_CHECKSUM) {
        throw migrationError('The migration checksum does not match the shipped SQL file.');
    }
    return true;
}

module.exports = { MIGRATION_NAME, MIGRATION_CHECKSUM, validateRequiredSchema };
