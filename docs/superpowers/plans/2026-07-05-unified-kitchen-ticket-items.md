# Unified Kitchen Ticket Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify kitchen item preparation so held orders, table saves, and `/api/print/print` kitchen tickets all send one canonical item shape into `printKitchenOrder()`.

**Architecture:** Keep `printKitchenOrder()` in `backend/routes/print.js` as the only category-to-printer routing function. Add a small shared service that converts cart rows, table diff rows, and DB order item rows into canonical kitchen-ticket items with stable line identity, trusted product/category data, bundle preservation, and safe fallbacks. Each caller keeps its own business identity rules so held-order kitchen fire still does not create invoice/order/payment side effects.

**Tech Stack:** Node.js CommonJS, Express 5, MySQL via `mysql2/promise`, Vitest + Supertest.

## Global Constraints

- Do not touch `pos-spooler-printer/`; this is backend item preparation only.
- Do not create invoice numbers, paid order IDs, payments, or checkout side effects for held-order fire kitchen.
- Do not remove `printKitchenOrder()` routing behavior: category mapping, parent-category fallback, "other items", bundle expansion, queue creation.
- Do not change table incremental diff semantics in `getNewItems()`; table-save kitchen firing may still aggregate product+note increases to avoid phantom reprints.
- Preserve route-specific trust rules: held-order fire may keep existing custom/client category fallback, but table-save kitchen firing must stay strict and must not route client-only custom categories that do not resolve to a product row.
- Preserve Arabic-safe image rendering and existing kitchen payload fields.
- Use TDD: each behavior change starts with a failing test, then minimal implementation, then affected suite verification.
- Run single Vitest files with `npx vitest run <path>` from `C:\xampp\htdocs\posapp`; do not use Jest.
- Seed-heavy integration suites must run sequentially, not in parallel, because they recreate the same test database.

---

## File Structure

- Create `backend/services/kitchenTicketItems.js`
  - Owns canonical kitchen item normalization.
  - Has no Express dependency and no printing/queue side effects.
  - Accepts a DB-like object with `query(sql, params)` so routes can pass `pool` or transaction/connection objects.

- Create `backend/tests/unit/kitchenTicketItems.test.js`
  - Fast unit tests for duplicate rows, stale categories, product_id vs id, custom items, and bundles.

- Modify `backend/routes/pos/orders.js`
  - Remove route-local held-order kitchen normalization helpers.
  - Use `normalizeKitchenTicketItems()` before calling `printKitchenOrder()`.

- Modify `backend/tests/integration/heldOrders.fireKitchen.test.js`
  - Keep the held-order duplicate/category regression green.
  - Add one assertion that product IDs are not rewritten from `product_id` to `id` incorrectly.

- Modify `backend/routes/pos/tables.js`
  - Use `normalizeKitchenTicketItems()` after `getNewItems()` and before `printKitchenOrder()`.
  - Keep `getNewItems()` unchanged.

- Modify `backend/routes/print.js`
  - Use `normalizeKitchenTicketItems()` for `/api/print/print` kitchen tickets after DB order items are loaded.
  - Keep `expandBundlesForKitchen()` and `printKitchenOrder()` in place.

- Modify `backend/tests/unit/print.unit.test.js`
  - Add route-level regression coverage for two DB order item rows with the same product.

---

### Task 1: Add The Shared Kitchen Item Normalizer

**Files:**
- Create: `backend/services/kitchenTicketItems.js`
- Create: `backend/tests/unit/kitchenTicketItems.test.js`

**Interfaces:**
- Produces: `async normalizeKitchenTicketItems(rawItems, { db, linePrefix = 'kitchen-line' })`
- Returns: `Array<{ id, product_id, cartId, category_id, name, qty, note, is_bundle, bundleItems? }>`
- Consumes: a DB-like object with `query(sql, params)` that returns `[rows]`.

- [ ] **Step 1: Write failing unit tests**

Create `backend/tests/unit/kitchenTicketItems.test.js`:

```js
const { describe, it, expect, vi } = require('vitest');
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');

function fakeDb(products) {
    return {
        query: vi.fn(async (sql, params) => {
            expect(sql).toContain('FROM products');
            const wanted = new Set(params.map(Number));
            return [products.filter(product => wanted.has(Number(product.id)))];
        })
    };
}

describe('normalizeKitchenTicketItems', () => {
    it('preserves repeated cart rows as distinct kitchen lines and refreshes categories from products', async () => {
        const db = fakeDb([
            { id: 1, name: 'Test Burger', category_id: 10, is_bundle: 0 },
            { id: 2, name: 'Test Drink', category_id: 20, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            { id: 1, product_id: 1, cartId: 'cart-a', name: 'Old Burger', qty: 1, category_id: 999 },
            { id: 1, product_id: 1, name: 'Old Burger', qty: 1, category_id: 999 },
            { id: 2, product_id: 2, cartId: 'cart-c', name: 'Old Drink', quantity: 3, category_id: 999 }
        ], { db, linePrefix: 'held-42' });

        expect(items).toHaveLength(3);
        expect(items.map(item => item.cartId)).toEqual(['cart-a', 'held-42-2-1', 'cart-c']);
        expect(new Set(items.map(item => item.cartId)).size).toBe(3);
        expect(items.map(item => item.product_id)).toEqual([1, 1, 2]);
        expect(items.map(item => item.category_id)).toEqual([10, 10, 20]);
        expect(items[2].qty).toBe(3);
    });

    it('uses product_id ahead of id when a cart row has both fields', async () => {
        const db = fakeDb([
            { id: 7, name: 'Real Product', category_id: 70, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            { id: 'frontend-row-1', product_id: 7, name: 'Client Name', qty: 2, category_id: 999 }
        ], { db, linePrefix: 'held-99' });

        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('frontend-row-1');
        expect(items[0].product_id).toBe(7);
        expect(items[0].category_id).toBe(70);
        expect(items[0].cartId).toBe('held-99-1-7');
    });

    it('preserves custom items without product lookup matches', async () => {
        const db = fakeDb([]);

        const items = await normalizeKitchenTicketItems([
            { id: 'CUSTOM_1', name: 'Manual Kitchen Item', qty: 1, category_id: 55, note: 'no onion' }
        ], { db, linePrefix: 'held-custom' });

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            id: 'CUSTOM_1',
            product_id: null,
            cartId: 'held-custom-1-CUSTOM_1',
            category_id: 55,
            name: 'Manual Kitchen Item',
            qty: 1,
            note: 'no onion',
            is_bundle: 0
        });
    });

    it('normalizes bundle sub-items with their own line identity and refreshed categories', async () => {
        const db = fakeDb([
            { id: 4, name: 'Family Package', category_id: 40, is_bundle: 1 },
            { id: 1, name: 'Burger', category_id: 10, is_bundle: 0 },
            { id: 2, name: 'Drink', category_id: 20, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            {
                id: 4,
                product_id: 4,
                cartId: 'bundle-parent',
                name: 'Package',
                qty: 2,
                category_id: 999,
                is_bundle: true,
                bundleItems: [
                    { product_id: 1, name: 'Old Burger', qty: 1, category_id: 999, removed: false },
                    { product_id: 2, name: 'Old Drink', qty: 1, category_id: 999, removed: true }
                ]
            }
        ], { db, linePrefix: 'held-bundle' });

        expect(items).toHaveLength(1);
        expect(items[0].is_bundle).toBeTruthy();
        expect(items[0].category_id).toBe(40);
        expect(items[0].bundleItems).toHaveLength(2);
        expect(items[0].bundleItems[0].product_id).toBe(1);
        expect(items[0].bundleItems[0].category_id).toBe(10);
        expect(items[0].bundleItems[0].cartId).toBe('bundle-parent-bundle-1-1');
        expect(items[0].bundleItems[1].removed).toBe(true);
        expect(items[0].bundleItems[1].category_id).toBe(20);
    });

    it('preserves DB-row bundle parent links so print expansion can attach bundle labels', async () => {
        const db = fakeDb([
            { id: 4, name: 'Family Package', category_id: 40, is_bundle: 1 },
            { id: 1, name: 'Burger', category_id: 10, is_bundle: 0 }
        ]);

        const items = await normalizeKitchenTicketItems([
            { id: 900, product_id: 4, name: 'Family Package', quantity: 1, category_id: 999, is_bundle: 1 },
            { id: 901, parent_item_id: 900, product_id: 1, name: 'Burger', quantity: 2, category_id: 999, is_bundle: 0 }
        ], { db, linePrefix: 'order-44' });

        expect(items).toHaveLength(2);
        expect(items[1].parent_item_id).toBe(900);
        expect(items[1].cartId).toBe('order-44-2-1');
        expect(items[1].qty).toBe(2);
        expect(items[1].category_id).toBe(10);
    });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
npx vitest run backend/tests/unit/kitchenTicketItems.test.js
```

Expected: FAIL because `../../services/kitchenTicketItems` does not exist.

- [ ] **Step 3: Create the shared service**

Create `backend/services/kitchenTicketItems.js`:

```js
function toPositiveIntOrNull(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function getKitchenProductId(item) {
    if (!item || typeof item !== 'object') return null;
    return toPositiveIntOrNull(item.product_id ?? item.id);
}

function buildKitchenCartId(item, index, productId, prefix) {
    if (item && item.cartId !== undefined && item.cartId !== null && String(item.cartId).trim() !== '') {
        return String(item.cartId);
    }
    const suffix = productId || (item && item.id !== undefined ? item.id : 'custom');
    return `${prefix}-${index + 1}-${suffix}`;
}

function collectProductIds(items, out = new Set()) {
    for (const item of Array.isArray(items) ? items : []) {
        const productId = getKitchenProductId(item);
        if (productId) out.add(productId);
        if (Array.isArray(item?.bundleItems)) collectProductIds(item.bundleItems, out);
    }
    return out;
}

async function loadProductsById(db, productIds) {
    if (!db || typeof db.query !== 'function') {
        throw new Error('normalizeKitchenTicketItems requires a db query object.');
    }
    if (productIds.length === 0) return new Map();

    const placeholders = productIds.map(() => '?').join(',');
    const [products] = await db.query(
        `SELECT id, name, category_id, is_bundle FROM products WHERE id IN (${placeholders})`,
        productIds
    );

    const productById = new Map();
    for (const product of products) productById.set(Number(product.id), product);
    return productById;
}

function normalizeBundleItems(bundleItems, { parentCartId, productById }) {
    return bundleItems.map((subItem, subIndex) => {
        const productId = getKitchenProductId(subItem);
        const product = productId ? productById.get(productId) : null;
        const cartId = buildKitchenCartId(subItem, subIndex, productId, `${parentCartId}-bundle`);

        return {
            ...subItem,
            id: subItem.id ?? productId ?? cartId,
            product_id: productId,
            cartId,
            category_id: product ? product.category_id : subItem.category_id,
            name: subItem.name || product?.name || '',
            qty: subItem.qty ?? subItem.quantity ?? 1,
            note: subItem.note || '',
            is_bundle: subItem.is_bundle || product?.is_bundle || 0
        };
    });
}

async function normalizeKitchenTicketItems(rawItems, { db, linePrefix = 'kitchen-line' } = {}) {
    const list = Array.isArray(rawItems) ? rawItems : [];
    const productIds = [...collectProductIds(list)].sort((a, b) => a - b);
    const productById = await loadProductsById(db, productIds);

    return list.map((item, index) => {
        const productId = getKitchenProductId(item);
        const product = productId ? productById.get(productId) : null;
        const cartId = buildKitchenCartId(item, index, productId, linePrefix);
        const bundleItems = Array.isArray(item.bundleItems)
            ? normalizeBundleItems(item.bundleItems, { parentCartId: cartId, productById })
            : null;

        return {
            ...item,
            id: item.id ?? productId ?? cartId,
            product_id: productId,
            cartId,
            category_id: product ? product.category_id : item.category_id,
            name: item.name || item.item_name || product?.name || 'Unknown Item',
            qty: item.qty ?? item.quantity ?? 1,
            note: item.note || '',
            is_bundle: item.is_bundle || product?.is_bundle || 0,
            ...(bundleItems ? { bundleItems } : {})
        };
    });
}

module.exports = {
    normalizeKitchenTicketItems,
    toPositiveIntOrNull,
    getKitchenProductId,
    buildKitchenCartId
};
```

- [ ] **Step 4: Run the service tests and verify they pass**

Run:

```bash
npx vitest run backend/tests/unit/kitchenTicketItems.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/services/kitchenTicketItems.js backend/tests/unit/kitchenTicketItems.test.js
git commit -m "test(pos): cover canonical kitchen item normalization"
```

---

### Task 2: Move Held-Order Fire Kitchen Onto The Shared Normalizer

**Files:**
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/tests/integration/heldOrders.fireKitchen.test.js`

**Interfaces:**
- Consumes: `normalizeKitchenTicketItems(rawItems, { db: pool, linePrefix: 'held-<id>' })`
- Produces: Held-order `fire_kitchen` still calls `printKitchenOrder(req.io, payload)` with `invoice_id: ''` and no invoice number.

- [ ] **Step 1: Confirm the held-order regression test fails if the route-local fix is removed**

Run before editing:

```bash
npx vitest run backend/tests/integration/heldOrders.fireKitchen.test.js
```

Expected on the current fixed working tree: PASS. If the old route-local mapper is reverted, this test must FAIL on duplicate line identity or stale category assertions.

- [ ] **Step 2: Replace local normalization helpers with service import**

In `backend/routes/pos/orders.js`, add near the other imports:

```js
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');
```

Delete these route-local helper functions from `backend/routes/pos/orders.js`:

```js
function toPositiveIntOrNull(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function getHeldKitchenProductId(item) {
    if (!item || typeof item !== 'object') return null;
    return toPositiveIntOrNull(item.product_id ?? item.id);
}

function buildHeldKitchenCartId(item, index, productId, prefix = 'held-line') {
    if (item && item.cartId !== undefined && item.cartId !== null && String(item.cartId).trim() !== '') {
        return String(item.cartId);
    }
    const suffix = productId || (item && item.id !== undefined ? item.id : 'custom');
    return `${prefix}-${index + 1}-${suffix}`;
}

async function normalizeHeldKitchenItems(rawItems) {
    const list = Array.isArray(rawItems) ? rawItems : [];
    const productIds = [...new Set(list.map(getHeldKitchenProductId).filter(Boolean))];
    const productById = new Map();

    if (productIds.length > 0) {
        const placeholders = productIds.map(() => '?').join(',');
        const [products] = await pool.query(
            `SELECT id, name, category_id, is_bundle FROM products WHERE id IN (${placeholders})`,
            productIds
        );
        for (const product of products) productById.set(Number(product.id), product);
    }

    return list.map((item, index) => {
        const productId = getHeldKitchenProductId(item);
        const product = productId ? productById.get(productId) : null;
        const cartId = buildHeldKitchenCartId(item, index, productId);
        const bundleItems = Array.isArray(item.bundleItems)
            ? item.bundleItems.map((subItem, subIndex) => {
                const subProductId = getHeldKitchenProductId(subItem);
                return {
                    ...subItem,
                    id: subItem.id ?? subProductId ?? `${cartId}-bundle-${subIndex + 1}`,
                    product_id: subProductId,
                    cartId: buildHeldKitchenCartId(subItem, subIndex, subProductId, `${cartId}-bundle`),
                    qty: subItem.qty ?? subItem.quantity ?? 1,
                    note: subItem.note || ''
                };
            })
            : null;

        return {
            id: item.id ?? productId ?? cartId,
            product_id: productId,
            cartId,
            category_id: product ? product.category_id : item.category_id,
            name: item.name || product?.name || '',
            qty: item.qty ?? item.quantity ?? 1,
            note: item.note || '',
            is_bundle: item.is_bundle || product?.is_bundle || 0,
            ...(bundleItems ? { bundleItems } : {})
        };
    });
}
```

Replace the held-order route line:

```js
const items = await normalizeHeldKitchenItems(rawItems);
```

with:

```js
const items = await normalizeKitchenTicketItems(rawItems, {
    db: pool,
    linePrefix: `held-${id}`
});
```

- [ ] **Step 3: Strengthen the held-order regression test**

In `backend/tests/integration/heldOrders.fireKitchen.test.js`, after:

```js
expect(product1Lines).toHaveLength(2);
```

add:

```js
expect(product1Lines.map(item => item.product_id)).toEqual([SEED.product1.id, SEED.product1.id]);
expect(product1Lines.map(item => item.id)).toEqual([SEED.product1.id, SEED.product1.id]);
```

This proves the service preserves the current cart item ID while still using `product_id` for authoritative DB lookup.

- [ ] **Step 4: Run held-order tests**

Run sequentially:

```bash
npx vitest run backend/tests/integration/heldOrders.fireKitchen.test.js
npx vitest run backend/tests/integration/bundle.heldOrders.fire.test.js
npx vitest run backend/tests/integration/heldOrders.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add backend/routes/pos/orders.js backend/tests/integration/heldOrders.fireKitchen.test.js
git commit -m "fix(pos): use shared kitchen item normalization for held orders"
```

---

### Task 3: Use The Shared Normalizer For Table-Save Kitchen Tickets Without Changing Table Diff Semantics

**Files:**
- Modify: `backend/routes/pos/tables.js`
- Test: `backend/tests/integration/tables.test.js`
- Test: `backend/tests/integration/bundle.tables.test.js`

**Interfaces:**
- Consumes: `normalizeKitchenTicketItems(newItemsToPrint, { db: conn, linePrefix: 'table-<order_id>' })`
- Preserves: `getNewItems(cartItems, existingItemsForPrint)` remains the only table incremental diff rule.

- [ ] **Step 1: Add a regression test for table lines that differ by note but lack cart IDs**

In `backend/tests/integration/tables.test.js`, add a test near the existing table kitchen identity tests:

```js
it('table-save kitchen ticket keeps same-product different-note lines distinct when cartId is missing', async () => {
    const [printerResult] = await pool.query(
        `INSERT INTO printers (name, role, type, windows_name, is_active)
         VALUES ('Kitchen Different Notes', 'kitchen', 'windows', 'Kitchen-Diff-Notes', 1)`
    );
    const printerId = printerResult.insertId;
    await pool.query(
        'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
        [printerId, SEED.category.id]
    );

    try {
        const createRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                require_update_permission: true,
                user_id: SEED.waiterUser.id,
                shift_id: null,
                table_id: SEED.table.id,
                table_number: '1',
                current_order_id: null,
                cart: [
                    { id: SEED.product1.id, product_id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, note: 'no salt', category_id: 999 },
                    { id: SEED.product1.id, product_id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, note: 'extra spicy', category_id: 999 }
                ],
                subtotal: 10,
                tax: 1.6,
                total: 11.6
            });

        expect(createRes.statusCode).toBe(200);

        const [[job]] = await pool.query(
            "SELECT payload FROM print_queue WHERE print_type = 'kitchen' ORDER BY id DESC LIMIT 1"
        );
        const payload = JSON.parse(job.payload);
        const primaryItems = payload.data.items.filter(item => !item._isOther);

        expect(primaryItems).toHaveLength(2);
        expect(primaryItems.map(item => item.note).sort()).toEqual(['extra spicy', 'no salt']);
        expect(new Set(primaryItems.map(item => item.cartId)).size).toBe(2);
        expect(primaryItems.map(item => item.category_id)).toEqual([SEED.category.id, SEED.category.id]);
    } finally {
        await pool.query('DELETE FROM printer_categories WHERE printer_id = ?', [printerId]);
        await pool.query('DELETE FROM printers WHERE id = ?', [printerId]);
    }
});
```

Expected behavior: table save still uses `getNewItems()` for incremental diffing, so different notes become two print lines. The generated kitchen payload must keep both lines distinct even when the incoming cart omitted `cartId`.

- [ ] **Step 2: Run the new table test and verify it fails before route integration**

Run:

```bash
npx vitest run backend/tests/integration/tables.test.js -t "same-product different-note"
```

Expected before this task's implementation: FAIL because both lines reach `printKitchenOrder()` with the same `id` and no `cartId`, so the second note is deduped out of the queued ticket.

- [ ] **Step 3: Import the shared normalizer in `tables.js`**

Add near existing imports in `backend/routes/pos/tables.js`:

```js
const { normalizeKitchenTicketItems } = require('../../services/kitchenTicketItems');
```

- [ ] **Step 4: Replace the manual kitchen item mapping inside the existing print guard**

Inside the existing `if (newItemsToPrint.length > 0) { ... }` block, replace the current `const itemsWithDetails = ...`, `if (itemsWithDetails.length > 0) { ... }`, and inner `try/catch` shown below:

```js
const itemsWithDetails = newItemsToPrint.map(item => {
    const product = productMap.get(item.product_id);
    return {
        // Spread preserves is_bundle + bundleItems (each sub carries its own
        // product_id/name/qty/category_id/removed) so printKitchenOrder's
        // expandBundlesForKitchen can route the SUB-items, not the parent.
        ...item,
        category_id: product ? product.category_id : null,
        name: product ? product.name : (item.name || 'Unknown Item'),
        price: item.price
    };
    // Bundle lines must always pass: even when the bundle parent has a null
    // category_id (so would route nowhere) its sub-items still need routing.
    // The parent itself is dropped during expansion; subs carry their own cat.
}).filter(item => item.category_id !== null || Array.isArray(item.bundleItems));
```

with:

```js
try {
    const itemsWithDetails = (await normalizeKitchenTicketItems(newItemsToPrint, {
        db: conn,
        linePrefix: `table-${order_id}`
    })).filter(item => {
        if (Array.isArray(item.bundleItems)) return true;
        return item.product_id !== null
            && productMap.has(Number(item.product_id))
            && item.category_id !== null;
    });

    if (itemsWithDetails.length > 0) {
        await printRouter.printKitchenOrder(req.io, {
            print_batch_id: `table-${order_id}-${crypto.randomUUID()}`,
            internal_invoice_id: order_id,
            invoice_id: order_id,
            invoice_number: null,
            invoice_display_no: null,
            order_display_no: saveIdentity.order_display_no,
            ticket_display_no: saveIdentity.ticket_display_no || saveIdentity.order_display_no,
            order_id: saveIdentity.ticket_display_no || saveIdentity.order_display_no || null,
            table_number: resolvedTable?.table_number || data.table_number || '',
            order_type_name: 'Table',
            order_taken_at: identityRow?.created_at || null,
            date: identityRow?.created_at || null,
            items: itemsWithDetails
        });
    }
} catch (printErr) {
    logger.error({
        err: printErr,
        route: req.originalUrl,
        method: req.method,
        userId: req.user?.id,
        role: req.user?.role,
        invoiceId: order_id,
        tableId: data.table_id
    }, 'Kitchen ticket print failed after table order commit.');
}
```

Keep this normalization inside the existing print `try/catch`. The table order has already committed, so product re-query or print failures must be logged as print failures and must not make the committed save return 500. The filter deliberately preserves the old table policy: table-save only routes items backed by server product rows, while bundle parents may pass because their sub-items carry the actual kitchen categories.

- [ ] **Step 5: Run table and bundle table tests**

Run sequentially:

```bash
npx vitest run backend/tests/integration/tables.test.js -t "same-product different-note"
npx vitest run backend/tests/integration/bundle.tables.test.js
npx vitest run backend/tests/integration/tables.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "refactor(pos): normalize table kitchen ticket items centrally"
```

---

### Task 4: Use The Shared Normalizer For `/api/print/print` Kitchen Tickets

**Files:**
- Modify: `backend/routes/print.js`
- Modify: `backend/tests/unit/print.unit.test.js`

**Interfaces:**
- Consumes: `normalizeKitchenTicketItems(dbItems, { db: pool, linePrefix: 'order-<invoice_id>' })`
- Preserves: paid register tickets keep invoice identity; open table kitchen tickets keep invoice display fields null.

- [ ] **Step 1: Add route-level regression for two DB rows with the same product**

In `backend/tests/unit/print.unit.test.js`, inside `describe('receipt identity via POST /print route', ...)`, add these two tests:

```js
it('kitchen print route keeps repeated DB order item rows distinct before routing', async () => {
    receiptQuerySpy.mockImplementation(async (sql, params) => {
        if (sql.includes('FROM settings')) return [[{ key_name: 'store_name', value: 'Test Store' }]];
        if (sql.includes('FROM orders o')) {
            return [[{
                invoice_id: 888,
                order_id: 22,
                invoice_number: 5,
                invoice_issued_at: '2026-07-05 12:00:00',
                created_at: '2026-07-05 11:59:00',
                payment_method: 'cash',
                table_id: null,
                waiter_id: null,
                order_type_name: 'Dine In'
            }]];
        }
        if (sql.includes('FROM order_items')) {
            return [[
                { id: 501, invoice_id: 888, product_id: 1, item_name: null, name: 'Burger', quantity: 1, category_id: 999, is_bundle: 0 },
                { id: 502, invoice_id: 888, product_id: 1, item_name: null, name: 'Burger', quantity: 1, category_id: 999, is_bundle: 0 }
            ]];
        }
        if (sql.includes('FROM restaurant_tables')) return [[]];
        if (sql.includes('SELECT id, name, category_id, is_bundle FROM products')) {
            return [[{ id: 1, name: 'Test Burger', category_id: 1, is_bundle: 0 }]];
        }
        if (sql.includes('FROM categories')) return [[{ id: 1, parent_id: null }]];
        if (sql.includes("role = 'kitchen'")) {
            return [[{
                category_id: 1,
                id: 10,
                name: 'Kitchen',
                role: 'kitchen',
                type: 'windows',
                windows_name: 'Kitchen-1',
                is_active: 1
            }]];
        }
        if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 990 }];
        if (sql.includes('UPDATE print_queue')) return [{}];
        return [[]];
    });

    const res = await request(app)
        .post('/print/print')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ print_type: 'kitchen', invoice_id: 888 });

    expect(res.statusCode).toBe(200);
    const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
    const payload = JSON.parse(insertCall[1][0]);
    const primaryItems = payload.data.items.filter(item => !item._isOther);
    expect(primaryItems).toHaveLength(2);
    expect(primaryItems.map(item => item.cartId)).toEqual(['order-888-1-1', 'order-888-2-1']);
    expect(primaryItems.map(item => item.category_id)).toEqual([1, 1]);
});

it('kitchen print route preserves DB bundle parent links so child items keep bundle labels', async () => {
    receiptQuerySpy.mockImplementation(async (sql, params) => {
        if (sql.includes('FROM settings')) return [[{ key_name: 'store_name', value: 'Test Store' }]];
        if (sql.includes('FROM orders o')) {
            return [[{
                invoice_id: 889,
                order_id: 23,
                invoice_number: 6,
                invoice_issued_at: '2026-07-05 12:05:00',
                created_at: '2026-07-05 12:04:00',
                payment_method: 'cash',
                table_id: null,
                waiter_id: null,
                order_type_name: 'Dine In'
            }]];
        }
        if (sql.includes('FROM order_items')) {
            return [[
                { id: 700, invoice_id: 889, product_id: 4, item_name: null, name: 'Family Package', quantity: 1, category_id: 999, is_bundle: 1 },
                { id: 701, invoice_id: 889, parent_item_id: 700, product_id: 1, item_name: null, name: 'Burger', quantity: 2, category_id: 999, is_bundle: 0 }
            ]];
        }
        if (sql.includes('FROM restaurant_tables')) return [[]];
        if (sql.includes('SELECT id, name, category_id, is_bundle FROM products')) {
            return [[
                { id: 4, name: 'Family Package', category_id: 1, is_bundle: 1 },
                { id: 1, name: 'Test Burger', category_id: 1, is_bundle: 0 }
            ]];
        }
        if (sql.includes('FROM categories')) return [[{ id: 1, parent_id: null }]];
        if (sql.includes("role = 'kitchen'")) {
            return [[{
                category_id: 1,
                id: 10,
                name: 'Kitchen',
                role: 'kitchen',
                type: 'windows',
                windows_name: 'Kitchen-1',
                is_active: 1
            }]];
        }
        if (sql.includes('INSERT INTO print_queue')) return [{ insertId: 991 }];
        if (sql.includes('UPDATE print_queue')) return [{}];
        return [[]];
    });

    const res = await request(app)
        .post('/print/print')
        .set('Authorization', `Bearer ${TEST_TOKEN}`)
        .send({ print_type: 'kitchen', invoice_id: 889 });

    expect(res.statusCode).toBe(200);
    const insertCall = receiptQuerySpy.mock.calls.find(c => c[0].includes('INSERT INTO print_queue'));
    const payload = JSON.parse(insertCall[1][0]);
    const primaryItems = payload.data.items.filter(item => !item._isOther);
    expect(primaryItems).toHaveLength(1);
    expect(primaryItems[0].product_id).toBe(1);
    expect(primaryItems[0]._bundleLabel).toBe('Family Package');
    expect(primaryItems[0].parent_item_id).toBe(700);
});
```

- [ ] **Step 2: Run the new route tests and verify the intended red/green split before integration**

Run:

```bash
npx vitest run backend/tests/unit/print.unit.test.js -t "repeated DB order item rows"
npx vitest run backend/tests/unit/print.unit.test.js -t "bundle parent links"
```

Expected before this task's implementation: the repeated-row test FAILS because the `/print` kitchen route maps DB items inline and does not assign canonical `cartId` values. The bundle-label test must PASS before Task 4 and stay PASS after Task 4; it protects against the normalizer stripping `parent_item_id`.

- [ ] **Step 3: Import the shared normalizer in `print.js`**

Add near existing imports in `backend/routes/print.js`:

```js
const { normalizeKitchenTicketItems } = require('../services/kitchenTicketItems');
```

- [ ] **Step 4: Normalize DB kitchen items before building `printPayload`**

After the `dbItems.length === 0` guard in the kitchen branch of `backend/routes/print.js`, add:

```js
const kitchenItems = await normalizeKitchenTicketItems(dbItems, {
    db: pool,
    linePrefix: `order-${invoice_id}`
});
```

Replace this field inside `printPayload`:

```js
items: dbItems.map(item => ({
    ...item,
    qty: item.quantity
})),
```

with:

```js
items: kitchenItems,
```

- [ ] **Step 5: Run print unit tests**

Run:

```bash
npx vitest run backend/tests/unit/print.unit.test.js -t "repeated DB order item rows"
npx vitest run backend/tests/unit/print.unit.test.js -t "bundle parent links"
npx vitest run backend/tests/unit/print.unit.test.js
```

Expected: all PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add backend/routes/print.js backend/tests/unit/print.unit.test.js
git commit -m "refactor(print): normalize kitchen print route items centrally"
```

---

### Task 5: Final Verification And Cleanup

**Files:**
- Inspect: `backend/routes/pos/orders.js`
- Inspect: `backend/routes/pos/tables.js`
- Inspect: `backend/routes/print.js`
- Inspect: `backend/services/kitchenTicketItems.js`
- Inspect: `backend/tests/unit/kitchenTicketItems.test.js`
- Inspect: `backend/tests/integration/heldOrders.fireKitchen.test.js`
- Inspect: `backend/tests/integration/tables.test.js`
- Inspect: `backend/tests/unit/print.unit.test.js`

**Interfaces:**
- Verifies: all kitchen entry points use the same item normalization service before `printKitchenOrder()`.
- Verifies: no caller moved checkout/payment/table ownership logic into the shared service.

- [ ] **Step 1: Search for duplicated kitchen item mapping**

Run:

```bash
rg -n "category_id: product \\?|product_id: item\\.id|normalizeHeldKitchenItems|itemsWithDetails = newItemsToPrint\\.map|dbItems\\.map\\(item => \\(\\{" backend/routes backend/services backend/tests
```

Expected: no route-local kitchen item normalizer remains. Matches inside tests or comments must be reviewed and either removed or confirmed as historical test setup.

- [ ] **Step 2: Search for accidental checkout side effects in the new service**

Run:

```bash
rg -n "invoice|payment|checkout|order_id|print_queue|enqueue|printKitchenOrder" backend/services/kitchenTicketItems.js
```

Expected: no output. The normalizer must not know about checkout identity, print queues, or payment.

- [ ] **Step 3: Run affected tests sequentially**

Run:

```bash
npx vitest run backend/tests/unit/kitchenTicketItems.test.js
npx vitest run backend/tests/integration/heldOrders.fireKitchen.test.js
npx vitest run backend/tests/integration/bundle.heldOrders.fire.test.js
npx vitest run backend/tests/integration/heldOrders.test.js
npx vitest run backend/tests/integration/bundle.tables.test.js
npx vitest run backend/tests/integration/tables.test.js
npx vitest run backend/tests/unit/print.unit.test.js
```

Expected: every command exits 0.

- [ ] **Step 4: Run broad backend and admin build checks**

Run:

```bash
npx vitest run backend/tests/unit/helpers.test.js backend/tests/unit/printJobIdentity.test.js
npm run build:admin
```

Expected: both commands exit 0.

- [ ] **Step 5: Inspect git status and final diff**

Run:

```bash
git status --short --branch
git diff --stat HEAD
```

Expected: only files from this plan are modified, plus any pre-existing untracked docs explicitly left untouched.

- [ ] **Step 6: Commit final cleanup if Task 5 changed files**

If Task 5 only verifies and changes no files, do not create an empty commit. If comments or tests are cleaned up during Task 5, commit:

```bash
git add backend/routes/pos/orders.js backend/routes/pos/tables.js backend/routes/print.js backend/services/kitchenTicketItems.js backend/tests/unit/kitchenTicketItems.test.js backend/tests/integration/heldOrders.fireKitchen.test.js backend/tests/integration/tables.test.js backend/tests/unit/print.unit.test.js
git commit -m "chore(print): verify unified kitchen ticket item flow"
```

---

## Self-Review

- Spec coverage: The plan unifies item preparation for held orders, table saves, and `/api/print/print` kitchen tickets while keeping `printKitchenOrder()` as the single printer router.
- Held-order safety: Task 2 preserves no-invoice/no-checkout behavior and keeps `kitchen_fired` semantics in the route.
- Table safety: Task 3 explicitly keeps `getNewItems()` unchanged, so existing table incremental quantity aggregation does not get accidentally rewritten.
- Printer routing safety: No task edits category-to-printer routing, parent-category fallback, queue creation, or spooler code.
- Placeholder scan: No placeholder markers or vague implementation step remains.
- Type consistency: Every task uses the same exported function name: `normalizeKitchenTicketItems(rawItems, { db, linePrefix })`.
