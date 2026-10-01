function addDateDays(dateString, days) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
}

function normalizePeriod(period = {}) {
    const startDate = period.start_date ?? period.startDate;
    const endDate = period.end_date ?? period.endDate ?? startDate;
    if (!startDate || !endDate) {
        throw new Error('Report period is missing start_date or end_date.');
    }
    const startHour = Number.isInteger(Number(period.business_day_start_hour))
        ? Number(period.business_day_start_hour)
        : 6;
    const endHour = (startHour + 23) % 24;
    return {
        ...period,
        start_date: startDate,
        end_date: endDate,
        window_label: `${startDate} ${String(startHour).padStart(2, '0')}:00 → ${addDateDays(endDate, 1)} ${String(endHour).padStart(2, '0')}:59`
    };
}

function reportIdentity(printType, period) {
    return `${printType}:${period.start_date}:${period.end_date}`;
}

export function buildDailySummaryPrintPayload(report) {
    const period = normalizePeriod(report.period);
    return {
        print_type: 'daily_summary_report',
        report_id: reportIdentity('daily_summary_report', period),
        period,
        summary: report.summary,
        comparison: report.comparison,
        payments: report.payments,
        platform_reconciliation: report.platform_reconciliation,
        order_types: report.order_types,
        hourly_sales: report.hourly_sales,
        cash_status: report.cash_status
    };
}

export function buildDailySalesPrintPayload(report) {
    const period = normalizePeriod(report.period);
    const products = (report.products || []).filter(p => p.note !== 'Auto-Gratuity' && p.item_name !== 'Service Charge');
    return {
        print_type: 'daily_sales_report',
        report_id: reportIdentity('daily_sales_report', period),
        period,
        totals: report.totals,
        categories: report.categories || [],
        products,
        order_types: report.order_types || [],
        cashiers: report.cashiers || [],
        waiters: report.waiters || [],
        tables: report.tables || [],
        tables_enabled: report.tables_enabled
    };
}

export function buildDailyRefundPrintPayload(report) {
    const period = normalizePeriod(report.period);
    return {
        print_type: 'daily_refunds_report',
        report_id: reportIdentity('daily_refunds_report', period),
        period,
        summary: report.summary,
        by_staff: report.by_staff || [],
        top_reasons: report.top_reasons || [],
        events: report.events || []
    };
}

export function buildDailyExpensePrintPayload(report) {
    const period = normalizePeriod(report.period);
    return {
        print_type: 'daily_expenses_report',
        report_id: reportIdentity('daily_expenses_report', period),
        period,
        summary: report.summary,
        sales_collected: report.sales_collected,
        remaining_after_expenses: report.remaining_after_expenses,
        by_source: report.by_source || [],
        by_category: report.by_category || [],
        entries: report.entries || []
    };
}

export function buildDailyIngredientsPrintPayload(report) {
    const period = normalizePeriod(report.period || {
        start_date: report.date,
        end_date: report.date,
    });
    return {
        print_type: 'daily_ingredients_report',
        report_id: reportIdentity('daily_ingredients_report', period),
        period,
        date: report.date,
        ingredients: report.ingredients || [],
        waste_by_reason: report.waste_by_reason || {},
        totals: report.totals
    };
}
