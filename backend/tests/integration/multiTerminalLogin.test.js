// integration/multiTerminalLogin.test.js — a PIN login signs the user out elsewhere unless auth.multi_terminal is granted
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

const cookieOf = res => res.headers['set-cookie'].find(c => c.startsWith('pos_token=')).split(';')[0];
const login = async () => {
    const res = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
    expect(res.statusCode).toBe(200);
    return cookieOf(res);
};
const me = cookie => request(app).get('/api/auth/me').set('Cookie', cookie);

describe('PIN login on several terminals', () => {
    beforeAll(async () => { await seedDatabase(); });
    afterAll(async () => { await pool.end(); });
    afterEach(async () => {
        await pool.query("DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'auth.multi_terminal'", [SEED.cashierUser.id]);
    });

    it('signs the first terminal out when the user has no grant', async () => {
        const terminalA = await login();
        expect((await me(terminalA)).statusCode).toBe(200);
        const terminalB = await login();
        expect((await me(terminalA)).statusCode).toBe(401);
        expect((await me(terminalB)).statusCode).toBe(200);
    });

    it('keeps both terminals signed in when the user has the grant', async () => {
        await pool.query("INSERT INTO user_permissions (user_id, perm_key) VALUES (?, 'auth.multi_terminal')", [SEED.cashierUser.id]);
        const terminalA = await login();
        const terminalB = await login();
        expect((await me(terminalA)).statusCode).toBe(200);
        expect((await me(terminalB)).statusCode).toBe(200);
        const [[{ active }]] = await pool.query(
            'SELECT COUNT(*) AS active FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL', [SEED.cashierUser.id]);
        expect(Number(active)).toBeGreaterThanOrEqual(2);
    });

    it('keeps admin logins single-session even though the role grants every action', async () => {
        const adminLogin = async () => cookieOf(await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number }));
        const first = await adminLogin();
        const second = await adminLogin();
        expect((await me(first)).statusCode).toBe(401);
        expect((await me(second)).statusCode).toBe(200);
    });

    it('signs every terminal out on the next grantless login after the grant is removed', async () => {
        await pool.query("INSERT INTO user_permissions (user_id, perm_key) VALUES (?, 'auth.multi_terminal')", [SEED.cashierUser.id]);
        const terminalA = await login();
        const terminalB = await login();
        await pool.query("DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'auth.multi_terminal'", [SEED.cashierUser.id]);
        const terminalC = await login();
        expect((await me(terminalA)).statusCode).toBe(401);
        expect((await me(terminalB)).statusCode).toBe(401);
        expect((await me(terminalC)).statusCode).toBe(200);
    });
});
