# Refund Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or superpowers:executing-plans) to run this task-by-task, and superpowers:test-driven-development for every task (failing test FIRST, prove red → green). Steps use checkbox (`- [ ]`) syntax. **Run one Task per agent dispatch; commit before the next.**
>
> **Git hygiene:** the owner may have unrelated WIP in the tree (`git status` shows modified `orderSessionStore.js`, `tables.js`, `tables.test.js`, `orderSessionStore.test.js`). Do NOT `git stash`. When committing, stage ONLY the files each Task names (`git add <exact file>` per listed file) — never `git add -A`.

**Goal:** Fix four confirmed refund/void correctness defects in `backend/routes/pos/refunds.js` and `src/components/pos/RefundModal.vue`: (P2-6) catalog products refund with a NULL `item_name` snapshot; (P2-2) the over-refund cap under-records the void subtotal on the 2nd+ partial void; (P3-3) a clamped refund header diverges from its `refund_items` line rows; (P3-4) the RefundModal `isPaid` paid-refund load path is dead code that can never load. Each behavior change ships with a test.

**Architecture:** Single POST endpoint `POST /api/pos/refunds` (`backend/routes/pos/refunds.js`) handles both `kind='void'` (cancel of an unpaid open-table order — no money moves, `amount_refunded=0`) and `kind='refund'` (money return on a paid order). It locks the order `FOR UPDATE`, loads parent `order_items`, mirrors checkout/PosCalculator money math (`calculateLineTotal(line) × discountRatio`; `tax_amount` stored net), writes a `refunds` header + `refund_items` line rows, restocks if enabled, updates `orders.refund_status`, and inserts the `audit_events` row with the same `conn` before `conn.commit()`. The Vue `RefundModal.vue` (Options-API `setup()`) is the POS-terminal front door for **unpaid-table voids only**; it loads authoritative lines from `GET /api/pos/table_order` and posts the selection through `useCart().processRefund`.

**Tech Stack:** Vue 3 (Options-API `setup()`), Vite 6, Tailwind v4; Express 5 + `mysql2/promise`; Vitest + supertest. Test runner is **Vitest** (`npx vitest run <file>`), never jest. Integration suite: `backend/tests/integration/refunds.test.js` (seeds via `seedDatabase()`/`SEED` from `backend/tests/fixtures/seed.js`; `adminCookie` = login `9001`, `waiterCookie` = `9003` holds `pos.refund`; `cashierCookie` = `9002` lacks it). Product 1 = `Test Burger`, price 5.00, tax 16, `stock NULL`. Money helpers: `roundMoney(v) = Math.round((v + Number.EPSILON) * 100) / 100`, `MONEY_TOLERANCE = 0.02`, `calculateLineTotal({price, qty, discountType, discountValue})` (from `backend/services/PosCalculator.js`).

## Global Constraints

- Failing test FIRST, then the fix. Prove red → green with the exact command output.
- `sendError()` sanitizes messages containing (`table` AND `exist`) or `ER_`/`SQLSTATE`/`mysql`/`SQL Error`, and any 500 in production → generic text. Do not phrase new error strings with those tokens.
- Server is money-authoritative: never trust client-sent `amount_refunded`/`subtotal_refunded`. Do not weaken the over-refund cap or the per-line quantity guard.
- `audit_events` for refunds/voids must be transactional: insert with the same `conn` before `conn.commit()`. If audit insert fails, rollback the refund/void too.
- Void = cancel of an unpaid order: `amount_refunded` MUST stay 0. None of these tasks change that.
- Regression net: after every backend task, `npx vitest run backend/tests/integration/refunds.test.js` must stay green (all pre-existing cases still pass).
- Line numbers below were read on 2026-07-04 but MAY have shifted — re-open each cited file and match on the quoted BEFORE text, not the line number.

---

## Task 1 — P2-6: refund_items.item_name stored NULL for catalog products

**Finding P2-6** — `backend/routes/pos/refunds.js:70-75`. **Defect:** the order-lines load selects the raw `item_name`:
```
SELECT id, product_id, item_name, note, quantity, price_at_sale, tax_rate, tax_amount,
       discount_type, discount_value, sort_order
FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL
```
Catalog products store `order_items.item_name = NULL` by design (only the product row carries the name; see `tables.js` table-save insert and `checkout.js`). So `computed[].item_name` (~L168) and the `refund_items` INSERT (~L223) persist NULL → refund history/receipts show a blank name (or, after a product rename, the *current* `products.name`). This is the exact sibling of the already-fixed `void_item`/print bug (`tables.js:1182` and `tables.js:750` already use `COALESCE(oi.item_name, p.name)`); the fix never reached `refunds.js`.

**Files:** Modify `backend/routes/pos/refunds.js`; add a seed helper + test to `backend/tests/integration/refunds.test.js`.

**Interfaces:** No signature change. The query gains `LEFT JOIN products p` and returns `item_name` = `COALESCE(oi.item_name, p.name)`; every downstream `it.item_name` / `it.id` / `it.product_id` / `it.quantity` / `it.sort_order` key is preserved via aliasing.

- [ ] **Step 1 — write the FULL failing test.** In `backend/tests/integration/refunds.test.js`, add this seed helper next to `seedPaidOrder` (after line ~143) and this test inside the top-level `describe('POST /api/pos/refunds', ...)`:
```javascript
  // A paid CATALOG-product line stores item_name = NULL (the product row owns the name).
  async function seedPaidCatalogOrderNullName() {
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 11.60)`
    );
    const invoiceId = r.insertId;
    const [it] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, NULL, 2, 5.000000, 16.00, 1.600000)`,
      [invoiceId]
    );
    return { invoiceId, orderItemId: it.insertId };
  }

  it('(P2-6) refunding a catalog product snapshots the product name, never NULL', async () => {
    const { invoiceId } = await seedPaidCatalogOrderNullName();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const [[refund]] = await pool.query('SELECT id FROM refunds WHERE invoice_id=?', [invoiceId]);
    const [[ri]] = await pool.query('SELECT item_name FROM refund_items WHERE refund_id=?', [refund.id]);
    expect(ri.item_name).not.toBeNull();
    expect(ri.item_name).toBe('Test Burger'); // COALESCE(oi.item_name, p.name)

    // The snapshot is durable: renaming the product AFTER the refund never rewrites history.
    await pool.query("UPDATE products SET name='Renamed Burger' WHERE id=1");
    const [[after]] = await pool.query('SELECT item_name FROM refund_items WHERE refund_id=?', [refund.id]);
    expect(after.item_name).toBe('Test Burger');
  });
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/integration/refunds.test.js -t "P2-6"` → FAILS: `expect(ri.item_name).not.toBeNull()` receives `null` (raw NULL persisted).

- [ ] **Step 3 — minimal fix.** In `backend/routes/pos/refunds.js`, the order-lines load (~L70):

  BEFORE:
```javascript
        const [orderItems] = await conn.query(
            `SELECT id, product_id, item_name, note, quantity, price_at_sale, tax_rate, tax_amount,
                    discount_type, discount_value, sort_order
             FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL`,
            [invoiceId]
        );
```
  AFTER:
```javascript
        const [orderItems] = await conn.query(
            `SELECT oi.id, oi.product_id, COALESCE(oi.item_name, p.name) AS item_name,
                    oi.note, oi.quantity, oi.price_at_sale, oi.tax_rate, oi.tax_amount,
                    oi.discount_type, oi.discount_value, oi.sort_order
             FROM order_items oi
             LEFT JOIN products p ON oi.product_id = p.id
             WHERE oi.invoice_id = ? AND oi.parent_item_id IS NULL`,
            [invoiceId]
        );
```

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/integration/refunds.test.js -t "P2-6"` → PASS. (`item_name` = `Test Burger`; rename-afterward assertion holds because the value is snapshotted into `refund_items` at refund time.)

- [ ] **Step 5 — regression.** `npx vitest run backend/tests/integration/refunds.test.js` → all cases green (the whole-order/partial/bundle tests still assert their expected `item_name='Test Burger'`, now sourced identically).

- [ ] **Step 6 — commit.** Stage only the two files:
```
git add backend/routes/pos/refunds.js backend/tests/integration/refunds.test.js
git commit -m "fix(refunds): COALESCE item_name from product on refund_items snapshot (P2-6)"
```

---

## Task 2 — P2-2: over-refund cap under-records the void subtotal on the 2nd+ partial void

**Finding P2-2** — `backend/routes/pos/refunds.js:179-181`. **Defect:** the cap computes
```
remainingSubtotal = roundMoney(Math.max(0, roundMoney(discountedSubtotal) - priorSubtotalRefunded))
```
This is correct for `kind='refund'` (a paid sale is frozen history, so remaining = frozen subtotal minus the cumulative already-refunded). It is WRONG for `kind='void'`: a partial void calls `recomputeOrderTotals` which UPDATEs `orders.subtotal` DOWN, and this request re-reads that shrunken `order.subtotal` (locked `FOR UPDATE` at the top) into `discountedSubtotal`. Meanwhile `priorSubtotalRefunded` is the cumulative sum of *prior* void `subtotal_refunded` rows. So on the 2nd void the cap subtracts already-voided money from an already-shrunken subtotal and clamps the recorded void subtotal to ~0, while the child `refund_items` keep the true value. **Repro:** one line qty5 @ 10.00 (subtotal 50). Void1 qty4 → records 40, `orders.subtotal` → 10. Void2 qty1 computes `subtotalRefunded=10` but `remainingSubtotal = max(0, 10 - 40) = 0` → records 0. Σ recorded = 40 vs actual 50.

**Files:** Modify `backend/routes/pos/refunds.js`; add a test to `backend/tests/integration/refunds.test.js`.

**Interfaces:** `remainingSubtotal` becomes branch-aware: for `void` it is the live remaining bill (`roundMoney(discountedSubtotal)`); the cumulative `- priorSubtotalRefunded` cap is kept ONLY for `refund`. `remainingTotal` and the `amountRefunded` logic are unchanged.

- [ ] **Step 1 — write the FULL failing test.** Add inside the top-level `describe(...)` in `refunds.test.js`:
```javascript
  it('(P2-2) sequential partial voids record the full subtotal (no under-count on 2nd void)', async () => {
    // One line qty5 @ 10.00 → subtotal 50.00, tax 0, on table 1.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, table_id, subtotal, tax, total, payment_method)
       VALUES (1, 1, 1, 50.00, 0.00, 50.00, 'unpaid_table')`
    );
    const invoiceId = r.insertId;
    const [it] = await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 5, 10.000000, 0, 0)`,
      [invoiceId]
    );
    await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=1", [invoiceId]);
    const orderItemId = it.insertId;

    const v1 = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'void', items: [{ order_item_id: orderItemId, qty: 4 }] });
    expect(v1.status).toBe(200);
    const v2 = await request(app).post('/api/pos/refunds').set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'void', items: [{ order_item_id: orderItemId, qty: 1 }] });
    expect(v2.status).toBe(200);

    const [rows] = await pool.query(
      'SELECT subtotal_refunded FROM refunds WHERE invoice_id=? ORDER BY id', [invoiceId]
    );
    expect(rows.length).toBe(2);
    const sum = rows.reduce((a, x) => a + Number(x.subtotal_refunded), 0);
    expect(sum).toBeCloseTo(50.00, 2);                          // was 40.00 before the fix
    expect(Number(rows[1].subtotal_refunded)).toBeGreaterThan(0); // 2nd void was clamped to 0
  });
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/integration/refunds.test.js -t "P2-2"` → FAILS: `rows[1].subtotal_refunded` is `0.00`, so `sum` is `40.00` not `50.00`.

- [ ] **Step 3 — minimal fix.** In `backend/routes/pos/refunds.js`, the cap block (~L176-181):

  BEFORE:
```javascript
        // Hard over-refund cap (defense-in-depth). A refund can never return more than the
        // order's remaining refundable money: subtotal capped to (order.subtotal*ratio - prior),
        // amount capped to (order.total - prior). Clamp on rounding overshoot.
        const remainingSubtotal = roundMoney(Math.max(0, roundMoney(discountedSubtotal) - priorSubtotalRefunded));
        const remainingTotal = roundMoney(Math.max(0, (Number(order.total) || 0) - priorAmountRefunded));
        if (subtotalRefunded > remainingSubtotal) subtotalRefunded = remainingSubtotal;
```
  AFTER:
```javascript
        // Hard over-refund cap (defense-in-depth). Two different "remaining" definitions:
        //  - refund: a paid sale is frozen history, so remaining = discountedSubtotal MINUS
        //            the cumulative sum already refunded across prior refund rows.
        //  - void:   order_items IS the live bill and recomputeOrderTotals shrinks
        //            orders.subtotal after each partial void, so discountedSubtotal already
        //            reflects every earlier void. Subtracting priorSubtotalRefunded again
        //            double-counts and clamps the 2nd+ void to ~0 — cap to the live bill only.
        const remainingSubtotal = kind === 'void'
            ? roundMoney(discountedSubtotal)
            : roundMoney(Math.max(0, roundMoney(discountedSubtotal) - priorSubtotalRefunded));
        const remainingTotal = roundMoney(Math.max(0, (Number(order.total) || 0) - priorAmountRefunded));
        if (subtotalRefunded > remainingSubtotal) subtotalRefunded = remainingSubtotal;
```

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/integration/refunds.test.js -t "P2-2"` → PASS (`rows[1] = 10.00`, `sum = 50.00`).

- [ ] **Step 5 — regression.** `npx vitest run backend/tests/integration/refunds.test.js` → green. Pay attention that `partial void reduces the live order...`, `voiding the last item empties the order...`, and `repeated partial void respects current remaining...` still pass (the `refund`-path cap is untouched, so the C2 discounted-refund cases are unaffected).

- [ ] **Step 6 — commit.**
```
git add backend/routes/pos/refunds.js backend/tests/integration/refunds.test.js
git commit -m "fix(refunds): cap void subtotal to live bill, not cumulative prior (P2-2)"
```

---

## Task 3 — P3-3: clamped refund header diverges from its refund_items line rows

**Finding P3-3** — `backend/routes/pos/refunds.js:181-184` + INSERT `:217-226`. **Defect:** when the over-refund cap clamps the header `subtotalRefunded`, the per-line `computed[]` values are NOT rescaled, so `SUM(refund_items.line_subtotal)` can exceed the stored `refunds.subtotal_refunded` — header and its own line rows no longer reconcile. After Task 2, the void path no longer clamps in the normal case, so this reproduces on the `kind='refund'` clamp path: a stored rollup residue (a paid order whose `orders.subtotal` was saved a cent below the line net — a legitimate per-line-vs-rollup rounding artifact) makes the header cap bite while the line row keeps the higher value.

**Files:** Modify `backend/routes/pos/refunds.js`; add a test to `backend/tests/integration/refunds.test.js`.

**Interfaces:** capture `preClampSubtotal` (the pre-clamp header subtotal), and after the cap, if the clamp reduced it, proportionally rescale every `computed[].line_subtotal` and re-derive `line_total = line_subtotal + line_tax`; the last line absorbs the rounding remainder so `Σ line_subtotal === subtotalRefunded` exactly. `tax_refunded` is not independently clamped by the cap, so only `line_subtotal`/`line_total` need rescaling.

**Overlap note:** this Task edits the SAME cap block as Task 2 — run Task 2 FIRST. The BEFORE snippet below already reflects Task 2's void-aware `remainingSubtotal`.

- [ ] **Step 1 — write the FULL failing test.** Add inside the top-level `describe(...)`:
```javascript
  it('(P3-3) a clamped refund header keeps refund_items in sync (Sum lines == subtotal_refunded)', async () => {
    // Stored rollup residue: a single 10.00 line, but orders.subtotal was saved a cent
    // low (9.99). The over-refund cap clamps the header subtotal to 9.99, so the line
    // rows must be rescaled from 10.00 to 9.99 or header and lines diverge.
    const [r] = await pool.query(
      `INSERT INTO orders (order_id, user_id, subtotal, tax, total, payment_method, cash_amount, amount_tendered)
       VALUES (1, 1, 9.99, 0.00, 9.99, 'cash', 9.99, 9.99)`
    );
    const invoiceId = r.insertId;
    await pool.query(
      `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
       VALUES (?, 1, 'Test Burger', 1, 10.000000, 0, 0)`,
      [invoiceId]
    );
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', adminCookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);

    const [[refund]] = await pool.query('SELECT subtotal_refunded FROM refunds WHERE invoice_id=?', [invoiceId]);
    expect(Number(refund.subtotal_refunded)).toBeCloseTo(9.99, 2); // header clamped
    const [[agg]] = await pool.query(
      `SELECT COALESCE(SUM(ri.line_subtotal),0) s
       FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
       WHERE r.invoice_id = ?`, [invoiceId]
    );
    // Before the fix: header 9.99 vs Sum(lines) 10.00. After: exactly equal.
    expect(Number(agg.s)).toBeCloseTo(Number(refund.subtotal_refunded), 2);
  });
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run backend/tests/integration/refunds.test.js -t "P3-3"` → FAILS: `Σ line_subtotal` = `10.00`, `subtotal_refunded` = `9.99`.

- [ ] **Step 3 — minimal fix.** In `backend/routes/pos/refunds.js`, the cap block (post-Task-2 state, ~L179-184):

  BEFORE:
```javascript
        const remainingSubtotal = kind === 'void'
            ? roundMoney(discountedSubtotal)
            : roundMoney(Math.max(0, roundMoney(discountedSubtotal) - priorSubtotalRefunded));
        const remainingTotal = roundMoney(Math.max(0, (Number(order.total) || 0) - priorAmountRefunded));
        if (subtotalRefunded > remainingSubtotal) subtotalRefunded = remainingSubtotal;
        // void = cancel of an unpaid order: no money moves.
        let amountRefunded = kind === 'void' ? 0 : roundMoney(subtotalRefunded + taxRefunded);
        if (kind !== 'void' && amountRefunded > remainingTotal) amountRefunded = remainingTotal;
```
  AFTER:
```javascript
        const remainingSubtotal = kind === 'void'
            ? roundMoney(discountedSubtotal)
            : roundMoney(Math.max(0, roundMoney(discountedSubtotal) - priorSubtotalRefunded));
        const remainingTotal = roundMoney(Math.max(0, (Number(order.total) || 0) - priorAmountRefunded));
        const preClampSubtotal = subtotalRefunded;
        if (subtotalRefunded > remainingSubtotal) subtotalRefunded = remainingSubtotal;
        // void = cancel of an unpaid order: no money moves.
        let amountRefunded = kind === 'void' ? 0 : roundMoney(subtotalRefunded + taxRefunded);
        if (kind !== 'void' && amountRefunded > remainingTotal) amountRefunded = remainingTotal;

        // If the over-refund cap clamped the header subtotal, rescale the per-line
        // refund_items rows so SUM(line_subtotal) still equals refunds.subtotal_refunded.
        // Without this the header and its own line rows diverge and refund receipts /
        // history don't reconcile. The last line absorbs the rounding remainder so the
        // sum is exact.
        if (computed.length && subtotalRefunded < preClampSubtotal - 1e-9) {
            const scale = preClampSubtotal > 0 ? subtotalRefunded / preClampSubtotal : 0;
            let allocated = 0;
            computed.forEach((c, i) => {
                if (i === computed.length - 1) {
                    c.line_subtotal = roundMoney(subtotalRefunded - allocated);
                } else {
                    c.line_subtotal = roundMoney(c.line_subtotal * scale);
                    allocated = roundMoney(allocated + c.line_subtotal);
                }
                c.line_total = roundMoney(c.line_subtotal + c.line_tax);
            });
        }
```

- [ ] **Step 4 — run → PASS.** `npx vitest run backend/tests/integration/refunds.test.js -t "P3-3"` → PASS (`Σ line_subtotal` = `9.99` = header). The rescale is a no-op whenever the clamp does not fire (guarded by `subtotalRefunded < preClampSubtotal - 1e-9`), so no other case is disturbed.

- [ ] **Step 5 — regression.** `npx vitest run backend/tests/integration/refunds.test.js` → green (including the Task 2 void case, where after Task 2 the clamp does not fire so the rescale never runs).

- [ ] **Step 6 — commit.**
```
git add backend/routes/pos/refunds.js backend/tests/integration/refunds.test.js
git commit -m "fix(refunds): rescale refund_items lines when the header cap clamps (P3-3)"
```

---

## Task 4 — P3-4: RefundModal paid-refund (isPaid=true) load path is dead code

**Finding P3-4** — `src/components/pos/RefundModal.vue`, `loadItems()` (~L149-178), prop `isPaid` (~L123), the refund-method picker (~L66-85), and `confirm()` (~L231-250). **Defect:** `loadItems()` always fetches `GET api/pos/table_order?order_id=...`, which 409s any order whose `payment_method !== 'unpaid_table'` (`tables.js:732`). So when `isPaid=true`, the load can never succeed — the whole `isPaid` branch (refund-method picker, `intent:'refund'`, `refund_method`) is unreachable. It is masked because the component's **only** consumer, `PosTerminal.vue:587`, mounts it as `<RefundModal :open=... :invoice-id=... @close=... />` and never binds `:is-paid`. Admin paid refunds are a **separate** implementation: `src/admin/pages/Orders.vue` has its own inline refund modal + `submitRefund` (loading lines from `api/admin/order_details`) and does NOT import this component (grep: `RefundModal` is imported only in `PosTerminal.vue:808`).

**Decision — option (a): remove the dead `isPaid` path.** RefundModal.vue is exclusively the POS-terminal unpaid-table void front door; the paid path here is genuinely dead and duplicates admin `Orders.vue`. Option (b) (loading paid lines from `api/admin/order_details`) would require mounting the component in a DOM to test, but the repo has **no component-test infrastructure** (`vitest.config.mjs` → `environment: 'node'`, no jsdom, no `@vue/test-utils`). Deleting unreachable code is the minimal, correct, testable fix. The test is a runnable source-structural spec (the "grep for dangling references" the finding sanctions) placed under the existing `src/**/*.spec.js` include glob.

**Files:** Modify `src/components/pos/RefundModal.vue`; add `src/components/pos/RefundModal.ispaid.spec.js` (new, runnable under the `src/**/*.spec.js` glob in `vitest.config.mjs`).

**Interfaces:** the `isPaid` prop and `refundMethod` state are removed; `confirm()` always posts `intent: 'void'`, `refund_method: null` (unchanged behavior for the sole caller, which already never set `isPaid`). Public template contract for `PosTerminal.vue:587` (`open`, `invoice-id`, `@close`) is unchanged.

- [ ] **Step 1 — write the FULL failing test.** Create `src/components/pos/RefundModal.ispaid.spec.js`:
```javascript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'RefundModal.vue'), 'utf8');

describe('RefundModal — dead paid-refund (isPaid) path removed (P3-4)', () => {
  it('no longer declares the dead isPaid prop or refundMethod state', () => {
    expect(SRC).not.toMatch(/isPaid/);
    expect(SRC).not.toMatch(/refundMethod/);
  });

  it('always submits a void intent (unpaid-table cancel), never a paid refund', () => {
    expect(SRC).toMatch(/intent:\s*'void'/);
    expect(SRC).not.toMatch(/intent:\s*props\.isPaid/);
    expect(SRC).toMatch(/refund_method:\s*null/);
  });

  it('still loads authoritative order lines via table_order', () => {
    expect(SRC).toMatch(/api\/pos\/table_order/);
  });
});
```

- [ ] **Step 2 — run → FAIL.** `npx vitest run src/components/pos/RefundModal.ispaid.spec.js` → FAILS: the source still contains `isPaid`, `refundMethod`, and `intent: props.isPaid ...`.

- [ ] **Step 3 — minimal fix.** Apply all five edits in `src/components/pos/RefundModal.vue`:

  **(a) Remove the prop (~L120-124).** BEFORE:
```javascript
  props: {
    open:      { type: Boolean, default: false },
    invoiceId: { type: [Number, String], default: null },
    isPaid:    { type: Boolean, default: false },
  },
```
  AFTER:
```javascript
  props: {
    open:      { type: Boolean, default: false },
    invoiceId: { type: [Number, String], default: null },
  },
```

  **(b) Remove the refund-method picker block (~L66-85)** — delete the entire block, comment included:
```html
        <!-- Refund method — paid orders only -->
        <div v-if="isPaid" class="mb-4">
          <label class="block text-[11px] sm:text-xs font-black text-on-surface-variant uppercase tracking-widest mb-2">{{ $t('Refund Method') }}</label>
          <div class="flex gap-2">
            <button @click="refundMethod = 'cash'"
              :class="['flex-1 py-2.5 rounded-xl text-xs font-bold border-2 transition-colors',
                refundMethod === 'cash'
                  ? 'border-primary bg-primary-fixed text-primary'
                  : 'border-outline-variant/30 bg-surface-container-lowest text-on-surface-variant hover:border-primary/50']">
              <i class="fa-solid fa-money-bill-wave me-1.5"></i>{{ $t('Cash') }}
            </button>
            <button @click="refundMethod = 'card'"
              :class="['flex-1 py-2.5 rounded-xl text-xs font-bold border-2 transition-colors',
                refundMethod === 'card'
                  ? 'border-primary bg-primary-fixed text-primary'
                  : 'border-outline-variant/30 bg-surface-container-lowest text-on-surface-variant hover:border-primary/50']">
              <i class="fa-regular fa-credit-card me-1.5"></i>{{ $t('Card') }}
            </button>
          </div>
        </div>
```

  **(c) Remove the `refundMethod` ref (~L133).** Delete: `    const refundMethod = ref('cash');`

  **(d) Drop the `refundMethod` reset in the open/close watch (~L182-184).** BEFORE:
```javascript
    watch(() => props.open, (isOpen) => {
      reason.value = '';
      refundMethod.value = 'cash';
      if (isOpen) {
```
  AFTER:
```javascript
    watch(() => props.open, (isOpen) => {
      reason.value = '';
      if (isOpen) {
```

  **(e) Hardcode the void contract in `confirm()` (~L239-245).** BEFORE:
```javascript
      const result = await processRefund({
        invoice_id:    props.invoiceId,
        items,
        reason:        reason.value || null,
        refund_method: props.isPaid ? refundMethod.value : null,
        intent:        props.isPaid ? 'refund' : 'void',
      });
```
  AFTER:
```javascript
      const result = await processRefund({
        invoice_id:    props.invoiceId,
        items,
        reason:        reason.value || null,
        refund_method: null,
        intent:        'void',
      });
```

  **(f) Drop `refundMethod` from the returned object (~L252-258).** BEFORE:
```javascript
    return {
      lineItems, isProcessing,
      selectedQty, reason, refundMethod,
      loading, loadError, ready,
      allSelected, nothingSelected,
      toggleSelectAll, incQty, decQty, confirm,
    };
```
  AFTER:
```javascript
    return {
      lineItems, isProcessing,
      selectedQty, reason,
      loading, loadError, ready,
      allSelected, nothingSelected,
      toggleSelectAll, incQty, decQty, confirm,
    };
```

- [ ] **Step 4 — run → PASS.** `npx vitest run src/components/pos/RefundModal.ispaid.spec.js` → PASS (no `isPaid`/`refundMethod` tokens remain; `intent: 'void'` and `refund_method: null` present). Then confirm the SFC still compiles: `npm run build:admin` → build succeeds.

- [ ] **Step 5 — backend regression (unchanged, guard).** `npx vitest run backend/tests/integration/refunds.test.js` → green (this task touches no backend file; kept per format as a regression check).

- [ ] **Step 6 — commit.**
```
git add src/components/pos/RefundModal.vue src/components/pos/RefundModal.ispaid.spec.js
git commit -m "refactor(refund-modal): remove dead isPaid paid-refund path (P3-4)"
```

---

## Self-Review

- **Each task is red→green and independently committed.** Tasks 1-3 add one integration case each to `refunds.test.js`; Task 4 adds a standalone spec. Every task ends with the full `npx vitest run backend/tests/integration/refunds.test.js` regression run.
- **P2-6 math unchanged.** Task 1 only aliases the SELECT and adds a `LEFT JOIN products`; all downstream keys (`it.id/product_id/item_name/quantity/price_at_sale/tax_rate/tax_amount/discount_type/discount_value/sort_order/note`) are preserved, so the partial-void, bundle-rebuild, and restock code is untouched. The rename-afterward assertion proves the value is a durable snapshot, not a live join.
- **P2-2 scope is void-only.** The `refund`-path cap keeps its cumulative `- priorSubtotalRefunded` term verbatim, so the C2 discounted-refund cases and the "blocks a second refund that exceeds remaining quantity" per-line guard are unaffected. The per-line quantity guard (`qty > remaining`) still fires first, so voids can never remove more units than exist.
- **P2-2 / P3-3 order dependency is called out.** Both edit the same cap block; Task 3's BEFORE snippet is written against the post-Task-2 state. Task 3's rescale is guarded (`subtotalRefunded < preClampSubtotal - 1e-9`) so it is a strict no-op in every case where the cap does not clamp — including all pre-existing green tests and, after Task 2, normal voids.
- **P3-3 determinism.** The repro uses only integer-cent values (a `10.00` line vs a stored `9.99` subtotal) to avoid floating-point half-cent ambiguity; the clamp delta is exactly `0.01`, and the last-line-absorbs-remainder allocation guarantees `Σ line_subtotal === subtotal_refunded` exactly. `tax_refunded` is not clamped by the cap, so leaving `line_tax` unscaled is correct; `line_total` is re-derived.
- **P3-4 option choice justified and safe.** Grep confirms `RefundModal` is imported only by `PosTerminal.vue:808` and mounted only at `:587` without `:is-paid`; admin `Orders.vue` uses a separate inline modal. Removing `isPaid`/`refundMethod` cannot affect the sole caller. No jsdom/`@vue/test-utils` exists, so a DOM-mount test (option b) is infeasible without new infra; the source-structural spec runs in the existing `environment: 'node'` config under the `src/**/*.spec.js` glob and provides a real red→green.
- **Residual (out of scope, note for owner):** if a future caller ever needs an in-POS *paid* refund UI, re-introduce it via option (b) (load lines from `api/admin/order_details`) with proper component-test infra, rather than resurrecting the removed branch. Also, the second cap `amountRefunded > remainingTotal` (tax-inclusive) is left as-is — P3-3 only reconciles the subtotal clamp per the finding scope.

## Cross-plan file overlap

- **`backend/routes/pos/refunds.js` — shared with Plan 6 (void-permission-model).** This plan edits the money/query region: the order-lines load (~L70, Task 1) and the over-refund cap + `refund_items` build (~L179-226, Tasks 2-3). Plan 6's P3-2 adds a `pos.void_printed` permission gate at the **top-of-handler** (~L14-62), a disjoint region. There is no line overlap, but both plans touch the same file — **do not run them in parallel on the same working tree.** Recommended sequencing: land this plan (money correctness) first, then Plan 6 (permission gate), or vice-versa; either way re-run `npx vitest run backend/tests/integration/refunds.test.js` after each task in both plans and resolve any import/context drift before committing.
- **`backend/tests/integration/refunds.test.js` — shared with Plan 6.** Both plans append cases to the same top-level `describe`. Append-only additions rarely conflict; if both are in flight, rebase the later plan's new cases onto the earlier plan's committed file rather than force-merging.
- **`src/components/pos/RefundModal.vue` — this plan only** (Plan 6 does not touch it). No cross-plan conflict on the frontend change.
