// integration/auth.test.js — Integration tests for login, logout, manager override, me, and cookie-based authorization
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');
const { overrideAttempts } = require('../../services/ManagerOverrideService');

describe('Auth Integration Tests', () => {
    beforeAll(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        // Drain connection pool at the end of the test suite
        await pool.end();
    });

    describe('POST /api/auth/login', () => {
        it('should login cashier successfully and set cookie', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.user).toBeDefined();
            expect(res.body.user.name).toBe(SEED.cashierUser.name);
            expect(res.body.user.role).toBe(SEED.cashierUser.role);

            // Verify pos_token cookie is set
            const cookies = res.headers['set-cookie'];
            expect(cookies).toBeDefined();
            expect(cookies.some(c => c.includes('pos_token='))).toBe(true);
            expect(cookies.some(c => c.includes('HttpOnly'))).toBe(true);
        });

        it('should reject login for inactive user', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.inactiveUser.user_number });

            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Invalid user number');
        });

        it('should reject login for non-existent user number', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ user_number: '9999' });

            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Invalid user number');
        });

        it('should return 400 when user_number is empty', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ user_number: '' });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('required');
        });
    });

    describe('GET /api/auth/me', () => {
        it('should return user info when authenticated via cookie', async () => {
            // 1. Login to get cookie
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            // 2. Access /me with cookie
            const res = await request(app)
                .get('/api/auth/me')
                .set('Cookie', cookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.user).toBeDefined();
            expect(res.body.user.name).toBe(SEED.cashierUser.name);
            // Verify sensitive columns are filtered out
            expect(res.body.user.password_hash).toBeUndefined();
            expect(res.body.user.admin_pin).toBeUndefined();
            expect(res.body.user.session_token).toBeUndefined();
        });

        it('should return 401 when no session cookie is supplied', async () => {
            const res = await request(app).get('/api/auth/me');
            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe('SESSION_REQUIRED');
            expect(res.body.message).toContain('No session token');
        });

        it('should return 401 when an invalid cookie is supplied', async () => {
            const res = await request(app)
                .get('/api/auth/me')
                .set('Cookie', 'pos_token=invalid_token_signature_123');
            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe('SESSION_INVALID');
            expect(res.body.message).toContain('Invalid or expired session');
        });
    });

    describe('POST /api/auth/manager_override', () => {
        beforeEach(async () => {
            overrideAttempts.clear();
            await pool.query(
                "DELETE FROM audit_events WHERE event_type IN ('pin_override_success','pin_override_failed','pin_override_locked')"
            );
            await pool.query('UPDATE users SET xyz = 0 WHERE id IN (?, ?)', [SEED.cashierUser.id, SEED.adminUser.id]);
        });

        afterEach(async () => {
            overrideAttempts.clear();
            await pool.query('UPDATE users SET xyz = 0 WHERE id IN (?, ?)', [SEED.cashierUser.id, SEED.adminUser.id]);
        });

        it('should approve override with correct manager pin', async () => {
            // Need to be logged in first to perform manager override (it has requireAuth middleware)
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            const res = await request(app)
                .post('/api/auth/manager_override')
                .set('Cookie', cookie)
                .send({ admin_pin: SEED.adminUser.pin });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('approved');
            expect(res.body.permissions).toEqual(['pos.discount', 'pos.price_override']);
            const [[event]] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'pin_override_success' ORDER BY id DESC LIMIT 1"
            );
            expect(event).toMatchObject({ user_id: SEED.cashierUser.id, manager_id: SEED.adminUser.id });
            expect(JSON.parse(event.new_value)).toEqual({ route: '/api/auth/manager_override' });
            expect(String(event.new_value)).not.toContain(SEED.adminUser.pin);
        });

        it('does not persist query parameters in manager-override audit metadata', async () => {
            const loginRes = await request(app).post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];
            const querySecret = 'query-pin-must-not-be-stored';

            const response = await request(app)
                .post(`/api/auth/manager_override?admin_pin=${querySecret}`)
                .set('Cookie', cookie)
                .send({ admin_pin: SEED.adminUser.pin });

            expect(response.statusCode).toBe(200);
            const [[event]] = await pool.query(
                "SELECT new_value FROM audit_events WHERE event_type = 'pin_override_success' ORDER BY id DESC LIMIT 1"
            );
            expect(JSON.parse(event.new_value)).toEqual({ route: '/api/auth/manager_override' });
            expect(String(event.new_value)).not.toContain(querySecret);
        });

        it('should reject override with incorrect pin', async () => {
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            const res = await request(app)
                .post('/api/auth/manager_override')
                .set('Cookie', cookie)
                .send({ admin_pin: 'wrong_pin' });

            expect(res.statusCode).toBe(401);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Invalid manager PIN');
            const [[event]] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'pin_override_failed' ORDER BY id DESC LIMIT 1"
            );
            expect(event).toMatchObject({ user_id: SEED.cashierUser.id, manager_id: null });
            expect(JSON.parse(event.new_value)).toEqual({ route: '/api/auth/manager_override' });
            expect(String(event.new_value)).not.toContain('wrong_pin');
        });

        it('audits the standalone lockout without testing the supplied PIN', async () => {
            const loginRes = await request(app).post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            for (let attempt = 0; attempt < 5; attempt += 1) {
                const failed = await request(app).post('/api/auth/manager_override')
                    .set('Cookie', cookie).send({ admin_pin: 'wrong_pin' });
                expect(failed.statusCode).toBe(401);
            }

            const locked = await request(app).post('/api/auth/manager_override')
                .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
            expect(locked.statusCode).toBe(429);

            const [[event]] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'pin_override_locked' ORDER BY id DESC LIMIT 1"
            );
            expect(event).toMatchObject({ user_id: SEED.cashierUser.id, manager_id: null });
            expect(JSON.parse(event.new_value)).toEqual({ route: '/api/auth/manager_override' });
            expect(String(event.new_value)).not.toContain(SEED.adminUser.pin);
        });

        it('does not audit when either manager-override participant has xyz enabled', async () => {
            const loginRes = await request(app).post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            for (const hiddenUserId of [SEED.cashierUser.id, SEED.adminUser.id]) {
                await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [hiddenUserId]);
                const response = await request(app).post('/api/auth/manager_override')
                    .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
                expect(response.statusCode).toBe(200);

                const [[{ count }]] = await pool.query(
                    "SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ? AND manager_id = ? AND event_type = 'pin_override_success'",
                    [SEED.cashierUser.id, SEED.adminUser.id]
                );
                expect(Number(count)).toBe(0);
                await pool.query('UPDATE users SET xyz = 0 WHERE id = ?', [hiddenUserId]);
            }

            const visibleAgain = await request(app).post('/api/auth/manager_override')
                .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
            expect(visibleAgain.statusCode).toBe(200);
            const [[{ count }]] = await pool.query(
                "SELECT COUNT(*) AS count FROM audit_events WHERE user_id = ? AND manager_id = ? AND event_type = 'pin_override_success'",
                [SEED.cashierUser.id, SEED.adminUser.id]
            );
            expect(Number(count)).toBe(1);
        });

        it('serializes overlapping standalone verifications and releases the actor afterward', async () => {
            const loginRes = await request(app).post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            const requests = [1, 2].map(() => request(app).post('/api/auth/manager_override')
                .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin }));
            const responses = await Promise.all(requests);
            expect(responses.map(response => response.statusCode).sort()).toEqual([200, 429]);

            const retry = await request(app).post('/api/auth/manager_override')
                .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
            expect(retry.statusCode).toBe(200);
        });

        it('still approves a valid override when audit storage fails', async () => {
            const loginRes = await request(app).post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];
            const originalQuery = pool.query.bind(pool);
            const querySpy = vi.spyOn(pool, 'query').mockImplementation((sql, values) => {
                if (typeof sql === 'string' && sql.includes('INSERT INTO audit_events')) {
                    return Promise.reject(new Error('simulated audit insert failure'));
                }
                return originalQuery(sql, values);
            });
            const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

            try {
                const response = await request(app).post('/api/auth/manager_override')
                    .set('Cookie', cookie).send({ admin_pin: SEED.adminUser.pin });
                expect(response.statusCode).toBe(200);
                expect(response.body.success).toBe(true);
                expect(logSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ eventType: 'pin_override_success', userId: SEED.cashierUser.id }),
                    'audit_events: failed to log pin_override_success'
                );
            } finally {
                logSpy.mockRestore();
                querySpy.mockRestore();
            }
        });

        it('should return 400 when admin_pin is missing', async () => {
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            const res = await request(app)
                .post('/api/auth/manager_override')
                .set('Cookie', cookie)
                .send({});

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('PIN is required');
            const [[{ count }]] = await pool.query(
                "SELECT COUNT(*) AS count FROM audit_events WHERE event_type IN ('pin_override_success','pin_override_failed','pin_override_locked')"
            );
            expect(Number(count)).toBe(0);
        });
    });

    describe('POST /api/auth/logout', () => {
        it('should logout user, clear cookie, and invalidate token in DB', async () => {
            // 1. Login
            const loginRes = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookie = loginRes.headers['set-cookie'][0];

            // 2. Logout
            const logoutRes = await request(app)
                .post('/api/auth/logout')
                .set('Cookie', cookie);

            expect(logoutRes.statusCode).toBe(200);
            expect(logoutRes.body.success).toBe(true);

            // Cookie should be cleared (Max-Age=0)
            const clearCookies = logoutRes.headers['set-cookie'];
            expect(clearCookies.some(c => c.includes('Max-Age=0'))).toBe(true);

            // Subsequent requests with the same cookie should be rejected
            const meRes = await request(app)
                .get('/api/auth/me')
                .set('Cookie', cookie);
            expect(meRes.statusCode).toBe(401);
        });

        it('GET /api/auth/logout is not the logout route (must be POST)', async () => {
            const getRes = await request(app).get('/api/auth/logout');
            expect([404, 405]).toContain(getRes.status);
        });
    });

    describe('Single-Session Login Eviction', () => {
        it('re-login invalidates the previous session token', async () => {
            const loginResA = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookieA = loginResA.headers['set-cookie'][0];

            const loginResB = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const cookieB = loginResB.headers['set-cookie'][0];

            const meA = await request(app)
                .get('/api/auth/me')
                .set('Cookie', cookieA);
            expect(meA.statusCode).toBe(401);
            expect(meA.body.success).toBeFalsy();

            const meB = await request(app)
                .get('/api/auth/me')
                .set('Cookie', cookieB);
            expect(meB.statusCode).toBe(200);
            expect(meB.body.success).toBe(true);
        });
    });

    describe('fixed call-center session authority', () => {
        beforeAll(async () => {
            await pool.query(`
                INSERT INTO users (id, user_number, name, role, allowed_sections, is_active)
                VALUES (20, '9020', 'Call Center Auth', 'call_center', '1,2', 1)
                ON DUPLICATE KEY UPDATE role='call_center', allowed_sections='1,2', is_active=1
            `);
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (20, 'pos.checkout'), (20, 'tables.access')");
        });

        it('strips stale grants and sections on login, cache miss, and /me', async () => {
            const login = await request(app).post('/api/auth/login').send({ user_number: '9020' });
            expect(login.statusCode).toBe(200);
            expect(login.body.user).toMatchObject({ role: 'call_center', permissions: [], allowed_sections: null });
            const cookie = login.headers['set-cookie'][0];

            invalidateUserSessions(20);
            const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
            expect(me.statusCode).toBe(200);
            expect(me.body.user).toMatchObject({ role: 'call_center', permissions: [], allowed_sections: null });
        });

        it('rejects a valid manager PIN for call center before override work', async () => {
            await pool.query(
                "DELETE FROM audit_events WHERE event_type IN ('pin_override_success','pin_override_failed','pin_override_locked')"
            );
            const login = await request(app).post('/api/auth/login').send({ user_number: '9020' });
            const response = await request(app)
                .post('/api/auth/manager_override')
                .set('Cookie', login.headers['set-cookie'][0])
                .send({ admin_pin: SEED.adminUser.pin });
            expect(response.statusCode).toBe(403);
            const [[{ count }]] = await pool.query(
                "SELECT COUNT(*) AS count FROM audit_events WHERE event_type IN ('pin_override_success','pin_override_failed','pin_override_locked')"
            );
            expect(Number(count)).toBe(0);
        });
    });
});
