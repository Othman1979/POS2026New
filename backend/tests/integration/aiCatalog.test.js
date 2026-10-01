import { beforeAll, afterAll, describe, expect, it } from 'vitest';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const key = 'ai-catalog-test-key-with-more-than-forty-eight-characters';
process.env.ORDER_INTAKE_ENABLED = 'true';
process.env.ORDER_INTAKE_CLIENT_ID = 'ai-catalog-test';
process.env.ORDER_INTAKE_API_KEY_SHA256 = crypto.createHash('sha256').update(key).digest('hex');
process.env.ORDER_INTAKE_QUOTE_SECRET = 'ai-catalog-quote-secret-with-at-least-thirty-two-characters';
process.env.ORDER_INTAKE_ACTOR_USER_ID = '70';
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('customer-facing product information', () => {
    let staff, cashier;
    beforeAll(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO users (id,user_number,name,role,is_active) VALUES (70,'9070','AI actor','call_center',1),(71,'9071','Phone desk','call_center',1)");
        staff = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        cashier = (await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).headers['set-cookie'][0];
    });
    afterAll(() => pool.end());
    const endpoint = '/api/admin/products';
    const save = body => request(app).put(endpoint).set('Cookie', staff).send({ id: 1, ...body });

    it('upgrades an existing products table and reapplying keeps the description', async () => {
        const name = '2026-09-22-product-customer-info-v1';
        const sql = fs.readFileSync(path.resolve(__dirname, `../../migrations/${name}.auto.sql`), 'utf8');
        const apply = async () => { for (const statement of sql.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await pool.query(statement); };
        await pool.query('ALTER TABLE products DROP COLUMN customer_info');
        await apply();
        await pool.query('UPDATE products SET customer_info=? WHERE id=1', ['مع متبل وثومية']);
        await apply();
        const [[row]] = await pool.query('SELECT customer_info FROM products WHERE id=1');
        expect(row.customer_info).toBe('مع متبل وثومية');
        await pool.query('UPDATE products SET customer_info=NULL WHERE id=1');
    });

    it('creates information through normal product creation and enforces admin access and validation', async () => {
        expect((await request(app).put(endpoint).set('Cookie', cashier).send({ id: 1, customer_info: 'x', previous_customer_info: '' })).status).toBe(403);
        expect((await request(app).put(endpoint).set('Authorization', `Bearer ${key}`).send({ id: 1, customer_info: 'x', previous_customer_info: '' })).status).not.toBe(200);
        const created = await request(app).post(endpoint).set('Cookie', staff).send({ name: 'New dish info', price: 5, customer_info: '  Comes with sauces  ' });
        expect(created.status).toBe(200);
        const [[row]] = await pool.query('SELECT customer_info FROM products WHERE id=?', [created.body.id]);
        expect(row.customer_info).toBe('Comes with sauces');
        expect((await save({ customer_info: 'x'.repeat(1201), previous_customer_info: '' })).status).toBe(400);
        expect((await save({ customer_info: {}, previous_customer_info: '' })).status).toBe(400);
        expect((await save({ customer_info: 'missing previous' })).status).toBe(400);
    });

    it('preserves prices, handles lost-reply replay and rejects conflicting edits', async () => {
        const text = 'يأتي معه متبل وثومية وصوص الشمندر الخاص بالمطعم.';
        const body = { customer_info: text, previous_customer_info: '' };
        expect((await save(body)).status).toBe(200);
        expect((await save(body)).status).toBe(200);
        expect((await save({ ...body, customer_info: 'stale edit' })).status).toBe(409);
        const current = await request(app).get(endpoint + '?search=Test%20Burger&limit=20').set('Cookie', staff);
        expect(current.body.products.find(row => row.id === 1).customer_info).toBe(text);
        expect((await save({ is_available: 1 })).status).toBe(200);
        const [[product]] = await pool.query('SELECT price,is_available FROM products WHERE id=1');
        expect(Number(product.price)).toBe(5);
        expect(Number(product.is_available)).toBe(1);
        const ai = await request(app).get('/api/order-intake/v1/catalog/search?q=Test%20Burger').set('Authorization', `Bearer ${key}`);
        expect(ai.status).toBe(200);
        expect(ai.body.products.find(row => row.id === 1).customer_info).toBe(text);
        expect((await save({ customer_info: '', previous_customer_info: text })).status).toBe(200);
        const cleared = await request(app).get('/api/order-intake/v1/catalog/search?q=Test%20Burger').set('Authorization', `Bearer ${key}`);
        expect(cleared.body.products.find(row => row.id === 1).customer_info).toBeNull();
    });

    it('preserves information during unrelated partial updates', async () => {
        await save({ customer_info: 'Included sauces', previous_customer_info: '' });
        expect((await save({ name: 'Test Burger' })).status).toBe(200);
        const [[row]] = await pool.query('SELECT customer_info FROM products WHERE id=1');
        expect(row.customer_info).toBe('Included sauces');
    });
});
