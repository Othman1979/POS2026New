import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const { buildReportDocuments } = createRequire(import.meta.url)('../../../pos-spooler-printer/v2/report-typst.js');
const nativeReport = (print_type, data) => buildReportDocuments({ print_type, data }).map(page => page.source).join('\n');

const read = path => readFileSync(resolve(process.cwd(), path), 'utf8');
const expectOrdered = (source, anchors) => {
    let cursor = -1;
    for (const anchor of anchors) {
        const next = source.indexOf(anchor, cursor + 1);
        expect(next, `Expected ${anchor} after ${anchors[Math.max(0, anchors.indexOf(anchor) - 1)]}`).toBeGreaterThan(cursor);
        cursor = next;
    }
};

describe('admin browser report print design', () => {
    it('loads the self-hosted font and selects one print page rule at runtime', () => {
        const html = read('print_receipt.html');
        const css = read('src/print.css');
        const app = read('src/print/PrintReceiptApp.vue');

        expect(html).toContain('/assets/css/fonts.css');
        expect(css).not.toMatch(/@page\s*\{/);
        expect(css).toContain('html[data-print-layout="thermal"] body');
        expect(css).toContain('html[data-print-layout="a4"] body');
        expect(app).toContain("'@page { size: A4 portrait; margin: 22mm 12mm 16mm; }'");
        expect(app).toContain("'@page { size: 80mm auto; margin: 0; }'");
    });

    it('keeps explicit audit-sheet bands inside a zero-margin A4 page', () => {
        const app = read('src/print/PrintReceiptApp.vue');
        const a4 = read('src/print/AdminReportA4.vue');

        expect(app).toContain("printType === 'audit_report'");
        expect(app).toContain("'@page { size: A4 portrait; margin: 0; }'");
        expect(a4).toContain('min-height: 297mm');
        expect(a4).toContain('padding: 22mm 12mm 16mm');
        expect(a4).toContain('top: 12mm');
        expect(a4).toContain('bottom: 8mm');
    });

    it('keeps thermal reports proportional to the approved V2 output', () => {
        const css = read('src/print.css');
        const app = read('src/print/PrintReceiptApp.vue');

        expect(css).toContain('--u: calc(70mm / 556)');
        expect(css).toContain("Tahoma, 'Segoe UI', Arial");
        expect(css).toContain("'Helvetica Neue', Helvetica, Arial");
        expect(css).toContain('.report-major-rule');
        expect(css).toContain('.report-minor-rule');
        expect(app).toContain('thermal-report');
        expect(app).not.toContain("font-family: 'Cairo'");
    });

    it('pins the complete X/Z browser branch and its approved V2 section order', () => {
        const app = read('src/print/PrintReceiptApp.vue');
        const browserXz = app.slice(
            app.indexOf("printType === 'z_report' || printType === 'x_report'"),
            app.indexOf('<!-- DAILY SUMMARY REPORT -->')
        );
        const v2Xz = nativeReport('z_report', { platform_sales: 5, platform_order_type_breakdown: [{ order_type_name: 'Delivery', total_sales: 5 }], order_type_breakdown: [{ order_type_name: 'Dine In', total_sales: 10 }], actual_cash: 10 });
        const fields = [
            'platform_sales',
            'total_discounts',
            'starting_cash',
            'order_type_breakdown',
            'platform_order_type_breakdown',
        ];
        const sections = ['Sales Summary', 'Tender Breakdown', 'Platform Receivables by Provider', 'Sales by Order Type', 'Cash Drawer Audit'];

        expect(app.match(/printType === 'z_report' \|\| printType === 'x_report'/g)).toHaveLength(1);
        for (const field of fields) expect(browserXz).toContain(field);
        expectOrdered(browserXz.toLowerCase(), sections.map(section => section.toLowerCase()));
        expectOrdered(v2Xz.toLowerCase(), sections.map(section => section.toLowerCase()));
    });

    it('keeps the shared audit and Items/Y sections in V2 order', () => {
        const app = read('src/print/PrintReceiptApp.vue');
        const browserAudit = app.slice(app.indexOf("printType === 'audit_report'"), app.indexOf("['category_items_report", app.indexOf("printType === 'audit_report'")));
        const v2Audit = nativeReport('audit_report', { language: 'ar', shifts: [{ status: 'closed', actual_cash: 10, variance: 0 }], order_types: [{ name: 'Dine In', net_sales: 10 }] });
        const browserItems = app.slice(app.indexOf("['category_items_report"), app.indexOf('\n</template>\n\n<script>'));
        const v2Items = nativeReport('category_items_report', { categories: [{ category_name: 'Food', qty_sold: 1, gross_revenue: 10 }], subcategories: [{ category_name: 'Meal', qty_sold: 1, gross_revenue: 10 }], items: [{ item_name: 'Lunch', qty_sold: 1, gross_revenue: 10 }] });
        const browserAuditSections = ['ملخص المبيعات', 'المدفوعات', 'نتيجة مراجعة المناوبات', 'المناوبات', 'أنواع الطلبات'];
        const v2AuditSections = ['ملخص المبيعات', 'المدفوعات', 'نتيجة مراجعة المناوبات', 'المناوبات', 'أنواع الطلبات'];
        const itemSections = ['المجموعات', 'التصنيفات الفرعية', 'الأصناف'];

        expectOrdered(browserAudit, browserAuditSections);
        expectOrdered(v2Audit, v2AuditSections);
        expectOrdered(browserItems, itemSections);
        expectOrdered(v2Items, itemSections);
    });

    it('prints each audit shift as its own thermal reconciliation with business-clock timestamps', () => {
        const app = read('src/print/PrintReceiptApp.vue');
        const browserAudit = app.slice(app.indexOf("printType === 'audit_report'"), app.indexOf("['category_items_report", app.indexOf("printType === 'audit_report'")));

        for (const field of [
            'shift.opened_at',
            'shift.closed_at',
            'shift.starting_cash',
            'shift.cash_sales',
            'shift.cash_expenses',
            'shift.expected_cash',
            'shift.actual_cash',
            'shift.variance',
        ]) {
            expect(browserAudit).toContain(field);
        }
        expect(browserAudit).toContain('formatAuditDateTime');
        expect(browserAudit).toContain('auditShiftReview');
        expect(browserAudit).toContain('v-if="data.payload_hash"');
        expect(browserAudit).not.toContain('v-if="!data.is_period"');
        expect(browserAudit).not.toContain('data.is_period ? data.generated_at');
        expect(browserAudit.match(/formatAuditDateTime\(data\.generated_at\)/g)).toHaveLength(2);
    });

    it('uses the same complete shift detail block for period and X/Z reports', () => {
        const app = read('src/print/PrintReceiptApp.vue');
        const auditStart = app.indexOf("printType === 'audit_report'");
        const auditEnd = app.indexOf("['category_items_report", auditStart);
        const auditBranch = app.slice(auditStart, auditEnd);
        const shiftStart = auditBranch.indexOf('<div v-for="shift in data.shifts || []"');
        const shiftEnd = auditBranch.indexOf('<div class="dashed-line"></div>', shiftStart);
        const shiftDetails = auditBranch.slice(shiftStart, shiftEnd);

        expect(auditEnd).toBeGreaterThan(auditStart);
        expect(shiftStart).toBeGreaterThan(-1);
        expect(shiftEnd).toBeGreaterThan(shiftStart);
        expect(auditBranch.match(/v-for="shift in data\.shifts/g)).toHaveLength(1);
        expect(shiftDetails).not.toContain('data.is_period');
        for (const field of [
            'shift.gross_sales',
            'shift.cash_sales',
            'shift.card_sales',
            'shift.cash_expenses',
            'shift.line_discounts',
            'shift.order_discounts',
            'shift.refund_count',
            'shift.refund_value',
            'shift.void_count',
            'shift.void_value',
            'shift.expected_cash',
            'shift.actual_cash',
            'shift.variance',
        ]) {
            expect(shiftDetails).toContain(field);
        }
    });

    it('renders A4 only for the included admin report types with real paged-media semantics', () => {
        const app = read('src/print/PrintReceiptApp.vue');
        const a4 = read('src/print/AdminReportA4.vue');
        const reportTypes = [
            'daily_summary_report',
            'daily_sales_report',
            'daily_refunds_report',
            'daily_expenses_report',
            'x_report',
            'z_report',
            'audit_report',
            'category_items_report',
            'y_held_items_report'
        ];

        expect(app).toContain('<AdminReportA4');
        expect(app).toContain('isA4AdminReport');
        for (const type of reportTypes) expect(app).toContain(`'${type}'`);
        expect(a4).toContain('IBM Plex Sans Arabic');
        expect(a4).toContain('display: table-header-group');
        expect(a4).toContain('break-inside: avoid');
        expect(a4).toContain('unicode-bidi: isolate');
        expect(a4).not.toMatch(/page\s+n\s+of\s+m/i);
        expect(a4).not.toContain('table-footer-group');
    });

    it('covers every report ledger and shows audit-only metadata conditionally', () => {
        const a4 = read('src/print/AdminReportA4.vue');
        for (const section of [
            'summary', 'payments', 'platform_reconciliation', 'comparison', 'order_types',
            'hourly_sales', 'cash_status', 'categories', 'products', 'cashiers', 'waiters',
            'tables', 'by_staff', 'top_reasons', 'events', 'by_source', 'by_category',
            'entries', 'cash_reconciliation', 'shifts', 'subcategories', 'items', 'orders'
        ]) {
            expect(a4).toContain(section);
        }
        expect(a4).toContain('hasAuditMetadata');
        expect(a4).toContain('data.payload_hash');
        expect(a4).toContain('data.serial_label');
    });

    it('keeps English-only A4 X/Z reports LTR regardless of the admin language', () => {
        const a4 = read('src/print/AdminReportA4.vue');
        expect(a4).toContain("const isEnglishOnlyReport = computed(() => ['x_report', 'z_report'].includes(props.printType));");
        expect(a4).toContain('if (isEnglishOnlyReport.value) return false;');
        expect(a4).toContain(':data-no-i18n="isEnglishOnlyReport ? \'\' : null"');
    });

    it('clears the metric divider at the start of every four-column row', () => {
        const a4 = read('src/print/AdminReportA4.vue');
        expect(a4).toContain('.metric:nth-child(4n+1)');
        expect(a4).not.toContain('.metric:first-child');
    });

    // A4 ledger rows are built from named field specs. The alternative - walking the
    // payload and deriving a label from the key - printed "net sales pre tax" into an
    // Arabic audit and rendered refund_rate, a percentage, as "2.66 JD".
    it('names and types every ledger field instead of deriving them from payload keys', () => {
        const a4 = read('src/print/AdminReportA4.vue');
        expect(a4).not.toContain("replaceAll('_', ' ')");
        expect(a4).not.toContain('keyValueRows');
        expect(a4).toContain("field('refund_rate', 'Refund rate', 'نسبة المرتجعات', 'percent')");
        expect(a4).toContain("type FieldKind = 'money' | 'count' | 'percent' | 'text'");
    });

    // The specs must keep up with the builders. Reading the builder's own object
    // literal is what makes a newly added server field fail here rather than vanish
    // from the printed audit or arrive labelled with its machine name.
    it('covers every audit summary and payment field the builder produces', () => {
        const a4 = read('src/print/AdminReportA4.vue');
        const builder = read('backend/services/auditReportBuilder.js');

        const blockKeys = (source, name) => {
            const start = source.indexOf(`${name}: {`);
            expect(start).toBeGreaterThan(-1);
            let depth = 0;
            let end = start + name.length + 1;
            for (; end < source.length; end += 1) {
                if (source[end] === '{') depth += 1;
                if (source[end] === '}') { depth -= 1; if (depth === 0) break; }
            }
            return [...source.slice(start, end).matchAll(/^\s{12}([a-z_]+):/gm)].map(match => match[1]);
        };
        for (const block of ['summary', 'payments']) {
            const produced = blockKeys(builder, block);
            expect(produced.length).toBeGreaterThan(0);
            for (const key of produced) expect(a4).toContain(`${block}?.${key}`);
        }
    });
});
