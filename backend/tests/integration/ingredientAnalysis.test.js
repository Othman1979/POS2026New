const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const L = require('../../services/RecipeLedgerService');
const A = require('../../services/IngredientAnalysisService');

describe('sales-driven ingredient costing', () => {
    let id;
    const day = '2026-09-07';
    async function tx(work) {
        const conn = await pool.getConnection();
        try { await conn.beginTransaction(); const value = await work(conn); await conn.commit(); return value; }
        catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    }
    beforeAll(async () => {
        await seedDatabase();
        const [row] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Costed chicken','weight','kg',0.004)");
        id = row.insertId;
    });
    afterAll(() => pool.end());
    it('uses quantity-weighted priced purchases without a count and preserves recorded costs', async () => {
        for (const [qty, cost, key] of [[10,4,'cost-a'],[20,5,'cost-b']]) {
            await tx(conn => L.recordStockBatch(conn, { kind:'receipt', entries:[{ingredient_id:id,qty,unit:'kg',unit_cost:cost}],clientKey:key,businessDate:day }));
        }
        const costs = await L.resolveIngredientCosts(pool, [{id,unit_cost:0.004}], day);
        expect(costs.get(id).unit_cost).toBeCloseTo(0.00466667,8);
        expect(costs.get(id).cost_source).toBe('purchase_average');
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,125)',[id]);
        await tx(conn=>L.syncOrderLines(conn,{enabled:true,sourceId:1,businessDate:day,lines:[{key:L.newLineKey(),isNew:true,product_id:1,qty:60}]}));
        const [[usage]] = await pool.query("SELECT qty,unit_cost,cost_source FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND kind='usage'",[id]);
        expect(Number(usage.qty)).toBe(-7500);
        expect(Number(usage.unit_cost)).toBeCloseTo(0.00466667,8);
        expect(usage.cost_source).toBe('purchase_average');
        expect((await L.getIngredientSummaries(pool,{businessDate:day})).find(row=>row.id===id).expected_remaining).toBeNull();
        await pool.query('UPDATE ingredients SET unit_cost=0.1 WHERE id=?',[id]);
        const [[old]] = await pool.query("SELECT unit_cost FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND kind='usage'",[id]);
        expect(Number(old.unit_cost)).toBe(Number(usage.unit_cost));
    });
    it('ignores unpriced receipts and expires the purchase window to an explicit reference', async () => {
        await tx(conn=>L.recordStockBatch(conn,{kind:'receipt',entries:[{ingredient_id:id,qty:100,unit:'kg'}],clientKey:'unpriced',businessDate:day}));
        expect((await L.resolveIngredientCosts(pool,[{id,unit_cost:0.1}],day)).get(id).unit_cost).toBeCloseTo(0.00466667,8);
        expect((await L.resolveIngredientCosts(pool,[{id,unit_cost:0.1}],'2026-10-08')).get(id)).toMatchObject({unit_cost:0.1,cost_source:'reference'});
    });
    it('reconciles 100 mixed-size meals without counts and excludes unpaid preparations from meal revenue', async () => {
        const [chicken]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Example chicken','weight','kg',0.004)");
        const [other]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Other meal ingredients','count','unit',0.5)");
        await pool.query('DELETE FROM product_recipe_lines WHERE product_id IN (1,2)');
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit,yield_pct) VALUES ?',[[[1,chicken.insertId,125,80],[2,chicken.insertId,250,80],[1,other.insertId,1,100],[2,other.insertId,1,100]]]);
        for (const [product,qty,price,method] of [[1,60,3,'cash'],[2,40,5,'cash'],[1,10,3,'unpaid_table']]) {
            const [order]=await pool.query('INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,?,0,?,?,?)',[qty*price,qty*price,method,'2026-09-07 10:00:00']);
            const key=L.newLineKey();
            await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_line_key) VALUES (?,?,?,?,?,?)',[order.insertId,product,product===1?'100g meal':'200g meal',qty,price,key]);
            await tx(conn=>L.syncOrderLines(conn,{enabled:true,sourceId:order.insertId,businessDate:day,lines:[{key,isNew:true,product_id:product,qty}]}));
        }
        const report=await A.getAnalysis(pool,{startDate:day,endDate:day});
        expect(report.totals).toMatchObject({net_revenue:380,known_cost:120,estimated_margin:260,incomplete:false});
        expect(report.ingredients.find(row=>row.ingredient_id===chicken.insertId).qty).toBe(17500);
        expect(report.operations.find(row=>row.ingredient_id===chicken.insertId).qty).toBe(18750);
        expect(report.meals.map(row=>row.sold).sort()).toEqual([40,60]);
    });
    it('preserves every cent when allocating header discounts across meal lines', () => {
        const order={total:1,tax:0};
        const amounts=A.allocateSaleRevenue(order,Array.from({length:3},()=>({price_at_sale:1,quantity:1,tax_rate:0})));
        expect(amounts).toEqual([0.34,0.33,0.33]);
    });
    it('reports a next-day refund at its event date without repricing the original sale', async () => {
        const [[line]]=await pool.query("SELECT oi.* FROM order_items oi JOIN orders o ON o.invoice_id=oi.invoice_id WHERE oi.product_id=1 AND o.payment_method='cash' ORDER BY oi.id LIMIT 1");
        const [refund]=await pool.query("INSERT INTO refunds(kind,invoice_id,scope,subtotal_refunded,tax_refunded,amount_refunded,refund_method,reason,user_id,created_at) VALUES ('refund',?,'item',6,0,6,'cash','test',1,'2026-09-08 10:00:00')",[line.invoice_id]);
        await pool.query('INSERT INTO refund_items(refund_id,order_item_id,product_id,item_name,quantity,unit_price,line_subtotal,line_tax,line_total) VALUES (?,?,1,?,2,3,6,0,6)',[refund.insertId,line.id,line.item_name]);
        await tx(conn=>L.reverseLinesUsage(conn,{lines:[{lineKey:line.recipe_line_key,qty:2}],sourceType:'refund',sourceId:refund.insertId,businessDate:'2026-09-08'}));
        await pool.query('UPDATE product_recipe_lines SET qty_per_unit=9999 WHERE product_id=1');
        const original=await A.getAnalysis(pool,{startDate:day,endDate:day,productId:1});
        expect(original.totals).toMatchObject({net_revenue:380,known_cost:120,estimated_margin:260});
        expect(original.events).toHaveLength(1);
        expect(original.events[0]).toMatchObject({kind:'sale',net_revenue:180,known_cost:60});
        const returned=await A.getAnalysis(pool,{startDate:'2026-09-08',endDate:'2026-09-08'});
        expect(returned.totals).toMatchObject({net_revenue:-6,known_cost:-2,estimated_margin:-4,food_cost_pct:null});
        const both=await A.getAnalysis(pool,{startDate:day,endDate:'2026-09-08'});
        expect(both.totals).toMatchObject({net_revenue:374,known_cost:118,estimated_margin:256});
    });
    it('distinguishes a free purchase from an unknown price and applies receipt corrections to future estimates', async () => {
        const [[receipt]]=await pool.query("SELECT id FROM stock_movements WHERE movement_type='ingredient' AND client_key LIKE 'batch:%' AND ingredient_id=? AND kind='receipt' ORDER BY id LIMIT 1",[id]);
        await tx(conn=>L.amendManualMovement(conn,{movementId:receipt.id,qty:0,unit:'kg',note:'Duplicate delivery',clientKey:'cost-cancel',businessDate:day}));
        expect((await L.resolveIngredientCosts(pool,[{id,unit_cost:0.1}],day)).get(id).unit_cost).toBe(0.005);
        const [free]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Free sample','weight','kg')");
        expect((await L.resolveIngredientCosts(pool,[{id:free.insertId,unit_cost:null}],day)).get(free.insertId)).toMatchObject({unit_cost:null,cost_source:'missing'});
        await tx(conn=>L.recordStockBatch(conn,{kind:'receipt',entries:[{ingredient_id:free.insertId,qty:1,unit:'kg',unit_cost:0}],clientKey:'free-sample',businessDate:day}));
        expect((await L.resolveIngredientCosts(pool,[{id:free.insertId,unit_cost:null}],day)).get(free.insertId)).toMatchObject({unit_cost:0,cost_source:'purchase_average'});
    });
    it('shows measured variance only between two counts and nets corrected receipts', async () => {
        const [item]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Count comparison','weight','kg')");
        const ingredientId=item.insertId;
        const record=(kind,qty,clientKey,extra={})=>tx(conn=>L.recordManualMovement(conn,{ingredientId,kind,qty,unit:'kg',clientKey,businessDate:day,...extra}));
        await record('count',10,'comparison-start');
        const received=await record('receipt',5,'comparison-received');
        await record('waste',1,'comparison-waste',{reason:'spoiled'});
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,source_type,business_date) VALUES ('ingredient',?,'usage',-2000,'order',?)",[ingredientId,day]);
        await tx(conn=>L.amendManualMovement(conn,{movementId:received.movement.id,qty:4,unit:'kg',clientKey:'comparison-correct',note:'Supplier quantity',businessDate:day}));
        await record('count',11,'comparison-end');
        const report=await A.getAnalysis(pool,{startDate:day,endDate:day});
        expect(report.comparisons.find(row=>row.ingredient_id===ingredientId)).toMatchObject({actual_usage:3000,unexplained:0});
    });
    it('keeps the transaction price snapshot consistent and picks up a concurrent purchase on the next operation', async () => {
        const [item]=await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Concurrent cost','weight','kg',0.004)");
        await pool.query('DELETE FROM product_recipe_lines WHERE product_id=2');
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (2,?,100)',[item.insertId]);
        const writer=await pool.getConnection(),key=L.newLineKey();
        try {
            await writer.beginTransaction();await writer.query("SELECT id FROM stock_movements WHERE movement_type='ingredient'  LIMIT 1");
            await tx(conn=>L.recordStockBatch(conn,{kind:'receipt',entries:[{ingredient_id:item.insertId,qty:5,unit:'kg',unit_cost:6}],clientKey:'concurrent-purchase',businessDate:day}));
            await L.syncOrderLines(writer,{enabled:true,sourceId:99,businessDate:day,lines:[{key,isNew:true,product_id:2,qty:1}]});
            await writer.commit();
            const [[row]]=await pool.query("SELECT unit_cost FROM stock_movements WHERE movement_type='ingredient' AND line_key=? AND kind='usage'",[key]);
            expect(Number(row.unit_cost)).toBe(0.004);
            expect((await L.resolveIngredientCosts(pool,[{id:item.insertId,unit_cost:0.004}],day)).get(item.insertId).unit_cost).toBe(0.006);
        }finally{await writer.rollback();writer.release();}
    });
    it('freezes a paid split line before later preparation changes its shared ledger cost', async () => {
        const key=L.newLineKey();
        const [order]=await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,10,0,10,'cash','2026-09-09 10:00:00')");
        await pool.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_line_key) VALUES (?,2,'Split meal',1,10,?)",[order.insertId,key]);
        await tx(async conn=>{
            await L.syncOrderLines(conn,{enabled:true,sourceId:order.insertId,businessDate:'2026-09-09',lines:[{key,isNew:true,product_id:2,qty:2}]});
            await A.captureInvoiceCosts(conn,order.insertId);
        });
        const before=await A.getAnalysis(pool,{startDate:'2026-09-09',endDate:'2026-09-09'});
        await pool.query('UPDATE ingredients SET unit_cost=0.5 WHERE id=(SELECT ingredient_id FROM product_recipe_lines WHERE product_id=2 LIMIT 1)');
        await tx(conn=>L.syncOrderLines(conn,{enabled:true,sourceId:999,businessDate:'2026-11-01',lines:[{key,isNew:false,product_id:2,qty:4}]}));
        await tx(conn=>A.captureInvoiceCosts(conn,order.insertId));
        const after=await A.getAnalysis(pool,{startDate:'2026-09-09',endDate:'2026-09-09'});
        expect(after.totals).toEqual(before.totals);
        expect(after.totals.known_cost).toBeCloseTo(0.6,6);
    });
    it('keeps unknown recipes and modified meals out of claimed margins while allowing a recorded zero cost',async()=>{
        const snapshot=JSON.stringify([{ingredient_id:id,name:'Chicken',display_unit:'kg',qty_per_portion:100,cost_per_portion:0,complete:true}]);
        for(const [recipe,modifiers] of [[snapshot,null],['[]',null],[snapshot,'[{"name":"extra"}]']]) {
            const [order]=await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,10,0,10,'cash','2026-09-10 10:00:00')");
            await pool.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot,selected_modifiers) VALUES (?,1,'Coverage meal',1,10,?,?)",[order.insertId,recipe,modifiers]);
        }
        const report=await A.getAnalysis(pool,{startDate:'2026-09-10',endDate:'2026-09-10'});
        expect(report.totals).toMatchObject({net_revenue:30,known_cost:0,estimated_margin:null,incomplete:true});
    });
    it('uses the half-open paid business-day boundary instead of when a table was first opened',async()=>{
        const {parseDailyReportPeriod}=require('../../services/dailyReportPeriod');
        const period=parseDailyReportPeriod({startDate:'2026-09-12',endDate:'2026-09-12'});
        for (const at of [period.business_start_at,period.business_end_at]) {
            const [order]=await pool.query("INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at,invoice_issued_at) VALUES (1,10,0,10,'cash','2026-09-01 10:00:00',?)",[at]);
            await pool.query("INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot) VALUES (?,1,'Boundary meal',1,10,'[]')",[order.insertId]);
        }
        const report=await A.getAnalysis(pool,{startDate:'2026-09-12',endDate:'2026-09-12'});
        expect(report.totals.net_revenue).toBe(10);expect(report.meals[0].sold).toBe(1);
    });
    it('replays an unpriced delivery after the reference price changes without creating another receipt',async()=>{
        const args={ingredientId:id,kind:'receipt',qty:1,unit:'kg',clientKey:'reference-retry',businessDate:day};
        const first=await tx(conn=>L.recordManualMovement(conn,args));
        await pool.query('UPDATE ingredients SET unit_cost=0.9 WHERE id=?',[id]);
        const retry=await tx(conn=>L.recordManualMovement(conn,args));
        expect(retry.replay).toBe(true);expect(retry.movement.id).toBe(first.movement.id);
    });
});
