const crypto = require('crypto');
const { getBusinessDayRange, getBusinessDateRange } = require('../utils/businessDate');
const { getFinancialMetricsForRange } = require('./financeMetrics');
const {
    REFUNDS_ROLLUP_JOIN,
    NET_TOTAL,
    NET_TAX,
    NET_CASH,
    NET_CARD,
    lineSubtotalAfterOrderDiscount,
    getRefundsByShift,
    paidOrderTimeSql,
} = require('./financialSql');
const { getShiftDiscountsByShift, getShiftVoidsByShift } = require('./shiftMetrics');
const { getCashExpensesByShift } = require('./expenseMetrics');
const { getRangeTotals: getPlatformReconciliationTotals } = require('./PlatformRemittanceService');
const { getPrintStoreInfo } = require('./printStoreInfo');

const toMoney = (value) => Number(Number(value || 0).toFixed(2));
const toQty = (value) => Number(Number(value || 0).toFixed(3));

function hashPayload(payload) {
    const copy = { ...payload };
    delete copy.payload_hash;
    return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

async function getStoreInfo(executor) {
    return getPrintStoreInfo(executor);
}

async function getOpenShifts(executor, range) {
    const [rows] = await executor.query(`
        SELECT s.id AS shift_id, s.user_id, u.name AS cashier_name, s.opened_at
        FROM shifts s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.status = 'open'
          AND s.opened_at < ?
          AND (
            s.opened_at >= ?
            OR EXISTS (
              SELECT 1 FROM orders o
              WHERE o.shift_id = s.id
                AND ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
                AND o.payment_method NOT IN ('unpaid_table', 'voided')
            )
            OR EXISTS (
              SELECT 1 FROM refunds r
              WHERE r.shift_id = s.id AND r.created_at >= ? AND r.created_at < ?
            )
            OR EXISTS (
              SELECT 1 FROM orders vo
              WHERE vo.shift_id = s.id
                AND vo.created_at >= ? AND vo.created_at < ?
                AND vo.payment_method = 'voided'
            )
            OR EXISTS (
              SELECT 1 FROM expenses e
              WHERE e.shift_id = s.id AND e.created_at >= ? AND e.created_at < ?
            )
          )
        ORDER BY s.opened_at ASC, s.id ASC
    `, [
        range.end,
        range.start,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
    ]);
    return rows.map(row => ({
        shift_id: row.shift_id,
        user_id: row.user_id,
        cashier_name: row.cashier_name || 'Unknown',
        opened_at: row.opened_at,
    }));
}

async function getShiftSections(executor, range) {
    const [shifts] = await executor.query(`
        SELECT s.id AS shift_id, s.user_id, u.name AS cashier_name, s.starting_cash,
               s.expected_cash, s.actual_cash, s.opened_at, s.closed_at, s.status,
               CASE WHEN s.status='closed' AND s.closed_at >= ? AND s.closed_at < ? THEN 1 ELSE 0 END AS closed_in_window,
               CASE WHEN s.opened_at >= ? AND s.status='closed' AND s.closed_at >= ? AND s.closed_at < ? THEN 1 ELSE 0 END AS within_window
        FROM shifts s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.opened_at < ?
          AND (
            s.opened_at >= ?
            OR (s.closed_at >= ? AND s.closed_at < ?)
            OR EXISTS (
              SELECT 1 FROM orders o
              WHERE o.shift_id = s.id
                AND ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
                AND o.payment_method NOT IN ('unpaid_table', 'voided')
            )
            OR EXISTS (
              SELECT 1 FROM refunds r
              WHERE r.shift_id = s.id AND r.created_at >= ? AND r.created_at < ?
            )
            OR EXISTS (
              SELECT 1 FROM orders vo
              WHERE vo.shift_id = s.id
                AND vo.created_at >= ? AND vo.created_at < ?
                AND vo.payment_method = 'voided'
            )
            OR EXISTS (
              SELECT 1 FROM expenses e
              WHERE e.shift_id = s.id AND e.created_at >= ? AND e.created_at < ?
            )
          )
        ORDER BY s.opened_at ASC, s.id ASC
    `, [
        range.start, range.end,
        range.start, range.start, range.end,
        range.end,
        range.start,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
        range.start, range.end,
    ]);

    if (shifts.length === 0) return [];

    const shiftIds = shifts.map(shift => shift.shift_id);
    const placeholders = shiftIds.map(() => '?').join(',');
    const [totals] = await executor.query(`
        SELECT o.shift_id,
               COUNT(o.invoice_id) AS order_count,
               COALESCE(SUM(o.total), 0) AS gross_sales,
               COALESCE(SUM(o.cash_amount), 0) AS cash_sales,
               COALESCE(SUM(o.card_amount), 0) AS card_sales,
               COALESCE(SUM(CASE WHEN o.payment_method='platform' THEN o.total ELSE 0 END), 0) AS platform_sales,
               COALESCE(SUM(o.tax), 0) AS total_tax
        FROM orders o
        WHERE o.shift_id IN (${placeholders})
          AND ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY o.shift_id
    `, [...shiftIds, range.start, range.end]);

    const totalsByShift = new Map(totals.map(row => [row.shift_id, row]));
    const refundsByShift = await getRefundsByShift(executor, shiftIds, range);
    const discountsByShift = await getShiftDiscountsByShift(executor, shiftIds, range);
    const voidsByShift = await getShiftVoidsByShift(executor, shiftIds, range);
    const expensesByShift = await getCashExpensesByShift(executor, shiftIds, range);

    return shifts.map(shift => {
        const total = totalsByShift.get(shift.shift_id) || {};
        const refunds = refundsByShift[shift.shift_id] || { refund_count: 0, amt: 0, cash: 0, card: 0, platform: 0, tax: 0 };
        const discounts = discountsByShift[shift.shift_id] || { order_discounts: 0, line_discounts: 0, total_discounts: 0 };
        const voids = voidsByShift[shift.shift_id] || { void_count: 0, void_value: 0 };
        const startingCash = toMoney(shift.starting_cash);
        const cashSales = toMoney(Number(total.cash_sales || 0) - refunds.cash);
        const cashExpenses = toMoney(expensesByShift[shift.shift_id] || 0);
        const expectedCash = shift.status === 'closed'
            ? (shift.expected_cash == null ? null : toMoney(shift.expected_cash))
            : toMoney(startingCash + cashSales - cashExpenses);
        const actualCash = shift.status === 'closed' && shift.actual_cash != null
            ? toMoney(shift.actual_cash)
            : null;
        const variance = actualCash === null || shift.expected_cash == null
            ? null
            : toMoney(actualCash - Number(shift.expected_cash));

        return {
            shift_id: shift.shift_id,
            user_id: shift.user_id,
            cashier_name: shift.cashier_name || 'Unknown',
            status: shift.status,
            opened_at: shift.opened_at,
            closed_at: shift.closed_at,
            closed_in_window: Boolean(Number(shift.closed_in_window)),
            within_window: Boolean(Number(shift.within_window)),
            starting_cash: startingCash,
            gross_sales: toMoney(Number(total.gross_sales || 0) - refunds.amt),
            cash_sales: cashSales,
            cash_expenses: cashExpenses,
            card_sales: toMoney(Number(total.card_sales || 0) - refunds.card),
            platform_sales: toMoney(Number(total.platform_sales || 0) - refunds.platform),
            total_tax: toMoney(Number(total.total_tax || 0) - refunds.tax),
            total_discounts: toMoney(discounts.total_discounts),
            line_discounts: toMoney(discounts.line_discounts),
            order_discounts: toMoney(discounts.order_discounts),
            refund_count: refunds.refund_count,
            refund_value: toMoney(refunds.amt),
            void_count: voids.void_count,
            void_value: toMoney(voids.void_value),
            order_count: Number(total.order_count || 0),
            expected_cash: expectedCash,
            actual_cash: actualCash,
            variance,
        };
    });
}



async function getItems(executor, range) {
    const [rows] = await executor.query(`
        SELECT
            COALESCE(oi.item_name, p.name, 'Unknown') AS item_name,
            SUM(GREATEST(0, oi.quantity - COALESCE(rfi.rq, 0))) AS qty_sold,
            SUM(GREATEST(0,
                ${lineSubtotalAfterOrderDiscount('oi', 'o')}
                + COALESCE(oi.tax_amount, 0)
                - COALESCE(rfi.rs, 0)
                - COALESCE(rfi.rt, 0)
            )) AS gross_revenue
        FROM order_items oi
        JOIN orders o ON oi.invoice_id = o.invoice_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN (
            SELECT ri.order_item_id, SUM(ri.quantity) AS rq, SUM(ri.line_subtotal) AS rs, SUM(ri.line_tax) AS rt
            FROM refund_items ri
            JOIN refunds r ON r.id = ri.refund_id
            WHERE r.kind = 'refund'
            GROUP BY ri.order_item_id
        ) rfi ON rfi.order_item_id = oi.id
        WHERE ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY COALESCE(oi.item_name, p.name, 'Unknown')
        ORDER BY gross_revenue DESC, item_name ASC
    `, [range.start, range.end]);

    return rows.map(row => ({
        item_name: row.item_name,
        qty_sold: toQty(row.qty_sold),
        gross_revenue: toMoney(row.gross_revenue),
    }));
}

async function getOrderTypes(executor, range) {
    const [rows] = await executor.query(`
        SELECT COALESCE(ot.name, 'Standard') AS order_type_name,
               COUNT(o.invoice_id) AS order_count,
               COALESCE(SUM(${NET_TOTAL}), 0) AS total_sales
        FROM orders o
        LEFT JOIN order_types ot ON o.order_type_id = ot.id
        ${REFUNDS_ROLLUP_JOIN}
        WHERE ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY COALESCE(ot.name, 'Standard')
        ORDER BY total_sales DESC
    `, [range.start, range.end]);

    return rows.map(row => ({
        order_type_name: row.order_type_name,
        order_count: Number(row.order_count || 0),
        total_sales: toMoney(row.total_sales),
    }));
}

function buildCashReconciliation(shifts) {
    let open_shifts = 0;
    let closed_shifts = 0;
    let closed_outside_window = 0;
    let uncounted_shifts = 0;
    let shifts_needing_review = 0;
    let net_variance_total = 0;
    let shortage_total = 0;
    let overage_total = 0;
    let moneyIncomplete = false;

    for (const shift of shifts) {
        if (shift.status !== 'closed') {
            open_shifts++;
            moneyIncomplete = true;
            continue;
        }
        if (!shift.closed_in_window) {
            closed_outside_window++;
            continue;
        }
        closed_shifts++;
        if (shift.actual_cash == null || shift.expected_cash == null || shift.variance == null) {
            uncounted_shifts++;
            moneyIncomplete = true;
            continue;
        }
        net_variance_total = toMoney(net_variance_total + shift.variance);
        if (shift.variance < 0) shortage_total = toMoney(shortage_total + Math.abs(shift.variance));
        else if (shift.variance > 0) overage_total = toMoney(overage_total + shift.variance);
        if (Math.abs(shift.variance) >= 0.01) shifts_needing_review++;
    }

    return {
        cash_expenses_total: toMoney(shifts.reduce((sum, shift) => sum + Number(shift.cash_expenses || 0), 0)),
        open_shifts,
        closed_shifts,
        closed_outside_window,
        uncounted_shifts,
        shifts_needing_review,
        net_variance_total: moneyIncomplete || closed_shifts === 0 ? null : toMoney(net_variance_total),
        shortage_total: moneyIncomplete || closed_shifts === 0 ? null : toMoney(shortage_total),
        overage_total: moneyIncomplete || closed_shifts === 0 ? null : toMoney(overage_total),
    };
}

async function buildAuditReportPayload(executor, options) {
    const isPeriod = Boolean(options.startDate);
    const businessDate = options.businessDate || null;
    const periodStartDate = isPeriod ? options.startDate : null;
    const periodEndDate = isPeriod ? (options.endDate || options.startDate) : null;
    const range = isPeriod
        ? getBusinessDateRange(periodStartDate, periodEndDate)
        : getBusinessDayRange(businessDate);
    const [
        storeInfo,
        summary,
        shifts,
        orderTypes,
        openShifts,
        platformReconciliation,
    ] = await Promise.all([
        getStoreInfo(executor),
        getFinancialMetricsForRange(executor, { start: range.start, end: range.end }),
        getShiftSections(executor, range),
        getOrderTypes(executor, range),
        getOpenShifts(executor, range),
        getPlatformReconciliationTotals(executor, {
            startDate: periodStartDate || businessDate,
            endDate: periodEndDate || businessDate,
        }),
    ]);

    const cashSales = toMoney(summary.cash_sales);
    const cardSales = toMoney(summary.card_sales);
    const platformSales = toMoney(summary.platform_sales);
    const payload = {
        print_type: 'audit_report',
        report_type: isPeriod ? 'period' : options.reportType,
        is_period: isPeriod,
        serial_label: options.serialLabel || null,
        copy_label: options.copyLabel || 'ORIGINAL',
        business_date: businessDate,
        period_start_date: periodStartDate,
        period_end_date: periodEndDate,
        business_start_at: range.start,
        business_end_at: range.end,
        generated_at: new Date().toISOString(),
        generated_by: {
            id: options.generatedByUser?.id || null,
            name: options.generatedByUser?.name || 'Unknown',
        },
        storeInfo,
        summary: {
            total_orders: Number(summary.total_orders || 0),
            sales_incl_tax: toMoney(summary.sales_incl_tax),
            net_sales_pre_tax: toMoney(summary.net_sales_pre_tax),
            tax_collected: toMoney(summary.tax_collected),
            discounts_total: toMoney(summary.discounts_total),
            line_discounts_total: toMoney(summary.line_discounts_total),
            order_discounts_total: toMoney(summary.order_discounts_total),
            refunds_total: toMoney(summary.refunds_total),
            refund_count: Number(summary.refund_count || 0),
            void_count: Number(summary.void_count || 0),
            void_value: toMoney(summary.void_value),
            avg_check: toMoney(summary.avg_check),
        },
        payments: {
            cash_sales: cashSales,
            card_sales: cardSales,
            platform_sales: platformSales,
            total_collected: toMoney(cashSales + cardSales),
        },
        platform_reconciliation: platformReconciliation,
        cash_reconciliation: buildCashReconciliation(shifts),
        shifts,
        order_types: orderTypes,
        blockers: {
            open_shifts: openShifts,
        },
    };

    payload.payload_hash = hashPayload(payload);
    return payload;
}

module.exports = {
    buildAuditReportPayload,
    hashPayload,
    getItems,
    getStoreInfo,
};
