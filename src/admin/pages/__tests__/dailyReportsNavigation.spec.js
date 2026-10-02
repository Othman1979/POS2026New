import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Daily Reports Navigation Structure', () => {
    const routerPath = path.resolve(__dirname, '../../router.js');
    const layoutPath = path.resolve(__dirname, '../../components/ReportsLayout.vue');
    const sidebarPath = path.resolve(__dirname, '../../components/Sidebar.vue');
    const summaryPath = path.resolve(__dirname, '../ReportsSummary.vue');
    const salesPath = path.resolve(__dirname, '../ReportsSalesDetails.vue');
    const refundsPath = path.resolve(__dirname, '../ReportsRefunds.vue');
    const expensesPath = path.resolve(__dirname, '../ReportsExpenses.vue');
    const expenseCategoriesPath = path.resolve(__dirname, '../../components/ExpenseCategoryModal.vue');

    it('router.js defines the four focused report routes and handles legacy redirection', () => {
        const source = fs.readFileSync(routerPath, 'utf8');

        expect(source).toContain("name: 'reports-summary'");
        expect(source).toContain("name: 'reports-sales'");
        expect(source).toContain("name: 'reports-refunds'");
        expect(source).toContain("name: 'reports-expenses'");
        expect(source).toContain("name: 'reports-ingredients'");

        // check that legacy pages redirect to reports-summary or other
        expect(source).toContain('reports-overview');
        expect(source).toContain("{ path: '/reports-invoices', redirect: '/orders' }");
        expect(source).toContain("{ path: '/reports-shifts', redirect: '/shifts' }");
        expect(source).toContain("'reports-invoices': 'orders'");
        expect(source).toContain("'reports-shifts': 'shifts'");
    });

    it('ReportsLayout.vue provides the shared period and browser-only print layout menu', () => {
        const source = fs.readFileSync(layoutPath, 'utf8');

        expect(source).not.toContain('reports-invoices');
        expect(source).toContain('ReportPrintMenu');
        expect(source).toContain('useBrowserReportPrint');
        expect(source).toContain('@select="printReportLayout"');
        expect(source).toContain(':disabled="!reportSupported"');
        expect(source).not.toContain('useThermalReportPrint');
        expect(source).not.toContain('print_method');
        expect(source).not.toContain('pos_receipt_printer_id');
        expect(source).not.toContain('api/print/print');
        expect(source).toContain('exportReportExcel');
        expect(source).toContain('printReportPdf');
        for (const label of ['Previous', 'Today', 'Next', 'Custom period']) {
            expect(source).toContain(label);
        }
        expect(source).toContain(':max="today"');
        expect(source).toContain('periodError');
    });

    it('uses two-decimal ledgers and resilient report states', () => {
        const summary = fs.readFileSync(summaryPath, 'utf8');
        const sales = fs.readFileSync(salesPath, 'utf8');
        const refunds = fs.readFileSync(refundsPath, 'utf8');
        const expenses = fs.readFileSync(expensesPath, 'utf8');

        for (const source of [summary, sales, refunds, expenses]) {
            expect(source).not.toContain('toFixed(3)');
        }
        expect(summary).toContain('error && !data');
        expect(sales).toContain('error && !data');
        expect(summary).not.toContain('md:grid-cols-3');
        expect(refunds).not.toContain('grid-cols-2 lg:grid-cols-4');
        expect(expenses).toContain('remaining_after_expenses');
    });

    it('keeps refund investigation row-local, retryable, and keyboard accessible', () => {
        const source = fs.readFileSync(refundsPath, 'utf8');

        expect(source).toContain('value="split"');
        expect(source).toContain('tabindex="0"');
        expect(source).toContain('@keydown.enter');
        expect(source).toContain('detailsState');
        expect(source).toContain('retryRowDetails');
        expect(source).toContain('AbortController');
        expect(source).toContain('clearTimeout(debounceTimer)');
    });

    it('keeps expense category ordering automatic and shows readable expense times', () => {
        const expenses = fs.readFileSync(expensesPath, 'utf8');
        const categories = fs.readFileSync(expenseCategoriesPath, 'utf8');

        expect(categories).not.toContain('v-model.number="category.sort_order"');
        expect(expenses).toContain('formatBusinessDateTime(entry.created_at)');
        expect(expenses).toContain('min="0"');
        expect(expenses).not.toContain('min="0.01"');
    });
});
