# Admin Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current admin dashboard with a current-business-day operating view: four trusted headline metrics, matching-weekday pace comparison and forecast, conditional table status, exception-only warnings, product performance, payment mix, complete Arabic copy, and Latin digits.

**Architecture:** Build one event-time analytics pipeline over a bounded 29-day range, reusing Daily Reports money and product rules rather than calling single-period report builders dozens of times. A slim dashboard builder combines those event rows with pure comparison/forecast functions and conditional operational queries. Vue 3 uses typed `<script setup>` components plus a lifecycle-safe data controller for `KeepAlive`, while Chart.js is isolated to one pace-chart component.

**Tech Stack:** Node.js, Express 5, MySQL 8-compatible SQL through `mysql2/promise`, Vue 3.5 Composition API, TypeScript-enabled Vue SFCs, Chart.js 4, Tailwind CSS 4, Vitest 4, supertest.

## Global Constraints

- Dashboard scope is current business day only. Add no date picker or historical query parameter.
- `Sales today` equals paid sales including tax minus refunds issued during current business day.
- `Average check` equals paid sales processed before refunds divided by paid order count, matching Daily Reports.
- Comparison uses previous four calendar dates with same weekday, cut at same elapsed business minute; require at least three operating days.
- Forecast uses matching-day progress share and every confidence gate from approved spec; unreliable estimate is `null`, never `0` or fabricated copy.
- Product money, units, discounts, service-charge exclusion, and refund-event attribution must stay consistent with Daily Reports Sales Details.
- Refunds, voids, discounts, register differences, and low stock appear only through deterministic attention rules.
- Tables payload and UI are absent when `tables_enabled != '1'`; merged tables never duplicate open order value.
- No recent-orders block, invoice actions, printing, tax card, profit, expenses, or AI-generated text.
- English and Arabic copy must be natural. No `Business Pulse`, `Performance Intelligence`, `Live Floor`, or similar titles.
- Arabic UI uses Latin digits for dates, times, percentages, counts, and money; existing translated JD label remains unchanged.
- Use warm neutral surfaces, thin dividers, restrained teal, no gradients, glass, heavy shadows, oversized hero, doughnut chart, or card mosaic.
- Chart chronological axis remains left-to-right in both languages. Structural layout mirrors in RTL.
- 1024px: headline ledger is 2x2, chart full width, Tables below. Mobile: one column, no page-level horizontal scrolling.
- Vue code uses Composition API and `<script setup lang="ts">`; dashboard component name remains exactly `dashboard` for `KeepAlive`.
- Refresh every 60 seconds only while active; retain last good payload on silent failure; abort stale requests; clean every timer/listener/chart.
- No schema migration. Use bounded range predicates and existing order/refund indexes. Run `EXPLAIN` against final dashboard queries before completion.

## File Map

### Backend files

- Modify `backend/utils/businessDate.js`: add SQL elapsed-business-minute helper.
- Modify `backend/tests/unit/businessDate.test.js`: lock overnight elapsed-minute SQL.
- Create `backend/services/financialEventMetrics.js`: shared financial formulas plus bounded event timeline query.
- Modify `backend/services/dailyReportBuilder.js`: consume/re-export shared formulas; preserve public contract.
- Create `backend/tests/integration/dashboardFinancialTimeline.test.js`: event attribution and tender allocation.
- Create `backend/services/productSalesMetrics.js`: shared product sales/refund event query.
- Modify `backend/services/dailySalesDetailsBuilder.js`: use shared product query.
- Create `backend/tests/integration/productSalesMetrics.test.js`: discount/refund/product-date regression.
- Create `backend/services/dashboardAnalytics.js`: pure matching dates, rollups, comparison, pace, forecast, warnings, product deltas.
- Create `backend/tests/unit/dashboardAnalytics.test.js`: pure rule coverage.
- Create `backend/services/dashboardDataBuilder.js`: orchestration and conditional operational reads.
- Create `backend/tests/integration/dashboardDataBuilder.test.js`: complete payload and tables/shift/stock behavior.
- Modify `backend/config/cache.js`: key dashboard cache by business date and minute bucket.
- Replace `backend/routes/admin/dashboard.js`: slim route calling builder.
- Rewrite `backend/tests/integration/dashboard.test.js`: public API and cache regressions.

### Frontend files

- Create `src/admin/pages/dashboard/dashboardTypes.ts`: dashboard API types.
- Create `src/admin/utils/dashboardPresentation.ts`: deterministic narrative and attention copy selection.
- Create `src/admin/utils/__tests__/dashboardPresentation.spec.js`: narrative/attention tests.
- Modify `src/admin/utils/reportFormatting.js`: localized business date/time/weekday using Latin digits.
- Modify `src/admin/utils/__tests__/reportFormatting.spec.js`: Arabic numeral regression.
- Modify `assets/js/admin/i18n.js`: every new static and dynamic Arabic key.
- Create `src/admin/pages/__tests__/dashboardLocalization.spec.js`: missing-key and banned-copy scan.
- Create `src/admin/composables/useDashboardData.ts`: fetch/refresh/realtime/`KeepAlive` controller.
- Create `src/admin/composables/__tests__/useDashboardData.spec.js`: timers, aborts, stale data, cleanup.
- Create `src/admin/components/dashboard/DashboardMetricLedger.vue`.
- Create `src/admin/components/dashboard/DashboardAttention.vue`.
- Create `src/admin/components/dashboard/DashboardPaceChart.vue`.
- Create `src/admin/components/dashboard/DashboardTablesNow.vue`.
- Create `src/admin/components/dashboard/DashboardProducts.vue`.
- Create `src/admin/components/dashboard/DashboardPayments.vue`.
- Replace `src/admin/pages/Dashboard.vue`: composition shell and responsive layout.
- Create `src/admin/pages/__tests__/dashboardStructure.spec.js`: component binding, IA, accessibility, and anti-regression contract.

---

### Task 1: Add elapsed-business-minute SQL helper

**Files:**
- Modify: `backend/utils/businessDate.js`
- Test: `backend/tests/unit/businessDate.test.js`

**Interfaces:**
- Produces: `businessLocalElapsedMinuteSql(columnExpression: string): string`; minute `0` is configured business-day start and minute `1439` is final minute.

- [ ] **Step 1: Write failing SQL-helper test**

Add inside existing `describe('SQL helpers')`:

```js
it('businessLocalElapsedMinuteSql wraps local time around the 06:00 business start', () => {
    expect(bd.businessLocalElapsedMinuteSql('o.created_at')).toBe(
        "MOD((HOUR(CONVERT_TZ(o.created_at, '+00:00', '+03:00')) * 60 + " +
        "MINUTE(CONVERT_TZ(o.created_at, '+00:00', '+03:00')) - 360 + 1440), 1440)"
    );
});
```

- [ ] **Step 2: Run test and confirm red**

Run: `npx vitest run backend/tests/unit/businessDate.test.js`

Expected: FAIL with `bd.businessLocalElapsedMinuteSql is not a function`.

- [ ] **Step 3: Add helper and export**

Add beside other SQL helpers:

```js
const businessLocalElapsedMinuteSql = (columnExpression) => {
    const local = businessLocalTimestampSql(columnExpression);
    const startMinutes = getBusinessDayStartHour() * 60;
    return `MOD((HOUR(${local}) * 60 + MINUTE(${local}) - ${startMinutes} + 1440), 1440)`;
};
```

Add `businessLocalElapsedMinuteSql` to `module.exports`.

- [ ] **Step 4: Run test and confirm green**

Run: `npx vitest run backend/tests/unit/businessDate.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/utils/businessDate.js backend/tests/unit/businessDate.test.js
git commit -m "feat(dashboard): add elapsed business minute SQL helper"
```

---

### Task 2: Centralize financial event formulas and timeline query

**Files:**
- Create: `backend/services/financialEventMetrics.js`
- Modify: `backend/services/dailyReportBuilder.js`
- Test: `backend/tests/integration/dashboardFinancialTimeline.test.js`
- Verify: `backend/tests/unit/dailyReportMath.test.js`
- Verify: `backend/tests/integration/dailyReportsSummary.test.js`

**Interfaces:**
- Produces: `allocateRefundPayment(refund, originalPayment)`.
- Produces: `combineFinancialEvents(sales, refunds)` with existing Daily Reports shape.
- Produces: `getFinancialEventsForPeriod(executor, startDate, endDate)` with existing behavior.
- Produces: `getFinancialEventTimeline(executor, range): Promise<FinancialMinuteEvent[]>`.
- `FinancialMinuteEvent` fields: `business_date`, `elapsed_minute`, `sales_processed`, `orders`, `cash`, `card`, `refunds_issued`, `tax_refunded`, `refund_cash`, `refund_card`, `refund_count`, `discounts_total`, `void_count`, `void_value`.

- [ ] **Step 1: Write failing timeline integration test**

Create test with fixed event times; use helpers already exported from `backend/tests/helpers/fixtures.js`:

```js
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { getBusinessDateRange } = require('../../utils/businessDate');
const { getFinancialEventTimeline } = require('../../services/financialEventMetrics');

describe('getFinancialEventTimeline', () => {
    beforeEach(seedDatabase);

    it('attributes paid sales and old-order refunds to their own event minutes', async () => {
        const oldInvoice = await insertPaidOrder(pool, {
            total: 100, subtotal: 100, tax: 0,
            cash_amount: 60, card_amount: 40, payment_method: 'split',
            invoice_issued_at: '2026-07-07 04:00:00', created_at: '2026-07-07 04:00:00'
        });
        await insertOrderItem(pool, { invoice_id: oldInvoice, quantity: 1, price_at_sale: 100, tax_amount: 0 });
        await insertOrderRefund(pool, {
            invoice_id: oldInvoice, amount_refunded: 10.01, subtotal_refunded: 10.01,
            refund_method: 'split', created_at: '2026-07-14 05:30:00'
        });
        await insertPaidOrder(pool, {
            total: 50, subtotal: 50, tax: 0,
            cash_amount: 50, payment_method: 'cash',
            invoice_issued_at: '2026-07-14 04:00:00', created_at: '2026-07-14 04:00:00'
        });

        const rows = await getFinancialEventTimeline(pool, getBusinessDateRange('2026-07-14'));
        expect(rows).toContainEqual(expect.objectContaining({
            business_date: '2026-07-14', elapsed_minute: 60,
            sales_processed: 50, orders: 1
        }));
        expect(rows).toContainEqual(expect.objectContaining({
            business_date: '2026-07-14', elapsed_minute: 150,
            refunds_issued: 10.01, refund_cash: 6.01, refund_card: 4
        }));
    });
});
```

- [ ] **Step 2: Run test and confirm red**

Run: `npx vitest run backend/tests/integration/dashboardFinancialTimeline.test.js`

Expected: FAIL because `backend/services/financialEventMetrics.js` does not exist.

- [ ] **Step 3: Move shared Daily Reports functions without behavior change**

Create `financialEventMetrics.js`. Move `allocateRefundPayment`, `combineFinancialEvents`, and `getFinancialEventsForPeriod` from `dailyReportBuilder.js` unchanged. Keep this export footer:

```js
module.exports = {
    allocateRefundPayment,
    combineFinancialEvents,
    getFinancialEventsForPeriod,
    getFinancialEventTimeline,
};
```

In `dailyReportBuilder.js`, import them:

```js
const {
    allocateRefundPayment,
    combineFinancialEvents,
    getFinancialEventsForPeriod,
} = require('./financialEventMetrics');
```

Keep compatibility exports at bottom:

```js
module.exports = {
    allocateRefundPayment,
    combineFinancialEvents,
    buildComparison,
    buildDailySummary
};
```

- [ ] **Step 4: Implement bounded minute timeline**

Use one bounded orders aggregation, one refund read, and one void union. Core merge contract:

```js
const { roundMoney } = require('./PosCalculator');
const {
    orderDiscountApplied,
    lineSubtotalBeforeOrderDiscount,
    paidOrderTimeSql,
    paidOrderWhere,
    refundVoidValueSql,
} = require('../routes/admin/helpers');
const {
    businessLocalDateSql,
    businessLocalElapsedMinuteSql,
} = require('../utils/businessDate');

function emptyTimelineRow(businessDate, elapsedMinute) {
    return {
        business_date: businessDate,
        elapsed_minute: Number(elapsedMinute),
        sales_processed: 0, orders: 0, cash: 0, card: 0,
        refunds_issued: 0, tax_refunded: 0, refund_cash: 0, refund_card: 0,
        refund_count: 0, discounts_total: 0, void_count: 0, void_value: 0,
    };
}

function timelineKey(date, minute) {
    return `${date}:${Number(minute)}`;
}

async function getFinancialEventTimeline(executor, range) {
    const paidAt = paidOrderTimeSql('o');
    const saleDate = businessLocalDateSql(paidAt);
    const saleMinute = businessLocalElapsedMinuteSql(paidAt);
    const refundDate = businessLocalDateSql('r.created_at');
    const refundMinute = businessLocalElapsedMinuteSql('r.created_at');
    const lineBeforeDiscount = lineSubtotalBeforeOrderDiscount('oi');

    const [orderResult, refundResult, voidResult] = await Promise.all([
        executor.query(`
            SELECT ${saleDate} AS business_date, ${saleMinute} AS elapsed_minute,
                   COUNT(o.invoice_id) AS orders,
                   COALESCE(SUM(o.total), 0) AS sales_processed,
                   COALESCE(SUM(CASE WHEN o.payment_method='cash' THEN o.total WHEN o.payment_method='split' THEN o.cash_amount ELSE 0 END), 0) AS cash,
                   COALESCE(SUM(CASE WHEN o.payment_method='card' THEN o.total WHEN o.payment_method='split' THEN o.card_amount ELSE 0 END), 0) AS card,
                   COALESCE(SUM(${orderDiscountApplied('o')} + COALESCE(ld.line_discount_amount, 0)), 0) AS discounts_total
            FROM orders o
            LEFT JOIN (
                SELECT oi.invoice_id,
                       COALESCE(SUM(GREATEST(0, (oi.price_at_sale * oi.quantity) - ${lineBeforeDiscount})), 0) AS line_discount_amount
                FROM order_items oi
                JOIN orders discount_orders ON discount_orders.invoice_id=oi.invoice_id
                WHERE ${paidOrderWhere('discount_orders')}
                GROUP BY oi.invoice_id
            ) ld ON ld.invoice_id = o.invoice_id
            WHERE ${paidOrderWhere('o')}
            GROUP BY ${saleDate}, ${saleMinute}
        `, [range.start, range.end, range.start, range.end]),
        executor.query(`
            SELECT ${refundDate} AS business_date, ${refundMinute} AS elapsed_minute,
                   r.amount_refunded, r.tax_refunded, r.refund_method,
                   o.cash_amount, o.card_amount
            FROM refunds r
            JOIN orders o ON o.invoice_id = r.invoice_id
            WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
        `, [range.start, range.end]),
        executor.query(`
            SELECT event_date AS business_date, event_minute AS elapsed_minute,
                   SUM(void_count) AS void_count, SUM(void_value) AS void_value
            FROM (
                SELECT ${refundDate} AS event_date, ${refundMinute} AS event_minute,
                       COUNT(*) AS void_count,
                       COALESCE(SUM(${refundVoidValueSql('r', 'o', 'riv')}), 0) AS void_value
                FROM refunds r
                LEFT JOIN orders o ON o.invoice_id = r.invoice_id
                LEFT JOIN (
                    SELECT ri.refund_id,
                           COALESCE(SUM(ri.line_total), 0) AS item_total,
                           COALESCE(SUM(ri.line_subtotal), 0) AS item_subtotal
                    FROM refund_items ri
                    JOIN refunds scoped_refund ON scoped_refund.id=ri.refund_id
                    WHERE scoped_refund.created_at >= ? AND scoped_refund.created_at < ?
                    GROUP BY ri.refund_id
                ) riv ON riv.refund_id=r.id
                WHERE r.kind='void' AND r.created_at >= ? AND r.created_at < ?
                GROUP BY ${refundDate}, ${refundMinute}
                UNION ALL
                SELECT ${businessLocalDateSql('o.created_at')} AS event_date,
                       ${businessLocalElapsedMinuteSql('o.created_at')} AS event_minute,
                       COUNT(*) AS void_count,
                       COALESCE(SUM(COALESCE(o.original_total, o.total, 0)), 0) AS void_value
                FROM orders o
                WHERE o.payment_method='voided' AND o.created_at >= ? AND o.created_at < ?
                  AND NOT EXISTS (SELECT 1 FROM refunds r2 WHERE r2.invoice_id=o.invoice_id AND r2.kind='void')
                GROUP BY ${businessLocalDateSql('o.created_at')}, ${businessLocalElapsedMinuteSql('o.created_at')}
            ) void_events
            GROUP BY event_date, event_minute
        `, [range.start, range.end, range.start, range.end, range.start, range.end]),
    ]);

    const rows = new Map();
    const rowFor = (date, minute) => {
        const key = timelineKey(date, minute);
        if (!rows.has(key)) rows.set(key, emptyTimelineRow(date, minute));
        return rows.get(key);
    };

    for (const row of orderResult[0]) {
        Object.assign(rowFor(row.business_date, row.elapsed_minute), {
            sales_processed: roundMoney(row.sales_processed), orders: Number(row.orders || 0),
            cash: roundMoney(row.cash), card: roundMoney(row.card),
            discounts_total: roundMoney(row.discounts_total),
        });
    }
    for (const refund of refundResult[0]) {
        const row = rowFor(refund.business_date, refund.elapsed_minute);
        const allocated = allocateRefundPayment(refund, refund);
        row.refunds_issued = roundMoney(row.refunds_issued + Number(refund.amount_refunded || 0));
        row.tax_refunded = roundMoney(row.tax_refunded + Number(refund.tax_refunded || 0));
        row.refund_cash = roundMoney(row.refund_cash + allocated.cash);
        row.refund_card = roundMoney(row.refund_card + allocated.card);
        row.refund_count += 1;
    }
    for (const event of voidResult[0]) {
        const row = rowFor(event.business_date, event.elapsed_minute);
        row.void_count += Number(event.void_count || 0);
        row.void_value = roundMoney(row.void_value + Number(event.void_value || 0));
    }
    return [...rows.values()].sort((a, b) =>
        a.business_date.localeCompare(b.business_date) || a.elapsed_minute - b.elapsed_minute
    );
}
```

- [ ] **Step 5: Run focused financial tests**

Run:

```bash
npx vitest run backend/tests/integration/dashboardFinancialTimeline.test.js backend/tests/unit/dailyReportMath.test.js backend/tests/integration/dailyReportsSummary.test.js
```

Expected: PASS. Existing Daily Reports values unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/services/financialEventMetrics.js backend/services/dailyReportBuilder.js backend/tests/integration/dashboardFinancialTimeline.test.js
git commit -m "refactor(reports): share financial event timeline metrics"
```

---

### Task 3: Share product sales and refund-event calculations

**Files:**
- Create: `backend/services/productSalesMetrics.js`
- Modify: `backend/services/dailySalesDetailsBuilder.js`
- Test: `backend/tests/integration/productSalesMetrics.test.js`
- Verify: `backend/tests/integration/dailyReportsSalesDetails.test.js`

**Interfaces:**
- Produces: `getProductSalesByBusinessDate(executor, range): Promise<ProductEventRow[]>`.
- Produces: `getProductSalesForPeriod(executor, period): Promise<ProductEventRow[]>`.
- Row fields: `business_date`, `elapsed_minute`, `product_id`, `item_name`, `category_id`, `sold_qty`, `returned_qty`, `sold_amount`, `returned_amount`, `net_units`, `net_sales`.

- [ ] **Step 1: Write failing product-event test**

```js
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { insertPaidOrder, insertOrderItem, insertOrderRefund } = require('../helpers/fixtures');
const { getBusinessDateRange } = require('../../utils/businessDate');
const { getProductSalesByBusinessDate } = require('../../services/productSalesMetrics');

describe('productSalesMetrics', () => {
    beforeEach(seedDatabase);

    it('keeps sale value on sale day and returned value on refund day', async () => {
        const invoiceId = await insertPaidOrder(pool, {
            subtotal: 100, total: 80, tax: 0, discount_type: 'fixed', discount_value: 20,
            invoice_issued_at: '2026-07-07 04:00:00', created_at: '2026-07-07 04:00:00'
        });
        const itemId = await insertOrderItem(pool, {
            invoice_id: invoiceId, quantity: 2, price_at_sale: 50, tax_amount: 0
        });
        const refundId = await insertOrderRefund(pool, {
            invoice_id: invoiceId, subtotal_refunded: 40, amount_refunded: 40,
            created_at: '2026-07-14 05:00:00'
        });
        await pool.query(`
            INSERT INTO refund_items
              (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
            VALUES (?, ?, 1, 'Test Burger', 1, 50, 40, 0, 40)
        `, [refundId, itemId]);

        const rows = await getProductSalesByBusinessDate(
            pool, getBusinessDateRange('2026-07-07', '2026-07-14')
        );
        expect(rows.find(r => r.business_date === '2026-07-07')).toMatchObject({ sold_amount: 80, net_sales: 80 });
        expect(rows.find(r => r.business_date === '2026-07-14')).toMatchObject({ returned_amount: 40, net_sales: -40, net_units: -1 });
    });
});
```

- [ ] **Step 2: Run test and confirm red**

Run: `npx vitest run backend/tests/integration/productSalesMetrics.test.js`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Extract one shared union query**

Move the product sale/refund union from `dailySalesDetailsBuilder.js` into
`productSalesMetrics.js`. Add business date to each union branch using event time:

```js
const { roundMoney } = require('./PosCalculator');
const { lineSubtotalAfterOrderDiscount, paidOrderTimeSql } = require('../routes/admin/helpers');
const { businessLocalDateSql, businessLocalElapsedMinuteSql } = require('../utils/businessDate');

async function getProductSalesByBusinessDate(executor, range) {
    const saleDate = businessLocalDateSql(paidOrderTimeSql('o'));
    const saleMinute = businessLocalElapsedMinuteSql(paidOrderTimeSql('o'));
    const refundDate = businessLocalDateSql('r.created_at');
    const refundMinute = businessLocalElapsedMinuteSql('r.created_at');
    const [rows] = await executor.query(`
        SELECT business_date, elapsed_minute, product_id, item_name, category_id,
               SUM(sold_qty) AS sold_qty, SUM(returned_qty) AS returned_qty,
               SUM(sold_amount) AS sold_amount, SUM(returned_amount) AS returned_amount
        FROM (
            SELECT ${saleDate} AS business_date, ${saleMinute} AS elapsed_minute,
                   oi.product_id, COALESCE(oi.item_name, p.name, 'Custom Item') AS item_name, p.category_id,
                   SUM(oi.quantity) AS sold_qty, 0 AS returned_qty,
                   SUM(${lineSubtotalAfterOrderDiscount('oi', 'o')} + COALESCE(oi.tax_amount, 0)) AS sold_amount,
                   0 AS returned_amount
            FROM order_items oi
            JOIN orders o ON o.invoice_id=oi.invoice_id
            LEFT JOIN products p ON p.id=oi.product_id
            WHERE ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
              AND o.payment_method NOT IN ('unpaid_table','voided')
              AND oi.parent_item_id IS NULL AND COALESCE(oi.note,'') <> 'Auto-Gratuity'
            GROUP BY ${saleDate}, ${saleMinute}, oi.product_id, COALESCE(oi.item_name, p.name, 'Custom Item'), p.category_id
            UNION ALL
            SELECT ${refundDate} AS business_date, ${refundMinute} AS elapsed_minute,
                   COALESCE(ri.product_id, source_oi.product_id),
                   COALESCE(ri.item_name, source_oi.item_name, p.name, 'Custom Item'), p.category_id,
                   0, SUM(ri.quantity), 0, SUM(ri.line_total)
            FROM refund_items ri
            JOIN refunds r ON r.id=ri.refund_id
            JOIN order_items source_oi ON source_oi.id=ri.order_item_id
            LEFT JOIN products p ON p.id=COALESCE(ri.product_id, source_oi.product_id)
            WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
              AND source_oi.parent_item_id IS NULL AND COALESCE(ri.note,'') <> 'Auto-Gratuity'
            GROUP BY ${refundDate}, ${refundMinute}, COALESCE(ri.product_id, source_oi.product_id),
                     COALESCE(ri.item_name, source_oi.item_name, p.name, 'Custom Item'), p.category_id
        ) events
        GROUP BY business_date, elapsed_minute, product_id, item_name, category_id
    `, [range.start, range.end, range.start, range.end]);

    return rows.map(row => ({
        business_date: row.business_date,
        elapsed_minute: Number(row.elapsed_minute),
        product_id: row.product_id,
        item_name: row.item_name,
        category_id: row.category_id,
        sold_qty: Number(row.sold_qty || 0),
        returned_qty: Number(row.returned_qty || 0),
        sold_amount: roundMoney(row.sold_amount),
        returned_amount: roundMoney(row.returned_amount),
        net_units: Number(row.sold_qty || 0) - Number(row.returned_qty || 0),
        net_sales: roundMoney(Number(row.sold_amount || 0) - Number(row.returned_amount || 0)),
    }));
}
```

Implement period collapse with zero ambiguity:

```js
async function getProductSalesForPeriod(executor, period) {
    const rows = await getProductSalesByBusinessDate(executor, {
        start:period.business_start_at,
        end:period.business_end_at,
    });
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.product_id ?? 'custom'}:${row.item_name}:${row.category_id ?? 'none'}`;
        if (!grouped.has(key)) grouped.set(key, {
            product_id:row.product_id, item_name:row.item_name, category_id:row.category_id,
            sold_qty:0, returned_qty:0, sold_amount:0, returned_amount:0,
        });
        const target = grouped.get(key);
        target.sold_qty += row.sold_qty;
        target.returned_qty += row.returned_qty;
        target.sold_amount += row.sold_amount;
        target.returned_amount += row.returned_amount;
    }
    return [...grouped.values()].map(row => ({
        ...row,
        sold_amount:roundMoney(row.sold_amount),
        returned_amount:roundMoney(row.returned_amount),
        net_units:row.sold_qty - row.returned_qty,
        net_sales:roundMoney(row.sold_amount - row.returned_amount),
    }));
}
```
Export both functions.

- [ ] **Step 4: Replace duplicated query in Sales Details**

At top of `dailySalesDetailsBuilder.js`:

```js
const { getProductSalesForPeriod } = require('./productSalesMetrics');
```

Replace local `productSql` and query call with:

```js
const productEvents = await getProductSalesForPeriod(executor, period);
```

Keep existing category-tree accumulation unchanged; it consumes same row names.

- [ ] **Step 5: Run focused product/report tests**

Run:

```bash
npx vitest run backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/dailyReportsSalesDetails.test.js
```

Expected: PASS. Daily Reports product/category totals unchanged.

- [ ] **Step 6: Commit**

```bash
git add backend/services/productSalesMetrics.js backend/services/dailySalesDetailsBuilder.js backend/tests/integration/productSalesMetrics.test.js
git commit -m "refactor(reports): share product sales event metrics"
```

---

### Task 4: Implement pure comparison, pace, forecast, warning, and product rules

**Files:**
- Create: `backend/services/dashboardAnalytics.js`
- Test: `backend/tests/unit/dashboardAnalytics.test.js`

**Interfaces:**
- Produces: `matchingBusinessDates(businessDate)`.
- Produces: `rollupFinancialTimeline(rows, businessDate, maxElapsedMinute)`.
- Produces: `selectEligibleDays(rows, candidateDates)`.
- Produces: `buildDashboardComparison(current, historical)`.
- Produces: `buildPaceSeries(rows, today, eligibleDates, elapsedMinute)`.
- Produces: `estimateClosingSales(current, historicalFullDays, elapsedMinute)`.
- Produces: `buildAttentionItems(input)`.
- Produces: `buildTopProducts(todayRows, historicalRows, eligibleDates)`.

- [ ] **Step 1: Write failing pure-rule tests**

Create table-driven tests covering every locked threshold:

```js
const {
    matchingBusinessDates, rollupFinancialTimeline, buildDashboardComparison,
    estimateClosingSales, buildAttentionItems, buildTopProducts
} = require('../../services/dashboardAnalytics');

describe('dashboardAnalytics', () => {
    it('returns previous four matching weekdays', () => {
        expect(matchingBusinessDates('2026-07-14')).toEqual([
            '2026-07-07', '2026-06-30', '2026-06-23', '2026-06-16'
        ]);
    });

    it('cuts rollup at same elapsed business minute and nets refund events', () => {
        const rows = [
            { business_date:'2026-07-14', elapsed_minute:60, sales_processed:100, orders:2, cash:100, card:0, refunds_issued:0, refund_cash:0, refund_card:0, refund_count:0, discounts_total:0, void_count:0, void_value:0 },
            { business_date:'2026-07-14', elapsed_minute:120, sales_processed:0, orders:0, cash:0, card:0, refunds_issued:20, refund_cash:20, refund_card:0, refund_count:1, discounts_total:0, void_count:0, void_value:0 }
        ];
        expect(rollupFinancialTimeline(rows, '2026-07-14', 90)).toMatchObject({ sales_collected:100, total_orders:2 });
        expect(rollupFinancialTimeline(rows, '2026-07-14', 120)).toMatchObject({ sales_collected:80, refunds_issued:20, average_ticket:50 });
    });

    it('uses 5 percent pace deadband and 3 point driver margin', () => {
        expect(buildDashboardComparison(
            { sales_collected:120, total_orders:12, average_ticket:10 },
            [{ sales_collected:100, total_orders:10, average_ticket:10 }]
        )).toMatchObject({ pace_state:'ahead', driver:'orders' });
        expect(buildDashboardComparison(
            { sales_collected:103, total_orders:10, average_ticket:10.3 },
            [{ sales_collected:100, total_orders:10, average_ticket:10 }]
        ).pace_state).toBe('typical');
    });

    it('hides forecast until every confidence gate passes', () => {
        const current = { sales_collected:300, total_orders:10 };
        const stable = [
            { sales_collected:250, full_day_sales:500 },
            { sales_collected:300, full_day_sales:600 },
            { sales_collected:200, full_day_sales:400 },
        ];
        expect(estimateClosingSales(current, stable, 180)).toBe(600);
        expect(estimateClosingSales({ ...current, total_orders:4 }, stable, 180)).toBeNull();
        expect(estimateClosingSales(current, stable, 60)).toBeNull();
        expect(estimateClosingSales(current, stable.slice(0, 2), 180)).toBeNull();
    });

    it('requires amount floor, rate floor, and twice-normal rate for warnings', () => {
        const common = { comparisonReady:true, closedShifts:[], lowStockItems:[] };
        expect(buildAttentionItems({
            ...common,
            current:{ sales_processed:100, refunds_issued:4.99, void_value:0, discounts_total:0 },
            typical:{ refund_rate:1, void_rate:0, discount_rate:0 }
        })).toEqual([]);
        expect(buildAttentionItems({
            ...common,
            current:{ sales_processed:100, refunds_issued:10, void_value:0, discounts_total:0 },
            typical:{ refund_rate:2, void_rate:0, discount_rate:0 }
        })[0]).toMatchObject({ type:'refund', destination:'reports-refunds' });
    });

    it('ranks products by net sales and averages only eligible matching days', () => {
        const result = buildTopProducts(
            [{ product_id:1, item_name:'Burger Deluxe', net_sales:120, net_units:6 }],
            [
                { business_date:'2026-07-07', product_id:1, item_name:'Burger Deluxe', net_sales:100 },
                { business_date:'2026-06-30', product_id:1, item_name:'Burger Deluxe', net_sales:80 },
                { business_date:'2026-06-23', product_id:1, item_name:'Burger Deluxe', net_sales:120 },
            ],
            ['2026-07-07','2026-06-30','2026-06-23']
        );
        expect(result[0]).toMatchObject({ name:'Burger Deluxe', net_sales:120, net_units:6, delta_percent:20 });
    });
});
```

- [ ] **Step 2: Run test and confirm red**

Run: `npx vitest run backend/tests/unit/dashboardAnalytics.test.js`

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement constants and rollup/comparison rules**

Use named constants and shared `combineFinancialEvents`:

```js
const { roundMoney } = require('./PosCalculator');
const { combineFinancialEvents } = require('./financialEventMetrics');
const { addBusinessDays } = require('../utils/businessDate');

const LIMITS = Object.freeze({
    requiredDays: 3, paceDeadbandPercent: 5, driverMarginPoints: 3,
    minForecastMinutes: 120, minForecastOrders: 5, minProgressShare: 0.15,
    maxFullDayCoefficientOfVariation: 0.50,
    minAttentionAmount: 5, refundRateFloor: 5, voidRateFloor: 5, discountRateFloor: 10,
});

const mean = values => values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
const percentDelta = (current, typical) => typical > 0 ? ((current - typical) / typical) * 100 : null;

function matchingBusinessDates(date) {
    return [1, 2, 3, 4].map(weeks => addBusinessDays(date, weeks * -7));
}

function rollupFinancialTimeline(rows, businessDate, maxElapsedMinute = 1439) {
    const totals = rows
        .filter(row => row.business_date === businessDate && Number(row.elapsed_minute) <= maxElapsedMinute)
        .reduce((acc, row) => {
            for (const key of Object.keys(acc)) acc[key] += Number(row[key] || 0);
            return acc;
        }, { sales_processed:0, orders:0, cash:0, card:0, refunds_issued:0,
             tax_refunded:0, refund_cash:0, refund_card:0, refund_count:0,
             discounts_total:0, void_count:0, void_value:0 });
    return { ...combineFinancialEvents(totals, totals), discounts_total:roundMoney(totals.discounts_total),
             void_count:totals.void_count, void_value:roundMoney(totals.void_value) };
}
```

Add exact eligibility and comparison functions:

```js
function selectEligibleDays(rows, candidateDates) {
    return candidateDates.filter(date => {
        const full = rollupFinancialTimeline(rows, date, 1439);
        return full.sales_processed > 0 || full.refund_count > 0 || full.void_count > 0;
    });
}

function buildDashboardComparison(current, historical) {
    const typical = {
        sales_today:roundMoney(mean(historical.map(day => day.sales_collected))),
        orders:mean(historical.map(day => day.total_orders)),
        average_check:roundMoney(mean(historical.map(day => day.average_ticket))),
    };
    const values = {
        sales_today:current.sales_collected,
        orders:current.total_orders,
        average_check:current.average_ticket,
    };
    const delta = Object.fromEntries(Object.keys(values).map(key => [key, {
        amount:roundMoney(values[key] - typical[key]),
        percent:percentDelta(values[key], typical[key]),
    }]));
    const salesPercent = delta.sales_today.percent;
    const paceState = salesPercent === null ? 'unavailable'
        : salesPercent > LIMITS.paceDeadbandPercent ? 'ahead'
        : salesPercent < -LIMITS.paceDeadbandPercent ? 'behind' : 'typical';
    const orderChange = delta.orders.percent;
    const checkChange = delta.average_check.percent;
    let driver = 'none';
    if (paceState === 'ahead' || paceState === 'behind') {
        if (orderChange !== null && checkChange !== null) {
            const orderMagnitude = Math.abs(orderChange);
            const checkMagnitude = Math.abs(checkChange);
            driver = orderMagnitude >= checkMagnitude + LIMITS.driverMarginPoints ? 'orders'
                : checkMagnitude >= orderMagnitude + LIMITS.driverMarginPoints ? 'average_check'
                : 'both';
        }
    }
    return { typical, delta, pace_state:paceState, driver };
}
```

- [ ] **Step 4: Implement exact forecast and warning gates**

```js
function estimateClosingSales(current, historicalFullDays, elapsedMinute) {
    if (historicalFullDays.length < LIMITS.requiredDays || elapsedMinute < LIMITS.minForecastMinutes ||
        current.total_orders < LIMITS.minForecastOrders || current.sales_collected <= 0) return null;
    const valid = historicalFullDays.filter(day => day.full_day_sales > 0 && day.sales_collected >= 0);
    if (valid.length < LIMITS.requiredDays) return null;
    const shares = valid.map(day => day.sales_collected / day.full_day_sales);
    const averageShare = mean(shares);
    if (averageShare < LIMITS.minProgressShare) return null;
    const fullTotals = valid.map(day => day.full_day_sales);
    const fullMean = mean(fullTotals);
    const variance = mean(fullTotals.map(value => (value - fullMean) ** 2));
    const cv = fullMean > 0 ? Math.sqrt(variance) / fullMean : Infinity;
    if (cv > LIMITS.maxFullDayCoefficientOfVariation) return null;
    return roundMoney(Math.max(current.sales_collected, current.sales_collected / averageShare));
}

function rates(metrics) {
    return {
        refund_rate: metrics.sales_processed > 0 ? (metrics.refunds_issued / metrics.sales_processed) * 100 : 0,
        void_rate: metrics.sales_processed + metrics.void_value > 0 ?
            (metrics.void_value / (metrics.sales_processed + metrics.void_value)) * 100 : 0,
        discount_rate: metrics.sales_processed + metrics.discounts_total > 0 ?
            (metrics.discounts_total / (metrics.sales_processed + metrics.discounts_total)) * 100 : 0,
    };
}
```

Implement attention output exactly:

```js
function buildTypicalAttentionRates(days) {
    return {
        refund_rate:mean(days.map(day => rates(day).refund_rate)),
        void_rate:mean(days.map(day => rates(day).void_rate)),
        discount_rate:mean(days.map(day => rates(day).discount_rate)),
    };
}

function buildAttentionItems({ current, typical, comparisonReady, closedShifts, lowStockItems }) {
    const items = [];
    if (comparisonReady && typical) {
        const currentRates = rates(current);
        const rules = [
            { type:'refund', value:current.refunds_issued, rate:currentRates.refund_rate, typical:typical.refund_rate, floor:LIMITS.refundRateFloor, message_key:'refund_rate', destination:'reports-refunds' },
            { type:'void', value:current.void_value, rate:currentRates.void_rate, typical:typical.void_rate, floor:LIMITS.voidRateFloor, message_key:'void_rate', destination:'reports-refunds' },
            { type:'discount', value:current.discounts_total, rate:currentRates.discount_rate, typical:typical.discount_rate, floor:LIMITS.discountRateFloor, message_key:'discount_rate', destination:'reports-summary' },
        ];
        for (const rule of rules) {
            if (rule.value >= LIMITS.minAttentionAmount && rule.rate >= rule.floor && rule.rate >= rule.typical * 2) {
                items.push({ type:rule.type, severity:'warning', message_key:rule.message_key,
                    params:{ amount:roundMoney(rule.value), rate:roundMoney(rule.rate) }, destination:rule.destination });
            }
        }
    }
    for (const shift of closedShifts) {
        const variance = roundMoney(shift.variance);
        if (Math.abs(variance) >= 0.01) items.push({
            type:'register', severity:'warning', message_key:'register_variance',
            params:{ shift_id:shift.shift_id, amount:Math.abs(variance), direction:variance < 0 ? 'short' : 'over' },
            destination:'shifts',
        });
    }
    if (lowStockItems.length) items.push({
        type:'stock', severity:'warning', message_key:'low_stock',
        params:{ count:lowStockItems.length }, destination:'inventory',
    });
    return items;
}
```

- [ ] **Step 5: Implement pace and top-products output**

Implement pace and product output:

```js
function buildPaceSeries(rows, today, eligibleDates, elapsedMinute) {
    const cutoffs = [];
    for (let cutoff = 59; cutoff < elapsedMinute; cutoff += 60) cutoffs.push(cutoff);
    if (!cutoffs.length || cutoffs.at(-1) !== elapsedMinute) cutoffs.push(elapsedMinute);
    return { points:cutoffs.map(cutoff => ({
        elapsed_minute:cutoff,
        today:rollupFinancialTimeline(rows, today, cutoff).sales_collected,
        typical:eligibleDates.length >= LIMITS.requiredDays
            ? roundMoney(mean(eligibleDates.map(date => rollupFinancialTimeline(rows, date, cutoff).sales_collected)))
            : null,
    })) };
}

function buildTopProducts(todayRows, historicalRows, eligibleDates) {
    const groupedToday = new Map();
    for (const row of todayRows) {
        const key = `${row.product_id ?? 'custom'}:${row.item_name}`;
        const item = groupedToday.get(key) || { product_id:row.product_id, name:row.item_name, net_sales:0, net_units:0 };
        item.net_sales += Number(row.net_sales || 0);
        item.net_units += Number(row.net_units || 0);
        groupedToday.set(key, item);
    }
    return [...groupedToday.values()]
        .sort((a, b) => b.net_sales - a.net_sales)
        .slice(0, 5)
        .map(item => {
            const dayValues = eligibleDates.map(date => historicalRows
                .filter(row => row.business_date === date && row.product_id === item.product_id && row.item_name === item.name)
                .reduce((sum, row) => sum + Number(row.net_sales || 0), 0));
            const typical = mean(dayValues);
            return {
                ...item,
                net_sales:roundMoney(item.net_sales),
                delta_percent:eligibleDates.length >= LIMITS.requiredDays && typical > 0
                    ? roundMoney(percentDelta(item.net_sales, typical)) : null,
            };
        });
}
```

Export all public functions after implementations:

```js
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
```

- [ ] **Step 6: Run pure tests**

Run: `npx vitest run backend/tests/unit/dashboardAnalytics.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/services/dashboardAnalytics.js backend/tests/unit/dashboardAnalytics.test.js
git commit -m "feat(dashboard): add deterministic comparison and forecast rules"
```

---

### Task 5: Build complete dashboard payload from bounded data

**Files:**
- Create: `backend/services/dashboardDataBuilder.js`
- Test: `backend/tests/integration/dashboardDataBuilder.test.js`

**Interfaces:**
- Consumes: `getFinancialEventTimeline`, `getProductSalesByBusinessDate`, and every pure function from Task 4.
- Produces: `buildDashboardData(executor, { now }): Promise<DashboardPayload>`.
- Produces payload fields exactly: `business_date`, `as_of`, `refreshed_at`, `history`, `headline`, `comparison`, `pace`, `tables`, `attention`, `products`, `payments`.

- [ ] **Step 1: Write failing current-day payload test**

Use injected UTC time so business-day cutoffs never depend on test clock:

```js
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { insertPaidOrder, insertShift } = require('../helpers/fixtures');
const { buildDashboardData } = require('../../services/dashboardDataBuilder');

describe('buildDashboardData', () => {
    beforeEach(seedDatabase);

    async function seedMatchingTuesday(date, sameTimeTotal, fullDayTotal) {
        await insertPaidOrder(pool, {
            total:sameTimeTotal, subtotal:sameTimeTotal, tax:0,
            cash_amount:sameTimeTotal, payment_method:'cash',
            invoice_issued_at:`${date} 06:00:00`, created_at:`${date} 06:00:00`
        });
        if (fullDayTotal > sameTimeTotal) {
            const late = fullDayTotal - sameTimeTotal;
            await insertPaidOrder(pool, {
                total:late, subtotal:late, tax:0, cash_amount:late, payment_method:'cash',
                invoice_issued_at:`${date} 18:00:00`, created_at:`${date} 18:00:00`
            });
        }
    }

    it('builds same-time comparison from at least three operating Tuesdays', async () => {
        for (const date of ['2026-07-07','2026-06-30','2026-06-23']) {
            await seedMatchingTuesday(date, 100, 200);
        }
        for (let index=0; index<5; index += 1) {
            await insertPaidOrder(pool, {
                total:24, subtotal:24, tax:0, cash_amount:24, payment_method:'cash',
                invoice_issued_at:`2026-07-14 0${4 + index}:00:00`,
                created_at:`2026-07-14 0${4 + index}:00:00`
            });
        }

        const data = await buildDashboardData(pool, { now:new Date('2026-07-14T09:00:00Z') });
        expect(data.business_date).toBe('2026-07-14');
        expect(data.history).toEqual({ eligible_days:3, comparison_ready:true });
        expect(data.headline).toMatchObject({ sales_today:120, orders:5, average_check:24, estimated_close:240 });
        expect(data.comparison).toMatchObject({ pace_state:'ahead' });
        expect(data.pace.points.at(-1).elapsed_minute).toBe(360);
    });
});
```

- [ ] **Step 2: Write failing tables, shift, and feature-gate tests**

Append:

```js
it('deduplicates merged-table order value and reports longest open table', async () => {
    const invoiceId = await insertPaidOrder(pool, {
        table_id:SEED.table.id, payment_method:'unpaid_table',
        total:35, subtotal:35, cash_amount:0, card_amount:0,
        invoice_issued_at:null, created_at:'2026-07-14 04:00:00'
    });
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id IN (?,?)",
        [invoiceId, SEED.table.id, SEED.table2.id]);
    await pool.query('UPDATE restaurant_tables SET parent_table_id=? WHERE id=?',
        [SEED.table.id, SEED.table2.id]);

    const data = await buildDashboardData(pool, { now:new Date('2026-07-14T09:00:00Z') });
    expect(data.tables).toMatchObject({ occupied_count:2, open_unpaid_value:35 });
    expect(data.tables.longest_open).toMatchObject({ table_number:'1' });
});

it('omits tables and low-stock attention when features are disabled', async () => {
    await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key IN ('tables_enabled','stock_enabled')");
    const data = await buildDashboardData(pool, { now:new Date('2026-07-14T09:00:00Z') });
    expect(data.tables).toBeNull();
    expect(data.attention.some(item => item.type === 'stock')).toBe(false);
});

it('reports stored closed-shift variance without recomputing drawer totals', async () => {
    const shiftId = await insertShift(pool, {
        status:'closed', opened_at:'2026-07-14 03:30:00', closed_at:'2026-07-14 08:00:00',
        expected_cash:100, actual_cash:96.5
    });
    const data = await buildDashboardData(pool, { now:new Date('2026-07-14T09:00:00Z') });
    expect(data.attention).toContainEqual(expect.objectContaining({
        type:'register', params:{ shift_id:shiftId, amount:3.5, direction:'short' }
    }));
});
```

- [ ] **Step 3: Run builder tests and confirm red**

Run: `npx vitest run backend/tests/integration/dashboardDataBuilder.test.js`

Expected: FAIL because builder does not exist.

- [ ] **Step 4: Implement settings and operational readers**

Create private helpers in `dashboardDataBuilder.js`:

```js
const { roundMoney } = require('./PosCalculator');
const { getFinancialEventTimeline } = require('./financialEventMetrics');
const { getProductSalesByBusinessDate } = require('./productSalesMetrics');
const { getBusinessDate, getBusinessDateRange, formatDbTimestamp } = require('../utils/businessDate');
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
    return rows.map(row => ({ shift_id:Number(row.shift_id), variance:Number(row.variance) }));
}

async function readTableSnapshot(executor, now) {
    const [[countRow], [orders]] = await Promise.all([
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
    const openOrders = orders;
    const oldest = openOrders[0] || null;
    const oldestDate = oldest
        ? (oldest.created_at instanceof Date
            ? oldest.created_at
            : new Date(`${String(oldest.created_at).replace(' ', 'T')}Z`))
        : null;
    return {
        occupied_count:Number(countRow[0]?.occupied_count || 0),
        open_unpaid_value:roundMoney(openOrders.reduce((sum, order) => sum + Number(order.total || 0), 0)),
        longest_open:oldest ? {
            invoice_id:Number(oldest.invoice_id), table_number:String(oldest.table_number), opened_at:oldest.created_at,
            elapsed_minutes:Math.max(0, Math.floor((now.getTime() - oldestDate.getTime()) / 60000)),
        } : null,
    };
}

async function readLowStock(executor, threshold) {
    const [rows] = await executor.query(`
        SELECT id, name, stock FROM products
        WHERE is_active=1 AND stock IS NOT NULL AND stock <= ?
        ORDER BY stock ASC, name ASC
    `, [threshold]);
    return rows;
}
```

- [ ] **Step 5: Implement orchestration and exact payload**

```js
async function buildDashboardData(executor, { now = new Date() } = {}) {
    const businessDate = getBusinessDate(now);
    const todayRange = getBusinessDateRange(businessDate);
    const todayStart = new Date(`${todayRange.start.replace(' ', 'T')}Z`);
    const elapsedMinute = Math.max(0, Math.min(1439, Math.floor((now.getTime() - todayStart.getTime()) / 60000)));
    const asOf = formatDbTimestamp(now);
    const candidateDates = matchingBusinessDates(businessDate);
    const analysisRange = getBusinessDateRange(candidateDates.at(-1), businessDate);

    const settings = await readDashboardSettings(executor);
    const tablesEnabled = settings.tables_enabled === '1';
    const stockEnabled = settings.stock_enabled === '1';

    const [timeline, productRows, closedShifts, tables, lowStockItems] = await Promise.all([
        getFinancialEventTimeline(executor, analysisRange),
        getProductSalesByBusinessDate(executor, analysisRange),
        readClosedShiftVariances(executor, todayRange, asOf),
        tablesEnabled ? readTableSnapshot(executor, now) : Promise.resolve(null),
        stockEnabled ? readLowStock(executor, Number(settings.low_stock_threshold || 3)) : Promise.resolve([]),
    ]);

    const current = rollupFinancialTimeline(timeline, businessDate, elapsedMinute);
    const operatingDates = selectEligibleDays(timeline, candidateDates);
    const comparisonReady = operatingDates.length >= 3;
    const sameTimeHistory = operatingDates.map(date => rollupFinancialTimeline(timeline, date, elapsedMinute));
    const comparison = comparisonReady ? buildDashboardComparison(current, sameTimeHistory) : {
        typical:null, delta:null, pace_state:'unavailable', driver:'none'
    };
    const historicalFullDays = operatingDates.map(date => ({
        sales_collected:rollupFinancialTimeline(timeline, date, elapsedMinute).sales_collected,
        full_day_sales:rollupFinancialTimeline(timeline, date, 1439).sales_collected,
    }));
    const estimate = comparisonReady ? estimateClosingSales(current, historicalFullDays, elapsedMinute) : null;
    const typicalForAttention = comparisonReady ? buildTypicalAttentionRates(sameTimeHistory) : null;
    const comparableProductRows = productRows.filter(row => row.elapsed_minute <= elapsedMinute);
    const todayProducts = comparableProductRows.filter(row => row.business_date === businessDate);

    const payments = [
        { method:'cash', amount:current.cash_collected },
        { method:'card', amount:current.card_collected },
    ].filter(item => item.amount > 0);
    const paymentTotal = payments.reduce((sum, item) => sum + item.amount, 0);
    payments.forEach(item => { item.share = paymentTotal > 0 ? roundMoney((item.amount / paymentTotal) * 100) : 0; });

    return {
        business_date:businessDate,
        as_of:asOf,
        refreshed_at:now.toISOString(),
        history:{ eligible_days:operatingDates.length, comparison_ready:comparisonReady },
        headline:{
            sales_today:current.sales_collected,
            orders:current.total_orders,
            average_check:current.average_ticket,
            estimated_close:estimate,
        },
        comparison,
        pace:buildPaceSeries(timeline, businessDate, comparisonReady ? operatingDates : [], elapsedMinute),
        tables:tablesEnabled ? tables : null,
        attention:buildAttentionItems({
            current, typical:typicalForAttention, comparisonReady,
            closedShifts, lowStockItems,
        }),
        products:buildTopProducts(todayProducts, comparableProductRows, comparisonReady ? operatingDates : []),
        payments,
    };
}

module.exports = { buildDashboardData };
```

- [ ] **Step 6: Run builder and pure analytics tests**

Run:

```bash
npx vitest run backend/tests/unit/dashboardAnalytics.test.js backend/tests/integration/dashboardDataBuilder.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/services/dashboardDataBuilder.js backend/services/dashboardAnalytics.js backend/tests/integration/dashboardDataBuilder.test.js backend/tests/unit/dashboardAnalytics.test.js
git commit -m "feat(dashboard): build current-day operating payload"
```

---

### Task 6: Replace dashboard route and make cache rollover-safe

**Files:**
- Modify: `backend/config/cache.js`
- Replace: `backend/routes/admin/dashboard.js`
- Rewrite: `backend/tests/integration/dashboard.test.js`

**Interfaces:**
- Consumes: `buildDashboardData(pool, { now })`.
- Produces: `GET /api/admin/dashboard` new contract only.
- Produces: `getDashboardAnalyticsCache(key)` and `setDashboardAnalyticsCache(key, payload, expiresAt)`.

- [ ] **Step 1: Rewrite API test for new contract**

Keep existing login/cache setup. Replace legacy `finance`, `trend`, `topItems`, and
chart-array assertions with:

```js
it('returns presentation-neutral current-day payload and no legacy dashboard fields', async () => {
    await seedOrderWithRefund({ orderTotal:100, refundAmt:30, method:'cash' });
    const data = await fetchDashboard();
    expect(data).toMatchObject({
        success:true,
        history:expect.objectContaining({ eligible_days:expect.any(Number), comparison_ready:expect.any(Boolean) }),
        headline:expect.objectContaining({ sales_today:70, orders:1, average_check:100 }),
        pace:expect.objectContaining({ points:expect.any(Array) }),
        attention:expect.any(Array), products:expect.any(Array), payments:expect.any(Array),
    });
    expect(data).not.toHaveProperty('finance');
    expect(data).not.toHaveProperty('trend');
    expect(data).not.toHaveProperty('topItems');
});

it('keeps old-order refunds on refund day instead of restating original sale day', async () => {
    const { invoiceId } = await seedOrderWithRefund({ orderTotal:100, refundAmt:0 });
    const today = getBusinessDate();
    const range = getBusinessDateRange(today);
    await pool.query('UPDATE orders SET invoice_issued_at=DATE_SUB(?, INTERVAL 7 DAY), created_at=DATE_SUB(?, INTERVAL 7 DAY) WHERE invoice_id=?',
        [range.start, range.start, invoiceId]);
    await pool.query(`
        INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, refund_method, user_id, created_at)
        VALUES ('refund', ?, 'order', 20, 0, 20, 'cash', 1, ?)
    `, [invoiceId, range.start]);
    invalidateDashboardCache();
    const data = await fetchDashboard();
    expect(data.headline.sales_today).toBe(-20);
    expect(data.headline.orders).toBe(0);
});

it('returns full product names and net values', async () => {
    await seedOrderWithRefund({ orderTotal:100, refundAmt:30 });
    const data = await fetchDashboard();
    expect(data.products[0]).toMatchObject({ name:'Test Burger', net_units:1 });
    expect(data.products[0].name).not.toContain('...');
});
```

Retain/adapt existing tests for `invoice_issued_at`, partial refund, tax/discount/void
correctness, and Amman business-day boundaries. Assertions move to `headline`,
`attention`, `payments`, `products`, and `pace`.

- [ ] **Step 2: Add cache-key regression test**

```js
it('does not reuse cache after minute bucket or business-date rollover', async () => {
    const cache = require('../../config/cache');
    cache.setDashboardAnalyticsCache('2026-07-14:100', { marker:1 }, Date.now() + 30000);
    expect(cache.getDashboardAnalyticsCache('2026-07-14:100').payload.marker).toBe(1);
    expect(cache.getDashboardAnalyticsCache('2026-07-14:101')).toBeNull();
    expect(cache.getDashboardAnalyticsCache('2026-07-15:100')).toBeNull();
});
```

- [ ] **Step 3: Run API test and confirm red**

Run: `npx vitest run backend/tests/integration/dashboard.test.js`

Expected: FAIL on legacy payload and old cache signature.

- [ ] **Step 4: Key cache by business date and absolute minute**

Change cache functions:

```js
getDashboardAnalyticsCache: (key) => {
    const cached = cacheStore.dashboardAnalyticsCache;
    return cached && cached.key === key ? cached : null;
},
setDashboardAnalyticsCache: (key, payload, expiresAt) => {
    cacheStore.dashboardAnalyticsCache = { key, payload, expiresAt };
},
```

Keep `invalidateDashboardCache()` unchanged.

- [ ] **Step 5: Replace route with thin builder call**

Keep `/alerts` behavior unchanged for existing consumers. Replace only `/dashboard`:

```js
const { getBusinessDate } = require('../../utils/businessDate');
const { buildDashboardData } = require('../../services/dashboardDataBuilder');
const DASHBOARD_ANALYTICS_CACHE_TTL_MS = 30 * 1000;

router.get('/dashboard', async (req, res) => {
    try {
        const now = new Date();
        const cacheKey = `${getBusinessDate(now)}:${Math.floor(now.getTime() / 60000)}`;
        const cached = getDashboardAnalyticsCache(cacheKey);
        if (cached && cached.expiresAt > now.getTime()) return sendSuccess(res, cached.payload);

        const payload = await buildDashboardData(pool, { now });
        setDashboardAnalyticsCache(cacheKey, payload, now.getTime() + DASHBOARD_ANALYTICS_CACHE_TTL_MS);
        return sendSuccess(res, payload);
    } catch (error) {
        logAdminRouteError(req, error);
        return sendError(res, 500, 'Dashboard data fetch failed.');
    }
});
```

Delete route-local prior-day, 14-day trend, top-item truncation, and doughnut-array
construction.

- [ ] **Step 6: Run dashboard API suite**

Run:

```bash
npx vitest run backend/tests/unit/dashboardAnalytics.test.js backend/tests/integration/dashboardFinancialTimeline.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/dashboardDataBuilder.test.js backend/tests/integration/dashboard.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/config/cache.js backend/routes/admin/dashboard.js backend/tests/integration/dashboard.test.js
git commit -m "feat(api): serve redesigned dashboard contract"
```

---

### Task 7: Add typed frontend contract, natural copy, and Latin-digit formatting

**Files:**
- Create: `src/admin/pages/dashboard/dashboardTypes.ts`
- Create: `src/admin/utils/dashboardPresentation.ts`
- Test: `src/admin/utils/__tests__/dashboardPresentation.spec.js`
- Modify: `src/admin/utils/reportFormatting.js`
- Test: `src/admin/utils/__tests__/reportFormatting.spec.js`
- Modify: `assets/js/admin/i18n.js`
- Test: `src/admin/pages/__tests__/dashboardLocalization.spec.js`

**Interfaces:**
- Produces: `DashboardPayload` and child data types.
- Produces: `buildDashboardNarrative(payload, translate)`.
- Produces: `attentionMessage(item, translate)`.
- Produces: `formatElapsedMinutes(minutes, translate)`.
- Produces: `formatReportBusinessDate`, `formatReportBusinessTime`, `formatReportWeekday`.

- [ ] **Step 1: Define exact API types**

Create `dashboardTypes.ts`:

```ts
export type PaceState = 'ahead' | 'behind' | 'typical' | 'unavailable'
export type DashboardDriver = 'orders' | 'average_check' | 'both' | 'none'
export type DashboardDestination = 'reports-summary' | 'reports-sales' | 'reports-refunds' | 'shifts' | 'inventory' | 'tablemap'

export interface DashboardDelta {
  amount: number
  percent: number | null
}

export interface PacePoint {
  elapsed_minute: number
  today: number
  typical: number | null
}

export interface DashboardAttentionItem {
  type: 'refund' | 'void' | 'discount' | 'register' | 'stock'
  severity: 'warning' | 'danger'
  message_key: string
  params: Record<string, string | number>
  destination: DashboardDestination
}

export interface DashboardProduct {
  product_id: number | null
  name: string
  net_sales: number
  net_units: number
  delta_percent: number | null
}

export interface DashboardPayload {
  success: boolean
  business_date: string
  as_of: string
  refreshed_at: string
  history: { eligible_days: number; comparison_ready: boolean }
  headline: {
    sales_today: number
    orders: number
    average_check: number
    estimated_close: number | null
  }
  comparison: {
    typical: null | { sales_today: number; orders: number; average_check: number }
    delta: null | {
      sales_today: DashboardDelta
      orders: DashboardDelta
      average_check: DashboardDelta
    }
    pace_state: PaceState
    driver: DashboardDriver
  }
  pace: { points: PacePoint[] }
  tables: null | {
    occupied_count: number
    open_unpaid_value: number
    longest_open: null | { invoice_id: number; table_number: string; opened_at: string; elapsed_minutes: number }
  }
  attention: DashboardAttentionItem[]
  products: DashboardProduct[]
  payments: Array<{ method: 'cash' | 'card'; amount: number; share: number }>
}
```

Backend always returns `elapsed_minutes`, computed from injected builder `now - opened_at`;
Vue never recalculates it from client clock.

- [ ] **Step 2: Write failing presentation tests**

```js
import { describe, expect, it } from 'vitest';
import { buildDashboardNarrative, attentionMessage, formatElapsedMinutes } from '../dashboardPresentation.ts';

const tr = value => value;
const payload = {
  business_date:'2026-07-14',
  headline:{ sales_today:120, orders:12, average_check:10, estimated_close:240 },
  history:{ eligible_days:4, comparison_ready:true },
  comparison:{
    pace_state:'ahead', driver:'orders',
    delta:{ sales_today:{ amount:20, percent:20 }, orders:{ amount:2, percent:20 }, average_check:{ amount:0, percent:0 } }
  }
};

describe('dashboardPresentation', () => {
  it('builds fixed natural narrative from reason codes', () => {
    expect(buildDashboardNarrative(payload, tr)).toBe(
      'Sales are 20% ahead of a typical Tuesday. More orders caused most of the increase.'
    );
  });

  it('never claims comparison when history is sparse', () => {
    expect(buildDashboardNarrative({ ...payload, history:{ eligible_days:2, comparison_ready:false } }, tr))
      .toBe('Not enough matching days for a useful comparison yet.');
  });

  it('uses calm empty-day copy', () => {
    expect(buildDashboardNarrative({ ...payload, headline:{ ...payload.headline, sales_today:0, orders:0 } }, tr))
      .toBe('No sales yet today.');
  });

  it('formats typed attention objects without backend prose', () => {
    expect(attentionMessage({ message_key:'register_variance', params:{ amount:3.5, direction:'short' } }, tr))
      .toBe('One closed register is 3.50 JD short.');
  });

  it('formats elapsed durations without seconds', () => {
    expect(formatElapsedMinutes(135, tr)).toBe('2 hr 15 min');
  });
});
```

- [ ] **Step 3: Extend Latin-digit formatter tests**

Append to `reportFormatting.spec.js`:

```js
it('uses Latin digits for Arabic dashboard dates and times', () => {
    currentLanguage.value = 'ar';
    const values = [
        formatReportBusinessDate('2026-07-14'),
        formatReportBusinessTime('2026-07-14T09:05:00.000Z'),
    ];
    for (const value of values) {
        expect(value).toMatch(/[0-9]/);
        expect(value).not.toMatch(/[٠-٩]/);
    }
    expect(formatReportWeekday('2026-07-14')).toBe('الثلاثاء');
});
```

Add imports for three new functions.

- [ ] **Step 4: Implement date/time/weekday formatting**

In `reportFormatting.js`, import existing business time formatter:

```js
import { formatBusinessTimeShort } from '../../utils/businessDate.js';
```

Add cached `Intl.DateTimeFormat` helpers and exports:

```js
const dateFormatters = new Map();

function dateFormatter(options) {
    const locale = reportLocale();
    const formatterOptions = { ...options, numberingSystem:'latn', timeZone:'UTC' };
    const key = `${locale}:${JSON.stringify(formatterOptions)}`;
    if (!dateFormatters.has(key)) dateFormatters.set(key, new Intl.DateTimeFormat(locale, formatterOptions));
    return dateFormatters.get(key);
}

function businessDateAsUtcNoon(value) {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12));
}

export function formatReportBusinessDate(value) {
    return dateFormatter({ year:'numeric', month:'short', day:'numeric' }).format(businessDateAsUtcNoon(value));
}

export function formatReportWeekday(value) {
    return dateFormatter({ weekday:'long' }).format(businessDateAsUtcNoon(value));
}

export function formatReportBusinessTime(value) {
    const [clock, period = ''] = formatBusinessTimeShort(value).split(' ');
    return `${clock} ${t(period)}`.trim();
}
```

- [ ] **Step 5: Implement deterministic presentation helper**

```ts
import { t } from '../../../assets/js/admin/i18n.js'
import { formatReportMoney, formatReportNumber, formatReportWeekday } from './reportFormatting.js'
import type { DashboardAttentionItem, DashboardPayload } from '../pages/dashboard/dashboardTypes'

type Translate = (value: string) => string

function fill(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template
  )
}

export function buildDashboardNarrative(payload: DashboardPayload, translate: Translate = t) {
  if (payload.headline.orders === 0 && payload.headline.sales_today === 0) return translate('No sales yet today.')
  if (!payload.history.comparison_ready || !payload.comparison.delta) {
    return translate('Not enough matching days for a useful comparison yet.')
  }
  const weekday = formatReportWeekday(payload.business_date)
  const percent = formatReportNumber(Math.abs(payload.comparison.delta.sales_today.percent || 0), { maximumFractionDigits:0 })
  const introKey = payload.comparison.pace_state === 'ahead'
    ? 'Sales are {percent}% ahead of a typical {weekday}.'
    : payload.comparison.pace_state === 'behind'
      ? 'Sales are {percent}% behind a typical {weekday}.'
      : 'Sales are close to a typical {weekday}.'
  const intro = fill(translate(introKey), { percent, weekday })
  const causeKeys = {
    ahead:{ orders:'More orders caused most of the increase.', average_check:'Higher average checks caused most of the increase.', both:'Order count and average check both contributed.', none:'' },
    behind:{ orders:'Fewer orders caused most of the difference.', average_check:'Lower average checks caused most of the difference.', both:'Order count and average check both contributed.', none:'' },
    typical:{ orders:'', average_check:'', both:'', none:'' },
    unavailable:{ orders:'', average_check:'', both:'', none:'' },
  } as const
  const cause = causeKeys[payload.comparison.pace_state][payload.comparison.driver]
  return cause ? `${intro} ${translate(cause)}` : intro
}

export function attentionMessage(item: Pick<DashboardAttentionItem, 'message_key' | 'params'>, translate: Translate = t) {
  const templates: Record<string, string> = {
    refund_rate:'Refunds are higher than usual: {amount}.',
    void_rate:'Voids are higher than usual: {amount}.',
    discount_rate:'Discounts are higher than usual: {amount}.',
    register_variance:'One closed register is {amount} {direction}.',
    low_stock:'{count} products are low in stock.',
  }
  const direction = item.params.direction === 'short' ? translate('short') : translate('over')
  return fill(translate(templates[item.message_key] || item.message_key), {
    ...item.params,
    amount:item.params.amount === undefined ? '' : formatReportMoney(item.params.amount),
    direction,
  })
}

export function formatElapsedMinutes(value: number, translate: Translate = t) {
  const minutes = Math.max(0, Math.floor(Number(value) || 0))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${formatReportNumber(rest)} ${translate('min')}`
  if (rest === 0) return `${formatReportNumber(hours)} ${translate('hr')}`
  return `${formatReportNumber(hours)} ${translate('hr')} ${formatReportNumber(rest)} ${translate('min')}`
}
```

- [ ] **Step 6: Add natural English keys and Arabic values**

Add missing keys below to Arabic dictionary. When key already exists (`Today`, `Orders`,
payment methods), keep one entry and update its value only if needed; never add duplicate
object keys. English remains key text by current i18n design:

```js
'Sales today': 'مبيعات اليوم',
'Current business day': 'يوم العمل الحالي',
'Last updated': 'آخر تحديث',
'Refresh dashboard': 'تحديث لوحة التحكم',
'Loading dashboard': 'جارٍ تحميل لوحة التحكم',
'Orders': 'الطلبات',
'Average check': 'متوسط الفاتورة',
'Estimated close': 'التقدير عند الإغلاق',
'At this pace': 'حسب الوتيرة الحالية',
'Needs attention': 'يحتاج متابعة',
'Tables right now': 'الطاولات الآن',
'Occupied tables': 'طاولات مشغولة',
'Open unpaid value': 'قيمة الطلبات المفتوحة',
'Longest open': 'الأطول انتظاراً',
'What sold': 'الأصناف المباعة',
'Net sales': 'صافي المبيعات',
'Units': 'الكمية',
'Cash and card': 'النقد والبطاقة',
'Today': 'اليوم',
'Typical day': 'اليوم المعتاد',
'No sales yet today.': 'لا توجد مبيعات حتى الآن اليوم.',
'Not enough matching days for a useful comparison yet.': 'لا توجد أيام مشابهة كافية للمقارنة بعد.',
'Sales are {percent}% ahead of a typical {weekday}.': 'المبيعات أعلى بنسبة {percent}% من المعتاد في أيام {weekday}.',
'Sales are {percent}% behind a typical {weekday}.': 'المبيعات أقل بنسبة {percent}% من المعتاد في أيام {weekday}.',
'Sales are close to a typical {weekday}.': 'المبيعات قريبة من المعتاد في أيام {weekday}.',
'More orders caused most of the increase.': 'الزيادة جاءت أساساً من عدد طلبات أكبر.',
'Higher average checks caused most of the increase.': 'الزيادة جاءت أساساً من ارتفاع متوسط الفاتورة.',
'Fewer orders caused most of the difference.': 'الانخفاض جاء أساساً من عدد طلبات أقل.',
'Lower average checks caused most of the difference.': 'الانخفاض جاء أساساً من انخفاض متوسط الفاتورة.',
'Order count and average check both contributed.': 'ساهم عدد الطلبات ومتوسط الفاتورة معاً في هذا الفرق.',
'Refunds are higher than usual: {amount}.': 'المرتجعات أعلى من المعتاد: {amount}.',
'Voids are higher than usual: {amount}.': 'الإلغاءات أعلى من المعتاد: {amount}.',
'Discounts are higher than usual: {amount}.': 'الخصومات أعلى من المعتاد: {amount}.',
'One closed register is {amount} {direction}.': 'فرق صندوق مغلق واحد هو {amount} {direction}.',
'{count} products are low in stock.': 'هناك {count} أصناف منخفضة المخزون.',
'short': 'عجز',
'over': 'زيادة',
'hr': 'س',
'min': 'د',
'AM': 'ص',
'PM': 'م',
'No products sold yet.': 'لم تُبع أصناف بعد.',
'No payments yet.': 'لا توجد مدفوعات بعد.',
'Dashboard could not be loaded.': 'تعذر تحميل لوحة التحكم.',
'Showing last successful update.': 'يتم عرض آخر تحديث ناجح.',
'Try again': 'حاول مرة أخرى',
```

- [ ] **Step 7: Add localization and banned-copy contract test**

```js
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Dashboard localization contract', () => {
  const componentDir = path.resolve(__dirname, '../../components/dashboard');
  const files = fs.existsSync(componentDir)
    ? fs.readdirSync(componentDir).filter(name => name.endsWith('.vue')).map(name => path.join(componentDir, name))
    : [];
  const sources = [path.resolve(__dirname, '../Dashboard.vue'), ...files]
    .filter(fs.existsSync).map(file => fs.readFileSync(file, 'utf8')).join('\n');
  const dictionary = fs.readFileSync(path.resolve(__dirname, '../../../../assets/js/admin/i18n.js'), 'utf8');

  it('has Arabic entries for static dashboard translation keys', () => {
    const keys = [...sources.matchAll(/\$t\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]);
    const arabicKeys = new Set([...dictionary.matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]));
    expect([...new Set(keys)].filter(key => !arabicKeys.has(key))).toEqual([]);
  });

  it('contains no AI-slop dashboard titles', () => {
    for (const banned of ['Business Pulse','Performance Intelligence','Live Floor','Revenue Engine']) {
      expect(sources).not.toContain(banned);
    }
  });

  it('covers dynamic narrative and attention templates', () => {
    const required = [
      'Sales are {percent}% ahead of a typical {weekday}.',
      'Sales are {percent}% behind a typical {weekday}.',
      'Sales are close to a typical {weekday}.',
      'More orders caused most of the increase.',
      'Higher average checks caused most of the increase.',
      'Fewer orders caused most of the difference.',
      'Lower average checks caused most of the difference.',
      'Refunds are higher than usual: {amount}.',
      'Voids are higher than usual: {amount}.',
      'Discounts are higher than usual: {amount}.',
      'One closed register is {amount} {direction}.',
      '{count} products are low in stock.',
    ];
    const arabicKeys = new Set([...dictionary.matchAll(/^\s*'([^']+)'\s*:/gm)].map(match => match[1]));
    expect(required.filter(key => !arabicKeys.has(key))).toEqual([]);
  });
});
```

- [ ] **Step 8: Run frontend utility/localization tests**

Run:

```bash
npx vitest run src/admin/utils/__tests__/reportFormatting.spec.js src/admin/utils/__tests__/dashboardPresentation.spec.js src/admin/pages/__tests__/dashboardLocalization.spec.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/admin/pages/dashboard/dashboardTypes.ts src/admin/utils/dashboardPresentation.ts src/admin/utils/__tests__/dashboardPresentation.spec.js src/admin/utils/reportFormatting.js src/admin/utils/__tests__/reportFormatting.spec.js assets/js/admin/i18n.js src/admin/pages/__tests__/dashboardLocalization.spec.js
git commit -m "feat(dashboard): add bilingual presentation contract"
```

---

### Task 8: Add lifecycle-safe dashboard data controller

**Files:**
- Create: `src/admin/composables/useDashboardData.ts`
- Test: `src/admin/composables/__tests__/useDashboardData.spec.js`

**Interfaces:**
- Produces: `createDashboardDataController(dependencies)` for deterministic tests.
- Produces: `useDashboardData()` Vue lifecycle wrapper.
- State: `data`, `isLoading`, `isRefreshing`, `error`, `staleError`.
- Methods: `load`, `activate`, `deactivate`, `destroy`, `handleRealtime`.

- [ ] **Step 1: Write failing controller tests**

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboardDataController } from '../useDashboardData.ts';

describe('dashboard data controller', () => {
  beforeEach(() => vi.useFakeTimers());

  it('retains last good payload when silent refresh fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok:true, json:async () => ({ success:true, headline:{ sales_today:10 } }) })
      .mockResolvedValueOnce({ ok:false, json:async () => ({ message:'offline' }) });
    const controller = createDashboardDataController({ fetchImpl, eventTarget:new EventTarget() });
    await controller.load();
    await controller.load({ silent:true });
    expect(controller.data.value.headline.sales_today).toBe(10);
    expect(controller.staleError.value).toBe('offline');
  });

  it('refreshes every 60 seconds only while active', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok:true, json:async () => ({ success:true }) });
    const controller = createDashboardDataController({ fetchImpl, eventTarget:new EventTarget() });
    controller.activate();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.deactivate();
    await vi.advanceTimersByTimeAsync(120000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('debounces realtime events and removes listener on deactivation', async () => {
    const target = new EventTarget();
    const fetchImpl = vi.fn().mockResolvedValue({ ok:true, json:async () => ({ success:true }) });
    const controller = createDashboardDataController({ fetchImpl, eventTarget:target });
    controller.activate();
    const event = new Event('admin:realtime');
    event.detail = { type:'table_update' };
    target.dispatchEvent(event);
    target.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    controller.deactivate();
    target.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('prevents older responses from overwriting newer data', async () => {
    let resolveFirst;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const fetchImpl = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ ok:true, json:async () => ({ success:true, marker:2 }) });
    const controller = createDashboardDataController({ fetchImpl, eventTarget:new EventTarget() });
    const oldLoad = controller.load();
    await controller.load();
    resolveFirst({ ok:true, json:async () => ({ success:true, marker:1 }) });
    await oldLoad;
    expect(controller.data.value.marker).toBe(2);
  });
});
```

- [ ] **Step 2: Run test and confirm red**

Run: `npx vitest run src/admin/composables/__tests__/useDashboardData.spec.js`

Expected: FAIL because composable does not exist.

- [ ] **Step 3: Implement controller core**

```ts
import { onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { DashboardPayload } from '../pages/dashboard/dashboardTypes'

const REALTIME_TYPES = new Set(['new_order','inventory_changed','shifts_changed','table_update'])

export function createDashboardDataController({
  fetchImpl = window.fetch.bind(window),
  eventTarget = window,
  refreshMs = 60000,
  realtimeDelayMs = 400,
} = {}) {
  const data = shallowRef<DashboardPayload | null>(null)
  const isLoading = ref(false)
  const isRefreshing = ref(false)
  const error = ref<string | null>(null)
  const staleError = ref<string | null>(null)
  let requestSequence = 0
  let abortController: AbortController | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let realtimeTimer: ReturnType<typeof setTimeout> | null = null
  let active = false

  async function load({ silent = false } = {}) {
    const sequence = ++requestSequence
    abortController?.abort()
    abortController = new AbortController()
    if (silent && data.value) isRefreshing.value = true
    else isLoading.value = true
    if (!silent) error.value = null
    try {
      const response = await fetchImpl('api/admin/dashboard', { signal:abortController.signal })
      const json = await response.json()
      if (!response.ok || !json.success) throw new Error(json.message || 'Dashboard could not be loaded.')
      if (sequence !== requestSequence) return
      data.value = json
      error.value = null
      staleError.value = null
    } catch (caught) {
      if (caught?.name === 'AbortError' || sequence !== requestSequence) return
      const message = caught instanceof Error ? caught.message : 'Dashboard could not be loaded.'
      if (data.value) staleError.value = message
      else error.value = message
    } finally {
      if (sequence === requestSequence) {
        isLoading.value = false
        isRefreshing.value = false
      }
    }
  }

  function handleRealtime(event: Event) {
    const type = (event as CustomEvent).detail?.type
    if (!active || !REALTIME_TYPES.has(type)) return
    if (realtimeTimer) clearTimeout(realtimeTimer)
    realtimeTimer = setTimeout(() => load({ silent:true }), realtimeDelayMs)
  }

  function activate() {
    if (active) return
    active = true
    eventTarget.addEventListener('admin:realtime', handleRealtime)
    refreshTimer = setInterval(() => load({ silent:true }), refreshMs)
  }

  function deactivate() {
    active = false
    eventTarget.removeEventListener('admin:realtime', handleRealtime)
    if (refreshTimer) clearInterval(refreshTimer)
    if (realtimeTimer) clearTimeout(realtimeTimer)
    refreshTimer = null
    realtimeTimer = null
    abortController?.abort()
  }

  function destroy() {
    deactivate()
    requestSequence += 1
  }

  return { data, isLoading, isRefreshing, error, staleError, load, activate, deactivate, destroy, handleRealtime }
}
```

- [ ] **Step 4: Add Vue lifecycle wrapper**

```ts
export function useDashboardData() {
  const controller = createDashboardDataController()
  let firstActivation = true
  onMounted(() => controller.load())
  onActivated(() => {
    controller.activate()
    if (!firstActivation) controller.load({ silent:true })
    firstActivation = false
  })
  onDeactivated(controller.deactivate)
  onUnmounted(controller.destroy)
  return controller
}
```

- [ ] **Step 5: Run controller tests**

Run: `npx vitest run src/admin/composables/__tests__/useDashboardData.spec.js`

Expected: PASS with no pending timers.

- [ ] **Step 6: Commit**

```bash
git add src/admin/composables/useDashboardData.ts src/admin/composables/__tests__/useDashboardData.spec.js
git commit -m "feat(dashboard): add keep-alive-safe data controller"
```

---

### Task 9: Build focused dashboard presentation components

**Files:**
- Create: `src/admin/components/dashboard/DashboardMetricLedger.vue`
- Create: `src/admin/components/dashboard/DashboardAttention.vue`
- Create: `src/admin/components/dashboard/DashboardPaceChart.vue`
- Create: `src/admin/components/dashboard/DashboardTablesNow.vue`
- Create: `src/admin/components/dashboard/DashboardProducts.vue`
- Create: `src/admin/components/dashboard/DashboardPayments.vue`

**Interfaces:**
- All components are controlled: props in, semantic navigation emit out.
- No component fetches data or reads router directly.
- Only `DashboardPaceChart.vue` imports Chart.js.

- [ ] **Step 1: Create connected metric ledger**

```vue
<!-- src/admin/components/dashboard/DashboardMetricLedger.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { formatReportMoney, formatReportNumber, formatReportPercent } from '../../utils/reportFormatting.js'
import type { DashboardPayload } from '../../pages/dashboard/dashboardTypes'

const props = defineProps<{
  headline: DashboardPayload['headline']
  comparison: DashboardPayload['comparison']
}>()

const metrics = computed(() => [
  { key:'sales', label:'Sales today', value:formatReportMoney(props.headline.sales_today),
    delta:props.comparison.delta?.sales_today.percent ?? null, money:true },
  { key:'orders', label:'Orders', value:formatReportNumber(props.headline.orders),
    delta:props.comparison.delta?.orders.percent ?? null, money:false },
  { key:'average', label:'Average check', value:formatReportMoney(props.headline.average_check),
    delta:props.comparison.delta?.average_check.percent ?? null, money:true },
  { key:'estimate', label:'Estimated close',
    value:props.headline.estimated_close === null ? '-' : formatReportMoney(props.headline.estimated_close),
    delta:null, money:true },
])

function deltaLabel(value: number | null) {
  if (value === null) return ''
  const sign = value > 0 ? '+' : ''
  return `${sign}${formatReportPercent(value)}`
}
</script>

<template>
  <section class="overflow-hidden rounded-2xl border border-border bg-card" :aria-label="$t('Sales today')">
    <div class="grid grid-cols-2 xl:grid-cols-4">
      <article v-for="(metric, index) in metrics" :key="metric.key"
        class="min-w-0 p-4 sm:p-5 xl:p-6"
        :class="[index % 2 ? 'border-s border-border' : '', index > 1 ? 'border-t xl:border-t-0' : '', index ? 'xl:border-s' : '']">
        <p class="text-xs font-medium text-muted-foreground">{{ $t(metric.label) }}</p>
        <p class="mt-2 truncate font-display text-2xl font-semibold tracking-tight text-foreground tabular-nums sm:text-3xl" data-no-i18n>
          {{ metric.value }}
        </p>
        <p v-if="metric.delta !== null" class="mt-2 text-xs font-semibold tabular-nums"
          :class="metric.delta > 0 ? 'text-teal-700' : metric.delta < 0 ? 'text-rose-700' : 'text-muted-foreground'" data-no-i18n>
          {{ deltaLabel(metric.delta) }}
        </p>
        <p v-else-if="metric.key === 'estimate'" class="mt-2 text-xs text-muted-foreground">{{ $t('At this pace') }}</p>
      </article>
    </div>
  </section>
</template>
```

- [ ] **Step 2: Create actionable attention list**

```vue
<!-- src/admin/components/dashboard/DashboardAttention.vue -->
<script setup lang="ts">
import { attentionMessage } from '../../utils/dashboardPresentation'
import type { DashboardAttentionItem, DashboardDestination } from '../../pages/dashboard/dashboardTypes'

defineProps<{ items: DashboardAttentionItem[] }>()
const emit = defineEmits<{ navigate: [destination: DashboardDestination] }>()
</script>

<template>
  <section v-if="items.length" class="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 sm:p-5"
    :aria-label="$t('Needs attention')">
    <h2 class="font-display text-base font-semibold text-foreground">{{ $t('Needs attention') }}</h2>
    <div class="mt-3 divide-y divide-amber-200/70">
      <button v-for="(item, index) in items" :key="`${item.type}-${index}`" type="button"
        class="flex min-h-11 w-full items-center justify-between gap-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
        @click="emit('navigate', item.destination)">
        <span class="text-sm font-medium text-zinc-800" data-no-i18n>{{ attentionMessage(item) }}</span>
        <i class="fa-solid fa-arrow-up-right-from-square shrink-0 text-xs text-zinc-500" aria-hidden="true"></i>
      </button>
    </div>
  </section>
</template>
```

- [ ] **Step 3: Create Tables, Products, and Payments ledgers**

Use these exact public contracts and core markup:

```vue
<!-- DashboardTablesNow.vue -->
<script setup lang="ts">
import { formatReportMoney, formatReportNumber } from '../../utils/reportFormatting.js'
import { formatElapsedMinutes } from '../../utils/dashboardPresentation'
import type { DashboardPayload } from '../../pages/dashboard/dashboardTypes'
defineProps<{ tables: NonNullable<DashboardPayload['tables']> }>()
const emit = defineEmits<{ navigate: [] }>()
</script>
<template>
  <section class="rounded-2xl border border-border bg-card p-5" :aria-label="$t('Tables right now')">
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-display text-base font-semibold">{{ $t('Tables right now') }}</h2>
      <button type="button" class="min-h-11 px-2 text-sm font-semibold text-teal-700 focus-visible:ring-2" @click="emit('navigate')">
        {{ $t('View tables') }}
      </button>
    </div>
    <dl class="mt-4 divide-y divide-border">
      <div class="flex justify-between gap-4 py-3"><dt>{{ $t('Occupied tables') }}</dt><dd class="font-semibold tabular-nums" data-no-i18n>{{ formatReportNumber(tables.occupied_count) }}</dd></div>
      <div class="flex justify-between gap-4 py-3"><dt>{{ $t('Open unpaid value') }}</dt><dd class="font-semibold tabular-nums" data-no-i18n>{{ formatReportMoney(tables.open_unpaid_value) }}</dd></div>
      <div v-if="tables.longest_open" class="flex justify-between gap-4 py-3">
        <dt>{{ $t('Longest open') }} · {{ $t('Table') }} <span data-no-i18n>{{ tables.longest_open.table_number }}</span></dt>
        <dd class="font-semibold tabular-nums" data-no-i18n>{{ formatElapsedMinutes(tables.longest_open.elapsed_minutes) }}</dd>
      </div>
    </dl>
  </section>
</template>
```

```vue
<!-- DashboardProducts.vue -->
<script setup lang="ts">
import { formatReportMoney, formatReportNumber, formatReportPercent } from '../../utils/reportFormatting.js'
import type { DashboardProduct } from '../../pages/dashboard/dashboardTypes'
defineProps<{ products: DashboardProduct[] }>()
const emit = defineEmits<{ navigate: [] }>()
</script>
<template>
  <section class="rounded-2xl border border-border bg-card p-5" :aria-label="$t('What sold')">
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-display text-base font-semibold">{{ $t('What sold') }}</h2>
      <button type="button" class="min-h-11 px-2 text-sm font-semibold text-teal-700 focus-visible:ring-2" @click="emit('navigate')">{{ $t('Sales Breakdown') }}</button>
    </div>
    <ol v-if="products.length" class="mt-3 divide-y divide-border">
      <li v-for="product in products" :key="`${product.product_id}-${product.name}`" class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3">
        <div class="min-w-0"><p class="break-words text-sm font-medium" data-no-i18n>{{ product.name }}</p><p class="mt-1 text-xs text-muted-foreground"><span data-no-i18n>{{ formatReportNumber(product.net_units) }}</span> {{ $t('Units') }}</p></div>
        <div class="text-end"><p class="text-sm font-semibold tabular-nums" data-no-i18n>{{ formatReportMoney(product.net_sales) }}</p><p v-if="product.delta_percent !== null" class="mt-1 text-xs tabular-nums text-muted-foreground" data-no-i18n>{{ product.delta_percent > 0 ? '+' : '' }}{{ formatReportPercent(product.delta_percent) }}</p></div>
      </li>
    </ol>
    <p v-else class="mt-6 text-sm text-muted-foreground">{{ $t('No products sold yet.') }}</p>
  </section>
</template>
```

```vue
<!-- DashboardPayments.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { formatReportMoney, formatReportPercent } from '../../utils/reportFormatting.js'
import type { DashboardPayload } from '../../pages/dashboard/dashboardTypes'
const props = defineProps<{ payments: DashboardPayload['payments'] }>()
const cashShare = computed(() => props.payments.find(item => item.method === 'cash')?.share || 0)
</script>
<template>
  <section class="rounded-2xl border border-border bg-card p-5" :aria-label="$t('Cash and card')">
    <h2 class="font-display text-base font-semibold">{{ $t('Cash and card') }}</h2>
    <template v-if="payments.length">
      <div class="mt-5 flex h-2 overflow-hidden rounded-full bg-zinc-200" dir="ltr" aria-hidden="true">
        <span class="bg-teal-700" :style="{ width:`${cashShare}%` }"></span><span class="flex-1 bg-zinc-400"></span>
      </div>
      <dl class="mt-4 divide-y divide-border">
        <div v-for="payment in payments" :key="payment.method" class="flex items-center justify-between gap-4 py-3">
          <dt class="capitalize">{{ $t(payment.method) }}</dt>
          <dd class="flex gap-3 tabular-nums" data-no-i18n><strong>{{ formatReportMoney(payment.amount) }}</strong><span class="text-muted-foreground">{{ formatReportPercent(payment.share) }}</span></dd>
        </div>
      </dl>
    </template>
    <p v-else class="mt-6 text-sm text-muted-foreground">{{ $t('No payments yet.') }}</p>
  </section>
</template>
```

Add these Arabic keys:

```js
'View tables': 'عرض الطاولات',
```

- [ ] **Step 4: Create isolated cumulative pace chart**

```vue
<!-- src/admin/components/dashboard/DashboardPaceChart.vue -->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
import { CategoryScale, Chart, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip } from 'chart.js'
import { currentLanguage, t } from '../../../../assets/js/admin/i18n.js'
import { formatReportMoney, formatReportNumber } from '../../utils/reportFormatting.js'
import { getBusinessDayStartHour } from '../../../utils/businessDate.js'
import type { PacePoint } from '../../pages/dashboard/dashboardTypes'

Chart.register(CategoryScale, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip)
const props = defineProps<{ points: PacePoint[] }>()
const canvas = shallowRef<HTMLCanvasElement | null>(null)
let chart: Chart | null = null

function timeLabel(elapsedMinute: number) {
  const absolute = (getBusinessDayStartHour() * 60 + elapsedMinute) % 1440
  const hours24 = Math.floor(absolute / 60)
  const minutes = absolute % 60
  const hours12 = hours24 % 12 || 12
  return `${formatReportNumber(hours12, { minimumIntegerDigits:2 })}:${formatReportNumber(minutes, { minimumIntegerDigits:2 })} ${t(hours24 >= 12 ? 'PM' : 'AM')}`
}

async function render() {
  await nextTick()
  chart?.destroy()
  if (!canvas.value || !props.points.length) return
  const fontFamily = currentLanguage.value === 'ar' ? 'IBM Plex Sans Arabic' : 'Space Grotesk'
  chart = new Chart(canvas.value, {
    type:'line',
    data:{
      labels:props.points.map(point => timeLabel(point.elapsed_minute)),
      datasets:[
        { label:t('Today'), data:props.points.map(point => point.today), borderColor:'#0f766e', borderWidth:2.5, pointRadius:2, tension:0.22 },
        { label:t('Typical day'), data:props.points.map(point => point.typical), borderColor:'#a1a1aa', borderDash:[6,5], borderWidth:2, pointRadius:0, tension:0.22, spanGaps:true },
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:false, animation:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration:180 },
      locale:currentLanguage.value === 'ar' ? 'ar-JO-u-nu-latn' : 'en-JO-u-nu-latn',
      plugins:{ legend:{ position:'top', align:'end', labels:{ usePointStyle:true, boxWidth:8, font:{ family:fontFamily } } },
        tooltip:{ callbacks:{ label:context => `${context.dataset.label}: ${formatReportMoney(context.parsed.y)}` } } },
      scales:{ x:{ grid:{ display:false }, ticks:{ maxRotation:0, autoSkip:true, font:{ family:fontFamily } } },
        y:{ beginAtZero:true, grid:{ color:'rgba(113,113,122,.12)' }, ticks:{ callback:value => formatReportNumber(value) } } },
    }
  })
}

watch([() => props.points, currentLanguage], render, { deep:true, immediate:true })
onBeforeUnmount(() => { chart?.destroy(); chart = null })
</script>

<template>
  <section class="rounded-2xl border border-border bg-card p-4 sm:p-5" :aria-label="$t('Sales today')">
    <div><h2 class="font-display text-base font-semibold">{{ $t('Sales today') }}</h2><p class="mt-1 text-sm text-muted-foreground">{{ $t('Today compared with a typical matching weekday') }}</p></div>
    <div class="mt-5 h-64 w-full sm:h-72" dir="ltr"><canvas ref="canvas"></canvas></div>
  </section>
</template>
```

Add Arabic translation:

```js
'Today compared with a typical matching weekday': 'اليوم مقارنة بمتوسط اليوم نفسه من الأسبوع',
```

- [ ] **Step 5: Build-check isolated components**

Temporarily import each component from `Dashboard.vue` without rendering it, run build,
then remove temporary imports before commit. This catches SFC/TypeScript path errors.

Temporary import block:

```js
import DashboardAttention from '../components/dashboard/DashboardAttention.vue';
import DashboardMetricLedger from '../components/dashboard/DashboardMetricLedger.vue';
import DashboardPaceChart from '../components/dashboard/DashboardPaceChart.vue';
import DashboardPayments from '../components/dashboard/DashboardPayments.vue';
import DashboardProducts from '../components/dashboard/DashboardProducts.vue';
import DashboardTablesNow from '../components/dashboard/DashboardTablesNow.vue';
void [DashboardAttention, DashboardMetricLedger, DashboardPaceChart, DashboardPayments, DashboardProducts, DashboardTablesNow];
```

Run: `npm run build:admin`

Expected: successful Vite build; no Vue compiler warnings.

Delete exactly this temporary block after successful build; Task 10 adds permanent imports.

- [ ] **Step 6: Commit**

```bash
git add src/admin/components/dashboard assets/js/admin/i18n.js
git commit -m "feat(dashboard): add focused presentation components"
```

---

### Task 10: Replace Dashboard page with responsive composition shell

**Files:**
- Replace: `src/admin/pages/Dashboard.vue`
- Test: `src/admin/pages/__tests__/dashboardStructure.spec.js`
- Verify: `src/admin/pages/__tests__/dashboardLocalization.spec.js`

**Interfaces:**
- Consumes: `useDashboardData`, presentation helpers, six Task 9 components.
- Preserves: component name `dashboard` for `src/admin/App.vue` `KeepAlive` include list.
- Emits no new global events; navigation uses existing route names.

- [ ] **Step 1: Write failing structure test**

```js
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const page = fs.readFileSync(path.resolve(__dirname, '../Dashboard.vue'), 'utf8');

describe('Dashboard structure', () => {
  it('uses script setup and keeps the KeepAlive component name', () => {
    expect(page).toContain('<script setup lang="ts">');
    expect(page).toMatch(/defineOptions\(\{\s*name:\s*['"]dashboard['"]/);
    expect(page).not.toContain('return {');
  });

  it('contains only approved information architecture', () => {
    for (const component of ['DashboardMetricLedger','DashboardAttention','DashboardPaceChart','DashboardTablesNow','DashboardProducts','DashboardPayments']) {
      expect(page).toContain(component);
    }
    for (const removed of ['primaryFinanceCards','secondaryFinanceCards','DoughnutController','BarController','Sales Trend','Last 14 business days','Recent Orders']) {
      expect(page).not.toContain(removed);
    }
  });

  it('has explicit loading, initial error, and stale-data states', () => {
    expect(page).toContain('isLoading && !data');
    expect(page).toContain('error && !data');
    expect(page).toContain('staleError && data');
    expect(page).toContain('aria-live="polite"');
  });

  it('uses approved responsive breakpoints without horizontal page scrolling', () => {
    expect(page).toContain('xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]');
    expect(page).toContain('min-w-0');
    expect(page).not.toContain('overflow-x-auto');
  });
});
```

- [ ] **Step 2: Run test and confirm red**

Run: `npx vitest run src/admin/pages/__tests__/dashboardStructure.spec.js`

Expected: FAIL against old Options API/card/chart dashboard.

- [ ] **Step 3: Replace page script**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import DashboardAttention from '../components/dashboard/DashboardAttention.vue'
import DashboardMetricLedger from '../components/dashboard/DashboardMetricLedger.vue'
import DashboardPaceChart from '../components/dashboard/DashboardPaceChart.vue'
import DashboardPayments from '../components/dashboard/DashboardPayments.vue'
import DashboardProducts from '../components/dashboard/DashboardProducts.vue'
import DashboardTablesNow from '../components/dashboard/DashboardTablesNow.vue'
import { useDashboardData } from '../composables/useDashboardData'
import { buildDashboardNarrative } from '../utils/dashboardPresentation'
import { formatReportBusinessDate, formatReportBusinessTime } from '../utils/reportFormatting.js'
import type { DashboardDestination } from './dashboard/dashboardTypes'

defineOptions({ name:'dashboard' })
const router = useRouter()
const { data, isLoading, isRefreshing, error, staleError, load } = useDashboardData()
const narrative = computed(() => data.value ? buildDashboardNarrative(data.value) : '')
const destinationRoutes: Record<DashboardDestination, string> = {
  'reports-summary':'reports-summary',
  'reports-sales':'reports-sales',
  'reports-refunds':'reports-refunds',
  shifts:'shifts', inventory:'inventory', tablemap:'tablemap',
}
function navigate(destination: DashboardDestination) {
  router.push({ name:destinationRoutes[destination] })
}
</script>
```

- [ ] **Step 4: Replace page template with priority reading order**

```vue
<template>
  <main class="min-w-0 space-y-5 pb-10 text-foreground" aria-live="polite">
    <section v-if="isLoading && !data" class="space-y-5" :aria-label="$t('Loading dashboard')">
      <div class="h-20 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"></div>
      <div class="grid grid-cols-2 overflow-hidden rounded-2xl border border-border xl:grid-cols-4">
        <div v-for="index in 4" :key="index" class="h-28 animate-pulse border-border bg-muted/70 motion-reduce:animate-none" :class="index > 1 ? 'border-t xl:border-t-0' : ''"></div>
      </div>
      <div class="h-72 animate-pulse rounded-2xl bg-muted/70 motion-reduce:animate-none"></div>
    </section>

    <section v-else-if="error && !data" class="rounded-2xl border border-border bg-card p-8 text-center">
      <h1 class="font-display text-xl font-semibold">{{ $t('Dashboard could not be loaded.') }}</h1>
      <p class="mt-2 text-sm text-muted-foreground" data-no-i18n>{{ error }}</p>
      <button type="button" class="mt-5 min-h-11 rounded-xl bg-teal-700 px-5 font-semibold text-white focus-visible:ring-2" @click="load()">{{ $t('Try again') }}</button>
    </section>

    <template v-else-if="data">
      <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <p class="text-sm font-medium text-muted-foreground" data-no-i18n>{{ formatReportBusinessDate(data.business_date) }} · {{ $t('Current business day') }}</p>
          <h1 class="mt-2 max-w-4xl font-display text-xl font-semibold leading-snug tracking-tight sm:text-2xl" data-no-i18n>{{ narrative }}</h1>
          <p class="mt-2 text-xs text-muted-foreground">{{ $t('Last updated') }} <span class="tabular-nums" data-no-i18n>{{ formatReportBusinessTime(data.refreshed_at) }}</span></p>
        </div>
        <button type="button" class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold focus-visible:ring-2" :disabled="isRefreshing" @click="load({ silent:true })">
          <i class="fa-solid fa-rotate motion-reduce:animate-none" :class="isRefreshing ? 'fa-spin' : ''" aria-hidden="true"></i><span>{{ $t('Refresh dashboard') }}</span>
        </button>
      </header>

      <div v-if="staleError && data" class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        {{ $t('Showing last successful update.') }}
        <button type="button" class="ms-2 min-h-11 font-semibold underline" @click="load({ silent:true })">{{ $t('Try again') }}</button>
      </div>

      <DashboardMetricLedger :headline="data.headline" :comparison="data.comparison" />
      <DashboardAttention :items="data.attention" @navigate="navigate" />

      <div class="grid min-w-0 grid-cols-1 gap-5"
        :class="data.tables ? 'xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]' : ''">
        <DashboardPaceChart class="min-w-0" :points="data.pace.points" />
        <DashboardTablesNow v-if="data.tables" :tables="data.tables" @navigate="navigate('tablemap')" />
      </div>

      <div class="grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2">
        <DashboardProducts :products="data.products" @navigate="navigate('reports-sales')" />
        <DashboardPayments :payments="data.payments" />
      </div>
    </template>
  </main>
</template>
```

- [ ] **Step 5: Run structure/localization tests and build**

Run:

```bash
npx vitest run src/admin/pages/__tests__/dashboardStructure.spec.js src/admin/pages/__tests__/dashboardLocalization.spec.js src/admin/utils/__tests__/dashboardPresentation.spec.js src/admin/composables/__tests__/useDashboardData.spec.js
npm run build:admin
```

Expected: all tests PASS; Vite build succeeds without missing Vue bindings or Chart.js warnings.

- [ ] **Step 6: Commit**

```bash
git add src/admin/pages/Dashboard.vue src/admin/pages/dashboard/dashboardTypes.ts src/admin/pages/__tests__/dashboardStructure.spec.js
git commit -m "feat(admin): redesign dashboard around today's operations"
```

---

### Task 11: Adversarial verification, query review, and responsive visual QA

**Files:**
- Modify only files proven defective by checks below.
- No new feature scope.

**Interfaces:**
- Produces: verified API/UI behavior at LTR/RTL desktop, 1024px, tablet, and mobile.

- [ ] **Step 1: Run all dashboard and shared-report regression tests**

```bash
npx vitest run backend/tests/unit/businessDate.test.js backend/tests/unit/dailyReportMath.test.js backend/tests/unit/dashboardAnalytics.test.js backend/tests/integration/dashboardFinancialTimeline.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/dashboardDataBuilder.test.js backend/tests/integration/dashboard.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsSalesDetails.test.js src/admin/utils/__tests__/reportFormatting.spec.js src/admin/utils/__tests__/dashboardPresentation.spec.js src/admin/composables/__tests__/useDashboardData.spec.js src/admin/pages/__tests__/dashboardLocalization.spec.js src/admin/pages/__tests__/dashboardStructure.spec.js
```

Expected: PASS; no changed Daily Reports totals.

- [ ] **Step 2: Run complete automated suite and production build**

```bash
npm run test:unit
npm run build:admin
```

Expected: all Vitest suites PASS; Vite production build succeeds.

- [ ] **Step 3: Inspect MySQL plans on test-sized and realistic data**

Run `EXPLAIN FORMAT=JSON` for the three bounded statements implemented in Tasks 2-3:

1. financial orders minute aggregation;
2. refund/void event range;
3. product sales/refund event union.

Required review result:

- order branches use bounded `invoice_issued_at`/`created_at` range access where possible;
- refund branches use `idx_refunds_created` or a range-compatible access path;
- joins use `order_items.invoice_id`, `refund_items.refund_id`, and PK lookups;
- no unbounded 29-day query, correlated per-row product query, or N+1 loop;
- no schema/index change without measured evidence and separate approval.

- [ ] **Step 4: Start admin and inspect four widths**

Run: `npm run dev:admin`

Using browser design review, inspect `/admin/dashboard` at:

- 1440x900 English;
- 1024x768 English;
- 768x1024 Arabic;
- 390x844 Arabic.

Acceptance:

- 1440: four metrics one row; chart beside Tables; lower panels balanced.
- 1024: metrics 2x2; chart full width; Tables below; summary/headlines visible without excessive scroll.
- mobile: 2x2 metrics remain legible; one-column reading order; no page horizontal overflow.
- Arabic: structure mirrors; chart axis remains chronological LTR; every numeral is Latin; JD presentation unchanged.
- Full product names wrap; no truncation from API or CSS.
- Focus rings visible; all buttons at least 44px; warning rows keyboard-activatable.
- Empty/sparse-history/failed-refresh states do not create blank cards or layout jumps.
- No gradient, glass blur, heavy shadow, oversized hero, doughnut, card mosaic, or AI-slop title.

- [ ] **Step 5: Exercise live lifecycle and failure paths**

Manual checks:

1. Navigate Dashboard -> Orders -> Dashboard repeatedly; confirm one refresh timer and no duplicate realtime request.
2. Switch English/Arabic while chart is visible; confirm one chart instance, translated legend, Latin digits.
3. Disable network after successful load; trigger refresh; confirm prior values remain with quiet stale notice.
4. Reload with network disabled; confirm focused initial error and working retry.
5. Toggle `tables_enabled` and `stock_enabled`; confirm blocks/attention disappear entirely when disabled.
6. Seed merged tables sharing one `current_order_id`; confirm physical occupied count includes both, money counts once.
7. Issue refund against an older invoice; confirm today's Sales decreases and historical sale is not restated.

- [ ] **Step 6: Run warning and binding scan**

Open browser console during every state above. Required result: zero Vue warnings, especially
`Property ... was accessed during render but is not defined on instance`, zero unhandled
promise rejections, and zero Chart.js canvas reuse warnings.

- [ ] **Step 7: Commit only verification fixes, if any**

```bash
git add backend/services backend/routes/admin/dashboard.js backend/config/cache.js backend/tests src/admin/pages/Dashboard.vue src/admin/pages/dashboard src/admin/components/dashboard src/admin/composables/useDashboardData.ts src/admin/composables/__tests__ src/admin/utils assets/js/admin/i18n.js
git commit -m "fix(dashboard): close verification gaps"
```

Skip this commit when checks require no code changes.
