const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {runPendingMigrations,splitMysqlScript}=require('../../migrations/runPendingMigrations');
const {validateRequiredSchema}=require('../../services/schemaValidation');
const manifest=require('../../migrations/auto-manifest.json');
vi.setConfig({testTimeout:180000});

describe('Stock availability policy migration',()=>{
    const target=manifest.migrations.find(row=>row.name==='2026-09-08-stock-availability-policy-v1');
    let directory,manifestPath;
    beforeAll(async()=>{
        await seedDatabase({ legacyStockSchema: true });directory=fs.mkdtempSync(path.join(os.tmpdir(),'posapp-stock-availability-'));
        manifestPath=path.join(directory,'manifest.json');fs.writeFileSync(manifestPath,JSON.stringify({migrations:[target]}));
        fs.copyFileSync(path.join(__dirname,'../../migrations',target.file),path.join(directory,target.file));
    });
    afterAll(async()=>{
        await pool.end();for(const file of ['manifest.json',target.file])fs.unlinkSync(path.join(directory,file));fs.rmdirSync(directory);
    });
    test('upgrades the exact predecessor, defaults existing stock to strict and preserves an explicit policy on rerun',async()=>{
        const [item]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Existing packaged stock','count','unit','active')");
        const [lot]=await pool.query("INSERT INTO stock_lots(stock_item_id,lot_code,is_default) VALUES (?,'default',1)",[item.insertId]);
        const [[location]]=await pool.query("SELECT id FROM stock_locations WHERE code='default'");
        await pool.query('INSERT INTO stock_balances(stock_item_id,location_id,lot_id,quantity,quantity_known,version) VALUES (?,?,?,7.125,1,9)',[item.insertId,location.id,lot.insertId]);
        await pool.query('ALTER TABLE stock_items DROP CONSTRAINT ck_stock_item_availability');
        await pool.query('ALTER TABLE stock_items DROP COLUMN availability_policy');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[target.name]);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([target.name]);
        expect((await pool.query('SELECT availability_policy FROM stock_items WHERE id=?',[item.insertId]))[0][0].availability_policy).toBe('strict');
        expect((await pool.query('SELECT CAST(quantity AS CHAR) quantity,quantity_known,version FROM stock_balances WHERE stock_item_id=?',[item.insertId]))[0][0]).toMatchObject({quantity:'7.125000',quantity_known:1,version:9});
        await pool.query("UPDATE stock_items SET availability_policy='estimate' WHERE id=?",[item.insertId]);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([]);
        for(const sql of splitMysqlScript(fs.readFileSync(path.join(directory,target.file),'utf8')))await pool.query(sql);
        expect((await pool.query('SELECT availability_policy FROM stock_items WHERE id=?',[item.insertId]))[0][0].availability_policy).toBe('estimate');
        await expect(pool.query("UPDATE stock_items SET availability_policy='invalid' WHERE id=?",[item.insertId])).rejects.toThrow('ck_stock_item_availability');
        await runPendingMigrations(pool);
        await validateRequiredSchema(pool);
    });
    test('fails closed on missing predecessor evidence and required schema, even when column totals match',async()=>{
        await pool.query('ALTER TABLE stock_items DROP CONSTRAINT ck_stock_item_availability');
        await pool.query('ALTER TABLE stock_movements CHANGE COLUMN source_line fixture_source_line VARCHAR(100) DEFAULT NULL');
        const failure=await validateRequiredSchema(pool).catch(error=>error);
        expect(failure.message).toMatch(/stock_availability_check/);
        expect(failure.message).toMatch(/stock_core_columns/);
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)',[target.name,target.requires.name]);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[target.requires.name,'wrong']);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
    });
});
