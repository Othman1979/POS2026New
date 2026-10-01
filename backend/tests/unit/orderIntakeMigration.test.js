import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-09-20-order-intake-requests-v1';
const CHECKSUM = '8c7d856018e4f9871947c2a4cca25a27b8e5397ed276b647f66e88b9798d77ab';
const SQL_SHA = '21a2c623f4d14ef2d7f78628e0175cb85a565e5835552ecfdc59c14b9cb96cfe';
const PREFLIGHT_SHA = '0ee4136d339672c8c770e356d0b1aa710342e0d6482a0037b6aa6fd52c037722';
const PREDECESSOR_NAME = '2026-09-19-customer-phone-index-v1';
const PREDECESSOR_CHECKSUM = '3438435e3ac707d8a184ff84f88acd8f2a220ec8222401752466267c383d527a';

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

describe('order-intake request migration authority', () => {
    it('ships one additive migration with exact predecessor, hashes, and fallback parity', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const target = manifest.migrations.find(entry => entry.name === NAME);
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
            expect(schema).toContain('CREATE TABLE');
            expect(schema).toContain('order_intake_requests');
            expect(schema).toContain('PRIMARY KEY (client_id, external_request_id)');
            expect(schema).toContain('KEY idx_order_intake_held_order (held_order_id)');
            expect(schema).toContain('KEY idx_order_intake_created_at (created_at)');
        }
        expect(fixture).toContain(NAME);
        expect(bootstrap).toContain(NAME);
        expect(validator).toContain("order_intake_requests");
        expect(validator).toContain('order_intake_request_columns: 6');
        expect(validator).toContain('order_intake_request_keys: 3');
        expect(validator).toContain('order_intake_request_checks: 1');
    });
});
