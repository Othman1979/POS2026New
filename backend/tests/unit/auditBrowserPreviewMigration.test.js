const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../..', '..');
const NAME = '2026-08-23-audit-browser-preview-v1';
const PREDECESSOR_NAME = '2026-08-17-spooler-v2-agents-v1';
const PREDECESSOR_CHECKSUM = 'e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985';
const CHECKSUM = crypto.createHash('sha256').update(NAME).digest('hex');
const AUTO_FILE = `${NAME}.auto.sql`;
const PREFLIGHT_FILE = `${NAME}.preflight.sql`;

function normalizeSql(value) {
    return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function blockFromFallback(fallback, name, checksum) {
    const start = `-- BEGIN AUTO MIGRATION: ${name} | ${checksum}`;
    const end = `-- END AUTO MIGRATION: ${name} | ${checksum}`;
    const startIndex = fallback.indexOf(start);
    const endIndex = fallback.indexOf(end);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return fallback.slice(startIndex + start.length, endIndex).trim();
}

describe('audit browser preview migration authority', () => {
    it('pins the successor chain, hashes, and exact Hostinger-safe delivery parity', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const entry = manifest.migrations.find((migration) => migration.name === NAME);
        const predecessorIndex = manifest.migrations.findIndex((migration) => migration.name === PREDECESSOR_NAME);
        const targetIndex = manifest.migrations.findIndex((migration) => migration.name === NAME);

        expect(entry).toMatchObject({
            name: NAME,
            checksum: CHECKSUM,
            file: AUTO_FILE,
            preflight: PREFLIGHT_FILE,
            requires: {
                name: PREDECESSOR_NAME,
                checksum: PREDECESSOR_CHECKSUM,
            },
        });
        expect(targetIndex).toBe(predecessorIndex + 1);

        const normal = normalizeSql(read(`backend/migrations/${NAME.replace(/-v1$/, '')}.sql`));
        const automatic = normalizeSql(read(`backend/migrations/${AUTO_FILE}`));
        const preflight = normalizeSql(read(`backend/migrations/${PREFLIGHT_FILE}`));
        const fallback = normalizeSql(read('deployment/database/hostinger-manual-migrations.sql'));

        expect(normal).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic, 'utf8').digest('hex'));
        expect(entry.preflightSha256).toBe(crypto.createHash('sha256').update(preflight, 'utf8').digest('hex'));
        expect(automatic).not.toMatch(/\b(?:DELIMITER|PROCEDURE|TRIGGER|DEFINER|DROP|DELETE|TRUNCATE|RENAME)\b/i);
        expect(preflight).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|RENAME)\b/i);
        expect(blockFromFallback(fallback, NAME, CHECKSUM)).toBe(automatic.trim());
    });

    it('appends browser_ready without changing the existing audit status order', () => {
        const expected = "ENUM('queued','printed','failed','browser_ready') NOT NULL DEFAULT 'queued'";
        const baseline = read('deployment/database/baseline.sql');
        const fixture = read('backend/tests/fixtures/seed.js');
        const migration = normalizeSql(read(`backend/migrations/${NAME.replace(/-v1$/, '')}.sql`));

        expect(baseline).toContain(expected);
        expect(fixture).toContain(expected);
        expect(migration).toContain(expected);
        expect(migration).toMatch(/ALTER TABLE audit_report_documents[\s\S]*MODIFY COLUMN last_print_status/);
        expect(migration).toContain('ALGORITHM=INSTANT');
        expect(migration).toContain('LOCK=NONE');
        expect((migration.match(/browser_ready/g) || []).length).toBe(1);
    });

    it('uses a read-only preflight that accepts only the exact old or new enum', () => {
        const preflight = normalizeSql(read(`backend/migrations/${PREFLIGHT_FILE}`));
        const statements = preflight.split(';').map((statement) => statement.trim()).filter(Boolean);
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/^(?:--[^\n]*\n\s*)*SELECT\b/i);
        expect(preflight).toContain(PREDECESSOR_NAME);
        expect(preflight).toContain(PREDECESSOR_CHECKSUM);
        expect(preflight).toContain("'enum(''queued'',''printed'',''failed'')'");
        expect(preflight).toContain("'enum(''queued'',''printed'',''failed'',''browser_ready'')'");
        expect(preflight).toContain('AS ok');
        expect(preflight).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|RENAME)\b/i);
    });
});
