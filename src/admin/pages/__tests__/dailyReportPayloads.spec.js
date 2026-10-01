import { describe, expect, it } from 'vitest';
import {
    buildDailySummaryPrintPayload,
    buildDailySalesPrintPayload,
    buildDailyRefundPrintPayload,
    buildDailyExpensePrintPayload
} from '../dailyReportPayloads';

describe('dailyReportPayloads builders', () => {
    it('buildDailySummaryPrintPayload normalizes report data correctly', () => {
        const reportFixture = {
            period: {
                start_date: '2026-07-14',
                end_date: '2026-07-14',
                business_day_start_hour: 6
            },
            summary: {
                sales_collected: 130,
                sales_processed: 140,
                refunds_issued: 10,
                net_revenue_pre_tax: 120,
                tax_collected: 10,
                service_charges_collected: 0,
                cash_collected: 80,
                card_collected: 50,
                total_orders: 12,
                average_ticket: 11.67,
                discounts_total: 5,
                discounted_orders: 1,
                refund_count: 1,
                void_count: 0,
                void_value: 0
            },
            comparison: {
                sales_collected: { amount: 20, percent: 18.18 }
            },
            payments: [
                { key: 'cash', amount: 80 },
                { key: 'card', amount: 50 }
            ],
            platform_reconciliation: {
                invoice_allocations: 10,
                deductions: 1,
                additions: 0,
                net_received: 9
            },
            order_types: [],
            hourly_sales: [],
            cash_status: {
                state: 'balanced',
                open_shifts: 0,
                closed_shifts: 1,
                closed_outside_window: 0,
                uncounted_shifts: 0,
                shifts_needing_review: 0,
                net_variance: 0,
                shortage_total: 0,
                overage_total: 0
            },
            subscriptions: {
                subscription_collections: 30,
                redeemed_credits: 2,
                active_subscriptions: 4,
                subscriptions_expiring_7_days: 1
            }
        };

        const payload = buildDailySummaryPrintPayload(reportFixture);
        expect(payload.print_type).toBe('daily_summary_report');
        expect(payload.report_id).toBe('daily_summary_report:2026-07-14:2026-07-14');
        expect(payload.summary.sales_collected).toBe(130);
        expect(payload.period.business_day_start_hour).toBe(6);
        expect(payload.period.window_label).toBe('2026-07-14 06:00 → 2026-07-15 05:59');
        expect(payload.payments).toEqual([
            { key: 'cash', amount: 80 },
            { key: 'card', amount: 50 }
        ]);
        expect(payload.cash_status.state).toBe('balanced');
        expect(payload.platform_reconciliation).toEqual(reportFixture.platform_reconciliation);
        expect(payload).not.toHaveProperty('subscriptions');
    });

    it('buildDailySalesPrintPayload normalizes categories and filters out Auto-Gratuity', () => {
        const salesFixture = {
            period: {
                start_date: '2026-07-14',
                end_date: '2026-07-14',
                business_day_start_hour: 6
            },
            totals: {
                sales_collected: 28,
                menu_sales: 28,
                service_charges_collected: 0
            },
            categories: [
                {
                    category_id: 1,
                    name: 'Food',
                    sold_qty: 5,
                    returned_qty: 1,
                    sold_amount: 33.8,
                    returned_amount: 5.8,
                    net_sales: 28,
                    subcategories: [
                        {
                            category_id: 2,
                            name: 'Burgers',
                            sold_qty: 5,
                            returned_qty: 1,
                            sold_amount: 33.8,
                            returned_amount: 5.8,
                            net_sales: 28,
                            subcategories: []
                        }
                    ]
                }
            ],
            products: [
                {
                    product_id: 10,
                    item_name: 'Test Burger',
                    category_path: 'Food › Burgers',
                    sold_qty: 5,
                    returned_qty: 1,
                    sold_amount: 33.8,
                    returned_amount: 5.8,
                    net_sales: 28
                },
                {
                    product_id: null,
                    item_name: 'Service Charge',
                    category_path: 'Uncategorized',
                    sold_qty: 1,
                    returned_qty: 0,
                    sold_amount: 2.8,
                    returned_amount: 0,
                    net_sales: 2.8,
                    note: 'Auto-Gratuity'
                }
            ],
            order_types: [],
            cashiers: [],
            waiters: [],
            tables: [],
            tables_enabled: false
        };

        const payload = buildDailySalesPrintPayload(salesFixture);
        expect(payload.print_type).toBe('daily_sales_report');
        expect(payload.report_id).toBe('daily_sales_report:2026-07-14:2026-07-14');
        expect(payload.categories[0].subcategories[0].name).toBe('Burgers');
        expect(payload.products[0]).toMatchObject({ sold_qty: 5, returned_qty: 1, net_sales: 28 });
        expect(payload.products.some(row => row.item_name === 'Service Charge')).toBe(false);
    });

    it('buildDailyRefundPrintPayload normalizes refunds and events', () => {
        const refundPrintFixture = {
            period: {
                start_date: '2026-07-14',
                end_date: '2026-07-14',
                business_day_start_hour: 6
            },
            summary: {
                sales_processed: 100,
                refund_total: 30,
                refund_cash: 30,
                refund_card: 0,
                refund_count: 1,
                void_count: 0,
                void_value: 0
            },
            by_staff: [
                { user_id: 4, name: 'Cashier', refund_count: 1, refund_value: 30, void_count: 0, void_value: 0 }
            ],
            top_reasons: [
                { reason: 'wrong item', count: 1, value: 30 }
            ],
            events: [
                {
                    refund_id: 1,
                    kind: 'refund',
                    cashier_name: 'Cashier',
                    reason: 'wrong item',
                    amount_refunded: 30,
                    event_value: 30,
                    occurred_at_local: '2026-07-14 10:30',
                    items: [
                        { item_name: 'Test Burger', quantity: 1, line_total: 30 }
                    ]
                },
                {
                    refund_id: 2,
                    kind: 'void',
                    table_number: '4',
                    invoice_display_no: '43',
                    cashier_name: 'Waiter',
                    reason: 'Item removed from table',
                    event_value: 12,
                    occurred_at_local: '2026-07-14 10:45',
                    items: []
                }
            ]
        };

        const payload = buildDailyRefundPrintPayload(refundPrintFixture);
        expect(payload.print_type).toBe('daily_refunds_report');
        expect(payload.report_id).toBe('daily_refunds_report:2026-07-14:2026-07-14');
        expect(payload.by_staff).toHaveLength(1);
        expect(payload.top_reasons).toHaveLength(1);
        expect(payload.events[0]).toMatchObject({
            kind: 'refund',
            cashier_name: 'Cashier',
            reason: 'wrong item',
            items: expect.any(Array)
        });
        expect(payload.events[1]).toMatchObject({
            kind: 'void',
            table_number: '4',
            reason: 'Item removed from table'
        });
    });

    it('buildDailyExpensePrintPayload keeps totals and itemized history', () => {
        const payload = buildDailyExpensePrintPayload({
            period: {
                start_date: '2026-07-18',
                end_date: '2026-07-18',
                business_day_start_hour: 6
            },
            summary: { count: 2, total: 15, drawer: 10, outside: 5 },
            sales_collected: 100,
            remaining_after_expenses: 85,
            by_source: [{ source: 'drawer', total: 10 }],
            by_category: [{ category_name: 'Supplies', count: 2, total: 15 }],
            entries: [{ id: 1, category_name: 'Supplies', amount: 10, status: 'active' }]
        });

        expect(payload.print_type).toBe('daily_expenses_report');
        expect(payload.report_id).toBe('daily_expenses_report:2026-07-18:2026-07-18');
        expect(payload.remaining_after_expenses).toBe(85);
        expect(payload.entries).toHaveLength(1);
    });
});
