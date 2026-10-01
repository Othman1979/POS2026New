const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { insertShift, insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');

describe('Daily Reports Sales Details API', () => {
    let adminCookie;

    beforeAll(async () => {
        await seedDatabase();

        const adminLoginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLoginRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    it('returns sales details without bundle or service charge pollution, handles event-date refunds', async () => {
        // Clear DB for test
        await pool.query('DELETE FROM refund_items');
        await pool.query('DELETE FROM refunds');
        await pool.query('DELETE FROM order_items');
        await pool.query('DELETE FROM orders');
        await pool.query('DELETE FROM shifts');

        // Tuesday (current period): 2026-07-14
        const shiftTuesday = await insertShift(pool, { opened_at: '2026-07-14 06:00:00', closed_at: '2026-07-14 14:00:00', status: 'closed' });

        // Monday (past period): 2026-07-13
        const shiftMonday = await insertShift(pool, { opened_at: '2026-07-13 06:00:00', closed_at: '2026-07-13 14:00:00', status: 'closed' });

        // 1. Monday sale: 1 burger (unit price 5.80, tax-inclusive)
        const oMonday = await insertPaidOrder(pool, {
            shift_id: shiftMonday,
            total: 5.80,
            subtotal: 5.00,
            tax: 0.80,
            payment_method: 'cash',
            created_at: '2026-07-13 10:00:00',
            invoice_issued_at: '2026-07-13 10:00:00'
        });
        const oiMondayBurger = await insertOrderItem(pool, {
            invoice_id: oMonday,
            product_id: SEED.product1.id, // Test Burger
            quantity: 1,
            price_at_sale: 5.00,
            tax_rate: 16.00,
            tax_amount: 0.80
        });

        // 2. Tuesday sale: 5 burgers (unit price 5.80 each, tax-inclusive, total = 29.00)
        // One of the orders has Auto-Gratuity of 5.80 (so service charge collected should be 5.80)
        const oTuesdaySales = [];
        for (let i = 0; i < 5; i++) {
            const isFirst = (i === 0);
            const total = isFirst ? 11.60 : 5.80; // First order has service charge
            const orderId = await insertPaidOrder(pool, {
                shift_id: shiftTuesday,
                total,
                subtotal: isFirst ? 10.00 : 5.00,
                tax: isFirst ? 1.60 : 0.80,
                payment_method: 'cash',
                created_at: `2026-07-14 09:0${i}:00`,
                invoice_issued_at: `2026-07-14 09:0${i}:00`
            });
            oTuesdaySales.push(orderId);

            // Add Burger
            await insertOrderItem(pool, {
                invoice_id: orderId,
                product_id: SEED.product1.id,
                quantity: 1,
                price_at_sale: 5.00,
                tax_rate: 16.00,
                tax_amount: 0.80
            });

            if (isFirst) {
                // Add Auto-Gratuity
                const agItemId = await insertOrderItem(pool, {
                    invoice_id: orderId,
                    quantity: 1,
                    price_at_sale: 5.80,
                    tax_rate: 0,
                    tax_amount: 0
                });
                await pool.query("UPDATE order_items SET note = 'Auto-Gratuity', product_id = NULL WHERE id = ?", [agItemId]);
            }
        }

        // 3. Tuesday refund of Monday's Burger
        const rTuesday = await pool.query(`
            INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, refund_method, user_id, shift_id, created_at)
            VALUES ('refund', ?, 'item', 5.00, 0.80, 5.80, 'cash', ?, ?, '2026-07-14 11:00:00')
        `, [oMonday, SEED.adminUser.id, shiftTuesday]);
        const refundId = rTuesday[0].insertId;

        // Refund item link:
        await pool.query(`
            INSERT INTO refund_items (refund_id, order_item_id, product_id, quantity, unit_price, line_subtotal, line_tax, line_total)
            VALUES (?, ?, ?, 1, 5.00, 5.00, 0.80, 5.80)
        `, [refundId, oiMondayBurger, SEED.product1.id]);

        // 4. Seed a Bundle Parent and Bundle Child on Tuesday to ensure children are excluded
        const oBundle = await insertPaidOrder(pool, {
            shift_id: shiftTuesday,
            total: 12.00,
            subtotal: 12.00,
            tax: 0.00,
            payment_method: 'cash',
            created_at: '2026-07-14 12:00:00',
            invoice_issued_at: '2026-07-14 12:00:00'
        });
        const parentOi = await insertOrderItem(pool, {
            invoice_id: oBundle,
            product_id: SEED.product2.id, // Say product2 is Family Package
            quantity: 1,
            price_at_sale: 12.00,
            tax_rate: 0,
            tax_amount: 0
        });
        // Update product name to Family Package for test
        await pool.query("UPDATE products SET name = 'Family Package' WHERE id = ?", [SEED.product2.id]);

        // Child item has parent_item_id set
        const childOi = await insertOrderItem(pool, {
            invoice_id: oBundle,
            product_id: SEED.product1.id,
            quantity: 1,
            price_at_sale: 0.00,
            tax_rate: 0,
            tax_amount: 0
        });
        await pool.query("UPDATE order_items SET parent_item_id = ?, item_name = 'Bundle Child' WHERE id = ?", [parentOi, childOi]);

        // Run request
        const res = await request(app)
            .get('/api/admin/reports/sales-details?start_date=2026-07-14&end_date=2026-07-14')
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);

        // Check products:
        // Product1 is "Test Burger" (which is product_id = SEED.product1.id, but name might be seeded name)
        // Let's find it by product_id
        const burger = res.body.products.find(row => row.product_id === SEED.product1.id);
        expect(burger).toBeDefined();
        expect(Number(burger.sold_qty)).toBe(5);
        expect(Number(burger.returned_qty)).toBe(1);
        expectMoney(burger.sold_amount, 29.00); // 5 burgers * 5.80 tax-inclusive
        expectMoney(burger.returned_amount, 5.80);
        expectMoney(burger.net_sales, 23.20);

        // Service charge checking
        expect(res.body.products.some(row => row.item_name === '10% Service Charge' || row.item_name === 'Auto-Gratuity')).toBe(false);
        expectMoney(res.body.totals.service_charges_collected, 5.80);

        // Bundle checking
        expect(res.body.products.filter(row => row.item_name === 'Family Package')).toHaveLength(1);
        expectMoney(res.body.products.find(row => row.item_name === 'Family Package').sold_amount, 12.00);
        expect(res.body.products.some(row => row.item_name === 'Bundle Child')).toBe(false);

        // Check categories: Food -> Burgers hierarchy
        // Seed category structure: make sure category of product1 has parent_id or name
        // (the seed fixture already builds category structures, we just assert categories structure is present)
        expect(res.body.categories.length).toBeGreaterThan(0);
    });
});
