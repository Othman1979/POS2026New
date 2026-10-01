const request = require('supertest');
const express = require('express');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

const CHECKOUT_ROUTER = require.resolve('../../routes/pos/checkout');

// Loads the real checkout router with its own limiter capped at `max`, so the test
// can reach the quota without touching the limiter the shared app already built.
function checkoutAppWithLimit(max) {
    const cached = require.cache[CHECKOUT_ROUTER];
    const previous = process.env.CHECKOUT_RATE_LIMIT_MAX;
    delete require.cache[CHECKOUT_ROUTER];
    process.env.CHECKOUT_RATE_LIMIT_MAX = String(max);
    try {
        const isolated = express();
        isolated.use(express.json());
        isolated.use('/api/pos', require(CHECKOUT_ROUTER));
        return isolated;
    } finally {
        if (previous === undefined) delete process.env.CHECKOUT_RATE_LIMIT_MAX;
        else process.env.CHECKOUT_RATE_LIMIT_MAX = previous;
        require.cache[CHECKOUT_ROUTER] = cached;
    }
}

// The checkout limiter is keyed by the signed-in actor, so it must only run
// once authentication has established who that actor is.
describe('checkout guard order', () => {
    afterAll(async () => {
        await pool.end();
    });

    it.each(['/api/pos/checkout', '/api/pos/checkout/jofotara', '/api/pos/checkout/jofotara/status'])(
        'answers an unauthenticated %s with 401 before the rate limiter runs',
        async route => {
            const res = await request(app).post(route).send({});
            expect(res.statusCode).toBe(401);
        }
    );

    it('refuses a call-center actor with 403 without spending the checkout quota', async () => {
        await seedDatabase();
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (20, '9020', 'Call Center Checkout', 'call_center', 1)
        `);
        const login = await request(app).post('/api/auth/login').send({ user_number: '9020' });
        expect(login.statusCode).toBe(200);
        const cookie = login.headers['set-cookie'][0];

        const limited = checkoutAppWithLimit(2);
        const statuses = [];
        for (const route of [
            '/api/pos/checkout', '/api/pos/checkout', '/api/pos/checkout',
            '/api/pos/checkout/jofotara', '/api/pos/checkout/jofotara/status',
        ]) {
            const res = await request(limited).post(route).set('Cookie', cookie).send({});
            statuses.push(res.statusCode);
        }
        expect(statuses).toEqual([403, 403, 403, 403, 403]);
    });
});