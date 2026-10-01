const {
    activeOrderDiscountApplied,
    activeOrderDiscountSumsSql,
    paidOrderTimeSql,
} = require('./financialSql');

async function getShiftDiscountsByShift(executor, shiftIds, range = null) {
    if (!Array.isArray(shiftIds) || shiftIds.length === 0) return {};

    const params = [...shiftIds];
    let rangeSql = '';
    if (range?.start && range?.end) {
        rangeSql = `AND ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?`;
        params.push(range.start, range.end);
    }

    const [rows] = await executor.query(`
        WITH selected_shift_orders AS (
            SELECT o.invoice_id, o.shift_id, o.subtotal, o.discount_type, o.discount_value
            FROM orders o
            WHERE o.shift_id IN (${shiftIds.map(() => '?').join(',')})
              ${rangeSql}
              AND o.payment_method NOT IN ('unpaid_table', 'voided')
        )
        SELECT
            o.shift_id,
            COALESCE(SUM(${activeOrderDiscountApplied('o', 'ads')}), 0) AS order_discounts,
            COALESCE(SUM(ads.line_discount_amount), 0) AS line_discounts
        FROM selected_shift_orders o
        LEFT JOIN ${activeOrderDiscountSumsSql('selected_shift_orders')} ads ON ads.invoice_id = o.invoice_id
        GROUP BY o.shift_id
    `, params);

    const map = {};
    for (const row of rows) {
        const orderDiscounts = Number(row.order_discounts || 0);
        const lineDiscounts = Number(row.line_discounts || 0);
        map[row.shift_id] = {
            order_discounts: orderDiscounts,
            line_discounts: lineDiscounts,
            total_discounts: orderDiscounts + lineDiscounts,
        };
    }
    return map;
}

// Voided orders keep their pre-void shift_id but carry payment_method = 'voided',
// so they are already excluded from every sales/discount query (which all filter
// payment_method NOT IN ('unpaid_table','voided')). This is a separate rollup so
// the audit report can show "N voids worth X" per shift without touching sales math.
async function getShiftVoidsByShift(executor, shiftIds, range = null) {
    if (!Array.isArray(shiftIds) || shiftIds.length === 0) return {};

    const params = [...shiftIds];
    let rangeSql = '';
    if (range?.start && range?.end) {
        rangeSql = 'AND created_at >= ? AND created_at < ?';
        params.push(range.start, range.end);
    }

    const [rows] = await executor.query(`
        SELECT
            shift_id,
            COUNT(invoice_id) AS void_count,
            COALESCE(SUM(COALESCE(original_total, total, 0)), 0) AS void_value
        FROM orders
        WHERE shift_id IN (${shiftIds.map(() => '?').join(',')})
          ${rangeSql}
          AND payment_method = 'voided'
        GROUP BY shift_id
    `, params);

    const map = {};
    for (const row of rows) {
        map[row.shift_id] = {
            void_count: Number(row.void_count || 0),
            void_value: Number(row.void_value || 0),
        };
    }
    return map;
}

module.exports = {
    getShiftDiscountsByShift,
    getShiftVoidsByShift,
};
