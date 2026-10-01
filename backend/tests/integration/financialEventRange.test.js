const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderItem } = require('../helpers/fixtures');
const { getFinancialEventsForPeriod } = require('../../services/financialEventMetrics');

describe('financial event range uses the issued timestamp and legacy fallback consistently', () => {
    beforeAll(async () => { await seedDatabase(); });
    afterAll(async () => { await pool.end(); });

    it('scopes sales, discounts and service fees without including bundle child discounts', async () => {
        const start = '2026-09-06 00:00:00';
        const end = '2026-09-07 00:00:00';
        const cases = [
            { created_at: '2026-01-01 08:00:00', invoice_issued_at: start },
            { created_at: '2026-01-01 08:00:00', invoice_issued_at: '2026-09-06 14:00:00' },
            { created_at: '2026-09-06 14:00:00', invoice_issued_at: null },
            { created_at: start, invoice_issued_at: end },
            { created_at: start, invoice_issued_at: '2026-09-05 23:59:59' },
            { created_at: start, invoice_issued_at: null, payment_method: 'unpaid_table' },
            { created_at: start, invoice_issued_at: start, payment_method: 'voided' },
        ];
        for (const dates of cases) {
            const invoiceId = await insertPaidOrder(pool, {
                subtotal: 12, tax: 0, total: 11, cash_amount: 11,
                discount_type: 'fixed', discount_value: 1, ...dates
            });
            const parent = await insertOrderItem(pool, {
                invoice_id: invoiceId, quantity: 1, price_at_sale: 10, tax_amount: 0,
                discount_type: 'fixed', discount_value: 1
            });
            const fee = await insertOrderItem(pool, { invoice_id: invoiceId, quantity: 1, price_at_sale: 3, tax_amount: 0 });
            await pool.query("UPDATE order_items SET note='Auto-Gratuity' WHERE id=?", [fee]);
            const child = await insertOrderItem(pool, {
                invoice_id: invoiceId, quantity: 1, price_at_sale: 100, tax_amount: 0,
                discount_type: 'fixed', discount_value: 100
            });
            await pool.query('UPDATE order_items SET parent_item_id=? WHERE id=?', [parent, child]);
        }
        expect(await getFinancialEventsForPeriod(pool, start, end)).toMatchObject({
            orders: 3, sales_processed: 33, cash: 33,
            discounts_total: 6, discounted_orders: 3, service_charges_collected: 8.25,
        });
    });
});
