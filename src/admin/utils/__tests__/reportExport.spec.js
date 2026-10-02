import { describe, expect, it } from 'vitest';
import { reportPrintHtml } from '../reportExport.js';

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
