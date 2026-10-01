import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const MANIFEST_PATH = path.join(ROOT, 'migrations', 'auto-manifest.json');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-10-call-center-held-orders.sql');

const PREDECESSOR_NAME = '2026-08-10-held-order-lifecycle-v1';
const PREDECESSOR_CHECKSUM = 'af0234c8bce485927d509691f5b7a1445ce4e6ff6352b46822175b0165956160';
const PREDECESSOR_SQL_SHA = 'a5ecfe94d542e5672dbc95d10877b38ceb75f10987e5e97c1720728e440b2185';
const MIGRATION_NAME = '2026-08-10-call-center-held-orders-v1';
const MIGRATION_CHECKSUM = 'f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b';

function readMigration() {
    return fs.existsSync(MIGRATION_PATH)
        ? fs.readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n')
        : '';
}

function executableSql(sql) {
    return sql
        .replace(/^\s*--.*$/gm, '')
        .trim();
}

describe('call-center migration evidence contract', () => {
    it('pins the exact lifecycle predecessor before this evidence migration', () => {
        const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        const predecessor = manifest.migrations.find(({ name }) => name === PREDECESSOR_NAME);
        const targetIndex = manifest.migrations.findIndex(({ name }) => name === MIGRATION_NAME);
        const tip = manifest.migrations[targetIndex];
        const next = manifest.migrations[targetIndex + 1];
        const sql = readMigration();

        expect(predecessor).toMatchObject({
            name: PREDECESSOR_NAME,
            checksum: PREDECESSOR_CHECKSUM,
            sha256: PREDECESSOR_SQL_SHA,
        });
        expect(tip).toMatchObject({
            name: MIGRATION_NAME,
            checksum: MIGRATION_CHECKSUM,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM },
        });
        expect(next?.requires).toEqual({ name: MIGRATION_NAME, checksum: MIGRATION_CHECKSUM });
        expect(sql).toContain(`-- Requires migration: ${PREDECESSOR_NAME}`);
        expect(sql).toContain(`-- Requires checksum: ${PREDECESSOR_CHECKSUM}`);
    });

    it('appends call_center to the existing role enum without reordering roles', () => {
        const sql = readMigration();

        expect(sql).toMatch(
            /ALTER TABLE users\s+MODIFY role\s+ENUM\(\s*'admin'\s*,\s*'cashier'\s*,\s*'programmer'\s*,\s*'waiter'\s*,\s*'table_manager'\s*,\s*'call_center'\s*\)\s+NOT NULL\s+DEFAULT\s+'cashier'/i
        );
    });

    it.each([
        ['held_orders', 'idx_held_orders_call_center_user', 'fk_held_orders_call_center_user'],
        ['orders', 'idx_orders_call_center_user', 'fk_orders_call_center_user'],
    ])('adds a nullable source column, index, and restrictive user FK to %s', (table, index, foreignKey) => {
        const sql = readMigration();

        expect(sql).toMatch(new RegExp(
            `ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS call_center_user_id INT NULL\\s*;`,
            'i'
        ));
        expect(sql).toMatch(new RegExp(
            `ALTER TABLE ${table}\\s+ADD INDEX IF NOT EXISTS ${index}\\s*\\(call_center_user_id\\)\\s*;`,
            'i'
        ));
        expect(sql).toMatch(new RegExp(
            `ALTER TABLE ${table}\\s+ADD CONSTRAINT ${foreignKey} FOREIGN KEY IF NOT EXISTS \\(call_center_user_id\\)\\s+REFERENCES users\\s*\\(id\\)\\s+ON DELETE RESTRICT\\s*;`,
            'i'
        ));
    });

    it('preserves existing users, grants, held/orders, operational, financial, print, subscription, audit, and ledger rows', () => {
        const sql = executableSql(readMigration());
        const beforeLedger = sql.split(/INSERT INTO schema_migrations\b/i)[0];

        expect(beforeLedger).not.toMatch(/\b(?:DELETE\s+FROM|UPDATE\s+\w|TRUNCATE(?:\s+TABLE)?|DROP(?:\s+TABLE|\s+COLUMN|\s+INDEX)|RENAME\s+TABLE)\b/i);
        expect(sql).not.toMatch(/\b(?:DROP TABLE|DROP COLUMN|DROP INDEX|TRUNCATE TABLE|RENAME TABLE|DELETE FROM)\b/i);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS call_center_user_id INT NULL/i);
        expect(sql).not.toMatch(/call_center_user_id\s+INT\s+NOT NULL/i);
    });

    it('keeps the normal evidence file additive, idempotent, and ledger-last', () => {
        const sql = readMigration();
        const executable = executableSql(sql);
        const statements = executable.split(';').map((statement) => statement.trim()).filter(Boolean);

        expect(sql).toContain(`-- ${MIGRATION_NAME}`);
        expect(sql).toContain(`'${MIGRATION_NAME}'`);
        expect(sql).toContain(`'${MIGRATION_CHECKSUM}'`);
        expect(sql).toContain('SET NAMES utf8mb4;');
        expect((sql.match(/INSERT INTO schema_migrations\b/gi) || [])).toHaveLength(1);
        expect(statements.at(-1)).toMatch(/^INSERT INTO schema_migrations\s*\(migration_name, checksum\)/i);
        expect(statements.at(-1)).toContain('ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name)');
        expect(sql).not.toMatch(/\b(?:DELIMITER|CREATE\s+PROCEDURE|CALL\s+`|TRIGGER|DEFINER)\b/i);
        expect(sql).not.toMatch(/\.auto\.sql|auto-manifest|hostinger-manual-migrations/i);
    });
});
