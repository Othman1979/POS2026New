const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-09-01-fractional-stock-precision-v1';
const CHECKSUM = crypto.createHash('sha256').update(NAME).digest('hex');
const PREDECESSOR_NAME = '2026-09-01-product-price-override-lock-v1';
const PREDECESSOR_CHECKSUM = 'e04d158c0236de84de1f01aadc75f88f06468fd90dbd43b87aa5dce68cf8bfb8';

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

describe('fractional stock precision migration authority', () => {
    it('pins the successor, hashes, SQL copies, and Hostinger fallback', () => {
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

        const normal = normalizeSql(read(`backend/migrations/${NAME}.sql`));
        const automatic = normalizeSql(read(`backend/migrations/${NAME}.auto.sql`));
        const preflight = normalizeSql(read(`backend/migrations/${NAME}.preflight.sql`));
        const fallback = normalizeSql(read('deployment/database/hostinger-manual-migrations.sql'));

        expect(normal).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic).digest('hex'));
        expect(entry.preflightSha256).toBe(crypto.createHash('sha256').update(preflight).digest('hex'));
        expect(automatic).toContain('MODIFY COLUMN stock DECIMAL(16,6) DEFAULT NULL');
        expect(automatic).toContain('MODIFY COLUMN min_stock_level DECIMAL(16,6) DEFAULT 10');
        expect(automatic).toContain('MODIFY COLUMN max_stock_level DECIMAL(16,6) DEFAULT 100');
        expect(automatic).toContain('ALGORITHM=COPY, LOCK=SHARED');
        expect(fallbackBlock(fallback)).toBe(automatic.trim());
    });

    it('keeps every fresh-schema authority at the same precision and ledger tip', () => {
        for (const source of [read('deployment/database/baseline.sql'), read('backend/tests/fixtures/seed.js')]) {
            expect(source).toContain('stock decimal(16,6) DEFAULT NULL');
            expect(source).toContain('min_stock_level decimal(16,6) DEFAULT 10');
            expect(source).toContain('max_stock_level decimal(16,6) DEFAULT 100');
        }
        expect(read('backend/tests/fixtures/seed.js')).toContain(NAME);
        expect(read('deployment/tools/bootstrap-database.js')).toContain(NAME);

        expect(read('backend/services/schemaValidation.js')).toContain('product_stock_precision: 3');
    });

    it('preflights only the exact complete legacy or target shape', () => {
        const preflight = normalizeSql(read(`backend/migrations/${NAME}.preflight.sql`));
        expect(preflight).toContain(PREDECESSOR_NAME);
        expect(preflight).toContain(PREDECESSOR_CHECKSUM);
        expect(preflight).toContain('legacy_shape_count = 3');
        expect(preflight).toContain('target_shape_count = 3');
        expect(preflight).toContain("COLUMN_NAME IN ('stock', 'min_stock_level', 'max_stock_level')");
        expect(preflight).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|RENAME)\b/i);
    });
});
