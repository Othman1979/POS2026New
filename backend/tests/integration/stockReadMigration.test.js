const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {runPendingMigrations}=require('../../migrations/runPendingMigrations');
const {validateRequiredSchema}=require('../../services/schemaValidation');
const manifest=require('../../migrations/auto-manifest.json');
// Full startup validation inspects the complete historical schema. Keep its
// query alive to completion before the next case mutates that same fixture.
vi.setConfig({ testTimeout:180_000 });

describe('Stock read index migration',()=>{
    const target=manifest.migrations.find(entry=>entry.name==='2026-09-08-stock-read-index-v1');
    let directory,manifestPath;
    beforeAll(async()=>{
        await seedDatabase();
        directory=fs.mkdtempSync(path.join(os.tmpdir(),'posapp-stock-read-index-'));
        manifestPath=path.join(directory,'manifest.json');
        fs.writeFileSync(manifestPath,JSON.stringify({migrations:[target]}));
        fs.copyFileSync(path.join(__dirname,'../../migrations',target.file),path.join(directory,target.file));
    });
    afterAll(async()=>{
        await pool.end();
        for(const file of ['manifest.json',target.file]) fs.unlinkSync(path.join(directory,file));
        fs.rmdirSync(directory);
    });
    test('upgrades the exact predecessor without changing stock data and reruns as a no-op',async()=>{
        const [item]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Preserved','count','unit','active')");
        const [[before]]=await pool.query('SELECT * FROM stock_items WHERE id=?',[item.insertId]);
        await pool.query('ALTER TABLE stock_items DROP INDEX idx_stock_item_active_name');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[target.name]);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([target.name]);
        const [columns]=await pool.query("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND INDEX_NAME='idx_stock_item_active_name' ORDER BY SEQ_IN_INDEX");
        expect(columns.map(row=>row.COLUMN_NAME)).toEqual(['tracking_state','is_active','name','id']);
        expect((await pool.query('SELECT * FROM stock_items WHERE id=?',[item.insertId]))[0][0]).toEqual(before);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([]);
        await validateRequiredSchema(pool);
    });
    test('rejects a ledger claiming the new floor with the required index missing',async()=>{
        await pool.query('ALTER TABLE stock_items DROP INDEX idx_stock_item_active_name');
        await expect(validateRequiredSchema(pool)).rejects.toThrow(/stock_active_name_index/);
    });
    test('rejects missing and conflicting predecessor evidence',async()=>{
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)',[target.name,target.requires.name]);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[target.requires.name,'wrong']);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
    });
});
