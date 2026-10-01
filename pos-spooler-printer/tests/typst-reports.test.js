'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { supportsReport, buildReportDocuments } = require('../v2/report-typst');
const { reconciliationFrom, summarizeAuditShifts } = require('../v2/report-data');
const { jobs: representativeJobs } = require('./fixtures/typst-reports.cjs');
const pinnedFonts = process.env.SPOOLER_TYPST_FONT_DIR || path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'fonts');

function sources(type, data) {
    const job = { print_type: type, data };
    assert(supportsReport(job), `${type} should use the native renderer`);
    const docs = buildReportDocuments(job);
    assert(docs.length > 0);
    for (const doc of docs) {
        assert.equal(doc.width, 576);
        assert.deepEqual(doc.assets, []);
        assert.match(doc.source, /height: auto/);
        assert.match(doc.source, /bottom: 60pt/);
    }
    return docs;
}
function content(type, data) { return sources(type, data).map(doc => doc.source).join('\n'); }
function hasAll(source, ...values) { for (const value of values) assert(source.includes(value), `Missing ${value}`); }

const shift = {
    storeInfo: { store_name: 'Test Store' }, shift_id: 7, gross_sales: 150, platform_sales: 30,
    total_discounts: 5, cash_sales: 80, card_sales: 40, cash_expenses: 8,
    starting_cash: 20, expected_cash: 92, actual_cash: 90,
    platform_order_type_breakdown: [{ order_type_name: 'Delivery', total_sales: 30 }],
    order_type_breakdown: [{ order_type_name: 'Dine In', total_sales: 100 }],
    expense_categories: [{ category_name: 'Supplies', count: 1, total: 8 }]
};
for (const type of ['x_report', 'z_report']) {
    const src = content(type, shift);
    hasAll(src, 'TEST STORE', '150.00 JD', '30.00 JD', 'Discounts Applied', '-5.00 JD',
        'Cash Payments', 'Card Payments', 'Cash Expenses', '-8.00 JD', 'Delivery', 'Dine In', 'Supplies',
        'EXPECTED IN DRAWER', '92.00 JD', 'ACTUAL COUNTED', '90.00 JD', 'VARIANCE (SHORT)', '-2.00 JD');
    assert.equal(sources(type, shift).length, 1, 'ordinary shift reports should stay on one document');
    assert(!content(type, { ...shift, actual_cash: null, total_discounts: 0, cash_expenses: 0 }).includes('ACTUAL COUNTED'));
}

const audit = {
    storeInfo: { store_name: 'مطعم' }, report_type: 'z_audit', serial_label: 'Z-17', copy_label: 'REPRINT',
    business_date: '2026-09-20', generated_at: '2026-09-21T00:00:00Z', generated_by: { name: 'مدير' },
    summary: { sales_incl_tax: 110, net_sales_pre_tax: 100, tax_collected: 10, total_orders: 3,
        avg_check: 36.67, discounts_total: 5, line_discounts_total: 2, order_discounts_total: 3,
        refund_count: 1, refunds_total: 4, void_count: 1, void_value: 6 },
    payments: { cash_sales: 50, card_sales: 30, platform_sales: 30, total_collected: 80 },
    cash_reconciliation: { closed_shifts: 1, closed_outside_window: 0, open_shifts: 0,
        uncounted_shifts: 0, shifts_needing_review: 1, net_variance_total: -2,
        shortage_total: 2, overage_total: 0, cash_expenses_total: 3 },
    shifts: [{ shift_id: 9, cashier_name: 'أحمد', status: 'closed', within_window: true,
        gross_sales: 110, cash_sales: 50, card_sales: 30, platform_sales: 30, cash_expenses: 3,
        line_discounts: 2, order_discounts: 3, refund_count: 1, refund_value: 4,
        void_count: 1, void_value: 6, starting_cash: 20, expected_cash: 67, actual_cash: 65, variance: -2 }],
    order_types: [{ order_type_name: 'سفري', order_count: 2, total_sales: 60 }],
    blockers: { open_shifts: [{ shift_id: 10, cashier_name: 'باسل' }] }, payload_hash: 'abcdef1234567890'
};
const auditSource = content('audit_report', audit);
hasAll(auditSource, 'إعادة طباعة', 'المبيعات شاملة الضريبة', '110.00 د.أ', 'الضريبة المحصّلة',
    'المرتجعات', 'الطلبات الملغاة', 'نتيجة مراجعة المناوبات', 'إجمالي العجز',
    '2.00 د.أ', 'صافي فرق المناوبات', '#9 أحمد', 'النقد المتوقع', 'النقد الفعلي',
    'سفري', 'مناوبات مفتوحة', '#10 باسل', 'abcdef123456');
assert(!content('audit_report', { ...audit, cash_reconciliation: { ...audit.cash_reconciliation, open_shifts: 1, net_variance_total: null } }).includes('إجمالي العجز'));
assert.equal(reconciliationFrom(audit).shortage, 2);
assert.equal(summarizeAuditShifts([{ status: 'closed', actual_cash: 8, variance: -2 }]).shortage, 2);
assert.equal(summarizeAuditShifts([{ status: 'open' }]).netVariance, null);

const category = {
    storeInfo: { store_name: 'مطعم' }, business_date: '2026-09-20',
    summary: { order_count: 2, subtotal: 100, line_discount: 3, order_discount: 2, tax: 8, total: 103 },
    categories: [{ category_name: 'مشروبات', qty_sold: 3, gross_revenue: 15 }],
    subcategories: [{ category_name: 'رئيسية', rows: [{ category_name: 'بارد', qty_sold: 2, gross_revenue: 10 }] }],
    items: [{ item_name: 'عصير برتقال', qty_sold: 2, gross_revenue: 10 }]
};
for (const type of ['category_items_report', 'y_held_items_report']) {
    const src = content(type, category);
    hasAll(src, 'مشروبات', '3', '15.00 د.أ', 'بارد', 'عصير برتقال', '10.00');
}
hasAll(content('y_held_items_report', category), 'المجموع قبل خصم الطلب', 'خصم الأصناف', 'خصم الطلبات', '103.00 د.أ');

const en = { language: 'en', period: { window_label: '2026-09-20 06:00 → 2026-09-21 05:59' } };
const summary = { ...en,
    summary: { sales_collected: 130, expenses_total: 7, remaining_after_expenses: 123,
        sales_processed: 140, refunds_issued: 10, net_revenue_pre_tax: 120, tax_collected: 10,
        service_charges_collected: 9, total_orders: 12, average_ticket: 11.67,
        discounted_orders: 1, refund_count: 1, void_count: 2 },
    payments: [{ key: 'cash', amount: 80 }, { key: 'card', amount: 50 }, { key: 'platform', amount: 30 },
        { key: 'subscription_receivable_cash_collections', amount: 999 }],
    cash_status: { state: 'review', closed_shifts: 2, open_shifts: 0, uncounted_shifts: 0,
        net_variance: 0, shortage_total: 4, overage_total: 4 }
};
const summarySource = content('daily_summary_report', summary);
hasAll(summarySource, 'Daily Summary Report', '130.00 JD', '123.00 JD', '140.00 JD',
    '-10.00 JD', '120.00 JD', '9.00 JD', 'Shortage Total', 'Overage Total', 'Net Shift Variance');
assert(!summarySource.includes('999.00 JD'));
assert(!summarySource.includes('Expected Cash'));
assert(!summarySource.includes('Actual Cash'));
const inProgress = content('daily_summary_report', { ...summary, cash_status: { state: 'in_progress', open_shifts: 1 } });
hasAll(inProgress, 'Reconciliation in progress');
assert(!inProgress.includes('Shortage Total'));
const noShifts = content('daily_summary_report', { ...summary, cash_status: { state: 'no_shifts', closed_outside_window: 1 } });
hasAll(noShifts, 'No shifts settled in this report window', 'Shifts settled on another business day');

const sales = { ...en, totals: { sales_collected: 99, menu_sales: 90, service_charges_collected: 9 },
    categories: [{ name: 'Food', sold_qty: 3, net_sales: 30, subcategories: [{ name: 'Soup', sold_qty: 1, net_sales: 10 }] }],
    products: [{ item_name: 'Tomato Soup', sold_qty: 2, returned_qty: 1, net_sales: 20 }],
    order_types: [{ name: 'Dine In', orders: 2, net_sales: 40 }], cashiers: [{ name: 'Ali', orders: 2, net_sales: 40 }],
    tables_enabled: true, waiters: [{ name: 'Zaid', orders: 1, net_sales: 20 }],
    tables: [{ table_number: '4', section_name: 'Patio', net_sales: 20 }] };
hasAll(content('daily_sales_report', sales), 'Daily Sales Report', 'Soup', 'Tomato Soup', '2/1',
    'Dine In', 'Ali', 'Zaid', 'Patio', 'Service Charges', 'Product and category amounts include tax');
assert(!content('daily_sales_report', { ...sales, tables_enabled: false }).includes('Zaid'));

const refunds = { ...en, summary: { sales_processed: 100, refund_total: 5, refund_rate: 5, void_value: 8 },
    by_staff: [{ name: 'Ali', refund_value: 5, void_value: 8 }],
    top_reasons: [{ reason: 'Item removed from table', count: 1, value: 8 }],
    events: [{ kind: 'void', table_number: 4, event_value: 8, cashier_name: 'Ali',
        occurred_at_local: '12:30', refund_method: 'cash', reason: 'Item removed from table',
        items: [{ item_name: 'Burger', quantity: 1, line_total: 8 }] }] };
const refundSource = content('daily_refunds_report', refunds);
hasAll(refundSource, 'Daily Refunds Report', '-5.00 JD', '8.00 JD', 'Table 4',
    'Item removed from table', 'Burger', 'Voided item value — no money returned.');
assert(!refundSource.includes('#— (Void)'));

const expenses = { ...en, summary: { total: 15, drawer: 10, outside: 5 }, sales_collected: 100,
    remaining_after_expenses: 85, by_category: [{ category_name: 'Supplies', count: 2, total: 15 }],
    entries: [{ id: 7, category_name: 'Supplies', amount: 10, source: 'drawer', shift_id: 3,
        note: 'Paper rolls', status: 'canceled', created_by_name: 'Cashier', canceled_by_name: 'Manager',
        created_at: '10:00' }] };
hasAll(content('daily_expenses_report', expenses), '85.00 JD', 'Supplies', 'Paper rolls', 'Canceled', 'Manager');
const slip = { ...en, storeInfo: { store_name: 'Store' }, id: 7, category_name: 'Supplies',
    amount: 10, source: 'drawer', shift_id: 3, created_by_name: 'Cashier', created_at: '10:00',
    canceled_by_name: 'Manager', canceled_at: '10:05', note: 'Paper rolls' };
hasAll(content('expense_slip', slip), 'Expense Receipt', 'Store', '#7', 'Supplies', 'Paper rolls', '10.00 JD');
hasAll(content('expense_cancel_slip', slip), 'Expense', 'Cancellation', 'Manager', '10:05', '10.00 JD');

// Data is text, even when it resembles Typst source or HTML.
const hostile = '#pagebreak() <img src=x onerror=alert(1)> \\ "';
const hostileSource = content('daily_sales_report', { ...sales, products: [{ ...sales.products[0], item_name: hostile }] });
assert(hostileSource.includes('\\\\'));
assert(hostileSource.includes('\\"'));

// Logical rows remain whole across bounded documents, including 200-row Y and audit cases.
const largeY = sources('y_held_items_report', { ...category, items: Array.from({ length: 200 }, (_, i) => ({
    item_name: `Item ${i}`, qty_sold: 1, gross_revenue: i + 1
})) });
assert(largeY.length > 1);
for (let i = 0; i < 200; i++) assert(largeY.some(doc => doc.source.includes(`Item ${i}`)), `lost Y row ${i}`);
const largeAudit = sources('audit_report', { ...audit, shifts: Array.from({ length: 200 }, (_, i) => ({ ...audit.shifts[0], shift_id: i + 1 })) });
assert(largeAudit.length > 1 && largeAudit.length <= 24, '200 shifts fit the renderer page cap');
for (let i = 1; i <= 200; i++) assert(largeAudit.some(doc => doc.source.includes(`#${i} أحمد`)), `lost audit shift ${i}`);
const largeRefunds = sources('daily_refunds_report', { ...refunds,
    events: [{ ...refunds.events[0], items: Array.from({ length: 200 }, (_, i) => ({
        item_name: `Refund Detail ${i} ${'Long Item '.repeat(5)}`, quantity: 1, line_total: i + 1
    })) }]
});
assert(largeRefunds.length > 1 && largeRefunds.length <= 24, 'large refund event fits the renderer page cap');
for (let i = 0; i < 200; i++) assert(largeRefunds.some(doc => doc.source.includes(`Refund Detail ${i} `)), `lost refund item ${i}`);

const deepRoot = { name: 'Depth 0', sold_qty: 1, net_sales: 1, subcategories: [] };
let deepNode = deepRoot;
for (let depth = 1; depth < 500; depth++) {
    const child = { name: `Depth ${depth}`, sold_qty: 1, net_sales: 1, subcategories: [] };
    deepNode.subcategories.push(child);
    deepNode = child;
}
const deepCategories = content('daily_sales_report', { ...sales, categories: [deepRoot] });
assert(deepCategories.indexOf('Depth 0') < deepCategories.indexOf('Depth 499'), 'deep category preorder is preserved');
assert(deepCategories.includes('Depth 499'), 'deep category leaf is retained');
deepNode.subcategories.push(deepRoot);
assert.throws(() => sources('daily_sales_report', { ...sales, categories: [deepRoot] }),
    error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED' && error.failureClass === 'permanent_safe');
deepNode.subcategories.pop();
const oversized = Array.from({ length: 2001 }, (_, i) => ({ name: `Category ${i}`, sold_qty: 1, net_sales: 1 }));
assert.throws(() => sources('daily_sales_report', { ...sales, categories: oversized }),
    error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED' && error.failureClass === 'permanent_safe');

const longNotes = Array.from({ length: 4 }, (_, i) => ({ ...expenses.entries[0], id: i + 1,
    note: `Entry ${i} ` + 'Long centered note '.repeat(75) }));
const longCentered = sources('daily_expenses_report', { ...expenses, entries: longNotes });
assert(longCentered.length > 1, 'wrapped centered notes contribute to page estimates');
for (let i = 0; i < longNotes.length; i++) assert(longCentered.some(doc => doc.source.includes(`Entry ${i} `)));
assert.throws(() => sources('daily_expenses_report', { ...expenses, entries: [{ ...expenses.entries[0], note: 'very long '.repeat(1000) }] }),
    error => error.code === 'TYPST_DOCUMENT_UNSUPPORTED' && error.failureClass === 'permanent_safe');

const typst = [
    process.env.SPOOLER_TYPST_EXE,
    path.join(__dirname, '..', '.cache', 'typst', '0.15.1', 'typst.exe'),
    path.join(__dirname, '..', '..', 'deployment', 'out', 'stage', 'spooler', '.cache', 'typst', '0.15.1', 'typst.exe')
].find(candidate => candidate && fs.existsSync(candidate));
if (typst) {
    assert(fs.existsSync(pinnedFonts), 'pinned Typst fonts must be available for real compilation');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-report-typst-'));
    try {
        for (const job of representativeJobs) {
            for (const [index, doc] of sources(job.print_type, job.data).entries()) {
                const input = path.join(dir, `${job.print_type}-${index}.typ`);
                const output = path.join(dir, `${job.print_type}-${index}.png`);
                fs.writeFileSync(input, doc.source);
                execFileSync(typst, ['compile', '--ppi', '72', '--ignore-system-fonts', '--font-path', pinnedFonts, input, output], { stdio: 'pipe', timeout: 15000 });
                const png = fs.readFileSync(output);
                assert.equal(png.readUInt32BE(16), 576, `${job.print_type} raster width`);
                assert(png.readUInt32BE(20) > 100, `${job.print_type} raster height`);
            }
        }
        let auditHeight = 0;
        for (const [index, doc] of largeAudit.entries()) {
            const input = path.join(dir, `large-audit-${index}.typ`);
            const output = path.join(dir, `large-audit-${index}.png`);
            fs.writeFileSync(input, doc.source);
            execFileSync(typst, ['compile', '--ppi', '72', '--ignore-system-fonts', '--font-path', pinnedFonts, input, output], { stdio: 'pipe', timeout: 15000 });
            const png = fs.readFileSync(output);
            assert.equal(png.readUInt32BE(16), 576);
            const height = png.readUInt32BE(20);
            assert(height <= 12004, 'large audit page stays under the renderer height cap');
            auditHeight += height;
        }
        assert(auditHeight <= 200000, `large audit stays under the renderer total height cap (${auditHeight})`);
        let refundHeight = 0;
        for (const [index, doc] of largeRefunds.entries()) {
            const input = path.join(dir, `large-refund-${index}.typ`);
            const output = path.join(dir, `large-refund-${index}.png`);
            fs.writeFileSync(input, doc.source);
            execFileSync(typst, ['compile', '--ppi', '72', '--ignore-system-fonts', '--font-path', pinnedFonts, input, output], { stdio: 'pipe', timeout: 15000 });
            const png = fs.readFileSync(output);
            assert.equal(png.readUInt32BE(16), 576);
            const height = png.readUInt32BE(20);
            assert(height <= 12004, `large refund page ${index} stays under height cap (${height})`);
            refundHeight += height;
        }
        assert(refundHeight <= 200000, `large refund stays under total height cap (${refundHeight})`);
        for (const [index, doc] of longCentered.entries()) {
            const input = path.join(dir, `long-centered-${index}.typ`);
            const output = path.join(dir, `long-centered-${index}.png`);
            fs.writeFileSync(input, doc.source);
            execFileSync(typst, ['compile', '--ppi', '72', '--ignore-system-fonts', '--font-path', pinnedFonts, input, output], { stdio: 'pipe', timeout: 15000 });
            const png = fs.readFileSync(output);
            assert.equal(png.readUInt32BE(16), 576);
            assert(png.readUInt32BE(20) <= 12004, 'long centered text stays within a bounded page');
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(`Native Typst reports: 11 types, semantic fixtures, bounded rows${typst ? ', real Typst compile' : ''} passed.`);
