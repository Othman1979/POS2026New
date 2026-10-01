# Table Structural Ops (Transfer/Merge/Join/Disjoin) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to run this plan task-by-task in the current session (or superpowers:executing-plans for a separate review session), and superpowers:test-driven-development for every task (failing test FIRST, prove red → green). Steps use checkbox (`- [ ]`) syntax. **Run one Task per agent dispatch; commit before the next.**
>
> **Git hygiene:** the owner may have unrelated WIP in the tree. Do NOT `git stash`. When committing, stage ONLY the two files this plan names (`git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js`) — never `git add -A`.

**Goal:** Close four data-integrity/audit defects in the POS table *structural* operations (transfer / merge / join / disjoin) in `backend/routes/pos/tables.js`. Each fix ships with a failing-first integration test. The behaviour changes are intentional: no more ghost occupied tables after transfer/merge, no orphaned open orders via disjoin, and durable audit trails for merge/disjoin (which today are DELETE-with-no-record and blind-null respectively).

**Architecture:** All four ops live in one route file. `POST /api/pos/tables/transfer` (`~L227`) multiplexes `transfer` / `swap` / `merge` by `action`. `POST /api/pos/tables/join` (`~L462`) and `POST /api/pos/tables/disjoin` (`~L531`) are separate handlers. All use the same transaction shape: `pool.getConnection()` → `conn.beginTransaction()` → work → `conn.commit()`, with `conn.rollback()` in the `catch` and `conn.release()` in `finally`. Tables are `SELECT ... FOR UPDATE` locked in ascending id order to avoid deadlocks. After commit, each affected table is pushed with `broadcastTableUpdate(req.io, id)`. Joined seats are modelled by `restaurant_tables.parent_table_id` pointing at the parent, with the child mirroring the parent's `current_order_id`/`status`. The **canonical group-release** already used by disjoin and checkout is `SET current_order_id = NULL, parent_table_id = NULL, status = 'available'` — transfer and merge are the outliers that fail to reset all three columns, which is the root of P1-4 and P3-12.

**Tech Stack:** Node + Express 5, `mysql2/promise` pool, Socket.IO for `broadcastTableUpdate`. Tests: **Vitest** + supertest (`npx vitest run <file>`), **never jest** (`npx jest` gives false pool-closed failures). Integration suite: `backend/tests/integration/tables.test.js`, seeded by `backend/tests/fixtures/seed.js` (`seedDatabase()` in `beforeEach` drops+recreates every table, so each test starts clean). `audit_events` columns: `event_type, user_id, manager_id, entity_type, entity_id, old_value, new_value, ip_address, created_at`.

## Global Constraints

- **Failing test FIRST**, then the minimal fix. Prove red → green for every task.
- **Edits are confined to two files:** `backend/routes/pos/tables.js` and `backend/tests/integration/tables.test.js`. No migrations (audit_events + parent_table_id already exist in schema and seed).
- **Audit inserts are transactional.** Capture any snapshot into a handler-scoped local BEFORE the DELETE/UPDATE that destroys it, then insert the `audit_events` row with the same `conn` immediately BEFORE `conn.commit()`. If audit insert fails, the merge/disjoin/delete must roll back too. Do not use background `pool.query(...).catch(...)` audit logging.
- **sendError() sanitizes** any message containing both `table`+`exist`, or `ER_`/`SQLSTATE`/`mysql`, into a generic string. New error strings must avoid those substrings (the plan's disjoin messages use the word "seat", not "table").
- **Seed only defines tables id 1 (`SEED.table`) and id 2 (`SEED.table2`).** Any test needing an empty transfer/merge target inserts a third: `INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')` (section 1 exists; `(section_id, table_number)` is unique so `'3'` is safe).
- **Reuse existing helpers/fixtures verbatim:** `createTableOrder(cookie, tableId, items, subtotal, tax, total)` (returns `invoice_id`), `adminCookie` (all permissions — `canMergeTables`/`canTransferTable` true, bypasses manager PIN), `SEED.product1` (price 5.00, tax 16%), `SEED.product2` (price 2.00, tax 0%), `SEED.adminUser.id`.
- Re-open each cited file before editing — line numbers below are from the 2026-07-04 working tree and may have shifted. Match the quoted BEFORE text, not the line number.
- Verify each task with `npx vitest run backend/tests/integration/tables.test.js` (full file) — not just the single filtered test.

---

### Task 1 — P1-4: Transfer must fully release the source table's joined children

**Finding P1-4** — `backend/routes/pos/tables.js:~290` (transfer branch). Defect: on `action==='transfer'`, the source's joined children are updated with `SET current_order_id = NULL` **only** — `parent_table_id` is left dangling and `status` is left `occupied`/`printed`, producing un-seatable / un-cashable ghost tables that point at the now-available source with no order.

**Product decision (document at top of task):** a transfer moves ONE table's order to an empty target. The source's *joined group* does not travel with it. The safe, canonical resolution — matching disjoin and checkout — is to **fully release** the source's children (free them to `available`, un-parented). (The alternative, re-parenting the whole group onto the target, is a larger UX change and is explicitly NOT chosen here.)

**Files:** `backend/routes/pos/tables.js`, `backend/tests/integration/tables.test.js`.

- [ ] **Step 1 — write the FULL failing test.** In `tables.test.js`, inside `describe('Table Operations (Transfer, Swap, Merge, Join, Disjoin, Redirection)', ...)`, add:
```javascript
        it('P1-4: transfer fully releases the source table joined children (no ghost occupied)', async () => {
            // empty transfer target (seed only ships tables 1 & 2)
            await pool.query("INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')");

            // order on source T1
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            // join T2 as a child of T1 (mirrors T1's order + occupied status)
            const joinRes = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });
            expect(joinRes.statusCode).toBe(200);

            // transfer T1 -> empty T3
            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send({ sourceTableId: SEED.table.id, targetTableId: 3, action: 'transfer' });
            expect(res.statusCode).toBe(200);

            // order moved to T3
            const [[t3]] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = 3");
            expect(t3.status).toBe('occupied');
            expect(t3.current_order_id).toBe(invoiceId);
            const [[ord]] = await pool.query("SELECT table_id FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(ord.table_id).toBe(3);

            // source T1 released
            const [[t1]] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1.status).toBe('available');
            expect(t1.current_order_id).toBeNull();

            // child T2 FULLY released — never a ghost (occupied with null order + dangling parent)
            const [[t2]] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2.status).toBe('available');
            expect(t2.current_order_id).toBeNull();
            expect(t2.parent_table_id).toBeNull();
        });
```

- [ ] **Step 2 — run, expect FAIL.** `npx vitest run backend/tests/integration/tables.test.js -t "P1-4"` → FAILS: pre-fix T2 keeps `status='occupied'` and `parent_table_id=1`, so `expect(t2.status).toBe('available')` and `expect(t2.parent_table_id).toBeNull()` fail (received `'occupied'` / `1`).

- [ ] **Step 3 — minimal fix (3 edits: declare → capture+release → broadcast).**

  **(3a) Declare a holder** at the top of the transfer handler's `try`, immediately after `await conn.beginTransaction();`:
```javascript
        // Ids of the source table's joined children, captured before we release them
        // (3b) so the floor plan updates live for every client after commit (3c).
        let transferFreedChildIds = [];
```

  **(3b) Capture-then-release** — in the `transfer` branch, replace the source child-release line.
  BEFORE:
```javascript
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL WHERE parent_table_id = ?", [sourceTableId]);
```
  AFTER (capture the children BEFORE nulling their `parent_table_id`, then FULLY release them):
```javascript
            const [freedChildRows] = await conn.execute("SELECT id FROM restaurant_tables WHERE parent_table_id = ?", [sourceTableId]);
            transferFreedChildIds = freedChildRows.map(r => r.id);
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL, parent_table_id = NULL, status = 'available' WHERE parent_table_id = ?", [sourceTableId]);
```

  **(3c) Broadcast after commit** — in the post-commit `if (req.io) { ... }` block (the one that already broadcasts `sourceTableId`, `targetTableId`, and the `srcChildren`/`tgtChildren` loops), append after the existing `srcChildren` loop:
```javascript
            // Push the children we just detached from the source join. Their
            // parent_table_id is now NULL, so the srcChildren query in this block no
            // longer returns them — without this they stay 'occupied' on other
            // clients until a manual floor-plan refresh.
            for (const id of transferFreedChildIds) {
                broadcastTableUpdate(req.io, id);
            }
```
  (Leave the preceding target-side child re-parent line — `... WHERE parent_table_id = ?`, `[..., targetTableId]` — untouched; a valid transfer target is empty so it is a harmless no-op.)

- [ ] **Step 4 — run, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "P1-4"` → green.

- [ ] **Step 5 — full-file regression.** `npx vitest run backend/tests/integration/tables.test.js` → all green (the existing childless transfer/swap tests are unaffected: the UPDATE matches 0 rows when there are no children).

- [ ] **Step 6 — commit.**
```
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(tables): transfer fully releases source joined children (no ghost occupied)"
```

**Broadcast note:** Step 3c closes the socket-staleness gap this fix would otherwise open. Because the release nulls `parent_table_id`, the post-commit `srcChildren` query no longer returns the freed children, so they are broadcast explicitly from `transferFreedChildIds` — the floor plan clears them live for every client instead of leaving them 'occupied' until a manual refresh. The Step-1 integration test asserts the DB end-state only (a socket emit isn't observable through `supertest`); verify the live push once manually by transferring a joined table with two register clients open — the released child clears on the floor plan without a refresh.

---

### Task 2 — P2-5: Merge must write a durable `table_merge` audit event before hard-deleting the source order

**Finding P2-5** — `backend/routes/pos/tables.js:~418-419` (merge branch). Defect: merge moves the source order's items into the target then hard-`DELETE`s `order_items` + `orders` for the source, leaving only a free-text `logger.info` (`~L431`). `recomputeOrderTotals` restamps tax so the pre-merge state is unrecoverable, and cross-waiter PIN overrides are not persisted with order context.

**Files:** `backend/routes/pos/tables.js`, `backend/tests/integration/tables.test.js`.

**Interfaces** — the audit row (mirrors the existing `void_item` insert at `tables.js:~1274`):
```
event_type  = 'table_merge'
entity_type = 'order'
entity_id   = <source invoice_id>           // the order being destroyed
old_value   = { items:[{product_id,item_name,quantity,price_at_sale,tax_amount}], subtotal, tax, total, waiter_id }
new_value   = { target_invoice_id, source_table_id, target_table_id }
ip_address  = req.ip || null
user_id     = req.user.id
```

- [ ] **Step 1 — write the FULL failing test.** Add inside the same `describe('Table Operations ...')`:
```javascript
        it('P2-5: merge writes a table_merge audit event snapshotting the deleted source order', async () => {
            // source order with 2+ items so the snapshot array is non-trivial
            const sourceInvoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product2.id, qty: 1, price: SEED.product2.price }
                ],
                7.00, 0.80, 7.80
            );
            const targetInvoiceId = await createTableOrder(
                adminCookie, SEED.table2.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send({ sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge' });
            expect(res.statusCode).toBe(200);

            // transactional audit insert is visible after the response
            await new Promise(resolve => setTimeout(resolve, 50));

            const [events] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'table_merge' AND entity_id = ? ORDER BY id DESC",
                [sourceInvoiceId]
            );
            expect(events.length).toBeGreaterThan(0);

            const ev = events[0];
            expect(ev.user_id).toBe(SEED.adminUser.id);
            expect(ev.entity_type).toBe('order');

            const oldVal = JSON.parse(ev.old_value);
            const newVal = JSON.parse(ev.new_value);
            expect(Array.isArray(oldVal.items)).toBe(true);
            expect(oldVal.items.length).toBeGreaterThanOrEqual(2);
            const burgerLine = oldVal.items.find(i => i.product_id === SEED.product1.id);
            expect(burgerLine).toBeDefined();
            expect(Number(burgerLine.quantity)).toBe(1);
            expect(newVal.target_invoice_id).toBe(targetInvoiceId);
            expect(newVal.source_table_id).toBe(SEED.table.id);
            expect(newVal.target_table_id).toBe(SEED.table2.id);
        });
```

- [ ] **Step 2 — run, expect FAIL.** `npx vitest run backend/tests/integration/tables.test.js -t "P2-5"` → FAILS: no `table_merge` row exists, so `expect(events.length).toBeGreaterThan(0)` fails (received `0`).

- [ ] **Step 3 — minimal fix (three edits in the transfer handler).**

  **3a. Declare the snapshot local at the top of the try.**
  BEFORE:
```javascript
        await conn.beginTransaction();
```
  AFTER:
```javascript
        await conn.beginTransaction();
        let mergeAuditSnapshot = null;
```

  **3b. Snapshot the source order immediately BEFORE it is deleted** (merge branch; `sourceItems` was already fetched earlier in this branch).
  BEFORE:
```javascript
            // Void/Delete source order items and source order
            await conn.execute("DELETE FROM order_items WHERE invoice_id = ?", [sourceTable.current_order_id]);
            await conn.execute("DELETE FROM orders WHERE invoice_id = ?", [sourceTable.current_order_id]);
```
  AFTER:
```javascript
            // Snapshot the source order BEFORE it is destroyed, for a durable merge audit trail.
            const [[sourceOrderForAudit]] = await conn.execute(
                "SELECT subtotal, tax, total, waiter_id FROM orders WHERE invoice_id = ?",
                [sourceTable.current_order_id]
            );
            mergeAuditSnapshot = {
                sourceInvoiceId: sourceTable.current_order_id,
                items: sourceItems.map(i => ({
                    product_id: i.product_id,
                    item_name: i.item_name,
                    quantity: i.quantity,
                    price_at_sale: i.price_at_sale,
                    tax_amount: i.tax_amount,
                })),
                subtotal: sourceOrderForAudit?.subtotal ?? null,
                tax: sourceOrderForAudit?.tax ?? null,
                total: sourceOrderForAudit?.total ?? null,
                waiter_id: sourceOrderForAudit?.waiter_id ?? null,
                targetInvoiceId: targetTable.current_order_id,
                sourceTableId: Number(sourceTableId),
                targetTableId: Number(targetTableId),
            };

            // Void/Delete source order items and source order
            await conn.execute("DELETE FROM order_items WHERE invoice_id = ?", [sourceTable.current_order_id]);
            await conn.execute("DELETE FROM orders WHERE invoice_id = ?", [sourceTable.current_order_id]);
```

  **3c. Insert the audit row transactionally before commit** (immediately before `await conn.commit();`, after the destructive work).
  BEFORE:
```javascript
        await conn.commit();

        if (req.io) {
```
  AFTER:
```javascript
        // Durable merge audit; same transaction as the source-order delete.
        if (mergeAuditSnapshot) {
            await conn.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ('table_merge', ?, 'order', ?, ?, ?, ?)`,
                [
                    req.user.id,
                    mergeAuditSnapshot.sourceInvoiceId,
                    JSON.stringify({
                        items: mergeAuditSnapshot.items,
                        subtotal: mergeAuditSnapshot.subtotal,
                        tax: mergeAuditSnapshot.tax,
                        total: mergeAuditSnapshot.total,
                        waiter_id: mergeAuditSnapshot.waiter_id,
                    }),
                    JSON.stringify({
                        target_invoice_id: mergeAuditSnapshot.targetInvoiceId,
                        source_table_id: mergeAuditSnapshot.sourceTableId,
                        target_table_id: mergeAuditSnapshot.targetTableId,
                    }),
                    req.ip || null,
                ]
            );
        }

        await conn.commit();

        if (req.io) {
```

- [ ] **Step 4 — run, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "P2-5"` → green.

- [ ] **Step 5 — full-file regression.** `npx vitest run backend/tests/integration/tables.test.js` → all green. Include an audit-insert-failure rollback test if touching this task after the 2026-07-04 audit-policy update.

- [ ] **Step 6 — commit.**
```
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "feat(tables): durable table_merge audit event before source order delete"
```

---

### Task 3 — P3-12: Merge must clear `parent_table_id` on released source children

**Finding P3-12** — `backend/routes/pos/tables.js:~426` (merge branch). Defect: the merge child-release UPDATE sets `current_order_id = NULL, status = 'available'` but leaves `parent_table_id` pointing at the (now available) source, so the freed seat still renders a phantom "Joined" badge. Same class as P1-4 but in the merge path.

> **Sequencing:** run Task 3 AFTER Task 2 — both edit the merge branch. Task 2 touches the pre-DELETE region and the post-commit block; Task 3 touches the single child-release UPDATE two lines below the DELETE. They do not overlap, but re-open the file and match the BEFORE text exactly.

**Files:** `backend/routes/pos/tables.js`, `backend/tests/integration/tables.test.js`.

- [ ] **Step 1 — write the FULL failing test.** Add inside the same `describe('Table Operations ...')`:
```javascript
        it('P3-12: merge clears parent_table_id on released source children (no phantom Joined badge)', async () => {
            // empty merge target
            await pool.query("INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')");

            // source order on T1
            await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            // target order on T3 (merge requires an occupied target)
            await createTableOrder(
                adminCookie, 3,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            // join T2 as a child of the source T1
            const joinRes = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });
            expect(joinRes.statusCode).toBe(200);

            // merge source T1 -> target T3
            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send({ sourceTableId: SEED.table.id, targetTableId: 3, action: 'merge' });
            expect(res.statusCode).toBe(200);

            // child T2 fully released — parent link cleared
            const [[t2]] = await pool.query(
                "SELECT parent_table_id, status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(t2.parent_table_id).toBeNull();
            expect(t2.status).toBe('available');
            expect(t2.current_order_id).toBeNull();
        });
```

- [ ] **Step 2 — run, expect FAIL.** `npx vitest run backend/tests/integration/tables.test.js -t "P3-12"` → FAILS: pre-fix T2 keeps `parent_table_id=1`, so `expect(t2.parent_table_id).toBeNull()` fails (received `1`).

- [ ] **Step 3 — minimal fix (3 edits: declare → capture+release → broadcast, mirroring Task 1).** Self-contained: does NOT depend on Task 1's `transferFreedChildIds` (transfer and merge are mutually-exclusive branches of the same handler, so a separate holder + loop is robust to task ordering).

  **(3a) Declare a holder** at the top of the transfer handler's `try`, immediately after `await conn.beginTransaction();` (a second line alongside Task 1's `transferFreedChildIds`):
```javascript
        // Merge-branch equivalent of Task 1's holder: capture the source's joined
        // children before we clear their parent link so they broadcast live after commit.
        let mergeReleasedChildIds = [];
```

  **(3b) Capture-then-release** — in the `merge` branch, replace the source child-release line.
  BEFORE:
```javascript
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL, status = 'available' WHERE parent_table_id = ?", [sourceTableId]);
```
  AFTER (capture BEFORE nulling `parent_table_id`, then clear all three columns):
```javascript
            const [mergedChildRows] = await conn.execute("SELECT id FROM restaurant_tables WHERE parent_table_id = ?", [sourceTableId]);
            mergeReleasedChildIds = mergedChildRows.map(r => r.id);
            await conn.execute("UPDATE restaurant_tables SET current_order_id = NULL, parent_table_id = NULL, status = 'available' WHERE parent_table_id = ?", [sourceTableId]);
```

  **(3c) Broadcast after commit** — in the same post-commit `if (req.io) { ... }` block, append after Task 1's `transferFreedChildIds` loop (or after the `srcChildren` loop if Task 1 is not yet merged):
```javascript
            // Push the children we just detached from the source join on merge. Their
            // parent_table_id is now NULL, so the srcChildren query in this block no
            // longer returns them — without this they keep a phantom 'Joined' badge on
            // other clients until a manual floor-plan refresh.
            for (const id of mergeReleasedChildIds) {
                broadcastTableUpdate(req.io, id);
            }
```

- [ ] **Step 4 — run, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "P3-12"` → green.

- [ ] **Step 5 — full-file regression.** `npx vitest run backend/tests/integration/tables.test.js` → all green (existing childless merge tests match 0 rows).

- [ ] **Step 6 — commit.**
```
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(tables): merge clears parent_table_id + re-broadcasts released source children"
```

**Broadcast note:** Step 3c closes the socket-staleness gap the `parent_table_id=NULL` change would otherwise open — the merge post-commit `srcChildren` query no longer returns the freed children, so they are broadcast explicitly from `mergeReleasedChildIds` (mirrors Task 1's 3c). No phantom 'Joined' badge lingers on other clients. As in Task 1, the integration test asserts the DB end-state only; verify the live push once manually with two register clients open.

---

### Task 4 — P2-4: Disjoin must only release genuine joined children (and audit them)

**Finding P2-4** — `backend/routes/pos/tables.js:~557-563` (disjoin handler). Defect: the loop blindly runs `SET parent_table_id = NULL, current_order_id = NULL, status = 'available'` for every client-supplied id with NO check that the row is an actual joined child (`parent_table_id IS NOT NULL`) and NO occupancy guard, never settling the `orders` row. A crafted/stale request passing a standalone occupied table's id (or a parent id) frees that seat while its unpaid_table order survives referenced by no table (un-locatable by the reopen lookup) and the seat can be re-seated bypassing payment. Join already guards occupancy; disjoin is the asymmetric outlier. Also, disjoin writes no audit row.

**Files:** `backend/routes/pos/tables.js`, `backend/tests/integration/tables.test.js`.

**Interfaces** — the audit row:
```
event_type  = 'table_disjoin'
entity_type = 'table'
entity_id   = <parent_table_id of the first released child>
old_value   = { children:[{id,parent_table_id,current_order_id,status}] }   // pre-release state
new_value   = { separated_ids:[<child ids>] }
ip_address  = req.ip || null
user_id     = req.user.id
```
Rejection messages avoid the sendError trigger substrings by using "seat" (not "table") and never `exist`.

- [ ] **Step 1 — write the FULL failing tests.** Add a new `describe` block inside the top-level suite (next to the other table-op describes):
```javascript
    describe('Disjoin guard (P2-4)', () => {
        it('rejects disjoining a standalone (non-child) seat and leaves it untouched', async () => {
            // Seat a standalone table — parent_table_id IS NULL, has an open order.
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({ tableIds: [SEED.table.id] });

            expect(res.statusCode).toBeGreaterThanOrEqual(400);
            expect(res.statusCode).toBeLessThan(500);
            expect(res.body.success).toBe(false);

            // Untouched: still occupied, order still referenced (not orphaned).
            const [[t1]] = await pool.query(
                "SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            expect(t1.status).toBe('occupied');
            expect(t1.current_order_id).toBe(invoiceId);
            expect(t1.parent_table_id).toBeNull();
        });

        it('releases a genuine joined child and writes a table_disjoin audit event', async () => {
            // Join T2 as a child of T1 (parent has no order — child mirrors available/null).
            const joinRes = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });
            expect(joinRes.statusCode).toBe(200);

            const res = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({ tableIds: [SEED.table2.id] });
            expect(res.statusCode).toBe(200);

            const [[t2]] = await pool.query(
                "SELECT parent_table_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(t2.parent_table_id).toBeNull();

            // transactional audit insert is visible after the response
            await new Promise(resolve => setTimeout(resolve, 50));
            const [events] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'table_disjoin' AND entity_id = ? ORDER BY id DESC",
                [SEED.table.id]
            );
            expect(events.length).toBeGreaterThan(0);
            const ev = events[0];
            expect(ev.user_id).toBe(SEED.adminUser.id);
            const newVal = JSON.parse(ev.new_value);
            expect(newVal.separated_ids).toContain(SEED.table2.id);
        });
    });
```

- [ ] **Step 2 — run, expect FAIL.** `npx vitest run backend/tests/integration/tables.test.js -t "P2-4"` → FAILS on both: the standalone-seat request currently returns `200` and frees T1 (so `toBeGreaterThanOrEqual(400)` and `status==='occupied'` fail); the positive case releases T2 but writes no audit row (`events.length` is `0`).

- [ ] **Step 3 — minimal fix (two edits in the disjoin handler).**

  **3a. Guard the loop — only genuine joined children may be released.**
  BEFORE:
```javascript
        // 2. Disjoin tables
        for (const tableId of tableIds) {
            await conn.execute(
                "UPDATE restaurant_tables SET parent_table_id = NULL, current_order_id = NULL, status = 'available' WHERE id = ?",
                [tableId]
            );
        }
```
  AFTER:
```javascript
        // 2. Disjoin tables — only genuine joined children (parent_table_id set) may be
        //    released. A standalone/parent seat must never be silently freed: that would
        //    orphan its open unpaid order (referenced by no seat) and let the seat be
        //    re-used without payment.
        const disjoinedChildren = [];
        for (const tableId of tableIds) {
            const [[childRow]] = await conn.execute(
                "SELECT id, parent_table_id, current_order_id, status FROM restaurant_tables WHERE id = ? FOR UPDATE",
                [tableId]
            );
            if (!childRow) {
                await conn.rollback();
                return sendError(res, 404, "Seat not found.");
            }
            if (childRow.parent_table_id == null) {
                await conn.rollback();
                return sendError(res, 400, "Selected seat is not a joined child and cannot be separated.");
            }
            disjoinedChildren.push({
                id: childRow.id,
                parent_table_id: childRow.parent_table_id,
                current_order_id: childRow.current_order_id,
                status: childRow.status,
            });
            await conn.execute(
                "UPDATE restaurant_tables SET parent_table_id = NULL, current_order_id = NULL, status = 'available' WHERE id = ?",
                [tableId]
            );
        }
```

  **3b. Insert the audit row transactionally before commit.**
  BEFORE:
```javascript
        await conn.commit();

        if (req.io) {
            for (const tableId of tableIds) {
                broadcastTableUpdate(req.io, tableId);
            }
        }
```
  AFTER:
```javascript
        // Durable disjoin audit; same transaction as the child release.
        if (disjoinedChildren.length > 0) {
            await conn.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ('table_disjoin', ?, 'table', ?, ?, ?, ?)`,
                [
                    req.user.id,
                    disjoinedChildren[0].parent_table_id,
                    JSON.stringify({ children: disjoinedChildren }),
                    JSON.stringify({ separated_ids: disjoinedChildren.map(c => c.id) }),
                    req.ip || null,
                ]
            );
        }

        await conn.commit();

        if (req.io) {
            for (const tableId of tableIds) {
                broadcastTableUpdate(req.io, tableId);
            }
        }
```

- [ ] **Step 4 — run, expect PASS.** `npx vitest run backend/tests/integration/tables.test.js -t "P2-4"` → both green.

- [ ] **Step 5 — full-file regression.** `npx vitest run backend/tests/integration/tables.test.js` → all green. In particular the existing `'should successfully join and disjoin child tables'` test still passes: T2 is joined (`parent_table_id=1`) before disjoin, so it clears the guard and is released.

- [ ] **Step 6 — commit.**
```
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(tables): disjoin only releases real joined children + adds table_disjoin audit"
```

---

## Self-Review

- **Red before green, real code, no placeholders.** Each task ships a full failing test, an exact BEFORE→AFTER edit, and the precise `-t` filter plus full-file command. All four fixes touch only the two named files.
- **Consistency with the canonical group-release.** Transfer (Task 1) and merge (Task 3) now use the same three-column reset (`current_order_id`, `parent_table_id`, `status`) that disjoin and checkout already use — the outliers are aligned, eliminating both ghost-occupied (P1-4) and phantom-joined (P3-12) states.
- **Audit pattern fidelity.** Tasks 2 & 4 follow the current destructive-audit invariant: snapshot captured into a handler-scoped local BEFORE the destructive statement, `await conn.query(...)` inserts `audit_events` immediately BEFORE `conn.commit()`, and audit failure rolls back the business mutation. No background audit writes after commit.
- **sendError safety.** New disjoin messages ("Seat not found.", "Selected seat is not a joined child and cannot be separated.") contain neither `table`+`exist` nor `ER_`/`SQLSTATE`/`mysql`, so they survive the sanitizer intact and assertions on `res.body.success === false` hold.
- **Guard correctness.** `childRow.parent_table_id == null` matches SQL NULL (and only NULL — table ids are always ≥ 1, never 0), so standalone/parent seats are rejected while true children pass. Rollback-on-first-offender means a mixed/crafted batch leaves the DB untouched.
- **Real-time child broadcast (implemented, both paths):** Task 1 (transfer) and Task 3 (merge) each capture the source's joined child ids BEFORE clearing `parent_table_id` and re-broadcast them after commit (Step 3c), so freed seats clear on the floor plan live for every client — no reliance on the next `get_tables`. The socket emit itself isn't asserted through `supertest` (DB end-state is); a two-client manual check is noted in each task.
- **Not in scope (owner decisions / other findings):** re-parenting the whole group onto the transfer target (P1-4 alternative, rejected); settling vs. voiding an orphaned order discovered during disjoin (guard prevents creating one; remediating pre-existing orphans is separate). Real-time per-child broadcast on transfer is now IN scope and implemented (Step 3c of Task 1).

## Cross-plan file overlap

- **This plan edits only `backend/routes/pos/tables.js` (structural-op routes ~L227-583) and `backend/tests/integration/tables.test.js`.** Plans 1, 2, 6, 7 also edit `tables.js` but in the `table_order` POST handler (~L807+) and void/print/permission regions — far from the transfer/join/disjoin routes here — so cross-plan merge conflicts are unlikely. The executor must still re-run `npx vitest run backend/tests/integration/tables.test.js` after each task in every plan to catch any interaction.
- **Intra-plan adjacency:** Tasks 2 and 3 both live in the merge branch (Task 2: top-of-try local + pre-DELETE snapshot + transactional audit insert; Task 3: the single child-release UPDATE two lines below the DELETE). They do not share lines. Run in listed order (1 → 2 → 3 → 4) and match the quoted BEFORE text rather than the line number, since earlier tasks shift line numbers.
- **Shared test seed:** every task that needs an empty target inserts `restaurant_tables` id 3 within its own test; because `seedDatabase()` runs in `beforeEach` and drops/recreates all tables, there is no cross-test residue.
