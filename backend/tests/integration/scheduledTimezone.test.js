const pool = require('../../config/db');
const { buildDatabasePoolOptions } = require('../../config/databasePoolOptions');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { businessLocalTimestampSql } = require('../../utils/businessDate');

describe('database timestamp wire contract', () => {
    afterAll(() => pool.end());
    it('keeps appointment clock fields as strings and actual events as UTC instants', async () => {
        const [[row]] = await pool.query('SELECT CAST(? AS DATETIME) AS delivery_date, CAST(? AS DATETIME) AS created_at', ['2026-09-09T18:30', '2026-09-09 15:30:00']);
        expect(row.delivery_date).toBe('2026-09-09 18:30:00');
        expect(row.created_at.toISOString()).toBe('2026-09-09T15:30:00.000Z');
        expect(JSON.parse(JSON.stringify(row))).toEqual({delivery_date:'2026-09-09 18:30:00',created_at:'2026-09-09T15:30:00.000Z'});
        const [[session]] = await pool.query('SELECT @@session.time_zone AS zone');
        expect(session.zone).toBe('+00:00');
        expect(buildDatabasePoolOptions().timezone).toBe('Z');
    });
    it('round trips a paid checkout schedule through database, order details and order notes', async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cookie = login.headers['set-cookie'][0];
        await request(app).post('/api/auth/shifts?action=open').set('Cookie', cookie).send({ user_id: SEED.adminUser.id, starting_cash: 0 });
        const [[shift]] = await pool.query("SELECT id FROM shifts WHERE user_id=? AND status='open'", [SEED.adminUser.id]);
        const input = { cart:[{id:SEED.product1.id,qty:1,price:5}],shift_id:shift.id,subtotal:5,tax:0.8,total:5.8,payment_method:'cash',amount_tendered:6,change_due:0.2,idempotency_key:randomUUID(),delivery_date:'2026-09-09T18:30' };
        const sale = await request(app).post('/api/pos/checkout').set('Cookie',cookie).send(input);
        expect(sale.status, JSON.stringify(sale.body)).toBe(200);
        const [[stored]] = await pool.query('SELECT invoice_id,delivery_date,created_at,UTC_TIMESTAMP() AS now_utc FROM orders WHERE idempotency_key=?',[input.idempotency_key]);
        expect(stored.delivery_date).toBe('2026-09-09 18:30:00');
        expect(Math.abs(stored.created_at.getTime()-stored.now_utc.getTime())).toBeLessThan(10000);
        const details = await request(app).get('/api/admin/order_details').query({id:stored.invoice_id}).set('Cookie',cookie);
        expect(details.status).toBe(200);
        expect(details.body.order.delivery_date).toBe('2026-09-09 18:30:00');
        expect(details.body.order.created_at).toMatch(/Z$/);
        const notes = await request(app).get('/api/pos/order_notes').set('Cookie',cookie);
        expect(notes.status).toBe(200);
        expect(notes.body.orders.find(row=>row.invoice_id===stored.invoice_id).delivery_date).toBe('2026-09-09 18:30:00');
        const invalid = await request(app).post('/api/pos/checkout').set('Cookie',cookie).send({...input,idempotency_key:randomUUID(),delivery_date:'2026-02-30T18:30'});
        expect(invalid.status).toBe(400);
    });
    it('filters audit events by venue calendar date, including midnight and excluding the next midnight', async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cookie = login.headers['set-cookie'][0];
        const ids = [];
        for (const stamp of ['2026-07-20 20:59:59', '2026-07-20 21:00:00', '2026-07-21 20:59:59', '2026-07-21 21:00:00']) {
            const [row] = await pool.query("INSERT INTO audit_events(event_type,user_id,entity_type,entity_id,created_at) VALUES('timezone_review',?,'order','1',?)", [SEED.adminUser.id, stamp]);
            ids.push(row.insertId);
        }
        const result = await request(app).get('/api/admin/audit').query({event_type:'timezone_review',start_date:'2026-07-21',end_date:'2026-07-21'}).set('Cookie', cookie);
        expect(result.status).toBe(200);
        expect(result.body.events.map(row => row.id).sort((a,b) => a-b)).toEqual(ids.slice(1,3));
        expect((await request(app).get('/api/admin/audit').query({start_date:'2026-02-30'}).set('Cookie',cookie)).status).toBe(400);
    });
    it('compares future appointments with the business clock, not UTC wall time', async () => {
        const [[row]] = await pool.query(`SELECT CAST('2026-09-09 18:30:00' AS DATETIME) > ${businessLocalTimestampSql("CAST('2026-09-09 16:00:00' AS DATETIME)")} AS future`);
        expect(row.future).toBe(0);
    });
});
