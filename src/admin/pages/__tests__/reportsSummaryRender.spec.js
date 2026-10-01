import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';

const state = vi.hoisted(() => ({ data: null }));
vi.mock('vue', async original => ({
    ...await original(),
    inject: key => key === 'dailyReportPeriod' ? { startDate: ref('2026-07-18'), endDate: ref('2026-07-18') } : null,
    useSSRContext: () => ({ modules: new Set() }),
}));
vi.mock('../../composables/useDailyReportPage.js', () => ({ useDailyReportPage: () => ({ data: state.data, loading: ref(false), error: ref(null), reload: vi.fn() }) }));
vi.mock('@/shared/i18n.js', () => ({ t: key => key, currentLanguage: ref('en') }));
import ReportsSummary from '../ReportsSummary.vue';

const text = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
async function render() {
    const app = createSSRApp(ReportsSummary);
    app.config.globalProperties.$t = key => key;
    app.component('router-link', { template: '<a><slot /></a>' });
    return renderToString(app);
}
async function section(title) {
    const html = await render();
    const start = html.indexOf(title);
    expect(start, `${title} section rendered`).toBeGreaterThan(-1);
    return text(html.slice(start, html.indexOf('</section>', start)));
}

beforeEach(() => {
    state.data = ref({
        summary: {
            total_orders: 12, average_ticket: 10, sales_processed: 120, refunds_issued: 20, sales_collected: 100,
            expenses_total: 15, remaining_after_expenses: 85, void_value: 7, discounts_total: 5, tax_collected: 16,
            net_revenue_pre_tax: 104, refund_count: 2, refund_order_count: 1, refund_item_count: 1, expense_count: 3,
            drawer_expenses_total: 10, outside_expenses_total: 5, discounted_orders: 2, void_order_count: 1, void_item_count: 1,
        },
        comparison: {}, payments: [], hourly_sales: [], order_types: [],
        cash_status: { state: 'review', closed_shifts: 2, open_shifts: 0, uncounted_shifts: 0, closed_outside_window: 0,
            shortage_total: 3.5, overage_total: 1, net_variance: -2.5, expected_cash: 777.25, actual_cash: 774.75 },
    });
});

describe('ReportsSummary sales story', () => {
    it('walks from total sales to the remainder after returns and expenses', async () => {
        const html = await render();
        const ledger = html.slice(html.indexOf('summary-story__ledger'), html.indexOf('</ol>'));
        const rows = ledger.split('<li').slice(1).map(row => {
            const strong = [...row.matchAll(/<strong[^>]*>([^<]*)<\/strong>/g)].map(match => match[1].trim());
            return [strong[0], strong[strong.length - 1]];
        });
        expect(rows).toEqual([
            ['Total Sales', '120.00 JD'],
            ['Returns Deducted', '-20.00 JD'],
            ['Net Sales After Returns', '100.00 JD'],
            ['Recorded Expenses', '-15.00 JD'],
            ['Sales Remaining After Expenses', '85.00 JD'],
        ]);
    });

    it('breaks down the returns and expenses lines', async () => {
        const html = await render();
        const notes = [...html.matchAll(/<small[^>]*>([\s\S]*?)<\/small>/g)].map(match => text(match[1]));
        expect(notes).toContain('2 Refund Events · 1 Whole-order returns · 1 Selected-item returns');
        expect(notes).toContain('3 expense entries · Cash drawer 10.00 JD · Outside POS 5.00 JD');
    });

    it('shows voids and discounts as already reflected instead of subtracting them again', async () => {
        const context = await section('Already Reflected Above');
        expect(context).toContain('Discounts Given 2 discounted orders · Already included in total sales View discounted orders 5.00 JD');
        expect(context).toContain('Voided Before Payment 1 Whole-order voids · 1 Partial item voids · Not collected as sales 7.00 JD');
    });
});

describe('ReportsSummary cash drawer status', () => {
    it('shows the window shortage, overage and signed net variance', async () => {
        const cash = await section('Cash Drawer Status');
        expect(cash).toContain('2 closed shifts · 0 active open shifts · 0 uncounted shifts');
        expect(cash).toContain('Shortage Total 3.50 JD Overage Total 1.00 JD Net Shift Variance -2.50 JD');
    });

    it('never shows combined drawer balances', async () => {
        const cash = await section('Cash Drawer Status');
        expect(cash).not.toContain('777.25');
        expect(cash).not.toContain('774.75');
    });

    it('reports reconciliation in progress before any shift is closed', async () => {
        state.data.value.cash_status = { state: 'in_progress', closed_shifts: 0, open_shifts: 1, uncounted_shifts: 0, closed_outside_window: 0, net_variance: null };
        const cash = await section('Cash Drawer Status');
        expect(cash).toContain('Reconciliation in progress');
        expect(cash).not.toContain('Net Shift Variance');
    });

    it('explains shifts settled on another business day when none closed in the window', async () => {
        state.data.value.cash_status = { state: 'no_shifts', closed_shifts: 0, open_shifts: 0, uncounted_shifts: 0, closed_outside_window: 3, net_variance: null };
        const cash = await section('Cash Drawer Status');
        expect(cash).toContain('No shifts settled in this report window');
        expect(cash).toContain('Shifts settled on another business day: 3');
    });
});
