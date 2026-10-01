const { availabilitySql } = require('./StockProductAdapter');
const { roundMoney } = require('./PosCalculator');
const { getFinancialEventTimeline } = require('./financialEventMetrics');
const { getProductSalesByBusinessDate } = require('./productSalesMetrics');
const {
    getBusinessDate,
    getBusinessDateRange,
    formatDbTimestamp,
} = require('../utils/businessDate');
const {
    matchingBusinessDates,
    rollupFinancialTimeline,
    selectEligibleDays,
    buildDashboardComparison,
    buildPaceSeries,
    estimateClosingSales,
    buildTypicalAttentionRates,
    buildAttentionItems,
    buildTopProducts,
} = require('./dashboardAnalytics');
const { getExpenseTotalsForRange } = require('./expenseMetrics');

async function readDashboardSettings(executor) {
    const [rows] = await executor.query(`
        SELECT setting_key, setting_value FROM settings
        WHERE setting_key IN ('tables_enabled','stock_enabled','low_stock_threshold')
    `);
    return Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
}

async function readClosedShiftVariances(executor, range, asOf) {
    const [rows] = await executor.query(`
        SELECT id AS shift_id,
               ROUND(COALESCE(actual_cash,0) - COALESCE(expected_cash,0), 2) AS variance
        FROM shifts
        WHERE status='closed' AND closed_at >= ? AND closed_at <= ?
          AND ABS(ROUND(COALESCE(actual_cash,0) - COALESCE(expected_cash,0), 2)) >= 0.01
        ORDER BY closed_at DESC
    `, [range.start, asOf]);
    return rows.map(row => ({
        shift_id: Number(row.shift_id),
        variance: Number(row.variance),
    }));
}

async function readTableSnapshot(executor, now) {
    const [countResult, ordersResult] = await Promise.all([
        executor.query('SELECT COUNT(*) AS occupied_count FROM restaurant_tables WHERE current_order_id IS NOT NULL'),
        executor.query(`
            SELECT o.invoice_id, o.total, o.created_at, COALESCE(t.table_number, '') AS table_number
            FROM orders o
            LEFT JOIN restaurant_tables t ON t.id=o.table_id
            WHERE o.payment_method='unpaid_table'
              AND EXISTS (SELECT 1 FROM restaurant_tables rt WHERE rt.current_order_id=o.invoice_id)
            ORDER BY o.created_at ASC
        `),
    ]);
    const countRows = countResult[0];
    const openOrders = ordersResult[0];
    const oldest = openOrders[0] || null;
    const oldestDate = oldest
        ? (oldest.created_at instanceof Date
            ? oldest.created_at
            : new Date(`${String(oldest.created_at).replace(' ', 'T')}Z`))
        : null;

    return {
        occupied_count: Number(countRows[0]?.occupied_count || 0),
        open_unpaid_value: roundMoney(
            openOrders.reduce((sum, order) => sum + Number(order.total || 0), 0)
        ),
        longest_open: oldest ? {
            invoice_id: Number(oldest.invoice_id),
            table_number: String(oldest.table_number),
            opened_at: oldest.created_at,
            elapsed_minutes: Math.max(0, Math.floor((now.getTime() - oldestDate.getTime()) / 60000)),
        } : null,
    };
}

async function readLowStock(executor, threshold) {
    const [rows] = await executor.query(`
        SELECT p.id,p.name,${availabilitySql('p')} AS stock FROM products p
        WHERE p.is_active=1 HAVING stock IS NOT NULL AND stock <= ?
        ORDER BY stock ASC, name ASC
    `, [threshold]);
    return rows;
}

async function buildDashboardData(executor, { now = new Date() } = {}) {
    const businessDate = getBusinessDate(now);
    const todayRange = getBusinessDateRange(businessDate);
    const todayStart = new Date(`${todayRange.start.replace(' ', 'T')}Z`);
    const elapsedMinute = Math.max(
        0,
        Math.min(1439, Math.floor((now.getTime() - todayStart.getTime()) / 60000))
    );
    const asOf = formatDbTimestamp(now);
    const candidateDates = matchingBusinessDates(businessDate);
    const analysisRange = getBusinessDateRange(candidateDates.at(-1), businessDate);

    const settings = await readDashboardSettings(executor);
    const tablesEnabled = settings.tables_enabled === '1';
    const stockEnabled = settings.stock_enabled === '1';
    const rawThreshold = settings.low_stock_threshold;
    const configuredThreshold = rawThreshold != null
        && String(rawThreshold).trim() !== ''
        ? Number(rawThreshold)
        : Number.NaN;
    const lowStockThreshold = Number.isFinite(configuredThreshold)
        && configuredThreshold >= 0
        ? configuredThreshold
        : 3;

    const [timeline, productRows, closedShifts, tables, lowStockItems, expenses] = await Promise.all([
        getFinancialEventTimeline(executor, analysisRange),
        getProductSalesByBusinessDate(executor, analysisRange),
        readClosedShiftVariances(executor, todayRange, asOf),
        tablesEnabled ? readTableSnapshot(executor, now) : Promise.resolve(null),
        stockEnabled
            ? readLowStock(executor, lowStockThreshold)
            : Promise.resolve([]),
        getExpenseTotalsForRange(executor, todayRange),
    ]);

    const current = rollupFinancialTimeline(timeline, businessDate, elapsedMinute);
    const operatingDates = selectEligibleDays(timeline, candidateDates);
    const comparisonReady = operatingDates.length >= 3;
    const sameTimeHistory = operatingDates.map(date =>
        rollupFinancialTimeline(timeline, date, elapsedMinute)
    );
    const comparison = comparisonReady
        ? buildDashboardComparison(current, sameTimeHistory)
        : { typical: null, delta: null, pace_state: 'unavailable', driver: 'none' };
    const historicalFullDays = operatingDates.map(date => ({
        sales_collected: rollupFinancialTimeline(timeline, date, elapsedMinute).sales_collected,
        full_day_sales: rollupFinancialTimeline(timeline, date, 1439).sales_collected,
    }));
    const estimate = comparisonReady
        ? estimateClosingSales(current, historicalFullDays, elapsedMinute)
        : null;
    const typicalForAttention = comparisonReady
        ? buildTypicalAttentionRates(sameTimeHistory)
        : null;
    const comparableProductRows = productRows.filter(row => row.elapsed_minute <= elapsedMinute);
    const todayProducts = comparableProductRows.filter(row => row.business_date === businessDate);

    const payments = [
        { method: 'cash', amount: current.cash_collected },
        { method: 'card', amount: current.card_collected },
        { method: 'platform', amount: current.platform_sales },
    ].filter(item => item.amount > 0);
    const paymentTotal = payments.reduce((sum, item) => sum + item.amount, 0);
    payments.forEach(item => {
        item.share = paymentTotal > 0 ? roundMoney((item.amount / paymentTotal) * 100) : 0;
    });

    return {
        business_date: businessDate,
        as_of: asOf,
        refreshed_at: now.toISOString(),
        history: {
            eligible_days: operatingDates.length,
            comparison_ready: comparisonReady,
        },
        headline: {
            sales_today: current.sales_collected,
            expenses_today: expenses.total,
            remaining_after_expenses: roundMoney(current.sales_collected - expenses.total),
            orders: current.total_orders,
            average_check: current.average_ticket,
            estimated_close: estimate,
        },
        comparison,
        pace: buildPaceSeries(
            timeline,
            businessDate,
            comparisonReady ? operatingDates : [],
            elapsedMinute
        ),
        tables: tablesEnabled ? tables : null,
        attention: buildAttentionItems({
            current,
            typical: typicalForAttention,
            comparisonReady,
            closedShifts,
            lowStockItems,
        }),
        products: buildTopProducts(
            todayProducts,
            comparableProductRows,
            comparisonReady ? operatingDates : []
        ),
        payments,
    };
}

module.exports = { buildDashboardData };
