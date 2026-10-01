const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const A=require('../../services/IngredientAnalysisService');
const L=require('../../services/RecipeLedgerService');
const {performance}=require('node:perf_hooks');
describe('ingredient analysis bounded work',()=>{
    beforeAll(()=>seedDatabase());afterAll(()=>pool.end());
    it('reconciles 1000 paid invoices in bounded batches and limits drilldown payloads',async()=>{
        const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Benchmark chicken','weight','kg',0.004)");
        const id=ingredient.insertId;
        const snapshot=JSON.stringify([{ingredient_id:id,name:'Benchmark chicken',display_unit:'kg',qty_per_portion:100,cost_per_portion:0.4,complete:true}]);
        await pool.query('INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES ?',[Array.from({length:1000},()=>[1,5,0,5,'cash','2026-09-07 10:00:00'])]);
        const [orders]=await pool.query("SELECT invoice_id FROM orders WHERE created_at='2026-09-07 10:00:00'");
        await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot) VALUES ?',[orders.map(o=>[o.invoice_id,1,'Benchmark meal',1,5,snapshot])]);
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,unit_cost,purchase_priced,source_type,business_date) VALUES ?",[(Array.from({length:900},(_,i)=>[id,'receipt',1000,0.004+i%3*0.001,1,'manual',`2026-08-${String(10+i%20).padStart(2,'0')}`])).map(row => ['ingredient', ...row])]);
        const timings=[];let queries=0;
        const conn={query:(...args)=>{queries++;return pool.query(...args);}};
        await A.getAnalysis(conn,{startDate:'2026-09-07',endDate:'2026-09-07'});
        queries=0;const cpuStart=process.cpuUsage();
        for(let i=0;i<20;i++) {
            const start=performance.now(),report=await A.getAnalysis(conn,{startDate:'2026-09-07',endDate:'2026-09-07'});timings.push(performance.now()-start);
            expect(report.totals).toMatchObject({net_revenue:5000,known_cost:400,estimated_margin:4600,incomplete:false});
        }
        expect(queries/20).toBeLessThanOrEqual(15);
        const cpu=process.cpuUsage(cpuStart);
        const detail=await A.getAnalysis(pool,{startDate:'2026-09-07',endDate:'2026-09-07',productId:1});
        expect(detail.events).toHaveLength(50);expect(detail.events_has_more).toBe(true);
        const costTimes=[];
        for(let i=0;i<100;i++){const start=performance.now();const price=(await L.resolveIngredientCosts(pool,[{id,unit_cost:0.004}],'2026-09-07')).get(id);costTimes.push(performance.now()-start);expect(price.unit_cost).toBeCloseTo(0.005,6);}
        const snapshotTimes=[],syncTimes=[];let snapshotQueries=0;
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,100)',[id]);
        for(let i=0;i<20;i++){
            const tx=await pool.getConnection();
            try {
                await tx.beginTransaction();
                const [order]=await tx.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,5,0,5,'cash','2026-09-08 10:00:00')");
                const key=L.newLineKey();await tx.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_line_key) VALUES (?,1,'Snapshot meal',1,5,?)",[order.insertId,key]);
                const start=performance.now();
                await L.syncOrderLines(tx,{enabled:true,sourceId:order.insertId,businessDate:'2026-09-08',lines:[{key,isNew:true,product_id:1,qty:1}]});
                const capturedAt=performance.now();syncTimes.push(capturedAt-start);
                await A.captureInvoiceCosts({query:(...args)=>{snapshotQueries++;return tx.query(...args);}},order.insertId);
                snapshotTimes.push(performance.now()-capturedAt);await tx.commit();
            } finally {await tx.rollback();tx.release();}
        }
        const summarize=values=>({mean_ms:values.reduce((a,b)=>a+b,0)/values.length,p95_ms:[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]});
        const evidence={invoices:1000,priced_receipts:900,report_rounds:20,report_queries:queries/20,report:summarize(timings),node_cpu_ms_per_report:(cpu.user+cpu.system)/1000/20,cost_lookup:summarize(costTimes),recipe_sync:summarize(syncTimes),invoice_snapshot:summarize(snapshotTimes),invoice_snapshot_queries:snapshotQueries/20,detail_events:detail.events.length,detail_bytes:Buffer.byteLength(JSON.stringify(detail)),note:'Local isolated MySQL; Node CPU excludes MySQL CPU. Recipe sync and invoice snapshot timings are phases, not end-to-end checkout timings. Timing is evidence, not a portable performance guarantee.'};
        require('node:fs').mkdirSync('scratch',{recursive:true});require('node:fs').writeFileSync('scratch/ingredient-analysis-performance.json',JSON.stringify(evidence,null,2));
    });
});
