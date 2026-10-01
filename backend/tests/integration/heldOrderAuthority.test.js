const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('held-order continuation authority', () => {
    let cookie;

    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Test Platform', 1, 1)");
        const [printer] = await pool.query("INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Held Authority Kitchen', 'kitchen', 'windows', 'Held Authority Kitchen', 'held-authority-test')");
        await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [printer.insertId, SEED.category.id]);
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cookie = login.headers['set-cookie'][0];
        const shift = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
        expect(shift.statusCode).toBe(200);
    });

    afterAll(async () => { await pool.end(); });

    async function createAndClaim({ taxProfile = 'sales_tax', taxExempt = false, quantity = 1, serviceCharge = false, phoneOrder = false } = {}) {
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='tax_registration_type'", [taxProfile]);
        let creatorCookie = cookie;
        if (taxExempt || serviceCharge) {
            const admin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
            creatorCookie = admin.headers['set-cookie'][0];
        }
        let actorCookie = cookie;
        if (phoneOrder) {
            await pool.query("INSERT INTO users (id, user_number, name, role, is_active) VALUES (70, '9070', 'Fixture Phone Worker', 'call_center', 1)");
            const phoneLogin = await request(app).post('/api/auth/login').send({ user_number: '9070' });
            actorCookie = phoneLogin.headers['set-cookie'][0];
        }
        let snapshot;
        if (serviceCharge) {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='service_charge_enabled'");
            await pool.query("UPDATE settings SET setting_value='10' WHERE setting_key='service_charge_percentage'");
            await pool.query("UPDATE settings SET setting_value='5' WHERE setting_key='service_charge_tax_rate'");
            const createdSnapshot = await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', creatorCookie).send({});
            expect(createdSnapshot.statusCode, JSON.stringify(createdSnapshot.body)).toBe(200);
            snapshot = createdSnapshot.body.snapshot;
        }
        const createPayload = {
            hold_request_id: `held-authority-${crypto.randomUUID()}`,
            reference_name: 'Tax context hold',
            subtotal: (serviceCharge ? 5.5 : 5) * quantity,
            tax_exempt: taxExempt,
            cart: {
                order_type_id: phoneOrder ? 1 : 3,
                ...(phoneOrder ? { customer_name: 'Fixture Customer', customer_phone: '0791234567', customer_address: 'Fixture Address' } : {}),
                items: [
                    { id: SEED.product1.id, qty: quantity, price: 5, tax_rate: 16 },
                    ...(serviceCharge ? [{ id: 'FEE_HELD', product_id: null, qty: 1, price: 0.5 * quantity, tax_rate: 5, note: 'Auto-Gratuity' }] : [])
                ]
            },
            ...(snapshot ? { service_charge_snapshot: { id: snapshot.id, version: snapshot.version } } : {})
        };
        const created = await request(app).post('/api/pos/held_orders').set('Cookie', creatorCookie).send(createPayload);
        expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
        expect(created.body.kitchen_fired).toBe(true);
        if (phoneOrder) {
            // Represent an existing phone-source hold carrying a cashier-authorized
            // fee; phone workers cannot grant fee authority when creating a hold.
            await pool.query('UPDATE held_orders SET call_center_user_id=70 WHERE id=?', [created.body.id]);
        }
        const token = 'a'.repeat(64);
        const claimed = await request(app).post(`/api/pos/held_orders/${created.body.id}/claim`).set('Cookie', actorCookie)
            .send({ expected_version: created.body.version, claim_token: token, ...(phoneOrder ? { phone: '0791234567' } : {}) });
        expect(claimed.statusCode, JSON.stringify(claimed.body)).toBe(200);
        return {
            id: created.body.id, token, version: claimed.body.claim.version,
            cart: JSON.parse(claimed.body.order.cart_data), createPayload,
            snapshot: claimed.body.order.service_charge_snapshot,
            actorCookie, creatorCookie
        };
    }

    async function continueHold(kind, held, overrides = {}, expectedStatus = 200) {
        const cart = { ...held.cart, ...overrides, items: overrides.items || held.cart.items.map(item => ({ ...item, qty: kind === 'follow-up' ? 2 : 1 })) };
        const payload = { claim_token: held.token, expected_version: held.version, operation_id: `authority-${crypto.randomUUID()}`, cart };
        const operation = kind === 'save'
            ? request(app).patch(`/api/pos/held_orders/${held.id}`)
            : request(app).post(`/api/pos/held_orders/${held.id}/follow-up`);
        const response = await operation.set('Cookie', cookie).send(payload);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(expectedStatus);
        return response;
    }

    async function changeKitchenRouting(change) {
        if (change === 'disabled') await pool.query("UPDATE printers SET is_active=0 WHERE spooler_id='held-authority-test'");
        else await pool.query('DELETE FROM printer_categories WHERE category_id=?', [SEED.category.id]);
        await pool.query("INSERT INTO categories (id, name, is_active) VALUES (2, 'New Preparation Station', 1)");
        await pool.query('UPDATE products SET category_id=2 WHERE id=?', [SEED.product2.id]);
        const [printer] = await pool.query("INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('New Kitchen', 'kitchen', 'windows', 'New Kitchen', 'held-authority-new')");
        await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, 2)', [printer.insertId]);
    }

    it.each(['save', 'follow-up'])('%s reuses its locked held row for claim validation', async kind => {
        const held = await createAndClaim();
        const acquire = pool.getConnection.bind(pool);
        let heldLockReads = 0;
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await acquire();
            const query = conn.query.bind(conn);
            conn.query = (sql, params) => {
                if (/SELECT \* FROM held_orders WHERE id\s*=\s*\? FOR UPDATE/i.test(String(sql))) heldLockReads++;
                return query(sql, params);
            };
            return conn;
        });
        try {
            await continueHold(kind, held);
            expect(heldLockReads).toBe(1);
        } finally { spy.mockRestore(); }
    });

    async function settle(heldId) {
        const response = await request(app).post('/api/pos/held_orders/settle-platform').set('Cookie', cookie)
            .send({ order_type_id: 3, held_order_ids: [heldId] });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.failures).toEqual([]);
        expect(response.body.successes).toHaveLength(1);
        const [[order]] = await pool.query('SELECT total, tax, tax_exempt_at_sale, tax_registration_type_at_sale, tax_inclusive_at_sale FROM orders ORDER BY invoice_id DESC LIMIT 1');
        return order;
    }

    it.each([false, true])('saves only the held service-charge UUID (replaced: %s)', async replaced => {
        const held = await createAndClaim({ serviceCharge: true });
        const response = await request(app).patch(`/api/pos/held_orders/${held.id}`).set('Cookie', cookie).send({
            claim_token: held.token,
            expected_version: held.version,
            operation_id: `service-charge-${crypto.randomUUID()}`,
            cart: held.cart,
            service_charge_snapshot: { ...held.snapshot, id: replaced ? crypto.randomUUID() : held.snapshot.id }
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(replaced ? 409 : 200);
        const [[row]] = await pool.query('SELECT service_charge_snapshot_id, version, claimed_by_user_id FROM held_orders WHERE id=?', [held.id]);
        expect(row.service_charge_snapshot_id).toBe(held.snapshot.id);
        expect(Number(row.version)).toBe(held.version + (replaced ? 0 : 1));
        expect(row.claimed_by_user_id).toBe(replaced ? SEED.cashierUser.id : null);
        if (replaced) {
            expect(response.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        } else {
            const order = await settle(held.id);
            expect(Number(order.total)).toBe(6.33);
            const [[snapshot]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [held.snapshot.id]);
            expect(snapshot.state).toBe('finalized');
        }
    });

    it.each([false, true])('lets a phone worker edit customer details only with the existing fee UUID (replaced: %s)', async replaced => {
        const held = await createAndClaim({ serviceCharge: true, phoneOrder: true });
        const response = await request(app).patch(`/api/pos/held_orders/${held.id}`).set('Cookie', held.actorCookie).send({
            claim_token: held.token,
            expected_version: held.version,
            operation_id: `phone-fee-${crypto.randomUUID()}`,
            cart: { ...held.cart, customer_address: 'Updated Fixture Address' },
            service_charge_snapshot: { ...held.snapshot, id: replaced ? crypto.randomUUID() : held.snapshot.id }
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(replaced ? 409 : 200);
        const [[row]] = await pool.query('SELECT cart_data, service_charge_snapshot_id, version FROM held_orders WHERE id=?', [held.id]);
        expect(row.service_charge_snapshot_id).toBe(held.snapshot.id);
        expect(Number(row.version)).toBe(held.version + (replaced ? 0 : 1));
        expect(JSON.parse(row.cart_data).customer_address).toBe(replaced ? 'Fixture Address' : 'Updated Fixture Address');
        if (replaced) expect(response.body.code).toBe('CALL_CENTER_FINANCIAL_CONTEXT_CHANGED');
    });

    it('lets a phone worker keep an absent service-charge snapshot absent', async () => {
        const held = await createAndClaim({ phoneOrder: true });
        const response = await request(app).patch(`/api/pos/held_orders/${held.id}`).set('Cookie', held.actorCookie).send({
            claim_token: held.token,
            expected_version: held.version,
            operation_id: `phone-no-fee-${crypto.randomUUID()}`,
            cart: { ...held.cart, customer_address: 'Updated Fixture Address' },
            service_charge_snapshot: null
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const [[row]] = await pool.query('SELECT service_charge_snapshot_id FROM held_orders WHERE id=?', [held.id]);
        expect(row.service_charge_snapshot_id).toBeNull();
    });

    it('rejects reusing a hold request with a different service-charge UUID at the same version', async () => {
        const held = await createAndClaim({ serviceCharge: true });
        const replacement = await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', held.creatorCookie).send({});
        expect(replacement.statusCode, JSON.stringify(replacement.body)).toBe(200);
        expect(replacement.body.snapshot.version).toBe(held.createPayload.service_charge_snapshot.version);
        const replay = await request(app).post('/api/pos/held_orders').set('Cookie', held.creatorCookie).send({
            ...held.createPayload,
            service_charge_snapshot: { id: replacement.body.snapshot.id, version: replacement.body.snapshot.version }
        });
        expect(replay.statusCode, JSON.stringify(replay.body)).toBe(409);
        expect(replay.body.code).toBe('HELD_OPERATION_CONFLICT');
        const [[rows]] = await pool.query('SELECT COUNT(*) count FROM held_orders');
        expect(Number(rows.count)).toBe(1);
        const [[unused]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [replacement.body.snapshot.id]);
        expect(unused.state).toBe('draft');
    });

    it.each([false, true])('replays a legacy fee fingerprint only for its bound UUID (replaced: %s)', async replaced => {
        const held = await createAndClaim({ serviceCharge: true });
        // Historical fingerprint of createAndClaim's default fee request, whose
        // UUID was incorrectly normalized to null by the previous writer.
        held.cart._hold_request_fingerprint = '792b242815682781f2f01c20c3c89eaa8e8d85deee467c761bef5b5498294b67';
        await pool.query('UPDATE held_orders SET cart_data=? WHERE id=?', [JSON.stringify(held.cart), held.id]);
        const response = await request(app).post('/api/pos/held_orders').set('Cookie', held.creatorCookie).send({
            ...held.createPayload,
            service_charge_snapshot: {
                ...held.createPayload.service_charge_snapshot,
                id: replaced ? crypto.randomUUID() : held.snapshot.id
            }
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(replaced ? 409 : 200);
        if (replaced) expect(response.body.code).toBe('HELD_OPERATION_CONFLICT');
        else expect(response.body).toMatchObject({ id: held.id, replay: true });
        const [[rows]] = await pool.query('SELECT COUNT(*) count FROM held_orders');
        expect(Number(rows.count)).toBe(1);
    });

    for (const kind of ['save', 'follow-up']) {
        const quantity = kind === 'follow-up' ? 2 : 1;

        it(`${kind} cannot turn a taxable platform hold into an exempt sale`, async () => {
            const held = await createAndClaim();
            await continueHold(kind, held, { tax_exempt_at_hold: true });
            const order = await settle(held.id);
            expect(Number(order.tax_exempt_at_sale)).toBe(0);
            expect(Number(order.tax)).toBeCloseTo(0.8 * quantity, 2);
            expect(Number(order.total)).toBeCloseTo(5.8 * quantity, 2);
        });

        it(`${kind} cannot replace the held accounting profile or tax-inclusive mode`, async () => {
            const held = await createAndClaim();
            await continueHold(kind, held, { tax_registration_type_at_hold: 'income_tax', tax_inclusive_at_hold: 1 });
            const order = await settle(held.id);
            expect(order.tax_registration_type_at_sale).toBe('sales_tax');
            expect(Number(order.tax_inclusive_at_sale)).toBe(0);
            expect(Number(order.total)).toBeCloseTo(5.8 * quantity, 2);
        });

        it(`${kind} preserves the original creation replay after untrusted metadata changes`, async () => {
            const held = await createAndClaim();
            await continueHold(kind, held, {
                _hold_request_fingerprint: 'replacement',
                tax_context_version: 0,
                receipt_tax_inclusive_at_hold: 1,
                customer_name: 'Updated customer'
            });
            const replay = await request(app).post('/api/pos/held_orders').set('Cookie', cookie).send(held.createPayload);
            expect(replay.statusCode, JSON.stringify(replay.body)).toBe(200);
            expect(replay.body).toMatchObject({ id: held.id, replay: true });
            const [[row]] = await pool.query('SELECT cart_data, claimed_by_user_id FROM held_orders WHERE id=?', [held.id]);
            const saved = JSON.parse(row.cart_data);
            expect(saved).toMatchObject({
                tax_context_version: 1,
                receipt_tax_inclusive_at_hold: 0,
                customer_name: 'Updated customer'
            });
            expect(row.claimed_by_user_id).toBeNull();
        });

        it(`${kind} keeps a previously authorized exemption while the editing cashier lacks its permission`, async () => {
            const held = await createAndClaim({ taxExempt: true });
            await continueHold(kind, held, { tax_exempt_at_hold: false });
            const order = await settle(held.id);
            expect(Number(order.tax_exempt_at_sale)).toBe(1);
            expect(Number(order.tax)).toBe(0);
        });

        it(`${kind} continues to price income-tax holds with their saved profile after settings change`, async () => {
            const held = await createAndClaim({ taxProfile: 'income_tax' });
            await pool.query("UPDATE settings SET setting_value='sales_tax' WHERE setting_key='tax_registration_type'");
            await continueHold(kind, held);
            const [[row]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=?', [held.id]);
            expect(JSON.parse(row.cart_data).items[0].tax_rate).toBe(0);
            const order = await settle(held.id);
            expect(order.tax_registration_type_at_sale).toBe('income_tax');
            expect(Number(order.tax)).toBe(0);
            expect(Number(order.total)).toBe(5 * quantity);
        });

        it.each([
            ['disabled', 'reduced'],
            ['removed', 'removed'],
        ])(`${kind} preserves original-station evidence when the route is %s and a line is %s`, async (routeChange, lineChange) => {
            const held = await createAndClaim({ quantity: 2 });
            await changeKitchenRouting(routeChange);
            const items = [
                ...(lineChange === 'reduced' ? [{ ...held.cart.items[0], qty: 1 }] : []),
                { id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }
            ];
            if (kind === 'save' && routeChange === 'removed') {
                await continueHold(kind, held, { items }, 200);
                const [jobs] = await pool.query('SELECT payload FROM print_queue ORDER BY id');
                expect(jobs).toHaveLength(3);
                const cancellation = JSON.parse(jobs[1].payload).data;
                expect(cancellation.void_ticket).toBe(true);
                expect(cancellation.items[0].qty).toBe(2);
                expect(cancellation.items[0].product_id).toBe(SEED.product1.id);
                return;
            }
            const result = await continueHold(kind, held, { items }, 409);
            expect(result.body.code).toBe(kind === 'save' ? 'HELD_KITCHEN_ROUTE_MISSING' : 'HELD_KITCHEN_SENT_LINE_CONFLICT');
            const [[row]] = await pool.query('SELECT cart_data, version, kitchen_dispatch_version FROM held_orders WHERE id=?', [held.id]);
            expect(JSON.parse(row.cart_data).items).toHaveLength(1);
            expect(JSON.parse(row.cart_data).items[0].qty).toBe(2);
            expect(Number(row.version)).toBe(held.version);
            expect(Number(row.kitchen_dispatch_version)).toBe(1);
            const [[jobs]] = await pool.query('SELECT COUNT(*) count FROM print_queue');
            expect(Number(jobs.count)).toBe(1);
        });

        it(`${kind} can add newly routed work while preserving sent lines whose route changed`, async () => {
            const held = await createAndClaim({ quantity: 2 });
            await changeKitchenRouting('removed');
            await continueHold(kind, held, { items: [
                ...held.cart.items,
                { id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }
            ] });
            const [[row]] = await pool.query('SELECT cart_data, kitchen_dispatch_version FROM held_orders WHERE id=?', [held.id]);
            const items = JSON.parse(row.cart_data).items;
            expect(items).toHaveLength(2);
            expect(items.find(item => item.product_id === SEED.product1.id).qty).toBe(2);
            expect(Number(row.kitchen_dispatch_version)).toBe(2);
        });
    }
});
