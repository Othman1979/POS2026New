import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import AdminReportA4 from '../AdminReportA4.vue';

async function renderHtml(printType, data) {
    return renderToString(createSSRApp(AdminReportA4, { printType, data }));
}

async function renderText(printType, data) {
    const html = await renderHtml(printType, data);
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('AdminReportA4 rendered financial contracts', () => {
    it('prints ingredient display units and keeps unlike waste quantities separate', async () => {
        const text = await renderText('daily_ingredients_report', {
            direction: 'ltr', period: { window_label: '2026-09-05' }, totals: {},
            ingredients: [
                { id: 1, name: 'Chicken', display_unit: 'kg', opening: 10000, received: 2000, used: 200, waste: 500, closing_expected: 11300, waste_by_reason: { spoiled: 500 } },
                { id: 2, name: 'Pepsi', display_unit: 'unit', opening: null, received: 0, used: 0, waste: 1, closing_expected: null, waste_by_reason: { spoiled: 1 } },
            ], waste_by_reason: { spoiled: 501 },
        });
        expect(text).toContain('0.2 kg');
        expect(text).toContain('11.3 kg');
        expect(text).toMatch(/Chicken\s+Spoiled\s+0.5 kg/);
        expect(text).toMatch(/Pepsi\s+Spoiled\s+1 unit/);
        expect(text).not.toContain('501');
    });
    it('renders the official audit as the approved two-page A4 ledger', async () => {
        const html = await renderHtml('audit_report', {
            report_type: 'z_audit',
            copy_label: 'ORIGINAL',
            serial_label: 'Z-114',
            payload_hash: '9f2c4a71e8b30d5c',
            business_start_at: '2026-08-22 06:00',
            business_end_at: '2026-08-23 05:59',
            generated_at: '2026-08-23 05:12',
            generated_by: { name: 'Manager' },
            storeInfo: { store_name: 'Test Restaurant' },
            summary: {
                total_orders: 60,
                sales_incl_tax: 1214.5,
                net_sales_pre_tax: 1150,
                tax_collected: 64.5,
                discounts_total: 20.5,
                line_discounts_total: 12,
                order_discounts_total: 8.5,
                refunds_total: 25,
                refund_count: 2,
                void_count: 2,
                void_value: 8.5,
                avg_check: 20.24,
            },
            payments: {
                cash_sales: 720,
                card_sales: 366.3,
                platform_sales: 128.2,
                total_collected: 1097.3,
            },
            cash_reconciliation: {
                starting_cash_total: 100,
                cash_expenses_total: 42.5,
                expected_cash_total: 782.5,
                actual_cash_total: 782.4,
                variance_total: -0.1,
            },
            platform_reconciliation: {
                positive_allocations: 128.2,
                deductions: 10,
                net_received: 118.2,
                unreconciled_difference: 0,
                settlement_count: 2,
                reversal_count: 0,
            },
            shifts: [{
                shift_id: 412,
                cashier_name: 'Cashier',
                status: 'closed',
                opened_at: '2026-08-22 06:00',
                closed_at: '2026-08-22 15:00',
                order_count: 60,
                gross_sales: 1214.5,
                platform_sales: 128.2,
                total_tax: 64.5,
                cash_sales: 720,
                card_sales: 366.3,
                cash_expenses: 42.5,
                line_discounts: 12,
                order_discounts: 8.5,
                refund_count: 2,
                refund_value: 25,
                void_count: 2,
                void_value: 8.5,
                starting_cash: 100,
                expected_cash: 782.5,
                actual_cash: 782.4,
                variance: -0.1,
            }],
            order_types: [{ order_type_name: 'Dine In', order_count: 60, total_sales: 1214.5 }],
            blockers: { open_shifts: [] },
        });
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        expect(html.match(/data-audit-page=/g)).toHaveLength(2);
        expect(html).toContain('data-audit-page="financial-summary"');
        expect(html).toContain('data-audit-page="operational-details"');
        expect(text).toMatch(/جرد Z[^]*نسخة أصلية[^]*حالة تسوية المناوبات[^]*الملخص المالي[^]*احتساب صافي المبيعات[^]*ملخص مراجعة المناوبات[^]*توزيع المبيعات حسب طريقة التحصيل/);
        expect(text).toMatch(/التفاصيل التشغيلية[^]*المناوبات[^]*المبيعات حسب نوع الطلب[^]*الخصومات والمرتجعات والإلغاءات[^]*المصروفات النقدية[^]*تسوية حسابات منصات التوصيل[^]*نتيجة المراجعة[^]*اعتماد المدير[^]*ملاحظات المراجعة/);
        expect(text).toContain('الفرق غير المسوّى');
    });

    it('reconciles non-period X/Z reports per cashier without netting drawer balances', async () => {
        const text = await renderText('audit_report', {
            report_type: 'z_audit',
            is_period: false,
            generated_at: '2026-09-01T10:05:00.000Z',
            business_start_at: '2026-09-01T03:00:00.000Z',
            business_end_at: '2026-09-02T03:00:00.000Z',
            storeInfo: { store_name: 'Test Restaurant' },
            summary: { total_orders: 2, sales_incl_tax: 25, tax_collected: 3, net_sales_pre_tax: 22 },
            payments: { cash_sales: 25 },
            cash_reconciliation: {
                starting_cash_total: 200,
                expected_cash_total: 225,
                actual_cash_total: 225,
                variance_total: 0,
            },
            shifts: [{
                shift_id: 11,
                cashier_name: 'Morning Cashier',
                status: 'closed',
                opened_at: '2026-09-01T05:00:00.000Z',
                closed_at: '2026-09-01T12:00:00.000Z',
                order_count: 1,
                gross_sales: 10,
                total_tax: 1,
                cash_sales: 10,
                card_sales: 0,
                platform_sales: 0,
                line_discounts: 0,
                order_discounts: 0,
                refund_count: 0,
                refund_value: 0,
                void_count: 0,
                void_value: 0,
                cash_expenses: 0,
                starting_cash: 100,
                expected_cash: 110,
                actual_cash: 114,
                variance: 4,
            }, {
                shift_id: 12,
                cashier_name: 'Night Cashier',
                status: 'closed',
                opened_at: '2026-09-01T12:00:00.000Z',
                closed_at: '2026-09-01T22:30:00.000Z',
                order_count: 1,
                gross_sales: 15,
                total_tax: 2,
                cash_sales: 15,
                card_sales: 0,
                platform_sales: 0,
                line_discounts: 0,
                order_discounts: 0,
                refund_count: 0,
                refund_value: 0,
                void_count: 0,
                void_value: 0,
                cash_expenses: 0,
                starting_cash: 100,
                expected_cash: 115,
                actual_cash: 111,
                variance: -4,
            }],
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text).toContain('Morning Cashier');
        expect(text).toContain('Night Cashier');
        expect(text.match(/رصيد الافتتاح/g)).toHaveLength(2);
        expect(text).not.toContain('200.00 د.أ');
        expect(text).not.toContain('225.00 د.أ');
        expect(text).toContain('مناوبتان تحتاجان مراجعة');
        expect(text).not.toContain('الصندوق متوازن');
        expect(text).toContain('2026-09-01 08:00 AM');
        expect(text).toContain('2026-09-01 03:00 PM');
        expect(text).toContain('2026-09-02 01:30 AM');
        expect(text).toContain('2026-09-01 01:05 PM');
        expect(text).not.toContain('2026-09-01T');
    });

    it('never prints sequential drawer snapshots as a combined 1,100 or 500 total', async () => {
        const text = await renderText('audit_report', {
            report_type: 'period',
            is_period: true,
            generated_at: '2026-07-14T12:00:00.000Z',
            summary: {},
            payments: {},
            cash_reconciliation: {
                starting_cash_total: 500,
                expected_cash_total: 1100,
                actual_cash_total: 1100,
                variance_total: 0,
            },
            shifts: [{
                shift_id: 1,
                cashier_name: 'First',
                status: 'closed',
                closed_in_window: true,
                within_window: true,
                starting_cash: 100,
                expected_cash: 400,
                actual_cash: 400,
                variance: 0,
            }, {
                shift_id: 2,
                cashier_name: 'Second',
                status: 'closed',
                closed_in_window: true,
                within_window: true,
                starting_cash: 400,
                expected_cash: 700,
                actual_cash: 700,
                variance: 0,
            }],
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text.match(/رصيد الافتتاح/g)).toHaveLength(2);
        expect(text).not.toContain('1,100.00');
        expect(text).not.toContain('500.00');
    });

    it('keeps opposite shortages and overages in review instead of a balanced drawer', async () => {
        const text = await renderText('audit_report', {
            report_type: 'z_audit',
            cash_reconciliation: {
                net_variance_total: 0,
                shortage_total: 4,
                overage_total: 4,
                closed_shifts: 2,
                shifts_needing_review: 2,
                open_shifts: 0,
                closed_outside_window: 0,
                uncounted_shifts: 0,
            },
            shifts: [
                { shift_id: 1, cashier_name: 'A', status: 'closed', closed_in_window: true, within_window: true, actual_cash: 104, expected_cash: 100, variance: 4, starting_cash: 100 },
                { shift_id: 2, cashier_name: 'B', status: 'closed', closed_in_window: true, within_window: true, actual_cash: 96, expected_cash: 100, variance: -4, starting_cash: 100 },
            ],
            summary: {},
            payments: {},
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text).toContain('مناوبتان تحتاجان مراجعة');
        expect(text).not.toContain('الصندوق متوازن');
    });

    it('omits the drawer equation when within_window is false', async () => {
        const text = await renderText('audit_report', {
            report_type: 'period',
            is_period: true,
            summary: {},
            payments: {},
            cash_reconciliation: { net_variance_total: 0, closed_shifts: 0, closed_outside_window: 1, open_shifts: 0, uncounted_shifts: 0, shifts_needing_review: 0 },
            shifts: [{
                shift_id: 8,
                cashier_name: 'Overnight',
                status: 'closed',
                closed_in_window: false,
                within_window: false,
                starting_cash: 50,
                expected_cash: 80,
                actual_cash: 77,
                variance: -3,
            }],
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text).toContain('نشاط ضمن نافذة التقرير');
        expect(text).toContain('أرصدة المناوبة عند الإغلاق');
        expect(text).not.toContain('= النقد المتوقع');
    });

    it('prints the drawer equation only when within_window is true', async () => {
        const text = await renderText('audit_report', {
            report_type: 'z_audit',
            summary: {},
            payments: {},
            cash_reconciliation: { net_variance_total: 0, closed_shifts: 1, open_shifts: 0, uncounted_shifts: 0, shifts_needing_review: 0, closed_outside_window: 0 },
            shifts: [{
                shift_id: 9,
                cashier_name: 'Day',
                status: 'closed',
                closed_in_window: true,
                within_window: true,
                starting_cash: 50,
                expected_cash: 80,
                actual_cash: 80,
                variance: 0,
            }],
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text).toContain('= النقد المتوقع');
        expect(text).toContain('نشاط ضمن نافذة التقرير');
        expect(text).toContain('أرصدة المناوبة عند الإغلاق');
    });

    it('renders stale rows without flags as per-shift balances and ignores legacy totals', async () => {
        const text = await renderText('audit_report', {
            report_type: 'z_audit',
            summary: {},
            payments: {},
            cash_reconciliation: {
                starting_cash_total: 1100,
                expected_cash_total: 1100,
                actual_cash_total: 1100,
                variance_total: 0,
            },
            shifts: [{
                shift_id: 3,
                cashier_name: 'Stale',
                status: 'closed',
                starting_cash: 100,
                expected_cash: 400,
                actual_cash: 400,
                variance: 0,
            }],
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text).toContain('رصيد الافتتاح');
        expect(text).toContain('400.00');
        expect(text).not.toContain('1,100.00');
        expect(text).not.toContain('= النقد المتوقع');
    });

    it('does not keep period aggregate expected, actual, or variance columns', async () => {
        const text = await renderText('audit_report', {
            report_type: 'period',
            is_period: true,
            generated_at: '2026-09-03T05:00:00.000Z',
            summary: {},
            payments: {},
            cash_reconciliation: {
                starting_cash_total: 300,
                cash_expenses_total: 20,
                expected_cash_total: 450,
                actual_cash_total: 450,
                variance_total: 0,
            },
            shifts: [{
                shift_id: 21,
                cashier_name: 'Period Cashier',
                status: 'closed',
                opened_at: '2026-09-01T05:00:00.000Z',
                closed_at: '2026-09-01T12:00:00.000Z',
                starting_cash: 100,
                expected_cash: 150,
                actual_cash: 150,
                variance: 0,
            }],
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text).toContain('رصيد الافتتاح');
        expect(text).not.toContain('رصيد الصندوق عند الفتح');
        expect(text).toContain('ملخص مراجعة المناوبات');
    });

    it('renders the Daily Summary producer field names and units', async () => {
        const text = await renderText('daily_summary_report', {
            direction: 'ltr',
            period: { window_label: '2026-08-23' },
            summary: {},
            payments: [
                { key: 'cash', amount: 10 },
                { key: 'card', amount: 20 },
                { key: 'platform', amount: 30 },
            ],
            platform_reconciliation: {},
            comparison: {},
            order_types: [{ name: 'Dine In', orders: 5, net_sales: 50 }],
            hourly_sales: [{ hour: 9, orders: 3, sales_processed: 27.5 }],
            cash_status: {},
        });

        expect(text).toMatch(/Cash Payments\s+10\.00 JD/);
        expect(text).toMatch(/Card Payments\s+20\.00 JD/);
        expect(text).toMatch(/Platform Sales[^0-9]*30\.00 JD/);
        expect(text).toMatch(/Dine In\s+5\s+50\.00 JD/);
        expect(text).toMatch(/09:00\s+3\s+27\.50 JD/);
    });

    it('prints shortage, overage, and net variance instead of combined drawer balances', async () => {
        const text = await renderText('daily_summary_report', {
            direction: 'rtl',
            period: { window_label: '2026-07-14' },
            summary: {},
            payments: [],
            platform_reconciliation: {},
            comparison: {},
            order_types: [],
            hourly_sales: [],
            cash_status: {
                state: 'review',
                open_shifts: 0,
                closed_shifts: 2,
                closed_outside_window: 0,
                uncounted_shifts: 0,
                shifts_needing_review: 2,
                net_variance: 0,
                shortage_total: 4,
                overage_total: 4,
            },
        });

        expect(text).toContain('إجمالي العجز');
        expect(text).toContain('إجمالي الزيادة');
        expect(text).toContain('صافي فرق المناوبات');
        expect(text).not.toContain('النقد المتوقع');
        expect(text).not.toContain('النقد الفعلي');
        expect(text).not.toContain('Expected cash');
        expect(text).not.toContain('Counted cash');
    });

    it('does not invent variance money when no shift settled in the report window', async () => {
        const text = await renderText('daily_summary_report', {
            direction: 'rtl',
            period: { window_label: '2026-07-14' },
            summary: {},
            payments: [],
            platform_reconciliation: {},
            comparison: {},
            order_types: [],
            hourly_sales: [],
            cash_status: {
                state: 'no_shifts',
                open_shifts: 0,
                closed_shifts: 0,
                closed_outside_window: 1,
                uncounted_shifts: 0,
                shifts_needing_review: 0,
                net_variance: 0,
                shortage_total: 0,
                overage_total: 0,
            },
        });

        expect(text).toContain('لا توجد مناوبات أُغلقت ضمن فترة التقرير');
        expect(text).not.toContain('إجمالي العجز');
        expect(text).not.toContain('إجمالي الزيادة');
        expect(text).not.toContain('صافي فرق المناوبات');
        expect(text).not.toContain('التسوية قيد التنفيذ');
    });

    it('keeps every refund channel and uses the event fields returned by the server', async () => {
        const text = await renderText('daily_refunds_report', {
            direction: 'ltr',
            period: { window_label: '2026-08-23' },
            summary: {
                sales_processed: 100,
                refund_total: 5,
                refund_rate: 5,
                refund_cash: 2,
                refund_card: 2,
                refund_platform: 1,
                refund_count: 1,
                void_count: 0,
                void_value: 0,
            },
            by_staff: [],
            top_reasons: [],
            events: [{
                invoice_display_no: 'INV-7',
                kind: 'refund',
                reason: 'Customer request',
                cashier_name: 'Cashier',
                occurred_at_local: '2026-08-23 10:00',
                refund_method: 'cash',
                event_value: 12.5,
            }],
        });

        expect(text).toMatch(/Refunded to platform\s+1\.00 JD/);
        expect(text).toMatch(/INV-7\s+Refund\s+Customer request\s+Cashier\s+2026-08-23 10:00\s+Cash\s+12\.50 JD/);
    });

    it('renders complete Daily Sales category and dimension rows', async () => {
        const text = await renderText('daily_sales_report', {
            direction: 'ltr',
            period: { window_label: '2026-08-23' },
            totals: {},
            categories: [{
                name: 'Food', sold_qty: 5, returned_qty: 1, sold_amount: 33.8, returned_amount: 5.8, net_sales: 28,
                subcategories: [{ name: 'Burgers', sold_qty: 3, returned_qty: 1, sold_amount: 20, returned_amount: 5.8, net_sales: 14.2, subcategories: [] }],
            }],
            products: [{ item_name: 'Burger', category_path: 'Food › Burgers', sold_qty: 3, returned_qty: 1, sold_amount: 20, returned_amount: 5.8, net_sales: 14.2 }],
            order_types: [{ name: 'Dine In', orders: 4, sold_amount: 30, returned_amount: 2, net_sales: 28 }],
            cashiers: [{ name: 'Cashier', orders: 4, sold_amount: 30, returned_amount: 2, net_sales: 28 }],
            waiters: [{ name: 'Waiter', orders: 4, sold_amount: 30, returned_amount: 2, net_sales: 28 }],
            tables: [{ table_number: 'T-4', section_name: 'Main Floor', orders: 4, sold_amount: 30, returned_amount: 2, net_sales: 28 }],
            tables_enabled: true,
        });

        expect(text).toMatch(/Food\s+5\s+1\s+33\.80 JD\s+5\.80 JD\s+28\.00 JD/);
        expect(text).toMatch(/Food › Burgers\s+3\s+1\s+20\.00 JD\s+5\.80 JD\s+14\.20 JD/);
        expect(text).toMatch(/Burger\s+Food › Burgers\s+3\s+1\s+20\.00 JD\s+5\.80 JD\s+14\.20 JD/);
        expect(text).toMatch(/Main Floor · Table T-4\s+4\s+30\.00 JD\s+2\.00 JD\s+28\.00 JD/);
    });

    it('keeps the V2 expense breakdown in X/Z reports', async () => {
        const text = await renderText('z_report', {
            shift_id: 14,
            cashier_name: 'Samir',
            opened_at: '2026-08-23 08:00',
            cash_sales: 10,
            card_sales: 20,
            platform_sales: 30,
            total_discounts: 3,
            cash_expenses: 8,
            expense_categories: [{ category_name: 'Supplies', count: 2, total: 8 }],
            order_type_breakdown: [],
            platform_order_type_breakdown: [],
        });

        expect(text).toMatch(/Shift\s+#14/);
        expect(text).toMatch(/Cashier\s+Samir/);
        expect(text).toMatch(/Cash Expenses by Category[^]*Supplies\s+2\s+-8\.00 JD/);
    });

    it('localizes bounded expense values instead of leaking enum tokens into Arabic output', async () => {
        const text = await renderText('daily_expenses_report', {
            direction: 'rtl',
            period: { window_label: '2026-08-23' },
            summary: {},
            by_source: [{ source: 'drawer', total: 1 }],
            by_category: [],
            entries: [{
                id: 1,
                category_name: 'Supplies',
                source: 'drawer',
                created_by_name: 'Cashier',
                status: 'active',
                created_at: '2026-08-23 10:00',
                note: 'تنظيف طارئ',
                amount: 1,
            }, {
                id: 2,
                category_name: 'Supplies',
                source: 'outside',
                created_by_name: 'Cashier',
                canceled_by_name: 'Manager',
                status: 'canceled',
                created_at: '2026-08-23 10:15',
                canceled_at: '2026-08-23 10:30',
                note: 'Canceled entry',
                amount: 2,
            }],
        });

        expect(text).toContain('من الصندوق');
        expect(text).toContain('نشط');
        expect(text).toContain('ملغى');
        expect(text).toContain('تنظيف طارئ');
        expect(text).toContain('2026-08-23 01:30 PM');
        expect(text).not.toMatch(/\b(drawer|active)\b/);
    });

    it('retains platform values in Arabic audit shift rows', async () => {
        const text = await renderText('audit_report', {
            summary: {},
            payments: {},
            cash_reconciliation: {},
            shifts: [{
                shift_id: 9,
                cashier_name: 'Cashier',
                status: 'open',
                opened_at: '2026-08-23 08:00',
                closed_at: null,
                starting_cash: 25,
                gross_sales: 100,
                platform_sales: 20,
                total_tax: 8,
                cash_sales: 40,
                card_sales: 40,
                order_count: 9,
                refund_count: 2,
                void_count: 1,
                cash_expenses: 0,
                line_discounts: 0,
                order_discounts: 0,
                refund_value: 0,
                void_value: 0,
                expected_cash: 45,
                actual_cash: null,
                variance: null,
            }],
            order_types: [],
            blockers: { open_shifts: [] },
        });

        expect(text).toContain('مفتوحة');
        expect(text).not.toMatch(/\bopen\b/);
        expect(text).not.toContain('الجرد الفعلي مكتمل');
        expect(text).toMatch(/المبيعات شاملة الضريبة 100\.00 د\.أ[^]*الضريبة المحصلة 8\.00 د\.أ/);
        expect(text).toMatch(/نقدًا \/ بطاقة \/ منصات 40\.00 د\.أ \/ 40\.00 د\.أ \/ 20\.00 د\.أ/);
        expect(text).toMatch(/مرتجعات: عدد \/ قيمة 2 \/ 0\.00 د\.أ[^]*طلبات ملغاة: عدد \/ قيمة 1 \/ 0\.00 د\.أ/);
        expect(text).toMatch(/رصيد الافتتاح 25\.00 د\.أ[^]*النقد المتوقع 45\.00 د\.أ[^]*النقد الفعلي —[^]*الفرق \(عجز أو زيادة\) —/);
        expect(text).toContain('2026-08-23 11:00 AM');
        expect(text).toMatch(/\b9\b/);
    });

    it('prints Y calculations and aggregated items without individual receipts', async () => {
        const text = await renderText('y_held_items_report', {
            summary: {
                order_count: 1,
                subtotal: 10,
                line_discount: 1,
                order_discount: 2,
                tax: 0.5,
                total: 7.5,
            },
            orders: [{
                held_order_id: 7,
                reference_name: 'Hold 7',
                cashier_name: 'Cashier',
                created_at: '2026-08-23 11:00',
                kitchen_fired: true,
                summary: { subtotal: 10, line_discount: 1, order_discount: 2, tax: 0.5, total: 7.5 },
                items: [{ item_name: 'Burger', note: 'No onion', qty: 2, unit_price: 5, line_discount: 1, net_amount: 9, kind: 'item' }],
            }],
            categories: [],
            subcategories: [],
            items: [{ item_name: 'Aggregated Burger', qty_sold: 2, gross_revenue: 7.5 }],
        });

        expect(text).toMatch(/1\.00 د\.أ\s+خصم الأصناف/);
        expect(text).toMatch(/2\.00 د\.أ\s+خصم الطلبات/);
        expect(text).toContain('Aggregated Burger');
        expect(text).toContain('7.50');
        for (const receiptText of ['Hold 7', 'Cashier', 'No onion', 'تفاصيل الطلبات', 'أصناف الطلبات المحفوظة']) expect(text).not.toContain(receiptText);
    });
});
