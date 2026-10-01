# POS Calculation Audit — Register + Tables (2026-07-05)

Scope: POS register + tables workflows only (cashier/waiter). Frontend cart/checkout/split/receipt display + backend checkout/tables/orders/catalog calculation & persistence. Admin excluded. **No code changed** — findings, repro cases, unification plan, test plan only.

---

## 0. Executive summary

Backend is the calculation authority and it is **well-hardened** (multiple prior audits landed here). On the register checkout path and table-save path, the server:

- Re-prices every product line from the DB (`applyDatabasePrices`) — client `price` ignored for non-managers.
- Recomputes `subtotal/tax/total` from DB prices + DB product `tax_rate` (`calculateExpectedTotals` in `backend/services/PosCalculator.js`).
- Asserts the client `subtotal` and `total` are within 0.02 (`assertNearMoney`), then **overwrites** them with server values before persist.
- Validates the Auto-Gratuity line against settings on the **summed** fee line-totals (`assertServiceChargeValid`) — qty-inflation / second-forged-line / NaN-tax all fail closed.
- Enforces settle line-up == saved order_items, frozen settle prices, split item conservation.

The **primary register checkout path** has no revenue-loss divergence. **The bill-split endpoint does** — see **S1 (HIGH, CONFIRMED by runnable probe)**: a phantom empty seat defeats split reconciliation and lets an authenticated split-permitted user destroy an arbitrary fraction of a bill (probe demonstrated an 11.60 order reduced to a single 1.00 held check; price `0` is allowed so 100% loss is possible). The other issues are: a customer-facing printed-check tax omission, an unlogged manager price-override, display-layer penny drift, and test-fidelity/coverage gaps.

> **v2 correction:** an earlier draft rated the split-seat price weakness as "bounded, no net loss." That was wrong — the phantom-empty-seat path (S1) makes it unbounded. Confirmed experimentally (§3.S1).

### Architecture reality (important — not where the prompt pointed)

| Prompt assumed | Actual authority |
|---|---|
| `src/utils/money.js` = math | It is **format only** (`formatMoney`, `varianceIsZero`). No calc. |
| Vue files hold FE math | Vue files are thin shells. **All FE math lives in `assets/js/composables/stores/orderSessionStore.js`** (via `useCart()`/`useTables()` facades). |
| `catalog.js` calculates | Catalog serves raw `products.price` + `tax_rate`; math is in `backend/services/PosCalculator.js` + `helpers.js`. |

---

## 1. Calculation map

Legend: **BE-AUTH** = backend authoritative (persisted value recomputed server-side); **FE-DISPLAY** = frontend, display only, never persisted; **DUP** = same formula duplicated in FE+BE (drift risk); **CLIENT-TRUST** = value accepted from client and persisted without server recompute.

| Quantity | Source of truth | Where | Class |
|---|---|---|---|
| Product base price | DB `products.price` (net/tax-exclusive) | `helpers.js:393-445 fetchCartProducts`/`applyDatabasePrices` | **BE-AUTH** (except manager override / frozen settle) |
| Modifier option price | DB `products.modifiers[].price` | `PosCalculator.js:115-132 computeModifierSurcharge` | **BE-AUTH** (client `selectedModifiers[].price` ignored) |
| Line net (price×qty − line disc) | duplicated | FE `orderSessionStore.js:325-334 getItemTotal` / BE `PosCalculator.js:60-65 calculateLineTotal` | **DUP** |
| Line tax | BE product `tax_rate`; FE line `tax_rate` | FE `cartTax` 264-279 / BE `PosCalculator.js:89-97` + stamp `checkout.js:620-626` | **DUP** (BE ignores client rate on product lines) |
| Order subtotal (net) | duplicated | FE `rawSubtotal` 227-236 / BE `PosCalculator.js:68` | **DUP** |
| Order discount | duplicated; split-settle server-sourced | FE `cartOrderDiscountAmount` 242-250 / BE `PosCalculator.js:69-76` | **DUP** |
| Order tax (prorated) | duplicated (`discountRatio`) | FE `cartTax` / BE `PosCalculator.js:89-97` | **DUP** |
| Service charge line | duplicated; BE re-validates | FE `addServiceCharge` 2387-2416 / BE `helpers.js:308-345 assertServiceChargeValid` | **DUP + BE-AUTH validate** |
| Grand total | duplicated; BE overwrites | FE `cartTotal` 281-298 / BE `PosCalculator.js:99-107` | **DUP → BE-AUTH persist** |
| Persisted `orders.subtotal/tax/total` | server-computed | `checkout.js:469-471,580-585`; `tables.js:1336-1338,1489,1531` | **BE-AUTH** |
| Persisted `order_items.price_at_sale/tax_amount` | server (DB price, prorated tax) | `checkout.js:620-644`; `tables.js:1571-1596` | **BE-AUTH** (except override/custom) |
| Register hold `held_orders.subtotal` + `cart_data` | client, verbatim | `orders.js:96-110` | **CLIENT-TRUST** (re-priced later at checkout) |
| Split seat `subtotal` + `cart_data.items` | client; qty conserved + aggregate bounded; **prices NOT re-pinned** | `tables.js:1948-2011,2074-2090` | **partial CLIENT-TRUST** |
| Split-settle line price | frozen from `held_orders.cart_data` | `checkout.js:399-408` | server-stored |
| Receipt preview totals | server figures (`lastOrder.subtotal/tax/total`) | `ReceiptPreviewModal.vue:73-79` | **FE-DISPLAY** of BE-AUTH |
| Receipt preview line total | FE helper (gross) | `receiptLineTotals.js:20-29 receiptItemDisplayTotal` | **FE-DISPLAY** |
| Split printed check total | client; **tax hard-coded 0**, total = subtotal | `TableSplits.vue:402-436` | **FE-DISPLAY (wrong)** |
| Table board / recall totals | stored `orders.total` / rebuilt from lines | `tables.js:172,906-956` | BE-AUTH passthrough |

### Canonical formulas (as implemented today)

```
itemNet      = max(0, price*qty − lineDiscount)           lineDiscount: fixed = value*qty ; percent = value% of price*qty
subtotal     = Σ itemNet                                  (net, pre-order-discount)   ← "subtotal" everywhere BE + FE cart
orderDisc    = fixed: min(subtotal, value) ; percent: subtotal*value/100
discSubtotal = max(0, subtotal − orderDisc)
discountRatio= subtotal>0 ? discSubtotal/subtotal : 1
tax          = round2( Σ itemNet * discountRatio * rate/100 )      per-line rate; one terminal round
total         = round2( discSubtotal + Σ(itemNet*discountRatio*rate/100) )   ← re-derives tax, not tax+discSubtotal
serviceCharge= round2( pct/100 * Σ itemNet(excluding FEE lines) )  a cart line; own settings tax_rate; itself in subtotal
seatSubtotal = round2( Σ seat.itemNet )                            (net, pre-tax) — split time
```

Note the naming trap: **`subtotal` = NET pre-tax** in cart/checkout/orders, but `TableSplits.vue` renders the stored net `subtotal` under the label **"Total"** (`TableSplits.vue:185-188`), and split-check math treats `seat.subtotal` ambiguously as net subtotal **or** payable total (`tables.js:1926-1929,2004-2007`).

---

## 2. Invariants (must always hold)

1. **Persisted `orders.{subtotal,tax,total}` are server-recomputed, never client.** — HOLDS (`checkout.js:469-471`, `tables.js:1336-1338`).
2. **Product line price = DB price×qty + DB modifier surcharge**, except explicit manager override or frozen settle price. — HOLDS, but override is silent/unlogged (F3).
3. **Product line tax = DB product `tax_rate`; client `tax_rate` ignored on product lines.** — HOLDS (`PosCalculator.js:94`, P3-14 fix).
4. **Modifier surcharge = Σ matched DB option prices; taxed at parent rate.** — HOLDS (`computeModifierSurcharge`).
5. **Service charge amount = pct × line-discounted subtotal-without-fees; tax_rate = settings; enabled required.** — HOLDS on checkout + table-save; **NOT enforced at split time** (re-checked at settle) (F4).
6. **Order discount: value ≥ 0, percent ≤ 100, permission-gated, applied pre-tax.** — HOLDS at calc layer; **not exercised over HTTP** (T-gap).
7. **Σ split seat charges = parent total.** — **VIOLATED** (S1, confirmed): a phantom item-less seat pads the aggregate check while contributing nothing persisted; per-seat prices also not pinned to DB (F2).
8. **Settle cart line-up == saved order_items (qty); price frozen from saved.** — HOLDS (`checkout.js:356-393`).
9. **FE preview totals == BE persisted totals within rounding.** — HOLDS to ±0.01; foot-drift cosmetic (F5).
10. **Printed customer-facing amount == amount actually charged.** — **VIOLATED for split printed check** (F1: tax omitted).

---

## 3. Findings (severity-ordered)

### S1 — HIGH — **CONFIRMED** — Phantom empty seat defeats bill-split reconciliation → arbitrary revenue loss
- **File:** `backend/routes/pos/tables.js` — three lines combine into the hole:
  - `1937`: `seatSum = splits.reduce((s, sPart) => s + Number(sPart.subtotal), 0)` — reconciliation sums the **client-declared** subtotal of *every* split, including item-less ones.
  - `1992`: `if (normalizedItems.length === 0) continue;` — an item-less seat is **skipped** by the per-seat subtotal validation.
  - `2072`: `if (normalizedItems.length === 0) continue;` — an item-less seat is **skipped** by persistence (never written to `held_orders`).
  - Compounded by **F2**: per-seat item prices are never re-pinned to DB, and `normalizeCartItems` allows `price: 0`.
- **Workflow:** tables (split). **Requires:** a user with split-bill permission (`checkSplitBillPermission`) — authenticated insider.
- **Exploit:** POST a split with (1) a real seat holding all parent items but priced far below DB (down to 0), and (2) a **phantom seat with `items: []`** whose declared `subtotal` pads `seatSum` up to the parent total. Every guard passes: aggregate reconciles (phantom's declared subtotal fills the gap), item conservation holds (phantom carries no items), each real seat is self-consistent at its forged prices, phantom is skipped. The parent order is voided; only the underpriced real seat is persisted.
- **Proof (runnable probe, executed 2026-07-05):** parent = 2×product1 @5.00, 16% tax → subtotal 10.00 / total 11.60. Malicious split = `[{Real: 2×product1 @0.50, subtotal 1.00}, {Phantom: items:[], subtotal 9.00}]`. Result:
  ```
  status: 200,
  heldRows: [ { name: 'Real', subtotal: 1 } ],
  heldSubtotalSum: 1,
  parentPaymentMethod: 'voided',
  parentOriginalSubtotal: 10
  ```
  → an 11.60 bill became a single 1.00-net held check; **~10.44 gross destroyed** in one call. With `price: 0`, loss is 100%. The held split can then be settled for pennies (customer cash pocketed) or deleted (`DELETE /table_splits` does no money validation).
- **Expected:** A split must conserve the parent's value; a seat with a declared subtotal but no items is invalid; per-seat prices must be anchored to the parent/DB.
- **Fix (defense in depth, all three):**
  1. **Reject** any split whose `normalizedItems.length === 0` (do not `continue`) — an item-less seat carrying a declared subtotal is malformed.
  2. Compute `seatSum` from the **server-recomputed** DB-priced seat totals, not client `sPart.subtotal`.
  3. Pin seat item prices via `applyDatabasePrices` / parent frozen `price_at_sale` before `calculateExpectedTotals` (also closes F2).
- **Regression test to add** (`backend/tests/integration/tables.test.js`): the exact probe above — assert the split is **rejected** (or that `Σ held_orders.subtotal` conserves the parent net subtotal).

### F1 — MEDIUM — Split printed "check" omits tax; total shown = pre-tax subtotal
- **File:** `src/components/TableSplits.vue:402-436` (`printCheckBill`) — `tax: 0, discount: 0, total: check.subtotal`.
- **Workflow:** tables (split).
- **Scenario:** Tax-exclusive venue. Waiter splits a bill, prints each seat's check to hand to the customer. The printed check shows `Total = subtotal` with **no tax line**. At settle, `checkout.js` recomputes and **adds tax** (`calculateExpectedTotals`), so the customer is charged more than the printed check stated. Guest-check print (`printGuestCheck`) *does* include tax, so the two customer documents disagree.
- **Expected:** Printed pre-bill total == amount charged at settle (tax included, or clearly labeled tax-exclusive).
- **Risk:** Customer dispute / drawer reconciliation gap; inconsistent with `printGuestCheck`. Not a theft vector but an operational/customer-trust defect.
- **Fix:** Compute the split-check print totals through the same preview helper used for the guest check (include tax + real total), or explicitly gross each line. Do not hard-code `tax:0`.

### F2 — MEDIUM — Split seat item prices are not re-pinned to DB (value redistribution across seats)
- **File:** `backend/routes/pos/tables.js:1948-2011` — seat items go through `normalizeCartItems` (rejects negative/zero) but **`applyDatabasePrices` is never called**; `calculateExpectedTotals` computes seat subtotal from **client** `item.price`.
- **Workflow:** tables (split).
- **Scenario:** Parent order (DB-priced) has item X (50) and Y (50), total 100. Client submits seat A `{X qty1 price 1}` and seat B `{Y qty1 price 99}`. Guards pass: qty conservation holds (X=1, Y=1), aggregate `seatSum=100≈parentTotal`, each seat is self-consistent (`seat.subtotal`≈server recompute of its own client prices). Seats persist with the forged per-seat prices, then settle at those frozen prices (`checkout.js:399-408`).
- **Expected:** Each split line charges the DB/parent price for that product; per-seat prices anchored to source order.
- **Risk:** On its own it *appears* bounded to redistribution (aggregate ≈ parent), but **combined with the phantom-seat hole (S1) it is unbounded revenue loss** — the aggregate bound is exactly what the phantom defeats. Even standalone, it lets a cashier target which party underpays and stores misleading per-line money.
- **Fix:** In the split endpoint, run `applyDatabasePrices(normalizedItems, splitProductMap, req.user, false)` (freeze from the parent's saved `price_at_sale`, not client) before `calculateExpectedTotals`, so seat prices are pinned to the parent order. (Part of the S1 fix.)

### F3 — MEDIUM — Manager price-override trusts client price with no audit of the delta
- **File:** `backend/routes/pos/helpers.js:438` — `if (!isManager) { … DB price … }`; managers skip the overwrite, so `order_items.price_at_sale` = raw client price. No `price_history`/audit row of original→override.
- **Workflow:** both (register + tables).
- **Scenario:** A holder of `pos.price_override` sets any line price (including near-zero) via the numpad; `subtotal/total` recompute from that price so `assertNearMoney` passes trivially. No PIN, no audit trail of the reduction.
- **Expected:** Price overrides are permitted but logged (who, product, base→override, delta) for after-the-fact fraud detection.
- **Risk:** Over-granted permission = silent unlimited discounting with no forensic trail. This is by-design trust but unobservable.
- **Fix:** When `isManager` and `client price ≠ DB base + surcharge`, write an audit row (reuse the atomic in-txn `audit_events` pattern per project policy) capturing the delta. No behavior change to totals.

### F4 — LOW/MED — Split endpoint does not call `assertServiceChargeValid`
- **File:** `backend/routes/pos/tables.js:1861` loads only `['stock_enabled','tax_inclusive_pricing']`; service-charge settings not loaded, helper not called.
- **Workflow:** tables (split).
- **Scenario:** An Auto-Gratuity line inside a seat is validated only as an ordinary line (subtotal ±0.02). A forged fee `tax_rate` or amount is not caught at split time. **Mitigated:** at settle, `checkout.js:328` runs `assertServiceChargeValid` on the seat cart, so a bad fee is rejected then; and aggregate is bounded.
- **Expected:** Defense-in-depth — validate the fee at the point it is written to `held_orders`.
- **Risk:** Low (settle re-checks), but the persisted split blob can hold an invalid fee until settle.
- **Fix:** Load service-charge settings in the split endpoint and call `assertServiceChargeValid` per seat before persisting.

### F5 — LOW — FE displayed `Subtotal − Discount + Tax ≠ Total` by ±0.01 (receipt can mis-foot)
- **File:** FE `orderSessionStore.js:281-298 cartTotal` re-derives tax from raw instead of adding the already-rounded `cartTax`; `cartSubtotal`/`cartOrderDiscountAmount`/`cartTax` are each independently rounded. Same shape on the receipt: `ReceiptPreviewModal.vue:73-79` prints server `round2(subtotal)`, `round2(discount)`, `round2(tax)`, `round2(total)` where `total=round2(discSubtotal+taxRaw)`.
- **Workflow:** both.
- **Scenario:** Certain rate/qty combos make the three shown components sum to a value one cent off the shown Total.
- **Expected:** Printed receipt foots exactly.
- **Risk:** Cosmetic penny mismatch; customer/auditor confusion. No money lost (charge = server total).
- **Fix:** Derive the displayed Total from the same rounded components shown (`shownSubtotal − shownDiscount + shownTax`), or show unrounded intermediates. Apply identically FE + receipt.

### F6 — LOW — Cart-row gross ignores the order-discount ratio
- **File:** `orderSessionStore.js:334-340 getItemTotalGross` (used at `PosTerminal.vue:468`) applies line discount + tax but **not** `discountRatio`.
- **Workflow:** both. When an order-level discount is present, cart line grosses sum to more than the displayed Total.
- **Fix:** Either display line gross pre-order-discount consistently and rely on the discount line, or apply `discountRatio` to row gross. Document the choice.

### F7 — LOW — Receipt/board line totals vs subtotal are net/gross-inconsistent
- **Files:** `ReceiptPreviewModal.vue:65,166` line totals are **gross** while `Subtotal` (73-79) is **net** → printed lines sum ≈ subtotal+tax, not subtotal. `TableSplits.vue:87,176-177` item rows are raw `qty*price` (ignore line discount **and** tax) while the header (79/187) shows the stored **net** subtotal → rows can sum ≠ shown total.
- **Workflow:** both (receipt), tables (board).
- **Fix:** Pick one convention per document (either show a Tax line and net line totals, or gross line totals with a gross subtotal) and route every line through `receiptLineTotals.js`.

### F8 — LOW — Fractional split qty rounding has no residue compensation
- **File:** `orderSessionStore.js:1150-1158 splitItemFractionally` → `(item.qty/ways).toFixed(4)`. 3-way of qty 1 → `0.3333×3 = 0.9999`.
- **Workflow:** tables (split). Backend conservation tolerance is `0.0001` (`tables.js:1981`): 3-way passes at the boundary (loses 0.0001×price of revenue); **many-way fractional splits (e.g. 7-way) exceed 0.0001 and are outright rejected** — a usability failure, not a money leak.
- **Fix:** Put the rounding residue on the last piece (mirror `distributeOrderDiscount`), so pieces sum exactly to the parent qty.

### F9 — LOW — Register hold trusts client `subtotal` + raw `cart_data`
- **File:** `backend/routes/pos/orders.js:96-110` — only finiteness-checked; JSON cart persisted verbatim.
- **Workflow:** register. **Mitigated:** at claim/checkout the cart is re-priced by `applyDatabasePrices` (hold is not a settle → `trustClientPrices=false`), so tampered prices never reach a paid order. Exposure is limited to the displayed held-order subtotal (cosmetic).
- **Fix (optional):** Recompute + store a server subtotal at hold time for display integrity, or label it advisory.

### F10 — LOW — Split reconciliation dual-anchor ambiguity
- **File:** `tables.js:1939-1940` accepts `seatSum` matching **either** `parentDiscountedSubtotal` **or** `parentTotal` (differ by tax); `2006-2007` accepts seat subtotal **or** seat total.
- **Workflow:** tables (split). The stored `seat.subtotal` may be pre-tax or post-tax depending on the client build; feeds F1's wrong printed total.
- **Fix:** Narrow the API to one convention (recommend net pre-tax `seatSubtotal`), compute tax server-side at settle, and reject the other.

### F11 — LOW — Minor consistency nits (batch)
- **Split seat merge key ignores modifiers** (`orderSessionStore.js:1171`: `id && note && price`) — two same-price/same-note lines with different modifiers merge. Rare.
- **Service-charge fee base rounding differs**: FE add uses `round2(rawSubtotal)` (`addServiceCharge` 2403), FE update uses raw (`updateServiceCharge` 189-201), BE uses raw (`assertServiceChargeValid`). Absorbed by 0.02 tolerance; unify on raw.
- **Order-level discount reduces the Auto-Gratuity line** (fee is inside `rawSubtotal`, so order discount + `discountRatio` shrink it). FE + BE agree, but confirm this is the intended business rule.
- **Per-line tax stamp** uses `Number(product.tax_rate)` without `|| 0` (`checkout.js:622`) vs rollup `Number(product.tax_rate) || 0` (`PosCalculator.js:94`). Not triggerable (schema `DEFAULT 0.00`), but latent — align them.

### F12 — MEDIUM (test fidelity) — Test schema runs lower money precision than production
- **File:** `backend/tests/fixtures/seed.js:204` `products.price DECIMAL(10,2)` and `price_history DECIMAL(10,3)`, while production is `DECIMAL(10,6)` (`production-sync-2026-06-27.sql`, `2026-06-26-price-precision-decimal-6.sql`).
- **Risk:** Rounding/precision tests (incl. the 10k-combo simulation) run at coarser precision than prod, so 6-dp price drift can pass tests yet occur live.
- **Fix:** Bring `seed.js` money columns to production precision.

---

## 4. Break-it probe results (requested experiments)

| Probe | Result | Where enforced |
|---|---|---|
| Client sends subtotal/tax/total < recomputed | **BLOCKED** | `assertNearMoney` `checkout.js:464-465`; overwrite 469-471 |
| Client sends product price < DB | **BLOCKED** (non-manager) / **ALLOWED unlogged** (manager, F3) | `applyDatabasePrices` `helpers.js:422-445` |
| Client sends modifier option price ≠ DB | **IGNORED** (surcharge from DB only) | `computeModifierSurcharge` |
| Client omits modifiers from subtotal but shows them | Modifiers are folded into unit `price`; BE recomputes surcharge from DB → **BLOCKED** | `applyDatabasePrices` |
| Correct price, forged `tax_rate` (product line) | **IGNORED** (DB rate used) | `PosCalculator.js:94` |
| Service charge correct unit price + inflated qty | **BLOCKED** (summed line-total) | `assertServiceChargeValid` |
| Second forged Auto-Gratuity line | **BLOCKED** | `assertServiceChargeValid` |
| Missing tax_rate on fee line (NaN) | **BLOCKED** (fails closed) | `assertServiceChargeValid:337-341` |
| Split sum ≠ parent total (all seats have items) | **BLOCKED** (±0.02 aggregate) | `tables.js:1937-1943` |
| Split with phantom item-less seat padding the aggregate | **NOT BLOCKED — CONFIRMED loss (S1)** | `tables.js:1937,1992,2072` |
| Split per-seat price redistribution (sum preserved) | **NOT BLOCKED** (F2) | `tables.js:1948-2011` |
| Rounding drift 99×0.01 @16% | Within tolerance; single terminal round | `roundingSimulation.test.js` (10k combos) passes |
| Mixed tax rates + order discount | Correct (per-line rate × `discountRatio`) | `taxMixedCart`, `PosCalculator.test.js:282` |
| Taxable item + non-taxable service charge | Correct (fee own `tax_rate`, validated) | `assertServiceChargeValid` |
| Held saved with one formula, paid with another | Re-priced + recomputed at settle | `checkout.js:410-471` |
| Negative / >100% order discount over HTTP | Calc layer throws; **no HTTP integration test** (T-gap) | `normalizeDiscount` `PosCalculator.js:14-21` |

---

## 5. Proposed unified calculation design

**Principle:** one backend authority, one FE mirror for preview only, one rounding rule, one vocabulary. The backend authority already largely exists (`PosCalculator.js`); the work is to route *every* path through it and make the FE a thin mirror.

1. **Single backend authority.** Keep `PosCalculator.calculateExpectedTotals` as the *only* producer of `{subtotal, tax, total, discount, discountRatio}`. Extend it to also emit the canonical per-line breakdown `{net, taxAmount, gross}` and the service-charge line, and have **every** write path call it with **DB-priced** items:
   - checkout ✓ (already), table-save ✓ (already), **split endpoint → reject item-less seats, recompute `seatSum` server-side, and run `applyDatabasePrices` before recompute (fixes S1 + F2)**, held-order create → optional server subtotal (F9).
   - Add `assertServiceChargeValid` to the split endpoint (F4).
2. **One FE display helper mirroring BE formulas — preview only.** Consolidate the scattered `orderSessionStore` computeds + `receiptLineTotals.js` behind a single `posTotals(cart, opts)` that reproduces `PosCalculator` exactly (share the formula + rounding constants across FE/BE, e.g. a tiny shared spec). It is display-only; the server value always wins on persist. This kills the DUP-drift class.
3. **Rounding rules (single definition):**
   - `roundMoney` = half-up, `+Number.EPSILON`, 2 dp — the one function for all customer-facing figures (already shared FE/BE).
   - Per-line `tax_amount` persisted at 6 dp (raw), rolled up and rounded **once**.
   - **Never chain-round.** Displayed Total must be derived from the same rounded components shown so receipts foot (fixes F5/F6).
4. **Vocabulary (rename to kill the `subtotal`-means-two-things trap):**
   - `netSubtotal` — Σ line net, pre-order-discount, pre-tax.
   - `discountedSubtotal` — post-order-discount, pre-tax.
   - `tax` — Σ prorated per-line tax.
   - `grossTotal` — `discountedSubtotal + tax` (the charged amount).
   - `serviceCharge` — a line, not an order field.
   - `seatNetSubtotal` / `seatGrossTotal` — split-time, unambiguous (fixes F10). `TableSplits.vue` must stop labeling net subtotal as "Total".
5. **Customer documents:** guest check, split check, and paid receipt all render through the same preview helper → identical Tax + Total everywhere (fixes F1/F7).

---

## 6. Focused test plan

### Backend unit (`backend/tests/unit/`, vitest)
- `PosCalculator`: service-charge base rounding parity (FE rounded-subtotal vs BE raw); lock "order discount reduces Auto-Gratuity" expectation; per-line breakdown `{net,tax,gross}` sums to rollup.
- `assertServiceChargeValid` on the split-seat shape.

### Backend integration (`backend/tests/integration/`)
- **Discount HTTP guards (gap):** POST `/pos/checkout` and `/pos/table_order` with `order_discount_value: -5` and `150` (percent) → expect **400**. Same for negative item-level `discountValue`.
- **Service-charge forgery on the checkout path (gap):** qty-inflation, second forged line, missing `tax_rate` → expect **400** (currently covered on tables path only).
- **Split phantom seat (S1) — top priority:** POST `/pos/table_splits/split` with an underpriced real seat + a phantom `items:[]` seat padding the aggregate → expect **rejection** (currently returns 200 and destroys value; probe already written).
- **Split price-pinning (F2):** POST `/pos/table_splits/split` with redistributed per-seat prices (sum preserved) → expect **rejection** after the `applyDatabasePrices` fix.
- **Split price 0 (S1 variant):** real seat priced `0` + phantom → expect rejection (guards 100% loss).
- **Held-order tamper (F9):** hold with forged `cart_data` prices, then claim + checkout → charged at **DB price**.
- **Cumulative drift:** subtotal +0.02 AND total +0.02 simultaneously → still bounded/rejected as intended.
- **Split printed vs charged (F1):** assert split-check print total == settle charge.

### Frontend unit (`assets/js/composables/**`, vitest)
- `orderSessionStore` foot check: shown `Subtotal − Discount + Tax === Total` across a matrix of rates/qtys (F5).
- Service-charge fee base parity with BE (F11).
- `getItemTotalGross` vs displayed Total reconciliation with an order discount present (F6).

### Playwright (`tests/e2e/specs/`) — add adversarial
- Register: DevTools-mutate a cart line `price`/`tax_rate` before checkout → server normalizes/rejects; on-screen Total == printed receipt Total == charged.
- Tables: open → save → split → print each seat → settle; assert printed seat total == charged total (F1), and no total drift across save/recall/settle.

---

## 7. Not-a-bug (verified, do not "fix")
- Client `data.tax` is never validated — intentional; server recomputes + overwrites tax.
- `assertNearMoney` 0.02 tolerance does not leak revenue — server **overwrites** persisted totals with its own value regardless.
- Product-line client `tax_rate` ignored — intentional (P3-14).
- Bundle child rows carry 0 money — intentional; parent carries the price/tax.
