import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('partial table void batched writes', () => {
    let cookie;
    const post = (path, body) => request(app).post(`/api/${path}`).set('Cookie', cookie).send(body);
    const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
    const ok = res => { expect(res.statusCode, JSON.stringify(res.body)).toBe(200); return res.body; };
    const load = async id => ok(await request(app).get(`/api/pos/table_order?order_id=${id}`).set('Cookie', cookie));
    const num = value => Number(Number(value).toFixed(6));

    beforeEach(async () => {
        await seedDatabase();
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
        await pool.query('UPDATE products SET stock=100 WHERE id IN (1,2,4)');
    });
    afterAll(() => pool.end());

    function watchWrites() {
        const writes = [];
        const originalGetConnection = pool.getConnection.bind(pool);
        const patched = [];
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async (...args) => {
            const conn = await originalGetConnection(...args);
            const originalQuery = conn.query;
            conn.query = async (sql, ...params) => {
                writes.push(String(sql).replace(/\s+/g, ' ').trim());
                return originalQuery.call(conn, sql, ...params);
            };
            patched.push({ conn, originalQuery });
            return conn;
        });
        return {
            writes,
            restore() {
                spy.mockRestore();
                for (const { conn, originalQuery } of patched) conn.query = originalQuery;
            }
        };
    }

    const saveMultiLineOrder = async () => {
        const cart = [
            { id: 1, name: 'Test Burger', qty: 3, price: 5, tax_rate: 16 },
            { id: 2, name: 'Test Drink', qty: 2, price: 2, tax_rate: 0 },
            { id: 10, name: 'Modifier Product', qty: 2, price: 7, tax_rate: 16, selected_modifiers: [{ name: 'Size', option: 'Large', price: 2 }] },
            {
                id: 4, product_id: 4, name: 'Family Package', qty: 2, price: 10, tax_rate: 16, is_bundle: true,
                bundleItems: [
                    { product_id: 1, name: 'Test Burger', qty: 1, category_id: 1, removed: false },
                    { product_id: 2, name: 'Test Drink', qty: 1, category_id: 1, removed: false }
                ]
            }
        ];
        const saved = ok(await post('pos/table_order', { table_id: SEED.table.id, cart, subtotal: 53, tax: 7.84, total: 60.84 }));
        return load(saved.invoice_id);
    };

    it.each([0, 1])('writes identical tax columns and refund rows with one statement per table (xyz=%s)', async xyz => {
        await pool.query('UPDATE users SET xyz=? WHERE id=1', [xyz]);
        const bill = await saveMultiLineOrder();
        const before = await rows('SELECT * FROM order_items WHERE invoice_id=? ORDER BY id', [bill.invoice_id]);
        const parentsBefore = before.filter(row => row.parent_item_id == null);
        expect(parentsBefore).toHaveLength(4);
        expect(before.filter(row => row.parent_item_id != null)).toHaveLength(2);

        const voidQty = new Map(parentsBefore.map(row => [Number(row.id), Number(row.product_id) === 2 ? 0 : 1]));
        const items = parentsBefore.filter(row => voidQty.get(Number(row.id)) > 0)
            .map(row => ({ order_item_id: row.id, qty: voidQty.get(Number(row.id)) }));
        expect(items).toHaveLength(3);

        const watcher = watchWrites();
        let res;
        try {
            res = await post('pos/refunds', { invoice_id: bill.invoice_id, intent: 'void', expected_version: bill.version, items });
        } finally {
            watcher.restore();
        }
        ok(res);

        const taxUpdates = watcher.writes.filter(sql => /^UPDATE order_items SET tax_rate/i.test(sql));
        const refundItemInserts = watcher.writes.filter(sql => /^INSERT INTO refund_items/i.test(sql));
        expect(taxUpdates.length).toBeLessThan(parentsBefore.length);
        expect(taxUpdates).toHaveLength(1);
        expect(refundItemInserts).toHaveLength(xyz ? 0 : 1);

        const after = await rows('SELECT * FROM order_items WHERE invoice_id=? ORDER BY id', [bill.invoice_id]);
        const parentsAfter = after.filter(row => row.parent_item_id == null);
        expect(parentsAfter.map(row => Number(row.id))).toEqual(parentsBefore.map(row => Number(row.id)));
        const expectedParents = parentsBefore.map(row => {
            const remaining = Number(row.quantity) - voidQty.get(Number(row.id));
            return {
                id: Number(row.id),
                quantity: num(remaining),
                tax_rate: num(row.tax_rate),
                jofotara_tax_category: row.jofotara_tax_category,
                tax_amount: num(Number(row.tax_amount) * remaining / Number(row.quantity))
            };
        });
        expect(parentsAfter.map(row => ({
            id: Number(row.id),
            quantity: num(row.quantity),
            tax_rate: num(row.tax_rate),
            jofotara_tax_category: row.jofotara_tax_category,
            tax_amount: num(row.tax_amount)
        }))).toEqual(expectedParents);
        const children = after.filter(row => row.parent_item_id != null);
        expect(children).toHaveLength(2);
        children.forEach(child => expect(num(child.quantity)).toBe(1));

        const refundItems = await rows('SELECT * FROM refund_items ORDER BY id');
        if (xyz) {
            expect(refundItems).toEqual([]);
            expect(await rows('SELECT * FROM refunds')).toEqual([]);
            return;
        }
        const [refund] = await rows("SELECT * FROM refunds WHERE kind='void'");
        expect(refund.scope).toBe('item');
        const expectedRefundItems = items.map(({ order_item_id, qty }) => {
            const row = parentsBefore.find(item => Number(item.id) === Number(order_item_id));
            const fraction = qty / Number(row.quantity);
            const lineSubtotal = num((Number(row.price_at_sale) + Number(row.modifier_surcharge || 0)) * Number(row.quantity) * fraction);
            const lineTax = num(Number(row.tax_amount) * fraction);
            return {
                refund_id: Number(refund.id),
                order_item_id: Number(row.id),
                product_id: Number(row.product_id),
                item_name: row.item_name,
                note: row.note,
                quantity: num(qty),
                unit_price: num(row.price_at_sale),
                line_subtotal: lineSubtotal,
                line_tax: lineTax,
                line_total: num(lineSubtotal + lineTax)
            };
        });
        expect(refundItems.map(row => ({
            refund_id: Number(row.refund_id),
            order_item_id: Number(row.order_item_id),
            product_id: Number(row.product_id),
            item_name: row.item_name,
            note: row.note,
            quantity: num(row.quantity),
            unit_price: num(row.unit_price),
            line_subtotal: num(row.line_subtotal),
            line_tax: num(row.line_tax),
            line_total: num(row.line_total)
        }))).toEqual(expectedRefundItems);
        expect(num(refund.subtotal_refunded)).toBe(num(expectedRefundItems.reduce((sum, row) => sum + row.line_subtotal, 0)));
        expect(num(refund.tax_refunded)).toBe(num(expectedRefundItems.reduce((sum, row) => sum + row.line_tax, 0)));
    });
});
