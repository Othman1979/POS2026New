import { describe, expect, it } from 'vitest';
import { reportPrintHtml, tableReportHtml } from '../reportExport.js';

describe('report PDF export page', () => {
    it('wraps the shown report with an escaped title, period and A4 page rules', () => {
        const html = reportPrintHtml({ innerHTML: '<table><tr><td>12.50</td></tr></table>' }, { title: 'Sales <details>', period: '2026-10-01', rtl: true });
        expect(html).toContain('<html lang="ar" dir="rtl">');
        expect(html).toContain('<h1>Sales &lt;details&gt;</h1>');
        expect(html).toContain('2026-10-01');
        expect(html).toContain('@page { size: A4');
        expect(html).toContain('<td>12.50</td>');
    });

    it('renders an empty body when the report has not loaded', () => {
        expect(reportPrintHtml(null, { title: 'Refunds', period: '', rtl: false })).toContain('<html lang="en" dir="ltr">');
    });
});

describe('table report PDF page', () => {
    it('renders a headed A4 table with escaped cells, right-aligned numbers and a row count', () => {
        const html = tableReportHtml(['Item', 'Balance'], [['Cola <can>', '24'], ['Rice', '12.5']], { title: 'Stock levels', period: '2026-10-02', rtl: true, numeric: [1], footer: '2 Items' });
        expect(html).toContain('<html lang="ar" dir="rtl">');
        expect(html).toContain('<thead><tr><th>Item</th><th class="num">Balance</th></tr></thead>');
        expect(html).toContain('<td>Cola &lt;can&gt;</td><td class="num">24</td>');
        expect(html).toContain('<footer>2 Items</footer>');
        expect(html).toContain('@page { size: A4');
    });
});
