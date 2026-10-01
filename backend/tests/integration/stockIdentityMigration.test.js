const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { runPendingMigrations, splitMysqlScript } = require('../../migrations/runPendingMigrations');
const { restoreProductSnapshots } = require('../../services/StockProductAdapter');
const ledger = require('../../services/StockLedgerService');

describe('Stock identity migration preserves original stock', () => {
    const target = require('../../migrations/auto-manifest.json').migrations.find(row => row.name === '2026-09-12-stock-item-identity-v1');
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations', target.file), 'utf8');
    let directory, manifestPath, itemId, lotId, locationId;
    beforeAll(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-stock-identity-'));
        manifestPath = path.join(directory, 'manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({ migrations: [target] }));
        fs.writeFileSync(path.join(directory, target.file), sql);
    });
    beforeEach(async () => {
        await seedDatabase({ legacyStockSchema: true });
        const [item] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('Historical stock','count','unit','active')");
        itemId = item.insertId;
        const [lot] = await pool.query("INSERT INTO stock_lots(stock_item_id,lot_code,is_default) VALUES (?,'default',1)", [itemId]);
        lotId = lot.insertId;
        const [[location]] = await pool.query("SELECT id FROM stock_locations WHERE code='default'");
        locationId = location.id;
        await pool.query('INSERT INTO stock_balances(stock_item_id,location_id,lot_id,quantity,quantity_known,version) VALUES (?,?,?,7.123456,1,3)', [itemId,locationId,lotId]);
    });
    afterAll(async () => {
        await pool.end();
        for (const file of ['manifest.json',target.file]) fs.unlinkSync(path.join(directory,file));
        fs.rmdirSync(directory);
    });
    const migrate = () => runPendingMigrations(pool, { manifestPath });
    const balance = async () => (await pool.query('SELECT CAST(quantity AS CHAR) quantity,quantity_known,version,location_id,lot_id FROM stock_balances WHERE stock_item_id=?',[itemId]))[0][0];

    test('removes only warehouse tables, preserves balance, IDs and repeat startup', async () => {
        const before = await balance();
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await balance()).toEqual(before);
        expect((await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_lots','stock_locations')"))[0]).toHaveLength(0);
        await expect(pool.query('INSERT INTO stock_balances(stock_item_id) VALUES (?)',[itemId])).rejects.toMatchObject({code:'ER_DUP_ENTRY'});
        expect((await migrate()).applied).toEqual([]);
        expect((await pool.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('stock_receipts','stock_ingredient_links','ingredient_movements','stock_movements')"))[0]).toHaveLength(4);
    });

    test('returns an old version 2 composition to its original stock after remapping the product', async () => {
        await migrate();
        // Current writers run only after startup applies every successor migration.
        await runPendingMigrations(pool);
        const [replacement] = await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ('New composition','count','unit','active')");
        await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,10,1)',[replacement.insertId]);
        await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES (1,?,1)',[replacement.insertId]);
        await pool.query('UPDATE products SET stock=10 WHERE id=1');
        const conn=await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [before]=await conn.query('SELECT id,stock,stock_version FROM products WHERE id=1 FOR UPDATE');
            await restoreProductSnapshots(conn,{before,cartItems:[{product_id:1,qty:'1.5',stock_authority:'product',stock_snapshot:{version:2,components:[{stock_item_id:String(itemId),location_id:String(locationId),lot_id:String(lotId),qty_per_sale:'2.000000',policy_version:'1'}]}}],source:{type:'refund',id:'old_sale'},businessDate:'2026-09-12',actorId:1});
            await conn.commit();
        } catch(error){await conn.rollback();throw error;} finally{conn.release();}
        expect((await balance()).quantity).toBe('10.123456');
        const [[replacementBalance]]=await pool.query('SELECT quantity FROM stock_balances WHERE stock_item_id=?',[replacement.insertId]);
        expect(Number(replacementBalance.quantity)).toBe(10);
    });

    test('retains populated purchasing receipts and their original identity descriptions', async () => {
        const [receipt]=await pool.query("INSERT INTO stock_receipts(status,business_date) VALUES ('posted','2026-09-08')");
        await pool.query("UPDATE stock_locations SET name='Original store' WHERE id=?",[locationId]);
        await pool.query('INSERT INTO stock_receipt_lines(receipt_id,line_ordinal,stock_item_id,location_id,lot_id,pack_qty,received_qty) VALUES (?,0,?,?,?,1,2)',[receipt.insertId,itemId,locationId,lotId]);
        await migrate();
        const [[row]]=await pool.query('SELECT received_qty,legacy_stock_identity FROM stock_receipt_lines WHERE receipt_id=?',[receipt.insertId]);
        const identity=typeof row.legacy_stock_identity==='string'?JSON.parse(row.legacy_stock_identity):row.legacy_stock_identity;
        expect(Number(row.received_qty)).toBe(2);
        expect(identity).toMatchObject({location_id:String(locationId),location_name:'Original store',lot_id:String(lotId),lot_code:'default'});
        expect((await pool.query('SELECT id FROM stock_receipts WHERE id=?',[receipt.insertId]))[0]).toHaveLength(1);
    });

    test('replays an old completed internal intent without changing stock or its result', async () => {
        const input={kind:'receipt',request_key:randomUUID(),business_date:'2026-09-11',lines:[{stock_item_id:itemId,location_id:locationId,lot_id:lotId,quantity:'2'}]};
        const intent={kind:input.kind,business_date:input.business_date,actor_id:'1',original_operation_id:null,lines:[{key:[itemId,locationId,lotId].map(String),quantity:'2.000000',expected_version:null,source_line:null}]};
        const hash=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
        const result={operation_id:999,lines:[{stock_item_id:String(itemId),location_id:String(locationId),lot_id:String(lotId),quantity:'7.123456',quantity_known:true,version:'3'}]};
        await pool.query("INSERT INTO stock_operations(request_key,payload_hash,kind,result_json) VALUES (?,?,'receipt',?)",[input.request_key,hash,JSON.stringify(result)]);
        await migrate();
        await runPendingMigrations(pool);
        expect(await ledger.post(pool,input,1)).toEqual({...result,replayed:true});
        expect((await balance()).quantity).toBe('7.123456');
    });

    test.each(['quarantine','multiple_balances','traceable'])('rejects %s before destructive changes',async variant=>{
        if(variant==='quarantine')await pool.query("UPDATE stock_lots SET state='quarantine' WHERE id=?",[lotId]);
        if(variant==='traceable')await pool.query('UPDATE stock_items SET lot_required=1 WHERE id=?',[itemId]);
        if(variant==='multiple_balances'){
            const [[other]]=await pool.query("SELECT id FROM stock_locations WHERE code='in_transit'");
            await pool.query('INSERT INTO stock_balances(stock_item_id,location_id,lot_id,quantity) VALUES (?,?,?,5)',[itemId,other.id,lotId]);
        }
        await expect(migrate()).rejects.toThrow('failed at statement');
        expect((await pool.query('SELECT id FROM stock_lots WHERE id=?',[lotId]))[0]).toHaveLength(1);
        const [[column]]=await pool.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='stock_items' AND COLUMN_NAME='lot_required'");
        expect(column.n).toBe(1);
        expect((await pool.query('SELECT * FROM schema_migrations WHERE migration_name=?',[target.name]))[0]).toHaveLength(0);
    });

    test('resumes after the first table drop without copying or resetting balances', async()=>{
        const conn=await pool.getConnection();
        try {
            for(const statement of splitMysqlScript(sql)){
                await conn.query(statement);
                if(statement==='DROP TABLE IF EXISTS stock_lots')break;
            }
        } finally{conn.release();}
        const before=await balance();
        expect((await migrate()).applied).toEqual([target.name]);
        expect(await balance()).toEqual(before);
    });
});
