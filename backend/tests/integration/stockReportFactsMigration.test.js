const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {runPendingMigrations,splitMysqlScript}=require('../../migrations/runPendingMigrations');
const {validateRequiredSchema}=require('../../services/schemaValidation');
const generations=require('../../services/StockReportGenerationService');
const manifest=require('../../migrations/auto-manifest.json');
vi.setConfig({testTimeout:180_000});

describe('Stock report fact migration',()=>{
    const target=manifest.migrations.find(row=>row.name==='2026-09-08-stock-report-facts-v1');
    let directory,manifestPath;
    beforeAll(async()=>{
        await seedDatabase({ legacyStockSchema: true });directory=fs.mkdtempSync(path.join(os.tmpdir(),'posapp-report-facts-'));
        manifestPath=path.join(directory,'manifest.json');fs.writeFileSync(manifestPath,JSON.stringify({migrations:[target]}));
        fs.copyFileSync(path.join(__dirname,'../../migrations',target.file),path.join(directory,target.file));
    });
    afterAll(async()=>{
        await pool.end();for(const file of ['manifest.json',target.file])fs.unlinkSync(path.join(directory,file));fs.rmdirSync(directory);
    });
    test('upgrades the exact predecessor, invalidates metadata-only publications and preserves sources',async()=>{
        await pool.query('ALTER TABLE order_items ADD INDEX fixture_parent_invoice (parent_item_id,invoice_id)');
        await pool.query('ALTER TABLE order_items DROP INDEX idx_order_items_parent_invoice');
        const [item]=await pool.query("INSERT INTO stock_items(name,measure,base_unit) VALUES ('Preserved','count','unit')");
        await generations.markDirty(pool,[{day:'2026-09-07',scope_id:1}]);
        const old=await generations.claim(pool);await generations.publish(pool,old);
        await pool.query('ALTER TABLE stock_items DROP CONSTRAINT ck_stock_item_availability');
        await pool.query('ALTER TABLE stock_items DROP COLUMN availability_policy');
        await pool.query('DROP TABLE IF EXISTS stock_operation_sources,stock_ingredient_links');
        await pool.query("DELETE FROM schema_migrations WHERE migration_name='2026-09-08-stock-ingredient-cutover-v1'");
        await pool.query("DELETE FROM schema_migrations WHERE migration_name='2026-09-08-stock-availability-policy-v1'");
        await pool.query('DROP TABLE stock_report_meals,stock_report_ingredients,stock_report_events,stock_report_operations');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[target.name]);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([target.name]);
        expect((await pool.query('SELECT name FROM stock_items WHERE id=?',[item.insertId]))[0][0].name).toBe('Preserved');
        expect((await generations.status(pool,{startDate:'2026-09-07'}))[0]).toMatchObject({pending:true,published_build_id:null,generation:'2'});
        expect((await pool.query('SELECT state FROM stock_report_builds WHERE id=?',[old.build_id]))[0][0].state).toBe('obsolete');
        const current=await generations.claim(pool);await generations.publish(pool,current);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([]);
        // The cumulative manual fallback may be pasted twice. Its guarded
        // invalidation must not revoke a publication after the first install.
        for(const statement of splitMysqlScript(fs.readFileSync(path.join(directory,target.file),'utf8'))) await pool.query(statement);
        expect((await generations.status(pool,{startDate:'2026-09-07'}))[0]).toMatchObject({pending:false,published_build_id:current.build_id,generation:'2'});
        await runPendingMigrations(pool);
        await validateRequiredSchema(pool);
    });
    test('rejects a same-shaped index with the wrong required name',async()=>{
        // Validate corruption separately: two full startup validations in one
        // case can time out while the first query is still using this fixture.
        await pool.query('ALTER TABLE order_items DROP INDEX idx_order_items_parent_invoice');
        try { await expect(validateRequiredSchema(pool)).rejects.toThrow(/stock_report_fact_keys/); }
        finally { await pool.query('ALTER TABLE order_items ADD INDEX idx_order_items_parent_invoice (parent_item_id,invoice_id)'); }
    });
    test('fails closed on a missing or conflicting predecessor',async()=>{
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)',[target.name,target.requires.name]);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[target.requires.name,'wrong']);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
    });
});
