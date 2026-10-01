const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const {runPendingMigrations}=require('../../migrations/runPendingMigrations');
const {validateRequiredSchema}=require('../../services/schemaValidation');
const manifest=require('../../migrations/auto-manifest.json');
vi.setConfig({testTimeout:180_000});

describe('Stock report generation migration',()=>{
    const target=manifest.migrations.find(row=>row.name==='2026-09-08-stock-report-generations-v1');
    let directory,manifestPath;
    beforeAll(async()=>{
        await seedDatabase({ legacyStockSchema: true });
        directory=fs.mkdtempSync(path.join(os.tmpdir(),'posapp-report-generations-'));
        manifestPath=path.join(directory,'manifest.json');
        fs.writeFileSync(manifestPath,JSON.stringify({migrations:[target]}));
        fs.copyFileSync(path.join(__dirname,'../../migrations',target.file),path.join(directory,target.file));
    });
    afterAll(async()=>{
        await pool.end();
        for(const name of ['manifest.json',target.file]) fs.unlinkSync(path.join(directory,name));
        fs.rmdirSync(directory);
    });
    test('upgrades the exact predecessor, preserves stock and reruns without deleting published metadata',async()=>{
        const [item]=await pool.query("INSERT INTO stock_items(name,measure,base_unit) VALUES ('Preserved','count','unit')");
        // Later derived tables reference build identities; remove only these
        // empty scratch projections to reconstruct this exact predecessor.
        await pool.query('ALTER TABLE stock_items DROP CONSTRAINT ck_stock_item_availability');
        await pool.query('ALTER TABLE stock_items DROP COLUMN availability_policy');
        await pool.query('DROP TABLE IF EXISTS stock_operation_sources,stock_ingredient_links');
        await pool.query("DELETE FROM schema_migrations WHERE migration_name='2026-09-08-stock-ingredient-cutover-v1'");
        await pool.query("DELETE FROM schema_migrations WHERE migration_name='2026-09-08-stock-availability-policy-v1'");
        await pool.query('DROP TABLE stock_report_daily,stock_report_count_corrections,stock_report_counts,stock_report_backfill');
        await pool.query("DELETE FROM schema_migrations WHERE migration_name IN ('2026-09-08-stock-report-backfill-v1','2026-09-08-stock-report-count-intervals-v1','2026-09-08-stock-report-daily-projection-v1')");
        await pool.query('DROP TABLE stock_report_meals,stock_report_ingredients,stock_report_events,stock_report_operations');
        await pool.query("DELETE FROM schema_migrations WHERE migration_name='2026-09-08-stock-report-facts-v1'");
        await pool.query('DROP TABLE stock_report_dirty,stock_report_worker,stock_report_builds');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[target.name]);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([target.name]);
        expect((await pool.query('SELECT name FROM stock_items WHERE id=?',[item.insertId]))[0][0].name).toBe('Preserved');
        const reports=require('../../services/StockReportGenerationService');
        await reports.markDirty(pool,[{day:'2026-09-08',scope_id:1}]);
        const build=await reports.claim(pool); await reports.publish(pool,build);
        expect((await runPendingMigrations(pool,{manifestPath})).applied).toEqual([]);
        expect((await reports.status(pool,{startDate:'2026-09-08'}))[0].published_build_id).toBe(build.build_id);
        await runPendingMigrations(pool);
        await validateRequiredSchema(pool);
    });
    test('rejects a falsely current ledger when the installation worker lease table is missing',async()=>{
        await pool.query('DROP TABLE stock_report_worker');
        await expect(validateRequiredSchema(pool)).rejects.toThrow(/stock_report_generation/);
    });
    test('refuses missing or conflicting predecessor evidence',async()=>{
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)',[target.name,target.requires.name]);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)',[target.requires.name,'wrong']);
        await expect(runPendingMigrations(pool,{manifestPath})).rejects.toThrow();
    });
});
