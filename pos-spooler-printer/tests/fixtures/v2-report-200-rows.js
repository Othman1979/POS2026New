module.exports = {
    queue_id: 9200,
    idempotency_key: 'v2-report-200-rows',
    payload_hash: '9'.repeat(64),
    printer_id: 3,
    print_type: 'daily_sales_report',
    data: {
        language: 'ar',
        period: { window_label: '2026-08-17' },
        storeInfo: { store_name: 'مطعم الاختبار' },
        totals: { sales_collected: 1234.56, menu_sales: 1100, service_charges_collected: 134.56 },
        payments: [{ key: 'cash', amount: 600 }, { key: 'card', amount: 500 }],
        products: Array.from({ length: 200 }, (_, index) => ({
            item_name: `صنف اختبار ${index + 1}`,
            sold_qty: 1,
            returned_qty: 0,
            net_sales: 5.5
        })),
        cashiers: [{ name: 'موظف الاختبار', orders: 200, net_sales: 1100 }],
        waiters: [],
        tables: [],
        tables_enabled: false
    }
};
