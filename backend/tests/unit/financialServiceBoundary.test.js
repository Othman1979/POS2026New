import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const BACKEND = path.resolve(__dirname, '../..');
const FINANCIAL_SERVICES = [
    'auditReportBuilder.js',
    'categoryItemsReportBuilder.js',
    'dailyRefundReportBuilder.js',
    'dailySalesDetailsBuilder.js',
    'financialEventMetrics.js',
    'productSalesMetrics.js',
    'shiftMetrics.js'
];

describe('financial service boundary', () => {
    it('keeps service modules independent from HTTP route modules', () => {
        for (const filename of FINANCIAL_SERVICES) {
            const source = fs.readFileSync(path.join(BACKEND, 'services', filename), 'utf8');
            expect(source, filename).not.toMatch(/routes[\\/]admin[\\/](?:helpers|financeMetrics)/);
        }
    });

    it('owns financial SQL and metrics in services while preserving route helper compatibility', () => {
        const sqlPath = path.join(BACKEND, 'services/financialSql.js');
        const metricsPath = path.join(BACKEND, 'services/financeMetrics.js');
        expect(fs.existsSync(sqlPath)).toBe(true);
        expect(fs.existsSync(metricsPath)).toBe(true);

        const financialSql = require(sqlPath);
        const routeHelpers = require(path.join(BACKEND, 'routes/admin/helpers.js'));
        expect(routeHelpers.paidOrderWhere).toBe(financialSql.paidOrderWhere);
        expect(routeHelpers.activeOrderDiscountApplied).toBe(financialSql.activeOrderDiscountApplied);
        expect(routeHelpers.getRefundsByShift).toBe(financialSql.getRefundsByShift);
    });
});
