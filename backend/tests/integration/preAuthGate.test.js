const request = require('supertest');
const http = require('node:http');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { invalidateAuthModeCache } = require('../../services/deviceAccess');

describe('global pre-authentication boundary', () => {
    afterAll(async () => pool.end());

    it('caps both accepted body formats before the gate and preserves the global parser elsewhere', async () => {
        const large = '1'.repeat(17 * 1024);
        expect((await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ user_number: large }))).status).toBe(413);
        expect((await request(app).post('/api/auth/login').type('form').send({ user_number: large })).status).toBe(413);
        expect((await request(app).post('/API/AUTH/LOGIN/').set('Content-Type', 'application/json').send(JSON.stringify({ user_number: large }))).status).toBe(413);
        expect((await request(app).post('/api/auth/logout').send({ padding: 'x'.repeat(50 * 1024) })).status).not.toBe(413);
        expect((await request(app).post('/api//auth/login').send({ user_number: 'missing' })).status).toBe(404);
    });

    it('exposes no ungated alias for a covered route', async () => {
        // A `.php` suffix used to be stripped after the gate matched, so /api/auth/login.php
        // reached the login handler with no rate limit, no lease and the 1 MB parser.
        const large = '1'.repeat(17 * 1024);
        const aliased = await request(app).post('/api/auth/login.php')
            .set('Content-Type', 'application/json').send(JSON.stringify({ user_number: large }));
        expect(aliased.status).toBe(404);
        expect(aliased.body?.message).not.toBe('Invalid user number.');
        expect((await request(app).get('/api/auth/login-policy.php')).status).toBe(404);
    });

    it('admits at most six dynamic policy requests while one database read is in flight', async () => {
        invalidateAuthModeCache();
        const originalQuery = pool.query;
        let release;
        const held = new Promise(resolve => { release = resolve; });
        pool.query = function (sql, params) {
            if (String(sql).includes("setting_key='staff_device_auth_mode'")) return held;
            return originalQuery.call(this, sql, params);
        };
        try {
            const pending = Array.from({ length: 7 }, () => request(app).get('/api/auth/login-policy').then(response => response));
            await new Promise(resolve => setTimeout(resolve, 100));
            const early = await Promise.race([
                Promise.all(pending.map((promise, index) => promise.then(response => ({ index, response })))),
                new Promise(resolve => setTimeout(() => resolve(null), 500)),
            ]);
            // Promise.all cannot finish while the admitted six are held; inspect the seventh directly.
            const seventh = await pending[6];
            expect(seventh.status).toBe(429);
            expect(seventh.body).toEqual({ success: false, code: 'SERVER_BUSY', message: 'The server is busy. Try again in a moment.' });
            expect(early).toBeNull();
            release([[{ setting_value: 'disabled' }]]);
            const responses = await Promise.all(pending.slice(0, 6));
            expect(responses.every(response => response.status === 200)).toBe(true);
        } finally {
            pool.query = originalQuery;
        }
    }, 5000);

    it('does not lease capacity while six request bodies are still incomplete', async () => {
        const server = app.listen(0);
        const { port } = server.address();
        const stuck = [];
        try {
            for (let index = 0; index < 6; index += 1) {
                const pending = http.request({ port, method: 'POST', path: '/api/auth/login', headers: { 'content-type': 'application/json', 'content-length': '64' } });
                pending.on('error', () => {});
                pending.write('{"user_number":"');
                stuck.push(pending);
            }
            const policy = await request(server).get('/api/auth/login-policy');
            expect(policy.status).toBe(200);
        } finally {
            stuck.forEach(pending => pending.destroy());
            await new Promise(resolve => server.close(resolve));
        }
    });
});
