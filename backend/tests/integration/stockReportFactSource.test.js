const pool=require('../../config/db');
const {seedDatabase}=require('../fixtures/seed');
const analysis=require('../../services/IngredientAnalysisService');
const {scopeFor}=require('../../services/StockReportGenerationService');

describe('Bounded ingredient report fact source',()=>{
    const day='2026-09-07';
    let ingredient;
    beforeEach(async()=>{
        await seedDatabase();
        const [row]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Chicken','weight','g')");
        ingredient=row.insertId;
    });
    afterAll(()=>pool.end());
    async function invoice({count=3,method='cash',snapshot=true}={}){
        const [order]=await pool.query('INSERT INTO orders(user_id,subtotal,tax,total,payment_method,created_at) VALUES (1,1,0,1,?,?)',[method,day+' 10:00:00']);
        await pool.query('INSERT INTO order_items(invoice_id,product_id,item_name,quantity,price_at_sale,recipe_cost_snapshot) VALUES ?',
            [Array.from({length:count},()=>[order.insertId,1,'Meal',1,1,snapshot?JSON.stringify([{ingredient_id:ingredient,name:'Chicken',display_unit:'g',qty_per_portion:125,cost_per_portion:0.125,complete:true}]):null])]);
        return order.insertId;
    }
    test('bounds invoice batches, preserves cent allocation and never runs whole-period comparison queries',async()=>{
        const first=await invoice(),second=await invoice(); await invoice({method:'unpaid_table'});
        for(let n=0;n<38;n++)await invoice();
        const calls=[],facts=[];
        const conn={query(sql,args){calls.push({sql,args});return pool.query(sql,args);}};
        const result=await analysis.streamFinancialFacts(conn,{businessDate:day,scopeId:null},async fact=>facts.push(fact));
        expect(facts).toHaveLength(120);
        expect(facts.filter(f=>f.invoice_id===first).map(f=>f.net_revenue_cents)).toEqual([34,33,33]);
        expect(facts.filter(f=>f.invoice_id===second).map(f=>f.net_revenue_cents)).toEqual([34,33,33]);
        expect(facts.every(f=>f.recipe[0].cost_per_portion===0.125)).toBe(true);
        expect(result).toMatchObject({invoices:40,refunds:0});
        const lineReads=calls.filter(c=>/FROM order_items.*WHERE invoice_id IN/.test(c.sql));
        expect(lineReads.length).toBeGreaterThan(1);
        expect(lineReads.every(c=>c.args.length<=16)).toBe(true);
        expect(calls.some(c=>/first_id|last_id|WHERE m.business_date BETWEEN/.test(c.sql))).toBe(false);
    });
    test('large repeated fractional costs reconcile without accumulation drift',async()=>{
        // Reproduce the measured 100,000-invoice drift without inserting a
        // benchmark-sized database into the normal correctness suite.
        const snapshot=JSON.stringify([{ingredient_id:1,name:'Chicken',display_unit:'g',qty_per_portion:100,cost_per_portion:0.4,complete:true}]);
        const source={async query(sql,args){
            if(sql.includes('SELECT o.*')){
                const after=Number(args[4]);
                return [Array.from({length:Math.min(200,100000-after)},(_,n)=>({invoice_id:after+n+1,total:7,tax:0,created_at:day+' 10:00:00'}))];
            }
            if(sql.includes('SELECT * FROM order_items'))return [args.flatMap(invoice_id=>[[1,1,1],[2,0.5,2],[1,2,3]].map(([product_id,quantity,price_at_sale],n)=>({
                id:invoice_id*3+n,invoice_id,product_id,quantity,price_at_sale,tax_rate:0,discount_value:0,item_name:'Meal',recipe_cost_snapshot:snapshot
            })))];
            return [[]];
        }};
        const result=await analysis.getAnalysis(source,{startDate:day,endDate:day});
        expect(result.totals.known_cost).toBe(140000);
        expect(result.ingredients[0].known_cost).toBe(140000);
        expect(result.meals.map(row=>row.known_cost)).toEqual([120000,20000]);
    });
    test('partitions both sale and next-day refund by the original invoice and preserves frozen costs',async()=>{
        const id=await invoice({count:1});
        const [[line]]=await pool.query('SELECT id FROM order_items WHERE invoice_id=?',[id]);
        const [refund]=await pool.query("INSERT INTO refunds(kind,invoice_id,scope,subtotal_refunded,tax_refunded,amount_refunded,refund_method,user_id,created_at) VALUES ('refund',?,'item',1,0,1,'cash',1,'2026-09-08 10:00:00')",[id]);
        await pool.query("INSERT INTO refund_items(refund_id,order_item_id,product_id,item_name,quantity,unit_price,line_subtotal,line_tax,line_total) VALUES (?,?,1,'Meal',1,1,1,0,1)",[refund.insertId,line.id]);
        const scope=scopeFor('invoice',id),sale=[],returned=[],wrong=[];
        await analysis.streamFinancialFacts(pool,{businessDate:day,scopeId:scope},async fact=>sale.push(fact));
        await analysis.streamFinancialFacts(pool,{businessDate:'2026-09-08',scopeId:scope},async fact=>returned.push(fact));
        await analysis.streamFinancialFacts(pool,{businessDate:'2026-09-08',scopeId:(scope+1)%32},async fact=>wrong.push(fact));
        expect(sale).toHaveLength(1);expect(returned).toHaveLength(1);expect(wrong).toEqual([]);
        expect(returned[0]).toMatchObject({kind:'refund',invoice_id:id,source_id:refund.insertId,net_revenue_cents:-100,quantity:1});
        expect(returned[0].recipe).toEqual(sale[0].recipe);
    });
    test('awaits the sink and stops querying after cancellation instead of accumulating the rest of history',async()=>{
        await invoice({count:1}); await invoice({count:1});
        let calls=0,arrived=0,release;
        const pause=new Promise(resolve=>{release=resolve;});
        const conn={query(...args){calls++;return pool.query(...args);}};
        const running=analysis.streamFinancialFacts(conn,{businessDate:day,scopeId:null},async()=>{arrived++;await pause;throw new Error('cancel build');});
        await vi.waitFor(()=>expect(arrived).toBe(1));
        const pausedCalls=calls;
        await new Promise(resolve=>setTimeout(resolve,20));
        expect(calls).toBe(pausedCalls);
        release();await expect(running).rejects.toThrow('cancel build');
        expect(arrived).toBe(1);expect(calls).toBe(pausedCalls);
    });
    test('preserves missing-line and non-product revenue coverage instead of losing those cents',async()=>{
        const empty=await invoice({count:1});await pool.query('DELETE FROM order_items WHERE invoice_id=?',[empty]);
        const excluded=await invoice({count:1});await pool.query('UPDATE order_items SET product_id=NULL WHERE invoice_id=?',[excluded]);
        const facts=[];await analysis.streamFinancialFacts(pool,{businessDate:day,scopeId:null},async fact=>facts.push(fact));
        expect(facts).toHaveLength(2);
        expect(facts.find(f=>f.invoice_id===empty)).toMatchObject({coverage:'unallocated',net_revenue_cents:100});
        expect(facts.find(f=>f.invoice_id===excluded)).toMatchObject({coverage:'excluded',net_revenue_cents:100});
        await expect(analysis.streamFinancialFacts(pool,{businessDate:'2026-02-30',scopeId:0},async()=>{})).rejects.toThrow();
        await expect(analysis.streamFinancialFacts(pool,{businessDate:day,scopeId:32},async()=>{})).rejects.toThrow();
    });
});
