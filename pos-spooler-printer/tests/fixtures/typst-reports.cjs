'use strict';

const period = { window_label: '2026-09-20 06:00 → 2026-09-21 05:59' };
const shift = { storeInfo: { store_name: 'Sample Store' }, shift_id: 17, gross_sales: 150,
    platform_sales: 30, total_discounts: 5, cash_sales: 80, card_sales: 40, cash_expenses: 8,
    starting_cash: 20, expected_cash: 92, actual_cash: 90,
    platform_order_type_breakdown: [{ order_type_name: 'Delivery', total_sales: 30 }],
    order_type_breakdown: [{ order_type_name: 'Dine In', total_sales: 100 }],
    expense_categories: [{ category_name: 'Supplies', count: 1, total: 8 }] };
const audit = { storeInfo: { store_name: 'مطعم العينة' }, report_type: 'z_audit', serial_label: 'Z-17',
    copy_label: 'REPRINT', business_date: '2026-09-20', generated_at: '2026-09-21T00:00:00Z',
    generated_by: { name: 'مدير' }, summary: { sales_incl_tax: 110, net_sales_pre_tax: 100,
        tax_collected: 10, total_orders: 3, avg_check: 36.67, discounts_total: 5,
        line_discounts_total: 2, order_discounts_total: 3, refund_count: 1, refunds_total: 4,
        void_count: 1, void_value: 6 }, payments: { cash_sales: 50, card_sales: 30,
        platform_sales: 30, total_collected: 80 }, cash_reconciliation: { closed_shifts: 1,
        closed_outside_window: 0, open_shifts: 0, uncounted_shifts: 0, shifts_needing_review: 1,
        net_variance_total: -2, shortage_total: 2, overage_total: 0, cash_expenses_total: 3 },
    shifts: [{ shift_id: 9, cashier_name: 'أحمد', status: 'closed', within_window: true,
        gross_sales: 110, cash_sales: 50, card_sales: 30, platform_sales: 30, cash_expenses: 3,
        line_discounts: 2, order_discounts: 3, refund_count: 1, refund_value: 4, void_count: 1,
        void_value: 6, starting_cash: 20, expected_cash: 67, actual_cash: 65, variance: -2 }],
    order_types: [{ order_type_name: 'سفري', order_count: 2, total_sales: 60 }],
    blockers: { open_shifts: [{ shift_id: 10, cashier_name: 'باسل' }] }, payload_hash: 'abcdef1234567890' };
const category = { storeInfo: { store_name: 'مطعم العينة' }, business_date: '2026-09-20',
    generated_at: '2026-09-21T00:00:00Z', generated_by: { name: 'مدير' },
    summary: { order_count: 2, subtotal: 100, line_discount: 3, order_discount: 2, tax: 8, total: 103 },
    categories: [{ category_name: 'مشروبات', qty_sold: 3, gross_revenue: 15 }],
    subcategories: [{ category_name: 'رئيسية', rows: [{ category_name: 'بارد', qty_sold: 2, gross_revenue: 10 }] }],
    items: [{ item_name: 'عصير برتقال', qty_sold: 2, gross_revenue: 10 }] };
const summary = { language: 'en', period, summary: { sales_collected: 130, expenses_total: 7,
    remaining_after_expenses: 123, sales_processed: 140, refunds_issued: 10,
    net_revenue_pre_tax: 120, tax_collected: 10, service_charges_collected: 9,
    total_orders: 12, average_ticket: 11.67, discounted_orders: 1, refund_count: 1, void_count: 2 },
    payments: [{ key: 'cash', amount: 80 }, { key: 'card', amount: 50 }, { key: 'platform', amount: 30 }],
    cash_status: { state: 'review', closed_shifts: 2, open_shifts: 0, uncounted_shifts: 0,
        net_variance: 0, shortage_total: 4, overage_total: 4 } };
const sales = { language: 'en', period, totals: { sales_collected: 99, menu_sales: 90,
    service_charges_collected: 9 }, categories: [{ name: 'Food', sold_qty: 3, net_sales: 30,
        subcategories: [{ name: 'Soup', sold_qty: 1, net_sales: 10 }] }],
    products: [{ item_name: 'Tomato Soup', sold_qty: 2, returned_qty: 1, net_sales: 20 }],
    order_types: [{ name: 'Dine In', orders: 2, net_sales: 40 }],
    cashiers: [{ name: 'Ali', orders: 2, net_sales: 40 }], tables_enabled: true,
    waiters: [{ name: 'Zaid', orders: 1, net_sales: 20 }],
    tables: [{ table_number: '4', section_name: 'Patio', net_sales: 20 }] };
const refunds = { language: 'en', period,
    summary: { sales_processed: 100, refund_total: 5, refund_rate: 5, void_value: 8 },
    by_staff: [{ name: 'Ali', refund_value: 5, void_value: 8 }],
    top_reasons: [{ reason: 'Item removed from table', count: 1, value: 8 }],
    events: [{ kind: 'void', table_number: 4, event_value: 8, cashier_name: 'Ali',
        occurred_at_local: '12:30', refund_method: 'cash', reason: 'Item removed from table',
        items: [{ item_name: 'Burger', quantity: 1, line_total: 8 }] }] };
const expenses = { language: 'en', period, summary: { total: 15, drawer: 10, outside: 5 },
    sales_collected: 100, remaining_after_expenses: 85,
    by_category: [{ category_name: 'Supplies', count: 2, total: 15 }],
    entries: [{ id: 7, category_name: 'Supplies', amount: 10, source: 'drawer', shift_id: 3,
        note: 'Paper rolls', status: 'canceled', created_by_name: 'Cashier', canceled_by_name: 'Manager',
        created_at: '10:00' }] };
const slip = { language: 'en', storeInfo: { store_name: 'Sample Store' }, id: 7,
    category_name: 'Supplies', amount: 10, source: 'drawer', shift_id: 3,
    created_by_name: 'Cashier', created_at: '10:00', canceled_by_name: 'Manager',
    canceled_at: '10:05', note: 'Paper rolls' };

const dataByType = { x_report: shift, z_report: shift, audit_report: audit,
    category_items_report: category, y_held_items_report: category,
    daily_summary_report: summary, daily_sales_report: sales, daily_refunds_report: refunds,
    daily_expenses_report: expenses, expense_slip: slip, expense_cancel_slip: slip };

module.exports = { dataByType, jobs: Object.entries(dataByType).map(([print_type, data], i) => ({
    queue_id: 1000 + i, print_type, data
})) };
