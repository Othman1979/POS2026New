import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.test'), override: true });

const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const DATABASE = 'posapp_webauthn_migration_test';
const WEBAUTHN_NAME = '2026-08-13-webauthn-registered-device-access-v1';
const LEGACY_TOKEN_HASH = 'a'.repeat(64);

describe('WebAuthn exact-predecessor migration', () => {
    let admin;
    let pool;

    beforeEach(async () => {
        admin = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            port: Number(process.env.DB_PORT || 3306),
            multipleStatements: true,
        });
        await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
        await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
        await admin.query(`USE \`${DATABASE}\``);
        await admin.query(fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8'));

        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../migrations/auto-manifest.json'), 'utf8'));
        const predecessors = manifest.migrations.filter(({ name }) => name !== WEBAUTHN_NAME);
        const ledger = new Map();
        for (const migration of predecessors) {
            ledger.set(migration.requires.name, migration.requires.checksum);
            ledger.set(migration.name, migration.checksum);
        }
        ledger.delete(WEBAUTHN_NAME);
        await admin.query(
            `INSERT INTO schema_migrations (migration_name, checksum) VALUES ${[...ledger].map(() => '(?, ?)').join(', ')}`,
            [...ledger].flatMap(([name, checksum]) => [name, checksum])
        );
        await admin.query(`
            SET FOREIGN_KEY_CHECKS=0;
            DROP TABLE webauthn_ceremonies, auth_sessions, webauthn_credentials, webauthn_recovery_codes;
            SET FOREIGN_KEY_CHECKS=1;
            ALTER TABLE users DROP INDEX uq_users_webauthn_user_handle, DROP COLUMN webauthn_user_handle,
              ADD COLUMN session_token VARCHAR(128) DEFAULT NULL;
            DELETE FROM settings WHERE setting_key IN ('staff_device_auth_mode','webauthn_bootstrap_consumed');
            INSERT INTO users (id, user_number, name, role, is_active, session_token)
              VALUES (9001, 'migration-user', 'Migration User', 'admin', 1, '${LEGACY_TOKEN_HASH}');
            INSERT INTO categories (id, name) VALUES (9001, 'Preserved Category');
            INSERT INTO products (id, category_id, name, price) VALUES (9001, 9001, 'Preserved Product', 1.250000);
            INSERT INTO orders
              (invoice_id, user_id, subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount, change_due)
              VALUES (9001, 9001, 1.25, 0, 1.25, 'cash', 1.25, 1.25, 0, 0);
        `);

        pool = mysql.createPool({
            host: process.env.DB_HOST || '127.0.0.1',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: DATABASE,
            port: Number(process.env.DB_PORT || 3306),
            connectionLimit: 2,
        });
    });

    afterEach(async () => {
        await pool?.end().catch(() => {});
        await admin?.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => {});
        await admin?.end().catch(() => {});
    });

    it('migrates the legacy session and preserves business rows', async () => {
        await expect(runPendingMigrations(pool)).resolves.toMatchObject({ applied: [WEBAUTHN_NAME] });

        const [[authority]] = await pool.query(`
            SELECT
              (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN
                ('webauthn_credentials','webauthn_ceremonies','auth_sessions','webauthn_recovery_codes')) AS tables_present,
              (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME='session_token') AS legacy_columns,
              (SELECT COUNT(*) FROM auth_sessions WHERE token_hash=? AND user_id=9001 AND credential_id IS NULL) AS migrated_sessions,
              (SELECT COUNT(*) FROM users WHERE id=9001) AS users_preserved,
              (SELECT COUNT(*) FROM categories WHERE id=9001) AS categories_preserved,
              (SELECT COUNT(*) FROM products WHERE id=9001) AS products_preserved,
              (SELECT COUNT(*) FROM orders WHERE invoice_id=9001) AS orders_preserved
        `, [DATABASE, DATABASE, LEGACY_TOKEN_HASH]);
        expect(authority).toEqual({
            tables_present: 4,
            legacy_columns: 0,
            migrated_sessions: 1,
            users_preserved: 1,
            categories_preserved: 1,
            products_preserved: 1,
            orders_preserved: 1,
        });
        const verifySql = fs.readFileSync(
            path.resolve(__dirname, '../../migrations/2026-08-13-webauthn-registered-device-access.verify.sql'),
            'utf8'
        );
        const [[verified]] = await pool.query(verifySql);
        expect(verified.ok).toBe(1);
    });

    it('rejects an incompatible partial target before changing the predecessor', async () => {
        await pool.query('CREATE TABLE auth_sessions (id CHAR(36) NOT NULL PRIMARY KEY) ENGINE=InnoDB');

        await expect(runPendingMigrations(pool)).rejects.toThrow(/preflight rejected/);
        const [[state]] = await pool.query(`
            SELECT
              (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME='session_token') AS legacy_columns,
              (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='users' AND COLUMN_NAME='webauthn_user_handle') AS new_columns,
              (SELECT COUNT(*) FROM users WHERE id=9001 AND session_token=?) AS users_unchanged,
              (SELECT COUNT(*) FROM schema_migrations WHERE migration_name=?) AS ledger_rows
        `, [DATABASE, DATABASE, LEGACY_TOKEN_HASH, WEBAUTHN_NAME]);
        expect(state).toEqual({ legacy_columns: 1, new_columns: 0, users_unchanged: 1, ledger_rows: 0 });
    });
});
