'use strict';

const { formatBusinessTime } = require('../businessTime');
const { reconciliationFrom } = require('./report-data');

const LABELS = {
    summaryTitle: ['Daily Summary Report', 'تقرير الملخص اليومي'],
    salesTitle: ['Daily Sales Report', 'تقرير المبيعات اليومي'],
    refundsTitle: ['Daily Refunds Report', 'تقرير المرتجعات اليومي'],
    expensesTitle: ['Daily Expenses Report', 'تقرير المصروفات اليومي'],
    expenseSlipTitle: ['Expense Receipt', 'إيصال مصروف'],
    expenseCancelTitle: ['Expense Cancellation', 'إلغاء مصروف'],
    expensesRecorded: ['Recorded Expenses', 'المصروفات المسجلة'],
    drawerExpenses: ['From Cash Drawers', 'من صناديق النقد'],
    outsideExpenses: ['Outside POS', 'خارج نظام الكاشير'],
    remainingAfterExpenses: ['Remaining After Expenses', 'المتبقي بعد المصروفات'],
    byCategory: ['By Category', 'حسب التصنيف'],
    expenseEntries: ['Expense Entries', 'سجل المصروفات'],
    noExpenses: ['No expenses in this period.', 'لا توجد مصروفات في هذه الفترة.'],
    category: ['Category', 'التصنيف'],
    source: ['Source', 'المصدر'],
    recordedBy: ['Recorded By', 'سجّله'],
    canceledBy: ['Canceled By', 'ألغاه'],
    note: ['Note', 'ملاحظة'],
    shift: ['Shift', 'المناوبة'],
    time: ['Time', 'الوقت'],
    drawer: ['Cash Drawer', 'صندوق النقد'],
    outside: ['Outside POS', 'خارجي'],
    canceled: ['Canceled', 'ملغى'],
    salesCollected: ['Net Sales', 'صافي المبيعات'],
    salesProcessed: ['Sales Processed', 'المبيعات المعالجة'],
    refundsIssued: ['Refunds Issued', 'المرتجعات الصادرة'],
    netRevenue: ['Net Revenue', 'صافي الإيراد'],
    tax: ['Tax', 'الضريبة'],
    serviceCharges: ['Service Charges', 'رسوم الخدمة'],
    cashPayments: ['Cash Payments', 'المدفوعات النقدية'],
    cardPayments: ['Card Payments', 'مدفوعات البطاقة'],
    platformSales: ['Platform Sales (Not Collected)', 'مبيعات المنصات (غير محصلة)'],
    totalOrders: ['Total Orders', 'إجمالي الطلبات'],
    averageTicket: ['Average Ticket', 'متوسط الفاتورة'],
    discountedOrders: ['Discounted Orders', 'الطلبات المخفضة'],
    refundEvents: ['Refund Events', 'عمليات الإرجاع'],
    voidEvents: ['Void Events', 'عمليات الإلغاء'],
    closedShifts: ['Closed shifts', 'مناوبات مغلقة'],
    openShifts: ['Active open shifts', 'مناوبات مفتوحة نشطة'],
    uncountedShifts: ['Uncounted shifts', 'مناوبات بلا جرد'],
    settledAnotherDay: ['Shifts settled on another business day', 'مناوبات أُغلقت في يوم عمل آخر'],
    shortageTotal: ['Shortage Total', 'إجمالي العجز'],
    overageTotal: ['Overage Total', 'إجمالي الزيادة'],
    netVariance: ['Net Shift Variance', 'صافي فرق المناوبات'],
    reconciliationInProgress: ['Reconciliation in progress', 'التسوية قيد التنفيذ'],
    cashStatus: ['Cash Status', 'حالة الصندوق'],
    refundsTiming: ['Refunds are counted when issued.', 'تُحتسب المرتجعات عند إصدارها.'],
    menuSales: ['Menu Sales', 'مبيعات القائمة'],
    salesByCategory: ['Sales by Category', 'المبيعات حسب التصنيف'],
    products: ['Products', 'الأصناف'],
    product: ['Product', 'الصنف'],
    qtyNet: ['Qty / Net', 'الكمية / الصافي'],
    orderTypes: ['Order Types', 'أنواع الطلبات'],
    cashiers: ['Cashiers', 'الصرافون'],
    waiters: ['Waiters', 'النوادل'],
    tables: ['Tables', 'الطاولات'],
    table: ['Table', 'طاولة'],
    tableIdentity: ['Table', 'الطاولة'],
    salesNote: ['Product and category amounts include tax. Service charges are shown separately.', 'تشمل مبالغ الأصناف والتصنيفات الضريبة، وتظهر رسوم الخدمة منفصلة.'],
    refundRate: ['Refund Rate', 'نسبة المرتجعات'],
    voidValue: ['Void Value', 'قيمة الإلغاء'],
    staffActivity: ['Activity by Staff', 'الحركة حسب الموظف'],
    staff: ['Staff', 'الموظف'],
    refundVoid: ['Refund / Void', 'مرتجع / إلغاء'],
    topReasons: ['Top Reasons', 'أكثر الأسباب'],
    refundVoidEvents: ['Refund & Void Events', 'سجل المرتجعات والإلغاءات'],
    amount: ['Amount', 'المبلغ'],
    method: ['Method', 'الطريقة'],
    cash: ['Cash', 'نقدي'],
    card: ['Card', 'بطاقة'],
    platform: ['Platform', 'منصة'],
    split: ['Split', 'تقسيم'],
    reason: ['Reason', 'السبب'],
    refund: ['Refund', 'مرتجع'],
    void: ['Void', 'إلغاء'],
    itemRemovedFromTable: ['Item removed from table', 'تم حذف الصنف من الطاولة'],
    tableCleared: ['Table cleared', 'تم إخلاء الطاولة'],
    noEvents: ['No refunds or voids in this period.', 'لا توجد مرتجعات أو إلغاءات في هذه الفترة.'],
    voidNote: ['Voided item value — no money returned.', 'قيمة الصنف الملغى — لم تتم إعادة أموال.'],
    end: ['End of Report', 'نهاية التقرير'],
    balanced: ['Balanced', 'متوازن'],
    in_progress: ['In progress', 'قيد التنفيذ'],
    review: ['Needs review', 'يحتاج مراجعة'],
    no_shifts: ['No shifts', 'لا توجد مناوبات'],
};

const REPORT_TYPES = new Set([
    'x_report', 'z_report', 'audit_report', 'category_items_report', 'y_held_items_report',
    'daily_summary_report', 'daily_sales_report', 'daily_refunds_report',
    'daily_expenses_report', 'expense_slip', 'expense_cancel_slip'
]);
const WIDTH = 576;
// A 200-shift audit must fit the renderer's 24-page cap. These are weighted
// source-line estimates, not physical paper lines; grouped shifts stay intact.
const MAX_LINES_PER_DOCUMENT = 140;
const MAX_AUDIT_LINES_PER_DOCUMENT = 300;
const MAX_CATEGORY_NODES = 2000;

function unsupported(message) {
    throw Object.assign(new Error(message), { code: 'TYPST_DOCUMENT_UNSUPPORTED', failureClass: 'permanent_safe' });
}

function supportsReport(job) { return REPORT_TYPES.has(job?.print_type); }
function arr(value) { return Array.isArray(value) ? value : []; }
function str(value) { return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); }
function literal(value) { return JSON.stringify(str(value).replace(/[\x21-\x7e]{30,}/g, token => [...token].join('\u200b'))); }
function amount(value) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(2) : '0.00'; }
function cur(data) { return data?.language === 'ar' || data?.direction === 'rtl' ? 'د.أ' : 'JD'; }
function ar(data) { return data?.language === 'ar' || data?.direction === 'rtl'; }
function L(data, key) { return (LABELS[key] || [key, key])[ar(data) ? 1 : 0]; }
function money(data, value) { return `${amount(value)} ${cur(data)}`; }
function reportMoney(value) { return `${amount(value)} د.أ`; }
function paymentAmount(data, key) { return Number(arr(data.payments).find(row => row.key === key)?.amount) || 0; }
function eventReason(data, reason) {
    return reason === 'Item removed from table' ? L(data, 'itemRemovedFromTable')
        : reason === 'Table cleared' ? L(data, 'tableCleared') : reason || '—';
}
function cashStatusLabel(data, cash) {
    return cash.state === 'no_shifts' && Number(cash.closed_outside_window) > 0
        ? (ar(data) ? 'لا توجد مناوبات أُغلقت ضمن فترة التقرير' : 'No shifts settled in this report window')
        : L(data, cash.state || 'no_shifts');
}

// All interpolation enters Typst as a quoted string expression, never markup.
function text(value, { size = 25, weight = 400, dir = 'auto' } = {}) {
    return `#text(size: ${size}pt, weight: ${weight}, dir: ${dir}, top-edge: 0.85em, bottom-edge: 0.25em)[#text(${literal(value)})]`;
}
function centeredLineCount(value, size) {
    // Use a deliberately wide glyph estimate so long English, Arabic and
    // explicit newlines all reserve room before assigning document pages.
    const charsPerLine = Math.max(1, Math.floor(556 / (size * 0.75)));
    return str(value).split(/\r\n|\r|\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}
function center(value, size = 26, weight = 600) {
    const wrappedLines = centeredLineCount(value, size);
    if (wrappedLines > 70) unsupported('Report centered text exceeds one bounded page.');
    return { source: `#block(width: 100%, above: 0pt, below: 0pt)[#align(center)[${text(value, { size, weight })}]]\n#v(20pt)\n`, lines: 1 + wrappedLines };
}
function row(label, value, { rtl = false, size = 25, weight = 600, indent = 0 } = {}) {
    const labelText = text(label, { size, weight: weight === 700 ? 700 : 400, dir: rtl ? 'rtl' : 'auto' });
    const valueText = text(value, { size, weight, dir: 'auto' });
    const labelCell = `[#align(${rtl ? 'right' : 'left'})[${labelText}]]`;
    const valueCell = `[#align(${rtl ? 'left' : 'right'})[${valueText}]]`;
    const cells = rtl ? `${valueCell}, ${labelCell}` : `${labelCell}, ${valueCell}`;
    const labelWidth = 363 - 2 * indent;
    const columns = rtl ? `(185pt, ${labelWidth}pt)` : `(${labelWidth}pt, 185pt)`;
    const extraLines = Math.max(0, Math.ceil(str(label).length / 30) - 1, Math.ceil(str(value).length / 18) - 1);
    return { source: `#block(width: 100%, above: 0pt, below: 0pt, breakable: false, inset: (left: ${indent}pt, right: ${indent}pt))[#grid(columns: ${columns}, gutter: 8pt, ${cells})]\n#v(12pt)\n`, lines: 2 + extraLines };
}
function line(data, key, value, options) { return row(L(data, key), value, { rtl: ar(data), ...options }); }
function rule(solid = false) { return { source: `#v(12pt)\n#line(length: 100%, stroke: ${solid ? '2pt' : '1pt'} + black)\n#v(16pt)\n`, lines: 1 }; }
function title(value, size = 36) { return center(value, size, 700); }
function heading(value, solid = false) { const caption = center(value, 30, 700); return { source: rule(solid).source + caption.source, lines: 1 + caption.lines }; }
function end(value) { const caption = center(value, 22, 600); return { source: rule(true).source + caption.source, lines: 1 + caption.lines }; }
function listBlock(...blocks) { return { source: blocks.map(block => block.source).join(''), lines: blocks.reduce((n, block) => n + block.lines, 0) }; }
function yItem(item) {
    const extraLines = Math.max(0, Math.ceil(str(item.item_name).length / 28) - 1);
    return { source: `#block(width: 100%, above: 0pt, below: 0pt, breakable: false)[#grid(columns: (135pt, 70pt, 341pt), gutter: 5pt, [#align(center)[${text(amount(item.gross_revenue), { size: 20 })}]], [#align(center)[${text(item.qty_sold, { size: 25 })}]], [#align(right)[${text(item.item_name, { size: 25, dir: 'rtl' })}]])]\n#v(2pt)\n`, lines: 2 + extraLines };
}
function pushRows(blocks, rows, make) { for (const item of rows) blocks.push(make(item)); }
function startDaily(data, key) { return [title(L(data, key), 48), center(data.period?.window_label, 28), rule(true)]; }

function dailySummary(data) {
    const s = data.summary || {}, cash = data.cash_status || {};
    const b = startDaily(data, 'summaryTitle');
    b.push(line(data, 'salesCollected', money(data, s.sales_collected)));
    if (Number(s.expenses_total || 0) !== 0) {
        b.push(line(data, 'expensesRecorded', money(data, s.expenses_total)));
        b.push(line(data, 'remainingAfterExpenses', money(data, s.remaining_after_expenses)));
    }
    b.push(line(data, 'salesProcessed', money(data, s.sales_processed)), line(data, 'refundsIssued', `-${money(data, s.refunds_issued)}`),
        line(data, 'netRevenue', money(data, s.net_revenue_pre_tax)), line(data, 'tax', money(data, s.tax_collected)));
    if (Number(s.service_charges_collected || 0) !== 0) b.push(line(data, 'serviceCharges', money(data, s.service_charges_collected)));
    b.push(rule(), line(data, 'cashPayments', money(data, paymentAmount(data, 'cash'))),
        line(data, 'cardPayments', money(data, paymentAmount(data, 'card'))),
        line(data, 'platformSales', money(data, paymentAmount(data, 'platform'))), rule(),
        line(data, 'totalOrders', s.total_orders || 0), line(data, 'averageTicket', money(data, s.average_ticket)),
        line(data, 'discountedOrders', s.discounted_orders || 0), line(data, 'refundEvents', s.refund_count || 0),
        line(data, 'voidEvents', s.void_count || 0), rule(),
        line(data, 'closedShifts', cash.closed_shifts || 0), line(data, 'openShifts', cash.open_shifts || 0),
        line(data, 'uncountedShifts', cash.uncounted_shifts || 0));
    if (Number(cash.closed_outside_window) > 0) b.push(line(data, 'settledAnotherDay', Number(cash.closed_outside_window)));
    if (Number(cash.closed_shifts) > 0 && cash.net_variance != null) {
        b.push(line(data, 'shortageTotal', money(data, cash.shortage_total)), line(data, 'overageTotal', money(data, cash.overage_total)),
            line(data, 'netVariance', `${Number(cash.net_variance) > 0 ? '+' : ''}${money(data, cash.net_variance)}`));
    } else if (cash.state === 'in_progress') b.push(center(L(data, 'reconciliationInProgress'), 24));
    b.push(line(data, 'cashStatus', cashStatusLabel(data, cash), { weight: 700 }), center(L(data, 'refundsTiming'), 18), end(`--- ${L(data, 'end')} ---`));
    return b;
}

function categoryRows(data, roots) {
    const blocks = [], seen = new Set();
    const stack = roots.map(node => ({ node, depth: 0 })).reverse();
    while (stack.length) {
        const { node, depth } = stack.pop();
        if (!node || typeof node !== 'object' || Array.isArray(node)) unsupported('Report category is invalid.');
        if (seen.has(node)) unsupported('Report category graph contains a cycle or repeated node.');
        if (seen.size >= MAX_CATEGORY_NODES) unsupported('Report category graph exceeds its node limit.');
        seen.add(node);
        blocks.push(row(`${depth ? '• ' : ''}${str(node.name)}`, `${str(node.sold_qty)} / ${money(data, node.net_sales)}`,
            { rtl: ar(data), indent: Math.min(depth, 4) * 8, weight: depth ? 400 : 600 }));
        if (node.subcategories != null && !Array.isArray(node.subcategories)) unsupported('Report category children are invalid.');
        for (let index = arr(node.subcategories).length - 1; index >= 0; index--) {
            stack.push({ node: node.subcategories[index], depth: depth + 1 });
        }
    }
    return blocks;
}
function dailySales(data) {
    const t = data.totals || {}, b = startDaily(data, 'salesTitle');
    b.push(line(data, 'salesCollected', money(data, t.sales_collected)), line(data, 'menuSales', money(data, t.menu_sales)),
        line(data, 'serviceCharges', money(data, t.service_charges_collected)));
    if (arr(data.categories).length) {
        b.push(heading(L(data, 'salesByCategory')));
        b.push(...categoryRows(data, data.categories));
    }
    if (arr(data.products).length) {
        b.push(heading(L(data, 'products')), row(L(data, 'product'), L(data, 'qtyNet'), { rtl: ar(data), size: 22, weight: 700 }), rule(true));
        pushRows(b, data.products, product => row(product.item_name,
            `${product.sold_qty}${Number(product.returned_qty) > 0 ? `/${product.returned_qty}` : ''} - ${money(data, product.net_sales)}`,
            { rtl: ar(data) }));
    }
    for (const [field, headingKey, makeLabel] of [
        ['order_types', 'orderTypes', r => `${str(r.name)} (${str(r.orders)})`],
        ['cashiers', 'cashiers', r => `${str(r.name)} (${str(r.orders)})`],
        ['waiters', 'waiters', r => `${str(r.name)} (${str(r.orders)})`],
        ['tables', 'tables', r => `${L(data, 'table')} ${str(r.table_number)} (${str(r.section_name)})`]
    ]) {
        if (!arr(data[field]).length || (['waiters', 'tables'].includes(field) && !data.tables_enabled)) continue;
        b.push(heading(L(data, headingKey)));
        pushRows(b, data[field], r => row(makeLabel(r), money(data, r.net_sales), { rtl: ar(data) }));
    }
    b.push(rule(), center(L(data, 'salesNote'), 18), end(`--- ${L(data, 'end')} ---`));
    return b;
}

function dailyRefunds(data) {
    const s = data.summary || {}, b = startDaily(data, 'refundsTitle');
    b.push(line(data, 'salesProcessed', money(data, s.sales_processed)), line(data, 'refundsIssued', `-${money(data, s.refund_total)}`),
        line(data, 'refundRate', s.refund_rate == null ? '—' : `${s.refund_rate}%`), line(data, 'voidValue', money(data, s.void_value)));
    if (arr(data.by_staff).length) {
        b.push(heading(L(data, 'staffActivity')), row(L(data, 'staff'), L(data, 'refundVoid'), { rtl: ar(data), size: 22, weight: 700 }), rule(true));
        pushRows(b, data.by_staff, staff => row(staff.name, `${amount(staff.refund_value)} / ${amount(staff.void_value)}`, { rtl: ar(data) }));
    }
    if (arr(data.top_reasons).length) {
        b.push(heading(L(data, 'topReasons')));
        pushRows(b, data.top_reasons, r => row(`${eventReason(data, r.reason)} (${r.count})`, money(data, r.value), { rtl: ar(data) }));
    }
    b.push(heading(L(data, 'refundVoidEvents')));
    if (!arr(data.events).length) b.push(center(L(data, 'noEvents'), 22));
    for (const [eventIndex, e] of arr(data.events).entries()) {
        const kind = L(data, e.kind === 'void' ? 'void' : 'refund');
        const identity = e.kind === 'void' && e.table_number != null && e.table_number !== ''
            ? `${L(data, 'tableIdentity')} ${e.table_number}` : `#${e.invoice_display_no || e.invoice_id || '—'}`;
        const group = [...(eventIndex ? [rule()] : []), row(`${identity} (${kind})`, e.occurred_at_local, { rtl: ar(data), size: 22 }),
            row(`${L(data, 'amount')}: ${money(data, e.event_value)}`, e.cashier_name, { rtl: ar(data), size: 22 }),
            center(`${L(data, 'method')}: ${L(data, e.refund_method || '')}`, 21),
            center(`${L(data, 'reason')}: ${eventReason(data, e.reason)}`, 21)];
        let itemGroup = group;
        let groupLines = group.reduce((total, block) => total + block.lines, 0);
        for (const item of arr(e.items)) {
            const itemRow = row(`• ${str(item.item_name)} × ${str(item.quantity)}`,
                money(data, item.line_total), { rtl: ar(data), size: 22, indent: 8 });
            if (groupLines + itemRow.lines > 100 && itemGroup.length > 1) {
                b.push(listBlock(...itemGroup));
                itemGroup = [row(`${identity} (${kind})`, L(data, 'products'), { rtl: ar(data), size: 22, weight: 700 })];
                groupLines = itemGroup[0].lines;
            }
            itemGroup.push(itemRow);
            groupLines += itemRow.lines;
        }
        b.push(listBlock(...itemGroup));
    }
    b.push(rule(), center(L(data, 'voidNote'), 18), end(`--- ${L(data, 'end')} ---`));
    return b;
}

function dailyExpenses(data) {
    const s = data.summary || {}, b = startDaily(data, 'expensesTitle');
    b.push(line(data, 'salesCollected', money(data, data.sales_collected)), line(data, 'expensesRecorded', money(data, s.total)),
        line(data, 'drawerExpenses', money(data, s.drawer)), line(data, 'outsideExpenses', money(data, s.outside)),
        line(data, 'remainingAfterExpenses', money(data, data.remaining_after_expenses), { weight: 700 }));
    if (arr(data.by_category).length) {
        b.push(heading(L(data, 'byCategory')));
        pushRows(b, data.by_category, c => row(`${str(c.category_name)} (${str(c.count || 0)})`, money(data, c.total), { rtl: ar(data) }));
    }
    b.push(heading(L(data, 'expenseEntries')));
    if (!arr(data.entries).length) b.push(center(L(data, 'noExpenses'), 22));
    for (const e of arr(data.entries)) {
        const source = L(data, e.source === 'drawer' ? 'drawer' : 'outside');
        const group = [rule(), row(`#${str(e.id)} ${str(e.category_name)}`, money(data, e.amount), { rtl: ar(data), weight: 700 }),
            row(`${source}${e.shift_id ? ` #${e.shift_id}` : ''}`, e.created_at, { rtl: ar(data), size: 22 }),
            center(`${L(data, 'recordedBy')}: ${str(e.created_by_name)}`, 22)];
        if (e.note) group.push(center(`${L(data, 'note')}: ${str(e.note)}`, 22));
        if (e.status === 'canceled') group.push(center(`${L(data, 'canceled')}${e.canceled_by_name ? ` - ${e.canceled_by_name}` : ''}`, 25, 700));
        b.push(listBlock(...group));
    }
    b.push(end(`--- ${L(data, 'end')} ---`));
    return b;
}

function expenseSlip(data, canceled) {
    const slipTitle = canceled && !ar(data)
        ? [center('Expense', 48, 700), center('Cancellation', 48, 700)]
        : [title(L(data, canceled ? 'expenseCancelTitle' : 'expenseSlipTitle'), 48)];
    const b = [center(data.storeInfo?.store_name || 'POS System', 44, 700), ...slipTitle,
        center(`#${str(data.id)}`, 36, 700), rule(true),
        line(data, 'category', data.category_name), line(data, 'source', L(data, data.source === 'drawer' ? 'drawer' : 'outside'))];
    if (data.shift_id) b.push(line(data, 'shift', `#${data.shift_id}`));
    b.push(line(data, 'recordedBy', data.created_by_name), line(data, 'time', data.created_at));
    if (data.note) b.push(line(data, 'note', data.note, { weight: 400 }));
    if (canceled) b.push(rule(), line(data, 'canceledBy', data.canceled_by_name), line(data, 'time', data.canceled_at));
    b.push(rule(), line(data, 'amount', money(data, data.amount), { weight: 700 }));
    return b;
}

function shiftReport(data, isZ) {
    const m = value => `${amount(value)} JD`, b = [center(str(data.storeInfo?.store_name || 'POS System').toUpperCase(), 44, 700),
        title(isZ ? 'END OF SHIFT (Z-REPORT)' : 'MID-SHIFT AUDIT (X-REPORT)', 44),
        center(`Printed: ${formatBusinessTime(new Date(), data.business_config?.business_sql_offset)}`, 30),
        center(`Shift ID: #${str(data.shift_id)}`, 36, 700), heading('Sales Summary', true),
        row('Gross Sales', m(data.gross_sales)), row('Platform Sales (Not Collected)', m(data.platform_sales))];
    if (data.total_discounts > 0) b.push(row('Discounts Applied', `-${m(data.total_discounts)}`));
    b.push(heading('Tender Breakdown'), row('Cash Payments', m(data.cash_sales)), row('Card Payments', m(data.card_sales)));
    if (Number(data.cash_expenses || 0) > 0) b.push(row('Cash Expenses', `-${m(data.cash_expenses)}`));
    if (arr(data.platform_order_type_breakdown).length) {
        b.push(heading('Platform Receivables by Provider'));
        pushRows(b, data.platform_order_type_breakdown, t => row(t.order_type_name || 'Platform', m(t.total_sales)));
    }
    if (arr(data.order_type_breakdown).length) {
        b.push(heading('Sales by Order Type'));
        pushRows(b, data.order_type_breakdown, t => row(t.order_type_name || 'Standard', m(t.total_sales)));
    }
    if (arr(data.expense_categories).length) {
        b.push(heading('Cash Expenses by Category'));
        pushRows(b, data.expense_categories, c => row(`${str(c.category_name)} (${Number(c.count || 0)})`, `-${m(c.total)}`));
    }
    b.push(heading('Cash Drawer Audit'), row('Starting Float', m(data.starting_cash)),
        row('EXPECTED IN DRAWER', m(data.expected_cash), { weight: 700, size: 30 }));
    if (data.actual_cash != null) {
        const variance = parseFloat(data.actual_cash) - parseFloat(data.expected_cash);
        const varianceLabel = variance === 0 ? 'PERFECT' : variance > 0 ? 'OVERAGE' : 'SHORT';
        b.push(row('ACTUAL COUNTED', m(data.actual_cash), { weight: 700, size: 30 }), rule(),
            row(`VARIANCE (${varianceLabel})`, m(variance), { weight: 700, size: 30 }));
    }
    b.push(center('--- End of Report ---', 22));
    return b;
}

function arabicHeader(data, reportTitle) {
    const b = [center(data.storeInfo?.store_name || 'POS System', 44, 700), title(reportTitle)];
    if (data.is_period) b.push(center(`من ${str(data.period_start_date)} إلى ${str(data.period_end_date)}`, 30));
    else b.push(center(`تاريخ العمل: ${str(data.business_date)}`, 30));
    b.push(center('يوم العمل: 06:00 – 05:59', 26),
        center(`طُبع بتاريخ ${formatBusinessTime(data.generated_at, data.business_config?.business_sql_offset)} بواسطة ${str(data.generated_by?.name || 'النظام')}`, 22),
        rule(true));
    return b;
}

function auditReport(data) {
    const kind = data.report_type === 'z_audit' ? 'Z' : 'X';
    const s = data.summary || {}, p = data.payments || {}, drawer = data.cash_reconciliation || {};
    const review = reconciliationFrom(data), r = (label, value, options) => row(label, value, { rtl: true, ...options });
    const m = reportMoney, nullable = v => v == null ? '—' : m(v);
    const b = arabicHeader(data, data.is_period ? 'التقرير الدوري' : `جرد ${kind} / ${str(data.serial_label)}`);
    if (!data.is_period) b.splice(2, 0, center(data.copy_label === 'REPRINT' ? 'إعادة طباعة' : 'نسخة أصلية', 30, 700));
    b.pop(); // The first heading supplies the header divider.
    b.push(heading('ملخص المبيعات', true), r('المبيعات شاملة الضريبة', m(s.sales_incl_tax)),
        r('صافي المبيعات', m(s.net_sales_pre_tax)), r('الضريبة المحصّلة', m(s.tax_collected)),
        r('عدد الطلبات', Number(s.total_orders || 0)), r('متوسط الفاتورة', m(s.avg_check)),
        r('إجمالي الخصومات', m(s.discounts_total)), r('خصم الأصناف', m(s.line_discounts_total), { size: 18, indent: 8 }),
        r('خصم الفاتورة', m(s.order_discounts_total), { size: 18, indent: 8 }),
        r('المرتجعات', `${Number(s.refund_count || 0)} / ${m(s.refunds_total)}`),
        r('الطلبات الملغاة', `${Number(s.void_count || 0)} / ${m(s.void_value)}`),
        center('الأرقام أعلاه صافية من الخصومات والمرتجعات والطلبات الملغاة.', 18),
        heading('المدفوعات'), r('نقدًا', m(p.cash_sales)), r('بالبطاقة', m(p.card_sales)),
        r('مبيعات المنصات (غير محصلة)', m(p.platform_sales)), r('الإجمالي', m(p.total_collected), { weight: 700 }),
        heading('نتيجة مراجعة المناوبات'), center(review.result, 30, 700), center(review.state, 25),
        r('المناوبات المشمولة', Number(review.total)), r('تحتاج مراجعة', Number(review.needsReview)),
        r('مفتوحة / بلا جرد فعلي', `${Number(review.open)} / ${Number(review.uncounted)}`));
    if (review.netVariance != null) b.push(r('إجمالي العجز', m(review.shortage)), r('إجمالي الزيادة', m(review.overage)),
        r('صافي فرق المناوبات', `${Number(review.netVariance) > 0 ? '+' : ''}${m(review.netVariance)}`, { weight: 700 }));
    b.push(r('مصروفات الصندوق', `-${m(drawer.cash_expenses_total)}`));
    if (arr(data.shifts).length) b.push(heading('المناوبات'));
    for (const [index, shift] of arr(data.shifts).entries()) {
        const group = [...(index ? [rule()] : []), r(`#${str(shift.shift_id)} ${str(shift.cashier_name)} (${shift.status === 'open' ? 'مفتوحة' : 'مغلقة'})`, '', { weight: 700 }),
            center('نشاط ضمن نافذة التقرير', 18, 700),
            r('المبيعات / نقدًا / بطاقة / منصات', `${amount(shift.gross_sales)} / ${amount(shift.cash_sales)} / ${amount(shift.card_sales)} / ${amount(shift.platform_sales)}`, { size: 20 }),
            r('مصروفات الصندوق', `-${m(shift.cash_expenses)}`, { size: 20 }),
            r('خصم أصناف / فاتورة', `${amount(shift.line_discounts)} / ${amount(shift.order_discounts)}`, { size: 20 }),
            r('المرتجعات', `${Number(shift.refund_count || 0)} / ${m(shift.refund_value)}`, { size: 20 }),
            r('الطلبات الملغاة', `${Number(shift.void_count || 0)} / ${m(shift.void_value)}`, { size: 20 }),
            center('أرصدة المناوبة عند الإغلاق', 18, 700), r('رصيد الافتتاح', m(shift.starting_cash), { size: 20 })];
        if (shift.within_window === true) group.push(r('+ المبيعات النقدية بعد المرتجعات', m(shift.cash_sales), { size: 20 }),
            r('- مصروفات الصندوق', m(shift.cash_expenses), { size: 20 }), r('= النقد المتوقع', m(shift.expected_cash), { size: 20, weight: 700 }));
        else group.push(r('النقد المتوقع', m(shift.expected_cash), { size: 20 }));
        group.push(r('النقد الفعلي', nullable(shift.actual_cash), { size: 20 }), r('الفرق (عجز أو زيادة)', nullable(shift.variance), { size: 20 }));
        b.push(listBlock(...group));
    }
    if (arr(data.order_types).length) {
        b.push(heading('أنواع الطلبات'));
        pushRows(b, data.order_types, t => r(`${str(t.order_type_name)} (${Number(t.order_count || 0)})`, m(t.total_sales)));
    }
    if (arr(data.blockers?.open_shifts).length) b.push(heading(`مناوبات مفتوحة: ${data.blockers.open_shifts.map(shift => `#${str(shift.shift_id)} ${str(shift.cashier_name)}`).join('، ')}`));
    b.push(end(data.is_period ? 'نهاية التقرير الدوري' : `نهاية تقرير جرد ${kind}`));
    if (data.payload_hash) b.push(center(str(data.payload_hash).slice(0, 12), 16, 400));
    return b;
}

function categoryReport(data, isY) {
    const s = data.summary || {}, r = (label, value, options) => row(label, value, { rtl: true, ...options });
    const b = arabicHeader(data, isY ? 'Y' : 'تقرير الأصناف');
    if (isY) b.push(r('عدد الطلبات', Number(s.order_count || 0)), r('المجموع قبل خصم الطلب', reportMoney(s.subtotal)),
        r('خصم الأصناف', reportMoney(s.line_discount)), r('خصم الطلبات', reportMoney(s.order_discount)),
        r('الضريبة', reportMoney(s.tax)), r('الإجمالي', reportMoney(s.total), { size: 22, weight: 700 }), rule());
    b.push(center('المجموعات', 30, 700));
    pushRows(b, arr(data.categories), c => r(`${str(c.category_name)} (${str(c.qty_sold)})`, reportMoney(c.gross_revenue)));
    if (arr(data.subcategories).length) {
        b.push(heading('التصنيفات الفرعية'));
        for (const group of data.subcategories) {
            b.push(r(group.category_name, '', { weight: 700 }));
            pushRows(b, arr(group.rows), sub => r(`${str(sub.category_name)} (${str(sub.qty_sold)})`, reportMoney(sub.gross_revenue), { indent: 10 }));
        }
    }
    if (arr(data.items).length) {
        b.push(heading('الأصناف'));
        if (isY) b.push({ source: `#block(width: 100%, above: 0pt, below: 0pt)[#grid(columns: (135pt, 70pt, 341pt), gutter: 5pt, [#align(center)[${text('المبلغ د.أ', { size: 20, weight: 700 })}]], [#align(center)[${text('الكمية', { size: 20, weight: 700 })}]], [#align(right)[${text('الصنف', { size: 20, weight: 700, dir: 'rtl' })}]])]\n#v(2pt)\n`, lines: 2 }, rule(true));
        pushRows(b, data.items, item => isY
            ? yItem(item)
            : listBlock(r(item.item_name, `${str(item.qty_sold)}×`), r('', reportMoney(item.gross_revenue), { size: 20, indent: 12 })));
    }
    b.push(end(isY ? 'نهاية تقرير Y' : 'نهاية تقرير الأصناف'));
    return b;
}

function reportBlocks(job) {
    const d = job.data || {};
    switch (job.print_type) {
        case 'x_report': return shiftReport(d, false);
        case 'z_report': return shiftReport(d, true);
        case 'audit_report': return auditReport(d);
        case 'category_items_report': return categoryReport(d, false);
        case 'y_held_items_report': return categoryReport(d, true);
        case 'daily_summary_report': return dailySummary(d);
        case 'daily_sales_report': return dailySales(d);
        case 'daily_refunds_report': return dailyRefunds(d);
        case 'daily_expenses_report': return dailyExpenses(d);
        case 'expense_slip': return expenseSlip(d, false);
        case 'expense_cancel_slip': return expenseSlip(d, true);
        default: throw Object.assign(new Error('Unsupported report type.'), { code: 'TYPST_DOCUMENT_UNSUPPORTED', failureClass: 'permanent_safe' });
    }
}

function buildReportDocuments(job, { assetPrefix = 'assets' } = {}) {
    if (!supportsReport(job)) throw Object.assign(new Error('Unsupported report type.'), { code: 'TYPST_DOCUMENT_UNSUPPORTED', failureClass: 'permanent_safe' });
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(assetPrefix)) throw new TypeError('Invalid Typst asset prefix.');
    const blocks = reportBlocks(job), pages = [];
    const pageBudget = job.print_type === 'audit_report' ? MAX_AUDIT_LINES_PER_DOCUMENT : MAX_LINES_PER_DOCUMENT;
    let current = [], lines = 0;
    const flush = () => {
        if (!current.length) return;
        const source = [
            '#set page(width: 576pt, height: auto, margin: (left: 10pt, right: 10pt, top: 5pt, bottom: 60pt), fill: white)',
            '#set text(font: ("Noto Sans", "Noto Sans Arabic", "Noto Emoji"), size: 25pt, fill: black)',
            '#set par(leading: 5pt)', current.join('')
        ].join('\n');
        pages.push({ source, assets: [], width: WIDTH });
        current = []; lines = 0;
    };
    for (const block of blocks) {
        if (block.lines > pageBudget) unsupported('Report section exceeds one bounded page.');
        if (lines && lines + block.lines > pageBudget) flush();
        current.push(block.source); lines += block.lines;
    }
    flush();
    if (pages.length > 24) unsupported('Report exceeds the bounded page count.');
    return pages;
}

module.exports = { supportsReport, buildReportDocuments };
