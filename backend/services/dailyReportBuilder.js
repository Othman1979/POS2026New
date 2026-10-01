const { roundMoney } = require('./PosCalculator');
const {
    allocateRefundPayment,
    combineFinancialEvents,
    getFinancialEventsForPeriod,
} = require('./financialEventMetrics');
const { buildOrderTypeBreakdown } = require('./dailyReportDimensions');
const { getExpenseTotalsForRange } = require('./expenseMetrics');
const { getRangeTotals: getPlatformReconciliationTotals } = require('./PlatformRemittanceService');

function buildComparison(current, prior) {
    const keys = ['sales_collected', 'total_orders', 'average_ticket'];
    const comparison = {};
    for (const key of keys) {
        const curVal = Number(current[key]) || 0;
        const priVal = Number(prior[key]) || 0;
        const amount = roundMoney(curVal - priVal);
        let percent = null;
        if (priVal > 0) {
            percent = roundMoney((amount / priVal) * 100);
        } else if (priVal < 0) {
            percent = roundMoney((amount / Math.abs(priVal)) * 100);
        }
        comparison[key] = { amount, percent };
    }
    return comparison;
}

async function buildDailySummary(executor, period) {
    const { getBusinessSqlOffset, getBusinessDateRange } = require('../utils/businessDate');
    const offset = getBusinessSqlOffset();

    const compRange = getBusinessDateRange(period.comparison_start_date, period.comparison_end_date);

    const currentMetrics = await getFinancialEventsForPeriod(executor, period.business_start_at, period.business_end_at);
    const priorMetrics = await getFinancialEventsForPeriod(executor, compRange.start, compRange.end);

    const currentCombined = combineFinancialEvents(currentMetrics, currentMetrics);
    const priorCombined = combineFinancialEvents(priorMetrics, priorMetrics);
    const expenses = await getExpenseTotalsForRange(executor, {
        start: period.business_start_at,
        end: period.business_end_at,
    });
    const summary = {
        ...currentCombined,
        expenses_total: roundMoney(expenses.total),
        expense_count: expenses.count,
        drawer_expenses_total: roundMoney(expenses.drawer),
        outside_expenses_total: roundMoney(expenses.outside),
        remaining_after_expenses: roundMoney(currentCombined.sales_collected - expenses.total),
    };

    const comparison = buildComparison(currentCombined, priorCombined);

    const payments = [
        { key: 'cash', amount: currentCombined.cash_collected },
        { key: 'card', amount: currentCombined.card_collected },
        { key: 'platform', amount: currentCombined.platform_sales }
    ];

    const order_types = await buildOrderTypeBreakdown(executor, period);
    const platform_reconciliation = await getPlatformReconciliationTotals(executor, {
        startDate: period.start_date,
        endDate: period.end_date
    });

    const [hourlyRows] = await executor.query(`
        SELECT
            HOUR(CONVERT_TZ(COALESCE(o.invoice_issued_at, o.created_at), '+00:00', ?)) AS hour,
            COUNT(o.invoice_id) AS orders,
            COALESCE(SUM(o.total), 0) AS sales_processed
        FROM orders o
        WHERE COALESCE(o.invoice_issued_at, o.created_at) >= ?
          AND COALESCE(o.invoice_issued_at, o.created_at) < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY hour
    `, [offset, period.business_start_at, period.business_end_at]);

    const hourlyMap = {};
    for (const r of hourlyRows) {
        hourlyMap[r.hour] = { orders: Number(r.orders) || 0, sales_processed: Number(r.sales_processed) || 0 };
    }

    const startHour = period.business_day_start_hour;
    const hourly_sales = [];
    for (let i = 0; i < 24; i++) {
        const hr = (startHour + i) % 24;
        const data = hourlyMap[hr] || { orders: 0, sales_processed: 0 };
        hourly_sales.push({
            hour: hr,
            orders: data.orders,
            sales_processed: roundMoney(data.sales_processed)
        });
    }

    const [shiftRows] = await executor.query(`
        SELECT id, status, starting_cash, expected_cash, actual_cash,
               CASE WHEN status='closed' AND closed_at >= ? AND closed_at < ? THEN 1 ELSE 0 END AS closed_in_window
        FROM shifts
        WHERE opened_at < ?
          AND (
            opened_at >= ?
            OR closed_at IS NULL
            OR closed_at >= ?
            OR EXISTS (
                SELECT 1 FROM orders shift_orders
                WHERE shift_orders.shift_id = shifts.id
                  AND COALESCE(shift_orders.invoice_issued_at, shift_orders.created_at) >= ?
                  AND COALESCE(shift_orders.invoice_issued_at, shift_orders.created_at) < ?
            )
            OR EXISTS (
                SELECT 1 FROM refunds shift_refunds
                WHERE shift_refunds.shift_id = shifts.id
                  AND shift_refunds.created_at >= ?
                  AND shift_refunds.created_at < ?
            )
          )
    `, [
        period.business_start_at, period.business_end_at,
        period.business_end_at,
        period.business_start_at,
        period.business_start_at,
        period.business_start_at, period.business_end_at,
        period.business_start_at, period.business_end_at,
    ]);

    let open_shifts = 0;
    let closed_shifts = 0;
    let closed_outside_window = 0;
    let uncounted_shifts = 0;
    let shifts_needing_review = 0;
    let net_variance = 0;
    let shortage_total = 0;
    let overage_total = 0;

    for (const s of shiftRows) {
        if (s.status === 'open') {
            open_shifts++;
            continue;
        }
        const inside = s.status === 'closed' && Number(s.closed_in_window) === 1;
        const outside = s.status === 'closed' && !inside;
        if (outside) {
            closed_outside_window++;
            continue;
        }
        if (!inside) continue;

        closed_shifts++;
        const uncounted = s.actual_cash == null || s.expected_cash == null;
        if (uncounted) {
            uncounted_shifts++;
            continue;
        }
        const variance = roundMoney(Number(s.actual_cash) - Number(s.expected_cash));
        net_variance = roundMoney(net_variance + variance);
        if (variance < 0) shortage_total = roundMoney(shortage_total + Math.abs(variance));
        else if (variance > 0) overage_total = roundMoney(overage_total + variance);
        if (Math.abs(variance) >= 0.01) shifts_needing_review++;
    }

    let state = 'no_shifts';
    if (open_shifts > 0 || uncounted_shifts > 0) {
        state = 'in_progress';
    } else if (closed_shifts === 0) {
        state = 'no_shifts';
    } else if (shifts_needing_review > 0) {
        state = 'review';
    } else {
        state = 'balanced';
    }

    const moneyIncomplete = open_shifts > 0 || uncounted_shifts > 0 || closed_shifts === 0;
    const cash_status = {
        state,
        open_shifts,
        closed_shifts,
        closed_outside_window,
        uncounted_shifts,
        shifts_needing_review,
        net_variance: moneyIncomplete ? null : roundMoney(net_variance),
        shortage_total: moneyIncomplete ? null : roundMoney(shortage_total),
        overage_total: moneyIncomplete ? null : roundMoney(overage_total),
    };

    return {
        period,
        summary,
        comparison,
        payments,
        platform_reconciliation,
        order_types,
        hourly_sales,
        cash_status
    };
}

module.exports = {
    allocateRefundPayment,
    combineFinancialEvents,
    buildComparison,
    buildDailySummary
};
