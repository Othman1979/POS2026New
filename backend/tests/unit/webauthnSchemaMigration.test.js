import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-08-13-webauthn-registered-device-access-v1';
const CHECKSUM = '20a660bd124b6691ec35f13575d018ee84d0e1504ea760be45c63502d2b64a09';
const SQL_SHA = '4d29b2be29029f32b402ff5fc923938c04ab8eae74501c55607bc481a3157619';
const PREFLIGHT_SHA = '74a536882348af0633e4ff0365bddb809868b149a7e1ca12d0ece2f16ce330a3';
const PREDECESSOR = '2026-08-13-split-quantity-precision-v1';
const PREDECESSOR_CHECKSUM = 'eeefbd8ab9baed40052468558f88ad84851c8ad6f99630cd7c145902d9cdcc76';

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');

describe('WebAuthn schema migration contract', () => {
    it('pins the exact predecessor, normalized automatic hash, and fallback copy', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const entry = manifest.migrations.find(({ name }) => name === NAME);
        const automatic = read(`backend/migrations/${entry.file}`);
        const normal = read(`backend/migrations/${entry.file.replace(/\.auto\.sql$/, '.sql')}`);
        const fallback = read('deployment/database/hostinger-manual-migrations.sql');
        const start = `-- BEGIN AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;
        const startIndex = fallback.indexOf(start);
        const endIndex = fallback.indexOf(end);

        expect(entry).toMatchObject({
            name: NAME,
            checksum: CHECKSUM,
            file: '2026-08-13-webauthn-registered-device-access.auto.sql',
            sha256: SQL_SHA,
            preflight: '2026-08-13-webauthn-registered-device-access.preflight.sql',
            preflightSha256: PREFLIGHT_SHA,
            requires: { name: PREDECESSOR, checksum: PREDECESSOR_CHECKSUM },
        });
        expect(normal).toBe(automatic);
        expect(crypto.createHash('sha256').update(automatic).digest('hex')).toBe(SQL_SHA);
        expect(startIndex).toBeGreaterThanOrEqual(0);
        expect(endIndex).toBeGreaterThan(startIndex);
        expect(fallback.slice(startIndex + start.length, endIndex).trim()).toBe(automatic.trim());
    });

    it('pins read-only preflight and verification gates', () => {
        const preflight = read('backend/migrations/2026-08-13-webauthn-registered-device-access.preflight.sql');
        const verify = read('backend/migrations/2026-08-13-webauthn-registered-device-access.verify.sql');

        expect(crypto.createHash('sha256').update(preflight).digest('hex')).toBe(PREFLIGHT_SHA);
        expect(preflight).toMatch(/^--[\s\S]*\nSELECT\b/);
        expect(preflight).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|TRUNCATE)\b/i);
        expect(verify).toMatch(/^--[\s\S]*\nSELECT\b/);
        expect(verify).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|REPLACE|TRUNCATE)\b/i);
    });

    it('limits the migration to the registered-device/session authority tables', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const entry = manifest.migrations.find(({ name }) => name === NAME);
        const sql = read(`backend/migrations/${entry.file.replace(/\.auto\.sql$/, '.sql')}`);
        for (const table of ['webauthn_credentials', 'webauthn_ceremonies', 'webauthn_recovery_codes', 'auth_sessions']) {
            expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
        }
        expect(sql).toContain('ADD COLUMN IF NOT EXISTS webauthn_user_handle VARBINARY(64)');
        expect(sql).toContain("'staff_device_auth_mode', 'disabled'");
        expect(sql).toContain("'webauthn_bootstrap_consumed', '0'");
        expect(sql).toContain('DROP COLUMN IF EXISTS session_token');
        expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE|RENAME)\s+(?:TABLE|FROM|DATABASE)\b/i);
        expect(sql).not.toMatch(/WEBAUTHN_BOOTSTRAP_SECRET\s*=/i);
    });
});
