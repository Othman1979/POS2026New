const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { validateRequiredSchema } = require('../../services/schemaValidation');
const manifest = require('../../migrations/auto-manifest.json');
vi.setConfig({ testTimeout: 180000 });

describe('Stock procurement migration', () => {
    const target = manifest.migrations.find(row => row.name === '2026-09-08-stock-procurement-v1');
    let directory, manifestPath;
    beforeAll(async () => {
        await seedDatabase({ legacyStockSchema: true });
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-stock-procurement-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.copyFileSync(path.join(__dirname, '../../migrations', target.file), path.join(directory, target.file));
    });
    afterAll(async () => {
        await pool.end();
        for (const file of ['manifest.json', target.file]) fs.unlinkSync(path.join(directory, file));
        fs.rmdirSync(directory);
    });
    test('upgrades the exact predecessor, preserves stock identities and reruns without dropping columns', async () => {
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Preserved procurement','count','unit','active')");
        await pool.query('SET FOREIGN_KEY_CHECKS=0');
        for (const table of ['stock_price_adjustment_lines', 'stock_price_adjustments', 'stock_vendor_return_lines', 'stock_vendor_returns', 'stock_receipt_lines', 'stock_receipts', 'stock_purchase_order_lines', 'stock_purchase_orders', 'stock_supplier_items', 'stock_suppliers']) {
            await pool.query(`DROP TABLE IF EXISTS ${table}`);
        }
        await pool.query('SET FOREIGN_KEY_CHECKS=1');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?', [target.name]);
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([target.name]);
        expect((await pool.query('SELECT name FROM stock_items WHERE id=?', [item.insertId]))[0][0].name).toBe('Preserved procurement');
        expect((await runPendingMigrations(pool, { manifestPath })).applied).toEqual([]);
        for (const sql of splitMysqlScript(fs.readFileSync(path.join(directory, target.file), 'utf8'))) await pool.query(sql);
        const integrity=manifest.migrations.find(row=>row.name==='2026-09-08-procurement-request-integrity-v1');
        for(const sql of splitMysqlScript(fs.readFileSync(path.join(__dirname,'../../migrations',integrity.file),'utf8')))await pool.query(sql);
        await runPendingMigrations(pool);
        await validateRequiredSchema(pool);
    });
    test('request integrity upgrades its exact predecessor and reruns without changing schema',async()=>{
        await seedDatabase({ legacyStockSchema: true });
        const integrity=manifest.migrations.find(row=>row.name==='2026-09-08-procurement-request-integrity-v1');
        const [created]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Return migration','count','unit','active')");
        const item={id:created.insertId};
        const [lot]=await pool.query("INSERT INTO stock_lots(stock_item_id,lot_code,is_default) VALUES (?,'default',1)",[item.id]);
        const [[location]]=await pool.query("SELECT id FROM stock_locations WHERE code='default'");
        const [receipt]=await pool.query("INSERT INTO stock_receipts(status,business_date) VALUES ('posted','2026-09-08')");
        const [line]=await pool.query('INSERT INTO stock_receipt_lines(receipt_id,line_ordinal,stock_item_id,location_id,lot_id,pack_qty,packs,loose,received_qty) VALUES (?,1,?,?,?,1,10,0,10)',[receipt.insertId,item.id,location.id,lot.insertId]);
        const [returned]=await pool.query("INSERT INTO stock_vendor_returns(receipt_id,status,business_date) VALUES (?,'posted','2026-09-08')",[receipt.insertId]);
        await pool.query('INSERT INTO stock_vendor_return_lines(vendor_return_id,line_ordinal,receipt_line_id,quantity) VALUES (?,1,?,3)',[returned.insertId,line.insertId]);
        for(const table of ['stock_purchase_orders','stock_receipts','stock_vendor_returns','stock_price_adjustments'])await pool.query(`ALTER TABLE ${table} DROP COLUMN request_hash`);
        await pool.query('ALTER TABLE stock_receipt_lines DROP COLUMN returned_qty');
        await pool.query('DELETE FROM schema_migrations WHERE migration_name=?',[integrity.name]);
        const pathFor=path.join(directory,'integrity-manifest.json');
        fs.writeFileSync(pathFor,JSON.stringify({migrations:[integrity]}));
        fs.copyFileSync(path.join(__dirname,'../../migrations',integrity.file),path.join(directory,integrity.file));
        try{
            expect((await runPendingMigrations(pool,{manifestPath:pathFor})).applied).toEqual([integrity.name]);
            expect((await runPendingMigrations(pool,{manifestPath:pathFor})).applied).toEqual([]);
            const [columns]=await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_receipt_lines' AND COLUMN_NAME='returned_qty'");
            expect(columns).toHaveLength(1);
            const [[preserved]]=await pool.query('SELECT returned_qty FROM stock_receipt_lines WHERE id=?',[line.insertId]);
            expect(Number(preserved.returned_qty)).toBe(3);
        }finally{fs.unlinkSync(pathFor);fs.unlinkSync(path.join(directory,integrity.file));}
    });
    test('fails closed on missing predecessor evidence and retained stock schema', async () => {
        await runPendingMigrations(pool);
        // Purchasing is retired; the retained stock request identity remains mandatory.
        await pool.query('ALTER TABLE stock_operations DROP INDEX uq_stock_operation_request');
        await expect(validateRequiredSchema(pool)).rejects.toThrow(/stock_operation_request_key/);
        await pool.query('DELETE FROM schema_migrations WHERE migration_name IN (?,?)', [target.name, target.requires.name]);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
        await pool.query('INSERT INTO schema_migrations(migration_name,checksum) VALUES (?,?)', [target.requires.name, 'wrong']);
        await expect(runPendingMigrations(pool, { manifestPath })).rejects.toThrow();
    });
});
