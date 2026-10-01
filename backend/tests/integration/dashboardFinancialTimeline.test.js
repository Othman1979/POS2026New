const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { getBusinessDateRange } = require('../../utils/businessDate');
const { getFinancialEventTimeline } = require('../../services/financialEventMetrics');

describe('getFinancialEventTimeline', () => {
    beforeEach(seedDatabase);

    it('attributes paid sales and old-order refunds to their own event minutes', async () => {
        const oldInvoice = await insertPaidOrder(pool, {
            total: 100,
            subtotal: 100,
            tax: 0,
            cash_amount: 60,
            card_amount: 40,
            payment_method: 'split',
            invoice_issued_at: '2026-07-07 04:00:00',
            created_at: '2026-07-07 04:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: oldInvoice,
            quantity: 1,
            price_at_sale: 100,
            tax_amount: 0,
        });
        await insertOrderRefund(pool, {
            invoice_id: oldInvoice,
            amount_refunded: 10.01,
            subtotal_refunded: 10.01,
            refund_method: 'split',
            created_at: '2026-07-14 05:30:00',
        });
        await insertPaidOrder(pool, {
            total: 50,
            subtotal: 50,
            tax: 0,
            cash_amount: 50,
            payment_method: 'cash',
            invoice_issued_at: '2026-07-14 04:00:00',
            created_at: '2026-07-14 04:00:00',
        });

        const rows = await getFinancialEventTimeline(pool, getBusinessDateRange('2026-07-14'));

        expect(rows).toContainEqual(expect.objectContaining({
            business_date: '2026-07-14',
            elapsed_minute: 60,
            sales_processed: 50,
            orders: 1,
        }));
        expect(rows).toContainEqual(expect.objectContaining({
            business_date: '2026-07-14',
            elapsed_minute: 150,
            refunds_issued: 10.01,
            refund_cash: 6.01,
            refund_card: 4,
        }));
    });

    it('keeps platform sales and platform refunds out of cash and card timeline totals', async () => {
        const invoice = await insertPaidOrder(pool, {
            total: 12,
            subtotal: 12,
            tax: 0,
            cash_amount: 0,
            card_amount: 0,
            payment_method: 'platform',
            invoice_issued_at: '2026-07-14 06:00:00',
            created_at: '2026-07-14 06:00:00',
        });
        await insertOrderRefund(pool, {
            invoice_id: invoice,
            amount_refunded: 2,
            subtotal_refunded: 2,
            refund_method: 'platform',
            created_at: '2026-07-14 06:10:00',
        });

        const rows = await getFinancialEventTimeline(pool, getBusinessDateRange('2026-07-14'));

        expect(rows).toContainEqual(expect.objectContaining({
            business_date: '2026-07-14',
            elapsed_minute: 180,
            platform: 12,
            cash: 0,
            card: 0,
        }));
        expect(rows).toContainEqual(expect.objectContaining({
            business_date: '2026-07-14',
            elapsed_minute: 190,
            refund_platform: 2,
            refund_cash: 0,
            refund_card: 0,
        }));
    });
});
