# Modifier Surcharge Untaxed (flat surcharge, tax on base price only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modifier surcharges stay folded into the line price (subtotal/receipt unchanged) but stop being taxed — per-line tax is computed on `price − modifier_surcharge`, with legacy rows (no stored surcharge) keeping today's math bit-for-bit.

**Architecture:** One new server-authored per-unit money column `order_items.modifier_surcharge` (NULL ≡ "tax the full price"), assigned everywhere `price`/`price_at_sale` is assigned (DB fold), pinned everywhere price is pinned (settle/split/table-save frozen paths), copied everywhere rows are copied (merge). The tax-base change lands in exactly two math authorities — backend `PosCalculator` (`taxableLineTotal` feeding `stampLineTax` + the `calculateExpectedTotals` reducer) and frontend `src/utils/posTotals.js` (`taxableLineNet` feeding `lineTax`/`lineGross`). **Execution shape: inert plumbing first, one activation commit last.** Tasks 2-6 wire math, persistence, pins, and carriers while NOTHING creates the field — all organic data stays NULL, so old math holds on both FE and BE and every commit is deployable. Task 7 lands the field's three writers (fold attach, FE add-time attach, claim legacy attach) in ONE commit — the only commit where behavior changes.

**Tech Stack:** Node/Express, mysql2, Vue 3 + Pinia, Vitest (+supertest integration).

## Owner decision this plan implements (recorded 2026-07-10)

Owner wants the modifier surcharge to be a **flat, untaxed** add-on. Consequences the owner must be aware of before execution (re-confirm if in doubt):
- In **tax-exclusive** mode, the same modifier cart now costs **less** (tax shrinks). Z-report/dashboard tax figures drop accordingly for new orders. That is the point of the change.
- In **tax-inclusive** mode there is **zero behavior change**: the backend already stamps `tax = 0` and `total = discountedSubtotal` in inclusive mode (`PosCalculator.js:147-150`, `:163-172`); the surcharge simply remains part of the gross price. (The known inclusive-mode per-line stamping inconsistency, obs 2939, is out of scope.)
- Discount interaction (design decision, baked into the formula): line discounts and the order-discount ratio apply to the **taxable base** the same way they apply to the full line today — percent discounts scale the reduced base, fixed line discounts subtract fully from the reduced base, clamped at 0. Customer-favorable on edge carts (a fixed discount larger than the base zeroes the tax even though the surcharge remainder is still paid).
- Refund subtotals still refund the **full** paid line (surcharge included); only the tax portion follows the (now smaller) stored `tax_amount`. No refund code changes.
- Frozen paths (open tables, splits) saved before the activation deploy settle at their OLD surcharge-taxed totals. Register HOLDS are different: they have no frozen settle path — a legacy hold re-prices at claim (with the existing "totals changed" warning) and charges the NEW total at checkout.

## Anchor baseline — READ FIRST

All file:line anchors were verified 2026-07-12 against merged **`master` @ `1508443d`** (post modifier-stable-ids). Execute only on a tree at/after that commit. Line numbers are hints — **match on the quoted code, not the number**. Baseline suite: 1187 tests green (`npx vitest run`), build green.

## Verified current behavior (why the change looks like this)

- The surcharge is folded into `item.price` in exactly ONE backend place — `applyDatabasePrices`, `backend/routes/pos/helpers.js:404-406` (`expected = basePrice + extraPrice`) — and one FE place — `confirmModifiers`, `assets/js/composables/stores/orderSessionStore.js:2129`.
- ALL backend tax math is centralized: `calculateLineTotal` (`PosCalculator.js:119-124`) is the base, `calculateLineTax` (`:116-117`) the rate application, `stampLineTax` (`:147-150`) the per-line stamp, `calculateExpectedTotals` (`:152-187`) the rollup. Three stamp sites (checkout `:971`, table-save tables.js `:1807`, heal helpers.js `:602`) and the rollup reducer (`:174-177`) all consume them.
- ALL frontend tax math is centralized in `src/utils/posTotals.js` (`lineNet:12`, `lineTax:32`, `posTotals:60`), consumed by the store's `totals` computed (`orderSessionStore.js:232-237`) and `heldOrderTotal` (`src/utils/orderNotesTax.js:26-29`). Remaining local FE copies: `getItemTotalGross` (store `:304-309`), `receiptLineTotals.js` fallbacks (`:20-29`, `:35-46`), PosTerminal unit-price template fallback (`PosTerminal.vue:468`).
- Reports, receipts, and refunds all **read stored** `orders.tax` / `order_items.tax_amount` — none re-derive tax from `tax_rate`. Finalized invoices are edit-gated (`checkout.js:165-170, 234-238`). So history is automatically safe; only write/re-stamp paths and live previews change.
- The per-unit surcharge is currently derivable only via `computeModifierSurcharge(product, line)` (`PosCalculator.js:195-205`, DB prices, id-first matching). The `selected_modifiers` snapshot is display-only and its unmatched entries can carry client-supplied prices — it is **not** a legal money source (stable-ids invariant #1 stands).
- **Register holds always re-price:** checkout of a claimed hold runs the fold (`trustClientPrices=false`, no `savedPriceMap`) — there is no frozen path for holds. Anything the claim response displays must therefore be derived by the SAME resolver the fold uses, or the hold cannot be checked out.

## Invariants (do not violate)

1. **`modifier_surcharge` is per-unit, server-authored.** A client-sent value must never reach a money stamp: `normalizeCartItems` STRIPS it (the `...item` spread would otherwise forward it — "don't touch the function" is NOT ignoring the field), and the DB fold (`applyDatabasePrices`) / frozen-price pins are the only writers on persisting paths. The strip lands in Task 2 together with the math, before any attach exists.
2. **NULL ≡ old/full-price tax; positive number ≡ reduced tax base.** Store `NULL`, not `0`, for no surcharge, custom lines, fee lines, and legacy rows. `taxableLineTotal`/`taxableLineNet` still treat null/0/absent the same in math, but DB identity uses `<=>` (merge match), so writing `0` would split legacy-NULL rows from semantically identical no-surcharge rows. Never backfill historical rows.
3. **Subtotal semantics unchanged.** The surcharge stays inside `price` / `price_at_sale` / `orders.subtotal` / receipt rows. Only the tax base shrinks. `assertNearMoney('Subtotal', ...)` expectations do not move.
4. **Surcharge rides with price.** Every site that assigns, pins, or copies `price_at_sale` does the identical thing for `modifier_surcharge` (fold, checkout settle pin, table-save pin, split-creation pin, merge row copies, heal SELECT).
5. Tax-inclusive mode and tax-exempt behavior are untouched (tax already 0 there).
6. `selected_modifiers` snapshot stays a non-money display field.
7. New 400/403/409 messages must not contain "table"/"exist"/ER_/SQLSTATE (sendError sanitizer). NOTE: the mixed-group refresh error in Task 5 Step 2 must therefore avoid the word "table" — the text given there is pre-checked.
8. FE and BE formulas must stay shape-identical (raw-sum → round once) or checkout 400s on Total at the 0.02 tolerance.
9. **Single activation commit.** The field's writers — `applyDatabasePrices` attach, `confirmModifiers` FE attach, claim legacy attach — all land together in Task 7, strictly AFTER every carrier (Tasks 4-6). Every commit before Task 7 must leave all organic data NULL → identical old math on FE and BE. Every commit is deployable; only the Task 7 commit changes behavior.

## Non-goals (explicitly out of scope)

- Receipt/presentation contract changes (no separate surcharge row, no per-line tax rows). The v1 contract carries `summary.taxAmount` from stored/rollup values — it follows automatically. **No spooler deploy.**
- The dropped register-audit T9 note↔selection forgery check (DB-anchored note parsing) stays deferred — with surcharge untaxed AND money DB-sourced, a forged note no longer moves any number.
- Inclusive-mode per-line `tax_amount = 0` stamping inconsistency (obs 2939).
- Admin UI exposure of the new column; notes-category pseudo-modifiers; QR drafts (carry no modifiers).

## Global constraints

- Test runner is **Vitest**: `npx vitest run <files>` — ONE vitest process at a time (shared `posapp_test` DB). Focused files during implementation; full suite exactly ONCE at the end (Task 9).
- Commit after every task (`feat(pos):` / `test(pos):` / `docs(pos):`).
- FE has no SFC harness — store logic unit-tested via `backend/tests/unit/orderSessionStore.test.js`; Vue component changes verified by `npm run build`.
- Schema parity: DDL goes to `backend/tests/fixtures/seed.js` AND a migration file; apply the migration to the dev DB before running `node scripts/validate-schema-drift.js`.
- **Tasks 2-6 must not change any existing test's result.** If a pre-existing test flips during those tasks, the task leaked behavior — stop and find the leak; do not update the test.
- **Existing modifier-cart tests WILL fail during Task 7 (activation) — that is the expected new behavior, not a regression.** The sweep is part of Task 7's commit; Task 8 catches stragglers. NEVER "fix" production code to keep an old expected total green; never delete a test to silence it.

## File map

| File | Change | Task |
|---|---|---|
| `backend/migrations/2026-07-12-modifier-surcharge-untaxed.sql` + `apply-modifier-surcharge-untaxed.js` | **Create** — add column (no backfill) | 1 |
| `backend/tests/fixtures/seed.js` | `order_items` CREATE gains `modifier_surcharge` | 1 |
| `backend/services/PosCalculator.js` | `sanitizeModifierSurcharge`, `taxableLineTotal`; `stampLineTax` + rollup reducer use taxable base; `normalizeCartItems` strips client `modifier_surcharge` (spread would carry it) | 2 |
| `src/utils/posTotals.js` | `taxableLineNet`; `lineTax`/`lineGross` use it | 3 |
| `src/utils/receiptLineTotals.js` | fallback gross + `splitCheckTotals` use taxable net | 3 |
| `backend/routes/pos/checkout.js` | INSERT column (4); settle SELECT + `registerSavedRow` + pin loop + mixed-group reject (5) | 4, 5 |
| `backend/routes/pos/tables.js` | save INSERT + merge copy INSERTs + `<=>` match (4); save pin + split-creation SELECT/maps/pin + mixed-group rejects (5); GET table_order emits (6) | 4, 5, 6 |
| `backend/routes/pos/helpers.js` | `recomputeOrderTotals` reads column (4); `applyDatabasePrices` attaches surcharge (7) | 4, 7 |
| `backend/routes/pos/orders.js` | claim preserve-by-index (5); claim legacy DB-attach (7) | 5, 7 |
| `backend/services/ReceiptPresentationSources.js` | held/split presentation `builderItems` passes the field through | 5 |
| `backend/routes/print.js` | guest-check `builderItems` + split payload items pass the field through | 5 |
| `assets/js/composables/stores/orderSessionStore.js` | `processFinalAddToCart` passthrough, restore maps, `getItemTotalGross` + new `getItemUnitGross` (6); `confirmModifiers` attach (7) | 6, 7 |
| `src/components/PosTerminal.vue` | unit-price fallback uses `getItemUnitGross` | 6 |
| Tests | `PosCalculator.test.js`, `posTotals.test.js`, `posTotalsParity.test.js`, `receiptLineTotals.test.js`, `orderSessionStore.test.js`, `integration/checkout.test.js`, `tables.test.js`, `heldOrders.test.js`, refunds/partial-void file + expected-value sweep | 2-8 |

## New-math rule (use to update/author every expected value)

For a line with folded unit price `p`, per-unit surcharge `s`, qty `q`, rate `r`%, line discount `d`, order-discount ratio `ρ`:

```
taxableNet(line) = same net formula as today, but with unit price (p − s) instead of p
                 = max(0, (p − s)·q  − fixed·q)            for fixed line discounts
                 = max(0, (p − s)·q · (1 − pct/100))        for percent line discounts
tax(line)        = taxableNet · ρ · r/100        (raw; summed across lines, rounded once)
subtotal         = unchanged (full p·q net math)
total            = discountedSubtotal + Σtax     (exclusive mode; inclusive unchanged)
```

Worked example used throughout: base 5.00 + "Large" +2.00 ⇒ `p = 7.00`, `s = 2.00`, 16%: subtotal **7.00**, tax **0.80** (was 1.12), total **7.80** (was 8.12).

## SQL-seeded fixture pattern (Tasks 4-6)

Before Task 7 nothing creates the field organically, so plumbing tests plant it by hand and prove the conduit:

```sql
UPDATE order_items SET modifier_surcharge = 2.00, tax_amount = 0.80 WHERE id = ?;
UPDATE orders SET tax = 0.80, total = 7.80 WHERE invoice_id = ?;
```

(or hand-INSERT a `held_orders` row whose `cart_data` items carry `"modifier_surcharge": 2`). The Task 2 math is already live, so a seeded row settling at 7.80 → 200 proves the pin conduit end-to-end without any organic writer existing.

---

### Task 0: Anchor re-verification (no code)

- [ ] **Step 1:** `git merge-base --is-ancestor 1508443d HEAD` must exit 0. Run `npx vitest run` once to record the green baseline (expect 1187; if higher, note the number — it is the Task 9 floor).
- [ ] **Step 2:** Spot-check load-bearing anchors (quoted code, lines are hints):
  - fold: `const expected = Number((basePrice + extraPrice).toFixed(4));` — `backend/routes/pos/helpers.js:406`
  - stamp: `const stampLineTax = (item, taxRate, discountRatio = 1, taxInclusivePricing = false) =>` — `PosCalculator.js:147`
  - rollup reducer: `return sum + (calculateLineTotal(item) * discountRatio * (taxRate / 100));` — `PosCalculator.js:176`
  - checkout INSERT column list — `checkout.js:986`; table-save INSERT — `tables.js:1820`
  - checkout `registerSavedRow` — `checkout.js:467`; table-save pin block — `tables.js:1457-1505`; split parent SELECT — `tables.js:2247-2251`
  - claim: `let items = normalizeCartItems(` — `orders.js:105`; deep copy `const originalItems = JSON.parse(` — `orders.js:120`
  - FE `lineTax` — `src/utils/posTotals.js:32-39`; store fold — `orderSessionStore.js:2129`

### Task 1: Schema — `order_items.modifier_surcharge`

**Files:**
- Create: `backend/migrations/2026-07-12-modifier-surcharge-untaxed.sql`, `backend/migrations/apply-modifier-surcharge-untaxed.js`
- Modify: `backend/tests/fixtures/seed.js` (order_items CREATE, directly after the `selected_modifiers longtext DEFAULT NULL,` line)

**Interfaces:**
- Produces: nullable per-unit money column `order_items.modifier_surcharge decimal(10,6) DEFAULT NULL`. NULL means "unknown/legacy — tax the full price". No backfill, ever (invariant 2).

- [ ] **Step 1: SQL file**

```sql
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS modifier_surcharge decimal(10,6) DEFAULT NULL;
```

- [ ] **Step 2: Apply script** — copy `backend/migrations/apply-modifier-stable-ids.js` structure exactly (dotenv env-file switch, confirm gate, idempotent information_schema probe) with these substitutions: gate env `MODIFIER_SURCHARGE_MIGRATION_CONFIRM` = `apply-modifier-surcharge`, column `modifier_surcharge`, SQL file name above, and **delete the entire products-backfill section** (this migration has no backfill; the script only adds the column).
- [ ] **Step 3: seed.js** — in the `order_items` CREATE TABLE, after `selected_modifiers longtext DEFAULT NULL,` add:

```sql
          modifier_surcharge decimal(10,6) DEFAULT NULL,
```

- [ ] **Step 4: Apply + verify.** PowerShell: `$env:MODIFIER_SURCHARGE_MIGRATION_CONFIRM='apply-modifier-surcharge'; node backend/migrations/apply-modifier-surcharge-untaxed.js` against the DEV database. Run it AGAIN — expect the "already exists, skipping" path (idempotence proof). Then run any seeded test once (e.g. `npx vitest run backend/tests/unit/PosCalculator.test.js`) and `node scripts/validate-schema-drift.js` — expect no drift.
- [ ] **Step 5: Commit** — `git add backend/migrations backend/tests/fixtures/seed.js && git commit -m "feat(pos): order_items.modifier_surcharge column"`

**PROD NOTE (do not lose):** production deploy order is: (1) stable-ids migration (applied 2026-07-12 to the live posapp DB), (2) this migration, (3) deploy code. The code's INSERTs name the column — deploying code before DDL breaks every checkout. Task 9 adds this to the runbook.

### Task 2: Backend math authority — taxable base in `PosCalculator`

**Files:**
- Modify: `backend/services/PosCalculator.js`
- Test: `backend/tests/unit/PosCalculator.test.js`

**Interfaces:**
- Produces: `sanitizeModifierSurcharge(value) -> number|null` (finite, >0, ≤10000, else null); `taxableLineTotal(item) -> number` (line net with unit price reduced by `item.modifier_surcharge`); `stampLineTax` and the `calculateExpectedTotals` tax reducer now consume `taxableLineTotal`. Both new functions exported (later tasks + tests consume them).
- **Behavior note:** inert. No code path sets `modifier_surcharge`, and `normalizeCartItems` now strips client-sent values (without the strip the `...item` spread would forward them into the new math — a live forgery window at this commit). Behavior first changes in Task 7.

- [ ] **Step 1: Write the failing tests** (append to `PosCalculator.test.js`; keep every existing test untouched)

```js
describe('untaxed modifier surcharge (taxable base)', () => {
    const { taxableLineTotal, sanitizeModifierSurcharge, stampLineTax, calculateExpectedTotals, normalizeCartItems } =
        require('../../services/PosCalculator');

    it('subtracts the per-unit surcharge from the tax base only', () => {
        const line = { price: 7, qty: 2, modifier_surcharge: 2 };
        expect(taxableLineTotal(line)).toBe(10);           // (7-2)*2
        expect(stampLineTax(line, 16)).toBeCloseTo(1.6, 9); // 10 * 16%
    });

    it('treats NULL/absent/0 surcharge as legacy full-price math', () => {
        expect(taxableLineTotal({ price: 7, qty: 2 })).toBe(14);
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: null })).toBe(14);
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: 0 })).toBe(14);
        expect(stampLineTax({ price: 7, qty: 2, modifier_surcharge: null }, 16)).toBeCloseTo(2.24, 9);
    });

    it('clamps when the surcharge exceeds the (manager-overridden) price', () => {
        expect(taxableLineTotal({ price: 1, qty: 1, modifier_surcharge: 2 })).toBe(0);
        expect(stampLineTax({ price: 1, qty: 1, modifier_surcharge: 2 }, 16)).toBe(0);
    });

    it('applies line discounts to the reduced base (same shapes as full-price math)', () => {
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: 2, discountType: 'percent', discountValue: 50 })).toBe(5);
        expect(taxableLineTotal({ price: 7, qty: 2, modifier_surcharge: 2, discountType: 'fixed', discountValue: 1 })).toBe(8);
        expect(taxableLineTotal({ price: 7, qty: 1, modifier_surcharge: 2, discountType: 'fixed', discountValue: 6 })).toBe(0); // clamped
    });

    it('rollup: tax excludes surcharge, subtotal keeps it, inclusive mode unchanged', () => {
        const cart = [{ product_id: 1, price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }];
        const excl = calculateExpectedTotals({}, cart, new Map(), false);
        expect(excl.subtotal).toBe(7);
        expect(excl.tax).toBe(0.8);
        expect(excl.total).toBe(7.8);
        const incl = calculateExpectedTotals({}, cart, new Map(), true);
        expect(incl.tax).toBe(0);
        expect(incl.total).toBe(7);
    });

    it('rollup: order discount ratio prorates the taxable base', () => {
        // subtotal 7, 50% order discount -> ratio 0.5 -> tax = 5 * 0.5 * 16% = 0.40
        const cart = [{ product_id: 1, price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }];
        const out = calculateExpectedTotals(
            { order_discount_type: 'percent', order_discount_value: 50 }, cart, new Map(), false);
        expect(out.tax).toBe(0.4);
        expect(out.total).toBe(3.9);
    });

    it('sanitizer bounds values; normalizeCartItems strips client money metadata', () => {
        expect(sanitizeModifierSurcharge('2.5')).toBe(2.5);
        expect(sanitizeModifierSurcharge(0)).toBeNull();
        expect(sanitizeModifierSurcharge(-1)).toBeNull();
        expect(sanitizeModifierSurcharge('evil')).toBeNull();
        expect(sanitizeModifierSurcharge(10001)).toBeNull();
        const [prod, fee, custom] = normalizeCartItems([
            { id: 1, qty: 1, price: 7, modifier_surcharge: 2 },
            { qty: 1, price: 3, note: 'Auto-Gratuity', name: '10% Service Charge', modifier_surcharge: 2 },
            { qty: 1, price: 4, name: 'Open Item', modifier_surcharge: 2 }
        ]);
        expect(prod.modifier_surcharge).toBeUndefined();
        expect(fee.modifier_surcharge).toBeUndefined();
        expect(custom.modifier_surcharge).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/unit/PosCalculator.test.js` → FAIL (`taxableLineTotal` not exported).
- [ ] **Step 3: Implement** in `PosCalculator.js`:

Add near `sanitizeSelectedModifiers`:

```js
// modifier_surcharge is per-unit, server-authored money metadata: the DB fold
// (applyDatabasePrices) and the frozen-price pins overwrite it on every
// persisting path. This sanitizer only bounds what flows through preview /
// held payloads. 0/absent/garbage all collapse to null (≡ legacy full-price tax).
const sanitizeModifierSurcharge = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? parsed : null;
};
```

Add directly under `calculateLineTotal`:

```js
// Tax base for one line: the folded price minus the per-unit modifier surcharge.
// NULL/absent surcharge is identical to 0 — legacy rows keep taxing the full
// price with no discriminator branch. Never derive this from selected_modifiers.
const taxableLineTotal = (item) => {
    const surcharge = toFiniteNumber(item.modifier_surcharge, 0);
    if (surcharge <= 0) return calculateLineTotal(item);
    return calculateLineTotal({
        ...item,
        price: Math.max(0, toFiniteNumber(item.price) - surcharge)
    });
};
```

Change `stampLineTax` (`:147-150`) to:

```js
const stampLineTax = (item, taxRate, discountRatio = 1, taxInclusivePricing = false) =>
    taxInclusivePricing
        ? 0
        : calculateLineTax(taxableLineTotal(item), taxRate, discountRatio);
```

Change the `calculateExpectedTotals` tax reducer (`:174-177`) to:

```js
    const tax = cartItems.reduce((sum, item) => {
        const taxRate = resolveLineTaxRate(item, productMap, taxRateOverrides);
        return sum + (taxableLineTotal(item) * discountRatio * (taxRate / 100));
    }, 0);
```

(The `subtotal` reducer at `:153` stays on `calculateLineTotal` — invariant 3.)

In `normalizeCartItems`, **actively strip** the client field. The returned object starts with `...item` (`PosCalculator.js:96-97`) — the spread CARRIES a client-sent `modifier_surcharge` through; leaving the function untouched does NOT ignore the field, it forwards it straight into the new `stampLineTax`, and Task 2 alone would be a deployable tax-forgery window (client sends `modifier_surcharge` + matching lower totals → `assertNearMoney` passes → undercharged). Add to the returned object:

```js
            // modifier_surcharge is server-authored money metadata. The ...item spread
            // would forward a client-sent value into the tax base, so strip it here;
            // applyDatabasePrices/frozen pins attach the real value on persisting paths.
            modifier_surcharge: undefined,
```

(`undefined` keeps the Step 1 `toBeUndefined()` assertions green, is dropped by `JSON.stringify` in held/split cart_data writes, and reads as 0 in `taxableLineTotal` — so Task 2 stays inert AND forge-proof at its own commit boundary. Server paths mutate the items AFTER normalize, so later fold/pin attaches are unaffected.)

Export `taxableLineTotal` and `sanitizeModifierSurcharge` from `module.exports`.

- [ ] **Step 4: Run** — `npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/helpers.test.js` → PASS, including all pre-existing tests (nothing sets the field yet).
- [ ] **Step 5: Commit** — `git commit -am "feat(pos): taxable line base excludes modifier surcharge"`

### Task 3: Frontend math authority — `posTotals` + `receiptLineTotals`

**Files:**
- Modify: `src/utils/posTotals.js`, `src/utils/receiptLineTotals.js`
- Test: `backend/tests/unit/posTotals.test.js`, `backend/tests/unit/posTotalsParity.test.js`, `backend/tests/unit/receiptLineTotals.test.js`

**Interfaces:**
- Produces: `taxableLineNet(item)` exported from `posTotals.js`; `lineTax` and `lineGross` consume it. `receiptLineTotals` fallbacks mirror the same base. Formula shape must remain identical to Task 2's backend versions (invariant 8).
- **Behavior note:** inert — no FE cart line carries the field until Tasks 6-7, and null/absent reproduces today's outputs exactly.

- [ ] **Step 1: Write the failing tests.** Append to `posTotals.test.js`:

```js
describe('untaxed modifier surcharge', () => {
    it('lineTax uses price minus surcharge; lineNet keeps full price', () => {
        const line = { price: 7, qty: 2, tax_rate: 16, modifier_surcharge: 2 };
        expect(lineNet(line)).toBe(14);
        expect(lineTax(line)).toBeCloseTo(1.6, 9);          // (7-2)*2*16%
        expect(lineGross(line)).toBeCloseTo(15.6, 9);       // 14 + 1.6
        expect(lineTax({ ...line, modifier_surcharge: null })).toBeCloseTo(2.24, 9);
        expect(lineTax({ price: 1, qty: 1, tax_rate: 16, modifier_surcharge: 2 })).toBe(0); // clamp
    });

    it('posTotals: subtotal keeps surcharge, tax excludes it', () => {
        const out = posTotals([{ price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }], {}, {});
        expect(out.subtotal).toBe(7);
        expect(out.tax).toBe(0.8);
        expect(out.total).toBe(7.8);
        const incl = posTotals([{ price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }], {}, { taxInclusive: true });
        expect(incl.tax).toBe(0);
        expect(incl.total).toBe(7);
    });
});
```

(`lineNet`, `lineTax`, `lineGross`, `posTotals` are already imported at the top of that file — extend the import only if one is missing.)

Append to `posTotalsParity.test.js` a parity case with a surcharge line — mirror however that file already pairs FE `posTotals` vs backend `calculateExpectedTotals` (read its existing cases first and copy the harness shape exactly), with cart `[{ product_id: 1, price: 7, qty: 3, tax_rate: 16, modifier_surcharge: 2, discountType: 'percent', discountValue: 10 }]` plus an order discount `{ type: 'percent', value: 25 }`, asserting FE tax/total === BE tax/total.

Append to `receiptLineTotals.test.js`:

```js
describe('untaxed modifier surcharge fallbacks', () => {
    it('receiptItemDisplayTotal fallback grosses up only the base', () => {
        // no saved tax_amount -> fallback path
        const item = { price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 };
        expect(receiptItemDisplayTotal(item)).toBeCloseTo(7.8, 9);
        // saved tax_amount still wins verbatim
        expect(receiptItemDisplayTotal({ ...item, tax_amount: 1.12 })).toBeCloseTo(8.12, 9);
    });

    it('splitCheckTotals taxes the reduced base', () => {
        const out = splitCheckTotals([{ price: 7, qty: 1, tax_rate: 16, modifier_surcharge: 2 }]);
        expect(out.subtotal).toBe(7);
        expect(out.tax).toBeCloseTo(0.8, 9);
        expect(out.total).toBe(7.8);
    });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/unit/posTotals.test.js backend/tests/unit/receiptLineTotals.test.js` → FAIL (old full-price tax values).
- [ ] **Step 3: Implement.** In `src/utils/posTotals.js` add after `lineNet`:

```js
// Tax base: folded price minus per-unit modifier surcharge (server-authored,
// carried on restored/held lines). null/absent/0 => full-price legacy math.
export const taxableLineNet = (item = {}) => {
    const surcharge = parseFinite(item.modifier_surcharge);
    if (surcharge <= 0) return lineNet(item);
    return lineNet({ ...item, price: Math.max(0, parseFinite(item.price) - surcharge) });
};
```

Change `lineTax` (`:32-39`) last line to `return taxableLineNet(item) * ratio * (rate / 100);` and `lineGross` (`:41-45`) to:

```js
export const lineGross = (item, opts = {}) => {
    const net = lineNet(item);
    if (opts.taxExempt || opts.taxInclusive) return net;
    return net + taxableLineNet(item) * (parseFinite(item?.tax_rate) / 100);
};
```

In `src/utils/receiptLineTotals.js` add:

```js
function taxableNetTotal(item = {}) {
  const surcharge = toNumber(item.modifier_surcharge);
  if (!(surcharge > 0)) return receiptItemNetTotal(item);
  const price = toNumber(item.price ?? item.price_at_sale);
  return receiptItemNetTotal({ ...item, price: Math.max(0, price - surcharge) });
}
```

Change `receiptItemDisplayTotal`'s fallback line (`:27-28`) to:

```js
  const taxRate = toNumber(item.tax_rate ?? item.taxRate);
  return netTotal + taxableNetTotal(item) * (taxRate / 100);
```

Change `splitCheckTotals`'s tax accumulation (`:41`) to:

```js
        tax += taxableNetTotal(item) * (toNumber(item.tax_rate ?? item.taxRate) / 100);
```

- [ ] **Step 4: Run** — `npx vitest run backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/receiptLineTotals.test.js backend/tests/unit/orderNotesTax.test.js` (last one if it exists; `orderNotesTax.js` spreads `...source` so the field flows through untouched) → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(pos): frontend tax math excludes modifier surcharge"`

### Task 4: Inert plumbing I — persist, copy, heal

**Files:**
- Modify: `backend/routes/pos/checkout.js` (INSERT `:986-1001`), `backend/routes/pos/tables.js` (save INSERT `:1820-1835`, merge copies `:425-426` and `:476-477`, merge match `:448-458`), `backend/routes/pos/helpers.js` (`recomputeOrderTotals:564-611`)
- Test: `backend/tests/integration/tables.test.js` (merge), the partial-void integration file (grep `recomputeOrderTotals` callers' tests)

**Interfaces:**
- Consumes: `taxableLineTotal` via `stampLineTax` (Task 2) — no new imports at stamp sites. Produces: both order_items INSERTs persist `item.modifier_surcharge ?? null`; merge copies it and never collapses rows with different surcharges; heal reads it back.
- **Behavior note:** inert — nothing attaches the field to cart lines, so every organic INSERT writes NULL and heal reads NULL → old math. Tests plant values with the SQL-seeded fixture pattern. All pre-existing tests must stay green.

- [ ] **Step 1: Write the failing tests.**
  - Merge copy + collapse guard (extend the existing merge test in `tables.test.js` that already asserts `selected_modifiers` copying): after saving source+target orders organically, SQL-seed the SOURCE row `modifier_surcharge = 2.00` (fixture pattern), merge, then assert the copied row carries `2.00`; add a second case seeding target NULL + source `2.00` on identical product/note/price/tax and assert the merge produces TWO rows (no qty collapse), each keeping its own surcharge; assert the target order's `orders.tax` after the merge recompute uses the reduced base for the seeded row.
  - Partial-void heal (append a sibling to the existing partial-void test): save a table order with two lines, SQL-seed line 1 `modifier_surcharge = 2.00`, partially void line 2, then assert line 1's `tax_amount` is the reduced (base-only) value and `orders.tax` matches — proving heal read the column instead of re-taxing the full price.
- [ ] **Step 2: Run to verify failure** — copied row lacks the column / heal re-taxes full price.
- [ ] **Step 3: Implement.**

`checkout.js` INSERT (`:986`) — column list gains `modifier_surcharge` after `selected_modifiers`, params gain the value after the snapshot param:

```js
                    "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, note, selected_modifiers, modifier_surcharge, discount_type, discount_value, sort_order, parent_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
```

with `item.modifier_surcharge ?? null` inserted after the snapshot param. `tables.js` save INSERT (`:1820`): identical change.

`tables.js` merge copies — both INSERTs (`:425-426` and `:476-477`) gain `modifier_surcharge` after `selected_modifiers` in the column list and `item.modifier_surcharge` after `item.selected_modifiers` in params (source rows come from `SELECT *`, the field is present).

`tables.js` merge qty-increment match (`:448-458`): the existing-row SELECT predicate gains `AND modifier_surcharge <=> ?` (param `item.modifier_surcharge`), so a legacy-NULL row and a valued row with identical note/price never collapse into one row (they carry different tax bases; collapsing would silently retax the source units at the target's base).

`helpers.js` `recomputeOrderTotals`:
- SELECT (`:564-566`) gains `modifier_surcharge`:

```js
        "SELECT id, product_id, quantity, price_at_sale, discount_type, discount_value, tax_rate, parent_item_id, modifier_surcharge FROM order_items WHERE invoice_id = ?",
```

- `cartItems` map (`:570-577`) gains `modifier_surcharge: it.modifier_surcharge != null ? Number(it.modifier_surcharge) : null,`
- `lineLike` (`:596-601`) gains the same line.
- Update the function's header comment (`:548-552`): add `// modifier_surcharge is frozen like price_at_sale: heal READS it, never recomputes it.`

- [ ] **Step 4: Run** — new tests PASS; then `npx vitest run backend/tests/integration/tables.test.js` plus the partial-void file → every pre-existing test still green (inertness proof).
- [ ] **Step 5: Commit** — `git commit -am "feat(pos): persist and copy modifier_surcharge (inert, no writer)"`

### Task 5: Inert plumbing II — frozen pins, claim preserve, presentation/print passthroughs

**Files:**
- Modify: `backend/routes/pos/checkout.js` (settle SELECT `:492`, `registerSavedRow:467-489`, split register `:543-576`, group-fallback context `:612-628`, pin assignment `:629`), `backend/routes/pos/tables.js` (save SELECT `:1408`, save pin `:1461-1505`, split parent SELECT `:2247-2251`, split maps `:2263-2274`, split pin `:2332-2361`), `backend/routes/pos/orders.js` (claim preserve loop), `backend/services/ReceiptPresentationSources.js` (`:266-308`), `backend/routes/print.js` (guest-check `builderItems:291-305`, split payload items `:248-257`)
- Test: `backend/tests/integration/checkout.test.js`, `tables.test.js`, `heldOrders.test.js`

**Interfaces:**
- Rule (invariant 4): wherever these paths assign `item.price` from a saved/frozen source, they now also assign `item.modifier_surcharge` from the same source. Legacy sources without the field yield `null` → old math → totals keep matching what was stored/displayed for those orders.
- **Behavior note:** inert — organic saved rows are all NULL until Task 7, so every pin pins NULL and every mixed-group set is `{null}` (size 1, no reject fires). Tests plant values with the SQL-seeded fixture pattern. All pre-existing tests must stay green.

- [ ] **Step 1: checkout settle pins.**
  - SELECT (`:492`) gains `modifier_surcharge`:

```js
                "SELECT id, product_id, item_name, quantity, note, price_at_sale, tax_rate, selected_modifiers, modifier_surcharge FROM order_items WHERE invoice_id = ?",
```

  - `registerSavedRow` (`:467`) gains a trailing param and context field, plus a group set mirroring the snapshot pattern:

```js
        const registerSavedRow = (id, productId, name, note, price, taxRate, qty, selectedModifiers, modifierSurcharge) => {
            const k = keyOfSaved(productId, name, note);
            savedPriceMap.set(k, price);
            const storedModifierSnapshot = serializeStoredModifierSnapshot(selectedModifiers);
            const surcharge = modifierSurcharge != null && Number.isFinite(Number(modifierSurcharge))
                ? Number(modifierSurcharge) : null;
            const context = {
                price,
                taxRate: Number(taxRate),
                product_id: productId,
                name: name || '',
                note: note || '',
                selectedModifiers: storedModifierSnapshot,
                modifier_surcharge: surcharge,
                remaining: Number(qty) || 0
            };
            if (id != null) savedRowById.set(Number(id), context);
            if (!savedGroupPrices.has(k)) savedGroupPrices.set(k, new Set());
            savedGroupPrices.get(k).add(price);
            if (Number.isFinite(Number(taxRate))) {
                if (!savedGroupTaxRates.has(k)) savedGroupTaxRates.set(k, new Set());
                savedGroupTaxRates.get(k).add(Number(taxRate));
            }
            if (!savedGroupModifierSnapshots.has(k)) savedGroupModifierSnapshots.set(k, new Set());
            savedGroupModifierSnapshots.get(k).add(storedModifierSnapshot);
            if (!savedGroupSurcharges.has(k)) savedGroupSurcharges.set(k, new Set());
            savedGroupSurcharges.get(k).add(surcharge);
        };
```

  Declare `const savedGroupSurcharges = new Map();` next to the existing `savedGroupModifierSnapshots` declaration (grep for it above `:467`).
  - Both callers pass the new arg: unpaid-settle (`:504`) → `..., it.selected_modifiers, it.modifier_surcharge)`; split register (`:574`) → `..., it.selectedModifiers, it.modifier_surcharge)`.
  - Group-fallback context (`:616-622`) gains a surcharge single-value check. Do **not** pin `null` for a mixed group: that retaxes one side of a legacy/post-deploy mix. If the group has more than one surcharge value and the client did not resolve by `order_item_id`, fail closed and force refresh:

```js
                        const groupSurcharges = savedGroupSurcharges.get(k);
                        if (groupSurcharges && groupSurcharges.size > 1) {
                            const err = new Error("Items cannot be changed while cashing out. Edit the order on the floor plan first.");
                            err.statusCode = 403;
                            throw err;
                        }
                        context = {
                            price: pinned,
                            taxRate: groupTaxRates?.size === 1 ? [...groupTaxRates][0] : null,
                            selectedModifiers: groupModifierSnapshots?.size === 1 ? [...groupModifierSnapshots][0] : null,
                            allowedModifierSnapshots: groupModifierSnapshots || null,
                            modifier_surcharge: groupSurcharges?.size === 1 ? [...groupSurcharges][0] : null
                        };
```

  - Pin assignment (`:629`, `item.price = pinned;`) gains:

```js
                item.price = pinned;
                item.modifier_surcharge = context ? (context.modifier_surcharge ?? null) : null;
```

  (Missing group surcharge still pins `null` for legacy rows; multi-valued surcharge rejects. No last-write-wins.)

- [ ] **Step 2: tables.js save pin.**
  - Saved-rows SELECT (`:1408`) gains `modifier_surcharge` (same column-list edit as Step 1).
  - Map builder (`:1461-1470`): do not use a surcharge map keyed only by product|note. Build saved context with surcharge as part of identity, and keep a group-level surcharge set for no-id fallbacks:

```js
        const surchargeKey = (value) => value == null ? 'NULL' : String(Number(value));
        const fullContextKey = (productId, itemName, note, price, taxRate, surcharge) =>
            `${keyOfSaved(productId, itemName, note)}|${price}|${taxRate}|${surchargeKey(surcharge)}`;
```

  Each saved row context stores `modifier_surcharge: it.modifier_surcharge != null ? Number(it.modifier_surcharge) : null`; `savedContextsByKey` is keyed by `fullContextKey(...)`, not only `price|tax`. Also declare and fill `savedGroupSurcharges: Map<product|note, Set<null|number>>`.
  - Pin loop, three touches:
    1. By-id branch (`:1476-1488`, where `resolvedSavedTaxRates.set(item, Number(row.tax_rate));` runs): add `item.modifier_surcharge = row.modifier_surcharge != null ? Number(row.modifier_surcharge) : null;` and mark the item in a `WeakSet` `surchargePinnedById` — the line's OWN saved row wins, never the group.
    2. Ambiguous-context branch (`:1492-1494`, where `item.price = context.price;` is set): assign `item.modifier_surcharge = context.modifier_surcharge ?? null;` and mark the item in `surchargePinnedById` — with surcharge inside `fullContextKey`, a mixed group makes `contexts.size > 1` and the branch's existing 409 fires by itself.
    3. Group fallback (`:1501-1503`) — if the saved group has exactly one surcharge, assign it with the pinned price; if it has more than one, throw a refresh error. Never last-write-win:

```js
                const groupSurcharges = savedGroupSurcharges.get(k);
                if (groupSurcharges && groupSurcharges.size > 1 && !surchargePinnedById.has(item)) {
                    const err = new Error("Saved item context is stale or ambiguous. Refresh the order and try again.");
                    err.statusCode = 409;
                    throw err;
                }
                if (savedPriceMap.has(k)) {
                    item.price = savedPriceMap.get(k);
                    if (!surchargePinnedById.has(item)) {
                        item.modifier_surcharge = groupSurcharges?.size === 1 ? [...groupSurcharges][0] : null;
                    }
                }
```

  **Ordering note for touch 3:** the `WeakSet` guard is mandatory — do NOT test `item.modifier_surcharge === undefined` (Task 2's strip defines the key on every normalized line, so that test always lies). Error text avoids "table"/"exist" (sendError sanitizer, invariant 7) — reuse the existing "Saved item context is stale or ambiguous" wording as quoted.
  (New lines added to an existing order are not in `savedPriceMap` → the fold attaches their surcharge from Task 7 onward.)

- [ ] **Step 3: split creation pin (tables.js).**
  - Parent SELECT (`:2247-2251`) gains `modifier_surcharge`.
  - `parentContextsByKey` must include surcharge in its identity key (`price|tax|surcharge`), not just in the value. Also build `parentSurchargesByGroup: Map<product|note, Set<null|number>>`.
  - `parentContextsByKey` value (`:2264-2267`) and `parentByLineId` value (`:2268-2274`) each gain `surcharge: item.modifier_surcharge != null ? Number(item.modifier_surcharge) : null`.
  - Pin loop: after `item.price = parentLine.price; item.tax_rate = parentLine.tax;` (`:2345-2347`) add `item.modifier_surcharge = parentLine.surcharge;`; after the context-branch assignments (`:2353-2355`) add `item.modifier_surcharge = context.surcharge;` (with surcharge in the context key, a mixed group makes `contexts.size > 1` and the existing "Split items mismatch" throw fires).
  - If a seat line lacks usable `order_item_id` and its parent product|note group has more than one surcharge value (`parentSurchargesByGroup`), throw the same "Split items mismatch. Please refresh the table order and try again." error. Never choose the last context.
  - Nothing else: the seat items (including the field) are persisted into `held_orders.cart_data` by the existing write, and split settle reads them back through Step 1's split `registerSavedRow` caller.

- [ ] **Step 4: claim preserve-by-index (orders.js).** After `normalizeCartItems` (`:105`, which strips the field) and BEFORE the `originalItems` deep copy at `:120`, restore the server-written value from `cartPayload.items` by index, so post-deploy holds enter both `originalItems` (old-totals side) and `items` with their hold-time value:

```js
        // Held cart_data is server-written at hold-save; normalizeCartItems strips the
        // field, so re-attach the stored value by index (indexes are 1:1 through normalize).
        for (let i = 0; i < items.length; i++) {
            const raw = cartPayload.items?.[i];
            const stored = Number(raw?.modifier_surcharge);
            items[i].modifier_surcharge = Number.isFinite(stored) && stored > 0 ? stored : null;
        }
```

  (The legacy DB-attach loop is deliberately NOT here — it is a writer and lands in Task 7 with the fold; see invariant 9.)

- [ ] **Step 5: presentation + print passthroughs.**
  - `ReceiptPresentationSources.js` — in `heldPresentationInput`'s builderItems return (`:266-276`, the object with `price: item.price ?? item.price_at_sale ?? 0` and `tax_rate: resolvedTaxRate`) add `modifier_surcharge: item.modifier_surcharge ?? null,`. Immediately after `const normalizedItems = normalizeCartItems(builderItems);` reattach the server-loaded field by index before `calculateExpectedTotals`:

```js
    normalizedItems.forEach((item, idx) => {
        const stored = Number(builderItems[idx]?.modifier_surcharge);
        item.modifier_surcharge = Number.isFinite(stored) && stored > 0 ? stored : null;
    });
```

  Do not change `normalizeCartItems` to accept client money metadata. `calculateExpectedTotals` at `:292-308` then prices the presentation exactly like settle. Consumers: held-board cards via `buildHeldPresentations`, split/held print via `print.js:157-161`. Without this, the printed split check / held-board card would show surcharge-TAXED totals while settle charges base-only tax (screen==print==charged violation).
  - `print.js` guest-check `builderItems` map (`:294-304`) gains:

```js
                                modifier_surcharge: item.modifier_surcharge != null && Number.isFinite(Number(item.modifier_surcharge))
                                    ? Number(item.modifier_surcharge) : null,
```

  (Client-built provisional preview, explicitly non-money — the field only keeps the printed guest check's tax line equal to what checkout will charge.)
  - `print.js` split/held payload `items:` map (`:248-257`) lists fields explicitly; add `modifier_surcharge: item.modifier_surcharge ?? null,` so per-line legacy rendering (when no `receipt_display_v1`) stays consistent. (The calc lines at `:212-219` spread `...item` — no edit.)

- [ ] **Step 6: Write the tests** (all SQL-seeded per the fixture pattern; copy harness/payload shapes from the adjacent tests in each file — especially the existing settle and split tests):

In `tables.test.js`:

```js
        it('table settle pins a seeded modifier_surcharge (reduced tax) and legacy NULL rows keep old math', async () => {
            // Arrange A: save a table order organically with the 7.00 modifier line
            // (all rows NULL at this task). SQL-seed the row + order totals per the
            // fixture pattern (surcharge 2.00 / tax 0.80 / total 7.80).
            // Act A: settle via POST /api/pos/checkout (copy the nearest settle test)
            // with totals subtotal 7.00 / tax 0.80 / total 7.80 → expect 200; the
            // re-inserted order_items row keeps modifier_surcharge = 2 and tax_amount ≈ 0.80.
            //
            // Arrange B (legacy): save a second identical order, seed NOTHING.
            // Act B: settle with old-math totals subtotal 7.00 / tax 1.12 / total 8.12 →
            // expect 200 — NULL pins through, old math stands (no 400, no repricing).
            // Both halves are mandatory — B is THE compatibility proof for every open
            // table crossing the activation deploy.
        });

        it('table re-save rejects mixed surcharge group when client line lacks order_item_id', async () => {
            // Seed an unpaid table order with two identical product/note/price/tax rows:
            // SQL-set one modifier_surcharge NULL, the other 2.00.
            // POST save_table_order with same product/note but no order_item_id.
            // Expect 409 refresh (or existing 403 edit-conflict shape), and assert
            // both DB rows keep their original modifier_surcharge values.
        });
```

In `tables.test.js` split describe:

```js
        it('split seats pin a seeded parent surcharge into cart_data and settle at reduced tax', async () => {
            // createTableOrder with the modifier line, SQL-seed the parent row
            // (surcharge 2.00 / tax 0.80) + order totals, then split into one seat:
            // 1) SELECT cart_data FROM held_orders ... — parsed.items[0].modifier_surcharge === 2
            // 2) settle the split check via checkout with split_check_id (copy the nearest
            //    split-settle test), totals 7.00 / 0.80 / 7.80 → 200,
            //    persisted line tax_amount ≈ 0.80.
        });

        it('split creation rejects mixed surcharge group without usable order_item_id', async () => {
            // Seed parent order with two identical product/note/price/tax rows:
            // one modifier_surcharge NULL, one 2.00 (SQL).
            // Submit a split payload for that product/note without order_item_id.
            // Expect the split-mismatch rejection, and assert no held_orders split row
            // was created. This locks "no last-write-wins".
        });
```

In `heldOrders.test.js`:

```js
        it('claim preserves a stored modifier_surcharge from cart_data', async () => {
            // Hand-INSERT a held_orders row whose cart_data items carry
            // "modifier_surcharge": 2 (hold-save does not write it until Task 7).
            // Claim it, then parse claim.body.order.cart_data →
            // items[0].modifier_surcharge === 2 and the claim totals are
            // subtotal 7.00 / tax 0.80 / total 7.80.
        });

        it('held-board presentation prices a stored surcharge like settle', async () => {
            // Same hand-INSERT arrange; GET the held-orders list (buildHeldPresentations
            // route) and assert the hold's receipt_display_v1.summary.taxAmount ≈ 0.80.
        });
```

In `checkout.test.js` — settle mixed-group reject:

```js
        it('unpaid-table settle rejects a mixed surcharge group for id-less lines', async () => {
            // Seed a saved order with two identical product/note/price/tax rows,
            // one NULL and one 2.00 (SQL). Settle with cart lines that omit
            // order_item_id → expect 403 "Items cannot be changed while cashing out".
        });
```

- [ ] **Step 7: Run** — `npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js` → new tests PASS and **every pre-existing test still green** (inertness proof — organic data is all NULL, so no expected value moves in this task).
- [ ] **Step 8: Commit** — `git commit -am "feat(pos): frozen paths pin modifier_surcharge (inert, no writer)"`

### Task 6: Inert plumbing III — read-back emit + FE lifecycle carry + display fallbacks

**Files:**
- Modify: `backend/routes/pos/tables.js` (GET table_order cartItem `:1042-1064`), `assets/js/composables/stores/orderSessionStore.js` (`processFinalAddToCart:1939-1948`, `getItemTotalGross:304-309`, split restore map `:1571-1587`, edit-invoice map `:1663-1687`, held-restore action — grep `restoreHeldOrder`), `src/components/PosTerminal.vue` (`:468` unit-price fallback)
- Test: `backend/tests/integration/tables.test.js` (GET emit), `backend/tests/unit/orderSessionStore.test.js`; `npm run build`

**Interfaces:**
- Consumes: `taxableLineNet`/`lineTax` (Task 3). Produces: every cart line — restored from table, split, edit-invoice, held claim — carries `modifier_surcharge` so the store's `posTotals`-driven computeds price it identically to the server. Add-time attach is NOT here (Task 7).
- **Behavior note:** inert — emitted/restored fields are NULL for all organic data; `getItemTotalGross`/`getItemUnitGross` reproduce today's numbers exactly when the field is null/absent. All pre-existing tests + build stay green.

- [ ] **Step 1: GET emit (failing test first).** In `tables.test.js`: save a table order, SQL-seed the row's `modifier_surcharge = 2.00`, GET `/api/pos/table_order?order_id=...` and assert the cart line carries `modifier_surcharge === 2`. Run → FAIL (field absent). Implement — GET table_order cartItem (`tables.js:1042-1064`) gains:

```js
                modifier_surcharge: item.modifier_surcharge != null ? parseFloat(item.modifier_surcharge) : null,
```

Re-run → PASS.

- [ ] **Step 2: FE carry.**
  - `processFinalAddToCart` `newItem` (`:1939-1948`) gains, next to the `selectedModifiers` line (inert until Task 7 passes the option):

```js
      modifier_surcharge: Number(options.modifierSurcharge) > 0 ? Number(options.modifierSurcharge) : null,
```

  - Split restore map (`orderSessionStore.js:1571-1587`) gains `modifier_surcharge: item.modifier_surcharge ?? null,`
  - Edit-invoice map (`:1663-1687`) gains `modifier_surcharge: item.modifier_surcharge != null ? parseFloat(item.modifier_surcharge) : null,` (admin `order_details` returns `oi.*`, the raw column is present).
  - Held restore: `restoreHeldOrder` (`:565-574`) spreads `...item` — verified, the field flows; no change. Re-verify the spread is still there.
  - `loadActiveTableOrder` (`:830-837`) spreads `{...item}` — no change (verify the spread is still there).

- [ ] **Step 3: Display fallbacks.** `getItemTotalGross` (`:304-309`) becomes (add `lineTax` to the `posTotals.js` import at `:10`):

```js
  const getItemTotalGross = (item) => {
    const pretax = lineNet(item);
    if (isTaxExempt.value || taxInclusivePricing.value) return pretax;
    return pretax + lineTax(item);
  };
```

Add below it, and export from the store alongside `getItemTotalGross`:

```js
  // Unit-price display fallback: gross per unit with the surcharge untaxed.
  const getItemUnitGross = (item) => {
    const price = parseFloat(item.price) || 0;
    if (isTaxExempt.value || taxInclusivePricing.value) return price;
    const surcharge = parseFloat(item.modifier_surcharge) || 0;
    return price + Math.max(0, price - surcharge) * ((parseFloat(item.tax_rate) || 0) / 100);
  };
```

In `PosTerminal.vue` `:468`, replace the inline fallback `(parseFloat(item.price) * (1 + (parseFloat(item.tax_rate) || 0) / 100)).toFixed(2)` with `getItemUnitGross(item).toFixed(2)`, wiring `getItemUnitGross` exactly the way `getItemTotalGross` reaches that template (find its destructure/binding and add the new name beside it). Leave the catalog-tile price at `:318` alone — it prices the base product, which is fully taxed.

- [ ] **Step 4: Store pin test** (append to `orderSessionStore.test.js`, mirroring its Pinia bootstrap — this passes as soon as Task 3 landed; it PINS the FE contract):

```js
    it('cartTax excludes the modifier surcharge; subtotal keeps it', async () => {
        const store = useOrderSessionStore();
        store.cart.push({
            cartId: 't1', id: 1, name: 'Burger', price: 7, qty: 1, tax_rate: 16,
            modifier_surcharge: 2, note: 'Size: Large (2.00 JD)',
            selectedModifiers: [{ gid: 'g', oid: 'o', group: 'Size', option: 'Large', price: 2 }]
        });
        expect(store.cartSubtotal).toBe(7);
        expect(store.cartTax).toBe(0.8);
        expect(store.cartTotal).toBe(7.8);
    });
```

- [ ] **Step 5: Run** — `npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/integration/tables.test.js` → PASS incl. all pre-existing; `npm run build` → green.
- [ ] **Step 6: Commit** — `git commit -am "feat(pos): carry modifier_surcharge through cart lifecycle (inert, no writer)"`

### Task 7: ACTIVATION — the three writers land in one commit

**Files:**
- Modify: `backend/routes/pos/helpers.js` (`applyDatabasePrices:394-413`), `assets/js/composables/stores/orderSessionStore.js` (`confirmModifiers:2129`), `backend/routes/pos/orders.js` (claim legacy attach)
- Test: `backend/tests/integration/checkout.test.js`, `heldOrders.test.js`, `tables.test.js` + expected-value sweep

**Why one commit:** the fold attach changes server-expected totals on fresh paths; the FE add-time attach changes what clients compute; the claim legacy attach changes claimed payloads. Any subset deployed alone makes FE and BE totals diverge → 400 storms on fresh modifier sales, reloaded tables, or claims. Tasks 4-6 made every carrier ready precisely so this flip is total. (This commit is also where existing modifier-cart tests move to the new expected values — the sweep is part of this commit so it stays green.)

- [ ] **Step 1: Write the failing tests** (append inside `checkout.test.js`'s main describe; copy harness names — `openShift()`, `cashierCookie`, `cashierShiftId`, `SEED.*` — and the invoice-id resolution from the nearest existing modifier test in the file, NOT from this plan):

```js
    it('taxes a modifier line on its base price only and persists the surcharge', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]);
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [modifiersJson, SEED.modifierProduct.id]);
        // base 5.00 + 2.00 = 7.00 folded; tax 16% of 5.00 = 0.80
        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.modifierProduct.id, qty: 1, price: 7.00, tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }]
            }],
            shift_id: cashierShiftId,
            subtotal: 7.00, tax: 0.80, total: 7.80,
            payment_method: 'cash', amount_tendered: 7.80, change_due: 0
        });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query(
            'SELECT price_at_sale, tax_amount, modifier_surcharge FROM order_items WHERE invoice_id = ? AND product_id = ?',
            [res.body.invoice_id, SEED.modifierProduct.id]);
        expect(Number(row.price_at_sale)).toBe(7);
        expect(Number(row.modifier_surcharge)).toBe(2);
        expect(Number(row.tax_amount)).toBeCloseTo(0.80, 6);
        const [[order]] = await pool.query('SELECT tax, total FROM orders WHERE invoice_id = ?', [res.body.invoice_id]);
        expect(Number(order.tax)).toBeCloseTo(0.80, 6);
        expect(Number(order.total)).toBeCloseTo(7.80, 6);
    });

    it('a client-forged modifier_surcharge on a plain line never reaches the stamp', async () => {
        await openShift();
        // plain product, forged field: normalize strips it, the fold writes NULL -> full tax.
        // Client totals are computed with the correct (full) tax so the request passes;
        // the assertion is on what got STAMPED.
        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16, modifier_surcharge: 4.99 }],
            shift_id: cashierShiftId,
            subtotal: 5.00, tax: 0.80, total: 5.80,
            payment_method: 'cash', amount_tendered: 5.80, change_due: 0
        });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query(
            'SELECT tax_amount, modifier_surcharge FROM order_items WHERE invoice_id = ?', [res.body.invoice_id]);
        expect(row.modifier_surcharge).toBeNull();
        expect(Number(row.tax_amount)).toBeCloseTo(0.80, 6);
    });
```

(Adjust `SEED.product1` price/tax arithmetic to the real seed values — read `seed.js` first. If a lower total is submitted with the forged field, expect 400 on Total instead; both assertions are valid, the row-level one is mandatory.)

In `heldOrders.test.js` — hold-save writes the field organically; legacy claim DB-attaches and checks out:

```js
        it('hold persists server-computed modifier_surcharge in cart_data', async () => {
            // POST /held_orders with the modifier line (client sends NO modifier_surcharge);
            // read held_orders.cart_data → items[0].modifier_surcharge === 2.
            // ALSO: GET the held-orders list and assert receipt_display_v1.summary.taxAmount ≈ 0.80
            // (organic twin of the Task 5 seeded presentation test).
        });

        it('claim DB-attaches a legacy hold and the claimed cart checks out end-to-end', async () => {
            // INSERT a held_orders row directly with cart_data items lacking the field
            // (copy the legacy-hold test pattern already in this file; id-bearing
            // selectedModifiers, folded price 7.00). Claim it, then:
            // 1) parse claim.body.order.cart_data → items[0].modifier_surcharge === 2
            //    (claim attaches with the SAME resolver checkout's fold uses);
            // 2) the claim response reports the totals change (old 8.12 → new 7.80) —
            //    copy how the existing claim tests read the warning/oldTotals fields;
            // 3) E2E proof the flow is not bricked: POST /api/pos/checkout with the
            //    claimed items and totals 7.00 / 0.80 / 7.80 → 200, persisted
            //    tax_amount ≈ 0.80. (A claim-only assertion would go green even if
            //    checkout 400s on every legacy hold — the checkout leg is mandatory.)
        });
```

In `tables.test.js` — organic save→settle (fold now attaches at save):

```js
        it('table saved after activation stamps reduced tax and settles at it', async () => {
            // Save via route with the 7.00 modifier line (no SQL seeding) → assert the
            // saved row has modifier_surcharge = 2, tax_amount ≈ 0.80, orders.tax ≈ 0.80.
            // Then settle at 7.00 / 0.80 / 7.80 → 200.
        });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js` → the new tests FAIL (400 Total mismatch / missing field: nothing attaches yet). Pre-existing modifier tests still PASS at this point.
- [ ] **Step 3: Implement the three writers.**

`helpers.js` `applyDatabasePrices` — attach unconditionally where the fold computes (after `:406`, before the `isManager` branch, so manager price overrides still get the DB surcharge). NULL, not 0, when no surcharge (invariant 2):

```js
            const basePrice = Number(product.price);
            const extraPrice = computeModifierSurcharge(product, item);
            const expected = Number((basePrice + extraPrice).toFixed(4));
            item.modifier_surcharge = extraPrice > 0 ? Number(extraPrice.toFixed(4)) : null;
            if (!isManager) {
```

`orderSessionStore.js` `confirmModifiers` final call (`:2129`) becomes (Task 6's `processFinalAddToCart` passthrough consumes the option):

```js
    processFinalAddToCart(product, ui.activeModifierQty, parseFloat(product.price) + extraPrice, noteLines.join('\n'), { selectedModifiers, modifierSurcharge: extraPrice });
```

`orders.js` claim — legacy DB-attach, AFTER the `originalItems` copy (`:120`) and after the tax-rate refresh loop ending `:135`, BEFORE `loadCheckoutSettings` (`:141`). Placement matters: `originalItems` must NOT get this value, so `oldTotals` reproduces the hold-time (old-math) display and the totals-changed warning fires for legacy holds. **Why legacy holds cannot "stay old-math":** register holds have no frozen settle path — checkout of a claimed cart always re-runs the fold, which attaches the CURRENT DB surcharge unconditionally. A legacy hold claimed with `null` would display 8.12 while checkout computes 7.80 → unrecoverable `Total mismatch` 400. Claim must attach with the same resolver the fold uses so what the cashier sees is what will be charged; the totals-changed warning is then truthful:

```js
        // Legacy holds parked before the surcharge deploy carry no field. Attach the
        // DB-derived value (same resolver checkout's fold uses) so the claim display
        // matches what checkout will actually charge. originalItems was copied above,
        // so oldTotals still shows the hold-time old-math figure and the warning fires.
        for (const item of items) {
            if (item.note === 'Auto-Gratuity' || item.product_id == null) continue;
            if (item.modifier_surcharge == null) {
                const product = productMap.get(item.product_id);
                const derived = product ? computeModifierSurcharge(product, item) : 0;
                item.modifier_surcharge = derived > 0 ? derived : null;
            }
        }
```

Extend the PosCalculator require (`orders.js:23`) with `computeModifierSurcharge`. Held-order SAVE needs no change — `applyDatabasePrices(items, ..., false, null)` at `:257` now attaches, and the items are serialized into `cart_data` verbatim at `:307`.

- [ ] **Step 4: Run + expected-value sweep (same commit).** `npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js` → new tests PASS; several pre-existing modifier-cart tests now FAIL with the lower server totals (e.g. the stable-ids rename test asserting `tax 1.12 / total 8.12`). **Update those expected values with the New-math rule** (7.00 → tax 0.80 / total 7.80 shape); the request payload's `tax`/`total` fields must also move or the server 400s. Do the same for `helpers.test.js`, `serviceChargeSnapshots.test.js` and any other file as it surfaces. Locate candidates with:

```
grep -rniE "selectedModifiers|modifiers = |modifierProduct" backend/tests | cut -d: -f1 | sort -u
```

(The grep is a preview only — Task 8's integration/unit sweep is the authoritative net before final verification; a modifier test can exist name-only without `selectedModifiers`.) Run each updated file focused until green. NEVER change production code to satisfy an old total.
- [ ] **Step 5:** `npm run build` → green (FE changed).
- [ ] **Step 6: Commit** — `git commit -am "feat(pos): activate untaxed modifier surcharge (fold, add-time, claim)"`

### Task 8: Repo-wide expected-value sweep (close the stragglers)

**Files:** test files only.

- [ ] **Step 1:** `npx vitest run backend/tests/integration backend/tests/unit` (one process — this is the mid-plan exception to "full suite once"; it is still a single run). List every failure.
- [ ] **Step 2:** For each: if the test carts a modifier line, recompute expectations with the New-math rule and update BOTH the request payload totals and the assertions. If a failure is NOT a modifier-total change, STOP — that is a real regression; debug the code, not the test.
- [ ] **Step 3:** Re-run only previously-failing files → green.
- [ ] **Step 4: Commit** — `git commit -am "test(pos): modifier carts expect base-only tax"`

### Task 9: Red-boundary proof, full verification, runbook

- [ ] **Step 1: Red-boundary proof (temporary, uncommitted).** In `PosCalculator.js`, change `taxableLineTotal` to `const taxableLineTotal = (item) => calculateLineTotal(item);`. Run `npx vitest run backend/tests/integration/checkout.test.js` → Task 7's headline test must FAIL with a 400 Total/`tax_amount` mismatch (proves the assertions bind to the new base, not incidentally). Restore with `git restore backend/services/PosCalculator.js` (safe only if that file has no other uncommitted edits — check `git status` first).
- [ ] **Step 2:** Full suite, exactly once: `npx vitest run` — ALL green (floor: Task 0 baseline + this plan's new tests). On failure: rerun only failing files, fix, one final full run.
- [ ] **Step 3:** `npm run build` — green.
- [ ] **Step 4: Runbook.** Append to `docs/superpowers/runbooks/2026-07-12-modifier-stable-ids-deploy-runbook.md` (same rollout train): run `apply-modifier-surcharge-untaxed.js` AFTER the stable-ids migration and BEFORE deploying this code (INSERTs name the column); FE+BE ship in the same deploy — open cashier tabs from before the deploy will 400 on Total for modifier carts until refreshed (standard refresh-after-deploy note); expect exclusive-mode tax/Z-report figures to drop for modifier orders from deploy time (owner-approved behavior change); historical rows are never backfilled; open TABLE orders and SPLITS saved pre-deploy settle at their OLD (surcharge-taxed) totals — correct and intentional; register HOLDS parked pre-deploy re-price at claim (totals-changed warning) and charge the NEW total, because holds always re-fold at checkout; no spooler deploy.
- [ ] **Step 5:** Commit docs, then follow superpowers:finishing-a-development-branch.

---

## Self-review notes (fresh-eyes pass against the design)

- **Coverage:** BE math + strip (T2), FE math (T3), INSERTs + heal + merge copies + collapse guard (T4), settle by-id/group pins for unpaid-table AND split settle + table re-save pins with per-row-id priority + mixed-group rejects + split-creation pins + claim preserve-by-index + presentation/guest/split-print passthroughs (T5), GET emit + FE lifecycle carry incl. all four restore paths + display fallbacks (T6), the three writers + organic tests + sweep (T7), straggler sweep (T8), red-boundary + runbook (T9). Reports/refunds/receipts intentionally untouched (read stored values — verified in recon); inclusive/exempt untouched (both authorities return 0 before the base matters; tax-exempt has no BE twin — FE-only zeroing, no interaction).
- **Per-commit safety (invariant 9):** T2/T3 inert (nothing sets the field; strip closes the forgery window); T4/T5/T6 inert (no writer exists — organic data all NULL, mixed-group sets are `{null}`, FE fallbacks reproduce old numbers on null); T7 flips FE and BE together in one deploy artifact; T8/T9 test-only. Each task ends with "all pre-existing tests still green" (T2-T6) or the sweep (T7-T8).
- **Trust boundary:** client field is STRIPPED by `normalizeCartItems`; fold or frozen pins are the only persisting sources. Fee/custom lines store `NULL`. DB-loaded payloads (claim, split settle server-side items, held presentation) re-attach their stored field by index after normalize; legacy FROZEN payloads (tables/splits) lacking it remain null/old-math, while legacy register holds get the DB-attach at claim because their checkout re-folds. Forgery test pins the fresh path; the settle mismatch gate (`checkout.js:490-525`) blocks introducing new lines at cashout.
- **Type/name consistency:** the field is `modifier_surcharge` (snake) on cart lines, DB rows, and FE lines everywhere — matching `tax_rate`/`price_at_sale` conventions; `taxableLineTotal` (BE, Task 2) / `taxableLineNet` (FE, Task 3) are consumed by name in later tasks; `surchargePinnedById` (WeakSet) and `savedGroupSurcharges`/`parentSurchargesByGroup` (Maps of Sets) are defined where used.
- **Known accepted edges:** id-less client settling/saving/splitting a mixed legacy/new group gets a refresh conflict instead of last-write-wins (real FE sends `order_item_id`; mixed groups only arise when a pre-activation order gains a same-note line post-activation); a legacy hold whose option was renamed attaches null at claim (resolver finds no match) — checkout's fold re-prices that line to base anyway, the pre-existing legacy-rename dead end documented in the stable-ids plan, no worse than today; manager price override below the surcharge clamps the base to 0 tax; `decimal(10,6)` matches `price_at_sale` precision; FE `parseFloat` vs BE `Number` coercion differs only on garbage strings no producer emits (same pre-existing class as `lineNet` vs `calculateLineTotal`); the 10000 sanitizer cap can null an absurd (>10000) multi-option surcharge in previews only — every persisting path is re-attached by fold/pin.
- **Executor warnings:** anchors drift — match quoted code; old modifier-total tests failing in Task 7 is the FEATURE (update values, never code); a pre-existing test flipping in Tasks 2-6 is a LEAK (fix the code, not the test); ONE vitest process; copy harness identifiers from adjacent tests, never from this plan's comments; test blocks written as comments are specifications to implement with the file's real helpers, not code to paste.

## Adversarial review round 1 (2026-07-12, pre-execution)

Independent reviewer verified the plan against master @ 1508443d. No CRITICAL. Patched: **H1** held/split `receipt_display_v1` builder dropped the field (`ReceiptPresentationSources.js:266-276`) → Task 5 Step 5 + test guard; **M1** merge qty-increment could collapse rows with different surcharges → `<=>` predicate + collapse test; **M2** table-save pin last-write-wins by key could retag a legacy row's base → per-row-id priority + mixed-group reject (WeakSet guard, do not use `=== undefined`); **M3** sweep grep widened + full-run declared authoritative; **L1** PosTerminal.vue path corrected (`src/components/PosTerminal.vue`); **L2/L3/L4** recorded as known accepted edges. Confirmed-safe: FE/BE cent parity (ratio-guard divergence < 0.0001), trust boundary (mismatch gate covers every settle; split cart replaced server-side; `canonicalizeServiceCharge` never strips product-line fields), all spread-based restore paths, falsifiability of the headline tests (Total 400 fires before the server-overwrite at `checkout.js:778`), seed/migration structure.

## Adversarial review round 2 (2026-07-12, owner, commit 3656e7d9 + follow-up 6eaa089a)

Owner findings, all verified real and adopted: **O1** the original Task 2 was a deployable tax-forgery window (math consumed the field before any server writer existed); **O2** store NULL, never 0, for "no surcharge" — the merge `<=>` predicate would split 0-vs-NULL semantically identical rows (composition bug between the round-1 M1 patch and the original stamp value); **O3** mixed-surcharge groups fail closed (403/409 refresh) instead of pin-null — matches the existing mixed-tax-rate rejection pattern; **O4** save/split pins carry surcharge inside the context identity key; **O5** second `PosTerminal.vue` path occurrence. Two corrections applied on top (verified against code): untouched `normalizeCartItems` does NOT ignore the field — its `...item` spread forwards it (`PosCalculator.js:96-97`) — so Task 2 actively strips; and "legacy holds stay null/old-math" would brick them (holds re-fold at checkout; unrecoverable 400 loop) — claim DB-attaches legacy items after the `originalItems` copy, tested to an E2E 200 checkout.

## Adversarial review round 3 (2026-07-12, owner findings + full-plan re-verification)

Owner: **F1 (MED-HIGH)** Task 4/5 commit boundary unsafe — settle/claim strip the field between commits → 400 mismatch; recommended merging Tasks 4+5. Verification showed the window is WIDER than reported: at the old Task-4 commit, FRESH modifier checkouts also 400 (server fold attaches, FE add-time attach lived in old Task 7), and even a merged 4+5 leaves table-reload settles broken until the GET emit lands. Merging 4+5 was therefore insufficient. **Resolution: the inert-plumbing / single-activation-switch restructure** — Tasks 4-6 move the field without creating it (all organic data NULL → old math both sides, every commit green + deployable, plumbing proven with SQL-seeded fixtures), and Task 7 lands the only three writers (fold attach, FE add-time attach, claim legacy attach) in one commit with the sweep. **F2 (LOW)** stale held-test heading contradicting the final claim design — fixed in the rewrite. The full-plan re-verification also caught two more patch-composition leftovers, both fixed: the old Task-4 interface line still said the fold writes "0 when no modifiers" (violated O2's NULL rule), and the runbook still claimed holds "settle at their OLD totals" (contradicted the round-2 claim design). This document was rewritten whole in round 3 — accumulated seams from three incremental patch rounds were the root cause of the recurring contradictions.
