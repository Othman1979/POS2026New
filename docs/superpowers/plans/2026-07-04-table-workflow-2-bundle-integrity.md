# Bundle Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — dispatch each `### Task N` to a fresh subagent, one task at a time, in order. Each task is TDD: write the failing test FIRST, watch it fail, apply the minimal fix, watch it pass, run the whole file, commit. Do NOT batch tasks. Do NOT edit source before its test is red.

**Goal**
Fix three bundle-related integrity defects in the table-order workflow so a bundle table can be edited/re-saved/settled by ordinary waiters without false "printed" blocks, so bundle-member stock stops inflating on every re-save/void/settle, and so a saved custom line (product_id NULL) can no longer be silently deleted past the void gate without permission or audit.

**Architecture**
`POST /api/pos/table_order` (backend/routes/pos/tables.js) saves an open table order. A bundle is stored as one priced PARENT `order_items` row (`parent_item_id IS NULL`) plus N DB-driven zero-priced CHILD rows (`parent_item_id = parent.id`, real member `product_id`). Children are minted server-side by `insertBundleChildren` (backend/services/bundleOrderItems.js) and never appear as top-level cart lines — `normalizeCartItems` (backend/services/PosCalculator.js) does NOT flatten them. Stock is deducted parent-only via `deductStockForCart` (backend/routes/pos/helpers.js) on both the create (tables.js:1331) and update (tables.js:1307) paths. The void diff is computed by `hasVoidsOrReductions` (helpers.js); the printed-lock and audit gates live in the tables.js update path. `POST /api/pos/checkout` (backend/routes/pos/checkout.js) settles a table, creating a fresh paid order and voiding the old "ghost" table order (with a stock restore).

**Tech Stack**
Node + Express + MySQL (mysql2/promise). Tests: **Vitest** — run a single file with `npx vitest run <path>` (NEVER `npx jest`; jest gives false race/pool-closed failures). Integration tests hit the real app + test DB via supertest and `seedDatabase()` (backend/tests/fixtures/seed.js). Money via `roundMoney`/`assertNearMoney`; destructive `audit_events` are inserted on the same transaction connection before commit.

## Global Constraints

- **Working-tree baseline is ALREADY applied — do NOT re-add:** void-reason modal removed; `checkHasVoids` Map-aggregate; `item_name` COALESCE in `existingItemsForPrint` (tables.js ~1182) and in the `table_order` GET (~750); saved-row delete FE gate `(!canVoidItems||!canBypassPrintedLock)`.
- **Test runner:** `npx vitest run <file>` only. Files touched here:
  - `backend/tests/integration/bundle.tables.test.js`
  - `backend/tests/unit/helpers.test.js`
- **Money:** never weaken `assertNearMoney`; the subtotal is the anti-tamper anchor and runs before the void gate — every test payload's `subtotal` MUST equal the sum of top-level cart line prices (bundle parent counts as its parent price; children count 0).
- **Error sanitizer:** `sendError()` rewrites any message containing both "table" and "exist" (or `ER_`/`SQLSTATE`/`mysql`) to a generic error — do not phrase new messages that way; none of these fixes add user-facing messages.
- **Transaction shape:** `getConnection → beginTransaction → … → audit insert with same conn → commit`, `rollback` in `catch`. A thrown Error rolls the whole txn back (fail-closed), including audit insert failure.
- **Line numbers below were re-confirmed on 2026-07-04 but may shift** — before every Edit, re-open the file and match on the quoted BEFORE text, not the line number.
- **Sequencing:** land this plan AFTER Plan 1 (critical). See `## Cross-plan file overlap` — the P1-1 edit sits ~15–30 lines from Plan 1's audit-timing change in the same tables.js block.
- **Commit after each task** with a message naming the finding id (e.g. `fix(tables): P1-1 printed-lock loop skips bundle children`), and end each commit body with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1 — P1-1: printed-lock loop counts bundle CHILD rows, falsely blocking edits to any bundle table

Finding **P1-1** · `backend/routes/pos/tables.js:1231` · The void-detection gate filters to parents (`parentsForVoidCheck`), but the printed-lock loop right below iterates the UNFILTERED `existingItemsForPrint`, so each bundle child (a top-level-invisible row) yields `totalNewQty = 0 < child.quantity` and throws the printed-lock error unless the actor holds `pos.void_printed_item`.

**Files**
- Modify `backend/routes/pos/tables.js:1231`
- Test `backend/tests/integration/bundle.tables.test.js`

**Steps**

1. Add a shared waiter helper + two failing tests. Add this helper INSIDE the `describe('Table-order bundle support (I4)', …)` block (right after the `bundleCartItem` function), then append the two `it` blocks at the end of the same describe. FULL code:

```js
    // Re-grant the seed waiter (id=3) a precise permission set, then log in fresh so
    // the new grants load into the session. Mirrors tables.test.js grantWaiter.
    async function grantWaiterAndLogin(keys) {
        await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [SEED.waiterUser.id]);
        if (keys.length) {
            await pool.query(
                "INSERT INTO user_permissions (user_id, perm_key) VALUES ?",
                [keys.map(k => [SEED.waiterUser.id, k])]
            );
        }
        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        return res.headers['set-cookie'][0];
    }

    it('P1-1: waiter without pos.void_printed_item can ADD a line to a bundle table', async () => {
        // Waiter owns the order (creates it), has edit rights + void_item, but NOT
        // void_printed_item. The buggy printed-lock loop counts the two bundle CHILD
        // rows (product 1 & 2) as reductions and throws; the fix iterates parents only.
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        const getRes = await request(app)
            .get('/api/pos/table_order')
            .query({ order_id: orderId })
            .set('Cookie', waiterCookie);
        expect(getRes.statusCode).toBe(200);
        const reconstructed = getRes.body.cart;

        // Re-save the reconstructed bundle PLUS one new standalone line (product 3,
        // which is NOT a bundle member, so it cannot accidentally match a child row).
        const resave = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId,
                cart: [
                    ...reconstructed,
                    { id: 3, product_id: 3, name: 'No Stock Item', qty: 1, price: 3.00 }
                ],
                subtotal: 13.00, tax: 1.60, total: 14.60
            });
        expect(resave.statusCode).toBe(200);

        // Bundle parent + 2 children + the new standalone = 4 rows.
        const [items] = await pool.query(
            "SELECT * FROM order_items WHERE invoice_id = ? ORDER BY sort_order", [orderId]
        );
        expect(items).toHaveLength(4);
        const parent = items.find(i => i.parent_item_id === null && i.product_id === SEED.bundleProduct.id);
        expect(parent).toBeDefined();
        expect(items.filter(i => i.parent_item_id !== null)).toHaveLength(2);
        expect(items.find(i => i.product_id === 3)).toBeDefined();
    });

    it('P1-1: waiter without pos.void_printed_item can re-save a bundle UNCHANGED', async () => {
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        const getRes = await request(app)
            .get('/api/pos/table_order')
            .query({ order_id: orderId })
            .set('Cookie', waiterCookie);
        const reconstructed = getRes.body.cart;

        const resave = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId,
                cart: reconstructed,
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(resave.statusCode).toBe(200);

        const [items] = await pool.query(
            "SELECT * FROM order_items WHERE invoice_id = ?", [orderId]
        );
        expect(items).toHaveLength(3); // parent + 2 children, unchanged
    });
```

2. Run just the two new tests → expect **FAIL**. Both re-saves return the printed-lock error (status is 500/400, not 200) because the loop throws on the child rows:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "P1-1"`
   Expected: `AssertionError: expected <500|400> to be 200` on the `resave.statusCode` assertions.

3. Apply the minimal fix. In `backend/routes/pos/tables.js`, the printed-lock loop must iterate parents only (mirroring `parentsForVoidCheck`, declared ~27 lines above at 1204). This is the ONLY occurrence of that loop header (verified unique).

   BEFORE:
   ```js
            for (const extItem of existingItemsForPrint) {
                const newMatches = cartItems.filter(newItem =>
   ```
   AFTER:
   ```js
            // Iterate PARENTS only: bundle child rows (parent_item_id != null) never
            // appear as top-level cart lines, so counting them here would falsely trip
            // the printed-lock on any bundle table. Mirror the void gate's parent filter.
            for (const extItem of parentsForVoidCheck) {
                const newMatches = cartItems.filter(newItem =>
   ```

4. Re-run the two tests → expect **PASS**:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "P1-1"`

5. Run the whole file → expect all green (existing 6 bundle tests + 2 new):
   `npx vitest run backend/tests/integration/bundle.tables.test.js`

6. Commit: `fix(tables): P1-1 printed-lock loop iterates parents, not bundle children`.

---

### Task 2 — P1-2 (tables.js): bundle-member stock inflates on re-save / void because RESTORE counts children while DEDUCT is parent-only

Finding **P1-2** · `backend/routes/pos/tables.js:993`, `:1287`, `:1664` · Every stock-RESTORE query selects `product_id, quantity … WHERE product_id IS NOT NULL`, which INCLUDES bundle child rows, but `deductStockForCart` only deducts top-level cart lines (a bundle = one parent SKU). So each restore adds member stock that deduction never removed → members drift upward on every re-save, void, and split.

**Reasoning per site (documented decision):** all three tables.js restores pair with a parent-only deduct (`deductStockForCart` at 1307/1331 never touches members), so restoring children is always an over-restore. The intended "return the physical stock that was actually removed" semantics = **parent-only** at every site. Fix: add `AND parent_item_id IS NULL` to each restore.

**Files**
- Modify `backend/routes/pos/tables.js:993` and `:1287` (byte-identical lines — one `replace_all` Edit)
- Modify `backend/routes/pos/tables.js:1664` (split-path restore — distinct line)
- Test `backend/tests/integration/bundle.tables.test.js`

**Steps**

1. Append two failing tests to the `describe('Table-order bundle support (I4)', …)` block. FULL code:

```js
    it('P1-2: bundle-member stock does NOT drift on unchanged re-save', async () => {
        // Enable stock; give the two members a known stock. The bundle product (id 4)
        // keeps NULL stock (bundles usually do), so ONLY the buggy child-restore can
        // touch member stock.
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE products SET stock=10 WHERE id IN (?, ?)", [SEED.product1.id, SEED.product2.id]);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Re-save the reconstructed bundle unchanged three times.
        for (let i = 0; i < 3; i++) {
            const getRes = await request(app)
                .get('/api/pos/table_order').query({ order_id: orderId }).set('Cookie', adminCookie);
            const resave = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: orderId,
                    cart: getRes.body.cart,
                    subtotal: 10.00, tax: 1.60, total: 11.60
                });
            expect(resave.statusCode).toBe(200);
        }

        const [[p1]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product1.id]);
        const [[p2]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product2.id]);
        expect(Number(p1.stock)).toBe(10); // members never deducted → must never be restored
        expect(Number(p2.stock)).toBe(10);
    });

    it('P1-2: voiding a bundle table (empty cart) does NOT inflate member stock', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE products SET stock=10 WHERE id IN (?, ?)", [SEED.product1.id, SEED.product2.id]);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Void the table by saving an empty cart.
        const voidRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({ table_id: SEED.table.id, current_order_id: orderId, cart: [], subtotal: 0, tax: 0, total: 0 });
        expect(voidRes.statusCode).toBe(200);

        const [[p1]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product1.id]);
        const [[p2]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product2.id]);
        expect(Number(p1.stock)).toBe(10);
        expect(Number(p2.stock)).toBe(10);
    });
```

2. Run the two new tests → expect **FAIL**. On the buggy code the child rows are restored (+1 per member per restore), so re-save drift yields 13 and the void yields 11:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "P1-2"`
   Expected: `AssertionError: expected 13 to be 10` (re-save) and `expected 11 to be 10` (void).

3. Apply the fix. First, the two byte-identical `[order_id]` restore queries (lines 993 and 1287) — use a single `Edit` with `replace_all: true`:

   BEFORE (appears exactly twice):
   ```js
                    const [oldItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL", [order_id]);
   ```
   AFTER:
   ```js
                    const [oldItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL AND parent_item_id IS NULL", [order_id]);
   ```

   Then the split-path restore at 1664 (distinct — uses `currentOrderId`) — a separate `Edit`:

   BEFORE:
   ```js
                const [oldItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL", [currentOrderId]);
   ```
   AFTER:
   ```js
                const [oldItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL AND parent_item_id IS NULL", [currentOrderId]);
   ```

   (Sanity: `grep -c "SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL\"" tables.js` should now report only the already-parent-only lines are gone; re-grep to confirm no un-fixed `product_id IS NOT NULL"` restore remains in tables.js.)

4. Re-run the two tests → expect **PASS**:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "P1-2"`

5. Run the whole file → expect all green:
   `npx vitest run backend/tests/integration/bundle.tables.test.js`

6. Commit: `fix(tables): P1-2 parent-only stock restore (stop bundle-member drift)`.

---

### Task 3 — P1-2 (checkout.js): settle restore counts bundle children, inflating member stock on cash-out

Finding **P1-2** · `backend/routes/pos/checkout.js:639` (ghost-void restore on table settle) and `:504` (edit-order restore) · Same asymmetry as Task 2: the restore selects child rows, but the paired deduct (`deductStockForCart`) is parent-only. Settling a bundle table restores its children, inflating member stock.

**Reasoning per site:** L639 restores the OLD table "ghost" order during a fresh settle — its original deduct was parent-only, so parent-only restore is correct. L504 restores an order being re-inserted on the checkout edit path — same parent-only deduct pairing. Both get `AND parent_item_id IS NULL`. The integration test drives the ghost-void path (L639); L504 is the identical-pattern sibling in the same file, fixed for parity (driving the edit-order-with-bundle path is out of scope).

**Files**
- Modify `backend/routes/pos/checkout.js:639` and `:504`
- Test `backend/tests/integration/bundle.tables.test.js`

**Steps**

1. Append the settle test to the `describe('Table-order bundle support (I4)', …)` block. FULL code:

```js
    it('P1-2: settling a bundle table does NOT inflate member stock (ghost-void restore)', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query("UPDATE products SET stock=10 WHERE id IN (?, ?)", [SEED.product1.id, SEED.product2.id]);

        // Admin opens a shift (checkout attributes the sale to a shift).
        const openRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', adminCookie)
            .send({ user_id: SEED.adminUser.id, starting_cash: 50.00 });
        expect(openRes.statusCode).toBe(200);
        const [[shift]] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [SEED.adminUser.id]
        );

        // Save the bundle to the table.
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
        expect(saveRes.statusCode).toBe(200);

        // Settle it (fresh paid order + ghost-void of the old table order).
        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [bundleCartItem({ qty: 1 })],
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 11.60, change_due: 0,
                shift_id: shift.id,
                idempotency_key: 'p1-2-settle-bundle-stock'
            });
        expect(payRes.body.success).toBe(true);

        const [[p1]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product1.id]);
        const [[p2]] = await pool.query("SELECT stock FROM products WHERE id = ?", [SEED.product2.id]);
        expect(Number(p1.stock)).toBe(10); // members never deducted → never restored
        expect(Number(p2.stock)).toBe(10);
    });
```

2. Run the new test → expect **FAIL**. The ghost-void restore adds the two children (+1 each), so members read 11:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "ghost-void restore"`
   Expected: `AssertionError: expected 11 to be 10`.

3. Apply the fix. First confirm the two target lines and that no other checkout restore is missed:
   `grep -n "SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL" backend/routes/pos/checkout.js` → expect exactly the two lines below.

   Ghost-void restore (L639, uses `oldTableItems` / `old_table_order_id`):
   BEFORE:
   ```js
                    const [oldTableItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL", [old_table_order_id]);
   ```
   AFTER:
   ```js
                    const [oldTableItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL AND parent_item_id IS NULL", [old_table_order_id]);
   ```

   Edit-order restore (L504, uses `oldItems` / `invoice_id`) — parity fix:
   BEFORE:
   ```js
                const [oldItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL", [invoice_id]);
   ```
   AFTER:
   ```js
                const [oldItems] = await conn.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ? AND product_id IS NOT NULL AND parent_item_id IS NULL", [invoice_id]);
   ```

4. Re-run the settle test → expect **PASS**:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "ghost-void restore"`

5. Run both affected files → expect all green:
   `npx vitest run backend/tests/integration/bundle.tables.test.js`
   `npx vitest run backend/tests/integration/checkout.test.js`

6. Commit: `fix(checkout): P1-2 parent-only stock restore on settle + edit paths`.

---

### Task 4 — P3-1a: `hasVoidsOrReductions` skips saved custom lines (product_id NULL), so their reduction is invisible to the diff

Finding **P3-1** · `backend/routes/pos/helpers.js:187-213` · The diff keys each row by `item.product_id || item.id` and `continue`s when falsy, so a saved custom line (product_id NULL, no id) never enters the maps — reducing/removing it can't flip `hasVoid`. Fix: key custom lines by a stable `custom:${name}|${note}` composite on both sides, and stop using `item.id` as a product fallback (the existing side will soon carry `oi.id`, a ROW id that must not masquerade as a product id — see Task 5).

**Files**
- Modify `backend/routes/pos/helpers.js:187-213`
- Test `backend/tests/unit/helpers.test.js`

**Steps**

1. Add four unit cases inside the existing `describe('hasVoidsOrReductions', …)` block (append right before its closing `});`, after the `'correctly handles DB model …'` test). FULL code:

```js
    it('P3-1: detects reduction of a saved custom line keyed by name+note', () => {
        const existing = [{ product_id: null, item_name: 'Custom Plate', quantity: 2, note: '' }];
        const newCart = [{ product_id: null, item_name: 'Custom Plate', qty: 1, note: '' }];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(true);
    });

    it('P3-1: detects full removal of a saved custom line', () => {
        const existing = [{ product_id: null, item_name: 'Auto-Gratuity', quantity: 1, note: '' }];
        expect(hasVoidsOrReductions([], existing)).toBe(true);
    });

    it('P3-1: does NOT flag an unchanged custom line (client model uses .name)', () => {
        const existing = [{ product_id: null, item_name: 'Auto-Gratuity', quantity: 1, note: '' }];
        const newCart = [{ product_id: null, name: 'Auto-Gratuity', qty: 1, note: '' }];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(false);
    });

    it('P3-1: matches custom lines by name AND note (different note = different line)', () => {
        const existing = [{ product_id: null, item_name: 'Service', quantity: 1, note: 'AM' }];
        const newCart = [{ product_id: null, name: 'Service', qty: 1, note: 'PM' }];
        expect(hasVoidsOrReductions(newCart, existing)).toBe(true); // AM removed
    });
```

2. Run the file scoped to these → expect **FAIL** (3 of the 4 fail on current code; the "unchanged" guard already passes):
   `npx vitest run backend/tests/unit/helpers.test.js -t "P3-1"`
   Expected: the reduction, removal, and name+note cases report `expected false to be true`.

3. Apply the fix. Replace the two per-loop key blocks with a shared `lineKey`.

   BEFORE (helpers.js, the whole function head through both loops):
   ```js
   const hasVoidsOrReductions = (newCart, existingItems) => {
       const existingMap = new Map();
       for (const item of existingItems) {
           const productId = item.product_id || item.id;
           if (!productId) continue;
           const key = `${productId}:${item.note || ''}`;
           const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.qty || 0);
           existingMap.set(key, (existingMap.get(key) || 0) + qty);
       }

       const newMap = new Map();
       for (const item of newCart) {
           const productId = item.product_id || item.id;
           if (!productId) continue;
           const key = `${productId}:${item.note || ''}`;
           const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.qty || 0);
           newMap.set(key, (newMap.get(key) || 0) + qty);
       }
   ```
   AFTER:
   ```js
   // Stable void-diff key. Real product lines key by product_id (+ note). Custom
   // lines (product_id NULL — Auto-Gratuity, split/merge restores) key by name+note
   // so their reduction/removal still participates in the diff. We do NOT fall back
   // to item.id: order_items rows carry oi.id (a ROW id) which must never masquerade
   // as a product id, and client carts are already normalized to carry product_id.
   const lineKey = (item) => {
       if (item.product_id) return `${item.product_id}:${item.note || ''}`;
       const name = item.item_name || item.name;
       if (name) return `custom:${name}|${item.note || ''}`;
       return null;
   };

   const hasVoidsOrReductions = (newCart, existingItems) => {
       const existingMap = new Map();
       for (const item of existingItems) {
           const key = lineKey(item);
           if (!key) continue;
           const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.qty || 0);
           existingMap.set(key, (existingMap.get(key) || 0) + qty);
       }

       const newMap = new Map();
       for (const item of newCart) {
           const key = lineKey(item);
           if (!key) continue;
           const qty = item.quantity !== undefined ? Number(item.quantity) : Number(item.qty || 0);
           newMap.set(key, (newMap.get(key) || 0) + qty);
       }
   ```
   (Leave the final `for (const [key, extQty] of existingMap.entries())` comparison loop unchanged.)

4. Re-run the P3-1 unit cases → expect **PASS**. Also re-run the pre-existing `'handles items without product_id (custom items — ignored)'` case — it MUST stay green (nameless custom → `lineKey` returns null → skipped):
   `npx vitest run backend/tests/unit/helpers.test.js -t "hasVoidsOrReductions"`

5. Run the whole unit file → expect all green:
   `npx vitest run backend/tests/unit/helpers.test.js`

6. Commit: `fix(helpers): P3-1 hasVoidsOrReductions keys custom lines by name+note`.

---

### Task 5 — P3-1b: saved custom-line removal bypasses the void gate + leaves no audit (tables.js diff + audit build)

Finding **P3-1** · `backend/routes/pos/tables.js:1181-1187` (existing-items SELECT omits `oi.id`) and `:1215-1228` (audit build loop matches custom lines only by null==null, ignoring name) · With Task 4 done, `hasVoidsOrReductions` now sees custom lines, but the audit-diff build loop still can't tell two custom lines apart, and the SELECT lacks the row id the finding calls for. Add `oi.id`; make the audit build loop match custom rows by name+note.

**Files**
- Modify `backend/routes/pos/tables.js:1181-1187`
- Modify `backend/routes/pos/tables.js:1215-1228`
- Test `backend/tests/integration/bundle.tables.test.js`

**Steps**

1. Append two failing integration tests to the `describe('Table-order bundle support (I4)', …)` block. These use the same `grantWaiterAndLogin` helper added in Task 1 (it is already in scope). FULL code:

```js
    it('P3-1: reducing a saved custom line without pos.void_item is blocked (403, no change)', async () => {
        // Waiter owns the order and can edit, but lacks pos.void_item.
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked']);

        // Create a normal one-product table order the waiter owns.
        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(saveRes.statusCode).toBe(200);
        const orderId = saveRes.body.order_id;

        // Inject a saved custom line (product_id NULL) directly — the merge/split
        // paths produce these; direct custom-on-fresh-table is blocked.
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order, parent_item_id)
             VALUES (?, NULL, 'Auto-Gratuity', 1, 2.00, 0, 0, 1, NULL)`,
            [orderId]
        );

        // Re-save a cart that OMITS the custom line (a reduction). The void gate must fire.
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(res.statusCode).toBe(403);

        // Rollback: the custom line is still present.
        const [[custom]] = await pool.query(
            "SELECT quantity, item_name FROM order_items WHERE invoice_id = ? AND product_id IS NULL", [orderId]
        );
        expect(custom).toBeDefined();
        expect(custom.item_name).toBe('Auto-Gratuity');
        expect(Number(custom.quantity)).toBe(1);
    });

    it('P3-1: authorized removal of a saved custom line writes a void_item audit capturing it', async () => {
        // Waiter with pos.void_item may remove it; the removal must be audited.
        const waiterCookie = await grantWaiterAndLogin(['tables.access', 'waiter.edit_locked', 'pos.void_item']);

        const saveRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        const orderId = saveRes.body.order_id;

        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, sort_order, parent_item_id)
             VALUES (?, NULL, 'Auto-Gratuity', 1, 2.00, 0, 0, 1, NULL)`,
            [orderId]
        );

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', waiterCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: orderId,
                cart: [{ id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
        expect(res.statusCode).toBe(200);

        const [[auditRow]] = await pool.query(
            "SELECT old_value FROM audit_events WHERE event_type='void_item' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            [orderId]
        );
        expect(auditRow).toBeDefined();
        expect(auditRow.old_value).toContain('Auto-Gratuity');
    });
```

2. Run the two new tests → expect **FAIL**. On current code (with Task 4 applied) the SELECT lacks `oi.id` and the build loop can still misattribute; more importantly the 403 test proves the end-to-end gate. Before Task 5 the audit-capture test fails because the build loop's `n.product_id === extItem.product_id` (null === null) counts ALL custom cart lines, so a removed custom line may not be captured by name:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "P3-1"`
   Expected: the audit-capture assertion `expected undefined … toContain('Auto-Gratuity')` fails (and/or the 403 test surfaces the gate). Both must be green after the fix.

3. Apply the fix. Add `oi.id` to the existing-items SELECT:

   BEFORE:
   ```js
                SELECT oi.product_id, COALESCE(oi.item_name, p.name) AS item_name, oi.quantity, oi.note, oi.parent_item_id
   ```
   AFTER:
   ```js
                SELECT oi.id, oi.product_id, COALESCE(oi.item_name, p.name) AS item_name, oi.quantity, oi.note, oi.parent_item_id
   ```

   Make the audit build loop custom-aware:

   BEFORE:
   ```js
                for (const extItem of parentsForVoidCheck) {
                    const totalNewQty = cartItems
                        .filter(n => n.product_id === extItem.product_id && (n.note || '') === (extItem.note || ''))
                        .reduce((sum, item) => sum + Number(item.qty), 0);
                    if (totalNewQty < Number(extItem.quantity)) {
                        auditedVoidItems.push({
                            product_id: extItem.product_id,
                            item_name: extItem.item_name || null,
                            note: extItem.note || null,
                            old_qty: Number(extItem.quantity),
                            new_qty: totalNewQty
                        });
                    }
                }
   ```
   AFTER:
   ```js
                for (const extItem of parentsForVoidCheck) {
                    const isCustom = !extItem.product_id;
                    const totalNewQty = cartItems
                        .filter(n => isCustom
                            ? (!n.product_id
                                && (n.item_name || n.name || '') === (extItem.item_name || '')
                                && (n.note || '') === (extItem.note || ''))
                            : (n.product_id === extItem.product_id && (n.note || '') === (extItem.note || '')))
                        .reduce((sum, item) => sum + Number(item.qty), 0);
                    if (totalNewQty < Number(extItem.quantity)) {
                        auditedVoidItems.push({
                            product_id: extItem.product_id,
                            item_name: extItem.item_name || null,
                            note: extItem.note || null,
                            old_qty: Number(extItem.quantity),
                            new_qty: totalNewQty
                        });
                    }
                }
   ```

4. Re-run the two tests → expect **PASS**:
   `npx vitest run backend/tests/integration/bundle.tables.test.js -t "P3-1"`

5. Run the whole file → expect all green:
   `npx vitest run backend/tests/integration/bundle.tables.test.js`

6. Commit: `fix(tables): P3-1 custom lines join void gate + audit (oi.id + name-keyed diff)`.

---

## Self-Review

- **All three findings covered:** P1-1 (Task 1), P1-2 (Tasks 2 + 3, all 5 restore sites: tables.js 993/1287/1664, checkout.js 504/639), P3-1 (Tasks 4 + 5).
- **Every source edit has a red-first test.** Task 3's L504 (checkout edit-order) is an explicitly-flagged parity fix not independently driven — same query pattern, same parent-only deduct pairing, in the same file as the exercised L639; driving the edit-order-with-bundle flow is out of scope and noted as such (honest, not silent).
- **The `.id`-fallback removal is safe:** `normalizeCartItems` (PosCalculator.js:40) already folds `item.product_id || item.id` into `product_id` via `normalizeProductId` (returns null for non-positive-int), and the only production caller (`tables.js:1205`) passes the normalized `cartItems`; existing unit tests all pass `product_id`. The pre-existing `'custom items — ignored'` test stays green because nameless custom rows yield a null `lineKey`.
- **`oi.id` addition cannot regress the diff:** `lineKey` never reads `item.id`, so the newly-selected row id is inert for real-product rows (keyed by product_id) and custom rows (keyed by name+note). This is why Task 4 must land before/with Task 5.
- **Money anchor respected:** every re-save/settle payload's `subtotal` equals the top-level line-price sum (bundle parent = 10.00; children = 0; added product 3 = 3.00 → 13.00). The subtotal assertion fires before the void gate, so the 403 test genuinely reaches the gate.
- **Stock math verified:** bundle product (id 4) keeps NULL stock, members = 10; members are never in any deduct cart, so the only thing that could move them is the buggy child-restore. Fixed code holds them at 10 across re-save (×3), void, and settle. Both create (1331) and update (1307) paths deduct parent-only — confirmed by grep.
- **Transactional audit:** the audit-capture test can read immediately after the response because `audit_events` is inserted with the same transaction before commit; audit insert failure must rollback the table-save mutation.
- **Risk:** `grantWaiterAndLogin` mutates `user_permissions` for the seed waiter; safe because `seedDatabase()` runs in `beforeEach`, re-seeding per test. Login happens AFTER the grant so the session loads the new perms.

## Cross-plan file overlap

- **`backend/routes/pos/tables.js`** — also edited by Plans 1, 6, 7. **Land this plan AFTER Plan 1.** The P1-1 edit (printed-lock loop, ~L1231) sits ~15–30 lines below Plan 1's P1-3 audit-timing change (the `auditedVoidItems` insert / gate region ~L1215–1284). Executors MUST sequence: apply Plan 1 first, then re-open tables.js and re-anchor Task 1 and Task 5 on the quoted BEFORE text (line numbers will have moved). Task 5 also edits the same `auditedVoidItems` build loop Plan 1's audit-timing change is adjacent to — resolve by hand if both touch lines 1215–1228.
- **`backend/routes/pos/checkout.js`** — also edited by Plans 1, 4. Task 3's two restore-line edits are localized (L504, L639) and unlikely to collide, but re-grep the two query strings before editing in case a Plan-1/4 change shifted them.
- **`backend/routes/pos/helpers.js`** — Task 4 rewrites the `hasVoidsOrReductions` head. If another plan touches this function, reconcile the `lineKey` extraction manually (it is additive — no behavior change for product lines).
- **`backend/services/bundleOrderItems.js`** — read-only here; not modified by this plan.
