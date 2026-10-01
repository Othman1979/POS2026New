const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { insertShift, insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { getShiftDiscountsByShift } = require('../../services/shiftMetrics');

async function readCount(conn) {
    const [rows] = await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'");
    expect(rows).toHaveLength(1);
    return Number(rows[0].Value);
}

describe('shift discount query boundaries', () => {
    beforeEach(async () => { await seedDatabase(); });

    it('keeps partial refunds, line/order discounts, legacy lines and multiple shifts separate', async () => {
        const first = await insertShift(pool);
        const second = await insertShift(pool);
        const invoice = await insertPaidOrder(pool, {
            shift_id: first, subtotal: 8, tax: 0, total: 6, cash_amount: 6,
            discount_type: 'fixed', discount_value: 2,
        });
        const item = await insertOrderItem(pool, {
            invoice_id: invoice, quantity: 2, price_at_sale: 5, tax_rate: 0, tax_amount: 0,
            discount_type: 'fixed', discount_value: 1,
        });
        // A later-day refund still reduces the active discount of this sale.
        const refund = await insertOrderRefund(pool, {
            invoice_id: invoice, shift_id: second, scope: 'item', subtotal_refunded: 1.5,
            amount_refunded: 1.5, created_at: '2026-07-03 10:00:00',
        });
        await pool.query(`INSERT INTO refund_items
            (refund_id,order_item_id,product_id,quantity,unit_price,line_subtotal,line_tax,line_total)
            VALUES (?,?,1,.5,5,1.5,0,1.5)`, [refund, item]);
        const percentage = await insertPaidOrder(pool, {
            shift_id: first, subtotal: 6, tax: 0, total: 3, cash_amount: 3,
            discount_type: 'percent', discount_value: 50,
        });
        await insertOrderItem(pool, {
            invoice_id: percentage, quantity: 1, price_at_sale: 8, tax_rate: 0, tax_amount: 0,
            discount_type: 'percent', discount_value: 25,
        });
        await insertPaidOrder(pool, {
            shift_id: second, subtotal: 10, tax: 0, total: 7, cash_amount: 7,
            discount_type: 'fixed', discount_value: 3, invoice_issued_at: null,
        });
        for (const method of ['voided', 'unpaid_table']) {
            await insertPaidOrder(pool, { shift_id: first, payment_method: method,
                discount_type: 'fixed', discount_value: 100, subtotal: 100, tax: 0, total: 0, cash_amount: 0 });
        }
        expect(await getShiftDiscountsByShift(pool, [first, second])).toEqual({
            [first]: { order_discounts: 4.5, line_discounts: 3.5, total_discounts: 8 },
            [second]: { order_discounts: 3, line_discounts: 0, total_discounts: 3 },
        });
        expect(await getShiftDiscountsByShift(pool, [first, second], {
            start: '2026-07-01 08:00:00', end: '2026-07-01 09:00:00',
        })).toEqual(await getShiftDiscountsByShift(pool, [first, second]));
        expect(await getShiftDiscountsByShift(pool, [first, second], {
            start: '2026-07-01 09:00:00', end: '2026-07-02 09:00:00',
        })).toEqual({});
    });

    it('keeps zero-subtotal and fully refunded line discounts finite', async () => {
        const shift = await insertShift(pool);
        for (const refunded of [false, true]) {
            const invoice = await insertPaidOrder(pool, {
                shift_id: shift, subtotal: 0, tax: 0, total: 0, cash_amount: 0,
                discount_type: 'percent', discount_value: 100,
            });
            const item = await insertOrderItem(pool, {
                invoice_id: invoice, quantity: 1, price_at_sale: 10, tax_rate: 0, tax_amount: 0,
                discount_type: 'percent', discount_value: 100,
            });
            if (refunded) {
                const refund = await insertOrderRefund(pool, { invoice_id: invoice, shift_id: shift });
                await pool.query(`INSERT INTO refund_items
                    (refund_id,order_item_id,product_id,quantity,unit_price,line_subtotal,line_tax,line_total)
                    VALUES (?,?,1,1,10,0,0,0)`, [refund, item]);
            }
        }
        expect(await getShiftDiscountsByShift(pool, [shift])).toEqual({
            [shift]: { order_discounts: 0, line_discounts: 10, total_discounts: 10 },
        });
        expect(await getShiftDiscountsByShift(pool, [])).toEqual({});
    });

    it.each([100, 500])('bounds refund work for %i selected invoices among unrelated history', async (selectedCount) => {
        const shift = await insertShift(pool);
        for (let i = 0; i < selectedCount; i++) {
            const invoice = await insertPaidOrder(pool, { shift_id: shift, tax: 0, total: 10, cash_amount: 10 });
            await insertOrderItem(pool, { invoice_id: invoice, tax_rate: 0, tax_amount: 0 });
        }
        const expected = await getShiftDiscountsByShift(pool, [shift]);
        const [otherShifts] = await pool.query(`INSERT INTO shifts (user_id,starting_cash,status,opened_at)
            VALUES ?`, [Array.from({ length: 200 }, () => [2, 0, 'open', '2025-01-01 06:00:00'])]);
        for (let offset = 0; offset < 4000; offset += 500) {
            await pool.query(`INSERT INTO orders
                (user_id,shift_id,subtotal,tax,total,cash_amount,payment_method,created_at,invoice_issued_at)
                VALUES ?`, [Array.from({ length: 500 }, (_, i) =>
                [2, otherShifts.insertId + (offset+i)%200, 10, 0, 10, 10, 'cash', '2025-01-01 08:00:00', '2025-01-01 08:00:00'])]);
        }
        await pool.query(`INSERT INTO order_items (invoice_id,product_id,quantity,price_at_sale,tax_rate,tax_amount)
            SELECT invoice_id,1,2,5,0,0 FROM orders WHERE shift_id<>?`, [shift]);
        await pool.query(`INSERT INTO refunds
            (kind,invoice_id,scope,subtotal_refunded,tax_refunded,amount_refunded,refund_method,user_id)
            SELECT 'refund',invoice_id,'item',2.5,0,2.5,'cash',1 FROM orders WHERE MOD(invoice_id,4)=0`);
        await pool.query(`INSERT INTO refund_items
            (refund_id,order_item_id,product_id,quantity,unit_price,line_subtotal,line_tax,line_total)
            SELECT r.id,oi.id,1,.5,5,2.5,0,2.5 FROM refunds r JOIN order_items oi ON oi.invoice_id=r.invoice_id`);
        await pool.query('ANALYZE TABLE orders,order_items,refunds,refund_items');
        const conn = await pool.getConnection();
        try {
            const before = await readCount(conn);
            expect(await getShiftDiscountsByShift(conn, [shift])).toEqual(expected);
            const rowsRead = (await readCount(conn)) - before;
            // A generous work bound, independent of wall-clock timing or exact plan shape.
            expect(rowsRead).toBeLessThan(selectedCount * 20);
        } finally { conn.release(); }
    });
});
