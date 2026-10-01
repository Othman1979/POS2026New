const {
    matchingBusinessDates,
    rollupFinancialTimeline,
    buildDashboardComparison,
    estimateClosingSales,
    buildAttentionItems,
    buildTopProducts,
} = require('../../services/dashboardAnalytics');

describe('dashboardAnalytics', () => {
    it('returns previous four matching weekdays', () => {
        expect(matchingBusinessDates('2026-07-14')).toEqual([
            '2026-07-07',
            '2026-06-30',
            '2026-06-23',
            '2026-06-16',
        ]);
    });

    it('cuts rollup at same elapsed business minute and nets refund events', () => {
        const rows = [
            {
                business_date: '2026-07-14', elapsed_minute: 60,
                sales_processed: 100, orders: 2, cash: 100, card: 0,
                refunds_issued: 0, refund_cash: 0, refund_card: 0, refund_count: 0,
                discounts_total: 0, void_count: 0, void_value: 0,
            },
            {
                business_date: '2026-07-14', elapsed_minute: 120,
                sales_processed: 0, orders: 0, cash: 0, card: 0,
                refunds_issued: 20, refund_cash: 20, refund_card: 0, refund_count: 1,
                discounts_total: 0, void_count: 0, void_value: 0,
            },
        ];

        expect(rollupFinancialTimeline(rows, '2026-07-14', 90)).toMatchObject({
            sales_collected: 100,
            total_orders: 2,
        });
        expect(rollupFinancialTimeline(rows, '2026-07-14', 120)).toMatchObject({
            sales_collected: 80,
            refunds_issued: 20,
            average_ticket: 50,
        });
    });

    it('uses 5 percent pace deadband and 3 point driver margin', () => {
        expect(buildDashboardComparison(
            { sales_collected: 120, total_orders: 12, average_ticket: 10 },
            [{ sales_collected: 100, total_orders: 10, average_ticket: 10 }]
        )).toMatchObject({ pace_state: 'ahead', driver: 'orders' });
        expect(buildDashboardComparison(
            { sales_collected: 103, total_orders: 10, average_ticket: 10.3 },
            [{ sales_collected: 100, total_orders: 10, average_ticket: 10 }]
        ).pace_state).toBe('typical');
    });

    it('hides forecast until every confidence gate passes', () => {
        const current = { sales_collected: 300, total_orders: 10 };
        const stable = [
            { sales_collected: 250, full_day_sales: 500 },
            { sales_collected: 300, full_day_sales: 600 },
            { sales_collected: 200, full_day_sales: 400 },
        ];

        expect(estimateClosingSales(current, stable, 180)).toBe(600);
        expect(estimateClosingSales({ ...current, total_orders: 4 }, stable, 180)).toBeNull();
        expect(estimateClosingSales(current, stable, 60)).toBeNull();
        expect(estimateClosingSales(current, stable.slice(0, 2), 180)).toBeNull();
    });

    it('requires amount floor, rate floor, and twice-normal rate for warnings', () => {
        const common = { comparisonReady: true, closedShifts: [], lowStockItems: [] };
        expect(buildAttentionItems({
            ...common,
            current: { sales_processed: 100, refunds_issued: 4.99, void_value: 0, discounts_total: 0 },
            typical: { refund_rate: 1, void_rate: 0, discount_rate: 0 },
        })).toEqual([]);
        expect(buildAttentionItems({
            ...common,
            current: { sales_processed: 100, refunds_issued: 10, void_value: 0, discounts_total: 0 },
            typical: { refund_rate: 2, void_rate: 0, discount_rate: 0 },
        })[0]).toMatchObject({ type: 'refund', destination: 'reports-refunds' });
    });

    it('ranks products by net sales and averages only eligible matching days', () => {
        const result = buildTopProducts(
            [{ product_id: 1, item_name: 'Burger Deluxe', net_sales: 120, net_units: 6 }],
            [
                { business_date: '2026-07-07', product_id: 1, item_name: 'Burger Deluxe', net_sales: 100 },
                { business_date: '2026-06-30', product_id: 1, item_name: 'Burger Deluxe', net_sales: 80 },
                { business_date: '2026-06-23', product_id: 1, item_name: 'Burger Deluxe', net_sales: 120 },
            ],
            ['2026-07-07', '2026-06-30', '2026-06-23']
        );

        expect(result[0]).toMatchObject({
            name: 'Burger Deluxe',
            net_sales: 120,
            net_units: 6,
            delta_percent: 20,
        });
    });
});
