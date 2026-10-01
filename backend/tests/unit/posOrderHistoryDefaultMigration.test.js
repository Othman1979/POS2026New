const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-08-31-pos-order-history-default-v1';
const CHECKSUM = crypto.createHash('sha256').update(NAME).digest('hex');
const PREDECESSOR_NAME = '2026-08-30-jofotara-stale-submission-index-v1';
const PREDECESSOR_CHECKSUM = '5c2daeb9a9f20a82a35503906ea8d99303922fea7cd7596186ad6041ae1d56ed';

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

describe('POS order-history default migration authority', () => {
    it('updates only the permission catalog and preserves every existing user grant', () => {
        const normal = normalizeSql(read(`backend/migrations/${NAME}.sql`));

        expect(normal).toContain("'orders.view'");
        expect(normal).toContain("'POS Order History'");
        expect(normal).toMatch(/'orders',\s*100,\s*1,\s*0,\s*0\s*\)/);
        expect(normal).toContain('default_cashier = VALUES(default_cashier)');
        expect(normal).not.toMatch(/(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO\s+|FROM\s+)?user_permissions\b/i);
        expect(normal).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
    });

    it('pins the successor, hashes, preflight, and Hostinger fallback parity', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const targetIndex = manifest.migrations.findIndex(({ name }) => name === NAME);
        const entry = manifest.migrations[targetIndex];

        expect(entry).toMatchObject({
            name: NAME,
            checksum: CHECKSUM,
            file: `${NAME}.auto.sql`,
            preflight: `${NAME}.preflight.sql`,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM }
        });
        expect(manifest.migrations[targetIndex - 1]?.name).toBe(PREDECESSOR_NAME);

        const normal = normalizeSql(read(`backend/migrations/${NAME}.sql`));
        const automatic = normalizeSql(read(`backend/migrations/${NAME}.auto.sql`));
        const preflight = normalizeSql(read(`backend/migrations/${NAME}.preflight.sql`));
        const fallback = normalizeSql(read('deployment/database/hostinger-manual-migrations.sql'));

        expect(normal).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic).digest('hex'));
        expect(entry.preflightSha256).toBe(crypto.createHash('sha256').update(preflight).digest('hex'));
        expect(preflight).toContain(PREDECESSOR_NAME);
        expect(preflight).toContain(PREDECESSOR_CHECKSUM);
        expect(preflight).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|RENAME)\b/i);
        expect(fallbackBlock(fallback)).toBe(automatic.trim());
    });
});
