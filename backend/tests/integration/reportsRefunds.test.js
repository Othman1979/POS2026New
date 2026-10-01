const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { formatDbTimestamp, getBusinessDayRange } = require('../../utils/businessDate');

describe('GET /api/admin/reports/refunds', () => {
    let adminCookie;
    let shiftId;
    let orderInvoiceId;

    const REFUND_DATE = '2025-07-15';

    beforeAll(async () => {
        await seedDatabase();

        const adminLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLogin.headers['set-cookie'][0];

        const [shiftRes] = await pool.query(
            `INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (?, 50.00, 'open', ?)`,
            [SEED.cashierUser.id, REFUND_DATE + ' 09:00:00']
        );
        shiftId = shiftRes.insertId;

        const [orderRes] = await pool.query(`
            INSERT INTO orders (invoice_number, invoice_issued_at, user_id, shift_id, subtotal, tax, total, payment_method, cash_amount, card_amount, created_at)
            VALUES (42, ?, ?, ?, 90.00, 10.00, 100.00, 'cash', 100.00, 0.00, ?)
        `, [REFUND_DATE + ' 10:00:00', SEED.cashierUser.id, shiftId, REFUND_DATE + ' 10:00:00']);
        orderInvoiceId = orderRes.insertId;

        // Refund: kind='refund', amount=30, method='cash', reason='wrong item', user A
        await pool.query(`
            INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, refund_method, reason, user_id, shift_id, created_at)
            VALUES ('refund', ?, 'order', 27.00, 3.00, 30.00, 'cash', 'wrong item', ?, ?, ?)
        `, [orderInvoiceId, SEED.cashierUser.id, shiftId, REFUND_DATE + ' 10:30:00']);

        // Void snapshot says Table 4 while the joined table is currently Table 1.
        // Reports must trust the immutable snapshot.
        await pool.query(`
            INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, refund_method, reason, user_id, shift_id, table_id, table_number, created_at)
            VALUES ('void', ?, 'order', 0.00, 0.00, 0.00, NULL, 'Item removed from table', ?, ?, ?, '4', ?)
        `, [orderInvoiceId, SEED.waiterUser.id, shiftId, SEED.table.id, REFUND_DATE + ' 11:00:00']);
    });

    afterAll(async () => {
        await pool.end();
    });

    describe('Auth guard', () => {
        it('returns 401 without cookie', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}`);
            expect(res.statusCode).toBe(401);
        });
    });

    describe('Summary', () => {
        it('gross_sales=100, refund_total=30, refund_cash=30, refund_card=0, refund_count=1, void_count=1, void_value=100, net_sales=70', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const s = res.body.summary;
            expect(Number(s.sales_processed)).toBe(100);
            expect(Number(s.refund_total)).toBe(30);
            expect(Number(s.refund_cash)).toBe(30);
            expect(Number(s.refund_card)).toBe(0);
            expect(Number(s.refund_count)).toBe(1);
            expect(Number(s.void_count)).toBe(1);
            expect(Number(s.void_value)).toBe(100);
        });
    });

    describe('by_staff', () => {
        it('tracks refund count, value, void count, void value by staff without outliers or rates', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body.by_staff)).toBe(true);
            const staffA = res.body.by_staff.find(s => Number(s.user_id) === SEED.cashierUser.id);
            expect(staffA).toBeDefined();
            expect(Number(staffA.refund_value)).toBe(30);
            expect(Number(staffA.refund_count)).toBe(1);
            expect(Number(staffA.void_count)).toBe(0);
            expect(Number(staffA.void_value)).toBe(0);
            expect(staffA).not.toHaveProperty('is_outlier');
            expect(staffA).not.toHaveProperty('refund_rate');
            expect(staffA).not.toHaveProperty('staff_sales');
            expect(res.body).not.toHaveProperty('trend');
        });
    });

    describe('top_reasons', () => {
        it('includes {reason:"wrong item", count:1, value:30}', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(Array.isArray(res.body.top_reasons)).toBe(true);
            const reason = res.body.top_reasons.find(r => r.reason === 'wrong item');
            expect(reason).toBeDefined();
            expect(Number(reason.count)).toBe(1);
            expect(Number(reason.value)).toBe(30);
        });
    });

    describe('log', () => {
        it('returns 2 rows, pagination.total=2, ordered by created_at DESC (void first)', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            const { rows, pagination } = res.body.log;
            expect(rows.length).toBe(2);
            expect(Number(pagination.total)).toBe(2);
            expect(rows[0].kind).toBe('void');
            expect(Number(rows[0].amount_refunded)).toBe(0);
            expect(Number(rows[0].event_value)).toBe(100);
            expect(rows[0].table_number).toBe('4');
            expect(rows[0].cashier_name).toBe(SEED.waiterUser.name);
            expect(rows[0].occurred_at_local).toBeTruthy();
            expect(rows[0].reason).toBe('Item removed from table');
            expect(rows[1].kind).toBe('refund');
            expect(Number(rows[1].event_value)).toBe(30);
            expect(rows[1].invoice_display_no).toBeTruthy();
        });

        it('filters kind=void → 1 row (the void)', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}&kind=void`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.log.rows.length).toBe(1);
            expect(res.body.log.rows[0].kind).toBe('void');
        });

        it('filters method=cash → 1 row (the refund)', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}&method=cash`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.log.rows.length).toBe(1);
            expect(res.body.log.rows[0].kind).toBe('refund');
        });

        it('finds a void by its snapshotted table number', async () => {
            const res = await request(app)
                .get(`/api/admin/reports/refunds?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}&q=4`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.log.rows).toHaveLength(1);
            expect(res.body.log.rows[0]).toMatchObject({ kind: 'void', table_number: '4' });
        });
    });

    describe('GET /api/admin/reports/refunds/print-data', () => {
        it('returns full event list and nested item list for selected period', async () => {
            const printRes = await request(app)
                .get(`/api/admin/reports/refunds/print-data?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}`)
                .set('Cookie', adminCookie);

            expect(printRes.statusCode).toBe(200);
            expect(printRes.body.success).toBe(true);
            expect(printRes.body.events).toBeDefined();
            expect(printRes.body.events.length).toBeGreaterThanOrEqual(1);

            const refundEvent = printRes.body.events.find(e => e.kind === 'refund');
            expect(refundEvent).toBeDefined();
            expect(refundEvent.cashier_name).toBeDefined();
            expect(refundEvent.reason).toBe('wrong item');
            expect(Array.isArray(refundEvent.items)).toBe(true);

            const voidEvent = printRes.body.events.find(e => e.kind === 'void');
            expect(voidEvent).toMatchObject({
                table_number: '4',
                cashier_name: SEED.waiterUser.name,
                reason: 'Item removed from table'
            });
            expect(voidEvent.occurred_at_local).toBeTruthy();
        });
    });
});
