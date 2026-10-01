import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });
// These cases rebuild the complete historical schema and rerun additive DDL.
// The expanded chain exceeds 30 seconds on the local MariaDB fixture; a timeout
// must not let the next test drop the same database while DDL is still running.
vi.setConfig({ testTimeout: 180_000 });

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');

async function loadHistoricalSubscriptionSchema(connection) {
    // Historical upgrade cases replay migrations that predate retirement.
    // The current deployment baseline intentionally contains none of these tables.
    await connection.query(fs.readFileSync(path.resolve(__dirname, '../fixtures/subscriptionLegacySchema.sql'), 'utf8'));
}

async function runPreRetirementMigrations(pool) {
    // Preserve the historical buyer-snapshot replay against its original chain.
    // The retirement migration must reject the deliberately nonempty plan below.
    const directory = path.resolve(__dirname, '../../migrations');
    const manifestPath = path.join(directory, `.auto-manifest-historical-${process.pid}.json`);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
    manifest.migrations = manifest.migrations.slice(0, manifest.migrations.findIndex(({ name }) => name === SUBSCRIPTION_RETIREMENT_NAME));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
        return await runPendingMigrations(pool, { manifestPath });
    } finally {
        fs.unlinkSync(manifestPath);
    }
}

const DATABASE = 'posapp_auto_migration_test';
const RECEIVABLE_NAME = '2026-07-29-subscription-receivables-v1';
const RECEIVABLE_CHECKSUM = 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da';
const PLATFORM_NAME = '2026-07-31-platform-held-order-settlement-v1';
const PLATFORM_CHECKSUM = 'cf94e76c83a78255bcce22b443b105692d081db2d717717191ea921181799b85';
const TAX_NAME = '2026-07-31-tax-exempt-checks-v1';
const TAX_CHECKSUM = '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3';
const REPAIR_NAME = '2026-08-01-additive-schema-reconciliation-v1';
const PROVIDER_NAME = '2026-08-03-platform-provider-reconciliation-v1';
const PROVIDER_CHECKSUM = '21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999';
const TAX_CATEGORY_NAME = '2026-08-04-jofotara-tax-categories-v1';
const TAX_CATEGORY_CHECKSUM = 'dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41';
const SPECIAL_SOURCE_NAME = '2026-08-04-special-source-buyer-snapshots-v1';
const SPECIAL_SOURCE_CHECKSUM = '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244';
const SERVICE_CHARGE_CATEGORY_NAME = '2026-08-05-service-charge-jofotara-tax-category-v1';
const SERVICE_CHARGE_CATEGORY_CHECKSUM = '9004d8ce5f3de65e3a90e2576d04a58e467b575e1b3bcd257ed11ea376ee8678';
const SETTINGS_VALUE_CAPACITY_NAME = '2026-08-08-settings-value-capacity-v1';
const SETTINGS_VALUE_CAPACITY_CHECKSUM = 'ff924b0bcdddcf8e6516dca12c8a89bd0e1dc811dafe8e1e91d71d99f3e91cff';
const IMPORTED_SCHEMA_REPAIR_NAME = '2026-08-09-imported-schema-drift-repair-v1';
const IMPORTED_SCHEMA_REPAIR_CHECKSUM = '0464357684022fb8dd6e8187adef527293296127b4233c0d4871d2f030713f73';
const BASELINE_AUTHORITY_NAME = '2026-08-09-baseline-foreign-key-authority-v1';
const BASELINE_AUTHORITY_CHECKSUM = '8f6e50495f7f7781507e692ac959beedaf622b5978bc6e9e2ac8d711282cd937';
const ORDER_REFERENCE_NAME = '2026-08-10-order-reference-authority-v1';
const ORDER_REFERENCE_CHECKSUM = 'da921de3485d1d776cc4f6a23e1e3212eb17d75e1b02088e83f4eae15b4eac35';
const LEGACY_PERMISSION_NAME = '2026-08-10-legacy-permission-column-retirement-v1';
const LEGACY_PERMISSION_CHECKSUM = 'd3bf428849b637d8efd463cc3a7ad0db920dee08ecb676d1d44099b335ecb550';
const REFUND_STATUS_NAME = '2026-08-10-refund-status-reconciliation-v1';
const REFUND_STATUS_CHECKSUM = '00b8fedabceb21101e6bb2739f89c54a6f7ee8fef6aa7b155a4e037b093f7ee6';
const ORDER_REFERENCE_INDEX_NAME = '2026-08-10-order-reference-index-authority-v1';
const HELD_ORDER_LIFECYCLE_NAME = '2026-08-10-held-order-lifecycle-v1';
const HELD_ORDER_LIFECYCLE_CHECKSUM = 'af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160';
const CALL_CENTER_NAME = '2026-08-10-call-center-held-orders-v1';
const CALL_CENTER_CHECKSUM = 'f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b';
const RECEIPT_TAX_DISPLAY_NAME = '2026-08-11-receipt-tax-display-v1';
const RECEIPT_TAX_DISPLAY_CHECKSUM = '90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3';
const SPLIT_QUANTITY_NAME = '2026-08-13-split-quantity-precision-v1';
const SPLIT_QUANTITY_CHECKSUM = 'eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76';
const WEBAUTHN_NAME = '2026-08-13-webauthn-registered-device-access-v1';
const WEBAUTHN_CHECKSUM = '20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09';
const SPOOLER_V2_NAME = '2026-08-17-spooler-v2-agents-v1';
const SPOOLER_V2_CHECKSUM = 'e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985';
const AUDIT_BROWSER_PREVIEW_NAME = '2026-08-23-audit-browser-preview-v1';
const AUDIT_BROWSER_PREVIEW_CHECKSUM = 'e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af';
const JOFOTARA_STALE_INDEX_NAME = '2026-08-30-jofotara-stale-submission-index-v1';
const JOFOTARA_STALE_INDEX_CHECKSUM = '5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed';
const POS_ORDER_HISTORY_NAME = '2026-08-31-pos-order-history-default-v1';
const POS_ORDER_HISTORY_CHECKSUM = '862e5378c380fa9c7145a184ec65ce75268020c1991d0a2f2765d6412d13d47b';
const PRODUCT_PRICE_OVERRIDE_LOCK_NAME = '2026-09-01-product-price-override-lock-v1';
const PRODUCT_PRICE_OVERRIDE_LOCK_CHECKSUM = 'e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8';
const FRACTIONAL_STOCK_NAME = '2026-09-01-fractional-stock-precision-v1';
const FRACTIONAL_STOCK_CHECKSUM = 'b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e';
const EXPENSE_ZERO_NAME = '2026-09-02-expense-zero-amount-v1';
const EXPENSE_ZERO_CHECKSUM = '264803980dc3f0eb94c5fcbe880ec8236d0b5a53db472f8cdc76998cbd4bda75';
const Y_ORDER_TYPE_NAME = '2026-09-03-y-order-type-setting-v1';
const Y_ORDER_TYPE_CHECKSUM = '4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3';
const RECIPE_LEDGER_NAME = '2026-09-05-recipe-ledger-v1';
const RECIPE_LEDGER_CHECKSUM = '9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb';
const STOCK_CORE_NAME = '2026-09-08-stock-ledger-core-v1';
const STOCK_CORE_CHECKSUM = '39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4';
const STOCK_SNAPSHOT_NAME = '2026-09-08-stock-sale-snapshots-v1';
const STOCK_SNAPSHOT_CHECKSUM = 'b20277b32d97ac5bfb303373e1fb7db67462ed071efaa6378906afda3935931f';
const STOCK_AVAILABILITY_NAME = '2026-09-08-stock-availability-policy-v1';
const STOCK_AVAILABILITY_CHECKSUM = '161a876cdeb6ee9b5ce72e1637cfbcaf25d64aa4a20787789abcb116048f8c88';
const STOCK_INGREDIENT_CUTOVER_NAME = '2026-09-08-stock-ingredient-cutover-v1';
const STOCK_INGREDIENT_CUTOVER_CHECKSUM = 'a6fc46b77ffc44f827b94d1d1ef063deb570e3eb83152347a88f0de759621a5a';
const STOCK_REPORT_BACKFILL_NAME = '2026-09-08-stock-report-backfill-v1';
const STOCK_REPORT_BACKFILL_CHECKSUM = '7c7eebb53d2edfc67603cbf1acb12a14c1b240608228df3c6b53d08a1df30cc4';
const STOCK_REPORT_COUNTS_NAME = '2026-09-08-stock-report-count-intervals-v1';
const STOCK_REPORT_COUNTS_CHECKSUM = '6279aa3e466c57d56ad077c67728e68f39e3369a9d61fffa232ba7eb701d61c4';
const STOCK_REPORT_DAILY_NAME = '2026-09-08-stock-report-daily-projection-v1';
const STOCK_REPORT_DAILY_CHECKSUM = 'eff1f4f5ec030b5fff7f637aae7daf5a9b671cdb21dd99d7423e559887314a67';
const TYPE_NUMBER_NAME='2026-09-12-order-type-numbering-v1';
const STOCK_IDENTITY_NAME='2026-09-12-stock-item-identity-v1';
const INGREDIENT_STATE_NAME='2026-09-12-ingredient-state-v1';
const TABLE_ACTION_RECOVERY_NAME='2026-09-13-table-action-recovery-v1';
const PAID_SPLIT_INDEX_NAME='2026-09-13-paid-split-parent-index-v1';
const TABLE_SEATING_NAME='2026-09-13-table-seating-v1';
const DELETED_ITEMS_NAME='2026-09-14-deleted-table-items-v1';
const PERMISSION_CATALOG_NAME='2026-09-14-permission-catalog-v1';
const TABLE_ACCESS_SCOPE_NAME='2026-09-14-table-access-scope-v1';
const PERMISSION_CATALOG_V2_NAME='2026-09-14-permission-catalog-v2';
const PRINT_QUEUE_TIMINGS_NAME='2026-09-17-print-queue-timings-v1';
const CUSTOMER_PHONE_INDEX_NAME='2026-09-19-customer-phone-index-v1';
const ORDER_INTAKE_REQUESTS_NAME='2026-09-20-order-intake-requests-v1';
const CUSTOMER_INFO_NAME='2026-09-22-product-customer-info-v1';
const SUBSCRIPTION_RETIREMENT_NAME='2026-09-23-subscriptions-retirement-v1';
const EXPENSE_REQUEST_NAME='2026-09-26-expense-request-id-v1';
const PRINTER_LAST_PRINTED_NAME='2026-09-30-printer-last-printed-v1';
const MULTI_TERMINAL_NAME='2026-09-30-multi-terminal-permission-v1';
const PURCHASE_INVOICES_NAME='2026-09-30-purchase-invoices-v1';
const RETIRE_PURCHASING_NAME='2026-10-01-retire-purchasing-tables-v1';
const STOCK_DOCUMENTS_NAME='2026-10-01-stock-documents-v1';
const PURCHASE_ITEM_KIND_NAME='2026-10-02-purchase-item-kind-v1';
const PRODUCT_BARCODES_NAME='2026-10-03-product-barcodes-v1';
const HELD_DATE_INDEX_NAME='2026-09-12-held-report-date-index-v1';
const UNIFIED_MOVEMENTS_NAME='2026-09-12-unified-stock-movements-v1';
const TYPE_NUMBER_CHECKSUM='91f50cc44ba575da5014fada4f152a709686b38950eead8eaf732f5a6b99d883';
const HELD_NUMBER_NAME='2026-09-09-held-order-numbers-v1';
const HELD_NUMBER_CHECKSUM='be050ef6d757dcc9cb35d1bd40653944acc607c277ab467271690dc35f9060ad';
const PROCUREMENT_INTEGRITY_NAME='2026-09-08-procurement-request-integrity-v1';
const PROCUREMENT_INTEGRITY_CHECKSUM='257ea0670b30d1755b7d67246355593c49abf93ac15543a83aa98a7153bd157f';
const STOCK_PROCUREMENT_NAME = '2026-09-08-stock-procurement-v1';
const STOCK_PROCUREMENT_CHECKSUM = 'a5394bbf4fe947eb059d1bffad0462853772b6d055c693988a7c03e188dc898d';
const INGREDIENT_WORKING_BALANCES_NAME = '2026-09-08-ingredient-working-balances-v1';
const INGREDIENT_WORKING_BALANCES_CHECKSUM = 'bccb2b82db00b7ce16af34d3adb3f0dd8feedeb9f85beeb9eae956d2ff30fd84';
const STOCK_RESOLVED_LINKS_NAME = '2026-09-08-stock-resolved-product-links-v1';
const STOCK_RESOLVED_LINKS_CHECKSUM = 'c00a02a6fda76f018ad8287a9d4a0355564d93a8430f0eb1a0d496dd45ffe301';
const STOCK_REPORT_REBUILD_NAME = '2026-09-08-stock-report-ingredient-rebuild-v1';
const STOCK_REPORT_REBUILD_CHECKSUM = '73cfeb1ec68ec93d958e216c939924627b916264a82da1879f1069c30363a329';
const STOCK_ITEM_PROJECTIONS_NAME = '2026-09-08-stock-item-projections-v1';
const STOCK_ITEM_PROJECTIONS_CHECKSUM = '6d81e9659ccd1da36f4067f8791d60c0311d48ec94249745a4164617a2d34f9b';
const STOCK_REPORT_FACTS_NAME = '2026-09-08-stock-report-facts-v1';
const STOCK_REPORT_FACTS_CHECKSUM = 'c4797f565bb206d531d832e567328842dad770a2efcc5ed55959dc317f41e8eb';
const STOCK_REPORT_GENERATIONS_NAME = '2026-09-08-stock-report-generations-v1';
const STOCK_REPORT_GENERATIONS_CHECKSUM = '724f2c5c996734c9a86f373d82a988468c77c2764a9f681e41de91739542e510';
const STOCK_READ_INDEX_NAME = '2026-09-08-stock-read-index-v1';
const STOCK_READ_INDEX_CHECKSUM = '318b60dd24d5961d50e51da89994895022e1bae1f7c24fe2d4ed9a6f954ce081';
const STOCK_ADJUSTMENT_NAME = '2026-09-08-stock-adjustments-v1';
const STOCK_ADJUSTMENT_CHECKSUM = '24dc1b1c7b16edb759bfdd7bcb0a67fdd7c13f2a75bd8388e98f4cb6a6a528cc';
const INGREDIENT_ANALYSIS_NAME = '2026-09-07-ingredient-analysis-v1';
const INGREDIENT_ANALYSIS_CHECKSUM = 'e83dc402889a86726e63c672f4d2c9e8a67aa8c24180ac13cf6b9d16f440ac60';
const RECIPE_PERFORMANCE_NAME = '2026-09-06-recipe-ledger-performance-v1';
const RECIPE_PERFORMANCE_CHECKSUM = 'f58a8a615d01ee8dddc91665a1d45120f5c565ede0d992b61c3760be0c27b95c';
const LEGACY_PERMISSION_COLUMNS = [
    'can_view_orders', 'canholdorders', 'can_update_table', 'can_apply_discount', 'can_void_items',
    'can_open_register', 'can_checkout_tables', 'bypass_existing_tables', 'bypass_printed_tables',
    'can_view_order_history', 'can_transfer_table', 'can_join_tables', 'can_split_bills',
    'waiter_split_bill', 'can_print_check'
];
const BASELINE_AUTHORITY_RELATIONSHIPS = [
    { CONSTRAINT_NAME: 'fk_uperm_user', TABLE_NAME: 'user_permissions', COLUMN_NAME: 'user_id', REFERENCED_TABLE_NAME: 'users', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'CASCADE' },
    { CONSTRAINT_NAME: 'fk_uperm_perm', TABLE_NAME: 'user_permissions', COLUMN_NAME: 'perm_key', REFERENCED_TABLE_NAME: 'permissions', REFERENCED_COLUMN_NAME: 'perm_key', DELETE_RULE: 'CASCADE' },
    { CONSTRAINT_NAME: 'fk_parent_table', TABLE_NAME: 'restaurant_tables', COLUMN_NAME: 'parent_table_id', REFERENCED_TABLE_NAME: 'restaurant_tables', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'SET NULL' },
    { CONSTRAINT_NAME: 'restaurant_tables_ibfk_1', TABLE_NAME: 'restaurant_tables', COLUMN_NAME: 'section_id', REFERENCED_TABLE_NAME: 'sections', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'RESTRICT' },
    { CONSTRAINT_NAME: 'shifts_ibfk_1', TABLE_NAME: 'shifts', COLUMN_NAME: 'user_id', REFERENCED_TABLE_NAME: 'users', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'RESTRICT' },
    { CONSTRAINT_NAME: 'order_items_ibfk_1', TABLE_NAME: 'order_items', COLUMN_NAME: 'invoice_id', REFERENCED_TABLE_NAME: 'orders', REFERENCED_COLUMN_NAME: 'invoice_id', DELETE_RULE: 'CASCADE' },
    { CONSTRAINT_NAME: 'order_items_ibfk_2', TABLE_NAME: 'order_items', COLUMN_NAME: 'product_id', REFERENCED_TABLE_NAME: 'products', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'RESTRICT' },
    { CONSTRAINT_NAME: 'fk_refund_items_refund', TABLE_NAME: 'refund_items', COLUMN_NAME: 'refund_id', REFERENCED_TABLE_NAME: 'refunds', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'CASCADE' },
    { CONSTRAINT_NAME: 'qr_table_drafts_ibfk_1', TABLE_NAME: 'qr_table_drafts', COLUMN_NAME: 'table_id', REFERENCED_TABLE_NAME: 'restaurant_tables', REFERENCED_COLUMN_NAME: 'id', DELETE_RULE: 'CASCADE' },
];

describe('automatic migration runner against MySQL', () => {
    it('upgrades the exact July 29 floor through the complete automatic chain', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            const baseline = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8');
            await admin.query(baseline);
            await admin.query(`
                INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
                VALUES ('orders.view','View Orders','عرض الطلبات','View and recall past and held orders.','عرض واسترجاع الطلبات السابقة والمعلقة.','orders',100,1,1,0);
                INSERT INTO users (id, user_number, name, role, is_active)
                VALUES (9001, '9001001', 'Existing Cashier', 'cashier', 1);
                INSERT INTO user_permissions (user_id, perm_key) VALUES (9001, 'orders.view');
            `);
            const preservedSetting = 'p'.repeat(255);
            await admin.query('ALTER TABLE settings MODIFY COLUMN setting_value VARCHAR(255) NOT NULL');
            await admin.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)',
                ['migration_capacity_probe', preservedSetting]
            );
            await admin.query('ALTER TABLE order_types DROP COLUMN is_deferred_settlement');
            await admin.query("ALTER TABLE orders MODIFY payment_method ENUM('cash','card','split','receivable','unpaid_table','voided') NOT NULL");
            await admin.query('ALTER TABLE orders DROP COLUMN tax_exempt_at_sale');
            await admin.query('ALTER TABLE order_items DROP COLUMN price_before_tax_exemption');
            await admin.query(`
                ALTER TABLE held_orders
                  DROP FOREIGN KEY fk_held_orders_claim_user,
                  DROP INDEX uq_held_orders_user_request,
                  DROP INDEX idx_held_orders_claim_owner,
                  DROP COLUMN version,
                  DROP COLUMN hold_request_id,
                  DROP COLUMN claimed_by_user_id,
                  DROP COLUMN claim_token_hash,
                  DROP COLUMN claim_expires_at,
                  DROP COLUMN updated_at,
                  DROP COLUMN kitchen_snapshot,
                  DROP COLUMN kitchen_dispatch_version,
                  DROP COLUMN last_operation_id,
                  DROP COLUMN last_operation_kind,
                  DROP COLUMN last_operation_result;
            `);
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query("INSERT INTO settings (setting_key, setting_value) VALUES ('service_charge_tax_rate', '8') ON DUPLICATE KEY UPDATE setting_value='8'");

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [PLATFORM_NAME, TAX_NAME, REPAIR_NAME, PROVIDER_NAME, TAX_CATEGORY_NAME, SPECIAL_SOURCE_NAME, SERVICE_CHARGE_CATEGORY_NAME, SETTINGS_VALUE_CAPACITY_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: [],
            });

            const [[orderTypeColumn]] = await pool.query(`
                SELECT COLUMN_TYPE, COLUMN_DEFAULT
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=? AND TABLE_NAME='order_types' AND COLUMN_NAME='is_deferred_settlement'
            `, [DATABASE]);
            const [[paymentMethodColumn]] = await pool.query(`
                SELECT COLUMN_TYPE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=? AND TABLE_NAME='orders' AND COLUMN_NAME='payment_method'
            `, [DATABASE]);
            const [[columns]] = await pool.query(`
                SELECT
                  SUM(TABLE_NAME='orders' AND COLUMN_NAME='tax_exempt_at_sale') AS order_column,
                  SUM(TABLE_NAME='order_items' AND COLUMN_NAME='price_before_tax_exemption') AS item_column
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=?
                  AND ((TABLE_NAME='orders' AND COLUMN_NAME='tax_exempt_at_sale')
                    OR (TABLE_NAME='order_items' AND COLUMN_NAME='price_before_tax_exemption'))
            `, [DATABASE]);
            const [[permission]] = await pool.query("SELECT implemented, default_cashier FROM permissions WHERE perm_key='pos.tax_exempt'");
            const [[ordersPermission]] = await pool.query("SELECT label, label_ar, default_cashier FROM permissions WHERE perm_key='orders.view'");
            const [[preservedOrderHistoryGrant]] = await pool.query("SELECT COUNT(*) AS count FROM user_permissions WHERE user_id=9001 AND perm_key='orders.view'");
            const ledgerNames = [PLATFORM_NAME, TAX_NAME, PROVIDER_NAME, TAX_CATEGORY_NAME, SPECIAL_SOURCE_NAME, SERVICE_CHARGE_CATEGORY_NAME, SETTINGS_VALUE_CAPACITY_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME];
            const [ledger] = await pool.query(
                'SELECT migration_name, checksum FROM schema_migrations WHERE migration_name IN (?) ORDER BY migration_name',
                [ledgerNames]
            );
            const [[serviceChargeCategory]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_jofotara_tax_category'");
            expect(orderTypeColumn).toMatchObject({ COLUMN_DEFAULT: '0' });
            expect(paymentMethodColumn.COLUMN_TYPE).toContain("'platform'");
            expect(columns).toMatchObject({ order_column: '1', item_column: '1' });
            expect(permission).toMatchObject({ implemented: 1, default_cashier: 0 });
            expect(ordersPermission).toEqual({ label: 'POS Order History', label_ar: 'سجل طلبات نقطة البيع', default_cashier: 0 });
            expect(Number(preservedOrderHistoryGrant.count)).toBe(1);
            expect(ledger).toEqual([
                { migration_name: PLATFORM_NAME, checksum: PLATFORM_CHECKSUM },
                { migration_name: TAX_NAME, checksum: TAX_CHECKSUM },
                { migration_name: PROVIDER_NAME, checksum: PROVIDER_CHECKSUM },
                { migration_name: TAX_CATEGORY_NAME, checksum: TAX_CATEGORY_CHECKSUM },
                { migration_name: SPECIAL_SOURCE_NAME, checksum: SPECIAL_SOURCE_CHECKSUM },
                { migration_name: SERVICE_CHARGE_CATEGORY_NAME, checksum: SERVICE_CHARGE_CATEGORY_CHECKSUM },
                { migration_name: SETTINGS_VALUE_CAPACITY_NAME, checksum: SETTINGS_VALUE_CAPACITY_CHECKSUM },
                { migration_name: BASELINE_AUTHORITY_NAME, checksum: BASELINE_AUTHORITY_CHECKSUM },
                { migration_name: IMPORTED_SCHEMA_REPAIR_NAME, checksum: IMPORTED_SCHEMA_REPAIR_CHECKSUM },
                { migration_name: CALL_CENTER_NAME, checksum: CALL_CENTER_CHECKSUM },
                { migration_name: HELD_ORDER_LIFECYCLE_NAME, checksum: HELD_ORDER_LIFECYCLE_CHECKSUM },
                { migration_name: ORDER_REFERENCE_NAME, checksum: ORDER_REFERENCE_CHECKSUM },
                { migration_name: ORDER_REFERENCE_INDEX_NAME, checksum: '8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d' },
                { migration_name: REFUND_STATUS_NAME, checksum: REFUND_STATUS_CHECKSUM },
                { migration_name: RECEIPT_TAX_DISPLAY_NAME, checksum: RECEIPT_TAX_DISPLAY_CHECKSUM },
                { migration_name: SPLIT_QUANTITY_NAME, checksum: SPLIT_QUANTITY_CHECKSUM },
                { migration_name: WEBAUTHN_NAME, checksum: WEBAUTHN_CHECKSUM },
                { migration_name: SPOOLER_V2_NAME, checksum: SPOOLER_V2_CHECKSUM },
                { migration_name: AUDIT_BROWSER_PREVIEW_NAME, checksum: AUDIT_BROWSER_PREVIEW_CHECKSUM },
                { migration_name: JOFOTARA_STALE_INDEX_NAME, checksum: JOFOTARA_STALE_INDEX_CHECKSUM },
                { migration_name: POS_ORDER_HISTORY_NAME, checksum: POS_ORDER_HISTORY_CHECKSUM },
                { migration_name: FRACTIONAL_STOCK_NAME, checksum: FRACTIONAL_STOCK_CHECKSUM },
                { migration_name: PRODUCT_PRICE_OVERRIDE_LOCK_NAME, checksum: PRODUCT_PRICE_OVERRIDE_LOCK_CHECKSUM },
                { migration_name: EXPENSE_ZERO_NAME, checksum: EXPENSE_ZERO_CHECKSUM },
                { migration_name: Y_ORDER_TYPE_NAME, checksum: Y_ORDER_TYPE_CHECKSUM },
                { migration_name: RECIPE_LEDGER_NAME, checksum: RECIPE_LEDGER_CHECKSUM },
                { migration_name: RECIPE_PERFORMANCE_NAME, checksum: RECIPE_PERFORMANCE_CHECKSUM },
                { migration_name: INGREDIENT_ANALYSIS_NAME, checksum: INGREDIENT_ANALYSIS_CHECKSUM },
                { migration_name: INGREDIENT_WORKING_BALANCES_NAME, checksum: INGREDIENT_WORKING_BALANCES_CHECKSUM },
                { migration_name: PROCUREMENT_INTEGRITY_NAME, checksum: PROCUREMENT_INTEGRITY_CHECKSUM },
                { migration_name: STOCK_ADJUSTMENT_NAME, checksum: STOCK_ADJUSTMENT_CHECKSUM },
                { migration_name: STOCK_AVAILABILITY_NAME, checksum: STOCK_AVAILABILITY_CHECKSUM },
                { migration_name: STOCK_INGREDIENT_CUTOVER_NAME, checksum: STOCK_INGREDIENT_CUTOVER_CHECKSUM },
                { migration_name: STOCK_ITEM_PROJECTIONS_NAME, checksum: STOCK_ITEM_PROJECTIONS_CHECKSUM },
                { migration_name: STOCK_CORE_NAME, checksum: STOCK_CORE_CHECKSUM },
                { migration_name: STOCK_PROCUREMENT_NAME, checksum: STOCK_PROCUREMENT_CHECKSUM },
                { migration_name: STOCK_READ_INDEX_NAME, checksum: STOCK_READ_INDEX_CHECKSUM },
                { migration_name: STOCK_REPORT_BACKFILL_NAME, checksum: STOCK_REPORT_BACKFILL_CHECKSUM },
                { migration_name: STOCK_REPORT_COUNTS_NAME, checksum: STOCK_REPORT_COUNTS_CHECKSUM },
                { migration_name: STOCK_REPORT_DAILY_NAME, checksum: STOCK_REPORT_DAILY_CHECKSUM },
                { migration_name: STOCK_REPORT_FACTS_NAME, checksum: STOCK_REPORT_FACTS_CHECKSUM },
                { migration_name: STOCK_REPORT_GENERATIONS_NAME, checksum: STOCK_REPORT_GENERATIONS_CHECKSUM },
                { migration_name: STOCK_REPORT_REBUILD_NAME, checksum: STOCK_REPORT_REBUILD_CHECKSUM },
                { migration_name: STOCK_RESOLVED_LINKS_NAME, checksum: STOCK_RESOLVED_LINKS_CHECKSUM },
                { migration_name: STOCK_SNAPSHOT_NAME, checksum: STOCK_SNAPSHOT_CHECKSUM },
                { migration_name: HELD_NUMBER_NAME, checksum: HELD_NUMBER_CHECKSUM },
                { migration_name: HELD_DATE_INDEX_NAME, checksum: '46e59d46adeee1ecd3dd569e42af670da9f3f36500daed5a8aa6f00b18789034' },
                { migration_name: INGREDIENT_STATE_NAME, checksum: '2cc330a0d1e14cd68ee38aa92bfb142371926b6752dd3f928c6c1aa53a42f30e' },
                { migration_name: TYPE_NUMBER_NAME, checksum: TYPE_NUMBER_CHECKSUM },
                { migration_name: STOCK_IDENTITY_NAME, checksum: '045d0475fd16715e4eafb913a6f7fe839ed7fb7920e2a8d478b86878172de24b' },
                { migration_name: UNIFIED_MOVEMENTS_NAME, checksum: '91cba75ab3e889134d546233f79ccaa6e2dc8a7d0f9cabf4dd855154736add99' },
                { migration_name: PAID_SPLIT_INDEX_NAME, checksum: 'ea1306e908192591951672a4dc91197877f7d707522193ac63802364d3a94136' },
                { migration_name: TABLE_ACTION_RECOVERY_NAME, checksum: '00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92' },
                { migration_name: TABLE_SEATING_NAME, checksum: '78f8798435bc6e44e45aeb1642189f42a9d562edb268354868b6d3e5a7674ab1' },
                { migration_name: DELETED_ITEMS_NAME, checksum: 'b207a4706801a2ba9c933d898af7722858de031005d00d1ca8490851a09d6b4e' },
                { migration_name: PERMISSION_CATALOG_NAME, checksum: require('../../migrations/auto-manifest.json').migrations.find(row => row.name === PERMISSION_CATALOG_NAME).checksum },
                { migration_name: PERMISSION_CATALOG_V2_NAME, checksum: require('../../migrations/auto-manifest.json').migrations.find(row => row.name === PERMISSION_CATALOG_V2_NAME).checksum },
                { migration_name: TABLE_ACCESS_SCOPE_NAME, checksum: require('../../migrations/auto-manifest.json').migrations.find(row => row.name === TABLE_ACCESS_SCOPE_NAME).checksum },
                { migration_name: PRINT_QUEUE_TIMINGS_NAME, checksum: require('../../migrations/auto-manifest.json').migrations.find(row => row.name === PRINT_QUEUE_TIMINGS_NAME).checksum },
                { migration_name: CUSTOMER_PHONE_INDEX_NAME, checksum: require('../../migrations/auto-manifest.json').migrations.find(row => row.name === CUSTOMER_PHONE_INDEX_NAME).checksum },
                { migration_name: ORDER_INTAKE_REQUESTS_NAME, checksum: require('../../migrations/auto-manifest.json').migrations.find(row => row.name === ORDER_INTAKE_REQUESTS_NAME).checksum },
                { migration_name: CUSTOMER_INFO_NAME, checksum: require('../../migrations/auto-manifest.json').migrations.find(row => row.name === CUSTOMER_INFO_NAME).checksum },
            ]);
            const [[settingsColumn]] = await pool.query(`
                SELECT DATA_TYPE, IS_NULLABLE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=? AND TABLE_NAME='settings' AND COLUMN_NAME='setting_value'
            `, [DATABASE]);
            expect(settingsColumn).toMatchObject({ DATA_TYPE: 'text', IS_NULLABLE: 'NO' });
            const [[preserved]] = await pool.query(
                "SELECT setting_value FROM settings WHERE setting_key='migration_capacity_probe'"
            );
            expect(preserved.setting_value).toBe(preservedSetting);
            expect(serviceChargeCategory.setting_value).toBe('S');

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: [PLATFORM_NAME, TAX_NAME, REPAIR_NAME, PROVIDER_NAME, TAX_CATEGORY_NAME, SPECIAL_SOURCE_NAME, SERVICE_CHARGE_CATEGORY_NAME, SETTINGS_VALUE_CAPACITY_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
            });

            await expect(runPendingMigrations(pool, { includeRepeatable: true })).resolves.toEqual({
                applied: [],
                skipped: [PLATFORM_NAME, TAX_NAME, REPAIR_NAME, PROVIDER_NAME, TAX_CATEGORY_NAME, SPECIAL_SOURCE_NAME, SERVICE_CHARGE_CATEGORY_NAME, SETTINGS_VALUE_CAPACITY_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
            });
            const [[retiredTables]] = await pool.query(`SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'subscription_%'`, [DATABASE]);
            expect(Number(retiredTables.total)).toBe(0);
            await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [REPAIR_NAME]);
            await expect(runPendingMigrations(pool, { includeRepeatable: true }))
                .rejects.toThrow(`Retired historical migration ledger entry is missing: ${REPAIR_NAME}`);
            const [[stillRetired]] = await pool.query(`SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'subscription_%'`, [DATABASE]);
            expect(Number(stillRetired.total)).toBe(0);
            const repairChecksum = require('../../migrations/auto-manifest.json').migrations.find(({ name }) => name === REPAIR_NAME).checksum;
            await pool.query('INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)', [REPAIR_NAME, repairChecksum]);
            await expect(validateRequiredSchema(pool)).resolves.toBe(true);
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('upgrades the exact held-order predecessor from a partial additive source state and preserves rows', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`
                INSERT INTO users (id, user_number, name, role, is_active)
                VALUES (1, 'held-order-migration-user', 'Held Order Migration User', 'admin', 1);
                INSERT INTO orders
                    (invoice_id, user_id, subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount, change_due)
                VALUES (1, 1, 12.00, 0.00, 12.00, 'cash', 12.00, 12.00, 0.00, 0.00);
                INSERT INTO held_orders (id, user_id, reference_name, cart_data, subtotal)
                VALUES (1, 1, 'Historical held order', '{"items":[]}', 12.00);
            `);
            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.slice(0, manifest.migrations.findIndex(({ name }) => name === CALL_CENTER_NAME));
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${prior.map(() => '(?, ?)').join(', ')}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );
            await admin.query(`
                ALTER TABLE users
                  MODIFY role ENUM('admin','cashier','programmer','waiter','table_manager') NOT NULL DEFAULT 'cashier';
                ALTER TABLE held_orders
                  DROP FOREIGN KEY fk_held_orders_call_center_user,
                  DROP INDEX idx_held_orders_call_center_user;
                ALTER TABLE orders
                  DROP FOREIGN KEY fk_orders_call_center_user,
                  DROP INDEX idx_orders_call_center_user,
                  DROP COLUMN call_center_user_id;
            `);

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: prior.map(({ name }) => name),
            });
            const [[columns]] = await pool.query(`
                SELECT
                  SUM(TABLE_NAME='orders' AND COLUMN_NAME='call_center_user_id' AND IS_NULLABLE='YES') AS order_source,
                  SUM(TABLE_NAME='held_orders' AND COLUMN_NAME='call_center_user_id' AND IS_NULLABLE='YES') AS held_source
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=? AND COLUMN_NAME='call_center_user_id'
            `, [DATABASE]);
            const [relationships] = await pool.query(`
                SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, rc.DELETE_RULE
                FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
                 AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=?
                  AND kcu.CONSTRAINT_NAME IN ('fk_orders_call_center_user','fk_held_orders_call_center_user')
                ORDER BY kcu.CONSTRAINT_NAME
            `, [DATABASE]);
            const [indexes] = await pool.query(`
                SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME
                FROM information_schema.STATISTICS
                WHERE TABLE_SCHEMA=?
                  AND INDEX_NAME IN ('idx_orders_call_center_user','idx_held_orders_call_center_user')
                ORDER BY INDEX_NAME
            `, [DATABASE]);
            const [[role]] = await pool.query(`
                SELECT COLUMN_TYPE
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME='role'
            `, [DATABASE]);
            const [[order]] = await pool.query('SELECT invoice_id, total, call_center_user_id FROM orders WHERE invoice_id=1');
            const [[held]] = await pool.query('SELECT id, reference_name, subtotal, call_center_user_id FROM held_orders WHERE id=1');
            expect(columns).toEqual({ order_source: '1', held_source: '1' });
            expect(relationships).toEqual([
                { TABLE_NAME: 'held_orders', CONSTRAINT_NAME: 'fk_held_orders_call_center_user', DELETE_RULE: 'RESTRICT' },
                { TABLE_NAME: 'orders', CONSTRAINT_NAME: 'fk_orders_call_center_user', DELETE_RULE: 'RESTRICT' },
            ]);
            expect(indexes).toEqual([
                { TABLE_NAME: 'held_orders', INDEX_NAME: 'idx_held_orders_call_center_user', COLUMN_NAME: 'call_center_user_id' },
                { TABLE_NAME: 'orders', INDEX_NAME: 'idx_orders_call_center_user', COLUMN_NAME: 'call_center_user_id' },
            ]);
            expect(role.COLUMN_TYPE).toContain("'call_center'");
            expect(order).toEqual({ invoice_id: 1, total: '12.00', call_center_user_id: null });
            expect(held).toEqual({ id: 1, reference_name: 'Historical held order', subtotal: '12.00', call_center_user_id: null });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('normalizes dangling order dimensions before adding restrictive foreign keys', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`
                INSERT INTO users (id, user_number, name, role, is_active)
                VALUES (1, 'migration-user', 'Migration User', 'admin', 1);
                ALTER TABLE orders DROP FOREIGN KEY fk_orders_waiter;
                ALTER TABLE orders DROP FOREIGN KEY fk_orders_order_type;
                ALTER TABLE orders DROP FOREIGN KEY fk_orders_customer;
                ALTER TABLE orders DROP FOREIGN KEY fk_orders_table;
                INSERT INTO orders (user_id, waiter_id, order_type_id, customer_id, table_id, subtotal, tax, total, payment_method)
                VALUES (1, 999001, 999002, 999003, 999004, 1.00, 0.00, 1.00, 'cash');
            `);
            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.filter(({ name }) => name !== ORDER_REFERENCE_NAME);
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da']
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${prior.map(() => '(?, ?)').join(', ')}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );
            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [ORDER_REFERENCE_NAME],
                skipped: prior.map(({ name }) => name),
            });
            const [[order]] = await pool.query(
                'SELECT waiter_id, order_type_id, customer_id, table_id FROM orders LIMIT 1'
            );
            expect(order).toEqual({ waiter_id: null, order_type_id: null, customer_id: null, table_id: null });
            const [relationships] = await pool.query(`
                SELECT kcu.CONSTRAINT_NAME, rc.DELETE_RULE
                FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA=kcu.CONSTRAINT_SCHEMA
                 AND rc.TABLE_NAME=kcu.TABLE_NAME
                 AND rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=? AND kcu.TABLE_NAME='orders'
                  AND kcu.CONSTRAINT_NAME IN ('fk_orders_waiter','fk_orders_order_type','fk_orders_customer','fk_orders_table')
                ORDER BY kcu.CONSTRAINT_NAME
            `, [DATABASE]);
            expect(relationships).toEqual([
                { CONSTRAINT_NAME: 'fk_orders_customer', DELETE_RULE: 'RESTRICT' },
                { CONSTRAINT_NAME: 'fk_orders_order_type', DELETE_RULE: 'RESTRICT' },
                { CONSTRAINT_NAME: 'fk_orders_table', DELETE_RULE: 'RESTRICT' },
                { CONSTRAINT_NAME: 'fk_orders_waiter', DELETE_RULE: 'RESTRICT' },
            ]);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('retires only the legacy permission columns while preserving users and grants', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`ALTER TABLE users ${LEGACY_PERMISSION_COLUMNS.map((column) => `ADD COLUMN IF NOT EXISTS ${column} TINYINT(1) NOT NULL DEFAULT 0`).join(', ')}`);
            await admin.query(`
                INSERT INTO users (id, user_number, name, role, allowed_sections, xyz, admin_pin, is_active)
                VALUES (1, 'legacy-permission-user', 'Permission User', 'cashier', '1,2', 1, 'pin-hash', 1);
                INSERT INTO permissions (perm_key, label, label_ar, category, implemented, default_cashier, overridable)
                VALUES ('orders.view', 'View Orders', 'عرض الطلبات', 'orders', 1, 0, 1);
                INSERT INTO user_permissions (user_id, perm_key) VALUES (1, 'orders.view');
                UPDATE users SET can_view_orders=1, can_apply_discount=1, can_split_bills=1 WHERE id=1;
            `);
            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.filter(({ name }) => name !== LEGACY_PERMISSION_NAME && name !== REFUND_STATUS_NAME && name !== ORDER_REFERENCE_INDEX_NAME && name !== HELD_ORDER_LIFECYCLE_NAME);
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${prior.map(() => '(?, ?)').join(', ')}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );
            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME],
                skipped: prior.map(({ name }) => name),
            });
            const [columns] = await pool.query(`
                SELECT COLUMN_NAME
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME IN (${LEGACY_PERMISSION_COLUMNS.map(() => '?').join(', ')})
                ORDER BY COLUMN_NAME
            `, [DATABASE, ...LEGACY_PERMISSION_COLUMNS]);
            expect(columns).toHaveLength(0);
            const [[user]] = await pool.query('SELECT user_number, name, role, allowed_sections, xyz, admin_pin, is_active FROM users WHERE id=1');
            expect(user).toEqual({
                user_number: 'legacy-permission-user',
                name: 'Permission User',
                role: 'cashier',
                allowed_sections: '1,2',
                xyz: 1,
                admin_pin: 'pin-hash',
                is_active: 1,
            });
            const [grants] = await pool.query('SELECT user_id, perm_key FROM user_permissions WHERE user_id=1');
            expect(grants).toEqual([{ user_id: 1, perm_key: 'orders.view' }]);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('repairs a ledger-complete import with missing named constraints and table options', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`
                INSERT INTO settings (setting_key, setting_value) VALUES
                  ('tax_registration_type','sales_tax'),
                  ('jofotara_sales_tax_client_id',''),
                  ('jofotara_sales_tax_secret_key',''),
                  ('jofotara_sales_tax_income_source_sequence',''),
                  ('jofotara_sales_tax_seller_tax_number',''),
                  ('jofotara_sales_tax_seller_registered_name',''),
                  ('jofotara_income_tax_client_id',''),
                  ('jofotara_income_tax_secret_key',''),
                  ('jofotara_income_tax_income_source_sequence',''),
                  ('jofotara_income_tax_seller_tax_number',''),
                  ('jofotara_income_tax_seller_registered_name',''),
                  ('jofotara_auto_submit','0'),
                  ('jofotara_auto_submit_since',''),
                  ('service_charge_jofotara_tax_category','O');
                INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
                VALUES
                  ('pos.subscriptions','Manage Subscriptions','إدارة الاشتراكات','Sell subscriptions and redeem customer meals.','بيع الاشتراكات وصرف وجبات العملاء.','pos',98,1,0,1),
                  ('pos.subscription_credit','Issue Subscription Credit','منح اشتراك آجل','Issue a subscription as a receivable invoice.','منح اشتراك كفاتورة ذمم آجلة.','pos',99,1,0,1),
                  ('pos.tax_exempt','Tax Exempt','إعفاء ضريبي','Apply tax exemption to the current unpaid check.','تطبيق tax exemption.','pos',100,1,0,0);
                INSERT INTO print_templates (document_type) VALUES ('receipt'), ('kitchen');
            `);

            await admin.query('SET FOREIGN_KEY_CHECKS=0');
            await admin.query(`
                ALTER TABLE product_bundle_items
                  DROP FOREIGN KEY fk_pbi_bundle,
                  DROP FOREIGN KEY fk_pbi_product;
                ALTER TABLE product_price_overrides
                  DROP FOREIGN KEY fk_product_price_overrides_root,
                  DROP FOREIGN KEY fk_product_price_overrides_product;
                ALTER TABLE subscription_plans
                  DROP FOREIGN KEY fk_subscription_plans_sale_product,
                  DROP FOREIGN KEY fk_subscription_plans_created_by;
                ALTER TABLE subscription_plan_products
                  DROP FOREIGN KEY fk_subscription_plan_products_plan,
                  DROP FOREIGN KEY fk_subscription_plan_products_product;
                ALTER TABLE subscription_extensions
                  DROP FOREIGN KEY fk_subscription_extensions_subscription,
                  DROP FOREIGN KEY fk_subscription_extensions_extended_by;
                ALTER TABLE subscription_redemptions
                  DROP FOREIGN KEY fk_subscription_redemptions_subscription,
                  DROP FOREIGN KEY fk_subscription_redemptions_redeemed_by,
                  DROP FOREIGN KEY fk_subscription_redemptions_shift,
                  DROP FOREIGN KEY fk_subscription_redemptions_reversed_by;
                ALTER TABLE subscription_redemption_items
                  DROP FOREIGN KEY fk_subscription_redemption_items_redemption,
                  DROP FOREIGN KEY fk_subscription_redemption_items_product;
                ALTER TABLE held_orders
                  DROP FOREIGN KEY fk_held_orders_parent_invoice,
                  DROP FOREIGN KEY fk_held_orders_split_table;
                ALTER TABLE print_templates
                  DROP FOREIGN KEY fk_print_templates_active_revision,
                  DROP FOREIGN KEY fk_print_templates_draft_revision;
                ALTER TABLE print_template_revisions
                  DROP FOREIGN KEY fk_print_template_revisions_template,
                  DROP FOREIGN KEY fk_print_template_revisions_creator;
                ALTER TABLE print_template_revision_tests
                  DROP FOREIGN KEY fk_print_template_tests_revision,
                  DROP FOREIGN KEY fk_print_template_tests_printer,
                  DROP FOREIGN KEY fk_print_template_tests_queue,
                  DROP FOREIGN KEY fk_print_template_tests_confirmer;
                ALTER TABLE subscription_collections
                  DROP FOREIGN KEY fk_subscription_collections_subscription,
                  DROP FOREIGN KEY fk_subscription_collections_shift,
                  DROP FOREIGN KEY fk_subscription_collections_user,
                  DROP FOREIGN KEY fk_subscription_collections_reversal;
                ALTER TABLE orders
                  DROP CONSTRAINT chk_orders_receivable_terms,
                  DEFAULT CHARACTER SET latin1 COLLATE latin1_swedish_ci;
                ALTER TABLE print_templates
                  ENGINE=MyISAM,
                  DEFAULT CHARACTER SET latin1 COLLATE latin1_swedish_ci;
                ALTER TABLE print_template_revisions
                  ENGINE=MyISAM,
                  DEFAULT CHARACTER SET latin1 COLLATE latin1_swedish_ci;
                ALTER TABLE print_template_revision_tests
                  ENGINE=MyISAM,
                  DEFAULT CHARACTER SET latin1 COLLATE latin1_swedish_ci;
                ALTER TABLE products DROP CONSTRAINT chk_products_jofotara_tax_category;
                ALTER TABLE order_items DROP CONSTRAINT chk_order_items_jofotara_tax_category;
                ALTER TABLE service_charge_snapshots DROP CONSTRAINT chk_service_charge_snapshots_jofotara_tax_category;
            `);
            await admin.query('SET FOREIGN_KEY_CHECKS=1');

            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.slice(0, manifest.migrations.findIndex(({ name }) => name === IMPORTED_SCHEMA_REPAIR_NAME));
            const placeholders = prior.map(() => '(?, ?)').join(', ');
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${placeholders}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: prior.map(({ name }) => name),
            });
            await expect(validateRequiredSchema(pool)).resolves.toBe(true);

            const [[engines]] = await pool.query(`
                SELECT
                  SUM(TABLE_NAME='orders' AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_general_ci') AS orders,
                  SUM(TABLE_NAME IN ('print_templates','print_template_revisions','print_template_revision_tests')
                      AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_general_ci') AS print_templates
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=?
                  AND (TABLE_NAME='orders' OR TABLE_NAME IN ('print_templates','print_template_revisions','print_template_revision_tests'))
            `, [DATABASE]);
            expect(engines).toMatchObject({ orders: '1', print_templates: '3' });

            const [[constraints]] = await pool.query(`
                SELECT
                  SUM(CONSTRAINT_NAME IN (
                    'fk_pbi_bundle','fk_pbi_product','fk_product_price_overrides_root','fk_product_price_overrides_product',
                    'fk_subscription_plans_sale_product','fk_subscription_plans_created_by',
                    'fk_subscription_plan_products_plan','fk_subscription_plan_products_product',
                    'fk_subscription_extensions_subscription','fk_subscription_extensions_extended_by',
                    'fk_subscription_redemptions_subscription','fk_subscription_redemptions_redeemed_by',
                    'fk_subscription_redemptions_shift','fk_subscription_redemptions_reversed_by',
                    'fk_subscription_redemption_items_redemption','fk_subscription_redemption_items_product',
                    'fk_held_orders_parent_invoice','fk_held_orders_split_table',
                    'fk_print_templates_active_revision','fk_print_templates_draft_revision',
                    'fk_print_template_revisions_template','fk_print_template_revisions_creator',
                    'fk_print_template_tests_revision','fk_print_template_tests_printer',
                    'fk_print_template_tests_queue','fk_print_template_tests_confirmer',
                    'fk_subscription_collections_subscription','fk_subscription_collections_shift',
                    'fk_subscription_collections_user','fk_subscription_collections_reversal'
                  )) AS foreign_keys
                FROM information_schema.KEY_COLUMN_USAGE
                WHERE CONSTRAINT_SCHEMA=?
            `, [DATABASE]);
            expect(Number(constraints.foreign_keys)).toBe(14);

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: [...prior.map(({ name }) => name), IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('repairs exactly the nine baseline authority foreign keys on a ledger-complete import', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`
                INSERT INTO settings (setting_key, setting_value) VALUES
                  ('tax_registration_type','sales_tax'),
                  ('jofotara_sales_tax_client_id',''),
                  ('jofotara_sales_tax_secret_key',''),
                  ('jofotara_sales_tax_income_source_sequence',''),
                  ('jofotara_sales_tax_seller_tax_number',''),
                  ('jofotara_sales_tax_seller_registered_name',''),
                  ('jofotara_income_tax_client_id',''),
                  ('jofotara_income_tax_secret_key',''),
                  ('jofotara_income_tax_income_source_sequence',''),
                  ('jofotara_income_tax_seller_tax_number',''),
                  ('jofotara_income_tax_seller_registered_name',''),
                  ('jofotara_auto_submit','0'),
                  ('jofotara_auto_submit_since',''),
                  ('service_charge_jofotara_tax_category','O');
                INSERT INTO permissions (perm_key, label, label_ar, description, description_ar, category, sort_order, implemented, default_cashier, overridable)
                VALUES
                  ('pos.subscriptions','Manage Subscriptions','إدارة الاشتراكات','Sell subscriptions and redeem customer meals.','بيع اشتراكات.','pos',98,1,0,1),
                  ('pos.subscription_credit','Issue Subscription Credit','منح اشتراك آجل','Issue a subscription as a receivable invoice.','منح اشتراك.','pos',99,1,0,1),
                  ('pos.tax_exempt','Tax Exempt','إعفاء ضريبي','Apply tax exemption to the current unpaid table.','تطبيق إعفاء.','pos',100,1,0,0);
                INSERT INTO print_templates (document_type) VALUES ('receipt'), ('kitchen');
            `);

            await admin.query('SET FOREIGN_KEY_CHECKS=0');
            await admin.query(`
                ALTER TABLE user_permissions
                  DROP FOREIGN KEY fk_uperm_user,
                  DROP FOREIGN KEY fk_uperm_perm;
                ALTER TABLE restaurant_tables
                  DROP FOREIGN KEY fk_parent_table,
                  DROP FOREIGN KEY restaurant_tables_ibfk_1;
                ALTER TABLE shifts DROP FOREIGN KEY shifts_ibfk_1;
                ALTER TABLE order_items
                  DROP FOREIGN KEY order_items_ibfk_1,
                  DROP FOREIGN KEY order_items_ibfk_2;
                ALTER TABLE refund_items DROP FOREIGN KEY fk_refund_items_refund;
                ALTER TABLE qr_table_drafts DROP FOREIGN KEY qr_table_drafts_ibfk_1;
            `);
            await admin.query('SET FOREIGN_KEY_CHECKS=1');

            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.slice(0, manifest.migrations.findIndex(({ name }) => name === BASELINE_AUTHORITY_NAME));
            const placeholders = prior.map(() => '(?, ?)').join(', ');
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${placeholders}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: prior.map(({ name }) => name),
            });

            const [relationships] = await pool.query(`
                SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_NAME, kcu.COLUMN_NAME,
                       kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                       rc.DELETE_RULE
                FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                 AND rc.TABLE_NAME = kcu.TABLE_NAME
                 AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=?
                  AND kcu.CONSTRAINT_NAME IN (${BASELINE_AUTHORITY_RELATIONSHIPS.map(() => '?').join(', ')})
                ORDER BY kcu.CONSTRAINT_NAME
            `, [DATABASE, ...BASELINE_AUTHORITY_RELATIONSHIPS.map(({ CONSTRAINT_NAME }) => CONSTRAINT_NAME)]);
            expect(relationships).toHaveLength(BASELINE_AUTHORITY_RELATIONSHIPS.length);
            expect(relationships).toEqual(BASELINE_AUTHORITY_RELATIONSHIPS.slice().sort((a, b) => a.CONSTRAINT_NAME.localeCompare(b.CONSTRAINT_NAME)));
            await expect(validateRequiredSchema(pool)).resolves.toBe(true);

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: [...prior.map(({ name }) => name), BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
            });
            await expect(runPendingMigrations(pool, { includeRepeatable: true })).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
            const [afterRepeatable] = await pool.query(`
                SELECT kcu.CONSTRAINT_NAME, kcu.TABLE_NAME, kcu.COLUMN_NAME,
                       kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
                       rc.DELETE_RULE
                FROM information_schema.KEY_COLUMN_USAGE kcu
                JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                 AND rc.TABLE_NAME = kcu.TABLE_NAME
                 AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                WHERE kcu.CONSTRAINT_SCHEMA=?
                  AND kcu.CONSTRAINT_NAME IN (${BASELINE_AUTHORITY_RELATIONSHIPS.map(() => '?').join(', ')})
                ORDER BY kcu.CONSTRAINT_NAME
            `, [DATABASE, ...BASELINE_AUTHORITY_RELATIONSHIPS.map(({ CONSTRAINT_NAME }) => CONSTRAINT_NAME)]);
            expect(afterRepeatable).toEqual(relationships);
            await expect(validateRequiredSchema(pool)).resolves.toBe(true);
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('reruns the 8/1 reconciliation with already-present named platform and print foreign keys', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);

            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${manifest.migrations.filter(({ name }) => name !== SUBSCRIPTION_RETIREMENT_NAME).map(() => '(?, ?)').join(', ')}`,
                manifest.migrations.filter(({ name }) => name !== SUBSCRIPTION_RETIREMENT_NAME).flatMap(({ name, checksum }) => [name, checksum])
            );
            const expectedForeignKeys = [
                'fk_print_templates_active_revision',
                'fk_print_templates_draft_revision',
                'fk_platform_remittances_user',
                'fk_platform_remittances_reversal',
                'fk_platform_remittance_lines_remittance',
                'fk_platform_remittance_lines_order',
                'fk_platform_remittance_adjustments_remittance',
            ];
            const [[before]] = await admin.query(`
                SELECT COUNT(DISTINCT CONSTRAINT_NAME) AS foreign_keys
                FROM information_schema.KEY_COLUMN_USAGE
                WHERE CONSTRAINT_SCHEMA=? AND CONSTRAINT_NAME IN (${expectedForeignKeys.map(() => '?').join(', ')})
            `, [DATABASE, ...expectedForeignKeys]);
            expect(Number(before.foreign_keys)).toBe(expectedForeignKeys.length);

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });
            const repeatable = new Set([REPAIR_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME]);
            await expect(runPendingMigrations(pool, { includeRepeatable: true })).resolves.toEqual({
                applied: [REPAIR_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, SUBSCRIPTION_RETIREMENT_NAME],
                skipped: manifest.migrations.filter(({ name }) => !repeatable.has(name) && name !== SUBSCRIPTION_RETIREMENT_NAME).map(({ name }) => name),
            });
            const [[after]] = await admin.query(`
                SELECT COUNT(DISTINCT CONSTRAINT_NAME) AS foreign_keys
                FROM information_schema.KEY_COLUMN_USAGE
                WHERE CONSTRAINT_SCHEMA=? AND CONSTRAINT_NAME IN (${expectedForeignKeys.map(() => '?').join(', ')})
            `, [DATABASE, ...expectedForeignKeys]);
            expect(Number(after.foreign_keys)).toBe(expectedForeignKeys.length);
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('backfills only legacy special-source buyers and preserves frozen snapshots on reapply', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            const baseline = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8');
            await admin.query(baseline);
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`
                ALTER TABLE orders
                  DROP CONSTRAINT chk_orders_receivable_terms,
                  ADD CONSTRAINT chk_orders_receivable_terms CHECK (
                    (payment_method='receivable'
                      AND payment_due_on IS NOT NULL
                      AND CHAR_LENGTH(TRIM(receivable_reason)) > 0
                      AND CHAR_LENGTH(TRIM(buyer_name_at_sale)) > 0
                      AND COALESCE(cash_amount,0)=0 AND COALESCE(card_amount,0)=0
                      AND COALESCE(amount_tendered,0)=0 AND COALESCE(change_due,0)=0)
                    OR
                    (payment_method<>'receivable'
                      AND payment_due_on IS NULL
                      AND receivable_reason IS NULL
                      AND buyer_name_at_sale IS NULL
                      AND buyer_phone_at_sale IS NULL
                      AND buyer_address_at_sale IS NULL)
                  )
            `);
            await admin.query("INSERT INTO users (id, user_number, name, role) VALUES (1, 'migration-user', 'Migration User', 'admin')");
            await admin.query(`
                INSERT INTO customers (id, phone, name, address) VALUES
                  (1, '0791000001', 'Subscription Buyer', 'Subscription Address'),
                  (2, '0791000002', 'Platform Buyer', 'Platform Address'),
                  (3, '0791000003', 'Ordinary Buyer', 'Ordinary Address')
            `);
            await admin.query("INSERT INTO products (id, name, price) VALUES (1, 'Migration Plan Product', 10)");
            await admin.query("INSERT INTO subscription_plans (id, sale_product_id, included_credits, duration_days) VALUES (1, 1, 1, 30)");
            await admin.query(`
                INSERT INTO orders
                  (invoice_id, user_id, customer_id, subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount, change_due)
                VALUES
                  (1, 1, 1, 10, 0, 10, 'cash', 10, 10, 0, 0),
                  (2, 1, 2, 20, 0, 20, 'platform', 0, 0, 0, 0),
                  (3, 1, 3, 30, 0, 30, 'cash', 30, 30, 0, 0)
            `);
            await admin.query(`
                INSERT INTO customer_subscriptions
                  (customer_id, plan_id, purchase_invoice_id, starts_on, ends_on, total_credits, status, created_by)
                VALUES (1, 1, 1, '2026-08-01', '2026-08-31', 1, 'active', 1)
            `);
            await admin.query(`
                INSERT INTO schema_migrations (migration_name, checksum) VALUES
                  (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)
            `, [
                RECEIVABLE_NAME, RECEIVABLE_CHECKSUM,
                PLATFORM_NAME, PLATFORM_CHECKSUM,
                TAX_NAME, TAX_CHECKSUM,
                REPAIR_NAME, '5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679',
                PROVIDER_NAME, PROVIDER_CHECKSUM,
                TAX_CATEGORY_NAME, TAX_CATEGORY_CHECKSUM,
            ]);

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPreRetirementMigrations(pool)).resolves.toEqual({
                applied: [SPECIAL_SOURCE_NAME, SERVICE_CHARGE_CATEGORY_NAME, SETTINGS_VALUE_CAPACITY_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME],
                skipped: [PLATFORM_NAME, TAX_NAME, REPAIR_NAME, PROVIDER_NAME, TAX_CATEGORY_NAME],
            });
            const [backfilled] = await pool.query(`
                SELECT invoice_id, buyer_name_at_sale, buyer_phone_at_sale, buyer_address_at_sale
                FROM orders ORDER BY invoice_id
            `);
            expect(backfilled).toEqual([
                { invoice_id: 1, buyer_name_at_sale: 'Subscription Buyer', buyer_phone_at_sale: '0791000001', buyer_address_at_sale: 'Subscription Address' },
                { invoice_id: 2, buyer_name_at_sale: 'Platform Buyer', buyer_phone_at_sale: '0791000002', buyer_address_at_sale: 'Platform Address' },
                { invoice_id: 3, buyer_name_at_sale: null, buyer_phone_at_sale: null, buyer_address_at_sale: null },
            ]);

            await pool.query("UPDATE orders SET buyer_name_at_sale='Frozen Platform Buyer' WHERE invoice_id=2");
            await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [SPECIAL_SOURCE_NAME]);
            await expect(runPreRetirementMigrations(pool)).resolves.toEqual({
                applied: [SPECIAL_SOURCE_NAME],
                skipped: [PLATFORM_NAME, TAX_NAME, REPAIR_NAME, PROVIDER_NAME, TAX_CATEGORY_NAME, SERVICE_CHARGE_CATEGORY_NAME, SETTINGS_VALUE_CAPACITY_NAME, IMPORTED_SCHEMA_REPAIR_NAME, BASELINE_AUTHORITY_NAME, ORDER_REFERENCE_NAME, LEGACY_PERMISSION_NAME, REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME],
            });
            const [[preserved]] = await pool.query(
                'SELECT buyer_name_at_sale, buyer_phone_at_sale, buyer_address_at_sale FROM orders WHERE invoice_id=2'
            );
            expect(preserved).toEqual({
                buyer_name_at_sale: 'Frozen Platform Buyer',
                buyer_phone_at_sale: '0791000002',
                buyer_address_at_sale: 'Platform Address',
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('converges MariaDB implicit foreign-key indexes to canonical baseline names', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`
                ALTER TABLE orders DROP FOREIGN KEY fk_orders_waiter;
                ALTER TABLE orders DROP FOREIGN KEY fk_orders_order_type;
                ALTER TABLE orders DROP INDEX idx_orders_waiter_id;
                ALTER TABLE orders DROP INDEX idx_orders_order_type_id;
                ALTER TABLE orders ADD CONSTRAINT fk_orders_waiter FOREIGN KEY (waiter_id) REFERENCES users(id) ON DELETE RESTRICT;
                ALTER TABLE orders ADD CONSTRAINT fk_orders_order_type FOREIGN KEY (order_type_id) REFERENCES order_types(id) ON DELETE RESTRICT;
            `);

            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.slice(0, manifest.migrations.findIndex(({ name }) => name === ORDER_REFERENCE_INDEX_NAME));
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${prior.map(() => '(?, ?)').join(', ')}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );
            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: prior.map(({ name }) => name),
            });
            const [indexes] = await pool.query(`
                SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_in_order
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders'
                   AND INDEX_NAME IN ('idx_orders_waiter_id','idx_orders_order_type_id','fk_orders_waiter','fk_orders_order_type')
                 GROUP BY INDEX_NAME ORDER BY INDEX_NAME
            `);
            expect(indexes).toEqual([
                { INDEX_NAME: 'idx_orders_order_type_id', columns_in_order: 'order_type_id' },
                { INDEX_NAME: 'idx_orders_waiter_id', columns_in_order: 'waiter_id' },
            ]);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('applies the receipt-display snapshot after the exact call-center predecessor without changing historical money', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
        const receiptIndex = manifest.migrations.findIndex(({ name }) => name === RECEIPT_TAX_DISPLAY_NAME);
        expect(receiptIndex).toBeGreaterThanOrEqual(0);
        expect(manifest.migrations[receiptIndex]).toMatchObject({
            name: RECEIPT_TAX_DISPLAY_NAME,
            checksum: RECEIPT_TAX_DISPLAY_CHECKSUM,
            requires: { name: CALL_CENTER_NAME, checksum: CALL_CENTER_CHECKSUM },
        });
        const prior = manifest.migrations.slice(0, receiptIndex);
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            const [[column]] = await admin.query(`
                SELECT COUNT(*) AS count
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=? AND TABLE_NAME='orders' AND COLUMN_NAME='receipt_tax_inclusive_at_sale'
            `, [DATABASE]);
            if (Number(column.count) === 1) {
                await admin.query('ALTER TABLE orders DROP COLUMN receipt_tax_inclusive_at_sale');
            }
            await admin.query(`
                INSERT INTO users (id, user_number, name, role, is_active)
                VALUES (1, 'receipt-tax-migration-user', 'Receipt Tax Migration User', 'admin', 1);
                INSERT INTO orders
                    (invoice_id, user_id, subtotal, tax, tax_inclusive_at_sale, total, payment_method)
                VALUES (1, 1, 10.00, 1.60, 1, 11.60, 'cash');
            `);
            const [[before]] = await admin.query(
                'SELECT subtotal, tax, tax_inclusive_at_sale, total, payment_method FROM orders WHERE invoice_id=1'
            );
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${prior.map(() => '(?, ?)').join(', ')}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );
            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: prior.map(({ name }) => name),
            });
            const [[after]] = await pool.query(
                'SELECT subtotal, tax, tax_inclusive_at_sale, total, payment_method, receipt_tax_inclusive_at_sale FROM orders WHERE invoice_id=1'
            );
            expect(after).toEqual({ ...before, receipt_tax_inclusive_at_sale: null });
            const [[ledger]] = await pool.query(
                'SELECT migration_name, checksum FROM schema_migrations WHERE migration_name=?',
                [RECEIPT_TAX_DISPLAY_NAME]
            );
            expect(ledger).toEqual({ migration_name: RECEIPT_TAX_DISPLAY_NAME, checksum: RECEIPT_TAX_DISPLAY_CHECKSUM });
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('reconciles refund caches from paid and open-table evidence without changing refund rows', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query(`
                INSERT INTO users (id, user_number, name, role)
                VALUES (1, 'refund-migration-user', 'Refund Migration User', 'admin');
                INSERT INTO orders
                    (invoice_id, invoice_number, user_id, subtotal, tax, total, payment_method, refund_status)
                VALUES
                    (1, 1001, 1, 10, 0, 10, 'cash', 'full'),
                    (2, 1002, 1, 20, 0, 20, 'cash', 'none'),
                    (3, 1003, 1, 20, 0, 20, 'cash', 'none'),
                    (4, 1004, 1, 20, 0, 20, 'unpaid_table', 'full'),
                    (5, 1005, 1, 20, 0, 20, 'voided', 'none');
                INSERT INTO order_items (id, invoice_id, item_name, quantity, price_at_sale)
                VALUES
                    (101, 1, 'No refund', 1, 10),
                    (201, 2, 'Partial paid', 2, 10),
                    (301, 3, 'Full paid', 1, 20),
                    (401, 4, 'Partial table void', 2, 10),
                    (501, 5, 'Full table void', 1, 20);
                INSERT INTO refunds
                    (id, kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, user_id)
                VALUES
                    (1, 'refund', 2, 'item', 10, 0, 10, 1),
                    (2, 'refund', 3, 'order', 20, 0, 20, 1),
                    (3, 'void', 4, 'item', 10, 0, 0, 1),
                    (4, 'void', 5, 'order', 20, 0, 0, 1);
                INSERT INTO refund_items
                    (id, refund_id, order_item_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
                VALUES
                    (1, 1, 201, 'Partial paid', 1, 10, 10, 0, 10),
                    (2, 2, 301, 'Full paid', 1, 20, 20, 0, 20),
                    (3, 3, 401, 'Partial table void', 1, 10, 10, 0, 10),
                    (4, 4, 501, 'Full table void', 1, 20, 20, 0, 20);
            `);

            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.slice(0, manifest.migrations.findIndex(({ name }) => name === REFUND_STATUS_NAME));
            await admin.query(
                'INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)',
                [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]
            );
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${prior.map(() => '(?, ?)').join(', ')}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            const [refundRowsBefore] = await pool.query(
                'SELECT id, invoice_id, kind, amount_refunded FROM refunds ORDER BY id'
            );
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: prior.map(({ name }) => name),
            });
            const [statuses] = await pool.query(
                'SELECT invoice_id, refund_status FROM orders ORDER BY invoice_id'
            );
            expect(statuses).toEqual([
                { invoice_id: 1, refund_status: 'none' },
                { invoice_id: 2, refund_status: 'partial' },
                { invoice_id: 3, refund_status: 'full' },
                { invoice_id: 4, refund_status: 'partial' },
                { invoice_id: 5, refund_status: 'full' },
            ]);
            const [refundRowsAfter] = await pool.query(
                'SELECT id, invoice_id, kind, amount_refunded FROM refunds ORDER BY id'
            );
            expect(refundRowsAfter).toEqual(refundRowsBefore);

            await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME]);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [REFUND_STATUS_NAME, ORDER_REFERENCE_INDEX_NAME, HELD_ORDER_LIFECYCLE_NAME, CALL_CENTER_NAME, RECEIPT_TAX_DISPLAY_NAME, SPLIT_QUANTITY_NAME, WEBAUTHN_NAME, SPOOLER_V2_NAME, AUDIT_BROWSER_PREVIEW_NAME, JOFOTARA_STALE_INDEX_NAME],
                skipped: [...prior.map(({ name }) => name), POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
            });
            const [statusesAfterRetry] = await pool.query(
                'SELECT invoice_id, refund_status FROM orders ORDER BY invoice_id'
            );
            expect(statusesAfterRetry).toEqual(statuses);
            const [refundRowsAfterRetry] = await pool.query(
                'SELECT id, invoice_id, kind, amount_refunded FROM refunds ORDER BY id'
            );
            expect(refundRowsAfterRetry).toEqual(refundRowsBefore);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });

    it('applies the JoFotara stale index once and rejects a conflicting named shape', async () => {
        if (DATABASE !== 'posapp_auto_migration_test') throw new Error('Refusing to use an unexpected scratch database.');
        const admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        let pool;
        try {
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
            await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await admin.query(`USE \`${DATABASE}\``);
            await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));
            await loadHistoricalSubscriptionSchema(admin);
            await admin.query('ALTER TABLE jofotara_documents DROP INDEX idx_jofotara_status_attempt');

            const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
            const prior = manifest.migrations.slice(0, manifest.migrations.findIndex(({ name }) => name === JOFOTARA_STALE_INDEX_NAME));
            await admin.query('INSERT INTO schema_migrations (migration_name, checksum) VALUES (?, ?)', [RECEIVABLE_NAME, RECEIVABLE_CHECKSUM]);
            await admin.query(
                `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${prior.map(() => '(?, ?)').join(', ')}`,
                prior.flatMap(({ name, checksum }) => [name, checksum])
            );

            pool = mysql.createPool({
                host: process.env.DB_HOST || '127.0.0.1',
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '',
                database: DATABASE,
                port: Number(process.env.DB_PORT || 3306),
                connectionLimit: 2,
            });

            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [JOFOTARA_STALE_INDEX_NAME, POS_ORDER_HISTORY_NAME, PRODUCT_PRICE_OVERRIDE_LOCK_NAME, FRACTIONAL_STOCK_NAME, EXPENSE_ZERO_NAME, Y_ORDER_TYPE_NAME, RECIPE_LEDGER_NAME, RECIPE_PERFORMANCE_NAME, INGREDIENT_ANALYSIS_NAME, STOCK_ADJUSTMENT_NAME, STOCK_CORE_NAME, STOCK_SNAPSHOT_NAME, STOCK_READ_INDEX_NAME, STOCK_REPORT_GENERATIONS_NAME, STOCK_REPORT_FACTS_NAME, STOCK_AVAILABILITY_NAME, STOCK_INGREDIENT_CUTOVER_NAME, STOCK_ITEM_PROJECTIONS_NAME, STOCK_REPORT_REBUILD_NAME, STOCK_RESOLVED_LINKS_NAME, STOCK_REPORT_BACKFILL_NAME, STOCK_REPORT_COUNTS_NAME, INGREDIENT_WORKING_BALANCES_NAME, STOCK_REPORT_DAILY_NAME, STOCK_PROCUREMENT_NAME, PROCUREMENT_INTEGRITY_NAME, HELD_NUMBER_NAME, TYPE_NUMBER_NAME, STOCK_IDENTITY_NAME, INGREDIENT_STATE_NAME, UNIFIED_MOVEMENTS_NAME, HELD_DATE_INDEX_NAME, TABLE_ACTION_RECOVERY_NAME, PAID_SPLIT_INDEX_NAME, TABLE_SEATING_NAME, DELETED_ITEMS_NAME, PERMISSION_CATALOG_NAME, TABLE_ACCESS_SCOPE_NAME, PERMISSION_CATALOG_V2_NAME, PRINT_QUEUE_TIMINGS_NAME, CUSTOMER_PHONE_INDEX_NAME, ORDER_INTAKE_REQUESTS_NAME, CUSTOMER_INFO_NAME, SUBSCRIPTION_RETIREMENT_NAME, EXPENSE_REQUEST_NAME, PRINTER_LAST_PRINTED_NAME, MULTI_TERMINAL_NAME, PURCHASE_INVOICES_NAME, RETIRE_PURCHASING_NAME, STOCK_DOCUMENTS_NAME, PURCHASE_ITEM_KIND_NAME, PRODUCT_BARCODES_NAME],
                skipped: prior.map(({ name }) => name),
            });
            const [indexRows] = await pool.query(`
                SELECT COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
                  FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME='jofotara_documents'
                   AND INDEX_NAME='idx_jofotara_status_attempt'
                 ORDER BY SEQ_IN_INDEX
            `, [DATABASE]);
            expect(indexRows).toEqual([
                { COLUMN_NAME: 'status', SEQ_IN_INDEX: 1, NON_UNIQUE: 1 },
                { COLUMN_NAME: 'last_attempt_at', SEQ_IN_INDEX: 2, NON_UNIQUE: 1 },
            ]);
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [],
                skipped: manifest.migrations.map(({ name }) => name),
            });

            await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [JOFOTARA_STALE_INDEX_NAME]);
            await pool.query('ALTER TABLE jofotara_documents DROP INDEX idx_jofotara_status_attempt');
            await pool.query('ALTER TABLE jofotara_documents ADD INDEX idx_jofotara_status_attempt(last_attempt_at, status)');
            await expect(runPendingMigrations(pool)).rejects.toThrow(
                `Migration ${JOFOTARA_STALE_INDEX_NAME} preflight rejected the current schema.`
            );
        } finally {
            await pool?.end().catch(() => {});
            await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
            await admin.end();
        }
    });
});
