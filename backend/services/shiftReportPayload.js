const { getShiftDiscountsByShift } = require('./shiftMetrics');
const { getBusinessSqlOffset, getBusinessDayStartHour } = require('../utils/businessDate');
const { getCashExpensesByShift, getCashExpenseCategoriesByShift } = require('./expenseMetrics');
const {
    REFUNDS_ROLLUP_JOIN,
    NET_TOTAL,
    getRefundsByShift,
} = require('./financialSql');

function reportError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

async function buildShiftReportPayload(executor, {
    shiftId,
    printType,
    user,
    storeInfo,
    receiptPrinterId,
}) {
    const normalizedShiftId = Number(shiftId);
    const normalizedPrintType = printType === 'zreport' ? 'z_report' : printType;
    if (!Number.isSafeInteger(normalizedShiftId) || normalizedShiftId <= 0) {
        throw reportError(400, 'Shift ID is required.');
    }
    if (!['x_report', 'z_report'].includes(normalizedPrintType)) {
        throw reportError(400, 'Invalid shift report type.');
    }

    const [shifts] = await executor.query(`
        SELECT s.*, u.name as cashier_name
        FROM shifts s
        LEFT JOIN users u ON s.user_id = u.id
        WHERE s.id = ?
    `, [normalizedShiftId]);
    if (shifts.length === 0) throw reportError(404, 'Shift not found.');

    const shift = shifts[0];
    const isOwner = String(shift.user_id) === String(user?.id);
    const isAdmin = user?.role === 'admin' || user?.role === 'programmer';
    if (!isAdmin && !isOwner) {
        throw reportError(403, 'Forbidden: You are not authorized to print this shift report.');
    }

    const [totals] = await executor.query(`
        SELECT
            COALESCE(SUM(o.total), 0) as gross_sales,
            COALESCE(SUM(o.tax), 0) as gross_tax,
            COALESCE(SUM(o.cash_amount), 0) as cash_sales,
            COALESCE(SUM(o.card_amount), 0) as card_sales,
            COALESCE(SUM(CASE WHEN o.payment_method = 'platform' THEN o.total ELSE 0 END), 0) as platform_sales
        FROM orders o
        WHERE o.shift_id = ? AND o.payment_method NOT IN ('unpaid_table', 'voided')
    `, [normalizedShiftId]);
    const totalData = totals[0];
    const discountMap = await getShiftDiscountsByShift(executor, [normalizedShiftId]);
    const shiftDiscounts = discountMap[normalizedShiftId] || { total_discounts: 0 };

    const [orderTypeBreakdown] = await executor.query(`
        SELECT COALESCE(ot.name, 'Standard') as order_type_name,
               SUM(${NET_TOTAL}) as total_sales,
               SUM(CASE WHEN o.payment_method = 'platform' THEN ${NET_TOTAL} ELSE 0 END) as platform_sales
        FROM orders o
        LEFT JOIN order_types ot ON o.order_type_id = ot.id
        ${REFUNDS_ROLLUP_JOIN}
        WHERE o.shift_id = ? AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY o.order_type_id
    `, [normalizedShiftId]);

    const refMap = await getRefundsByShift(executor, [normalizedShiftId]);
    const shiftRef = refMap[normalizedShiftId] || { amt: 0, cash: 0, card: 0, platform: 0 };
    const startingCash = parseFloat(shift.starting_cash || 0);
    const cashSales = parseFloat(totalData.cash_sales || 0) - shiftRef.cash;
    const grossSales = parseFloat(totalData.gross_sales || 0) - shiftRef.amt;
    const taxCollected = parseFloat(totalData.gross_tax || 0) - shiftRef.tax;
    const cardSales = parseFloat(totalData.card_sales || 0) - shiftRef.card;
    const platformSales = parseFloat(totalData.platform_sales || 0) - shiftRef.platform;
    const expenseMap = await getCashExpensesByShift(executor, [normalizedShiftId]);
    const expenseCategoryMap = await getCashExpenseCategoriesByShift(executor, [normalizedShiftId]);
    const cashExpenses = expenseMap[normalizedShiftId] || 0;
    const liveExpectedCash = startingCash + cashSales - cashExpenses;

    return {
        print_type: normalizedPrintType,
        business_config: {
            business_sql_offset: getBusinessSqlOffset(),
            business_day_start_hour: getBusinessDayStartHour(),
        },
        ...(receiptPrinterId !== undefined ? { receipt_printer_id: receiptPrinterId } : {}),
        storeInfo,
        shift_id: normalizedShiftId,
        cashier_name: shift.cashier_name || 'Unknown',
        opened_at: shift.opened_at,
        closed_at: shift.closed_at,
        starting_cash: startingCash,
        gross_sales: grossSales,
        net_sales_pre_tax: grossSales - taxCollected,
        tax_collected: taxCollected,
        gross_cash_sales: parseFloat(totalData.cash_sales || 0),
        cash_refunds: shiftRef.cash,
        cash_sales: cashSales,
        cash_expenses: cashExpenses,
        expense_categories: expenseCategoryMap[normalizedShiftId] || [],
        card_sales: cardSales,
        platform_sales: platformSales,
        total_discounts: parseFloat(shiftDiscounts.total_discounts || 0),
        expected_cash: shift.status === 'closed' ? parseFloat(shift.expected_cash || 0) : liveExpectedCash,
        actual_cash: shift.status === 'closed' ? parseFloat(shift.actual_cash || 0) : undefined,
        variance: shift.status === 'closed'
            ? parseFloat(shift.actual_cash || 0) - parseFloat(shift.expected_cash || 0)
            : 0,
        order_type_breakdown: orderTypeBreakdown.map(row => ({
            order_type_name: row.order_type_name,
            total_sales: parseFloat(row.total_sales || 0),
        })),
        platform_order_type_breakdown: orderTypeBreakdown
            .filter(row => Number(row.platform_sales) !== 0)
            .map(row => ({
                order_type_name: row.order_type_name,
                total_sales: parseFloat(row.platform_sales),
            })),
    };
}

module.exports = { buildShiftReportPayload };
