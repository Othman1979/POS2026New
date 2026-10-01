# Service-Charge Merge/Void Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Table merges keep exactly one service-charge fee (re-homed or recomputed, never doubled, never blocked) and voids/merges never strand a bound snapshot in `open_order`.

**Architecture:** Ownership-aware snapshot primitives (`abandonOpenOrder`, `rehomeOpenOrder`, and the existing `touchOpenOrder`) feed two route changes inside existing transactions. Empty-cart voids retain an audit-safe FK while transitioning the snapshot, reference-aware cleanup preserves that row, and merges apply a four-case disposition matrix, version bump, financially exact item identity, and full canonical fee restamp before totals are recomputed.

**Tech Stack:** Node.js/CommonJS, Express, MySQL/InnoDB (MariaDB syntax), Vitest 4.

**Spec:** `docs/superpowers/specs/2026-07-11-service-charge-merge-void-reconciliation-design.md` — read it first.

## Global Constraints

- Work on a branch from current `master` (service-charge canonicalization is merged; verify `backend/services/ServiceChargeSnapshotService.js` exists).
- Vitest execution rule (owner-mandated): run ONLY the named focused test files per step; never run the complete suite mid-plan; run `npx vitest run` exactly ONCE in Final Verification; never start a second Vitest process while one is active (shared `posapp_test`); use a progress-visible reporter and say what is running.
- Owner policy: on merge, keep ONE fee — never doubled, never blocked; when both orders are bound, the target's snapshot and frozen rate win.
- The fee survives whenever either side had a fee row; it never doubles.
- Snapshot columns on `orders` and `held_orders` have real foreign keys created by `apply-service-charge-snapshots.js`. A voided order intentionally retains its FK for audit; cleanup must never delete a referenced snapshot.
- All snapshot work happens inside the existing route transactions, before the source order row is deleted (merge) or before commit (void), so failures roll back cleanly.
- Reject `sourceTableId === targetTableId` before opening a table-action transaction.
- Target-owned surviving snapshots must be holder-validated and version-bumped so stale pre-merge carts fail closed.
- Normal order-item rows may quantity-merge only when their complete persisted financial identity matches. The target order's existing order-level discount continues to win; source order-level discounts are not imported.
- Do not change split, transfer, swap, disjoin, refund, or paid-order flows.
- Stage only files named by the current task; never `git add -A`.

---

## File Structure

**Modify:**

- `backend/services/ServiceChargeSnapshotService.js` — `ALLOWED`, ownership-aware abandon/rehome primitives, and reference-aware cleanup.
- `backend/services/ServiceChargeCalculator.js` — export `canonicalName` (already defined internally).
- `backend/routes/pos/tables.js` — void abandonment (empty-cart block ~line 1120) and merge disposition (merge branch ~lines 356-475).
- `backend/tests/unit/serviceChargeSnapshotService.test.js` — primitive contract tests.
- `backend/tests/integration/serviceChargeSnapshots.test.js` — void + merge matrix tests.

---

## Task 1: Snapshot ownership and cleanup primitives

**Files:**

- Modify: `backend/services/ServiceChargeSnapshotService.js`
- Test: `backend/tests/unit/serviceChargeSnapshotService.test.js`

**Interfaces:**

- Produces `rehomeOpenOrder(conn, { snapshotId, version, fromOrderId, toOrderId }) -> newVersion` — holder swap under version-CAS, state stays `open_order`; throws the standard 409 `conflict` on any mismatch.
- Produces `abandonOpenOrder(conn, { snapshotId, version, orderId }) -> newVersion` — `open_order -> abandoned` under a CAS that includes the old `holder_type='order'` and `holder_id=orderId`.
- Changes `cleanupExpiredDrafts(conn, now)` so no eligible draft/abandoned/claimed row is deleted while `orders`, `held_orders`, or a child snapshot references it.
- Produces `ALLOWED` containing `'open_order:abandoned'` so `transition(conn, { from: 'open_order', to: 'abandoned', holderType: 'none', holderId: null })` succeeds.

- [ ] **Step 1: Write the failing unit tests**

Append inside the existing `describe('ServiceChargeSnapshotService', ...)` block in `backend/tests/unit/serviceChargeSnapshotService.test.js`, using the file's existing `connection(...)` mocked-conn helper:

```javascript
    it('rehomes an open-order snapshot to a new order under version CAS', async () => {
        const conn = connection([{ affectedRows: 1 }]);

        const next = await service.rehomeOpenOrder(conn, {
            snapshotId: 'snap-1', version: 4, fromOrderId: 101, toOrderId: 202
        });

        expect(next).toBe(5);
        const [sql, params] = conn.query.mock.calls[0];
        expect(sql).toContain("state='open_order'");
        expect(sql).toContain('version=version+1');
        expect(params).toEqual(['202', 'snap-1', '101', 4]);
    });

    it('rejects a rehome when version or holder does not match', async () => {
        const conn = connection([{ affectedRows: 0 }]);

        await expect(service.rehomeOpenOrder(conn, {
            snapshotId: 'snap-1', version: 3, fromOrderId: 101, toOrderId: 202
        })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('abandons an open-order snapshot only for its owning order', async () => {
        const conn = connection([{ affectedRows: 1 }]);

        const next = await service.abandonOpenOrder(conn, {
            snapshotId: 'snap-1', version: 4, orderId: 101
        });

        expect(next).toBe(5);
        const [sql, params] = conn.query.mock.calls[0];
        expect(sql).toContain("state='open_order'");
        expect(sql).toContain("holder_type='order'");
        expect(sql).toContain('holder_id=?');
        expect(params).toEqual(['snap-1', '101', 4]);
    });

    it('rejects open-order abandonment for a stale version or wrong holder', async () => {
        const conn = connection([{ affectedRows: 0 }]);

        await expect(service.abandonOpenOrder(conn, {
            snapshotId: 'snap-1', version: 3, orderId: 999
        })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('allows the open_order -> abandoned transition', async () => {
        const conn = connection([{ affectedRows: 1 }]);

        const next = await service.transition(conn, {
            snapshotId: 'snap-1', version: 2, from: 'open_order', to: 'abandoned',
            holderType: 'none', holderId: null
        });

        expect(next).toBe(3);
    });

    it('still rejects finalized -> abandoned without touching the database', async () => {
        const conn = connection([]);

        await expect(service.transition(conn, {
            snapshotId: 'snap-1', version: 2, from: 'finalized', to: 'abandoned',
            holderType: 'none', holderId: null
        })).rejects.toMatchObject({ statusCode: 409 });
        expect(conn.query).not.toHaveBeenCalled();
    });

    it('cleanup preserves abandoned snapshots referenced by financial records', async () => {
        const conn = connection([{ affectedRows: 0 }]);
        const now = new Date('2026-07-11T12:00:00.000Z');

        await service.cleanupExpiredDrafts(conn, now);

        const [sql, params] = conn.query.mock.calls[0];
        expect(sql).toContain('LEFT JOIN orders');
        expect(sql).toContain('LEFT JOIN held_orders');
        expect(sql).toContain('LEFT JOIN service_charge_snapshots child');
        expect(sql).toContain('parent_snapshot_id');
        expect(params).toEqual([now, now, now]);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run backend/tests/unit/serviceChargeSnapshotService.test.js --reporter=verbose`
Expected: the new rehome/abandon/cleanup tests FAIL for the missing primitives and missing reference guards; the existing disallowed-transition test remains green.

- [ ] **Step 3: Implement the primitives**

In `backend/services/ServiceChargeSnapshotService.js`:

Change the `ALLOWED` set (add the last line before the closing bracket):

```javascript
const ALLOWED = new Set([
    'draft:open_order', 'draft:held', 'draft:finalized', 'draft:abandoned',
    'open_order:finalized', 'open_order:split_parent', 'open_order:abandoned',
    'held:claimed', 'held:finalized',
    'claimed:held', 'claimed:finalized', 'claimed:abandoned'
]);
```

Add directly below the existing `touchOpenOrder` function (same shape — it is the sibling primitive):

```javascript
// Holder swap for a table merge: the snapshot follows its fee to the surviving order.
// State stays 'open_order'; only holder_id changes, under the same version CAS as
// touchOpenOrder so a concurrent save/settle on either order rolls the merge back.
const rehomeOpenOrder = async (conn, { snapshotId, version, fromOrderId, toOrderId }) => {
    const [result] = await conn.query(`
        UPDATE service_charge_snapshots
           SET holder_id=?, version=version+1
         WHERE id=? AND state='open_order'
           AND holder_type='order' AND holder_id=? AND version=?
    `, [String(toOrderId), snapshotId, String(fromOrderId), version]);
    if (result.affectedRows !== 1) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return Number(version) + 1;
};

// Ownership-aware terminal transition for void/merge. Including the old holder in
// the UPDATE predicate prevents a stale/dangling order FK from abandoning another
// order's snapshot.
const abandonOpenOrder = async (conn, { snapshotId, version, orderId }) => {
    const [result] = await conn.query(`
        UPDATE service_charge_snapshots
           SET state='abandoned', holder_type='none', holder_id=NULL,
               claim_token_hash=NULL, version=version+1
         WHERE id=? AND state='open_order'
           AND holder_type='order' AND holder_id=? AND version=?
    `, [snapshotId, String(orderId), version]);
    if (result.affectedRows !== 1) {
        throw conflict('Service-charge snapshot changed. Refresh and try again.');
    }
    return Number(version) + 1;
};
```

Replace `cleanupExpiredDrafts` with a multi-table-safe delete. Apply the reference
guards to every eligible state: drafts and idle claims should not be bound, but a
corrupted reference must be preserved rather than turn all future draft creation into
a foreign-key failure:

```javascript
const cleanupExpiredDrafts = (conn, now = new Date()) => conn.query(`
    DELETE scs
      FROM service_charge_snapshots scs
      LEFT JOIN orders o
        ON o.service_charge_snapshot_id=scs.id
      LEFT JOIN held_orders h
        ON h.service_charge_snapshot_id=scs.id
      LEFT JOIN service_charge_snapshots child
        ON child.parent_snapshot_id=scs.id
     WHERE (
            (scs.state='draft' AND scs.expires_at < ?)
         OR (
            scs.state='abandoned'
            AND scs.updated_at < DATE_SUB(?, INTERVAL 1 DAY)
         )
         OR (scs.state='claimed' AND scs.updated_at < DATE_SUB(?, INTERVAL 7 DAY))
     )
       AND o.invoice_id IS NULL
       AND h.id IS NULL
       AND child.id IS NULL
`, [now, now, now]);
```

Add `rehomeOpenOrder` and `abandonOpenOrder` to `module.exports` next to
`touchOpenOrder`.

In `backend/services/ServiceChargeCalculator.js`, add `canonicalName` to `module.exports` (it is already defined at the top of the file; Task 3 consumes it):

```javascript
module.exports = {
    SERVICE_NOTE,
    canonicalName,
    serviceChargeBase,
    serviceChargeFee,
    canonicalizeServiceCharge,
    allocateServiceChargeCents
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run backend/tests/unit/serviceChargeSnapshotService.test.js backend/tests/unit/serviceChargeCalculator.test.js --reporter=verbose`
Expected: PASS, zero failures (calculator suite proves the export change broke nothing).

- [ ] **Step 5: Commit**

```bash
git add backend/services/ServiceChargeSnapshotService.js backend/services/ServiceChargeCalculator.js backend/tests/unit/serviceChargeSnapshotService.test.js
git commit -m "feat(pos): add snapshot rehome and open-order abandonment primitives"
```

---

## Task 2: Void/release abandons the bound snapshot

**Files:**

- Modify: `backend/routes/pos/tables.js` (empty-cart void block, inside `POST /table_order`, ~lines 1120-1179)
- Test: `backend/tests/integration/serviceChargeSnapshots.test.js`

**Interfaces:**

- Consumes Task 1 `abandonOpenOrder`; extend the existing snapshot-service import in `tables.js`.
- Keeps `orders.service_charge_snapshot_id` as an intentional audit FK. Task 1 cleanup must preserve it.
- No API contract change: void request/response unchanged.

- [ ] **Step 1: Write the failing integration test**

Append inside the existing `describe('service-charge snapshots', ...)` in `backend/tests/integration/serviceChargeSnapshots.test.js` (it already has `enable(...)` and admin-cookie helpers):

```javascript
    it('abandons the bound snapshot when a fee-bearing table is voided', async () => {
        await enable('10', '5');
        const draft = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
        const save = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.5, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: draft.id, version: draft.version },
            subtotal: 5.5, tax: 0.83, total: 6.33
        });
        expect(save.statusCode).toBe(200);

        const voidRes = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table.id,
            cart: [],
            void_reason: 'test void'
        });
        expect(voidRes.statusCode).toBe(200);

        const [[snap]] = await pool.query('SELECT state, holder_type, holder_id FROM service_charge_snapshots WHERE id=?', [draft.id]);
        expect(snap).toMatchObject({ state: 'abandoned', holder_type: 'none' });
        expect(snap.holder_id).toBeNull();
        const [[order]] = await pool.query('SELECT payment_method, service_charge_snapshot_id FROM orders WHERE invoice_id=?', [save.body.invoice_id]);
        expect(order).toMatchObject({
            payment_method: 'voided',
            service_charge_snapshot_id: draft.id
        });

        // Age the abandoned row, then trigger cleanup through normal draft creation.
        // The FK-bound audit snapshot must survive and cleanup must not make draft
        // creation fail with ER_ROW_IS_REFERENCED.
        await pool.query(
            "UPDATE service_charge_snapshots SET updated_at=DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE id=?",
            [draft.id]
        );
        const nextDraft = await request(app).post('/api/pos/service_charge_snapshots')
            .set('Cookie', adminCookie).send({});
        expect(nextDraft.statusCode).toBe(200);
        const [[retained]] = await pool.query(
            'SELECT COUNT(*) AS count FROM service_charge_snapshots WHERE id=?',
            [draft.id]
        );
        expect(Number(retained.count)).toBe(1);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js --reporter=verbose`
Expected: the new test FAILS — snapshot state is still `'open_order'` after the void.

- [ ] **Step 3: Implement the void abandonment**

In `backend/routes/pos/tables.js`, inside the empty-cart void block, directly AFTER the `UPDATE orders SET payment_method = 'voided' ...` query (the statement ending `WHERE invoice_id = ?` with `[voidReason, voidNoteSuffix, order_id]`) and BEFORE the `voidOrderAuditPayload = {` assignment, insert:

```javascript
                // A voided order's bound snapshot must not stay 'open_order' forever.
                // Keep the order FK as a durable audit link; reference-aware cleanup
                // preserves it while deleting abandoned rows that truly are unowned.
                // A split parent's snapshot is already terminal ('split_parent') — the
                // state gate skips it rather than attempt an illegal transition.
                const [[voidedOrderSnap]] = await conn.query(
                    "SELECT service_charge_snapshot_id FROM orders WHERE invoice_id = ?",
                    [order_id]
                );
                if (voidedOrderSnap?.service_charge_snapshot_id) {
                    const snap = await getForUpdate(conn, voidedOrderSnap.service_charge_snapshot_id);
                    if (snap.state === 'open_order') {
                        await abandonOpenOrder(conn, {
                            snapshotId: snap.id,
                            version: snap.version,
                            orderId: order_id
                        });
                    }
                }
```

Extend the existing import with `abandonOpenOrder`. Keep `getForUpdate` because the
state gate distinguishes an ordinary open-order snapshot from a terminal split parent.

- [ ] **Step 4: Run the focused suites to verify they pass**

Run: `npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/tables.test.js --reporter=verbose`
Expected: PASS, zero failures (tables.test.js proves existing void/split flows are untouched).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/pos/tables.js backend/tests/integration/serviceChargeSnapshots.test.js
git commit -m "fix(pos): abandon bound snapshots when a table order is voided"
```

---

## Task 3: Merge disposition matrix and canonical fee recompute

**Files:**

- Modify: `backend/routes/pos/tables.js` (merge branch of `POST /tables/transfer`, ~lines 356-504)
- Test: `backend/tests/integration/serviceChargeSnapshots.test.js`

**Interfaces:**

- Consumes Task 1 `rehomeOpenOrder` and `abandonOpenOrder`, plus existing `getForUpdate` and `touchOpenOrder`; consumes `serviceChargeFee` + `canonicalName` from `ServiceChargeCalculator`.
- Merge endpoint: `POST /api/pos/tables/transfer` with body `{ sourceTableId, targetTableId, action: 'merge' }` (unchanged contract).
- Disposition matrix (spec): target-bound survives and gets a version bump; source-only re-homes; both-bound abandons the source; fee survives whenever either side had one, never doubles.
- Rejects same-table merge before the transaction and preserves financially distinct item rows.

- [ ] **Step 1: Write the failing integration tests**

Append inside `describe('service-charge snapshots', ...)` in `backend/tests/integration/serviceChargeSnapshots.test.js`:

```javascript
    // Merge matrix helper: saves a table order, optionally fee-bearing, returns { invoiceId, snapshot }.
    const saveTable = async (tableId, items, totals, withFee) => {
        let snapshot = null;
        const cart = [...items];
        if (withFee) {
            snapshot = (await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({})).body.snapshot;
            cart.push({ id: 'FEE_X', product_id: null, name: 'fee', price: withFee.price, qty: 1, tax_rate: withFee.tax, note: 'Auto-Gratuity' });
        }
        const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: tableId,
            cart,
            ...(snapshot ? { service_charge_snapshot: { id: snapshot.id, version: snapshot.version } } : {}),
            ...totals
        });
        expect(res.statusCode).toBe(200);
        return {
            invoiceId: res.body.invoice_id,
            snapshot,
            boundSnapshot: res.body.service_charge_snapshot || null
        };
    };

    const mergeTables = (sourceTableId, targetTableId) =>
        request(app).post('/api/pos/tables/transfer').set('Cookie', adminCookie)
            .send({ sourceTableId, targetTableId, action: 'merge' });

    it('merge source-only: re-homes the snapshot, keeps one recomputed fee, and settles', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2, tax: 0, total: 2 }, null);

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        // Snapshot re-homed: still open_order, holder is now the TARGET invoice, target FK set.
        const [[snap]] = await pool.query('SELECT state, holder_id, version FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(snap).toMatchObject({ state: 'open_order', holder_id: String(target.invoiceId) });
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [target.invoiceId]);
        expect(order.service_charge_snapshot_id).toBe(source.snapshot.id);

        // Exactly one fee row, recomputed over combined goods (5 + 2) at the frozen 10%.
        const [fees] = await pool.query("SELECT price_at_sale, tax_rate, quantity FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({ price_at_sale: '0.700000', tax_rate: '5.00', quantity: '1.000' });

        // The old dead-end: settling the merged order must work.
        // goods tax: 5×16% = 0.80; fee tax: 0.70×5% = 0.035 → total tax 0.84 (rounded).
        const settle = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            edit_invoice_id: target.invoiceId,
            table_id: SEED.table2.id,
            cart: [
                { id: SEED.product1.id, price: 5, qty: 1 },
                { id: SEED.product2.id, price: 2, qty: 1 },
                { id: 'FEE_1', product_id: null, name: '10% Service Charge', price: 0.7, qty: 1, tax_rate: 5, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: source.snapshot.id, version: snap.version },
            subtotal: 7.7, tax: 0.84, total: 8.54,
            payment_method: 'cash', amount_tendered: 10, change_due: 1.46
        });
        expect(settle.statusCode).toBe(200);
        const [[finalized]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(finalized.state).toBe('finalized');
    });

    it('merge both-bound at differing rates: target rate wins, source abandoned, fee not doubled', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        await enable('12.5', '16');
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        const [[sourceSnap]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(sourceSnap.state).toBe('abandoned');
        const [[targetSnap]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [target.snapshot.id]);
        expect(targetSnap).toMatchObject({ state: 'open_order', holder_id: String(target.invoiceId) });

        // ONE fee row at the TARGET's frozen 12.5%/16 over combined goods 7.00 → 0.88.
        const [fees] = await pool.query("SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({ price_at_sale: '0.880000', tax_rate: '16.00' });
        const [[audit]] = await pool.query(
            "SELECT new_value FROM audit_events WHERE event_type='table_merge' AND entity_id=? ORDER BY id DESC LIMIT 1",
            [source.invoiceId]
        );
        expect(JSON.parse(audit.new_value).service_charge).toEqual({
            kept: target.snapshot.id,
            rehomed: null,
            abandoned: source.snapshot.id
        });
    });

    it('merge target-only: target snapshot survives and its fee recomputes over the combined base', async () => {
        await enable('12.5', '16');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        const [fees] = await pool.query("SELECT price_at_sale FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0].price_at_sale).toBe('0.880000');
        const [[order]] = await pool.query('SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?', [target.invoiceId]);
        expect(order.service_charge_snapshot_id).toBe(target.snapshot.id);
        expect(source.snapshot).toBeNull();
    });

    it('merge both-bound but target fee removed: source fee copies and recomputes at target rate', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        await enable('12.5', '16');
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });
        // Remove the target's fee but keep its snapshot bound (fee-removed save).
        const noFee = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table2.id,
            current_order_id: target.invoiceId,
            cart: [{ id: SEED.product2.id, price: 2, qty: 1 }],
            service_charge_snapshot: { id: target.snapshot.id, version: 2 },
            subtotal: 2, tax: 0, total: 2
        });
        expect(noFee.statusCode).toBe(200);

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(200);

        // The fee survived (from the source) but at the target's surviving frozen rate.
        const [fees] = await pool.query("SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'", [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({ price_at_sale: '0.880000', tax_rate: '16.00' });
        const [[sourceSnap]] = await pool.query('SELECT state FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(sourceSnap.state).toBe('abandoned');
    });

    it('merge neither-bound keeps goods and creates no snapshot or fee', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2, tax: 0, total: 2 }, null);

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [[order]] = await pool.query(
            'SELECT service_charge_snapshot_id FROM orders WHERE invoice_id=?',
            [target.invoiceId]
        );
        expect(order.service_charge_snapshot_id).toBeNull();
        const [[counts]] = await pool.query(
            "SELECT COUNT(*) AS items, SUM(note='Auto-Gratuity') AS fees FROM order_items WHERE invoice_id=?",
            [target.invoiceId]
        );
        expect(Number(counts.items)).toBe(2);
        expect(Number(counts.fees || 0)).toBe(0);
        expect(source.snapshot).toBeNull();
    });

    it('rejects a same-table merge without changing the order or snapshot', async () => {
        await enable('10', '5');
        const saved = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });

        const beforeItems = await pool.query(
            'SELECT product_id, quantity, price_at_sale, note FROM order_items WHERE invoice_id=? ORDER BY id',
            [saved.invoiceId]
        );
        const response = await mergeTables(SEED.table.id, SEED.table.id);
        expect(response.statusCode).toBe(400);
        const [afterItems] = await pool.query(
            'SELECT product_id, quantity, price_at_sale, note FROM order_items WHERE invoice_id=? ORDER BY id',
            [saved.invoiceId]
        );
        expect(afterItems).toEqual(beforeItems[0]);
        const [[table]] = await pool.query('SELECT current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
        expect(table.current_order_id).toBe(saved.invoiceId);
        const [[snapshot]] = await pool.query('SELECT state, holder_id, version FROM service_charge_snapshots WHERE id=?', [saved.snapshot.id]);
        expect(snapshot).toMatchObject({ state: 'open_order', holder_id: String(saved.invoiceId) });
    });

    it('preserves different line discounts and charges the exact combined base', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1, discountType: 'fixed', discountValue: 1 }],
            { subtotal: 4.4, tax: 0.66, total: 5.06 }, { price: 0.4, tax: 5 });
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [goods] = await pool.query(
            "SELECT quantity, discount_type, discount_value FROM order_items WHERE invoice_id=? AND COALESCE(note,'')<>'Auto-Gratuity' ORDER BY id",
            [target.invoiceId]
        );
        expect(goods).toHaveLength(2);
        expect(goods.map(row => [row.quantity, row.discount_type, row.discount_value])).toEqual([
            ['1.000', null, '0.00'],
            ['1.000', 'fixed', '1.00']
        ]);
        const [[fee]] = await pool.query(
            "SELECT price_at_sale FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
            [target.invoiceId]
        );
        expect(fee.price_at_sale).toBe('0.900000');
        expect(source.snapshot.id).not.toBe(target.snapshot.id);
    });

    it('NULL-safe matches otherwise identical legacy discount rows', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        await pool.query(
            'UPDATE order_items SET discount_value=NULL WHERE invoice_id IN (?, ?)',
            [source.invoiceId, target.invoiceId]
        );

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [goods] = await pool.query(
            "SELECT quantity, discount_value FROM order_items WHERE invoice_id=? AND COALESCE(note,'')<>'Auto-Gratuity'",
            [target.invoiceId]
        );
        expect(goods).toHaveLength(1);
        expect(goods[0]).toMatchObject({ quantity: '2.000', discount_value: null });
    });

    it('bumps the surviving target snapshot so a stale pre-merge save fails closed', async () => {
        await enable('12.5', '16');
        await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.25, tax: 0.04, total: 2.29 }, { price: 0.25, tax: 16 });
        const staleVersion = target.boundSnapshot.version;

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const staleSave = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
            table_id: SEED.table2.id,
            current_order_id: target.invoiceId,
            cart: [
                { id: SEED.product2.id, price: 2, qty: 1 },
                { id: 'FEE_X', product_id: null, price: 0.25, qty: 1, tax_rate: 16, note: 'Auto-Gratuity' }
            ],
            service_charge_snapshot: { id: target.snapshot.id, version: staleVersion },
            subtotal: 2.25, tax: 0.04, total: 2.29
        });
        expect(staleSave.statusCode).toBe(409);
        expect(staleSave.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        const [[sourceGoods]] = await pool.query(
            'SELECT COUNT(*) AS count FROM order_items WHERE invoice_id=? AND product_id=?',
            [target.invoiceId, SEED.product1.id]
        );
        expect(Number(sourceGoods.count)).toBe(1);
    });

    it('deduplicates and fully restamps a malformed surviving fee row', async () => {
        await enable('10', '5');
        await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5, tax: 0.8, total: 5.8 }, null);
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2.2, tax: 0.01, total: 2.21 }, { price: 0.2, tax: 5 });
        await pool.query(`
            UPDATE order_items
               SET product_id=?, item_name='forged', quantity=2,
                   discount_type='fixed', discount_value=1
             WHERE invoice_id=? AND note='Auto-Gratuity'
        `, [SEED.product2.id, target.invoiceId]);
        await pool.query(`
            INSERT INTO order_items
                (invoice_id, product_id, item_name, quantity, price_at_sale,
                 tax_rate, tax_amount, note, discount_type, discount_value)
            VALUES (?, NULL, 'duplicate', 1, 99, 99, 0,
                    'Auto-Gratuity', NULL, 0)
        `, [target.invoiceId]);

        expect((await mergeTables(SEED.table.id, SEED.table2.id)).statusCode).toBe(200);
        const [fees] = await pool.query(`
            SELECT product_id, item_name, quantity, price_at_sale, tax_rate,
                   note, discount_type, discount_value, parent_item_id
              FROM order_items
             WHERE invoice_id=? AND note='Auto-Gratuity'
        `, [target.invoiceId]);
        expect(fees).toHaveLength(1);
        expect(fees[0]).toMatchObject({
            product_id: null,
            item_name: '10% Service Charge',
            quantity: '1.000',
            price_at_sale: '0.700000',
            tax_rate: '5.00',
            note: 'Auto-Gratuity',
            discount_type: null,
            discount_value: '0.00',
            parent_item_id: null
        });
    });

    it('rolls back copied items when source snapshot ownership conflicts', async () => {
        await enable('10', '5');
        const source = await saveTable(SEED.table.id,
            [{ id: SEED.product1.id, price: 5, qty: 1 }],
            { subtotal: 5.5, tax: 0.83, total: 6.33 }, { price: 0.5, tax: 5 });
        const target = await saveTable(SEED.table2.id,
            [{ id: SEED.product2.id, price: 2, qty: 1 }],
            { subtotal: 2, tax: 0, total: 2 }, null);
        await pool.query(
            "UPDATE service_charge_snapshots SET holder_id='wrong-order' WHERE id=?",
            [source.snapshot.id]
        );

        const merge = await mergeTables(SEED.table.id, SEED.table2.id);
        expect(merge.statusCode).toBe(409);
        expect(merge.body.code).toBe('SERVICE_CHARGE_SNAPSHOT_CONFLICT');
        const [[sourceOrder]] = await pool.query('SELECT COUNT(*) AS count FROM orders WHERE invoice_id=?', [source.invoiceId]);
        expect(Number(sourceOrder.count)).toBe(1);
        const [[targetGoods]] = await pool.query(
            "SELECT COUNT(*) AS count FROM order_items WHERE invoice_id=? AND COALESCE(note,'')<>'Auto-Gratuity'",
            [target.invoiceId]
        );
        expect(Number(targetGoods.count)).toBe(1);
        const [[snap]] = await pool.query('SELECT state, holder_id FROM service_charge_snapshots WHERE id=?', [source.snapshot.id]);
        expect(snap).toMatchObject({ state: 'open_order', holder_id: 'wrong-order' });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js --reporter=verbose`
Expected: the disposition, same-table, differing-discount identity, stale-version, malformed-fee, rollback, and public-code assertions FAIL for the specific missing protections. The NULL-legacy identity test is a regression lock and may already PASS against the old broad merge query; pre-existing plain merge coverage may likewise satisfy part of the neither-bound case.

- [ ] **Step 3: Implement the merge disposition**

In `backend/routes/pos/tables.js`:

**3a — imports and hostile-input guard.** Extend the two service imports at the top of the file:

```javascript
const { canonicalizeServiceCharge, allocateServiceChargeCents, serviceChargeFee, canonicalName } = require('../../services/ServiceChargeCalculator');
const { getForUpdate, assertDraftUsableBy, bindDraft, touchOpenOrder, createChildHeldSnapshot, transition, rehomeOpenOrder, abandonOpenOrder } = require('../../services/ServiceChargeSnapshotService');
```

Immediately after validating the action and before acquiring a connection, reject a
self-merge. Compare normalized numeric IDs so `'1'` and `1` cannot bypass the guard:

```javascript
    if (Number(sourceTableId) === Number(targetTableId)) {
        return sendError(res, 400, 'Source and target tables must be different.');
    }
```

**3b — load both snapshots.** In the merge branch, replace the two ownership SELECTs:

```javascript
            const [[sourceOrder]] = await conn.execute("SELECT waiter_id FROM orders WHERE invoice_id = ?", [sourceTable.current_order_id]);
            const [[targetOrder]] = await conn.execute("SELECT waiter_id FROM orders WHERE invoice_id = ?", [targetTable.current_order_id]);
```

with:

```javascript
            const [[sourceOrder]] = await conn.execute("SELECT waiter_id, service_charge_snapshot_id FROM orders WHERE invoice_id = ?", [sourceTable.current_order_id]);
            const [[targetOrder]] = await conn.execute("SELECT waiter_id, service_charge_snapshot_id FROM orders WHERE invoice_id = ?", [targetTable.current_order_id]);
            // Lock both bound snapshots for the whole merge. getForUpdate on a snapshot
            // that vanished throws 409 EXPIRED and rolls the merge back untouched.
            const sourceSnapshot = sourceOrder?.service_charge_snapshot_id
                ? await getForUpdate(conn, sourceOrder.service_charge_snapshot_id) : null;
            const targetSnapshot = targetOrder?.service_charge_snapshot_id
                ? await getForUpdate(conn, targetOrder.service_charge_snapshot_id) : null;
            // The snapshot that owns the merged order's fee. The holder-aware CAS calls
            // below validate ownership before commit; any mismatch rolls back all copies.
            // Target wins when both exist.
            const survivingSnapshot = targetSnapshot || sourceSnapshot;
```

**3c — fee-aware item copy.** Directly before the `for (const item of sourceItems) {` loop, add:

```javascript
            // One fee, never doubled: skip the source's Auto-Gratuity row when the target
            // already carries its own, or when no snapshot survives to make it settleable.
            const [[existingTargetFee]] = await conn.execute(
                "SELECT id FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity' LIMIT 1",
                [targetTable.current_order_id]
            );
```

And as the FIRST statement inside the loop (before the `if (item.parent_item_id != null) continue;` line):

```javascript
                if (item.note === 'Auto-Gratuity' && (existingTargetFee || !survivingSnapshot)) continue;
```

Replace the normal-line `existingItem` lookup with a complete financial identity. Keep
the existing quantity increment/insert branches unchanged around it:

```javascript
                const [[existingItem]] = await conn.execute(`
                    SELECT id, quantity
                      FROM order_items
                     WHERE invoice_id = ?
                       AND product_id <=> ?
                       AND item_name <=> ?
                       AND price_at_sale = ?
                       AND note <=> ?
                       AND discount_type <=> ?
                       AND discount_value <=> ?
                       AND tax_rate = ?
                `, [
                    targetTable.current_order_id,
                    item.product_id,
                    item.item_name,
                    item.price_at_sale,
                    item.note,
                    item.discount_type,
                    item.discount_value,
                    item.tax_rate
                ]);
```

`<=>` is MariaDB/MySQL NULL-safe equality. Do not import the source order-level
discount; the target order's existing discount remains authoritative.

**3d — disposition + fee recompute.** Directly after the item-copy loop's closing brace (before the `// Snapshot the source order BEFORE it is destroyed` comment), add:

```javascript
            // Snapshot disposition: target-bound survives and is version-bumped;
            // source-only re-homes; both-bound abandons the source. Every primitive
            // includes state, holder, order ID, and version in its CAS predicate.
            let rehomedSnapshotId = null;
            let abandonedSnapshotId = null;
            if (sourceSnapshot && targetSnapshot) {
                await abandonOpenOrder(conn, {
                    snapshotId: sourceSnapshot.id,
                    version: sourceSnapshot.version,
                    orderId: sourceTable.current_order_id
                });
                abandonedSnapshotId = sourceSnapshot.id;
            } else if (sourceSnapshot) {
                await rehomeOpenOrder(conn, {
                    snapshotId: sourceSnapshot.id,
                    version: sourceSnapshot.version,
                    fromOrderId: sourceTable.current_order_id,
                    toOrderId: targetTable.current_order_id
                });
                await conn.execute(
                    "UPDATE orders SET service_charge_snapshot_id = ? WHERE invoice_id = ?",
                    [sourceSnapshot.id, targetTable.current_order_id]
                );
                rehomedSnapshotId = sourceSnapshot.id;
            }

            // A target-owned snapshot must change version when the merged cart changes.
            // This is both an ownership check and the stale-client invalidation token.
            if (targetSnapshot) {
                await touchOpenOrder(conn, {
                    snapshotId: targetSnapshot.id,
                    version: targetSnapshot.version,
                    orderId: targetTable.current_order_id
                });
            }

            // Reconcile the persisted fee shape. A merge is a recovery boundary: when a
            // snapshot survives, keep the lowest-ID fee row and delete extras; without a
            // snapshot, remove every fee row rather than preserve an unsettleable order.
            const [mergedFeeRows] = await conn.execute(
                "SELECT id FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity' ORDER BY id FOR UPDATE",
                [targetTable.current_order_id]
            );
            if (!survivingSnapshot) {
                if (mergedFeeRows.length > 0) {
                    await conn.execute(
                        "DELETE FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity'",
                        [targetTable.current_order_id]
                    );
                }
            } else if (mergedFeeRows.length > 0) {
                const keepFeeId = mergedFeeRows[0].id;
                await conn.execute(
                    "DELETE FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity' AND id <> ?",
                    [targetTable.current_order_id, keepFeeId]
                );
                const [goods] = await conn.execute(
                    "SELECT quantity, price_at_sale, discount_type, discount_value, note FROM order_items WHERE invoice_id = ?",
                    [targetTable.current_order_id]
                );
                const fee = serviceChargeFee(goods.map(row => ({
                    price: Number(row.price_at_sale),
                    qty: Number(row.quantity),
                    discountType: row.discount_type,
                    discountValue: Number(row.discount_value || 0),
                    note: row.note
                })), survivingSnapshot.percentage);
                if (fee > 0) {
                    await conn.execute(`
                        UPDATE order_items
                           SET product_id=NULL,
                               item_name=?, quantity=1, price_at_sale=?,
                               tax_rate=?, note='Auto-Gratuity',
                               discount_type=NULL, discount_value=0,
                               parent_item_id=NULL
                         WHERE id=?
                    `, [
                        canonicalName(survivingSnapshot.percentage),
                        fee,
                        Number(survivingSnapshot.tax_rate),
                        keepFeeId
                    ]);
                } else {
                    await conn.execute("DELETE FROM order_items WHERE id = ?", [keepFeeId]);
                }
            }
```

(`recomputeOrderTotals` already runs after this block and restamps per-line tax and order totals — do not duplicate that.)

**3e — audit.** In the `mergeAuditSnapshot = { ... }` object, add one property after `targetTableId`:

```javascript
                serviceCharge: {
                    kept: targetSnapshot?.id ?? null,
                    rehomed: rehomedSnapshotId,
                    abandoned: abandonedSnapshotId
                },
```

And in the merge audit INSERT's `new_value` `JSON.stringify({...})`, add after `target_table_id`:

```javascript
                        service_charge: mergeAuditSnapshot.serviceCharge,
```

**3f — preserve the conflict code.** In the `/tables/transfer` catch block, pass the
snapshot service's machine-readable code through `sendError`:

```javascript
        return sendError(res, status, msg, err.publicCode || null);
```

Replace the existing three-argument `sendError` call. Do not invent a code for ordinary
database or validation errors; only forward one already attached by the snapshot service.

- [ ] **Step 4: Run the focused suites to verify they pass**

Run: `npx vitest run backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/tables.test.js backend/tests/integration/bundle.tables.test.js --reporter=verbose`
Expected: PASS, zero failures (tables + bundle suites prove plain merges, bundle merges, transfer, and swap are untouched).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/pos/tables.js backend/tests/integration/serviceChargeSnapshots.test.js
git commit -m "fix(pos): reconcile service-charge snapshots across table merges"
```

---

## Final Verification

- [ ] **Step 1: Run the complete suite exactly once**

Run: `npx vitest run --reporter=verbose`
Expected: zero failures. This is the plan's single full-suite run (owner rule). If it fails, rerun ONLY the failing files while fixing, then one final complete run.

- [ ] **Step 2: Build**

Run: `npm run build:admin`
Expected: successful Vite build (no frontend changes in this plan; this guards the shared import surface).

- [ ] **Step 3: Static orphan audit**

```bash
rg -n "DELETE FROM orders|payment_method = 'voided'|open_order|abandonOpenOrder|rehomeOpenOrder|touchOpenOrder" backend/routes/pos/tables.js
rg -n "service_charge_snapshot_id|LEFT JOIN orders|LEFT JOIN held_orders|parent_snapshot_id" backend/services/ServiceChargeSnapshotService.js backend/migrations/apply-service-charge-snapshots.js
git diff --check master...HEAD
git status --short
```

Expected: every `DELETE FROM orders` or `payment_method = 'voided'` path in tables.js either dispositions the bound snapshot (merge, empty-cart void) or is covered by a terminal state (split-parent void); no unrelated files modified.

- [ ] **Step 4: Review commit boundaries**

```bash
git log --oneline master..HEAD
```

Expected: three commits matching Tasks 1-3.

---

## Deferred and Explicitly Excluded

- Multi-snapshot order ownership (rejected in the spec).
- Split, transfer, swap, disjoin, refund, and paid-order flows.
- Backfill of snapshots stranded before this ships (optional one-off SQL during a rollout window).
