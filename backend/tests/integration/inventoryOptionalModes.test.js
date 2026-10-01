const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('optional product stock and recipe consumption', () => {
    let cashier, admin, shiftId, ingredientId;
    beforeAll(async () => {
        await seedDatabase();
        cashier = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
        admin = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await request(app).post('/api/auth/shifts?action=open').set('Cookie', cashier).send({ user_id: SEED.cashierUser.id, starting_cash: 0 });
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.cashierUser.id]);
        shiftId = shift.id;
        const [ingredient] = await pool.query("INSERT INTO ingredients(name,measure,display_unit,unit_cost) VALUES ('Optional recipe','weight','g',0.01)");
        ingredientId = ingredient.insertId;
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)', [SEED.product1.id, ingredientId]);
        await require('../../services/RecipeLedgerService').backfillWorkingBalances(pool);
    });
    afterAll(() => pool.end());

    test.each([['0', '0'], ['1', '0'], ['0', '1'], ['1', '1']])('sells mixed items and refunds with stock=%s, recipes=%s, without opening ingredient counts', async (stock, recipes) => {
        const settings = await request(app).post('/api/system/settings').set('Cookie', admin).send({ stock_enabled: stock, recipe_ledger_enabled: recipes });
        expect(settings.status, JSON.stringify(settings.body)).toBe(200);
        const opening = stock === '1' ? 20 : 0;
        await pool.query('UPDATE products SET stock=? WHERE id=?', [opening, SEED.product1.id]);
        await pool.query('UPDATE products SET stock=NULL WHERE id=?', [SEED.product2.id]);
        const [[before]] = await pool.query("SELECT COALESCE(SUM(qty),0) qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?", [ingredientId]);
        const key = randomUUID();
        const sold = await request(app).post('/api/pos/checkout').set('Cookie', cashier).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5 }, { id: SEED.product2.id, qty: 1, price: 2 }],
            shift_id: shiftId, subtotal: 7, tax: 0.8, total: 7.8, payment_method: 'cash', amount_tendered: 8, change_due: 0.2, idempotency_key: key
        });
        expect(sold.status, JSON.stringify(sold.body)).toBe(200);
        const [[order]] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', [key]);
        const [[product]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);
        expect(Number(product.stock)).toBe(stock === '1' ? 19 : 0);
        const [[used]] = await pool.query("SELECT COALESCE(SUM(qty),0) qty FROM stock_movements WHERE movement_type='ingredient' AND ingredient_id=?", [ingredientId]);
        expect(Number(used.qty) - Number(before.qty)).toBe(recipes === '1' ? -200 : 0);
        const refund = await request(app).post('/api/pos/refunds').set('Cookie', admin).send({ invoice_id: order.invoice_id, intent: 'refund', refund_method: 'cash' });
        expect(refund.status, JSON.stringify(refund.body)).toBe(200);
        const [[restored]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);
        expect(Number(restored.stock)).toBe(opening);
        const [[untracked]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);
        expect(untracked.stock).toBeNull();
    });
});
