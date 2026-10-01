const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('recipe ledger combined restaurant flow regressions', () => {
    let cookie, ingredientId;
    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        const [created] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES ('Phase 4 chicken','weight','g')");
        ingredientId = created.insertId;
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,200)', [SEED.product1.id, ingredientId]);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='recipe_ledger_enabled'");
    });
    afterAll(async () => pool.end());
    const burger = extra => ({ id: SEED.product1.id, qty: 1, price: 5, note: '', ...extra });
    async function save(cart, invoiceId = null) {
        const result = await request(app).post('/api/pos/table_order').set('Cookie', cookie).send({
            table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart,
            subtotal: cart.length * 5, tax: cart.length * 0.8, total: cart.length * 5.8
        });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body.invoice_id || result.body.order_id;
    }
    async function lines(invoiceId) {
        return (await pool.query('SELECT id,recipe_line_key FROM order_items WHERE invoice_id=? ORDER BY id', [invoiceId]))[0];
    }
    it.each([{ count: 1, newFirst: false }, { count: 3, newFirst: false }, { count: 3, newFirst: true }])(
        'adds a fresh burger beside $count saved duplicate lines (newFirst=$newFirst) with a current recipe and independent key',
        async ({ count, newFirst }) => {
            const invoiceId = await save(Array.from({ length: count }, () => burger()));
            const original = await lines(invoiceId);
            await save(original.map(line => burger({ order_item_id: line.id })), invoiceId);
            const resaved = await lines(invoiceId);
            expect(resaved.map(line => line.recipe_line_key)).toEqual(original.map(line => line.recipe_line_key));
            await pool.query('UPDATE product_recipe_lines SET qty_per_unit=250 WHERE product_id=?', [SEED.product1.id]);
            const savedCart = resaved.map(line => burger({ order_item_id: line.id }));
            await save(newFirst ? [burger(), ...savedCart] : [...savedCart, burger()], invoiceId);
            const current = await lines(invoiceId);
            expect(new Set(current.map(line => line.recipe_line_key)).size).toBe(count + 1);
            const newLine = current.find(line => !original.some(old => old.recipe_line_key === line.recipe_line_key));
            expect(newLine).toBeDefined();
            const [usage] = await pool.query("SELECT line_key,SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient'  GROUP BY line_key");
            expect(Number(usage.find(row => row.line_key === newLine.recipe_line_key).qty)).toBe(-250);
            for (const line of original) expect(Number(usage.find(row => row.line_key === line.recipe_line_key).qty)).toBe(-200);
            await save(current.map(line => burger({ order_item_id: line.id })), invoiceId);
            const [[total]] = await pool.query("SELECT SUM(qty) qty FROM stock_movements WHERE movement_type='ingredient' ");
            expect(Number(total.qty)).toBe(-count * 200 - 250);
        }
    );
});
