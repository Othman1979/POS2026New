const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');
const NAME = '2026-09-05-recipe-ledger-v1';
const CHECKSUM = crypto.createHash('sha256').update(NAME).digest('hex');
const PREDECESSOR_NAME = '2026-09-03-y-order-type-setting-v1';
const PREDECESSOR_CHECKSUM = '4ce5988110e392f84d029cdd280c90d21eef1cd0d2c86d556bc7df5ac93df4c3';

function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

describe('recipe ledger migration authority', () => {
    it('pins the successor, hashes, SQL copies, and Hostinger fallback', () => {
        const manifest = JSON.parse(read('backend/migrations/auto-manifest.json'));
        const targetIndex = manifest.migrations.findIndex(({ name }) => name === NAME);
        const predecessorIndex = manifest.migrations.findIndex(({ name }) => name === PREDECESSOR_NAME);
        const entry = manifest.migrations[targetIndex];
        const automatic = read(`backend/migrations/${NAME}.auto.sql`);
        const fallback = read('deployment/database/hostinger-manual-migrations.sql');
        const start = `-- BEGIN AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;
        const end = `-- END AUTO MIGRATION: ${NAME} | ${CHECKSUM}`;

        expect(CHECKSUM).toBe('9f9112ea304b683bc33d5710595ff13157f25c87f12b7acbc74c7e299169eecb');
        expect(targetIndex).toBe(predecessorIndex + 1);
        expect(entry).toMatchObject({
            name: NAME,
            checksum: CHECKSUM,
            file: `${NAME}.auto.sql`,
            requires: { name: PREDECESSOR_NAME, checksum: PREDECESSOR_CHECKSUM },
        });
        expect(read(`backend/migrations/${NAME}.sql`)).toBe(automatic);
        expect(entry.sha256).toBe(crypto.createHash('sha256').update(automatic, 'utf8').digest('hex'));
        expect(automatic).toContain('CREATE TABLE IF NOT EXISTS ingredients');
        expect(automatic).toContain('CREATE TABLE IF NOT EXISTS product_recipe_lines');
        expect(automatic).toContain('CREATE TABLE IF NOT EXISTS ingredient_movements');
        expect(automatic).toContain('ADD COLUMN IF NOT EXISTS recipe_line_key char(32) DEFAULT NULL');
        expect(automatic).toContain("INSERT IGNORE INTO settings (setting_key, setting_value)\nVALUES ('recipe_ledger_enabled', '0')");
        expect(automatic).not.toMatch(/\b(?:DELIMITER|PROCEDURE|TRIGGER|DEFINER)\b/i);
        expect(fallback.slice(fallback.indexOf(start) + start.length, fallback.indexOf(end)).trim())
            .toBe(automatic.trim());
        expect(read('backend/tests/fixtures/seed.js')).toContain(NAME);
        expect(read('backend/tests/fixtures/seed.js')).toContain("('recipe_ledger_enabled', '0')");
    });
});
