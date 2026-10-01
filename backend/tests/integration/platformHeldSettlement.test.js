const pool = require('../../config/db');
const request = require('supertest');
const { app } = require('../../../server');
const { executeCheckout } = require('../../modules/checkout/executeCheckout');
const { seedDatabase, SEED } = require('../fixtures/seed');

function ioStub() {
    return { to: () => ({ emit: () => {} }) };
}

async function seedPlatformHold({
    orderTypeId = 3,
    orderTypeName = 'Talabat',
    orderDiscount = { type: null, value: 0 },
    customerName = 'Platform Guest',
    customerPhone = '0790000000',
    customerAddress = 'Amman'
} = {}) {
    await pool.query(
        "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (?, ?, 1, 1) ON DUPLICATE KEY UPDATE name = VALUES(name), is_active = VALUES(is_active), is_deferred_settlement = VALUES(is_deferred_settlement)",
        [orderTypeId, orderTypeName]
    );
    const [shift] = await pool.query(
        "INSERT INTO shifts (user_id, status, starting_cash, opened_at) VALUES (?, 'open', 0, NOW())",
        [SEED.cashierUser.id]
    );
    const cart = {
        order_type_id: orderTypeId,
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_address: customerAddress,
        delivery_date: null,
        order_note: 'Platform reference',
        order_discount: orderDiscount,
        hash_number: null,
        tax_context_version: 1,
        tax_inclusive_at_hold: 0,
        tax_registration_type_at_hold: 'sales_tax',
        items: [{
            id: SEED.product1.id,
            product_id: SEED.product1.id,
            name: SEED.product1.name,
            item_name: SEED.product1.name,
            qty: 1,
            price: 5,
            tax_rate: 16,
            selectedModifiers: []
        }]
    };
    const [held] = await pool.query(
        'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, kitchen_fired) VALUES (?, ?, ?, 5, 1)',
        [SEED.adminUser.id, `${orderTypeName} #100`, JSON.stringify(cart)]
    );
    return { heldOrderId: held.insertId, shiftId: shift.insertId };
}

describe('platform held-order settlement', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('refuses to convert a source-marked phone hold into a platform settlement', async () => {
        const { heldOrderId, shiftId } = await seedPlatformHold();
        await pool.query("INSERT INTO users (id, user_number, name, role, is_active) VALUES (70, '9070', 'Phone Desk', 'call_center', 1)");
        await pool.query('UPDATE held_orders SET call_center_user_id=70 WHERE id=?', [heldOrderId]);

        await expect(executeCheckout({
            user: { ...SEED.cashierUser, permissions: ['pos.checkout', 'pos.hold_orders'] },
            input: { shift_id: shiftId },
            io: ioStub(),
            authorizeManagerOverride: async () => ({ allowed: false }),
            platformHeldOrderId: heldOrderId,
            expectedPlatformOrderTypeId: 3
        })).rejects.toMatchObject({ publicCode: 'CALL_CENTER_PLATFORM_SETTLEMENT_FORBIDDEN' });
        const [[row]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [heldOrderId]);
        expect(row.id).toBe(heldOrderId);
    });

    it('finalizes a kitchen-fired flagged held snapshot with frozen money and a zero tender', async () => {
        const { heldOrderId, shiftId } = await seedPlatformHold();
        const [[heldBeforeSettlement]] = await pool.query('SELECT created_at FROM held_orders WHERE id = ?', [heldOrderId]);
        await pool.query('UPDATE products SET price = 99, tax_rate = 0 WHERE id = ?', [SEED.product1.id]);

        const result = await executeCheckout({
            user: { ...SEED.cashierUser, permissions: ['pos.checkout', 'pos.hold_orders'] },
            input: { shift_id: shiftId },
            io: ioStub(),
            authorizeManagerOverride: async () => ({ allowed: false }),
            platformHeldOrderId: heldOrderId,
            expectedPlatformOrderTypeId: 3
        });

        expect(result).toMatchObject({
            payment_method: 'platform', subtotal: 5, tax: 0.8, total: 5.8,
            amount_tendered: 0, cash_amount: 0, card_amount: 0, change_due: 0, duplicate: false
        });
        const [[order]] = await pool.query('SELECT * FROM orders WHERE invoice_id = ?', [result.invoice_id]);
        expect(order).toMatchObject({
            payment_method: 'platform', customer_id: expect.any(Number),
            buyer_name_at_sale: 'Platform Guest', buyer_phone_at_sale: '0790000000', buyer_address_at_sale: 'Amman'
        });
        await pool.query('UPDATE customers SET name=?, phone=?, address=? WHERE id=?', ['Changed Platform Guest', '0790000999', 'Changed address', order.customer_id]);
        const [[snapshotAfterCustomerUpdate]] = await pool.query(
            'SELECT buyer_name_at_sale, buyer_phone_at_sale, buyer_address_at_sale FROM orders WHERE invoice_id=?',
            [result.invoice_id]
        );
        expect(snapshotAfterCustomerUpdate).toEqual({
            buyer_name_at_sale: 'Platform Guest', buyer_phone_at_sale: '0790000000', buyer_address_at_sale: 'Amman'
        });
        expect(Number(order.amount_tendered)).toBe(0);
        const [items] = await pool.query('SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id = ?', [result.invoice_id]);
        expect(Number(items[0].price_at_sale)).toBe(5);
        expect(Number(items[0].tax_rate)).toBe(16);
        const [heldRows] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [heldOrderId]);
        expect(heldRows).toHaveLength(0);
        const [[audit]] = await pool.query(
            "SELECT user_id, new_value FROM audit_events WHERE event_type = 'platform_held_order_settled' AND entity_id = ?",
            [result.invoice_id]
        );
        expect(audit.user_id).toBe(SEED.cashierUser.id);
        expect(JSON.parse(audit.new_value)).toMatchObject({
            held_order_id: heldOrderId,
            held_by_user_id: SEED.adminUser.id,
            settled_by_user_id: SEED.cashierUser.id,
            held_created_at: heldBeforeSettlement.created_at.toISOString(),
            shift_id: shiftId,
            order_type_id: 3,
            invoice_id: result.invoice_id
        });
        const [[documents]] = await pool.query('SELECT COUNT(*) AS count FROM jofotara_documents WHERE order_invoice_id = ?', [result.invoice_id]);
        expect(Number(documents.count)).toBe(0);

        const duplicate = await executeCheckout({
            user: { ...SEED.cashierUser, permissions: ['pos.checkout', 'pos.hold_orders'] },
            input: { shift_id: shiftId },
            io: ioStub(),
            authorizeManagerOverride: async () => ({ allowed: false }),
            platformHeldOrderId: heldOrderId,
            expectedPlatformOrderTypeId: 3
        });
        expect(duplicate).toMatchObject({ invoice_id: result.invoice_id, duplicate: true, payment_method: 'platform' });
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE idempotency_key = ?', [`platform-held:${heldOrderId}`]);
        expect(Number(count.count)).toBe(1);
    });

    it('freezes a name-only platform buyer without creating a customer row', async () => {
        const { heldOrderId, shiftId } = await seedPlatformHold({
            customerName: 'Name Only Guest',
            customerPhone: '',
            customerAddress: ''
        });

        const result = await executeCheckout({
            user: { ...SEED.cashierUser, permissions: ['pos.checkout', 'pos.hold_orders'] },
            input: { shift_id: shiftId },
            io: ioStub(),
            authorizeManagerOverride: async () => ({ allowed: false }),
            platformHeldOrderId: heldOrderId,
            expectedPlatformOrderTypeId: 3
        });
        const [[order]] = await pool.query(
            'SELECT customer_id, buyer_name_at_sale, buyer_phone_at_sale, buyer_address_at_sale FROM orders WHERE invoice_id=?',
            [result.invoice_id]
        );
        expect(order).toEqual({
            customer_id: null,
            buyer_name_at_sale: 'Name Only Guest',
            buyer_phone_at_sale: null,
            buyer_address_at_sale: null
        });
    });

    it('settles bundle children from the server-held snapshot after the live bundle changes', async () => {
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1) ON DUPLICATE KEY UPDATE is_active=1, is_deferred_settlement=1"
        );
        await pool.query(
            "INSERT INTO shifts (user_id, status, starting_cash, opened_at) VALUES (?, 'open', 0, NOW())",
            [SEED.cashierUser.id]
        );
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const cashierCookie = login.headers['set-cookie'][0];
        const bundleItems = [
            { product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, removed: false },
            { product_id: SEED.product2.id, name: SEED.product2.name, qty: 1, removed: false }
        ];
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', cashierCookie)
            .send({
                reference_name: 'Talabat bundle',
                subtotal: 10,
                cart: {
                    order_type_id: 3,
                    order_discount: { type: null, value: 0 },
                    items: [{
                        id: SEED.bundleProduct.id,
                        product_id: SEED.bundleProduct.id,
                        name: SEED.bundleProduct.name,
                        qty: 1,
                        price: SEED.bundleProduct.price,
                        tax_rate: SEED.bundleProduct.tax_rate,
                        is_bundle: true,
                        bundleItems
                    }]
                }
            });
        expect(hold.statusCode).toBe(200);
        const [[held]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [hold.body.id]);
        const frozenBundle = JSON.parse(held.cart_data).items[0];
        expect(frozenBundle.bundle_snapshot_version).toBe(1);

        await pool.query('DELETE FROM product_bundle_items WHERE bundle_id = ? AND product_id = ?', [SEED.bundleProduct.id, SEED.product1.id]);
        await pool.query('UPDATE product_bundle_items SET qty = 9 WHERE bundle_id = ? AND product_id = ?', [SEED.bundleProduct.id, SEED.product2.id]);
        await pool.query("UPDATE products SET name = 'Changed live name' WHERE id = ?", [SEED.product2.id]);
        await pool.query('UPDATE held_orders SET kitchen_fired = 1 WHERE id = ?', [hold.body.id]);

        const settled = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', cashierCookie)
            .send({ order_type_id: 3, held_order_ids: [hold.body.id] });

        expect(settled.statusCode).toBe(200);
        expect(settled.body.failures).toEqual([]);
        const invoiceId = settled.body.successes[0].invoice_id;
        const [children] = await pool.query(
            'SELECT product_id, item_name, quantity FROM order_items WHERE invoice_id = ? AND parent_item_id IS NOT NULL ORDER BY sort_order',
            [invoiceId]
        );
        expect(children.map(child => ({
            product_id: Number(child.product_id),
            item_name: child.item_name,
            quantity: Number(child.quantity)
        }))).toEqual([
            { product_id: SEED.product1.id, item_name: SEED.product1.name, quantity: 1 },
            { product_id: SEED.product2.id, item_name: SEED.product2.name, quantity: 1 }
        ]);
    });

    it('makes concurrent settlement attempts converge on one invoice', async () => {
        const { heldOrderId, shiftId } = await seedPlatformHold();
        const settle = () => executeCheckout({
            user: { ...SEED.cashierUser, permissions: ['pos.checkout', 'pos.hold_orders'] },
            input: { shift_id: shiftId },
            io: ioStub(),
            authorizeManagerOverride: async () => ({ allowed: false }),
            platformHeldOrderId: heldOrderId,
            expectedPlatformOrderTypeId: 3
        });

        const results = await Promise.all([settle(), settle()]);
        expect(results.map(result => result.invoice_id)).toEqual([results[0].invoice_id, results[0].invoice_id]);
        expect(results.map(result => result.duplicate).sort()).toEqual([false, true]);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE idempotency_key = ?', [`platform-held:${heldOrderId}`]);
        expect(Number(count.count)).toBe(1);
    });

    it('requires discount authorization before a discounted platform hold becomes a sale', async () => {
        const { heldOrderId, shiftId } = await seedPlatformHold({
            orderDiscount: { type: 'percent', value: 100 }
        });

        await expect(executeCheckout({
            user: { ...SEED.cashierUser, permissions: ['pos.checkout', 'pos.hold_orders'] },
            input: { shift_id: shiftId },
            io: ioStub(),
            authorizeManagerOverride: async () => ({ allowed: false }),
            platformHeldOrderId: heldOrderId,
            expectedPlatformOrderTypeId: 3
        })).rejects.toMatchObject({ statusCode: 403 });

        const [[held]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [heldOrderId]);
        expect(held).toBeDefined();
    });

    it('does not settle a held order belonging to another platform provider', async () => {
        const talabat = await seedPlatformHold();
        const careem = await seedPlatformHold({ orderTypeId: 4, orderTypeName: 'Careem' });
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const cashierCookie = login.headers['set-cookie'][0];

        const response = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', cashierCookie)
            .send({ order_type_id: 3, held_order_ids: [talabat.heldOrderId, careem.heldOrderId] });

        expect(response.statusCode).toBe(200);
        expect(response.body.successes).toEqual([
            expect.objectContaining({ held_order_id: talabat.heldOrderId })
        ]);
        expect(response.body.failures).toEqual([
            expect.objectContaining({
                held_order_id: careem.heldOrderId,
                publicCode: 'PLATFORM_ORDER_TYPE_MISMATCH'
            })
        ]);
        const [[careemHeld]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [careem.heldOrderId]);
        expect(careemHeld).toBeDefined();
    });

    it('requires both hold and checkout permissions', async () => {
        const { heldOrderId } = await seedPlatformHold();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        const response = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', login.headers['set-cookie'][0])
            .send({ order_type_id: 3, held_order_ids: [heldOrderId] });

        expect(response.statusCode).toBe(403);
        const [[held]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [heldOrderId]);
        expect(held).toBeDefined();
    });

    it('requires the settling user to have their own open shift', async () => {
        const { heldOrderId } = await seedPlatformHold();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const response = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', login.headers['set-cookie'][0])
            .send({ order_type_id: 3, held_order_ids: [heldOrderId] });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('PLATFORM_SHIFT_REQUIRED');
        const [[held]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [heldOrderId]);
        expect(held).toBeDefined();
    });

    it('leaves holds untouched when the provider is no longer configured for deferred settlement', async () => {
        const { heldOrderId } = await seedPlatformHold();
        await pool.query('UPDATE order_types SET is_deferred_settlement = 0 WHERE id = 3');
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const response = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', login.headers['set-cookie'][0])
            .send({ order_type_id: 3, held_order_ids: [heldOrderId] });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('PLATFORM_ORDER_TYPE_INVALID');
        const [[held]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [heldOrderId]);
        expect(held).toBeDefined();
    });

    it('rolls back the sale and preserves the hold when stock deduction fails', async () => {
        const { heldOrderId, shiftId } = await seedPlatformHold();
        await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'stock_enabled'");
        await pool.query('UPDATE products SET stock = 0 WHERE id = ?', [SEED.product1.id]);

        await expect(executeCheckout({
            user: { ...SEED.cashierUser, permissions: ['pos.checkout', 'pos.hold_orders'] },
            input: { shift_id: shiftId },
            io: ioStub(),
            authorizeManagerOverride: async () => ({ allowed: false }),
            platformHeldOrderId: heldOrderId,
            expectedPlatformOrderTypeId: 3
        })).rejects.toThrow(/Insufficient stock/);

        const [[held]] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [heldOrderId]);
        const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE idempotency_key = ?', [`platform-held:${heldOrderId}`]);
        expect(held).toBeDefined();
        expect(Number(orders.count)).toBe(0);
    });

    it('settles the frozen held service charge after live settings change', async () => {
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1) ON DUPLICATE KEY UPDATE is_active=1, is_deferred_settlement=1"
        );
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='service_charge_enabled'");
        await pool.query("UPDATE settings SET setting_value='10' WHERE setting_key='service_charge_percentage'");
        await pool.query("UPDATE settings SET setting_value='5' WHERE setting_key='service_charge_tax_rate'");
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const adminCookie = login.headers['set-cookie'][0];
        await pool.query(
            "INSERT INTO shifts (user_id, status, starting_cash, opened_at) VALUES (?, 'open', 0, NOW())",
            [SEED.adminUser.id]
        );
        const snapshotResponse = await request(app)
            .post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie)
            .send({});
        const snapshot = snapshotResponse.body.snapshot;
        const hold = await request(app)
            .post('/api/pos/held_orders')
            .set('Cookie', adminCookie)
            .send({
                reference_name: 'Talabat service charge',
                subtotal: 5.5,
                cart: {
                    order_type_id: 3,
                    order_discount: { type: null, value: 0 },
                    items: [
                        { id: SEED.product1.id, product_id: SEED.product1.id, price: 5, qty: 1, tax_rate: 16 },
                        { id: 'FEE_PLATFORM', product_id: null, price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
                    ]
                },
                service_charge_snapshot: { id: snapshot.id, version: snapshot.version }
            });
        expect(hold.statusCode).toBe(200);
        await pool.query("UPDATE settings SET setting_value='20' WHERE setting_key='service_charge_percentage'");
        await pool.query("UPDATE settings SET setting_value='16' WHERE setting_key='service_charge_tax_rate'");
        await pool.query('UPDATE held_orders SET kitchen_fired=1 WHERE id=?', [hold.body.id]);

        const settled = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', adminCookie)
            .send({ order_type_id: 3, held_order_ids: [hold.body.id] });

        expect(settled.statusCode).toBe(200);
        expect(settled.body.failures).toEqual([]);
        expect(settled.body.successes[0].total).toBe(6.33);
        const [[fee]] = await pool.query(
            "SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [settled.body.successes[0].invoice_id]
        );
        expect(Number(fee.price_at_sale)).toBe(0.5);
        expect(Number(fee.tax_rate)).toBe(5);
        const [[finalSnapshot]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [snapshot.id]);
        expect(finalSnapshot).toMatchObject({
            state: 'finalized',
            holder_type: 'order',
            holder_id: String(settled.body.successes[0].invoice_id)
        });
    });

    it('settles selected platform holds even when no kitchen ticket was fired', async () => {
        const first = await seedPlatformHold();
        const second = await seedPlatformHold();
        await pool.query('UPDATE held_orders SET kitchen_fired = 0 WHERE id = ?', [second.heldOrderId]);
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const cashierCookie = login.headers['set-cookie'][0];

        const response = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', cashierCookie)
            .send({ order_type_id: 3, held_order_ids: [first.heldOrderId, second.heldOrderId] });

        expect(response.statusCode).toBe(200);
        expect(response.body.successes).toHaveLength(2);
        expect(response.body.successes).toEqual(expect.arrayContaining([
            expect.objectContaining({ held_order_id: first.heldOrderId, duplicate: false }),
            expect.objectContaining({ held_order_id: second.heldOrderId, duplicate: false })
        ]));
        expect(response.body.failures).toEqual([]);
        const [remaining] = await pool.query('SELECT id FROM held_orders WHERE id = ?', [second.heldOrderId]);
        expect(remaining).toHaveLength(0);
    });

    it('rejects an invalid platform batch before it starts', async () => {
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const cashierCookie = login.headers['set-cookie'][0];
        const response = await request(app)
            .post('/api/pos/held_orders/settle-platform')
            .set('Cookie', cashierCookie)
            .send({ order_type_id: 3, held_order_ids: [1, 1] });

        expect(response.statusCode).toBe(400);
        expect(response.body.message).toMatch(/unique/i);
    });
});
