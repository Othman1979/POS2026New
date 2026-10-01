import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../../..');
const TARGET_NAME = '2026-08-11-receipt-tax-display-v1';
const TARGET_CHECKSUM = '90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3';
const TARGET_SQL_SHA = '8871974f40069bca8cdb92f6bc5a986578c365fec505d9cc67efa4528836d794';
const PREDECESSOR_NAME = '2026-08-10-call-center-held-orders-v1';
const PREDECESSOR_CHECKSUM = 'f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b';
const PREDECESSOR_SQL_SHA = 'f1b384472c35fc84e30d7c970582cef03964a51773e7ea61c658bd77829121bc';

function read(relative) {
    return fs.readFileSync(path.join(REPO, relative), 'utf8').replace(/\r\n/g, '\n');
}

function executableSql(sql) {
    return sql.replace(/^\s*--.*$/gm, '').trim();
}

describe('receipt tax display migration contract', () => {
    it('follows the exact call-center predecessor and pins the normalized SQL hash', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const predecessor = manifest.migrations.find(({ name }) => name === PREDECESSOR_NAME);
        const targetIndex = manifest.migrations.findIndex(({ name }) => name === TARGET_NAME);
        const target = manifest.migrations[targetIndex];

        expect(predecessor).toMatchObject({
            name: PREDECESSOR_NAME,
            checksum: PREDECESSOR_CHECKSUM,
            sha256: PREDECESSOR_SQL_SHA,
        });
        expect(targetIndex).toBeGreaterThanOrEqual(0);
        expect(target).toMatchObject({
            name: TARGET_NAME,
            checksum: TARGET_CHECKSUM,
            file: `${TARGET_NAME}.auto.sql`,
            sha256: TARGET_SQL_SHA,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM },
        });
    });

    it('keeps normal, automatic, and fallback SQL byte-identical after line-ending normalization', () => {
        const normal = read(`backend/migrations/${TARGET_NAME}.sql`);
        const automatic = read(`backend/migrations/${TARGET_NAME}.auto.sql`);
        const fallback = read('deployment/database/hostinger-manual-migrations.sql');
        const start = `-- BEGIN AUTO MIGRATION: ${TARGET_NAME} | ${TARGET_CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${TARGET_NAME} | ${TARGET_CHECKSUM}`;
        const startIndex = fallback.indexOf(start);
        const endIndex = fallback.indexOf(end);

        expect(normal).toBe(automatic);
        expect(crypto.createHash('sha256').update(automatic).digest('hex')).toBe(TARGET_SQL_SHA);
        expect(startIndex).toBeGreaterThanOrEqual(0);
        expect(endIndex).toBeGreaterThan(startIndex);
        expect(fallback.slice(startIndex + start.length, endIndex).trim()).toBe(automatic.trim());
    });

    it('adds only the nullable receipt snapshot and records it last without changing money', () => {
        const sql = read(`backend/migrations/${TARGET_NAME}.sql`);
        const executable = executableSql(sql);
        const beforeLedger = executable.split(/INSERT INTO schema_migrations\b/i)[0];
        const statements = executable.split(';').map((statement) => statement.trim()).filter(Boolean);

        expect(sql).toContain(`-- Requires migration: ${PREDECESSOR_NAME}`);
        expect(sql).toContain(`-- Requires checksum: ${PREDECESSOR_CHECKSUM}`);
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS receipt_tax_inclusive_at_sale TINYINT(1) NULL');
        expect(beforeLedger).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|DROP|RENAME)\b/i);
        expect(sql).not.toMatch(/\b(?:DELETE\s+FROM|DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|RENAME)\b/i);
        expect((sql.match(/INSERT INTO schema_migrations\b/gi) || [])).toHaveLength(1);
        expect(statements.at(-1)).toMatch(/^INSERT INTO schema_migrations\s*\(migration_name, checksum\)/i);
        expect(statements.at(-1)).toContain(`'${TARGET_NAME}'`);
        expect(statements.at(-1)).toContain(`'${TARGET_CHECKSUM}'`);
    });

    it('keeps fresh and test schema authorities aligned with the nullable column and ledger', () => {
        const baseline = read('deployment/database/baseline.sql');
        const fixture = read('backend/tests/fixtures/seed.js');
        const bootstrap = read('deployment/tools/bootstrap-database.js');
        const validator = read('backend/services/schemaValidation.js');
        const installer = read('backend/tests/integration/installerBaseline.test.js');

        for (const schema of [baseline, fixture]) {
            expect(schema).toMatch(/tax_inclusive_at_sale[^\n]*\n\s+receipt_tax_inclusive_at_sale tinyint\(1\) DEFAULT NULL/i);
        }
        expect(bootstrap).toContain(TARGET_NAME);
        expect(installer).toContain(TARGET_NAME);
        expect(validator).toContain('receipt_tax_inclusive_at_sale');
    });
});
