const HTML_ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

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

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/[&<>"']/g, char => HTML_ESCAPE_MAP[char]);
}

function isArabic(data) {
    return data?.language === 'ar' || data?.direction === 'rtl';
}

function label(data, key) {
    const pair = LABELS[key] || [key, key];
    return pair[isArabic(data) ? 1 : 0];
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function currency(data) {
    return isArabic(data) ? 'د.أ' : 'JD';
}

function paymentAmount(data, key) {
    const row = (Array.isArray(data.payments) ? data.payments : []).find(payment => payment.key === key);
    return Number(row?.amount) || 0;
}

function line(data, key, value, className = 'font-bold') {
    return `<div class="text-lr ${className}"><span>${escapeHtml(label(data, key))}</span><span>${value}</span></div>`;
}

function heading(data, key) {
    return `<div class="text-center font-black text-lg mt-2 mb-2 uppercase">${escapeHtml(label(data, key))}</div>`;
}

function eventReason(data, reason) {
    if (reason === 'Item removed from table') return label(data, 'itemRemovedFromTable');
    if (reason === 'Table cleared') return label(data, 'tableCleared');
    return reason || '—';
}

function header(data, key) {
    return `
        <div class="text-center mb-4">
            <div class="kitchen-header mt-2">${escapeHtml(label(data, key))}</div>
            <div class="text-center font-black text-lg mt-1 mb-2">${escapeHtml(data.period?.window_label)}</div>
        </div>
        <div class="solid-line"></div>`;
}

function endOfReport(data) {
    return `
        <div class="solid-line" style="margin-top: 16px;"></div>
        <div class="text-center font-bold text-sm mt-4">--- ${escapeHtml(label(data, 'end'))} ---</div>`;
}

function wrapper(data, body) {
    const rtl = isArabic(data);
    return `<div dir="${rtl ? 'rtl' : 'ltr'}" style="text-align:${rtl ? 'right' : 'left'};font-family:${rtl ? "'Arial', sans-serif" : 'sans-serif'};">${body}</div>`;
}

function renderVoidKitchenHeader(data, {
    now = new Date(),
    formatDateTime
} = {}) {
    if (data?.void_ticket !== true) return '';
    if (typeof formatDateTime !== 'function') {
        throw new TypeError('formatDateTime is required.');
    }

    const tableNumber = escapeHtml(data.table_number);
    const printedAt = escapeHtml(formatDateTime(now));
    const orderedAt = escapeHtml(formatDateTime(data.order_taken_at));

    return `
        <div class="dashed-line"></div>
        <div class="total-box" style="justify-content: center; margin-top: 8px;">TABLE: ${tableNumber}</div>
        <div dir="rtl" class="mt-2 mb-2">
            <div class="text-lr font-bold"><span>وقت الطباعة</span><span dir="ltr">${printedAt}</span></div>
            <div class="text-lr font-bold"><span>وقت الطلب</span><span dir="ltr">${orderedAt}</span></div>
        </div>
        <div class="solid-line"></div>
        <div dir="rtl" class="text-center font-black text-2xl mb-2">تم إلغاء هذا الصنف</div>`;
}

function renderSubscriptionKitchenHeader(data, { formatDateTime } = {}) {
    const redemption = data?.subscription_redemption;
    if (!redemption) return '';
    if (typeof formatDateTime !== 'function') {
        throw new TypeError('formatDateTime is required.');
    }
    const title = redemption.is_void
        ? 'تم إلغاء وجبة الاشتراك / SUBSCRIPTION MEAL VOID'
        : 'وجبة اشتراك / SUBSCRIPTION MEAL';
    return `
        <div class="kitchen-header">${title}</div>
        <div class="dashed-line"></div>
        <div class="text-center font-black text-xl">${escapeHtml(redemption.reference)}</div>
        ${redemption.customer_name ? `<div class="text-center font-bold text-lg">${escapeHtml(redemption.customer_name)}</div>` : ''}
        ${redemption.customer_phone ? `<div class="text-center font-bold text-lg">${escapeHtml(redemption.customer_phone)}</div>` : ''}
        <div class="text-center font-bold text-lg">${escapeHtml(formatDateTime(data.date))}</div>
        <div class="dashed-line"></div>`;
}

function cashStatusLabel(data, cash) {
    if (cash.state === 'no_shifts' && Number(cash.closed_outside_window) > 0) {
        return isArabic(data)
            ? 'لا توجد مناوبات أُغلقت ضمن فترة التقرير'
            : 'No shifts settled in this report window';
    }
    return label(data, cash.state || 'no_shifts');
}

function renderDailyCashStatus(data, cash, cur) {
    const parts = [
        line(data, 'closedShifts', escapeHtml(cash.closed_shifts || 0)),
        line(data, 'openShifts', escapeHtml(cash.open_shifts || 0)),
        line(data, 'uncountedShifts', escapeHtml(cash.uncounted_shifts || 0)),
    ];
    if (Number(cash.closed_outside_window) > 0) {
        parts.push(line(data, 'settledAnotherDay', escapeHtml(Number(cash.closed_outside_window))));
    }
    if (Number(cash.closed_shifts) > 0 && cash.net_variance !== null && cash.net_variance !== undefined) {
        const net = `${Number(cash.net_variance) > 0 ? '+' : ''}${money(cash.net_variance)} ${cur}`;
        parts.push(line(data, 'shortageTotal', `${money(cash.shortage_total)} ${cur}`));
        parts.push(line(data, 'overageTotal', `${money(cash.overage_total)} ${cur}`));
        parts.push(line(data, 'netVariance', net));
    } else if (cash.state === 'in_progress') {
        parts.push(`<div class="text-lr font-bold"><span>${escapeHtml(label(data, 'reconciliationInProgress'))}</span><span></span></div>`);
    }
    parts.push(`<div class="total-box" style="margin-top:8px;"><span>${escapeHtml(label(data, 'cashStatus'))}</span><span>${escapeHtml(cashStatusLabel(data, cash))}</span></div>`);
    return parts.join('\n        ');
}

function renderDailySummaryReport(data) {
    const sum = data.summary || {};
    const cash = data.cash_status || {};
    const cur = escapeHtml(currency(data));

    return wrapper(data, `
        ${header(data, 'summaryTitle')}
        ${line(data, 'salesCollected', `${money(sum.sales_collected)} ${cur}`)}
        ${Number(sum.expenses_total || 0) !== 0 ? line(data, 'expensesRecorded', `${money(sum.expenses_total)} ${cur}`) : ''}
        ${Number(sum.expenses_total || 0) !== 0 ? line(data, 'remainingAfterExpenses', `${money(sum.remaining_after_expenses)} ${cur}`) : ''}
        ${line(data, 'salesProcessed', `${money(sum.sales_processed)} ${cur}`)}
        ${line(data, 'refundsIssued', `-${money(sum.refunds_issued)} ${cur}`)}
        ${line(data, 'netRevenue', `${money(sum.net_revenue_pre_tax)} ${cur}`)}
        ${line(data, 'tax', `${money(sum.tax_collected)} ${cur}`)}
        ${Number(sum.service_charges_collected || 0) !== 0 ? line(data, 'serviceCharges', `${money(sum.service_charges_collected)} ${cur}`) : ''}
        <div class="dashed-line"></div>
        ${line(data, 'cashPayments', `${money(paymentAmount(data, 'cash'))} ${cur}`)}
        ${line(data, 'cardPayments', `${money(paymentAmount(data, 'card'))} ${cur}`)}
        ${line(data, 'platformSales', `${money(paymentAmount(data, 'platform'))} ${cur}`)}
        <div class="dashed-line"></div>
        ${line(data, 'totalOrders', escapeHtml(sum.total_orders || 0))}
        ${line(data, 'averageTicket', `${money(sum.average_ticket)} ${cur}`)}
        ${line(data, 'discountedOrders', escapeHtml(sum.discounted_orders || 0))}
        ${line(data, 'refundEvents', escapeHtml(sum.refund_count || 0))}
        ${line(data, 'voidEvents', escapeHtml(sum.void_count || 0))}
        <div class="dashed-line"></div>
        ${renderDailyCashStatus(data, cash, cur)}
        <div class="text-center font-bold text-xs mt-4">${escapeHtml(label(data, 'refundsTiming'))}</div>
        ${endOfReport(data)}`);
}

function appendCategory(html, data, category, depth = 0) {
    const indent = Math.min(depth, 4) * 16;
    html.push(`<div class="text-lr ${depth ? 'font-normal' : 'font-bold'}" style="padding-inline-start:${indent}px;"><span>${depth ? '• ' : ''}${escapeHtml(category.name)}</span><span>${escapeHtml(category.sold_qty)} / ${money(category.net_sales)} ${escapeHtml(currency(data))}</span></div>`);
    for (const child of Array.isArray(category.subcategories) ? category.subcategories : []) {
        appendCategory(html, data, child, depth + 1);
    }
}

function renderDailySalesReport(data) {
    const totals = data.totals || {};
    const categories = Array.isArray(data.categories) ? data.categories : [];
    const products = Array.isArray(data.products) ? data.products : [];
    const cur = escapeHtml(currency(data));
    const html = [header(data, 'salesTitle')];
    html.push(line(data, 'salesCollected', `${money(totals.sales_collected)} ${cur}`));
    html.push(line(data, 'menuSales', `${money(totals.menu_sales)} ${cur}`));
    html.push(line(data, 'serviceCharges', `${money(totals.service_charges_collected)} ${cur}`));

    if (categories.length) {
        html.push('<div class="dashed-line"></div>', heading(data, 'salesByCategory'));
        for (const category of categories) appendCategory(html, data, category);
    }
    if (products.length) {
        html.push('<div class="dashed-line"></div>', heading(data, 'products'));
        html.push(`<div class="item-header"><div class="col-name">${escapeHtml(label(data, 'product'))}</div><div class="col-total">${escapeHtml(label(data, 'qtyNet'))}</div></div><div class="solid-line"></div>`);
        for (const product of products) {
            const qty = `${product.sold_qty}${Number(product.returned_qty) > 0 ? `/${product.returned_qty}` : ''}`;
            html.push(`<div class="item-row"><div class="col-name">${escapeHtml(product.item_name)}</div><div class="col-total">${escapeHtml(qty)} - ${money(product.net_sales)} ${cur}</div></div>`);
        }
    }

    const sections = [
        ['order_types', 'orderTypes', row => `${escapeHtml(row.name)} (${escapeHtml(row.orders)})`],
        ['cashiers', 'cashiers', row => `${escapeHtml(row.name)} (${escapeHtml(row.orders)})`],
        ['waiters', 'waiters', row => `${escapeHtml(row.name)} (${escapeHtml(row.orders)})`],
        ['tables', 'tables', row => `${escapeHtml(label(data, 'table'))} ${escapeHtml(row.table_number)} (${escapeHtml(row.section_name)})`],
    ];
    for (const [field, title, nameFor] of sections) {
        const rows = Array.isArray(data[field]) ? data[field] : [];
        if (!rows.length || ((field === 'waiters' || field === 'tables') && !data.tables_enabled)) continue;
        html.push('<div class="dashed-line"></div>', heading(data, title));
        for (const row of rows) html.push(`<div class="text-lr font-bold"><span>${nameFor(row)}</span><span>${money(row.net_sales)} ${cur}</span></div>`);
    }

    html.push('<div class="dashed-line"></div>');
    html.push(`<div class="text-center font-bold text-xs leading-normal">${escapeHtml(label(data, 'salesNote'))}</div>`);
    html.push(endOfReport(data));
    return wrapper(data, html.join(''));
}

function renderDailyRefundsReport(data) {
    const sum = data.summary || {};
    const byStaff = Array.isArray(data.by_staff) ? data.by_staff : [];
    const reasons = Array.isArray(data.top_reasons) ? data.top_reasons : [];
    const events = Array.isArray(data.events) ? data.events : [];
    const cur = escapeHtml(currency(data));
    const html = [header(data, 'refundsTitle')];
    html.push(line(data, 'salesProcessed', `${money(sum.sales_processed)} ${cur}`));
    html.push(line(data, 'refundsIssued', `-${money(sum.refund_total)} ${cur}`));
    html.push(line(data, 'refundRate', sum.refund_rate == null ? '—' : `${escapeHtml(sum.refund_rate)}%`));
    html.push(line(data, 'voidValue', `${money(sum.void_value)} ${cur}`));

    if (byStaff.length) {
        html.push('<div class="dashed-line"></div>', heading(data, 'staffActivity'));
        html.push(`<div class="item-header"><div class="col-name">${escapeHtml(label(data, 'staff'))}</div><div class="col-total">${escapeHtml(label(data, 'refundVoid'))}</div></div><div class="solid-line"></div>`);
        for (const staff of byStaff) html.push(`<div class="item-row"><div class="col-name">${escapeHtml(staff.name)}</div><div class="col-total">${money(staff.refund_value)} / ${money(staff.void_value)}</div></div>`);
    }
    if (reasons.length) {
        html.push('<div class="dashed-line"></div>', heading(data, 'topReasons'));
        for (const reason of reasons) html.push(`<div class="text-lr font-bold"><span>${escapeHtml(eventReason(data, reason.reason))} (${escapeHtml(reason.count)})</span><span>${money(reason.value)} ${cur}</span></div>`);
    }

    html.push('<div class="dashed-line"></div>', heading(data, 'refundVoidEvents'));
    if (!events.length) {
        html.push(`<div class="text-center font-bold text-sm mt-2">${escapeHtml(label(data, 'noEvents'))}</div>`);
    }
    for (const event of events) {
        const eventKind = event.kind === 'void' ? label(data, 'void') : label(data, 'refund');
        const eventIdentity = event.kind === 'void' && event.table_number !== null && event.table_number !== undefined && event.table_number !== ''
            ? `${label(data, 'tableIdentity')} ${event.table_number}`
            : `#${event.invoice_display_no || event.invoice_id || '—'}`;
        html.push(`<div style="border-bottom:1px dashed #999;padding-bottom:6px;margin-bottom:8px;">`);
        html.push(`<div class="text-lr font-bold"><span>${escapeHtml(eventIdentity)} (${escapeHtml(eventKind)})</span><span>${escapeHtml(event.occurred_at_local)}</span></div>`);
        html.push(`<div class="text-lr text-sm"><span>${escapeHtml(label(data, 'amount'))}: ${money(event.event_value)} ${cur}</span><span>${escapeHtml(event.cashier_name)}</span></div>`);
        html.push(`<div class="text-sm">${escapeHtml(label(data, 'method'))}: ${escapeHtml(label(data, event.refund_method || ''))}</div>`);
        html.push(`<div class="text-sm italic">${escapeHtml(label(data, 'reason'))}: ${escapeHtml(eventReason(data, event.reason))}</div>`);
        const items = Array.isArray(event.items) ? event.items : [];
        if (items.length) {
            html.push('<div style="padding-inline-start:10px;margin-top:4px;border-inline-start:2px solid #999;">');
            for (const item of items) html.push(`<div class="text-lr text-sm"><span>• ${escapeHtml(item.item_name)} × ${escapeHtml(item.quantity)}</span><span>${money(item.line_total)} ${cur}</span></div>`);
            html.push('</div>');
        }
        html.push('</div>');
    }
    html.push('<div class="dashed-line"></div>');
    html.push(`<div class="text-center font-bold text-xs leading-normal">${escapeHtml(label(data, 'voidNote'))}</div>`);
    html.push(endOfReport(data));
    return wrapper(data, html.join(''));
}

function renderDailyExpensesReport(data) {
    const sum = data.summary || {};
    const categories = Array.isArray(data.by_category) ? data.by_category : [];
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const cur = escapeHtml(currency(data));
    const html = [header(data, 'expensesTitle')];
    html.push(line(data, 'salesCollected', `${money(data.sales_collected)} ${cur}`));
    html.push(line(data, 'expensesRecorded', `${money(sum.total)} ${cur}`));
    html.push(line(data, 'drawerExpenses', `${money(sum.drawer)} ${cur}`));
    html.push(line(data, 'outsideExpenses', `${money(sum.outside)} ${cur}`));
    html.push(`<div class="total-box" style="margin-top:8px;"><span>${escapeHtml(label(data, 'remainingAfterExpenses'))}</span><span>${money(data.remaining_after_expenses)} ${cur}</span></div>`);

    if (categories.length) {
        html.push('<div class="dashed-line"></div>', heading(data, 'byCategory'));
        for (const category of categories) {
            html.push(`<div class="text-lr font-bold"><span>${escapeHtml(category.category_name)} (${escapeHtml(category.count || 0)})</span><span>${money(category.total)} ${cur}</span></div>`);
        }
    }

    html.push('<div class="dashed-line"></div>', heading(data, 'expenseEntries'));
    if (!entries.length) html.push(`<div class="text-center font-bold text-sm mt-2">${escapeHtml(label(data, 'noExpenses'))}</div>`);
    for (const entry of entries) {
        const canceled = entry.status === 'canceled';
        const source = label(data, entry.source === 'drawer' ? 'drawer' : 'outside');
        html.push(`<div style="border-bottom:1px dashed #999;padding-bottom:6px;margin-bottom:8px;${canceled ? 'opacity:.65;' : ''}">`);
        html.push(`<div class="text-lr font-black"><span>#${escapeHtml(entry.id)} ${escapeHtml(entry.category_name)}</span><span>${money(entry.amount)} ${cur}</span></div>`);
        html.push(`<div class="text-lr text-sm"><span>${escapeHtml(source)}${entry.shift_id ? ` #${escapeHtml(entry.shift_id)}` : ''}</span><span>${escapeHtml(entry.created_at)}</span></div>`);
        html.push(`<div class="text-sm">${escapeHtml(label(data, 'recordedBy'))}: ${escapeHtml(entry.created_by_name)}</div>`);
        if (entry.note) html.push(`<div class="text-sm">${escapeHtml(label(data, 'note'))}: ${escapeHtml(entry.note)}</div>`);
        if (canceled) html.push(`<div class="font-black">${escapeHtml(label(data, 'canceled'))}${entry.canceled_by_name ? ` - ${escapeHtml(entry.canceled_by_name)}` : ''}</div>`);
        html.push('</div>');
    }
    html.push(endOfReport(data));
    return wrapper(data, html.join(''));
}

function renderExpenseSlip(data, canceled = false) {
    const cur = escapeHtml(currency(data));
    const title = canceled ? 'expenseCancelTitle' : 'expenseSlipTitle';
    const source = label(data, data.source === 'drawer' ? 'drawer' : 'outside');
    return wrapper(data, `
        <div class="text-center font-black text-2xl mt-2">${escapeHtml(data.storeInfo?.store_name || 'POS System')}</div>
        <div class="kitchen-header mt-2">${escapeHtml(label(data, title))}</div>
        <div class="text-center font-black text-xl mt-2">#${escapeHtml(data.id)}</div>
        <div class="solid-line"></div>
        ${line(data, 'category', escapeHtml(data.category_name))}
        ${line(data, 'source', escapeHtml(source))}
        ${data.shift_id ? line(data, 'shift', `#${escapeHtml(data.shift_id)}`) : ''}
        ${line(data, 'recordedBy', escapeHtml(data.created_by_name))}
        ${line(data, 'time', escapeHtml(data.created_at))}
        ${data.note ? line(data, 'note', escapeHtml(data.note), 'font-normal') : ''}
        ${canceled ? '<div class="dashed-line"></div>' : ''}
        ${canceled ? line(data, 'canceledBy', escapeHtml(data.canceled_by_name)) : ''}
        ${canceled ? line(data, 'time', escapeHtml(data.canceled_at)) : ''}
        <div class="total-box" style="margin-top:10px;"><span>${escapeHtml(label(data, 'amount'))}</span><span>${money(data.amount)} ${cur}</span></div>`);
}

function renderReportSection(printType, data) {
    const renderers = {
        daily_summary_report: renderDailySummaryReport,
        daily_sales_report: renderDailySalesReport,
        daily_refunds_report: renderDailyRefundsReport,
        daily_expenses_report: renderDailyExpensesReport,
        expense_slip: data => renderExpenseSlip(data, false),
        expense_cancel_slip: data => renderExpenseSlip(data, true),
    };
    return renderers[printType]?.(data || {}) || '';
}

module.exports = {
    escapeHtml,
    renderReportSection,
    renderVoidKitchenHeader,
    renderSubscriptionKitchenHeader
};
