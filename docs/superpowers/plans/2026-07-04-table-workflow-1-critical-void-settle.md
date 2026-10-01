# Critical Void & Settle Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to implement task-by-task; steps use `- [ ]` checkboxes.

**Goal**: Eliminate two classes of correctness bugs in the table settle / void flow: (P0-1) a split-check settle silently voids a re-seated table's live order and frees the table; (P1-3) four void audit_events are written on a separate auto-commit connection BEFORE the request transaction commits, leaving phantom audit rows when the transaction rolls back.

**Architecture**: Node + Express + MySQL (mysql2/promise pool). POS routes at `backend/routes/pos/*` open a pooled connection, `beginTransaction`, mutate rows, insert required destructive audit rows with the same `conn`, then `commit` (rollback in catch). Audit rows go to `audit_events` and must be transactional: if the audit insert fails, the mutation rolls back too. Integration tests are Vitest (`supertest` against the real Express `app` + a seeded MySQL test DB).

**Tech Stack**: Node.js, Express, MySQL (mysql2/promise), Vitest + supertest. Frontend untouched by this plan.

## Global Constraints

- **Test runner is Vitest**, run via `npx vitest run <file>` from repo root `C:\xampp\htdocs\posapp`. NEVER `npx jest` (gives false race/pool-closed failures). Focus a single test with `-t "<name>"`.
- Integration suites touched here: `backend/tests/integration/checkout.test.js` and `backend/tests/integration/tables.test.js`. Both call `seedDatabase()` in `beforeEach` and `await pool.end()` in `afterAll`. A live MySQL test DB must be running (the existing suite already requires it).
- Existing test helpers to mirror exactly: `createTableOrder(cookie, tableId, items, subtotal, tax, total)` (tables.test.js, returns invoice_id) and the inline `grantWaiter([...perms])` in tables.test.js; the connection-mock pattern in checkout.test.js (`vi.spyOn(pool, 'getConnection')` wrapping `conn.query`) and tables.test.js. `SEED` exposes `product1` (burger 5.00 / 16% tax), `product2` (drink 2.00 / 0% tax), `table`, `table2`, `adminUser`, `cashierUser`, `waiterUser`.
- **Money**: `roundMoney` + `assertNearMoney` (MONEY_TOLERANCE). In the table-save path only `Subtotal` is asserted against the client; tax/total are server-authoritative.
- **Audit rows are transactional and MUST be inserted with the same `conn` BEFORE `conn.commit()`.** Do not use background `pool.query(...).catch(...)` for destructive audit rows.
- **DB txn pattern**: `pool.getConnection` → `beginTransaction` → … → `commit`; `rollback` in catch.
- **`sendError()` sanitizes** any message containing (`"table"` AND `"exist"`) or `ER_`/`SQLSTATE`/`mysql` into a generic error. Do not phrase new error strings that trip that trap. (No new user-facing strings are introduced by this plan.)
- **Working-tree baseline already applied — do NOT re-add or "fix"**: void-reason modal removed (payloads send `void_reason: null`); `checkHasVoids` Map-aggregate; `item_name` COALESCE in `existingItemsForPrint` query (tables.js ~L1182) + `table_order` GET (~L750); saved-row delete FE gate `(!canVoidItems || !canBypassPrintedLock)`; the "A void reason is required" hard-throws removed.
- **Scope discipline**: change ONLY the lines each task names. `let` declarations added must be minimal and in the smallest scope that reaches both the assignment and the transactional audit insert. Line numbers below were current at authoring time and **will drift** — re-open each file and match on the quoted BEFORE text, not the number.

---

### Task 1: P0-1 — split-check settle must not void a re-seated table order

Finding **P0-1** — `backend/routes/pos/checkout.js`, "Release Table and Cleanup Ghost Table Order" block (~L622-689), guarded only by `if (data.table_id)` (~L624). Defect: on a split settle (`isSplitSettle = !!data.split_check_id`, defined ~L194) the client legitimately sends `table_id`; the block reads the table's *current* `current_order_id`, and if the table was re-seated with a new unpaid order B, `old_table_order_id !== invoice_id` → it VOIDS order B (zeroes totals, `payment_method='voided'`), restocks B, and frees the table. A split already detached from the table at split time, so a seat settle must never touch `restaurant_tables` or void another invoice.

**Files**
- Modify `backend/routes/pos/checkout.js:624` (the `if (data.table_id)` guard).
- Test `backend/tests/integration/checkout.test.js`.

- [ ] **Step 1 — Write the FAILING regression test.** Append inside the top-level `describe('Checkout Integration Tests', …)` in `backend/tests/integration/checkout.test.js` (e.g. after the existing `'fresh checkout over an old table ghost…'` test):

```js
    it('P0-1: a split-check settle must not void a re-seated table order or free the table', async () => {
        await openShift();

        // Admin cookie for the split route (checkSplitBillPermission) — cashier lacks it.
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        // 1. Seed ORIGINAL unpaid table order A on SEED.table and point the table at it.
        const [insA] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const orderA = insA.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [orderA, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [orderA, SEED.table.id]
        );

        // 2. Split A into one seat — this VOIDS A and FREES the table (detaches the split).
        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: orderA,
                splits: [
                    { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                ]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[held]] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");
        const splitCheckId = held.id;

        // 3. Re-seat the SAME table with a brand-new unpaid order B (live, unpaid).
        const [insB] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 2.00, 0.00, 2.00, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const orderB = insB.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Drink', 1, 2.00, 0, '')",
            [orderB, SEED.product2.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [orderB, SEED.table.id]
        );

        // 4. Settle the DETACHED split seat. The client legitimately sends table_id on a split
        //    settle (see checkout.js comment). This must NOT touch table B.
        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                split_check_id: splitCheckId,
                parent_invoice_id: orderA,
                is_split: true,
                table_id: SEED.table.id,
                idempotency_key: 'p0-1-split-reseat'
            });
        expect(payRes.statusCode).toBe(200);
        expect(payRes.body.success).toBe(true);

        // 5. Order B is untouched and the table is still occupied by B.
        const [[bRow]] = await pool.query(
            "SELECT payment_method FROM orders WHERE invoice_id = ?", [orderB]
        );
        expect(bRow.payment_method).toBe('unpaid_table');

        const [[tRow]] = await pool.query(
            "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]
        );
        expect(tRow.status).toBe('occupied');
        expect(tRow.current_order_id).toBe(orderB);
    });
```

- [ ] **Step 2 — Run it, expect FAIL.** `npx vitest run backend/tests/integration/checkout.test.js -t "P0-1: a split-check settle must not void"`. Expected failure: the release block runs (guard is only `if (data.table_id)`), voiding B and freeing the table → `expect(bRow.payment_method).toBe('unpaid_table')` receives `'voided'` (and/or `tRow.status` is `'available'`, `tRow.current_order_id` is `null`). The 200 assertions on `payRes` pass (checkout still "succeeds").

- [ ] **Step 3 — Apply the minimal fix.** In `backend/routes/pos/checkout.js`, change the guard.

  BEFORE:
  ```js
        // 6. Release Table and Cleanup Ghost Table Order
        let tableToEmitAvailable = null;
        if (data.table_id) {
  ```
  AFTER:
  ```js
        // 6. Release Table and Cleanup Ghost Table Order
        // A split-check settle has ALREADY detached from the table at split time (the split
        // route freed the table and voided the parent). Re-running this block on a split
        // settle would void whatever order the table now points at (a legitimate re-seat) and
        // wrongly free the table. isSplitSettle is only true when a validated split_check_id is
        // present, so a normal unpaid_table settle still frees its table.
        let tableToEmitAvailable = null;
        if (data.table_id && !isSplitSettle) {
  ```

- [ ] **Step 4 — Run the regression test, expect PASS.** `npx vitest run backend/tests/integration/checkout.test.js -t "P0-1: a split-check settle must not void"`. Now `payRes` is 200, order B is `unpaid_table`, and the table stays `occupied` with `current_order_id === orderB`.

- [ ] **Step 5 — Add the NON-REGRESSION guard test (normal settle still frees the table) and run the whole suite.** Append after the Step-1 test:

```js
    it('P0-1 guard: a normal unpaid_table settle (no split) still frees the table', async () => {
        await openShift();

        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table2.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [invoiceId, SEED.table2.id]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table2.id
            });
        expect(res.statusCode).toBe(200);

        const [[tRow]] = await pool.query(
            "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]
        );
        expect(tRow.status).toBe('available');
        expect(tRow.current_order_id).toBeNull();
    });
```
  This guard passes both before AND after the fix (it proves the `!isSplitSettle` change does not break the normal settle path). Run the full suite: `npx vitest run backend/tests/integration/checkout.test.js`. Expect all tests green.

- [ ] **Step 6 — Commit.**
  ```
  git add backend/routes/pos/checkout.js backend/tests/integration/checkout.test.js
  git commit -m "fix(checkout): skip table release/void block on split-check settle (P0-1)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 2: P1-3 — move the `void_item` audit into the transaction (tables.js)

Finding **P1-3** (worst site) — `backend/routes/pos/tables.js`, `void_item` audit ~L1273, inside the `if (order_id)` update branch; the request commits far later at ~L1409. Between the audit insert and the commit run: `DELETE order_items` (~L1310), the re-insert loop, and `validateBundleCartLines` (~L1356) which **throws 400 on a forged bundle line**. The audit is written with `pool.query(...)` (separate auto-commit connection), so on that throw the transaction rolls back but the audit row survives → phantom.

**Files**
- Modify `backend/routes/pos/tables.js` — remove the audit at ~L1273; re-insert it after `conn.commit()` (~L1409).
- Test `backend/tests/integration/tables.test.js`.

- [ ] **Step 1 — Write the FAILING regression test.** Append inside the top-level `describe('Table Bill Split Integration Tests', …)` in `backend/tests/integration/tables.test.js` (e.g. after the `describe('Item-Level Void Audit on Saved Tables', …)` block):

```js
    describe('P1-3: void_item audit is committed only after the transaction', () => {
        it('writes NO phantom void_item audit row when a post-audit validation rolls the txn back', async () => {
            // Saved table order with 2 burgers (admin holds void + printed-bypass perms).
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // Re-save that REDUCES the burger 2 -> 1 (builds auditedVoidItems) AND attaches a
            // forged bundle line: product2 is NOT a bundle, so validateBundleCartLines throws
            // 400 AFTER the audit insert but BEFORE commit -> whole transaction rolls back.
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId,
                    cart: [
                        { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                        { id: SEED.product2.id, qty: 1, price: 2.00, bundleItems: [{ product_id: SEED.product1.id }] }
                    ],
                    subtotal: 7.00, tax: 0.80, total: 7.80
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/bundle/i);

            // Fire-and-forget audit insert would land within this window if it ran.
            await new Promise(resolve => setTimeout(resolve, 50));

            const [[{ c }]] = await pool.query(
                "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'void_item' AND entity_id = ?",
                [invoiceId]
            );
            expect(Number(c)).toBe(0);

            // The reduction rolled back: the burger is still qty 2.
            const [items] = await pool.query(
                "SELECT quantity FROM order_items WHERE invoice_id = ? AND product_id = ?",
                [invoiceId, SEED.product1.id]
            );
            expect(Number(items[0].quantity)).toBe(2);
        });

        it('writes exactly one void_item audit row on a SUCCESSFUL reduction (insert not dropped)', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(200);

            await new Promise(resolve => setTimeout(resolve, 50));

            const [[{ c }]] = await pool.query(
                "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'void_item' AND entity_id = ?",
                [invoiceId]
            );
            expect(Number(c)).toBe(1);
        });
    });
```

- [ ] **Step 2 — Run it, expect FAIL (first test) / PASS (second).** `npx vitest run backend/tests/integration/tables.test.js -t "P1-3: void_item audit"`. The first test FAILS: the audit fires at ~L1273 before `validateBundleCartLines` throws, so `COUNT(*)` is `1`, not `0` (`expected 0, received 1`). The second (positive) test PASSES already (guards against dropping the insert during the fix).

- [ ] **Step 3 — Apply the minimal fix.** Remove the early audit block from the update branch and re-insert it with `await conn.query(...)` immediately before commit.

  BEFORE (in the `if (order_id)` update branch, ~L1270):
  ```js
                // Durable audit of item-level voids/reductions on a saved/printed table
                // (superseded: use the transactional audit insert below instead).
                if (auditedVoidItems && auditedVoidItems.length > 0) {
                    pool.query(
                        `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                         VALUES ('void_item', ?, 'order', ?, ?, ?, ?)`,
                        [
                            req.user.id,
                            order_id,
                            JSON.stringify({ items: auditedVoidItems }),
                            JSON.stringify({ void_reason: voidReason }),
                            req.ip || null
                        ]
                    ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_item'));
                }

  ```
  AFTER (leave only a marker comment where it was):
  ```js
                // Item-level void audit is DEFERRED until after conn.commit() (see below) so a
                // post-audit rollback (e.g. a forged bundle line failing validation) cannot
                // leave a phantom audit_events row. auditedVoidItems/order_id/voidReason are
                // function-scoped locals that survive to the transactional audit insert.

  ```

  Then, BEFORE (the main success commit, ~L1409):
  ```js
        await conn.commit();

        const [[identityRow]] = await conn.query(
  ```
  AFTER:
  ```js
        await conn.commit();

        // Durable audit of item-level voids/reductions — fired only after the transaction has
        // Durable audit row; same transaction as the table-order mutation.
        if (auditedVoidItems && auditedVoidItems.length > 0) {
            pool.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ('void_item', ?, 'order', ?, ?, ?, ?)`,
                [
                    req.user.id,
                    order_id,
                    JSON.stringify({ items: auditedVoidItems }),
                    JSON.stringify({ void_reason: voidReason }),
                    req.ip || null
                ]
            ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_item'));
        }

        const [[identityRow]] = await conn.query(
  ```

- [ ] **Step 4 — Run the two tests, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "P1-3: void_item audit"`. Both green: the rollback case now leaves `COUNT(*) = 0`; the success case still writes exactly one row.

- [ ] **Step 5 — Run the affected suite.** `npx vitest run backend/tests/integration/tables.test.js`. Confirm the pre-existing `'writes a void_item audit event when an item is reduced…'` test and all others stay green.

- [ ] **Step 6 — Commit.**
  ```
  git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
  git commit -m "fix(tables): make void_item audit transactional (P1-3)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 3: P1-3 — move the empty-cart `void_order` audit into the transaction (tables.js)

Finding **P1-3** — `backend/routes/pos/tables.js`, empty-cart `void_order` audit ~L1036, inside the `if (order_id)` sub-block of the empty-cart branch; the branch commits at ~L1053 after clearing the table (~L1052). The audit uses `pool.query(...)` before commit, so a throw in the table-release UPDATE (or any query up to commit) leaves a phantom `void_order` row while the order's void is rolled back.

**Files**
- Modify `backend/routes/pos/tables.js` — capture the payload where the audit was, insert after `conn.commit()` (~L1053).
- Test `backend/tests/integration/tables.test.js`.

- [ ] **Step 1 — Write the FAILING regression test.** Append inside the top-level `describe(...)` in `backend/tests/integration/tables.test.js`:

```js
    describe('P1-3: void_order (empty-cart) audit is committed only after the transaction', () => {
        it('writes NO phantom void_order audit row when a post-audit crash rolls the txn back', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            // Force the table-release UPDATE (runs AFTER the void_order audit, BEFORE commit)
            // to throw, so the whole void transaction rolls back.
            const originalGetConnection = pool.getConnection;
            vi.spyOn(pool, 'getConnection').mockImplementation(async function () {
                const conn = await originalGetConnection.call(this);
                const originalQuery = conn.query;
                conn.query = async function (sql, params) {
                    if (typeof sql === 'string' && sql.includes("SET status = 'available'")) {
                        throw new Error('Simulated crash after void audit');
                    }
                    return originalQuery.call(this, sql, params);
                };
                return conn;
            });

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, cart: [] });
            expect(res.statusCode).toBe(500);

            vi.restoreAllMocks();

            await new Promise(resolve => setTimeout(resolve, 50));

            const [[{ c }]] = await pool.query(
                "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'void_order' AND entity_id = ?",
                [invoiceId]
            );
            expect(Number(c)).toBe(0);

            // The void rolled back: still a live unpaid table order.
            const [[o]] = await pool.query(
                "SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]
            );
            expect(o.payment_method).toBe('unpaid_table');
        });
    });
```

- [ ] **Step 2 — Run it, expect FAIL.** `npx vitest run backend/tests/integration/tables.test.js -t "P1-3: void_order (empty-cart) audit"`. The audit fires at ~L1036 before the mocked UPDATE throws, so `COUNT(*)` is `1` (`expected 0, received 1`). The `payment_method` assertion passes (the void UPDATE is rolled back).

- [ ] **Step 3 — Apply the minimal fix.** Declare a payload holder at the top of the empty-cart branch, capture instead of insert, and insert with `await conn.query(...)` immediately before commit.

  BEFORE (empty-cart branch header, ~L971):
  ```js
        // 1. Handle Empty Cart (Table Release / Void)
        if (!data.cart || data.cart.length === 0) {
            if (order_id) {
  ```
  AFTER:
  ```js
        // 1. Handle Empty Cart (Table Release / Void)
        if (!data.cart || data.cart.length === 0) {
            let voidOrderAuditPayload = null;
            if (order_id) {
  ```

  BEFORE (the audit, ~L1035):
  ```js
                // Write durable audit event (superseded: use the transactional insert below)
                pool.query(
                    `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                     VALUES ('void_order', ?, 'order', ?, ?, ?, ?)`,
                    [
                        req.user.id,
                        order_id,
                        JSON.stringify({ total: originalOrderVals?.total, subtotal: originalOrderVals?.subtotal, tax: originalOrderVals?.tax }),
                        JSON.stringify({ void_reason: voidReason }),
                        req.ip || null
                    ]
                ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_order'));
  ```
  AFTER:
  ```js
                // Capture the audit payload now; the durable insert is DEFERRED until after
                // conn.commit() so a post-audit rollback cannot leave a phantom audit row.
                voidOrderAuditPayload = {
                    userId: req.user.id,
                    entityId: order_id,
                    oldValue: JSON.stringify({ total: originalOrderVals?.total, subtotal: originalOrderVals?.subtotal, tax: originalOrderVals?.tax }),
                    newValue: JSON.stringify({ void_reason: voidReason }),
                    ip: req.ip || null
                };
  ```

  BEFORE (the empty-cart commit, ~L1052):
  ```js
            await conn.query("UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, parent_table_id = NULL WHERE id IN (?)", [tableIdsToClear]);
            await conn.commit();

            if (req.io) {
  ```
  AFTER:
  ```js
            await conn.query("UPDATE restaurant_tables SET status = 'available', current_order_id = NULL, parent_table_id = NULL WHERE id IN (?)", [tableIdsToClear]);
            await conn.commit();

            // Fire the void_order audit only after the transaction has durably committed.
            if (voidOrderAuditPayload) {
                pool.query(
                    `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                     VALUES ('void_order', ?, 'order', ?, ?, ?, ?)`,
                    [
                        voidOrderAuditPayload.userId,
                        voidOrderAuditPayload.entityId,
                        voidOrderAuditPayload.oldValue,
                        voidOrderAuditPayload.newValue,
                        voidOrderAuditPayload.ip
                    ]
                ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_order'));
            }

            if (req.io) {
  ```

- [ ] **Step 4 — Run the test, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "P1-3: void_order (empty-cart) audit"`. The mocked crash aborts before commit, so no audit is written → `COUNT(*) = 0`.

- [ ] **Step 5 — Run the affected suite.** `npx vitest run backend/tests/integration/tables.test.js`. All green (empty-cart void success path still writes its audit — covered indirectly; no existing test asserts a phantom).

- [ ] **Step 6 — Commit.**
  ```
  git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
  git commit -m "fix(tables): make empty-cart void_order audit transactional (P1-3)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 4: P1-3 — move the `void_split` audit into the transaction (tables.js)

Finding **P1-3** — `backend/routes/pos/tables.js`, `void_split` audit ~L1703, inside the `if (isTableSplit)` block; the route commits at ~L1744 after releasing the table (~L1719) and inserting each seat into `held_orders` (~L1738). The audit uses `pool.query(...)` before commit, so a throw during a seat insert leaves a phantom `void_split` row while the original order's void is rolled back.

**Files**
- Modify `backend/routes/pos/tables.js` — declare a payload holder in the split handler's outer scope (next to `let tableIdsToClear = [];`), capture instead of insert, insert after `conn.commit()` (~L1744).
- Test `backend/tests/integration/tables.test.js`.

- [ ] **Step 1 — Write the FAILING regression test.** Append inside the top-level `describe(...)`:

```js
    describe('P1-3: void_split audit is committed only after the transaction', () => {
        it('writes NO phantom void_split audit row when a post-audit crash rolls the txn back', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // Force the first held_orders INSERT (runs AFTER the void_split audit, BEFORE
            // commit) to throw, rolling back the whole split.
            const originalGetConnection = pool.getConnection;
            vi.spyOn(pool, 'getConnection').mockImplementation(async function () {
                const conn = await originalGetConnection.call(this);
                const originalQuery = conn.query;
                conn.query = async function (sql, params) {
                    if (typeof sql === 'string' && sql.includes('INSERT INTO held_orders')) {
                        throw new Error('Simulated crash after split audit');
                    }
                    return originalQuery.call(this, sql, params);
                };
                return conn;
            });

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                        { referenceName: 'Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                    ]
                });
            expect(res.statusCode).toBe(500);

            vi.restoreAllMocks();

            await new Promise(resolve => setTimeout(resolve, 50));

            const [[{ c }]] = await pool.query(
                "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'void_split' AND entity_id = ?",
                [invoiceId]
            );
            expect(Number(c)).toBe(0);

            // The split rolled back: the original order is NOT voided.
            const [[o]] = await pool.query(
                "SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]
            );
            expect(o.payment_method).toBe('unpaid_table');
        });
    });
```

- [ ] **Step 2 — Run it, expect FAIL.** `npx vitest run backend/tests/integration/tables.test.js -t "P1-3: void_split audit"`. The audit fires at ~L1703 before the mocked `held_orders` insert throws, so `COUNT(*)` is `1` (`expected 0, received 1`). The `payment_method` stays `unpaid_table` (void UPDATE rolled back).

- [ ] **Step 3 — Apply the minimal fix.** Add the holder in outer scope, capture, and insert with `await conn.query(...)` immediately before commit.

  BEFORE (~L1616):
  ```js
        const isTableSplit = !!(tableId && currentOrderId);
        let tableIdsToClear = [];
        let parentInvoiceId = null;
  ```
  AFTER:
  ```js
        const isTableSplit = !!(tableId && currentOrderId);
        let tableIdsToClear = [];
        let voidSplitAuditPayload = null;
        let parentInvoiceId = null;
  ```

  BEFORE (the audit, ~L1702):
  ```js
            // Write durable audit event (superseded: use the transactional insert below)
            pool.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ('void_split', ?, 'order', ?, ?, ?, ?)`,
                [
                    req.user.id,
                    currentOrderId,
                    JSON.stringify({ total: originalSplitVals?.total, subtotal: originalSplitVals?.subtotal, tax: originalSplitVals?.tax }),
                    JSON.stringify({ void_reason: voidReason || 'Bill Split' }),
                    req.ip || null
                ]
            ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_split'));
  ```
  AFTER:
  ```js
            // Capture the audit payload now; the durable insert is DEFERRED until after
            // conn.commit() so a post-audit rollback cannot leave a phantom audit row.
            voidSplitAuditPayload = {
                userId: req.user.id,
                entityId: currentOrderId,
                oldValue: JSON.stringify({ total: originalSplitVals?.total, subtotal: originalSplitVals?.subtotal, tax: originalSplitVals?.tax }),
                newValue: JSON.stringify({ void_reason: voidReason || 'Bill Split' }),
                ip: req.ip || null
            };
  ```

  BEFORE (the split commit, ~L1744):
  ```js
        await conn.commit();

        // 3. Emit socket updates and return success
        if (req.io) {
  ```
  AFTER:
  ```js
        await conn.commit();

        // Fire the void_split audit only after the transaction has durably committed.
        if (voidSplitAuditPayload) {
            pool.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ('void_split', ?, 'order', ?, ?, ?, ?)`,
                [
                    voidSplitAuditPayload.userId,
                    voidSplitAuditPayload.entityId,
                    voidSplitAuditPayload.oldValue,
                    voidSplitAuditPayload.newValue,
                    voidSplitAuditPayload.ip
                ]
            ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_split'));
        }

        // 3. Emit socket updates and return success
        if (req.io) {
  ```

- [ ] **Step 4 — Run the test, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "P1-3: void_split audit"`. The mocked crash aborts before commit, so no audit is written → `COUNT(*) = 0`.

- [ ] **Step 5 — Run the affected suite.** `npx vitest run backend/tests/integration/tables.test.js`. Confirm the existing split tests (`'should split a table order into two seats…'`, which asserts the original order becomes `voided`) still pass — that path commits normally, so the deferred audit still writes.

- [ ] **Step 6 — Commit.**
  ```
  git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
  git commit -m "fix(tables): make void_split audit transactional (P1-3)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

### Task 5: P1-3 — move the ghost `void_checkout` audit into the transaction (checkout.js)

Finding **P1-3** — `backend/routes/pos/checkout.js`, ghost-table `void_checkout` audit ~L677, inside the release/void block; the request commits at ~L692 after `ensurePaidInvoiceNumber` (~L691) reserves an invoice number. The audit uses `pool.query(...)` before commit, so a throw during invoice-number reservation leaves a phantom `void_checkout` row while the ghost void and the new order are rolled back. (This block is reached on an admin/edit checkout over an old ghost table order — the release block from Task 1, now `if (data.table_id && !isSplitSettle)`.)

**Files**
- Modify `backend/routes/pos/checkout.js` — declare a payload holder next to `let tableToEmitAvailable = null;`, capture instead of insert, insert after `conn.commit()` (~L692).
- Test `backend/tests/integration/checkout.test.js`.

- [ ] **Step 1 — Write the FAILING regression test.** Append inside the top-level `describe('Checkout Integration Tests', …)`:

```js
    it('P1-3: a rollback after the ghost void_checkout writes NO phantom audit row', async () => {
        await openShift();

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        // Seed a ghost unpaid table order and point the table at it.
        const [ghost] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
             VALUES (NULL, ?, ?, ?, ?, 10, 0, 10, 'unpaid_table')`,
            [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id, cashierShiftId]
        );
        const ghostId = ghost.insertId;
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
             VALUES (?, ?, 'Test Burger', 1, 10, 0, 0)`,
            [ghostId, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [ghostId, SEED.table.id]
        );

        // Force the invoice-number reservation (runs AFTER the ghost void_checkout audit,
        // BEFORE commit) to throw, rolling back the whole checkout.
        const originalGetConnection = pool.getConnection;
        vi.spyOn(pool, 'getConnection').mockImplementation(async function () {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            conn.query = async function (sql, params) {
                if (typeof sql === 'string' && sql.includes('INSERT INTO invoice_sequences')) {
                    throw new Error('Simulated crash after ghost void audit');
                }
                return originalQuery.call(this, sql, params);
            };
            return conn;
        });

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
                subtotal: 5, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                shift_id: cashierShiftId,
                idempotency_key: 'p1-3-ghost-rollback'
            });
        expect(res.statusCode).toBe(500);

        vi.restoreAllMocks();

        await new Promise(resolve => setTimeout(resolve, 50));

        const [[{ c }]] = await pool.query(
            "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'void_checkout' AND entity_id = ?",
            [ghostId]
        );
        expect(Number(c)).toBe(0);

        // The ghost void rolled back: it is still a live unpaid table order.
        const [[o]] = await pool.query(
            "SELECT payment_method FROM orders WHERE invoice_id = ?", [ghostId]
        );
        expect(o.payment_method).toBe('unpaid_table');
    });
```

- [ ] **Step 2 — Run it, expect FAIL.** `npx vitest run backend/tests/integration/checkout.test.js -t "P1-3: a rollback after the ghost void_checkout"`. The ghost audit fires at ~L677 before `ensurePaidInvoiceNumber`'s `INSERT INTO invoice_sequences` throws, so `COUNT(*)` is `1` (`expected 0, received 1`). The ghost stays `unpaid_table` (void UPDATE rolled back).

- [ ] **Step 3 — Apply the minimal fix.** (Task 1 already changed the guard to `if (data.table_id && !isSplitSettle)`.) Add the holder, capture, and insert with `await conn.query(...)` immediately before commit.

  BEFORE (~L622, after Task 1):
  ```js
        // 6. Release Table and Cleanup Ghost Table Order
        // A split-check settle has ALREADY detached from the table at split time (the split
        // route freed the table and voided the parent). Re-running this block on a split
        // settle would void whatever order the table now points at (a legitimate re-seat) and
        // wrongly free the table. isSplitSettle is only true when a validated split_check_id is
        // present, so a normal unpaid_table settle still frees its table.
        let tableToEmitAvailable = null;
        if (data.table_id && !isSplitSettle) {
  ```
  AFTER:
  ```js
        // 6. Release Table and Cleanup Ghost Table Order
        // A split-check settle has ALREADY detached from the table at split time (the split
        // route freed the table and voided the parent). Re-running this block on a split
        // settle would void whatever order the table now points at (a legitimate re-seat) and
        // wrongly free the table. isSplitSettle is only true when a validated split_check_id is
        // present, so a normal unpaid_table settle still frees its table.
        let tableToEmitAvailable = null;
        let voidCheckoutAuditPayload = null;
        if (data.table_id && !isSplitSettle) {
  ```

  BEFORE (the ghost audit, ~L676):
  ```js
               // Durable audit event for this ghost-table void (superseded: use transactional insert)
               pool.query(
                   `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                    VALUES ('void_checkout', ?, 'order', ?, ?, ?, ?)`,
                   [
                       api_user.id,
                       old_table_order_id,
                       JSON.stringify({ total: originalGhostVals?.total, subtotal: originalGhostVals?.subtotal, tax: originalGhostVals?.tax }),
                       JSON.stringify({ replacement_invoice_id: invoice_id }),
                       req.ip || null
                   ]
               ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_checkout'));
  ```
  AFTER:
  ```js
               // Durable audit event for this ghost-table void — transactional, before commit,
               // so an audit failure rolls back the ghost void too.
               voidCheckoutAuditPayload = {
                   userId: api_user.id,
                   entityId: old_table_order_id,
                   oldValue: JSON.stringify({ total: originalGhostVals?.total, subtotal: originalGhostVals?.subtotal, tax: originalGhostVals?.tax }),
                   newValue: JSON.stringify({ replacement_invoice_id: invoice_id }),
                   ip: req.ip || null
               };
  ```

  BEFORE (the commit, ~L691):
  ```js
        const invoiceIdentity = await ensurePaidInvoiceNumber(conn, invoice_id, createdAt);
        await conn.commit();

        if (tableToEmitAvailable) {
  ```
  AFTER:
  ```js
        const invoiceIdentity = await ensurePaidInvoiceNumber(conn, invoice_id, createdAt);
        await conn.commit();

        // Fire the ghost-void audit only after the transaction has durably committed.
        if (voidCheckoutAuditPayload) {
            pool.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ('void_checkout', ?, 'order', ?, ?, ?, ?)`,
                [
                    voidCheckoutAuditPayload.userId,
                    voidCheckoutAuditPayload.entityId,
                    voidCheckoutAuditPayload.oldValue,
                    voidCheckoutAuditPayload.newValue,
                    voidCheckoutAuditPayload.ip
                ]
            ).catch(auditErr => logger.error({ err: auditErr }, 'audit_events: failed to log void_checkout'));
        }

        if (tableToEmitAvailable) {
  ```

- [ ] **Step 4 — Run the test, expect PASS.** `npx vitest run backend/tests/integration/checkout.test.js -t "P1-3: a rollback after the ghost void_checkout"`. The mocked crash aborts before commit → no audit row → `COUNT(*) = 0`.

- [ ] **Step 5 — Run the affected suite.** `npx vitest run backend/tests/integration/checkout.test.js`. Confirm the pre-existing `'fresh checkout over an old table ghost voids the ghost…'` test still passes (that path commits, so the deferred `void_checkout` audit still writes).

- [ ] **Step 6 — Commit.**
  ```
  git add backend/routes/pos/checkout.js backend/tests/integration/checkout.test.js
  git commit -m "fix(checkout): make ghost void_checkout audit transactional (P1-3)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  ```

---

## Self-Review

**Finding coverage**
- **P0-1** (split settle voids a re-seated order) → Task 1: guard the release/void block with `if (data.table_id && !isSplitSettle)`; failing regression (split → re-seat B → settle seat → assert B `unpaid_table` + table `occupied` with B) plus a non-regression guard proving normal settles still free the table. ✔
- **P1-3** (four audit sites originally written on a separate connection before commit) → Task 2 (`void_item`, tables.js — real forged-bundle rollback regression + a positive "exactly one row" guard), Task 3 (`void_order` empty-cart, tables.js), Task 4 (`void_split`, tables.js), Task 5 (`void_checkout`, checkout.js). Each now inserts the audit row with the same transaction connection before `conn.commit()`, so audit failure rolls back the business mutation. ✔ All four sites named in the finding are covered.

**Test approach note**: only `void_item` has a natural black-box rollback trigger (a forged bundle line failing `validateBundleCartLines` post-audit). The other three sites (`void_order`, `void_split`, `void_checkout`) use the established `vi.spyOn(pool, 'getConnection')` connection-mock (already used in both suites) to throw on a query that provably runs AFTER the audit and BEFORE commit — the empty-cart table-release `UPDATE … SET status = 'available'`, the `INSERT INTO held_orders` seat insert, and `ensurePaidInvoiceNumber`'s `INSERT INTO invoice_sequences` respectively. Each mock restores with `vi.restoreAllMocks()`.

**Placeholder scan**: no TODO / "add validation" / "similar to Task N". Every code step shows real BEFORE→AFTER source and full test code. Exact vitest commands and expected FAIL/PASS reasons are given per step.

**Type consistency**: captured audit payloads are plain objects with `userId` (number), `entityId` (number invoice id), `oldValue`/`newValue` (JSON strings), `ip` (string|null) — identical values/types to the original inline `pool.query` parameter arrays, only relocated. `voidCheckoutAuditPayload`/`voidOrderAuditPayload`/`voidSplitAuditPayload` are `let … = null` initialized and null-guarded before the transactional insert, so a path that never voids fires no audit. `checkout.js` uses `api_user.id` (not `req.user.id`) — preserved. `tables.js` sites use `req.user.id` — preserved. Scopes verified: `auditedVoidItems`/`order_id`/`voidReason` are function-scoped in tables.js and remain in scope at the transactional insert (Task 2); the new holders are declared in the smallest scope reaching both the assignment and the commit (empty-cart branch for Task 3; split-handler outer scope for Task 4; release-block outer scope for Task 5).

## Cross-plan file overlap

This plan edits `backend/routes/pos/checkout.js` (Tasks 1, 5) and `backend/routes/pos/tables.js` (Tasks 2, 3, 4). Plans 2 (bundle), 3 (structural ops), 4 (splits), 6 (permissions), and 7 (hardening) also edit `tables.js` and/or `checkout.js`.

- **Land this plan FIRST** — highest severity (one P0 data-corruption + four phantom-audit correctness bugs) and the smallest diff (one guard clause + four audit relocations). Landing first minimizes rebase pain for the larger structural plans.
- Because these two files are shared, executors of **every** plan touching them MUST re-run both integration suites after their changes:
  ```
  npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js
  ```
- Task 1 and Task 5 both edit the same `checkout.js` region (the release/void block header at ~L622-624). Task 1 changes the `if` condition; Task 5 (run later) adds `let voidCheckoutAuditPayload = null;` on the line above the now-modified `if`. Task 5's BEFORE text in this plan already reflects Task 1's edit — apply the tasks in order (1 → 5).
- Task 3 and Task 4 both add a `let …AuditPayload = null;` in `tables.js` but in different scopes (empty-cart branch vs. split handler) — no textual overlap.
