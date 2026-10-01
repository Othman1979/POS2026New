import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');

const BASE_NAME = '2026-07-31-platform-held-order-settlement-v1';
const BASE_CHECKSUM = 'b'.repeat(64);
const TARGET_NAME = '2026-07-31-tax-exempt-checks-v1';
const TARGET_CHECKSUM = 'c'.repeat(64);
const REPAIR_NAME = '2026-08-01-additive-schema-reconciliation-v1';
const REPAIR_CHECKSUM = '5c1f6f37dca58f4f292aa699394e4ad7f420ba57c7f6a1992bd4400429a27679';
const PLATFORM_RECONCILIATION_NAME = '2026-08-03-platform-provider-reconciliation-v1';
const PLATFORM_RECONCILIATION_CHECKSUM = '21d0fb62426802c01d26b36de0a54055f32c747ed918468a0dde6deaf02df999';
const JOFOTARA_TAX_CATEGORIES_NAME = '2026-08-04-jofotara-tax-categories-v1';
const JOFOTARA_TAX_CATEGORIES_CHECKSUM = 'dd55b0f292733138e08bea56cb3821d7b58aae9c549dcc984c991eae70257d41';
const SPECIAL_SOURCE_BUYER_SNAPSHOTS_NAME = '2026-08-04-special-source-buyer-snapshots-v1';
const SPECIAL_SOURCE_BUYER_SNAPSHOTS_CHECKSUM = '084c3b93e1ac260226c5297f067d01859148844450a9197046ffff5d6ca9b244';
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
const ORDER_REFERENCE_INDEX_CHECKSUM = '8e24a2088f8bf6aa0078954a6db5c4e4adb0140a69a523339b5ae20ebc0c951d';
const HELD_ORDER_LIFECYCLE_NAME = '2026-08-10-held-order-lifecycle-v1';
const HELD_ORDER_LIFECYCLE_CHECKSUM = 'af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160';
const CALL_CENTER_NAME = '2026-08-10-call-center-held-orders-v1';
const CALL_CENTER_CHECKSUM = 'f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b';
const CALL_CENTER_SQL_SHA = 'f1b384472c35fc84e30d7c970582cef03964a51773e7ea61c658bd77829121bc';
const RECEIPT_TAX_DISPLAY_NAME = '2026-08-11-receipt-tax-display-v1';
const RECEIPT_TAX_DISPLAY_CHECKSUM = '90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3';
const RECEIPT_TAX_DISPLAY_SQL_SHA = '8871974f40069bca8cdb92f6bc5a986578c365fec505d9cc67efa4528836d794';
const SPLIT_QUANTITY_PRECISION_NAME = '2026-08-13-split-quantity-precision-v1';
const LEGACY_PERMISSION_COLUMNS = [
    'can_view_orders', 'canholdorders', 'can_update_table', 'can_apply_discount', 'can_void_items',
    'can_open_register', 'can_checkout_tables', 'bypass_existing_tables', 'bypass_printed_tables',
    'can_view_order_history', 'can_transfer_table', 'can_join_tables', 'can_split_bills',
    'waiter_split_bill', 'can_print_check'
];
const BASELINE_AUTHORITY_FOREIGN_KEYS = [
    ['fk_uperm_user', 'user_permissions', 'user_id', 'users', 'id', 'CASCADE'],
    ['fk_uperm_perm', 'user_permissions', 'perm_key', 'permissions', 'perm_key', 'CASCADE'],
    ['fk_parent_table', 'restaurant_tables', 'parent_table_id', 'restaurant_tables', 'id', 'SET NULL'],
    ['restaurant_tables_ibfk_1', 'restaurant_tables', 'section_id', 'sections', 'id', 'RESTRICT'],
    ['shifts_ibfk_1', 'shifts', 'user_id', 'users', 'id', 'RESTRICT'],
    ['order_items_ibfk_1', 'order_items', 'invoice_id', 'orders', 'invoice_id', 'CASCADE'],
    ['order_items_ibfk_2', 'order_items', 'product_id', 'products', 'id', 'RESTRICT'],
    ['fk_refund_items_refund', 'refund_items', 'refund_id', 'refunds', 'id', 'CASCADE'],
    ['qr_table_drafts_ibfk_1', 'qr_table_drafts', 'table_id', 'restaurant_tables', 'id', 'CASCADE'],
];
const fixtureDirectories = [];

function writeFixture({ sql, migration = {}, file = 'target.sql' } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-auto-migration-'));
    fixtureDirectories.push(directory);
    const sqlText = sql || [
        'SET NAMES utf8mb4;',
        'ALTER TABLE orders',
        '  ADD COLUMN IF NOT EXISTS migration_probe INT NULL;',
        "INSERT INTO schema_migrations (migration_name, checksum) VALUES ('target', 'checksum');",
    ].join('\n');
    const sqlPath = path.join(directory, 'target.sql');
    fs.writeFileSync(sqlPath, sqlText);
    const manifest = {
        migrations: [{
            name: TARGET_NAME,
            checksum: TARGET_CHECKSUM,
            file,
            sha256: crypto.createHash('sha256').update(sqlText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')).digest('hex'),
            requires: { name: BASE_NAME, checksum: BASE_CHECKSUM },
            ...migration,
        }],
    };
    const manifestPath = path.join(directory, 'auto-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    return { manifestPath, sqlText };
}

function fakePool({ ledger = {}, lock = 1, released = 1, ledgerError, statementError, onStatement } = {}) {
    const state = { ...ledger };
    const calls = [];
    const connection = {
        destroy: vi.fn(),
        release: vi.fn(),
        query: vi.fn(async (sql, params = []) => {
            const text = String(sql).trim();
            calls.push({ sql: text, params });
            if (text.includes('GET_LOCK')) return [[{ acquired: lock }]];
            if (text.includes('RELEASE_LOCK')) return [[{ released }]];
            if (text.startsWith('SELECT migration_name, checksum FROM schema_migrations')) {
                if (ledgerError) throw ledgerError;
                return [Object.entries(state).map(([migration_name, checksum]) => ({migration_name, checksum}))];
            }
            if (text.startsWith('SELECT checksum FROM schema_migrations')) {
                if (ledgerError) throw ledgerError;
                return [state[params[0]] ? [{ checksum: state[params[0]] }] : []];
            }
            if (statementError) throw statementError;
            await onStatement?.({ sql: text, state });
            return [[]];
        }),
    };
    return {
        calls,
        connection,
        pool: { getConnection: vi.fn(async () => connection) },
        state,
    };
}

afterEach(() => {
    while (fixtureDirectories.length) {
        fs.rmSync(fixtureDirectories.pop(), { recursive: true, force: true });
    }
});

describe('automatic database migrations', () => {
    it('reads a current migration ledger once while still checking the complete predecessor chain', async () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
        const ledger = Object.fromEntries(manifest.migrations.flatMap(m => [[m.name, m.checksum], [m.requires.name, m.requires.checksum]]));
        const fake = fakePool({ledger});
        const result = await runPendingMigrations(fake.pool);
        expect(result.applied).toEqual([]);
        expect(result.skipped).toHaveLength(manifest.migrations.length);
        expect(fake.calls.filter(call => call.sql.includes('FROM schema_migrations'))).toHaveLength(1);
    });

    it('ships the complete ordered managed migration chain', () => {
        const manifest = JSON.parse(fs.readFileSync(
            path.resolve(__dirname, '../../migrations/auto-manifest.json'),
            'utf8'
        ));

        expect(manifest.migrations.map(({ name }) => name)).toEqual([
            '2026-07-31-platform-held-order-settlement-v1',
            '2026-07-31-tax-exempt-checks-v1',
            REPAIR_NAME,
            '2026-08-03-platform-provider-reconciliation-v1',
            JOFOTARA_TAX_CATEGORIES_NAME,
            SPECIAL_SOURCE_BUYER_SNAPSHOTS_NAME,
            SERVICE_CHARGE_CATEGORY_NAME,
            SETTINGS_VALUE_CAPACITY_NAME,
            IMPORTED_SCHEMA_REPAIR_NAME,
            BASELINE_AUTHORITY_NAME,
            ORDER_REFERENCE_NAME,
            LEGACY_PERMISSION_NAME,
            REFUND_STATUS_NAME,
            ORDER_REFERENCE_INDEX_NAME,
            HELD_ORDER_LIFECYCLE_NAME,
            CALL_CENTER_NAME,
            RECEIPT_TAX_DISPLAY_NAME,
            SPLIT_QUANTITY_PRECISION_NAME,
            '2026-08-13-webauthn-registered-device-access-v1',
            '2026-08-17-spooler-v2-agents-v1',
            '2026-08-23-audit-browser-preview-v1',
            '2026-08-30-jofotara-stale-submission-index-v1',
            '2026-08-31-pos-order-history-default-v1',
            '2026-09-01-product-price-override-lock-v1',
            '2026-09-01-fractional-stock-precision-v1',
            '2026-09-02-expense-zero-amount-v1',
            '2026-09-03-y-order-type-setting-v1',
            '2026-09-05-recipe-ledger-v1',
            '2026-09-06-recipe-ledger-performance-v1',
            '2026-09-07-ingredient-analysis-v1',
            '2026-09-08-stock-adjustments-v1',
            '2026-09-08-stock-ledger-core-v1',
            '2026-09-08-stock-sale-snapshots-v1',
            '2026-09-08-stock-read-index-v1',
            '2026-09-08-stock-report-generations-v1',
            '2026-09-08-stock-report-facts-v1',
            '2026-09-08-stock-availability-policy-v1',
            '2026-09-08-stock-ingredient-cutover-v1',
            '2026-09-08-stock-item-projections-v1',
            '2026-09-08-stock-report-ingredient-rebuild-v1',
            '2026-09-08-stock-resolved-product-links-v1',
            '2026-09-08-stock-report-backfill-v1',
            '2026-09-08-stock-report-count-intervals-v1',
            '2026-09-08-ingredient-working-balances-v1',
            '2026-09-08-stock-report-daily-projection-v1',
            '2026-09-08-stock-procurement-v1',
            '2026-09-08-procurement-request-integrity-v1',
            '2026-09-09-held-order-numbers-v1',
            '2026-09-12-order-type-numbering-v1', '2026-09-12-stock-item-identity-v1', '2026-09-12-ingredient-state-v1', '2026-09-12-unified-stock-movements-v1',
            '2026-09-12-held-report-date-index-v1',
            '2026-09-13-table-action-recovery-v1',
            '2026-09-13-paid-split-parent-index-v1',
            '2026-09-13-table-seating-v1',
            '2026-09-14-deleted-table-items-v1',
            '2026-09-14-permission-catalog-v1',
            '2026-09-14-table-access-scope-v1',
            '2026-09-14-permission-catalog-v2',
            '2026-09-17-print-queue-timings-v1',
            '2026-09-19-customer-phone-index-v1',
            '2026-09-20-order-intake-requests-v1',
            '2026-09-22-product-customer-info-v1',
            '2026-09-23-subscriptions-retirement-v1',
            '2026-09-26-expense-request-id-v1',
            '2026-09-30-printer-last-printed-v1',
            '2026-09-30-multi-terminal-permission-v1',
            '2026-09-30-purchase-invoices-v1',
            '2026-10-01-retire-purchasing-tables-v1',
            '2026-10-01-stock-documents-v1',
            '2026-10-02-purchase-item-kind-v1',
            '2026-10-03-product-barcodes-v1',
        ]);
        expect(manifest.migrations[0].requires).toEqual({
            name: '2026-07-29-subscription-receivables-v1',
            checksum: 'b47d61065204ea3145fc60003d78b3b4aaecf09fc437102aa65983ed59d2f8da',
        });
        expect(manifest.migrations.find(({ name }) => name === REPAIR_NAME)).toMatchObject({
            name: REPAIR_NAME,
            checksum: REPAIR_CHECKSUM,
            file: '2026-08-01-additive-schema-reconciliation.auto.sql',
            repeatable: true,
            requires: {
                name: '2026-07-31-tax-exempt-checks-v1',
                checksum: '6be2b31c8b0bb9ff8c54df9f5f75a7d2d7b6e4ce66a71f7f2e202ba9a6b9e1d3',
            },
        });
    });

    it('ships durable order-intake idempotency with exact hashes and Hostinger fallback parity', () => {
        const name = '2026-09-20-order-intake-requests-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const index = manifest.migrations.findIndex(row => row.name === name);
        const target = manifest.migrations[index];
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        const preflight = read(target.preflight);
        expect(target).toMatchObject({
            name,
            checksum,
            requires: {
                name: '2026-09-19-customer-phone-index-v1',
                checksum: '3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a',
            },
        });
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(crypto.createHash('sha256').update(preflight).digest('hex')).toBe(target.preflightSha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
    });

    it('ships fail-closed subscription retirement with exact hashes and fallback parity', () => {
        const name = '2026-09-23-subscriptions-retirement-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const target = manifest.migrations.find(row => row.name === name);
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        expect(target).toMatchObject({
            name, checksum,
            requires: {
                name: '2026-09-22-product-customer-info-v1',
                checksum: 'e124551d700c0b76f7735f9593507df7647d5f66c36b6834b08459349705dd30'
            }
        });
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(crypto.createHash('sha256').update(read(target.preflight)).digest('hex')).toBe(target.preflightSha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
    });

    it('ships the expense request key with exact hashes and fallback parity', () => {
        const name = '2026-09-26-expense-request-id-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const target = manifest.migrations.find(row => row.name === name);
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        expect(target).toMatchObject({
            name, checksum,
            requires: {
                name: '2026-09-23-subscriptions-retirement-v1',
                checksum: '2133bbc1d19f437389429029dae9909fc5cc325198c64c8e1f3873168e863ebd'
            }
        });
        expect(sql).toContain('UNIQUE KEY IF NOT EXISTS uq_expenses_request (created_by, request_id)');
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
    });

    it('ships the printer last-printed column with exact hashes and fallback parity', () => {
        const name = '2026-09-30-printer-last-printed-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const target = manifest.migrations.find(row => row.name === name);
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        expect(target).toMatchObject({
            name, checksum,
            requires: {
                name: '2026-09-26-expense-request-id-v1',
                checksum: '317d8ee8d1a844e64e347ed07a3f969c69a5d75ae6f43883e841d1ef9d6f6e63'
            }
        });
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS last_printed_at datetime DEFAULT NULL');
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
    });

    it('ships the multi-terminal permission row with exact hashes and fallback parity', () => {
        const name = '2026-09-30-multi-terminal-permission-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const target = manifest.migrations.find(row => row.name === name);
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        expect(target).toMatchObject({
            name, checksum,
            requires: {
                name: '2026-09-30-printer-last-printed-v1',
                checksum: 'c9bf978dcc5e00e2dd6a5f4a09de2ef26347aabeb540a7a9fcfdc9c93a51f031'
            }
        });
        expect(sql).toContain("'auth.multi_terminal'");
        expect(sql).not.toMatch(/user_permissions|\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
    });

    it('ships the purchase invoice tables with exact hashes and fallback parity', () => {
        const name = '2026-09-30-purchase-invoices-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const target = manifest.migrations.find(row => row.name === name);
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        const tables = ['purchase_suppliers', 'purchase_invoices', 'purchase_invoice_lines'];
        expect(target).toMatchObject({
            name, checksum,
            requires: {
                name: '2026-09-30-multi-terminal-permission-v1',
                checksum: '39060fd593fffd1667e754a3a7a1708ad73636faaaf00b50e86ad994bb6df893'
            }
        });
        for (const table of tables) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
        const code = sql.split('\n').filter(line => !line.startsWith('--')).join('\n');
        expect(code).not.toMatch(/stock_suppliers|stock_purchase_|stock_receipts|\bDROP\b|DELETE FROM|\bTRUNCATE\b/i);
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
        const baseline = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8').replace(/\r\n/g, '\n');
        // A fresh install has the final shape: the shared tables, never the retired invoice tables.
        expect(baseline).toContain('CREATE TABLE IF NOT EXISTS purchase_suppliers (');
        expect(baseline).not.toContain('CREATE TABLE IF NOT EXISTS purchase_invoices (');
    });

    it('ships the stock documents migration with exact hashes, ordering and fallback parity', () => {
        const name = '2026-10-01-stock-documents-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const index = manifest.migrations.findIndex(row => row.name === name);
        const target = manifest.migrations[index];
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        expect(target.requires).toEqual({ name: manifest.migrations[index - 1].name, checksum: manifest.migrations[index - 1].checksum });
        expect(target).toMatchObject({ name, checksum, requires: { name: '2026-10-01-retire-purchasing-tables-v1' } });
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(`${name}.sql`)).toBe(sql);
        for (const table of ['stock_documents', 'stock_document_lines']) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
    });

    it('ships the purchase item kind migration with exact hashes, ordering, fallback parity and the baseline shape', () => {
        const name = '2026-10-02-purchase-item-kind-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const index = manifest.migrations.findIndex(row => row.name === name);
        const target = manifest.migrations[index];
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        expect(target.requires).toEqual({ name: manifest.migrations[index - 1].name, checksum: manifest.migrations[index - 1].checksum });
        expect(target).toMatchObject({ name, checksum, requires: { name: '2026-10-01-stock-documents-v1' } });
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
        // A fresh install has the final shape, and the ledger row that says the migration is already applied.
        const baseline = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8').replace(/\r\n/g, '\n');
        const table = baseline.split('CREATE TABLE IF NOT EXISTS stock_documents (')[1].split('CREATE TABLE IF NOT EXISTS stock_document_lines (')[0];
        expect(table).toContain("item_kind ENUM('product','ingredient') NULL,");
        expect(table).toContain('uq_stock_document_supplier_reference (supplier_id, reference, item_kind)');
        expect(table).toContain("doc_type = 'purchase' AND item_kind IS NOT NULL");
        expect(table).toContain("doc_type = 'count' AND item_kind IS NULL");
        const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../../deployment/tools/bootstrap-database.js'), 'utf8');
        expect(bootstrap).toContain(`('${name}','${checksum}')`);
    });

    it('ships the product barcodes migration with exact hashes, ordering, fallback parity and the baseline shape', () => {
        const name = '2026-10-03-product-barcodes-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const index = manifest.migrations.findIndex(row => row.name === name);
        const target = manifest.migrations[index];
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        // The tail of the manifest, right after the purchase item kind migration it builds on.
        expect(index).toBe(manifest.migrations.length - 1);
        expect(target.requires).toEqual({ name: manifest.migrations[index - 1].name, checksum: manifest.migrations[index - 1].checksum });
        expect(target).toMatchObject({ name, checksum, requires: { name: '2026-10-02-purchase-item-kind-v1' } });
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(`${name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
        // A fresh install has the final shape, and the ledger row that says the migration is already applied.
        const baseline = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8').replace(/\r\n/g, '\n');
        const table = baseline.split('CREATE TABLE IF NOT EXISTS product_barcodes (')[1];
        expect(table).toContain('UNIQUE KEY uq_product_barcode (barcode)');
        expect(table).toContain('CONSTRAINT fk_product_barcodes_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE');
        expect(table).toContain('COLLATE=utf8mb4_general_ci');
        const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../../deployment/tools/bootstrap-database.js'), 'utf8');
        expect(bootstrap).toContain(`('${name}','${checksum}')`);
    });

    it('ships the held-report index with exact hashes and Hostinger fallback parity', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const index = manifest.migrations.findIndex(row => row.name === '2026-09-12-held-report-date-index-v1');
        const target = manifest.migrations[index];
        expect(target.name).toBe('2026-09-12-held-report-date-index-v1');
        expect(target.requires).toEqual({ name: manifest.migrations[index - 1].name, checksum: manifest.migrations[index - 1].checksum });
        const read = file => fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
        const sql = read(target.file);
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(crypto.createHash('sha256').update(read(target.preflight)).digest('hex')).toBe(target.preflightSha256);
        expect(read(`${target.name}.sql`)).toBe(sql);
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const begin = `-- BEGIN AUTO MIGRATION: ${target.name} | ${target.checksum}\n`;
        const end = `-- END AUTO MIGRATION: ${target.name} | ${target.checksum}`;
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(sql);
    });

    it('ships ingredient cutover provenance with exact hashes and Hostinger fallback parity', () => {
        const name = '2026-09-08-stock-ingredient-cutover-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const predecessor = manifest.migrations.find(({ name: current }) => current === '2026-09-08-stock-availability-policy-v1');
        const entry = manifest.migrations.find(({ name: current }) => current === name);
        const normal = fs.readFileSync(path.join(directory, `${name}.sql`), 'utf8').replace(/\r\n/g, '\n');
        const automatic = fs.readFileSync(path.join(directory, `${name}.auto.sql`), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(entry).toMatchObject({
            name,
            checksum,
            file: `${name}.auto.sql`,
            requires: { name: predecessor.name, checksum: predecessor.checksum },
        });
        expect(normal).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic).digest('hex'));
        expect(automatic).toContain('CREATE TABLE IF NOT EXISTS stock_ingredient_links');
        expect(automatic).toContain('CREATE TABLE IF NOT EXISTS stock_operation_sources');
        expect(automatic).toContain("source_kind IN ('ingredient_cutover','ingredient_usage','ingredient_manual','ingredient_correction')");
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic.trim());
    });

    it('ships stock item barcode and attention projections with exact hashes and Hostinger fallback parity', () => {
        const name = '2026-09-08-stock-item-projections-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const predecessor = manifest.migrations.find(({ name: current }) => current === '2026-09-08-stock-ingredient-cutover-v1');
        const entry = manifest.migrations.find(({ name: current }) => current === name);
        const normal = fs.readFileSync(path.join(directory, `${name}.sql`), 'utf8').replace(/\r\n/g, '\n');
        const automatic = fs.readFileSync(path.join(directory, `${name}.auto.sql`), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(entry).toMatchObject({
            name,
            checksum,
            file: `${name}.auto.sql`,
            requires: { name: predecessor.name, checksum: predecessor.checksum },
        });
        expect(normal).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic).digest('hex'));
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS barcode VARCHAR(50) NULL');
        expect(automatic).toContain('idx_stock_item_attention');
        expect(automatic).toContain('idx_stock_movement_item_day');
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic.trim());
    });

    it('ships stock procurement documents with exact hashes and Hostinger fallback parity', () => {
        const name = '2026-09-08-stock-procurement-v1';
        const checksum = crypto.createHash('sha256').update(name).digest('hex');
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const predecessor = manifest.migrations.find(({ name: current }) => current === '2026-09-08-stock-report-daily-projection-v1');
        const entry = manifest.migrations.find(({ name: current }) => current === name);
        const normal = fs.readFileSync(path.join(directory, `${name}.sql`), 'utf8').replace(/\r\n/g, '\n');
        const automatic = fs.readFileSync(path.join(directory, `${name}.auto.sql`), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
        expect(entry).toMatchObject({
            name,
            checksum,
            file: `${name}.auto.sql`,
            requires: { name: predecessor.name, checksum: predecessor.checksum },
        });
        expect(normal).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic).digest('hex'));
        expect(automatic).toContain('CREATE TABLE IF NOT EXISTS stock_suppliers');
        expect(automatic).toContain('CREATE TABLE IF NOT EXISTS stock_receipts');
        expect(automatic).toContain("('inventory.read'");
        expect(automatic).toContain("'count.enter'");
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic.trim());
    });

    it('adds the DB-only Y order type setting without overwriting a configured value', () => {
        const name = '2026-09-03-y-order-type-setting-v1';
        const checksum = '4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3';
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find((migration) => migration.name === name);
        const normal = fs.readFileSync(path.join(directory, `${name}.sql`), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, `${name}.auto.sql`), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}`;
        const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;

        expect(entry).toMatchObject({ name, checksum, file: `${name}.auto.sql` });
        expect(normal).toBe(automatic);
        expect(automatic).toContain("INSERT IGNORE INTO settings (setting_key, setting_value)\nVALUES ('y_order_type_id', '')");
        expect(automatic).not.toMatch(/UPDATE\s+settings\b/i);
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships the imported-schema repair with exact named constraints and fallback parity', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === IMPORTED_SCHEMA_REPAIR_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-09-imported-schema-drift-repair.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-09-imported-schema-drift-repair.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${IMPORTED_SCHEMA_REPAIR_NAME} | ${IMPORTED_SCHEMA_REPAIR_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${IMPORTED_SCHEMA_REPAIR_NAME} | ${IMPORTED_SCHEMA_REPAIR_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: IMPORTED_SCHEMA_REPAIR_NAME,
            checksum: IMPORTED_SCHEMA_REPAIR_CHECKSUM,
            file: '2026-08-09-imported-schema-drift-repair.auto.sql',
            requires: {
                name: SETTINGS_VALUE_CAPACITY_NAME,
                checksum: SETTINGS_VALUE_CAPACITY_CHECKSUM,
            },
            repeatable: true,
        });
        expect(normal).toBe(automatic);
        expect(automatic).toMatch(/ALTER TABLE orders\s+ENGINE=InnoDB/);
        expect(automatic).toContain('DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
        expect(automatic).toContain('DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms');
        expect(automatic).toContain('ADD CONSTRAINT fk_pbi_bundle FOREIGN KEY IF NOT EXISTS');
        expect(automatic).toContain('ADD CONSTRAINT fk_print_templates_active_revision FOREIGN KEY IF NOT EXISTS');
        expect(automatic).toContain('ADD CONSTRAINT IF NOT EXISTS chk_products_jofotara_tax_category');
        expect(automatic).not.toMatch(/\b(?:DELIMITER|PROCEDURE|TRIGGER|DEFINER)\b/i);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships the nine baseline authority foreign keys with exact delivery parity', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === BASELINE_AUTHORITY_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-09-baseline-foreign-key-authority.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-09-baseline-foreign-key-authority.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${BASELINE_AUTHORITY_NAME} | ${BASELINE_AUTHORITY_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${BASELINE_AUTHORITY_NAME} | ${BASELINE_AUTHORITY_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: BASELINE_AUTHORITY_NAME,
            checksum: BASELINE_AUTHORITY_CHECKSUM,
            file: '2026-08-09-baseline-foreign-key-authority.auto.sql',
            repeatable: true,
            requires: {
                name: IMPORTED_SCHEMA_REPAIR_NAME,
                checksum: IMPORTED_SCHEMA_REPAIR_CHECKSUM,
            },
        });
        expect(normal).toBe(automatic);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);

        for (const [name, child, column, parent, referencedColumn, deleteRule] of BASELINE_AUTHORITY_FOREIGN_KEYS) {
            const definition = new RegExp(
                `ALTER TABLE ${child}\\s+ADD CONSTRAINT ${name} FOREIGN KEY IF NOT EXISTS \\(${column}\\)\\s+REFERENCES ${parent}\\(${referencedColumn}\\)\\s+ON DELETE ${deleteRule}\\s*;`,
                'i'
            );
            expect((automatic.match(definition) || []).length, name).toBe(1);
        }
        expect((automatic.match(/ADD CONSTRAINT [A-Za-z0-9_]+ FOREIGN KEY IF NOT EXISTS/gi) || [])).toHaveLength(9);
        expect(automatic).not.toMatch(/^\s*(?:DELETE\s+FROM|UPDATE\s+\w+\s+SET)\b/im);
        expect(automatic).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/i);
        expect(automatic).toContain('ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name)');
    });

    it('ships historical order-reference authority with exact delivery parity', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === ORDER_REFERENCE_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-10-order-reference-authority.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-10-order-reference-authority.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${ORDER_REFERENCE_NAME} | ${ORDER_REFERENCE_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${ORDER_REFERENCE_NAME} | ${ORDER_REFERENCE_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: ORDER_REFERENCE_NAME,
            checksum: ORDER_REFERENCE_CHECKSUM,
            file: '2026-08-10-order-reference-authority.auto.sql',
            requires: {
                name: BASELINE_AUTHORITY_NAME,
                checksum: BASELINE_AUTHORITY_CHECKSUM,
            },
        });
        expect(normal).toBe(automatic);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
        expect(automatic).toContain('SET o.waiter_id = NULL');
        expect(automatic).toContain('SET o.order_type_id = NULL');
        expect(automatic).toContain('SET o.customer_id = NULL');
        expect(automatic).toContain('SET o.table_id = NULL');
        expect((automatic.match(/ADD CONSTRAINT [A-Za-z0-9_]+ FOREIGN KEY IF NOT EXISTS/gi) || [])).toHaveLength(4);
        expect(automatic).not.toMatch(/\b(?:DELETE\s+FROM|DROP|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/i);
    });

    it('ships legacy permission retirement with exact delivery parity and no row deletion', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === LEGACY_PERMISSION_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-10-legacy-permission-column-retirement.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-10-legacy-permission-column-retirement.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${LEGACY_PERMISSION_NAME} | ${LEGACY_PERMISSION_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${LEGACY_PERMISSION_NAME} | ${LEGACY_PERMISSION_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: LEGACY_PERMISSION_NAME,
            checksum: LEGACY_PERMISSION_CHECKSUM,
            file: '2026-08-10-legacy-permission-column-retirement.auto.sql',
            requires: { name: ORDER_REFERENCE_NAME, checksum: ORDER_REFERENCE_CHECKSUM },
        });
        expect(normal).toBe(automatic);
        expect((automatic.match(/ALTER TABLE users\s+DROP COLUMN IF EXISTS/gi) || [])).toHaveLength(LEGACY_PERMISSION_COLUMNS.length);
        for (const column of LEGACY_PERMISSION_COLUMNS) expect(automatic).toContain(`DROP COLUMN IF EXISTS ${column}`);
        expect(automatic).toContain('INSERT INTO schema_migrations');
        expect(automatic).not.toMatch(/\b(?:DELETE\s+FROM|UPDATE\s+\w+\s+SET|DROP\s+TABLE|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/i);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships refund-status reconciliation with exact delivery parity and cache-only updates', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === REFUND_STATUS_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-10-refund-status-reconciliation.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-10-refund-status-reconciliation.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${REFUND_STATUS_NAME} | ${REFUND_STATUS_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${REFUND_STATUS_NAME} | ${REFUND_STATUS_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: REFUND_STATUS_NAME,
            checksum: REFUND_STATUS_CHECKSUM,
            file: '2026-08-10-refund-status-reconciliation.auto.sql',
            requires: { name: LEGACY_PERMISSION_NAME, checksum: LEGACY_PERMISSION_CHECKSUM },
        });
        expect(normal).toBe(automatic);
        expect(automatic).toContain('UPDATE orders o');
        expect(automatic).toContain("r.kind='refund'");
        expect(automatic).toContain("o.payment_method='voided'");
        expect(automatic).toContain("o.payment_method='unpaid_table'");
        expect(automatic).toContain('evidence.refunded_amount');
        expect(automatic).not.toMatch(/\b(?:DELETE\s+FROM|INSERT\s+INTO\s+(?:refunds|refund_items)|DROP\s+TABLE|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/i);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('repairs implicit order-reference index names with exact delivery parity', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === ORDER_REFERENCE_INDEX_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-10-order-reference-index-authority.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-10-order-reference-index-authority.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${ORDER_REFERENCE_INDEX_NAME} | ${ORDER_REFERENCE_INDEX_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${ORDER_REFERENCE_INDEX_NAME} | ${ORDER_REFERENCE_INDEX_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: ORDER_REFERENCE_INDEX_NAME,
            checksum: ORDER_REFERENCE_INDEX_CHECKSUM,
            file: '2026-08-10-order-reference-index-authority.auto.sql',
            requires: { name: REFUND_STATUS_NAME, checksum: REFUND_STATUS_CHECKSUM },
        });
        expect(normal).toBe(automatic);
        expect(automatic).toContain('ADD INDEX IF NOT EXISTS idx_orders_waiter_id (waiter_id)');
        expect(automatic).toContain('ADD INDEX IF NOT EXISTS idx_orders_order_type_id (order_type_id)');
        expect(automatic).not.toMatch(/^\s*(?:DELETE\s+FROM|UPDATE\s+(?!schema_migrations\b)|DROP|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/im);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships the durable held-order lifecycle migration with exact delivery parity', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === HELD_ORDER_LIFECYCLE_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-10-held-order-lifecycle.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-10-held-order-lifecycle.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${HELD_ORDER_LIFECYCLE_NAME} | ${HELD_ORDER_LIFECYCLE_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${HELD_ORDER_LIFECYCLE_NAME} | ${HELD_ORDER_LIFECYCLE_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: HELD_ORDER_LIFECYCLE_NAME,
            checksum: HELD_ORDER_LIFECYCLE_CHECKSUM,
            file: '2026-08-10-held-order-lifecycle.auto.sql',
            requires: {
                name: ORDER_REFERENCE_INDEX_NAME,
                checksum: ORDER_REFERENCE_INDEX_CHECKSUM,
            },
        });
        expect(normal).toBe(automatic);
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS version INT UNSIGNED NOT NULL DEFAULT 1');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS hold_request_id VARCHAR(64) NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS claimed_by_user_id INT NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS claim_token_hash CHAR(64) NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS claim_expires_at DATETIME NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS kitchen_snapshot LONGTEXT NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS kitchen_dispatch_version INT UNSIGNED NOT NULL DEFAULT 0');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS last_operation_id VARCHAR(64) NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS last_operation_kind VARCHAR(32) NULL');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS last_operation_result LONGTEXT NULL');
        expect(automatic).toContain('uq_held_orders_user_request');
        expect(automatic).toContain('fk_held_orders_claim_user');
        expect(automatic).toContain(`'${HELD_ORDER_LIFECYCLE_NAME}'`);
        expect(automatic).not.toMatch(/\b(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/i);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships call-center source authority with exact predecessor, delivery parity, and preservation', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === CALL_CENTER_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-10-call-center-held-orders.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-10-call-center-held-orders.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${CALL_CENTER_NAME} | ${CALL_CENTER_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${CALL_CENTER_NAME} | ${CALL_CENTER_CHECKSUM}`;

        expect(entry).toEqual({
            name: CALL_CENTER_NAME,
            checksum: CALL_CENTER_CHECKSUM,
            file: '2026-08-10-call-center-held-orders.auto.sql',
            sha256: CALL_CENTER_SQL_SHA,
            requires: {
                name: HELD_ORDER_LIFECYCLE_NAME,
                checksum: HELD_ORDER_LIFECYCLE_CHECKSUM,
            },
        });
        expect(normal).toBe(automatic);
        expect(automatic).toContain("MODIFY role ENUM('admin','cashier','programmer','waiter','table_manager','call_center')");
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS call_center_user_id INT NULL');
        expect(automatic).toContain('idx_held_orders_call_center_user');
        expect(automatic).toContain('idx_orders_call_center_user');
        expect(automatic).toContain('fk_held_orders_call_center_user');
        expect(automatic).toContain('fk_orders_call_center_user');
        expect(automatic).toContain('ON DELETE RESTRICT');
        expect(automatic).not.toMatch(/\b(?:DELETE\s+FROM|DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/i);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships receipt tax-display authority with exact predecessor and delivery parity', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === RECEIPT_TAX_DISPLAY_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-11-receipt-tax-display-v1.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-11-receipt-tax-display-v1.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${RECEIPT_TAX_DISPLAY_NAME} | ${RECEIPT_TAX_DISPLAY_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${RECEIPT_TAX_DISPLAY_NAME} | ${RECEIPT_TAX_DISPLAY_CHECKSUM}`;

        expect(entry).toEqual({
            name: RECEIPT_TAX_DISPLAY_NAME,
            checksum: RECEIPT_TAX_DISPLAY_CHECKSUM,
            file: '2026-08-11-receipt-tax-display-v1.auto.sql',
            sha256: RECEIPT_TAX_DISPLAY_SQL_SHA,
            requires: {
                name: CALL_CENTER_NAME,
                checksum: CALL_CENTER_CHECKSUM,
            },
        });
        expect(normal).toBe(automatic);
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS receipt_tax_inclusive_at_sale TINYINT(1) NULL');
        expect(automatic).not.toMatch(/\b(?:DELETE\s+FROM|DROP|TRUNCATE|RENAME|PROCEDURE|TRIGGER|DEFINER|DELIMITER)\b/i);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('copies the approved JoFotara tax-category SQL exactly into the Hostinger fallback', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const automatic = fs.readFileSync(path.join(directory, '2026-08-04-jofotara-tax-categories.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${JOFOTARA_TAX_CATEGORIES_NAME} | ${JOFOTARA_TAX_CATEGORIES_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${JOFOTARA_TAX_CATEGORIES_NAME} | ${JOFOTARA_TAX_CATEGORIES_CHECKSUM}`;

        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
        expect(automatic).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    });

    it('copies the approved special-source buyer-snapshot SQL exactly into the Hostinger fallback', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const normal = fs.readFileSync(path.join(directory, '2026-08-04-special-source-buyer-snapshots.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-04-special-source-buyer-snapshots.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${SPECIAL_SOURCE_BUYER_SNAPSHOTS_NAME} | ${SPECIAL_SOURCE_BUYER_SNAPSHOTS_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${SPECIAL_SOURCE_BUYER_SNAPSHOTS_NAME} | ${SPECIAL_SOURCE_BUYER_SNAPSHOTS_CHECKSUM}`;

        expect(normal).toContain('DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms');
        expect(normal).toContain('buyer_name_at_sale = COALESCE(buyer_name_at_sale, customers.name)');
        expect(normal).toContain("payment_method = 'platform'");
        expect(normal).toContain('FROM customer_subscriptions');
        expect(normal).toContain('buyer_name_at_sale IS NULL');
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships the service-charge category repair in manifest order and copies it exactly to the fallback', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === SERVICE_CHARGE_CATEGORY_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-05-service-charge-jofotara-tax-category.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-05-service-charge-jofotara-tax-category.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${SERVICE_CHARGE_CATEGORY_NAME} | ${SERVICE_CHARGE_CATEGORY_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${SERVICE_CHARGE_CATEGORY_NAME} | ${SERVICE_CHARGE_CATEGORY_CHECKSUM}`;

        expect(entry).toMatchObject({
            checksum: SERVICE_CHARGE_CATEGORY_CHECKSUM,
            requires: {
                name: SPECIAL_SOURCE_BUYER_SNAPSHOTS_NAME,
                checksum: SPECIAL_SOURCE_BUYER_SNAPSHOTS_CHECKSUM,
            },
        });
        expect(normal).toContain("rate.setting_key = 'service_charge_tax_rate'");
        expect(normal).toContain("category.setting_value = 'S'");
        expect(automatic).toContain("category.setting_value = 'S'");
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
        expect(automatic).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    });

    it('ships the settings value capacity migration after service-charge repair', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'auto-manifest.json'), 'utf8'));
        const entry = manifest.migrations.find(({ name }) => name === SETTINGS_VALUE_CAPACITY_NAME);
        const normal = fs.readFileSync(path.join(directory, '2026-08-08-settings-value-capacity.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-08-settings-value-capacity.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${SETTINGS_VALUE_CAPACITY_NAME} | ${SETTINGS_VALUE_CAPACITY_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${SETTINGS_VALUE_CAPACITY_NAME} | ${SETTINGS_VALUE_CAPACITY_CHECKSUM}`;

        expect(entry).toMatchObject({
            name: SETTINGS_VALUE_CAPACITY_NAME,
            checksum: SETTINGS_VALUE_CAPACITY_CHECKSUM,
            file: '2026-08-08-settings-value-capacity.auto.sql',
            requires: {
                name: SERVICE_CHARGE_CATEGORY_NAME,
                checksum: SERVICE_CHARGE_CATEGORY_CHECKSUM,
            },
        });
        expect(normal).toContain('MODIFY COLUMN setting_value TEXT NOT NULL');
        expect(automatic).toContain('MODIFY COLUMN setting_value TEXT NOT NULL');
        expect(automatic).not.toMatch(/setting_value\s*\([^)]*\)|KEY\s+.*setting_value/i);
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
        expect(automatic).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b/i);
    });

    it('keeps the repeatable reconciliation additive and identical across its three delivery forms', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const normal = fs.readFileSync(path.join(directory, '2026-08-01-additive-schema-reconciliation.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const automatic = fs.readFileSync(path.join(directory, '2026-08-01-additive-schema-reconciliation.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${REPAIR_NAME} | ${REPAIR_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${REPAIR_NAME} | ${REPAIR_CHECKSUM}`;
        const block = fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim();

        expect(normal).toBe(automatic);
        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(block).toBe(automatic);
        const statements = splitMysqlScript(automatic);
        expect(statements).not.toEqual([]);
        const alterForeignKeys = statements.filter((statement) => /^ALTER TABLE/i.test(statement) && /\bADD\s+(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\b/i.test(statement));
        expect(alterForeignKeys).toHaveLength(7);
        expect(alterForeignKeys.map((statement) => statement.match(/ADD CONSTRAINT (\w+) FOREIGN KEY IF NOT EXISTS/i)?.[1])).toEqual([
            'fk_print_templates_active_revision',
            'fk_print_templates_draft_revision',
            'fk_platform_remittances_user',
            'fk_platform_remittances_reversal',
            'fk_platform_remittance_lines_remittance',
            'fk_platform_remittance_lines_order',
            'fk_platform_remittance_adjustments_remittance',
        ]);
        expect(alterForeignKeys.every((statement) => /ADD CONSTRAINT \w+ FOREIGN KEY IF NOT EXISTS/i.test(statement))).toBe(true);
        expect(automatic).not.toMatch(/\b(?:DROP|TRUNCATE|RENAME)\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/i);
    });

    it('copies the approved platform reconciliation automatic SQL exactly into the Hostinger fallback', () => {
        const directory = path.resolve(__dirname, '../../migrations');
        const automatic = fs.readFileSync(path.join(directory, '2026-08-03-platform-provider-reconciliation.auto.sql'), 'utf8').replace(/\r\n/g, '\n').trim();
        const fallback = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'), 'utf8').replace(/\r\n/g, '\n');
        const start = `-- BEGIN AUTO MIGRATION: ${PLATFORM_RECONCILIATION_NAME} | ${PLATFORM_RECONCILIATION_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${PLATFORM_RECONCILIATION_NAME} | ${PLATFORM_RECONCILIATION_CHECKSUM}`;

        expect(fallback.indexOf(start)).toBeGreaterThanOrEqual(0);
        expect(fallback.indexOf(end)).toBeGreaterThan(fallback.indexOf(start));
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim()).toBe(automatic);
    });

    it('ships Hostinger-safe automatic SQL without stored routines or definers', () => {
        const manifestPath = path.resolve(__dirname, '../../migrations/auto-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        for (const migration of manifest.migrations) {
            const sql = fs.readFileSync(path.join(path.dirname(manifestPath), migration.file), 'utf8');
            expect(sql).not.toMatch(/\b(?:DELIMITER|PROCEDURE|TRIGGER|DEFINER)\b/i);
            expect(sql).toContain('INSERT INTO schema_migrations');
        }
    });

    it('splits multiline Hostinger-safe SQL statements', () => {
        const { sqlText } = writeFixture();

        const statements = splitMysqlScript(sqlText);

        expect(statements).toHaveLength(3);
        expect(statements[0]).toBe('SET NAMES utf8mb4');
        expect(statements[1]).toContain('ALTER TABLE orders');
        expect(statements[2]).toContain('INSERT INTO schema_migrations');
    });

    it('rejects stored routines and definers from automatic SQL', () => {
        expect(() => splitMysqlScript('DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$'))
            .toThrow('Hostinger-safe');
        expect(() => splitMysqlScript('CREATE DEFINER=root TRIGGER t BEFORE INSERT ON x FOR EACH ROW SET @x=1;'))
            .toThrow('Hostinger-safe');
    });

    it('skips an exactly applied migration and still releases its lock', async () => {
        const { manifestPath } = writeFixture();
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .resolves.toEqual({ applied: [], skipped: [TARGET_NAME] });

        expect(fake.calls.some(({ sql }) => sql.includes('CREATE PROCEDURE'))).toBe(false);
        expect(fake.calls.some(({ sql }) => sql.includes('RELEASE_LOCK'))).toBe(true);
        expect(fake.connection.release).toHaveBeenCalledOnce();
    });

    it.each([
        ['missing', undefined],
        ['wrong', 'd'.repeat(64)],
    ])('validates the predecessor before skipping an exactly-ledgered migration when it is %s', async (_label, predecessorChecksum) => {
        const { manifestPath } = writeFixture();
        const ledger = { [TARGET_NAME]: TARGET_CHECKSUM };
        if (predecessorChecksum) ledger[BASE_NAME] = predecessorChecksum;
        const fake = fakePool({ ledger });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow(`Migration ${TARGET_NAME} requires ${BASE_NAME}`);

        expect(fake.calls.some(({ sql }) => sql.includes('ALTER TABLE orders'))).toBe(false);
    });

    it('re-executes an exactly-ledgered repeatable reconciliation', async () => {
        const { manifestPath } = writeFixture({ migration: { repeatable: true } });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath, includeRepeatable: true }))
            .resolves.toEqual({ applied: [TARGET_NAME], skipped: [] });

        expect(fake.calls.some(({ sql }) => sql.startsWith('ALTER TABLE orders'))).toBe(true);
    });

    it('does not re-run repeatable DDL through ordinary restricted startup', async () => {
        const { manifestPath } = writeFixture({ migration: { repeatable: true } });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .resolves.toEqual({ applied: [], skipped: [TARGET_NAME] });

        expect(fake.calls.some(({ sql }) => sql.startsWith('ALTER TABLE orders'))).toBe(false);
    });

    it('refuses destructive statements in a repeatable reconciliation', async () => {
        const { manifestPath } = writeFixture({
            sql: 'DELETE FROM orders;',
            migration: { repeatable: true },
        });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath, includeRepeatable: true }))
            .rejects.toThrow(/additive/i);

        expect(fake.calls.some(({ sql }) => sql.startsWith('DELETE FROM'))).toBe(false);
    });

    it('allows only an idempotent check-constraint drop/re-add in a repeatable reconciliation', async () => {
        const { manifestPath } = writeFixture({
            sql: [
                'ALTER TABLE orders',
                '  DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms,',
                '  ADD CONSTRAINT chk_orders_receivable_terms CHECK (1);',
                "INSERT INTO schema_migrations (migration_name, checksum) VALUES ('target', 'checksum');",
            ].join('\n'),
            migration: { repeatable: true },
        });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath, includeRepeatable: true }))
            .resolves.toEqual({ applied: [TARGET_NAME], skipped: [] });
    });

    it.each([
        'ALTER TABLE orders DROP CONSTRAINT chk_orders_receivable_terms;',
        'ALTER TABLE orders DROP FOREIGN KEY IF EXISTS fk_orders_user;',
        'ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms, DROP COLUMN note;',
        'ALTER TABLE orders DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms, ADD CONSTRAINT chk_orders_receivable_terms FOREIGN KEY IF NOT EXISTS (user_id) REFERENCES users(id);',
    ])('rejects non-idempotent or non-check destructive repeatable DDL: %s', async (sql) => {
        const { manifestPath } = writeFixture({ sql, migration: { repeatable: true } });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath, includeRepeatable: true }))
            .rejects.toThrow(/additive/i);
    });

    it('does not let a leading SQL comment hide destructive repeatable DDL', async () => {
        const { manifestPath } = writeFixture({
            sql: '-- looks harmless\nDELETE FROM orders;',
            migration: { repeatable: true },
        });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath, includeRepeatable: true }))
            .rejects.toThrow(/additive/i);

        expect(fake.calls.some(({ sql }) => sql.includes('DELETE FROM'))).toBe(false);
    });

    it('rejects a changed SQL file before opening a database connection', async () => {
        const { manifestPath } = writeFixture({ migration: { sha256: '0'.repeat(64) } });
        const fake = fakePool();

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow('file hash');

        expect(fake.pool.getConnection).not.toHaveBeenCalled();
    });

    it('uses a line-ending-stable SQL hash across Windows and Linux checkouts', async () => {
        const sql = 'SELECT 1;\r\n';
        const { manifestPath } = writeFixture({ sql });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .resolves.toEqual({ applied: [], skipped: [TARGET_NAME] });
    });

    it('rejects path traversal and duplicate migration names', async () => {
        const traversal = writeFixture({ file: '../target.sql' });
        const fake = fakePool();
        await expect(runPendingMigrations(fake.pool, { manifestPath: traversal.manifestPath }))
            .rejects.toThrow('file name');

        const duplicate = writeFixture();
        const manifest = JSON.parse(fs.readFileSync(duplicate.manifestPath, 'utf8'));
        manifest.migrations.push({ ...manifest.migrations[0] });
        fs.writeFileSync(duplicate.manifestPath, JSON.stringify(manifest));
        await expect(runPendingMigrations(fake.pool, { manifestPath: duplicate.manifestPath }))
            .rejects.toThrow('duplicate migration');
    });

    it('rejects a ledger checksum conflict without executing migration SQL', async () => {
        const { manifestPath } = writeFixture();
        const fake = fakePool({ ledger: { [TARGET_NAME]: 'd'.repeat(64) } });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow('checksum conflict');

        expect(fake.calls.some(({ sql }) => sql.includes('CREATE PROCEDURE'))).toBe(false);
        expect(fake.calls.some(({ sql }) => sql.includes('RELEASE_LOCK'))).toBe(true);
    });

    it('requires the exact predecessor before applying a missing migration', async () => {
        const { manifestPath } = writeFixture();
        const fake = fakePool();

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow(BASE_NAME);

        expect(fake.calls.some(({ sql }) => sql.includes('CREATE PROCEDURE'))).toBe(false);
    });

    it('times out safely when another deployment owns the migration lock', async () => {
        const { manifestPath } = writeFixture();
        const fake = fakePool({ lock: 0 });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow('migration lock');

        expect(fake.calls.some(({ sql }) => sql.includes('RELEASE_LOCK'))).toBe(false);
        expect(fake.connection.release).toHaveBeenCalledOnce();
    });

    it('applies statements serially and verifies the migration ledger afterward', async () => {
        const { manifestPath } = writeFixture();
        const fake = fakePool({
            ledger: { [BASE_NAME]: BASE_CHECKSUM },
            onStatement: ({ sql, state }) => {
                if (sql.startsWith('INSERT INTO schema_migrations')) state[TARGET_NAME] = TARGET_CHECKSUM;
            },
        });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .resolves.toEqual({ applied: [TARGET_NAME], skipped: [] });

        const executed = fake.calls.map(({ sql }) => sql);
        expect(executed.findIndex((sql) => sql.startsWith('ALTER TABLE')))
            .toBeLessThan(executed.findIndex((sql) => sql.startsWith('INSERT INTO schema_migrations')));
        expect(executed.at(-1)).toContain('RELEASE_LOCK');
    });

    it('reports an actionable managed-baseline error when schema_migrations is absent', async () => {
        const { manifestPath } = writeFixture();
        const error = Object.assign(new Error("Table 'legacy.schema_migrations' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
        const fake = fakePool({ ledgerError: error });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow('managed schema baseline');

        expect(fake.calls.some(({ sql }) => sql.includes('RELEASE_LOCK'))).toBe(true);
    });

    it('does not attach failed SQL bodies to migration errors', async () => {
        const { manifestPath } = writeFixture();
        const mysqlError = Object.assign(new Error('ALTER command denied'), {
            code: 'ER_TABLEACCESS_DENIED_ERROR',
            sql: 'SECRET MIGRATION SQL',
        });
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM }, statementError: mysqlError });

        let failure;
        try {
            await runPendingMigrations(fake.pool, { manifestPath });
        } catch (error) {
            failure = error;
        }

        expect(failure.message).toContain(TARGET_NAME);
        expect(failure.message).toContain('ER_TABLEACCESS_DENIED_ERROR');
        expect(failure.message).not.toContain('SECRET MIGRATION SQL');
        expect(failure).not.toHaveProperty('sql');
    });

    it('fails closed when SQL execution does not record the expected ledger row', async () => {
        const { manifestPath } = writeFixture();
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM } });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow('did not record');

        expect(fake.calls.some(({ sql }) => sql.includes('RELEASE_LOCK'))).toBe(true);
        expect(fake.connection.release).toHaveBeenCalledOnce();
    });

    it('destroys a pooled connection when its advisory lock cannot be released', async () => {
        const { manifestPath } = writeFixture();
        const fake = fakePool({ ledger: { [BASE_NAME]: BASE_CHECKSUM, [TARGET_NAME]: TARGET_CHECKSUM }, released: 0 });

        await expect(runPendingMigrations(fake.pool, { manifestPath }))
            .rejects.toThrow('release');

        expect(fake.connection.destroy).toHaveBeenCalledOnce();
        expect(fake.connection.release).not.toHaveBeenCalled();
    });
});
