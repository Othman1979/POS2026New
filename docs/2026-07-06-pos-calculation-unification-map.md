# POS Calculation Unification Map & Weak-Spots Audit (2026-07-06)

Exhaustive sweep of EVERY money-calculation surface across the POS register + tables workflows, frontend **and** backend, produced by 5 parallel agents + a 200k-cart FE↔BE fuzz. Purpose: (a) give Part C / Phase 7 the complete "must-cover" checklist so nothing is missed, and (b) rank the weak/improvable spots.

> **STATUS (2026-07-06):** the two real bugs this sweep found — **B1** (tax-inclusive per-line tax stamp) and **B2** (fractional split conservation) — are **FIXED** on branch `fix/pos-calc-b1-b2`. Everything else below is unchanged (Part C display-unification targets + confirm-with-owner items).

## 0. Headline

- **FE and BE rollup math are already numerically identical.** A 200,000-random-cart fuzz (mixed tax rates, order + line discounts, fixed/percent) found **0 divergence** in subtotal/tax/total between the FE store and `PosCalculator.js` — matching the existing `roundingSimulation.test.js`. So a unification is *safe*; the two engines already agree.
- The real problems are NOT in the rollup. They are: **per-line tax stamping** (bug B1 — now FIXED), **fractional split qty** (bug B2 — now FIXED), **receipt/display net-vs-gross drift** (cosmetic but customer-facing), and **heavy formula duplication** (~10 hand-copies of one line formula) — which is exactly what Part C should collapse.

Legend for scope: **BUG** = act now, separate from Part C · **DRIFT** = unification target (Part C / small BE cleanup) · **COSMETIC** = display polish (Phase 6) · **CONFIRM** = business-rule question.

---

## 1. Complete calculation-surface inventory (the must-cover checklist)

Every formula family, with EVERY place it currently lives FE + BE, and the single source it should collapse to. `S` = `assets/js/composables/stores/orderSessionStore.js`; `PC` = `backend/services/PosCalculator.js`; `H` = `backend/routes/pos/helpers.js`; `RLT` = `src/utils/receiptLineTotals.js`.

| # | Formula family | Frontend locations | Backend locations | Collapse to |
|---|---|---|---|---|
| 1 | **Line net** (price×qty − item discount; **fixed = per-unit ×qty**) | `S.getItemTotal:325`, `S.rawSubtotal:231` (inline), `S.cartTax:272` (inline), `S.cartTotal:291` (inline), `S.updateServiceCharge:191` (inline), `S.getSeatTotal:1207` (inline), `RLT.receiptItemNetTotal:8`, `RLT.splitCheckTotals:39` | `PC.calculateLineTotal:61`, + inline copies at `checkout.js:661-663`, `tables.js:1575-1577`, `H.recomputeOrderTotals:588-590` | `PC.calculateLineTotal` (BE) / one FE `lineNet()` mirroring it |
| 2 | **Line tax** (per-line rate × discountRatio; rate 0 → 0 tax but line still in subtotal) | `S.cartTax:264-279`, `S.cartTotal:288-296` (re-derived copy) | `PC.calculateLineTax:58`, inline in `PC.calculateExpectedTotals:97`, stamps `checkout.js:664`, `tables.js:1578`, `H.recomputeOrderTotals:591` | `PC.calculateLineTax` |
| 3 | **Line gross** (net × 1+rate/100) | `S.getItemTotalGross:335`, `S.cartGrossSubtotal:342`, `RLT.receiptItemDisplayTotal:20`, `PosTerminal.vue:318` (card, inline), `:467` (cart row, inline) | — (BE never grosses per-line) | one FE `lineGross()` |
| 4 | **Order discount** (fixed=min(sub,val)/percent; prorated into tax via `discountRatio`) | `S.cartOrderDiscountAmount:242`, `S.rawDiscountedSubtotal:251`, `S.distributeOrderDiscount:25` (splits) | inline in `PC.calculateExpectedTotals:72-77`, `tables.js:1940-1944` (split parent), `refunds.js:142-146` (discountRatio) | `PC.calculateExpectedTotals` |
| 5 | **Subtotal / discounted subtotal** | `S.rawSubtotal:227`, `S.cartSubtotal:238`, `S.rawDiscountedSubtotal:251`, `S.discountedSubtotal:260` | `PC.calculateExpectedTotals:69-77` | `PC` |
| 6 | **Tax rollup** | `S.cartTax:264` | `PC.calculateExpectedTotals:90-98` | `PC` |
| 7 | **Grand total** | `S.cartTotal:281` (re-derives tax) | `PC.calculateExpectedTotals:103` | `PC` |
| 8 | **Service charge fee** (pct × subtotal-without-fees) | `S.addServiceCharge:2406` (base = **rounded** cartSubtotal), `S.updateServiceCharge:201` (base = **raw**) | `H.assertServiceChargeValid:333` (base = **raw**) | one base + one rounder |
| 9 | **Modifier surcharge** | `S.confirmModifiers:2029-2039` (fold Σ opt.price into unit price) | `PC.computeModifierSurcharge:116` (DB name-match) | mirror; match by **id** not name |
| 10 | **Split allocation** | `S.getSeatTotal:1205` (net, no tax, returns STRING), `S.distributeOrderDiscount:25`, `S.splitItemFractionally:1153` + move helpers `:1168-1201` | `tables.js` split reconcile `:1940-2087` (server-authoritative), `parentByLineId` pin | keep split-specific; base on unified line-net |
| 11 | **Payment / tender** | `S.changeDue:300`, `S.cashShortfall:311`, `S.splitBalanceDue:318`, split alloc `:2155-2186` | `H.validatePayments:452`, `H.validateCashAmount:712` | out of `posTotals` scope (note) |
| 12 | **Rounding** | `S.roundMoney:16`; variants: `.toFixed(2)` (service charge), `.toFixed(4)` (qty), `RLT.round2:31` | `PC.roundMoney:12`; `H.applyDatabasePrices:441` `.toFixed(4)`; `money.js` admin-only | one `roundMoney` everywhere |
| 13 | **Tax-inclusive / tax-exempt modes** | `S.cartTax:266`, `S.cartTotal:283` (inclusive), `S.isTaxExempt:168` | `PC.calculateExpectedTotals:78-87` (inclusive short-circuit); per-line stamp now gated (B1 fixed: checkout/tables/recompute) | helper takes both flags |
| 14 | **Bundle** (children price/tax 0; child qty = member×parent) | display only (`PosTerminal.vue` sub-item qty) | `bundleOrderItems.js:118,121-125`; `reconstructBundleSubs:153` | keep; confirm tax rule |
| 15 | **Held orders** (store raw client subtotal; re-price at settle) | `S.holdCurrentOrder:1075-1093` (sends raw), `S.restoreHeldOrder:549` (re-derives) | `orders.js:96-110` (stores raw `cart_data`+subtotal, no recompute) | restore/settle already re-derive — the target pattern |
| 16 | **Refund line math** | — | `refunds.js:195-215` (uses `PC.calculateLineTotal` + stored `tax_amount`) | already shared (good) |

**Your list, all covered** by the families above: order discount (#4), item discount (#1), service charge (#8), price override (feeds #1 as an input — no separate formula; authority is BE `applyDatabasePrices`), different taxes / 0-tax-normal (#2/#6 — confirmed 0-rate lines count in subtotal, contribute 0 tax, are never dropped), held orders (#15), split checks (#10). Custom open item: removed from UI + gated at `checkout.js:312` — no FE surface.

---

## 2. Invariants (which hold, which don't)

1. FE rollup ≡ BE rollup (subtotal/tax/total). — **HOLDS** (200k-cart fuzz, 0 divergence).
2. `SUM(order_items.tax_amount) ≈ orders.tax`. — **HOLDS** (exclusive: 6dp column absorbs per-line raw; inclusive: both 0 after B1 fixed the per-line stamp on all three write paths).
3. Shown `Subtotal − Discount + Tax == Total`. — **VIOLATED** (~21% of carts, ±0.01) FE + receipt (D2).
4. Per-line "Total" column sums to shown "Subtotal". — **VIOLATED** (line totals gross, subtotal net) (D3).
5. Split seat qtys sum to parent qty. — **HOLDS** after B2 (last-piece remainder). Was violated by fractional split residue.
6. Charged price = DB price (non-manager). — HOLDS for product lines; custom lines bypass repricing (W-custom, narrow since UI removed).
7. Server authoritative on persist (client totals overwritten). — **HOLDS** (checkout + tables).

---

## 3. Weak spots — ranked

### Real bugs — FIXED on branch `fix/pos-calc-b1-b2` (2026-07-06)

**B1 — Tax-inclusive mode stamped per-line `tax_amount` with the EXCLUSIVE formula. — FIXED.** In inclusive mode `calculateExpectedTotals` returns rollup `tax = 0`, but the per-line stamp ran `calculateLineTax(...)` unconditionally at **THREE** sites — `checkout.js:664`, **`tables.js:1578` (table-save path, originally missed)**, and `H.recomputeOrderTotals:591` — writing exclusive tax per line while `orders.tax = 0`, which `receiptItemDisplayTotal` (`RLT:20`, `net + savedTax`) then over-printed ~rate%. (Experiment: inclusive 11.60 → stamped `1.856` vs correct `1.600`.) **All three now stamp `0` in inclusive mode** (`taxInclusivePricing ? 0 : calculateLineTax(...)`); exclusive mode unchanged. Only ever fired if `tax_inclusive_pricing = '1'`. Regression tests on both the checkout and table-save paths.

**B2 — Fractional split qty (`toFixed(4)`) wasn't conserved → legit splits REJECTED. — FIXED.** `S.splitItemFractionally` made `ways` copies of a truncated `qty/ways` that didn't sum back, so the backend conservation check (`tables.js:2009`, tol `0.0001`) rejected legit 6-way / compound ÷3-then-÷4 splits with an unresolvable "Split items mismatch. Please refresh" (and could leak a cent within tolerance). **Now the last piece takes the remainder** (`qty − pieceQty×(ways−1)`), mirroring `distributeOrderDiscount`; the pieces sum exactly. Unit test: 6-way conserves within tolerance. (Was audit F8, rated LOW; the compound-button repro upgraded it.)

### Drift-risk (the unification targets — Part C Phase 7 + a small BE cleanup)

**D1 — One line formula, ~10 hand-copies.** Line-net/tax is copied 6× in the FE store (`getItemTotal`, `rawSubtotal`, `cartTax`, `cartTotal`, `updateServiceCharge`, `getSeatTotal`) + `RLT` (2) + `PosTerminal` inline gross-ups (2); and 4× on the BE (`checkout.js:661-664`, `tables.js:1575-1578`, `H.recomputeOrderTotals:588-591`, and `PC.calculateExpectedTotals:97` re-implements `calculateLineTax` inline). All equivalent today; any future change won't propagate. **This is the core Part C payoff** (FE) plus a parallel BE cleanup: collapse the 4 inline stamps into one `stampLineTax(item, rate, ratio) = calculateLineTax(calculateLineTotal(item), rate, ratio)`. Some FE copies (`cartTax`/`cartTotal`/`getSeatTotal`) also drop the `|| 0` guard on `price*qty`, so a blank price on a taxable line yields `NaN → roundMoney → 0` (silent).

**D2 — `cartTotal` re-derives tax instead of reusing `cartTax`.** FE (`S:288-296`) and BE (`PC:103`) both do `total = round(discountedSubtotal + rawTax)` while the shown pieces are each rounded independently → `Subtotal − Discount + Tax ≠ Total` by 0.01 in ~41,803/200,000 carts. Phase 6: derive the shown Total from the shown components (or `Tax = round(Total − DiscountedSubtotal)`).

**D3 — Net-vs-gross display inconsistency.** Line "Total" columns are gross while "Subtotal" is net, so lines never sum to Subtotal whenever tax > 0: `PosTerminal.vue:468` vs `:540`, `ReceiptPreviewModal.vue:65/166` vs `74/177`, `PrintReceiptApp.vue:36` vs `44`. Also `PosTerminal` inline gross-ups (`:318`, `:467`) ignore `isTaxExempt`, so with tax-exempt ON the unit column and line-total disagree. Phase 6/7.

**D4 — `tax_rate` coalesce written three ways.** `Number(product.tax_rate) || 0` (rollup `PC:95`) vs `Number(product.tax_rate)` (checkout stamp `:660`, **no `||0`** — the odd one out, would write `NaN` if the column were ever undefined) vs `Number(product.tax_rate || 0)` (tables stamp `:1574`, recompute). Latent (DECIMAL column always present); unify on one helper.

**D5 — Service charge fee has 3 bases.** rounded `cartSubtotal` (`addServiceCharge:2406`) vs raw (`updateServiceCharge:201`, `assertServiceChargeValid:333`). ≤0.0005 gap (inside tolerance, usually self-corrected), but 3 formulas for one number. Unify `addServiceCharge` onto the raw base.

**D6 — `tables.js` persists client discount, not normalized.** `tables.js:1489/1534` store `data.order_discount_type/value` raw; checkout stores `expectedTotals.orderDiscount.*`. A garbage type with value 0 is stored verbatim (inert, re-nulled on recompute). Route tables through `expectedTotals.orderDiscount`.

### Cosmetic / consistency

- **`roundMoney` EPSILON nudge is ineffective for |v| ≥ ~1** (added before ×100 scale): `roundMoney(8.245)=8.24`, `roundMoney(35.855)=35.85` (half-up "fails"). Identical FE/BE so no divergence, but it doesn't deliver documented round-half-up. If you touch rounding, use scale-then-nudge (`Math.round(v*100 + 1e-6)/100`). (`PC:12`, `S:16`, `RLT:31`.)
- **`getSeatTotal` returns a STRING** (`S:1212` `.toFixed(2)`), unlike every other money getter. Callers `parseFloat` it. Type trap for unification.
- **Fixed discount is per-UNIT (×qty)** everywhere (consistent). A "fixed 2.00" on qty 3 removes 6.00. Keep it, but document/rename `unitDiscount` at the shared calculator.
- **No single money formatter for POS.** `money.js` is admin-only; POS uses bare `.toFixed(2)`; `PrintReceiptApp` has its own `money()`; A4/Delivery use `.toFixed(3)`.
- **Fixed-discount display overstates** when value > subtotal (`print.js:362`, `checkout.js:48`) — prints raw value while applied discount was capped. Header total correct.
- **`distributeOrderDiscount` last-seat residue can be clipped** to `≤ sST` (`S:44`) → order discount under-applied on splits when the last seat is small. Edge.
- **Split-cash revenue leg unrounded** (`S:2162` `actualCashRevenue = cartTotal − card`) → float dust in `cash_amount`.
- **`MONEY_TOLERANCE = 0.02` slack + stacking** (`H:20`): several independent `assertNearMoney` per checkout each allow 0.02 → cumulative accepted drift > 0.02. Consider tightening to ~0.01 or asserting one conservation identity. (Backend security tolerance, not Part C.)
- **Split path hardcodes `0.02`** in 4 spots (`tables.js:1949-50, 2076-77`) not sourced from `MONEY_TOLERANCE` → drift if retuned.

### Confirm-with-owner (business rules, not bugs)

- **Bundle children carry 0 tax** (`bundleOrderItems.js:125`) — the bundle's whole tax rides on the parent line's rate. If a component has a different statutory rate it's lost. Intended?
- **Order discount does NOT reduce the service-charge fee base** (FE + BE agree). Intended?
- **`reconstructBundleSubs` divides by `parentRow.quantity`** with no zero guard (`bundleOrderItems.js:153` → Infinity on a fully-voided parent) — known partial-void edge.
- **`computeModifierSurcharge` matches by option NAME** — renaming an option silently drops its surcharge; fix by matching a stable id.

---

## 4. Already solid (verified — do not "fix")

- FE↔BE rollup parity (200k carts, 0 divergence).
- `SUM(order_items.tax_amount) ≈ orders.tax` in exclusive mode (6dp column).
- Checkout total/subtotal anti-tamper + full server overwrite of persisted totals.
- Frozen-price settle + `order_item_id` quantity-consumption (the price-swap guard from Part A/C5).
- Split server-authoritative reconciliation (`serverSeatNetSum` vs parent).
- Refund net math mirrors checkout and reuses `calculateLineTotal` + stored `tax_amount`.
- Catalog serves raw price/tax/modifiers; every route re-derives server-side.
- 0-tax items treated as normal everywhere.

---

## 5. Recommendation

1. **Two real bugs → FIXED** (branch `fix/pos-calc-b1-b2`, 2026-07-06):
   - **B1** tax-inclusive per-line stamp now `0` on all THREE write paths (checkout, **table-save**, recompute). Only ever affected `tax_inclusive_pricing = '1'` deployments.
   - **B2** split fractional residue → last-piece-gets-remainder; fixes the "Split items mismatch" dead-end.
2. **Part C scope grows to the full §1 inventory.** My earlier "~5 computeds" list was incomplete — Phase 7's `posTotals()` must cover families #1–#10 + #12–#13 (line net/tax/gross, discounts, subtotal, tax, total, service charge, modifier fold, splits, rounding, inclusive/exempt), and the receipt renderers (D3) must route through it.
3. **Backend gets a parallel micro-cleanup** (independent, low-risk): collapse the 4 inline line-tax stamps into one `stampLineTax()` call (D1), and unify the `tax_rate` coalesce (D4) + tables discount persistence (D6). This makes the BE a clean single authority for the FE to mirror.
4. Remaining sequence (**B1/B2 done**): **Phase 6 (foot the display) → Phase 7 (one FE helper mirroring the cleaned BE) → Phase 8 (naming)**, with the BE micro-cleanup (item 3) alongside.
