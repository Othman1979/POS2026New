const {randomUUID}=require('node:crypto');
const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const invalidation=require('../../services/StockReportInvalidation');
const ledger=require('../../services/StockLedgerService');
const worker=require('../../services/StockReportWorker');

describe('source-owned stock report transactions',()=>{
    beforeEach(seedDatabase);
    afterAll(()=>pool.end());
    async function item(name){
        const [created]=await pool.query("INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES (?,'count','unit','active')",[name]);

        await pool.query('INSERT INTO stock_balances(stock_item_id,quantity,quantity_known) VALUES (?,0,1)',[created.insertId]);
        return {stock_item_id:String(created.insertId)};
    }
    test('competing multi-source transactions flush sorted unique dirty keys only after stock writes',async()=>{
        const keys=await Promise.all([item('First'),item('Second')]);
        let ready=0,release;
        const barrier=new Promise(resolve=>{release=resolve;});
        async function write(key,days){
            const conn=await invalidation.getConnection(pool);
            try{
                await conn.beginTransaction();
                for(let n=0;n<2;n++){
                    await ledger.post(conn,{kind:'receipt',request_key:randomUUID(),business_date:days[n],lines:[{...key,quantity:String(n+1)}]},1);
                    await invalidation.physicalDay(conn,days[n]);
                }
                const [[dirty]]=await conn.query('SELECT COUNT(*) n FROM stock_report_dirty');
                expect(Number(dirty.n)).toBe(0);
                if(++ready===2)release();await barrier;
                await conn.commit();
            }catch(error){await conn.rollback();throw error;}finally{conn.release();}
        }
        await Promise.all([write(keys[0],['2026-09-08','2026-09-07']),write(keys[1],['2026-09-07','2026-09-08'])]);
        const [dirty]=await pool.query('SELECT generation,pending FROM stock_report_dirty');
        expect(dirty).toHaveLength(64);
        expect(dirty.every(row=>Number(row.generation)===2&&row.pending===1)).toBe(true);
        const [balances]=await pool.query('SELECT quantity FROM stock_balances ORDER BY stock_item_id');
        expect(balances.map(row=>Number(row.quantity))).toEqual([3,3]);
        expect(invalidation.hasSourcePressure()).toBe(false);
    });
    test('rollback discards invalidation and source writes; the worker yields while the transaction is active',async()=>{
        const conn=await invalidation.getConnection(pool);
        try{
            await conn.beginTransaction();
            await conn.query('UPDATE products SET price=9 WHERE id=1');
            await invalidation.physicalDay(conn,'2026-09-08');
            expect(await worker.runOne(pool)).toEqual({status:'deferred'});
            await conn.rollback();
            await conn.beginTransaction();await conn.commit();
        }finally{conn.release();}
        const [[product]]=await pool.query('SELECT price FROM products WHERE id=1');
        const [[dirty]]=await pool.query('SELECT COUNT(*) n FROM stock_report_dirty');
        expect(Number(product.price)).toBe(5);expect(Number(dirty.n)).toBe(0);
        expect(invalidation.hasSourcePressure()).toBe(false);
    });
    test('releasing an unfinished source transaction rolls it back instead of leaking a lease or pending scopes',async()=>{
        const conn=await invalidation.getConnection(pool);
        await conn.beginTransaction();await conn.query('UPDATE products SET price=99 WHERE id=1');
        await invalidation.physicalDay(conn,'2026-09-08');conn.release();conn.release();
        const [[product]]=await pool.query('SELECT price FROM products WHERE id=1');
        expect(Number(product.price)).toBe(5);expect(invalidation.hasSourcePressure()).toBe(false);
    });
});
