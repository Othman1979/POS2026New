const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('retired subscription API', () => {
  let adminCookie;

  beforeAll(async () => {
    await seedDatabase();
    const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
    adminCookie = login.headers['set-cookie'][0];
  });

  afterAll(async () => { await pool.end(); });

  it('rejects old POS and admin endpoints without recreating a subscription table', async () => {
    for (const [method, url] of [
      ['get', '/api/pos/subscription-plans'],
      ['post', '/api/pos/subscription-redemptions'],
      ['get', '/api/admin/subscriptions'],
      ['post', '/api/admin/subscription-plans']
    ]) {
      const response = await request(app)[method](url).set('Cookie', adminCookie).send({});
      expect(response.status, url).toBe(410);
      expect(response.body.code).toBe('SUBSCRIPTIONS_RETIRED');
    }
    const [[tables]] = await pool.query(`SELECT COUNT(*) AS count FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='customer_subscriptions'`);
    expect(Number(tables.count)).toBe(0);
  });

  it('rejects a stale subscription checkout before writing an order', async () => {
    const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
    const response = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
      cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
      subscription_purchase: { plan_id: 1 }
    });
    expect(response.status).toBe(410);
    expect(response.body.code).toBe('SUBSCRIPTIONS_RETIRED');
    const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
    expect(after.count).toBe(before.count);
  });
});
