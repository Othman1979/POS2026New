// integration/bundle.checkout.test.js — bundle expansion at checkout
import { vi } from 'vitest';

const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

function watchBusinessMutations() {
    const writes = [];
    const originalGetConnection = pool.getConnection.bind(pool);
    const patchedConnections = [];
    const getConnectionSpy = vi.spyOn(pool, 'getConnection').mockImplementation(async (...args) => {
        const conn = await originalGetConnection(...args);
        const originalQuery = conn.query;
        const originalExecute = conn.execute;
        const record = sql => {
            const statement = String(sql).replace(/\s+/g, ' ').trim();
            if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement)) writes.push(statement);
        };
        conn.query = async (sql, ...params) => {
            record(sql);
            return originalQuery.call(conn, sql, ...params);
        };
        conn.execute = async (sql, ...params) => {
            record(sql);
            return originalExecute.call(conn, sql, ...params);
        };
        patchedConnections.push({ conn, originalQuery, originalExecute });
        return conn;
    });

    return {
        writes,
        restore() {
            getConnectionSpy.mockRestore();
            for (const { conn, originalQuery, originalExecute } of patchedConnections) {
                conn.query = originalQuery;
                conn.execute = originalExecute;
            }
        }
    };
}

describe('Bundle Checkout', () => {
    let cashierCookie;
    let cashierShiftId;

    beforeEach(async () => {
        await seedDatabase();
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = loginRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    async function openShift() {
        await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
        const [rows] = await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [SEED.cashierUser.id]);
        cashierShiftId = rows[0].id;
        return cashierShiftId;
    }

    // Bundle line: price 10.00 pre-tax, 16% tax => tax 1.60, total 11.60
    function bundleCartItem(overrides = {}) {
        return {
            id: SEED.bundleProduct.id,
            product_id: SEED.bundleProduct.id,
            qty: 1,
            price: SEED.bundleProduct.price,
            is_bundle: true,
            bundleItems: [
                { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, category_id: 1, tax_rate: 16, removed: false },
                { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, category_id: 1, tax_rate: 0, removed: false }
            ],
            ...overrides
        };
    }

    it('inserts a priced parent row and zero-priced child rows linked by parent_item_id', async () => {
        await openShift();
        const mutations = watchBusinessMutations();
        let res;
        try {
            res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [bundleCartItem()],
                    shift_id: cashierShiftId,
                    subtotal: 10.00, tax: 1.60, total: 11.60,
                    payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                    idempotency_key: 'bundle_basic_key'
                });
            expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
            expect(mutations.writes.filter(sql => sql.startsWith('INSERT INTO order_items'))).toHaveLength(2);
        } finally {
            mutations.restore();
        }

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const [items] = await pool.query(
            "SELECT * FROM order_items WHERE invoice_id = ? ORDER BY sort_order", [res.body.invoice_id]
        );
        expect(items).toHaveLength(3);

        const parent = items.find(i => i.parent_item_id === null);
        expect(parent.product_id).toBe(SEED.bundleProduct.id);
        expect(Number(parent.price_at_sale)).toBe(10);

        const children = items.filter(i => i.parent_item_id !== null);
        expect(children).toHaveLength(2);
        for (const c of children) {
            expect(c.parent_item_id).toBe(parent.id);
            expect(Number(c.price_at_sale)).toBe(0);
            expect(Number(c.tax_rate)).toBe(0);
            expect(Number(c.tax_amount)).toBe(0);
        }
    });

    it('only the parent row carries tax', async () => {
        await openShift();
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [bundleCartItem()],
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                idempotency_key: 'bundle_tax_key'
            });
        expect(res.statusCode).toBe(200);

        const [items] = await pool.query(
            "SELECT tax_amount, parent_item_id FROM order_items WHERE invoice_id = ?", [res.body.invoice_id]
        );
        const taxed = items.filter(i => Number(i.tax_amount) > 0);
        expect(taxed).toHaveLength(1);
        expect(taxed[0].parent_item_id).toBeNull();
    });

    it('flushes ordinary parents around a bundle while keeping all sort orders stable', async () => {
        await openShift();
        const mutations = watchBusinessMutations();
        let res;
        try {
            res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [
                        { id: SEED.product1.id, qty: 1, price: 5 },
                        bundleCartItem(),
                        { id: SEED.product2.id, qty: 1, price: 2 }
                    ],
                    shift_id: cashierShiftId,
                    subtotal: 17, tax: 2.4, total: 19.4,
                    payment_method: 'cash', amount_tendered: 20, change_due: 0.6,
                    idempotency_key: 'bundle-between-ordinary-parents'
                });
            expect(mutations.writes.filter(sql => sql.startsWith('INSERT INTO order_items'))).toHaveLength(4);
        } finally {
            mutations.restore();
        }

        expect(res.statusCode).toBe(200);
        const [items] = await pool.query(
            'SELECT id, product_id, sort_order, parent_item_id FROM order_items WHERE invoice_id=? ORDER BY sort_order',
            [res.body.invoice_id]
        );
        expect(items.map(item => Number(item.sort_order))).toEqual([0, 1, 2, 3, 4]);
        const bundleParent = items.find(item => Number(item.product_id) === SEED.bundleProduct.id && item.parent_item_id === null);
        expect(items.filter(item => item.parent_item_id === bundleParent.id).map(item => Number(item.product_id)).sort())
            .toEqual([SEED.product1.id, SEED.product2.id]);
    });

    it('keeps children scoped to their own bundle parent IDs', async () => {
        await openShift();
        const mutations = watchBusinessMutations();
        let res;
        try {
            res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [bundleCartItem(), bundleCartItem()],
                    shift_id: cashierShiftId,
                    subtotal: 20, tax: 3.2, total: 23.2,
                    payment_method: 'cash', amount_tendered: 30, change_due: 6.8,
                    idempotency_key: 'two-bundle-parent-boundaries'
                });
            expect(mutations.writes.filter(sql => sql.startsWith('INSERT INTO order_items'))).toHaveLength(4);
        } finally {
            mutations.restore();
        }

        expect(res.statusCode).toBe(200);
        const [items] = await pool.query(
            'SELECT id, product_id, parent_item_id FROM order_items WHERE invoice_id=? ORDER BY sort_order',
            [res.body.invoice_id]
        );
        const parents = items.filter(item => item.parent_item_id === null);
        expect(parents).toHaveLength(2);
        expect(new Set(parents.map(parent => parent.id)).size).toBe(2);
        for (const parent of parents) {
            expect(items.filter(item => item.parent_item_id === parent.id).map(item => Number(item.product_id)).sort())
                .toEqual([SEED.product1.id, SEED.product2.id]);
        }
    });

    it('rejects a fresh catalog bundle without bundleItems before checkout writes', async () => {
        await openShift();
        const [[beforeOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [[beforeItems]] = await pool.query('SELECT COUNT(*) AS count FROM order_items');

        const { bundleItems: _ignored, ...parentOnlyBundle } = bundleCartItem();
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [parentOnlyBundle],
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                idempotency_key: 'bundle-parent-only-checkout'
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe('Invalid bundle contents.');
        const [[afterOrders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const [[afterItems]] = await pool.query('SELECT COUNT(*) AS count FROM order_items');
        expect(Number(afterOrders.count)).toBe(Number(beforeOrders.count));
        expect(Number(afterItems.count)).toBe(Number(beforeItems.count));
    });

    it('preserves the existing zero-member bundle behavior for an empty array', async () => {
        await openShift();
        await pool.query('DELETE FROM product_bundle_items WHERE bundle_id = ?', [SEED.bundleProduct.id]);
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [bundleCartItem({ bundleItems: [] })],
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                idempotency_key: 'empty-member-bundle-checkout'
            });

        expect(res.statusCode).toBe(200);
        const [items] = await pool.query('SELECT parent_item_id FROM order_items WHERE invoice_id = ?', [res.body.invoice_id]);
        expect(items).toHaveLength(1);
        expect(items[0].parent_item_id).toBeNull();
    });

    it('bundle qty=2 multiplies child quantities', async () => {
        await openShift();
        // qty 2 => subtotal 20.00, tax 3.20, total 23.20
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [bundleCartItem({ qty: 2 })],
                shift_id: cashierShiftId,
                subtotal: 20.00, tax: 3.20, total: 23.20,
                payment_method: 'cash', amount_tendered: 30.00, change_due: 6.80,
                idempotency_key: 'bundle_qty2_key'
            });
        expect(res.statusCode).toBe(200);

        const [children] = await pool.query(
            "SELECT quantity FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL", [res.body.invoice_id]
        );
        expect(children).toHaveLength(2);
        for (const c of children) expect(Number(c.quantity)).toBe(2);
    });

    // ── Security: forge rejection tests ──────────────────────────────────────
    it('rejects a non-bundle product with forged bundleItems (forge: non-bundle parent)', async () => {
        await openShift();
        // product1 (id=1) has is_bundle=0 — attaching bundleItems is a client forgery
        const forgedCart = [{
            id: SEED.product1.id,
            product_id: SEED.product1.id,
            qty: 1,
            price: SEED.product1.price,
            bundleItems: [
                { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, removed: false }
            ]
        }];
        // product1 tax_rate=16 => subtotal=5.00, tax=0.80, total=5.80
        const mutations = watchBusinessMutations();
        try {
            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: forgedCart,
                    shift_id: cashierShiftId,
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    payment_method: 'cash', amount_tendered: 10.00, change_due: 4.20,
                    idempotency_key: 'forge_nonbundle_key'
                });
            expect(res.statusCode).toBe(400);
            expect(mutations.writes).toEqual([]);
        } finally {
            mutations.restore();
        }
        // Rollback must leave no order or order_items
        const [orders] = await pool.query(
            "SELECT invoice_id FROM orders WHERE idempotency_key = ?", ['forge_nonbundle_key']
        );
        expect(orders).toHaveLength(0);
    });

    it('rejects a real bundle with a forged child product_id not in bundle definition (forge: non-member child)', async () => {
        await openShift();
        // product id=3 ('No Stock Item') is NOT a member of bundle id=4 per product_bundle_items
        const forgedBundle = bundleCartItem({
            bundleItems: [
                { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, removed: false },
                { product_id: 3, name: 'No Stock Item', qty: 1, removed: false }  // not a member
            ]
        });
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [forgedBundle],
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                idempotency_key: 'forge_nonmember_key'
            });
        expect(res.statusCode).toBe(400);
        const [orders] = await pool.query(
            "SELECT invoice_id FROM orders WHERE idempotency_key = ?", ['forge_nonmember_key']
        );
        expect(orders).toHaveLength(0);
    });
    it('rejects a custom item (null product_id) with a forged bundleItems array (forge: null-parent bundle)', async () => {
        await openShift();
        // A forged line: product_id null (custom item) but carries bundleItems pointing at a real product.
        // Without the fix this would pass validation (filter skips null product_id) and mint child rows.
        const forgedCart = [{
            product_id: null,
            name: 'Free Combo',
            qty: 1,
            price: 0,
            bundleItems: [
                { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, removed: false }
            ]
        }];
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: forgedCart,
                shift_id: cashierShiftId,
                subtotal: 0, tax: 0, total: 0,
                payment_method: 'cash', amount_tendered: 0, change_due: 0,
                idempotency_key: 'forge_null_parent_bundle_key'
            });
        expect(res.statusCode).toBe(400);
        // Rollback must leave no order or order_items
        const [orders] = await pool.query(
            "SELECT invoice_id FROM orders WHERE idempotency_key = ?", ['forge_null_parent_bundle_key']
        );
        expect(orders).toHaveLength(0);
    });
    // ─────────────────────────────────────────────────────────────────────────

    it('removed sub-item is skipped and logged to bundle_modifications', async () => {
        await openShift();
        const item = bundleCartItem();
        item.bundleItems[1].removed = true; // remove the Drink
        // NOTE: _modified intentionally NOT set — audit must be server-derived (M2 fix)

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [item],
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                idempotency_key: 'bundle_removed_key'
            });
        expect(res.statusCode).toBe(200);

        const [children] = await pool.query(
            "SELECT item_name FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL", [res.body.invoice_id]
        );
        expect(children).toHaveLength(1);
        expect(children[0].item_name).toBe(SEED.product1.name);

        const [mods] = await pool.query(
            "SELECT * FROM bundle_modifications WHERE order_id = ?", [res.body.invoice_id]
        );
        expect(mods).toHaveLength(1);
        expect(mods[0].action).toBe('removed');
        expect(mods[0].product_name).toBe(SEED.product2.name);
        expect(mods[0].cashier_id).toBe(SEED.cashierUser.id);
    });

    // ── Security: DB-driven child qty; client sub.qty must be ignored (I1 fix) ──
    it('ignores forged client sub.qty; child qty = DB member qty × parent qty (qty-forge)', async () => {
        await openShift();
        // Client sends qty:99 for both members — DB defines qty=1 each, parentQty=1
        // Stored child quantity must be 1, NOT 99.
        const forgedCart = [bundleCartItem({
            bundleItems: [
                { product_id: SEED.product1.id, name: SEED.product1.name, qty: 99, removed: false },
                { product_id: SEED.product2.id, name: SEED.product2.name, qty: 99, removed: false },
            ],
        })];
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: forgedCart,
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                idempotency_key: 'forge_qty_key',
            });
        expect(res.statusCode).toBe(200);
        const [children] = await pool.query(
            'SELECT quantity FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL',
            [res.body.invoice_id]
        );
        expect(children).toHaveLength(2);
        // DB member qty (1.000) × parentQty (1) = 1, regardless of client's 99
        for (const c of children) expect(Number(c.quantity)).toBe(1);
    });

    // ── Security: null child product_id must be rejected (I2 fix) ──────────────
    it('rejects a real bundle with a null-product_id child entry (forge: null child)', async () => {
        await openShift();
        // Real bundle parent (SEED.bundleProduct.id = 4, is_bundle=1)
        // but one bundleItems entry has product_id: null → must be rejected 400.
        // Pre-fix: null product_id skipped member check → child row minted free.
        // Post-fix: validateBundleCartLines rejects any null child product_id.
        const forgedBundle = bundleCartItem({
            bundleItems: [
                { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, removed: false },
                { product_id: null, name: 'Injected Free Item', qty: 1, removed: false },
            ],
        });
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [forgedBundle],
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 20.00, change_due: 8.40,
                idempotency_key: 'forge_null_child_key',
            });
        expect(res.statusCode).toBe(400);
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key = ?', ['forge_null_child_key']
        );
        expect(orders).toHaveLength(0);
    });

    it('bundle corruption: rejects raw nested bundle quantity before normalization and rolls back checkout', async () => {
        await openShift();
        const idempotencyKey = 'bundle-corrupt-raw-cart';

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [bundleCartItem({ qty: 0 })],
                shift_id: cashierShiftId,
                subtotal: 0, tax: 0, total: 0,
                payment_method: 'cash', amount_tendered: 0, change_due: 0,
                idempotency_key: idempotencyKey
            });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key = ?',
            [idempotencyKey]
        );
        expect(orders).toHaveLength(0);
    });
});
