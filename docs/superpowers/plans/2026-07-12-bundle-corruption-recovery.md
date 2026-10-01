# Bundle Corruption Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every persisted bundle consumer reject missing/cross-invoice parents and non-positive bundle quantities before money, stock, kitchen, receipt, audit, or lifecycle mutation; prevent those states at DB level.

**Architecture:** One pure `bundleIntegrity` service owns structural checks and typed errors. Existing receipt and kitchen adapters call it centrally; mutation routes validate persisted data at their first authoritative load. A resumable MariaDB migration scans first, adds quantity/index safeguards, then atomically swaps the old self-FK for a same-invoice composite FK.

**Tech Stack:** Node.js CommonJS, Express 5, mysql2/promise, MariaDB 10.4.32, Vitest 4, Supertest.

## Global Constraints

- No automatic repair, inferred quantities, quarantine table/status, repair endpoint, frontend workflow, or catalog-history snapshot.
- Do not guard structural-neutral table transfer/swap/status actions; they never derive or rewrite bundle rows. Owner-approved held discard remains an explicit recovery action.
- Every Vitest command touching `posapp_test` must include `--no-file-parallelism --maxWorkers=1 --maxConcurrency=1`.
- Internal errors use `publicCode: 'BUNDLE_ORDER_CORRUPT'`; preserve existing response transports: POS `code`, admin/print `publicCode`, list rows `receipt_display_error`.
- Public message is exactly `Order bundle data is inconsistent. Manager repair required.`
- Stable internal reasons: `missing_same_invoice_parent`, `cross_invoice_parent`, `nested_parent`, `non_positive_parent_quantity`, `non_positive_child_quantity`.
- Historical validation is structural only. Never compare persisted children with current `products.is_bundle` or `product_bundle_items`.
- Top-level rows without children are not inferred to be bundle parents.
- Every guard runs before business mutation. Each commit must preserve existing valid bundle behavior.
- Runtime validation is `O(n)`, pure, and query-free. No per-row DB queries.
- Migration default is scan-only. DDL requires `BUNDLE_INTEGRITY_MIGRATION_CONFIRM` to equal current DB name.
- Migration scanner covers every `order_items.quantity <= 0`, not bundle rows only, because CHECK is table-wide.
- Do not run DB integration files in parallel; suites share and reseed `posapp_test`.
- Do not stage or commit unrelated `mockup-orders.html` deletion.
- One commit per task. Each commit must stand alone.

## Proven Design Experiments

Experiments already run against isolated scratch tables in `posapp_test`:

1. Existing single-column FK allowed child invoice `2` to reference parent invoice `1`.
2. Adding composite supporting indexes and self-FK in one `ALTER` failed with MariaDB `errno: 150`.
3. Stage 1 indexes/CHECK followed by atomic stage 2 FK swap succeeded.
4. Forced stage-2 failure retained old FK.
5. Composite FK rejected cross-invoice insert.
6. CHECK rejected zero quantity.
7. Parent delete cascaded to child.
8. Deleting an order with both order cascade and self cascade left zero item rows.
9. Old single-column parent index could be dropped inside successful stage-2 swap.
10. `check_constraint_checks=OFF` safely enabled deliberate corrupt test fixtures.

Read-only production scan found zero dangling parents, cross-invoice links, non-positive `order_items` quantities, bad referenced parents/children, or bad nested bundle holds.

---

### Task 1: Pure integrity authority and corrupt-fixture helper

**Files:**
- Create: `backend/services/bundleIntegrity.js`
- Create: `backend/tests/unit/bundleIntegrity.test.js`
- Create: `backend/tests/helpers/bundleIntegrityFixtures.js`

**Interfaces:**
- Produces: `BUNDLE_ORDER_CORRUPT`, `BUNDLE_ORDER_CORRUPT_MESSAGE`, `assertOrderItemBundleIntegrity(rows)`, `assertNestedBundleIntegrity(items)`.
- Both assertions return original input unchanged on success and throw typed error on failure.
- Test helper produces `withBundleIntegrityChecksDisabled(pool, callback)` using one dedicated connection and guaranteed session restoration.

- [ ] **Step 1: Write failing pure contract tests**

Create `backend/tests/unit/bundleIntegrity.test.js`:

```js
import { describe, expect, it } from 'vitest';
const {
    BUNDLE_ORDER_CORRUPT,
    BUNDLE_ORDER_CORRUPT_MESSAGE,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
} = require('../../services/bundleIntegrity');

const expectCorrupt = (fn, reason) => {
    let error;
    try { fn(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(409);
    expect(error.publicCode).toBe(BUNDLE_ORDER_CORRUPT);
    expect(error.message).toBe(BUNDLE_ORDER_CORRUPT_MESSAGE);
    expect(error.integrityReason).toBe(reason);
    return error;
};

describe('bundleIntegrity', () => {
    it('accepts a valid flat bundle without mutating rows', () => {
        const rows = [
            { id: 10, invoice_id: 7, parent_item_id: null, quantity: 2 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 4 }
        ];
        const before = structuredClone(rows);
        expect(assertOrderItemBundleIntegrity(rows)).toBe(rows);
        expect(rows).toEqual(before);
    });

    it('accepts a top-level row with no children', () => {
        const rows = [{ id: 10, invoice_id: 7, parent_item_id: null, quantity: 1 }];
        expect(assertOrderItemBundleIntegrity(rows)).toBe(rows);
    });

    it.each([
        [[{ id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }], 'missing_same_invoice_parent'],
        [[
            { id: 10, invoice_id: 6, parent_item_id: null, quantity: 1 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }
        ], 'cross_invoice_parent'],
        [[
            { id: 9, invoice_id: 7, parent_item_id: null, quantity: 1 },
            { id: 10, invoice_id: 7, parent_item_id: 9, quantity: 1 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }
        ], 'nested_parent'],
        [[
            { id: 10, invoice_id: 7, parent_item_id: null, quantity: 0 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: 1 }
        ], 'non_positive_parent_quantity'],
        [[
            { id: 10, invoice_id: 7, parent_item_id: null, quantity: 1 },
            { id: 11, invoice_id: 7, parent_item_id: 10, quantity: -1 }
        ], 'non_positive_child_quantity']
    ])('rejects corrupt flat rows with %s', (rows, reason) => {
        expectCorrupt(() => assertOrderItemBundleIntegrity(rows), reason);
    });

    it.each([0, -1, NaN, Infinity])('rejects nested bundle parent quantity %s', qty => {
        expectCorrupt(() => assertNestedBundleIntegrity([{
            cartId: 'bundle-1', qty,
            bundleItems: [{ product_id: 1, qty: 1 }]
        }]), 'non_positive_parent_quantity');
    });

    it('rejects a non-positive active nested child but allows removed legacy metadata', () => {
        expectCorrupt(() => assertNestedBundleIntegrity([{
            cartId: 'bundle-1', qty: 1,
            bundleItems: [{ product_id: 1, qty: 0, removed: false }]
        }]), 'non_positive_child_quantity');
        expect(() => assertNestedBundleIntegrity([{
            cartId: 'bundle-1', qty: 1,
            bundleItems: [{ product_id: 1, removed: true }]
        }])).not.toThrow();
    });
});
```

- [ ] **Step 2: Run tests and prove red boundary**

Run:

```powershell
npx vitest run backend/tests/unit/bundleIntegrity.test.js --reporter=verbose
```

Expected: FAIL because `backend/services/bundleIntegrity.js` does not exist.

- [ ] **Step 3: Implement pure authority**

Create `backend/services/bundleIntegrity.js`:

```js
'use strict';

const BUNDLE_ORDER_CORRUPT = 'BUNDLE_ORDER_CORRUPT';
const BUNDLE_ORDER_CORRUPT_MESSAGE = 'Order bundle data is inconsistent. Manager repair required.';

function fail(reason, context) {
    const error = new Error(BUNDLE_ORDER_CORRUPT_MESSAGE);
    error.statusCode = 409;
    error.publicCode = BUNDLE_ORDER_CORRUPT;
    error.integrityReason = reason;
    error.integrityContext = context;
    throw error;
}

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const rowId = row => row?.id ?? row?.cartId ?? null;

function assertOrderItemBundleIntegrity(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const byId = new Map();
    for (const row of list) {
        const id = Number(row?.id);
        if (Number.isInteger(id) && id > 0) byId.set(id, row);
    }

    for (const child of list) {
        if (child?.parent_item_id == null) continue;
        const parentId = Number(child.parent_item_id);
        const parent = byId.get(parentId);
        const context = { childId: rowId(child), parentId: child.parent_item_id };
        if (!parent) fail('missing_same_invoice_parent', context);
        if (child.invoice_id != null && parent.invoice_id != null &&
            String(child.invoice_id) !== String(parent.invoice_id)) {
            fail('cross_invoice_parent', {
                ...context,
                childInvoiceId: child.invoice_id,
                parentInvoiceId: parent.invoice_id
            });
        }
        if (parent.parent_item_id != null) fail('nested_parent', context);
        if (!positive(parent.quantity ?? parent.qty)) fail('non_positive_parent_quantity', context);
        if (!positive(child.quantity ?? child.qty)) fail('non_positive_child_quantity', context);
    }
    return rows;
}

function assertNestedBundleIntegrity(items) {
    const list = Array.isArray(items) ? items : [];
    for (let itemIndex = 0; itemIndex < list.length; itemIndex++) {
        const item = list[itemIndex];
        if (!Array.isArray(item?.bundleItems)) continue;
        const context = { itemIndex, parentId: rowId(item) };
        if (!positive(item.qty ?? item.quantity)) fail('non_positive_parent_quantity', context);
        for (let childIndex = 0; childIndex < item.bundleItems.length; childIndex++) {
            const child = item.bundleItems[childIndex];
            if (child?.removed === true) continue;
            if (!positive(child?.qty ?? child?.quantity)) {
                fail('non_positive_child_quantity', {
                    ...context,
                    childIndex,
                    childId: child?.product_id ?? child?.id ?? null
                });
            }
        }
    }
    return items;
}

module.exports = {
    BUNDLE_ORDER_CORRUPT,
    BUNDLE_ORDER_CORRUPT_MESSAGE,
    assertOrderItemBundleIntegrity,
    assertNestedBundleIntegrity
};
```

- [ ] **Step 4: Add safe corrupt-fixture helper**

Create `backend/tests/helpers/bundleIntegrityFixtures.js`:

```js
async function withBundleIntegrityChecksDisabled(pool, callback) {
    const conn = await pool.getConnection();
    try {
        await conn.query('SET SESSION FOREIGN_KEY_CHECKS=0');
        await conn.query('SET SESSION check_constraint_checks=OFF');
        return await callback(conn);
    } finally {
        await conn.query('SET SESSION check_constraint_checks=ON').catch(() => {});
        await conn.query('SET SESSION FOREIGN_KEY_CHECKS=1').catch(() => {});
        conn.release();
    }
}

module.exports = { withBundleIntegrityChecksDisabled };
```

- [ ] **Step 5: Run focused test**

Run:

```powershell
npx vitest run backend/tests/unit/bundleIntegrity.test.js --reporter=verbose
```

Expected: one file passes; all integrity cases green.

- [ ] **Step 6: Commit**

```powershell
git add -- backend/services/bundleIntegrity.js backend/tests/unit/bundleIntegrity.test.js backend/tests/helpers/bundleIntegrityFixtures.js
git commit -m "feat(pos): define bundle integrity authority"
```

---

### Task 2: Receipt, history, held-list, and kitchen fail-closed reads

**Files:**
- Modify: `backend/services/ReceiptPresentationSources.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/routes/admin/orders.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/tests/integration/bundle.print.test.js`
- Modify: `backend/tests/integration/heldOrders.test.js`
- Modify: `backend/tests/integration/bundle.heldOrders.fire.test.js`
- Modify: `backend/tests/integration/adminRouting.test.js`
- Modify: `backend/tests/integration/print.authz.test.js`

**Interfaces:**
- Consumes Task 1 guards and constants.
- Produces central receipt and kitchen read behavior; lists isolate corruption per row.

- [ ] **Step 1: Add red read/kitchen tests**

Add these exact cases to existing suites, using `withBundleIntegrityChecksDisabled` whenever DB constraints may already exist:

```js
const captureBundleError = fn => {
    try { fn(); } catch (error) { return error; }
    throw new Error('Expected bundle corruption error.');
};

it('rejects a zero-quantity nested bundle instead of routing it as quantity one', () => {
    const error = captureBundleError(() => expandBundlesForKitchen([{
        id: 4, name: 'Family Package', qty: 0, is_bundle: 1,
        bundleItems: [{ product_id: 1, name: 'Burger', qty: 1, removed: false }]
    }]));
    expect(error).toMatchObject({ statusCode: 409, publicCode: 'BUNDLE_ORDER_CORRUPT' });
});

it('rejects a DB child whose parent is absent from the invoice payload', () => {
    const error = captureBundleError(() => expandBundlesForKitchen([{
        id: 11, invoice_id: 7, parent_item_id: 10,
        product_id: 1, name: 'Burger', quantity: 1
    }]));
    expect(error).toMatchObject({ statusCode: 409, publicCode: 'BUNDLE_ORDER_CORRUPT' });
});
```

Add integration assertions:

- `GET /api/pos/held_orders`: corrupt nested bundle row returns `receipt_display_error === 'BUNDLE_ORDER_CORRUPT'`; valid sibling remains present and printable.
- `POST /api/pos/held_orders/fire_kitchen`: corrupt nested parent returns `409`, body `code === 'BUNDLE_ORDER_CORRUPT'`, `kitchen_fired` remains `0`, print spy receives zero calls.
- `GET /api/admin/order_details`: invoice-local orphan returns `409`, body `publicCode === 'BUNDLE_ORDER_CORRUPT'`.
- numeric receipt reprint: same orphan returns `409`, body `publicCode === 'BUNDLE_ORDER_CORRUPT'`, print queue count unchanged.
- valid DB and nested bundle fixtures retain exact existing output.

- [ ] **Step 2: Run red tests individually**

```powershell
npx vitest run backend/tests/integration/bundle.print.test.js --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/heldOrders.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/bundle.heldOrders.fire.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/adminRouting.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/print.authz.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
```

Expected: new assertions fail because reads still drop, default, or render corrupt data.

- [ ] **Step 3: Wire central receipt validation**

In `ReceiptPresentationSources.js` import guards/constants. At start of `orderPresentationInput`:

```js
assertOrderItemBundleIntegrity(items);
```

After `rawItems` is extracted inside `heldPresentationInput`:

```js
assertNestedBundleIntegrity(rawItems);
assertOrderItemBundleIntegrity(rawItems);
```

In `buildHeldPresentations` catch, preserve bundle corruption instead of rewriting it as receipt validation:

```js
if (error.publicCode === BUNDLE_ORDER_CORRUPT) {
    return { presentation: null, error };
}
```

Keep existing receipt-invalid normalization for every other data error.

After held-list presentations are built in `backend/routes/pos/orders.js`, log each corrupt row without failing valid siblings:

```js
if (pres.error?.publicCode === BUNDLE_ORDER_CORRUPT) {
    logger.warn({
        err: pres.error,
        heldOrderId: row.id,
        integrityReason: pres.error.integrityReason,
        integrityContext: pres.error.integrityContext
    }, 'Corrupt held-order bundle data.');
}
```

- [ ] **Step 4: Remove kitchen defaults and validate both shapes**

At start of `expandBundlesForKitchen` in `backend/routes/print.js`:

```js
assertNestedBundleIntegrity(list);
assertOrderItemBundleIntegrity(list);
```

Replace quantity fallbacks:

```js
const parentQty = Number(it.qty ?? it.quantity);
const childQty = Number(sub.qty ?? sub.quantity) * parentQty;
```

The assertions make both numbers positive and finite before multiplication.

Before generic print error handling:

```js
if (e.publicCode === BUNDLE_ORDER_CORRUPT) {
    logger.error({
        err: e,
        invoiceId: req.body?.invoice_id || req.body?.order_id,
        integrityReason: e.integrityReason,
        integrityContext: e.integrityContext
    }, 'Print blocked by corrupt bundle data.');
    return res.status(e.statusCode || 409).json({
        success: false,
        message: e.message,
        publicCode: e.publicCode
    });
}
```

- [ ] **Step 5: Preserve typed admin and held-kitchen transport**

In `backend/routes/admin/orders.js`, before current `422` branch:

```js
if (e.publicCode === BUNDLE_ORDER_CORRUPT) {
    logAdminRouteError(req, e);
    return res.status(e.statusCode || 409).json({
        success: false,
        message: e.message,
        publicCode: e.publicCode
    });
}
```

In held kitchen fire, validate `rawItems` before normalization and before `kitchen_fired` UPDATE:

```js
assertNestedBundleIntegrity(rawItems);
assertOrderItemBundleIntegrity(rawItems);
```

Change route catch to existing POS transport:

```js
sendError(
    res,
    e.statusCode || 500,
    e.statusCode ? e.message : 'Operation failed. Please try again.',
    e.publicCode || null
);
```

- [ ] **Step 6: Run read/kitchen files serially**

Run same five commands from Step 2. Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```powershell
git add -- backend/services/ReceiptPresentationSources.js backend/routes/print.js backend/routes/admin/orders.js backend/routes/pos/orders.js backend/tests/integration/bundle.print.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/bundle.heldOrders.fire.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/print.authz.test.js
git commit -m "fix(pos): fail closed on corrupt bundle reads"
```

---

### Task 3: Checkout and held lifecycle mutation guards

**Files:**
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/tests/integration/bundle.checkout.test.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/heldOrders.test.js`

**Interfaces:**
- Consumes Task 1 guards.
- Guarantees split held rows are validated before delete; persisted table rows before rewrite; held rows before claim/delete; new holds before persistence.

- [ ] **Step 1: Add red mutation/rollback tests**

Add cases proving:

```js
expect(response.statusCode).toBe(409);
expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
```

Required scenarios:

1. Split held payload with nested bundle parent qty `0`: checkout returns 409; held row and service-charge snapshot state/version remain unchanged; no paid order exists.
2. Saved unpaid table with parent qty `0` and a child: checkout returns 409 before rewrite; original order/items/table/stock remain unchanged.
3. Admin table cashout without `edit_invoice_id`: corrupt table `current_order_id` still returns 409; no fresh paid order or void audit is created.
4. Duplicate idempotent checkout response for corrupt finalized order rethrows 409 rather than returning success without presentation.
5. Held claim with corrupt nested child qty: held row remains; snapshot claim transition rolls back.
6. Holding a new corrupt nested bundle returns 409 and inserts no held row.

Use `withBundleIntegrityChecksDisabled(pool, async conn => { ... })` to inject zero/cross-invoice fixtures so tests remain valid after Task 5 constraints.

- [ ] **Step 2: Run red tests serially**

```powershell
npx vitest run backend/tests/integration/bundle.checkout.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/checkout.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/heldOrders.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
```

Expected: new tests fail through current delete/rewrite/500 paths.

- [ ] **Step 3: Validate split held payload before deletion**

Immediately after parsing `splitHeldPayload`, before `DELETE FROM held_orders`:

```js
assertNestedBundleIntegrity(splitHeldPayload?.items);
assertOrderItemBundleIntegrity(splitHeldPayload?.items);
```

- [ ] **Step 4: Validate submitted nested cart before generic normalization**

Immediately before `normalizeCartItems(data.cart)`:

```js
assertNestedBundleIntegrity(data.cart);
```

This preserves typed 409 behavior for parent qty `0`; `normalizeCartItems` would otherwise throw a generic invalid-quantity error first. Server-authoritative DB member validation remains unchanged.

- [ ] **Step 5: Validate persisted checkout invoices**

For the `data.edit_invoice_id` saved-item query, select `invoice_id` and `parent_item_id`, then assert before constructing maps:

```js
assertOrderItemBundleIntegrity(savedItems);
```

For admin table cashout without `edit_invoice_id`, retain resolved table `current_order_id` while the table row is locked. Before totals or writes:

```js
if (!isSplitSettle && tablePersistedInvoiceId &&
    Number(tablePersistedInvoiceId) !== Number(data.edit_invoice_id)) {
    const [persistedRows] = await conn.query(
        'SELECT id, invoice_id, parent_item_id, quantity FROM order_items WHERE invoice_id = ? FOR UPDATE',
        [tablePersistedInvoiceId]
    );
    assertOrderItemBundleIntegrity(persistedRows);
}
```

Do not add a second query when `edit_invoice_id` already loaded full saved rows.

- [ ] **Step 6: Stop duplicate checkout from swallowing corruption**

In `buildDuplicateCheckoutResponse` catch, before legacy warning fallback:

```js
if (error.publicCode === BUNDLE_ORDER_CORRUPT) throw error;
```

- [ ] **Step 7: Guard held claim and save**

In held claim, validate parsed persisted `cartPayload.items` before product loading and before held-row deletion:

```js
assertNestedBundleIntegrity(cartPayload.items);
assertOrderItemBundleIntegrity(cartPayload.items);
```

In held save, validate `cartPayload.items` before `normalizeCartItems` and before inserting `held_orders`:

```js
assertNestedBundleIntegrity(cartPayload.items);
```

Existing transaction catches already forward status and public code.

- [ ] **Step 8: Run selected checkout/held tests**

Run commands from Step 2. Expected: all selected tests pass with rollback assertions.

- [ ] **Step 9: Commit**

```powershell
git add -- backend/routes/pos/checkout.js backend/routes/pos/orders.js backend/tests/integration/bundle.checkout.test.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js
git commit -m "fix(pos): guard bundle checkout and held lifecycles"
```

---

### Task 4: Table, merge, split, reconstruction, and refund guards

**Files:**
- Modify: `backend/services/bundleOrderItems.js`
- Modify: `backend/routes/pos/helpers.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/routes/pos/refunds.js`
- Modify: `backend/tests/unit/helpers.test.js`
- Modify: `backend/tests/integration/bundle.tables.test.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/integration/refunds.test.js`

**Interfaces:**
- Consumes Task 1 flat/nested guards.
- Keeps table and refund transactions unchanged on corruption.

- [ ] **Step 1: Add red table/refund tests**

Required cases:

1. `GET /table_order` with cross-invoice child returns POS `409/code`; it does not silently drop child.
2. `POST /table_order` with corrupt persisted parent returns 409; existing rows, totals, stock, audit, table state remain byte-identical.
3. Empty-cart whole-order void of a corrupt table also returns 409 before restock, audit, item delete, or table release.
4. Table merge rejects corrupt source and corrupt target independently before copying/deleting rows or changing snapshots.
5. Table split rejects corrupt parent invoice before creating held seats, void audit, stock restore, or table release.
6. Refund/void rejects corrupt structure with 409/code rather than 500; refunds, refund_items, audit, order rows, totals, stock, table state remain unchanged.
7. `reconstructBundleSubs` rejects zero parent and cross-invoice child with typed error; valid reconstruction output remains exact.
8. `recomputeOrderTotals` performs no UPDATE when product-edit healing encounters corrupt bundle rows.

Inject relational corruption through `withBundleIntegrityChecksDisabled`.

- [ ] **Step 2: Run red files serially**

```powershell
npx vitest run backend/tests/integration/bundle.tables.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/tables.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/refunds.test.js -t "bundle corruption" --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/unit/helpers.test.js -t "bundle corruption" --reporter=verbose
```

Expected: current routes drop, propagate, return 500, or rewrite totals.

- [ ] **Step 3: Harden reconstruction without fallback**

At start of `reconstructBundleSubs`:

```js
assertOrderItemBundleIntegrity([parentRow, ...(childRows || [])]);
```

All callers must pass parent `id`, `invoice_id`, `parent_item_id`, and `quantity`. Update refund's synthetic parent object accordingly. Keep division exact:

```js
qty: Number(child.quantity) / Number(parentRow.quantity)
```

No fallback branch is allowed.

- [ ] **Step 4: Guard table recall and save**

After GET loads all invoice items:

```js
assertOrderItemBundleIntegrity(items);
```

Immediately after table/order identity is resolved—and before settings, empty-cart void, restock, audit, or cart normalization—load saved rows once:

```js
let savedItems = [];
if (order_id) {
    [savedItems] = await conn.query(
        'SELECT id, invoice_id, product_id, item_name, note, quantity, price_at_sale, tax_rate, selected_modifiers, modifier_surcharge, parent_item_id FROM order_items WHERE invoice_id = ? FOR UPDATE',
        [order_id]
    );
    assertOrderItemBundleIntegrity(savedItems);
}
```

Delete the later `let savedItems` declaration/query and reuse this array for frozen-price/void logic. This closes empty-cart whole-order void without adding a second query.

Before non-empty POST normalizes cart:

```js
assertNestedBundleIntegrity(data.cart);
```

GET recall still validates its independently loaded `items` immediately after SELECT.

Change GET catch so typed integrity errors are not converted to 500:

```js
return sendError(
    res,
    e.statusCode || 500,
    e.statusCode ? e.message : 'Operation failed. Please try again.',
    e.publicCode || null
);
```

- [ ] **Step 5: Guard central open-order recomputation**

In `backend/routes/pos/helpers.js`, import `assertOrderItemBundleIntegrity`. Inside `recomputeOrderTotals`, immediately after its full `order_items` SELECT and before `calculateExpectedTotals` or any UPDATE:

```js
assertOrderItemBundleIntegrity(items);
```

Add unit test in `backend/tests/unit/helpers.test.js` with a mocked connection returning a zero-qty referenced parent plus child. Assert rejection carries `BUNDLE_ORDER_CORRUPT` and query history contains no `UPDATE orders` or `UPDATE order_items`. This protects asynchronous `healOpenOrdersForProduct` plus route callers.

- [ ] **Step 6: Guard merge source and target**

Load both complete item sets before any copy:

```js
const [sourceItems] = await conn.execute(
    'SELECT * FROM order_items WHERE invoice_id = ? FOR UPDATE',
    [sourceTable.current_order_id]
);
const [targetItems] = await conn.execute(
    'SELECT * FROM order_items WHERE invoice_id = ? FOR UPDATE',
    [targetTable.current_order_id]
);
assertOrderItemBundleIntegrity(sourceItems);
assertOrderItemBundleIntegrity(targetItems);
```

Reuse `targetItems` for target fee lookup where practical; do not refactor unrelated merge SQL.

- [ ] **Step 7: Guard split payload and persisted parent**

Before normalizing each seat, validate its raw items:

```js
for (const seat of splits) {
    assertNestedBundleIntegrity(seat.items);
}
```

Replace parent-only DB query with one full-order query, assert, then filter:

```js
const [allParentOrderItems] = await conn.query(
    'SELECT id, invoice_id, product_id, item_name, note, quantity, price_at_sale, tax_rate, selected_modifiers, modifier_surcharge, parent_item_id FROM order_items WHERE invoice_id = ? FOR UPDATE',
    [currentOrderId]
);
assertOrderItemBundleIntegrity(allParentOrderItems);
const parentItems = allParentOrderItems.filter(item => item.parent_item_id == null);
```

Keep conservation calculations parent-only.

In split catch, forward typed errors without production masking:

```js
const msg = e.statusCode && !isDbError
    ? e.message
    : ((process.env.NODE_ENV === 'production' || isDbError)
        ? 'Failed to split bill due to a database error.'
        : (e.message || 'Failed to split bill.'));
return sendError(res, status, msg, e.publicCode || null);
```

In `GET /table_splits`, after `buildHeldPresentations`, log corrupt rows with `heldOrderId`, `integrityReason`, and `integrityContext` while retaining per-row `receipt_display_error` behavior.

- [ ] **Step 8: Guard refunds before calculations**

Load all order rows, assert, then filter parents:

```js
const [allOrderItems] = await conn.query(`
    SELECT oi.id, oi.invoice_id, oi.parent_item_id, oi.product_id,
           COALESCE(oi.item_name, p.name) AS item_name,
           oi.note, oi.quantity, oi.price_at_sale, oi.tax_rate, oi.tax_amount,
           oi.discount_type, oi.discount_value, oi.sort_order
      FROM order_items oi
      LEFT JOIN products p ON oi.product_id = p.id
     WHERE oi.invoice_id = ?
     FOR UPDATE
`, [invoiceId]);
assertOrderItemBundleIntegrity(allOrderItems);
const orderItems = allOrderItems.filter(item => item.parent_item_id == null);
```

Change catch to:

```js
const status = err.statusCode || 500;
return sendError(
    res,
    status,
    status === 500 ? 'Refund failed.' : err.message,
    err.publicCode || null
);
```

- [ ] **Step 9: Run table/refund selected tests**

Run commands from Step 2. Expected: all selected tests pass.

- [ ] **Step 10: Commit**

```powershell
git add -- backend/services/bundleOrderItems.js backend/routes/pos/helpers.js backend/routes/pos/tables.js backend/routes/pos/refunds.js backend/tests/unit/helpers.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js
git commit -m "fix(pos): guard bundle table and refund mutations"
```

---

### Task 5: Resumable MariaDB prevention migration and schema parity

**Files:**
- Create: `backend/migrations/apply-bundle-integrity-constraints.js`
- Modify: `backend/tests/fixtures/seed.js`
- Create: `backend/tests/unit/bundleIntegrityMigration.test.js`
- Create: `backend/tests/integration/bundleIntegrityMigration.test.js`

**Interfaces:**
- Produces: `scanBundleIntegrity(conn)`, `readBundleConstraintState(conn)`, `applyBundleIntegrityConstraints(conn)` for testing and CLI.
- CLI without confirmation scans only. Exact DB-name confirmation applies DDL.

- [ ] **Step 1: Write red migration tests**

Unit tests mock mysql connection and prove:

- scan SQL includes `non_positive_quantity`, `missing_same_invoice_parent`, `cross_invoice_parent`, `nested_parent`;
- scanner parses nested bundles in every `held_orders.cart_data` row and reports held ID/reason;
- scanner reports `product_bundle_items.qty <= 0` as `non_positive_bundle_definition_quantity` so CHECK deployment cannot turn bad catalog data into checkout DB errors;
- findings prevent every ALTER;
- stage 1 precedes stage 2;
- existing equivalent indexes are reused by column sequence, not guessed by name;
- actual deployed single self-FK name comes from `information_schema`;
- partial stage 1 resumes without duplicate DDL;
- completed composite FK is idempotent;
- stage 2 drops old single parent index only after replacement child index exists.

Integration tests after `seedDatabase()` prove:

```js
await expect(pool.query(
    'INSERT INTO order_items (invoice_id, quantity, price_at_sale) VALUES (?, 0, 1)',
    [invoiceId]
)).rejects.toThrow();

await expect(pool.query(
    'UPDATE order_items SET parent_item_id = ? WHERE id = ?',
    [parentFromOtherInvoice, childId]
)).rejects.toThrow();
```

Also inject corruption with constraint checks disabled and assert scanner returns exact row IDs/reasons.

- [ ] **Step 2: Run tests and prove red**

```powershell
npx vitest run backend/tests/unit/bundleIntegrityMigration.test.js --reporter=verbose
npx vitest run backend/tests/integration/bundleIntegrityMigration.test.js --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
```

Expected: missing runner/schema constraints cause failures.

- [ ] **Step 3: Implement scan-only default and schema inspection**

Runner requirements:

```js
const TABLE = 'order_items';
const CHECK_NAME = 'chk_order_items_quantity_positive';
const UNIQUE_INDEX = 'uq_order_items_id_invoice';
const CHILD_INDEX = 'idx_order_items_parent_invoice';
const COMPOSITE_FK = 'fk_order_items_parent_invoice';
```

Scanner uses one ordered `UNION ALL` query:

```sql
SELECT 'non_positive_quantity' reason, oi.invoice_id, oi.id row_id, oi.parent_item_id parent_id
  FROM order_items oi
 WHERE NOT (oi.quantity > 0)
UNION ALL
SELECT 'missing_same_invoice_parent', c.invoice_id, c.id, c.parent_item_id
  FROM order_items c
  LEFT JOIN order_items p ON p.id = c.parent_item_id
 WHERE c.parent_item_id IS NOT NULL AND p.id IS NULL
UNION ALL
SELECT 'cross_invoice_parent', c.invoice_id, c.id, c.parent_item_id
  FROM order_items c
  JOIN order_items p ON p.id = c.parent_item_id
 WHERE c.invoice_id <> p.invoice_id
UNION ALL
SELECT 'nested_parent', c.invoice_id, c.id, c.parent_item_id
  FROM order_items c
  JOIN order_items p ON p.id = c.parent_item_id
 WHERE p.parent_item_id IS NOT NULL
ORDER BY invoice_id, row_id, reason
```

Then load held rows once:

```js
const [heldRows] = await conn.query('SELECT id, cart_data FROM held_orders ORDER BY id');
```

Parse array-shaped legacy payloads and object-shaped current payloads. Call `assertNestedBundleIntegrity(items)`. On `BUNDLE_ORDER_CORRUPT`, append `{ entity: 'held_order', heldOrderId, reason, context }`; rethrow unexpected DB/programming errors. Held findings block DDL and deployment just like relational findings.

Run one catalog compatibility query and append findings without comparing historical child composition to current definitions:

```sql
SELECT bundle_id, product_id, qty
  FROM product_bundle_items
 WHERE NOT (qty > 0)
 ORDER BY bundle_id, product_id
```

Schema inspection groups `information_schema.STATISTICS` by index name/sequence and `KEY_COLUMN_USAGE` by FK constraint/ordinal position. It recognizes exact column sequences:

- referenced unique: `id, invoice_id`;
- child index: `parent_item_id, invoice_id`;
- legacy child index: `parent_item_id`;
- legacy self-FK: child `parent_item_id` → referenced `id`;
- composite self-FK: child `parent_item_id, invoice_id` → referenced `id, invoice_id`.

Throw clear manual-intervention error for conflicting desired names or multiple legacy self-FKs.

- [ ] **Step 4: Implement two resumable DDL stages**

Stage 1 builds only missing clauses while old FK remains:

```sql
ALTER TABLE `order_items`
  ADD UNIQUE KEY `uq_order_items_id_invoice` (`id`, `invoice_id`),
  ADD KEY `idx_order_items_parent_invoice` (`parent_item_id`, `invoice_id`),
  ADD CONSTRAINT `chk_order_items_quantity_positive` CHECK (`quantity` > 0)
```

Stage 2 discovers actual legacy FK/index names, then atomically swaps using quoted identifiers built from `information_schema` results:

```js
const ident = value => `\`${String(value).replaceAll('`', '``')}\``;
const dropIndex = legacyParentIndex
    ? `, DROP INDEX ${ident(legacyParentIndex.name)}`
    : '';
await conn.query(`
    ALTER TABLE \`order_items\`
      DROP FOREIGN KEY ${ident(legacyFk.name)}
      ${dropIndex},
      ADD CONSTRAINT \`fk_order_items_parent_invoice\`
        FOREIGN KEY (\`parent_item_id\`, \`invoice_id\`)
        REFERENCES \`order_items\` (\`id\`, \`invoice_id\`)
        ON DELETE CASCADE
`);
```

If no disposable exact single-column parent index exists, omit only `DROP INDEX`; never guess.

CLI flow:

1. Connect and print DB/version.
2. Scan and print every finding.
3. Exit nonzero on findings.
4. If confirmation does not equal current DB name, print `Scan clean; no DDL applied.` and exit zero.
5. Apply/resume stage 1.
6. Re-read schema.
7. Apply/resume stage 2.
8. Re-read schema and assert final CHECK/index/composite-FK state before success message.

Use:

```js
if (require.main === module) run().catch(...);
module.exports = { scanBundleIntegrity, readBundleConstraintState, applyBundleIntegrityConstraints };
```

- [ ] **Step 5: Update seeded schema**

In `backend/tests/fixtures/seed.js`, replace single parent index/FK with:

```sql
UNIQUE KEY uq_order_items_id_invoice (id, invoice_id),
KEY idx_order_items_parent_invoice (parent_item_id, invoice_id),
CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0),
CONSTRAINT fk_order_items_parent_invoice
  FOREIGN KEY (parent_item_id, invoice_id)
  REFERENCES order_items (id, invoice_id)
  ON DELETE CASCADE
```

Keep existing `invoice_id → orders` cascade. Proven MariaDB dual-cascade behavior leaves no child rows after order delete.

- [ ] **Step 6: Run migration tests serially**

```powershell
npx vitest run backend/tests/unit/bundleIntegrityMigration.test.js --reporter=verbose
npx vitest run backend/tests/integration/bundleIntegrityMigration.test.js --reporter=verbose --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
```

Expected: both files pass. Do not assert MariaDB's CHECK error code; MariaDB 10.4 reports an unintuitive mysql2 code. Assert rejection and final schema/row state.

- [ ] **Step 7: Run scanner against configured DB without DDL**

```powershell
Remove-Item Env:BUNDLE_INTEGRITY_MIGRATION_CONFIRM -ErrorAction SilentlyContinue
node backend/migrations/apply-bundle-integrity-constraints.js
```

Expected: clean scan and exact message `Scan clean; no DDL applied.` No schema mutation.

- [ ] **Step 8: Commit**

```powershell
git add -- backend/migrations/apply-bundle-integrity-constraints.js backend/tests/fixtures/seed.js backend/tests/unit/bundleIntegrityMigration.test.js backend/tests/integration/bundleIntegrityMigration.test.js
git commit -m "feat(db): prevent corrupt bundle relationships"
```

---

### Task 6: Recovery/rollout runbook and complete verification

**Files:**
- Create: `docs/superpowers/runbooks/2026-07-12-bundle-integrity-rollout.md`
- Modify only if implementation discoveries require factual correction: `docs/superpowers/specs/2026-07-12-bundle-corruption-recovery-design.md`

**Interfaces:**
- Documents scan, apply, recovery, rollback, and smoke verification.

- [ ] **Step 1: Write runbook**

Runbook must contain exact PowerShell commands:

```powershell
# Scan only
Remove-Item Env:BUNDLE_INTEGRITY_MIGRATION_CONFIRM -ErrorAction SilentlyContinue
node backend/migrations/apply-bundle-integrity-constraints.js

# Apply only after backup and clean scan
$targetDb = ((Get-Content .env | Where-Object { $_ -match '^DB_NAME=' }) -replace '^DB_NAME=', '').Trim()
if (-not $targetDb) { throw 'DB_NAME is missing from .env' }
$env:BUNDLE_INTEGRITY_MIGRATION_CONFIRM=$targetDb
node backend/migrations/apply-bundle-integrity-constraints.js
Remove-Item Env:BUNDLE_INTEGRITY_MIGRATION_CONFIRM
```

Deployment order:

1. Backup.
2. Scan.
3. Resolve every finding manually or stop.
4. Apply DB constraints.
5. Deploy backend.
6. Smoke test bundle save, hold, recall, kitchen fire, split, settle, merge, partial void/refund, receipt detail/reprint.
7. Monitor `BUNDLE_ORDER_CORRUPT`.

Runbook must state: any manual import/session that disables `FOREIGN_KEY_CHECKS` or `check_constraint_checks` must rerun scanner before POS traffic resumes. Re-enabling MariaDB checks does not retroactively validate rows inserted while checks were off.

Recovery section must state no generic repair SQL. It requires owner evidence, one transaction, open-order total recompute when priced parent qty changes, stock/accounting review, scanner rerun. For corrupt held JSON: an unfired hold may be owner-approved for discard/re-add; a kitchen-fired hold cannot be silently discarded and requires served-food/accounting review.

Rollback order:

1. Add/reuse single `(parent_item_id)` index.
2. In one ALTER, drop composite FK and add single-column self-FK.
3. Drop composite child index, referenced unique index, and CHECK only after old FK is restored.
4. Do not mutate/delete order data during constraint rollback.

- [ ] **Step 2: Run focused unit/read suites**

```powershell
npx vitest run backend/tests/unit/bundleIntegrity.test.js backend/tests/unit/bundleIntegrityMigration.test.js backend/tests/integration/bundle.print.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
```

Expected: all pass.

- [ ] **Step 3: Run DB integration files serially**

Run each command separately; do not combine files into one parallel Vitest invocation:

```powershell
npx vitest run backend/tests/integration/bundle.checkout.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/bundle.tables.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/heldOrders.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/bundle.heldOrders.fire.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/tables.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/refunds.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/adminRouting.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/print.authz.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
npx vitest run backend/tests/integration/bundleIntegrityMigration.test.js --reporter=dot --no-file-parallelism --maxWorkers=1 --maxConcurrency=1
```

Expected: every command exits 0. Negative-path error logs are expected where tests assert 409.

- [ ] **Step 4: Build and static audit**

```powershell
npm run build
rg -n "Number\(.*quantity.*\) \|\| 1|sub\.qty \|\| 1|parent_item_id.*undefined|BUNDLE_ORDER_CORRUPT" backend
git diff --check
git status --short
```

Expected:

- build exits 0;
- no bundle quantity fallback remains;
- every typed catch forwards code/publicCode according to transport;
- only intentional task files plus unrelated pre-existing `mockup-orders.html` deletion appear before commit;
- no whitespace errors.

- [ ] **Step 5: Schema-drift operational gate**

Do not apply DDL to `.env` DB merely to make drift validation green. After owner runs migration on intended local/deployment DB, run:

```powershell
node scripts/validate-schema-drift.js
```

Expected: zero drift. Before owner-approved DB migration, report expected new-index drift honestly; do not weaken or bypass the validator.

- [ ] **Step 6: Commit**

```powershell
git add -- docs/superpowers/runbooks/2026-07-12-bundle-integrity-rollout.md docs/superpowers/specs/2026-07-12-bundle-corruption-recovery-design.md
git commit -m "docs(pos): add bundle integrity rollout"
```

## Final Acceptance Audit

- [ ] Corrupt persisted bundles cannot reach money, stock, audit, kitchen, receipt, deletion, or lifecycle writes.
- [ ] Split held row is validated before deletion.
- [ ] Held kitchen row is validated before `kitchen_fired=1`.
- [ ] Duplicate checkout cannot swallow bundle corruption.
- [ ] Table merge validates source and target.
- [ ] Admin table cashout validates hidden old table order even without `edit_invoice_id`.
- [ ] Refund catch preserves 409/code instead of converting to 500.
- [ ] Held/history lists isolate corrupt row instead of failing whole list.
- [ ] Valid historical bundle ignores current catalog definition changes.
- [ ] Migration scanner includes all non-positive order-item quantities.
- [ ] Stage-1 interruption leaves old FK active.
- [ ] Stage-2 failure leaves old FK active.
- [ ] Composite FK rejects cross-invoice links and preserves cascades.
- [ ] No automatic repair, quarantine schema, frontend work, or unrelated refactor exists.
