const { roundMoney } = require('./PosCalculator');
const { combineFinancialEvents } = require('./financialEventMetrics');
const { addBusinessDays } = require('../utils/businessDate');

const LIMITS = Object.freeze({
    requiredDays: 3,
    paceDeadbandPercent: 5,
    driverMarginPoints: 3,
    minForecastMinutes: 120,
    minForecastOrders: 5,
    minProgressShare: 0.15,
    maxFullDayCoefficientOfVariation: 0.50,
    minAttentionAmount: 5,
    refundRateFloor: 5,
    voidRateFloor: 5,
    discountRateFloor: 10,
});

const mean = values => values.length
    ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length
    : 0;

const percentDelta = (current, typical) => typical > 0
    ? ((current - typical) / typical) * 100
    : null;

function matchingBusinessDates(date) {
    return [1, 2, 3, 4].map(weeks => addBusinessDays(date, weeks * -7));
}

function rollupFinancialTimeline(rows, businessDate, maxElapsedMinute = 1439) {
    const totals = rows
        .filter(row => row.business_date === businessDate && Number(row.elapsed_minute) <= maxElapsedMinute)
        .reduce((acc, row) => {
            for (const key of Object.keys(acc)) acc[key] += Number(row[key] || 0);
            return acc;
        }, {
            sales_processed: 0,
            orders: 0,
            cash: 0,
            card: 0,
            platform: 0,
            refunds_issued: 0,
            tax_refunded: 0,
            refund_cash: 0,
            refund_card: 0,
            refund_platform: 0,
            refund_count: 0,
            discounts_total: 0,
            void_count: 0,
            void_value: 0,
        });

    return {
        ...combineFinancialEvents(totals, totals),
        discounts_total: roundMoney(totals.discounts_total),
        void_count: totals.void_count,
        void_value: roundMoney(totals.void_value),
    };
}

function selectEligibleDays(rows, candidateDates) {
    return candidateDates.filter(date => {
        const full = rollupFinancialTimeline(rows, date, 1439);
        return full.sales_processed > 0 || full.refund_count > 0 || full.void_count > 0;
    });
}

function buildDashboardComparison(current, historical) {
    const typical = {
        sales_today: roundMoney(mean(historical.map(day => day.sales_collected))),
        orders: mean(historical.map(day => day.total_orders)),
        average_check: roundMoney(mean(historical.map(day => day.average_ticket))),
    };
    const values = {
        sales_today: current.sales_collected,
        orders: current.total_orders,
        average_check: current.average_ticket,
    };
    const delta = Object.fromEntries(Object.keys(values).map(key => [key, {
        amount: roundMoney(values[key] - typical[key]),
        percent: percentDelta(values[key], typical[key]),
    }]));
    const salesPercent = delta.sales_today.percent;
    const paceState = salesPercent === null
        ? 'unavailable'
        : salesPercent > LIMITS.paceDeadbandPercent
            ? 'ahead'
            : salesPercent < -LIMITS.paceDeadbandPercent
                ? 'behind'
                : 'typical';
    const orderChange = delta.orders.percent;
    const checkChange = delta.average_check.percent;
    let driver = 'none';

    if ((paceState === 'ahead' || paceState === 'behind') && orderChange !== null && checkChange !== null) {
        const orderMagnitude = Math.abs(orderChange);
        const checkMagnitude = Math.abs(checkChange);
        driver = orderMagnitude >= checkMagnitude + LIMITS.driverMarginPoints
            ? 'orders'
            : checkMagnitude >= orderMagnitude + LIMITS.driverMarginPoints
                ? 'average_check'
                : 'both';
    }

    return { typical, delta, pace_state: paceState, driver };
}

function buildPaceSeries(rows, today, eligibleDates, elapsedMinute) {
    const cutoffs = [];
    for (let cutoff = 59; cutoff < elapsedMinute; cutoff += 60) cutoffs.push(cutoff);
    if (!cutoffs.length || cutoffs.at(-1) !== elapsedMinute) cutoffs.push(elapsedMinute);

    return {
        points: cutoffs.map(cutoff => ({
            elapsed_minute: cutoff,
            today: rollupFinancialTimeline(rows, today, cutoff).sales_collected,
            typical: eligibleDates.length >= LIMITS.requiredDays
                ? roundMoney(mean(eligibleDates.map(date =>
                    rollupFinancialTimeline(rows, date, cutoff).sales_collected
                )))
                : null,
        })),
    };
}

function estimateClosingSales(current, historicalFullDays, elapsedMinute) {
    if (
        historicalFullDays.length < LIMITS.requiredDays ||
        elapsedMinute < LIMITS.minForecastMinutes ||
        current.total_orders < LIMITS.minForecastOrders ||
        current.sales_collected <= 0
    ) return null;

    const valid = historicalFullDays.filter(day => day.full_day_sales > 0 && day.sales_collected >= 0);
    if (valid.length < LIMITS.requiredDays) return null;

    const shares = valid.map(day => day.sales_collected / day.full_day_sales);
    const averageShare = mean(shares);
    if (averageShare < LIMITS.minProgressShare) return null;

    const fullTotals = valid.map(day => day.full_day_sales);
    const fullMean = mean(fullTotals);
    const variance = mean(fullTotals.map(value => (value - fullMean) ** 2));
    const coefficientOfVariation = fullMean > 0 ? Math.sqrt(variance) / fullMean : Infinity;
    if (coefficientOfVariation > LIMITS.maxFullDayCoefficientOfVariation) return null;

    return roundMoney(Math.max(current.sales_collected, current.sales_collected / averageShare));
}

function rates(metrics) {
    return {
        refund_rate: metrics.sales_processed > 0
            ? (metrics.refunds_issued / metrics.sales_processed) * 100
            : 0,
        void_rate: metrics.sales_processed + metrics.void_value > 0
            ? (metrics.void_value / (metrics.sales_processed + metrics.void_value)) * 100
            : 0,
        discount_rate: metrics.sales_processed + metrics.discounts_total > 0
            ? (metrics.discounts_total / (metrics.sales_processed + metrics.discounts_total)) * 100
            : 0,
    };
}

function buildTypicalAttentionRates(days) {
    return {
        refund_rate: mean(days.map(day => rates(day).refund_rate)),
        void_rate: mean(days.map(day => rates(day).void_rate)),
        discount_rate: mean(days.map(day => rates(day).discount_rate)),
    };
}

function buildAttentionItems({ current, typical, comparisonReady, closedShifts, lowStockItems }) {
    const items = [];

    if (comparisonReady && typical) {
        const currentRates = rates(current);
        const rules = [
            {
                type: 'refund', value: current.refunds_issued,
                rate: currentRates.refund_rate, typical: typical.refund_rate,
                floor: LIMITS.refundRateFloor, message_key: 'refund_rate',
                destination: 'reports-refunds',
            },
            {
                type: 'void', value: current.void_value,
                rate: currentRates.void_rate, typical: typical.void_rate,
                floor: LIMITS.voidRateFloor, message_key: 'void_rate',
                destination: 'reports-refunds',
            },
            {
                type: 'discount', value: current.discounts_total,
                rate: currentRates.discount_rate, typical: typical.discount_rate,
                floor: LIMITS.discountRateFloor, message_key: 'discount_rate',
                destination: 'reports-summary',
            },
        ];

        for (const rule of rules) {
            if (
                rule.value >= LIMITS.minAttentionAmount &&
                rule.rate >= rule.floor &&
                rule.rate >= rule.typical * 2
            ) {
                items.push({
                    type: rule.type,
                    severity: 'warning',
                    message_key: rule.message_key,
                    params: { amount: roundMoney(rule.value), rate: roundMoney(rule.rate) },
                    destination: rule.destination,
                });
            }
        }
    }

    for (const shift of closedShifts) {
        const variance = roundMoney(shift.variance);
        if (Math.abs(variance) >= 0.01) {
            items.push({
                type: 'register',
                severity: 'warning',
                message_key: 'register_variance',
                params: {
                    shift_id: shift.shift_id,
                    amount: Math.abs(variance),
                    direction: variance < 0 ? 'short' : 'over',
                },
                destination: 'shifts',
            });
        }
    }

    if (lowStockItems.length) {
        items.push({
            type: 'stock',
            severity: 'warning',
            message_key: 'low_stock',
            params: { count: lowStockItems.length },
            destination: 'inventory',
        });
    }

    return items;
}

function buildTopProducts(todayRows, historicalRows, eligibleDates) {
    const groupedToday = new Map();
    for (const row of todayRows) {
        const key = `${row.product_id ?? 'custom'}:${row.item_name}`;
        const item = groupedToday.get(key) || {
            product_id: row.product_id,
            name: row.item_name,
            net_sales: 0,
            net_units: 0,
        };
        item.net_sales += Number(row.net_sales || 0);
        item.net_units += Number(row.net_units || 0);
        groupedToday.set(key, item);
    }

    return [...groupedToday.values()]
        .sort((a, b) => b.net_sales - a.net_sales)
        .slice(0, 5)
        .map(item => {
            const dayValues = eligibleDates.map(date => historicalRows
                .filter(row =>
                    row.business_date === date &&
                    row.product_id === item.product_id &&
                    row.item_name === item.name
                )
                .reduce((sum, row) => sum + Number(row.net_sales || 0), 0));
            const typical = mean(dayValues);
            return {
                ...item,
                net_sales: roundMoney(item.net_sales),
                delta_percent: eligibleDates.length >= LIMITS.requiredDays && typical > 0
                    ? roundMoney(percentDelta(item.net_sales, typical))
                    : null,
            };
        });
}

module.exports = {
    LIMITS,
    matchingBusinessDates,
    rollupFinancialTimeline,
    selectEligibleDays,
    buildDashboardComparison,
    buildPaceSeries,
    estimateClosingSales,
    buildTypicalAttentionRates,
    buildAttentionItems,
    buildTopProducts,
};
