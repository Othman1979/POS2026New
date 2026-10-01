const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');
const manifest = require('../../migrations/auto-manifest.json');
const target = manifest.migrations.find(row => row.name === '2026-09-14-table-access-scope-v1');
const read = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const sql = read(path.join(__dirname, '../../migrations', target.file));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-table-scope-'));
const manifestPath = path.join(directory, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));
const migrate = () => runPendingMigrations(pool, { manifestPath });
const grants = async () => (await pool.query('SELECT user_id,perm_key FROM user_permissions ORDER BY user_id,perm_key'))[0];
const scopes = async () => (await pool.query('SELECT id,table_access_scope,allowed_sections FROM users ORDER BY id'))[0];

describe('explicit table scope migration', () => {
    beforeEach(seedDatabase);
    afterAll(async () => {
        await pool.end();
        fs.unlinkSync(path.join(directory, target.file));
        fs.unlinkSync(manifestPath);
        fs.rmdirSync(directory);
    });

    it('preserves old effective access and every grant, then replays without resetting choices', async () => {
        await pool.query('ALTER TABLE users DROP COLUMN table_access_scope');
        await pool.query("INSERT INTO users(id,name,user_number,role,allowed_sections) VALUES(7,'Blank waiter','7777','waiter',NULL),(8,'Phone desk','8888','call_center','1')");
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        const before = await grants();
        await expect(validateRequiredSchema(pool)).rejects.toThrow('table_access_scope_column');
        expect((await migrate()).applied).toEqual([target.name]);
        expect((await scopes()).map(row => [row.id, row.table_access_scope])).toEqual([[1,'all'],[2,'all'],[3,'selected'],[4,'all'],[5,'all'],[6,'selected'],[7,'none'],[8,'none']]);
        expect(await grants()).toEqual(before);
        expect(await validateRequiredSchema(pool)).toBe(true);
        await pool.query("UPDATE users SET table_access_scope='none' WHERE id=2");
        const chosen = await scopes();
        expect((await migrate()).applied).toEqual([]);
        for (const statement of splitMysqlScript(sql)) await pool.query(statement);
        expect(await scopes()).toEqual(chosen);
    });

    it('resumes an interrupted nullable-column backfill without overwriting an explicit choice', async () => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        await pool.query("ALTER TABLE users MODIFY COLUMN table_access_scope ENUM('all','selected','none') DEFAULT NULL");
        await pool.query('UPDATE users SET table_access_scope=NULL');
        await pool.query("UPDATE users SET table_access_scope='none' WHERE id=2");
        expect((await migrate()).applied).toEqual([target.name]);
        expect((await scopes()).find(row => row.id === 2).table_access_scope).toBe('none');
        expect((await scopes()).find(row => row.id === 3).table_access_scope).toBe('selected');
        expect(await validateRequiredSchema(pool)).toBe(true);
    });

    it.each(['missing predecessor', 'predecessor checksum', 'target checksum'])('fails closed for %s', async mode => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        const before = await scopes();
        if (mode === 'missing predecessor') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        else if (mode === 'predecessor checksum') await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?', ['a'.repeat(64), target.requires.name]);
        else await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES(?,?)', [target.name,'b'.repeat(64)]);
        await expect(migrate()).rejects.toThrow(/checksum|requires/);
        expect(await scopes()).toEqual(before);
    });

    it('ships identical checked SQL and preserves manifest ordering', () => {
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(path.join(__dirname, '../../migrations', target.file.replace('.auto.sql','.sql')))).toBe(sql);
        const fallback = read(path.join(__dirname, '../../../deployment/database/hostinger-manual-migrations.sql'));
        expect(fallback.split(`-- BEGIN AUTO MIGRATION: ${target.name} | ${target.checksum}\n`)[1].split(`-- END AUTO MIGRATION: ${target.name}`)[0]).toBe(sql);
        expect(manifest.migrations[manifest.migrations.indexOf(target)-1]).toMatchObject(target.requires);
    });
});
