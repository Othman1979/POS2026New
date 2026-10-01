const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { getBusinessDateRange } = require('../../utils/businessDate');
const { getProductSalesByBusinessDate } = require('../../services/productSalesMetrics');

describe('productSalesMetrics', () => {
    beforeEach(seedDatabase);

    it('keeps sale value on sale day and returned value on refund day', async () => {
        const invoiceId = await insertPaidOrder(pool, {
            subtotal: 100,
            total: 80,
            tax: 0,
            discount_type: 'fixed',
            discount_value: 20,
            invoice_issued_at: '2026-07-07 04:00:00',
            created_at: '2026-07-07 04:00:00',
        });
        const itemId = await insertOrderItem(pool, {
            invoice_id: invoiceId,
            quantity: 2,
            price_at_sale: 50,
            tax_amount: 0,
        });
        const refundId = await insertOrderRefund(pool, {
            invoice_id: invoiceId,
            subtotal_refunded: 40,
            amount_refunded: 40,
            created_at: '2026-07-14 05:00:00',
        });
        await pool.query(`
            INSERT INTO refund_items
              (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
            VALUES (?, ?, 1, 'Test Burger', 1, 50, 40, 0, 40)
        `, [refundId, itemId]);

        const rows = await getProductSalesByBusinessDate(
            pool,
            getBusinessDateRange('2026-07-07', '2026-07-14')
        );

        expect(rows.find(row => row.business_date === '2026-07-07')).toMatchObject({
            sold_amount: 80,
            net_sales: 80,
        });
        expect(rows.find(row => row.business_date === '2026-07-14')).toMatchObject({
            returned_amount: 40,
            net_sales: -40,
            net_units: -1,
        });
    });

    it('handles sale and refund item names stored with different collations', async () => {
        const invoiceId = await insertPaidOrder(pool, {
            subtotal: 10,
            total: 10,
            tax: 0,
            invoice_issued_at: '2026-07-14 04:00:00',
            created_at: '2026-07-14 04:00:00',
        });
        const itemId = await insertOrderItem(pool, {
            invoice_id: invoiceId,
            quantity: 1,
            price_at_sale: 10,
            tax_amount: 0,
        });
        const refundId = await insertOrderRefund(pool, {
            invoice_id: invoiceId,
            subtotal_refunded: 10,
            amount_refunded: 10,
            created_at: '2026-07-14 05:00:00',
        });

        await pool.query(
            'ALTER TABLE refund_items MODIFY item_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL'
        );
        try {
            await pool.query(`
                INSERT INTO refund_items
                  (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
                VALUES (?, ?, 1, 'Test Burger', 1, 10, 10, 0, 10)
            `, [refundId, itemId]);

            await expect(getProductSalesByBusinessDate(
                pool,
                getBusinessDateRange('2026-07-14', '2026-07-14')
            )).resolves.toEqual(expect.arrayContaining([
                expect.objectContaining({ item_name: 'Test Burger' }),
            ]));
        } finally {
            await pool.query(
                'ALTER TABLE refund_items MODIFY item_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL'
            );
        }
    });
});
