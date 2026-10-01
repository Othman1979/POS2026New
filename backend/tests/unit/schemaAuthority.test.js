import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_NAME = '2026-10-03-product-barcodes-v1';
const MIGRATION_CHECKSUM = 'd7070c1443d96cfae4feb758650aed5e464ee1f3b39de0f457635529c893a61e';

function loadSchemaValidation() {
    try {
        return require('../../services/schemaValidation');
    } catch (_) {
        return null;
    }
}

function createDb({ summary = {}, ledger = { migration_name: MIGRATION_NAME, checksum: MIGRATION_CHECKSUM } } = {}) {
    const queries = [];
    return {
        queries,
        async query(sql) {
            queries.push(sql);
            if (sql.startsWith('SELECT * FROM information_schema.')) return [[], ['TABLE_SCHEMA','CONSTRAINT_SCHEMA','TABLE_NAME'].map(name => ({name}))];
            if (sql.includes('AS print_queue_columns')) return [[{
                customer_phone_normalized_column: 1,
                customer_phone_normalized_index: 1,
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
                current_permission_catalog: 24,
                table_access_scope_column: 1,
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

                retired_stock_dimensions: 0, retired_ingredient_state_tables: 0,ingredient_working_index:1,ingredient_state_checks:2, stock_identity_keys: 2, stock_identity_foreign_key: 1,
                stock_ab_projection_columns:37,stock_ab_projection_keys:9,stock_ab_projection_foreign_keys:3,
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
                 platform_remittance_tables: 3,
                 platform_remittance_columns: 24,
                 platform_remittance_primary_keys: 3,
                 platform_remittance_foreign_keys: 5,
                 platform_remittance_indexes: 8,
                 platform_remittance_checks: 6,
                 platform_remittance_order_index: 1,
                 tax_exempt_order_column: 1,
                 tax_exempt_original_price_column: 1,
                 tax_exempt_permission: 1,
                 orders_view_permission: 1,
                 jofotara_tax_category_columns: 3,
                 jofotara_tax_category_checks: 3,
                 service_charge_tax_category_setting: 1,
                 settings_value_text_column: 1,
                refund_status_authority: 3,
                held_order_lifecycle_columns: 13,
                held_order_lifecycle_indexes: 4,
                held_order_lifecycle_foreign_keys: 1,
                call_center_source_columns: 2,
                call_center_source_indexes: 2,
                call_center_source_foreign_keys: 2,
                receipt_tax_display_column: 1,
                split_quantity_precision: 2,
                webauthn_user_handle_column: 1,
                webauthn_user_handle_index: 1,
                webauthn_credential_table: 1,
                webauthn_credential_columns: 20,
                webauthn_credential_indexes: 3,
                webauthn_ceremony_table: 1,
                webauthn_ceremony_columns: 16,
                webauthn_ceremony_indexes: 4,
                webauthn_recovery_table: 1,
                webauthn_recovery_columns: 8,
                webauthn_recovery_indexes: 3,
                auth_session_table: 1,
                auth_session_columns: 11,
                auth_session_indexes: 3,
                legacy_session_token_column: 0,
                device_auth_settings: 2,
                device_auth_mode_setting: 1,
                spooler_stations_table: 1,
                spooler_stations_columns: 5,
                spooler_agents_table: 1,
                spooler_agents_columns: 13,
                spooler_agent_statuses: 1,
                spooler_agents_generated_column: 1,
                spooler_agents_generated_unique: 1,
                spooler_agents_indexes: 2,
                jofotara_stale_submission_index: 1,
                print_queue_v2_columns: 6,
                print_queue_v2_statuses: 1,
                stock_document_tables: 3,
                stock_document_columns: 33,
                stock_document_unique_keys: 9,
                product_barcode_table: 1,
                product_barcode_columns: 4,
                product_barcode_unique_keys: 1,
                print_template_seed_rows: 2,
                order_type_sequence_columns: 4,
                order_type_sequence_keys: 2,
                ...summary
            }]];
            if (sql.includes('FROM print_templates WHERE document_type')) {
                return [[{ print_template_seed_rows: summary.print_template_seed_rows ?? 2 }]];
            }
            if (sql.includes('FROM schema_migrations')) return [[ledger].filter(Boolean)];
            throw new Error(`Unexpected SQL: ${sql}`);
        }
    };
}

describe('database schema authority', () => {
    it.each([
        'order_type_sequence_columns',
        'order_type_sequence_keys',
        'spooler_stations_table',
        'spooler_stations_columns',
        'spooler_agents_table',
        'spooler_agents_columns',
        'spooler_agent_statuses',
        'spooler_agents_generated_column',
        'spooler_agents_generated_unique',
        'spooler_agents_indexes',
        'print_queue_v2_columns',
        'print_queue_v2_statuses'
    ])('requires the V2 spooler schema authority %s', async (requirement) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it.each(['stock_document_columns', 'stock_document_unique_keys'])('requires the stock document schema shape (%s)', async (requirement) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: 1 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it('requires the suppliers and stock document tables', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { stock_document_tables: 2 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('stock_document_tables');
    });

    it.each(['product_barcode_table', 'product_barcode_columns', 'product_barcode_unique_keys'])('requires the product barcodes table shape (%s)', async (requirement) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it('requires the exact JoFotara stale-submission index shape', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { jofotara_stale_submission_index: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('jofotara_stale_submission_index');
    });

    it('requires six-decimal stock quantities and thresholds', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { product_stock_precision: 2 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('product_stock_precision');
    });

    it.each(['ingredient_working_index','ingredient_state_checks','stock_identity_keys','stock_identity_foreign_key','stock_ab_projection_columns','stock_ab_projection_keys','stock_ab_projection_foreign_keys','product_stock_version', 'stock_operation_columns', 'stock_operation_request_key', 'stock_core_columns', 'stock_operation_context_columns', 'stock_sale_snapshot_columns', 'stock_active_name_index', 'stock_report_generation_columns', 'stock_report_generation_keys', 'stock_report_generation_foreign_keys', 'stock_report_generation_checks', 'stock_report_fact_columns', 'stock_report_fact_keys', 'stock_report_fact_foreign_keys', 'stock_report_fact_checks', 'stock_availability_policy', 'stock_availability_check', 'stock_ingredient_cutover_columns', 'stock_ingredient_cutover_keys', 'stock_ingredient_cutover_foreign_keys', 'stock_ingredient_cutover_checks', 'stock_item_projection_columns', 'stock_item_projection_keys', 'stock_item_projection_checks', 'stock_movement_item_day_index'])('requires stock write safety: %s', async (requirement) => {
        const validation = loadSchemaValidation();
        await expect(validation.validateRequiredSchema(createDb({ summary: { [requirement]: 0 } }))).rejects.toThrow(requirement);
    });

    it('requires stable printer ownership and numeric queue printer identity', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({
            summary: {
                printer_owner_columns: 0,
                print_queue_printer_type: 0,
                printer_owner_indexes: 0
            }
        });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('printer_owner_columns');
    });

    it('requires the call-center source schema and ledger tip', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({
            ledger: { migration_name: MIGRATION_NAME, checksum: MIGRATION_CHECKSUM },
            summary: {
                call_center_source_columns: 1,
                call_center_source_indexes: 1,
                call_center_source_foreign_keys: 1,
            }
        });
        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('call_center_source_columns');
    });

    it('requires the nullable customer receipt tax-display snapshot', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({ summary: { receipt_tax_display_column: 0 } });
        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('receipt_tax_display_column');
    });

    it('requires every category price-list structure before startup', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({
            summary: {
                category_price_list_column: 0,
                category_price_list_index: 0,
                category_price_list_foreign_key: 0,
                product_price_overrides_table: 0,
                product_price_overrides_primary_key: 0,
                product_price_overrides_foreign_keys: 0,
                product_price_overrides_nonnegative_constraint: 0
            }
        });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('category_price_list_column');
    });

    it.each([
        ['legacy_permission_columns', 1],
        ['canonical_permission_tables', 0]
    ])('fails startup when %s is incomplete', async (requirement, value) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: value } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it('rejects a baseline authority foreign-key set with fewer than nine exact relationships', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({ summary: { baseline_authority_foreign_keys: 8 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('baseline_authority_foreign_keys');
    });

    it('rejects retired subscription tables before startup', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({
            summary: {
                retired_subscription_tables: 1
            }
        });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('retired_subscription_tables');
    });

    it.each([
        'receivable_order_columns',
        'receivable_payment_method',
        'receivable_order_index',
        'receivable_order_check'
    ])('fails startup when %s is incomplete', async (requirement) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it('requires platform settlement schema before startup', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({
            summary: {
                platform_order_type_column: 0
            }
        });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('platform_order_type_column');
    });

    it.each([
        'platform_remittance_tables',
        'platform_remittance_columns',
        'platform_remittance_primary_keys',
        'platform_remittance_foreign_keys',
        'platform_remittance_indexes',
        'platform_remittance_checks',
        'platform_remittance_order_index'
    ])('fails startup when %s is incomplete', async (requirement) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it.each([
        'tax_exempt_order_column',
        'tax_exempt_original_price_column',
        'tax_exempt_permission',
        'orders_view_permission'
    ])('fails startup when %s is incomplete', async (requirement) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it('fails startup clearly when an authoritative requirement is missing, without mutating schema', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({ summary: { bundle_foreign_keys: 1 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(MIGRATION_NAME);
        expect(db.queries.length).toBeGreaterThan(0);
        expect(db.queries.join('\n')).not.toMatch(/\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|DATABASE|INDEX)\b|\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
    });

    it('requires the exact product price-override lock column shape', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { product_price_override_lock_column: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('product_price_override_lock_column');
    });

    it('rejects an altered migration fingerprint', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({ ledger: { migration_name: MIGRATION_NAME, checksum: 'wrong' } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('checksum');
    });

    it('accepts the exact migrated schema and checksum', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb();

        await expect(validation.validateRequiredSchema(db)).resolves.toBe(true);
    });

    it('requires settings values to be TEXT and NOT NULL before startup', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { settings_value_text_column: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('settings_value_text_column');
    });

    it('requires the refund ledger and synchronized status cache before startup', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { refund_status_authority: 2 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('refund_status_authority');
    });

    it('requires canonical order-reference index names before startup', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { order_reference_indexes: 1 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('order_reference_indexes');
    });

    it('reports refund reconciliation mismatches with the same quantity and amount rule it verifies', () => {
        const sql = fs.readFileSync(
            path.join(ROOT, 'backend/migrations/2026-08-10-refund-status-reconciliation.verify.sql'),
            'utf8'
        );
        const amountCoverage = /refunded_amount[^\n]*\+ 1e-9 >= COALESCE\(o\.total, 0\)/g;

        expect(sql.match(amountCoverage)).toHaveLength(2);
    });

    it('requires both frozen tax-registration columns and the selector with isolated credential groups', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({
            summary: {
                tax_registration_columns: 0,
                tax_registration_settings: 0,
                tax_registration_selector: 0,
                obsolete_jofotara_settings: 5
            }
        });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('tax_registration_columns');
    });

    it('rejects a missing or unsupported tax-registration selector at startup', async () => {
        const validation = loadSchemaValidation();
        expect(validation).toBeTruthy();
        const db = createDb({ summary: { tax_registration_selector: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('tax_registration_selector');
    });

    it('requires legacy-safe sales-tax defaults for both frozen registration columns', () => {
        const validationSource = fs.readFileSync(path.join(ROOT, 'backend/services/schemaValidation.js'), 'utf8');

        expect(validationSource.match(/COLUMN_DEFAULT IN \('sales_tax', '''sales_tax'''\)/g)).toHaveLength(2);
    });

    it('opens the HTTP port before slow migration checks and gates traffic until the schema is ready', () => {
        const printerStatus = fs.readFileSync(path.join(ROOT, 'backend/services/printerStatus.js'), 'utf8');
        const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const listenIndex = server.indexOf('startupListenPromise = listenForStartup()');
        // Migrations and the schema check run inside the shared migrateAndValidate sequence.
        const validationIndex = server.indexOf('await migrateAndValidate(db, { logger })');

        expect(printerStatus).not.toMatch(/ALTER TABLE|ensurePrinterStatusSchema/);
        expect(listenIndex).toBeGreaterThanOrEqual(0);
        expect(validationIndex).toBeGreaterThan(listenIndex);
        expect(server).toContain("let startupStatus = process.env.NODE_ENV === 'test' ? 'ready' : 'starting'");
        expect(server).toContain("startupStatus === 'ready' || req.path === '/health' || req.path === '/api/health'");
        expect(server).toContain("if (startupStatus !== 'ready') return next(new Error('Server is starting.'))");
        expect(server.indexOf("startupStatus = 'ready'")).toBeGreaterThan(validationIndex);
        expect(server.indexOf('\n        onServerStarted();')).toBeGreaterThan(validationIndex);
        const readyIndex = server.indexOf("startupStatus = 'ready'");
        const runtimeStartIndex = server.indexOf('db.databaseRuntime.start()');
        const maintenanceStopIndex = server.indexOf('pool.databaseRuntime.stopMaintenance()');
        const runtimeStopIndex = server.indexOf('pool.databaseRuntime.stop()');
        const socketCloseIndex = server.indexOf('io.close()');
        const httpCloseIndex = server.indexOf('server.close(async (err) =>');
        const maintenanceStopAwaitIndex = server.indexOf('await Promise.all([');
        const runtimeStopAwaitIndex = server.indexOf('await pool.databaseRuntime.stop()');
        const poolEndIndex = server.indexOf('pool.end()');
        expect(runtimeStartIndex).toBeGreaterThan(readyIndex);
        expect(maintenanceStopIndex).toBeGreaterThan(-1);
        expect(socketCloseIndex).toBeGreaterThan(maintenanceStopIndex);
        expect(httpCloseIndex).toBeGreaterThan(socketCloseIndex);
        expect(maintenanceStopAwaitIndex).toBeGreaterThan(httpCloseIndex);
        expect(server.slice(maintenanceStopAwaitIndex, runtimeStopIndex)).toContain('databaseMaintenanceStop');
        expect(runtimeStopIndex).toBeGreaterThan(maintenanceStopAwaitIndex);
        expect(runtimeStopAwaitIndex).toBe(runtimeStopIndex - 'await '.length);
        expect(poolEndIndex).toBeGreaterThan(runtimeStopAwaitIndex);
        expect(server).toContain('const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 15_000;');
        expect(server).toContain('}, GRACEFUL_SHUTDOWN_TIMEOUT_MS);');
        expect(server).toContain("db: 'connected'");
        expect(server).toContain("status: 'ok'");
        expect(server).not.toMatch(/ensurePrintQueueSchema|ensurePrinterStatusSchema/);
        expect(server).toContain('await db.end()');
    });

    it('repairs managed schema drift once through the existing additive reconciliation', () => {
        const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const sequence = fs.readFileSync(path.join(ROOT, 'backend/services/migrateAndValidate.js'), 'utf8');
        const updater = fs.readFileSync(path.join(ROOT, 'deployment/tools/run-pending-migrations.js'), 'utf8');

        // Startup and the privileged updater share one sequence.
        expect(server).toContain('await migrateAndValidate(db, { logger })');
        expect(updater).toContain('await migrateAndValidate(pool, { runMigrations, validateSchema, repairConstraints, logger })');
        expect(sequence).toContain("if (error.code !== 'SCHEMA_MIGRATION_REQUIRED') throw error");
        expect(sequence).toContain('await runMigrations(db, { includeRepeatable: true })');
    });

    it('keeps migration bookkeeping out of application-schema drift comparisons', () => {
        const driftValidator = fs.readFileSync(path.join(ROOT, 'scripts/validate-schema-drift.js'), 'utf8');
        expect(driftValidator).toContain("const IGNORED_TABLES = new Set(['schema_migrations'])");
        expect(driftValidator).not.toContain('print_queue.idx_print_queue_status_created');
        expect(driftValidator).not.toMatch(/ADDITIVE_(?:TABLES|COLUMNS|INDEXES)|RETIRED_(?:COLUMNS|INDEXES)/);
    });

    it('ships one guarded phpMyAdmin migration with cleanup, constraints, and its checksum ledger', () => {
        const foundationPath = path.join(ROOT, 'backend/migrations/2026-07-18-erp-foundation.sql');
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-18-foundation-final-hygiene.sql');
        expect(fs.existsSync(foundationPath)).toBe(true);
        expect(fs.existsSync(migrationPath)).toBe(true);
        const foundationSql = fs.readFileSync(foundationPath, 'utf8');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        expect(foundationSql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
        expect(foundationSql).toContain('DELETE definition');
        expect(foundationSql).toContain('fk_pbi_bundle');
        expect(foundationSql).toContain('fk_pbi_product');
        expect(foundationSql).toContain('idx_print_queue_state_created');
        expect(foundationSql).toContain('idx_print_queue_status_created');
        expect(sql).toContain('DROP COLUMN warehouse_id');
        expect(sql).toContain('DROP INDEX idx_qr_drafts_table');
        expect(sql).toContain('DROP INDEX section_id');
        expect(sql).toContain('2026-07-18-foundation-final-hygiene-v1');
        expect(sql).toContain('c0e594b90955b0ecb819d29575cef226af99cd69099eaf9a9b16cb371ed05021');
    });

    it('ships a guarded multi-spooler ownership migration and verifier', () => {
        const printerMigrationName = '2026-07-19-multi-spooler-printer-ownership-v1';
        const printerMigrationChecksum = '33e94bbb406f197b48e527623c3b0d240b112beeb7fad7678df36c8b112ffb7d';
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-19-multi-spooler-printer-ownership.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-19-multi-spooler-printer-ownership-verify.sql');

        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        expect(migrationSql).toContain(printerMigrationName);
        expect(migrationSql).toContain(printerMigrationChecksum);
    });

    it('ships the guarded category price-list schema and verifier', () => {
        const migrationName = '2026-07-22-category-owned-price-lists-v1';
        const migrationChecksum = 'c99120ff5dd91f847ed0706f6f034bd65920e73b082332ad1d5e5e7d54d2d5cb';
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-22-category-owned-price-lists.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-22-category-owned-price-lists-verify.sql');

        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);

        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const verifySql = fs.readFileSync(verifyPath, 'utf8');

        expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
        expect(migrationSql).toContain('price_list_root_id int(11) DEFAULT NULL');
        expect(migrationSql).toContain('idx_categories_price_list_tree (price_list_root_id, is_active, id)');
        expect(migrationSql).toContain('fk_categories_price_list_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE SET NULL');
        expect(migrationSql).toContain('PRIMARY KEY (price_list_root_id, product_id)');
        expect(migrationSql).toContain('fk_product_price_overrides_root FOREIGN KEY (price_list_root_id) REFERENCES categories (id) ON DELETE CASCADE');
        expect(migrationSql).toContain('fk_product_price_overrides_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE');
        expect(migrationSql).toContain('chk_product_price_overrides_nonnegative CHECK (price >= 0)');
        expect(migrationSql).toContain(migrationName);
        expect(migrationSql).toContain(migrationChecksum);
        expect(verifySql).toContain('invalid_price_list_roots');
        expect(verifySql).toContain('invalid_price_list_descendants');
        expect(verifySql).toContain('parent.price_list_root_id');
        expect(verifySql).toContain('dormant_override_rows');
        expect(verifySql).toContain('categories_price_list_column');
        expect(verifySql).toContain('product_price_overrides_foreign_keys');
        expect(verifySql).toContain('missing_count');
        expect(verifySql).toContain('blocking_findings');
    });

    it('ships the guarded customer meal subscription schema and verifier', () => {
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-22-customer-meal-subscriptions.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-22-customer-meal-subscriptions-verify.sql');

        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);

        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const verifySql = fs.readFileSync(verifyPath, 'utf8');
        expect(migrationSql).toContain('2026-07-22-customer-meal-subscriptions-v1');
        expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS subscription_plans');
        expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS customer_subscriptions');
        expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS subscription_redemptions');
        expect(migrationSql).toContain("'pos.subscriptions'");
        expect(verifySql).toContain('subscription_tables');
    });

    it('ships and requires the guarded admin manual-subscription migration', () => {
        const migrationName = '2026-07-23-admin-manual-subscriptions-v1';
        const migrationChecksum = 'bfae412c0de61b04d05591a4089054e8a88bbc65433ac816a0cfd64243c904bf';
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-23-admin-manual-subscriptions.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-23-admin-manual-subscriptions-verify.sql');

        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const verifySql = fs.readFileSync(verifyPath, 'utf8');
        expect(migrationSql).toContain('MODIFY purchase_invoice_id INT NULL');
        expect(migrationSql).toContain('manual_reason VARCHAR(255) NULL');
        expect(migrationSql).toContain('fk_customer_subscriptions_created_by');
        expect(migrationSql).toContain('chk_customer_subscriptions_origin');
        expect(migrationSql).toContain(migrationName);
        expect(migrationSql).toContain(migrationChecksum);
        expect(verifySql).toContain('manual_subscription_columns');
        expect(verifySql).toContain('invalid_subscription_origins');

        const validation = loadSchemaValidation();
        expect(migrationSql).toContain(migrationChecksum);
    });

    it('ships the guarded subscription receivables schema and verifier', () => {
        const migrationName = '2026-07-29-subscription-receivables-v1';
        const migrationChecksum = 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da';
        const preflightPath = path.join(ROOT, 'backend/migrations/2026-07-29-subscription-receivables-preflight.sql');
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-29-subscription-receivables.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-29-subscription-receivables-verify.sql');

        expect(fs.existsSync(preflightPath)).toBe(true);
        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);
        const preflightSql = fs.readFileSync(preflightPath, 'utf8');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const verifySql = fs.readFileSync(verifyPath, 'utf8');

        expect(preflightSql).toContain('blocking_findings');
        expect(preflightSql).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
        expect(migrationSql).toContain("enum('cash','card','split','receivable','unpaid_table','voided')");
        expect(migrationSql).toContain('CREATE TABLE subscription_collections');
        expect(migrationSql).toContain('chk_orders_receivable_terms');
        expect(migrationSql).toContain("'pos.subscription_credit'");
        expect(migrationSql).toContain("('subscription_receivables_enabled','0')");
        expect(migrationSql).toContain(migrationName);
        expect(migrationSql).toContain(migrationChecksum);
        expect(verifySql).toContain('receivable_order_columns');
        expect(verifySql).toContain('subscription_collection_table');
        expect(verifySql).toContain('blocking_findings');
    });

    it('ships and requires relational ownership for progressive split checks', () => {
        const migrationName = '2026-07-24-progressive-split-checks-v1';
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-24-progressive-split-checks.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-24-progressive-split-checks-verify.sql');

        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const verifySql = fs.readFileSync(verifyPath, 'utf8');
        expect(migrationSql).toContain('parent_invoice_id int(11) DEFAULT NULL');
        expect(migrationSql).toContain('table_id int(11) DEFAULT NULL');
        expect(migrationSql).toContain('idx_held_orders_parent_invoice');
        expect(migrationSql).toContain('idx_held_orders_split_table');
        expect(migrationSql).toContain('fk_held_orders_parent_invoice');
        expect(migrationSql).toContain('fk_held_orders_split_table');
        expect(migrationSql).toContain(migrationName);
        expect(verifySql).toContain('progressive_split_columns');

        expect(loadSchemaValidation()).toBeTruthy();
    });

    it('preserves split quantities at six-decimal precision through sale and refund rows', () => {
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-08-13-split-quantity-precision.sql');
        const autoPath = path.join(ROOT, 'backend/migrations/2026-08-13-split-quantity-precision.auto.sql');
        const fixture = fs.readFileSync(path.join(ROOT, 'backend/tests/fixtures/seed.js'), 'utf8');

        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(autoPath)).toBe(true);
        expect(fs.readFileSync(migrationPath, 'utf8')).toContain('MODIFY COLUMN quantity DECIMAL(12,6) NOT NULL');
        expect(fs.readFileSync(autoPath, 'utf8')).toContain('MODIFY COLUMN quantity DECIMAL(12,6) NOT NULL');
        expect(fixture).toMatch(/CREATE TABLE order_items[\s\S]*quantity decimal\(12,6\) NOT NULL/i);
        expect(fixture).toMatch(/CREATE TABLE refund_items[\s\S]*quantity DECIMAL\(12,6\) NOT NULL/i);
    });

    it('fails startup when split quantity precision drifts', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { split_quantity_precision: 1 } });
        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('split_quantity_precision');
    });

    it('fails startup when progressive split ownership is incomplete', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { progressive_split_columns: 1 } });
        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('progressive_split_columns');
    });

    it('ships and requires the guarded JoFotara operations migration', () => {
        const jofotaraMigrationName = '2026-07-24-jofotara-operations-v1';
        const jofotaraMigrationChecksum = '3106a8e43bc3ad579e57e0a50e0bc7ac7e48f0cca6b9851fedd272c845ebc36e';
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-24-jofotara-operations.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-24-jofotara-operations-verify.sql');

        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const verifySql = fs.readFileSync(verifyPath, 'utf8');
        expect(migrationSql).toContain("('jofotara_auto_submit', '0')");
        expect(migrationSql).toContain("('jofotara_auto_submit_since', '')");
        expect(migrationSql).toContain(jofotaraMigrationName);
        expect(migrationSql).toContain(jofotaraMigrationChecksum);
        expect(verifySql).toContain('jofotara_operations_settings');
        expect(loadSchemaValidation().MIGRATION_NAME).toBe(MIGRATION_NAME);
    });

    it('fails startup when a JoFotara operations setting is missing', async () => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { jofotara_operations_settings: 1 } });
        await expect(validation.validateRequiredSchema(db)).rejects.toThrow('jofotara_operations_settings');
    });

    it.each([
        'print_template_tables',
        'print_template_required_columns',
        'print_template_primary_keys',
        'print_template_foreign_keys',
        'print_template_required_indexes',
        'print_template_required_checks',
        'print_template_seed_rows'
    ])('fails startup when %s is incomplete', async (requirement) => {
        const validation = loadSchemaValidation();
        const db = createDb({ summary: { [requirement]: 0 } });

        await expect(validation.validateRequiredSchema(db)).rejects.toThrow(requirement);
    });

    it('ships the guarded print-template schema, verifier, and exact authority fingerprint', () => {
        const printTemplateMigrationName = '2026-07-25-print-templates-v1';
        const printTemplateMigrationChecksum = 'd5ef4e76335b81799b8caff7b2aa6fc276c80b34896b433dff70b913dff34c07';
        const preflightPath = path.join(ROOT, 'backend/migrations/2026-07-25-print-templates-preflight.sql');
        const migrationPath = path.join(ROOT, 'backend/migrations/2026-07-25-print-templates.sql');
        const verifyPath = path.join(ROOT, 'backend/migrations/2026-07-25-print-templates-verify.sql');

        expect(fs.existsSync(preflightPath)).toBe(true);
        expect(fs.existsSync(migrationPath)).toBe(true);
        expect(fs.existsSync(verifyPath)).toBe(true);

        const preflightSql = fs.readFileSync(preflightPath, 'utf8');
        const migrationSql = fs.readFileSync(migrationPath, 'utf8');
        const verifySql = fs.readFileSync(verifyPath, 'utf8');

        expect(preflightSql).toContain('blocking_findings');
        expect(preflightSql).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
        expect(migrationSql).toContain('CREATE TABLE print_templates');
        expect(migrationSql).toContain('CREATE TABLE print_template_revisions');
        expect(migrationSql).toContain('CREATE TABLE print_template_revision_tests');
        expect(migrationSql).toContain("INSERT IGNORE INTO print_templates (document_type) VALUES ('receipt'), ('kitchen')");
        expect(migrationSql).toContain(printTemplateMigrationName);
        expect(migrationSql).toContain(printTemplateMigrationChecksum);
        expect(verifySql).toContain('print_template_tables');
        expect(verifySql).toContain('print_template_required_columns');
        expect(verifySql).toContain('print_template_foreign_keys');
        expect(verifySql).toContain('JSON_VALID(definition_json)');
        expect(verifySql).toContain('blocking_findings');
        expect(loadSchemaValidation().MIGRATION_NAME).toBe(MIGRATION_NAME);
        expect(loadSchemaValidation().MIGRATION_CHECKSUM).toBe(MIGRATION_CHECKSUM);
    });

    it('pins print-template primary-key and check-expression shapes and keeps verifier findings numeric', () => {
        const validationSource = fs.readFileSync(path.join(ROOT, 'backend/services/schemaValidation.js'), 'utf8');
        const verifySource = fs.readFileSync(path.join(ROOT, 'backend/migrations/2026-07-25-print-templates-verify.sql'), 'utf8');

        expect(validationSource).toContain("INDEX_NAME='PRIMARY'");
        expect(validationSource).toContain("EXTRA='auto_increment'");
        expect(validationSource).toContain("COLUMN_DEFAULT='0'");
        expect(validationSource).toContain("EXTRA='on update current_timestamp()'");
        expect(validationSource).toContain("TABLE_COLLATION='utf8mb4_general_ci'");
        expect(validationSource).toContain("COLLATION_NAME='utf8mb4_bin'");
        expect(validationSource).toContain('information_schema.CHECK_CONSTRAINTS');
        expect(validationSource).toContain("REPLACE(cc.CHECK_CLAUSE, CHAR(96), '')");
        expect(validationSource).toContain("'revision_no > 0'");
        expect(validationSource).toContain("'json_valid(definition_json)'");
        expect(verifySource).toContain("'document_type in (''receipt'',''kitchen'')'");
        expect(verifySource).toContain('PREPARE ps_print_template_verify FROM @ps_print_template_verify_sql');
    });
});
