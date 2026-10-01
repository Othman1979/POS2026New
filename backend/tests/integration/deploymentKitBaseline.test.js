const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { generateFreshDatabaseSql } = require('../../../deployment/tools/export-fresh-database');

const root = path.resolve(__dirname, '../../..');
const seed = "INSERT INTO users (user_number, name, role, admin_pin, is_active, xyz, table_access_scope)\nVALUES ('001234', 'Site Admin', 'admin', NULL, 1, 0, 'all'),\n('123456789012', 'Site Programmer', 'programmer', NULL, 1, 0, 'all');";

describe('exact generated deployment baseline import', () => {
    let directory, sql;
    beforeAll(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-kit-sql-test-'));
        sql = await generateFreshDatabaseSql(seed);
    });
    afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));
    it.each([
        ['current catalog and empty business data', '', '001234', true, null],
        ['missing first-save permission', "DELETE FROM permissions WHERE perm_key='tables.save';", '001234', false, 'Fresh permission catalog'],
        ['unexpected business history', "INSERT INTO customers(name,phone) VALUES('Unexpected customer','12345');", '001234', false, 'Fresh customers must be empty'],
        ['different private login reference', '', '009999', false, 'identity does not match']
    ])('validates %s before reporting success', (_name, mutation, adminNumber, allowed, message) => {
        const source = path.join(directory, 'fresh.sql'), report = path.join(directory, 'report.json'), login = path.join(directory, 'INITIAL-LOGIN.txt');
        fs.writeFileSync(source, `${sql}\n${mutation}\n`);
        fs.writeFileSync(login, `Administrator number: ${adminNumber}\nProgrammer number: 123456789012\n`);
        fs.rmSync(report, { force: true });
        const result = spawnSync(process.execPath, [path.join(root, 'scripts/reviews/fresh-pos-baseline.cjs'), source, report, login], {
            // The validator creates its own fixture. Do not inherit the outer isolated runner's fixed-name preload.
            cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 90000
        });
        expect(result.error).toBeUndefined();
        if (allowed) {
            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toMatchObject({
                pendingMigrations: 0, allBusinessTablesEmpty: true, initialIdentitiesMatch: true, removed: true,
                counts: { orders: 0, customers: 0, deleted: 0, user_permissions: 0 }
            });
        } else {
            expect(result.status).not.toBe(0);
            if (message) expect(result.stderr).toContain(message);
            expect(fs.existsSync(report)).toBe(false);
        }
    }, 100000);
});
