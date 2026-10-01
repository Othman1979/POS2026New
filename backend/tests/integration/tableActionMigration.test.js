const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');

describe('table action receipt migration', () => {
    const name = '2026-09-13-table-action-recovery-v1';
    const manifest = require('../../migrations/auto-manifest.json');
    const target = manifest.migrations.find(row => row.name === name);
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations', target.file), 'utf8').replace(/\r\n/g, '\n');
    let directory, manifestPath;
    beforeAll(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-table-action-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.writeFileSync(path.join(directory, target.file), sql);
    });
    beforeEach(async () => {
        await seedDatabase();
        await pool.query('DROP TABLE table_action_operations');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [name]);
    });
    afterAll(async () => {
        await pool.end();
        for (const file of ['manifest.json', target.file]) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    const migrate = () => runPendingMigrations(pool, { manifestPath });

    it('upgrades the exact predecessor and preserves receipts on repeat startup', async () => {
        const [before] = await pool.query('SELECT * FROM restaurant_tables ORDER BY id');
        const [[previous]] = await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        expect(previous.checksum).toBe(target.requires.checksum);
        await expect(validateRequiredSchema(pool)).rejects.toThrow('table_action_columns');
        expect((await migrate()).applied).toEqual([name]);
        expect(await validateRequiredSchema(pool)).toBe(true);
        await pool.query("INSERT INTO table_action_operations(operation_id,user_id,action,request_hash,result_json) VALUES ('receipt-after-upgrade',1,'swap',?,?)", ['a'.repeat(64), '{"committed":true}']);
        const [receipts] = await pool.query('SELECT * FROM table_action_operations');
        expect((await migrate()).applied).toEqual([]);
        expect((await pool.query('SELECT * FROM table_action_operations'))[0]).toEqual(receipts);
        expect((await pool.query('SELECT * FROM restaurant_tables ORDER BY id'))[0]).toEqual(before);
        await expect(pool.query("INSERT INTO table_action_operations(operation_id,user_id,action,request_hash) VALUES ('receipt-after-upgrade',1,'swap',?)", ['a'.repeat(64)]))
            .rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
        await pool.query('ALTER TABLE table_action_operations DROP INDEX uq_table_action_operation');
        await expect(validateRequiredSchema(pool)).rejects.toThrow('table_action_operation_key');
    });

    it.each(['missing predecessor', 'predecessor checksum', 'target checksum'])('fails closed for %s', async mode => {
        if (mode === 'missing predecessor') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        else if (mode === 'predecessor checksum') await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?', ['a'.repeat(64), target.requires.name]);
        else await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [name, 'a'.repeat(64)]);
        await expect(migrate()).rejects.toThrow(/checksum|requires/);
        const [tables] = await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='table_action_operations'");
        expect(tables).toEqual([]);
    });

    it('ships the same receipt schema in the baseline and exact execution SQL in the manual fallback', () => {
        expect(createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        for (const file of ['baseline.sql', 'hostinger-manual-migrations.sql']) {
            const content = fs.readFileSync(path.join(__dirname, '../../../deployment/database', file), 'utf8').replace(/\r\n/g, '\n');
            expect(content).toContain(file === 'baseline.sql'
                ? sql.match(/CREATE TABLE IF NOT EXISTS table_action_operations[\s\S]*?;\n/)[0]
                : sql);
        }
        expect(manifest.migrations[manifest.migrations.indexOf(target) - 1]).toMatchObject(target.requires);
    });
});
