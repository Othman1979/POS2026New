// integration/shift.test.js — Integration tests for shift lifecycle: open, close, and guards
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const {
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');
const { getBusinessDayRange, getBusinessDate } = require('../../utils/businessDate');

describe('Shift Integration Tests', () => {
    let cashierCookie;
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();

        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    // Helper: make the next matching query on the next pooled connection throw.
    function failNextConnectionQuery(predicate, message) {
        const originalGetConnection = pool.getConnection;
        pool.getConnection = async function () {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            const originalRelease = conn.release;
            let failed = false;
            conn.query = async function (sql, params) {
                if (!failed && predicate(sql, params)) {
                    failed = true;
                    throw new Error(message);
                }
                return originalQuery.call(this, sql, params);
            };
            conn.release = function () {
                conn.query = originalQuery;
                conn.release = originalRelease;
                pool.getConnection = originalGetConnection;
                return originalRelease.call(this);
            };
            return conn;
        };
    }

    const isAuditInsert = (eventType) => (sql, params) =>
        sql.includes('INSERT INTO audit_events') && Array.isArray(params) && params[0] === eventType;

    // Helper: record a drawer expense paid out of the shift's cash
    async function insertDrawerExpense(shiftId, amount) {
        const [category] = await pool.query(
            "INSERT INTO expense_categories (name, is_active, sort_order, created_by) VALUES ('Supplies', 1, 10, ?)",
            [SEED.adminUser.id]
        );
        await pool.query(
            `INSERT INTO expenses (category_id, amount, source, shift_id, note, created_by, created_at)
             VALUES (?, ?, 'drawer', ?, 'Shift purchase', ?, '2026-07-01 10:00:00')`,
            [category.insertId, amount, shiftId, SEED.cashierUser.id]
        );
        return category.insertId;
    }

    // Helper: open a shift for the cashier
    async function openCashierShift(startingCash = 50.00) {
        const res = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: startingCash });
        expect(res.statusCode).toBe(200);

        const [rows] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.cashierUser.id]
        );
        return rows[0].id;
    }

    describe('Shift Open', () => {
        describe('opening drawer reference', () => {
            it('returns only the latest closing count from the current business day', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO shifts
                      (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                    VALUES
                      (?, 10, 20, 21.25, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR)),
                      (?, 21.25, 30, 32.50, 'closed', ?, DATE_ADD(?, INTERVAL 2 HOUR))
                `, [SEED.adminUser.id, range.start, range.start, SEED.adminUser.id, range.start, range.start]);

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', cashierCookie);

                expect(response.statusCode).toBe(200);
                expect(response.headers['cache-control']).toContain('no-store');
                expect(response.body).toEqual({
                    success: true,
                    shift: null,
                    previous_shift_closing_cash: 32.5,
                    suggested_starting_cash: 32.5,
                });
            });

            it('suggests the previous close over the configured float after a same-day close', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO settings (setting_key, setting_value)
                    VALUES ('first_shift_starting_cash', '100')
                    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
                `);
                await pool.query(`
                    INSERT INTO shifts
                      (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                    VALUES (?, 10, 20, 32.50, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
                `, [SEED.adminUser.id, range.start, range.start]);

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', cashierCookie);

                expect(response.statusCode).toBe(200);
                expect(response.body.previous_shift_closing_cash).toBe(32.5);
                expect(response.body.suggested_starting_cash).toBe(32.5);
            });

            it('suggests nothing while any shift is open after a same-day close', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO shifts
                      (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                    VALUES (?, 10, 20, 32.50, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
                `, [SEED.adminUser.id, range.start, range.start]);
                await pool.query(
                    "INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (?, 32.50, 'open', DATE_ADD(?, INTERVAL 2 HOUR))",
                    [SEED.waiterUser.id, range.start]
                );

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', cashierCookie);

                expect(response.statusCode).toBe(200);
                expect(response.body.previous_shift_closing_cash).toBeNull();
                expect(response.body.suggested_starting_cash).toBeNull();
            });

            it('admin check for a selected cashier returns the same suggestion', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO shifts
                      (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                    VALUES (?, 10, 20, 32.50, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
                `, [SEED.adminUser.id, range.start, range.start]);

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', adminCookie);

                expect(response.statusCode).toBe(200);
                expect(response.body.shift).toBeNull();
                expect(response.body.previous_shift_closing_cash).toBe(32.5);
                expect(response.body.suggested_starting_cash).toBe(32.5);
            });

            it('suggests the configured float to concurrent first shifts before any shift closes', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO settings (setting_key, setting_value)
                    VALUES ('first_shift_starting_cash', '100')
                    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
                `);
                await pool.query(
                    "INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (?, 100, 'open', DATE_ADD(?, INTERVAL 1 HOUR))",
                    [SEED.waiterUser.id, range.start]
                );

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', cashierCookie);

                expect(response.statusCode).toBe(200);
                expect(response.body.shift).toBeNull();
                expect(response.body.previous_shift_closing_cash).toBeNull();
                expect(response.body.suggested_starting_cash).toBe(100);
            });

            it('does not carry a closing count across the business-day boundary', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO shifts
                      (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                    VALUES (?, 10, 20, 19.50, 'closed', DATE_SUB(?, INTERVAL 2 HOUR), DATE_SUB(?, INTERVAL 1 SECOND))
                `, [SEED.adminUser.id, range.start, range.start]);

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', cashierCookie);

                expect(response.body.previous_shift_closing_cash).toBeNull();
                expect(response.body.suggested_starting_cash).toBe(0);
            });

            it('does not disclose the reference without shift-open permission', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO shifts
                      (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                    VALUES (?, 10, 20, 22.00, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
                `, [SEED.adminUser.id, range.start, range.start]);
                const [user] = await pool.query(`
                    INSERT INTO users (name, role, user_number, is_active)
                    VALUES ('No Shift Permission', 'cashier', '9198', 1)
                `);
                const login = await request(app).post('/api/auth/login').send({ user_number: '9198' });

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${user.insertId}`)
                    .set('Cookie', login.headers['set-cookie'][0]);

                expect(response.statusCode).toBe(200);
                expect(response.body.previous_shift_closing_cash).toBeNull();
                expect(response.body.suggested_starting_cash).toBeNull();
            });

            it('suppresses an ambiguous reference while any shift remains open', async () => {
                const range = getBusinessDayRange(getBusinessDate());
                await pool.query(`
                    INSERT INTO shifts
                      (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                    VALUES (?, 10, 20, 23.00, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
                `, [SEED.adminUser.id, range.start, range.start]);
                await pool.query(
                    "INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (?, 23.00, 'open', DATE_ADD(?, INTERVAL 2 HOUR))",
                    [SEED.waiterUser.id, range.start]
                );

                const response = await request(app)
                    .get(`/api/auth/shifts?action=check&user_id=${SEED.cashierUser.id}`)
                    .set('Cookie', cashierCookie);

                expect(response.body.previous_shift_closing_cash).toBeNull();
                expect(response.body.suggested_starting_cash).toBeNull();
            });
        });

        it('should open a shift successfully with starting float', async () => {
            const res = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: 100.00 });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.shift_id).toBeDefined();

            // Verify shift in DB
            const [rows] = await pool.query("SELECT starting_cash, status FROM shifts WHERE id = ?", [res.body.shift_id]);
            expect(rows).toHaveLength(1);
            expect(rows[0].status).toBe('open');
            expect(Number(rows[0].starting_cash)).toBe(100.00);
        });

        it('stores the submitted starting cash instead of forcing the configured suggestion', async () => {
            await pool.query(`
                INSERT INTO settings (setting_key, setting_value)
                VALUES ('first_shift_starting_cash', '100')
                ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)
            `);

            const res = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: 37.50 });

            expect(res.statusCode).toBe(200);
            const [[shift]] = await pool.query('SELECT starting_cash FROM shifts WHERE id = ?', [res.body.shift_id]);
            expect(Number(shift.starting_cash)).toBe(37.50);
        });

        it('should block opening a second shift when user already has an open shift', async () => {
            // Open first shift
            await openCashierShift(50.00);

            // Attempt to open a second shift for the same user
            const res = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: 30.00 });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('already has an open shift');
        });

        it('should block cashier from opening shift for a different user', async () => {
            // Cashier tries to open a shift for admin (another user)
            const res = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.adminUser.id, starting_cash: 50.00 });

            expect(res.statusCode).toBe(403);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain("Cannot open another user's shift");
        });
    });

    describe('fixed call-center shift wall', () => {
        async function createCallCenterSession() {
            await pool.query(`
                INSERT INTO users (id, user_number, name, role, is_active)
                VALUES (20, '9020', 'Call Center Shift', 'call_center', 1)
            `);
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (20, 'shift.open'), (20, 'shift.close')");
            const login = await request(app).post('/api/auth/login').send({ user_number: '9020' });
            return login.headers['set-cookie'][0];
        }

        it('rejects every self shift action even with stale grants and a legacy open shift', async () => {
            const cookie = await createCallCenterSession();
            const [legacy] = await pool.query("INSERT INTO shifts (user_id, starting_cash, status) VALUES (20, 5, 'open')");

            const responses = [];
            responses.push(await request(app).get('/api/auth/shifts?action=check&user_id=20').set('Cookie', cookie));
            responses.push(await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: 20, starting_cash: 5 }));
            responses.push(await request(app).get(`/api/auth/shifts?action=zreport&shift_id=${legacy.insertId}`).set('Cookie', cookie));
            responses.push(await request(app).put('/api/auth/shifts?action=update_cash').set('Cookie', cookie).send({ shift_id: legacy.insertId, starting_cash: 6 }));
            responses.push(await request(app).put('/api/auth/shifts?action=close').set('Cookie', cookie).send({ shift_id: legacy.insertId, actual_cash: 5 }));

            expect(responses.map(response => response.statusCode)).toEqual([403, 403, 403, 403, 403]);
            const [[shift]] = await pool.query('SELECT status, starting_cash FROM shifts WHERE id=?', [legacy.insertId]);
            expect(shift).toEqual({ status: 'open', starting_cash: '5.00' });
        });

        it('excludes call center from eligible cashiers and refuses admin-created shifts', async () => {
            await createCallCenterSession();
            const eligible = await request(app).get('/api/admin/shifts?action=cashiers&all=true').set('Cookie', adminCookie);
            expect(eligible.statusCode).toBe(200);
            expect(eligible.body.cashiers.some(user => user.id === 20)).toBe(false);

            const open = await request(app).post('/api/admin/shifts').set('Cookie', adminCookie)
                .send({ user_id: 20, starting_cash: 5 });
            expect(open.statusCode).toBe(403);

            const authOpen = await request(app).post('/api/auth/shifts?action=open').set('Cookie', adminCookie)
                .send({ user_id: 20, starting_cash: 5 });
            expect(authOpen.statusCode).toBe(403);
            const [[count]] = await pool.query("SELECT COUNT(*) AS count FROM shifts WHERE user_id=20 AND status='open'");
            expect(Number(count.count)).toBe(0);
        });
    });

    describe('Shift Close', () => {
        it('should close a shift successfully and compute expected_cash from DB orders', async () => {
            const shiftId = await openCashierShift(50.00);

            // Create one cash order in this shift via checkout
            const cartPayload = {
                cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                shift_id: shiftId,
                subtotal: 2.00,
                tax: 0.00,
                total: 2.00,
                payment_method: 'cash',
                amount_tendered: 2.00,
                change_due: 0.00
            };
            const checkoutRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(cartPayload);
            expect(checkoutRes.statusCode).toBe(200);

            // Close the shift with actual_cash = 52.00 (starting 50 + 2 sale)
            const closeRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 52.00, shift_id: shiftId });

            expect(closeRes.statusCode).toBe(200);
            expect(closeRes.body.success).toBe(true);
            // expected_cash = 50 (starting) + 2 (cash sale) = 52
            expect(Number(closeRes.body.expected_cash)).toBe(52.00);

            // Verify shift is closed in DB
            const [rows] = await pool.query("SELECT status, expected_cash, actual_cash FROM shifts WHERE id = ?", [shiftId]);
            expect(rows[0].status).toBe('closed');
            expect(Number(rows[0].expected_cash)).toBe(52.00);
            expect(Number(rows[0].actual_cash)).toBe(52.00);
        });

        it.each(['occupied', 'printed'])('blocks shift close while the cashier has an unpaid %s table order', async (tableStatus) => {
            const shiftId = await openCashierShift(50.00);

            // Seed an unpaid table order owned by the cashier directly (creating via the
            // endpoint now requires waiter.edit_locked, which the cashier does not have).
            const [ins] = await pool.query(
                `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
                 VALUES (730001, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
                [SEED.cashierUser.id, SEED.cashierUser.id, SEED.table.id, shiftId]
            );
            await pool.query(
                "UPDATE restaurant_tables SET status=?, current_order_id=? WHERE id=?",
                [tableStatus, ins.insertId, SEED.table.id]
            );

            const closeRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 50.00, shift_id: shiftId });

            expect(closeRes.statusCode).toBe(409);
            expect(closeRes.body.success).toBe(false);
            expect(closeRes.body.message).toContain('Cannot close shift');
            expect(closeRes.body.message).toContain('open table order');
            const [[shift]] = await pool.query("SELECT status FROM shifts WHERE id = ?", [shiftId]);
            expect(shift.status).toBe('open');
        });

        it("refuses a cashier closing another cashier's shift and leaves it open", async () => {
            const otherShiftId = await insertShift(pool, {
                user_id: SEED.priceOverrideUser.id,
                starting_cash: 30.00,
                status: 'open',
            });

            const closeRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 0, shift_id: otherShiftId });

            expect(closeRes.statusCode).toBe(403);
            const [[shift]] = await pool.query("SELECT status, actual_cash FROM shifts WHERE id = ?", [otherShiftId]);
            expect(shift.status).toBe('open');
            expect(shift.actual_cash).toBeNull();
        });

        it('refuses a cashier without shift.close closing their own shift', async () => {
            const shiftId = await openCashierShift(50.00);
            await pool.query(
                "DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'shift.close'",
                [SEED.cashierUser.id]
            );
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });

            const closeRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', loginRes.headers['set-cookie'][0])
                .send({ actual_cash: 50.00, shift_id: shiftId });

            expect(closeRes.statusCode).toBe(403);
            const [[shift]] = await pool.query("SELECT status FROM shifts WHERE id = ?", [shiftId]);
            expect(shift.status).toBe('open');
        });

        it('should block closing an already-closed shift', async () => {
            const shiftId = await openCashierShift(50.00);

            // Close the shift the first time
            const closeRes1 = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 50.00, shift_id: shiftId });
            expect(closeRes1.statusCode).toBe(200);

            // Re-login cashier since their session was invalidated
            const reLoginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const newCashierCookie = reLoginRes.headers['set-cookie'][0];

            // Try to close again
            const closeRes2 = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', newCashierCookie)
                .send({ actual_cash: 50.00, shift_id: shiftId });

            expect(closeRes2.statusCode).toBe(400);
            expect(closeRes2.body.success).toBe(false);
            expect(closeRes2.body.message).toContain('already closed');
        });

        it('should compute correct expected_cash excluding card and unpaid_table payments', async () => {
            const shiftId = await openCashierShift(20.00);

            // Card payment — should NOT count toward expected_cash
            await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                    shift_id: shiftId,
                    subtotal: 2.00, tax: 0.00, total: 2.00,
                    payment_method: 'card',
                    amount_tendered: 2.00, change_due: 0.00,
                    idempotency_key: 'card_payment_shift_test'
                });

            // Cash payment — SHOULD count toward expected_cash
            await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product2.id, qty: 2, price: SEED.product2.price }],
                    shift_id: shiftId,
                    subtotal: 4.00, tax: 0.00, total: 4.00,
                    payment_method: 'cash',
                    amount_tendered: 4.00, change_due: 0.00,
                    idempotency_key: 'cash_payment_shift_test'
                });

            const closeRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 24.00, shift_id: shiftId });

            expect(closeRes.statusCode).toBe(200);
            // expected_cash = 20 (starting) + 4 (cash only) = 24.00 — NOT 26
            expect(Number(closeRes.body.expected_cash)).toBe(24.00);
        });
    });

    describe('Shift Starting Float Lock After First Order', () => {
        it('should block cashier from updating starting cash after an order has been placed', async () => {
            const shiftId = await openCashierShift(50.00);

            // Place an order in this shift
            const checkoutRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                    shift_id: shiftId,
                    subtotal: 2.00, tax: 0.00, total: 2.00,
                    payment_method: 'cash',
                    amount_tendered: 2.00, change_due: 0.00
                });
            expect(checkoutRes.statusCode).toBe(200);

            // Attempt to update starting cash after a sale
            const updateRes = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ starting_cash: 100.00, shift_id: shiftId });

            expect(updateRes.statusCode).toBe(403);
            expect(updateRes.body.success).toBe(false);
        });
    });

    describe('Z-Report Refund Netting', () => {
        it('should net cash refunds from gross_sales and expected_cash in Z-report', async () => {
            const shiftId = await openCashierShift(50.00);

            // Seed a cash order directly (total=100, cash_amount=100) in this shift
            const invoiceId = await insertPaidOrder(pool, {
                order_id: 1,
                shift_id: shiftId,
                subtotal: 100.00,
                tax: 0.00,
                total: 100.00,
                payment_method: 'cash',
                cash_amount: 100.00,
                card_amount: 0.00,
            });

            // Seed a cash refund of 40 scoped to this shift
            await insertOrderRefund(pool, {
                invoice_id: invoiceId,
                scope: 'order',
                amount_refunded: 40.00,
                subtotal_refunded: 40.00,
                tax_refunded: 0.00,
                refund_method: 'cash',
                shift_id: shiftId,
                user_id: SEED.adminUser.id,
            });

            const res = await request(app)
                .get(`/api/auth/shifts?action=zreport&shift_id=${shiftId}`)
                .set('Cookie', cashierCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            // gross_sales = 100 - 40 = 60 (net of refund)
            expect(Number(res.body.data.gross_sales)).toBe(60);
            // expected_cash = 50 (starting) + 60 (net cash sales) = 110
            expect(Number(res.body.data.expected_cash)).toBe(110);
        });

        it('zreport uses shift-scoped refunds and line plus order discounts', async () => {
            const shiftId = await openCashierShift(50.00);

            const invoiceId = await insertPaidOrder(pool, {
                shift_id: shiftId,
                subtotal: 8.00,
                tax: 0.00,
                total: 7.00,
                discount_type: 'fixed',
                discount_value: 1.00,
                payment_method: 'cash',
                cash_amount: 7.00,
            });
            await insertOrderItem(pool, {
                invoice_id: invoiceId,
                product_id: SEED.product1.id,
                quantity: 1.000,
                price_at_sale: 10.000000,
                tax_rate: 0.00,
                tax_amount: 0.000000,
                discount_type: 'fixed',
                discount_value: 2.00,
            });
            await insertOrderRefund(pool, {
                invoice_id: invoiceId,
                shift_id: shiftId,
                subtotal_refunded: 2.00,
                amount_refunded: 2.00,
                refund_method: 'cash',
            });

            const res = await request(app)
                .get(`/api/auth/shifts?action=zreport&shift_id=${shiftId}`)
                .set('Cookie', cashierCookie);

            expect(res.statusCode).toBe(200);
            expectMoney(res.body.data.gross_sales, 5.00);
            expectMoney(res.body.data.cash_sales, 5.00);
            expectMoney(res.body.data.total_discounts, 3.00);
            expectMoney(res.body.data.expected_cash, 55.00);
        });
    });

    describe('Cross-Shift Refund Scoping', () => {
        it('should scope refund netting to the shift the refund was ISSUED in, not the original sale shift', async () => {
            // Shift A: starting_cash=50, one cash order total=100. No refunds in A.
            const shiftARes = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
            expect(shiftARes.statusCode).toBe(200);
            const shiftAId = shiftARes.body.shift_id;

            const invoiceAId = await insertPaidOrder(pool, {
                order_id: 1,
                shift_id: shiftAId,
                subtotal: 100.00,
                tax: 0.00,
                total: 100.00,
                payment_method: 'cash',
                cash_amount: 100.00,
                card_amount: 0.00,
            });

            // Close shift A (no refunds)
            const closeARes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 150.00, shift_id: shiftAId });
            expect(closeARes.statusCode).toBe(200);
            // A: expected_cash = 50 + 100 = 150
            expect(Number(closeARes.body.expected_cash)).toBe(150);

            // Re-login cashier (session was invalidated on close)
            const reLoginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            cashierCookie = reLoginRes.headers['set-cookie'][0];

            // Shift B: starting_cash=50, one cash order total=100, plus a cash refund of 40 issued in B
            // (the refund references A's invoice — cross-shift scenario)
            const shiftBRes = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
            expect(shiftBRes.statusCode).toBe(200);
            const shiftBId = shiftBRes.body.shift_id;

            await insertPaidOrder(pool, {
                order_id: 2,
                shift_id: shiftBId,
                subtotal: 100.00,
                tax: 0.00,
                total: 100.00,
                payment_method: 'cash',
                cash_amount: 100.00,
                card_amount: 0.00,
            });

            // Cash refund of 40, issued in shift B, against A's invoice (cross-shift)
            await insertOrderRefund(pool, {
                invoice_id: invoiceAId,
                scope: 'order',
                amount_refunded: 40.00,
                subtotal_refunded: 40.00,
                tax_refunded: 0.00,
                refund_method: 'cash',
                shift_id: shiftBId,
                user_id: SEED.adminUser.id,
            });

            // Check shift A via zreport — should be UNTOUCHED by B's refund
            const zReportA = await request(app)
                .get(`/api/auth/shifts?action=zreport&shift_id=${shiftAId}`)
                .set('Cookie', cashierCookie);
            expect(zReportA.statusCode).toBe(200);
            // A gross_sales = 100 (no refunds in A)
            expect(Number(zReportA.body.data.gross_sales)).toBe(100);
            // A expected_cash = 50 + 100 = 150
            expect(Number(zReportA.body.data.expected_cash)).toBe(150);

            // Close shift B and check — refund of 40 must reduce B's drawer
            const closeBRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 110.00, shift_id: shiftBId });
            expect(closeBRes.statusCode).toBe(200);
            // B: expected_cash = 50 + 100 - 40 = 110
            expect(Number(closeBRes.body.expected_cash)).toBe(110);

            // Re-login again after B close
            const reLogin2Res = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            cashierCookie = reLogin2Res.headers['set-cookie'][0];

            // Check shift B via zreport — gross_sales = 100 - 40 = 60
            const zReportB = await request(app)
                .get(`/api/auth/shifts?action=zreport&shift_id=${shiftBId}`)
                .set('Cookie', cashierCookie);
            expect(zReportB.statusCode).toBe(200);
            expect(Number(zReportB.body.data.gross_sales)).toBe(60);
            expect(Number(zReportB.body.data.expected_cash)).toBe(110);
        });
    });

    describe('Shift Cache Eviction and Token Invalidation', () => {
        it('should evict token cache, clear session cookie, and reject subsequent requests after shift close', async () => {
            const shiftId = await openCashierShift(50.00);

            // Verify active session is valid
            const meResBefore = await request(app)
                .get('/api/auth/me')
                .set('Cookie', cashierCookie);
            expect(meResBefore.statusCode).toBe(200);
            expect(meResBefore.body.success).toBe(true);

            // Close the shift (this cashier closes their own shift)
            const closeRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 50.00, shift_id: shiftId });

            expect(closeRes.statusCode).toBe(200);
            expect(closeRes.body.success).toBe(true);

            // Assert Set-Cookie header clears the session token
            const setCookie = closeRes.headers['set-cookie'];
            expect(setCookie).toBeDefined();
            expect(setCookie.some(c => c.includes('pos_token=') && c.includes('Max-Age=0'))).toBe(true);

            // Subsequent requests with the old cookie must be rejected
            const meResAfter = await request(app)
                .get('/api/auth/me')
                .set('Cookie', cashierCookie);

            expect(meResAfter.statusCode).toBe(401);
            expect(meResAfter.body.success).toBe(false);
            expect(meResAfter.body.message).toContain('Invalid or expired session');
        });
    });

    describe('Shift Money Validation Guards (Task 11)', () => {
        it('should reject opening a shift with negative cash float', async () => {
            const res = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: -10.00 });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('cannot be negative');
        });

        it('should reject opening a shift with cash exceeding maximum limit', async () => {
            const res = await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cashierCookie)
                .send({ user_id: SEED.cashierUser.id, starting_cash: 999999999.00 });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('exceeds the maximum allowed');
        });

        it('should reject updating starting cash with invalid value', async () => {
            const shiftId = await openCashierShift(50.00);
            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ starting_cash: 'invalid', shift_id: shiftId });

            expect(res.statusCode).toBe(403);
            expect(res.body.success).toBe(false);
        });

        it('returns 400 when an admin submits an invalid cash amount', async () => {
            const shiftId = await openCashierShift(50.00);
            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ starting_cash: 'invalid', shift_id: shiftId });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('should reject closing a shift with invalid actual cash value', async () => {
            const shiftId = await openCashierShift(50.00);
            const res = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: -5.00, shift_id: shiftId });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('cannot be negative');
        });

        it('closed-shift variance uses the frozen expected_cash, not a live recompute', async () => {
            const shiftId = await openCashierShift(50.00);

            const payload = {
                cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                shift_id: shiftId,
                subtotal: 2.00,
                tax: 0.00,
                total: 2.00,
                payment_method: 'cash',
                amount_tendered: 2.00,
                change_due: 0.00
            };
            const checkRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(payload);
            expect(checkRes.statusCode).toBe(200);

            const total = 2.00;
            const expectedCash = 50.00 + total;
            const actualCash = 60.00;

            const closeRes = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: actualCash, shift_id: shiftId });
            expect(closeRes.statusCode).toBe(200);

            await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, amount_tendered, cash_amount, change_due)
                 VALUES (?, ?, 10.00, 0.00, 10.00, 'cash', 10.00, 10.00, 0.00)`,
                [SEED.cashierUser.id, shiftId]
            );

            const res = await request(app)
                .get('/api/admin/shifts')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);

            const shift = res.body.shifts.find(s => s.id === shiftId);
            expect(shift).toBeDefined();

            const expectedVariance = actualCash - expectedCash;
            expect(Number(shift.variance)).toBeCloseTo(expectedVariance, 2);
        });
    });

    describe('Admin Shifts Date Filter (Task 1)', () => {
        async function insertShiftAt(openedAt, status = 'closed') {
            return insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 10.00,
                opened_at: openedAt,
                status,
            });
        }

        it('filters to a single business date when only start_date is given', async () => {
            const shiftA = await insertShiftAt('2026-07-01 08:00:00'); // business date 2026-07-01
            const shiftB = await insertShiftAt('2026-07-02 08:00:00'); // business date 2026-07-02

            const res = await request(app)
                .get('/api/admin/shifts?start_date=2026-07-01')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            const ids = res.body.shifts.map(s => s.id);
            expect(ids).toContain(shiftA);
            expect(ids).not.toContain(shiftB);
        });

        it('filters to a range when start_date and end_date are both given', async () => {
            const shiftA = await insertShiftAt('2026-07-01 08:00:00');
            const shiftB = await insertShiftAt('2026-07-02 08:00:00');
            const shiftC = await insertShiftAt('2026-07-05 08:00:00');

            const res = await request(app)
                .get('/api/admin/shifts?start_date=2026-07-01&end_date=2026-07-02')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            const ids = res.body.shifts.map(s => s.id);
            expect(ids).toContain(shiftA);
            expect(ids).toContain(shiftB);
            expect(ids).not.toContain(shiftC);
        });

        it('a shift just before the 06:00 business-day boundary is excluded from the next day', async () => {
            // opened_at is stored in UTC; the 06:00 local (+03:00) boundary is 03:00 UTC.
            // 2026-07-02 02:59:00 UTC is still business date 2026-07-01.
            const shiftBoundary = await insertShiftAt('2026-07-02 02:59:00');

            const res = await request(app)
                .get('/api/admin/shifts?start_date=2026-07-02')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            const ids = res.body.shifts.map(s => s.id);
            expect(ids).not.toContain(shiftBoundary);
        });

        it('returns unfiltered results when no date params are given (back-compat)', async () => {
            const shiftA = await insertShiftAt('2020-01-01 08:00:00');

            const res = await request(app)
                .get('/api/admin/shifts?limit=200')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            const ids = res.body.shifts.map(s => s.id);
            expect(ids).toContain(shiftA);
        });

        it('GET ?search filters by cashier name across pages', async () => {
            await insertShiftAt('2026-07-01 08:00:00'); // seeded cashier
            const res = await request(app)
                .get(`/api/admin/shifts?search=${encodeURIComponent(SEED.cashierUser.name)}`)
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.shifts.length).toBeGreaterThan(0);
            expect(res.body.shifts.every(s => s.cashier_name === SEED.cashierUser.name)).toBe(true);
        });
    });

    describe('Method guard', () => {
        it('returns 405 for unsupported methods instead of hanging', async () => {
            const res = await request(app)
                .delete('/api/admin/shifts')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(405);
            expect(res.body.success).toBe(false);
        });
    });

    describe('Input validation', () => {
        it('POST without user_id returns 400 not 500', async () => {
            const res = await request(app)
                .post('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ starting_cash: 50 });
            expect(res.statusCode).toBe(400);
        });
        it('PUT without id returns 400 not 500', async () => {
            const res = await request(app)
                .put('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ actual_cash: 50 });
            expect(res.statusCode).toBe(400);
        });
    });

    describe('update_cash hardening + audit (auth.js)', () => {
        it('returns 400 (not 500) when shift_id is missing', async () => {
            const cashierRes = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ starting_cash: 50 });
            expect(cashierRes.statusCode).toBe(403);

            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ starting_cash: 50 });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('returns 400 (not a false success) when the shift is already closed', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20.00,
                status: 'closed',
                opened_at: '2026-07-01 08:00:00',
                closed_at: '2026-07-01 20:00:00',
            });
            const cashierRes = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(cashierRes.statusCode).toBe(403);

            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('on success writes a shift_cash_edited audit row in the same transaction', async () => {
            const shiftId = await openCashierShift(50.00);
            const cashierRes = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(cashierRes.statusCode).toBe(403);

            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const [audits] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'shift_cash_edited' AND entity_type = 'shift' AND entity_id = ?",
                [shiftId]
            );
            expect(audits).toHaveLength(1);
            expect(audits[0].user_id).toBe(SEED.adminUser.id);
            expect(JSON.parse(audits[0].new_value).starting_cash).toBe(75);

            const [rows] = await pool.query("SELECT starting_cash FROM shifts WHERE id = ?", [shiftId]);
            expect(Number(rows[0].starting_cash)).toBe(75.00);
        });

        it('keeps the starting cash unchanged when the shift_cash_edited audit fails', async () => {
            const shiftId = await openCashierShift(50.00);
            failNextConnectionQuery(isAuditInsert('shift_cash_edited'), 'simulated audit failure');

            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });

            expect(res.statusCode).toBe(500);
            const [[shift]] = await pool.query("SELECT starting_cash FROM shifts WHERE id = ?", [shiftId]);
            expectMoney(shift.starting_cash, 50.00);
        });

        it('allows an admin to correct starting cash after sales while the cashier remains blocked', async () => {
            const shiftId = await openCashierShift(50.00);
            await insertPaidOrder(pool, { shift_id: shiftId, total: 10, cash_amount: 10 });

            const cashierAttempt = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(cashierAttempt.statusCode).toBe(403);

            const adminAttempt = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(adminAttempt.statusCode).toBe(200);

            const [[shift]] = await pool.query('SELECT starting_cash FROM shifts WHERE id=?', [shiftId]);
            expect(Number(shift.starting_cash)).toBe(75);
            const [[audit]] = await pool.query(
                "SELECT user_id, old_value, new_value FROM audit_events WHERE event_type='shift_cash_edited' AND entity_id=?",
                [shiftId]
            );
            expect(audit.user_id).toBe(SEED.adminUser.id);
            expect(JSON.parse(audit.old_value).starting_cash).toBe(50);
            expect(JSON.parse(audit.new_value).starting_cash).toBe(75);
        });

        it('closed starting_cash +20 moves expected_cash +20 and leaves orders untouched', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 80.00,
                expected_cash: 130.00,
                actual_cash: 150.00,
                status: 'closed',
                opened_at: '2026-07-01 08:00:00',
                closed_at: '2026-07-01 20:00:00',
            });
            await insertPaidOrder(pool, { shift_id: shiftId, total: 50, cash_amount: 50 });
            const [[beforeOrders]] = await pool.query(
                'SELECT COUNT(*) AS n FROM orders WHERE shift_id = ?',
                [shiftId]
            );

            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, starting_cash: 100 });
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query(
                'SELECT starting_cash, expected_cash, actual_cash FROM shifts WHERE id = ?',
                [shiftId]
            );
            expect(Number(row.starting_cash)).toBe(100);
            expect(Number(row.expected_cash)).toBe(150);
            expect(Number(row.actual_cash)).toBe(150);

            const [[afterOrders]] = await pool.query(
                'SELECT COUNT(*) AS n FROM orders WHERE shift_id = ?',
                [shiftId]
            );
            expect(Number(afterOrders.n)).toBe(Number(beforeOrders.n));

            const list = await request(app)
                .get('/api/admin/shifts?start_date=2026-07-01&limit=200')
                .set('Cookie', adminCookie);
            expect(list.statusCode).toBe(200);
            const listed = list.body.shifts.find(s => s.id === shiftId);
            expect(listed).toBeDefined();
            expect(Number(listed.variance)).toBe(0);

            const payload = await request(app)
                .get(`/api/admin/shift-reports/${shiftId}/print-payload?type=z_report`)
                .set('Cookie', adminCookie);
            expect(payload.statusCode).toBe(200);
            expect(Number(payload.body.print_payload.starting_cash)).toBe(100);
            expect(Number(payload.body.print_payload.expected_cash)).toBe(150);
            expect(Number(payload.body.print_payload.actual_cash)).toBe(150);
        });

        it('closed actual_cash only leaves expected_cash unchanged', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 80.00,
                expected_cash: 130.00,
                actual_cash: 150.00,
                status: 'closed',
                opened_at: '2026-07-01 08:00:00',
                closed_at: '2026-07-01 20:00:00',
            });

            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, actual_cash: 140 });
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query(
                'SELECT starting_cash, expected_cash, actual_cash FROM shifts WHERE id = ?',
                [shiftId]
            );
            expect(Number(row.starting_cash)).toBe(80);
            expect(Number(row.expected_cash)).toBe(130);
            expect(Number(row.actual_cash)).toBe(140);
        });

        it.each([
            ['admin', 0, 0],
            ['admin', 130, 130],
            ['programmer', 0, 130],
            ['programmer', 123.45, 123.45],
        ])('%s can correct ending cash to %s against expected %s with audited reports', async (role, amount, expected) => {
            let cookie = adminCookie;
            let actorId = SEED.adminUser.id;
            if (role === 'programmer') {
                const [user] = await pool.query("INSERT INTO users (name, user_number, role, is_active) VALUES ('Correction Programmer', '9087', 'programmer', 1)");
                actorId = user.insertId;
                const login = await request(app).post('/api/auth/login').send({ user_number: '9087' });
                expect(login.statusCode).toBe(200);
                cookie = login.headers['set-cookie'][0];
            }
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id, starting_cash: 50, expected_cash: expected, actual_cash: 999,
                status: 'closed', opened_at: '2026-07-01 08:00:00', closed_at: '2026-07-01 20:00:00',
            });
            await insertPaidOrder(pool, { shift_id: shiftId, total: 25, cash_amount: 25 });
            const [ordersBefore] = await pool.query('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
            const forbidden = await request(app).put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie).send({ shift_id: shiftId, actual_cash: amount });
            expect(forbidden.statusCode).toBe(403);
            const res = await request(app).put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cookie).send({ shift_id: shiftId, actual_cash: amount });
            expect(res.statusCode).toBe(200);
            const [[row]] = await pool.query('SELECT starting_cash, expected_cash, actual_cash, status, closed_at FROM shifts WHERE id = ?', [shiftId]);
            expect(Number(row.starting_cash)).toBe(50);
            expect(Number(row.expected_cash)).toBe(expected);
            expect(Number(row.actual_cash)).toBe(amount);
            expect(row.status).toBe('closed');
            expect(row.closed_at).toBeTruthy();
            const [ordersAfter] = await pool.query('SELECT * FROM orders WHERE shift_id = ?', [shiftId]);
            expect(ordersAfter).toEqual(ordersBefore);
            const [[audit]] = await pool.query("SELECT user_id, old_value, new_value FROM audit_events WHERE event_type='shift_cash_edited' AND entity_id=?", [shiftId]);
            expect(audit.user_id).toBe(actorId);
            expect(JSON.parse(audit.old_value)).toEqual({ actual_cash: 999 });
            expect(JSON.parse(audit.new_value)).toEqual({ actual_cash: amount });
            const list = await request(app).get('/api/admin/shifts?start_date=2026-07-01&limit=200').set('Cookie', cookie);
            expect(list.statusCode).toBe(200);
            const listed = list.body.shifts.find(shift => shift.id === shiftId);
            expect(Number(listed.actual_cash)).toBe(amount);
            expect(Number(listed.variance)).toBeCloseTo(amount - expected, 2);
            const payload = await request(app).get(`/api/admin/shift-reports/${shiftId}/print-payload?type=z_report`).set('Cookie', cookie);
            expect(payload.statusCode).toBe(200);
            expect(Number(payload.body.print_payload.actual_cash)).toBe(amount);
            expect(Number(payload.body.print_payload.expected_cash)).toBe(expected);
            expect(Number(payload.body.print_payload.variance)).toBeCloseTo(amount - expected, 2);
        });

        it('open shift rejects actual_cash with 400', async () => {
            const shiftId = await openCashierShift(50.00);
            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, actual_cash: 10 });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Actual cash can only be corrected on a closed shift.');
        });

        it('audit row carries every mutated field and emits shifts_changed', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 80.00,
                expected_cash: 130.00,
                actual_cash: 150.00,
                status: 'closed',
                opened_at: '2026-07-01 08:00:00',
                closed_at: '2026-07-01 20:00:00',
            });
            global.__mockTo__.mockClear();
            global.__mockEmit__.mockClear();

            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, starting_cash: 100, actual_cash: 140 });
            expect(res.statusCode).toBe(200);

            const [[audit]] = await pool.query(
                "SELECT old_value, new_value FROM audit_events WHERE event_type = 'shift_cash_edited' AND entity_id = ?",
                [shiftId]
            );
            expect(JSON.parse(audit.old_value)).toEqual({
                starting_cash: 80,
                expected_cash: 130,
                actual_cash: 150,
            });
            expect(JSON.parse(audit.new_value)).toEqual({
                starting_cash: 100,
                expected_cash: 150,
                actual_cash: 140,
            });

            expect(global.__mockTo__).toHaveBeenCalledWith('staff');
            expect(global.__mockEmit__).toHaveBeenCalledWith(
                'shifts_changed',
                expect.objectContaining({ shift_id: shiftId })
            );
        });

        it('rounds 10.999 to 11.00', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 50.00,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });
            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: shiftId, starting_cash: 10.999 });
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query('SELECT starting_cash FROM shifts WHERE id = ?', [shiftId]);
            expect(Number(row.starting_cash)).toBe(11);
        });
    });

    describe('force-close audit (admin/shifts.js)', () => {
        it('writes a shift_force_closed audit row on successful force-close', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20.00,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });

            const res = await request(app)
                .put('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 20.00 });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const [audits] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'shift_force_closed' AND entity_type = 'shift' AND entity_id = ?",
                [shiftId]
            );
            expect(audits).toHaveLength(1);
            expect(audits[0].user_id).toBe(SEED.adminUser.id);
            expect(JSON.parse(audits[0].old_value).cashier_user_id).toBe(SEED.cashierUser.id);
        });

        it('leaves the shift open when the shift_force_closed audit fails', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20.00,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });
            failNextConnectionQuery(isAuditInsert('shift_force_closed'), 'simulated audit failure');

            const res = await request(app)
                .put('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 18.00 });

            expect(res.statusCode).toBe(500);
            const [[shift]] = await pool.query("SELECT status, actual_cash FROM shifts WHERE id = ?", [shiftId]);
            expect(shift.status).toBe('open');
            expect(shift.actual_cash).toBeNull();
            const [audits] = await pool.query(
                "SELECT id FROM audit_events WHERE event_type = 'shift_force_closed' AND entity_id = ?",
                [shiftId]
            );
            expect(audits).toHaveLength(0);
        });
    });

    describe('force-close expected cash (admin/shifts.js)', () => {
        it('freezes expected cash net of the shift cash refunds and drawer expenses', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 50.00,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });
            const invoiceId = await insertPaidOrder(pool, {
                shift_id: shiftId,
                subtotal: 100,
                tax: 0,
                total: 100,
                cash_amount: 100,
            });
            await insertOrderRefund(pool, {
                invoice_id: invoiceId,
                shift_id: shiftId,
                subtotal_refunded: 40,
                amount_refunded: 40,
                refund_method: 'cash',
            });
            await insertDrawerExpense(shiftId, 5.00);

            const res = await request(app)
                .put('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 105.00 });

            expect(res.statusCode).toBe(200);
            expectMoney(res.body.expected_cash, 105.00);
            const [[shift]] = await pool.query("SELECT status, expected_cash, actual_cash FROM shifts WHERE id = ?", [shiftId]);
            expect(shift.status).toBe('closed');
            expectMoney(shift.expected_cash, 105.00);
            expectMoney(shift.actual_cash, 105.00);
        });
    });

    describe('force query-param override semantics (admin/shifts.js)', () => {
        async function seedOpenTableShift() {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20.00,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });
            const [ins] = await pool.query(
                `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
                 VALUES (730002, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
                [SEED.cashierUser.id, SEED.cashierUser.id, SEED.table.id, shiftId]
            );
            await pool.query(
                "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?",
                [ins.insertId, SEED.table.id]
            );
            return shiftId;
        }

        it('?force=false still runs the open-table safety check (returns 409)', async () => {
            const shiftId = await seedOpenTableShift();
            const res = await request(app)
                .put('/api/admin/shifts?force=false')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 20.00 });
            expect(res.statusCode).toBe(409);
            expect(res.body.success).toBe(false);
        });

        it('?force=true overrides the open-table check (returns 200)', async () => {
            const shiftId = await seedOpenTableShift();
            const res = await request(app)
                .put('/api/admin/shifts?force=true')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 20.00 });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('auth /shifts validation guards (Task 1)', () => {
        it('GET check without user_id returns 400 (not 500)', async () => {
            const res = await request(app)
                .get('/api/auth/shifts?action=check')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('GET zreport without shift_id returns 400 (not 500)', async () => {
            const res = await request(app)
                .get('/api/auth/shifts?action=zreport')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('PUT close without shift_id returns 400 (not 500)', async () => {
            const res = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 50 });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });

    describe('auth /shifts cashiers action removed (Task 2)', () => {
        it('GET auth /shifts?action=cashiers is gone -> 404, not a shift list', async () => {
            const res = await request(app)
                .get('/api/auth/shifts?action=cashiers')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(404);
            expect(res.body.success).toBe(false);
        });
    });

    describe('admin shifts variance rounding (Task 3)', () => {
        it('returns a variance rounded to 2 decimals (no float residue)', async () => {
            // actual 52.00 vs frozen expected 52.10 -> exactly -0.10, not -0.0999999...
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 10.00,
                expected_cash: 52.10,
                actual_cash: 52.00,
                status: 'closed',
                opened_at: '2026-07-01 08:00:00',
                closed_at: '2026-07-01 20:00:00',
            });
            const res = await request(app)
                .get('/api/admin/shifts?limit=200')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            const row = res.body.shifts.find(s => s.id === shiftId);
            expect(row).toBeDefined();
            expect(row.variance).toBe(-0.1);
        });
    });

    describe('admin shift variance hints', () => {
        async function listShift(id, query = 'limit=200') {
            const res = await request(app)
                .get(`/api/admin/shifts?${query}`)
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            return { res, row: res.body.shifts.find(s => s.id === id) };
        }

        it('flags a mistyped starting cash and suggests the previous close', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 100, 100, 100, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
            `, [SEED.adminUser.id, range.start, range.start]);
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 80, 130, 150, 'closed', DATE_ADD(?, INTERVAL 2 HOUR), DATE_ADD(?, INTERVAL 3 HOUR))
            `, [SEED.cashierUser.id, range.start, range.start]);

            const { row } = await listShift(ins.insertId);
            expect(row.variance_hint.kind).toBe('starting_cash_mismatch');
            expect(row.variance_hint.suggested.starting_cash).toBe(100);
            expect(row.drawer_change_since_previous_close).toBe(-20);
        });

        it('flags a count that omitted the opening cash', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 500, 900, 400, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
            `, [SEED.cashierUser.id, range.start, range.start]);

            const { row } = await listShift(ins.insertId);
            expect(row.variance_hint.kind).toBe('count_excluded_opening');
            expect(row.variance_hint.suggested.actual_cash).toBe(900);
        });

        it('derives decimals from cents, not float or string arithmetic', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 100.10, 100.10, 100.10, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
            `, [SEED.adminUser.id, range.start, range.start]);
            const [mismatch] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 100.00, 350.00, 350.10, 'closed', DATE_ADD(?, INTERVAL 2 HOUR), DATE_ADD(?, INTERVAL 3 HOUR))
            `, [SEED.cashierUser.id, range.start, range.start]);
            const [omitted] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 100.10, 250.30, 150.20, 'closed', DATE_ADD(?, INTERVAL 4 HOUR), DATE_ADD(?, INTERVAL 5 HOUR))
            `, [SEED.waiterUser.id, range.start, range.start]);

            const { row: mismatchRow } = await listShift(mismatch.insertId);
            expect(mismatchRow.variance_hint.kind).toBe('starting_cash_mismatch');
            expect(mismatchRow.variance_hint.suggested.starting_cash).toBe(100.1);
            expect(mismatchRow.drawer_change_since_previous_close).toBe(-0.1);

            const { row: omittedRow } = await listShift(omitted.insertId);
            expect(omittedRow.variance_hint.kind).toBe('count_excluded_opening');
            expect(omittedRow.variance_hint.suggested.actual_cash).toBe(250.3);
        });

        it.each([
            [500, 900, 880],
            [500, 900, 900],
            [0, 400, 380],
            [100, 150, 0],
        ])('stays silent when no fingerprint matches (%s/%s/%s)', async (starting, expected, actual) => {
            const range = getBusinessDayRange(getBusinessDate());
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, ?, ?, ?, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
            `, [SEED.cashierUser.id, starting, expected, actual, range.start, range.start]);

            const { row } = await listShift(ins.insertId);
            expect(row.variance_hint).toBeNull();
        });

        it('omits prev-based fields when another shift overlapped the open', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 50, 50, 100, 'closed', ?, DATE_ADD(?, INTERVAL 2 HOUR))
            `, [SEED.adminUser.id, range.start, range.start]);
            await pool.query(`
                INSERT INTO shifts (user_id, starting_cash, status, opened_at)
                VALUES (?, 100, 'open', DATE_ADD(?, INTERVAL 1 HOUR))
            `, [SEED.waiterUser.id, range.start]);
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 80, 130, 150, 'closed', DATE_ADD(?, INTERVAL 121 MINUTE), DATE_ADD(?, INTERVAL 3 HOUR))
            `, [SEED.cashierUser.id, range.start, range.start]);

            const { row } = await listShift(ins.insertId);
            expect(row.drawer_change_since_previous_close).toBeNull();
            expect(row.variance_hint?.kind).not.toBe('starting_cash_mismatch');
        });

        it('finds the previous close outside the current page and date filter', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            const [prev] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 100, 100, 100, 'closed', DATE_SUB(?, INTERVAL 2 HOUR), DATE_SUB(?, INTERVAL 1 HOUR))
            `, [SEED.adminUser.id, range.start, range.start]);
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 80, 130, 150, 'closed', DATE_ADD(?, INTERVAL 1 HOUR), DATE_ADD(?, INTERVAL 2 HOUR))
            `, [SEED.cashierUser.id, range.start, range.start]);

            const { res, row } = await listShift(ins.insertId, `start_date=${getBusinessDate()}&limit=200`);
            expect(res.body.shifts.find(s => s.id === prev.insertId)).toBeUndefined();
            expect(row.drawer_change_since_previous_close).toBe(-20);
        });

        it('does not select the same shift as its own predecessor', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 80, 130, 150, 'closed', ?, ?)
            `, [SEED.cashierUser.id, range.start, range.start]);

            const { row } = await listShift(ins.insertId);
            expect(row.drawer_change_since_previous_close).toBeNull();
            expect(row.variance_hint?.kind).not.toBe('starting_cash_mismatch');
        });

        it('applies a suggestion through update_cash and the hint disappears', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 100, 100, 100, 'closed', ?, DATE_ADD(?, INTERVAL 1 HOUR))
            `, [SEED.adminUser.id, range.start, range.start]);
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 80, 130, 150, 'closed', DATE_ADD(?, INTERVAL 2 HOUR), DATE_ADD(?, INTERVAL 3 HOUR))
            `, [SEED.cashierUser.id, range.start, range.start]);

            const put = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: ins.insertId, starting_cash: 100 });
            expect(put.statusCode).toBe(200);

            const { row } = await listShift(ins.insertId);
            expect(row.variance_hint).toBeNull();
            expect(row.variance).toBe(0);
        });

        it('night cashier who counted only their sales: hint suggests the full drawer and applying it clears the shortage', async () => {
            // Morning: start 100, sells 400 cash, closes at 500. Night: prefilled 500, sells 400,
            // counts only the 400 they added. Expected 900, counted 400 -> variance -500 == -starting.
            const range = getBusinessDayRange(getBusinessDate());
            await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 100, 500, 500, 'closed', ?, DATE_ADD(?, INTERVAL 8 HOUR))
            `, [SEED.adminUser.id, range.start, range.start]);
            const [ins] = await pool.query(`
                INSERT INTO shifts
                  (user_id, starting_cash, expected_cash, actual_cash, status, opened_at, closed_at)
                VALUES (?, 500, 900, 400, 'closed', DATE_ADD(?, INTERVAL 9 HOUR), DATE_ADD(?, INTERVAL 16 HOUR))
            `, [SEED.cashierUser.id, range.start, range.start]);

            const before = await listShift(ins.insertId);
            expect(before.row.variance).toBe(-500);
            expect(before.row.drawer_change_since_previous_close).toBe(0);
            expect(before.row.variance_hint).toEqual({ kind: 'count_excluded_opening', suggested: { actual_cash: 900 } });

            const put = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', adminCookie)
                .send({ shift_id: ins.insertId, actual_cash: before.row.variance_hint.suggested.actual_cash });
            expect(put.statusCode).toBe(200);

            const after = await listShift(ins.insertId);
            expect(after.row.variance).toBe(0);
            expect(after.row.variance_hint).toBeNull();
            const [[db]] = await pool.query('SELECT expected_cash, actual_cash FROM shifts WHERE id = ?', [ins.insertId]);
            expect(Number(db.expected_cash)).toBe(900);
            expect(Number(db.actual_cash)).toBe(900);
        });

        it('open shift leaves both hint fields null', async () => {
            const range = getBusinessDayRange(getBusinessDate());
            const [ins] = await pool.query(`
                INSERT INTO shifts (user_id, starting_cash, status, opened_at)
                VALUES (?, 50, 'open', DATE_ADD(?, INTERVAL 1 HOUR))
            `, [SEED.cashierUser.id, range.start]);

            const { row } = await listShift(ins.insertId);
            expect(row.variance_hint).toBeNull();
            expect(row.drawer_change_since_previous_close).toBeNull();
        });
    });

    describe('admin shift drawer explanation', () => {
        it('collects server-priced tax in cash exactly once and excludes change from the drawer', async () => {
            await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='tax_inclusive_pricing'");
            const shiftId = await openCashierShift(20);

            const exclusive = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    shift_id: shiftId,
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8,
                    payment_method: 'cash',
                    amount_tendered: 10,
                    change_due: 4.2,
                    idempotency_key: 'shift-tax-exclusive-cash',
                });
            expect(exclusive.statusCode).toBe(200);
            expect(exclusive.body).toMatchObject({ total: 5.8, tax: 0.8, cash_amount: 5.8, change_due: 4.2 });

            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
            const inclusiveDisplay = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    shift_id: shiftId,
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8,
                    payment_method: 'cash',
                    amount_tendered: 10,
                    change_due: 4.2,
                    idempotency_key: 'shift-tax-inclusive-display-cash',
                });
            expect(inclusiveDisplay.statusCode).toBe(200);
            expect(inclusiveDisplay.body).toMatchObject({ total: 5.8, tax: 0.8, cash_amount: 5.8, change_due: 4.2 });

            const response = await request(app)
                .get(`/api/admin/shift-reports/${shiftId}/print-payload?type=x_report`)
                .set('Cookie', adminCookie);
            expect(response.statusCode).toBe(200);
            expectMoney(response.body.print_payload.gross_cash_sales, 11.6);
            expectMoney(response.body.print_payload.gross_sales, 11.6);
            expectMoney(response.body.print_payload.expected_cash, 31.6);
        });

        it('allocates a tax-bearing split refund back to the original cash and card tenders', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });
            const invoiceId = await insertPaidOrder(pool, {
                shift_id: shiftId,
                subtotal: 100,
                tax: 16,
                total: 116,
                payment_method: 'split',
                cash_amount: 69.60,
                card_amount: 46.40,
            });
            await insertOrderRefund(pool, {
                invoice_id: invoiceId,
                shift_id: shiftId,
                subtotal_refunded: 10.01,
                tax_refunded: 1.60,
                amount_refunded: 11.61,
                refund_method: 'split',
            });

            const response = await request(app)
                .get(`/api/admin/shift-reports/${shiftId}/print-payload?type=x_report`)
                .set('Cookie', adminCookie);
            expect(response.statusCode).toBe(200);
            const shift = response.body.print_payload;
            expectMoney(shift.cash_refunds, 6.97);
            expectMoney(shift.cash_sales, 62.63);
            expectMoney(shift.card_sales, 41.76);
            expectMoney(shift.gross_sales, 104.39);
            expectMoney(shift.net_sales_pre_tax, 89.99);
            expectMoney(shift.tax_collected, 14.40);
            expectMoney(shift.expected_cash, 82.63);
        });

        it('the canonical shift detail explains the expense deduction behind expected cash', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 217.60,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });
            const invoiceId = await insertPaidOrder(pool, {
                shift_id: shiftId,
                subtotal: 179,
                tax: 0,
                total: 179,
                cash_amount: 179,
            });
            await insertOrderRefund(pool, {
                invoice_id: invoiceId,
                shift_id: shiftId,
                subtotal_refunded: 4,
                amount_refunded: 4,
                refund_method: 'cash',
            });
            const categoryId = await insertDrawerExpense(shiftId, 4.60);

            const response = await request(app)
                .get(`/api/admin/shift-reports/${shiftId}/print-payload?type=x_report`)
                .set('Cookie', adminCookie);
            expect(response.statusCode).toBe(200);
            const shift = response.body.print_payload;
            expectMoney(shift.starting_cash, 217.60);
            expectMoney(shift.gross_cash_sales, 179);
            expectMoney(shift.cash_refunds, 4);
            expectMoney(shift.cash_sales, 175);
            expectMoney(shift.cash_expenses, 4.60);
            expectMoney(shift.expected_cash, 388);
            expect(shift.expense_categories).toEqual([{
                category_id: categoryId,
                category_name: 'Supplies',
                count: 1,
                total: 4.6,
            }]);
        });
    });

    describe('Z report on close', () => {
        const receiptPrinter = () => pool.query("INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Receipt', 'receipt', 'windows', 'Test Receipt', 1)");

        it('refuses a Z print sent after the close, because the close revoked the session', async () => {
            await receiptPrinter();
            const shiftId = await openCashierShift(50.00);
            const close = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cashierCookie)
                .send({ actual_cash: 50, shift_id: shiftId });
            expect(close.statusCode).toBe(200);
            const late = await request(app).post('/api/print/print').set('Cookie', cashierCookie)
                .send({ print_type: 'z_report', shift_id: shiftId });
            expect(late.statusCode).toBe(401);
        });

        it('queues the Z report inside the close request from the committed shift, without store secrets', async () => {
            const [[printer]] = await receiptPrinter().then(([result]) => [[{ id: result.insertId }]]);
            await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('jofotara_secret_key', 'must-not-print') ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)");
            const shiftId = await openCashierShift(50.00);
            const close = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cashierCookie)
                .send({ actual_cash: 48.5, shift_id: shiftId, print_z_report: true, receipt_printer_id: printer.id });
            expect(close.statusCode).toBe(200);
            expect(close.body.z_report_print_queued).toBe(true);
            const [jobs] = await pool.query("SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1");
            const payload = JSON.parse(jobs[0].payload);
            expect(payload.print_type).toBe('z_report');
            expect(payload.printer_id).toBe(printer.id);
            expect(Number(payload.data.shift_id ?? payload.data.id)).toBe(shiftId);
            expect(Number(payload.data.actual_cash)).toBe(48.5);
            expect(JSON.stringify(payload)).not.toContain('must-not-print');
        });

        it('reports an unqueued Z report without failing the committed close', async () => {
            const shiftId = await openCashierShift(50.00);
            const close = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cashierCookie)
                .send({ actual_cash: 50, shift_id: shiftId, print_z_report: true });
            expect(close.statusCode).toBe(200);
            expect(close.body.z_report_print_queued).toBe(false);
            const [[shift]] = await pool.query("SELECT status FROM shifts WHERE id = ?", [shiftId]);
            expect(shift.status).toBe('closed');
        });

        it('does not print when the close does not ask for it', async () => {
            await receiptPrinter();
            const shiftId = await openCashierShift(50.00);
            const close = await request(app).put('/api/auth/shifts?action=close').set('Cookie', cashierCookie)
                .send({ actual_cash: 50, shift_id: shiftId });
            expect(close.body).not.toHaveProperty('z_report_print_queued');
            const [[{ queued }]] = await pool.query("SELECT COUNT(*) AS queued FROM print_queue WHERE JSON_EXTRACT(payload, '$.print_type') = 'z_report'");
            expect(Number(queued)).toBe(0);
        });
    });
});
