const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');
const {
    seedReceiptPrinter,
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
    insertVoidedOrder,
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');

describe('test helpers', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('logs in a seeded user and creates a minimal paid-order fixture', async () => {
        const adminCookie = await loginSeedUser(request, app, 'adminUser');
        expect(adminCookie).toContain('pos_token=');

        const printerId = await seedReceiptPrinter(pool);
        expect(printerId).toBeGreaterThan(0);

        const shiftId = await insertShift(pool, {
            status: 'closed',
            expected_cash: 31.60,
            actual_cash: 31.60,
            closed_at: '2026-07-01 10:00:00',
        });
        const invoiceId = await insertPaidOrder(pool, { shift_id: shiftId });
        await insertOrderItem(pool, { invoice_id: invoiceId });
        await insertOrderRefund(pool, {
            invoice_id: invoiceId,
            shift_id: shiftId,
            subtotal_refunded: 1.00,
            amount_refunded: 1.00,
        });

        const [[order]] = await pool.query('SELECT total FROM orders WHERE invoice_id = ?', [invoiceId]);
        expectMoney(order.total, 11.60);
    });

    it('insertVoidedOrder persists original_total and original_subtotal', async () => {
        const invoiceId = await insertVoidedOrder(pool, {
            total: 0,
            subtotal: 0,
            original_total: 11.60,
            original_subtotal: 10.00,
        });

        const [[order]] = await pool.query(
            'SELECT original_total, original_subtotal FROM orders WHERE invoice_id = ?',
            [invoiceId]
        );
        expectMoney(order.original_total, 11.60);
        expectMoney(order.original_subtotal, 10.00);
    });
});
