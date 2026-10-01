import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-09-17-print-queue-timings-v1';
const CHECKSUM = '3bc2bd5d5fb08f32ded8952ee570408c33bb493efd97b206d8bd09d0205d687e';
const SQL_SHA = '5807e7ba881f19b9ba3d0ad31704d69f80d3ec3f0fd1f1fbf6e1e112d2f47b40';
const PREDECESSOR_NAME = '2026-09-14-permission-catalog-v2';
const PREDECESSOR_CHECKSUM = 'a5b95c9e6d4e4239a1f0d516b95db7aa2580c4af19e70bfe9a16f3c5edd97408';

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('print queue timing migration authority', () => {
    it('ships one additive online migration through every deployment path', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const targetIndex = manifest.migrations.findIndex(row => row.name === NAME);
        const target = manifest.migrations[targetIndex];
        const normal = read(`backend/migrations/${NAME}.sql`);
        const automatic = read(`backend/migrations/${NAME}.auto.sql`);
        const fallback = read('deployment/database/hostinger-manual-migrations.sql');
        const start = `-- BEGIN AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;

        expect(targetIndex).toBeGreaterThanOrEqual(0);
        expect(manifest.migrations[targetIndex + 1].requires).toEqual({ name: NAME, checksum: CHECKSUM });
        expect(target).toMatchObject({
            name: NAME,
            checksum: CHECKSUM,
            file: `${NAME}.auto.sql`,
            sha256: SQL_SHA,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM }
        });
        expect(normal).toBe(automatic);
        expect(crypto.createHash('sha256').update(automatic).digest('hex')).toBe(SQL_SHA);
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim())
            .toBe(automatic.trim());
        expect(automatic).toContain('ALGORITHM=INSTANT, LOCK=NONE');
        expect(automatic.split(/INSERT INTO schema_migrations\b/i)[0])
            .not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|RENAME|UPDATE)\b/i);
    });

    it('keeps the fresh schema, fixture, bootstrap ledger, and startup authority aligned', () => {
        const baseline = read('deployment/database/baseline.sql');
        const fixture = read('backend/tests/fixtures/seed.js');
        const bootstrap = read('deployment/tools/bootstrap-database.js');
        const validator = read('backend/services/schemaValidation.js');
        const expectedColumns = [
            'render_duration_ms int unsigned DEFAULT NULL',
            'local_duration_ms int unsigned DEFAULT NULL',
            'renderer varchar(16) DEFAULT NULL',
            'transport_mode varchar(24) DEFAULT NULL'
        ];

        for (const schema of [baseline, fixture]) {
            for (const column of expectedColumns) expect(schema.toLowerCase()).toContain(column.toLowerCase());
        }
        expect(fixture).toContain(NAME);
        expect(bootstrap).toContain(NAME);
        expect(validator).toContain("'render_duration_ms', 'local_duration_ms', 'renderer', 'transport_mode'");
        expect(validator).toContain('print_queue_columns: 30');
    });
});
