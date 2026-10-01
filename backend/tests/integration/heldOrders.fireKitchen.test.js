import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Held Orders - fire_kitchen item mapping', () => {
    let cashierCookie;
    let kitchenPrinterId;

    beforeAll(async () => {
        await seedDatabase();
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Held Mapping Kitchen', 'kitchen', 'windows', 'Held Mapping Kitchen', 'held-mapping')"
        );
        kitchenPrinterId = printer.insertId;
        await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [kitchenPrinterId, SEED.category.id]);
        const c = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = c.headers['set-cookie'][0];
    });

    afterAll(async () => {
        if (!kitchenPrinterId) return;
        await pool.query('DELETE FROM printer_categories WHERE printer_id=?', [kitchenPrinterId]);
        await pool.query('DELETE FROM printers WHERE id=?', [kitchenPrinterId]);
    });

    it('keeps repeated cart rows distinct and refreshes product categories before kitchen routing', async () => {
        const staleCategoryId = 9999;
        const holdCart = {
            items: [
                {
                    id: SEED.product1.id,
                    product_id: SEED.product1.id,
                    cartId: 'held-line-a',
                    name: SEED.product1.name,
                    qty: 1,
                    category_id: staleCategoryId
                },
                {
                    id: SEED.product1.id,
                    product_id: SEED.product1.id,
                    name: SEED.product1.name,
                    qty: 1,
                    category_id: staleCategoryId
                },
                {
                    id: SEED.product2.id,
                    product_id: SEED.product2.id,
                    cartId: 'held-line-c',
                    name: SEED.product2.name,
                    qty: 3,
                    category_id: staleCategoryId
                }
            ]
        };

        const holdRes = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({ reference_name: 'Repeated lines fire test', cart: holdCart, subtotal: 11 });
        expect(holdRes.statusCode).toBe(200);
        expect(holdRes.body.kitchen_fired).toBe(true);

        const [queueRows] = await pool.query(
            "SELECT payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id DESC LIMIT 1",
            [`kitchen:held-${holdRes.body.id}-%`]
        );
        const capturedItems = JSON.parse(queueRows[0].payload).data.items;
        expect(capturedItems).toHaveLength(3);
        const cartIds = capturedItems.map(item => item.cartId);
        expect(cartIds.every(Boolean)).toBe(true);
        expect(new Set(cartIds).size).toBe(3);

        const [[product1]] = await pool.query('SELECT category_id FROM products WHERE id = ?', [SEED.product1.id]);
        const [[product2]] = await pool.query('SELECT category_id FROM products WHERE id = ?', [SEED.product2.id]);
        const product1Lines = capturedItems.filter(item => item.product_id === SEED.product1.id);
        expect(product1Lines).toHaveLength(2);
        expect(product1Lines.map(item => item.product_id)).toEqual([SEED.product1.id, SEED.product1.id]);
        expect(product1Lines.map(item => item.id)).toEqual([SEED.product1.id, SEED.product1.id]);
        expect(product1Lines.map(item => item.category_id)).toEqual([product1.category_id, product1.category_id]);
        expect(capturedItems.find(item => item.product_id === SEED.product2.id).category_id).toBe(product2.category_id);
    });
});
