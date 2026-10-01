const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { catalog, permissionCatalogSql } = require('../../config/permissionCatalog');
const { PERMISSIONS, getCatalog } = require('../../services/PermissionService');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');

const manifest = require('../../migrations/auto-manifest.json');
const target = manifest.migrations.find(row => row.name === '2026-09-14-permission-catalog-v2');
const read = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const sql = read(path.join(__dirname, '../../migrations', target.file));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-permission-catalog-'));
const manifestPath = path.join(directory, 'manifest.json');
// Later migrations add catalog rows this one predates; the repair chain ends with the newest.
const later = manifest.migrations.find(row => row.name === '2026-09-30-multi-terminal-permission-v1');
fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));
const chainManifestPath = path.join(directory, 'chain.json');
fs.writeFileSync(chainManifestPath, JSON.stringify({ migrations: [target, later] }));
fs.copyFileSync(path.join(__dirname, '../../migrations', later.file), path.join(directory, later.file));
const migrate = () => runPendingMigrations(pool, { manifestPath });
const migrateChain = () => runPendingMigrations(pool, { manifestPath: chainManifestPath });
// The later subscriptions retirement removes permissions this catalog migration still ships.
const retirement = manifest.migrations.find(row => row.name === '2026-09-23-subscriptions-retirement-v1');
const retireStatements = splitMysqlScript(read(path.join(__dirname, '../../migrations', retirement.file)))
    .filter(statement => /^DELETE FROM (user_permissions|permissions) WHERE perm_key IN/.test(statement.trim()));
const retiredKeys = [...retireStatements.at(-1).matchAll(/'([a-z_.]+)'/g)].map(match => match[1]);
const retire = async () => { for (const statement of retireStatements) await pool.query(statement); };
const grants = async () => (await pool.query('SELECT user_id,perm_key FROM user_permissions ORDER BY user_id,perm_key'))[0];

describe('complete permission catalog installation and repair', () => {
    beforeEach(seedDatabase);
    afterAll(async () => {
        await pool.end();
        fs.unlinkSync(path.join(directory, target.file));
        fs.unlinkSync(manifestPath);
        fs.unlinkSync(chainManifestPath);
        fs.unlinkSync(path.join(directory, later.file));
        fs.rmdirSync(directory);
    });

    it('repairs an incomplete predecessor catalog without changing staff grants or defaults, and replays safely', async () => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        // Remove only ungranted rows, reproducing an incomplete deployment without deleting staff grants.
        await pool.query('DELETE p FROM permissions p LEFT JOIN user_permissions up ON up.perm_key=p.perm_key WHERE up.user_id IS NULL');
        await pool.query("UPDATE permissions SET label='Old checkout label',default_cashier=0,overridable=1 WHERE perm_key='pos.checkout'");
        const before = await grants();
        const [[predecessor]] = await pool.query('SELECT checksum FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        expect(predecessor.checksum).toBe(target.requires.checksum);
        await expect(validateRequiredSchema(pool)).rejects.toThrow('current_permission_catalog');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [later.name]);
        expect((await migrateChain()).applied).toEqual([target.name, later.name]);
        expect(await grants()).toEqual(before);
        expect((await pool.query('SELECT perm_key FROM permissions'))[0].map(row => row.perm_key).sort()).toEqual([...Object.values(PERMISSIONS), ...retiredKeys].sort());
        await expect(validateRequiredSchema(pool)).rejects.toThrow('retired_subscription_permissions');
        await retire();
        expect(await validateRequiredSchema(pool)).toBe(true);
        const rows = await getCatalog();
        expect(rows.map(row => row.perm_key).sort()).toEqual(Object.values(PERMISSIONS).sort());
        expect(rows.find(row => row.perm_key==='pos.checkout')).toMatchObject({default_cashier:0,overridable:1});
        expect(rows.find(row => row.perm_key==='tables.save')).toMatchObject({implemented:1,default_cashier:0,overridable:0});
        expect((await migrateChain()).applied).toEqual([]);
        for (const statement of splitMysqlScript(sql)) await pool.query(statement);
        expect(await grants()).toEqual(before);
        await retire();
        expect(await validateRequiredSchema(pool)).toBe(true);
    });

    it('detects a missing permission even if the latest migration is already recorded', async () => {
        await pool.query("DELETE FROM permissions WHERE perm_key='tables.save'");
        await expect(validateRequiredSchema(pool)).rejects.toThrow('current_permission_catalog');
    });

    it.each(['missing predecessor', 'predecessor checksum', 'target checksum'])('fails closed for %s', async mode => {
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        await pool.query("DELETE FROM permissions WHERE perm_key='tables.save'");
        const before = await grants();
        if(mode==='missing predecessor') await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.requires.name]);
        else if(mode==='predecessor checksum') await pool.query('UPDATE schema_migrations SET checksum=? WHERE migration_name=?', ['a'.repeat(64),target.requires.name]);
        else await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES(?,?)', [target.name,'b'.repeat(64)]);
        await expect(migrate()).rejects.toThrow(/checksum|requires/);
        expect((await pool.query("SELECT * FROM permissions WHERE perm_key='tables.save'"))[0]).toEqual([]);
        expect(await grants()).toEqual(before);
    });

    it('ships the same catalog in the installer seed, migration and manual fallback', () => {
        expect(catalog.map(row=>row.perm_key).sort()).toEqual(Object.values(PERMISSIONS).sort());
        expect(new Set(catalog.map(row=>row.perm_key)).size).toBe(catalog.length);
        expect(retiredKeys).toEqual(['pos.subscriptions', 'pos.subscription_credit']);
        expect(retiredKeys.some(key => catalog.some(row => row.perm_key === key))).toBe(false);
        const withoutRetired = sql.split('\n').filter(line => !retiredKeys.some(key => line.startsWith(`('${key}',`))).join('\n');
        expect(withoutRetired).toContain(permissionCatalogSql().replace(/,\n\('auth\.multi_terminal'[^\n]*/, ''));
        expect(crypto.createHash('sha256').update(sql).digest('hex')).toBe(target.sha256);
        expect(read(path.join(__dirname,'../../migrations',target.file.replace('.auto.sql','.sql')))).toBe(sql);
        const fallback=read(path.join(__dirname,'../../../deployment/database/hostinger-manual-migrations.sql'));
        expect(fallback.split(`-- BEGIN AUTO MIGRATION: ${target.name} | ${target.checksum}\n`)[1].split(`-- END AUTO MIGRATION: ${target.name}`)[0]).toBe(sql);
        expect(manifest.migrations[manifest.migrations.indexOf(target)-1]).toMatchObject(target.requires);
    });
});
