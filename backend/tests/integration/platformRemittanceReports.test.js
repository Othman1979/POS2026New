const { seedDatabase, SEED } = require('../fixtures/seed');
const pool = require('../../config/db');
const { insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
const { buildDailySummary } = require('../../services/dailyReportBuilder');
const { buildAuditReportPayload } = require('../../services/auditReportBuilder');

describe('platform reconciliation report contract', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    async function seedTimeline() {
        const invoiceId = await insertPaidOrder(pool, {
            order_type_id: SEED.orderType.id,
            subtotal: 10,
            tax: 0,
            total: 10,
            payment_method: 'platform',
            cash_amount: 0,
            card_amount: 0,
            created_at: '2026-07-30 10:00:00',
            invoice_issued_at: '2026-07-30 10:00:00'
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceId,
            quantity: 1,
            price_at_sale: 10,
            tax_rate: 0,
            tax_amount: 0
        });
        await insertOrderRefund(pool, {
            invoice_id: invoiceId,
            amount_refunded: 2,
            subtotal_refunded: 2,
            tax_refunded: 0,
            refund_method: 'platform',
            created_at: '2026-08-01 10:00:00'
        });

        const [settlement] = await pool.query(`
            INSERT INTO platform_remittances
                (order_type_id, provider_name_at_entry, kind, settled_on, net_received, recorded_by, idempotency_key)
            VALUES (?, 'Dine In', 'settlement', '2026-07-31', 9, ?, 'report-settlement')
        `, [SEED.orderType.id, SEED.adminUser.id]);
        await pool.query(
            'INSERT INTO platform_remittance_lines (remittance_id, invoice_id, allocated_amount) VALUES (?,?,10)',
            [settlement.insertId, invoiceId]
        );
        await pool.query(
            `INSERT INTO platform_remittance_adjustments
                (remittance_id, direction, category, amount, note)
             VALUES (?, 'deduction', 'commission', 1, NULL)`,
            [settlement.insertId]
        );

        const [reversal] = await pool.query(`
            INSERT INTO platform_remittances
                (order_type_id, provider_name_at_entry, kind, settled_on, net_received,
                 reverses_remittance_id, reason, recorded_by, idempotency_key)
            VALUES (?, 'Dine In', 'reversal', '2026-08-02', 9, ?, 'Statement voided', ?, 'report-reversal')
        `, [SEED.orderType.id, settlement.insertId, SEED.adminUser.id]);
        await pool.query(
            'INSERT INTO platform_remittance_lines (remittance_id, invoice_id, allocated_amount) VALUES (?,?,10)',
            [reversal.insertId, invoiceId]
        );
        await pool.query(
            `INSERT INTO platform_remittance_adjustments
                (remittance_id, direction, category, amount, note)
             VALUES (?, 'deduction', 'commission', 1, NULL)`,
            [reversal.insertId]
        );
    }

    it('separates sale-day revenue from settlement-day reconciliation and keeps payment totals unchanged', async () => {
        await seedTimeline();
        const period = parseDailyReportPeriod({ startDate: '2026-07-31', endDate: '2026-07-31' });
        const summary = await buildDailySummary(pool, period);

        expect(summary.platform_reconciliation).toMatchObject({
            start_date: '2026-07-31',
            end_date: '2026-07-31',
            invoice_allocations: 10,
            deductions: 1,
            additions: 0,
            net_received: 9,
            unreconciled_difference: 0,
            settlement_count: 1,
            reversal_count: 0
        });
        expect(summary.payments).not.toContainEqual(expect.objectContaining({ key: 'platform_reconciliation' }));
        expect(summary.summary.cash_collected).toBe(0);
        expect(summary.summary.card_collected).toBe(0);

        const reversalDay = await buildDailySummary(pool, parseDailyReportPeriod({ startDate: '2026-08-02', endDate: '2026-08-02' }));
        expect(reversalDay.platform_reconciliation).toMatchObject({
            invoice_allocations: -10,
            deductions: -1,
            net_received: -9,
            settlement_count: 0,
            reversal_count: 1
        });
    });

    it('carries the same reconciliation object into the audit report payload', async () => {
        await seedTimeline();
        const payload = await buildAuditReportPayload(pool, {
            reportType: 'x_audit',
            businessDate: '2026-07-31',
            generatedByUser: SEED.adminUser
        });
        expect(payload.platform_reconciliation).toMatchObject({
            start_date: '2026-07-31',
            end_date: '2026-07-31',
            invoice_allocations: 10,
            deductions: 1,
            net_received: 9
        });
        expect(payload.payments.total_collected).toBe(0);
    });
});
