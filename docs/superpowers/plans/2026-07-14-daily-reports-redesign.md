# Daily Reports Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace seven overlapping report pages with three guided, finance-correct pages—Summary, Sales Details, and Refunds & Voids—with authoritative 80 mm thermal reports.

**Architecture:** Keep Daily Reports read-only and date-driven. Add focused summary and sales-detail builders that report sales and refunds on their event dates, retain the dedicated refund endpoint for investigation, and leave invoice operations in Order History and register operations in Shifts. Each page loads only its own API contract; one shared report layout owns business-date navigation and one thermal Print action.

**Tech Stack:** Express 5, MySQL 8/InnoDB, Vue 3 Composition API, Vue Router 4, Tailwind CSS 4, Chart.js 4, Vitest, Supertest, Puppeteer-based local spooler.

## Global Constraints

- Daily Reports has exactly three pages: `Summary`, `Sales Details`, `Refunds & Voids`.
- Order History remains sole invoice-detail, receipt-preview, A4, and invoice-reprint surface.
- Shifts remains sole shift-management, X/Z, period-audit, and shift-print surface.
- Default period is current configured business date; day controls are Previous, Today, Next. Custom start/end range stays behind `Custom period`.
- Every screen and receipt prints configured business-day window; never hardcode `06:00`.
- Summary headline is `Sales Collected`: tax-inclusive paid sales processed in selected period minus refund events issued in selected period.
- Comparison uses same weekday last week; multi-day ranges compare same date span shifted seven days back.
- Product/category figures are tax-inclusive, discount-adjusted, and return-adjusted on event date.
- Product rows expose sold quantity, returned quantity, and net sales separately.
- Service charge is included in Sales Collected, shown separately, excluded from menu-product/category ranking, and hidden when zero. A nonzero historical charge remains visible even if the feature is currently disabled so the ledger still reconciles.
- Expenses, costs, profit, margin, customers, top customers, transaction/invoice lists, and full shift lists do not appear in Daily Reports.
- Discounts remain Summary facts only; no discount-reason UI because schema stores no discount reason.
- Refunds and voids remain distinct: refunds move money; voids do not.
- A `split` refund is reported across cash/card in the original order's frozen cash/card proportion, rounded per refund event with the remainder assigned to card. The schema stores no more precise split-refund allocation, so reports never invent a different tender mix.
- Refund UI contains no staff-outlier algorithm or automatic accusation.
- Refund log expands affected items only and links to original order in Order History.
- Thermal printing is only report output: no A4 and no CSV from Daily Reports.
- Print target is 80 mm only; browser print and local spooler output must have matching content.
- Refund thermal output includes every selected-period event, affected items, time, amount, cashier, method, and reason.
- Tables and waiters render only when table service is enabled and relevant rows exist.
- Bundle parent is reporting unit; bundle component rows never inflate sold quantities or create zero-revenue products.
- English and Arabic/RTL remain supported in screen and thermal output.
- All three screens remain usable at narrow admin widths: ledger rows wrap predictably, data tables scroll within their section, and actions keep visible labels.
- No database migration is required; all required event and snapshot fields already exist.
- Historical product names and money use frozen order/refund fields. Category placement uses current `products.category_id` because category was not snapshotted at sale; deleted/orphaned products remain visible under `Uncategorized`.

---

## Final Data Contracts

### `GET /api/admin/reports/summary`

Query: `start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`; omitted values default to current business date.

```js
{
  success: true,
  period: {
    start_date: '2026-07-14',
    end_date: '2026-07-14',
    is_single_day: true,
    business_start_at: '2026-07-14 03:00:00',
    business_end_at: '2026-07-15 03:00:00',
    business_day_start_hour: 6,
    business_day_end_hour: 5,
    comparison_start_date: '2026-07-07',
    comparison_end_date: '2026-07-07'
  },
  summary: {
    sales_processed: 150.00,
    refunds_issued: 20.00,
    sales_collected: 130.00,
    net_revenue_pre_tax: 112.07,
    tax_collected: 17.93,
    service_charges_collected: 10.00,
    cash_collected: 80.00,
    card_collected: 50.00,
    total_orders: 12,
    average_ticket: 12.50,
    discounts_total: 5.00,
    discounted_orders: 2,
    refund_count: 1,
    void_count: 1,
    void_value: 8.00
  },
  comparison: {
    sales_collected: { amount: 10.00, percent: 8.33 },
    total_orders: { amount: 2, percent: 20.00 },
    average_ticket: { amount: -0.50, percent: -3.85 }
  },
  payments: [
    { key: 'cash', amount: 80.00 },
    { key: 'card', amount: 50.00 }
  ],
  order_types: [
    { order_type_id: 1, name: 'Dine In', orders: 8, sold_amount: 110.00, returned_amount: 10.00, net_sales: 100.00 }
  ],
  hourly_sales: [
    { hour: 6, orders: 0, sales_processed: 0.00 },
    { hour: 7, orders: 2, sales_processed: 22.00 }
  ],
  cash_status: {
    state: 'balanced',
    open_shifts: 0,
    closed_shifts: 2,
    shifts_needing_review: 0,
    expected_cash: 180.00,
    actual_cash: 180.00,
    variance: 0.00
  }
}
```

`cash_status.state` is exactly one of `in_progress`, `balanced`, `review`, `no_shifts`. If any included shift is open, `actual_cash` and `variance` are `null`.

### `GET /api/admin/reports/sales-details`

```js
{
  success: true,
  period: {
    start_date: '2026-07-14',
    end_date: '2026-07-14',
    is_single_day: true,
    business_start_at: '2026-07-14 03:00:00',
    business_end_at: '2026-07-15 03:00:00',
    business_day_start_hour: 6,
    business_day_end_hour: 5,
    comparison_start_date: '2026-07-07',
    comparison_end_date: '2026-07-07'
  },
  totals: {
    sales_collected: 130.00,
    menu_sales: 120.00,
    service_charges_collected: 10.00
  },
  categories: [{
    category_id: 1,
    name: 'Food',
    sold_qty: 20,
    returned_qty: 1,
    sold_amount: 130.00,
    returned_amount: 10.00,
    net_sales: 120.00,
    subcategories: [{
      category_id: 2,
      name: 'Burgers',
      sold_qty: 12,
      returned_qty: 1,
      sold_amount: 90.00,
      returned_amount: 10.00,
      net_sales: 80.00
    }]
  }],
  products: [{
    product_id: 1,
    item_name: 'Classic Burger',
    category_path: 'Food › Burgers',
    sold_qty: 5,
    returned_qty: 1,
    sold_amount: 35.00,
    returned_amount: 7.00,
    net_sales: 28.00
  }],
  order_types: [{
    order_type_id: 1,
    name: 'Dine In',
    orders: 8,
    sold_amount: 110.00,
    returned_amount: 10.00,
    net_sales: 100.00
  }],
  cashiers: [{
    user_id: 2,
    name: 'Cashier',
    orders: 8,
    sold_amount: 110.00,
    returned_amount: 10.00,
    net_sales: 100.00
  }],
  waiters: [{
    user_id: 3,
    name: 'Waiter',
    orders: 6,
    sold_amount: 90.00,
    returned_amount: 10.00,
    net_sales: 80.00
  }],
  tables: [{
    table_id: 4,
    table_number: 'T4',
    section_name: 'Main Hall',
    orders: 3,
    sold_amount: 45.00,
    returned_amount: 5.00,
    net_sales: 40.00
  }],
  tables_enabled: true
}
```

All dimension rows use the common money keys `sold_amount`, `returned_amount`, `net_sales`; quantity keys apply only to categories/products. Every category node recursively uses the category shape shown above and owns a `subcategories` array. Category and product totals exclude service charges and reconcile to `menu_sales`. Order type, cashier, waiter, and table dimensions include service charges and reconcile to `sales_collected`. Refund dimensions come from original order/product attribution, while Refunds & Voids staff rows identify who processed the correction.

### `GET /api/admin/reports/refunds`

Retain pagination/filter query parameters. Return:

```js
{
  success: true,
  period: {
    start_date: '2026-07-14',
    end_date: '2026-07-14',
    is_single_day: true,
    business_start_at: '2026-07-14 03:00:00',
    business_end_at: '2026-07-15 03:00:00',
    business_day_start_hour: 6,
    business_day_end_hour: 5,
    comparison_start_date: '2026-07-07',
    comparison_end_date: '2026-07-07'
  },
  summary: {
    sales_processed: 150.00,
    refund_total: 20.00,
    refund_rate: 13.33,
    refund_cash: 20.00,
    refund_card: 0.00,
    refund_count: 1,
    void_count: 1,
    void_value: 8.00
  },
  by_staff: [{
    user_id: 2,
    name: 'Cashier',
    refund_count: 1,
    refund_value: 20.00,
    void_count: 0,
    void_value: 0.00
  }],
  top_reasons: [{ reason: 'Wrong item', count: 1, value: 20.00 }],
  log: {
    rows: [{
      refund_id: 9,
      invoice_id: 101,
      invoice_number: 4012,
      invoice_display_no: '4012',
      kind: 'refund',
      amount_refunded: 20.00,
      event_value: 20.00,
      refund_method: 'cash',
      reason: 'Wrong item',
      user_id: 2,
      cashier_name: 'Cashier',
      created_at: '2026-07-14 10:15:00',
      occurred_at_local: '2026-07-14 13:15',
      first_item_name: 'Burger',
      item_count: 1
    }],
    pagination: { total: 1, page: 1, limit: 50, total_pages: 1 }
  }
}
```

Remove `trend`, `staff_sales`, `refund_rate` per staff, and `is_outlier`.

### `GET /api/admin/reports/refunds/print-data`

Same `period`, `summary`, `by_staff`, and `top_reasons` keys, plus unpaginated `events`. Each event uses the log-row keys above and adds:

```js
items: [{
  order_item_id: 44,
  product_id: 7,
  item_name: 'Burger',
  note: 'No onion',
  quantity: 1,
  unit_price: 20.00,
  line_subtotal: 17.24,
  line_tax: 2.76,
  line_total: 20.00
}]
```

This endpoint is admin-only and exists so thermal output is complete even when UI log is paginated.

### Thermal Types

```js
const DAILY_REPORT_PRINT_TYPES = [
  'daily_summary_report',
  'daily_sales_report',
  'daily_refunds_report',
];

function dailyReportId(printType, period) {
  return `${printType}:${period.start_date}:${period.end_date}`;
}
```

Each print payload includes this stable `report_id`; every user click still carries a fresh print request ID, so deliberate duplicate prints remain possible.

---

## File Map

### Create

- `backend/services/dailyReportPeriod.js` — date validation, range metadata, prior-week period.
- `backend/services/dailyReportBuilder.js` — event-ledger summary and cash status.
- `backend/services/dailySalesDetailsBuilder.js` — product/category/order-type/staff/table sales and returns.
- `backend/services/dailyRefundReportBuilder.js` — neutral refund summary, paginated log, full print events.
- `backend/tests/unit/dailyReportPeriod.test.js` — pure period rules.
- `backend/tests/unit/dailyReportMath.test.js` — event-ledger and comparison math.
- `backend/tests/integration/dailyReportsSummary.test.js` — summary API contract.
- `backend/tests/integration/dailyReportsSalesDetails.test.js` — sales-detail contract.
- `src/admin/composables/useDailyReportPage.js` — abortable page-specific report fetching.
- `src/admin/composables/useThermalReportPrint.js` — browser/spooler thermal dispatch.
- `src/admin/pages/ReportsSummary.vue` — guided ledger.
- `src/admin/pages/ReportsSalesDetails.vue` — one guided breakdown page.
- `src/admin/pages/dailyReportPayloads.js` — pure payload normalization for three print types.
- `src/admin/pages/__tests__/dailyReportsNavigation.spec.js` — three-page route/source contract.
- `src/admin/pages/__tests__/dailyReportPayloads.spec.js` — pure print-payload tests.

### Modify

- `backend/routes/admin/reports.js` — expose focused endpoints; remove old monolithic payload queries.
- `backend/routes/print.js` — accept/sanitize three new report types.
- `backend/tests/unit/printJobIdentity.test.js` — prove new report types retain deterministic report identity behavior.
- `backend/tests/integration/reportsRefunds.test.js` — neutral refund contract and print data.
- `backend/tests/unit/print.unit.test.js` — nested daily-report sanitization.
- `backend/routes/admin/orders.js` — report deep-link filters for discounted and original orders.
- `backend/tests/integration/adminOrdersStats.test.js` — discounted-order filter contract.
- `backend/tests/integration/reports.test.js` — remove old monolithic contract expectations.
- `backend/tests/integration/adminRouting.test.js` — focused endpoint smoke contracts.
- `backend/tests/unit/receiptPresentationContract.test.js` — remove deleted ReportsInvoices source expectation.
- `src/admin/components/ReportsLayout.vue` — three tabs, day navigation, custom period, one Print button.
- `src/admin/router.js` — new routes plus legacy redirects.
- `src/admin/pageRegistry.js` — new pages; remove old report loaders.
- `src/admin/components/Sidebar.vue` — point Daily Reports to `reports-summary`.
- `src/utils/businessDate.js` — expose configured start hour and display window.
- `src/utils/__tests__/businessDate.spec.js` — configured window tests.
- `src/admin/pages/ReportsRefunds.vue` — guided factual page, no outlier/export logic.
- `src/admin/pages/Orders.vue` — consume report deep links without duplicating order UI.
- `src/print/PrintReceiptApp.vue` — three matching browser thermal templates.
- `src/print/__tests__/reportPrintBranches.spec.js` — new print type contract; old branches absent.
- `assets/js/admin/i18n.js` — exact English/Arabic copy.
- `pos-spooler-printer/report-html.js` — escaped 80 mm renderers for three types.
- `pos-spooler-printer/server.js` — route new report types to renderer.
- `pos-spooler-printer/tests/report-html.test.js` — content, escaping, RTL, full-event checks.
- `docs/SPOOLER-CHANGES.md` — preserve ignored spooler changes for deployment.

### Delete

- `src/admin/pages/ReportsOverview.vue`
- `src/admin/pages/ReportsProducts.vue`
- `src/admin/pages/ReportsTables.vue`
- `src/admin/pages/ReportsStaff.vue`
- `src/admin/pages/ReportsInvoices.vue`
- `src/admin/pages/ReportsShifts.vue`
- `src/admin/pages/reportShiftsPayload.js`
- `src/admin/pages/__tests__/reportShiftsPayload.spec.js`

Do not delete `src/admin/components/A4Receipt.vue`; Order History still uses A4 invoice printing.

---

### Task 1: Lock Business-Period And Event-Ledger Math

**Files:**
- Create: `backend/services/dailyReportPeriod.js`
- Create: `backend/services/dailyReportBuilder.js`
- Create: `backend/tests/unit/dailyReportPeriod.test.js`
- Create: `backend/tests/unit/dailyReportMath.test.js`

**Interfaces:**
- Produces: `parseDailyReportPeriod({ startDate, endDate, defaultDate })`.
- Produces: `combineFinancialEvents(sales, refunds)`.
- Produces: `buildComparison(current, prior)`.
- Produces: `allocateRefundPayment(refund, originalPayment)` for cash/card reconciliation.
- Consumes: `getBusinessDate`, `getBusinessDateRange`, `getBusinessDayStartHour`, `addBusinessDays` from `backend/utils/businessDate.js`.

- [ ] **Step 1: Write failing period tests**

```js
const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');

it('defaults to one business day and shifts comparison seven days', () => {
  const p = parseDailyReportPeriod({ defaultDate: '2026-07-14' });
  expect(p.start_date).toBe('2026-07-14');
  expect(p.end_date).toBe('2026-07-14');
  expect(p.comparison_start_date).toBe('2026-07-07');
  expect(p.business_day_start_hour).toBe(6);
  expect(p.business_day_end_hour).toBe(5);
});

it('rejects malformed, reversed, and over-366-day ranges', () => {
  expect(() => parseDailyReportPeriod({ startDate: 'bad', endDate: '2026-07-14' })).toThrow('Invalid report date.');
  expect(() => parseDailyReportPeriod({ startDate: '2026-02-30', endDate: '2026-03-01' })).toThrow('Invalid report date.');
  expect(() => parseDailyReportPeriod({ startDate: '2026-07-15', endDate: '2026-07-14' })).toThrow('End date must not be before start date.');
  expect(() => parseDailyReportPeriod({ startDate: '2025-01-01', endDate: '2026-07-14' })).toThrow('Report range cannot exceed 366 days.');
});
```

- [ ] **Step 2: Run tests and confirm missing module failure**

Run: `npx vitest run backend/tests/unit/dailyReportPeriod.test.js`

Expected: FAIL with module-not-found for `dailyReportPeriod`.

- [ ] **Step 3: Implement exact period parser**

```js
const {
  addBusinessDays,
  getBusinessDate,
  getBusinessDateRange,
  getBusinessDayStartHour,
} = require('../utils/businessDate');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERIOD_DAYS = 366;

function isValidDateOnly(value) {
  if (!DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function daysBetween(startDate, endDate) {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
}

function invalidPeriod(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseDailyReportPeriod({ startDate, endDate, defaultDate = getBusinessDate() } = {}) {
  const start = String(startDate || defaultDate);
  const end = String(endDate || start);
  if (!isValidDateOnly(start) || !isValidDateOnly(end)) throw invalidPeriod('Invalid report date.');
  const span = daysBetween(start, end);
  if (span < 0) throw invalidPeriod('End date must not be before start date.');
  if (span >= MAX_PERIOD_DAYS) throw invalidPeriod('Report range cannot exceed 366 days.');
  const range = getBusinessDateRange(start, end);
  const startHour = getBusinessDayStartHour();
  return {
    start_date: start,
    end_date: end,
    is_single_day: start === end,
    business_start_at: range.start,
    business_end_at: range.end,
    business_day_start_hour: startHour,
    business_day_end_hour: (startHour + 23) % 24,
    comparison_start_date: addBusinessDays(start, -7),
    comparison_end_date: addBusinessDays(end, -7),
  };
}

module.exports = { MAX_PERIOD_DAYS, daysBetween, parseDailyReportPeriod };
```

- [ ] **Step 4: Write failing event-math tests**

```js
const { allocateRefundPayment, combineFinancialEvents, buildComparison } = require('../../services/dailyReportBuilder');

it('puts a Tuesday refund against Tuesday without restating Monday sales', () => {
  expect(combineFinancialEvents(
    { sales_processed: 100, tax: 10, cash: 100, card: 0, orders: 2 },
    { refunds_issued: 20, tax_refunded: 2, refund_cash: 20, refund_card: 0 }
  )).toMatchObject({
    sales_collected: 80,
    net_revenue_pre_tax: 72,
    tax_collected: 8,
    cash_collected: 80,
    total_orders: 2,
    average_ticket: 50,
  });
});

it('returns null percent when prior comparison is zero', () => {
  expect(buildComparison({ sales_collected: 10 }, { sales_collected: 0 }).sales_collected)
    .toEqual({ amount: 10, percent: null });
});

it('allocates a split refund by the original frozen tender mix and preserves cents', () => {
  expect(allocateRefundPayment(
    { amount_refunded: 10.01, refund_method: 'split' },
    { total: 100, cash_amount: 60, card_amount: 40 }
  )).toEqual({ cash: 6.01, card: 4.00 });
});
```

- [ ] **Step 5: Implement pure math helpers in `dailyReportBuilder.js`**

Use integer-cent rounding through existing `roundMoney` from `backend/services/PosCalculator.js`. `average_ticket` is `sales_processed / orders`, not refund-adjusted Sales Collected divided by orders.

`allocateRefundPayment` assigns cash/card methods entirely to that tender. For `split`, divide by the original order's `cash_amount / (cash_amount + card_amount)`, round cash once, and assign the refund remainder to card. If one original side is zero, assign the whole event to the nonzero side; reject impossible zero-tender split data instead of silently fabricating a 50/50 split.

- [ ] **Step 6: Run unit tests**

Run: `npx vitest run backend/tests/unit/dailyReportPeriod.test.js backend/tests/unit/dailyReportMath.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/services/dailyReportPeriod.js backend/services/dailyReportBuilder.js backend/tests/unit/dailyReportPeriod.test.js backend/tests/unit/dailyReportMath.test.js
git commit -m "feat: define daily report event ledger"
```

---

### Task 2: Build Summary API Around Event Dates

**Files:**
- Modify: `backend/services/dailyReportBuilder.js`
- Modify: `backend/routes/admin/reports.js`
- Create: `backend/tests/integration/dailyReportsSummary.test.js`

**Interfaces:**
- Consumes: `parseDailyReportPeriod` from Task 1.
- Produces: `buildDailySummary(executor, period)` with Final Data Contract shape.
- Produces: `GET /api/admin/reports/summary`.

- [ ] **Step 1: Write cross-day refund integration test**

Seed Monday sale and Tuesday refund directly, then assert Monday remains stable and Tuesday owns refund:

```js
const monday = await request(app)
  .get('/api/admin/reports/summary?start_date=2026-07-06&end_date=2026-07-06')
  .set('Cookie', adminCookie);
const tuesday = await request(app)
  .get('/api/admin/reports/summary?start_date=2026-07-07&end_date=2026-07-07')
  .set('Cookie', adminCookie);

expectMoney(monday.body.summary.sales_processed, 100);
expectMoney(monday.body.summary.refunds_issued, 0);
expectMoney(monday.body.summary.sales_collected, 100);
expectMoney(tuesday.body.summary.sales_processed, 0);
expectMoney(tuesday.body.summary.refunds_issued, 20);
expectMoney(tuesday.body.summary.sales_collected, -20);
```

- [ ] **Step 2: Add failing tests for service charge, payments, comparison, and cash state**

Assertions must prove:

```js
expectMoney(body.summary.service_charges_collected, 5.80);
expectMoney(body.summary.cash_collected + body.summary.card_collected, body.summary.sales_collected);
expect(body.comparison.sales_collected).toEqual({ amount: 10, percent: 10 });
expect(body.cash_status).toMatchObject({ state: 'in_progress', open_shifts: 1, actual_cash: null, variance: null });
expect(body.period.business_day_start_hour).toBe(6);
```

- [ ] **Step 3: Run summary integration test and confirm 404/failing contract**

Run: `npx vitest run backend/tests/integration/dailyReportsSummary.test.js`

Expected: FAIL because `/reports/summary` does not exist.

- [ ] **Step 4: Implement sale-event and refund-event aggregates**

Sale aggregate filters paid orders by `paidOrderTimeSql('o')` within selected range and does not join refund rollups. Refund events filter `refunds.created_at` within selected range and `kind='refund'`, join the original order's frozen tender amounts, then aggregate through `allocateRefundPayment` so cash plus card remains equal to Sales Collected, including split refunds.

```sql
SELECT COUNT(o.invoice_id) orders,
       COALESCE(SUM(o.total),0) sales_processed,
       COALESCE(SUM(o.tax),0) tax,
       COALESCE(SUM(CASE
         WHEN o.payment_method='cash' THEN o.total
         WHEN o.payment_method='split' THEN COALESCE(o.cash_amount,0)
         ELSE 0 END),0) cash,
       COALESCE(SUM(CASE
         WHEN o.payment_method='card' THEN o.total
         WHEN o.payment_method='split' THEN COALESCE(o.card_amount,0)
         ELSE 0 END),0) card
FROM orders o
WHERE COALESCE(o.invoice_issued_at,o.created_at) >= ?
  AND COALESCE(o.invoice_issued_at,o.created_at) < ?
  AND o.payment_method NOT IN ('unpaid_table','voided')
```

```sql
SELECT r.id, r.amount_refunded, r.tax_refunded, r.refund_method,
       o.total AS original_total, o.payment_method AS original_payment_method,
       o.cash_amount AS original_cash_amount, o.card_amount AS original_card_amount
FROM refunds r
JOIN orders o ON o.invoice_id=r.invoice_id
WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
```

- [ ] **Step 5: Implement discounts, voids, service charge, order types, hourly sales, and cash status**

Rules:

- Discounts are calculated only from sale events in range; later refunds do not rewrite prior discount totals.
- Calculate sale-time order discounts with raw `orderDiscountApplied('o')` and parent-line discounts from raw `order_items` using `lineSubtotalBeforeOrderDiscount` with `parent_item_id IS NULL`; do not use `ACTIVE_ORDER_DISCOUNT_SUMS` or `REFUND_NETTED_ORDER_ITEMS` in this event ledger.
- Tax and pre-tax revenue use frozen `orders.tax`/`refunds.tax_refunded`; never infer embedded tax that the checkout intentionally stored as zero for a tax-inclusive-at-sale order.
- Service-charge sale rows use `oi.note='Auto-Gratuity'`, `oi.parent_item_id IS NULL`; return rows use `ri.note='Auto-Gratuity'` and refund event range.
- Order types show sold, returned, net; return attribution comes from original order.
- Hourly chart shows sales processed by settlement hour only, orders buckets from configured business-day start through the following hour cycle, and fills empty hours with zero. Caption states refunds are separate.
- Cash status uses shift-scoped refunds and frozen closed-shift expected/actual values. Any open shift makes totals provisional.
- Cash-state precedence is exact: `in_progress` when any shift is open; otherwise `no_shifts` when none closed; otherwise `review` when any closed shift has nonzero cent-rounded variance; otherwise `balanced`.

- [ ] **Step 6: Add route before legacy `/reports` handler**

```js
router.get('/reports/summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const period = parseDailyReportPeriod({ startDate: req.query.start_date, endDate: req.query.end_date });
    return sendSuccess(res, await buildDailySummary(pool, period));
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) logAdminRouteError(req, error);
    return sendError(res, status, error.message);
  }
});
```

- [ ] **Step 7: Run focused summary tests**

Run: `npx vitest run backend/tests/unit/dailyReportMath.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/businessDayReconciliation.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/services/dailyReportBuilder.js backend/routes/admin/reports.js backend/tests/integration/dailyReportsSummary.test.js
git commit -m "feat: add guided daily summary API"
```

---

### Task 3: Build Sales Details API Without Bundle Or Service-Charge Pollution

**Files:**
- Create: `backend/services/dailySalesDetailsBuilder.js`
- Create: `backend/tests/integration/dailyReportsSalesDetails.test.js`
- Modify: `backend/routes/admin/reports.js`

**Interfaces:**
- Consumes: period object from `parseDailyReportPeriod`.
- Produces: `buildDailySalesDetails(executor, period)`.
- Produces: `GET /api/admin/reports/sales-details`.

- [ ] **Step 1: Write failing sales/return contract test**

Seed five Tuesday burger sales plus one Tuesday refund of a Monday burger. Assert:

```js
const burger = res.body.products.find(row => row.item_name === 'Test Burger');
expect(Number(burger.sold_qty)).toBe(5);
expect(Number(burger.returned_qty)).toBe(1);
expectMoney(burger.sold_amount, 29);
expectMoney(burger.returned_amount, 5.8);
expectMoney(burger.net_sales, 23.2);
```

- [ ] **Step 2: Add failing hierarchy, service-charge, and bundle tests**

```js
expect(res.body.categories[0].subcategories[0].name).toBe('Burgers');
expect(res.body.products.some(row => row.item_name === '10% Service Charge')).toBe(false);
expectMoney(res.body.totals.service_charges_collected, 5.8);
expect(res.body.products.filter(row => row.item_name === 'Family Package')).toHaveLength(1);
expectMoney(res.body.products.find(row => row.item_name === 'Family Package').sold_amount, 12.00); // frozen parent price includes modifier surcharge
expect(res.body.products.some(row => row.item_name === 'Bundle Child')).toBe(false);
expect(res.body.products.some(row => row.item_name === 'Refunded Bundle Child')).toBe(false);
```

- [ ] **Step 3: Run test and confirm missing endpoint**

Run: `npx vitest run backend/tests/integration/dailyReportsSalesDetails.test.js`

Expected: FAIL with 404.

- [ ] **Step 4: Implement unioned sale/return event rows**

Use one `UNION ALL` per dimension, then aggregate in JS or outer SQL. Sale lines require `oi.parent_item_id IS NULL` and exclude only `oi.note='Auto-Gratuity'`. Refund lines join their frozen source `order_items` row, require `source_oi.parent_item_id IS NULL`, require `r.kind='refund'` in the refund-event range, and exclude `ri.note='Auto-Gratuity'`.

```js
const saleSql = `
SELECT product_id, item_name, category_id,
       SUM(sold_qty) sold_qty, SUM(returned_qty) returned_qty,
       SUM(sold_amount) sold_amount, SUM(returned_amount) returned_amount
FROM (
  SELECT oi.product_id, COALESCE(oi.item_name,p.name,'Custom Item') item_name, p.category_id,
         SUM(oi.quantity) sold_qty, 0 returned_qty,
         SUM(${lineSubtotalAfterOrderDiscount('oi', 'o')} + COALESCE(oi.tax_amount,0)) sold_amount,
         0 returned_amount
  FROM order_items oi
  JOIN orders o ON o.invoice_id=oi.invoice_id
  LEFT JOIN products p ON p.id=oi.product_id
  WHERE COALESCE(o.invoice_issued_at,o.created_at) >= ?
    AND COALESCE(o.invoice_issued_at,o.created_at) < ?
    AND o.payment_method NOT IN ('unpaid_table','voided')
    AND oi.parent_item_id IS NULL
    AND COALESCE(oi.note,'') <> 'Auto-Gratuity'
  GROUP BY oi.product_id, COALESCE(oi.item_name,p.name,'Custom Item'), p.category_id
  UNION ALL
  SELECT COALESCE(ri.product_id,source_oi.product_id) product_id,
         COALESCE(ri.item_name,source_oi.item_name,p.name,'Custom Item') item_name,
         p.category_id,
         0, SUM(ri.quantity), 0, SUM(ri.line_total)
  FROM refund_items ri
  JOIN refunds r ON r.id=ri.refund_id
  JOIN order_items source_oi ON source_oi.id=ri.order_item_id
  LEFT JOIN products p ON p.id=COALESCE(ri.product_id,source_oi.product_id)
  WHERE r.kind='refund' AND r.created_at >= ? AND r.created_at < ?
    AND source_oi.parent_item_id IS NULL
    AND COALESCE(ri.note,'') <> 'Auto-Gratuity'
  GROUP BY COALESCE(ri.product_id,source_oi.product_id),
           COALESCE(ri.item_name,source_oi.item_name,p.name,'Custom Item'), p.category_id
) events
GROUP BY product_id,item_name,category_id
`;
```

The sale line expression must use stored discounted line subtotal plus stored line tax. Apply order discount allocation with existing `lineSubtotalAfterOrderDiscount`; never recompute catalog price.

- [ ] **Step 5: Build category tree and common dimension rows**

Reuse a cycle-safe root resolver. Build recursive `subcategories`, sort sibling nodes descending by `net_sales`, create full product `category_path` strings, and put missing/orphaned/cyclic attribution under localized `Uncategorized` instead of dropping money. Retain zero/negative rows when a selected period contains returns without new sales.

Order type, cashier, waiter, and table rows use original order attribution for both sale and refund event rows. Refund-page staff remains refund-processor attribution.

- [ ] **Step 6: Hide table/waiter output conditionally**

Read `settings.tables_enabled`; return `tables_enabled: false`, `waiters: []`, and `tables: []` when disabled.

- [ ] **Step 7: Add route and run tests**

Run: `npx vitest run backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/categoryItemsReport.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/services/dailySalesDetailsBuilder.js backend/routes/admin/reports.js backend/tests/integration/dailyReportsSalesDetails.test.js
git commit -m "feat: add event-based sales details API"
```

---

### Task 4: Make Refunds Neutral, Guided, And Fully Printable

**Files:**
- Create: `backend/services/dailyRefundReportBuilder.js`
- Modify: `backend/routes/admin/reports.js`
- Modify: `backend/tests/integration/reportsRefunds.test.js`

**Interfaces:**
- Produces: `buildRefundReport(executor, period, filters)`.
- Produces: `buildRefundPrintData(executor, period)`.
- Updates: `GET /api/admin/reports/refunds`.
- Produces: `GET /api/admin/reports/refunds/print-data`.

- [ ] **Step 1: Replace outlier expectations with neutral facts**

```js
expect(staffA).toMatchObject({
  refund_count: 1,
  refund_value: 30,
  void_count: 0,
  void_value: 0,
});
expect(staffA).not.toHaveProperty('is_outlier');
expect(staffA).not.toHaveProperty('refund_rate');
expect(staffA).not.toHaveProperty('staff_sales');
expect(res.body).not.toHaveProperty('trend');
```

- [ ] **Step 2: Add full-print endpoint test**

```js
const print = await request(app)
  .get(`/api/admin/reports/refunds/print-data?start_date=${REFUND_DATE}&end_date=${REFUND_DATE}`)
  .set('Cookie', adminCookie);

expect(print.statusCode).toBe(200);
expect(print.body.events).toHaveLength(2);
expect(print.body.events[0]).toMatchObject({ cashier_name: expect.any(String), reason: expect.any(String) });
expect(print.body.events.flatMap(event => event.items)).not.toHaveLength(0);
```

- [ ] **Step 3: Run refund integration tests and confirm failures**

Run: `npx vitest run backend/tests/integration/reportsRefunds.test.js`

Expected: FAIL on removed outlier shape and missing print-data route.

- [ ] **Step 4: Move refund query assembly into builder**

Delete `REFUND_OUTLIER_FACTOR`, team-average calculation, and trend query. Preserve filters `kind`, `user_id`, `method`, `q`, `page`, and `limit` with parameterized SQL; `method` accepts only `cash`, `card`, or `split`.

Compute only overall rate:

```js
const refundRate = salesProcessed > 0
  ? roundMoney((refundTotal / salesProcessed) * 100)
  : null;
```

- [ ] **Step 5: Build unpaginated nested print events in one bounded query set**

Load event headers ordered by `r.created_at ASC, r.id ASC`, then load all `refund_items` using event IDs in one query and group with a `Map`. Do not perform one item query per event.

Select `occurred_at_local` with `DATE_FORMAT(businessLocalTimestampSql('r.created_at'), '%Y-%m-%d %H:%i')`. UI and both print paths display this field; `created_at` stays in the payload only as the raw audit timestamp.

- [ ] **Step 6: Define route order safely**

Register `/reports/refunds/print-data` before `/reports/refunds/:refundId/items` so Express never parses `print-data` as an ID.

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run backend/tests/integration/reportsRefunds.test.js backend/tests/integration/businessDayReconciliation.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/services/dailyRefundReportBuilder.js backend/routes/admin/reports.js backend/tests/integration/reportsRefunds.test.js
git commit -m "refactor: make refund reporting factual"
```

---

### Task 5: Collapse Navigation To Three Report Pages

**Files:**
- Modify: `src/admin/router.js`
- Modify: `src/admin/pageRegistry.js`
- Modify: `src/admin/components/Sidebar.vue`
- Modify: `src/admin/components/ReportsLayout.vue`
- Modify: `src/utils/businessDate.js`
- Modify: `src/utils/__tests__/businessDate.spec.js`
- Create: `src/admin/composables/useDailyReportPage.js`
- Create: `src/admin/composables/useThermalReportPrint.js`
- Create: `src/admin/pages/ReportsSummary.vue` (route-safe loading shell; completed in Task 6)
- Create: `src/admin/pages/ReportsSalesDetails.vue` (route-safe loading shell; completed in Task 7)
- Modify: `src/admin/pages/ReportsRefunds.vue` (route-safe loading shell; completed in Task 8)
- Create: `src/admin/pages/__tests__/dailyReportsNavigation.spec.js`

**Interfaces:**
- Produces route names: `reports-summary`, `reports-sales`, `reports-refunds`.
- Provides injection keys: `dailyReportPeriod`, `dailyReportPrintProvider`, `registerDailyReportPrint`.
- Produces `getBusinessDayStartHour()` and `businessDayWindowLabel(startDate, endDate)` on frontend.
- Migrates stale `admin_current_page` values in `router.js` before `pageNames` validation.

- [ ] **Step 1: Write failing route/source test**

```js
expect(routerSource).toContain("name: 'reports-summary'");
expect(routerSource).toContain("name: 'reports-sales'");
expect(routerSource).toContain("name: 'reports-refunds'");
expect(layoutSource).toContain("label: 'Summary'");
expect(layoutSource).toContain("label: 'Sales Details'");
expect(layoutSource).toContain("label: 'Refunds & Voids'");
expect(layoutSource).not.toContain('reports-invoices');
expect(layoutSource).not.toContain('Print A4');
expect(layoutSource).not.toContain('Export');
```

- [ ] **Step 2: Add configured-window tests**

```js
bd.initBusinessConfig({ business_sql_offset: '+03:00', business_day_start_hour: 6 });
expect(bd.getBusinessDayStartHour()).toBe(6);
expect(bd.businessDayWindowLabel('2026-07-14', '2026-07-14'))
  .toBe('2026-07-14 06:00 → 2026-07-15 05:59');
```

- [ ] **Step 3: Run tests and confirm failures**

Run: `npx vitest run src/utils/__tests__/businessDate.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js`

Expected: FAIL on missing route names/window helpers.

- [ ] **Step 4: Implement new routes and legacy redirects**

```js
children: [
  { path: '/reports-summary', name: 'reports-summary', component: pageLoaders['reports-summary'], meta: { page: 'reports' } },
  { path: '/reports-sales', name: 'reports-sales', component: pageLoaders['reports-sales'], meta: { page: 'reports' } },
  { path: '/reports-refunds', name: 'reports-refunds', component: pageLoaders['reports-refunds'], meta: { page: 'reports' } },
  { path: '/reports-overview', redirect: '/reports-summary' },
  { path: '/reports-products', redirect: '/reports-sales' },
  { path: '/reports-tables', redirect: '/reports-sales' },
  { path: '/reports-staff', redirect: '/reports-sales' },
  { path: '/reports-invoices', redirect: '/orders' },
  { path: '/reports-shifts', redirect: '/shifts' },
]
```

Set the parent `/reports` redirect to `/reports-summary`. Map persisted `reports-overview` to `reports-summary`, product/table/staff routes to `reports-sales`, invoices to `orders`, and report-shifts to `shifts` before `pageNames` validation.

- [ ] **Step 5: Rewrite ReportsLayout responsibilities**

Layout owns:

- three tabs;
- previous/today/next controls when single day;
- disabled Next when selected day equals current business date;
- collapsed custom-period start/end fields, each capped at current business date and validated before navigation;
- selected business-window label;
- one Print button, disabled until active page registers provider;
- session-storage date persistence;
- one shared inline loading/error/retry treatment that keeps the last successful page data visible during refresh;
- no data fetching, A4, print dropdown, or tab animation flourish.

- [ ] **Step 6: Add build-safe route shells**

Create valid Summary and Sales Details components with the shared layout and a localized loading state. Replace the old Refunds component's removed-layout injections with the same route-safe shell. These are real route targets, not empty files; Tasks 6–8 replace their loading bodies with final ledgers. This keeps every new route free of runtime injection errors at this commit boundary.

- [ ] **Step 7: Implement page fetch composable**

`useDailyReportPage(endpoint, period)` watches dates, aborts stale requests, exposes `{ data, loading, error, reload }`, and never replaces good data with an older response.

- [ ] **Step 8: Implement thermal print composable**

Preserve current browser/spooler settings behavior. Input is an async provider returning `{ print_type, ...data }`. Append active admin `language` and `direction` to both paths. Browser stores payload then opens `print_receipt.html`; spooler posts to `api/print/print`. No A4 branch.

- [ ] **Step 9: Run tests and build**

Run: `npx vitest run src/utils/__tests__/businessDate.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js && npm run build:admin`

Expected: PASS and successful Vite build.

- [ ] **Step 10: Commit**

```bash
git add src/admin/router.js src/admin/pageRegistry.js src/admin/components/Sidebar.vue src/admin/components/ReportsLayout.vue src/admin/composables/useDailyReportPage.js src/admin/composables/useThermalReportPrint.js src/admin/pages/ReportsSummary.vue src/admin/pages/ReportsSalesDetails.vue src/admin/pages/ReportsRefunds.vue src/utils/businessDate.js src/utils/__tests__/businessDate.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js
git commit -m "refactor: reduce daily reports to three pages"
```

---

### Task 6: Build Guided Summary Ledger

**Files:**
- Modify: `src/admin/pages/ReportsSummary.vue`
- Create: `src/admin/pages/dailyReportPayloads.js`
- Create: `src/admin/pages/__tests__/dailyReportPayloads.spec.js`
- Modify: `src/admin/pages/Orders.vue`
- Modify: `backend/routes/admin/orders.js`
- Modify: `backend/tests/integration/adminOrdersStats.test.js`

**Interfaces:**
- Consumes: `/api/admin/reports/summary` contract.
- Produces: `buildDailySummaryPrintPayload(report)` returning `daily_summary_report`.
- Produces Order History deep-link contract:
  - discounted orders: `{ name: 'orders', query: { discounted: '1', start_date, end_date } }`;
  - original order: `{ name: 'orders', query: { invoice: invoice_number || undefined, open_invoice_id } }`.

- [ ] **Step 1: Write failing print-payload test**

```js
const payload = buildDailySummaryPrintPayload(reportFixture);
expect(payload.print_type).toBe('daily_summary_report');
expect(payload.report_id).toBe('daily_summary_report:2026-07-14:2026-07-14');
expect(payload.summary.sales_collected).toBe(130);
expect(payload.period.business_day_start_hour).toBe(6);
expect(payload.cash_status.state).toBe('balanced');
```

- [ ] **Step 2: Implement pure payload builder and run test**

Run: `npx vitest run src/admin/pages/__tests__/dailyReportPayloads.spec.js`

Expected: PASS.

- [ ] **Step 3: Implement ledger template in exact reading order**

1. Period/window. Show `Current business day — In progress` only when the range includes the current configured business date; past periods get no false finalized status.
2. Large `Sales Collected` with same-weekday comparison.
3. Formula rows: sales processed, refunds issued, net pre-tax revenue, tax, service charge when nonzero.
4. Cash/card payment reconciliation.
5. Orders and average ticket comparison.
6. Order-type rows.
7. One accessible hourly bar chart.
8. Discounts, refunds, voids with Refunds page and Orders History links.
9. Cash status with `View Shifts` link.

Use plain ledger rows and borders. No four-card KPI strip, gradients, customer blocks, profit blocks, or decorative chart legends.

Render negative Sales Collected with its minus sign and the explanation that refunds exceeded sales processed in the selected period. When comparison percent is `null`, show `No comparable sales last week`, never infinity or a fake 100%.

- [ ] **Step 4: Implement Order History deep links**

Add `discounted=1` support to `GET /api/admin/orders`, meaning “had a nonzero discount when sold.” Filter with raw `orderDiscountApplied('o') > 0` or an `EXISTS` subquery over parent `order_items` whose raw line amount minus `lineSubtotalBeforeOrderDiscount` is positive. Do not use refund-netted active discount sums for this filter: a later full refund must not make a discounted sale disappear. Add integration coverage proving undiscounted orders are excluded, a later-refunded discounted order remains included, and date/payment/cashier/pagination filters still compose.

In `Orders.vue`, read route query once on entry:

- `discounted=1`: load `start_date`/`end_date`, send `discounted=1` to the API, and show a removable `Discounted orders` filter chip.
- `open_invoice_id`: clear the default current-day range and call `viewOrder(open_invoice_id)` so the existing Order History modal opens. When public `invoice` exists, also set visible invoice search and fetch the unrestricted matching row; legacy orders without a public invoice number still open directly.

Do not add receipt or invoice UI to Reports. Validate numeric `open_invoice_id` before requesting details. Clear consumed `open_invoice_id` with `router.replace` so activation cannot reopen the modal.

- [ ] **Step 5: Make hourly chart accessible and non-misleading**

Chart uses `sales_processed`, not refund-netted historic order values. Add visible caption `Sales processed by hour. Refunds are shown separately.` and a text fallback list for screen readers.

- [ ] **Step 6: Register active print provider**

On mount/watch, register async provider returning `buildDailySummaryPrintPayload(data.value)`; unregister on unmount so Print cannot send stale previous-page data.

- [ ] **Step 7: Run source tests and build**

Run: `npx vitest run src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js backend/tests/integration/adminOrdersStats.test.js && npm run build:admin`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/admin/pages/ReportsSummary.vue src/admin/pages/Orders.vue src/admin/pages/dailyReportPayloads.js src/admin/pages/__tests__/dailyReportPayloads.spec.js backend/routes/admin/orders.js backend/tests/integration/adminOrdersStats.test.js
git commit -m "feat: add guided daily summary ledger"
```

---

### Task 7: Build One Sales Details Page

**Files:**
- Modify: `src/admin/pages/ReportsSalesDetails.vue`
- Modify: `src/admin/pages/dailyReportPayloads.js`
- Modify: `src/admin/pages/__tests__/dailyReportPayloads.spec.js`

**Interfaces:**
- Consumes: `/api/admin/reports/sales-details` contract.
- Produces: `buildDailySalesPrintPayload(report)` returning `daily_sales_report`.

- [ ] **Step 1: Add failing sales payload assertions**

```js
const payload = buildDailySalesPrintPayload(salesFixture);
expect(payload.print_type).toBe('daily_sales_report');
expect(payload.report_id).toBe('daily_sales_report:2026-07-14:2026-07-14');
expect(payload.categories[0].subcategories[0].name).toBe('Burgers');
expect(payload.products[0]).toMatchObject({ sold_qty: 5, returned_qty: 1, net_sales: 28 });
expect(payload.products.some(row => row.item_name === 'Service Charge')).toBe(false);
```

- [ ] **Step 2: Implement payload builder and run test**

Run: `npx vitest run src/admin/pages/__tests__/dailyReportPayloads.spec.js`

Expected: PASS.

- [ ] **Step 3: Implement guided page sections**

Reading order:

1. Reconciliation header: Sales Collected, menu sales, service charge.
2. Parent category rows; expand in place for subcategories.
3. Product table with `Product`, `Category`, `Sold`, `Returned`, `Net Sales`.
4. Compact order-type section.
5. Cashiers.
6. Waiters and tables only when enabled/data exists.

Product search and category filter stay immediately above product table. Default sort is net sales descending. Do not add separate inner tabs.

Show one quiet reconciliation note: `Amounts include tax. Returns are counted when issued. Service charges are shown separately.`

- [ ] **Step 4: Handle negative and empty event rows clearly**

Returns-only row remains visible with sold `0`, returned quantity positive, and negative net sales. Empty range renders one sentence, not multiple empty cards.

- [ ] **Step 5: Register complete print provider**

Provider prints all API rows, not currently searched/filtered screen subset.

- [ ] **Step 6: Run tests and build**

Run: `npx vitest run src/admin/pages/__tests__/dailyReportPayloads.spec.js && npm run build:admin`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/admin/pages/ReportsSalesDetails.vue src/admin/pages/dailyReportPayloads.js src/admin/pages/__tests__/dailyReportPayloads.spec.js
git commit -m "feat: add consolidated sales details page"
```

---

### Task 8: Rewrite Refunds & Voids Screen Around Investigation Flow

**Files:**
- Modify: `src/admin/pages/ReportsRefunds.vue`
- Modify: `src/admin/pages/dailyReportPayloads.js`
- Modify: `src/admin/pages/__tests__/dailyReportPayloads.spec.js`

**Interfaces:**
- Consumes: paginated refund endpoint for screen.
- Consumes: `/api/admin/reports/refunds/:refundId/items` on first row expansion and caches by refund ID.
- Consumes: `/api/admin/reports/refunds/print-data` only when Print is requested.
- Produces: `buildDailyRefundPrintPayload(report)` returning `daily_refunds_report`.

- [x] **Step 1: Add failing full-refund payload test**

```js
const payload = buildDailyRefundPrintPayload(refundPrintFixture);
expect(payload.print_type).toBe('daily_refunds_report');
expect(payload.report_id).toBe('daily_refunds_report:2026-07-14:2026-07-14');
expect(payload.events[0]).toMatchObject({
  kind: 'refund',
  cashier_name: 'Cashier',
  reason: 'Wrong item',
});
expect(payload.events[0].items[0].item_name).toBe('Burger');
```

- [x] **Step 2: Rewrite screen in exact investigation order**

1. Refund amount/rate against sales processed.
2. Refund vs void counts/values.
3. Cash vs card returned.
4. Top reasons.
5. Neutral activity by staff.
6. Filtered audit log.

Delete sparkline, `Staff Watch`, `All normal`, team-average text, warning colors for staff, and Export button.

When `refund_rate` is `null`, show `No sales processed in this period`. Label void value as `Voided item value — no money returned` on screen and thermal output.

- [x] **Step 3: Keep focused audit-log interactions**

Row click expands affected items, reason, staff, method, time, and amount. Add `Open original order` action using the Task 6 contract `{ name: 'orders', query: { invoice: event.invoice_number || undefined, open_invoice_id: event.invoice_id } }`. Do not render receipt preview, print invoice, or A4 actions.

Fetch affected items only on first expansion, cache successful results by `refund_id`, and show a row-local retry state on failure. A slow response for one row must not overwrite another row's state.

- [x] **Step 4: Register async full-print provider**

Provider fetches `refunds/print-data` for selected period, then builds payload. It does not reuse current 50-row page.

- [x] **Step 5: Run tests and build**

Run: `npx vitest run src/admin/pages/__tests__/dailyReportPayloads.spec.js backend/tests/integration/reportsRefunds.test.js && npm run build:admin`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/admin/pages/ReportsRefunds.vue src/admin/pages/dailyReportPayloads.js src/admin/pages/__tests__/dailyReportPayloads.spec.js
git commit -m "refactor: guide refund investigations"
```

---

### Task 9: Implement Matching 80 mm Browser And Spooler Reports

The deployable spooler source is the user-confirmed ignored directory `C:\xampp\htdocs\posapp\pos-spooler-printer`; edit and verify it in place even though Git will not stage those files.

**Files:**
- Modify: `backend/routes/print.js`
- Modify: `backend/tests/unit/print.unit.test.js`
- Modify: `backend/tests/unit/printJobIdentity.test.js`
- Modify: `src/print/PrintReceiptApp.vue`
- Modify: `src/print/__tests__/reportPrintBranches.spec.js`
- Modify: `pos-spooler-printer/report-html.js` (ignored local deployment source)
- Modify: `pos-spooler-printer/server.js` (ignored local deployment source)
- Modify: `pos-spooler-printer/tests/report-html.test.js` (ignored local deployment source)
- Modify: `docs/SPOOLER-CHANGES.md`

**Interfaces:**
- Consumes three thermal types defined above.
- Produces content-equivalent browser and spooler receipts.

- [x] **Step 1: Replace old print-branch test**

```js
const reportTypes = ['daily_summary_report', 'daily_sales_report', 'daily_refunds_report'];
for (const type of reportTypes) expect(source).toContain(`printType === '${type}'`);
for (const oldType of ['report_overview','report_products','report_tables','report_staff','report_invoices','report_shifts']) {
  expect(source).not.toContain(`printType === '${oldType}'`);
}
```

- [x] **Step 2: Add nested sanitizer test**

Post hostile category, product, staff, reason, and item strings. Assert queued payload contains stripped/sanitized values for every nested collection and preserves numbers.

Extend `printJobIdentity.test.js` to pass each new type with a fixed `report_id`, printer, and request ID; assert the key uses the existing `report:<type>:<report_id>` path. No production identity change is expected because every new type already ends in `_report`.

- [x] **Step 3: Run print tests and confirm failures**

Run: `npx vitest run src/print/__tests__/reportPrintBranches.spec.js backend/tests/unit/print.unit.test.js`

Expected: FAIL on missing new types and sanitizer paths.

- [x] **Step 4: Update backend print whitelist and sanitizer**

Add all three types to receipt-printer routing and admin-only report authorization. Sanitize:

- top-level `report_id`; `period` date/window strings; enum-like `language`, `direction`, cash state, payment key, event kind, and refund method;
- `categories[].name` and recursively nested `subcategories[].name` at any depth;
- `products[].item_name`, `category_path`;
- `order_types[].name`;
- `cashiers[].name`, `waiters[].name`;
- `tables[].table_number`, `section_name`;
- `by_staff[].name`, `top_reasons[].reason`;
- `events[].cashier_name`, `reason`, invoice display fields;
- `events[].items[].item_name`, `note`.

Restrict `language` to `en|ar` and derive `direction` server-side from language. Preserve finite numeric values; reject non-finite numbers instead of stringifying them.

- [x] **Step 5: Build browser templates**

All templates use `$t`, current document direction, configured period window, two-decimal money, compact 80 mm rows, dashed section dividers, and no chart graphics. Keep `src/print.css` at `@page { size: 80mm auto; }`; do not add a 58 mm or A4 report mode.

Summary is deliberately short: ledger totals, payments, orders, exceptions, and cash status—no hourly chart or product list. Add the note `Refunds are counted when issued.` Sales prints each category → recursive subcategory → its products, followed by order types → staff/tables, with the note `Product and category amounts include tax. Service charges are shown separately.` Refunds prints summary → staff/reasons → every event and its items.

- [x] **Step 6: Add escaped spooler renderers**

Extend `renderReportSection` mapping:

```js
const renderers = {
  daily_summary_report: renderDailySummary,
  daily_sales_report: renderDailySales,
  daily_refunds_report: renderDailyRefunds,
};
```

Compute `refund_cash` and `refund_card` with Task 1's `allocateRefundPayment`, including `split` events, so Refunds and Summary use identical tender math.

Every interpolated string must pass `escapeHtml`. Keep render functions in `report-html.js`, not inline in `server.js`.

Add a local `LABELS` map for English and Arabic report labels, choose it from sanitized `data.language`, and wrap each report in `<section dir="ltr|rtl">`. Data values remain escaped and unchanged. The spooler must not depend on browser i18n globals.

- [x] **Step 7: Route spooler types**

Replace old report-type array in ignored `server.js` with three new types plus still-supported `audit_report` and `category_items_report` branches. Do not remove official audit/category-item printing used by Shifts.

- [x] **Step 8: Test ignored spooler source directly**

Run:

```bash
node pos-spooler-printer/tests/report-html.test.js
node --check pos-spooler-printer/report-html.js
node --check pos-spooler-printer/server.js
```

Expected: `report-html tests passed`; tests assert English, Arabic `dir="rtl"`, escaped hostile text, every refund event/item, and `80mm` with no `58mm`/A4 report branch. Both syntax checks exit 0.

- [x] **Step 9: Document deployment copy**

Append exact changed file list and verification commands to `docs/SPOOLER-CHANGES.md`. Note `pos-spooler-printer/` is git-ignored and must be copied/restarted on each print machine.

- [x] **Step 10: Run tracked print tests**

Run: `npx vitest run src/print/__tests__/reportPrintBranches.spec.js backend/tests/unit/print.unit.test.js backend/tests/unit/printJobIdentity.test.js`

Expected: PASS.

- [x] **Step 11: Commit tracked files**

```bash
git add backend/routes/print.js backend/tests/unit/print.unit.test.js backend/tests/unit/printJobIdentity.test.js src/print/PrintReceiptApp.vue src/print/__tests__/reportPrintBranches.spec.js docs/SPOOLER-CHANGES.md
git commit -m "feat: add daily report thermal printing"
```

Ignored spooler files are verified but intentionally absent from commit; deployment notes preserve their changes.

---

### Task 10: Remove Seven-Page Legacy And Finish Localization

**Files:**
- Delete legacy files listed in File Map.
- Modify: `assets/js/admin/i18n.js`
- Modify: `backend/tests/integration/reports.test.js`
- Modify: `backend/tests/integration/adminRouting.test.js`
- Modify: `backend/tests/unit/receiptPresentationContract.test.js`

**Interfaces:**
- Removes old monolithic `GET /api/admin/reports` response dependency after all new endpoints pass.
- Keeps legacy URL redirects only.

- [x] **Step 1: Add exact localization keys**

Include English/Arabic for all visible labels, especially:

`Summary`, `Sales Details`, `Refunds & Voids`, `Sales Collected`, `Sales Processed`, `Refunds Issued`, `Net Revenue Before Tax`, `Service Charges Collected`, `Same weekday last week`, `No comparable sales last week`, `Business day`, `Current business day — In progress`, `Custom period`, `Sold`, `Returned`, `Net Sales`, `Uncategorized`, `Discounted orders`, `Open original order`, `Sales processed by hour. Refunds are shown separately.`, `Refunds are counted when issued.`, `Refunds exceeded sales processed in this period.`, `No sales processed in this period`, `Voided item value — no money returned`, `Amounts include tax. Returns are counted when issued. Service charges are shown separately.`, `Product and category amounts include tax. Service charges are shown separately.`, `Cash balanced`, `Shifts need review`, `Shift counting in progress`.

- [x] **Step 2: Delete obsolete pages and print helper**

Delete only files listed in File Map. Remove their loaders/imports/tests. Preserve Order History, Shifts, A4Receipt, audit reports, and category-items print builder.

- [x] **Step 3: Remove old monolithic report queries**

Once summary/sales/refund routes cover all consumers, remove `/reports` response fields `cogs_summary`, `customer_summary`, `top_customers`, `invoices`, `shifts`, truncation flags, and the seven-page print types. Either redirect bare `/reports` API requests to summary builder or return the summary contract directly for compatibility; do not keep duplicate query stacks.

- [x] **Step 4: Update integration/source contracts**

`adminRouting.test.js` expects `/api/admin/reports/summary` and `/api/admin/reports/sales-details`. `receiptPresentationContract.test.js` removes `ReportsInvoices.vue` because Order History remains receipt owner.

- [x] **Step 5: Run placeholder/legacy scan**

Run:

```bash
rg -n "reports-overview|reports-products|reports-tables|reports-staff|reports-invoices|reports-shifts|report_overview|report_products|report_tables|report_staff|report_invoices|report_shifts|Gross Profit|Top Customers|Staff Watch|All normal|Print A4" src/admin backend/routes/print.js src/print
```

Expected: only intentional legacy router redirects or unrelated Order History/Shifts A4 text; no legacy report page/print implementation.

- [x] **Step 6: Run complete verification**

```bash
npx vitest run backend/tests/unit/dailyReportPeriod.test.js backend/tests/unit/dailyReportMath.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/reportsRefunds.test.js backend/tests/integration/businessDayReconciliation.test.js backend/tests/integration/adminOrdersStats.test.js backend/tests/unit/print.unit.test.js backend/tests/unit/printJobIdentity.test.js src/utils/__tests__/businessDate.spec.js src/admin/pages/__tests__/dailyReportsNavigation.spec.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/print/__tests__/reportPrintBranches.spec.js
npm run build:admin
node pos-spooler-printer/tests/report-html.test.js
node --check pos-spooler-printer/report-html.js
node --check pos-spooler-printer/server.js
```

Expected: all tests pass, Vite build succeeds, spooler test prints `report-html tests passed`, syntax check exits 0.

- [x] **Step 7: Manual acceptance test**

Use test data containing cash, card, split payment, order discount, service charge, cross-day refund, void, bundle, waiter/table, balanced shift, and short shift. Verify:

- previous/today/next/custom period behavior;
- configured business window in English and Arabic;
- same-weekday comparison;
- product/category totals reconcile to Sales Collected with service charge separated;
- Monday sale remains unchanged after Tuesday refund;
- Tuesday refund appears in Sales Details and Refunds;
- Orders and Shifts links open correct existing pages;
- discounted Summary link opens Order History with the selected period and discounted-only filter;
- each refund row opens the existing original-order modal in Order History;
- browser thermal and physical spooler output match on 80 mm paper;
- full refund event list prints beyond first 50 screen rows;
- no A4 or CSV action appears.

- [x] **Step 8: Commit**

```bash
git add assets/js/admin/i18n.js backend/routes/admin/reports.js backend/tests/integration/reports.test.js backend/tests/integration/adminRouting.test.js backend/tests/unit/receiptPresentationContract.test.js src/admin src/print
git commit -m "chore: remove legacy daily report pages"
```

---

## Done Definition

- Sidebar opens `Summary` for current business date.
- Only three Daily Reports page tabs exist.
- No invoice or shift workflow is duplicated.
- Event-date refund math is proven by cross-day tests.
- Sales Collected reconciles with cash/card and tax/service-charge breakdown.
- Sales Details reports parent sellable items, nested categories, sold/returned quantities, and tax-inclusive net sales.
- Refunds page is factual, searchable, neutral, and links to Order History.
- One Print action produces complete English/Arabic 80 mm thermal reports in browser and physical spooler.
- Old seven-page routes redirect safely.
- Focused tests, full build, spooler renderer tests, and manual acceptance matrix pass.
