# Category/Subcategory/Items Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the المجموعات (Categories) and الأصناف (Items) sections from the X/Z/Period جرد (audit) thermal report, and move that breakdown — plus a NEW subcategory rollup — into its own dedicated "تقرير الأصناف" (Items Report) button and print template on the Shifts page, available for both a single business date and a date period.

**Architecture:** A brand-new, independent backend builder (`categoryItemsReportBuilder.js`) computes three sections from order/refund data: top-level Categories (rolled up from all descendant subcategories), Subcategories (grouped under their parent category, omitted when a category has no real children), and Items (existing tax-inclusive item breakdown, reused as-is). It is dispatched ad-hoc (no serial number, no persisted document — like the existing Period Report) through a new route, and rendered by a brand-new `print_type` (`category_items_report`) in both print renderers. The existing `audit_report` builder/template loses its `categories`/`items` fields entirely — this is a clean move, not a duplication.

**Tech Stack:** Node.js/Express, mysql2, Vitest + supertest (backend TDD), Vue 3 `<script setup>` templates (frontend, manual verification — no test runner for print templates), a git-ignored Electron/Node spooler (`pos-spooler-printer/server.js`, edited on disk, never committed).

## Global Constraints

- Money is always **tax-inclusive** in these reports (`+ COALESCE(oi.tax_amount, 0)`), net of order-level discounts (`lineSubtotalAfterOrderDiscount`) and net of refunds (`refund_items` join). Never re-add tax anywhere in a renderer — the numbers coming from the backend already include it.
- Money is rounded with `toMoney()` (2 decimals) and quantity with `toQty()` (3 decimals) — copy these two one-line helpers into any new backend file that needs them (this codebase does not share a single money-util module; every service file defines its own, by convention).
- Tests run with `npx vitest run` — **never** `npx jest` (jest gives false failures in this repo).
- `pos-spooler-printer/server.js` is **git-ignored**. Edit it on disk, but **never** `git commit` or `git add -f` it. Only `docs/SPOOLER-CHANGES.md` (a plain-text changelog for manual per-machine deploy) gets committed for that file's changes.
- `pos-spooler-printer/server.js` has **no `escapeHtml` function**. Its `audit_report` block interpolates category/item names raw (no escaping). Match that exact style in the new block — do not call `escapeHtml`, it does not exist there and will crash.
- Do not touch `src/menu/MenuApp.vue` (unrelated customer QR menu — it also has a "categories" concept but is a completely different feature).
- The new report is **ad-hoc**: no `audit_report_documents` row, no serial number, nothing persisted — same as how `/print-period` already works today.
- Every step in this plan that touches `backend/services/auditReportBuilder.js` must not change the behavior of `getStoreInfo`, `getOpenShifts`, `getShiftSections`, or `getOrderTypes` — those are untouched and still fully used by the X/Z/Period audit report.

---

## Orientation: what exists today, in plain terms

Open `backend/services/auditReportBuilder.js` and skim it before starting. Today, `buildAuditReportPayload()` builds ONE payload used by three print flows:
1. **X report** (`POST /api/admin/audit-reports/print` with `report_type: 'x_audit'`) — single business date, serialized (gets a serial number, saved to `audit_report_documents`).
2. **Z report** (same route, `report_type: 'z_audit'`) — same, but is the "official" end-of-day closing report.
3. **Period report** (`POST /api/admin/audit-reports/print-period`) — a date range, NOT serialized, NOT saved anywhere — it just builds the payload and prints it.

All three currently include a `categories` array (from `getCategories()`) and an `items` array (from `getItems()`) in the payload, and both `src/print/PrintReceiptApp.vue` (browser preview) and `pos-spooler-printer/server.js` (thermal spooler) render those two sections under a "المجموعات" / "الأصناف" heading.

**What this plan does:** deletes those two sections from all three of the above (they share one builder and one template, so removing from the builder removes it everywhere at once), and adds a **fourth, brand-new, independent print flow** — "تقرير الأصناف" — that is the only place left showing category/subcategory/item breakdowns. It reuses the same date-range logic (single date or period) as the existing UI already has (the `filterDateFrom`/`filterDateTo`/`isPeriodMode` state on the Shifts page), so no new date-picker UI is needed — just a new button that reads that same state.

**The new hierarchy concept:** the `categories` table has a `parent_id` column (nullable, self-referencing). A category with `parent_id IS NULL` is a "top-level category" (a root). A category with `parent_id NOT NULL` is a "subcategory" of whatever category that `parent_id` points to. Products are assigned to exactly one category via `products.category_id` — that category might itself be a root (parent_id NULL) or a subcategory (parent_id set). Today's `getCategories()` completely ignores this hierarchy — it just groups flatly by whatever category name the product happens to have, mixing root and subcategory names into one flat list. The new report fixes this: it walks each product's category up its `parent_id` chain to find its ultimate root, and:
- **Categories section** = totals per root, aggregating everything below it (its own direct products AND all its subcategories' products).
- **Subcategories section** = for products whose OWN assigned category has a `parent_id` (i.e. it is not itself a root), grouped under their resolved root category, in the same revenue order as the Categories section. A root category that has zero subcategory sales (all its sales came from products assigned directly to the root) simply does not appear in this section at all — its total is still fully counted in the Categories section.

---

## Task 1: New backend builder — `categoryItemsReportBuilder.js`

This task creates the new report's data logic in complete isolation, fully tested, without touching the existing audit report at all (so nothing existing can break in this task).

**Files:**
- Modify: `backend/services/auditReportBuilder.js` (add 2 exports only — no other changes)
- Create: `backend/services/categoryItemsReportBuilder.js`
- Create: `backend/tests/integration/categoryItemsReport.test.js`

**Interfaces:**
- Consumes: `getItems(executor, range)` and `getStoreInfo(executor)`, both already defined inside `auditReportBuilder.js` (this task exports them, does not change their bodies); `getBusinessDayRange`, `getBusinessDateRange` from `backend/utils/businessDate.js`; `lineSubtotalAfterOrderDiscount`, `paidOrderTimeSql` from `backend/routes/admin/helpers.js`.
- Produces: `buildCategoryItemsReportPayload(executor, options)` where `options` is `{ businessDate?, startDate?, endDate?, generatedByUser? }` (exactly the same option shape `buildAuditReportPayload` already accepts for date resolution) returning a payload object shaped:
  ```js
  {
    print_type: 'category_items_report',
    is_period: boolean,
    business_date: string|null,
    period_start_date: string|null,
    period_end_date: string|null,
    business_start_at: string,
    business_end_at: string,
    generated_at: string, // ISO timestamp
    generated_by: { id: number|null, name: string },
    storeInfo: object,
    categories: [{ category_name: string, qty_sold: number, gross_revenue: number }],
    subcategories: [{ category_name: string, rows: [{ category_name: string, qty_sold: number, gross_revenue: number }] }],
    items: [{ item_name: string, qty_sold: number, gross_revenue: number }],
  }
  ```
  This exact shape is what Task 3 (route) and Task 4 (frontend template) will consume.

### Step 1: Export `getItems` and `getStoreInfo` from `auditReportBuilder.js`

Open `backend/services/auditReportBuilder.js`. Find the `module.exports` block at the very end of the file (currently the last 4 lines):

```js
module.exports = {
    buildAuditReportPayload,
    hashPayload,
};
```

Replace it with:

```js
module.exports = {
    buildAuditReportPayload,
    hashPayload,
    getItems,
    getStoreInfo,
};
```

This is the ONLY change to this file in this task. Do not touch `getCategories()`, `buildAuditReportPayload()`, or anything else yet — that happens in Task 2.

- [ ] Make this edit.

### Step 2: Write the failing tests for the new builder

Create `backend/tests/integration/categoryItemsReport.test.js` with this exact content:

```js
const { seedDatabase, SEED } = require('../fixtures/seed');
const pool = require('../../config/db');
const {
    insertShift,
    insertPaidOrder,
    insertOrderItem,
    insertOrderRefund,
} = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');
const { buildCategoryItemsReportPayload } = require('../../services/categoryItemsReportBuilder');

describe('category/subcategory/items report builder', () => {
    beforeEach(async () => {
        await seedDatabase();
    });

    afterAll(async () => {
        await pool.end();
    });

    it('breaks down items by name ordered by tax-inclusive total (business date)', async () => {
        const shiftId = await insertShift(pool, {
            starting_cash: 20.00, expected_cash: 20.00, actual_cash: 20.00,
            status: 'closed', opened_at: '2026-07-01 07:00:00', closed_at: '2026-07-02 02:40:00',
        });

        // One order with two different products.
        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftId, subtotal: 16.00, tax: 1.60, total: 17.60,
            cash_amount: 17.60, card_amount: 0.00,
            created_at: '2026-07-01 08:00:00', invoice_issued_at: '2026-07-01 08:00:00',
        });
        // 2x Test Burger @ 5.00, 16% tax -> line gross = 10.00 + 1.60 = 11.60
        await insertOrderItem(pool, {
            invoice_id: invoiceId, product_id: SEED.product1.id,
            quantity: 2.000, price_at_sale: 5.000000, tax_rate: 16.00, tax_amount: 1.600000,
        });
        // 3x Test Drink @ 2.00, 0% tax -> line gross = 6.00
        await insertOrderItem(pool, {
            invoice_id: invoiceId, product_id: SEED.product2.id,
            quantity: 3.000, price_at_sale: 2.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.print_type).toBe('category_items_report');
        expect(payload.is_period).toBe(false);
        expect(payload.items).toHaveLength(2);
        expect(payload.items[0].item_name).toBe(SEED.product1.name); // 'Test Burger'
        expect(payload.items[0].qty_sold).toBe(2);
        expectMoney(payload.items[0].gross_revenue, 11.60);
        expect(payload.items[1].item_name).toBe(SEED.product2.name); // 'Test Drink'
        expect(payload.items[1].qty_sold).toBe(3);
        expectMoney(payload.items[1].gross_revenue, 6.00);
    });

    it('aggregates item breakdown across a multi-day period and sets is_period', async () => {
        // Day 1: 2x Test Burger (tax-free for simple arithmetic)
        const shiftAId = await insertShift(pool, {
            starting_cash: 10.00, expected_cash: 10.00, actual_cash: 10.00,
            status: 'closed', opened_at: '2026-07-01 08:00:00', closed_at: '2026-07-01 20:00:00',
        });
        const invoiceAId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftAId, subtotal: 10.00, tax: 0.00, total: 10.00,
            cash_amount: 10.00, card_amount: 0.00,
            created_at: '2026-07-01 09:00:00', invoice_issued_at: '2026-07-01 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceAId, product_id: SEED.product1.id,
            quantity: 2.000, price_at_sale: 5.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        // Day 2: 3x Test Burger — same product, must merge with Day 1 in the period rollup.
        const shiftBId = await insertShift(pool, {
            starting_cash: 10.00, expected_cash: 10.00, actual_cash: 10.00,
            status: 'closed', opened_at: '2026-07-02 08:00:00', closed_at: '2026-07-02 20:00:00',
        });
        const invoiceBId = await insertPaidOrder(pool, {
            order_id: 2, shift_id: shiftBId, subtotal: 15.00, tax: 0.00, total: 15.00,
            cash_amount: 15.00, card_amount: 0.00,
            created_at: '2026-07-02 09:00:00', invoice_issued_at: '2026-07-02 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceBId, product_id: SEED.product1.id,
            quantity: 3.000, price_at_sale: 5.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        const payload = await buildCategoryItemsReportPayload(pool, {
            startDate: '2026-07-01', endDate: '2026-07-02',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.is_period).toBe(true);
        expect(payload.business_date).toBeNull();
        expect(payload.items).toHaveLength(1);
        expect(payload.items[0].item_name).toBe(SEED.product1.name);
        expect(payload.items[0].qty_sold).toBe(5);        // 2 + 3 merged across days
        expectMoney(payload.items[0].gross_revenue, 25.00); // 10 + 15
    });

    it('rolls up subcategory sales into their top-level category total, and omits direct-to-root sales from the subcategories section', async () => {
        // SEED.category (id 1, 'Test Category') is a root category (parent_id NULL) that
        // SEED.product1 ('Test Burger') is already directly assigned to.
        // Add a real subcategory under it, and a new product assigned to that subcategory.
        await pool.query(
            "INSERT INTO categories (id, parent_id, name, is_active) VALUES (100, 1, 'Test Subcategory', 1)"
        );
        await pool.query(
            "INSERT INTO products (id, category_id, name, price, tax_rate, is_active, is_bundle) VALUES (100, 100, 'Sub Item', 3.0000, 0, 1, 0)"
        );

        const shiftId = await insertShift(pool, {
            starting_cash: 10.00, expected_cash: 10.00, actual_cash: 10.00,
            status: 'closed', opened_at: '2026-07-01 07:00:00', closed_at: '2026-07-02 02:40:00',
        });

        // Direct-to-root sale: 1x Test Burger @ 5.00, 0% tax -> gross 5.00, assigned to root category 1.
        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftId, subtotal: 5.00, tax: 0.00, total: 5.00,
            cash_amount: 5.00, card_amount: 0.00,
            created_at: '2026-07-01 08:00:00', invoice_issued_at: '2026-07-01 08:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoiceId, product_id: SEED.product1.id,
            quantity: 1.000, price_at_sale: 5.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        // Subcategory sale: 2x Sub Item @ 3.00, 0% tax -> gross 6.00, assigned to subcategory 100 (root 1).
        const invoice2Id = await insertPaidOrder(pool, {
            order_id: 2, shift_id: shiftId, subtotal: 6.00, tax: 0.00, total: 6.00,
            cash_amount: 6.00, card_amount: 0.00,
            created_at: '2026-07-01 09:00:00', invoice_issued_at: '2026-07-01 09:00:00',
        });
        await insertOrderItem(pool, {
            invoice_id: invoice2Id, product_id: 100,
            quantity: 2.000, price_at_sale: 3.000000, tax_rate: 0.00, tax_amount: 0.000000,
        });

        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        // Categories: root total = 5.00 (direct) + 6.00 (subcategory) = 11.00, qty 1 + 2 = 3.
        expect(payload.categories).toHaveLength(1);
        expect(payload.categories[0].category_name).toBe(SEED.category.name);
        expect(payload.categories[0].qty_sold).toBe(3);
        expectMoney(payload.categories[0].gross_revenue, 11.00);

        // Subcategories: exactly one group (the root), containing exactly the subcategory's
        // own row — the direct-to-root Test Burger sale must NOT appear here.
        expect(payload.subcategories).toHaveLength(1);
        expect(payload.subcategories[0].category_name).toBe(SEED.category.name);
        expect(payload.subcategories[0].rows).toHaveLength(1);
        expect(payload.subcategories[0].rows[0].category_name).toBe('Test Subcategory');
        expect(payload.subcategories[0].rows[0].qty_sold).toBe(2);
        expectMoney(payload.subcategories[0].rows[0].gross_revenue, 6.00);
    });

    it('does not double-subtract a pre-checkout item void from the category breakdown (ported audit finding)', async () => {
        const shiftId = await insertShift(pool, {
            starting_cash: 5.00, expected_cash: 5.00, actual_cash: 5.00,
            status: 'closed', opened_at: '2026-07-01 07:00:00', closed_at: '2026-07-02 02:40:00',
        });

        // Order was rung up with 2 units, one got voided on the floor before checkout —
        // order_items.quantity already reflects only the 1 remaining unit (physically
        // shrunk in place), matching what POST /api/pos/refunds intent=void does.
        const invoiceId = await insertPaidOrder(pool, {
            order_id: 1, shift_id: shiftId, subtotal: 5.00, tax: 0.00, total: 5.00,
            cash_amount: 5.00, card_amount: 0.00,
            created_at: '2026-07-01 08:00:00', invoice_issued_at: '2026-07-01 08:00:00',
        });
        const orderItemId = await insertOrderItem(pool, {
            invoice_id: invoiceId, quantity: 1.000, price_at_sale: 5.000000,
            tax_rate: 0.00, tax_amount: 0.000000,
        });

        // The pre-checkout void still leaves its audit trail in refunds/refund_items —
        // a 'void' kind record for the unit that was removed before payment.
        const voidRefundId = await insertOrderRefund(pool, {
            kind: 'void', invoice_id: invoiceId, subtotal_refunded: 5.00, tax_refunded: 0.00,
            amount_refunded: 0.00, refund_method: null, user_id: SEED.cashierUser.id, shift_id: shiftId,
        });
        await pool.query(`
            INSERT INTO refund_items (refund_id, order_item_id, product_id, quantity, unit_price, line_subtotal, line_tax, line_total)
            VALUES (?, ?, ?, 1.000, 5.000000, 5.00, 0.00, 5.00)
        `, [voidRefundId, orderItemId, SEED.product1.id]);

        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        // The category breakdown must match the true remaining sale — not re-subtract the
        // void a second time via refund_items (the 'void' kind must be excluded).
        const categoryTotal = payload.categories.reduce((sum, c) => sum + c.gross_revenue, 0);
        expect(categoryTotal).toBe(5);
        expect(payload.categories[0].qty_sold).toBe(1);
    });
});
```

- [ ] Create this file.

### Step 3: Run the tests to verify they fail

Run: `npx vitest run backend/tests/integration/categoryItemsReport.test.js`

Expected: FAIL — `Cannot find module '../../services/categoryItemsReportBuilder'` (the file doesn't exist yet).

- [ ] Run it, confirm this exact failure mode.

### Step 4: Implement `categoryItemsReportBuilder.js`

Create `backend/services/categoryItemsReportBuilder.js` with this exact content:

```js
const { getBusinessDayRange, getBusinessDateRange } = require('../utils/businessDate');
const { lineSubtotalAfterOrderDiscount, paidOrderTimeSql } = require('../routes/admin/helpers');
const { getItems, getStoreInfo } = require('./auditReportBuilder');

const toMoney = (value) => Number(Number(value || 0).toFixed(2));
const toQty = (value) => Number(Number(value || 0).toFixed(3));

// Walks a category's parent_id chain up to its root (parent_id IS NULL) and returns that
// root's id. Cycle-safe: if a cycle is ever detected (should be impossible — product edits
// already reject cyclical parent_id assignment), the original id is returned as its own root.
function resolveRootId(categoryMap, categoryId) {
    const visited = new Set();
    let currentId = categoryId;
    while (categoryMap.has(currentId) && !visited.has(currentId)) {
        visited.add(currentId);
        const current = categoryMap.get(currentId);
        if (current.parent_id === null) return currentId;
        currentId = current.parent_id;
    }
    return categoryId;
}

async function getCategorySalesByCategoryId(executor, range) {
    const [rows] = await executor.query(`
        SELECT
            p.category_id AS category_id,
            COALESCE(c.name, 'Uncategorized') AS category_name,
            SUM(GREATEST(0, oi.quantity - COALESCE(rfi.rq, 0))) AS qty_sold,
            SUM(GREATEST(0,
                ${lineSubtotalAfterOrderDiscount('oi', 'o')}
                + COALESCE(oi.tax_amount, 0)
                - COALESCE(rfi.rs, 0)
                - COALESCE(rfi.rt, 0)
            )) AS gross_revenue
        FROM order_items oi
        JOIN orders o ON oi.invoice_id = o.invoice_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN (
            SELECT ri.order_item_id, SUM(ri.quantity) AS rq, SUM(ri.line_subtotal) AS rs, SUM(ri.line_tax) AS rt
            FROM refund_items ri
            JOIN refunds r ON r.id = ri.refund_id
            WHERE r.kind = 'refund'
            GROUP BY ri.order_item_id
        ) rfi ON rfi.order_item_id = oi.id
        WHERE ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY p.category_id, COALESCE(c.name, 'Uncategorized')
    `, [range.start, range.end]);
    return rows;
}

async function buildCategorySections(executor, range) {
    const salesRows = await getCategorySalesByCategoryId(executor, range);
    const [categoryRows] = await executor.query('SELECT id, parent_id, name FROM categories');
    const categoryMap = new Map(categoryRows.map(row => [row.id, { name: row.name, parent_id: row.parent_id }]));

    const categoryTotals = new Map(); // rootId (number) or 'uncategorized' -> { category_name, qty_sold, gross_revenue }
    const subcategoryTotals = new Map(); // rootId -> Map(categoryId -> { category_name, qty_sold, gross_revenue })

    for (const row of salesRows) {
        const categoryId = row.category_id;
        const qty = Number(row.qty_sold || 0);
        const revenue = Number(row.gross_revenue || 0);

        if (categoryId === null) {
            const bucket = categoryTotals.get('uncategorized') || { category_name: 'Uncategorized', qty_sold: 0, gross_revenue: 0 };
            bucket.qty_sold += qty;
            bucket.gross_revenue += revenue;
            categoryTotals.set('uncategorized', bucket);
            continue;
        }

        const ownCategory = categoryMap.get(categoryId) || null;
        const rootId = resolveRootId(categoryMap, categoryId);
        const rootInfo = categoryMap.get(rootId);
        const rootName = rootInfo ? rootInfo.name : row.category_name;

        const rootBucket = categoryTotals.get(rootId) || { category_name: rootName, qty_sold: 0, gross_revenue: 0 };
        rootBucket.qty_sold += qty;
        rootBucket.gross_revenue += revenue;
        categoryTotals.set(rootId, rootBucket);

        const isOwnCategoryARoot = ownCategory ? ownCategory.parent_id === null : true;
        if (!isOwnCategoryARoot) {
            if (!subcategoryTotals.has(rootId)) subcategoryTotals.set(rootId, new Map());
            const subMap = subcategoryTotals.get(rootId);
            const subBucket = subMap.get(categoryId) || { category_name: row.category_name, qty_sold: 0, gross_revenue: 0 };
            subBucket.qty_sold += qty;
            subBucket.gross_revenue += revenue;
            subMap.set(categoryId, subBucket);
        }
    }

    const rootIds = [...categoryTotals.keys()].sort(
        (a, b) => categoryTotals.get(b).gross_revenue - categoryTotals.get(a).gross_revenue
    );

    const categories = rootIds.map(rootId => {
        const bucket = categoryTotals.get(rootId);
        return {
            category_name: bucket.category_name,
            qty_sold: toQty(bucket.qty_sold),
            gross_revenue: toMoney(bucket.gross_revenue),
        };
    });

    const subcategories = rootIds
        .filter(rootId => subcategoryTotals.has(rootId))
        .map(rootId => ({
            category_name: categoryTotals.get(rootId).category_name,
            rows: [...subcategoryTotals.get(rootId).values()]
                .sort((a, b) => b.gross_revenue - a.gross_revenue)
                .map(sub => ({
                    category_name: sub.category_name,
                    qty_sold: toQty(sub.qty_sold),
                    gross_revenue: toMoney(sub.gross_revenue),
                })),
        }));

    return { categories, subcategories };
}

async function buildCategoryItemsReportPayload(executor, options) {
    const isPeriod = Boolean(options.startDate);
    const businessDate = options.businessDate || null;
    const periodStartDate = isPeriod ? options.startDate : null;
    const periodEndDate = isPeriod ? (options.endDate || options.startDate) : null;
    const range = isPeriod
        ? getBusinessDateRange(periodStartDate, periodEndDate)
        : getBusinessDayRange(businessDate);

    const [storeInfo, sections, items] = await Promise.all([
        getStoreInfo(executor),
        buildCategorySections(executor, range),
        getItems(executor, range),
    ]);

    return {
        print_type: 'category_items_report',
        is_period: isPeriod,
        business_date: businessDate,
        period_start_date: periodStartDate,
        period_end_date: periodEndDate,
        business_start_at: range.start,
        business_end_at: range.end,
        generated_at: new Date().toISOString(),
        generated_by: {
            id: options.generatedByUser?.id || null,
            name: options.generatedByUser?.name || 'Unknown',
        },
        storeInfo,
        categories: sections.categories,
        subcategories: sections.subcategories,
        items,
    };
}

module.exports = {
    buildCategoryItemsReportPayload,
};
```

- [ ] Create this file.

### Step 5: Run the tests to verify they pass

Run: `npx vitest run backend/tests/integration/categoryItemsReport.test.js`

Expected: PASS — all 4 tests green.

- [ ] Run it, confirm PASS. If any test fails, re-read the failure message carefully before changing anything — do not guess.

### Step 6: Commit

```bash
git add backend/services/auditReportBuilder.js backend/services/categoryItemsReportBuilder.js backend/tests/integration/categoryItemsReport.test.js
git commit -m "feat(reports): add category/subcategory/items report builder"
```

- [ ] Commit.

---

## Task 2: Strip categories/items out of the existing audit report builder

Now that the new builder fully covers this data (Task 1, already tested and committed), remove it from the old shared audit report so X/Z/Period stop showing it.

**Files:**
- Modify: `backend/services/auditReportBuilder.js`
- Modify: `backend/tests/integration/auditReports.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildAuditReportPayload()`'s returned payload no longer has `categories` or `items` keys. Every other key is unchanged.

### Step 1: Delete `getCategories()` and its call site

In `backend/services/auditReportBuilder.js`, delete the entire `getCategories` function (currently lines 168-201 — from `async function getCategories(executor, range) {` through the closing `}` right before `async function getItems`):

```js
async function getCategories(executor, range) {
    const [rows] = await executor.query(`
        SELECT
            COALESCE(c.name, 'Uncategorized') AS category_name,
            SUM(GREATEST(0, oi.quantity - COALESCE(rfi.rq, 0))) AS qty_sold,
            SUM(GREATEST(0,
                ${lineSubtotalAfterOrderDiscount('oi', 'o')}
                + COALESCE(oi.tax_amount, 0)
                - COALESCE(rfi.rs, 0)
                - COALESCE(rfi.rt, 0)
            )) AS gross_revenue
        FROM order_items oi
        JOIN orders o ON oi.invoice_id = o.invoice_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN (
            SELECT ri.order_item_id, SUM(ri.quantity) AS rq, SUM(ri.line_subtotal) AS rs, SUM(ri.line_tax) AS rt
            FROM refund_items ri
            JOIN refunds r ON r.id = ri.refund_id
            WHERE r.kind = 'refund'
            GROUP BY ri.order_item_id
        ) rfi ON rfi.order_item_id = oi.id
        WHERE ${paidOrderTimeSql('o')} >= ? AND ${paidOrderTimeSql('o')} < ?
          AND o.payment_method NOT IN ('unpaid_table', 'voided')
        GROUP BY COALESCE(c.name, 'Uncategorized')
        ORDER BY gross_revenue DESC
    `, [range.start, range.end]);

    return rows.map(row => ({
        category_name: row.category_name,
        qty_sold: toQty(row.qty_sold),
        gross_revenue: toMoney(row.gross_revenue),
    }));
}

```

Delete that whole block (leave `getItems` and everything else untouched).

- [ ] Make this deletion.

### Step 2: Remove `categories`/`items` from the `Promise.all` destructure and call list

Find this block inside `buildAuditReportPayload`:

```js
    const [
        storeInfo,
        summary,
        shifts,
        categories,
        items,
        orderTypes,
        openShifts,
    ] = await Promise.all([
        getStoreInfo(executor),
        getFinancialMetricsForRange(executor, { start: range.start, end: range.end }),
        getShiftSections(executor, range),
        getCategories(executor, range),
        getItems(executor, range),
        getOrderTypes(executor, range),
        getOpenShifts(executor, range),
    ]);
```

Replace it with:

```js
    const [
        storeInfo,
        summary,
        shifts,
        orderTypes,
        openShifts,
    ] = await Promise.all([
        getStoreInfo(executor),
        getFinancialMetricsForRange(executor, { start: range.start, end: range.end }),
        getShiftSections(executor, range),
        getOrderTypes(executor, range),
        getOpenShifts(executor, range),
    ]);
```

- [ ] Make this edit.

### Step 3: Remove `categories`/`items` from the payload object

Find this block (still inside `buildAuditReportPayload`):

```js
        shifts,
        categories,
        items,
        order_types: orderTypes,
```

Replace it with:

```js
        shifts,
        order_types: orderTypes,
```

- [ ] Make this edit.

### Step 4: Update the existing test file — remove stale assertions

Open `backend/tests/integration/auditReports.test.js`.

**4a.** In the test `'builds a business-date audit payload from authoritative report math'`, find these 4 lines near the end of the test body:

```js
        expect(payload.categories).toHaveLength(1);
        expect(payload.categories[0].category_name).toBe(SEED.category.name);
        expect(payload.categories[0].qty_sold).toBe(2);
        expectMoney(payload.categories[0].gross_revenue, 11.60);
        expect(payload.payload_hash).toMatch(/^[a-f0-9]{64}$/);
```

Replace with just:

```js
        expect(payload.payload_hash).toMatch(/^[a-f0-9]{64}$/);
```

**4b.** Delete the entire test `it('breaks down items by name ordered by tax-inclusive total (business date)', ...)` — this logic is now covered by `categoryItemsReport.test.js` (Task 1, Step 2). It runs from `it('breaks down items by name ordered by tax-inclusive total (business date)', async () => {` through the matching closing `});` right before `it('aggregates item breakdown across a multi-day period', ...)`.

**4c.** Delete the entire test `it('aggregates item breakdown across a multi-day period', ...)` — also already covered by `categoryItemsReport.test.js`. It runs from that `it(...)` line through its closing `});` right before `it('builds a periodical payload aggregating shifts across a multi-day range', ...)`.

**4d.** Delete the entire test `it('does not double-subtract a pre-checkout item void from the category breakdown (audit finding)', ...)` — this regression guard is now ported verbatim into `categoryItemsReport.test.js` (Task 1, Step 2, the 4th test). It runs from that `it(...)` line through its closing `});` right before `it('nets shift-level line_discounts against an item-level refund (audit finding)', ...)`.

Do not delete any other test in this file — everything else (shift math, discounts, voids, refunds, serialization, X/Z issuance, period report route tests) is unrelated to categories/items and must keep passing unchanged.

- [ ] Make all four edits (4a-4d).

### Step 5: Run the full audit report test suite

Run: `npx vitest run backend/tests/integration/auditReports.test.js`

Expected: PASS — every remaining test green (there should be no `payload.categories` or `payload.items` references left anywhere in this file — you can double check with a text search for `.categories` and `.items` inside this one file; the only remaining matches should be things like `payload.summary...` etc., not `payload.categories`/`payload.items`).

- [ ] Run it, confirm PASS.

### Step 6: Run the new report's test suite again (regression check)

Run: `npx vitest run backend/tests/integration/categoryItemsReport.test.js`

Expected: still PASS (Task 1's file must be completely unaffected by this task's changes, since it imports from `categoryItemsReportBuilder.js`, not `auditReportBuilder.js`'s removed function).

- [ ] Run it, confirm PASS.

### Step 7: Commit

```bash
git add backend/services/auditReportBuilder.js backend/tests/integration/auditReports.test.js
git commit -m "refactor(audit-report): remove categories/items sections (moved to category items report)"
```

- [ ] Commit.

---

## Task 3: New ad-hoc route — `POST /api/admin/audit-reports/print-items`

**Files:**
- Modify: `backend/routes/admin/auditReports.js`
- Modify: `backend/tests/integration/categoryItemsReport.test.js` (append route tests)

**Interfaces:**
- Consumes: `buildCategoryItemsReportPayload(executor, options)` from Task 1; `dispatchReceiptPrint({ io, clientIp, printerId, printType, data })` from `backend/services/printDispatch.js` (already imported in this file); `normalizeBusinessDate`, `normalizeDateOnly`, `daysBetween`, `MAX_PERIOD_DAYS`, `clientIp` — all already defined as local helpers in this same file, reused as-is.
- Produces: a route that, given `{ business_date }` OR `{ start_date, end_date }` in the POST body, builds the payload and dispatches it to the printer with `print_type: 'category_items_report'`, responding `{ success: true, message: '...' }`. Creates zero rows in `audit_report_documents`.

### Step 1: Write the failing route tests

Open `backend/tests/integration/categoryItemsReport.test.js` (created in Task 1). Add these imports at the top, alongside the existing ones:

```js
const request = require('supertest');
const { app } = require('../../../server');
const { loginSeedUser } = require('../helpers/auth');
const { seedReceiptPrinter } = require('../helpers/fixtures');
```

Then add this new `describe` block at the end of the file, just before the final closing `});` of the outer `describe('category/subcategory/items report builder', ...)` block — i.e., as a sibling to the existing `it(...)` blocks, still inside the outer `describe`:

```js
    describe('ad-hoc print route', () => {
        let adminCookie;

        beforeEach(async () => {
            adminCookie = await loginSeedUser(request, app, 'adminUser');
        });

        it('prints a single business-date items report without creating any document or serial', async () => {
            await seedReceiptPrinter(pool);

            const res = await request(app)
                .post('/api/admin/audit-reports/print-items')
                .set('Cookie', adminCookie)
                .send({ business_date: '2026-07-01' });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const [[{ docs }]] = await pool.query('SELECT COUNT(*) AS docs FROM audit_report_documents');
            const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
            expect(Number(docs)).toBe(0);
            expect(Number(queued)).toBe(1);

            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            const payload = JSON.parse(job.payload);
            expect(payload.print_type).toBe('category_items_report');
            expect(payload.data.is_period).toBe(false);
            expect(payload.data.business_date).toBe('2026-07-01');
        });

        it('prints a periodical items report when start_date/end_date are given', async () => {
            await seedReceiptPrinter(pool);

            const res = await request(app)
                .post('/api/admin/audit-reports/print-items')
                .set('Cookie', adminCookie)
                .send({ start_date: '2026-06-25', end_date: '2026-07-01' });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            const payload = JSON.parse(job.payload);
            expect(payload.print_type).toBe('category_items_report');
            expect(payload.data.is_period).toBe(true);
            expect(payload.data.period_start_date).toBe('2026-06-25');
            expect(payload.data.period_end_date).toBe('2026-07-01');
        });

        it('rejects a request with neither business_date nor start_date', async () => {
            await seedReceiptPrinter(pool);

            const res = await request(app)
                .post('/api/admin/audit-reports/print-items')
                .set('Cookie', adminCookie)
                .send({});

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });
```

- [ ] Make this edit.

### Step 2: Run the tests to verify they fail

Run: `npx vitest run backend/tests/integration/categoryItemsReport.test.js`

Expected: FAIL — the 3 new tests fail with a 404 (route doesn't exist yet). The 4 existing tests from Task 1 must still PASS.

- [ ] Run it, confirm this exact failure mode (new tests fail on 404, old tests still green).

### Step 3: Implement the route

Open `backend/routes/admin/auditReports.js`. Add this import near the top, alongside the existing `buildAuditReportPayload` import:

```js
const { buildAuditReportPayload } = require('../../services/auditReportBuilder');
const { buildCategoryItemsReportPayload } = require('../../services/categoryItemsReportBuilder');
```

Then add this new route right after the existing `/audit-reports/print-period` route (i.e., right before the final `module.exports = router;` line):

```js
router.post('/audit-reports/print-items', async (req, res) => {
    const businessDate = req.body.business_date ? normalizeBusinessDate(req.body.business_date) : null;
    const startDate = req.body.start_date ? normalizeDateOnly(req.body.start_date) : null;
    const endDate = req.body.end_date ? normalizeDateOnly(req.body.end_date) : null;

    if (!businessDate && !startDate) {
        return sendError(res, 400, 'Provide either business_date or start_date/end_date.');
    }
    if (startDate) {
        if (!endDate) return sendError(res, 400, 'Invalid end date.');
        if (endDate < startDate) return sendError(res, 400, 'End date must be on or after start date.');
        if (daysBetween(startDate, endDate) > MAX_PERIOD_DAYS) {
            return sendError(res, 400, `Period cannot exceed ${MAX_PERIOD_DAYS} days.`);
        }
    }

    try {
        const payload = await buildCategoryItemsReportPayload(pool, {
            businessDate: startDate ? null : businessDate,
            startDate: startDate || null,
            endDate: endDate || null,
            generatedByUser: req.user,
        });

        await dispatchReceiptPrint({
            io: req.io,
            clientIp: clientIp(req),
            printerId: req.body.receipt_printer_id || null,
            printType: 'category_items_report',
            data: payload,
        });

        return res.json({ success: true, message: 'تم إرسال تقرير الأصناف للطباعة.' });
    } catch (err) {
        logAdminRouteError(req, err);
        const statusCode = err.statusCode || 500;
        return sendError(res, statusCode, err.message || 'Failed to print items report.');
    }
});

module.exports = router;
```

(This replaces the old final `module.exports = router;` line — the new route goes above it, and the export line comes after.)

- [ ] Make this edit.

### Step 4: Run the tests to verify they pass

Run: `npx vitest run backend/tests/integration/categoryItemsReport.test.js`

Expected: PASS — all 7 tests green (4 from Task 1 + 3 new route tests).

- [ ] Run it, confirm PASS.

### Step 5: Run the full backend suite as a regression check

Run: `npx vitest run`

Expected: PASS — every backend test in the repo still green (this route addition and the auditReportBuilder.js changes from Task 2 must not have broken anything else).

- [ ] Run it, confirm PASS. If anything outside `auditReports.test.js` or `categoryItemsReport.test.js` fails, STOP and investigate before continuing — do not proceed to frontend work with a broken backend suite.

### Step 6: Commit

```bash
git add backend/routes/admin/auditReports.js backend/tests/integration/categoryItemsReport.test.js
git commit -m "feat(reports): add ad-hoc print-items route for the items report"
```

- [ ] Commit.

---

## Task 4: Browser preview template — `PrintReceiptApp.vue`

No automated test framework covers Vue print templates in this codebase — this task is manual-verification only. Follow the steps exactly; verification is a visual/structural check, not `npx vitest run`.

**Files:**
- Modify: `src/print/PrintReceiptApp.vue`

**Interfaces:**
- Consumes: `data.categories`, `data.subcategories`, `data.items` (from `buildCategoryItemsReportPayload`'s payload shape, Task 1), the existing `money()` helper already defined in this component's `<script setup>` (used throughout the file — do not redefine it).
- Produces: a new `<div v-if="printType === 'category_items_report'">` block, fully self-contained.

### Step 1: Remove the المجموعات and الأصناف sections from the `audit_report` block

Find this exact block (currently lines 293-313 of the file — right after the المناوبات/shifts section, right before أنواع الطلبات):

```
            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">المجموعات</div>
            <div v-for="category in data.categories || []" :key="category.category_name" class="flex justify-between text-xs font-bold">
                <span data-no-i18n>{{ category.category_name }} ({{ category.qty_sold }})</span>
                <span>{{ money(category.gross_revenue) }} د.أ</span>
            </div>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">الأصناف</div>
            <div v-for="item in data.items || []" :key="item.item_name" class="mb-1 text-xs font-bold">
                <div class="flex justify-between">
                    <span data-no-i18n>{{ item.item_name }}</span>
                    <span data-no-i18n>{{ item.qty_sold }}×</span>
                </div>
                <div data-no-i18n>{{ money(item.gross_revenue) }} د.أ</div>
            </div>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">أنواع الطلبات</div>
```

Replace it with just:

```
            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">أنواع الطلبات</div>
```

(This collapses the two separator lines that used to bracket the removed sections into the single separator that already existed between المناوبات and أنواع الطلبات.)

- [ ] Make this edit.

### Step 2: Add the new `category_items_report` block

Find the end of the `audit_report` block and the start of the `daily_report` block — this exact boundary (should now be around line 309-311 after Step 1's edit):

```
            <div class="text-center mt-2 text-[10px] font-bold" data-no-i18n>{{ data.generated_at }}</div>
        </div>

        <div v-if="printType === 'daily_report'">
```

Replace it with:

```
            <div class="text-center mt-2 text-[10px] font-bold" data-no-i18n>{{ data.generated_at }}</div>
        </div>

        <div v-if="printType === 'category_items_report'" dir="rtl" style="text-align: right; font-family: 'Cairo', sans-serif;">
            <div class="text-center mb-3">
                <div class="text-lg font-black uppercase tracking-widest" data-no-i18n>{{ data.storeInfo?.store_name || 'POS System' }}</div>
                <h1 class="text-xl font-black">تقرير الأصناف</h1>
                <template v-if="data.is_period">
                    <div class="text-[11px] font-bold" data-no-i18n>من {{ data.period_start_date }} إلى {{ data.period_end_date }}</div>
                </template>
                <template v-else>
                    <div class="text-[11px] font-bold mt-1">تاريخ العمل: <span data-no-i18n>{{ data.business_date }}</span></div>
                </template>
                <div class="text-[10px] font-bold" data-no-i18n>يوم العمل: 06:00 – 05:59</div>
                <div class="text-[10px] font-bold mt-1">طُبع بتاريخ <span data-no-i18n>{{ data.generated_at }}</span> بواسطة <span data-no-i18n>{{ data.generated_by?.name || 'النظام' }}</span></div>
            </div>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">المجموعات</div>
            <div v-for="category in data.categories || []" :key="`cat-${category.category_name}`" class="flex justify-between text-xs font-bold">
                <span data-no-i18n>{{ category.category_name }} ({{ category.qty_sold }})</span>
                <span>{{ money(category.gross_revenue) }} د.أ</span>
            </div>

            <template v-if="(data.subcategories || []).length">
                <div class="dashed-line"></div>
                <div class="text-sm font-black mb-1">التصنيفات الفرعية</div>
                <template v-for="group in data.subcategories" :key="`group-${group.category_name}`">
                    <div class="text-xs font-black mt-1 mb-0.5" data-no-i18n>{{ group.category_name }}</div>
                    <div v-for="sub in group.rows" :key="`sub-${group.category_name}-${sub.category_name}`" class="flex justify-between text-xs font-bold pr-2">
                        <span data-no-i18n>{{ sub.category_name }} ({{ sub.qty_sold }})</span>
                        <span>{{ money(sub.gross_revenue) }} د.أ</span>
                    </div>
                </template>
            </template>

            <div class="dashed-line"></div>

            <div class="text-sm font-black mb-1">الأصناف</div>
            <div v-for="item in data.items || []" :key="`item-${item.item_name}`" class="mb-1 text-xs font-bold">
                <div class="flex justify-between">
                    <span data-no-i18n>{{ item.item_name }}</span>
                    <span data-no-i18n>{{ item.qty_sold }}×</span>
                </div>
                <div data-no-i18n>{{ money(item.gross_revenue) }} د.أ</div>
            </div>

            <div class="dashed-line"></div>
            <div class="text-center font-black text-sm" data-no-i18n>نهاية تقرير الأصناف</div>
            <div class="text-center mt-2 text-[10px] font-bold" data-no-i18n>{{ data.generated_at }}</div>
        </div>

        <div v-if="printType === 'daily_report'">
```

- [ ] Make this edit.

### Step 3: Manual verification

Run: `npm run build`

Expected: build succeeds with no Vue template compile errors.

- [ ] Run it, confirm success. (This only checks the template is syntactically valid Vue — it does not check the print output visually. There is no automated visual check available; note in your final report that visual confirmation of the print preview was not performed, since no dev server / browser check was run as part of this task.)

### Step 4: Commit

```bash
git add src/print/PrintReceiptApp.vue
git commit -m "feat(print): move categories/items to a dedicated items-report template block"
```

- [ ] Commit.

---

## Task 5: Shifts page button — `Shifts.vue`

**Files:**
- Modify: `src/admin/pages/Shifts.vue`

**Interfaces:**
- Consumes: existing `filterDateFrom`, `filterDateTo`, `isPeriodMode` refs (already defined in this file's `setup()`), existing `window.showAdminAlert`, existing `t` (i18n function).
- Produces: new `isItemsPrinting` ref and `printItemsReport()` function, both added to the `return { ... }` object at the end of `setup()`.

### Step 1: Add the button to the template

Find this exact block (the Period Report button, currently around line 130-134):

```
                        <button v-if="isPeriodMode" @click="printPeriodReport" :disabled="isPeriodPrinting" class="h-9 px-3 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors text-xs flex items-center justify-center gap-1.5">
                            <i v-if="isPeriodPrinting" class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>
                            <i v-else class="fa-solid fa-print text-[10px]"></i>
                            <span>{{ $t('Print Period Report') }}</span>
                        </button>
```

Replace it with:

```
                        <button v-if="isPeriodMode" @click="printPeriodReport" :disabled="isPeriodPrinting" class="h-9 px-3 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors text-xs flex items-center justify-center gap-1.5">
                            <i v-if="isPeriodPrinting" class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>
                            <i v-else class="fa-solid fa-print text-[10px]"></i>
                            <span>{{ $t('Print Period Report') }}</span>
                        </button>
                        <button @click="printItemsReport" :disabled="isItemsPrinting" class="h-9 px-3 bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors text-xs flex items-center justify-center gap-1.5">
                            <i v-if="isItemsPrinting" class="fa-solid fa-circle-notch fa-spin text-[10px]"></i>
                            <i v-else class="fa-solid fa-boxes-stacked text-[10px]"></i>
                            <span>{{ $t('Items Report') }}</span>
                        </button>
```

This new button is always visible (both single-date and period mode), matching the "smart for both modes" requirement.

- [ ] Make this edit.

### Step 2: Add the ref and the handler function

Find this line (currently line 498, right after `isPeriodPrinting`):

```js
        const isPeriodPrinting = ref(false);
```

Replace it with:

```js
        const isPeriodPrinting = ref(false);
        const isItemsPrinting = ref(false);
```

Then find the end of the existing `printPeriodReport` function (currently lines 777-800):

```js
        const printPeriodReport = async () => {
            isPeriodPrinting.value = true;
            try {
                const res = await fetch('api/admin/audit-reports/print-period', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        start_date: filterDateFrom.value,
                        end_date: filterDateTo.value,
                        receipt_printer_id: localStorage.getItem('pos_receipt_printer_id') || ''
                    })
                });
                const data = await res.json();
                if (data.success) {
                    await window.showAdminAlert(data.message || t('Periodical report queued for printing.'));
                } else {
                    await window.showAdminAlert(data.message || t('Could not print periodical report.'));
                }
            } catch (e) {
                await window.showAdminAlert(t('Network error while printing the periodical report.'));
            } finally {
                isPeriodPrinting.value = false;
            }
        };
```

Add this new function right after it:

```js

        const printItemsReport = async () => {
            isItemsPrinting.value = true;
            try {
                const body = isPeriodMode.value
                    ? { start_date: filterDateFrom.value, end_date: filterDateTo.value }
                    : { business_date: filterDateFrom.value };
                body.receipt_printer_id = localStorage.getItem('pos_receipt_printer_id') || '';

                const res = await fetch('api/admin/audit-reports/print-items', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                const data = await res.json();
                if (data.success) {
                    await window.showAdminAlert(data.message || t('Items report queued for printing.'));
                } else {
                    await window.showAdminAlert(data.message || t('Could not print items report.'));
                }
            } catch (e) {
                await window.showAdminAlert(t('Network error while printing the items report.'));
            } finally {
                isItemsPrinting.value = false;
            }
        };
```

- [ ] Make both edits.

### Step 3: Expose the new ref and function

Find this line in the `return { ... }` object at the end of `setup()` (currently line 861):

```js
            filterDateFrom, filterDateTo, isPeriodMode, isPeriodPrinting, printPeriodReport,
```

Replace it with:

```js
            filterDateFrom, filterDateTo, isPeriodMode, isPeriodPrinting, printPeriodReport,
            isItemsPrinting, printItemsReport,
```

- [ ] Make this edit.

### Step 4: Manual verification

Run: `npm run build`

Expected: build succeeds with no errors.

- [ ] Run it, confirm success. Note in your final report that clicking the button in a live browser session was not performed as part of this task (no dev server was started) — this step only confirms the code compiles.

### Step 5: Commit

```bash
git add src/admin/pages/Shifts.vue
git commit -m "feat(shifts): add تقرير الأصناف button for the new items report"
```

- [ ] Commit.

---

## Task 6: Thermal spooler (git-ignored, manual deploy)

**Files:**
- Modify (on disk only — NEVER commit): `pos-spooler-printer/server.js`
- Modify (commit this one): `docs/SPOOLER-CHANGES.md`

**Interfaces:**
- Consumes: `data.categories`, `data.subcategories`, `data.items` (same payload shape as Task 4); the existing local `fmt` and `formatDateTime` helpers already defined and used inside the `audit_report` block of this file — reuse them, do not redefine.

### Step 1: Remove the المجموعات and الأصناف rendering from the `audit_report` block

Find this exact block inside the `if (print_type === 'audit_report') { ... }` block (currently around lines 733-753):

```js
        if (categories.length > 0) {
            htmlContent += `
                <div class="dashed-line" style="margin-top: 8px;"></div>
                <div class="text-center font-black text-lg mt-2 mb-2">المجموعات</div>
            `;
            categories.forEach(c => {
                htmlContent += `<div class="text-lr font-bold"><span>${c.category_name} (${c.qty_sold})</span><span>${fmt(c.gross_revenue)} د.أ</span></div>`;
            });
        }
        if (items.length > 0) {
            htmlContent += `
                <div class="dashed-line" style="margin-top: 8px;"></div>
                <div class="text-center font-black text-lg mt-2 mb-2">الأصناف</div>
            `;
            items.forEach(it => {
                htmlContent += `
                    <div class="text-lr font-bold" style="margin-top: 4px;"><span>${it.item_name}</span><span>${it.qty_sold}×</span></div>
                    <div style="font-size: 20px; padding-right: 12px; text-align: right;">${fmt(it.gross_revenue)} د.أ</div>
                `;
            });
        }

```

Delete this whole block entirely (it sits between the المناوبات/shifts loop and the `if (orderTypes.length > 0)` block — leave the orderTypes block untouched).

- [ ] Make this deletion.

### Step 2: Remove the now-unused `categories`/`items` local variables

Find this exact block near the top of the `if (print_type === 'audit_report')` handler (currently around lines 662-666):

```js
        const drawer = data.cash_reconciliation || {};
        const shifts = data.shifts || [];
        const categories = data.categories || [];
        const items = data.items || [];
        const orderTypes = data.order_types || [];
```

Replace it with:

```js
        const drawer = data.cash_reconciliation || {};
        const shifts = data.shifts || [];
        const orderTypes = data.order_types || [];
```

- [ ] Make this edit.

### Step 3: Add the new `category_items_report` print handler

Find the end of the `audit_report` block and the start of the report-section block — this exact boundary (currently around lines 780-783):

```js
        htmlContent += `
            <div class="solid-line" style="margin-top: 16px;"></div>
            <div class="text-center font-black text-lg mt-4">${isPeriod ? 'نهاية التقرير الدوري' : `نهاية تقرير جرد ${auditKind}`}</div>
            ${isPeriod ? '' : `<div class="text-center font-normal" style="font-size: 16px;">${(data.payload_hash || '').slice(0, 12)}</div>`}
            </div>
        `;
    }

    if ([
        'report_overview',
```

Replace it with:

```js
        htmlContent += `
            <div class="solid-line" style="margin-top: 16px;"></div>
            <div class="text-center font-black text-lg mt-4">${isPeriod ? 'نهاية التقرير الدوري' : `نهاية تقرير جرد ${auditKind}`}</div>
            ${isPeriod ? '' : `<div class="text-center font-normal" style="font-size: 16px;">${(data.payload_hash || '').slice(0, 12)}</div>`}
            </div>
        `;
    }

    if (print_type === 'category_items_report') {
        const categories = data.categories || [];
        const subcategories = data.subcategories || [];
        const items = data.items || [];
        const fmt = (v) => parseFloat(v || 0).toFixed(2);
        const isPeriod = Boolean(data.is_period);
        const headerTitle = isPeriod
            ? `<div class="text-center font-bold text-lg mt-1">من ${data.period_start_date} إلى ${data.period_end_date}</div>`
            : `<div class="text-center font-bold text-lg mt-1">تاريخ العمل: ${data.business_date}</div>`;

        htmlContent += `
            <div dir="rtl" style="direction: rtl; text-align: right; font-family: Tahoma, 'Segoe UI', Arial, sans-serif;">
            <div class="text-center font-black text-2xl mt-2 uppercase tracking-widest">${data.storeInfo?.store_name || 'POS System'}</div>
            <div class="kitchen-header mt-2" style="font-size: 38px;">تقرير الأصناف</div>
            ${headerTitle}
            <div class="text-center font-bold text-base">يوم العمل: 06:00 – 05:59</div>
            <div class="text-center font-bold text-sm mt-1 mb-2">طُبع بتاريخ ${formatDateTime(data.generated_at)} بواسطة ${data.generated_by?.name || 'النظام'}</div>
            <div class="solid-line"></div>
            <div class="text-center font-black text-lg mt-2 mb-2">المجموعات</div>
        `;
        categories.forEach(c => {
            htmlContent += `<div class="text-lr font-bold"><span>${c.category_name} (${c.qty_sold})</span><span>${fmt(c.gross_revenue)} د.أ</span></div>`;
        });

        if (subcategories.length > 0) {
            htmlContent += `
                <div class="dashed-line" style="margin-top: 8px;"></div>
                <div class="text-center font-black text-lg mt-2 mb-2">التصنيفات الفرعية</div>
            `;
            subcategories.forEach(group => {
                htmlContent += `<div class="text-lr font-black" style="margin-top: 4px;">${group.category_name}</div>`;
                group.rows.forEach(sub => {
                    htmlContent += `<div class="text-lr font-bold" style="padding-right: 10px;"><span>${sub.category_name} (${sub.qty_sold})</span><span>${fmt(sub.gross_revenue)} د.أ</span></div>`;
                });
            });
        }

        if (items.length > 0) {
            htmlContent += `
                <div class="dashed-line" style="margin-top: 8px;"></div>
                <div class="text-center font-black text-lg mt-2 mb-2">الأصناف</div>
            `;
            items.forEach(it => {
                htmlContent += `
                    <div class="text-lr font-bold" style="margin-top: 4px;"><span>${it.item_name}</span><span>${it.qty_sold}×</span></div>
                    <div style="font-size: 20px; padding-right: 12px; text-align: right;">${fmt(it.gross_revenue)} د.أ</div>
                `;
            });
        }

        htmlContent += `
            <div class="solid-line" style="margin-top: 16px;"></div>
            <div class="text-center font-black text-lg mt-4">نهاية تقرير الأصناف</div>
            </div>
        `;
    }

    if ([
        'report_overview',
```

- [ ] Make this edit.

### Step 4: Verify with Node syntax check

Run: `node --check pos-spooler-printer/server.js`

Expected: no output (exit code 0), meaning the file still parses as valid JavaScript.

- [ ] Run it, confirm no errors.

### Step 5: Document the manual deploy in `docs/SPOOLER-CHANGES.md`

Open `docs/SPOOLER-CHANGES.md` and read its existing format (it should already have an entry for the earlier جرد items-section change — match that same style). Append a new dated entry describing:
- What changed: removed المجموعات/الأصناف rendering from the `audit_report` block (now X/Z/Period reports no longer print those sections); added a brand-new `category_items_report` print handler with Categories → Subcategories (grouped under parent category) → Items, triggered by the new "تقرير الأصناف" button on the Shifts page.
- Exact line-range context so whoever applies this manually on the production spooler machine can find the right spot (reference the same anchors used in Steps 1-3 above).
- A reminder that this file is git-ignored and must be hand-applied to every physical spooler installation.

- [ ] Add this entry.

### Step 6: Commit (only the doc file)

```bash
git add docs/SPOOLER-CHANGES.md
git commit -m "docs(spooler): note items-report categories/subcategories manual deploy"
```

Do **not** run `git add` on `pos-spooler-printer/server.js` — it is git-ignored and must never be committed or force-added.

- [ ] Commit.

---

## Definition of Done

- [ ] `npx vitest run` (full backend suite) passes with zero failures.
- [ ] `npm run build` succeeds.
- [ ] `node --check pos-spooler-printer/server.js` passes.
- [ ] X, Z, and Period reports no longer contain المجموعات or الأصناف anywhere in their payload or rendered output.
- [ ] A new "تقرير الأصناف" button exists on the Shifts page, always enabled, that reads the same `filterDateFrom`/`filterDateTo`/`isPeriodMode` state as the other report buttons.
- [ ] The new report shows: Categories (root rollup) → Subcategories (grouped under parent, omitted when a category has no real subcategory sales) → Items — in that order, in both the browser preview and the (git-ignored, manually-deployed) thermal spooler.
- [ ] `docs/SPOOLER-CHANGES.md` has a new entry describing the spooler-side change for manual deployment.
- [ ] Six commits exist, one per task, in this order: builder, refactor-removal, route, browser template, Shifts button, spooler docs.
