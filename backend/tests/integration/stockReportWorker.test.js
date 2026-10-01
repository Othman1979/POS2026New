const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const generations=require('../../services/StockReportGenerationService');
const worker=require('../../services/StockReportWorker');
const facts=require('../../services/StockReportFactService');
const analysis=require('../../services/IngredientAnalysisService');

describe('Bounded stock report rebuilds',()=>{
    const day='2026-09-07';let invoiceId,scope,ingredientId;
    beforeEach(async()=>{
        await seedDatabase();
        const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Chicken','weight','g')");ingredientId=ingredient.insertId;
        const [order]=await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,501,0,501,'cash','2026-09-07 10:00:00')");invoiceId=order.insertId;
        const snapshot=JSON.stringify([{ingredient_id:ingredientId,name:'Chicken',display_unit:'g',qty_per_portion:100,cost_per_portion:0.1,complete:true}]);
        await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot) VALUES ?',
            [Array.from({length:501},()=>[invoiceId,1,'Meal',1,1,snapshot])]);
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,unit_cost,source_type,source_id,business_date) VALUES ('ingredient',?,'usage',-50100,0.001,'order',?,?)",[ingredientId,invoiceId,day]);
        scope=generations.scopeFor('invoice',invoiceId);
        await generations.markDirty(pool,[{day,scope_id:scope}]);
    });
    afterAll(()=>pool.end());
    const published=()=>pool.query(`SELECT m.* FROM stock_report_dirty d JOIN stock_report_meals m ON m.build_id=d.published_build_id
        WHERE d.day=? AND d.scope_id=?`,[day,scope]);
    test('writes at most 500 facts per transaction, releases the source connection during yields and reconciles known totals',async()=>{
        const waits=[];
        const result=await worker.runOne(pool,{waitFor:async ms=>{waits.push(ms);await pool.query('SELECT 1');}});
        expect(result.status).toBe('published');expect(result.rows).toBe(1505);
        expect(result.chunks).toBeGreaterThanOrEqual(4);
        expect(waits.length).toBeGreaterThanOrEqual(3);expect(waits.every(ms=>ms>=0&&ms<=500)).toBe(true);
        const [[meal]]=await published();
        expect(Number(meal.net_revenue_cents)).toBe(50100);expect(Number(meal.known_cost)).toBeCloseTo(50.1,8);
        expect(Number(meal.sold)).toBe(501);expect(Number(meal.incomplete_lines)).toBe(0);
        const [[material]]=await pool.query('SELECT * FROM stock_report_ingredients WHERE build_id=?',[result.build_id]);
        expect(Number(material.qty)).toBe(50100);expect(Number(material.known_cost)).toBeCloseTo(50.1,8);
        const [[operations]]=await pool.query('SELECT * FROM stock_report_operations WHERE build_id=?',[result.build_id]);
        expect(Number(operations.qty)).toBe(-50100);expect(Number(operations.known_cost)).toBeCloseTo(-50.1,8);
        const [[daily]]=await pool.query('SELECT used,used_cost FROM stock_report_daily WHERE build_id=?',[result.build_id]);
        expect(Number(daily.used)).toBe(50100);expect(Number(daily.used_cost)).toBeCloseTo(50.1,8);
        const reference=await analysis.getAnalysis(pool,{startDate:day,endDate:day});
        expect(Number(meal.net_revenue_cents)/100).toBe(reference.totals.net_revenue);
        expect(Number(meal.known_cost)).toBeCloseTo(reference.totals.known_cost,8);
        await expect(facts.writeBatch(pool,result.build_id,Array(501).fill({}))).rejects.toThrow('at most 500');
    });
    test('never publishes a partially persisted build after a source changes; the next build recomputes without double-counting',async()=>{
        let changed=false;
        const interrupted=await worker.runOne(pool,{waitFor:async()=>{
            if(changed)return;
            // Change the source at the first yield after a chunk is persisted, not
            // at a headroom yield that a slow claim can force before any write.
            const [staged]=await pool.query('SELECT 1 FROM stock_report_events LIMIT 1');
            if(!staged.length)return;
            changed=true;
            const conn=await pool.getConnection();
            try{await conn.beginTransaction();await conn.query('UPDATE orders SET total=502,subtotal=502 WHERE invoice_id=?',[invoiceId]);
                await generations.markDirty(conn,[{day,scope_id:scope}]);await conn.commit();
            }finally{await conn.rollback();conn.release();}
        }});
        expect(interrupted.status).toBe('superseded');expect((await published())[0]).toEqual([]);
        const [[stage]]=await pool.query('SELECT COUNT(*) n FROM stock_report_events WHERE build_id=?',[interrupted.build_id]);
        expect(Number(stage.n)).toBeGreaterThan(0);
        const completed=await worker.runOne(pool,{waitFor:async()=>{}});
        expect(completed.status).toBe('published');expect(completed.build_id).not.toBe(interrupted.build_id);
        const [[meal]]=await published();expect(Number(meal.net_revenue_cents)).toBe(50200);expect(Number(meal.sold)).toBe(501);
        const [[events]]=await pool.query('SELECT COUNT(*) n,SUM(net_revenue_cents) cents FROM stock_report_events WHERE build_id=?',[completed.build_id]);
        expect(Number(events.n)).toBe(501);expect(Number(events.cents)).toBe(50200);
    });
    test('cancellation leaves the scope pending and hides all staged rows',async()=>{
        const controller=new AbortController();
        const result=await worker.runOne(pool,{signal:controller.signal,waitFor:async()=>controller.abort()});
        expect(result.status).toBe('cancelled');expect((await published())[0]).toEqual([]);
        const [status]=await generations.status(pool,{startDate:day,endDate:day});expect(status.pending).toBe(true);
        const [[lease]]=await pool.query('SELECT lease_owner FROM stock_report_worker');expect(lease.lease_owner).toBeNull();
    });
    test('cleans obsolete facts in bounded transactions while preserving published facts and source history',async()=>{
        const first=await worker.runOne(pool,{waitFor:async()=>{}});
        await generations.markDirty(pool,[{day,scope_id:scope}]);
        const current=await worker.runOne(pool,{waitFor:async()=>{}});
        const step=await facts.cleanup(pool);
        expect(step.rows).toBe(500);expect(step.builds).toBe(0);
        expect((await pool.query('SELECT id FROM stock_report_builds WHERE id=?',[first.build_id]))[0]).toHaveLength(1);
        const last=await facts.cleanup(pool);expect(last.rows).toBeLessThanOrEqual(500);expect(last.builds).toBe(1);
        expect((await pool.query('SELECT id FROM stock_report_builds WHERE id=?',[first.build_id]))[0]).toEqual([]);
        const [[meal]]=await published();expect(String(meal.build_id)).toBe(current.build_id);expect(Number(meal.net_revenue_cents)).toBe(50100);
        expect((await pool.query("SELECT id FROM stock_movements WHERE movement_type='ingredient' "))[0]).toHaveLength(1);
        expect((await pool.query('SELECT invoice_id FROM orders'))[0]).toHaveLength(1);
        // Even inconsistent metadata must not permit deleting visible facts.
        await pool.query("UPDATE stock_report_builds SET state='obsolete' WHERE id=?",[current.build_id]);
        expect(await facts.cleanup(pool)).toEqual({rows:0,builds:0});
        expect((await published())[0]).toHaveLength(1);
    });
    test('cleanup cannot run beside another installation worker',async()=>{
        const [orphan]=await pool.query("INSERT INTO stock_report_builds(day,scope_id,generation,state) VALUES (?,0,1,'abandoned')",[day]);
        await pool.query('INSERT INTO stock_report_meals(build_id,product_id,net_revenue_cents) VALUES (?,1,100)',[orphan.insertId]);
        const active=await generations.claim(pool);
        expect(await facts.cleanup(pool)).toEqual({rows:0,builds:0});
        expect((await pool.query('SELECT * FROM stock_report_meals WHERE build_id=?',[orphan.insertId]))[0]).toHaveLength(1);
        await generations.abandon(pool,active);
        expect(await facts.cleanup(pool)).toEqual({rows:1,builds:1});
    });
    test('yields before the next source query when reading has consumed its headroom',async()=>{
        let clock=performance.now(),firstRead=true,lineRead=false,rested=false;
        const timer=vi.spyOn(performance,'now').mockImplementation(()=>clock);
        const measured={getConnection:()=>pool.getConnection(),async query(sql,args){
            if(sql.includes('FROM order_items')&&!lineRead){lineRead=true;expect(rested).toBe(true);}
            const result=await pool.query(sql,args);
            if(sql.includes('SELECT o.*')&&firstRead){firstRead=false;clock+=55;}
            return result;
        }};
        try{
            const result=await worker.runOne(measured,{waitFor:async ms=>{
                if(ms>0&&!lineRead)rested=true;
                clock+=ms;
                // The scheduler must be able to obtain the only connection.
                await pool.query('SELECT 1');
            }});
            expect(result.status).toBe('published');expect(lineRead).toBe(true);
        }finally{timer.mockRestore();}
    });
});
