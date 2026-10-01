import { describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

vi.mock('@/shared/i18n.js', () => ({ t: key => key, setLanguage: vi.fn() }));
import PrintReceiptApp from '../PrintReceiptApp.vue';

async function renderText(printType, data = {}) {
    const app = createSSRApp({
        ...PrintReceiptApp,
        setup() {
            const bindings = PrintReceiptApp.setup();
            bindings.printType.value = printType;
            bindings.data.value = data;
            return bindings;
        },
    });
    app.config.globalProperties.$t = key => key;
    const html = await renderToString(app);
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const PLATFORM_RECONCILIATION = {
    positive_allocations: 128.2,
    provider_credits_applied: 4,
    invoice_allocations: 124.2,
    deductions: 10,
    deductions_by_category: { Commission: 6, Delivery: 4 },
    additions: 2.5,
    additions_by_category: { Adjustment: 2.5 },
    net_received: 120.7,
    settlement_count: 3,
    reversal_count: 1,
};

describe('PrintReceiptApp report print branches', () => {
    it.each([
        ['z_report', 'END OF SHIFT (Z-REPORT)'],
        ['x_report', 'MID-SHIFT AUDIT (X-REPORT)'],
    ])('prints the full %s shift payload once', async (printType, title) => {
        const text = await renderText(printType, {
            shift_id: 14,
            gross_sales: 250,
            platform_sales: 40.5,
            total_discounts: 3.25,
            starting_cash: 50,
            expected_cash: 180,
            order_type_breakdown: [{ order_type_name: 'Dine In', total_sales: 209.5 }],
            platform_order_type_breakdown: [{ order_type_name: 'Talabat', total_sales: 40.5 }],
        });

        expect(text.split(title)).toHaveLength(2);
        expect(text).toContain('Platform Sales (Not Collected) 40.50 JD');
        expect(text).toContain('Discounts Applied -3.25 JD');
        expect(text).toContain('Starting Float 50.00 JD');
        expect(text).toContain('SALES BY ORDER TYPE Dine In 209.50 JD');
        expect(text).toContain('PLATFORM RECEIVABLES BY PROVIDER Talabat 40.50 JD');
    });

    it.each([
        ['daily_summary_report', 'Daily Summary Report'],
        ['daily_sales_report', 'Daily Sales Report'],
        ['daily_refunds_report', 'Daily Refunds Report'],
        ['daily_expenses_report', 'Daily Expenses Report'],
    ])('renders the %s thermal print type in browser mode', async (printType, title) => {
        expect(await renderText(printType, { summary: {} })).toContain(title);
    });

    it.each(['daily_report', 'report_overview', 'report_products', 'report_tables', 'report_staff', 'report_invoices', 'report_shifts'])(
        'prints nothing for the removed %s type',
        async (printType) => {
            expect(await renderText(printType)).toBe(await renderText(''));
        }
    );

    it('prints the backend daily summary contract and ignores removed presentation fields', async () => {
        const text = await renderText('daily_summary_report', {
            summary: {
                refunds_issued: 12.5,
                net_revenue_pre_tax: 300,
                service_charges_collected: 7.25,
                total_orders: 42,
                average_ticket: 8.1,
                discounted_orders: 5,
                refund_count: 2,
                void_count: 1,
                refund_total: 999.11,
                net_revenue: 999.22,
                service_charge: 999.33,
            },
            cash_status: { state: 'balanced', closed_shifts: 2, open_shifts: 0, uncounted_shifts: 1, closed_outside_window: 3, shortage_total: 4, overage_total: 1.5, net_variance: -2.5, collected: 999.44, expected_cash: 999.45, actual_cash: 999.46, variance: 999.47 },
            orders: { total: 999.55 },
            exceptions: { count: 999 },
        });

        for (const line of [
            'Refunds Issued -12.50 JD',
            'Net Revenue 300.00 JD',
            'Service Charge 7.25 JD',
            'Total Orders 42',
            'Avg Ticket Size 8.10 JD',
            'Discounted Orders 5',
            'Refund Events 2',
            'Void Events 1',
            'uncounted shifts 1',
            'Shifts settled on another business day 3',
            'Shortage Total 4.00 JD',
            'Overage Total 1.50 JD',
            'Net Shift Variance -2.50 JD',
        ]) {
            expect(text).toContain(line);
        }
        expect(text).not.toContain('999');
    });

    it('shows reconciliation in progress instead of variance totals before any shift closes', async () => {
        const text = await renderText('daily_summary_report', {
            summary: {},
            cash_status: { state: 'in_progress', closed_shifts: 0, open_shifts: 1, net_variance: 0 },
        });

        expect(text).toContain('Reconciliation in progress');
        expect(text).not.toContain('Net Shift Variance');
    });

    it('prints platform payouts with signed deductions and additions in the daily summary', async () => {
        const text = await renderText('daily_summary_report', { summary: {}, cash_status: {}, platform_reconciliation: PLATFORM_RECONCILIATION });

        for (const line of [
            'Positive Allocations 128.20 JD',
            'Provider Credits Applied 4.00 JD',
            'Invoice Allocations 124.20 JD',
            'Deductions -10.00 JD Commission -6.00 JD Delivery -4.00 JD',
            'Additions 2.50 JD Adjustment +2.50 JD',
            'Net Received 120.70 JD',
            'Settlement count / Reversal count 3 / 1',
        ]) {
            expect(text).toContain(line);
        }
    });

    it('prints platform payouts with signed deductions and additions in the audit report', async () => {
        const text = await renderText('audit_report', { report_type: 'z_audit', platform_reconciliation: PLATFORM_RECONCILIATION });

        for (const line of [
            'دفعات منصات التوصيل',
            'التخصيصات الموجبة 128.20 د.أ',
            'أرصدة مزود الخدمة المستخدمة 4.00 د.أ',
            'تخصيصات الفواتير 124.20 د.أ',
            'الخصومات -10.00 د.أ Commission -6.00 د.أ Delivery -4.00 د.أ',
            'الإضافات 2.50 د.أ Adjustment +2.50 د.أ',
            'صافي المستلم 120.70 د.أ',
            'التسويات / الإلغاءات 3 / 1',
        ]) {
            expect(text).toContain(line);
        }
    });

    it('prints one audit block per shift and no legacy aggregate drawer totals', async () => {
        const text = await renderText('audit_report', {
            report_type: 'z_audit',
            shifts: [
                { shift_id: 1, cashier_name: 'Ali', status: 'closed', starting_cash: 20, expected_cash: 120, actual_cash: 120, variance: 0 },
                { shift_id: 2, cashier_name: 'Sara', status: 'open', starting_cash: 30, expected_cash: 75 },
            ],
            cash_reconciliation: { starting_cash_total: 777.01, expected_cash_total: 777.02, actual_cash_total: 777.03, variance_total: 777.04 },
        });

        expect(text).toContain('#1 — Ali مغلقة');
        expect(text).toContain('#2 — Sara مفتوحة — غير مجرودة');
        expect(text.split('نشاط ضمن نافذة التقرير')).toHaveLength(3);
        expect(text.split('أرصدة المناوبة عند الإغلاق')).toHaveLength(3);
        expect(text).not.toContain('777');
    });

    it('prints the cash equation only for a shift that ran inside the report window', async () => {
        const text = await renderText('audit_report', {
            report_type: 'z_audit',
            shifts: [
                { shift_id: 1, cashier_name: 'Ali', status: 'closed', within_window: true, starting_cash: 20, cash_sales: 110, cash_expenses: 10, expected_cash: 120, actual_cash: 120, variance: 0 },
                { shift_id: 2, cashier_name: 'Sara', status: 'open', starting_cash: 30, expected_cash: 75 },
            ],
        });
        const [aliBlock, saraBlock] = text.split('#2 — Sara');

        expect(aliBlock).toContain('+ المبيعات النقدية بعد المرتجعات 110.00 د.أ - مصروفات الصندوق 10.00 د.أ = النقد المتوقع 120.00 د.أ');
        expect(saraBlock).toContain(' النقد المتوقع 75.00 د.أ');
        expect(saraBlock).not.toContain('= النقد المتوقع');
    });
});
