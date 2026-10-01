const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const service = require('../../services/PlatformRemittanceService');
const { insertPaidOrder, insertOrderRefund } = require('../helpers/fixtures');

describe('PlatformRemittanceService against MariaDB', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    async function invoice(total, orderTypeId = SEED.orderType.id, paymentMethod = 'platform') {
        return insertPaidOrder(pool, {
            order_type_id: orderTypeId, payment_method: paymentMethod,
            subtotal: total, tax: 0, total, cash_amount: 0, card_amount: 0,
        });
    }

    async function settlement(invoiceId, amount, { reversalOf = null, providerId = SEED.orderType.id } = {}) {
        const [header] = await pool.query(`INSERT INTO platform_remittances
            (order_type_id,provider_name_at_entry,kind,settled_on,net_received,reverses_remittance_id,reason,recorded_by,idempotency_key)
            VALUES (?,'Snapshot provider',?,'2026-07-01',?,?,?,?,UUID())`,
        [providerId, reversalOf ? 'reversal' : 'settlement', Math.max(amount, 0), reversalOf, reversalOf ? 'Fixture reversal' : null, SEED.adminUser.id]);
        if (invoiceId != null) await pool.query('INSERT INTO platform_remittance_lines(remittance_id,invoice_id,allocated_amount) VALUES (?,?,?)', [header.insertId, invoiceId, amount]);
        return header.insertId;
    }

    it('preserves separate debts and credits, cents, reversals, inactive and remittance-only providers', async () => {
        const credited = await invoice(10);
        await settlement(credited, 4);
        await insertOrderRefund(pool, { invoice_id: credited, refund_method: 'platform', amount_refunded: 7 });
        const positive = await invoice(5.07);
        await insertOrderRefund(pool, { invoice_id: positive, refund_method: 'platform', amount_refunded: 0.04 });
        await insertOrderRefund(pool, { invoice_id: positive, refund_method: 'platform', amount_refunded: 0.03 });
        const reversed = await settlement(positive, 1.11);
        await settlement(positive, 2.22);
        await settlement(positive, 1.11, { reversalOf: reversed });
        await settlement(await invoice(2), 2);

        const [archived] = await pool.query("INSERT INTO order_types(name,is_active) VALUES ('Archived provider',0)");
        await invoice(0.01, archived.insertId);
        await invoice(0.02, archived.insertId);
        await invoice(100, archived.insertId, 'cash');
        await invoice(99, null);
        const [remittanceOnly] = await pool.query("INSERT INTO order_types(name,is_active) VALUES ('',1)");
        await settlement(null, 0, { providerId: remittanceOnly.insertId });
        expect(await service.listProviders(pool)).toEqual([
            { order_type_id: SEED.orderType.id, provider_name: SEED.orderType.name, is_active: true, gross_due: 2.78, provider_credit: 1, net_outstanding: 1.78 },
            { order_type_id: archived.insertId, provider_name: 'Archived provider', is_active: false, gross_due: 0.03, provider_credit: 0, net_outstanding: 0.03 },
            { order_type_id: remittanceOnly.insertId, provider_name: 'Snapshot provider', is_active: true, gross_due: 0, provider_credit: 0, net_outstanding: 0 },
        ]);
    });

    it.each(['platform refund', 'previous allocation', 'open amount'])('keeps the per-invoice %s limit', async field => {
        const id = await invoice(99999999.99);
        if (field === 'platform refund') {
            for (let i = 0; i < 2; i++) await insertOrderRefund(pool, { invoice_id: id, refund_method: 'platform', amount_refunded: 99999999.99 });
        } else if (field === 'previous allocation') {
            for (let i = 0; i < 2; i++) await settlement(id, 99999999.99);
        } else {
            await settlement(id, -99999999.99);
        }
        await expect(service.listProviders(pool)).rejects.toMatchObject({
            publicCode: 'PLATFORM_REMITTANCE_INVALID_AMOUNT', message: `Invalid ${field}.`,
        });
    });

    it('allows a provider total larger than the individual invoice limit and handles empty data', async () => {
        expect(await service.listProviders(pool)).toEqual([]);
        await invoice(99999999.99);
        await invoice(99999999.99);
        expect((await service.listProviders(pool))[0]).toMatchObject({ gross_due: 199999999.98, provider_credit: 0, net_outstanding: 199999999.98 });
    });

    it('returns summary-sized database results as invoice history grows', async () => {
        const [second] = await pool.query("INSERT INTO order_types(name,is_active) VALUES ('Second provider',1)");
        await pool.query(`INSERT INTO orders(user_id,order_type_id,subtotal,tax,total,payment_method,cash_amount,card_amount)
            VALUES ?`, [Array.from({ length: 500 }, (_, index) => [2, index % 2 ? second.insertId : SEED.orderType.id, 10, 0, 10, 'platform', 0, 0])]);
        let queries = 0;
        let returnedRows = 0;
        const executor = {
            async query(sql, params) {
                const result = await pool.query(sql, params);
                queries++;
                returnedRows += result[0].length;
                return result;
            },
        };
        const providers = await service.listProviders(executor);
        expect(providers).toHaveLength(2);
        expect(providers.map(row => row.net_outstanding)).toEqual([2500, 2500]);
        expect(queries).toBeLessThanOrEqual(2);
        expect(returnedRows).toBeLessThanOrEqual(4);
    });

    it('derives a provider credit after a later platform refund without multiplying child rows', async () => {
        const [order] = await pool.query(`
            INSERT INTO orders
                (invoice_number,user_id,order_type_id,subtotal,tax,total,payment_method,
                 invoice_issued_at,created_at,cash_amount,card_amount,amount_tendered,change_due)
            VALUES (9101,?,?,10,0,10,'platform','2026-08-01 10:00:00','2026-08-01 10:00:00',0,0,0,0)
        `, [SEED.adminUser.id, SEED.orderType.id]);
        const invoiceId = Number(order.insertId);
        const [remittance] = await pool.query(`
            INSERT INTO platform_remittances
                (order_type_id,provider_name_at_entry,settled_on,net_received,recorded_by,idempotency_key)
            VALUES (?, 'Dine In', '2026-08-02', 4, ?, 'integration-platform-credit')
        `, [SEED.orderType.id, SEED.adminUser.id]);
        await pool.query(
            'INSERT INTO platform_remittance_lines (remittance_id,invoice_id,allocated_amount) VALUES (?,?,4)',
            [remittance.insertId, invoiceId]
        );
        await pool.query(`
            INSERT INTO refunds
                (kind,invoice_id,scope,amount_refunded,refund_method,user_id,reason)
            VALUES ('refund',?,'order',7,'platform',?,'provider refund')
        `, [invoiceId, SEED.adminUser.id]);

        const receivables = await service.listReceivables(pool, SEED.orderType.id);
        expect(receivables).toHaveLength(1);
        expect(receivables[0]).toMatchObject({
            invoice_id: invoiceId,
            net_platform_sale: 3,
            previous_allocations: 4,
            open_amount: -1
        });

        const providers = await service.listProviders(pool);
        expect(providers.find(row => row.order_type_id === SEED.orderType.id)).toMatchObject({
            provider_name: 'Dine In',
            gross_due: 0,
            provider_credit: 1,
            net_outstanding: -1
        });

        const range = await service.getRangeTotals(pool, {
            startDate: '2026-08-02',
            endDate: '2026-08-02',
            orderTypeId: SEED.orderType.id
        });
        expect(range).toMatchObject({
            invoice_allocations: 4,
            net_received: 4,
            computed_net: 4,
            unreconciled_difference: 0,
            settlement_count: 1,
            reversal_count: 0
        });
    });
});
