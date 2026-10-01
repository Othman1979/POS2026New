const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const activation = require('../../services/StockActivationService');
const { randomBytes } = require('node:crypto');

describe('Ingredient cutover unresolved table orders', () => {
    let ingredientId;
    beforeAll(() => seedDatabase());
    beforeEach(async () => {
        const [item] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES (?,'weight','g')", [randomBytes(12).toString('hex')]);
        ingredientId = item.insertId;
    });
    afterAll(() => pool.end());
    async function order(key, payment = 'unpaid_table') {
        const [invoice] = await pool.query('INSERT INTO orders(user_id,subtotal,tax,total,payment_method) VALUES (1,5,0,5,?)', [payment]);
        await pool.query('INSERT INTO order_items(invoice_id,product_id,quantity,price_at_sale,recipe_line_key) VALUES (?,1,1,5,?)', [invoice.insertId, key]);
        return invoice.insertId;
    }
    async function frozen(ids) {
        const key = randomBytes(16).toString('hex');
        await pool.query('INSERT INTO recipe_ledger_lines(line_key,ingredient_ids) VALUES (?,?)', [key, JSON.stringify(ids)]);
        return key;
    }
    test('finds frozen ingredient usage after the current recipe has changed and ignores settled invoices', async () => {
        const key = await frozen([ingredientId]);
        await order(key, 'cash');
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toBeNull();
        const invoice = await order(key);
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toMatchObject({ invoice_id: invoice, code: 'open_order' });
        await pool.query("UPDATE orders SET payment_method='voided' WHERE invoice_id=?", [invoice]);
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toBeNull();
    });
    test('does not reinterpret an explicit frozen empty composition using a newly added recipe', async () => {
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,1)', [ingredientId]);
        await order(await frozen([]));
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toBeNull();
    });
    test('checks current composition for a legacy line without frozen evidence', async () => {
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (1,?,1)', [ingredientId]);
        const invoice = await order(null);
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toMatchObject({ invoice_id: invoice, code: 'open_order' });
        await pool.query("UPDATE orders SET payment_method='cash' WHERE invoice_id=?", [invoice]);
    });
    test('fails closed on a missing frozen record instead of assuming an empty composition', async () => {
        const invoice = await order(randomBytes(16).toString('hex'));
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toMatchObject({ invoice_id: invoice, code: 'invalid_open_recipe' });
        await pool.query("UPDATE orders SET payment_method='cash' WHERE invoice_id=?", [invoice]);
    });
    test('resolves legacy bundle members only when the bundle has no overriding recipe', async () => {
        const [bundle] = await pool.query("INSERT INTO products(name,price,category_id,is_bundle) VALUES (?,5,1,1)", [randomBytes(12).toString('hex')]);
        await pool.query('INSERT INTO product_bundle_items(bundle_id,product_id,qty) VALUES (?,2,1)', [bundle.insertId]);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (2,?,1)', [ingredientId]);
        const invoice = await order(null);
        await pool.query('UPDATE order_items SET product_id=? WHERE invoice_id=?', [bundle.insertId, invoice]);
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toMatchObject({ invoice_id: invoice });
        const [other] = await pool.query("INSERT INTO ingredients(name,measure,display_unit) VALUES (?,'weight','g')", [randomBytes(12).toString('hex')]);
        await pool.query('INSERT INTO product_recipe_lines(product_id,ingredient_id,qty_per_unit) VALUES (?,?,1)', [bundle.insertId, other.insertId]);
        expect(await activation.findIngredientOpenOrder(pool, ingredientId)).toBeNull();
        await pool.query("UPDATE orders SET payment_method='cash' WHERE invoice_id=?", [invoice]);
    });
});
