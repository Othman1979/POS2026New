const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-08-30-jofotara-stale-submission-index-v1';
const CHECKSUM = crypto.createHash('sha256').update(NAME).digest('hex');
const PREDECESSOR_NAME = '2026-08-23-audit-browser-preview-v1';
const PREDECESSOR_CHECKSUM = 'e76a5c6a6ff9e831d6c5e5f5d907ba01732f5cd6446b231cc732b9e7728198af';
const INDEX_DEFINITION = 'KEY idx_jofotara_status_attempt (status, last_attempt_at)';

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function normalizeSql(value) {
    return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function fallbackBlock(fallback) {
    const start = `-- BEGIN AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;
    const end = `-- END AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;
    const startIndex = fallback.indexOf(start);
    const endIndex = fallback.indexOf(end);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return fallback.slice(startIndex + start.length, endIndex).trim();
}

describe('JoFotara stale-submission index migration authority', () => {
    it('pins the exact successor, hashes, additive SQL, and Hostinger fallback parity', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const predecessorIndex = manifest.migrations.findIndex(({ name }) => name === PREDECESSOR_NAME);
        const targetIndex = manifest.migrations.findIndex(({ name }) => name === NAME);
        const entry = manifest.migrations[targetIndex];

        expect(entry).toMatchObject({
            name: NAME,
            checksum: CHECKSUM,
            file: `${NAME}.auto.sql`,
            preflight: `${NAME}.preflight.sql`,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM }
        });
        expect(targetIndex).toBe(predecessorIndex + 1);

        const normal = normalizeSql(read(`backend/migrations/${NAME.replace(/-v1$/, '')}.sql`));
        const automatic = normalizeSql(read(`backend/migrations/${NAME}.auto.sql`));
        const preflight = normalizeSql(read(`backend/migrations/${NAME}.preflight.sql`));
        const fallback = normalizeSql(read('deployment/database/hostinger-manual-migrations.sql'));

        expect(normal).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic).digest('hex'));
        expect(entry.preflightSha256).toBe(crypto.createHash('sha256').update(preflight).digest('hex'));
        expect(automatic).toContain('ADD INDEX IF NOT EXISTS idx_jofotara_status_attempt (status, last_attempt_at)');
        expect(automatic).toContain('ALGORITHM=INPLACE, LOCK=NONE');
        expect(automatic).not.toMatch(/\b(?:DELIMITER|PROCEDURE|TRIGGER|DEFINER|DROP|DELETE|TRUNCATE|RENAME)\b/i);
        expect(preflight).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|RENAME)\b/i);
        expect(fallbackBlock(fallback)).toBe(automatic.trim());
    });

    it('makes the index and ledger part of every fresh-schema authority surface', () => {
        expect(read('deployment/database/baseline.sql')).toContain(INDEX_DEFINITION);
        expect(read('backend/tests/fixtures/seed.js')).toContain(INDEX_DEFINITION);
        expect(read('backend/tests/fixtures/seed.js')).toContain(NAME);
        expect(read('deployment/tools/bootstrap-database.js')).toContain(NAME);

        expect(read('backend/services/schemaValidation.js')).toContain('jofotara_stale_submission_index: 1');
    });

    it('preflights the predecessor, required columns, and absent-or-exact named index shape', () => {
        const preflight = normalizeSql(read(`backend/migrations/${NAME}.preflight.sql`));
        const statements = preflight.split(';').map(value => value.trim()).filter(Boolean);
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/^(?:--[^\n]*\n\s*)*SELECT\b/i);
        expect(preflight).toContain(PREDECESSOR_NAME);
        expect(preflight).toContain(PREDECESSOR_CHECKSUM);
        expect(preflight).toContain("COLUMN_NAME IN ('status', 'last_attempt_at')");
        expect(preflight).toContain("INDEX_NAME = 'idx_jofotara_status_attempt'");
        expect(preflight).toContain('AS ok');
    });
});
