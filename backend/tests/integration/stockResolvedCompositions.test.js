const { randomUUID } = require('node:crypto');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const ledger = require('../../services/StockLedgerService');
const { getConnection } = require('../../services/StockReportInvalidation');
const { prepareStockWrite, deductStockForCart, restoreStockForCart } = require('../../services/InventoryService');
const { availabilitySql } = require('../../services/StockProductAdapter');
const snapshots = require('../../services/StockSaleSnapshots');

describe('Resolved physical stock compositions', () => {
    beforeEach(() => seedDatabase());
    afterAll(() => pool.end());
    async function transaction(work) {
        const conn=await getConnection(pool);
        try {await conn.beginTransaction();const result=await work(conn);await conn.commit();return result;}
        catch(error){await conn.rollback();throw error;}finally{conn.release();}
    }
    const context=id=>({source:{type:'invoice',id:String(id)},businessDate:'2026-09-08',actorId:1});
    async function physical(amount='1000',count=1) {
        const name=randomUUID();
        await pool.query('INSERT INTO stock_items(name,measure,base_unit,tracking_state) VALUES ?',
            [Array.from({length:count},(_,i)=>[name+i,'weight','g','active'])]);
        const [items]=await pool.query('SELECT id FROM stock_items WHERE name LIKE ? ORDER BY id',[name+'%']);
        const physicalItems=items.map(row=>({stock_item_id:String(row.id)}));
        await transaction(async conn=>{for(let i=0;i<physicalItems.length;i+=100)await ledger.post(conn,{kind:'opening',request_key:randomUUID(),business_date:'2026-09-08',lines:physicalItems.slice(i,i+100).map(r=>({...r,quantity:amount,expected_version:'0'}))},1);});
        return physicalItems;
    }
    async function available(ids) {return (await pool.query(`SELECT id,CAST(${availabilitySql('p')} AS CHAR) stock FROM products p WHERE id IN (?) ORDER BY id`,[ids]))[0];}
    async function balance(id) {return (await pool.query('SELECT CAST(quantity AS CHAR) qty FROM stock_balances WHERE stock_item_id=?',[id]))[0][0].qty;}
    async function link(product,parts){await pool.query('INSERT INTO product_stock_links(product_id,stock_item_id,qty_per_sale) VALUES ?',[parts.map(([id,qty])=>[product,id,qty])]);}
    test('100g and 200g portions share one physical quantity and derive both menu availabilities',async()=>{
        const [{stock_item_id:item}]=await physical();
        await link(SEED.product1.id,[[item,'100']]);await link(SEED.product2.id,[[item,'200']]);
        const saved=await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:2},{product_id:SEED.product2.id,qty:1}],context(1)));
        expect(await balance(item)).toBe('600.000000');
        expect((await available([SEED.product1.id,SEED.product2.id])).map(r=>Number(r.stock))).toEqual([6,3]);
        expect(saved.get(SEED.product1.id).components[0].qty_per_sale).toBe('100.000000');
        await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(2)));
        expect((await available([SEED.product2.id]))[0].stock).toBe('2.500000');
        const [[operation]]=await pool.query("SELECT result_json FROM stock_operations WHERE request_key LIKE 'product_%' ORDER BY id LIMIT 1");
        expect(JSON.parse(operation.result_json).product_sources).toHaveLength(2);
    });
    test('ingredient counts compare with physical stock after a shared portion sale',async()=>{
        const L=require('../../services/RecipeLedgerService');
        const [part]=await physical('1000');
        const [ingredient]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Shared count','weight','g')");
        await pool.query('UPDATE ingredients SET stock_item_id=?,stock_movement_watermark=0,stock_activation_operation_id=(SELECT operation_id FROM stock_movements WHERE stock_item_id=? ORDER BY id LIMIT 1),stock_observation_token=REPEAT("a",64),stock_activation_quantity=1000,stock_activation_quantity_known=1,stock_activation_request_key="shared-count-fixture",stock_activated_at=CURRENT_TIMESTAMP(6) WHERE id=?',[part.stock_item_id,part.stock_item_id,ingredient.insertId]);
        const count=qty=>transaction(conn=>L.recordManualMovement(conn,{ingredientId:ingredient.insertId,kind:'count',qty,unit:'g',clientKey:randomUUID(),actor:{id:1},businessDate:'2026-09-08'}));
        await count(1000);await link(SEED.product1.id,[[part.stock_item_id,'100']]);
        await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:2}],context(35)));
        const result=await count(790);
        expect(Number(result.movement.expected_qty)).toBe(800);
        expect(await balance(part.stock_item_id)).toBe('790.000000');
        const [[projection]]=await pool.query('SELECT working_variance_qty AS variance_qty FROM ingredients WHERE id=?',[ingredient.insertId]);
        expect(Number(projection.variance_qty)).toBe(-10);
        await require('../../services/StockReportGenerationService').ensureCoverage(pool);
        await require('../../services/StockReportWorker').drain(pool,{limit:256,waitFor:async()=>{}});
        const page=await L.listIngredientPage(pool,{businessDate:'2026-09-08'});
        expect(page.items[0].today.used).toBe(200);

    });
    test('mixed packaged and recipe stock writers complete in either source order',async()=>{
        const L=require('../../services/RecipeLedgerService');
        const parts=await physical('1000',2);
        const ingredientIds=[];
        for(const [index,part] of parts.entries()){
            const [created]=await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES (?,'weight','g')",['Cross stock '+index]);ingredientIds.push(created.insertId);
            await pool.query(`UPDATE ingredients SET stock_item_id=?,stock_movement_watermark=0,stock_activation_operation_id=(SELECT operation_id FROM stock_movements WHERE stock_item_id=? ORDER BY id LIMIT 1),stock_observation_token=REPEAT('b',64),stock_activation_quantity=1000,stock_activation_quantity_known=1,stock_activation_request_key=?,stock_activated_at=CURRENT_TIMESTAMP(6) WHERE id=?`,[part.stock_item_id,part.stock_item_id,'cross-'+index,created.insertId]);
        }
        await link(SEED.product1.id,[[parts[0].stock_item_id,'1']]);await link(SEED.product2.id,[[parts[1].stock_item_id,'1']]);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,1),(?,?,1)',[SEED.product1.id,ingredientIds[1],SEED.product2.id,ingredientIds[0]]);
        let arrived=0,release;const together=new Promise(resolve=>{release=resolve;});
        const results=await Promise.allSettled([SEED.product1.id,SEED.product2.id].map(id=>transaction(async conn=>{
            await conn.query('SET innodb_lock_wait_timeout=2');
            try{
                if(++arrived===2)release();await together;
                const plan=await prepareStockWrite(conn,{items:[{product_id:id,qty:1}],recipeEnabled:true});
                await deductStockForCart(conn,[{product_id:id,qty:1}],{...context(id+40),plan});
                await L.syncOrderLines(conn,{enabled:true,sourceId:id+40,recipeContext:plan.recipeContext,businessDate:'2026-09-08',lines:[{key:L.newLineKey(),product_id:id,qty:1,isNew:true}]});
            }finally{await conn.query('SET innodb_lock_wait_timeout=DEFAULT');}
        })));
        expect(results.map(row=>row.status),JSON.stringify(results.map(row=>row.reason?.message))).toEqual(['fulfilled','fulfilled']);
        for(const part of parts)expect(await balance(part.stock_item_id)).toBe('998.000000');
    });
    test('returns use the original component and quantity after remapping, including mixed mappings of the same product',async()=>{
        const [a,b]=await physical('1000',2);await link(SEED.product1.id,[[a.stock_item_id,'100']]);
        const first=await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(3)));
        await pool.query('DELETE FROM product_stock_links WHERE product_id=?',[SEED.product1.id]);await link(SEED.product1.id,[[b.stock_item_id,'200']]);
        const second=await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(4)));
        const cart=[first,second].map(saved=>{const [stock_authority,stock_snapshot]=snapshots.columns(saved.get(SEED.product1.id));return {product_id:SEED.product1.id,qty:0.5,stock_authority,stock_snapshot};});
        await transaction(conn=>restoreStockForCart(conn,cart,{...context(5),source:{type:'refund',id:'5'}}));
        expect(await balance(a.stock_item_id)).toBe('950.000000');expect(await balance(b.stock_item_id)).toBe('900.000000');
        expect(Number((await available([SEED.product1.id]))[0].stock)).toBe(4.5);
    });
    test('200 components commit atomically and a second-chunk shortage rolls back every component',async()=>{
        const parts=await physical('2',200);await link(SEED.product1.id,parts.map(p=>[p.stock_item_id,'1']));
        const saved=await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(6)));
        expect(saved.get(SEED.product1.id).components).toHaveLength(200);
        const [[posted]]=await pool.query("SELECT COUNT(*) n FROM stock_operations WHERE request_key LIKE 'product_%'");expect(posted.n).toBe(2);
        // Exhaust only a component in chunk two through the real ledger.
        await transaction(conn=>ledger.post(conn,{kind:'issue',request_key:randomUUID(),business_date:'2026-09-08',lines:[{...parts.at(-1),quantity:'-1'}]},1));
        await expect(transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(7)))).rejects.toMatchObject({statusCode:409});
        expect(await balance(parts[0].stock_item_id)).toBe('1.000000');
        const [[after]]=await pool.query("SELECT COUNT(*) n FROM stock_operations WHERE request_key LIKE 'product_%'");expect(after.n).toBe(2);
    });
    test('fractional components reject unrepresentable quantities before any stock is posted',async()=>{
        const [a]=await physical();await link(SEED.product1.id,[[a.stock_item_id,'0.000001']]);
        await expect(transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:0.1}],context(8)))).rejects.toMatchObject({statusCode:409});
        expect(await balance(a.stock_item_id)).toBe('1000.000000');
    });
    test('concurrent portions cannot oversell the same physical balance',async()=>{
        const [a]=await physical('100');await link(SEED.product1.id,[[a.stock_item_id,'100']]);await link(SEED.product2.id,[[a.stock_item_id,'100']]);
        const results=await Promise.allSettled([SEED.product1.id,SEED.product2.id].map(id=>transaction(conn=>deductStockForCart(conn,[{product_id:id,qty:1}],context(id+20)))));
        expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
        expect(results.find(r=>r.status==='rejected').reason.statusCode).toBe(409);
        expect(await balance(a.stock_item_id)).toBe('0.000000');
    });
    test('original-stock returns remain valid after the catalog-owned physical item is archived',async()=>{
        const [a]=await physical('10');await link(SEED.product1.id,[[a.stock_item_id,'1']]);
        const saved=await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(31)));
        await pool.query('UPDATE stock_items SET is_active=0 WHERE id=?',[a.stock_item_id]);
        const [stock_authority,stock_snapshot]=snapshots.columns(saved.get(SEED.product1.id));
        await transaction(conn=>restoreStockForCart(conn,[{product_id:SEED.product1.id,qty:1,stock_authority,stock_snapshot}],{...context(32),source:{type:'refund',id:'32'}}));
        expect(await balance(a.stock_item_id)).toBe('10.000000');
        await expect(transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(33)))).rejects.toMatchObject({statusCode:409});
    });
    test('a multi-component product projects the stock of its scarcest component',async()=>{
        const [plenty]=await physical('10');const [scarce]=await physical('2');
        await link(SEED.product1.id,[[plenty.stock_item_id,'1'],[scarce.stock_item_id,'1']]);
        await transaction(conn=>deductStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],context(36)));
        const [[product]]=await pool.query('SELECT CAST(stock AS CHAR) stock FROM products WHERE id=?',[SEED.product1.id]);
        expect(product.stock).toBe('1.000000');
    });
    test('a legacy sale return is refused once the product is linked at a non-unit portion',async()=>{
        const [a]=await physical('1000');await link(SEED.product1.id,[[a.stock_item_id,'100']]);
        await expect(transaction(conn=>restoreStockForCart(conn,[{product_id:SEED.product1.id,qty:1}],{...context(37),source:{type:'refund',id:'37'}}))).rejects.toMatchObject({statusCode:409});
        expect(await balance(a.stock_item_id)).toBe('1000.000000');
    });

});
