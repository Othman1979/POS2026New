const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { invalidateUserSessions } = require('../../middleware/auth');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('service-charge snapshots', () => {
    let cashierCookie;
    let adminCookie;
    let waiterCookie;

    beforeEach(async () => {
        await seedDatabase();
        const cashier = await request(app).post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashier.headers['set-cookie'][0];
        const admin = await request(app).post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = admin.headers['set-cookie'][0];
        const waiter = await request(app).post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        waiterCookie = waiter.headers['set-cookie'][0];
    });

    afterAll(async () => pool.end());

    const grantCashier = async () => {
        await pool.query(
            "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.service_charge')",
            [SEED.cashierUser.id]
        );
        invalidateUserSessions(SEED.cashierUser.id);
    };

    const enable = async (percentage = '12.5', tax = '16', taxCategory = Number(tax) > 0 ? 'S' : 'O') => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='service_charge_enabled'");
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='service_charge_percentage'", [percentage]);
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='service_charge_tax_rate'", [tax]);
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='service_charge_jofotara_tax_category'", [taxCategory]);
    };

    const enableAutomaticTables = async (percentage = '10', tax = '5') => {
        await enable(percentage, tax);
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='auto_apply_service_charge'");
    };

    const createCashierDraft = async () => {
        await grantCashier();
        await enable();
        return request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', cashierCookie).send({});
    };

    const claimHeld = async (cookie, heldId, token = 'b'.repeat(64)) => {
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [heldId]);
        const response = await request(app)
            .post(`/api/pos/held_orders/${heldId}/claim`)
            .set('Cookie', cookie)
            .send({ claim_token: token, expected_version: Number(row?.version || 1) });
        return { response, token, order: response.body.order, claim: response.body.claim };
    };

    it('forbids creation without service-charge permission', async () => {
        await enable();
        const res = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', cashierCookie).send({});
        expect(res.statusCode).toBe(403);
        const [[row]] = await pool.query('SELECT COUNT(*) count FROM service_charge_snapshots');
        expect(Number(row.count)).toBe(0);
    });

    it('lets a table user create the automatic snapshot without manual service-charge permission', async () => {
        await enableAutomaticTables();
        const res = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', cashierCookie)
            .send({ auto_table: true, table_id: SEED.table.id });

        expect(res.statusCode).toBe(200);
        expect(res.body.snapshot).toMatchObject({ percentage: 10, taxRate: 5, version: 1 });
    });

    it('rejects the automatic snapshot path for an unknown table', async () => {
        await enableAutomaticTables();
        const res = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', cashierCookie)
            .send({ auto_table: true, table_id: 999999 });

        expect(res.statusCode).toBe(404);
    });

    it('forbids creation when the setting is disabled', async () => {
        await grantCashier();
        const res = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', cashierCookie).send({});
        expect(res.statusCode).toBe(403);
        const [[row]] = await pool.query('SELECT COUNT(*) count FROM service_charge_snapshots');
        expect(Number(row.count)).toBe(0);
    });

    it('freezes enabled percentage and tax for 24 hours', async () => {
        const res = await createCashierDraft();
        expect(res.statusCode).toBe(200);
        expect(res.body.snapshot).toMatchObject({ percentage: 12.5, taxRate: 16, taxCategory: 'S', version: 1 });
        const [[row]] = await pool.query('SELECT * FROM service_charge_snapshots WHERE id=?', [res.body.snapshot.id]);
        expect(row.state).toBe('draft');
        expect(row.percentage).toBe('12.5000');
        expect(row.tax_rate).toBe('16.00');
        expect(row.jofotara_tax_category).toBe('S');
        const hours = (new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 3_600_000;
        expect(hours).toBeCloseTo(24, 2);
    });

    it('lets the creator abandon a draft', async () => {
        const created = await createCashierDraft();
        const res = await request(app).delete(`/api/pos/service_charge_snapshots/${created.body.snapshot.id}`)
            .set('Cookie', cashierCookie).send({ version: 1 });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query('SELECT state, version FROM service_charge_snapshots WHERE id=?', [created.body.snapshot.id]);
        expect(row).toMatchObject({ state: 'abandoned', version: 2 });
    });

    it('rejects abandonment by another user', async () => {
        const created = await createCashierDraft();
        const res = await request(app).delete(`/api/pos/service_charge_snapshots/${created.body.snapshot.id}`)
            .set('Cookie', adminCookie).send({ version: 1 });
        expect(res.statusCode).toBe(409);
        const [[row]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [created.body.snapshot.id]);
        expect(row.state).toBe('draft');
    });

    it('rejects abandonment after the draft is bound', async () => {
        const created = await createCashierDraft();
        await pool.query("UPDATE service_charge_snapshots SET state='open_order', holder_type='order', holder_id='10' WHERE id=?", [created.body.snapshot.id]);
        const res = await request(app).delete(`/api/pos/service_charge_snapshots/${created.body.snapshot.id}`)
            .set('Cookie', cashierCookie).send({ version: 1 });
        expect(res.statusCode).toBe(409);
        const [[row]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [created.body.snapshot.id]);
        expect(row.state).toBe('open_order');
    });

    it('rejects direct checkout with a fee but no snapshot', async () => {
        await enable('10', '0');
        const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 0, note: 'Auto-Gratuity' }
            ],
            subtotal: 5.5, tax: 0.8, total: 6.3,
            payment_method: 'cash', amount_tendered: 10, change_due: 3.7
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/snapshot/i);
    });

    it('finalizes and links a valid direct-checkout snapshot', async () => {
        await enable('10', '0');
        const created = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        const snapshot = created.body.snapshot;
        const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: 'forged name', price: 0.5, qty: 1, tax_rate: 99, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: snapshot.id, version: snapshot.version },
            subtotal: 5.5, tax: 0.8, total: 6.3,
            payment_method: 'cash', amount_tendered: 10, change_due: 3.7
        });
        expect(res.statusCode).toBe(200);
        const [[state]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(state).toMatchObject({ state: 'finalized', holder_id: String(res.body.invoice_id) });
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [res.body.invoice_id]);
        expect(order.service_charge_snapshot_id).toBe(snapshot.id);
        const [[fee]] = await pool.query("SELECT item_name, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [res.body.invoice_id]);
        expect(fee.item_name).toBe('10% Service Charge');
        expect(fee.tax_rate).toBe('0.00');
    });

    it('abandons an unused draft when checkout has no fee', async () => {
        await enable('10', '0');
        const created = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        const snapshot = created.body.snapshot;
        const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            service_charge_snapshot: { id: snapshot.id, version: snapshot.version },
            subtotal: 5, tax: 0.8, total: 5.8,
            payment_method: 'cash', amount_tendered: 10, change_due: 4.2
        });
        expect(res.statusCode).toBe(200);
        const [[state]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(state).toMatchObject({ state: 'abandoned', holder_type: 'none', holder_id: null });
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [res.body.invoice_id]);
        expect(order.service_charge_snapshot_id).toBeNull();
    });

    it('binds a draft to an open table and returns its frozen snapshot', async () => {
        await enable('10', '5');
        const created = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        const snapshot = created.body.snapshot;
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: 'junk', price: 0.5, qty: 1, tax_rate: 99, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: snapshot.id, version: 1 },
            subtotal: 5.5, tax: 0.83, total: 6.33
        });
        expect(save.statusCode).toBe(200);
        const [[state]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(state).toMatchObject({ state: 'open_order', holder_id: String(save.body.invoice_id) });
        const loaded = await request(app).get(`/api/pos/table_order?order_id=${save.body.invoice_id}`)
            .set('Cookie', adminCookie);
        expect(loaded.body.service_charge_snapshot).toMatchObject({
            id: snapshot.id, percentage: 10, taxRate: 5, version: 2
        });
        const loadedFee = loaded.body.cart.find(item => item.note === 'Auto-Gratuity');
        expect(loadedFee).toMatchObject({ discountType: null, discountValue: 0 });

        await enable('20', '16');
        const updateCart = [
            { id: SEED.product1.id, price: 5, qty: 2 },
            { id: 'FEE_2', product_id: null, name: '20% forged', price: 1, qty: 1, tax_rate: 16, note: 'Auto-Gratuity' }
        ];
        const update = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: save.body.invoice_id, expected_version: await currentTableRevision(save.body.invoice_id),
            cart: updateCart,
            service_charge_snapshot: { id: snapshot.id, version: 2 },
            subtotal: 11, tax: 1.65, total: 12.65
        });
        expect(update.statusCode).toBe(200);
        expect(update.body.service_charge_snapshot).toMatchObject({ id: snapshot.id, percentage: 10, taxRate: 5, version: 3 });
        const [[fee]] = await pool.query("SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [save.body.invoice_id]);
        expect(fee.price_at_sale).toBe('1.000000');
        expect(fee.tax_rate).toBe('5.00');

        const stale = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: save.body.invoice_id, expected_version: await currentTableRevision(save.body.invoice_id),
            cart: updateCart,
            service_charge_snapshot: { id: snapshot.id, version: 2 },
            subtotal: 11, tax: 1.65, total: 12.65
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');

        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='service_charge_enabled'");
        const settle = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            edit_invoice_id: save.body.invoice_id,
            table_id: SEED.table.id,
            cart: updateCart,
            service_charge_snapshot: { id: snapshot.id, version: 3 },
            subtotal: 11, tax: 1.65, total: 12.65,
            payment_method: 'cash', amount_tendered: 20, change_due: 7.35
        });
        expect(settle.statusCode).toBe(200);
        const [[finalized]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(finalized.state).toBe('finalized');
    });

    it('supplies and binds the configured charge when a new table client omits it', async () => {
        await enableAutomaticTables('10', '5');
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            subtotal: 5,
            tax: 0.8,
            total: 5.8
        });

        expect(save.statusCode).toBe(200);
        expect(save.body.auto_service_charge_applied).toBe(true);
        expect(save.body.service_charge_snapshot).toMatchObject({ percentage: 10, taxRate: 5, version: 2 });
        const [[fee]] = await pool.query(
            "SELECT price_at_sale, tax_rate, sort_order FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [save.body.invoice_id]
        );
        expect(fee).toMatchObject({ price_at_sale: '0.500000', tax_rate: '5.00' });
        const [[last]] = await pool.query('SELECT MAX(sort_order) AS max_sort FROM order_items WHERE invoice_id=?', [save.body.invoice_id]);
        expect(fee.sort_order).toBe(last.max_sort);
    });

    it('keeps receipt-inclusive presentation out of table settlement accounting', async () => {
        await enableAutomaticTables('10', '16');
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
        await pool.query('UPDATE products SET price=1.50, tax_rate=16 WHERE id=?', [SEED.product1.id]);

        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{ id: SEED.product1.id, price: 1.5, qty: 1 }],
            subtotal: 1.5,
            tax: 0,
            total: 1.5
        });
        expect(save.statusCode).toBe(200);

        const loaded = await request(app).get(`/api/pos/table_order?order_id=${save.body.invoice_id}`)
            .set('Cookie', adminCookie);
        const loadedFee = loaded.body.cart.find(item => item.note === 'Auto-Gratuity');
        expect(loadedFee).toMatchObject({
            price: 0.15,
            tax_rate: 16,
            discountType: null,
            discountValue: 0
        });

        const settle = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            edit_invoice_id: save.body.invoice_id,
            table_id: SEED.table.id,
            cart: loaded.body.cart,
            service_charge_snapshot: loaded.body.service_charge_snapshot,
            subtotal: 1.65,
            tax: 0.26,
            total: 1.91,
            payment_method: 'cash',
            amount_tendered: 1.91,
            change_due: 0
        });

        expect(settle.statusCode).toBe(200);
        expect(settle.body).toMatchObject({ subtotal: 1.65, tax: 0.26, total: 1.91 });
    });

    it('freezes an exempt zero-rate service-charge category into the final order line', async () => {
        await enable('10', '0', 'Z');
        const created = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        expect(created.body.snapshot).toMatchObject({ taxRate: 0, taxCategory: 'Z' });
        const snapshot = created.body.snapshot;
        const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_Z', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 0, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: snapshot.id, version: snapshot.version },
            subtotal: 5.5, tax: 0.8, total: 6.3,
            payment_method: 'cash', amount_tendered: 10, change_due: 3.7
        });
        expect(res.statusCode).toBe(200);
        const [[fee]] = await pool.query(
            "SELECT jofotara_tax_category FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [res.body.invoice_id]
        );
        expect(fee.jofotara_tax_category).toBe('Z');
    });

    it('reprices a stale automatic charge when a reopened table adds an item', async () => {
        await enableAutomaticTables('8', '8');
        const created = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: SEED.product2.id, price: 2, qty: 1 }
            ],
            subtotal: 7,
            tax: 0.8,
            total: 7.8
        });
        expect(created.statusCode).toBe(200);

        const reopened = await request(app)
            .get(`/api/pos/table_order?order_id=${created.body.invoice_id}`)
            .set('Cookie', adminCookie);
        expect(reopened.statusCode).toBe(200);

        // The client adds an item but submits the previously rendered 0.56 fee.
        // This mirrors a save that beats Vue's deferred fee watcher.
        const staleCart = [
            ...reopened.body.cart,
            { id: SEED.product1.id, price: 5, qty: 1, tax_rate: 16 }
        ];
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: created.body.invoice_id, expected_version: await currentTableRevision(created.body.invoice_id),
            cart: staleCart,
            service_charge_snapshot: reopened.body.service_charge_snapshot,
            subtotal: 12.56,
            tax: 1.64,
            total: 14.2
        });

        expect(saved.statusCode).toBe(200);
        expect(saved.body.service_charge_snapshot).toMatchObject({ version: 3 });
        const [[order]] = await pool.query(
            'SELECT subtotal, tax, total FROM orders WHERE invoice_id=?',
            [created.body.invoice_id]
        );
        expect(order).toMatchObject({ subtotal: '12.96', tax: '1.68', total: '14.64' });
        const [[fee]] = await pool.query(
            "SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [created.body.invoice_id]
        );
        expect(fee).toMatchObject({ price_at_sale: '0.960000', tax_rate: '8.00' });
    });

    it('recalculates discounts, automatic charge, and mixed tax after a saved table gains an item', async () => {
        await enableAutomaticTables('8', '8');
        const created = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 2, discountType: 'percent', discountValue: 10 },
                { id: SEED.product2.id, price: 2, qty: 1, discountType: 'fixed', discountValue: 0.25 }
            ],
            order_discount_type: 'percent',
            order_discount_value: 10,
            subtotal: 11.61,
            tax: 1.36,
            total: 11.81
        });
        expect(created.statusCode).toBe(200);

        const reopened = await request(app)
            .get(`/api/pos/table_order?order_id=${created.body.invoice_id}`)
            .set('Cookie', adminCookie);
        expect(reopened.statusCode).toBe(200);

        // Deliberately retain the old 0.86 fee and totals. The table endpoint must
        // reprice the charge from the snapshot and recalculate the whole order.
        const saved = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: created.body.invoice_id, expected_version: await currentTableRevision(created.body.invoice_id),
            cart: [
                ...reopened.body.cart,
                { id: SEED.product1.id, price: 5, qty: 1, tax_rate: 16 }
            ],
            service_charge_snapshot: reopened.body.service_charge_snapshot,
            order_discount_type: 'percent',
            order_discount_value: 10,
            subtotal: 11.61,
            tax: 1.36,
            total: 11.81
        });

        expect(saved.statusCode).toBe(200);
        const [[order]] = await pool.query(
            'SELECT subtotal, tax, total, discount_type, discount_value FROM orders WHERE invoice_id=?',
            [created.body.invoice_id]
        );
        expect(order).toMatchObject({
            subtotal: '17.01',
            tax: '2.11',
            total: '17.42',
            discount_type: 'percent',
            discount_value: '10.00'
        });
        const [[fee]] = await pool.query(
            "SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [created.body.invoice_id]
        );
        expect(fee).toMatchObject({ price_at_sale: '1.260000', tax_rate: '8.00' });
    });

    it('does not add the automatic charge to an existing open table that predates the setting', async () => {
        const original = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            subtotal: 5,
            tax: 0.8,
            total: 5.8
        });
        expect(original.statusCode).toBe(200);
        await enableAutomaticTables();

        const update = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: original.body.invoice_id, expected_version: await currentTableRevision(original.body.invoice_id),
            cart: [{ id: SEED.product1.id, price: 5, qty: 2 }],
            subtotal: 10,
            tax: 1.6,
            total: 11.6
        });

        expect(update.statusCode).toBe(200);
        expect(update.body.service_charge_snapshot).toBeNull();
        const [[fees]] = await pool.query(
            "SELECT COUNT(*) AS count FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [original.body.invoice_id]
        );
        expect(Number(fees.count)).toBe(0);
    });

    it('rejects waiter removal and lets an admin remove a bound automatic charge', async () => {
        await enableAutomaticTables();
        const created = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            subtotal: 5,
            tax: 0.8,
            total: 5.8
        });
        const snapshot = created.body.service_charge_snapshot;
        const removal = {
            table_id: SEED.table.id,
            current_order_id: created.body.invoice_id, expected_version: await currentTableRevision(created.body.invoice_id),
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            service_charge_snapshot: { id: snapshot.id, version: snapshot.version },
            auto_service_charge_removed: true,
            subtotal: 5,
            tax: 0.8,
            total: 5.8
        };

        const forbidden = await request(app).post('/api/pos/table_order').set('Cookie', waiterCookie).send(removal);
        expect(forbidden.statusCode).toBe(403);

        const removed = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send(removal);
        expect(removed.statusCode).toBe(200);
        expect(removed.body.service_charge_snapshot).toBeNull();
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [created.body.invoice_id]);
        expect(order.service_charge_snapshot_id).toBeNull();
        const [[state]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(state.state).toBe('abandoned');
        const [[refundCount]] = await pool.query('SELECT COUNT(*) AS count FROM refunds WHERE invoice_id=?', [created.body.invoice_id]);
        const [[refundItemCount]] = await pool.query(
            'SELECT COUNT(*) AS count FROM refund_items ri JOIN refunds r ON r.id=ri.refund_id WHERE r.invoice_id=?',
            [created.body.invoice_id]
        );
        expect(Number(refundCount.count)).toBe(0);
        expect(Number(refundItemCount.count)).toBe(0);
    });

    it('rebinds a fresh charge snapshot after an admin removes an automatic table charge', async () => {
        await enableAutomaticTables('10', '5');
        const created = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            subtotal: 5,
            tax: 0.8,
            total: 5.8
        });
        expect(created.statusCode).toBe(200);

        const originalSnapshot = created.body.service_charge_snapshot;
        const removed = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: created.body.invoice_id, expected_version: await currentTableRevision(created.body.invoice_id),
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            service_charge_snapshot: { id: originalSnapshot.id, version: originalSnapshot.version },
            auto_service_charge_removed: true,
            subtotal: 5,
            tax: 0.8,
            total: 5.8
        });
        expect(removed.statusCode).toBe(200);
        expect(removed.body.service_charge_snapshot).toBeNull();

        const draft = (await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({})).body.snapshot;
        const readded = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            current_order_id: created.body.invoice_id, expected_version: await currentTableRevision(created.body.invoice_id),
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_READD', product_id: null, name: 'forged', price: 0.5, qty: 1, tax_rate: 99, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: draft.id, version: draft.version },
            subtotal: 5.5,
            tax: 0.83,
            total: 6.33
        });

        expect(readded.statusCode).toBe(200);
        expect(readded.body.service_charge_snapshot).toMatchObject({
            id: draft.id,
            percentage: 10,
            taxRate: 5,
            version: 2
        });
        const [[order]] = await pool.query(
            'SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?',
            [created.body.invoice_id]
        );
        expect(order.service_charge_snapshot_id).toBe(draft.id);
        const [[fee]] = await pool.query(
            "SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [created.body.invoice_id]
        );
        expect(fee).toMatchObject({ price_at_sale: '0.500000', tax_rate: '5.00' });
    });

    it('preserves and consumes a snapshot through hold, claim, and checkout', async () => {
        await enable('10', '5');
        const created = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        const snapshot = created.body.snapshot;
        const held = await request(app).post('/api/pos/held_orders').set('Cookie', adminCookie).send({
            reference_name: 'Snapshot hold',
            cart: { items: [
                { id: SEED.product1.id, price: 1, qty: 1 },
                { id: 'FEE_1', product_id: null, price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ] },
            subtotal: 1.5,
            service_charge_snapshot: { id: snapshot.id, version: 1 }
        });
        expect(held.statusCode).toBe(200);
        const [[heldRow]] = await pool.query('SELECT service_charge_snapshot_id, subtotal, cart_data FROM held_orders WHERE id=?', [held.body.id]);
        expect(heldRow.service_charge_snapshot_id).toBe(snapshot.id);
        expect(heldRow.subtotal).toBe('5.50');
        const claimed = await claimHeld(adminCookie, held.body.id);
        expect(claimed.response.statusCode).toBe(200);
        expect(claimed.order.service_charge_snapshot).toMatchObject({ id: snapshot.id, version: 2 });
        expect(claimed.claim.claimToken).toBeTruthy();

        await enable('20', '16');
        const cart = JSON.parse(claimed.order.cart_data).items;
        const paid = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart,
            held_order_context: {
                id: held.body.id,
                claim_token: claimed.claim.claimToken,
                expected_version: claimed.claim.version,
                operation_id: '11111111-1111-4111-8111-111111111111'
            },
            subtotal: 5.5, tax: 0.83, total: 6.33,
            payment_method: 'cash', amount_tendered: 10, change_due: 3.67
        });
        expect(paid.statusCode).toBe(200);
        const [[finalized]] = await pool.query('SELECT state, claim_token_hash FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(finalized).toMatchObject({ state: 'finalized', claim_token_hash: null });
    });

    // Regression (C1): a service charge added at the register AFTER a table was saved without one
    // must still settle. The order has no bound snapshot; checkout binds the submitted draft in
    // place, exactly like a direct register checkout. Before the fix this returned 400 and the
    // cashier could not charge the table.
    it('binds a fresh draft when a table is settled without an intervening save', async () => {
        await enable('10', '5');
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [{ id: SEED.product1.id, price: 5, qty: 1 }],
            subtotal: 5, tax: 0, total: 5
        });
        expect(save.statusCode).toBe(200);
        const [[boundBefore]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [save.body.invoice_id]);
        expect(boundBefore.service_charge_snapshot_id).toBeNull();

        const draft = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        const settle = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            edit_invoice_id: save.body.invoice_id,
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: 'junk name', price: 0.5, qty: 1, tax_rate: 99, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: draft.id, version: draft.version },
            subtotal: 5.5, tax: 0.83, total: 6.33,
            payment_method: 'cash', amount_tendered: 10, change_due: 3.67
        });
        expect(settle.statusCode).toBe(200);
        const [[state]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [draft.id]);
        expect(state).toMatchObject({ state: 'finalized', holder_id: String(settle.body.invoice_id) });
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [settle.body.invoice_id]);
        expect(order.service_charge_snapshot_id).toBe(draft.id);
        // Server stamps the canonical fee/tax over the forged submission (0.5 @ 10% of 5 = 0.5, tax 5).
        const [[fee]] = await pool.query("SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [settle.body.invoice_id]);
        expect(fee).toMatchObject({ price_at_sale: '0.500000', tax_rate: '5.00' });
    });

    // Regression (C3): a stale/consumed claim token presented on re-hold must return a recoverable
    // 409 with a public code, not a generic 500. Before the fix the bare Error became a 500.
    it('returns 409 with a public code when a re-hold presents a stale claim', async () => {
        await enable('10', '5');
        const draft = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        const held = await request(app).post('/api/pos/held_orders').set('Cookie', adminCookie).send({
            cart: { items: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ] },
            subtotal: 5.5,
            service_charge_snapshot: { id: draft.id, version: draft.version }
        });
        const claim = await claimHeld(adminCookie, held.body.id);
        expect(claim.response.statusCode).toBe(200);
        // Simulate the claim already being consumed elsewhere.
        await pool.query("UPDATE service_charge_snapshots SET state='finalized' WHERE id=?", [draft.id]);
        const rehold = await request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie', adminCookie).send({
            operation_id: '22222222-2222-4222-8222-222222222222',
            expected_version: claim.claim.version,
            claim_token: claim.claim.claimToken,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: draft.id }
        });
        expect(rehold.statusCode).toBe(409);
        expect(rehold.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
    });

    // Regression (C13): an orphaned claimed snapshot (crashed browser, never cleared) is reaped
    // by opportunistic cleanup after 7 days; live held/open/finalized rows are never touched.
    // Deliberate abandonment goes through the token-aware DELETE (separate test below).
    it('reaps week-old orphaned claimed snapshots on the next draft creation', async () => {
        await enable('10', '5');
        const orphan = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        await pool.query(
            "UPDATE service_charge_snapshots SET state='claimed', holder_type='claim', holder_id=?, updated_at=DATE_SUB(NOW(), INTERVAL 8 DAY) WHERE id=?",
            [String(SEED.adminUser.id), orphan.id]
        );
        const freshClaimed = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        await pool.query("UPDATE service_charge_snapshots SET state='claimed', holder_type='claim', holder_id=? WHERE id=?", [String(SEED.adminUser.id), freshClaimed.id]);
        // Trigger cleanupExpiredDrafts (runs before every draft insert).
        await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({});
        const [[gone]] = await pool.query('SELECT COUNT(*) c FROM service_charge_snapshots WHERE id=?', [orphan.id]);
        const [[kept]] = await pool.query('SELECT COUNT(*) c FROM service_charge_snapshots WHERE id=?', [freshClaimed.id]);
        expect(gone.c).toBe(0);
        expect(kept.c).toBe(1);
    });

    it('lets a cashier settle a fee already authorized on a claimed register hold', async () => {
        await enable('10', '5');
        const draftResponse = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        const draft = draftResponse.body.snapshot;
        const held = await request(app).post('/api/pos/held_orders').set('Cookie', adminCookie).send({
            reference_name: 'Authorized fee hold',
            cart: { items: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ] },
            subtotal: 5.5,
            service_charge_snapshot: { id: draft.id, version: draft.version }
        });
        expect(held.statusCode).toBe(200);

        const claim = await claimHeld(cashierCookie, held.body.id, 'c'.repeat(64));
        expect(claim.response.statusCode).toBe(200);
        const claimedItems = JSON.parse(claim.order.cart_data).items;

        const openShift = await request(app).post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
        expect(openShift.statusCode).toBe(200);
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);

        const checkout = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: claimedItems,
            held_order_context: {
                id: held.body.id,
                expected_version: claim.claim.version,
                claim_token: claim.claim.claimToken,
                operation_id: '33333333-3333-4333-8333-333333333333'
            },
            shift_id: shift.id,
            subtotal: 5.5,
            tax: 0.83,
            total: 6.33,
            payment_method: 'cash',
            amount_tendered: 10,
            change_due: 3.67,
            idempotency_key: 'claimed-service-charge-cashier'
        });

        expect(checkout.statusCode).toBe(200);
        const [[snapshot]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [draft.id]);
        expect(snapshot).toMatchObject({ state: 'finalized', holder_id: String(checkout.body.invoice_id) });
    });

    const holdAndClaim = async () => {
        await enable('10', '5');
        const draft = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        const held = await request(app).post('/api/pos/held_orders').set('Cookie', adminCookie).send({
            cart: { items: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ] },
            subtotal: 5.5,
            service_charge_snapshot: { id: draft.id, version: draft.version }
        });
        const claim = await claimHeld(adminCookie, held.body.id, 'd'.repeat(64));
        return { heldId: held.body.id, ...claim };
    };

    // Regression: clearing a restored order must consume its claim to 'abandoned' via the
    // token-aware DELETE — the deliberate path, so live claims never wait on the reaper.
    it('abandons a claimed snapshot through the token-aware DELETE', async () => {
        const claimed = await holdAndClaim();
        const res = await request(app).delete(`/api/pos/held_orders/${claimed.heldId}`)
            .set('Cookie', adminCookie)
            .send({
                expected_version: claimed.claim.version,
                claim_token: claimed.claim.claimToken,
                operation_id: '44444444-4444-4444-8444-444444444444',
                confirmed: true,
                reason_code: 'customer_changed_mind'
            });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query('SELECT state, holder_type, claim_token_hash FROM service_charge_snapshots WHERE id=?', [claimed.order.service_charge_snapshot.id]);
        expect(row).toMatchObject({ state: 'abandoned', holder_type: 'none', claim_token_hash: null });
    });

    it('rejects a token-aware DELETE with a wrong token and keeps the claim', async () => {
        const claimed = await holdAndClaim();
        const res = await request(app).delete(`/api/pos/held_orders/${claimed.heldId}`)
            .set('Cookie', adminCookie)
            .send({
                expected_version: claimed.claim.version,
                claim_token: 'a'.repeat(64),
                operation_id: '55555555-5555-4555-8555-555555555555',
                confirmed: true,
                reason_code: 'customer_changed_mind'
            });
        expect(res.statusCode).toBe(409);
        const [[row]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [claimed.order.service_charge_snapshot.id]);
        expect(row.state).toBe('held');
    });

    // A held checkout must fail closed if its bound snapshot is no longer in the held state,
    // while leaving the durable held row available for recovery.
    it('keeps the held order when its snapshot changes before checkout', async () => {
        const claimed = await holdAndClaim();
        await pool.query("UPDATE service_charge_snapshots SET state='finalized', holder_type='order', holder_id='external' WHERE id=?", [claimed.order.service_charge_snapshot.id]);
        const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: JSON.parse(claimed.order.cart_data).items,
            held_order_context: {
                id: claimed.heldId,
                expected_version: claimed.claim.version,
                claim_token: claimed.claim.claimToken,
                operation_id: '66666666-6666-4666-8666-666666666666'
            },
            service_charge_snapshot: {
                id: claimed.order.service_charge_snapshot.id,
                version: claimed.order.service_charge_snapshot.version
            },
            subtotal: 5.5, tax: 0.83, total: 6.33,
            payment_method: 'cash', amount_tendered: 10, change_due: 3.67
        });
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        const [[stillHeld]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [claimed.heldId]);
        expect(stillHeld).toBeTruthy();
    });

    // Regression (C5): a corrupted negative allocation must fail closed at split settle instead
    // of skipping both validation branches and accepting the fee line unvalidated.
    it('rejects a split settle whose persisted allocation is negative', async () => {
        await enable('10', '5');
        const draft = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: draft.id, version: draft.version },
            subtotal: 5.5, tax: 0.83, total: 6.33
        });
        expect(save.statusCode).toBe(200);
        const split = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
            tableId: SEED.table.id,
            currentOrderId: save.body.invoice_id,
            splits: [{
                referenceName: 'Seat 1', subtotal: 6.33,
                items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
            }]
        });
        expect(split.statusCode).toBe(200);
        const [[held]] = await pool.query('SELECT id, cart_data FROM held_orders ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(held.cart_data);
        expect(payload.service_charge_allocation_cents).toBe(50);
        payload.service_charge_allocation_cents = -5;
        await pool.query('UPDATE held_orders SET cart_data=? WHERE id=?', [JSON.stringify(payload), held.id]);

        const settle = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            split_check_id: held.id,
            table_id: SEED.table.id,
            cart: payload.items,
            subtotal: 5.5, tax: 0.83, total: 6.33,
            payment_method: 'cash', amount_tendered: 10, change_due: 3.67
        });
        expect(settle.statusCode).toBe(409);
        expect(settle.body.message).toMatch(/allocation/i);
    });

    it('abandons but retains the referenced snapshot when a legacy numbered table is voided', async () => {
        await enable('10', '5');
        const draft = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: draft.id, version: draft.version },
            subtotal: 5.5, tax: 0.83, total: 6.33
        });
        expect(save.statusCode).toBe(200);

        // Numbered legacy orders retain their row; future unissued cancellations
        // archive the items and delete the parent, so they no longer exercise this FK.
        await pool.query('UPDATE orders SET order_id=77 WHERE invoice_id=?', [save.body.invoice_id]);
        const voidRes = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: save.body.invoice_id,
            expected_version: await currentTableRevision(save.body.invoice_id), intent: 'void'
        });
        expect(voidRes.statusCode).toBe(200);

        const [[snap]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [draft.id]);
        expect(snap).toMatchObject({ state: 'abandoned', holder_type: 'none' });
        expect(snap.holder_id).toBeNull();
        const [[order]] = await pool.query('SELECT payment_method, service_charge_snapshot_id FROM orders WHERE invoice_id=?', [save.body.invoice_id]);
        expect(order).toMatchObject({
            payment_method: 'voided',
            service_charge_snapshot_id: draft.id
        });

        // Age the abandoned row, then trigger cleanup through normal draft creation.
        // The FK-bound audit snapshot must survive and cleanup must not make draft
        // creation fail with ER_ROW_IS_REFERENCED.
        await pool.query(
            "UPDATE service_charge_snapshots SET updated_at=DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE id=?",
            [draft.id]
        );
        const nextDraft = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        expect(nextDraft.statusCode).toBe(200);
        const [[retained]] = await pool.query(
            'SELECT COUNT(*) AS count FROM service_charge_snapshots WHERE id=?',
            [draft.id]
        );
        expect(Number(retained.count)).toBe(1);
    });

    it('rejects void when a bound snapshot is in an unexpected terminal state', async () => {
        await enable('10', '5');
        const draft = (await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({})).body.snapshot;
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: draft.id, version: draft.version },
            subtotal: 5.5, tax: 0.83, total: 6.33
        });
        expect(save.statusCode).toBe(200);
        await pool.query("UPDATE service_charge_snapshots SET state='finalized' WHERE id=?", [draft.id]);

        const voidRes = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie).send({
            invoice_id: save.body.invoice_id,
            expected_version: await currentTableRevision(save.body.invoice_id), intent: 'void'
        });

        expect(voidRes.statusCode).toBe(409);
        expect(voidRes.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        const [[order]] = await pool.query(
            'SELECT payment_method, subtotal, tax, total FROM orders WHERE invoice_id=?',
            [save.body.invoice_id]
        );
        expect(order.payment_method).toBe('unpaid_table');
        expect(Number(order.subtotal)).toBe(5.5);
        expect(Number(order.tax)).toBe(0.83);
        expect(Number(order.total)).toBe(6.33);
        const [[table]] = await pool.query(
            'SELECT current_order_id, status FROM restaurant_tables WHERE id=?',
            [SEED.table.id]
        );
        expect(table).toMatchObject({ current_order_id: save.body.invoice_id, status: 'occupied' });
    });

    // Merge matrix helper: saves a table order, optionally fee-bearing, returns { invoiceId, snapshot }.
    const saveTable = async (tableId, items, totals, withFee) => {
        let snapshot = null;
        const cart = [...items];
        if (withFee) {
            snapshot = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
            cart.push({ id: 'FEE_X', product_id: null, name: 'fee', price: withFee.price, qty: 1, tax_rate: withFee.tax, note: 'Auto-Gratuity' });
        }
        const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: tableId,
            cart,
            ...(snapshot ? { service_charge_snapshot: { id: snapshot.id, version: snapshot.version } } : {}),
            ...totals
        });
        expect(res.statusCode).toBe(200);
        return {
            invoiceId: res.body.invoice_id,
            snapshot,
            boundSnapshot: res.body.service_charge_snapshot || null
        };
    };

    const mergeTables = async (sourceTableId, targetTableId) =>
        request(app).post('/api/pos/tables/transfer').set('Cookie', adminCookie)
            .send(await tableActionIntent(pool, { sourceTableId, targetTableId, action: 'merge' }));

    it('merge source-only: re-homes the snapshot, keeps one recomputed fee, and settles', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2, tax: 0, total: 2 }, null);

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        // Snapshot re-homed: still open_order, holder is now the TARGET invoice, target FK set.
        const [[snap]] = await pool.query('SELECT state, holder_id, version FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(snap).toMatchObject({ state: 'open_order', holder_id: String(target.invoiceId) });
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [target.invoiceId]);
        expect(order.service_charge_snapshot_id).toBe(source.snapshot.id);

        // Exactly one fee row, recomputed over combined goods (5 + 2) at the frozen 10%.
        const [fees] = await pool.query("SELECT price_at_sale, tax_rate, quantity FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({ price_at_sale: '0.700000', tax_rate: '5.00', quantity: '1.000000' });

        // The old dead-end: settling the merged order must work.
        // goods tax: 5×16% = 0.80; fee tax: 0.70×5% = 0.035 → total tax 0.84 (rounded).
        const settle = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            edit_invoice_id: target.invoiceId,
            table_id: SEED.table2.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: SEED.product2.id, price: 2, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.7, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: source.snapshot.id, version: snap.version },
            subtotal: 7.7, tax: 0.84, total: 8.54,
            payment_method: 'cash', amount_tendered: 10, change_due: 1.46
        });
        expect(settle.statusCode).toBe(200);
        const [[finalized]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(finalized.state).toBe('finalized');
    });

    it('merge both-bound at differing rates: target rate wins, source abandoned, fee not doubled', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        await enable('12.5', '16');
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        const [[sourceSnap]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(sourceSnap.state).toBe('abandoned');
        const [[targetSnap]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [target.snapshot.id]);
        expect(targetSnap).toMatchObject({ state: 'open_order', holder_id: String(target.invoiceId) });

        // ONE fee row at the TARGET's frozen 12.5%/16 over combined goods 7.00 → 0.88.
        const [fees] = await pool.query("SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({ price_at_sale: '0.880000', tax_rate: '16.00' });
        const [[audit]] = await pool.query(
            "SELECT new_value FROM audit_events WHERE event_type='table_merge' AND entity_id=? ORDER BY id DESC LIMIT 1",
            [source.invoiceId]
        );
        expect(JSON.parse(audit.new_value).service_charge).toEqual({
            kept: target.snapshot.id,
            rehomed: null,
            abandoned: source.snapshot.id
        });
    });

    it('merge target-only: target snapshot survives and its fee recomputes over the combined base', async () => {
        await enable('12.5', '16');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        const [fees] = await pool.query("SELECT price_at_sale FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0].price_at_sale).toBe('0.880000');
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [target.invoiceId]);
        expect(order.service_charge_snapshot_id).toBe(target.snapshot.id);
        expect(source.snapshot).toBeNull();
    });

    it('merge both-bound but target fee removed: source fee copies and recomputes at target rate', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        await enable('12.5', '16');
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });
        // Remove the target's fee but keep its snapshot bound (fee-removed save).
        const noFee = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table2.id,
            current_order_id: target.invoiceId, expected_version: await currentTableRevision(target.invoiceId),
            cart: [{ id: SEED.product2.id, price: 2, qty: 1 }],
            service_charge_snapshot: { id: target.snapshot.id, version: 2 },
            subtotal: 2, tax: 0, total: 2
        });
        expect(noFee.statusCode).toBe(200);

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        // The fee survived (from the source) but at the target's surviving frozen rate.
        const [fees] = await pool.query("SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({ price_at_sale: '0.880000', tax_rate: '16.00' });
        const [[sourceSnap]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(sourceSnap.state).toBe('abandoned');
    });

    it('merge neither-bound keeps goods and creates no snapshot or fee', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2, tax: 0, total: 2 }, null);

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [[order]] = await pool.query(
            'SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?',
            [target.invoiceId]
        );
        expect(order.service_charge_snapshot_id).toBeNull();
        const [[counts]] = await pool.query(
            "SELECT COUNT(*) AS items, SUM(note='Auto-Gratuity') AS fees FROM order_items WHERE invoice_id=?",
            [target.invoiceId]
        );
        expect(Number(counts.items)).toBe(2);
        expect(Number(counts.fees || 0)).toBe(0);
        expect(source.snapshot).toBeNull();
    });

    it('rejects a same-table merge without changing the order or snapshot', async () => {
        await enable('10', '5');
        const saved = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });

        const beforeItems = await pool.query(
            'SELECT product_id, quantity, price_at_sale, note FROM order_items WHERE invoice_id=? ORDER BY id',
            [saved.invoiceId]
        );
        const response = await mergeTables(SEED.table.id, SEED.table.id);
        expect(response.statusCode).toBe(400);
        const [afterItems] = await pool.query(
            'SELECT product_id, quantity, price_at_sale, note FROM order_items WHERE invoice_id=? ORDER BY id',
            [saved.invoiceId]
        );
        expect(afterItems).toEqual(beforeItems[0]);
        const [[table]] = await pool.query('SELECT current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
        expect(table.current_order_id).toBe(saved.invoiceId);
        const [[snapshot]] = await pool.query('SELECT state, holder_id, version FROM service_charge_snapshots WHERE id=?', [saved.snapshot.id]);
        expect(snapshot).toMatchObject({ state: 'open_order', holder_id: String(saved.invoiceId) });
    });

    it('preserves different line discounts and charges the exact combined base', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1, discountType: 'fixed', discountValue: 1 }],
            { subtotal: 4.4, tax: 0.66, total: 5.06 }, { price: 0.4, tax: 5 });
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [goods] = await pool.query(
            "SELECT quantity, discount_type, discount_value FROM order_items WHERE invoice_id=? AND COALESCE(note,'')<>'Auto-Gratuity' ORDER BY id",
            [target.invoiceId]
        );
        expect(goods).toHaveLength(2);
        expect(goods.map(row => [row.quantity, row.discount_type, row.discount_value])).toEqual([
            ['1.000000', null, '0.00'],
            ['1.000000', 'fixed', '1.00']
        ]);
        const [[fee]] = await pool.query(
            "SELECT price_at_sale FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [target.invoiceId]
        );
        expect(fee.price_at_sale).toBe('0.900000');
        expect(source.snapshot.id).not.toBe(target.snapshot.id);
    });

    it('NULL-safe matches otherwise identical legacy discount rows', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        await pool.query(
            'UPDATE order_items SET discount_value=NULL WHERE invoice_id IN (?, ?)',
            [source.invoiceId, target.invoiceId]
        );

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [goods] = await pool.query(
            "SELECT quantity, discount_value FROM order_items WHERE invoice_id=? AND COALESCE(note,'')<>'Auto-Gratuity'",
            [target.invoiceId]
        );
        expect(goods).toHaveLength(1);
        expect(goods[0]).toMatchObject({ quantity: '2.000000', discount_value: null });
    });

    it('bumps the surviving target snapshot so a stale pre-merge save fails closed', async () => {
        await enable('12.5', '16');
        await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });
        const staleVersion = target.boundSnapshot.version;

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const staleSave = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table2.id,
            current_order_id: target.invoiceId, expected_version: await currentTableRevision(target.invoiceId),
            cart: [
                { id: SEED.product2.id, price: 2, qty: 1 },
                { id: 'FEE_X', product_id: null, price: 0.25, qty: 1, tax_rate: 16, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: target.snapshot.id, version: staleVersion },
            subtotal: 2.25, tax: 0.04, total: 2.29
        });
        expect(staleSave.statusCode).toBe(409);
        expect(staleSave.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        const [[sourceGoods]] = await pool.query(
            'SELECT COUNT(*) AS count FROM order_items WHERE invoice_id=? AND product_id=?',
            [target.invoiceId, SEED.product1.id]
        );
        expect(Number(sourceGoods.count)).toBe(1);
    });

    it('deduplicates and fully restamps a malformed surviving fee row', async () => {
        await enable('10', '5');
        await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.2, tax: 0.01, total: 2.21 }, { price: 0.2, tax: 5 });
        await pool.query(`
            UPDATE order_items
               SET product_id=?, item_name='forged', quantity=2,
                   discount_type='fixed', discount_value=1
             WHERE invoice_id=? AND note='Auto-Gratuity'
        `, [SEED.product2.id, target.invoiceId]);
        await pool.query(`
            INSERT INTO order_items
                (invoice_id, product_id, item_name, quantity, price_at_sale,
                 tax_rate, tax_amount, note, discount_type, discount_value)
            VALUES (?, NULL, 'duplicate', 1, 99, 99, 0,
                    'Auto-Gratuity', NULL, 0)
        `, [target.invoiceId]);

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [fees] = await pool.query(`
            SELECT product_id, item_name, quantity, price_at_sale, tax_rate,
                   note, discount_type, discount_value, parent_item_id
              FROM order_items
             WHERE invoice_id=? AND note='Auto-Gratuity'
        `, [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({
            product_id: null,
            item_name: '10% Service Charge',
            quantity: '1.000000',
            price_at_sale: '0.700000',
            tax_rate: '5.00',
            note: 'Auto-Gratuity',
            discount_type: null,
            discount_value: '0.00',
            parent_item_id: null
        });
    });

    it('rolls back copied items when source snapshot ownership conflicts', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2, tax: 0, total: 2 }, null);
        await pool.query(
            "UPDATE service_charge_snapshots SET holder_id='wrong-order' WHERE id=?",
            [source.snapshot.id]
        );

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(409);
        expect(merge.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        const [[sourceOrder]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE invoice_id=?', [source.invoiceId]);
        expect(Number(sourceOrder.count)).toBe(1);
        const [[targetGoods]] = await pool.query(
            "SELECT COUNT(*) AS count FROM order_items WHERE invoice_id=? AND COALESCE(note,'')<>'Auto-Gratuity'",
            [target.invoiceId]
        );
        expect(Number(targetGoods.count)).toBe(1);
        const [[snap]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(snap).toMatchObject({ state: 'open_order', holder_id: 'wrong-order' });
    });
});
