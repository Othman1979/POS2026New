import { describe, expect, it } from 'vitest';
import { buildProductProfitPrintHtml } from '../productProfitPrint.js';

const report = {
    period: { start_date: '2026-10-01', end_date: '2026-10-01' },
    totals: { net_sales: 15, known_cost: 9, profit: 6, margin_pct: 40 },
};
const helpers = {
    t: (label) => label,
    money: (value) => (value === null ? '—' : Number(value).toFixed(2)),
    number: (value) => String(value),
    percent: (value) => (value === null ? '—' : `${value}%`),
    sourceLabel: { purchase_average: 'Purchase average', product_cost: 'Product cost price', unknown: 'No cost' },
};

describe('buildProductProfitPrintHtml', () => {
    it('renders escaped product rows, totals, and direction', () => {
        const html = buildProductProfitPrintHtml({
            ...helpers,
            report,
            rtl: true,
            products: [{
                item_name: '<b>Cola</b>', category_name: 'Drinks', sold_qty: 4, returned_qty: 1, net_qty: 3,
                net_sales: 15, unit_cost: 3, cost_source: 'purchase_average', cost: 9, profit: -1, margin_pct: 40,
            }],
        });

        expect(html).toContain('dir="rtl"');
        expect(html).toContain('&lt;b&gt;Cola&lt;/b&gt;');
        expect(html).not.toContain('<b>Cola</b>');
        expect(html).toContain('Purchase average');
        expect(html).toContain('class="loss"');
        expect(html).toContain('<td class="num">9.00</td>');
    });

    it('shows the empty state when the period has no sales', () => {
        const html = buildProductProfitPrintHtml({ ...helpers, report, rtl: false, products: [] });
        expect(html).toContain('dir="ltr"');
        expect(html).toContain('No sales in this period.');
    });
});
