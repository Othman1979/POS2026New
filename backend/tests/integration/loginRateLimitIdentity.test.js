const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateAuthModeCache } = require('../../services/deviceAccess');

function failNextConnectionQuery(predicate) {
    const originalGetConnection = pool.getConnection;
    pool.getConnection = async function () {
        const conn = await originalGetConnection.call(this);
        const originalQuery = conn.query;
        const originalRelease = conn.release;
        let failed = false;
        conn.query = async function (sql, params) {
            if (!failed && predicate(String(sql))) {
                failed = true;
                throw new Error('forced login failure');
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

describe('login abuse-control identity', () => {
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("UPDATE settings SET setting_value='disabled' WHERE setting_key='staff_device_auth_mode'");
        invalidateAuthModeCache();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('never lets forwarded identity create or remove candidate denial', async () => {
        const browser = request.agent(app);
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await browser
                .post('/api/auth/login')
                .set('X-Forwarded-For', `198.51.100.${attempt + 1}`)
                .send({ user_number: 'unknown-candidate' });
            expect(response.status).toBe(401);
        }
        const blocked = await browser
            .post('/api/auth/login')
            .set('X-Forwarded-For', '203.0.113.90')
            .send({ user_number: 'unknown-candidate' });
        expect(blocked.status).toBe(429);

        const valid = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(valid.status).toBe(200);
        expect(valid.headers['set-cookie']?.join(';')).toContain('pos_token=');
    });

    it('keeps PIN login usable for an unbound user without weakening unknown-user delays', async () => {
        await pool.query("UPDATE settings SET setting_value='enforced' WHERE setting_key='staff_device_auth_mode'");
        invalidateAuthModeCache();
        for (let attempt = 0; attempt < 20; attempt += 1) {
            const [known, unknown] = await Promise.all([
                request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number }),
                request(app).post('/api/auth/login').send({ user_number: `missing-${attempt}` }),
            ]);
            expect(known.status).toBe(200);
            expect(known.body.device_registration_required).toBe(false);
            expect(unknown.status).toBe(401);
            expect(unknown.body.message).toBe('Invalid user number.');
        }
    }, 15000);

    it('blocks only the matching browser and submitted user after three failures', async () => {
        const browserA = request.agent(app);
        const browserB = request.agent(app);

        expect((await browserA.post('/api/auth/login').send({ user_number: 'user-one' })).status).toBe(401);
        expect((await browserA.post('/api/auth/login').send({ user_number: 'user-one' })).status).toBe(401);
        const blocked = await browserA.post('/api/auth/login').send({ user_number: 'user-one' });
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe('LOGIN_RATE_LIMITED');
        expect(blocked.headers['retry-after']).toBe('60');

        const beforeBlockedRetry = pool.connectionTelemetrySnapshot();
        const blockedRetry = await browserA.post('/api/auth/login').send({ user_number: 'user-one' });
        const afterBlockedRetry = pool.connectionTelemetrySnapshot();
        expect(blockedRetry.status).toBe(429);
        expect(afterBlockedRetry.acquired).toBe(beforeBlockedRetry.acquired);

        expect((await browserA.post('/api/auth/login').send({ user_number: 'user-two' })).status).toBe(401);
        expect((await browserB.post('/api/auth/login').send({ user_number: 'user-one' })).status).toBe(401);
        expect((await browserB.post('/api/auth/login').send({ user_number: 'user-two' })).status).toBe(401);
    });

    it('clears the browser and user failure state after a successful login', async () => {
        const browser = request.agent(app);
        const candidate = 'temporarily-valid-user';
        const firstFailure = await browser.post('/api/auth/login').send({ user_number: candidate });
        expect(firstFailure.status).toBe(401);
        expect(firstFailure.headers['set-cookie'].join(';')).toContain('pos_login_browser=');
        expect((await browser.post('/api/auth/login').send({ user_number: candidate })).status).toBe(401);

        await pool.query('UPDATE users SET user_number=? WHERE id=?', [candidate, SEED.cashierUser.id]);
        const success = await browser.post('/api/auth/login').send({ user_number: candidate });
        expect(success.status).toBe(200);
        expect(success.headers['set-cookie'].join(';')).toContain('pos_token=');

        await pool.query('UPDATE users SET user_number=? WHERE id=?', [SEED.cashierUser.user_number, SEED.cashierUser.id]);
        expect((await browser.post('/api/auth/login').send({ user_number: candidate })).status).toBe(401);
        expect((await browser.post('/api/auth/login').send({ user_number: candidate })).status).toBe(401);
        expect((await browser.post('/api/auth/login').send({ user_number: candidate })).status).toBe(429);
    });

    it('keeps delay state unchanged on an internal failure', async () => {
        const browser = request.agent(app);
        const delayed = 'server-error-delayed';
        await browser.post('/api/auth/login').send({ user_number: delayed });
        await browser.post('/api/auth/login').send({ user_number: delayed });
        failNextConnectionQuery(sql => sql.includes('staff_device_auth_mode'));
        const failed = await browser.post('/api/auth/login').send({ user_number: delayed });
        expect(failed.status).toBe(500);
        const blocked = await browser.post('/api/auth/login').send({ user_number: delayed });
        expect(blocked.status).toBe(429);
        expect(blocked.headers['retry-after']).toBe('60');

        const fresh = 'server-error-fresh';
        failNextConnectionQuery(sql => sql.includes('staff_device_auth_mode'));
        expect((await browser.post('/api/auth/login').send({ user_number: fresh })).status).toBe(500);
        expect((await browser.post('/api/auth/login').send({ user_number: fresh })).status).toBe(401);
    });
});
