# POS Calculation Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confirmed bill-split money-loss hole and the surrounding POS calculation weaknesses found in the 2026-07-05 audit, then document (but defer) the display-unification future-proofing so no context is lost.

**Architecture:** The backend (`backend/services/PosCalculator.js` + `backend/routes/pos/helpers.js`) is already the single calculation authority for register checkout and table-save. This plan extends that same authority to the one path that skips it — the bill-split endpoint — and adds an audit trail + customer-facing correctness. No new abstractions; every fix reuses existing helpers. Future-proofing (FE display unification) is documented as deferred phases with guardrails, not executed here.

**Tech Stack:** Node.js/Express backend, MySQL (mysql2 pool), Vitest (`npx vitest run`) for unit + integration tests, Vue 3 SFCs (frontend, display only).

## Global Constraints

- **Scope = POS register + tables workflows only.** Do NOT touch admin UI, admin reports, admin settings, inventory admin, or unrelated accounting.
- **Test runner is Vitest:** `npx vitest run <file>` — never `npx jest` (false failures — see project memory).
- **Money rounding:** the only rounder is `roundMoney` (2-dp, half-up, `+Number.EPSILON`) in `PosCalculator.js:12`; per-line `tax_amount` persists at DECIMAL(10,6); roll up then round once — never chain-round.
- **Atomic-audit policy:** any `audit_events` insert for a destructive/financial op MUST run inside the same transaction via `await conn.query(...)` before `conn.commit()`, so an audit failure rolls the whole op back. Never fire-and-forget `pool.query` after commit.
- **Backend stays authoritative:** the frontend is display-only. Never make a persisted/charged value depend on a client-computed number.
- **No behavior change without a failing test first (TDD).** Small commits, one per task.
- Reference audit: `docs/superpowers/plans/2026-07-05-pos-calculation-audit.md` (findings S1, F1–F12).
- **Security-test doctrine:** a fix for a money bug is not proven by a rejection test alone. Every security task MUST also include a *success-path* test that asserts the **persisted and/or settled value** (e.g. the price stored in `held_orders.cart_data`, or the amount charged at settle) — not just the HTTP status. Validate the same object you persist; persist the same object you settle.

---

## Phase / File map

| Phase | Finding | Files touched | Risk |
|---|---|---|---|
| **PART A — security & correctness (do now)** | | | |
| 1 | S1 + F2 | `backend/routes/pos/tables.js` | low (split endpoint only) |
| 2 | F4 + F10 | `backend/routes/pos/tables.js` | low |
| 3 | F3 | `backend/routes/pos/helpers.js`, `backend/routes/pos/checkout.js`, `backend/routes/pos/tables.js` | low |
| 4 | F1 | `src/utils/receiptLineTotals.js`, `src/components/TableSplits.vue` | low (FE display) |
| **PART B — test fidelity + guard hardening (do now; 4 commits 5a–5d)** | | | |
| 5a | F12 | `backend/tests/fixtures/seed.js` (full money-column diff) | none (fixture) |
| 5b | discount guards | `backend/services/PosCalculator.js` + `backend/routes/pos/tables.js` (status fix) + checkout/tables tests | low (validation → 400) |
| 5c | svc-charge forgery | `backend/tests/integration/checkout.test.js` | none (tests) |
| 5d | held tamper | `backend/tests/integration/checkout.test.js` (+ seed modifier product) | none (tests) |
| **PART C — future-proofing (DEFERRED — documented, do NOT start until A+B merged & reviewed)** | | | |
| 6 | F5, F6, F7 | `assets/js/composables/stores/orderSessionStore.js`, `src/components/pos/ReceiptPreviewModal.vue`, `src/components/TableSplits.vue` | medium (display) |
| 7 | unification | `assets/js/composables/**`, `src/utils/receiptLineTotals.js` | medium (display, big DRY) |
| 8 | naming | POS FE + docs | low churn |

---

# Part A — Post-Review Corrections (BLOCKER: apply before ANY merge)

> Codex reviewed Gemini's executed Part A (commits on this branch) and found the S1/F2 fix
> **incomplete**. The split endpoint pins/validates `normalizedItems` but still **persists the
> raw `seat.items`** (`tables.js:2124-2125`), and split settle freezes prices from that stored
> blob (`checkout.js:399`). So a single honest-looking seat (`subtotal: 10.00`) carrying
> `price: 0.50` items passes validation, voids the parent, and settles at 0.50 — money lost, no
> phantom needed. Root cause was a plan defect: Task 1 mutated one object (`normalizedItems`)
> but persistence + downstream read another (`seat.items`). These corrections MUST land before
> merge. Do NOT treat Part A as done until C1–C3 are green.

## Correction C1 (P0 — completes S1/F2): persist the pinned items, not the raw client items

**Files:** Modify `backend/routes/pos/tables.js` (persist loop ~2120-2141). Test: `backend/tests/integration/tables.test.js`.

- [ ] **Step 1: Write the failing regression test** (success path — asserts the *stored* price):

```javascript
it('S1/F2: an accepted single-seat split persists the PARENT price, never the forged item price', async () => {
    const invoiceId = await createTableOrder(
        adminCookie, SEED.table.id,
        [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
        10.00, 1.60, 11.60
    );
    // One seat, all items, HONEST declared subtotal (10.00) but forged item price 0.50.
    const res = await request(app)
        .post('/api/pos/table_splits/split')
        .set('Cookie', adminCookie)
        .send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [
                { referenceName: 'Seat 1', subtotal: 10.00, items: [{ id: SEED.product1.id, qty: 2, price: 0.50, tax_rate: 16 }] }
            ]
        });
    expect(res.statusCode).toBe(200); // pinning corrects the price, so this is a valid split
    const [held] = await pool.query("SELECT cart_data FROM held_orders ORDER BY id DESC LIMIT 1");
    const cart = JSON.parse(held[0].cart_data);
    // The stored price MUST be the parent price, not the forged 0.50 — otherwise settle charges 0.50.
    expect(Number(cart.items[0].price)).toBe(Number(SEED.product1.price));
});
```

- [ ] **Step 2: Run it and confirm it FAILS** — `npx vitest run backend/tests/integration/tables.test.js -t "persists the PARENT price"` → FAIL (stored price is 0.50).

- [ ] **Step 3: Persist the normalized (pinned) items.** In the persist loop (`tables.js:2124`), change:

```javascript
            const cartPayload = {
                items: normalizedItems,   // was: seat.items — persist the pinned/validated items so settle can't freeze a forged price
                order_discount: seat.order_discount || null,
```

- [ ] **Step 4: Run the new test + the full split suite** — `npx vitest run backend/tests/integration/tables.test.js` → PASS. Confirm existing split→restore/settle tests stay green (`normalizeCartItems` preserves `name`/`tax_rate`/`note`/`selectedModifiers` via spread, so the restore/settle shape is intact).

- [ ] **Step 5: Commit** — `git commit -m "fix(pos): persist pinned split items so settle cannot freeze a forged price (P0/S1)"`

## Correction C2 (P1): key split conservation + pinning by a stable line identity

**Files:** Modify `backend/routes/pos/tables.js` (key + maps ~1955-2025). Test: `backend/tests/integration/tables.test.js`.

**Problem:** `itemKey = productId|note` collapses two parent lines that share product+note but differ in `price_at_sale` (manual override on one line, or a menu-price change between two adds). Both seat lines then pin to `parentPriceByKey`'s first price → legit split rejected or mis-priced.

**Approach (no new client trust):** the recall payload already carries `order_item_id` per line (`orderSessionStore.js:1596`). Build `parentPriceById`/`parentTaxById` from `order_items.id`, and when a seat line carries a valid `order_item_id` that maps to a parent line of this order, pin by id (exact price). Fall back to the `productId|note` key only when no id is present. Reject a seat line whose `order_item_id` is non-null but does not belong to the parent order (anti-forgery).

- [ ] **Step 1: Write a failing test** — parent with the same product on two lines at different prices (set one via a direct `order_items` update to simulate a price-override), split them into two seats, assert the split is **accepted** and each stored seat line keeps its own parent price. (See existing frozen-price test at `tables.test.js:2553` for the update-price-then-split pattern.)
- [ ] **Step 2: Run → FAIL** (today it rejects or mis-pins).
- [ ] **Step 3: Implement id-based keying** (prefer `order_item_id`; validate membership; fall back to `productId|note`). Keep the change inside the split endpoint only.
- [ ] **Step 4: Run split suite → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "fix(pos): key split pinning by parent line id to handle duplicate modifier/override lines (P1)"`

> Priority: lower than C1/C3. If the FE does not in fact send `order_item_id` inside `seat.items`, STOP and report — do not invent an identity. (Confirm first by logging a real split payload.)

## Correction C3 (P2): real "service charge ENABLED + forged fee" test

**Files:** Test only — `backend/tests/integration/tables.test.js` (replace/augment the current F4 test at ~342). Requires C1.

- [ ] **Step 1: Write the intended test** (service charge stays ENABLED; assert the forged fee is corrected to the parent fee in the stored blob):

```javascript
it('F4 (corrected): with service charge ENABLED, a forged seat fee is pinned to the parent fee, not persisted forged', async () => {
    await pool.query("UPDATE settings SET setting_value = '1'  WHERE setting_key = 'service_charge_enabled'");
    await pool.query("UPDATE settings SET setting_value = '10' WHERE setting_key = 'service_charge_percentage'");

    const invoiceId = await createTableOrder(
        adminCookie, SEED.table.id,
        [
            { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
            { id: null, name: '10% Service Charge', qty: 1, price: 0.50, tax_rate: 0, note: 'Auto-Gratuity' }
        ],
        5.50, 0.80, 6.30
    );

    const res = await request(app)
        .post('/api/pos/table_splits/split')
        .set('Cookie', adminCookie)
        .send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [{
                referenceName: 'Seat 1', subtotal: 5.50,
                items: [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 },
                    { id: null, name: '10% Service Charge', qty: 1, price: 1.30, tax_rate: 0, note: 'Auto-Gratuity' } // forged
                ]
            }]
        });

    expect(res.statusCode).toBe(200);
    const [held] = await pool.query("SELECT cart_data FROM held_orders ORDER BY id DESC LIMIT 1");
    const fee = JSON.parse(held[0].cart_data).items.find(i => i.note === 'Auto-Gratuity');
    expect(Number(fee.price)).toBe(0.50); // corrected to parent fee; forged 1.30 discarded
});
```

- [ ] **Step 2: Run → PASS only after C1** (before C1 the stored fee is the forged 1.30). Remove/replace the old disabled-service-charge F4 test so the suite exercises the amount branch.
- [ ] **Step 3: Commit** — `git commit -m "test(pos): service-charge split test exercises enabled+forged path and asserts stored fee (P2)"`

## Execution lessons (apply to every future task and plan)

- **L1 — Guard the value where it is persisted AND consumed, not only where it is validated.** Trace input → normalize → validate → persist → settle. A fix that stops at validation is incomplete.
- **L2 — When normalization creates new objects, those objects must flow to persistence.** Never let the raw client object outlive validation (this is exactly what caused P0).
- **L3 — A security test asserts the attack's end effect on the SUCCESS path** (stored/charged value), not just that bad input returns 4xx.
- **L4 — Specify tests exactly for lower agents** (precise setup + precise assertion) and forbid toggling settings/inputs that dodge the intended branch (P2).
- **L5 — Conservation/identity keys must be stable IDs, not derived strings that can collide** (P1).
- **L6 — Review against intent, not "tests are green."** Green tests missed P0/P2; a reviewer reading the diff against the plan's purpose caught them.
- **L7 — An identity/keying fix must be applied EVERYWHERE that identity is re-derived, not just at the point of discovery.** C2 keyed the split *endpoint* by `order_item_id`, but settlement (`checkout.js`) re-derived line identity by `product|note` and re-collapsed duplicate lines (the P1 twin). When you change a key, grep the whole lifecycle (validate → persist → **restore/settle**) for the OLD weak key and fix every occurrence. Corrective **C4** commit `7cb2554`.
- **L8 — For a money bug, tests must reach the persisted PAID total, not an intermediate store.** The P0/P2/C2 tests stopped at `held_orders.cart_data`; the settle collapse survived because nothing exercised split → pay → `orders.subtotal`. End money-path tests at the charged/persisted amount.
- **L9 — Introducing a client-controlled identity that selects a server value is a trust boundary.** Correction **C5** (commit after `7cb2554`) added `order_item_id`-keyed frozen prices; trusting that id let a client point two lines at one cheap id (price-line swap) to pay 2.00 not 6.00 (found by automated security review). A client identity must be validated (exists in this order, product/note match) AND consumed against the saved line's quantity so it can't be reused.
- **L10 — When a security test shows the attack "blocked," confirm WHICH guard blocked it.** The swap was first stopped only by an incidental "Subtotal mismatch" (DB reprice) that a price-override manager would bypass. Assert the specific guard's status/message (here: `403`), not just "not charged."
- **L11 — Know the per-path data flow before testing the surface.** Split settle rebuilds the cart from the server-stored held row (`checkout.js:227 data.cart = splitHeldPayload.items`), so the client cart is ignored there — the swap is only reachable on the unpaid-table cashout path. I wasted a cycle attacking split settle (cart discarded) before retargeting.

---

# PART A — Security & Correctness

## Task 1: Fix bill-split phantom-seat money loss (S1 + F2)

**Files:**
- Modify: `backend/routes/pos/tables.js` (split endpoint, ~1945–2011)
- Test: `backend/tests/integration/tables.test.js` (add to the `Bill Split Calculations & Seat Totals` describe block)

**Interfaces:**
- Consumes existing in-scope helpers already imported in `tables.js`: `normalizeCartItems`, `fetchCartProducts`, `calculateExpectedTotals`, and the local `itemKey(productId, itemName, note)` defined at `tables.js:1945`.
- Produces: no new exported symbols. Behavior change: `POST /api/pos/table_splits/split` now rejects (400) item-less seats and any seat priced off the parent order.

**Root cause (confirmed by audit probe):** `seatSum` (`tables.js:1937`) counts the client-declared `subtotal` of every split, but item-less seats are skipped by both per-seat validation (`1992`) and persistence (`2072`); and seat item prices are never re-pinned to the parent. So a phantom `items:[]` seat pads the reconciliation while real seats are underpriced (down to `0`).

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/integration/tables.test.js` inside the `describe('Bill Split Calculations & Seat Totals', ...)` block:

```javascript
it('S1: rejects a split with a phantom item-less seat padding the reconciliation', async () => {
    // Parent: 2x product1 @5.00, 16% tax => subtotal 10.00, tax 1.60, total 11.60
    const invoiceId = await createTableOrder(
        adminCookie, SEED.table.id,
        [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
        10.00, 1.60, 11.60
    );

    const res = await request(app)
        .post('/api/pos/table_splits/split')
        .set('Cookie', adminCookie)
        .send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [
                { referenceName: 'Real',    subtotal: 1.00, items: [{ id: SEED.product1.id, qty: 2, price: 0.50, tax_rate: 16 }] },
                { referenceName: 'Phantom', subtotal: 9.00, items: [] }
            ]
        });

    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);

    // No held checks created, parent NOT voided (transaction rolled back).
    const [held] = await pool.query("SELECT id FROM held_orders");
    expect(held).toHaveLength(0);
    const [[parent]] = await pool.query("SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]);
    expect(parent.payment_method).toBe('unpaid_table');
});

it('S1: rejects a phantom-seat split even when the real seat is priced at 0', async () => {
    const invoiceId = await createTableOrder(
        adminCookie, SEED.table.id,
        [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
        10.00, 1.60, 11.60
    );

    const res = await request(app)
        .post('/api/pos/table_splits/split')
        .set('Cookie', adminCookie)
        .send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [
                { referenceName: 'Real',    subtotal: 0.00, items: [{ id: SEED.product1.id, qty: 2, price: 0.00, tax_rate: 16 }] },
                { referenceName: 'Phantom', subtotal: 10.00, items: [] }
            ]
        });

    expect(res.statusCode).toBe(400);
    const [held] = await pool.query("SELECT id FROM held_orders");
    expect(held).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run backend/tests/integration/tables.test.js -t "S1:"`
Expected: FAIL — endpoint currently returns 200 and creates a held check (money lost).

- [ ] **Step 3: Implement the fix in `backend/routes/pos/tables.js`**

**3a.** Right after `normalizedSplits` is built (currently `tables.js:1948-1953`), reject item-less seats. Insert immediately after the `normalizedSplits = splits.map(...)` assignment:

```javascript
            // Every submitted seat must carry at least one item. An item-less seat with a
            // declared subtotal would pad the reconciliation sum without ever being validated
            // or persisted (S1 money-loss hole). The client never produces one.
            if (normalizedSplits.some(({ normalizedItems }) => normalizedItems.length === 0)) {
                throw new Error("Split seat mismatch: every seat must contain at least one item.");
            }
```

**3b.** Extend the parent-items query (currently `tables.js:1959-1963`) to also select the frozen price + tax, and build lookup maps. Replace that `SELECT` + the following `parentQtyByKey` loop with:

```javascript
            const [parentItems] = await conn.query(`
                SELECT product_id, item_name, note, quantity, price_at_sale, tax_rate
                FROM order_items
                WHERE invoice_id = ? AND parent_item_id IS NULL
            `, [currentOrderId]);
            const parentQtyByKey = new Map();
            const parentPriceByKey = new Map();
            const parentTaxByKey = new Map();
            for (const item of parentItems) {
                const key = itemKey(item.product_id, item.item_name, item.note);
                parentQtyByKey.set(key, (parentQtyByKey.get(key) || 0) + Number(item.quantity));
                if (!parentPriceByKey.has(key)) {
                    parentPriceByKey.set(key, Number(item.price_at_sale));
                    parentTaxByKey.set(key, Number(item.tax_rate));
                }
            }
```

**3c.** Pin every seat line to the parent's captured price/tax, immediately BEFORE the per-seat recompute loop (currently `tables.js:1991`, `for (const { seat, normalizedItems } of normalizedSplits) {`). Insert:

```javascript
            // Pin each seat line to the price/tax captured on the parent order. A seat may not
            // be charged less (or more) than the saved table order for the same item; only the
            // distribution across seats is the caller's choice. Mirrors checkout.js frozen-price
            // settle. Closes S1 (underpricing) + F2 (per-seat prices unpinned).
            for (const { normalizedItems } of normalizedSplits) {
                for (const item of normalizedItems) {
                    const key = itemKey(item.product_id, item.item_name || item.name, item.note);
                    if (parentPriceByKey.has(key)) {
                        item.price = parentPriceByKey.get(key);
                        if (item.product_id == null) item.tax_rate = parentTaxByKey.get(key);
                    }
                }
            }
```

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `npx vitest run backend/tests/integration/tables.test.js -t "S1:"`
Expected: PASS (both return 400, no held rows, parent untouched).

- [ ] **Step 5: Run the full split suite to verify no regression**

Run: `npx vitest run backend/tests/integration/tables.test.js`
Expected: PASS — the legitimate split tests (equal seats at DB price, P2-3 distributed discount, frozen-price-after-menu-change) stay green because pinning overwrites correctly-priced seats with the identical value.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(pos): reject phantom split seats and pin seat prices to parent (S1/F2)"
```

---

## Task 2: Split endpoint completeness — service-charge validation + unambiguous reconciliation (F4 + F10)

**Files:**
- Modify: `backend/routes/pos/tables.js` (split endpoint: settings load ~1861, aggregate reconciliation ~1937–1943, per-seat loop ~1991–2011)
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**
- Consumes: `getSettings(conn, keys)`, `assertServiceChargeValid(cartItems, { enabled, percentage, taxRate })`, `assertNearMoney(label, submitted, expected)` — all already imported in `tables.js`.
- Produces: no new symbols. Behavior: split now validates any Auto-Gratuity seat line and reconciles the seat sum against the parent using a single server-computed anchor.

- [ ] **Step 1: Write the failing tests**

```javascript
it('F4: rejects a split seat carrying a forged Auto-Gratuity fee', async () => {
    // Parent already carries a valid 10% service charge line (created via table_order).
    const invoiceId = await createTableOrder(
        adminCookie, SEED.table.id,
        [
            { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
            { id: null, name: '10% Service Charge', qty: 1, price: 0.50, tax_rate: 0, note: 'Auto-Gratuity' }
        ],
        5.50, 0.80, 6.30
    );

    // Split into one seat but inflate the fee line to 5.00.
    const res = await request(app)
        .post('/api/pos/table_splits/split')
        .set('Cookie', adminCookie)
        .send({
            tableId: SEED.table.id,
            currentOrderId: invoiceId,
            splits: [{
                referenceName: 'Seat 1', subtotal: 10.00,
                items: [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 },
                    { id: null, name: '10% Service Charge', qty: 1, price: 5.00, tax_rate: 0, note: 'Auto-Gratuity' }
                ]
            }]
        });

    expect(res.statusCode).toBe(400);
});
```

> Note: if `createTableOrder` cannot seed a service-charge line directly (permission/shape), build the parent order via `POST /api/pos/table_order` with the fee line and adjust totals to whatever the endpoint returns; the assertion that matters is the 400 on the forged split.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/integration/tables.test.js -t "F4:"`
Expected: FAIL — split currently ignores the fee line (200).

- [ ] **Step 3: Implement — load settings + validate + server-side reconciliation**

**3a.** Extend the settings load (currently `tables.js:1861`) to include the service-charge keys:

```javascript
        const checkoutSettings = await getSettings(conn, ['stock_enabled', 'tax_inclusive_pricing', 'service_charge_enabled', 'service_charge_percentage', 'service_charge_tax_rate']);
        const stockEnabled = checkoutSettings.stock_enabled === '1';
        const taxInclusivePricing = checkoutSettings.tax_inclusive_pricing === '1';
        const serviceChargeEnabledSetting = checkoutSettings.service_charge_enabled === '1';
        const serviceChargePct = parseFloat(checkoutSettings.service_charge_percentage || '10');
        const serviceChargeTax = parseFloat(checkoutSettings.service_charge_tax_rate || '0');
```

**3b.** Inside the per-seat loop (currently `tables.js:1991-2011`), after `calculateExpectedTotals(...)` yields `seatTotals`, validate any fee line and accumulate a server-side net sum. Replace the per-seat body with:

```javascript
            let serverSeatNetSum = 0;
            for (const { seat, normalizedItems } of normalizedSplits) {
                const seatDiscount = seat.order_discount || {};
                const seatTotals = calculateExpectedTotals(
                    {
                        order_discount_type: seatDiscount.type || null,
                        order_discount_value: Number(seatDiscount.value) || 0
                    },
                    normalizedItems,
                    splitProductMap,
                    taxInclusivePricing
                );

                // Validate a seat-level Auto-Gratuity line against settings (F4). Prices are
                // already pinned to the parent (Task 1), so this catches a settings-drift or
                // disabled-service-charge case; it fails closed on a non-finite fee tax_rate.
                assertServiceChargeValid(normalizedItems, {
                    enabled: serviceChargeEnabledSetting,
                    percentage: serviceChargePct,
                    taxRate: serviceChargeTax
                });

                const submittedSeatSubtotal = Number(seat.subtotal);
                const matchesSeatSubtotal = Math.abs(submittedSeatSubtotal - seatTotals.subtotal) <= 0.02;
                const matchesSeatTotal = Math.abs(submittedSeatSubtotal - seatTotals.total) <= 0.02;
                if (!Number.isFinite(submittedSeatSubtotal) || (!matchesSeatSubtotal && !matchesSeatTotal)) {
                    throw new Error("Split seat subtotal mismatch. Please refresh totals and try again.");
                }
                serverSeatNetSum += seatTotals.subtotal;
            }

            // Authoritative reconciliation (F10): the sum of SERVER-computed seat net subtotals
            // must equal the parent's discounted net subtotal. This no longer trusts the client
            // seatSum and removes the net-or-total ambiguity.
            assertNearMoney('Split reconciliation', serverSeatNetSum, parentDiscountedSubtotal);
```

> The existing client-`seatSum` block at `tables.js:1937-1943` may remain as an early sanity check or be removed; the new `serverSeatNetSum` assert is the authoritative one. If removed, keep `parentDiscountedSubtotal` / `parentTotal` definitions (they're used by the assert).

- [ ] **Step 4: Run to verify pass + no regression**

Run: `npx vitest run backend/tests/integration/tables.test.js`
Expected: PASS (F4 rejects; legitimate splits still reconcile).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js
git commit -m "fix(pos): validate service charge and reconcile split seats server-side (F4/F10)"
```

---

## Task 3: Audit trail for manager price overrides (F3)

**Files:**
- Modify: `backend/routes/pos/helpers.js` (`applyDatabasePrices` ~422–445, plus export unchanged)
- Modify: `backend/routes/pos/checkout.js` (call site ~424, insert audit before commit)
- Modify: `backend/routes/pos/tables.js` (call site ~1313, insert audit before commit)
- Test: `backend/tests/integration/checkout.test.js`

**Interfaces:**
- Produces: `applyDatabasePrices(...)` now RETURNS `Array<{ product_id, base, override }>` — the lines a price-override manager set away from the DB base. Empty array when no overrides (or non-manager, since non-managers are reset to base).
- Consumes: existing `audit_events` table + in-transaction `conn`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/integration/checkout.test.js` (near the existing price-override tests):

```javascript
it('F3: records a price_override audit row when a manager sets a manual price', async () => {
    // cashierWithOverrideCookie = a user holding pos.price_override (mirror the existing
    // price-override test setup in this file for how that user/cookie is created).
    const res = await request(app)
        .post('/api/pos/checkout')
        .set('Cookie', cashierWithOverrideCookie)
        .send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 1.00 }], // DB base is 5.00
            shift_id: overrideShiftId,
            subtotal: 1.00, tax: 0.16, total: 1.16,
            payment_method: 'cash', amount_tendered: 1.16, change_due: 0.00,
            order_discount_type: null, order_discount_value: 0,
            idempotency_key: `f3_override_${Date.now()}`
        });

    expect(res.statusCode).toBe(200);

    const [audits] = await pool.query(
        "SELECT old_value, new_value FROM audit_events WHERE event_type = 'price_override' AND entity_id = ?",
        [SEED.product1.id]
    );
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0].new_value).override).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/integration/checkout.test.js -t "F3:"`
Expected: FAIL — no `price_override` audit row exists.

- [ ] **Step 3: Make `applyDatabasePrices` return overrides**

In `backend/routes/pos/helpers.js`, change `applyDatabasePrices` (currently ~422-445) to collect and return overrides:

```javascript
const applyDatabasePrices = (cartItems, productMap, user, trustClientPrices = false, savedPriceMap = null) => {
    const overrides = [];
    if (trustClientPrices) return overrides; // Table-settle: trust the frozen price_at_sale
    const isManager = canPriceOverride(user);
    const keyOf = (productId, itemName, note) =>
        `${productId != null ? productId : 'custom:' + (itemName || '')}|${note || ''}`;

    for (const item of cartItems) {
        if (item.product_id) {
            const product = productMap.get(item.product_id);
            if (!product) {
                throw new Error('One or more products in the cart no longer exist.');
            }
            const k = keyOf(item.product_id, item.item_name || item.name, item.note);
            if (savedPriceMap && savedPriceMap.has(k)) {
                continue; // Frozen price preserved
            }
            const basePrice = Number(product.price);
            const extraPrice = computeModifierSurcharge(product, item);
            const expected = Number((basePrice + extraPrice).toFixed(4));
            if (!isManager) {
                item.price = expected;
            } else if (Math.abs(Number(item.price) - expected) > 0.0001) {
                overrides.push({ product_id: item.product_id, base: expected, override: Number(item.price) });
            }
        }
    }
    return overrides;
};
```

- [ ] **Step 4: Insert the audit at both call sites (in-transaction, before commit)**

In `backend/routes/pos/checkout.js`, capture the return at the call site (currently `checkout.js:424`):

```javascript
        const priceOverrides = applyDatabasePrices(cartItems, productMap, req.user, isUnpaidTableSettle, savedPriceMap.size > 0 ? savedPriceMap : null);
```

Then, after the order + items are written and BEFORE `await conn.commit();`, add:

```javascript
        for (const ov of priceOverrides) {
            await conn.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ('price_override', ?, 'product', ?, ?, ?, ?)`,
                [req.user.id, ov.product_id, JSON.stringify({ base: ov.base }), JSON.stringify({ override: ov.override }), req.ip || null]
            );
        }
```

Apply the identical capture + insert in `backend/routes/pos/tables.js` at its `applyDatabasePrices` call (currently `tables.js:1313`), inserting the audit loop before that endpoint's `conn.commit()`.

- [ ] **Step 5: Run to verify pass + no regression**

Run: `npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js`
Expected: PASS — override now audited; existing override tests (which assert the manual price is honored) still green because the price is unchanged, only an audit row is added.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/pos/helpers.js backend/routes/pos/checkout.js backend/routes/pos/tables.js backend/tests/integration/checkout.test.js
git commit -m "feat(pos): audit manager price overrides in-transaction (F3)"
```

---

## Task 4: Split printed check shows tax + true total (F1)

**Files:**
- Modify: `src/utils/receiptLineTotals.js` (add a small pure helper)
- Modify: `src/components/TableSplits.vue` (`printCheckBill` ~392-436)
- Test: `backend/tests/unit/receiptLineTotals.test.js`

**Interfaces:**
- Produces: `splitCheckTotals(items) => { subtotal, tax, total }` in `src/utils/receiptLineTotals.js`, all numbers rounded to 2 dp. Reuses the existing `receiptItemNetTotal(item)`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/unit/receiptLineTotals.test.js`:

```javascript
import { splitCheckTotals } from '../../../src/utils/receiptLineTotals.js';

describe('splitCheckTotals', () => {
    it('sums net line totals and adds per-line tax so the check foots', () => {
        const items = [
            { qty: 1, price: 5.00, tax_rate: 16 },
            { qty: 2, price: 2.00, tax_rate: 0 }
        ];
        const t = splitCheckTotals(items);
        expect(t.subtotal).toBe(9.00);
        expect(t.tax).toBe(0.80);
        expect(t.total).toBe(9.80);
    });

    it('honours a per-line discount before taxing', () => {
        const items = [{ qty: 1, price: 10.00, tax_rate: 10, discountType: 'percent', discountValue: 50 }];
        const t = splitCheckTotals(items);
        expect(t.subtotal).toBe(5.00);
        expect(t.tax).toBe(0.50);
        expect(t.total).toBe(5.50);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/unit/receiptLineTotals.test.js -t "splitCheckTotals"`
Expected: FAIL — `splitCheckTotals` is not exported.

- [ ] **Step 3: Implement the helper in `src/utils/receiptLineTotals.js`**

Append:

```javascript
const round2 = (n) => Math.round((toNumber(n) + Number.EPSILON) * 100) / 100;

// Totals for a split-check pre-bill: net subtotal (post per-line discount), per-line tax,
// and a footing total. Display only — the charged amount is recomputed server-side at settle.
export function splitCheckTotals(items = []) {
    let subtotal = 0;
    let tax = 0;
    for (const item of items) {
        const net = receiptItemNetTotal(item);
        subtotal += net;
        tax += net * (toNumber(item.tax_rate ?? item.taxRate) / 100);
    }
    subtotal = round2(subtotal);
    tax = round2(tax);
    return { subtotal, tax, total: round2(subtotal + tax) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run backend/tests/unit/receiptLineTotals.test.js -t "splitCheckTotals"`
Expected: PASS.

- [ ] **Step 5: Use it in `src/components/TableSplits.vue`**

Import at the top of the `<script setup>` (alongside existing imports):

```javascript
import { splitCheckTotals } from '../utils/receiptLineTotals.js';
```

In `printCheckBill` (currently ~`TableSplits.vue:392-436`), compute totals from the items and replace the hard-coded `tax: 0, discount: 0, total: check.subtotal` in `printPayload`:

```javascript
        const totals = splitCheckTotals(check.items);
        // ...inside printPayload:
        subtotal: totals.subtotal,
        tax: totals.tax,
        discount: 0,
        total: totals.total,
```

- [ ] **Step 6: Verify the printed check foots (manual/e2e)**

Run the app, open a table, split it, print a seat check. Confirm the printed check now shows a Tax line and `Total = Subtotal + Tax`, matching what settle will charge. (No automated print test exists; this is a visual confirmation per the `verify` workflow.)

- [ ] **Step 7: Commit**

```bash
git add src/utils/receiptLineTotals.js src/components/TableSplits.vue backend/tests/unit/receiptLineTotals.test.js
git commit -m "fix(pos): split printed check shows tax and true total (F1)"
```

---

# PART B — Test Fidelity (revised 2026-07-06 after review)

> **Revision note.** Part B was tightened per owner review + the L1–L11 lessons. Split into
> **four independent commits** (5a–5d). Two verified facts drive the changes:
> 1. **Discount validation returns inconsistent status codes.** A probe (2026-07-06) showed:
>    `checkout` order/line **negative** → `400` with the specific message; order/line **>100%** →
>    generic **500**; **every** `/table_order` discount validation → generic **500**. Root cause:
>    the checkout error remap (`checkout.js:862-870`) whitelists `negative` but not `exceed`/`100%`,
>    and the `/table_order` handler doesn't map these at all. So **5b includes a small backend fix**
>    so the guard fails **closed with a specific 400** — otherwise a test asserting `400` would fail,
>    or (worse, per **L10**) pass for the wrong reason (a subtotal mismatch, not the discount guard).
> 2. **Fixture precision must be diffed against the whole production schema**, not two named columns.

**Verified production money columns to diff against (`production-sync-2026-06-27.sql` + migrations):**
- `DECIMAL(10,6)`: `products.price`, `price_history.old_price`, `price_history.new_price`,
  `order_items.price_at_sale`, `order_items.tax_amount`, `refund_items.unit_price`.
- `DECIMAL(10,3)`: `order_items.quantity`, `refund_items.quantity`, `orders.original_total`,
  `orders.original_subtotal`, `orders.original_tax`, `product_bundle_items.qty`.
- `DECIMAL(10,2)`: `orders.{subtotal,tax,total,discount_value,amount_tendered,cash_amount,card_amount,change_due}`,
  `order_items.{tax_rate,discount_value}`, `products.tax_rate` is `DECIMAL(5,2)`, `held_orders.subtotal`,
  `refunds.{subtotal_refunded,tax_refunded,amount_refunded}`, `refund_items.{line_subtotal,line_tax,line_total}`.

### Part B — Review corrections (2026-07-06, Codex + self-review) — READ BEFORE EXECUTING

Two review rounds. All four Codex findings confirmed, plus two actor/permission findings that
would otherwise make a test pass or fail **for the wrong reason** (L10). Apply these while doing 5a–5d.

**Actor matrix.** `checkout.test.js` sets up only `cashierCookie` + `openShift()` (no admin). Seed
cashier (id 2) has `can_apply_discount = 0` and NO service-charge permission; admin (id 1) bypasses
both gates. `SEED.adminUser` exists — add an admin login in `checkout.test.js` setup and use per row:

| Test | Actor | Why |
|---|---|---|
| line discount negative / >100% (checkout) | cashier + shift | validated in `normalizeCartItems` (checkout.js:308) BEFORE the discount permission gate (338) |
| order discount negative (checkout) | cashier + shift | `hasDiscountsInPayload` is false for value ≤ 0 → gate skipped, reaches `normalizeDiscount` |
| **order discount >100% (checkout)** | **admin** | positive value → discount permission gate fires first; cashier → **403 "Manager PIN required"**, never reaches the value check |
| all discount cases (table_order) | **admin** | tables.test.js already uses admin; sidesteps the gate |
| **service-charge forgery (checkout)** | **admin** | cashier lacks `canApplyServiceCharge` → **403** before `assertServiceChargeValid` |
| **held-order tamper reprice (5d)** | **cashier (id 2)** | MUST be a NON-`pos.price_override` user — admin/price-override TRUST the client price (`applyDatabasePrices`), so the tamper would NOT reprice and the test would falsely pass |

Admin checkout may pass `shift_id: null` (admins are shift-exempt) or open an admin shift.

**5b — make the table discount matrix explicit (all 4, not 2):** order-negative, order->100%,
line-negative-fixed, line->100% against `/table_order` (admin), each asserting `400` + the specific message.

**5b — statusCode-fix blast radius:** `normalizeDiscount` is reached via `calculateExpectedTotals`
**directly** in `checkout.js`, `tables.js`, and `backend/routes/print.js:217` (receipt discount display);
`refunds.js` reaches it only **indirectly** via `recomputeOrderTotals` (helpers) on already-valid saved
order data. Attaching `statusCode 400` only changes the HTTP status of an already-thrown validation
error — safe on all paths (none throw on valid discounts); run the FULL suite to confirm.

**5d — real hold shape + claim flow (Codex P1/P2):** the FE holds `cart: { items:[...], order_discount,
customer_* }` (an OBJECT — `orderSessionStore.js:1076`; existing `heldOrders.test.js` `createHold` uses
`{ items:[...] }`), NOT a raw array. Do the held-tamper in **`checkout.test.js`** (has `openShift()` +
per-test seed isolation; `heldOrders.test.js` uses `beforeAll` and opens no shift). Flow:
`POST /held_orders {cart:{items:[...]}}` → `POST /held_orders/claim {id}` → parse `cart_data.items` →
`POST /checkout` with those items + `cashierShiftId` → assert persisted `orders.subtotal` = DB base
(+ DB modifier surcharge for the modifier case).

**Cash tender rule (applies to EVERY cash checkout test):** the payment validator asserts
`change_due ≈ amount_tendered - total` (`helpers.js:478`). Use **exact tender** — set
`amount_tendered` to the `total` and `change_due: 0`. `amount_tendered: 100, change_due: 0` will be
rejected with "Change due mismatch" for any total ≠ 100. (5b/5c already tender exactly; 5d must too.)

**Minor:** use static-unique `idempotency_key`s per test (not `Date.now()` — `checkout.test.js` toggles
fake timers via `vi.useRealTimers()` in afterEach, so `Date.now()` can repeat).

---

## Task 5a: Fixture money precision — full schema diff (F12)

**Files:** Modify `backend/tests/fixtures/seed.js`. Test: full suite.

- [ ] **Step 1: Diff EVERY money column in `seed.js` against the production list above.** Do not stop at the two known ones. For each `CREATE TABLE` in `seed.js` that has a production counterpart, compare the type/precision of every money-ish column (anything holding price/tax/total/subtotal/amount/discount/qty). Write down each mismatch.
- [ ] **Step 2: Fix each mismatch** so the fixture equals production. Known mismatches to start (verify, don't assume the list is exhaustive):
  - `products.price` `decimal(10,2)` → `decimal(10,6)` (`seed.js:~204`)
  - `price_history.old_price` / `new_price` `decimal(10,3)` → `decimal(10,6)`
  - Re-check `order_items.price_at_sale`, `order_items.tax_amount`, `refund_items.unit_price` are already `(10,6)`; `orders.original_*` and `refund_items.quantity` are `(10,3)`; fix any that drifted.
- [ ] **Step 3: Run the full suite** — `npx vitest run` → PASS (no test relied on coarser precision).
- [ ] **Step 4: Commit** — `git commit -m "test(pos): match all fixture money columns to production precision (F12)"`

## Task 5b: Discount HTTP guards — fail closed with a specific 400 (order + line, both routes)

**Files:** Modify `backend/services/PosCalculator.js` (attach status to validation errors). Verify/adjust the `/table_order` error handler in `backend/routes/pos/tables.js`. Tests: `backend/tests/integration/checkout.test.js`, `backend/tests/integration/tables.test.js`.

- [ ] **Step 1: Write failing tests that assert the SPECIFIC guard (not just 400).** Cover order-level AND line-level, negative AND >100%, on BOTH `/checkout` and `/table_order`. Assert both the status (`400`) and the message, so a subtotal mismatch can't make them pass:

```javascript
// checkout — order level
it('rejects a negative order discount with a specific 400', async () => {
    await openShift();  // cashier: value <= 0 skips the discount permission gate, reaches normalizeDiscount
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
        cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
        shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
        payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
        order_discount_type: 'fixed', order_discount_value: -5, idempotency_key: 'disc_ord_neg'
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/discount cannot be negative/i);
});
it('rejects an order discount over 100% with a specific 400', async () => {
    // ADMIN: a positive discount hits the permission gate first — cashier would get 403 here, not the value error
    const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
        cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
        shift_id: null, subtotal: 5.00, tax: 0.80, total: 5.80,   // admin is shift-exempt
        payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
        order_discount_type: 'percent', order_discount_value: 150, idempotency_key: 'disc_ord_over'
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/cannot exceed 100/i);
});
// checkout — line level (negative fixed, percent > 100)
it('rejects a negative line discount with a specific 400', async () => {
    await openShift();  // cashier: line discounts are validated in normalizeCartItems BEFORE the permission gate
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
        cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: 'fixed', discountValue: -5 }],
        shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
        payment_method: 'cash', amount_tendered: 5.80, change_due: 0, idempotency_key: 'disc_line_neg'
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/discount cannot be negative/i);
});
it('rejects a line discount over 100% with a specific 400', async () => {
    await openShift();  // cashier: line discounts validated in normalizeCartItems BEFORE the permission gate
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
        cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: 'percent', discountValue: 150 }],
        shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
        payment_method: 'cash', amount_tendered: 5.80, change_due: 0, idempotency_key: 'disc_line_over'
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/cannot exceed 100/i);
});
```
**Setup:** add an admin login to `checkout.test.js` (`adminCookie = <login SEED.adminUser.user_number>`) — the order->100% case needs it; the cashier cases call `openShift()`.

**All FOUR `/table_order` cases** — put these in `tables.test.js` (already logs in admin; admin bypasses the discount gate). Shape `{ table_id: SEED.table.id, cart, subtotal, tax, total, order_discount_type, order_discount_value }`, each asserting `400` + the specific message:
1. order negative — `order_discount_type: 'fixed', order_discount_value: -5` → `/discount cannot be negative/`
2. order >100% — `order_discount_type: 'percent', order_discount_value: 150` → `/cannot exceed 100/`
3. line negative fixed — cart item `discountType: 'fixed', discountValue: -5` → `/discount cannot be negative/`
4. line >100% — cart item `discountType: 'percent', discountValue: 150` → `/cannot exceed 100/`

- [ ] **Step 2: Run → confirm the >100% and all table_order cases FAIL** (currently generic `500`), proving the tests exercise the real guard, not a mismatch.

- [ ] **Step 3: Make the discount validation fail closed with a specific 400.** In `backend/services/PosCalculator.js` `normalizeDiscount` (lines ~16-19), attach `statusCode` to the thrown errors so both route handlers surface a client error and the message survives sanitization:

```javascript
const normalizeDiscount = (type, value, label) => {
    const normalizedType = type === 'fixed' || type === 'percent' ? type : null;
    const normalizedValue = toFiniteNumber(value, 0);
    const bad = (msg) => { const e = new Error(`${label} ${msg}`); e.statusCode = 400; return e; };
    if (normalizedValue < 0) throw bad('cannot be negative.');
    if (normalizedValue > 0 && !normalizedType) throw bad('type is invalid.');
    if (normalizedType === 'percent' && normalizedValue > 100) throw bad('cannot exceed 100%.');
    return { type: normalizedType, value: normalizedValue };
};
```

- [ ] **Step 4: Verify the `/table_order` handler surfaces `statusCode` + the message.** The table catch at `tables.js:~555-560` uses `err.statusCode || 500` and passes `err.message` for non-prod/non-DB, so attaching `statusCode` should be enough — but the `POST /table_order` handler is a separate try/catch further down; confirm it does the same. If it sanitizes 4xx messages to a generic string, adjust it to pass through the specific message for `statusCode < 500` (do NOT loosen 500/DB-error sanitization). Re-run the probe-style tests to confirm `400` + specific message on BOTH routes.

- [ ] **Step 5: Run the discount tests + full checkout/tables suites** → PASS. `npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js`

- [ ] **Step 6: Commit** — `git commit -m "fix(pos): discount validation fails closed with specific 400 on both routes + tests"`

## Task 5c: Service-charge forgery on the checkout path (enabled setting, specific rejection)

**Files:** Test: `backend/tests/integration/checkout.test.js`.

- [ ] **Step 1: Write the test with service charge ENABLED and assert the SPECIFIC service-charge rejection** (not the disabled/settings path — that was the P2 mistake). The checkout path calls `assertServiceChargeValid` (`checkout.js:328`); a wrong fee amount raises `assertNearMoney('Service charge', ...)` → message contains "Service charge" and "mismatch" (→ `400`).

```javascript
it('rejects a qty-inflated Auto-Gratuity fee at checkout (service charge enabled)', async () => {
    await pool.query("UPDATE settings SET setting_value = '1'  WHERE setting_key = 'service_charge_enabled'");
    await pool.query("UPDATE settings SET setting_value = '10' WHERE setting_key = 'service_charge_percentage'");
    // Base item 5.00 → correct fee 0.50; forge qty 10 so the fee line-total is 5.00.
    // ADMIN required: cashier lacks the service-charge permission → 403 before the amount guard.
    const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
        cart: [
            { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
            { id: null, name: '10% Service Charge', note: 'Auto-Gratuity', qty: 10, price: 0.50, tax_rate: 0 }
        ],
        shift_id: null, subtotal: 10.00, tax: 0.80, total: 10.80,   // admin is shift-exempt
        payment_method: 'cash', amount_tendered: 10.80, change_due: 0, idempotency_key: 'svc_forge_qty'
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/service charge/i);   // NOT /disabled/ — the amount guard fired
});
```
> Uses the same `adminCookie` added in 5b setup (admin holds the service-charge permission). Cashier would fail the permission gate first, so it cannot exercise the amount guard.

- [ ] **Step 2: Run → PASS** (`checkout.js:328` already validates; this just locks the coverage). Add a second case for a forged **second** Auto-Gratuity line hidden behind a valid one, asserting the same `/service charge/i` 400.

- [ ] **Step 3: Commit** — `git commit -m "test(pos): checkout service-charge forgery rejected with specific error (enabled path)"`

## Task 5d: Held-order tamper — base price AND priced modifier/option

**Files:** Test: `backend/tests/integration/checkout.test.js` (has `openShift()` + per-test seed isolation; do NOT use `heldOrders.test.js`, which uses `beforeAll` and opens no shift). May Modify `backend/tests/fixtures/seed.js` to add a modifier-bearing product. **Actor = cashier (id 2)** — MUST be a non-`pos.price_override` user, else the server trusts the client price and the tamper is never repriced (the test would falsely pass).

- [ ] **Step 1: Ensure a modifier-priced product exists in the seed.** The current seed has no product with a priced `modifiers` option (grep confirmed). Add one (mirror `helpers.test.js`'s `computeModifierSurcharge` fixture shape): a product priced `5.00`, `tax_rate 16`, with `modifiers` JSON `[{ "name": "Size", "options": [{ "name": "Large", "price": 2.00 }] }]`. Expose it as `SEED.modifierProduct`.
- [ ] **Step 2: Write the base-price tamper test** (end at the persisted PAID total, per L8): hold with the real FE shape `cart: { items: [{ id: SEED.product1.id, qty: 1, price: 1.00, tax_rate: 16 }] }` (below-DB price), claim it, checkout the claimed items as cashier with the CORRECT (DB) subtotal (`5.00`, total `5.80`). Use **exact tender**: `amount_tendered: 5.00 * 1.16, change_due: 0` (cash requires `change_due ≈ amount_tendered - total`, `helpers.js:478`). Assert persisted `orders.subtotal` (by `idempotency_key`) equals the **DB** price × qty (`5.00`), proving the server repriced the tampered line.
- [ ] **Step 3: Write the modifier/option tamper test.** Hold an order for `SEED.modifierProduct` selecting the priced `Large` option, but with the client `selectedModifiers[].price` and/or the line `price` tampered below (base + option). Claim + checkout. Assert the charged `orders.subtotal` = DB base + DB option surcharge (server recomputes the surcharge from `products.modifiers`, ignoring the client option price — see `computeModifierSurcharge`). Also assert `order_items.tax_amount` reflects the correct taxed total.

```javascript
it('charges DB base + DB modifier surcharge when a held modifier line is tampered', async () => {
    await openShift();
    // Hold with the REAL FE shape (cart is an OBJECT with items[]); tamper the line price AND the option price.
    const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
        reference_name: 'tamper', subtotal: 1.00,   // client lie
        cart: { items: [{ id: SEED.modifierProduct.id, qty: 1, price: 1.00, tax_rate: 16,
                          selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.00 }] }] }
    });
    expect(held.statusCode).toBe(200);

    // Claim (register flow), then checkout the claimed items as cashier (non-price-override → server reprices).
    const claim = await request(app).post('/api/pos/held_orders/claim').set('Cookie', cashierCookie).send({ id: held.body.id });
    const items = JSON.parse(claim.body.order.cart_data).items;

    const net = 7.00; // DB base 5.00 + DB Large surcharge 2.00, taxed at 16%
    const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
        cart: items, shift_id: cashierShiftId,
        subtotal: net, tax: net * 0.16, total: net * 1.16,
        // EXACT tender: cash requires change_due ≈ amount_tendered - total (helpers.js:478).
        // Using `net * 1.16` for both amount_tendered and total makes change_due exactly 0, float-safe.
        payment_method: 'cash', amount_tendered: net * 1.16, change_due: 0, idempotency_key: 'held_mod_tamper'
    });
    expect(res.statusCode).toBe(200);
    const [[paid]] = await pool.query("SELECT invoice_id, subtotal, tax FROM orders WHERE idempotency_key = 'held_mod_tamper'");
    expect(Number(paid.subtotal)).toBe(7.00);       // recomputed base + DB surcharge, NOT client 1.00/0.00
    expect(Number(paid.tax)).toBe(1.12);            // taxed on 7.00

    // Line-level guard (stronger): the persisted line price + tax_amount must be stamped from the
    // recomputed DB base + modifier surcharge, not the client's tampered 1.00 / 0.00.
    const [[line]] = await pool.query(
        "SELECT price_at_sale, tax_amount FROM order_items WHERE invoice_id = ? AND product_id = ?",
        [paid.invoice_id, SEED.modifierProduct.id]
    );
    expect(Number(line.price_at_sale)).toBe(7.00);
    expect(Number(line.tax_amount)).toBe(1.12);
});
```
> The assertion that matters: **persisted `orders.subtotal` = server-recomputed DB base + DB option surcharge**, never the client's `1.00`/`0.00`. If the server did NOT reprice, `subtotal` would compute to `1.00` and the honest client `7.00` would raise a `400` — so this test also fails loudly if repricing regresses.

- [ ] **Step 4: Run → PASS.** `npx vitest run backend/tests/integration/checkout.test.js`
- [ ] **Step 5: Commit** — `git commit -m "test(pos): held-order tamper (base price + priced modifier) recomputes from DB"`

---

# PART C — Future-Proofing (DEFERRED)

> **Do NOT start Part C until Part A + Part B are merged and reviewed.** These are documented here so the intent and scope survive; they are display-layer / DRY improvements, not security fixes. Each must land behind a golden test proving FE preview still equals the backend-authoritative totals. Keep them small and independently revertible. If any phase starts to sprawl, stop and re-scope — no big-bang rewrites.

## Phase 6 (deferred): Display foots exactly (F5, F6, F7)

- **Goal:** The three numbers a customer sees — Subtotal, Discount, Tax — must add up to the shown Total on screen and on the receipt; line totals use one consistent net-or-gross convention.
- **Files:** `assets/js/composables/stores/orderSessionStore.js` (`cartTotal` ~281-298), `src/components/pos/ReceiptPreviewModal.vue` (~73-79), `src/components/TableSplits.vue` (~87, 176-188).
- **Approach:** derive the displayed Total from the already-rounded shown components (`shownSubtotal − shownDiscount + shownTax`) instead of re-deriving tax from raw; pick one line-total convention per document and route every line through `receiptLineTotals.js`.
- **Guardrail:** display only — do not change any value sent to an API or persisted. Add a Vitest unit test asserting `shownSubtotal − shownDiscount + shownTax === shownTotal` across a rate/qty matrix before changing anything.
- **Start condition:** Part A + B merged.

## Phase 7 (deferred): One FE preview helper mirroring the backend (unification)

- **Goal:** Collapse the scattered frontend total computeds (`orderSessionStore.js` `rawSubtotal`/`cartTax`/`cartTotal`/`getSeatTotal`/`addServiceCharge`) and `receiptLineTotals.js` into a single `posTotals(cart, opts)` that reproduces `backend/services/PosCalculator.js` exactly, so FE and BE can never drift. Display only; the server value always wins on persist.
- **Files:** `assets/js/composables/stores/orderSessionStore.js`, `src/utils/receiptLineTotals.js`, callers in `src/components/pos/*` and `src/components/*`.
- **Approach:** extract the shared formula + rounding constants into one module imported by both the store and the receipt helpers; have existing computeds delegate to it (keep their names as thin wrappers to avoid touching every call site at once).
- **Guardrail:** add a golden parity test (extend `backend/tests/unit/roundingSimulation.test.js` style) asserting `posTotals(...)` output equals `calculateExpectedTotals(...)` across thousands of carts, RED before / GREEN after. No behavior change to payloads.
- **Start condition:** Phase 6 merged. If the delegation can't be done incrementally, split into per-computed sub-tasks; do not rewrite the store in one commit.

## Phase 8 (deferred): Vocabulary alignment (naming)

- **Goal:** Remove the `subtotal`-means-two-things trap: name things `netSubtotal / discountedSubtotal / tax / grossTotal / serviceCharge / seatNetSubtotal / seatGrossTotal`; stop `TableSplits.vue` labeling a net subtotal as "Total."
- **Files:** POS FE display components + the unified helper from Phase 7; audit/plan docs.
- **Approach:** mechanical rename with the suite green after each rename; no logic change.
- **Guardrail:** rename only; one symbol group per commit; full suite green between commits.
- **Start condition:** Phase 7 merged (rename the unified helper's outputs, not N scattered copies).

---

## Self-review notes (author)

- **Spec coverage:** S1 → Task 1; F2 → Task 1; F4 → Task 2; F10 → Task 2; F3 → Task 3; F1 → Task 4; F12 + coverage gaps → Task 5; F5/F6/F7 → Phase 6; unification → Phase 7; naming → Phase 8. F8 (fractional split residue), F9 (held subtotal display), F11 (misc nits) are intentionally NOT scheduled — low value, and F8/F9 are mitigated (backend conservation / re-pricing). Note this to the reviewer; add later only if desired.
- **Type consistency:** `applyDatabasePrices` return type (`Array<{product_id,base,override}>`) is used only in Task 3 call sites; `splitCheckTotals(items) => {subtotal,tax,total}` defined and consumed in Task 4; `itemKey` reused from `tables.js:1945` in Task 1.
- **No placeholders:** every code step shows the actual code. The only non-literal step is Task 2 Step 1's note about seeding a fee line and Task 5 Steps 5-6 (mirror-an-existing-test), which reference concrete existing tests to copy.
- **Ordering:** Part A tasks are independent and individually mergeable; Task 2 assumes Task 1's price-pinning is present (same file) — keep them in order.
