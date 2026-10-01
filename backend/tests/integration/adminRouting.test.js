// adminRouting.test.js — Integration tests for Phase 3 route refactoring
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');
const { withBundleIntegrityChecksDisabled } = require('../helpers/bundleIntegrityFixtures');

describe('Admin Sub-Routing & Exception Integration Tests', () => {
    let adminCookie;
    let cashierCookie;
    let waiterCookie;

    beforeEach(async () => {
        await seedDatabase();

        // Login Admin
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];

        // Login Cashier (unprivileged)
        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];

        // Login Waiter (unprivileged)
        const waiterRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        waiterCookie = waiterRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    describe('Unauthenticated Access (401 Gateway Check)', () => {
        it('should reject unauthenticated request to admin dashboard', async () => {
            const res = await request(app).get('/api/admin/dashboard');
            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
        });

        it('should reject unauthenticated request to admin products', async () => {
            const res = await request(app).get('/api/admin/products');
            expect(res.statusCode).toBe(401);
        });
    });

    describe('Role Authorization (403 Restrict Check)', () => {
        it('should reject standard Cashier from admin dashboard', async () => {
            const res = await request(app)
                .get('/api/admin/dashboard')
                .set('Cookie', cashierCookie);
            expect(res.statusCode).toBe(403);
        });

        it('should reject standard Cashier from admin users CRUD', async () => {
            const res = await request(app)
                .get('/api/admin/users')
                .set('Cookie', cashierCookie);
            expect(res.statusCode).toBe(403);
        });

        it('should reject standard Waiter from admin audit logs', async () => {
            const res = await request(app)
                .get('/api/admin/audit')
                .set('Cookie', waiterCookie);
            expect(res.statusCode).toBe(403);
        });

        it('should reject standard Waiter from admin shifts list', async () => {
            const res = await request(app)
                .get('/api/admin/shifts')
                .set('Cookie', waiterCookie);
            expect(res.statusCode).toBe(403);
        });
    });

    describe('Bypass Exceptions Check (requireAdminUnlessExceptions)', () => {
        it('should allow any authenticated user to execute GET /printers', async () => {
            // Waiter should have access to load printers (needed for client configurations check)
            const res = await request(app)
                .get('/api/admin/printers')
                .set('Cookie', waiterCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });

        it('should block cashier from GET /orders if they lack orders.view permission', async () => {
            await pool.query("DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'orders.view'", [SEED.cashierUser.id]);
            invalidateUserSessions(SEED.cashierUser.id);

            const res = await request(app)
                .get('/api/admin/orders')
                .set('Cookie', cashierCookie);
            expect(res.statusCode).toBe(403);
        });

        it('should block cashier from GET /orders even with orders.view (admin-panel only)', async () => {
            // The admin Order History page is admin/programmer only now. The cashier
            // order history lives in the POS app (GET /api/pos/order_notes), not here.
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'orders.view')", [SEED.cashierUser.id]);
            invalidateUserSessions(SEED.cashierUser.id);

            const res = await request(app)
                .get('/api/admin/orders')
                .set('Cookie', cashierCookie);
            expect(res.statusCode).toBe(403);
        });

        it('should allow cashier to GET /order_details if they have orders.view permission', async () => {
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'orders.view')", [SEED.cashierUser.id]);
            invalidateUserSessions(SEED.cashierUser.id);

            // Query details for a non-existent invoice ID
            const res = await request(app)
                .get('/api/admin/order_details?id=9999')
                .set('Cookie', cashierCookie);
            
            // 404 Not Found proves it successfully bypassed the 403 authorization guard!
            expect(res.statusCode).toBe(404);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('not found');
        });

        it('should block cashier from GET /shifts?action=cashiers even with orders.view (admin-panel only)', async () => {
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'orders.view')", [SEED.cashierUser.id]);
            invalidateUserSessions(SEED.cashierUser.id);

            const res = await request(app)
                .get('/api/admin/shifts?action=cashiers')
                .set('Cookie', cashierCookie);
            expect(res.statusCode).toBe(403);
        });
    });

    describe('Admin Full Route Access Check (All Sub-Routers)', () => {
        it('should allow admin to load alerts and dashboard (dashboard.js)', async () => {
            const resAlerts = await request(app).get('/api/admin/alerts').set('Cookie', adminCookie);
            expect(resAlerts.statusCode).toBe(200);
            expect(resAlerts.body.lowStockItems).toBeDefined();

            const resDash = await request(app).get('/api/admin/dashboard').set('Cookie', adminCookie);
            expect(resDash.statusCode).toBe(200);
            expect(resDash.body.headline).toBeDefined();
            expect(resDash.body.pace?.points).toBeInstanceOf(Array);
        });

        it('should allow admin to load products and categories (products.js)', async () => {
            const resProd = await request(app).get('/api/admin/products').set('Cookie', adminCookie);
            expect(resProd.statusCode).toBe(200);
            expect(resProd.body.products).toBeDefined();

            const resCat = await request(app).get('/api/admin/categories').set('Cookie', adminCookie);
            expect(resCat.statusCode).toBe(200);
            expect(resCat.body.categories).toBeDefined();
        });

        it('should allow admin to load orders (orders.js)', async () => {
            const res = await request(app).get('/api/admin/orders').set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.orders).toBeDefined();
        });

        it('should allow admin to load users (users.js)', async () => {
            const res = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.users).toBeDefined();
        });

        it('should allow admin to load customers (customers.js)', async () => {
            const res = await request(app).get('/api/admin/customers').set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.customers).toBeDefined();
        });

        it('should allow admin to load shifts (shifts.js)', async () => {
            const res = await request(app).get('/api/admin/shifts').set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.shifts).toBeDefined();
        });

        it('should allow admin to load order types and printers (printers.js)', async () => {
            const resTypes = await request(app).get('/api/admin/order_types').set('Cookie', adminCookie);
            expect(resTypes.statusCode).toBe(200);
            expect(resTypes.body.data).toBeDefined();

            const resPrinters = await request(app).get('/api/admin/printers').set('Cookie', adminCookie);
            expect(resPrinters.statusCode).toBe(200);
            expect(resPrinters.body.data).toBeDefined();
        });

        it('should allow admin to load reports (reports.js)', async () => {
            const resReports = await request(app).get('/api/admin/reports').set('Cookie', adminCookie);
            expect(resReports.statusCode).toBe(200);
            expect(resReports.body.sales_summary).toBeDefined();

            const resSummary = await request(app).get('/api/admin/reports/summary').set('Cookie', adminCookie);
            expect(resSummary.statusCode).toBe(200);
            expect(resSummary.body.summary).toBeDefined();

            const resSales = await request(app).get('/api/admin/reports/sales-details').set('Cookie', adminCookie);
            expect(resSales.statusCode).toBe(200);
            expect(resSales.body.categories).toBeDefined();

            const resWaiters = await request(app).get('/api/admin/reports/waiters').set('Cookie', adminCookie);
            expect(resWaiters.statusCode).toBe(200);
            expect(resWaiters.body.summary).toBeDefined();
        });

        it('should allow admin to load audit logs and price history (audit.js)', async () => {
            const resAudit = await request(app).get('/api/admin/audit').set('Cookie', adminCookie);
            expect(resAudit.statusCode).toBe(200);
            expect(resAudit.body.events).toBeDefined();

            const resPrice = await request(app).get('/api/admin/audit/price-history').set('Cookie', adminCookie);
            expect(resPrice.statusCode).toBe(200);
            expect(resPrice.body.history).toBeDefined();
        });

        it('should return 405 (not hang) for unsupported method on printers/order_types', async () => {
            const r1 = await request(app).patch('/api/admin/printers').set('Cookie', adminCookie).send({});
            expect(r1.statusCode).toBe(405);
            const r2 = await request(app).patch('/api/admin/order_types').set('Cookie', adminCookie).send({});
            expect(r2.statusCode).toBe(405);
        });
    });

    describe('GET /api/admin/order_details - Receipt display v1 coverage (Task 7)', () => {
        let adminShiftId;

        beforeEach(async () => {
            const shiftRes = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', adminCookie)
                .send({ user_id: SEED.adminUser.id, starting_cash: 50.00 });
            expect(shiftRes.statusCode).toBe(200);

            const [rows] = await pool.query(
                "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
                [SEED.adminUser.id]
            );
            adminShiftId = rows[0].id;
        });

        it('returns v1 presentation for paid, voided, and partially refunded records', async () => {
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope)
                 VALUES (1, ?, 10.00, 1.60, 11.60, 'cash', 0, NOW(), 'paid-details-scope')`,
                [adminShiftId]
            );
            const invoiceId = orderRes.insertId;
            await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                 VALUES (?, ?, 'Burger', 2, 5.00, 16.00, 1.60)`,
                [invoiceId, SEED.product1.id]
            );

            const res = await request(app)
                .get(`/api/admin/order_details?id=${invoiceId}`)
                .set('Cookie', adminCookie);
            
            expect(res.statusCode).toBe(200);
            expect(res.body.receipt_display_v1).toBeDefined();
            expect(res.body.receipt_display_v1.summary.total).toBe(11.60);
        });

        // Admin print shares orderPresentationInput with the paid receipt path, so the
        // note is already covered at the mapper. This pins the route to that mapper:
        // the recurring failure here has been someone giving a receipt path its own row
        // builder, and three of those shipped without the note field.
        it('carries the item note through to the admin presentation', async () => {
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope)
                 VALUES (1, ?, 5.00, 0.00, 5.00, 'cash', 0, NOW(), 'admin-note-scope')`,
                [adminShiftId]
            );
            const invoiceId = orderRes.insertId;
            await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, note)
                 VALUES (?, ?, 'Burger', 1, 5.00, 0.00, 0.00, 'No onion')`,
                [invoiceId, SEED.product1.id]
            );

            const res = await request(app)
                .get(`/api/admin/order_details?id=${invoiceId}`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.receipt_display_v1.rows[0].note).toBe('No onion');
        });

        it('returns the Task 4 exact pre-v1 fallback/422 pair when v1 presentation validation fails or is absent', async () => {
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope)
                 VALUES (1, ?, 100.00, 0.00, 100.00, 'cash', NULL, NOW(), 'pre-v1-mismatch')`,
                [adminShiftId]
            );
            const invoiceId = orderRes.insertId;
            await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                 VALUES (?, ?, 'Burger', 1, 10.00, 16.00, 1.60)`,
                [invoiceId, SEED.product1.id]
            );

            const res = await request(app)
                .get(`/api/admin/order_details?id=${invoiceId}`)
                .set('Cookie', adminCookie);
            
            expect(res.statusCode).toBe(200);
            expect(res.body.receipt_display_v1).toBeUndefined();
            expect(res.body.receipt_display_legacy_reason).toBe('PRE_V1_CENT_MISMATCH');
        });

        it('returns 422 when v1 presentation validation fails (e.g. price mismatch on non-null tax_inclusive_at_sale)', async () => {
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope)
                 VALUES (1, ?, 100.00, 0.00, 100.00, 'cash', 0, NOW(), 'v1-mismatch')`,
                [adminShiftId]
            );
            const invoiceId = orderRes.insertId;
            await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                 VALUES (?, ?, 'Burger', 1, 10.00, 16.00, 1.60)`,
                [invoiceId, SEED.product1.id]
            );

            const res = await request(app)
                .get(`/api/admin/order_details?id=${invoiceId}`)
                .set('Cookie', adminCookie);
            
            expect(res.statusCode).toBe(422);
            expect(res.body.success).toBe(false);
            expect(res.body.publicCode).toBe('RECEIPT_PRESENTATION_INVALID');
        });

        it('returns typed bundle corruption for an invoice-local orphan', async () => {
            let invoiceId;
            await withBundleIntegrityChecksDisabled(pool, async conn => {
                const [orderRes] = await conn.query(
                    `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope)
                     VALUES (1, ?, 0.00, 0.00, 0.00, 'cash', 0, NOW(), 'bundle-corrupt-admin')`,
                    [adminShiftId]
                );
                invoiceId = orderRes.insertId;
                await conn.query(
                    `INSERT INTO order_items (invoice_id, product_id, item_name, parent_item_id, quantity, price_at_sale, tax_rate, tax_amount)
                     VALUES (?, ?, 'Orphan Bundle Child', 999999, 1, 0.00, 16.00, 0.00)`,
                    [invoiceId, SEED.product1.id]
                );
            });

            const response = await request(app)
                .get(`/api/admin/order_details?id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(response.statusCode).toBe(409);
            expect(response.body.publicCode).toBe('BUNDLE_ORDER_CORRUPT');
        });
    });
});
