const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const L = require('../../services/RecipeLedgerService');
const { getBusinessDate } = require('../../utils/businessDate');

describe('POS ingredient costs and optional counts', () => {
    let admin, ingredientId, shiftId;
    beforeEach(async () => {
        await seedDatabase();
        admin = (await request(app).post('/api/auth/login').send({user_number:SEED.adminUser.user_number})).headers['set-cookie'][0];
        expect((await request(app).post('/api/system/settings').set('Cookie',admin).send({recipe_ledger_enabled:'1'})).status).toBe(200);
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Chicken','weight','kg',0.009)");
        ingredientId = ingredient.insertId;
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)',[SEED.product1.id,ingredientId]);
        await request(app).post('/api/auth/shifts?action=open').set('Cookie',admin).send({user_id:SEED.adminUser.id,starting_cash:0});
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'",[SEED.adminUser.id]);
        shiftId = shift.id;
    });
    afterAll(() => pool.end());
    async function movement(kind,qty,extra={}) {
        const body = {kind,qty,unit:'kg',client_key:randomUUID(),...extra};
        const result = await request(app).post(`/api/admin/ingredients/${ingredientId}/movements`).set('Cookie',admin).send(body);
        expect(result.status,JSON.stringify(result.body)).toBe(200);
        return (await pool.query("SELECT * FROM stock_movements WHERE movement_type='ingredient' AND client_key=?",[body.client_key]))[0][0];
    }
    async function sell() {
        const key=randomUUID();
        const result=await request(app).post('/api/pos/checkout').set('Cookie',admin).send({cart:[{id:SEED.product1.id,qty:1,price:5}],shift_id:shiftId,subtotal:5,tax:0.8,total:5.8,payment_method:'cash',amount_tendered:6,change_due:0.2,idempotency_key:key});
        expect(result.status,JSON.stringify(result.body)).toBe(200);
        return (await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?',[key]))[0][0].invoice_id;
    }
    const estimate = async () => (await L.resolveIngredientCosts(pool,[{id:ingredientId,unit_cost:0.009}],getBusinessDate())).get(ingredientId);
    test('receipts drive quantity-weighted base-unit costs; correction changes future estimates, not sale/refund snapshots', async () => {
        await movement('receipt',1,{unit_cost:4,cost_unit:'kg'});
        const second = await movement('receipt',3,{unit_cost:8,cost_unit:'kg'});
        expect(await estimate()).toEqual({unit_cost:0.007,cost_source:'purchase_average'});
        const invoice=await sell();
        const [[used]]=await pool.query("SELECT qty,unit_cost FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND kind='usage'",[ingredientId]);
        expect(Number(used.qty)).toBe(-200);
        expect(Number(used.unit_cost)).toBe(0.007);
        const waste=await movement('waste',0.1,{reason:'expired'});
        expect(Number(waste.qty)*Number(waste.unit_cost)).toBeCloseTo(-0.7,8);
        const corrected=await request(app).post(`/api/admin/ingredient-movements/${second.id}/amend`).set('Cookie',admin).send({qty:0,unit:'kg',note:'Wrong delivery quantity',client_key:randomUUID()});
        expect(corrected.status,JSON.stringify(corrected.body)).toBe(200);
        expect(await estimate()).toEqual({unit_cost:0.004,cost_source:'purchase_average'});
        const refund=await request(app).post('/api/pos/refunds').set('Cookie',admin).send({invoice_id:invoice,intent:'refund',refund_method:'cash'});
        expect(refund.status,JSON.stringify(refund.body)).toBe(200);
        const [[returned]]=await pool.query("SELECT qty,unit_cost FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND source_type='refund'",[ingredientId]);
        expect(Number(returned.qty)).toBe(200);
        expect(Number(returned.unit_cost)).toBe(0.007);
        const [summary]=await L.getIngredientSummaries(pool,{ids:[ingredientId],businessDate:getBusinessDate()});
        expect(summary.expected_remaining).toBeNull();
        expect(summary.today.waste_cost).toBeCloseTo(0.7,8);
    });
    test('an explicit free receipt is a known zero cost; unpriced stock does not invent a purchase price', async () => {
        await movement('receipt',1);
        expect(await estimate()).toEqual({unit_cost:0.009,cost_source:'reference'});
        await movement('receipt',1,{unit_cost:0});
        expect(await estimate()).toEqual({unit_cost:0,cost_source:'purchase_average'});
        const [[row]]=await pool.query('SELECT unit_cost FROM ingredients WHERE id=?',[ingredientId]);
        expect(Number(row.unit_cost)).toBe(0.009);
    });
    test('pause and resume do not reuse pre-pause or paused counts, while sales estimates still work', async () => {
        await movement('count',10);
        const settings=flag=>request(app).post('/api/system/settings').set('Cookie',admin).send({recipe_ledger_enabled:flag});
        expect((await settings('0')).status).toBe(200);
        await movement('count',9);
        await sell();
        expect((await settings('1')).status).toBe(200);
        await L.backfillWorkingBalances(pool);
        const [unknown]=await L.getIngredientSummaries(pool,{ids:[ingredientId],businessDate:getBusinessDate()});
        expect(unknown.expected_remaining).toBeNull();
        await sell();
        const [[usage]]=await pool.query("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=? AND kind='usage'",[ingredientId]);
        expect(Number(usage.qty)).toBe(-200);
        await movement('count',8);
        const [known]=await L.getIngredientSummaries(pool,{ids:[ingredientId],businessDate:getBusinessDate()});
        expect(known.expected_remaining).toBe(8000);
    });
});
