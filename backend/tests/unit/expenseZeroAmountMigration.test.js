import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-09-02-expense-zero-amount-v1';
const CHECKSUM = crypto.createHash('sha256').update(NAME).digest('hex');
const PREDECESSOR_NAME = '2026-09-01-fractional-stock-precision-v1';
const PREDECESSOR_CHECKSUM = 'b625afece604f1c160c629020bac36e4d931b5a49d460fc44a8c4b269e6c588e';

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('zero-valued expense migration authority', () => {
    it('pins the successor, hashes, SQL copies, constraint, and Hostinger fallback', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const targetIndex = manifest.migrations.findIndex(({ name }) => name === NAME);
        const predecessorIndex = manifest.migrations.findIndex(({ name }) => name === PREDECESSOR_NAME);
        const entry = manifest.migrations[targetIndex];
        const automatic = read(`backend/migrations/${NAME}.auto.sql`);
        const preflight = read(`backend/migrations/${NAME}.preflight.sql`);
        const fallback = read('deployment/database/hostinger-manual-migrations.sql');
        const start = `-- BEGIN AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;

        expect(targetIndex).toBe(predecessorIndex + 1);
        expect(entry).toMatchObject({
            name: NAME,
            checksum: CHECKSUM,
            file: `${NAME}.auto.sql`,
            preflight: `${NAME}.preflight.sql`,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM },
        });
        expect(read(`backend/migrations/${NAME}.sql`)).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic).digest('hex'));
        expect(entry.preflightSha256).toBe(crypto.createHash('sha256').update(preflight).digest('hex'));
        expect(automatic).toContain('ADD CONSTRAINT chk_expenses_amount CHECK (amount >= 0)');
        expect(automatic).not.toMatch(/DELETE\s+FROM\s+expenses|UPDATE\s+expenses/i);
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim())
            .toBe(automatic.trim());

        for (const source of [read('deployment/database/baseline.sql'), read('backend/tests/fixtures/seed.js')]) {
            expect(source).toContain('CONSTRAINT chk_expenses_amount CHECK (amount >= 0)');
        }
        expect(read('backend/tests/fixtures/seed.js')).toContain(NAME);
        expect(read('deployment/tools/bootstrap-database.js')).toContain(NAME);
        const validation = require('../../services/schemaValidation');
        // Later migrations may advance startup's required floor. This upgrade
        // must remain in that ordered chain, not permanently be its last entry.
        const currentIndex = manifest.migrations.findIndex(row => row.name === validation.MIGRATION_NAME);
        expect(currentIndex).toBeGreaterThanOrEqual(targetIndex);
        expect(manifest.migrations[currentIndex].checksum).toBe(validation.MIGRATION_CHECKSUM);
    });
});
