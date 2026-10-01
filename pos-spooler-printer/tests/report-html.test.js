'use strict';

const assert = require('node:assert/strict');
const { buildReportDocuments, supportsReport } = require('../v2/report-typst');

function report(type, data) {
    assert(supportsReport({ print_type: type, data }));
    return buildReportDocuments({ print_type: type, data }).map(doc => doc.source).join('\n');
}

const arRefunds = report('daily_refunds_report', {
    language: 'ar', direction: 'rtl', period: { window_label: '2026-07-14 06:00 → 2026-07-15 05:59' },
    summary: { sales_processed: 100, refund_total: 30, refund_rate: 30, void_value: 12 },
    by_staff: [{ name: 'أحمد', refund_value: 30, void_value: 12 }],
    top_reasons: [{ reason: 'خطأ', count: 1, value: 30 }],
    events: [
        { invoice_display_no: '42', kind: 'refund', event_value: 30, refund_method: 'split',
            occurred_at_local: '2026-07-14 10:00', cashier_name: 'أحمد', reason: 'خطأ', items: [] },
        { invoice_display_no: '43', table_number: '4', kind: 'void', event_value: 12,
            occurred_at_local: '2026-07-14 10:15', cashier_name: 'أحمد', reason: 'Item removed from table', items: [] }
    ]
});
for (const value of ['تقرير المرتجعات اليومي', 'الطريقة: تقسيم', 'الطاولة 4',
    'تم حذف الصنف من الطاولة', '#42', 'أحمد', '2026-07-14 10:15']) assert(arRefunds.includes(value), value);
assert(!arRefunds.includes('#43 (إلغاء)'), 'void primary identity must be the table');
assert(arRefunds.includes('dir: rtl'), 'Arabic report rows must flow right to left');

const englishVoid = report('daily_refunds_report', { language: 'en', events: [{ kind: 'void', table_number: '4',
    occurred_at_local: '11:00', cashier_name: 'Waiter', reason: 'Table cleared' }] });
assert(englishVoid.includes('Table 4'));
assert(englishVoid.includes('Table cleared'));

const y = report('y_held_items_report', {
    summary: { order_count: 1, subtotal: 9, line_discount: 1, order_discount: 0.5, tax: 1.2, total: 9.7 },
    items: [{ item_name: 'Aggregated Burger', qty_sold: 2, gross_revenue: 9.7 }],
    orders: [{ held_order_id: 17, reference_name: 'Private Reference', cashier_name: 'Cashier',
        items: [{ item_name: 'Burger', qty: 2, note: 'No onion' }] }]
});
assert(y.includes('Aggregated Burger'));
assert(y.includes('9.70'));
for (const privateValue of ['Private Reference', '#17', 'Cashier', 'No onion', 'تفاصيل الطلبات']) {
    assert(!y.includes(privateValue), `Y omits individual receipt detail: ${privateValue}`);
}

for (const removed of ['daily_report', 'report_overview', 'report_products', 'report_tables',
    'report_staff', 'report_invoices', 'report_shifts']) assert(!supportsReport({ print_type: removed }));

console.log('Native report content and Arabic localization passed.');
