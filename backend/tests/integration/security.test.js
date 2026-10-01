// integration/security.test.js — Integration tests for security hardening, brute force lockouts, and error sanitization
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { insertPaidOrder } = require('../helpers/fixtures');

describe('Security Integration Tests', () => {
    let cashierCookie;
    let cashierShiftId;

    beforeEach(async () => {
        await seedDatabase();

        // Login cashier
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = loginRes.headers['set-cookie'][0];
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
    async function openShift() {
        await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 10.00 });

        const [rows] = await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [SEED.cashierUser.id]);
        cashierShiftId = rows[0].id;
        return cashierShiftId;
    }

    describe('Manager PIN Brute Force Lockout', () => {
        it('should lockout manager PIN override attempts after maximum failures', async () => {
            // Five failed checks are allowed before the fixed five-minute lockout.
            for (let i = 0; i < 5; i++) {
                const res = await request(app)
                    .post('/api/auth/manager_override')
                    .set('Cookie', cashierCookie)
                    .send({ admin_pin: 'incorrect_pin_attempt' });
                
                expect(res.statusCode).toBe(401);
            }

            // The sixth attempt is denied before any PIN verification.
            const resLockout = await request(app)
                .post('/api/auth/manager_override')
                .set('Cookie', cashierCookie)
                .send({ admin_pin: SEED.adminUser.pin }); // even with the correct PIN now!

            expect(resLockout.statusCode).toBe(429);
            expect(resLockout.body.success).toBe(false);
            expect(resLockout.body.message).toContain('Too many failed override attempts');
        });
    });

    describe('Override lockout is keyed by the signed-in user, not the client address', () => {
        async function loginAs(userNumber) {
            const res = await request(app).post('/api/auth/login').send({ user_number: userNumber });
            return res.headers['set-cookie'][0];
        }

        async function openShiftFor(cookie, userId) {
            await request(app)
                .post('/api/auth/shifts?action=open')
                .set('Cookie', cookie)
                .send({ user_id: userId, starting_cash: 10.00 });
            const [[row]] = await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [userId]);
            return row.id;
        }

        function discountedSale(shiftId, extra) {
            return {
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: shiftId,
                subtotal: 5.00,
                tax: 0.64,
                total: 4.64,
                payment_method: 'cash',
                amount_tendered: 5.00,
                change_due: 0.36,
                order_discount_type: 'fixed',
                order_discount_value: 1.00,
                ...extra
            };
        }

        const surfaces = {
            'manager override': {
                lockedMessage: 'Too many failed override attempts',
                async setup(cookie) { return cookie; },
                attempt(cookie, _ctx, pin, ip, key) {
                    return request(app).post('/api/auth/manager_override')
                        .set('Cookie', cookie).set('X-Forwarded-For', ip)
                        .send({ admin_pin: pin });
                }
            },
            'checkout override': {
                lockedMessage: 'Too many failed manager PIN attempts',
                async setup(cookie, userId) { return openShiftFor(cookie, userId); },
                attempt(cookie, shiftId, pin, ip, key) {
                    return request(app).post('/api/pos/checkout')
                        .set('Cookie', cookie).set('X-Forwarded-For', ip)
                        .send(discountedSale(shiftId, { manager_pin: pin, idempotency_key: key }));
                }
            }
        };

        for (const [name, surface] of Object.entries(surfaces)) {
            it(`${name}: one user's failed PINs do not lock another user on the same address`, async () => {
                const otherCookie = await loginAs(SEED.priceOverrideUser.user_number);
                const cashierCtx = await surface.setup(cashierCookie, SEED.cashierUser.id);
                const otherCtx = await surface.setup(otherCookie, SEED.priceOverrideUser.id);

                for (let i = 0; i < 5; i++) {
                    const res = await surface.attempt(cashierCookie, cashierCtx, 'wrong_pin_123', '10.0.0.1', `iso_fail_${i}`);
                    expect(res.statusCode).toBe(401);
                }
                const locked = await surface.attempt(cashierCookie, cashierCtx, SEED.adminUser.pin, '10.0.0.1', 'iso_locked');
                expect(locked.statusCode).toBe(429);
                expect(locked.body.message).toContain(surface.lockedMessage);

                const other = await surface.attempt(otherCookie, otherCtx, SEED.adminUser.pin, '10.0.0.1', 'iso_other_ok');
                expect(other.statusCode).toBe(200);
                expect(other.body.success).toBe(true);
            });

            it(`${name}: rotating X-Forwarded-For addresses does not escape one user's lockout`, async () => {
                const ctx = await surface.setup(cashierCookie, SEED.cashierUser.id);
                for (let i = 0; i < 5; i++) {
                    const res = await surface.attempt(cashierCookie, ctx, 'wrong_pin_123', `203.0.113.${i + 1}`, `xff_fail_${i}`);
                    expect(res.statusCode).toBe(401);
                }
                const locked = await surface.attempt(cashierCookie, ctx, SEED.adminUser.pin, '203.0.113.99', 'xff_locked');
                expect(locked.statusCode).toBe(429);
                expect(locked.body.message).toContain(surface.lockedMessage);
            });
        }
    });

    describe('Error Sanitization (No raw DB info exposure)', () => {
        it('should return a generic 500 message on internal server errors and not leak DB queries', async () => {
            // Let's trigger a GET request to a database endpoint that throws an error.
            // A simple way is to delete a database table required by a route, then query that route.
            // E.g., DROP TABLE restaurant_tables, then hit GET /api/pos/get_tables
            await pool.query("SET FOREIGN_KEY_CHECKS = 0;");
            await pool.query("DROP TABLE IF EXISTS restaurant_tables");
            await pool.query("SET FOREIGN_KEY_CHECKS = 1;");

            // Authenticate as admin so the tables.access gate is bypassed and the DB query executes
            const adminLoginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.adminUser.user_number });
            const adminCookie = adminLoginRes.headers['set-cookie'][0];

            const res = await request(app)
                .get('/api/pos/get_tables')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(500);
            expect(res.body.success).toBe(false);
            // Verify it does NOT contain raw SQL error details
            expect(res.body.message).not.toContain('SELECT');
            expect(res.body.message).not.toContain('restaurant_tables');
            expect(res.body.message).not.toContain('Table doesn\'t exist');
            // Instead, it should contain a generic safe message
            expect(res.body.message).toContain('unexpected server error');
        });
    });

    describe('Cash Payment Validation (amount_tendered < total)', () => {
        it('should reject cash checkouts if amount_tendered is less than total', async () => {
            await openShift();

            const cart = [
                { id: SEED.product1.id, qty: 1, price: SEED.product1.price } // burger 5.00, 16% tax -> 5.80
            ];

            const payload = {
                cart,
                shift_id: cashierShiftId,
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 5.00, // LESS THAN TOTAL (5.80)
                change_due: 0
            };

            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(payload);

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('tendered');
        });
    });

    describe('SQL Injection Sanitization', () => {
        const SQL_PAYLOADS = [
            "'; DROP TABLE orders; --",
            "1' OR '1'='1",
            "admin'--",
            "' UNION SELECT * FROM users --",
            "1; SELECT sleep(5); --"
        ];

        it('stores an injected hash_number as the literal text on the paid order', async () => {
            await openShift();
            await pool.query('UPDATE order_types SET requires_hash = 1 WHERE id = ?', [SEED.orderType.id]);

            for (const [index, payload] of SQL_PAYLOADS.entries()) {
                const res = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                        shift_id: cashierShiftId,
                        order_type_id: SEED.orderType.id,
                        order_type_is_deferred_settlement: false,
                        subtotal: 2.00,
                        tax: 0.00,
                        total: 2.00,
                        payment_method: 'cash',
                        amount_tendered: 2.00,
                        change_due: 0.00,
                        hash_number: payload,
                        idempotency_key: `sql_inject_hash_${index}`
                    });

                expect(res.statusCode).toBe(200);
                const [[order]] = await pool.query('SELECT hash_number FROM orders WHERE invoice_id = ?', [res.body.invoice_id]);
                expect(order.hash_number).toBe(payload);
            }
        });

        it('stores an injected customer name as the literal text on the customer record', async () => {
            await openShift();

            for (const [index, payload] of SQL_PAYLOADS.entries()) {
                const phone = `079000000${index}`;
                const res = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                        shift_id: cashierShiftId,
                        subtotal: 2.00,
                        tax: 0.00,
                        total: 2.00,
                        payment_method: 'cash',
                        amount_tendered: 3.00,
                        change_due: 1.00,
                        customer_phone: phone,
                        customer_name: payload,
                        idempotency_key: `sql_inject_name_${index}`
                    });

                expect(res.statusCode).toBe(200);
                const [[customer]] = await pool.query('SELECT name FROM customers WHERE phone_normalized = ?', [phone]);
                expect(customer.name).toBe(payload);
            }
        });

        it('stores an injected order note as the literal text on the paid order', async () => {
            await openShift();

            for (const [index, payload] of SQL_PAYLOADS.entries()) {
                const res = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                        shift_id: cashierShiftId,
                        subtotal: 2.00,
                        tax: 0.00,
                        total: 2.00,
                        payment_method: 'cash',
                        amount_tendered: 3.00,
                        change_due: 1.00,
                        order_note: payload,
                        idempotency_key: `sql_inject_note_${index}`
                    });

                expect(res.statusCode).toBe(200);
                const [[order]] = await pool.query('SELECT note FROM orders WHERE invoice_id = ?', [res.body.invoice_id]);
                expect(order.note).toBe(payload);
            }
        });

        it('rejects an injected login user_number as an unknown user', async () => {
            for (const payload of SQL_PAYLOADS) {
                const res = await request(app)
                    .post('/api/auth/login')
                    .send({ user_number: payload });

                expect(res.statusCode).toBe(401);
                expect(res.body.success).toBe(false);
            }
        });

        it('matches an injected orders filter as a literal payment method', async () => {
            await insertPaidOrder(pool, { created_at: '2026-05-12 12:00:00', invoice_issued_at: '2026-05-12 12:00:00' });
            const adminLoginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.adminUser.user_number });
            const listOrders = paymentMethods => request(app)
                .get('/api/admin/orders')
                .set('Cookie', adminLoginRes.headers['set-cookie'][0])
                .query({ start_date: '2026-05-12', end_date: '2026-05-12', payment_methods: paymentMethods });

            for (const payload of SQL_PAYLOADS) {
                const res = await listOrders(payload);
                expect(res.statusCode).toBe(200);
                expect(res.body.orders).toEqual([]);
            }
            const control = await listOrders('cash');
            expect(control.body.orders).toHaveLength(1);
        });
    });

    describe('validateManagerPinOverride Lockout & Audit Events', () => {
        it('should lockout manager PIN override attempts during checkout voids and log audit events', async () => {
            await openShift();

            // A register sale with a discount the cashier isn't permitted to apply triggers
            // the manager-PIN override path (same lockout + audit events as before).
            const payload = {
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00,
                tax: 0.64,
                total: 4.64,
                payment_method: 'cash',
                amount_tendered: 5.00,
                change_due: 0.36,
                order_discount_type: 'fixed',
                order_discount_value: 1.00
            };

            // Attempt 5 times with incorrect manager PINs
            for (let i = 0; i < 5; i++) {
                const res = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({ ...payload, manager_pin: 'wrong_pin_123' });
                expect(res.statusCode).toBe(401);
                expect(res.body.message).toContain('Invalid manager override PIN');
            }

            // Verify a 'pin_override_failed' audit event was logged in DB
            const [failedEvents] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'pin_override_failed' ORDER BY id DESC"
            );
            expect(failedEvents.length).toBeGreaterThan(0);

            // The 6th attempt should trigger 429 rate limit / lockout
            const resLockout = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({ ...payload, manager_pin: SEED.adminUser.pin }); // even with correct PIN
            
            expect(resLockout.statusCode).toBe(429);
            expect(resLockout.body.message).toContain('Too many failed manager PIN attempts');

            // Verify a 'pin_override_locked' audit event was logged in DB (allow fire-and-forget query to finish)
            await new Promise(resolve => setTimeout(resolve, 50));
            const [lockedEvents] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'pin_override_locked' ORDER BY id DESC"
            );
            expect(lockedEvents.length).toBeGreaterThan(0);

            // Expiration test: mock Date only so async event loop functions still execute normally
            vi.useFakeTimers({ toFake: ['Date'] });
            
            // Advance system clock by 5 minutes + 1 second
            vi.advanceTimersByTime(5 * 60 * 1000 + 1000);

            // A 7th attempt with the correct PIN should now bypass lockout and succeed
            const resAfterExpiry = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({ ...payload, manager_pin: SEED.adminUser.pin, idempotency_key: 'pin_ok_after_expiry' });
            
            expect(resAfterExpiry.statusCode).toBe(200);
            expect(resAfterExpiry.body.success).toBe(true);

            // Verify a 'pin_override_success' audit event was logged in DB
            const [successEvents] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'pin_override_success' ORDER BY id DESC"
            );
            expect(successEvents.length).toBeGreaterThan(0);

            vi.useRealTimers();

            // Direct assertion on helpers.js overrideAttempts cleanup logic
            const { overrideAttempts } = require('../../services/ManagerOverrideService');
            expect(overrideAttempts.size).toBe(0); // successfully cleared on override success
        });

    });

    describe('Strict Input ID Type Enforcement', () => {
        it('should reject non-numeric/non-integer string IDs in checkout payload with 400', async () => {
            const malformedPayloads = [
                { edit_invoice_id: "not-an-integer" },
                { shift_id: "abc" },
                { table_id: "1.5" },
                { order_type_id: "0" },
                { edit_invoice_id: -5 }
            ];

            for (const payload of malformedPayloads) {
                const res = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                        subtotal: 5.00,
                        tax: 0.80,
                        total: 5.80,
                        payment_method: 'cash',
                        amount_tendered: 6.00,
                        change_due: 0.20,
                        ...payload
                    });

                expect(res.statusCode).toBe(400);
                expect(res.body.success).toBe(false);
                expect(res.body.message).toContain('Invalid');
            }
        });
    });
});

