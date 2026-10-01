const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { currentTableRevision } = require('../fixtures/tableOrderRevision');
// integration/permissions.test.js — Integration tests for role-based access control and gates
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { PERMISSIONS } = require('../../services/PermissionService');

// Inserts (or reuses) a table_manager user with a known PIN for override-scope tests.
async function ensureTableManager(pin = '7777') {
    await pool.query(
        "INSERT INTO users (id, user_number, name, role, is_active) VALUES (11, '9011', 'Test Table Manager', 'table_manager', 1) ON DUPLICATE KEY UPDATE is_active = 1"
    );
    const hash = require('bcryptjs').hashSync(pin, 12);
    await pool.query("UPDATE users SET admin_pin = ? WHERE id = 11", [hash]);
}

describe('Permissions Integration Tests', () => {
    let adminCookie;
    let waiterCookie;
    let cashierCookie;
    let cashierShiftId;

    beforeEach(async () => {
        await seedDatabase();

        // 1. Login Admin
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];

        // 2. Login Waiter
        const waiterRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        waiterCookie = waiterRes.headers['set-cookie'][0];

        // 3. Login Cashier
        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    afterEach(() => {
        const { overrideAttempts } = require('../../services/ManagerOverrideService');
        if (overrideAttempts) {
            overrideAttempts.clear();
        }
    });

    // Helper: open shift for cashier
    async function openCashierShift() {
        const res = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 20.00 });
        expect(res.statusCode).toBe(200);

        const [rows] = await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [SEED.cashierUser.id]);
        cashierShiftId = rows.length > 0 ? rows[0].id : null;
        return cashierShiftId;
    }

    // Helper: create a fresh saved table order owned by a given waiter id.
    async function seedTableOrder(ownerId) {
        const [r] = await pool.query(
            "INSERT INTO orders (order_id, waiter_id, user_id, table_id, subtotal, tax, total, created_at, payment_method) VALUES (720001, ?, ?, 1, 5.00, 0.80, 5.80, NOW(), 'unpaid_table')",
            [ownerId, ownerId]
        );
        const invoiceId = r.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, sort_order) VALUES (?, 1, 'Test Burger', 1, 5.00, 16, 0)",
            [invoiceId]
        );
        await pool.query("UPDATE restaurant_tables SET current_order_id = ?, status='occupied' WHERE id = 1", [invoiceId]);
        return invoiceId;
    }

    async function grant(userId, key) {
        await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, ?)", [userId, key]);
        const { invalidateUserSessions } = require('../../middleware/auth');
        invalidateUserSessions(userId);
        const relog = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        return relog.headers['set-cookie'][0];
    }

    async function revoke(userId, key) {
        await pool.query(
            'DELETE FROM user_permissions WHERE user_id=? AND perm_key=?',
            [userId, key]
        );
        const { invalidateUserSessions } = require('../../middleware/auth');
        invalidateUserSessions(userId);
        const relog = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        return relog.headers['set-cookie'][0];
    }

    describe('Role × Endpoints Permissions Matrix', () => {
        let programmerCookie;
        let tableManagerCookie;

        beforeEach(async () => {
            // Create and login a Programmer user dynamically
            await pool.query(
                "INSERT INTO users (id, user_number, name, role, is_active) VALUES (10, '9010', 'Test Programmer', 'programmer', 1)"
            );
            const progRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: '9010' });
            programmerCookie = progRes.headers['set-cookie'][0];

            // Create and login a Table Manager user dynamically
            await pool.query(
                "INSERT INTO users (id, user_number, name, role, is_active) VALUES (11, '9011', 'Test Table Manager', 'table_manager', 1)"
            );
            const tmRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: '9011' });
            tableManagerCookie = tmRes.headers['set-cookie'][0];
        });

        // 1. GET /api/admin/users (Admin-only gated endpoint)
        describe('GET /api/admin/users', () => {
            it('allows Admin and Programmer roles', async () => {
                const resAdmin = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
                expect(resAdmin.statusCode).toBe(200);

                const resProg = await request(app).get('/api/admin/users').set('Cookie', programmerCookie);
                expect(resProg.statusCode).toBe(200);
            });

            it('rejects Waiter, Cashier, and Table Manager roles (403)', async () => {
                for (const cookie of [waiterCookie, cashierCookie, tableManagerCookie]) {
                    const res = await request(app).get('/api/admin/users').set('Cookie', cookie);
                    expect(res.statusCode).toBe(403);
                }
            });
        });

        // 2. GET /api/admin/customers (Admin-only gated endpoint)
        describe('GET /api/admin/customers', () => {
            it('allows Admin and Programmer roles', async () => {
                const resAdmin = await request(app).get('/api/admin/customers').set('Cookie', adminCookie);
                expect(resAdmin.statusCode).toBe(200);

                const resProg = await request(app).get('/api/admin/customers').set('Cookie', programmerCookie);
                expect(resProg.statusCode).toBe(200);
            });

            it('rejects Waiter, Cashier, and Table Manager roles (403)', async () => {
                for (const cookie of [waiterCookie, cashierCookie, tableManagerCookie]) {
                    const res = await request(app).get('/api/admin/customers').set('Cookie', cookie);
                    expect(res.statusCode).toBe(403);
                }
            });
        });

        // 3. GET /api/admin/printers (Exception endpoint that allows GET for all authenticated users)
        describe('GET /api/admin/printers', () => {
            it('allows all authenticated roles', async () => {
                for (const cookie of [adminCookie, programmerCookie, waiterCookie, cashierCookie, tableManagerCookie]) {
                    const res = await request(app).get('/api/admin/printers').set('Cookie', cookie);
                    expect(res.statusCode).toBe(200);
                }
            });
        });

        // 4. GET /api/auth/shifts?action=history (Admin-only gated endpoint)
        describe('GET /api/auth/shifts?action=history', () => {
            it('allows Admin and Programmer roles', async () => {
                const resAdmin = await request(app).get('/api/auth/shifts?action=history').set('Cookie', adminCookie);
                expect(resAdmin.statusCode).toBe(200);

                const resProg = await request(app).get('/api/auth/shifts?action=history').set('Cookie', programmerCookie);
                expect(resProg.statusCode).toBe(200);
            });

            it('rejects Waiter, Cashier, and Table Manager roles (403)', async () => {
                for (const cookie of [waiterCookie, cashierCookie, tableManagerCookie]) {
                    const res = await request(app).get('/api/auth/shifts?action=history').set('Cookie', cookie);
                    expect(res.statusCode).toBe(403);
                }
            });
        });

        // 5. POST /api/auth/permissions (Admin-only mutation) - Deprecated
        describe('POST /api/auth/permissions', () => {
            it('returns 410 Deprecated for Admin and Programmer roles', async () => {
                const payload = {
                    id: SEED.cashierUser.id,
                    role: 'cashier',
                    canholdorders: 1,
                    can_update_table: 1,
                    can_view_orders: 1
                };
                const resAdmin = await request(app)
                    .post('/api/auth/permissions')
                    .set('Cookie', adminCookie)
                    .send(payload);
                expect(resAdmin.statusCode).toBe(410);

                const resProg = await request(app)
                    .post('/api/auth/permissions')
                    .set('Cookie', programmerCookie)
                    .send(payload);
                expect(resProg.statusCode).toBe(410);
            });

            it('rejects Waiter, Cashier, and Table Manager roles (403)', async () => {
                for (const cookie of [waiterCookie, cashierCookie, tableManagerCookie]) {
                    const res = await request(app)
                        .post('/api/auth/permissions')
                        .set('Cookie', cookie)
                        .send({ id: SEED.cashierUser.id, role: 'cashier' });
                    expect(res.statusCode).toBe(403);
                }
            });
        });

        // 6. GET /api/admin/reports (Admin-only gated endpoint)
        describe('GET /api/admin/reports', () => {
            it('allows Admin and Programmer roles', async () => {
                const resAdmin = await request(app).get('/api/admin/reports').set('Cookie', adminCookie);
                expect(resAdmin.statusCode).toBe(200);

                const resProg = await request(app).get('/api/admin/reports').set('Cookie', programmerCookie);
                expect(resProg.statusCode).toBe(200);
            });

            it('rejects Waiter, Cashier, and Table Manager roles (403)', async () => {
                for (const cookie of [waiterCookie, cashierCookie, tableManagerCookie]) {
                    const res = await request(app).get('/api/admin/reports').set('Cookie', cookie);
                    expect(res.statusCode).toBe(403);
                }
            });
        });

        // 7. GET /api/admin/audit & /api/admin/audit/price-history (Admin-only gated endpoints)
        describe('GET /api/admin/audit endpoints', () => {
            it('allows Admin and Programmer roles', async () => {
                const resAdmin = await request(app).get('/api/admin/audit').set('Cookie', adminCookie);
                expect(resAdmin.statusCode).toBe(200);

                const resProg = await request(app).get('/api/admin/audit/price-history').set('Cookie', programmerCookie);
                expect(resProg.statusCode).toBe(200);
            });

            it('rejects Waiter, Cashier, and Table Manager roles (403)', async () => {
                for (const cookie of [waiterCookie, cashierCookie, tableManagerCookie]) {
                    const resAudit = await request(app).get('/api/admin/audit').set('Cookie', cookie);
                    expect(resAudit.statusCode).toBe(403);

                    const resPrice = await request(app).get('/api/admin/audit/price-history').set('Cookie', cookie);
                    expect(resPrice.statusCode).toBe(403);
                }
            });
        });
    });

    describe('fixed call-center manager override boundary', () => {
        it('rejects the service directly before testing a valid manager PIN', async () => {
            await ensureTableManager('7777');
            const { authorizeManagerOverride } = require('../../services/ManagerOverrideService');

            await expect(authorizeManagerOverride({
                user: { id: 20, role: 'call_center', permissions: ['pos.checkout'] },
                managerPin: '7777',
                ipAddress: '127.0.0.1',
                route: '/direct-test'
            })).rejects.toMatchObject({ statusCode: 403 });
        });
    });

    describe('Checkout Feature Restrictions (Waiter vs Manager Override)', () => {
        // Waiters cannot apply order-level discounts without a manager PIN override.
        it('should reject checkout with discount for Cashier (without PIN override)', async () => {
            await openCashierShift();

            const cart = [
                { id: SEED.product1.id, qty: 1, price: SEED.product1.price } // burger 5.00, 16% tax -> 5.80
            ];

            const payload = {
                cart,
                shift_id: cashierShiftId,
                subtotal: 5.00,
                tax: 0.72, // 10% discount on burger: 4.50 * 0.16 = 0.72
                total: 5.22, // 4.50 + 0.72 = 5.22
                payment_method: 'cash',
                amount_tendered: 6.00,
                change_due: 0.78,
                order_discount_type: 'percent',
                order_discount_value: 10 // Cashier applying 10% discount without permission!
            };

            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie) // Cashier session
                .send(payload);

            expect(res.statusCode).toBe(403);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Manager PIN required to apply discounts');
        });

        it('should approve checkout with discount for Cashier with valid Manager PIN override', async () => {
            await openCashierShift();

            const cart = [
                { id: SEED.product2.id, qty: 1, price: SEED.product2.price } // drink 2.00, 0% tax -> 2.00
            ];

            // Apply 10% discount: 2.00 - 0.20 = 1.80
            const payload = {
                cart,
                shift_id: cashierShiftId,
                subtotal: 2.00,
                tax: 0.00,
                total: 1.80,
                payment_method: 'cash',
                amount_tendered: 2.00,
                change_due: 0.20,
                order_discount_type: 'percent',
                order_discount_value: 10,
                manager_pin: SEED.adminUser.pin // Valid Manager PIN override!
            };

            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(payload);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify order in DB has the discount
            const [orders] = await pool.query("SELECT * FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
            expect(Number(orders[0].total)).toBe(1.80);
            expect(orders[0].discount_type).toBe('percent');
            expect(Number(orders[0].discount_value)).toBe(10);
        });

        it('should reject checkout with discount for Cashier with invalid Manager PIN override', async () => {
            await openCashierShift();

            const cart = [
                { id: SEED.product2.id, qty: 1, price: SEED.product2.price }
            ];

            const payload = {
                cart,
                shift_id: cashierShiftId,
                subtotal: 2.00,
                tax: 0.00,
                total: 1.80,
                payment_method: 'cash',
                amount_tendered: 2.00,
                change_due: 0.20,
                order_discount_type: 'percent',
                order_discount_value: 10,
                manager_pin: 'invalid_pin_override' // INVALID PIN!
            };

            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(payload);

            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Invalid manager override PIN');
        });
    });

    describe('Cashier permission gates', () => {
        async function grant(userId, keys) {
            await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [userId]);
            if (keys.length) await pool.query("INSERT INTO user_permissions (user_id, perm_key) VALUES ?", [keys.map(k => [userId, k])]);
            // bust the session cache so the new grants load
            const { invalidateUserSessions } = require('../../middleware/auth');
            invalidateUserSessions(userId);
        }

        it('GET /api/admin/permissions returns the canonical catalog to admin', async () => {
            const res = await request(app).get('/api/admin/permissions').set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            const catalogKeys = res.body.catalog.map(row => row.perm_key);
            expect(catalogKeys).toHaveLength(Object.values(PERMISSIONS).length);
            expect(catalogKeys).toEqual(expect.arrayContaining(Object.values(PERMISSIONS)));
            expect(catalogKeys).toContain('pos.tax_exempt');

            expect(res.body.catalog.find(row => row.perm_key === 'orders.view')).toMatchObject({
                label: 'POS Order History',
                label_ar: 'سجل طلبات نقطة البيع',
                description: 'View recent orders, totals, and receipts in the POS Order Notes history. Does not grant Admin Orders access.',
                description_ar: 'عرض الطلبات الأخيرة والإجماليات والإيصالات في سجل ملاحظات الطلبات بنقطة البيع. لا يمنح الوصول إلى طلبات لوحة الإدارة.',
                default_cashier: 0,
            });
        });

        it('blocks checkout when cashier lacks pos.checkout', async () => {
            await grant(SEED.cashierUser.id, ['pos.hold_orders', 'shift.open']);
            // re-login to refresh cookie/permissions
            const r = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            const cookie = r.headers['set-cookie'][0];
            await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
            const [rows] = await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status='open' LIMIT 1", [SEED.cashierUser.id]);
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: rows[0].id, subtotal: 5.0, tax: 0.8, total: 5.8,
                payment_method: 'cash', amount_tendered: 6, change_due: 0.2
            });
            expect(res.statusCode).toBe(403);
        });

        it('blocks shift open when cashier lacks shift.open', async () => {
            await grant(SEED.cashierUser.id, ['pos.checkout']);
            const r = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            const cookie = r.headers['set-cookie'][0];
            const res = await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
            expect(res.statusCode).toBe(403);
        });

        it('rejects a client-forged zero-tax checkout', async () => {
            await grant(SEED.cashierUser.id, ['pos.checkout', 'shift.open']);
            const r = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            const cookie = r.headers['set-cookie'][0];
            await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
            const [s] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);
            // product1 is taxable (16%). Server recomputes total to 5.80.
            // assertNearMoney('Total', 5.00, 5.80) fires before validatePayments,
            // giving "Total mismatch" — client total is no longer silently ignored.
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: s[0].id, subtotal: 5.00, tax: 0, total: 5.00,
                payment_method: 'cash', amount_tendered: 5.00, change_due: 0
            });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/Total mismatch/i);
        });

        it('table_manager override grants an OVERRIDABLE perm (discount) but NOT a non-overridable one (checkout)', async () => {
            await ensureTableManager('7777');

            // Cashier with neither pos.checkout nor pos.discount.
            await grant(SEED.cashierUser.id, ['pos.hold_orders', 'shift.open']);
            const r = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            const cookie = r.headers['set-cookie'][0];
            await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
            const [s] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);

            // Checkout (non-overridable) must STILL fail under a table_manager PIN.
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
                cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }], // product2 tax 0%
                shift_id: s[0].id, subtotal: 2.00, tax: 0, total: 2.00,
                payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
                manager_pin: '7777'
            });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/check out|checkout/i);
        });

        it('does not make checkout permission overridable through an admin PIN', async () => {
            await grant(SEED.cashierUser.id, ['pos.hold_orders', 'shift.open']); // no pos.checkout
            const r = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            const cookie = r.headers['set-cookie'][0];
            await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.cashierUser.id, starting_cash: 20 });
            const [s] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open' LIMIT 1", [SEED.cashierUser.id]);
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cookie).send({
                cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                shift_id: s[0].id, subtotal: 2.00, tax: 0, total: 2.00,
                payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
                manager_pin: SEED.adminUser.pin
            });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/check out|checkout/i);
        });

        describe('tables.access enforcement (GET /api/pos/get_tables)', () => {
            it('rejects a cashier without tables.access (403)', async () => {
                // Seed cashier has no tables.access grant by default.
                const res = await request(app)
                    .get(`/api/pos/get_tables?user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', cashierCookie);
                expect(res.statusCode).toBe(403);
            });

            it('allows a cashier once granted tables.access', async () => {
                await pool.query(
                    "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'tables.access')",
                    [SEED.cashierUser.id]
                );
                // Re-login so the freshly granted permission is loaded into the session.
                const relog = await request(app)
                    .post('/api/auth/login')
                    .send({ user_number: SEED.cashierUser.user_number });
                const freshCookie = relog.headers['set-cookie'][0];

                const res = await request(app)
                    .get(`/api/pos/get_tables?user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', freshCookie);
                expect(res.statusCode).toBe(200);
            });

            it('allows a waiter without an explicit grant (role inherently needs tables)', async () => {
                const res = await request(app)
                    .get(`/api/pos/get_tables?user_id=${SEED.waiterUser.id}`)
                    .set('Cookie', waiterCookie);
                expect(res.statusCode).toBe(200);
            });
        });

        describe('orders.view enforcement (GET /api/pos/order_notes)', () => {
            it('keeps held-order access independent from paid-order history', async () => {
                await pool.query(
                    "DELETE FROM user_permissions WHERE user_id = ? AND perm_key IN ('pos.hold_orders', 'orders.view')",
                    [SEED.cashierUser.id]
                );
                await pool.query(
                    "INSERT INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.hold_orders')",
                    [SEED.cashierUser.id]
                );
                const heldOnlyLogin = await request(app)
                    .post('/api/auth/login')
                    .send({ user_number: SEED.cashierUser.user_number });
                const heldOnlyCookie = heldOnlyLogin.headers['set-cookie'][0];

                expect((await request(app).get('/api/pos/held_orders').set('Cookie', heldOnlyCookie)).statusCode).toBe(200);
                expect((await request(app).get('/api/pos/order_notes').set('Cookie', heldOnlyCookie)).statusCode).toBe(403);

                await pool.query(
                    "DELETE FROM user_permissions WHERE user_id = ? AND perm_key IN ('pos.hold_orders', 'orders.view')",
                    [SEED.cashierUser.id]
                );
                await pool.query(
                    "INSERT INTO user_permissions (user_id, perm_key) VALUES (?, 'orders.view')",
                    [SEED.cashierUser.id]
                );
                const historyOnlyLogin = await request(app)
                    .post('/api/auth/login')
                    .send({ user_number: SEED.cashierUser.user_number });
                const historyOnlyCookie = historyOnlyLogin.headers['set-cookie'][0];

                expect((await request(app).get('/api/pos/held_orders').set('Cookie', historyOnlyCookie)).statusCode).toBe(403);
                expect((await request(app).get('/api/pos/order_notes').set('Cookie', historyOnlyCookie)).statusCode).toBe(200);
            });

            it('rejects a cashier without the orders.view grant (403)', async () => {
                await pool.query(
                    "DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'orders.view'",
                    [SEED.cashierUser.id]
                );
                // Re-login so the tokenCache gets a fresh session without orders.view
                const relog = await request(app)
                    .post('/api/auth/login')
                    .send({ user_number: SEED.cashierUser.user_number });
                const freshCookie = relog.headers['set-cookie'][0];

                const res = await request(app)
                    .get('/api/pos/order_notes')
                    .set('Cookie', freshCookie);
                expect(res.statusCode).toBe(403);
            });

            it('allows a cashier granted the new orders.view key', async () => {
                await pool.query(
                    "INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'orders.view')",
                    [SEED.cashierUser.id]
                );
                const relog = await request(app)
                    .post('/api/auth/login')
                    .send({ user_number: SEED.cashierUser.user_number });
                const freshCookie = relog.headers['set-cookie'][0];

                const res = await request(app)
                    .get('/api/pos/order_notes')
                    .set('Cookie', freshCookie);
                expect(res.statusCode).toBe(200);
            });

            it('rejects a cashier without the canonical orders.view grant', async () => {
                // Authorization is owned by permissions/user_permissions; no legacy users-column fallback exists.
                await pool.query(
                    "DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'orders.view'",
                    [SEED.cashierUser.id]
                );
                const relog = await request(app)
                    .post('/api/auth/login')
                    .send({ user_number: SEED.cashierUser.user_number });
                const freshCookie = relog.headers['set-cookie'][0];

                const res = await request(app)
                    .get('/api/pos/order_notes')
                    .set('Cookie', freshCookie);
                expect(res.statusCode).toBe(403);
            });
        });

        describe('pos.void_printed_item recognized by canVoidPrinted', () => {
            const { canVoidPrinted } = require('../../services/PermissionService');

            it('returns false for a cashier without the grant', () => {
                const user = { role: 'cashier', permissions: [] };
                expect(canVoidPrinted(user)).toBe(false);
            });

            it('returns true for a cashier granted pos.void_printed_item', () => {
                const user = { role: 'cashier', permissions: ['pos.void_printed_item'] };
                expect(canVoidPrinted(user)).toBe(true);
            });

            it('returns true for admin via role bypass', () => {
                expect(canVoidPrinted({ role: 'admin', permissions: [] })).toBe(true);
            });
        });

        describe('admin user create writes grants, not legacy cashier columns', () => {
            it('creates a cashier whose permissions come from the permissions[] payload', async () => {
                const res = await request(app)
                    .post('/api/admin/users')
                    .set('Cookie', adminCookie)
                    .send({
                        name: 'Grant Cashier',
                        user_number: '9099',
                        role: 'cashier',
                        permissions: ['pos.checkout', 'pos.hold_orders'],
                        allowed_sections: ''
                    });
                expect(res.statusCode).toBe(200);
                const newId = res.body.id;

                const [grants] = await pool.query(
                    "SELECT perm_key FROM user_permissions WHERE user_id = ? ORDER BY perm_key",
                    [newId]
                );
                expect(grants.map(g => g.perm_key)).toEqual(['pos.checkout', 'pos.hold_orders']);
            });
        });
    });

    describe('waiter save-lock + ownership (table_order)', () => {
        it('restricted waiter CANNOT edit their own order after save (locked)', async () => {
            const invoiceId = await seedTableOrder(SEED.waiterUser.id);
            const restrictedCookie = await revoke(SEED.waiterUser.id, 'waiter.edit_locked');
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', restrictedCookie)
                .send({ current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), table_id: 1, cart: [
                    { product_id: 1, qty: 2, price: 5.00, tax_rate: 16, note: '' }
                ], subtotal: 10, tax: 1.6, total: 11.6 });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/saved|locked|permission/i);
        });

        it('waiter WITH waiter.edit_locked CAN edit their own saved order', async () => {
            const invoiceId = await seedTableOrder(SEED.waiterUser.id);
            const cookie = await grant(SEED.waiterUser.id, 'waiter.edit_locked');
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({ current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), table_id: 1, append_to_existing: true, cart: [
                    { product_id: 1, qty: 1, price: 5.00, tax_rate: 16, note: '' }
                ], subtotal: 5, tax: 0.8, total: 5.8 });
            expect(res.statusCode).toBe(200);
        });

        it('restricted waiter CANNOT load another waiters table', async () => {
            const invoiceId = await seedTableOrder(SEED.adminUser.id); // owned by someone else
            const res = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', waiterCookie);
            expect(res.statusCode).toBe(403);
        });

        it('waiter WITH waiter.override_tables CAN load another waiters table', async () => {
            const invoiceId = await seedTableOrder(SEED.adminUser.id);
            const cookie = await grant(SEED.waiterUser.id, 'waiter.override_tables');
            const res = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', cookie);
            expect(res.statusCode).toBe(200);
        });

        it('restricted waiter CANNOT create a new table order (no edit_locked), flag present', async () => {
            const restrictedCookie = await revoke(SEED.waiterUser.id, 'waiter.edit_locked');
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', restrictedCookie)
                .send({ table_id: 1, require_update_permission: true, cart: [
                    { product_id: 1, qty: 1, price: 5.00, tax_rate: 16, note: '' }
                ], subtotal: 5, tax: 0.8, total: 5.8 });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/permission/i);
        });

        it('restricted waiter CANNOT create a new table order even WITHOUT the flag', async () => {
            const restrictedCookie = await revoke(SEED.waiterUser.id, 'waiter.edit_locked');
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', restrictedCookie)
                .send({ table_id: 2, cart: [
                    { product_id: 1, qty: 1, price: 5.00, tax_rate: 16, note: '' }
                ], subtotal: 5, tax: 0.8, total: 5.8 });
            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/permission/i);
        });

        it('waiter WITH waiter.edit_locked CAN create a new table order', async () => {
            const cookie = await grant(SEED.waiterUser.id, 'waiter.edit_locked');
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({ table_id: 1, cart: [
                    { product_id: 1, qty: 1, price: 5.00, tax_rate: 16, note: '' }
                ], subtotal: 5, tax: 0.8, total: 5.8 });
            expect(res.statusCode).toBe(200);
        });
    });

    describe('waiter transfer/merge gating', () => {
        it('restricted waiter cannot transfer a table and both tables stay as they were', async () => {
            const invoiceId = await seedTableOrder(SEED.waiterUser.id);
            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', waiterCookie)
                .send(await tableActionIntent(pool, { action: 'transfer', sourceTableId: 1, targetTableId: 2 }));
            expect(res.statusCode).toBe(403);
            const [tables] = await pool.query('SELECT id, status, current_order_id FROM restaurant_tables WHERE id IN (1, 2) ORDER BY id');
            expect(tables).toEqual([
                { id: 1, status: 'occupied', current_order_id: invoiceId },
                { id: 2, status: 'available', current_order_id: null }
            ]);
            const [[order]] = await pool.query('SELECT table_id FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(order.table_id).toBe(1);
        });
    });

    describe('waiter.checkout gating', () => {
        it('restricted waiter cannot finalize a paid checkout (403)', async () => {
            await pool.query("DELETE FROM shifts WHERE user_id = ?", [SEED.waiterUser.id]);
            await pool.query("INSERT INTO shifts (user_id, status, starting_cash) VALUES (?, 'open', 20.00)", [SEED.waiterUser.id]);
            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', waiterCookie)
                .send({ payment_method: 'cash', amount_tendered: 6, cart: [
                    { product_id: 1, qty: 1, price: 5.00, tax_rate: 16, note: '' }
                ], subtotal: 5, tax: 0.8, total: 5.8 });
            expect(res.statusCode).toBe(403);
        });

        // Successful saved-table payment and denied counter payment are covered
        // with real settlements in checkoutPermissionScope.test.js.

    });

    describe('tax-exempt permission catalog', () => {
        it('is default-deny, not automatically granted, and keeps role bypass', async () => {
            expect(PERMISSIONS.POS_TAX_EXEMPT).toBe('pos.tax_exempt');

            const [[catalog]] = await pool.query(
                'SELECT perm_key, label_ar, implemented, default_cashier, overridable FROM permissions WHERE perm_key = ?',
                [PERMISSIONS.POS_TAX_EXEMPT]
            );
            expect(catalog).toMatchObject({
                perm_key: 'pos.tax_exempt',
                label_ar: 'إعفاء ضريبي',
                implemented: 1,
                default_cashier: 0,
                overridable: 0
            });

            const [[grant]] = await pool.query(
                'SELECT COUNT(*) AS count FROM user_permissions WHERE user_id = ? AND perm_key = ?',
                [SEED.cashierUser.id, PERMISSIONS.POS_TAX_EXEMPT]
            );
            expect(Number(grant.count)).toBe(0);

            const { canTaxExempt } = require('../../services/PermissionService');
            expect(canTaxExempt({ role: 'cashier', permissions: [] })).toBe(false);
            expect(canTaxExempt({ role: 'cashier', permissions: ['pos.tax_exempt'] })).toBe(true);
            expect(canTaxExempt({ role: 'admin', permissions: [] })).toBe(true);
            expect(canTaxExempt({ role: 'programmer', permissions: [] })).toBe(true);
        });
    });
});

