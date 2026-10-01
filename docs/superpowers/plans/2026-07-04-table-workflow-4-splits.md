# Split-Check Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — dispatch each Task below to a fresh implementation sub-agent, one at a time, in the given order. Each Task is a full red→green TDD cycle: write the failing test FIRST, watch it fail for the RIGHT reason, apply the minimal fix, watch it pass, run the whole file, then commit. Do NOT batch Tasks. Do NOT let a sub-agent "improve" code outside the cited lines. After every Task re-run BOTH integration suites (`npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js`) to catch cross-task regressions.
>
> **Git hygiene:** the owner has unrelated WIP in the tree (`git status` shows modified `orderSessionStore.js`, `tables.js`, and two test files). Do NOT `git stash`. When committing, stage ONLY the files each Task names (`git add <exact file>` per listed file) — **never** `git add -A` / `git add .` / `git commit -am`.

**Goal**
Fix five correctness defects in the table bill-split workflow so that a split check charges exactly what its printed guest check says, an order-level discount survives the split, discarded splits are audited, and a split issued against a joined child table releases the whole join. All fixes are server-authoritative (never trust client-recomputed money) and covered by tests.

**Architecture**
- Split creation: `POST /api/pos/table_splits/split` (backend/routes/pos/tables.js ~L1597) voids the parent order, returns stock, releases the table(s), and writes one `held_orders` row per seat (`cart_data` = JSON payload, `subtotal` = seat total).
- Split discard: `DELETE /api/pos/table_splits` (tables.js ~L1579) hard-deletes a `held_orders` row.
- Split settle: `POST /api/pos/checkout` (backend/routes/pos/checkout.js) with `split_check_id` locks+deletes the held row (~L138), then rings the seat as a finalized order.
- Split print (guest check): `POST /api/print/print` with `payment_method:'held'` + numeric held id → print.js rebuilds the printed numbers server-side from the held row (~L140-233). The client payload from src/components/TableSplits.vue (~L428) is OVERRIDDEN by this rebuild.
- Split FE math: assets/js/composables/stores/orderSessionStore.js — `getSeatTotal` (~L1037), `confirmSplit` (~L1047), `restoreTableSplit` (~L1258).
- Money math: backend/services/PosCalculator.js — `calculateExpectedTotals` (discountRatio = discountedSubtotal/subtotal, per-line tax prorated by discountRatio), `roundMoney`, `normalizeCartItems`. Frontend mirrors `roundMoney` at orderSessionStore.js L14.

**Tech Stack**
Vue 3 + Pinia (setup stores) frontend; Node + Express + MySQL (mysql2/promise) backend. Tests: Vitest (`npx vitest run <file>` — NOT jest). Integration suites seed a real MySQL test DB via backend/tests/fixtures/seed.js (`seedDatabase`, `SEED`). Frontend store tests mock `global.fetch` + Pinia.

## Global Constraints

- **Money**: only ever validate/emit money through `roundMoney` / `assertNearMoney` (`MONEY_TOLERANCE = 0.02`). Never trust a client-supplied total; recompute server-side and compare.
- **Server-authoritative discount + price**: a split settle must source both the frozen line price AND the order discount from the persisted `held_orders.cart_data`, never from the checkout payload. The client payload's discount/price fields are anti-tamper anchors only.
- **Audit**: destructive split audits must be durable before success. If the handler already uses a transaction, insert `audit_events` with the same `conn` before commit. If it currently uses `pool.query` without a transaction (for example split discard), wrap the destructive delete + audit insert in one transaction. Do not use background audit logging after the response.
- **sendError sanitizer**: `sendError()` rewrites any message containing both "table" and "exist" (or `ER_`/`SQLSTATE`/`mysql`) to a generic error. Do not phrase new error strings so they get scrubbed.
- **Do NOT re-apply working-tree baseline** (already present): void-reason modal removed; `checkHasVoids` Map-aggregate; `item_name` COALESCE; saved-row delete FE gate `(!canVoidItems||!canBypassPrintedLock)`.
- **Cross-plan ordering**: Plan 1 (checkout release block, P0-1) adds `!isSplitSettle` to the table-release path. **Land Plan 1 first.** Task 3 (P3-7) and Task 5 (P2-3) edit the same checkout.js settle path — re-read the file before editing and re-run both integration suites after each.
- **Re-open before editing**: every line number below is approximate (working tree drifts). Re-`grep`/`Read` the cited anchor text before applying any BEFORE→AFTER.
- Run all commands from repo root `C:\xampp\htdocs\posapp`.

---

### Task 1 — P3-10: split endpoint must resolve a joined child→parent before locking/releasing

**Finding P3-10** — backend/routes/pos/tables.js ~L1623-1719. Defect: the split endpoint locks `WHERE id = tableId` and releases `WHERE parent_table_id = tableId`. A joined CHILD shares the parent's propagated `current_order_id`, so a split issued against the child id passes the `current_order_id` guard, releases ONLY the child, and strands the parent + siblings in a ghost `occupied` state still pointing at the now-voided order. checkout.js already resolves child→parent (~L247-253); the split endpoint does not.

**Files**
- backend/tests/integration/tables.test.js (add test)
- backend/routes/pos/tables.js (fix)

**Interfaces**
- `POST /api/pos/table_splits/split` `{ tableId, currentOrderId, splits }`
- Helpers already in file: `createTableOrder`, `adminCookie`, `SEED`, `pool`.

- [ ] **Step 1 — Write the failing test.** Append inside the top-level `describe('Table Bill Split Integration Tests', ...)` in backend/tests/integration/tables.test.js:

```js
describe('Bill Split — joined child→parent resolution (P3-10)', () => {
    it('releases the parent and all siblings when a split targets a joined CHILD id', async () => {
        // Join child T2 under parent T1
        await request(app)
            .post('/api/pos/tables/join')
            .set('Cookie', adminCookie)
            .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });

        // Save an order on the PARENT → both T1 and T2 occupied on the same order
        const invoiceId = await createTableOrder(
            adminCookie, SEED.table.id,
            [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
            10.00, 1.60, 11.60
        );

        // Split using the CHILD id (T2) — the child shares the parent's propagated current_order_id
        const res = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table2.id,            // CHILD id, not the parent
                currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Seat A', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }] },
                    { referenceName: 'Seat B', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }] }
                ]
            });
        expect(res.statusCode).toBe(200);

        // Parent T1 must NOT be left occupied pointing at the voided order
        const [[t1]] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
        expect(t1.status).toBe('available');
        expect(t1.current_order_id).toBeNull();

        // Child T2 must be released and un-joined
        const [[t2]] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
        expect(t2.status).toBe('available');
        expect(t2.current_order_id).toBeNull();
        expect(t2.parent_table_id).toBeNull();
    });
});
```

- [ ] **Step 2 — Run, expect FAIL.**
  `npx vitest run backend/tests/integration/tables.test.js -t "joined CHILD id"`
  Expected: FAIL — `expected 'occupied' to be 'available'` on `t1.status` (the parent is stranded because only the child row was cleared).

- [ ] **Step 3 — Minimal fix** in backend/routes/pos/tables.js, inside `if (isTableSplit) {` (~L1623). Re-read first.

BEFORE:
```js
        if (isTableSplit) {
            const [[table]] = await conn.query("SELECT current_order_id, status FROM restaurant_tables WHERE id = ? FOR UPDATE", [tableId]);
            if (!table) {
                throw new Error("Table not found.");
            }
```
AFTER:
```js
        if (isTableSplit) {
            // Resolve a joined child table to its parent before locking/releasing,
            // mirroring the checkout release path (checkout.js). A child shares the
            // parent's propagated current_order_id, so a split against the child id
            // must act on the parent + all siblings — never orphan them occupied.
            let resolvedTableId = tableId;
            const [[childLink]] = await conn.query("SELECT parent_table_id FROM restaurant_tables WHERE id = ? FOR UPDATE", [tableId]);
            if (childLink && childLink.parent_table_id) {
                resolvedTableId = childLink.parent_table_id;
            }
            const [[table]] = await conn.query("SELECT current_order_id, status FROM restaurant_tables WHERE id = ? FOR UPDATE", [resolvedTableId]);
            if (!table) {
                throw new Error("Table not found.");
            }
```
Then, in the release block at the end of the same `if (isTableSplit)` body (~L1716-1719), replace the two `tableId` uses with `resolvedTableId`.

BEFORE:
```js
            const [childRows] = await conn.query("SELECT id FROM restaurant_tables WHERE parent_table_id = ? FOR UPDATE", [tableId]);
            tableIdsToClear = [tableId, ...childRows.map(c => c.id)];
```
AFTER:
```js
            const [childRows] = await conn.query("SELECT id FROM restaurant_tables WHERE parent_table_id = ? FOR UPDATE", [resolvedTableId]);
            tableIdsToClear = [resolvedTableId, ...childRows.map(c => c.id)];
```
(Leave the `current_order_id` match guard, the parent-order lookup by `currentOrderId`, the stock return, and the `UPDATE ... WHERE id IN (?)` untouched — they already operate on `tableIdsToClear`.)

- [ ] **Step 4 — Run, expect PASS.**
  `npx vitest run backend/tests/integration/tables.test.js -t "joined CHILD id"` → PASS.

- [ ] **Step 5 — Full file.** `npx vitest run backend/tests/integration/tables.test.js` → all green (existing parent-id split tests still pass; the parent path is unchanged because `parent_table_id` is NULL for a real parent).

- [ ] **Step 6 — Commit.** Stage ONLY this task's two files (never `-A`):
```bash
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(splits): resolve joined child→parent before releasing on split (P3-10)"
```

---

### Task 2 — P3-9: DELETE /table_splits must audit the discarded seat

**Finding P3-9** — backend/routes/pos/tables.js `router.delete('/table_splits')` ~L1579-1595. Defect: a hard `DELETE` gated only by `checkSplitBillPermission`, with NO `audit_events` row, actor, reason, or amount — unlike split creation (`void_split` audit ~L1703). A split represents served food (parent already voided + stock returned at split time), so discarding it silently destroys the paper trail.

**Files**
- backend/tests/integration/tables.test.js (add test)
- backend/routes/pos/tables.js (fix)

**Interfaces**
- `DELETE /api/pos/table_splits?id=<heldId>`
- `audit_events(event_type, user_id, entity_type, entity_id, old_value, ip_address)` — schema confirmed in seed.js.

- [ ] **Step 1 — Write the failing test.** Append inside the top-level split describe:

```js
describe('Bill Split — discard audit (P3-9)', () => {
    it('writes an audit_events row when an unpaid split check is discarded', async () => {
        const invoiceId = await createTableOrder(
            adminCookie, SEED.table.id,
            [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            2.00, 0.00, 2.00
        );
        await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [{ referenceName: 'Solo', subtotal: 2.00, items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }] }]
            });
        const [[held]] = await pool.query("SELECT id, subtotal FROM held_orders ORDER BY id DESC LIMIT 1");

        const delRes = await request(app)
            .delete(`/api/pos/table_splits?id=${held.id}`)
            .set('Cookie', adminCookie);
        expect(delRes.statusCode).toBe(200);

        // Held row is gone
        const [heldAfter] = await pool.query("SELECT id FROM held_orders WHERE id = ?", [held.id]);
        expect(heldAfter).toHaveLength(0);

        const [[audit]] = await pool.query(
            "SELECT * FROM audit_events WHERE event_type = 'discard_split_check' AND entity_id = ?",
            [held.id]
        );
        expect(audit).not.toBeNull();
        expect(audit.user_id).toBe(SEED.adminUser.id);
        const oldVal = JSON.parse(audit.old_value);
        expect(Number(oldVal.amount)).toBe(2.00);
    });
});
```

- [ ] **Step 2 — Run, expect FAIL.**
  `npx vitest run backend/tests/integration/tables.test.js -t "discarded"`
  Expected: FAIL — `expected null not to be null` (no `discard_split_check` row exists).

- [ ] **Step 3 — Minimal fix** in the DELETE handler. Re-read ~L1579 first.

BEFORE:
```js
    const { id } = req.query;
    try {
        const [rows] = await pool.query("SELECT reference_name FROM held_orders WHERE id=?", [id]);
        if (rows.length === 0) return sendError(res, 404, "Split check not found.");
        
        if (!rows[0].reference_name.startsWith('Table ')) {
            return sendError(res, 403, "Forbidden: Only table splits can be deleted via this endpoint.");
        }
        
        await pool.query("DELETE FROM held_orders WHERE id=?", [id]);
        return sendSuccess(res, { message: "Split check deleted successfully." });
```
AFTER:
```js
    const { id } = req.query;
    try {
        const [rows] = await pool.query("SELECT reference_name, subtotal, cart_data FROM held_orders WHERE id=?", [id]);
        if (rows.length === 0) return sendError(res, 404, "Split check not found.");

        const heldRow = rows[0];
        if (!heldRow.reference_name.startsWith('Table ')) {
            return sendError(res, 403, "Forbidden: Only table splits can be deleted via this endpoint.");
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query("DELETE FROM held_orders WHERE id=?", [id]);

            // A discarded split is served food (parent already voided + stock returned at
            // split time). Record actor + seat + amount, mirroring the void_split audit on
            // split creation. Same transaction as the delete.
            let itemCount = 0;
            try {
                const p = JSON.parse(heldRow.cart_data || '{}');
                itemCount = Array.isArray(p) ? p.length : (Array.isArray(p.items) ? p.items.length : 0);
            } catch (e) { /* leave itemCount = 0 */ }
            await conn.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, ip_address)
                 VALUES ('discard_split_check', ?, 'held_order', ?, ?, ?)`,
                [
                    req.user.id,
                    id,
                    JSON.stringify({ reference_name: heldRow.reference_name, amount: Number(heldRow.subtotal), item_count: itemCount }),
                    req.ip || null
                ]
            );
            await conn.commit();
        } catch (err) {
            await conn.rollback().catch(() => {});
            throw err;
        } finally {
            conn.release();
        }

        return sendSuccess(res, { message: "Split check deleted successfully." });
```

- [ ] **Step 4 — Run, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "discarded"` → PASS.

- [ ] **Step 5 — Full file.** `npx vitest run backend/tests/integration/tables.test.js` → all green.

- [ ] **Step 6 — Commit.**
```bash
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(splits): audit discarded split checks with actor + amount (P3-9)"
```

---

### Task 3 — P3-7: split settle must freeze prices from the held check, not the live catalog

**Finding P3-7** — backend/routes/pos/checkout.js. Defect: for a split settle no `savedPriceMap` is built (that block is `edit_invoice_id`-only, ~L328), so `applyDatabasePrices` (~L381, `isUnpaidTableSettle === false`) overwrites every non-manager line with the CURRENT `products.price`, and `expectedTotals` recompute from the same live price so `assertNearMoney` passes — a non-manager cashier charges a total ≠ the printed split check whenever the catalog price changed between split and settle.

**Files**
- backend/tests/integration/checkout.test.js (add test)
- backend/routes/pos/checkout.js (fix)

**Interfaces**
- `POST /api/pos/checkout` `{ split_check_id, cart, subtotal, tax, total, payment_method, ... }`
- `applyDatabasePrices(cartItems, productMap, user, trustClientPrices, savedPriceMap)` (backend/routes/pos/helpers.js L360) — skips any line whose key is in `savedPriceMap`.

- [ ] **Step 1 — Write the failing test.** Append a new `describe` in backend/tests/integration/checkout.test.js (this suite exposes `cashierCookie`, `cashierShiftId`, `openShift()`):

```js
describe('Split settle freezes split-time prices (P3-7)', () => {
    it('charges the split-time price even when the catalog price changed after the split', async () => {
        // Admin (has pos.split_checks) creates a table order and splits it
        const adminRes = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        const orderRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({ table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }], subtotal: 5.00, tax: 0.80, total: 5.80 });
        expect(orderRes.statusCode).toBe(200);
        const parentInvoiceId = orderRes.body.order_id;

        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id, currentOrderId: parentInvoiceId,
                splits: [{ referenceName: 'Solo', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }]
            });
        expect(splitRes.statusCode).toBe(200);
        const [[held]] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");

        // Catalog price jumps 5.00 → 8.00 AFTER the split
        await pool.query("UPDATE products SET price = 8.00 WHERE id = ?", [SEED.product1.id]);

        // Non-manager cashier settles the split at the split-time totals
        await openShift();
        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0.00,
                split_check_id: held.id,
                order_discount_type: null, order_discount_value: 0,
                idempotency_key: `split_freeze_${held.id}`
            });
        expect(payRes.statusCode).toBe(200);
        expect(payRes.body.success).toBe(true);

        // The settled line is frozen at the split-time price (5.00), NOT the new catalog 8.00
        const [items] = await pool.query("SELECT price_at_sale FROM order_items WHERE invoice_id = ?", [payRes.body.invoice_id]);
        expect(items).toHaveLength(1);
        expect(Number(items[0].price_at_sale)).toBe(5.00);
        const [[settled]] = await pool.query("SELECT total FROM orders WHERE invoice_id = ?", [payRes.body.invoice_id]);
        expect(Number(settled.total)).toBe(5.80);
    });
});
```

- [ ] **Step 2 — Run, expect FAIL.**
  `npx vitest run backend/tests/integration/checkout.test.js -t "split-time price"`
  Expected: FAIL at `expect(payRes.statusCode).toBe(200)` — the non-manager cashier's lines are re-priced to 8.00, so `expectedTotals.subtotal` becomes 8.00 and `assertNearMoney('Subtotal', 5.00, 8.00)` throws → checkout returns 400/500.

- [ ] **Step 3 — Minimal fix** in backend/routes/pos/checkout.js (three edits). Re-read the anchors first.

(3a) Capture the held payload BEFORE deleting it. BEFORE (~L138):
```js
        if (data.split_check_id) {
            const [rows] = await conn.query("SELECT id FROM held_orders WHERE id = ? FOR UPDATE", [data.split_check_id]);
            if (rows.length === 0) {
                throw new Error("Conflict: This split check has already been paid or modified on another terminal.");
            }
            await conn.query("DELETE FROM held_orders WHERE id = ?", [data.split_check_id]);
        }
```
AFTER:
```js
        let splitHeldPayload = null;
        if (data.split_check_id) {
            const [rows] = await conn.query("SELECT id, cart_data FROM held_orders WHERE id = ? FOR UPDATE", [data.split_check_id]);
            if (rows.length === 0) {
                throw new Error("Conflict: This split check has already been paid or modified on another terminal.");
            }
            try {
                const parsed = JSON.parse(rows[0].cart_data || '{}');
                splitHeldPayload = Array.isArray(parsed) ? { items: parsed } : parsed;
            } catch (e) { splitHeldPayload = { items: [] }; }
            await conn.query("DELETE FROM held_orders WHERE id = ?", [data.split_check_id]);
        }
```

(3b) Build the frozen-price map for the split settle. Insert immediately AFTER the existing `if (data.edit_invoice_id && originalPaymentMethod === 'unpaid_table') { ... }` block that populates `savedPriceMap` (the block ends ~L365, just before `const productMap = await fetchCartProducts(...)`):
```js
        // Split settle: freeze each line to the price captured when the check was split
        // (stored in held_orders.cart_data), so a catalog price change between split and
        // settle never diverges the charged total from the printed split check. Mirrors
        // the unpaid_table frozen-price path but sources price server-side from the held row.
        if (isSplitSettle && splitHeldPayload && Array.isArray(splitHeldPayload.items)) {
            const keyOf = (productId, itemName, note) =>
                `${productId != null ? productId : 'custom:' + (itemName || '')}|${note || ''}`;
            for (const it of splitHeldPayload.items) {
                const pid = it.product_id != null ? it.product_id : (it.id != null ? it.id : null);
                const k = keyOf(pid, it.item_name || it.name, it.note);
                const frozen = Number(it.price != null ? it.price : it.price_at_sale);
                if (Number.isFinite(frozen)) savedPriceMap.set(k, frozen);
            }
        }
```
(This relies on `isSplitSettle` (~L194) and `savedPriceMap` (~L327) already being declared above this point — confirm on re-read. The existing generic "Pre-populate frozen prices from savedPriceMap" block, `if (savedPriceMap.size > 0)`, then copies the frozen price onto each matching cart line.)

(3c) Pass `savedPriceMap` into `applyDatabasePrices` so the freeze survives the non-manager re-price. BEFORE (~L381):
```js
        applyDatabasePrices(cartItems, productMap, req.user, isUnpaidTableSettle);
```
AFTER:
```js
        applyDatabasePrices(cartItems, productMap, req.user, isUnpaidTableSettle, savedPriceMap.size > 0 ? savedPriceMap : null);
```
(Harmless for the unpaid_table path — `applyDatabasePrices` returns early there — and required for split settle where `isUnpaidTableSettle === false`.)

- [ ] **Step 4 — Run, expect PASS.** `npx vitest run backend/tests/integration/checkout.test.js -t "split-time price"` → PASS.

- [ ] **Step 5 — Full file.** `npx vitest run backend/tests/integration/checkout.test.js` → all green. Then re-run tables: `npx vitest run backend/tests/integration/tables.test.js`.

- [ ] **Step 6 — Commit.**
```bash
git add backend/routes/pos/checkout.js backend/tests/integration/checkout.test.js
git commit -m "fix(splits): freeze split-settle line prices from the held check (P3-7)"
```

---

### Task 4 — P2-3 (frontend): distribute the order-level discount across seats at split time

**Finding P2-3 (FE half)** — assets/js/composables/stores/orderSessionStore.js `getSeatTotal` (~L1037) + `confirmSplit` (~L1047). Defect: `getSeatTotal` applies only ITEM-level discounts; the parent order's ORDER-level discount is never distributed across seats. `confirmSplit` then voids the parent, so the order discount is lost and each restored seat settles at the full pre-discount price.

**Design (documented at task top):** distribute the parent order discount proportionally across seats. For a PERCENT discount every seat carries the same percent (uniform). For a FIXED discount each seat gets a proportional share of the money (residue assigned to the last seat so the shares sum exactly). Each seat's `subtotal` in the split payload becomes the DISCOUNTED subtotal, and each seat carries its own `order_discount` descriptor so the backend can persist + re-apply it at settle (Task 5). Reconciliation invariant (FE): `Σ(seat.subtotal) === parent discounted total`.

**Files**
- backend/tests/unit/orderSessionStore.test.js (add test)
- assets/js/composables/stores/orderSessionStore.js (fix)

**Interfaces**
- Store getters/actions: `orderDiscount` (ref `{ type, value }`), `activeTable` (ref), `confirmSplit()`; UI store `useOrderUiStore()` with `splitSeats`, `unassignedSplitItems`, `closeSplitModal()`.
- Module-level `roundMoney` at L14.

- [ ] **Step 1 — Write the failing test.** Append a new `describe` to backend/tests/unit/orderSessionStore.test.js (mirror the existing fetch-mock + Pinia pattern; `useOrderUiStore` is already imported):

```js
describe('useOrderSessionStore — split distributes the order-level discount (P2-3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('distributes a 10% order discount so Σ(seat subtotals) == the discounted total (90), not 100', async () => {
    let splitBody = null;
    global.fetch = vi.fn((url, options = {}) => {
      const u = String(url);
      if (u.includes('api/pos/table_splits/split') && options.method === 'POST') {
        splitBody = JSON.parse(options.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, message: 'Bill split successfully.' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) });
    });

    const s = useOrderSessionStore();
    const ui = useOrderUiStore();
    s.orderDiscount = { type: 'percent', value: 10 };   // parent order-level discount
    s.activeTable = null;                                 // generic split (skips closeTable)
    ui.unassignedSplitItems = [];
    ui.splitSeats = [
      { id: 1, name: 'Seat 1', items: [{ id: 1, price: 10, qty: 5, discountType: null, discountValue: 0, note: '', tax_rate: 0 }] },
      { id: 2, name: 'Seat 2', items: [{ id: 2, price: 10, qty: 5, discountType: null, discountValue: 0, note: '', tax_rate: 0 }] }
    ];

    await s.confirmSplit();

    expect(splitBody).not.toBeNull();
    expect(splitBody.splits).toHaveLength(2);
    const sum = splitBody.splits.reduce((acc, seat) => acc + Number(seat.subtotal), 0);
    expect(Number(sum.toFixed(2))).toBe(90);
    expect(splitBody.splits[0].subtotal).toBe(45);
    expect(splitBody.splits[1].subtotal).toBe(45);
    expect(splitBody.splits[0].order_discount).toEqual({ type: 'percent', value: 10 });
    expect(splitBody.splits[1].order_discount).toEqual({ type: 'percent', value: 10 });
  });
});
```

- [ ] **Step 2 — Run, expect FAIL.**
  `npx vitest run backend/tests/unit/orderSessionStore.test.js -t "distributes a 10%"`
  Expected: FAIL — `expected 100 to be 90` (seat subtotals are 50 + 50; no `order_discount` field is emitted).

- [ ] **Step 3 — Minimal fix** in assets/js/composables/stores/orderSessionStore.js.

(3a) Add a pure module-level helper next to `roundMoney` (near L14, module scope, NOT inside the store):
```js
// Distribute an order-level discount across seat subtotals. Percent → uniform per seat;
// fixed → proportional money share with the residue on the last seat so shares sum exactly.
// Returns per-seat { discountedSubtotal, order_discount|null }.
const distributeOrderDiscount = (seatSubtotals, disc) => {
  const type = disc && disc.type;
  const value = parseFloat(disc && disc.value) || 0;
  if (!type || value <= 0) {
    return seatSubtotals.map((sST) => ({ discountedSubtotal: roundMoney(sST), order_discount: null }));
  }
  if (type === 'percent') {
    const pct = Math.min(100, value);
    return seatSubtotals.map((sST) => ({
      discountedSubtotal: roundMoney(sST * (1 - pct / 100)),
      order_discount: { type: 'percent', value: pct }
    }));
  }
  // fixed
  const total = seatSubtotals.reduce((a, b) => a + b, 0);
  let allocated = 0;
  return seatSubtotals.map((sST, i) => {
    const isLast = i === seatSubtotals.length - 1;
    let share = isLast ? roundMoney(value - allocated) : roundMoney(total > 0 ? value * (sST / total) : 0);
    share = Math.min(Math.max(0, share), sST);
    allocated = roundMoney(allocated + share);
    return { discountedSubtotal: roundMoney(sST - share), order_discount: { type: 'fixed', value: share } };
  });
};
```

(3b) In `confirmSplit`, replace the payload construction. BEFORE (~L1056):
```js
    const splitsPayload = ui.splitSeats
      .filter(seat => seat.items.length > 0)
      .map(seat => ({
        referenceName: `${baseName} - ${seat.name}`,
        items: seat.items,
        subtotal: parseFloat(getSeatTotal(seat))
      }));
```
AFTER:
```js
    const activeSeats = ui.splitSeats.filter(seat => seat.items.length > 0);
    // Item-discounted subtotal per seat (order discount not yet applied).
    const seatItemSubtotals = activeSeats.map(seat => parseFloat(getSeatTotal(seat)));
    // Distribute the parent order-level discount across the seats.
    const distributed = distributeOrderDiscount(seatItemSubtotals, orderDiscount.value);
    const splitsPayload = activeSeats.map((seat, i) => ({
      referenceName: `${baseName} - ${seat.name}`,
      items: seat.items,
      subtotal: distributed[i].discountedSubtotal,
      order_discount: distributed[i].order_discount
    }));
```

- [ ] **Step 4 — Run, expect PASS.** `npx vitest run backend/tests/unit/orderSessionStore.test.js -t "distributes a 10%"` → PASS.

- [ ] **Step 5 — Full file.** `npx vitest run backend/tests/unit/orderSessionStore.test.js` → all green (the existing `getSeatTotal sums a seat with a percent discount` test is untouched — `getSeatTotal` itself is unchanged).

- [ ] **Step 6 — Commit.**
```bash
git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js
git commit -m "fix(splits): distribute order-level discount across seats at split (P2-3 FE)"
```

---

### Task 5 — P2-3 (backend): persist + reconcile + re-apply the seat order discount at settle

**Finding P2-3 (BE half)** — backend/routes/pos/tables.js split endpoint (persist + reconcile) and backend/routes/pos/checkout.js (server-authoritative re-apply + gate exemption). Defect continuation of Task 4: the split endpoint never stores a per-seat order discount, and the settle path never re-applies it, so the discount is lost even after the FE distributes it. Also a plain cashier lacks `pos.discount`, so naively re-applying it would 403.

**Design (documented at task top):** (1) split endpoint persists each seat's `order_discount` into `cart_data` and reconciles `Σ(seat.subtotal) ≈ parent discounted total` (rejects a malformed distribution). (2) settle reads the order discount SERVER-SIDE from the held payload captured in Task 3 (never from the client payload), so it cannot be tampered. (3) because the discount is inherited from an already-authorized parent order and is server-sourced, a split settle is EXEMPT from the fresh discount-permission gate.

**Files**
- backend/tests/integration/tables.test.js (add test)
- backend/routes/pos/tables.js (fix — split endpoint)
- backend/routes/pos/checkout.js (fix — settle path; builds on Task 3's `splitHeldPayload`)

**Interfaces**
- Split endpoint reads parent `orders.discount_type/discount_value/subtotal`; persists `cart_data.order_discount`.
- `hasDiscountsInPayload(data, cartItems)` (helpers.js L181) — true when `data.order_discount_type` set & value>0, or any item discount.
- `calculateExpectedTotals` reads `data.order_discount_type/value`.

- [ ] **Step 1 — Write the failing test.** Append to the top-level split describe in backend/tests/integration/tables.test.js:

```js
describe('Split settle re-applies the distributed order discount (P2-3)', () => {
    it('persists + re-applies each seat discount server-side, reconciling to the parent discounted total', async () => {
        // Parent: 50 drinks @2.00 = 100 subtotal, 10% order discount → 90 total, 0 tax
        const orderRes = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product2.id, qty: 50, price: SEED.product2.price }],
                order_discount_type: 'percent', order_discount_value: 10,
                subtotal: 100.00, tax: 0.00, total: 90.00
            });
        expect(orderRes.statusCode).toBe(200);
        const invoiceId = orderRes.body.order_id;

        // Split into two seats of 25 each; each carries its distributed discounted
        // subtotal (45) + order_discount share (mirrors the fixed Task-4 FE output).
        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Seat A', subtotal: 45.00, order_discount: { type: 'percent', value: 10 }, items: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }] },
                    { referenceName: 'Seat B', subtotal: 45.00, order_discount: { type: 'percent', value: 10 }, items: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }] }
                ]
            });
        expect(splitRes.statusCode).toBe(200);

        // Discount persisted into each held check
        const [held] = await pool.query("SELECT id, cart_data FROM held_orders ORDER BY id ASC");
        expect(held).toHaveLength(2);
        expect(JSON.parse(held[0].cart_data).order_discount).toEqual({ type: 'percent', value: 10 });

        // A non-manager cashier settles each seat. The server re-applies the persisted
        // discount (server-sourced) and does NOT require a fresh discount authorization.
        // The payload deliberately omits any order discount.
        let charged = 0;
        for (const seat of held) {
            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }],
                    shift_id: cashierShiftId,
                    subtotal: 50.00, tax: 0.00, total: 45.00,     // pre-discount subtotal, discounted total
                    payment_method: 'cash', amount_tendered: 45.00, change_due: 0.00,
                    split_check_id: seat.id,
                    order_discount_type: null, order_discount_value: 0,   // omitted on purpose
                    idempotency_key: `split_disc_${seat.id}`
                });
            expect(payRes.statusCode).toBe(200);
            const [[o]] = await pool.query("SELECT total FROM orders WHERE invoice_id = ?", [payRes.body.invoice_id]);
            expect(Number(o.total)).toBe(45.00);
            charged += Number(o.total);
        }
        expect(charged).toBe(90.00);   // == parent DISCOUNTED total, not 100
    });
});
```

- [ ] **Step 2 — Run, expect FAIL.**
  `npx vitest run backend/tests/integration/tables.test.js -t "distributed order discount"`
  Expected: FAIL — first on the persisted-discount assertion (`cart_data.order_discount` is `undefined`); and the settle would recompute total = 50 (no discount applied) so `assertNearMoney('Total', 45, 50)` throws → non-200. (Both symptoms of the missing BE half.)

- [ ] **Step 3 — Minimal fix.** Re-read anchors before each edit.

(3a) tables.js — extend the parent-order lookup to fetch its discount + subtotal. BEFORE (~L1633):
```js
            const [[parentOrder]] = await conn.query(`
                SELECT o.invoice_id, o.order_id, o.invoice_number, o.invoice_issued_at, o.waiter_id, t.table_number
                FROM orders o
                LEFT JOIN restaurant_tables t ON o.table_id = t.id
                WHERE o.invoice_id = ?
            `, [currentOrderId]);
```
AFTER:
```js
            const [[parentOrder]] = await conn.query(`
                SELECT o.invoice_id, o.order_id, o.invoice_number, o.invoice_issued_at, o.waiter_id,
                       o.subtotal, o.discount_type, o.discount_value, t.table_number
                FROM orders o
                LEFT JOIN restaurant_tables t ON o.table_id = t.id
                WHERE o.invoice_id = ?
            `, [currentOrderId]);
```

(3b) tables.js — reconcile the distributed seat subtotals against the parent discounted total. Insert INSIDE `if (parentOrder) { ... }`, immediately AFTER the waiter-ownership check block (before the "Mark original table order as voided" comment, ~L1660):
```js
                // Reconcile the FE-distributed seat subtotals against the parent order's
                // discounted total so a malformed/tampered split cannot silently under- or
                // over-charge the guests. Seat subtotals are already the discounted values.
                const parentSubtotal = Number(parentOrder.subtotal) || 0;
                let parentDiscounted = parentSubtotal;
                if (parentOrder.discount_type === 'fixed') parentDiscounted -= Number(parentOrder.discount_value) || 0;
                else if (parentOrder.discount_type === 'percent') parentDiscounted -= parentSubtotal * ((Number(parentOrder.discount_value) || 0) / 100);
                parentDiscounted = Math.max(0, parentDiscounted);
                const seatSum = splits.reduce((sum, sPart) => sum + (Number(sPart.subtotal) || 0), 0);
                assertNearMoney('Split reconciliation', seatSum, parentDiscounted);
```

(3c) tables.js — persist each seat's `order_discount` into `cart_data`. BEFORE (~L1726):
```js
            const cartPayload = {
                items: seat.items,
                parent_invoice_id: parentInvoiceId,
```
AFTER:
```js
            const cartPayload = {
                items: seat.items,
                order_discount: seat.order_discount || null,
                parent_invoice_id: parentInvoiceId,
```

(3d) checkout.js — read the order discount SERVER-SIDE from the held payload (captured in Task 3). Insert immediately AFTER `const isSplitSettle = !!data.split_check_id;` (~L194):
```js
        // Server-authoritative split discount: re-apply the order discount recorded on the
        // held check (distributed at split time from the already-authorized parent order).
        // Never trust the checkout payload's discount fields for a split settle.
        if (isSplitSettle && splitHeldPayload && splitHeldPayload.order_discount) {
            data.order_discount_type = splitHeldPayload.order_discount.type || null;
            data.order_discount_value = Number(splitHeldPayload.order_discount.value) || 0;
        }
```

(3e) checkout.js — exempt a split settle from the fresh discount-permission gate. BEFORE (~L310):
```js
        if (hasDiscountsInPayload(data, cartItems)) {
```
AFTER:
```js
        // A split settle re-applies a discount that was authorized on the parent order and
        // is read server-side from the held check (not client-supplied), so it does not
        // require a fresh discount authorization here.
        if (!isSplitSettle && hasDiscountsInPayload(data, cartItems)) {
```

- [ ] **Step 4 — Run, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "distributed order discount"` → PASS.

- [ ] **Step 5 — Full file + cross-suite.** `npx vitest run backend/tests/integration/tables.test.js` then `npx vitest run backend/tests/integration/checkout.test.js` → all green (Task 3's freeze test still passes; the discount override only fires when the held row carries an `order_discount`).

- [ ] **Step 6 — Commit.**
```bash
git add backend/routes/pos/tables.js backend/routes/pos/checkout.js backend/tests/integration/tables.test.js
git commit -m "fix(splits): persist, reconcile & server-authoritatively re-apply seat order discount (P2-3 BE)"
```

---

### Task 6 — P3-8: split guest-check print must include tax on tax-exclusive bills

**Finding P3-8** — backend/routes/print.js held-check rebuild ~L225-228 sets `tax:0, discount:0, total: held.subtotal`; src/components/TableSplits.vue ~L428-431 mirrors it. Held split rows store only a tax-EXCLUSIVE subtotal, but on settle the items carry `tax_rate` and the charged amount adds tax — so the printed guest check understates the bill. (Note: the client TableSplits.vue payload is IRRELEVANT here — print.js's `payment_method:'held'` rebuild overrides `subtotal/tax/total` server-side, confirmed at print.js L134-140.)

**Design (documented at task top):** add a tiny pure `computeHeldCheckTotals(items, taxInclusivePricing, orderDiscount)` to PosCalculator that wraps the SAME `calculateExpectedTotals` the settle path uses, so the printed total is guaranteed equal to the settle total by construction. print.js reads `tax_inclusive_pricing`, computes the held totals from the seat items, and stops hardcoding tax/total.

**Files**
- backend/tests/unit/PosCalculator.test.js (add test + extend the top-of-file require)
- backend/services/PosCalculator.js (add helper + export)
- backend/routes/pos/../routes/print.js (wire it in)  → i.e. backend/routes/print.js
- src/components/TableSplits.vue (clarifying comment only — see note)

**Interfaces**
- `computeHeldCheckTotals(items, taxInclusivePricing, orderDiscount = {})` → `{ subtotal, tax, total, discount, orderDiscount, discountRatio }` (delegates to `calculateExpectedTotals` with an empty productMap so per-line tax falls back to each item's `tax_rate`).

- [ ] **Step 1 — Write the failing test.** In backend/tests/unit/PosCalculator.test.js add `computeHeldCheckTotals` to the destructured `require` at the top of the file, then append:

```js
describe('computeHeldCheckTotals (P3-8 — split guest-check print totals)', () => {
    it('adds tax for a tax-exclusive seat so the printed total equals the settle total', () => {
        const items = [{ id: 1, qty: 1, price: 5.00, tax_rate: 16, discountType: null, discountValue: 0 }];
        const totals = computeHeldCheckTotals(items, false);   // tax-exclusive
        expect(totals.subtotal).toBe(5.00);
        expect(totals.tax).toBe(0.80);
        expect(totals.total).toBe(5.80);                        // NOT the old hardcoded 5.00
        // identical to what checkout charges for the same line
        const settle = calculateExpectedTotals({}, normalizeCartItems(items), new Map(), false);
        expect(totals.total).toBe(settle.total);
    });

    it('leaves total == subtotal for a tax-inclusive seat', () => {
        const items = [{ id: 1, qty: 1, price: 5.00, tax_rate: 16, discountType: null, discountValue: 0 }];
        const totals = computeHeldCheckTotals(items, true);
        expect(totals.tax).toBe(0);
        expect(totals.total).toBe(5.00);
    });
});
```

- [ ] **Step 2 — Run, expect FAIL.**
  `npx vitest run backend/tests/unit/PosCalculator.test.js -t "computeHeldCheckTotals"`
  Expected: FAIL — `computeHeldCheckTotals is not a function` (helper not yet exported).

- [ ] **Step 3 — Minimal fix** (two files for the tested seam; print.js + TableSplits.vue wiring below).

(3a) backend/services/PosCalculator.js — add the helper and export it. Insert before `module.exports`:
```js
/**
 * Compute the printed totals for a held split check from its stored seat items.
 * Delegates to calculateExpectedTotals (empty productMap → per-line tax falls back
 * to each item's tax_rate) so the printed total is identical to the settle total.
 */
const computeHeldCheckTotals = (items, taxInclusivePricing, orderDiscount = {}) => {
    const normalized = normalizeCartItems(items);
    return calculateExpectedTotals(
        { order_discount_type: orderDiscount.type || null, order_discount_value: orderDiscount.value || 0 },
        normalized,
        new Map(),
        !!taxInclusivePricing
    );
};
```
And add `computeHeldCheckTotals,` to the `module.exports` object.

- [ ] **Step 4 — Run, expect PASS.** `npx vitest run backend/tests/unit/PosCalculator.test.js -t "computeHeldCheckTotals"` → PASS.

- [ ] **Step 5 — Wire it into print.js, then full file.**

(5a) backend/routes/print.js — extend the PosCalculator import. BEFORE (L7):
```js
const { roundMoney } = require('../services/PosCalculator');
```
AFTER:
```js
const { roundMoney, computeHeldCheckTotals } = require('../services/PosCalculator');
```

(5b) backend/routes/print.js — in the held-check rebuild, compute real totals just before `data = { ... }` (~L195). Insert after the auth check (`if (!hasAccess) { return res.status(403)... }` block ends):
```js
                        // Real printed totals: tax-exclusive seats must show tax + a tax-
                        // inclusive total (the settle adds tax), matching what checkout charges.
                        const [[taxIncRow]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'tax_inclusive_pricing'");
                        const taxInclusivePricing = !!(taxIncRow && taxIncRow.setting_value === '1');
                        let heldTotals = { subtotal: Number(held.subtotal) || 0, tax: 0, discount: 0, total: Number(held.subtotal) || 0 };
                        try {
                            const calcItems = items.map(it => ({
                                id: it.id || it.product_id || null,
                                product_id: it.product_id || it.id || null,
                                qty: it.qty || it.quantity || 1,
                                price: it.price || it.price_at_sale || 0,
                                tax_rate: it.tax_rate || 0,
                                discountType: it.discountType || it.discount_type || null,
                                discountValue: parseFloat(it.discountValue || it.discount_value || 0)
                            }));
                            heldTotals = computeHeldCheckTotals(calcItems, taxInclusivePricing, parsedData.order_discount || {});
                        } catch (e) { /* fall back to the stored subtotal */ }
```
Then change the four hardcoded fields inside the `data = { ... }` object. BEFORE:
```js
                            subtotal: held.subtotal,
                            tax: 0,
                            discount: 0,
                            total: held.subtotal,
```
AFTER:
```js
                            subtotal: heldTotals.subtotal,
                            tax: heldTotals.tax,
                            discount: heldTotals.discount || 0,
                            total: heldTotals.total,
```

(5c) src/components/TableSplits.vue (~L428-431) — the client `tax:0 / total: check.subtotal` are OVERRIDDEN by print.js's held rebuild (payment_method:'held'), so they are cosmetic/dead. Do NOT duplicate tax math on the client. Add a one-line comment above `subtotal: check.subtotal,` for the next reader:
```js
          // NOTE: print.js rebuilds subtotal/tax/total server-side for held split checks
          // (payment_method:'held'); these three fields are placeholders, not authoritative.
```

- [ ] **Step 5d — print.js rebuild WIRING test (REQUIRED — printed money is customer-facing).** The `computeHeldCheckTotals` unit test proves the math; this step proves `print.js` actually wires it into the printed `data` for a tax-exclusive held check (not just the isolated helper). Follow the repo's print-seam pattern: `print.js` already exports pure helpers that are tested via `require('../../routes/print')` (see `backend/tests/integration/bundle.print.test.js` → `expandBundlesForKitchen`).
  - **Extract + export the seam:** if the held-check rebuild (`print.js` ~L140-233) is inline, lift the total-bearing part into an exported pure function `buildHeldCheckData(heldRow, settings)` and add it to `module.exports`, mirroring `expandBundlesForKitchen`. If a suitable exported seam already exists, reuse it.
  - **Test** (add to `backend/tests/integration/bundle.print.test.js`):
```javascript
const { buildHeldCheckData } = require('../../routes/print');
it('held split guest check prints tax + tax-inclusive total for a tax-exclusive item (printed == settle)', () => {
  const heldRow = { subtotal: 10.00, cart_data: JSON.stringify({ items: [{ product_id: 1, name: 'Burger', qty: 1, price: 10.00, tax_rate: 8 }], order_discount: {} }) };
  const data = buildHeldCheckData(heldRow, { taxInclusivePricing: false });
  expect(data.tax).toBeCloseTo(0.80, 2);
  expect(data.total).toBeCloseTo(10.80, 2);                  // == subtotal + tax, matches settle
  expect(data.total).toBeCloseTo(data.subtotal + data.tax, 2);
});
```
  - **Fallback (only if extraction is impractical):** POST `/api/print/print` with `payment_method:'held'` + the seeded held id and assert the emitted/returned payload's `total == subtotal + tax`; document which path you took. Do NOT close this task on the pure-helper test alone.
  - Run: `npx vitest run backend/tests/integration/bundle.print.test.js` → green.

- [ ] **Step 5b — Full runs.** `npx vitest run backend/tests/unit/PosCalculator.test.js` → green. Sanity: `npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js` → green (no behavior change to settle; the print-rebuild wiring is now covered by Step 5d).

- [ ] **Step 6 — Commit.**
```bash
git add backend/services/PosCalculator.js backend/routes/print.js backend/tests/unit/PosCalculator.test.js src/components/TableSplits.vue
git commit -m "fix(splits): print tax + tax-inclusive total on split guest checks (P3-8)"
```

---

## Self-Review

- **Every finding covered, one Task each:** P3-10 (T1), P3-9 (T2), P3-7 (T3), P2-3 (T4 FE + T5 BE), P3-8 (T6). Each Task is red→green with an explicit failing reason.
- **Tests fail for the RIGHT reason before the fix:** T1 parent stays `occupied`; T2 no audit row; T3 `assertNearMoney` rejects the re-priced subtotal (non-200); T4 `Σ==100` not 90; T5 missing `cart_data.order_discount` + `assertNearMoney('Total')` rejection; T6 `computeHeldCheckTotals is not a function`.
- **Server-authoritative money everywhere:** T3 sources the frozen price from `held_orders.cart_data` (not the payload); T5 sources the order discount from the held payload (not the payload) and reconciles against the parent; T6's printed total is `calculateExpectedTotals` verbatim, so print == settle by construction.
- **Discount-gate exemption is safe:** it only fires when `isSplitSettle` (a `split_check_id` validated under a row lock) AND the discount is read server-side from the held row — a cashier cannot forge a discount on an empty table.
- **Reconciliation uses the existing `assertNearMoney` (tolerance 0.02)** — no new import into tables.js; clean test numbers (90==90) pass exactly, real penny drift is absorbed.
- **No baseline re-work:** void-reason modal / checkHasVoids / item_name COALESCE / saved-row FE gate are all left as-is.
- **Ordering matters and is stated:** Plan 1 lands first; T3 introduces `splitHeldPayload` which T5 reuses (T3 before T5); T4 (FE distribution) conceptually precedes T5 (BE persist/re-apply) but they are independently testable.
- **Known limitation (documented, not a defect):** a fixed order discount split across seats can leave a ±0.01 rounding residue between the sum of rounded seat totals and the single parent total; the last-seat residue rule + the 0.02 reconciliation tolerance keep it within tolerance. Percent discounts on clean numbers are exact.
- **Risk — `pool` vs `conn` in T2:** the DELETE route starts as `pool`-only (no transaction); Task 2 must introduce a transaction so the held-order DELETE and `discard_split_check` audit insert commit or roll back together. The test reads the audit row immediately after success.
- **Risk — T6 print.js has no integration test:** per the finding, the pure `computeHeldCheckTotals` seam is unit-tested; the print.js wiring is a mechanical substitution reviewed by reading, and the TableSplits.vue numbers are proven dead (server override).

## Cross-plan file overlap

These files are also edited by sibling plans — coordinate merges and re-run the two integration suites after each landing:

- **backend/routes/pos/checkout.js** — Plan 1 (P0-1) adds `!isSplitSettle` to the table-RELEASE block; THIS plan's T3 (freeze price) + T5 (discount override + gate exemption) edit the settle path. **Land Plan 1 first**, then re-read checkout.js and confirm T3/T5 anchors still resolve. Also overlaps Plans 1/2/3 conceptually via the shared checkout flow.
- **backend/routes/pos/tables.js** — Plans 1/2/3 also edit this file. THIS plan touches the split routes (`DELETE /table_splits` ~L1579; `POST /table_splits/split` ~L1597-1744) and the parent-order lookup. Keep edits scoped to the split routes; re-`grep` anchors after any sibling merge.
- **assets/js/composables/stores/orderSessionStore.js** — Plans 6/7 also edit this store. THIS plan adds the module-level `distributeOrderDiscount` helper and rewrites `confirmSplit`'s payload build (~L1056). Merge by keeping the new helper near `roundMoney` (L14) and re-checking `confirmSplit` line numbers.
- **backend/routes/print.js** and **src/components/TableSplits.vue** — split-print surface; no known sibling overlap, but re-confirm the held-rebuild block (~L140-233) has not shifted.
- **backend/services/PosCalculator.js** — additive only (new exported helper); low conflict risk.

After EVERY task in this plan: `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js` (and the touched unit file). Do not proceed to the next task on any red.
