import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const baselinePath = path.join(ROOT, 'deployment/database/baseline.sql');

function fakeExecutor() {
    const calls = [];
    return {
        calls,
        async query(sql, params) {
            calls.push({ sql: String(sql), params });
            if (String(sql).includes('SELECT COUNT(*) AS count FROM users')) return [[{ count: 0 }]];
            return [[]];
        }
    };
}

describe('fresh database baseline', () => {
    it('contains the current POS schema without retired purchasing tables or business rows', () => {
        const sql = fs.readFileSync(baselinePath, 'utf8');
        expect((sql.match(/^CREATE TABLE /gm) || []).length).toBe(75);
        expect(sql).not.toMatch(/CREATE TABLE (?:subscription_|customer_subscription)/);
        expect(sql).toContain('CREATE TABLE deleted (');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS table_action_operations');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS order_intake_requests');
        expect(sql).toContain('CREATE TABLE daily_order_type_sequences');
        expect(sql).not.toMatch(/INSERT INTO|9001|Test Admin|Test Burger/);
        expect(sql).toContain('is_deferred_settlement tinyint(1) NOT NULL DEFAULT 0');
        expect(sql).toContain("enum('cash','card','split','receivable','platform','unpaid_table','voided')");
        expect(sql).toContain('tax_exempt_at_sale tinyint(1) NOT NULL DEFAULT 0');
        expect(sql).toContain('price_before_tax_exemption decimal(10,6) DEFAULT NULL');
        expect(sql).toContain('version int(10) unsigned NOT NULL DEFAULT 1');
        expect(sql).toContain('UNIQUE KEY uq_held_orders_user_request (user_id, hold_request_id)');
        expect(sql).toContain('CONSTRAINT fk_held_orders_claim_user FOREIGN KEY (claimed_by_user_id) REFERENCES users (id) ON DELETE RESTRICT');
        expect(sql).toContain('KEY idx_orders_platform_provider (payment_method,order_type_id,invoice_id)');
        expect(sql).toContain('CREATE TABLE platform_remittances');
        expect(sql).toContain('CREATE TABLE platform_remittance_lines');
        expect(sql).toContain('CREATE TABLE platform_remittance_adjustments');
        expect(sql).not.toMatch(/^CREATE TABLE (?:IF NOT EXISTS )?stock_(?:suppliers|supplier_items|purchase_orders|purchase_order_lines|receipts|receipt_lines|vendor_returns|vendor_return_lines|price_adjustments|price_adjustment_lines)\b/m);
        expect(sql).toContain('setting_value text NOT NULL');
        expect(sql).toContain("CONSTRAINT chk_orders_receivable_terms CHECK ((payment_method='receivable'");
        expect(sql).toContain("OR (payment_method<>'receivable' AND payment_due_on IS NULL AND receivable_reason IS NULL))");
        expect(sql).toContain('CREATE TABLE webauthn_credentials');
        expect(sql).toContain('CREATE TABLE auth_sessions');
        expect(sql).toContain('KEY idx_jofotara_status_attempt (status, last_attempt_at)');
        expect(sql).toContain('CREATE TABLE webauthn_ceremonies');
        expect(sql).toContain('CREATE TABLE webauthn_recovery_codes');
        expect(sql).not.toContain('session_token varchar(128)');
    });

    it('rejects programmer seeds that are not exactly twelve digits', async () => {
        const { bootstrapDatabase } = await import('../../../deployment/tools/bootstrap-database.js');
        const base = {
            executor: fakeExecutor(),
            validate: async () => true,
            database: 'posapp_installer_test',
            appPassword: 'test-app-secret',
            maintenancePassword: 'test-maintenance-secret',
            adminPassword: 'test-root-secret',
            programmerName: 'Programmer'
        };
        await expect(bootstrapDatabase({ ...base, programmerUserNumber: '87654321' })).rejects.toThrow(/twelve-digit programmer/);
        await expect(bootstrapDatabase({ ...base, programmerUserNumber: '8765432198765' })).rejects.toThrow(/twelve-digit programmer/);
    });

    it('bootstraps the guarded ledger and administrator without a live database', async () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployment/database/manifest.json'), 'utf8'));
        const { bootstrapDatabase, normalizeSqlText } = await import('../../../deployment/tools/bootstrap-database.js');
        const baseline = fs.readFileSync(baselinePath);
        expect(crypto.createHash('sha256').update(normalizeSqlText(baseline), 'utf8').digest('hex')).toBe(manifest.baseline.sha256);

        const executor = fakeExecutor();
        const result = await bootstrapDatabase({
            executor,
            validate: async () => true,
            database: 'posapp_installer_test',
            appPassword: 'test-app-secret',
            maintenancePassword: 'test-maintenance-secret',
            adminPassword: 'test-root-secret',
            programmerUserNumber: '876543219876',
            programmerName: 'Programmer'
        });

        expect(result).toMatchObject({ baselineVersion: 1, schemaValid: true });
        const sql = executor.calls.map((call) => call.sql).join('\n');
        expect(sql).toContain('2026-07-23-admin-manual-subscriptions-v1');
        expect(sql).toContain('2026-07-24-progressive-split-checks-v1');
        expect(sql).toContain('2026-07-24-jofotara-operations-v1');
        expect(sql).toContain('2026-07-25-print-templates-v1');
        expect(sql).toContain('2026-07-29-subscription-receivables-v1');
        expect(sql).toContain('2026-07-31-platform-held-order-settlement-v1');
        expect(sql).toContain('2026-07-31-tax-exempt-checks-v1');
        expect(sql).toContain('2026-08-01-additive-schema-reconciliation-v1');
        expect(sql).toContain('2026-08-04-jofotara-tax-categories-v1');
        expect(sql).toContain('2026-08-04-special-source-buyer-snapshots-v1');
        expect(sql).toContain('2026-08-05-service-charge-jofotara-tax-category-v1');
        expect(sql).toContain('2026-08-08-settings-value-capacity-v1');
        expect(sql).toContain('2026-08-09-imported-schema-drift-repair-v1');
        expect(sql).toContain('2026-08-09-baseline-foreign-key-authority-v1');
        expect(sql).toContain('2026-08-10-order-reference-index-authority-v1');
        expect(sql).toContain('2026-08-10-held-order-lifecycle-v1');
        expect(sql).toContain('2026-08-10-call-center-held-orders-v1');
        expect(sql).toContain('2026-08-11-receipt-tax-display-v1');
        expect(sql).toContain('2026-08-13-split-quantity-precision-v1');
        expect(sql).toContain('2026-08-13-webauthn-registered-device-access-v1');
        expect(sql).toContain('2026-08-30-jofotara-stale-submission-index-v1');
        expect(sql).toContain('2026-08-31-pos-order-history-default-v1');
        expect(sql).toContain('2026-09-03-y-order-type-setting-v1');
        expect(sql).toContain('2026-09-13-table-action-recovery-v1');
        expect(sql).toContain('2026-09-23-subscriptions-retirement-v1');
        expect(sql).not.toContain("('subscription_receivables_enabled','0')");
        expect(sql).toContain("('y_order_type_id','')");
        expect(sql).toContain("('staff_device_auth_mode','disabled')");
        expect(sql).toContain("('webauthn_bootstrap_consumed','0')");
        expect(sql).not.toContain("'pos.subscription_credit'");
        expect(sql).toContain("'POS Order History'");
        expect(sql).toContain('Does not grant Admin Orders access.');
        expect(sql).toContain("VALUES (?, ?, 'admin', NULL");
        expect(sql).toContain("(?, ?, 'programmer', NULL");
        expect(sql).toContain("CREATE USER IF NOT EXISTS 'posapp_runtime'@'127.0.0.1'");
        expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON `posapp_installer_test`.* TO 'posapp_runtime'@'127.0.0.1'");
        expect(sql).toContain("GRANT ALL PRIVILEGES ON `posapp_installer_test`.* TO 'posapp_maintenance'@'127.0.0.1'");
        expect(sql).toContain("ALTER USER 'root'@'localhost' IDENTIFIED BY 'test-root-secret'");
        expect(executor.calls.some((call) => call.params?.[0] === '009384')).toBe(true);
        expect(executor.calls.some((call) => call.params?.includes('876543219876'))).toBe(true);
    });

    // Baseline and A1 both take about 34.5 s for full metadata validation locally.
    it('bootstraps a real scratch database that passes the runtime schema validator', async () => {
        const mysql = (await import('mysql2/promise')).default;
        const { bootstrapDatabase } = await import('../../../deployment/tools/bootstrap-database.js');
        const db = `posapp_installer_test_${crypto.randomBytes(6).toString('hex')}`;
        const host = process.env.DB_HOST || '127.0.0.1';
        if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('Installer fixture requires a loopback database.');
        let created = false;
        const conn = await mysql.createConnection({
            host,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true
        });
        // Pass through everything except account/grant statements so local MySQL users are untouched.
        const executor = {
            query(sql, params) {
                if (/^(CREATE USER|ALTER USER|GRANT|FLUSH)/i.test(String(sql).trim())) return Promise.resolve([[]]);
                return conn.query(sql, params);
            }
        };
        try {
            await conn.query(`CREATE DATABASE \`${db}\``);
            created = true;
            console.info(`Installer fixture database: ${db}`);
            // No validate override: this must run the real validateRequiredSchema the server boots with.
            const result = await bootstrapDatabase({ executor, database: db, appPassword: 'probe', maintenancePassword: 'probe', adminPassword: 'probe', programmerUserNumber: '876543219876', programmerName: 'Programmer' });
            expect(result).toMatchObject({ schemaValid: true, baselineId: 'posapp-fresh-baseline-v1' });
            const [users] = await conn.query(`SELECT user_number, role, xyz FROM \`${db}\`.users ORDER BY role`);
            expect(users).toEqual(expect.arrayContaining([
                expect.objectContaining({ user_number: '009384', role: 'admin', xyz: 0 }),
                expect.objectContaining({ user_number: '876543219876', role: 'programmer', xyz: 0 }),
            ]));
            expect(users).toHaveLength(2);
            const { PERMISSIONS } = await import('../../services/PermissionService.js');
            const [catalog] = await conn.query('SELECT perm_key FROM permissions WHERE implemented=1');
            const currentKeys = catalog.map(row => row.perm_key);
            for (const key of Object.values(PERMISSIONS)) expect(currentKeys, `Fresh install missing ${key}`).toContain(key);
            const [[grants]] = await conn.query('SELECT COUNT(*) count FROM user_permissions');
            expect(grants.count).toBe(0);
            const [[yOrderTypeSetting]] = await conn.query(
                `SELECT setting_value FROM \`${db}\`.settings WHERE setting_key = 'y_order_type_id'`
            );
            expect(yOrderTypeSetting).toEqual({ setting_value: '' });
            const { runPendingMigrations } = await import('../../migrations/runPendingMigrations.js');
            const startupPool = { getConnection: async () => ({ query: conn.query.bind(conn), release() {} }) };
            for (let pass = 0; pass < 2; pass++) {
                expect((await runPendingMigrations(startupPool)).applied).toEqual([]);
            }
        } finally {
            try {
                if (created) await conn.query(`DROP DATABASE \`${db}\``);
            } finally { await conn.end(); }
        }
    }, 90_000);

    it('rejects identifiers that could escape the database boundary', async () => {
        const { bootstrapDatabase } = await import('../../../deployment/tools/bootstrap-database.js');
        await expect(bootstrapDatabase({ database: 'posapp;DROP DATABASE x', appPassword: 'a', maintenancePassword: 'b' }))
            .rejects.toThrow('Invalid database');
    });
});
