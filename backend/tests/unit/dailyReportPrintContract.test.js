const printRouter = require('../../routes/print');

function validSummaryPayload() {
    return {
        print_type: 'daily_summary_report',
        report_id: 'client-controlled',
        language: 'en',
        period: {
            start_date: '2026-07-14',
            end_date: '2026-07-14',
            business_day_start_hour: 6,
        },
        summary: { sales_collected: 20, refunds_issued: 2 },
        payments: [{ key: 'cash', amount: 18 }],
        cash_status: {
            state: 'balanced',
            open_shifts: 0,
            closed_shifts: 2,
            closed_outside_window: 0,
            uncounted_shifts: 0,
            shifts_needing_review: 0,
            net_variance: 0,
            shortage_total: 0,
            overage_total: 0,
        },
    };
}

describe('daily report thermal payload contract', () => {
    it('derives trusted report identity and the 80mm period label from the period', () => {
        const cleaned = printRouter.sanitizePrintData(validSummaryPayload());

        expect(cleaned.report_id).toBe('daily_summary_report:2026-07-14:2026-07-14');
        expect(cleaned.period.window_label).toBe('2026-07-14 06:00 → 2026-07-15 05:59');
        expect(cleaned.direction).toBe('ltr');
    });

    it('rejects malformed financial numbers instead of silently printing zero', () => {
        const payload = validSummaryPayload();
        payload.summary.sales_collected = 'twenty';

        expect(() => printRouter.sanitizePrintData(payload)).toThrow(/sales_collected/);
    });

    it('validates summary reconciliation detail fields as numbers', () => {
        const payload = validSummaryPayload();
        payload.summary.refund_item_count = 'one';

        expect(() => printRouter.sanitizePrintData(payload)).toThrow(/refund_item_count/);
    });

    it.each([
        'open_shifts',
        'closed_shifts',
        'closed_outside_window',
        'uncounted_shifts',
        'shifts_needing_review',
        'net_variance',
        'net_variance_total',
        'shortage_total',
        'overage_total',
        'cash_expenses_total',
    ])('rejects a malformed cash-status %s value', field => {
        const payload = validSummaryPayload();
        payload.cash_status[field] = 'invalid';

        expect(() => printRouter.sanitizePrintData(payload)).toThrow(new RegExp(field));
    });

    it('allows unavailable reconciliation money to remain null', () => {
        const payload = validSummaryPayload();
        payload.cash_status.net_variance = null;
        payload.cash_status.shortage_total = null;
        payload.cash_status.overage_total = null;

        expect(printRouter.sanitizePrintData(payload).cash_status).toMatchObject({
            net_variance: null,
            shortage_total: null,
            overage_total: null,
        });
    });

    it('rejects invalid report dates', () => {
        const payload = validSummaryPayload();
        payload.period.start_date = '2026-02-30';

        expect(() => printRouter.sanitizePrintData(payload)).toThrow(/period/i);
    });

    it('rejects unknown tender and event enum values', () => {
        const tenderPayload = validSummaryPayload();
        tenderPayload.payments[0].key = 'crypto';
        expect(() => printRouter.sanitizePrintData(tenderPayload)).toThrow(/payment key/i);

        const eventPayload = validSummaryPayload();
        eventPayload.events = [{ kind: 'delete', refund_method: 'cash', event_value: 1 }];
        expect(() => printRouter.sanitizePrintData(eventPayload)).toThrow(/event kind/i);
    });

    it('rejects retired receivable collection tender rows', () => {
        const payload = validSummaryPayload();
        payload.payments.push(
            { key: 'subscription_receivable_cash_collections', amount: 12 },
            { key: 'subscription_receivable_card_collections', amount: 8 }
        );

        expect(() => printRouter.sanitizePrintData(payload)).toThrow(/payment key/i);
    });

    it('sanitizes the bounded platform reconciliation block without folding it into tenders', () => {
        const payload = validSummaryPayload();
        payload.platform_reconciliation = {
            start_date: '2026-07-31',
            end_date: '2026-07-31',
            positive_allocations: 10,
            provider_credits_applied: 0,
            invoice_allocations: 10,
            deductions: 1,
            additions: 0,
            net_received: 9,
            computed_net: 9,
            unreconciled_difference: 0,
            settlement_count: 1,
            reversal_count: 0,
            adjustments_by_category: { commission: 1 },
            deductions_by_category: { commission: 1 },
            additions_by_category: { reimbursement: 0 }
        };
        const cleaned = printRouter.sanitizePrintData(payload);
        expect(cleaned.platform_reconciliation.net_received).toBe(9);
        expect(cleaned.platform_reconciliation.deductions_by_category).toMatchObject({ commission: 1, correction: 0 });
        expect(cleaned.platform_reconciliation.additions_by_category).toMatchObject({ reimbursement: 0, correction: 0 });
        expect(cleaned.payments).toEqual(payload.payments);
    });

    it('rejects non-finite reconciliation money instead of printing it', () => {
        const payload = validSummaryPayload();
        payload.platform_reconciliation = {
            start_date: '2026-07-31',
            end_date: '2026-07-31',
            net_received: '9.00'
        };
        expect(() => printRouter.sanitizePrintData(payload)).toThrow(/net_received/);
    });
});
