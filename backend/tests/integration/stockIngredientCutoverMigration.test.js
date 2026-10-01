const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');
const manifest = require('../../migrations/auto-manifest.json');
vi.setConfig({ testTimeout: 180000 });

describe('Ingredient cutover provenance migration', () => {
    const target = manifest.migrations.find(row => row.name === '2026-09-08-stock-ingredient-cutover-v1');
    let directory, manifestPath;
    beforeAll(async () => {
        await seedDatabase({ legacyStockSchema: true });
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-ingredient-cutover-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));
    });
    afterAll(async () => {
        await pool.end();
        for (const file of ['manifest.json', target.file]) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    test('upgrades the exact predecessor, preserves existing stock and reruns without dropping links', async () => {
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Preserved packaged','count','unit','active')");
        await pool.query('DROP TABLE stock_operation_sources,stock_ingredient_links');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
        expect((await pool.query('SELECT name FROM stock_items WHERE id=?', [item.insertId]))[0][0].name).toBe('Preserved packaged');
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([]);
        for (const sql of splitMysqlScript(fs.readFileSync(path.join(directory, target.file), 'utf8'))) await pool.query(sql);
        // The current validator describes the current schema, after successors.
        await runPendingMigrations(pool);
        await validateRequiredSchema(pool);
    });
    test('fails closed on missing predecessor evidence and required schema', async () => {
        await pool.query('DROP TABLE stock_operation_sources');
        const failure = await validateRequiredSchema(pool).catch(error => error);
        expect(failure.message).toMatch(/stock_ingredient_cutover/);
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)', [target.name, target.requires.name]);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [target.requires.name, 'wrong']);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    });
});
