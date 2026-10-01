const request = require('supertest');
const crypto = require('crypto');
const pool = require('../../config/db');
const { app } = require('../../../server');
const { seedDatabase } = require('../fixtures/seed');
const { getBusinessDate } = require('../../utils/businessDate');
const L = require('../../services/RecipeLedgerService');

describe('recipe ledger Phase 1 adversarial regressions', () => {
    const key = () => crypto.randomBytes(16).toString('hex');
    const actor = { id: 1, name: 'Test Admin' };
    const businessDate = getBusinessDate();
    let cookie;
    const http = (method, url, body) => request(app)[method](url).set('Cookie', cookie).send(body);
    const args = (id, kind, qty, clientKey = key()) => ({
        ingredientId: id, kind, qty, unit: 'g', clientKey, actor, businessDate
    });
    async function tx(fn) {
        const c = await pool.getConnection();
        try { await c.beginTransaction(); const value = await fn(c); await c.commit(); return value; }
        catch (error) { await c.rollback(); throw error; }
        finally { c.release(); }
    }
    async function ingredient() {
        const r = await http('post', '/api/admin/ingredients', { name: key(), measure: 'weight', display_unit: 'g' });
        expect(r.status).toBe(200);
        return r.body.ingredient.id;
    }
    beforeAll(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
    });
    afterAll(async () => pool.end());

    it('keeps uncounted history and first-count variance unknown', async () => {
        const id = await ingredient();
        await tx(c => L.recordManualMovement(c, args(id, 'receipt', 10)));
        const history = await http('get', '/api/admin/ingredients/' + id + '/movements');
        expect(history.body.rows[0].running_balance).toBeNull();
        const count = await tx(c => L.recordManualMovement(c, args(id, 'count', 100)));
        expect(count.movement.expected_qty).toBeNull();
        expect((await L.getIngredientSummaries(pool, { businessDate })).find(i => i.id === id).last_count.variance_qty).toBeNull();
    });

    it('reads count expectations after serialization even if its caller already has an old snapshot', async () => {
        const id = await ingredient();
        await tx(c => L.recordManualMovement(c, args(id,'count',100)));
        const writer = await pool.getConnection(), reader = await pool.getConnection();
        try {
            await reader.beginTransaction();
            await reader.query("SELECT COUNT(*) FROM stock_movements WHERE movement_type='ingredient' "); // realistic earlier caller read
            await writer.beginTransaction();
            await L.recordManualMovement(writer,args(id,'receipt',10));
            const counting = L.recordManualMovement(reader,args(id,'count',110));
            await writer.commit();
            const result = await counting;
            await reader.commit();
            expect(Number(result.movement.expected_qty)).toBe(110);
        } finally { await writer.rollback();await reader.rollback();writer.release();reader.release(); }
    });

    it('replays the winner even when the retry transaction has an older snapshot', async () => {
        const id = await ingredient(), a = args(id,'receipt',10);
        const winner = await pool.getConnection(), retry = await pool.getConnection();
        try {
            await retry.beginTransaction();
            await retry.query("SELECT COUNT(*) FROM stock_movements WHERE movement_type='ingredient' ");
            await winner.beginTransaction();
            await L.recordManualMovement(winner,a);
            const retried = L.recordManualMovement(retry,a);
            await winner.commit();
            expect((await retried).replay).toBe(true);
            await retry.commit();
            const [[row]] = await pool.query("SELECT COUNT(*) n,SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?",[id]);
            expect(Number(row.n)).toBe(1);expect(Number(row.qty)).toBe(10);
        } finally {await winner.rollback();await retry.rollback();winner.release();retry.release();}
    });

    it('returns success/replay for simultaneous HTTP receipt requests and permits independent writers', async () => {
        const id=await ingredient(),client_key=key();
        const send=()=>http('post','/api/admin/ingredients/'+id+'/movements',{kind:'receipt',qty:10,unit:'g',client_key});
        const responses=await Promise.all([send(),send()]);
        expect(responses.map(r=>r.status)).toEqual([200,200]);
        expect(responses.filter(r=>r.body.replay).length).toBe(1);
        const ids=await Promise.all([ingredient(),ingredient(),ingredient()]);
        const independent=await Promise.all(ids.map(id=>http('post','/api/admin/ingredients/'+id+'/movements',{
            kind:'receipt',qty:10,unit:'g',client_key:key()
        })));
        expect(independent.map(r=>r.status)).toEqual([200,200,200]);
        const uncounted=await Promise.all([ingredient(),ingredient(),ingredient()]);
        const counts=await Promise.all(uncounted.map(id=>http('post','/api/admin/ingredients/'+id+'/movements',{
            kind:'count',qty:100,unit:'g',client_key:key()
        })));
        expect(counts.map(r=>({status:r.status,message:r.body.message}))).toEqual([
            {status:200,message:undefined},{status:200,message:undefined},{status:200,message:undefined}
        ]);
    });

    it('never returns an impossible balance when writes commit between any summary queries', async () => {
        for (const boundary of [1,2,3,4]) {
            const id=await ingredient();
            await tx(c=>L.recordManualMovement(c,args(id,'count',100)));
            let reads=0;
            const wrapped={query:async(...a)=>{
                const result=await pool.query(...a);
                if(++reads===boundary) {
                    await tx(c=>L.recordManualMovement(c,args(id,'count',200)));
                    await tx(c=>L.recordManualMovement(c,args(id,'receipt',10)));
                }
                return result;
            }};
            const summary=(await L.getIngredientSummaries(wrapped,{businessDate})).find(i=>i.id===id);
            expect([100,200,210], 'no other balance ever existed').toContain(summary.expected_remaining);
        }
    });

    it('restores tiny and ordinary components through checkout and full fractional refund', async () => {
        const ids=[await ingredient(),await ingredient()];
        expect((await http('put','/api/admin/products/1/recipe',{lines:[
            {ingredient_id:ids[0],qty:0.000001,unit:'g'},
            {ingredient_id:ids[1],qty:1,unit:'g'}
        ]})).status).toBe(200);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
        const sale=await http('post','/api/pos/checkout',{cart:[{id:1,qty:1,price:5}],subtotal:5,tax:0.8,total:5.8,
            payment_method:'cash',amount_tendered:5.8,change_due:0,idempotency_key:key()});
        expect(sale.status,JSON.stringify(sale.body)).toBe(200);
        const [[line]]=await pool.query('SELECT id,recipe_line_key FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',[sale.body.invoice_id]);
        for(const qty of [0.333333,0.333333,0.333334]) {
            const refund=await http('post','/api/pos/refunds',{invoice_id:sale.body.invoice_id,intent:'refund',refund_method:'cash',
                items:[{order_item_id:line.id,qty}]});
            expect(refund.status,JSON.stringify(refund.body)).toBe(200);
        }
        const [net]=await pool.query("SELECT SUM(qty) qty,SUM(product_qty) pq FROM stock_movements WHERE movement_type='ingredient' AND line_key=? GROUP BY ingredient_id",[line.recipe_line_key]);
        expect(net).toHaveLength(2);
        for(const row of net){expect(Number(row.qty)).toBe(0);expect(Number(row.pq)).toBe(0);}
    });

    it('returns exact whole portions and never rounds a shortage upward', async () => {
        const id=await ingredient();
        await http('put','/api/admin/products/2/recipe',{lines:[{ingredient_id:id,qty:0.1,unit:'g'}]});
        await tx(c=>L.recordManualMovement(c,args(id,'count',0.3)));
        const result=await http('get','/api/admin/ingredients/portions');
        expect(result.body.portions.find(p=>p.product_id===2).portions_possible).toBe(3);
        expect(L.portionsPossible([{ingredient_id:1,qty_per_unit:0.1}],new Map([[1,0.299999]])).portions).toBe(2);
    });

    it('loads a bounded history page while including the entire prefix and later count resets', async () => {
        const id=await ingredient();
        const values=Array.from({length:2000},(_,i)=>[id,i===0?'count':'usage',i===0?10000:-1,'manual','2026-09-01']);
        await pool.query("INSERT INTO stock_movements(movement_type,ingredient_id,kind,qty,source_type,business_date) VALUES ?",[(values).map(row => ['ingredient', ...row])]);
        let fetched=0;
        const wrapped={query:async(...a)=>{const r=await pool.query(...a);if(Array.isArray(r[0]))fetched+=r[0].length;return r;}};
        const page=await L.listMovements(wrapped,{ingredientId:id,limit:2});
        expect(page.rows.map(r=>r.running_balance)).toEqual([8001,8002]);
        expect(fetched).toBeLessThanOrEqual(10);
        await tx(c=>L.recordManualMovement(c,args(id,'count',100)));
        await tx(c=>L.recordManualMovement(c,args(id,'receipt',10)));
        const next=await L.listMovements(pool,{ingredientId:id,from:businessDate,limit:2});
        expect(next.rows.map(r=>r.running_balance)).toEqual([110,100]);
    });
});
