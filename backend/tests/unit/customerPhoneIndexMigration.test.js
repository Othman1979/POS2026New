import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-09-19-customer-phone-index-v1';
const CHECKSUM = '3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a';
const SQL_SHA = 'a101a059baef02983ef65f8421866dfdd9f4018912a3ffc74101b429baf0007b';
const PREFLIGHT_SHA = '870239801363fc234207e28660efbcf7a3e1a8515ca39e880508d0800ab7bf85';
const PREDECESSOR_NAME = '2026-09-17-print-queue-timings-v1';
const PREDECESSOR_CHECKSUM = '3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e';

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

describe('customer phone index migration authority', () => {
    it('ships one additive migration with exact predecessor, hashes, and fallback parity', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const target = manifest.migrations.find(row => row.name === NAME);
        const normal = read(`backend/migrations/${NAME}.sql`);
        const automatic = read(`backend/migrations/${NAME}.auto.sql`);
        const preflight = read(`backend/migrations/${NAME}.preflight.sql`);
        const fallback = read('deployment/database/hostinger-manual-migrations.sql');
        const begin = `-- BEGIN AUTO MIGRATION: ${NAME} | ${CHECKSUM}\n`;
        const end = `-- END AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;

        expect(target).toEqual({
            name: NAME,
            checksum: CHECKSUM,
            file: `${NAME}.auto.sql`,
            sha256: SQL_SHA,
            preflight: `${NAME}.preflight.sql`,
            preflightSha256: PREFLIGHT_SHA,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM },
        });
        expect(normal).toBe(automatic);
        expect(crypto.createHash('sha256').update(automatic).digest('hex')).toBe(SQL_SHA);
        expect(crypto.createHash('sha256').update(preflight).digest('hex')).toBe(PREFLIGHT_SHA);
        expect(fallback.split(begin)).toHaveLength(2);
        expect(fallback.split(begin)[1].split(end)[0]).toBe(automatic);
        expect(preflight).not.toMatch(/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|RENAME|TRUNCATE)\b/i);
        expect(automatic.split(/INSERT INTO schema_migrations\b/i)[0]).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|RENAME|UPDATE)\b/i);
    });

    it('keeps fresh schema, fixture, bootstrap, and startup authority aligned', () => {
        const baseline = read('deployment/database/baseline.sql');
        const fixture = read('backend/tests/fixtures/seed.js');
        const bootstrap = read('deployment/tools/bootstrap-database.js');
        const validator = read('backend/services/schemaValidation.js');
        for (const schema of [baseline, fixture]) {
            expect(schema).toContain('phone_normalized varchar(20) GENERATED ALWAYS AS');
            expect(schema).toContain('KEY idx_customers_phone_normalized (phone_normalized,id)');
        }
        expect(fixture).toContain(NAME);
        expect(bootstrap).toContain(NAME);
        expect(validator).toContain('customer_phone_normalized_column: 1');
        expect(validator).toContain('customer_phone_normalized_index: 1');
    });

    it('uses the indexed generated column in exact customer lookup', () => {
        const catalog = read('backend/routes/pos/catalog.js');
        expect(catalog).toContain('WHERE c.phone_normalized=?');
        expect(catalog).not.toContain("normalizedPhoneSql('c.phone')");
    });
});
