# POS Calculation — Part C (Display Unification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the ~10 hand-copied money formulas into one backend authority + one mirrored frontend helper, foot every displayed receipt/panel so `Subtotal − Discount + Tax == Total`, and lock the owner-confirmed money rules — with **zero change** to any charged/persisted total.

**Architecture:** The backend `PosCalculator.js` becomes the single line-math authority (a `stampLineTax()` + `resolveTaxRate()` shared by all three write paths). A new pure ESM module `src/utils/posTotals.js` **mirrors** those formulas (not a shared module — a parity test enforces byte-identical rollups, per the Phase-7 decision). The Pinia store and every receipt/preview/split renderer delegate to that helper. Display footing is a **display-only derivation** (`Tax_shown = Total − DiscountedSubtotal`) layered on top of the unchanged canonical rollup, so `PosCalculator`'s returned values and the charged total stay identical and the existing 10k-combination rounding-parity test stays green.

**Tech Stack:** Node.js (CommonJS backend), Vue 3 + Pinia (ESM frontend, Vite bundler), Vitest (`environment: node`), MySQL. Money is `DECIMAL`; per-line `tax_amount` is `DECIMAL(10,6)`.

## Global Constraints

- Test runner is **`npx vitest run`** — NOT jest (`npx jest` gives false pool-closed failures). **Capture the current full-suite count with `npx vitest run` BEFORE Task 1** (post-B1/B2 it is ~839, but the exact number drifts — treat the pre-task run as the baseline). After every task the suite must be green at `baseline + (new tests this task added)`; do not hardcode a number.
- Communication in this repo is caveman-style per `CLAUDE.md`; keep commit messages conventional (`fix(pos):`, `refactor(pos):`, `test(pos):`, `docs(pos):`).
- **Do NOT change the `roundMoney` formula.** It is byte-identical FE/BE (`Math.round((v + Number.EPSILON) * 100) / 100`); changing the EPSILON nudge would break FE≡BE parity and re-baseline every money test. Its half-up limitation is documented, not fixed (Task 7).
- **Do NOT change any charged or persisted total.** `PosCalculator.calculateExpectedTotals` return values stay identical; server stays authoritative on persist; `MONEY_TOLERANCE = 0.02` is untouched (out of scope).
- `src/utils/posTotals.js` is authored as **ESM** (`export`) with **no Vue/DOM imports** — pure functions only. Proven importable by `backend/tests/unit/*.test.js` (see `receiptLineTotals.test.js`), by the store (relative path), and by Vite.
- Source of truth / acceptance criteria: [`docs/2026-07-06-pos-calculation-unification-map.md`](../../2026-07-06-pos-calculation-unification-map.md). Every §1 inventory row and every D1–D6 item is covered by a task, a test, or an owner-decision note (see the two matrices below).
- Owner decisions (2026-07-06, locked): **(1)** bundle children carry 0 tax, whole tax rides on parent — *keep current, lock with test*. **(2)** service charge fee = % of **pre-order-discount** goods subtotal, and the fee line rides inside the order-discount base so a percent order discount reduces it too — *keep current, lock with test*. **(3)** modifier matching stays **name-based** in Part C; stable option IDs are decomposed into their own spec+plan (Task 8).

---

## Alignment Matrix — task ↔ unification-map sections

| Task | Map §3 items | Map §5 phase | §1 inventory rows | Invariants touched |
|------|--------------|--------------|-------------------|--------------------|
| 1 — Backend single authority | D1 (BE side), D4, D6, `reconstructBundleSubs` zero-guard | BE micro-cleanup (item 3) | #1, #2, #4, #12, #13, #14 | #2 (preserved) |
| 2 — `posTotals.js` pure helper + parity test | D1 (foundation) | Phase 7 | #1, #2, #3, #12, #13 | #1 (enforced) |
| 3 — Refactor store computeds onto helper | D1 (FE side), D5 | Phase 7 | #1, #2, #3, #5, #6, #7, #8, #9(fold), #12, #13 | #1 (preserved) |
| 4 — Display footing | D2, fixed-discount overstate | Phase 6 | #4, #6, #7 | #3 (fixed) |
| 5 — Receipt/preview/split net-vs-gross | D3, `getSeatTotal` string | Phase 6/7 | #3, #10 | #4 (fixed) |
| 6 — Lock owner money rules | bundle-tax + order-discount-vs-service-charge confirms | — | #8, #14 | #2 (locked) |
| 7 — Naming / docs | `unitDiscount` rename, roundMoney-nudge note, single-formatter note | Phase 8 | #12 | — |
| 8 — Stable-option-ID follow-up spec | modifier name-match confirm | decomposition | #9 | — |

## §1 Inventory Coverage (acceptance criteria)

| Row | Formula family | Covered by |
|-----|----------------|-----------|
| #1 | Line net | Task 1 (BE), Task 2/3 (FE `lineNet`) |
| #2 | Line tax | Task 1 (`stampLineTax`), Task 2/3 (`lineTax`) |
| #3 | Line gross | Task 2/3 (`lineGross`), Task 5 (receipt display) |
| #4 | Order discount | Task 1 (D6 normalize), Task 2/3 (`orderDiscountAmount`), Task 4 (footing) |
| #5 | Subtotal / discounted subtotal | Task 2/3 (`posTotals`) |
| #6 | Tax rollup | Task 2/3 (`posTotals`) |
| #7 | Grand total | Task 2/3 (`posTotals`), Task 4 (footing) |
| #8 | Service charge fee | Task 3 (`serviceChargeFee`, D5 base unify), Task 6 (lock) |
| #9 | Modifier surcharge | Task 3 (fold into price mirrors BE), Task 8 (stable-id follow-up); name-match unchanged |
| #10 | Split allocation | Task 5 (`getSeatTotal` + split pre-bill through helper); BE reconcile stays server-authoritative |
| #11 | Payment / tender | **Out of scope** — not part of `posTotals`; unchanged (map note) |
| #12 | Rounding | Task 2/3 (one `roundMoney`); **formula change out of scope** (Task 7 documents) |
| #13 | Tax-inclusive / exempt | Task 1 (stamp gating, already B1-fixed), Task 2/3 (`opts` flags) |
| #14 | Bundle | Task 6 (lock parent-only tax), Task 1 (zero-guard) |
| #15 | Held orders | **No change** — already the target re-derive-at-settle pattern; restore path inherits the Task 3 helper |
| #16 | Refund line math | **No change** — already shares `calculateLineTotal` + stored `tax_amount` |

**Explicitly out of scope** (noted here so no §1 row is silently dropped): #11 payment/tender; #12 rounding-formula change; `MONEY_TOLERANCE` stacking + split hardcoded `0.02` constants + `distributeOrderDiscount` last-seat residue clip + split-cash unrounded revenue leg (all backend security/split-robustness — separate track); the map's `print.js:362` reference is **stale** (no such file exists; the real order-level raw-fixed-discount display is `checkout.js:52`, fixed in Task 4).

---

## File Structure

**Create:**
- `src/utils/posTotals.js` — pure ESM mirror of `PosCalculator` line/rollup math + display helpers. One responsibility: POS money math for the frontend. No Vue.
- `backend/tests/unit/posTotals.test.js` — unit tests for the pure helper.
- `backend/tests/unit/posTotalsParity.test.js` — asserts `posTotals()` ≡ `PosCalculator.calculateExpectedTotals()` across the same fuzz grid.
- `backend/tests/unit/serviceChargeRules.test.js` — Task 6 owner-rule locks (service charge).
- `docs/superpowers/specs/2026-07-06-stable-modifier-option-ids-design.md` — Task 8 follow-up spec.
- `docs/superpowers/plans/2026-07-06-stable-modifier-option-ids-plan.md` — Task 8 follow-up plan stub.

**Modify:**
- `backend/services/PosCalculator.js` — add `resolveTaxRate()`, `stampLineTax()`; export them; `calculateExpectedTotals` uses `resolveTaxRate`.
- `backend/routes/pos/checkout.js:658-667` (stamp), `:48-52` (fixed-discount display).
- `backend/routes/pos/tables.js:1489`, `:1534` (discount persistence), `:1572-1579` (stamp).
- `backend/routes/pos/helpers.js:584-597` (`recomputeOrderTotals` stamp).
- `backend/services/bundleOrderItems.js:153` (zero-guard).
- `assets/js/composables/stores/orderSessionStore.js` — computeds `rawSubtotal`, `cartOrderDiscountAmount`, `rawDiscountedSubtotal`, `cartTax`, `cartTotal`, `getItemTotal`, `getItemTotalGross`, `cartGrossSubtotal`, `getSeatTotal`, `updateServiceCharge`, `addServiceCharge`; add `displayDiscount`, `displayTax`, `getItemUnitGross` — **and add all three to the store's `return {…}` object at `orderSessionStore.js:2461`** (alongside `cartTax:2487`, `getItemTotalGross:2494`), or `storeToRefs`/the facade cannot see them.
- `assets/js/composables/useCart.js` — **the explicit facade PosTerminal reads from.** Add `displayDiscount: s.displayDiscount, displayTax: s.displayTax` to the `storeToRefs` block (near `cartTax: s.cartTax` at `:38`) and `getItemUnitGross: session.getItemUnitGross` to the actions passthrough (near `getItemTotalGross: session.getItemTotalGross` at `:87`). Without this, `PosTerminal`'s destructure of these names is `undefined` → `undefined.toFixed()` crash.
- `src/components/PosTerminal.vue` — totals panel (`:540-547`), cart-row gross (`:467-468`), product-card gross (`:318`); gross-ups must honor tax-exempt and tax-inclusive modes.
- `src/components/pos/ReceiptPreviewModal.vue` — modal line total (`:65`), modal totals block (`:74-78`), print-only thermal line total (`:166`), print-only thermal totals block (`:175-190`).
- `src/print/PrintReceiptApp.vue` — line total + totals block.
- `src/utils/receiptLineTotals.js` — add a footed `receiptTotalsBlock()` helper for the summary.
- `backend/tests/integration/bundle.tables.test.js` — add child-tax-zero assertion (Task 6).
- `docs/2026-07-06-pos-calculation-unification-map.md` — STATUS update (Task 7).

---

## Task 1: Backend single line-math authority (D1-BE, D4, D6, bundle zero-guard)

**Files:**
- Modify: `backend/services/PosCalculator.js`
- Modify: `backend/routes/pos/checkout.js:658-667`
- Modify: `backend/routes/pos/tables.js:1489`, `:1534`, `:1572-1579`
- Modify: `backend/routes/pos/helpers.js:584-597`
- Modify: `backend/services/bundleOrderItems.js:153`
- Test: `backend/tests/unit/PosCalculator.test.js` (extend)

**Interfaces:**
- Produces: `resolveTaxRate(product, fallbackRate = 0) → number` — `Number(product.tax_rate) || 0` when a product row is present, else the finite `fallbackRate`, else 0.
- Produces: `stampLineTax(item, taxRate, discountRatio = 1, taxInclusivePricing = false) → number` — `0` in inclusive mode, else `calculateLineTax(calculateLineTotal(item), taxRate, discountRatio)`. `item` must expose `{ price, qty, discountType, discountValue }`.

- [ ] **Step 1: Write the failing test** — in `backend/tests/unit/PosCalculator.test.js`, **extend the existing top-of-file `const { … } = require('../../services/PosCalculator')` destructure** to also pull `resolveTaxRate, stampLineTax` (do NOT add a second `require` line — it collides with the existing one). Then append the two describe blocks:

```javascript
// (top-of-file destructure now includes: resolveTaxRate, stampLineTax)

describe('resolveTaxRate', () => {
    it('uses product tax_rate when the product row is present', () => {
        expect(resolveTaxRate({ tax_rate: 16 }, 99)).toBe(16);
    });
    it('coalesces a NULL product tax_rate to 0 (not NaN) — the checkout D4 bug', () => {
        expect(resolveTaxRate({ tax_rate: null }, 99)).toBe(0);
    });
    it('falls back to the custom-line rate when there is no product', () => {
        expect(resolveTaxRate(null, 8)).toBe(8);
    });
    it('returns 0 for a non-finite fallback', () => {
        expect(resolveTaxRate(null, NaN)).toBe(0);
    });
});

describe('stampLineTax', () => {
    const line = { price: 10, qty: 2, discountType: null, discountValue: 0 }; // net 20
    it('stamps the exclusive per-line tax prorated by discountRatio', () => {
        expect(stampLineTax(line, 16, 0.5, false)).toBeCloseTo(1.6, 6); // 20 * 0.5 * 0.16
    });
    it('stamps 0 in tax-inclusive mode', () => {
        expect(stampLineTax(line, 16, 1, true)).toBe(0);
    });
    it('stamps 0 for a zero-rate line', () => {
        expect(stampLineTax(line, 0, 1, false)).toBe(0);
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/unit/PosCalculator.test.js`
Expected: FAIL — `resolveTaxRate is not a function` / `stampLineTax is not a function`.

- [ ] **Step 3: Implement the two helpers** in `backend/services/PosCalculator.js`. Add after `calculateLineTotal` (line 66):

```javascript
// Single tax-rate authority: a real catalog line uses the DB rate (NULL → 0); only a
// genuine custom line (no product row) falls back to its own client rate. Unifies the
// three drifted coalesces (checkout had no `|| 0` — the D4 odd-one-out that could stamp NaN).
const resolveTaxRate = (product, fallbackRate = 0) =>
    toFiniteNumber(product ? (Number(product.tax_rate) || 0) : fallbackRate, 0);

// Single per-line tax stamp shared by all three write paths (D1). Inclusive mode stamps 0
// to match the rollup tax (0); exclusive mode = calculateLineTax(calculateLineTotal(item), ...).
// `item` must expose { price, qty, discountType, discountValue }.
const stampLineTax = (item, taxRate, discountRatio = 1, taxInclusivePricing = false) =>
    taxInclusivePricing ? 0 : calculateLineTax(calculateLineTotal(item), taxRate, discountRatio);
```

Update the rollup to use `resolveTaxRate` (behaviour-identical to the current inline at `:95`) — replace line 95:

```javascript
        const taxRate = resolveTaxRate(product, item.tax_rate);
```

Add both to the `module.exports` block (after `computeModifierSurcharge`):

```javascript
    resolveTaxRate,
    stampLineTax,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run backend/tests/unit/PosCalculator.test.js`
Expected: PASS (all, including the pre-existing cases).

- [ ] **Step 5: Route the three write paths through the helpers.**

`backend/routes/pos/checkout.js` — replace lines 659-667 with:

```javascript
                const product = item.product_id ? productMap.get(item.product_id) : null;
                const taxRate = resolveTaxRate(product, item.tax_rate);
                // Tax-inclusive mode stamps 0 per line to match the rollup tax (0) — see B1.
                const taxAmount = stampLineTax(item, taxRate, discountRatio, taxInclusivePricing);
```

Add `resolveTaxRate, stampLineTax` to the `require('../../services/PosCalculator')` destructure at the top of `checkout.js` (it already imports `calculateLineTax`).

`backend/routes/pos/tables.js` — replace lines 1573-1579 with:

```javascript
                const product = item.product_id ? productMap.get(item.product_id) : null;
                const taxRate = resolveTaxRate(product, item.tax_rate);
                // Tax-inclusive mode stamps 0 per line to match the rollup tax (0) — see B1.
                const taxAmount = stampLineTax(item, taxRate, expectedTotals.discountRatio, taxInclusivePricing);
```

Add `resolveTaxRate, stampLineTax` to the PosCalculator destructure in `tables.js`.

`backend/routes/pos/helpers.js` `recomputeOrderTotals` — replace lines 586-592 with (note DB column → calculator field mapping):

```javascript
        const product = it.product_id ? productMap.get(Number(it.product_id)) : null;
        const taxRate = resolveTaxRate(product, it.tax_rate);
        const lineLike = { price: it.price_at_sale, qty: it.quantity, discountType: it.discount_type, discountValue: it.discount_value };
        // Tax-inclusive mode stamps 0 per line to match the rollup tax (0) — see B1.
        const taxAmount = stampLineTax(lineLike, taxRate, expected.discountRatio, taxInclusivePricing);
```

Add `resolveTaxRate, stampLineTax` to the PosCalculator destructure in `helpers.js`.

- [ ] **Step 6: Normalize the table-save discount persistence (D6).**

`backend/routes/pos/tables.js:1489` — change the UPDATE params `data.order_discount_type || null, Number(data.order_discount_value) || 0` to the normalized values:

```javascript
            await conn.query("UPDATE orders SET subtotal=?, tax=?, total=?, discount_type=?, discount_value=?, user_id=?, shift_id=?, void_reason=? WHERE invoice_id=?", [expectedTotals.subtotal, expectedTotals.tax, expectedTotals.total, expectedTotals.orderDiscount.type, expectedTotals.orderDiscount.value, req.user.id, originalShiftId, voidReason, order_id]);
```

`backend/routes/pos/tables.js:1534` — change the INSERT params the same way:

```javascript
            `, [req.user.id, data.shift_id || null, data.table_id, req.user.id, expectedTotals.subtotal, expectedTotals.tax, expectedTotals.total, data.order_discount_type || null, Number(data.order_discount_value) || 0]);
```
becomes:
```javascript
            `, [req.user.id, data.shift_id || null, data.table_id, req.user.id, expectedTotals.subtotal, expectedTotals.tax, expectedTotals.total, expectedTotals.orderDiscount.type, expectedTotals.orderDiscount.value]);
```

(`expectedTotals.orderDiscount` is the `{type, value}` from `normalizeDiscount` — a garbage type with value 0 now persists as `NULL/0`, matching the checkout path.)

- [ ] **Step 7: Guard the bundle divide-by-zero (`reconstructBundleSubs`).**

`backend/services/bundleOrderItems.js:153` — replace the `qty:` line:

```javascript
                qty: Number(parentRow.quantity) > 0 ? Number(child.quantity) / Number(parentRow.quantity) : Number(child.quantity), // guard fully-voided parent (qty 0 → Infinity)
```

- [ ] **Step 8: Run the full suite to prove no persisted-total drift**

Run: `npx vitest run`
Expected: PASS — **baseline green** (no new tests beyond the PosCalculator.test.js cases from Step 1). (The integration suites cover checkout/table-save persistence, the `SUM(tax_amount) ≈ orders.tax` invariant, and tax-inclusive stamping; they must stay green because the refactor is behaviour-identical except the D4 NaN→0 fix and the D6 normalization, neither of which changes any currently-reachable total.)

- [ ] **Step 9: Commit**

```bash
git add backend/services/PosCalculator.js backend/routes/pos/checkout.js backend/routes/pos/tables.js backend/routes/pos/helpers.js backend/services/bundleOrderItems.js backend/tests/unit/PosCalculator.test.js
git commit -m "refactor(pos): single stampLineTax/resolveTaxRate authority + normalized table discount persistence (D1/D4/D6)"
```

---

## Task 2: `src/utils/posTotals.js` pure helper + parity test (D1 foundation, Phase 7)

**Files:**
- Create: `src/utils/posTotals.js`
- Create: `backend/tests/unit/posTotals.test.js`
- Create: `backend/tests/unit/posTotalsParity.test.js`

**Interfaces:**
- Produces: `roundMoney(v) → number` (identical formula to `PosCalculator.roundMoney`).
- Produces: `lineNet(item) → number` — `price*qty − line discount` (fixed = per-unit ×qty), blank price guarded to 0, clamped ≥0.
- Produces: `lineTax(item, discountRatio = 1, opts = {}) → number` — `0` when `opts.taxExempt || opts.taxInclusive || rate ≤ 0`, else `lineNet(item) * discountRatio * rate/100`.
- Produces: `lineGross(item, opts = {}) → number` — `lineNet` when exempt/inclusive, else `lineNet * (1 + rate/100)`.
- Produces: `orderDiscountAmount(rawSubtotal, disc = {}) → number` — fixed → `min(rawSubtotal, value)`, percent → `rawSubtotal * value/100`, else 0.
- Produces: `posTotals(items, disc = {}, opts = {}) → { subtotal, discount, tax, total, discountedSubtotal, discountRatio }` — the canonical FE display rollup, byte-identical to `PosCalculator.calculateExpectedTotals` when line `item.tax_rate` values match catalog rates.
- Produces: `footedDisplay({ subtotal, discountedSubtotal, total }) → { subtotal, discount, tax, total }` — pieces that satisfy `subtotal − discount + tax === total` exactly.
- Produces: `serviceChargeBase(items) → number` and `serviceChargeFee(items, pct) → number` — Σ `lineNet` over non-service lines, × `pct/100` (rounded).
- Produces: `isServiceChargeLine(item) → boolean` — `String(item.id||'').startsWith('FEE_') || item.note === 'Auto-Gratuity'`.
- **Authority note:** every tax read uses each line's own `item.tax_rate` (catalog-shaped preview). The backend `productMap` stays the sole persist authority; `posTotals` equals the backend rollup only when `item.tax_rate` matches the catalog rate (which the FE populates on add-to-cart). This is a display/preview helper, not a re-implementation of the server trust boundary.

- [ ] **Step 1: Write the failing unit test** — `backend/tests/unit/posTotals.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  roundMoney, lineNet, lineTax, lineGross, orderDiscountAmount,
  posTotals, footedDisplay, serviceChargeBase, serviceChargeFee, isServiceChargeLine,
} from '../../../src/utils/posTotals.js';

describe('posTotals pure helper', () => {
  it('lineNet applies a fixed per-unit discount ×qty and clamps at 0', () => {
    expect(lineNet({ price: 10, qty: 3, discountType: 'fixed', discountValue: 2 })).toBe(24);
    expect(lineNet({ price: 10, qty: 1, discountType: 'fixed', discountValue: 999 })).toBe(0);
  });

  it('lineNet guards a blank price to 0 (no NaN leak)', () => {
    expect(lineNet({ price: '', qty: 2, tax_rate: 16 })).toBe(0);
  });

  it('lineTax is 0 when exempt, inclusive, or rate 0; else prorated', () => {
    const line = { price: 10, qty: 2, tax_rate: 16 };
    expect(lineTax(line, 1)).toBeCloseTo(3.2, 6);
    expect(lineTax(line, 0.5)).toBeCloseTo(1.6, 6);
    expect(lineTax(line, 1, { taxExempt: true })).toBe(0);
    expect(lineTax(line, 1, { taxInclusive: true })).toBe(0);
    expect(lineTax({ price: 10, qty: 1, tax_rate: 0 }, 1)).toBe(0);
  });

  it('lineGross adds tax unless exempt/inclusive', () => {
    expect(lineGross({ price: 10, qty: 1, tax_rate: 16 })).toBeCloseTo(11.6, 6);
    expect(lineGross({ price: 10, qty: 1, tax_rate: 16 }, { taxExempt: true })).toBe(10);
    expect(lineGross({ price: 10, qty: 1, tax_rate: 16 }, { taxInclusive: true })).toBe(10);
  });

  it('orderDiscountAmount caps a fixed discount at the subtotal', () => {
    expect(orderDiscountAmount(50, { type: 'fixed', value: 80 })).toBe(50);
    expect(orderDiscountAmount(50, { type: 'percent', value: 10 })).toBe(5);
  });

  it('posTotals rolls up subtotal/tax/total (exclusive)', () => {
    const items = [{ price: 10, qty: 2, tax_rate: 16 }, { price: 5, qty: 1, tax_rate: 0 }];
    const r = posTotals(items, { type: 'percent', value: 10 });
    expect(r.subtotal).toBe(25);
    expect(r.discount).toBe(2.5);
    expect(r.tax).toBeCloseTo(2.88, 2); // 20 net * 0.9 ratio * 0.16
    expect(r.total).toBeCloseTo(25.38, 2);
  });

  it('posTotals inclusive mode returns tax 0 and total = discounted subtotal', () => {
    const r = posTotals([{ price: 11.6, qty: 1, tax_rate: 16 }], {}, { taxInclusive: true });
    expect(r.tax).toBe(0);
    expect(r.total).toBe(11.6);
  });

  it('discountRatio uses the backend rule for any nonzero subtotal, even tiny values', () => {
    const r = posTotals([{ price: 0.00005, qty: 1, tax_rate: 0 }], { type: 'fixed', value: 0.00002 });
    expect(r.discountRatio).toBeCloseTo(0.6, 12);
  });

  it('footedDisplay makes Subtotal − Discount + Tax === Total exactly', () => {
    const d = footedDisplay({ subtotal: 25, discountedSubtotal: 22.5, total: 25.38 });
    expect(d.discount).toBe(2.5);
    expect(d.tax).toBe(2.88);
    expect(roundMoney(d.subtotal - d.discount + d.tax)).toBe(d.total);
  });

  it('service charge fee is % of pre-discount goods (excludes the fee line itself)', () => {
    const items = [{ price: 100, qty: 1, tax_rate: 0 }, { id: 'FEE_1', note: 'Auto-Gratuity', price: 10, qty: 1 }];
    expect(isServiceChargeLine(items[1])).toBe(true);
    expect(serviceChargeBase(items)).toBe(100);
    expect(serviceChargeFee(items, 10)).toBe(10);
  });

  it('AUTHORITY MODEL: tax comes from the line’s own tax_rate (catalog preview), NOT productMap', () => {
    // A stale/forged client rate produces a preview that differs from the backend, which
    // re-derives from the DB catalog. This documents the trust boundary — posTotals is a preview,
    // not the persist authority. Do NOT change it to look up a productMap.
    const stale = posTotals([{ product_id: 1, price: 10, qty: 1, tax_rate: 0 }], {}); // client claims 0%
    expect(stale.tax).toBe(0);   // preview trusts the line…
    expect(stale.total).toBe(10); // …the BE would instead charge the catalog rate on persist.
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run backend/tests/unit/posTotals.test.js`
Expected: FAIL — cannot resolve `../../../src/utils/posTotals.js`.

- [ ] **Step 3: Implement `src/utils/posTotals.js`:**

```javascript
// src/utils/posTotals.js
// Pure ESM mirror of backend/services/PosCalculator.js line + rollup math, plus
// display-footing helpers. NO Vue/DOM imports — safe to run under Node/Vitest and Vite.
// The `posTotalsParity.test.js` fuzz enforces byte-identical rollups with the backend.
//
// AUTHORITY MODEL: this helper is a FRONTEND PREVIEW over catalog-shaped cart items. It reads each
// line's own `item.tax_rate` — the rate the FE loaded from the catalog when the line was added —
// exactly as the current store computeds do. It is NOT the tax authority: the backend
// `calculateExpectedTotals` re-derives every product line's rate from `productMap` (DB) and
// overwrites the persisted totals. FE preview ≡ BE rollup ONLY when `item.tax_rate` equals the
// catalog rate; a stale/forged client rate diverges BY DESIGN and is corrected server-side on
// persist. Do NOT "fix" posTotals to chase productMap — that authority stays on the backend.

const toNumber = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export const roundMoney = (v) => Math.round((toNumber(v) + Number.EPSILON) * 100) / 100;

export function isServiceChargeLine(item = {}) {
  return String(item.id || '').startsWith('FEE_') || item.note === 'Auto-Gratuity';
}

// Line net = price*qty − line discount (fixed = per-unit ×qty). Blank price guarded → 0; clamp ≥0.
export function lineNet(item = {}) {
  const price = toNumber(item.price ?? item.price_at_sale);
  const qty = toNumber(item.qty ?? item.quantity);
  let total = price * qty;
  const dv = toNumber(item.discountValue ?? item.discount_value);
  const dt = item.discountType ?? item.discount_type;
  if (dv > 0) {
    if (dt === 'fixed') total -= dv * qty;
    else if (dt === 'percent') total -= total * (dv / 100);
  }
  return Math.max(0, total);
}

// Per-line tax prorated by the order discountRatio. 0 when exempt/inclusive/rate≤0.
export function lineTax(item = {}, discountRatio = 1, opts = {}) {
  if (opts.taxExempt || opts.taxInclusive) return 0;
  const rate = toNumber(item.tax_rate ?? item.taxRate);
  if (rate <= 0) return 0;
  return lineNet(item) * (discountRatio ?? 1) * (rate / 100);
}

// Line gross = net + its tax. Net when exempt/inclusive.
export function lineGross(item = {}, opts = {}) {
  const net = lineNet(item);
  if (opts.taxExempt || opts.taxInclusive) return net;
  const rate = toNumber(item.tax_rate ?? item.taxRate);
  return net * (1 + rate / 100);
}

export function orderDiscountAmount(rawSubtotal, disc = {}) {
  const value = toNumber(disc.value);
  if (value <= 0) return 0;
  if (disc.type === 'fixed') return Math.min(toNumber(rawSubtotal), value);
  if (disc.type === 'percent') return toNumber(rawSubtotal) * (value / 100);
  return 0;
}

// Canonical FE display rollup — mirrors PosCalculator.calculateExpectedTotals exactly when
// catalog-loaded line tax rates match the backend productMap rates.
export function posTotals(items = [], disc = {}, opts = {}) {
  const rawSubtotal = items.reduce((s, it) => s + lineNet(it), 0);
  const discAmt = orderDiscountAmount(rawSubtotal, disc);
  const rawDiscountedSubtotal = Math.max(0, rawSubtotal - discAmt);
  // Match PosCalculator exactly: any positive subtotal gets a ratio, even if it rounds to 0.00.
  const discountRatio = rawSubtotal > 0 ? rawDiscountedSubtotal / rawSubtotal : 1;

  if (opts.taxInclusive) {
    return {
      subtotal: roundMoney(rawSubtotal),
      discount: roundMoney(rawSubtotal - rawDiscountedSubtotal),
      tax: 0,
      total: roundMoney(rawDiscountedSubtotal),
      discountedSubtotal: roundMoney(rawDiscountedSubtotal),
      discountRatio,
    };
  }

  const rawTax = opts.taxExempt ? 0 : items.reduce((s, it) => s + lineTax(it, discountRatio, opts), 0);
  return {
    subtotal: roundMoney(rawSubtotal),
    discount: roundMoney(rawSubtotal - rawDiscountedSubtotal),
    tax: roundMoney(rawTax),
    total: roundMoney(rawDiscountedSubtotal + rawTax),
    discountedSubtotal: roundMoney(rawDiscountedSubtotal),
    discountRatio,
  };
}

// Display footing (D2): keep the canonical `total` (charged amount, parity-safe) and derive the
// shown Discount and Tax from the rounded pieces so Subtotal − Discount + Tax === Total exactly.
export function footedDisplay({ subtotal, discountedSubtotal, total }) {
  const s = roundMoney(subtotal);
  const ds = roundMoney(discountedSubtotal);
  const t = roundMoney(total);
  return { subtotal: s, discount: roundMoney(s - ds), tax: roundMoney(t - ds), total: t };
}

export function serviceChargeBase(items = []) {
  return items.filter((it) => !isServiceChargeLine(it)).reduce((s, it) => s + lineNet(it), 0);
}

export function serviceChargeFee(items = [], pct = 0) {
  return roundMoney(serviceChargeBase(items) * (toNumber(pct) / 100));
}
```

- [ ] **Step 4: Run to verify the unit test passes**

Run: `npx vitest run backend/tests/unit/posTotals.test.js`
Expected: PASS.

- [ ] **Step 5: Write the parity test** — `backend/tests/unit/posTotalsParity.test.js` (mirrors the `roundingSimulation.test.js` grid but drives the REAL `posTotals.js`, retiring the hand-copied `runFrontendCalc` mock):

```javascript
import { describe, it, expect } from 'vitest';
import { posTotals } from '../../../src/utils/posTotals.js';
import PosCalculator from '../../services/PosCalculator.js'; // CJS default = module.exports

describe('posTotals ≡ PosCalculator (rollup parity)', () => {
  it('matches subtotal/tax/total across 10,000+ combinations', () => {
    // PRECONDITION: each line's item.tax_rate equals its productMap rate (t1/t2 below), mirroring
    // how the FE builds the cart from the catalog. That is the domain where the FE preview equals
    // the BE authority. A stale/forged client rate is a deliberate divergence handled by the BE
    // (see posTotals.js AUTHORITY MODEL + the boundary test in posTotals.test.js), NOT by this fuzz.
    const prices = [1.05, 2.15, 3.45, 5.55, 10.25, 12.35, 15.65];
    const qtys = [1, 2, 3, 1.5, 0.75, 2.25];
    const taxRates = [0, 8, 16];
    let mismatches = 0;
    let n = 0;

    for (const p1 of prices) for (const q1 of qtys) for (const t1 of taxRates)
    for (const p2 of prices) for (const q2 of qtys) for (const t2 of taxRates) {
      n++;
      let d1t = null, d1v = 0, d2t = null, d2v = 0;
      if (n % 4 === 1) { d1t = 'percent'; d1v = 10; }
      else if (n % 4 === 2) { d2t = 'fixed'; d2v = 0.5; }
      else if (n % 4 === 3) { d1t = 'percent'; d1v = 15; d2t = 'fixed'; d2v = 0.75; }

      const items = [
        { id: 1, product_id: 1, price: p1, qty: q1, tax_rate: t1, discountType: d1t, discountValue: d1v },
        { id: 2, product_id: 2, price: p2, qty: q2, tax_rate: t2, discountType: d2t, discountValue: d2v },
      ];
      const rawSub = items.reduce((s, it) => {
        let lt = it.price * it.qty;
        if (it.discountType === 'fixed') lt -= it.discountValue * it.qty;
        else if (it.discountType === 'percent') lt -= lt * (it.discountValue / 100);
        return s + Math.max(0, lt);
      }, 0);
      items.push({ id: 'FEE_1', name: '10% Service Charge', price: Math.round((rawSub * 0.1 + Number.EPSILON) * 100) / 100, tax_rate: 0, qty: 1, note: 'Auto-Gratuity', discountType: null, discountValue: 0 });

      let disc = { type: null, value: 0 };
      if (n % 5 === 1) disc = { type: 'percent', value: 10 };
      else if (n % 5 === 2) disc = { type: 'fixed', value: 1.5 };
      else if (n % 5 === 3) disc = { type: 'percent', value: 25 };
      else if (n % 5 === 4) disc = { type: 'fixed', value: 3.75 };

      const taxInclusive = (n % 2 === 0);
      const client = posTotals(items, disc, { taxInclusive });
      const productMap = new Map([[1, { id: 1, tax_rate: t1 }], [2, { id: 2, tax_rate: t2 }]]);
      const server = PosCalculator.calculateExpectedTotals(
        { order_discount_type: disc.type, order_discount_value: disc.value }, items, productMap, taxInclusive);

      if (
        client.subtotal !== server.subtotal ||
        client.discount !== server.discount ||
        client.tax !== server.tax ||
        client.total !== server.total ||
        Math.abs(client.discountRatio - server.discountRatio) > 1e-12
      ) {
        mismatches++;
        // eslint-disable-next-line no-console
        console.error(`Mismatch: client ${JSON.stringify(client)} vs server ${JSON.stringify(server)}`);
      }
    }
    expect(mismatches).toBe(0);
    expect(n).toBeGreaterThan(10000);
  });
});
```

- [ ] **Step 6: Run the parity test**

Run: `npx vitest run backend/tests/unit/posTotalsParity.test.js`
Expected: PASS — `mismatches` is 0 over >10,000 combinations, including `discount` and raw `discountRatio`. (If the CJS default-import interop surprises the runner, the failure will be an import error on line 3 — switch to `import * as PosCalculator from '../../services/PosCalculator.js'`, which vitest also supports for CJS.)

- [ ] **Step 7: Commit**

```bash
git add src/utils/posTotals.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js
git commit -m "feat(pos): pure posTotals helper mirroring PosCalculator + 10k parity test (D1/Phase7)"
```

---

## Task 3: Refactor store computeds onto `posTotals` (D1-FE, D5, NaN guard)

> **Depends on Task 2:** `src/utils/posTotals.js` must already exist and export `lineNet`, `lineGross`, `orderDiscountAmount`, `posTotals`, `footedDisplay`, `serviceChargeBase`, `serviceChargeFee`, `roundMoney`. None of these exist in the frontend before Task 2 — if this task runs first, every delegated body throws at import. Do NOT reorder.

**Files:**
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Test: covered by `posTotalsParity.test.js` + `roundingSimulation.test.js` (unchanged) + the new NaN case below.

**Interfaces:**
- Consumes: everything Task 2 produces.
- Produces (store, unchanged public shape): `rawSubtotal`, `cartSubtotal`, `cartOrderDiscountAmount`, `rawDiscountedSubtotal`, `discountedSubtotal`, `cartTax`, `cartTotal`, `getItemTotal`, `getItemTotalGross`, `cartGrossSubtotal`, `getSeatTotal` (formula unified via `lineNet`; **still returns a `.toFixed(2)` string** — type unchanged).

- [ ] **Step 1: Add the import** at the top of `orderSessionStore.js` (after line 9):

```javascript
import {
  roundMoney as ptRoundMoney, lineNet, lineGross, orderDiscountAmount,
  posTotals, footedDisplay, serviceChargeBase, serviceChargeFee,
} from '../../../../src/utils/posTotals.js';
```

Delete the local `roundMoney` definition (lines 16-20) and, **at module scope (right after the import, NOT inside the store's `defineStore` setup callback)**, alias it — the module-level `distributeOrderDiscount` (line 25) calls `roundMoney` and must keep access:

```javascript
const roundMoney = ptRoundMoney; // single money rounder (was a local copy); MODULE scope
```

- [ ] **Step 2: Write the failing NaN-guard test** — append to `backend/tests/unit/posTotals.test.js`:

```javascript
describe('blank-price guard (store D1 fix)', () => {
  it('a taxable line with a blank price contributes 0, not NaN', () => {
    const r = posTotals([{ price: '', qty: 2, tax_rate: 16 }], {});
    expect(r.subtotal).toBe(0);
    expect(r.tax).toBe(0);
    expect(r.total).toBe(0);
  });
});
```

Run: `npx vitest run backend/tests/unit/posTotals.test.js`
Expected: PASS immediately (the guard is already in `lineNet`) — this test **locks** the guard the store now inherits (the old `cartTax`/`cartTotal`/`getSeatTotal` copies dropped `|| 0` and produced silent `NaN → 0`).

- [ ] **Step 3: Replace the money computeds** (lines 227-347). New bodies:

```javascript
  const rawSubtotal = computed(() =>
    cart.value.reduce((sum, item) => sum + lineNet(item), 0));

  const cartSubtotal = computed(() => roundMoney(rawSubtotal.value));

  const cartOrderDiscountAmount = computed(() =>
    roundMoney(orderDiscountAmount(rawSubtotal.value, orderDiscount.value)));

  const rawDiscountedSubtotal = computed(() =>
    Math.max(0, rawSubtotal.value - orderDiscountAmount(rawSubtotal.value, orderDiscount.value)));

  const discountedSubtotal = computed(() => roundMoney(rawDiscountedSubtotal.value));

  const _totals = computed(() => {
    const deps = getDeps();
    return posTotals(cart.value, orderDiscount.value, {
      taxExempt: isTaxExempt.value,
      taxInclusive: !!deps.terminal.taxInclusivePricing?.value,
    });
  });

  const cartTax = computed(() => _totals.value.tax);
  const cartTotal = computed(() => _totals.value.total);

  const getItemTotal = (item) => lineNet(item);

  // Pass BOTH flags: in exempt OR inclusive mode the price is already final, so lineGross must
  // NOT gross it up again. (The old getItemTotalGross ignored taxInclusive → a latent double-count
  // in inclusive mode; this fixes it.)
  const getItemTotalGross = (item) => {
    const deps = getDeps();
    return lineGross(item, {
      taxExempt: isTaxExempt.value,
      taxInclusive: !!deps.terminal.taxInclusivePricing?.value,
    });
  };

  const cartGrossSubtotal = computed(() => {
    if (isTaxExempt.value) return cartSubtotal.value;
    const deps = getDeps();
    const opts = { taxExempt: false, taxInclusive: !!deps.terminal.taxInclusivePricing?.value };
    return roundMoney(cart.value.reduce((sum, item) => sum + lineGross(item, opts), 0));
  });
```

- [ ] **Step 4: Refactor `getSeatTotal`** (lines 1211-1219) to reduce via the shared `lineNet` — but **keep the `.toFixed(2)` string return** (do NOT change the return type):

```javascript
  const getSeatTotal = (seat) =>
    roundMoney(seat.items.reduce((sum, item) => sum + lineNet(item), 0)).toFixed(2);
```

Rationale (audit-confirmed): `getSeatTotal` is rendered **directly** in a template — `src/components/pos/SplitCheckModal.vue:109` (`{{ getSeatTotal(seat) }}`, exposed via `useTables.js:83`, NOT `useCart`) — so a number return would drop the 2-decimal money format ("12.5" instead of "12.50"). We therefore only unify the inner formula (D1) and keep the string return; the string→number "type trap" cleanup (map §3) is **deferred** to a future coordinated change. Body is byte-identical to the current one.

- [ ] **Step 5: Route service charge through the shared base (D5).**

`updateServiceCharge` (lines 188-207) — replace the inline base reduce and the fee calc:

```javascript
    const base = serviceChargeBase(cart.value.filter(item => !String(item.id).startsWith('FEE_')));
    if (base === 0) {
      cart.value.splice(feeIdx, 1);
    } else {
      const feeItem = cart.value[feeIdx];
      const newFee = serviceChargeFee(cart.value.filter(item => !String(item.id).startsWith('FEE_')), pct);
      const newName = `${pct}% Service Charge`;
      if (Math.abs(parseFloat(feeItem.price) - newFee) > 0.001 || feeItem.name !== newName) {
        feeItem.price = newFee;
        feeItem.name = newName;
      }
    }
```

`addServiceCharge` (line 2412) — replace the rounded-`cartSubtotal` base with the raw shared base (D5 unify: `addServiceCharge` was the only one of three using a pre-rounded base):

```javascript
    const fee = serviceChargeFee(cart.value, pct);
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS — **baseline + the new posTotals/parity tests**, all green. The `roundingSimulation.test.js` (hand-copied mock) still passes because the store now computes the same values; the parity test guards the store's real dependency.

- [ ] **Step 7: Commit**

```bash
git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/posTotals.test.js
git commit -m "refactor(pos): store money computeds delegate to posTotals; unify svc-charge base (D1/D5)"
```

---

## Task 4: Display footing — Subtotal − Discount + Tax == Total (D2, Phase 6)

> **Order within this task:** define `displayDiscount`/`displayTax` in the store AND add them to the store's `return {}` FIRST, then add them to the `useCart.js` facade, THEN reference them in `PosTerminal.vue`. A `storeToRefs` of a getter the store doesn't return yields an `undefined` ref → `undefined.toFixed()`.

**Files:**
- Modify: `assets/js/composables/stores/orderSessionStore.js` (add `displayDiscount`, `displayTax`)
- Modify: `src/components/PosTerminal.vue:542-547`
- Modify: `backend/routes/pos/checkout.js:50-52`
- Test: `backend/tests/unit/posTotals.test.js` (footing already asserted in Task 2 Step 1); add the checkout capped-discount case below.

**Interfaces:**
- Consumes: `footedDisplay`, `orderDiscountAmount`, `roundMoney` from `posTotals.js`.
- Produces (store): `displayDiscount`, `displayTax` computeds — the footed pieces for the totals panel.

- [ ] **Step 1: Write the failing test** — append to `backend/tests/unit/posTotals.test.js`. `footedDisplay`, `posTotals`, and `roundMoney` are **already imported by the Task 2 import block — do NOT re-import them**:

```javascript
describe('display footing across the fuzz grid', () => {
  it('Subtotal − Discount + Tax === Total for every rounded triple', () => {
    const combos = [
      { subtotal: 8.24, discountedSubtotal: 8.24, total: 8.99 },
      { subtotal: 35.86, discountedSubtotal: 32.27, total: 37.43 },
      { subtotal: 100, discountedSubtotal: 90, total: 104.4 },
      { subtotal: 12.35, discountedSubtotal: 12.35, total: 12.35 },
    ];
    for (const c of combos) {
      const d = footedDisplay(c);
      expect(roundMoney(d.subtotal - d.discount + d.tax)).toBe(d.total);
    }
  });

  it('shows tax 0 in tax-EXEMPT mode (derived tax matches canonical cartTax=0)', () => {
    // Exempt: canonical total === discountedSubtotal, so derived tax = total − discountedSubtotal = 0.
    const r = posTotals([{ price: 10, qty: 2, tax_rate: 16 }], { type: 'percent', value: 10 }, { taxExempt: true });
    const d = footedDisplay(r);
    expect(d.tax).toBe(0);
    expect(roundMoney(d.subtotal - d.discount + d.tax)).toBe(d.total);
  });

  it('shows tax 0 in tax-INCLUSIVE mode', () => {
    const r = posTotals([{ price: 11.6, qty: 2, tax_rate: 16 }], { type: 'fixed', value: 3 }, { taxInclusive: true });
    const d = footedDisplay(r);
    expect(d.tax).toBe(0);
    expect(roundMoney(d.subtotal - d.discount + d.tax)).toBe(d.total);
  });
});
```

Run: `npx vitest run backend/tests/unit/posTotals.test.js`
Expected: PASS — locks the footing invariant AND that the derived display tax collapses to 0 in exempt/inclusive modes (matching canonical `cartTax`), before the panel/receipts wire it in.

- [ ] **Step 2: Add the footed display computeds** to `orderSessionStore.js` (after `cartTotal`):

```javascript
  // Display footing (D2): keep the canonical charged total, derive the SHOWN discount and tax
  // so Subtotal − Discount + Tax === Total exactly on screen and on receipts.
  const _footed = computed(() => footedDisplay({
    subtotal: cartSubtotal.value,
    discountedSubtotal: discountedSubtotal.value,
    total: cartTotal.value,
  }));
  const displayDiscount = computed(() => _footed.value.discount);
  const displayTax = computed(() => _footed.value.tax);
```

Expose them in BOTH places (`footedDisplay` is already imported in Task 3 Step 1):
1. Add `displayDiscount, displayTax` to the store's `return {…}` object (`orderSessionStore.js:2461`, next to `cartTax` at `:2487`).
2. Add `displayDiscount: s.displayDiscount, displayTax: s.displayTax,` to the `storeToRefs` block in `assets/js/composables/useCart.js` (next to `cartTax: s.cartTax` at `:38`).

`PosTerminal` already destructures the totals from `useCart()` (line 966) — Step 3 just adds the two names to that destructure.

- [ ] **Step 3: Point the totals panel at the footed values.**

`src/components/PosTerminal.vue` — the discount row (`:542-545`) and tax row (`:546-547`): render `displayDiscount` and `displayTax` instead of `cartOrderDiscountAmount` and `cartTax`:

```html
                  <div v-if="orderDiscount.value > 0" class="flex justify-between text-xs font-black text-error">
                    <span>{{ $t('Disc') }} ({{ orderDiscount.type === 'percent' ? orderDiscount.value + '%' : $t('Fix') }})</span>
                    <span class="font-mono font-black">-{{ displayDiscount.toFixed(2) }}</span>
                  </div>
                  <div class="flex justify-between text-xs font-bold text-on-surface-variant">
                    <span>{{ $t('Tax') }}</span><span class="text-on-surface font-mono font-semibold">{{ displayTax.toFixed(2) }}</span>
```

Add `displayDiscount, displayTax` to the `const { … } = cart;` destructure in `PosTerminal.vue` (line 966, where `cartSubtotal, cartOrderDiscountAmount, cartTax, cartTotal` are pulled from `useCart()`).

- [ ] **Step 4: Cap the fixed-discount display on the duplicate-checkout receipt payload.**

`backend/routes/pos/checkout.js:50-52` — the fixed branch prints the raw stored value even when it exceeded the subtotal. Cap it:

```javascript
        const discount = order.discount_type === 'percent'
            ? roundMoney(subtotal * discountValue / 100)
            : (order.discount_type === 'fixed' ? Math.min(subtotal, discountValue) : 0);
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS — baseline + new tests. (No charged/persisted total changed; only displayed pieces.)

- [ ] **Step 6: Commit**

```bash
git add assets/js/composables/stores/orderSessionStore.js assets/js/composables/useCart.js src/components/PosTerminal.vue backend/routes/pos/checkout.js backend/tests/unit/posTotals.test.js
git commit -m "fix(pos): foot the totals panel (Subtotal − Discount + Tax == Total) + cap fixed-discount display (D2)"
```

---

## Task 5: Receipt / preview / split net-vs-gross consistency (D3, Phase 7)

> **STOP / owner sign-off before executing Task 5:** receipt line "Total" columns switch from **gross** (tax-in) to **net** (pre-tax) so they sum to the NET Subtotal, with tax summarised on the Tax line. This is the standard exclusive-tax receipt; in tax-inclusive mode net == the tax-embedded price so nothing visibly changes there. Alternative (keep gross line totals, make Subtotal gross too) was rejected because it double-handles inclusive mode. Do not patch Task 5 until the owner confirms this visible receipt change.

**Files:**
- Modify: `src/utils/receiptLineTotals.js` (add `receiptTotalsBlock`)
- Modify: `src/components/pos/ReceiptPreviewModal.vue:65`, `:73-79`, `:166`, `:175-190` (modal preview AND print-only teleported receipt)
- Modify: `src/print/PrintReceiptApp.vue` (line-total cell + totals block)
- Modify: `src/components/PosTerminal.vue:318`, `:467` (honor `isTaxExempt` via helper)
- Test: `backend/tests/unit/receiptLineTotals.test.js` (extend)

**Interfaces:**
- Consumes: `receiptItemNetTotal` (existing), `footedDisplay` (Task 2), `orderDiscountAmount` (Task 2).
- Produces: `receiptTotalsBlock(order) → { subtotal, discount, tax, total }` — footed summary for any receipt payload. Reads `{ subtotal, total, discount, discount_type? }` and **normalizes `discount` to a money amount**, so it handles BOTH the admin-reprint shape (`buildReceiptPayload`: `discount` = raw value, `discount_type` present) AND the POS `lastOrder`/guest shape (`discount` = money, no `discount_type`).

- [ ] **Step 1: Write the failing test** — in `backend/tests/unit/receiptLineTotals.test.js`, **consolidate the two existing imports from `../../../src/utils/receiptLineTotals.js` into one top-of-file import** (the file currently imports `receiptItemDisplayTotal` at line 2 and `splitCheckTotals` at line 33). Then append:

```javascript
// (single helper import now reads:
// import { receiptItemDisplayTotal, receiptItemNetTotal, receiptTotalsBlock, splitCheckTotals } from '../../../src/utils/receiptLineTotals.js';
// and the later `import { splitCheckTotals } ...` line is deleted)

describe('receipt footing', () => {
  it('line net totals sum to the shown subtotal', () => {
    const items = [
      { qty: 2, price: 10, tax_rate: 16 },
      { qty: 1, price: 5, tax_rate: 0 },
    ];
    const lineSum = items.reduce((s, it) => s + receiptItemNetTotal(it), 0);
    expect(Math.round(lineSum * 100) / 100).toBe(25);
  });

  it('foots the admin-reprint shape (discount = raw percent + discount_type)', () => {
    const b = receiptTotalsBlock({ subtotal: 25, total: 25.38, discount: 10, discount_type: 'percent' });
    expect(b.discount).toBe(2.5); // 10% of 25 → money
    expect(Math.round((b.subtotal - b.discount + b.tax) * 100) / 100).toBe(b.total);
  });

  it('foots the POS lastOrder shape (discount = money, no discount_type)', () => {
    const b = receiptTotalsBlock({ subtotal: 25, total: 25.38, discount: 2.5 });
    expect(b.discount).toBe(2.5); // already money → passthrough (capped at subtotal)
    expect(Math.round((b.subtotal - b.discount + b.tax) * 100) / 100).toBe(b.total);
  });
});
```

Run: `npx vitest run backend/tests/unit/receiptLineTotals.test.js`
Expected: FAIL — `receiptTotalsBlock is not a function`.

- [ ] **Step 2: Implement `receiptTotalsBlock`** in `src/utils/receiptLineTotals.js` (import the two helpers from `posTotals.js`, which lives in the same `src/utils` dir):

```javascript
import { orderDiscountAmount, footedDisplay } from './posTotals.js';

// Footed summary for a receipt payload. `subtotal`/`total` are the authoritative values; the
// discount is normalized to MONEY then discount + tax are DERIVED so the block reconciles (D2/D3).
// The `discount` field is raw+typed on admin reprints (buildReceiptPayload: percent → a %, fixed →
// money) but already a money amount on POS lastOrder/guest payloads (no discount_type) — handle both.
export function receiptTotalsBlock(order = {}) {
  const subtotal = toNumber(order.subtotal);
  const total = toNumber(order.total);
  const rawDisc = toNumber(order.discount ?? order.discount_value);
  const discAmt = order.discount_type === 'percent'
    ? orderDiscountAmount(subtotal, { type: 'percent', value: rawDisc }) // percent number → money
    : Math.min(subtotal, rawDisc);                                       // fixed money, or already-money (no type)
  const discountedSubtotal = Math.max(0, subtotal - discAmt);
  return footedDisplay({ subtotal, discountedSubtotal, total });
}
```

Run: `npx vitest run backend/tests/unit/receiptLineTotals.test.js`
Expected: PASS.

- [ ] **Step 3: Switch BOTH preview renderers' line totals to NET** — `src/components/pos/ReceiptPreviewModal.vue:65` and `:166`:

```html
                  <span class="shrink-0 text-end">{{ receiptItemNetTotal(item).toFixed(2) }} JD</span>
```

```html
            <div class="thermal-col-total">{{ receiptItemNetTotal(item).toFixed(2) }} JD</div>
```

Ensure `receiptItemNetTotal` is imported alongside the existing `receiptItemDisplayTotal` import in that component.

- [ ] **Step 4: Foot BOTH preview totals blocks** — `src/components/pos/ReceiptPreviewModal.vue:73-79` and `:175-190`. Compute a footed block and render it in the modal preview:

```html
            <div v-if="block === 'totals'" class="mb-4 font-bold text-[11px] sm:text-xs">
              <div class="flex justify-between mb-0.5"><span class="font-normal">Subtotal</span><span>{{ receiptTotalsBlock(lastOrder).subtotal.toFixed(2) }} JD</span></div>
              <div v-if="receiptTotalsBlock(lastOrder).discount > 0" class="flex justify-between mb-0.5"><span class="font-normal">Discount</span><span>-{{ receiptTotalsBlock(lastOrder).discount.toFixed(2) }} JD</span></div>
              <div class="flex justify-between mb-1"><span class="font-normal">Tax</span><span>{{ receiptTotalsBlock(lastOrder).tax.toFixed(2) }} JD</span></div>
              <div class="bg-black text-white p-2.5 flex justify-between font-black text-xs sm:text-sm my-2 uppercase tracking-widest">
                <span>TOTAL</span><span>{{ receiptTotalsBlock(lastOrder).total.toFixed(2) }} JD</span>
              </div>
            </div>
```

Import `receiptTotalsBlock` in the component. (For render efficiency the implementer may hoist `const t = computed(() => receiptTotalsBlock(lastOrder.value))`; functionally equivalent.)

Then update the print-only teleported thermal receipt block to the same helper so the printed receipt cannot drift from the modal preview:

```html
        <div class="thermal-flex thermal-justify-between thermal-bold">
          <span>Subtotal</span>
          <span>{{ receiptTotalsBlock(lastOrder).subtotal.toFixed(2) }} JD</span>
        </div>
        <div v-if="receiptTotalsBlock(lastOrder).discount > 0" class="thermal-flex thermal-justify-between thermal-bold">
          <span>Discount</span>
          <span>-{{ receiptTotalsBlock(lastOrder).discount.toFixed(2) }} JD</span>
        </div>
        <div class="thermal-flex thermal-justify-between thermal-bold">
          <span>Tax</span>
          <span>{{ receiptTotalsBlock(lastOrder).tax.toFixed(2) }} JD</span>
        </div>
        <div class="thermal-total-box">
          <span>TOTAL</span>
          <span>{{ receiptTotalsBlock(lastOrder).total.toFixed(2) }} JD</span>
        </div>
```

Because `ReceiptPreviewModal.vue` is Options API (`<script>`, not `<script setup>`), return `receiptItemNetTotal` and `receiptTotalsBlock` from `setup()` alongside the existing `receiptItemDisplayTotal`.

- [ ] **Step 5: Apply the same changes to `src/print/PrintReceiptApp.vue`** (this component is Options API and binds `data`, not `lastOrder`).

Import at the top of the component's `<script>` block: add `receiptItemNetTotal` and `receiptTotalsBlock` to the existing `receiptLineTotals.js` import; you may drop `receiptItemDisplayTotal` if it becomes unused:
```javascript
import { receiptItemNetTotal, receiptTotalsBlock } from '../utils/receiptLineTotals.js';
```

Line 36 — per-line total to NET:
```html
                    <span class="text-right">{{ receiptItemNetTotal(item).toFixed(2) }} JD</span>
```

Lines 43-56 — replace the whole Subtotal/Discount/Tax/Total block with the footed block. **The discount line changes from a percent STRING (`-10%`) to the computed MONEY amount** so the block reconciles (`data.discount_type` is present only on admin reprints; `receiptTotalsBlock` normalizes either shape):
```html
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>Subtotal</span><span>{{ receiptTotalsBlock(data).subtotal.toFixed(2) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1" v-if="receiptTotalsBlock(data).discount > 0">
                <span>Discount</span>
                <span data-no-i18n>-{{ receiptTotalsBlock(data).discount.toFixed(2) }} JD</span>
            </div>
            <div class="flex justify-between text-xs font-bold mt-1">
                <span>Tax</span><span>{{ receiptTotalsBlock(data).tax.toFixed(2) }} JD</span>
            </div>

            <div class="flex justify-between text-lg font-black mt-2 pt-2 border-t-2 border-black">
                <span>TOTAL</span><span>{{ receiptTotalsBlock(data).total.toFixed(2) }} JD</span>
            </div>
```
Return `receiptItemNetTotal` and `receiptTotalsBlock` from `setup()` so the template can call them. Leave the non-receipt `data.sales_summary` / `data.summary` blocks (Z/X reports, lines 97+) untouched — they are a different payload.

- [ ] **Step 6: Honor tax-EXEMPT and tax-INCLUSIVE in the live-cart gross-ups (D3)** — `src/components/PosTerminal.vue`:

The fix lives in the **store** (which has `isTaxExempt` + `getDeps().terminal.taxInclusivePricing`), NOT in a PosTerminal-local method — `PosTerminal` does not destructure `taxInclusivePricing`. In `orderSessionStore.js`, next to `getItemTotalGross` (Task 3 Step 3), add a per-unit gross helper:
```javascript
  const getItemUnitGross = (item) => {
    const deps = getDeps();
    // Exempt OR inclusive → the price is already the final per-unit amount; do NOT gross it up.
    if (isTaxExempt.value || deps.terminal.taxInclusivePricing?.value) return parseFloat(item.price) || 0;
    return (parseFloat(item.price) || 0) * (1 + (parseFloat(item.tax_rate) || 0) / 100);
  };
```
Expose it: add `getItemUnitGross` to the store `return {…}` (`:2461`) and to the `useCart.js` actions passthrough (`getItemUnitGross: session.getItemUnitGross`, near `:87`) — see the File Structure note. Then in `PosTerminal.vue` add `getItemUnitGross` to the `= cart;` destructure (line 956, next to `getItemTotalGross`) and point the unit cell (`:467`) at it:
```html
                      <td class="py-1.5 px-1 text-end font-bold text-on-surface-variant align-middle text-[10px]">{{ getItemUnitGross(item).toFixed(2) }}</td>
```
The line-total cell (`:468`) already calls `getItemTotalGross(item)`, which Task 3 Step 3 makes mode-aware — no change there. The product-card price (`:318`) shows a catalog menu price independent of the cart's exempt state — leave as-is, but add a comment noting it is intentionally catalog-gross.

No `getSeatTotal` caller changes are needed: Task 3 Step 4 keeps its `.toFixed(2)` string return precisely because `src/components/pos/SplitCheckModal.vue:109` renders it directly in-template (`{{ getSeatTotal(seat) }}`). The string→number type-trap cleanup is deferred (see Task 3 Step 4 rationale).

- [ ] **Step 7: Run the full suite + a manual build sanity check**

Run: `npx vitest run`
Expected: PASS.
Run: `npm run build:admin` (the repo’s `test` script) — expected: build succeeds (proves the new `src/utils` imports resolve under Vite from both `src/` and `assets/js/`).

- [ ] **Step 8: Commit**

```bash
git add src/utils/receiptLineTotals.js src/components/pos/ReceiptPreviewModal.vue src/print/PrintReceiptApp.vue src/components/PosTerminal.vue assets/js/composables/stores/orderSessionStore.js assets/js/composables/useCart.js backend/tests/unit/receiptLineTotals.test.js
git commit -m "fix(pos): net line totals + footed receipt blocks; honor tax modes in cart gross-ups (D3)"
```

---

## Task 6: Lock owner-confirmed money rules (tests + docs, NO formula change)

**Files:**
- Create: `backend/tests/unit/serviceChargeRules.test.js`
- Modify: `backend/tests/integration/bundle.tables.test.js` (add child-tax-zero assertion)
- Modify: `backend/services/bundleOrderItems.js` (doc comment), `backend/routes/pos/helpers.js` `assertServiceChargeValid` (doc comment)

**Interfaces:**
- Consumes: `posTotals`, `serviceChargeFee` (Task 2); `PosCalculator.calculateExpectedTotals` (existing).

- [ ] **Step 1: Write the service-charge lock (unit, both engines)** — `backend/tests/unit/serviceChargeRules.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { posTotals, serviceChargeFee } from '../../../src/utils/posTotals.js';
import PosCalculator from '../../services/PosCalculator.js';

describe('OWNER RULE: service charge base is pre-order-discount, and the fee is discounted too', () => {
  const goods = [{ id: 1, product_id: 1, price: 100, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 }];
  const fee = { id: 'FEE_1', note: 'Auto-Gratuity', price: 10, qty: 1, tax_rate: 0, discountType: null, discountValue: 0 };

  it('fee = % of the PRE-discount goods subtotal (not reduced by the order discount)', () => {
    expect(serviceChargeFee([...goods, fee], 10)).toBe(10); // 10% of 100, ignores any order discount
  });

  it('a 10% order discount reduces the total INCLUDING the fee line (fee gets discounted too)', () => {
    const items = [...goods, fee]; // raw subtotal 110
    const r = posTotals(items, { type: 'percent', value: 10 });
    expect(r.subtotal).toBe(110);
    expect(r.total).toBe(99); // 110 − 11; the 1.00 off the fee proves the fee is inside the discount base
  });

  it('backend PosCalculator agrees (fee line rides in the discount base)', () => {
    const items = [{ ...goods[0] }, { ...fee }];
    const productMap = new Map([[1, { id: 1, tax_rate: 0 }]]);
    const server = PosCalculator.calculateExpectedTotals(
      { order_discount_type: 'percent', order_discount_value: 10 }, items, productMap, false);
    expect(server.subtotal).toBe(110);
    expect(server.total).toBe(99);
  });
});
```

Run: `npx vitest run backend/tests/unit/serviceChargeRules.test.js`
Expected: PASS (locks current behaviour; would fail if a future change moved the fee out of the discount base or discounted the fee base).

- [ ] **Step 2: Strengthen the bundle parent-only-tax lock (integration).**

`backend/tests/integration/bundle.tables.test.js` — in the existing "saves a NEW table order with a bundle" test (after line 69), add an explicit child-tax-zero assertion:

```javascript
        const children = items.filter(i => i.parent_item_id !== null);
        expect(children.length).toBe(2);
        for (const c of children) {
            expect(Number(c.tax_amount)).toBe(0); // OWNER RULE: bundle children carry 0 tax
            expect(Number(c.tax_rate)).toBe(0);   // whole bundle tax rides on the parent line
        }
```

- [ ] **Step 3: Document the two rules at the source.**

`backend/services/bundleOrderItems.js` — above the child INSERT (line 121), add:
```javascript
        // OWNER RULE (2026-07-06): bundle children are always priced/taxed 0; the entire
        // bundle tax rides on the parent line's rate. A component's own statutory rate is
        // intentionally NOT applied. Locked by bundle.tables.test.js.
```

`backend/routes/pos/helpers.js` `assertServiceChargeValid` (above line 330) — add:
```javascript
    // OWNER RULE (2026-07-06): the fee base is the goods subtotal BEFORE any order discount.
    // The fee is stored as a cart line, so a later order discount reduces it too. Locked by
    // serviceChargeRules.test.js.
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/unit/serviceChargeRules.test.js backend/tests/integration/bundle.tables.test.js backend/services/bundleOrderItems.js backend/routes/pos/helpers.js
git commit -m "test(pos): lock owner money rules — bundle parent-only tax + service-charge base/discount"
```

---

## Task 7: Naming / docs cleanup (Phase 8)

**Files:**
- Modify: `backend/services/PosCalculator.js` (doc comment on the fixed-discount semantics)
- Modify: `src/utils/posTotals.js` (roundMoney limitation note)
- Modify: `docs/2026-07-06-pos-calculation-unification-map.md` (STATUS)

- [ ] **Step 1: Document the per-unit fixed-discount semantics** at `calculateLineTotal` (`PosCalculator.js:61`) and mirror the wording in `posTotals.lineNet`:

```javascript
// NOTE: a `fixed` line discount is PER-UNIT (×qty) everywhere — a "fixed 2.00" on qty 3
// removes 6.00. This is intentional and consistent FE/BE. (Map §3 "unitDiscount" note.)
```

- [ ] **Step 2: Document the roundMoney nudge limitation** above `roundMoney` in `src/utils/posTotals.js`:

```javascript
// roundMoney adds Number.EPSILON before scaling; for |v| ≥ ~1 that nudge is too small to
// force documented round-half-up (e.g. 8.245 → 8.24). This is IDENTICAL FE/BE, so there is
// zero divergence — do NOT "fix" it here without changing PosCalculator in lockstep, or the
// parity test and every money baseline break. (Map §3 cosmetic; out of scope for Part C.)
```

- [ ] **Step 3: Update the unification map STATUS** — in `docs/2026-07-06-pos-calculation-unification-map.md`, extend the STATUS block (line 5) to note Part C completion and link this plan:

```markdown
> **STATUS (2026-07-06):** B1/B2 FIXED on `fix/pos-calc-b1-b2`. Part C (display unification) executed on
> `codex/pos-calculation-part-c` per [the Part C plan](superpowers/plans/2026-07-06-pos-calculation-part-c-unification-plan.md):
> D1 collapsed to `stampLineTax`/`resolveTaxRate` (BE) + `src/utils/posTotals.js` (FE, parity-tested); D2 display
> footed; D3 receipts net; D4/D5/D6 unified; owner rules (bundle parent-only tax, service-charge base) locked.
> Modifier stable IDs decomposed to their own spec+plan.
```

- [ ] **Step 4: Run the full suite** (docs+comments only, but confirm nothing broke)

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/services/PosCalculator.js src/utils/posTotals.js docs/2026-07-06-pos-calculation-unification-map.md
git commit -m "docs(pos): unitDiscount + roundMoney-nudge notes; map STATUS → Part C done (Phase 8)"
```

---

## Task 8: Stable modifier-option-ID follow-up spec + plan (decomposition)

> Part C keeps modifier matching **name-based**. This task only writes the design + plan for the separate cycle; it changes no runtime code. Current shape: product `modifiers` JSON is `[{ name, required, options: [{ name, price }] }]`; the cart records `selectedModifiers: [{ group, option, price }]` (by name); `computeModifierSurcharge` (`PosCalculator.js:123-126`) matches by name — so renaming an option silently drops its surcharge.

**Files:**
- Create: `docs/superpowers/specs/2026-07-06-stable-modifier-option-ids-design.md`
- Create: `docs/superpowers/plans/2026-07-06-stable-modifier-option-ids-plan.md`

- [ ] **Step 1: Create the spec directory**

Run:
```powershell
New-Item -ItemType Directory -Force docs/superpowers/specs
```

Expected: directory exists. This repo currently has `docs/superpowers/plans/`, but `docs/superpowers/specs/` may not exist yet.

- [ ] **Step 2: Write the design spec** — `docs/superpowers/specs/2026-07-06-stable-modifier-option-ids-design.md` covering, at minimum:
  - **Schema:** add a stable `id` to each modifier option in the product `modifiers` JSON (e.g. a per-product incrementing integer or a short uid), preserved across edits.
  - **Backfill migration:** a one-shot script assigning ids to every existing product’s options; idempotent; logs how many products/options touched.
  - **Admin modifier builder:** generate an id on option-create, preserve it on rename/reorder, never reuse a removed id.
  - **Frontend:** `confirmModifiers` records `optionId` (and `groupId`) alongside the existing name/price on `selectedModifiers`.
  - **Backend:** `computeModifierSurcharge` matches by `optionId` first, falling back to name for legacy lines (held orders, in-flight carts, pre-migration invoices).
  - **Legacy compatibility:** persisted order lines and held-order `cart_data` created before the change carry name-only selections and must still resolve via the fallback.
  - **Tests:** rename-after-order keeps the surcharge; id match beats name; fallback path for legacy lines.

- [ ] **Step 3: Write the plan stub** — `docs/superpowers/plans/2026-07-06-stable-modifier-option-ids-plan.md` with the standard writing-plans header and a task list mirroring the spec sections (schema+migration → admin builder → FE record id → BE match-by-id+fallback → legacy/tests). Mark it **not started**.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-06-stable-modifier-option-ids-design.md docs/superpowers/plans/2026-07-06-stable-modifier-option-ids-plan.md
git commit -m "docs(pos): decompose stable modifier-option-IDs into its own spec + plan"
```

---

## Self-Review (completed against the unification map)

- **Spec coverage:** every §1 row (#1–#16) and every D1–D6 item maps to a task in the two matrices above; #11/#15/#16 + rounding-formula + tolerance/split-robustness are explicitly marked out-of-scope with reasons. ✅
- **Placeholder scan:** no TBD/TODO; every code step shows real before/after; every test step shows runnable assertions. Task 5 now names both receipt renderers in `ReceiptPreviewModal.vue`, uses the actual Options API shape in `PrintReceiptApp.vue`, and has an explicit owner sign-off gate before the visible receipt line-total change. ✅
- **Type consistency:** `stampLineTax`/`resolveTaxRate` signatures identical across Tasks 1/definition; `posTotals`/`footedDisplay`/`lineNet`/`lineGross`/`orderDiscountAmount`/`serviceChargeFee`/`serviceChargeBase`/`isServiceChargeLine` used with the same signatures in Tasks 2–6; `getSeatTotal` keeps its `.toFixed(2)` string return (only the inner formula is unified via `lineNet`) — the string→number type-trap cleanup is deferred because `SplitCheckModal.vue:109` renders it directly in-template (audit-confirmed). ✅
- **Facade threading:** the UI reads totals through `useCart()`, not the store directly, so every NEW store member (`displayDiscount`, `displayTax`, `getItemUnitGross`) is exposed in all three sites — the store `return {}` (`orderSessionStore.js:2461`), the `useCart.js` facade (`storeToRefs` block `:38` for computeds, actions passthrough `:87` for the method), and the `PosTerminal.vue` destructure (`:956`/`:966`). Import-source claims verified: `checkout.js:19,30`, `tables.js:24,25`, `helpers.js:9-18` all destructure `calculateLineTax`/`calculateExpectedTotals` from `PosCalculator`, so the Task 1 destructure edits are correct. `tables.js:2057` (split reconcile) is a validation-only consumer of `calculateExpectedTotals` — it inherits the `resolveTaxRate` change but stamps/persists no per-line tax, so it is correctly out of Task 1's scope. ✅
- **Parity safety:** `PosCalculator.calculateExpectedTotals` return values and the charged/persisted total are unchanged in every task; footing is display-only; the 10k parity test + existing rounding sim guard the refactor. ✅

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-pos-calculation-part-c-unification-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
