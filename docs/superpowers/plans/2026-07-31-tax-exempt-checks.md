# Tax-Exempt Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` inline, `ponytail`, `test-driven-development`, `vue`, `mysql`, and `jofotara-invoice-integration`. Do not use subagents or brainstorming. Execute only this plan, one task and one focused commit at a time.

**Goal:** Restore a permission-controlled, whole-check tax exemption that is financially authoritative, cannot leak into the next order, survives legitimate hold/table/split workflows, preserves fixed modifier prices, and prints `(معفي من الضريبة)` on the cart and customer receipt.

**Architecture:** Tax exemption is one explicit order-level fact (`tax_exempt_at_sale`), not a change to global settings and not a mutation of item tax rates. The shared calculator derives the real pre-tax unit price; paid/open order rows store that charged pre-tax price in `price_at_sale` and retain the original frozen unit price in `price_before_tax_exemption` so reapplying tax never depends on current catalog prices or reverse arithmetic. The frontend previews the same contract, while checkout, held-order creation, and table saves remain server-authoritative and permission-gated. Receipt v1 gains an additive optional `taxExempt` flag while retaining an existing `taxMode`, so older spoolers print `0.00` rather than rejecting an unknown model; updated spoolers print the required label.

**Tech Stack:** Vue 3, Pinia, Express 5, MySQL/MariaDB via mysql2, Vitest, Supertest, tracked Node/Puppeteer spooler, JoFotara UBL XML.

---

## Non-negotiable behavior contract

1. The toggle applies to the entire current unpaid check only. It does not alter `settings.tax_inclusive_pricing`, product records, tax rates, or later orders.
2. The More modal shows the action only to admin/programmer users or users granted `pos.tax_exempt`. The action is disabled while the cart is empty and unavailable under the `income_tax` registration profile, where the system already has no sales-tax liability.
3. Selecting the action again reapplies tax. Paid orders cannot be changed retroactively.
4. The backend accepts only a boolean `tax_exempt`. A truthy string such as `"true"`, `1`, or a missing value must not silently activate it.
5. A non-admin user must have `pos.tax_exempt` whenever they create the exemption: a new checkout/hold with true or an open table transitioning false to true. A server-locked table/split/platform order that is already exempt may be preserved or settled by an otherwise-authorized cashier without demanding the exemption permission again. A claimed ordinary hold still requires permission at final checkout because the current claim flow deletes the held row and provides no durable server proof; do not invent a signing/token framework for this edge. UI hiding is never authorization.
6. The permission is default-deny: `default_cashier=0`, `overridable=0`. Existing cashiers receive no automatic grant. Admin/programmer retain the existing role bypass.
7. Product and service-charge rows retain their configured `tax_rate`; their calculated/stored `tax_amount` becomes zero. Their stored `price_at_sale` is the actual pre-tax charged unit price. Keeping the original rate distinguishes an exempt taxable line from an originally zero-rated line.
   The price-shape invariant is explicit: frontend carts and held/split drafts carry the frozen raw/source price; exempt persisted product/custom rows carry the charged net price in `price_at_sale` and the frozen source price in `price_before_tax_exemption`. A table restore maps the frozen source back to calculator input and derives the charged value once. Only DB-only recomputation over persisted exempt rows may use `pricesAlreadyExempt=true`; never send that mode through an editable client payload.
8. The auto-service-charge line remains on the check. Recalculate it once as the configured percentage of the already-exempt item base, then set its tax to zero. Never de-tax that generated fee a second time. Its `price_before_tax_exemption` may remain `NULL` because the snapshot percentage plus frozen item source prices deterministically regenerate it.
9. A fixed modifier surcharge remains the exact configured gross amount. A `0.15` cheese modifier contributes `0.15` whether the order is normal, tax-inclusive, tax-exclusive, or exempt. Exemption must not subtract `modifier_tax_amount` from that surcharge.
10. In every pricing mode, the customer pays the pre-tax value. In tax-exclusive mode the configured price is already the pre-tax basis and no tax is added. In tax-inclusive mode, remove embedded tax from the base item/service-charge using `grossBase / (1 + rate/100)`, then add the fixed modifier surcharge back unchanged. A normal total of `20.00` that contains `3.00` tax becomes an exempt total of `17.00` everywhere.
11. Discounts retain current ordering and clamps. Exemption changes tax calculation only; it does not create a second discount path.
12. The cart and customer receipt tax row displays the exact value `(معفي من الضريبة)`. Kitchen tickets are unchanged because they do not contain financial totals.
13. A held order, open table, or split child may preserve its own exemption because it is still the same check. Missing/legacy payload fields always default to false. Completing, clearing, voiding, abandoning, loading an unrelated order, or starting a new order always resets it.
14. Audit the authoritative transition, not merely the UI click: exempt held-order creation and open-table false-to-true/true-to-false saves record their actor; every successful exempt final checkout records the original non-exempt total, derived pre-tax total, tax removed, and final zero tax. Failed or rolled-back writes create no audit event.
15. JoFotara sales-tax invoices classify originally taxable exempt lines as category `E`, while genuinely zero-rated lines remain `Z`. Income-tax invoices remain on their existing path. Refund credit notes preserve the original line category.
16. No dedicated exemption-number modal, per-item exemption, per-tax-rate exemption, manager-PIN override, closed-check tax editing, new report page, or global settings toggle is included in this plan.

## Research decisions

- Toast places Tax Exempt in the check overflow menu, protects it with a dedicated permission/manager authorization, records an exemption reference, disallows retroactive exemption on paid checks, and reports exempt checks. This validates the More-modal location, permission wall, immutable paid-order rule, and durable order flag: <https://central.toasttab.com/articles/en_US/Knowledge/How-to-run-a-Tax-Exempt-transaction-1492809352212>
- Oracle MICROS Simphony exposes Tax Exempt through check/transaction functions, makes it a reversible check operation, supports whole-check or narrower tax-rate scopes, and can print an inclusive-tax-exempt summary: <https://docs.oracle.com/en/industries/food-beverage/simphony/19.8/simcg/c_taxes_exempting.htm>
- Oracle also records tax-exempt sales separately in tax reporting: <https://docs.oracle.com/en/industries/food-beverage/reporting-and-analytics/rarrg/c_taxes_add.htm>
- This first restoration deliberately implements only the requested whole-check scope. The persisted flag and audit event provide the foundation for a later exemption-reference field or dedicated report without forcing either workflow on current restaurants.

## Anti-regression examples

Use these values in both frontend and backend unit tests:

- Exclusive item: base `1.00`, tax `16%`, modifier surcharge `0.15`, modifier embedded-tax snapshot approximately `0.02069`.
  - Normal: existing behavior remains unchanged.
  - Exempt: subtotal `1.15`, tax `0.00`, total `1.15`.
- Exclusive service charge: taxable product subtotal `10.00`, automatic service charge `10%` with tax rate `16%`.
  - Exempt: product `10.00` + charge `1.00`; tax `0.00`; total `11.00` before any discount.
- Inclusive item: displayed base `1.16`, tax `16%`, modifier `0.15`.
  - Exempt base: `1.16 / 1.16 = 1.00`; fixed modifier stays `0.15`; subtotal and total are `1.15`; tax is `0.00`; label is `(معفي من الضريبة)`.
- Mixed check: one 16% taxable item and one 0% item.
  - Both have zero tax on an exempt order, but their persisted `tax_rate` values remain `16` and `0`, allowing JoFotara to emit `E` and `Z` respectively.

---

### Task 1: Restore schema authority and the default-deny permission

**Files:**
- Create: `backend/migrations/2026-07-31-tax-exempt-checks.sql`
- Create: `backend/migrations/2026-07-31-tax-exempt-checks-preflight.sql`
- Create: `backend/migrations/2026-07-31-tax-exempt-checks-verify.sql`
- Modify: `deployment/database/baseline.sql`
- Modify: `deployment/database/manifest.json`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/services/PermissionService.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`
- Modify: `backend/tests/integration/permissions.test.js`

**Step 1: Write failing schema and permission tests**

Assert all of the following:

- `orders.tax_exempt_at_sale TINYINT(1) NOT NULL DEFAULT 0` and nullable `order_items.price_before_tax_exemption DECIMAL(10,6)` exist in the test fixture and fresh baseline.
- the newest schema ledger/checksum is `2026-07-31-tax-exempt-checks-v1`;
- the permission catalog contains `pos.tax_exempt` with Arabic label `إعفاء ضريبي`, `implemented=1`, `default_cashier=0`, and `overridable=0`;
- an ordinary cashier is not granted the permission by bootstrap/seed;
- an explicit user grant works, and admin/programmer bypass still works;
- the historical `apply-remove-tax-exempt-permission.js` test remains untouched as a migration-history test.

Run:

```powershell
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js backend/tests/integration/permissions.test.js
```

Expected: fail because the column, newest ledger entry, permission constant/catalog entry, and assertions do not exist.

**Step 2: Implement the guarded migration**

The migration must:

- require `orders`, `permissions`, `user_permissions`, and `schema_migrations`;
- reject a conflicting checksum and safely no-op when the matching ledger row exists;
- add `tax_exempt_at_sale` after `tax_registration_type_at_sale` and `order_items.price_before_tax_exemption DECIMAL(10,6) NULL` after `price_at_sale`;
- delete any orphan/stale `user_permissions` rows for `pos.tax_exempt` before re-inserting the permission, ensuring the restored capability is default-deny;
- insert/update the catalog definition without granting it to any user;
- record its checksum.

The preflight must detect missing prerequisites and checksum conflicts without mutating. The verify script must assert the exact column definition, permission definition, zero automatic grants, and ledger checksum.

**Step 3: Update fresh-install and runtime authority**

- Add the two columns to the schema-only `baseline.sql`; keep business rows out of the fresh baseline, as its installer contract requires.
- Update the baseline SHA-256 in `manifest.json` after all baseline changes.
- Add the new migration ledger row to `bootstrap-database.js`.
- Advance `schemaValidation.js` to the new migration name/checksum and add `tax_exempt_order_column=1`, `tax_exempt_original_price_column=1`, and `tax_exempt_permission=1` checks.
- Add the column to `seed.js` and seed the catalog row in the fixture's existing permission seed, without adding a `user_permissions` grant.
- Add `PERMISSIONS.POS_TAX_EXEMPT` and `canTaxExempt(user)` to `PermissionService.js`.

**Step 4: Run focused tests**

Run the Step 1 command again. Expected: pass.

**Step 5: Commit**

```powershell
git add backend/migrations/2026-07-31-tax-exempt-checks.sql backend/migrations/2026-07-31-tax-exempt-checks-preflight.sql backend/migrations/2026-07-31-tax-exempt-checks-verify.sql deployment/database/baseline.sql deployment/database/manifest.json deployment/tools/bootstrap-database.js backend/services/schemaValidation.js backend/tests/fixtures/seed.js backend/services/PermissionService.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js backend/tests/integration/permissions.test.js
git commit -m "feat(tax): restore tax-exempt schema and permission"
```

### Task 2: Add one shared calculation concept without changing normal pricing

**Files:**
- Modify: `src/utils/posTotals.js`
- Modify: `backend/services/PosCalculator.js`
- Modify: `backend/services/ServiceChargeCalculator.js`
- Modify: `backend/services/OrderPricing.js`
- Modify: `backend/tests/unit/posTotals.test.js`
- Modify: `backend/tests/unit/posTotalsParity.test.js`
- Modify: `backend/tests/unit/serviceChargeCalculator.test.js`
- Modify: `backend/tests/unit/serviceChargeParity.test.js`
- Modify: `backend/tests/integration/serviceChargeSnapshots.test.js`

**Step 1: Write failing money-contract tests**

Add the four anti-regression examples above. Also pin:

- normal exclusive and inclusive results remain byte-for-byte/current-cent identical when `taxExempt` is false or absent;
- `exemptUnitPrice(item, taxRate, taxInclusive, { alreadyExempt=false }={})` returns the configured/raw unit price in exclusive mode, but in inclusive mode removes embedded tax from only `price - modifier_surcharge` and then restores the surcharge unchanged; `alreadyExempt=true` returns the stored charged price without a second conversion;
- the derived unit price is normalized to six decimals before totals and persistence, so browser, MySQL `DECIMAL(10,6)`, receipts, refunds, and JoFotara use the same value;
- discounts still apportion before tax and clamp as today;
- `stampLineTax(..., { taxExempt: true })` returns zero without changing the supplied rate;
- `recomputeOrderTotals` respects persisted exemption for open tables;
- an exempt service charge is generated exactly once from the exempt goods base: inclusive goods `20.00 -> 17.00` with a 10% charge produces `1.70`, not `2.00` and not a double-divided `1.47`; its line tax is zero;
- restoring/repricing an exempt open-table service charge repeats the same `17.00 * 10% = 1.70` result.

Run:

```powershell
npx vitest run backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/serviceChargeParity.test.js backend/tests/integration/serviceChargeSnapshots.test.js
```

Expected: fail because calculators do not accept `taxExempt` or derive a six-decimal pre-tax unit price.

**Step 2: Implement the smallest calculator change**

- Add `taxExempt=false` to the existing options objects; do not introduce a new calculator class or module.
- Add the same small `exemptUnitPrice(item, taxRate, taxInclusive, { alreadyExempt=false }={})` pure helper to the existing frontend/backend calculator files and cover their parity. When `alreadyExempt` is false and input is inclusive, calculate `round6(max(0, price - modifier_surcharge) / (1 + rate/100) + modifier_surcharge)`; for already-exempt, exclusive, or zero-rate rows, return `round6(price)`.
- Keep `backend/services/PosCalculator.js` as the financial authority and `src/utils/posTotals.js` as a display-only mirror. Their existing CommonJS/browser boundary makes this one small mirrored helper cheaper and safer than creating a compatibility package; the parity suite is the guard against drift. Do not duplicate the formula anywhere else.
- In exempt mode, `calculateLineSubtotal`/`lineNet` use `exemptUnitPrice`; fixed modifiers therefore remain unchanged while embedded base/service-charge tax is removed.
- In exempt mode, `stampLineTax`/`lineTax` return zero.
- `calculateExpectedTotals`/`posTotals` use the exempt subtotal, existing discount logic, zero tax, and discounted subtotal as total.
- Thread `taxExempt` through the existing frontend/backend `serviceChargeBase`, `serviceChargeFee`, `canonicalizeServiceCharge`, and `allocateServiceChargeCents` options. Goods use `exemptUnitPrice`; the generated Auto-Gratuity price is already exempt and is not passed through `exemptUnitPrice` again.
- Add `pricesAlreadyExempt=false` to the existing `calculateExpectedTotals` options and pass it to `exemptUnitPrice`. `OrderPricing.recomputeOrderTotals` passes `taxExempt: true, pricesAlreadyExempt: true` for persisted exempt rows, preventing a second division.
- Preserve every existing non-exempt branch exactly.

**Step 3: Run focused tests and commit**

Run the Step 1 command. Expected: pass.

```powershell
git add src/utils/posTotals.js backend/services/PosCalculator.js backend/services/ServiceChargeCalculator.js backend/services/OrderPricing.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/serviceChargeParity.test.js backend/tests/integration/serviceChargeSnapshots.test.js
git commit -m "feat(tax): calculate exempt check totals authoritatively"
```

### Task 3: Restore current-order state, More-modal control, and every reset wall

**Files:**
- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/stores/orderSession/orderSessionPersistence.js`
- Modify: `src/pos/stores/orderSession/checkoutFlow.js`
- Modify: `src/pos/useCart.js`
- Modify: `src/components/PosTerminal.vue`
- Modify: `src/components/pos/PosCartWorkspace.vue`
- Modify: `src/shared/i18n.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `backend/tests/unit/orderSessionPersistence.test.js`
- Modify: `backend/tests/unit/checkoutFlow.test.js`
- Modify: `backend/tests/unit/useCart.logic.test.js`

**Step 1: Write failing lifecycle tests before UI code**

Test all transitions explicitly:

- permission granted/admin shows `canTaxExempt`; ordinary cashier does not;
- empty cart cannot activate exemption;
- toggling changes totals immediately and is reversible;
- when an inclusive `20.00` line contains `3.00` tax, the cart row/subtotal/total all display `17.00`, not merely a zero tax footer;
- a browser refresh restores exemption only when the same persisted cart is non-empty;
- malformed persisted values and `"true"` default to false;
- `clearOrderSlice`, `startNewOrder`, successful `finalizeCheckout`, manual clear, removal of the final unsaved item, order-edit load, logout/session clear, and unrelated table load all clear the value;
- held/table restore first clears residue, then applies only an explicit boolean from that order; a legacy payload with no field stays false;
- exemption is included in the checkout fingerprint, request payload, frozen checkout result, and fallback receipt input, so toggling it cannot reuse a stale idempotency attempt;
- `POS_ORDER_SESSION_KEYS`, `clearOrderData`, and `clearPosOrderSession` remove its local-storage key.

Run:

```powershell
npx vitest run backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/useCart.logic.test.js
```

Expected: fail because the state, persistence key, facade, fingerprint, and UI contract do not exist.

**Step 2: Implement state and persistence**

- Add `isTaxExempt = ref(false)` beside the existing tax-mode refs.
- Add one computed `canTaxExempt` using `permissions.can('pos.tax_exempt')` and one action `toggleTaxExempt()` that refuses an empty cart or income-tax profile.
- Pass `{ taxInclusive, taxExempt: isTaxExempt.value }` into `posTotals`; build the cart receipt rows from the same derived six-decimal unit prices so line rows and summary both change from gross to pre-tax.
- Add `pos_tax_exempt` to `orderSessionPersistence.js`; store only literal JSON boolean `true`, remove the key for false, and restore it only with a non-empty restored cart.
- Put the reset in `clearOrderSlice()` and use that single wall; do not scatter ad-hoc post-checkout assignments.
- Add `taxExempt` to `buildCheckoutFingerprintSource`, `buildCheckoutRequest`, `frozen`, and `buildSuccessfulCheckoutResult`.
- Export only the ref/computed/action through the existing `useCart()` facade.

**Step 3: Implement the More-modal and cart label**

- Add one More-modal tile using the existing action-tile visual language.
- Its selected state must be visually explicit and its label must switch between on/off without opening another modal.
- Close the More modal after a successful toggle.
- In `PosCartWorkspace.vue`, keep the Tax row position under Subtotal. When exempt, show `(معفي من الضريبة)` instead of `0.00 JD`.
- Add only necessary English/Arabic translation keys; reuse the already-present historic tax-exempt translations where correct.

**Step 4: Run focused tests and commit**

Run the Step 1 command. Expected: pass.

```powershell
git add src/pos/stores/orderSessionStore.js src/pos/stores/orderSession/orderSessionPersistence.js src/pos/stores/orderSession/checkoutFlow.js src/pos/useCart.js src/components/PosTerminal.vue src/components/pos/PosCartWorkspace.vue src/shared/i18n.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/useCart.logic.test.js
git commit -m "feat(pos): restore permissioned tax-exempt check toggle"
```

### Task 4: Make checkout authoritative, auditable, and immutable

**Files:**
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/tests/integration/checkout.test.js`
- Modify: `backend/tests/integration/permissions.test.js`
- Modify: `backend/tests/unit/checkoutModuleWiring.test.js`

**Step 1: Write failing API/security tests**

Cover:

- permitted cashier and admin can create and checkout a newly exempt order;
- ordinary cashier receives `403`/`TAX_EXEMPT_PERMISSION_REQUIRED` when creating exemption, while an otherwise-authorized cashier may settle an already-exempt server-locked table/split/platform order without acquiring the permission merely to preserve its fiscal state;
- `tax_exempt: "true"` and `tax_exempt: 1` receive `400`;
- sending tax `0` without the flag still fails the existing subtotal/total anti-tamper checks;
- backend-recomputed exempt subtotal/tax/total must match submitted anchors;
- configured product/service-charge tax rates remain stored, line/order tax amounts are zero, and modifier surcharge remains exact;
- an inclusive raw `20.00` line that contains `3.00` tax stores `price_at_sale=17.000000`, `price_before_tax_exemption=20.000000`, and `tax_amount=0.000000`; the order subtotal/total are `17.00`;
- an exclusive raw pre-tax line stores the same charged `price_at_sale`, while `price_before_tax_exemption` retains the frozen submitted/server-resolved source price;
- `orders.tax_exempt_at_sale=1` is persisted for exempt sales and `0` otherwise;
- the audit event is transactionally written only on successful exempt checkout and records normal total, exempt pre-tax total, removed tax amount, original pricing mode, and final zero tax;
- idempotent retry returns the same order and does not duplicate the audit event;
- reusing one idempotency key after changing only `tax_exempt` produces the existing payload-conflict response rather than returning a normal-tax result for an exempt request or vice versa;
- paid-order edit paths remain prohibited.

Run:

```powershell
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/permissions.test.js backend/tests/unit/checkoutModuleWiring.test.js
```

Expected: fail because checkout ignores the flag and has no permission/persistence/audit path.

**Step 2: Implement server authority**

- Parse only `data.tax_exempt === true`; reject any present non-boolean value.
- Reject true for the income-tax registration profile.
- Call `canTaxExempt(user)` before accepting a client-created exemption. If checkout is settling an existing server-locked table/split/platform order, derive exemption from that locked row and preserve it without a second permission demand. A claimed ordinary hold still requires permission because its current claim flow removes the durable held row before checkout; do not add a token/signature subsystem.
- Pass `taxExempt` into `calculateExpectedTotals`, `stampLineTax`, service-charge canonicalization/reconciliation, and receipt creation.
- Persist `tax_exempt_at_sale` in both order INSERT and open-order UPDATE statements.
- Include the authoritative exemption boolean in the server-side idempotency/request identity before any cached checkout result can be reused.
- For each exempt product/custom financial parent row, persist `exemptUnitPrice(...)` into `price_at_sale`, the server-resolved frozen raw unit price into `price_before_tax_exemption`, the original effective `tax_rate`, and zero `tax_amount`. Persist the already-generated exempt Auto-Gratuity price with `price_before_tax_exemption=NULL`. For non-exempt rows, preserve current `price_at_sale` and store `NULL` in the new column.
- Calculate the non-exempt expected total once with the existing calculator only for the audit payload. Record `removedTax = normalExpected.total - exemptExpected.total`; this captures embedded inclusive tax as well as added exclusive tax without a parallel formula.
- Append one `tax_exempt_sale` audit event after the invoice id exists, inside the checkout transaction.

**Step 3: Run tests and commit**

Run the Step 1 command. Expected: pass.

```powershell
git add backend/modules/checkout/executeCheckout.js backend/tests/integration/checkout.test.js backend/tests/integration/permissions.test.js backend/tests/unit/checkoutModuleWiring.test.js
git commit -m "feat(checkout): enforce and audit tax-exempt sales"
```

### Task 5: Preserve the same check across holds, tables, and splits without leaking it

**Files:**
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/modules/tables/saveTableOrder.js`
- Modify: `backend/modules/tables/splitChecks.js`
- Modify: `backend/modules/tables/tableRelationships.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `backend/tests/integration/heldOrders.test.js`
- Modify: `backend/tests/integration/tables.test.js`
- Modify: `backend/tests/unit/splitChecks.test.js`
- Modify: `backend/tests/unit/tableSession.logic.test.js`
- Modify: `backend/tests/unit/tableRelationshipModuleWiring.test.js`
- Modify: `backend/tests/integration/platformHeldSettlement.test.js`

**Step 1: Write failing continuity and stale-state tests**

Test:

- creating an exempt hold requires permission and stores `tax_exempt_at_hold: true` in server-written `cart_data`;
- non-boolean/missing legacy values restore false;
- claim/restore preserves exempt only for that held order, then a new order resets false;
- open-table false-to-true save requires permission, persists `orders.tax_exempt_at_sale`, stores charged pre-tax `price_at_sale` plus frozen `price_before_tax_exemption`, recomputes zero taxes, and returns the field; preserving true or turning it false follows the transition rule rather than demanding permission again;
- restoring an exempt open table exposes the frozen pre-exemption price as calculator input but the derived pre-tax price as the visible/charged line value; toggling exemption off restores the exact frozen price even if the catalog price changed meanwhile;
- loading table A exempt followed by table B non-exempt cannot carry the flag;
- all split children inherit the locked parent exemption, carry the parent's frozen raw source prices in editable/held payloads, derive charged pre-tax amounts exactly once at authoritative persistence, allocate zero tax cents, and never divide an already-persisted net price a second time;
- split cancellation/restoration and progressive settlement keep the parent/child contract;
- table transfer preserves the source check unchanged; table merge rejects taxable/exempt source-target pairs with `409 TAX_EXEMPT_CONTEXT_MISMATCH` before moving any row or snapshot;
- same-context exempt merges copy `price_before_tax_exemption`, include it in line-merge identity, and regenerate Auto-Gratuity once from the merged net goods base with zero tax;
- platform-held settlement preserves a server-written exemption and never fires kitchen again; a normal platform hold remains unchanged;
- `tax_inclusive_at_sale` and `tax_registration_type_at_sale` behavior remains unchanged.

Run:

```powershell
npx vitest run backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/unit/splitChecks.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableRelationshipModuleWiring.test.js backend/tests/integration/platformHeldSettlement.test.js
```

Expected: fail because no hold/table/split payload carries exemption.

**Step 2: Implement propagation at existing boundaries**

- Add the boolean to the existing order draft returned by `readOrderDraft()`; do not create a new workflow module.
- On hold routes, require permission when creating an exempt hold. On table save, require permission only for the authoritative false-to-true transition; allow an otherwise-authorized user to preserve an already-exempt server-locked table and to turn exemption off. Record the actor for exempt hold creation and both table exemption transitions in the same DB transaction. Failed writes record nothing.
- Use `tax_exempt_at_hold` in held JSON, mirroring existing `tax_inclusive_at_hold` naming.
- Add `tax_exempt_at_sale` and `price_before_tax_exemption` to existing table SELECT/response/update/insert statements and pass the exemption to the authoritative calculator/stamper.
- When an exempt table is loaded for editing, map `price_before_tax_exemption ?? price_at_sale` to the draft's raw source price and keep `price_at_sale` only as persisted charged-price evidence. This makes the toggle reversible without consulting current product prices and prevents double exemption.
- Split from the locked parent row, never from a client flag. Every editable/held child draft carries the frozen raw source price; derive its charged pre-tax value once during authoritative settlement and allocate zero tax cents. Persist both raw and charged values on the child order rows.
- In `tableRelationships`, lock and compare both orders' `tax_exempt_at_sale` values before a merge. Reject a mixed fiscal context instead of silently converting either order. For an exempt-to-exempt merge, copy the original-price column on parent and child rows, add it to the existing line-equivalence predicate, and recompute the surviving service charge from already-net goods without applying exemption twice. A transfer moves the existing order id and needs no repricing.
- On restore, call the canonical clear/load boundary first, then apply `value === true`; absence must never inherit current memory.

**Step 3: Run tests and commit**

Run the Step 1 command. Expected: pass.

```powershell
git add backend/routes/pos/orders.js backend/modules/tables/saveTableOrder.js backend/modules/tables/splitChecks.js backend/modules/tables/tableRelationships.js backend/routes/pos/tables.js src/pos/stores/orderSession/tableOrderWorkflow.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/unit/splitChecks.test.js backend/tests/unit/tableSession.logic.test.js backend/tests/unit/tableRelationshipModuleWiring.test.js backend/tests/integration/platformHeldSettlement.test.js
git commit -m "feat(tax): preserve exemption across order workflows"
```

### Task 6: Print the exempt label through receipt v1 and custom templates

**Files:**
- Modify: `backend/services/ReceiptPresentation.js`
- Modify: `src/utils/receiptPresentation.js`
- Modify: `backend/services/ReceiptPresentationSources.js`
- Modify: `backend/services/printDocumentModel.js`
- Modify: `backend/services/printTemplateEngine.js`
- Modify: `backend/services/printTemplateDefaults.js`
- Modify: `pos-spooler-printer/receiptDisplayV1.cjs`
- Modify: `backend/tests/fixtures/receiptPresentationCases.json`
- Create: `backend/tests/fixtures/printGoldens/receipt-tax-exempt.html`
- Modify: `backend/tests/unit/receiptPresentation.test.js`
- Modify: `backend/tests/unit/receiptPresentationContract.test.js`
- Modify: `backend/tests/unit/receiptPresentationParity.test.js`
- Modify: `backend/tests/unit/printDocumentModel.test.js`
- Modify: `backend/tests/unit/printTemplateEngine.test.js`
- Modify: `backend/tests/unit/spoolerReceiptDisplay.test.js`
- Modify: `pos-spooler-printer/tests/receipt-display.test.js`

**Step 1: Write failing receipt-parity tests**

Require:

- receipt v1 accepts optional boolean `taxExempt`, rejects non-boolean values, and emits `summary.taxLabel='(معفي من الضريبة)'` with tax amount zero;
- exemption keeps an existing tax mode (`exclusive` in the presentation fallback) rather than adding a new enum, so an older tracked spooler validator does not reject the job;
- current-cart/held receipt rows derive the same pre-tax base price as the calculators, preserve fixed modifiers, and reconcile to the lower exempt subtotal;
- persisted-order receipt rows use the already-charged pre-tax `price_at_sale` directly and never divide them a second time;
- backend and frontend presentations remain JSON-identical;
- current spooler output and custom-template output show the exact Arabic phrase rather than `0.00 JD` or `Included in prices`;
- existing active template revisions that contain the old `summary.taxAmount` field still render the label when `summary.taxLabel` is present;
- all existing non-exempt inclusive, exclusive, split, refund, bundle, and service-charge goldens remain unchanged; the new exempt golden carries the lower pre-tax rows and total.

Run:

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationContract.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/printDocumentModel.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/spoolerReceiptDisplay.test.js pos-spooler-printer/tests/receipt-display.test.js
```

Expected: fail because receipt v1 has no exemption fact and renderers use tax mode alone.

**Step 2: Implement backward-compatible presentation**

- Add optional `taxExempt` to both presentation builders/validators and their parity fixture. Do not add a fourth tax-mode enum or bump receipt version.
- Let the builder accept an explicit tax label only when `taxExempt === true`; force tax amount zero and emit the exact Arabic value.
- For current-cart and held-order sources, transform raw prices with `exemptUnitPrice` before calling the presentation builder. For persisted paid/open-order sources, use the already-normalized `price_at_sale` directly. Make the input distinction explicit at the existing source functions; do not infer it from whether tax is zero.
- Pass `order.tax_exempt_at_sale` from every order/held presentation source.
- Add `taxExempt` to `printDocumentModel`.
- Change template field resolution so `summary.taxAmount` yields `summary.taxLabel` whenever a label exists, not only in inclusive mode. This protects already-published templates.
- Change the builtin default visibility rules to show the numeric tax field when `summary.taxLabel` is falsy and the label field when it is truthy.
- Change `receiptDisplayV1.cjs` to escape and render the supplied label whenever present.

**Step 3: Run tests and commit**

Run the Step 1 command. Expected: pass.

```powershell
git add backend/services/ReceiptPresentation.js src/utils/receiptPresentation.js backend/services/ReceiptPresentationSources.js backend/services/printDocumentModel.js backend/services/printTemplateEngine.js backend/services/printTemplateDefaults.js pos-spooler-printer/receiptDisplayV1.cjs backend/tests/fixtures/receiptPresentationCases.json backend/tests/fixtures/printGoldens/receipt-tax-exempt.html backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationContract.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/printDocumentModel.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/spoolerReceiptDisplay.test.js pos-spooler-printer/tests/receipt-display.test.js
git commit -m "feat(receipts): print tax-exempt check labels"
```

### Task 7: Preserve fiscal meaning through reprints, refunds, and JoFotara

**Files:**
- Modify: `backend/services/JofotaraXmlBuilder.js`
- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/services/RefundService.js`
- Modify: `backend/modules/refunds/voidOpenTableOrder.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/tests/unit/jofotaraXmlBuilder.test.js`
- Modify: `backend/tests/integration/jofotara.test.js`
- Modify: `backend/tests/integration/refunds.test.js`
- Modify: `backend/tests/integration/print.authz.test.js`
- Modify: `backend/tests/integration/dailyReportsSalesDetails.test.js`
- Modify: `backend/tests/integration/dailyReportsSummary.test.js`
- Modify: `backend/tests/integration/productSalesMetrics.test.js`
- Modify: `backend/tests/integration/shift.test.js`

**Step 1: Write failing fiscal tests**

Cover:

- order reprint reads persisted exemption and prints the label after global settings change;
- partial/full refund monetary allocations use stored zero line tax and never invent tax;
- refunds use the stored pre-tax `price_at_sale`, so a `20.00 -> 17.00` exempt sale can refund at most `17.00`, never `20.00`;
- voided open-table recomputation preserves the exempt flag and zero tax; repriced Auto-Gratuity is regenerated once from already-net goods and is not divided again;
- daily sales details, daily summaries, product metrics, and X/Z shift totals report revenue `17.00` and tax `0.00` from the persisted exempt sale; none reconstruct the former `20.00` gross amount;
- sales-tax JoFotara snapshot emits category `E`, rate `0`, and six-decimal zero tax for lines whose stored original tax rate is positive;
- originally zero-rated lines remain category `Z`;
- mixed E/Z lines use the same stored pre-tax extensions and reconcile exactly to the saved lower order subtotal/discount/total;
- credit-note lines copy/derive the same E/Z category as the original fiscal line;
- income-tax snapshot behavior is unchanged;
- an exempt JoFotara rejection becomes the existing pending/rejected operations state and never rolls back or duplicates the completed POS sale.

Run:

```powershell
npx vitest run backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/refunds.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/shift.test.js
```

Expected: fail because zero tax is currently classified as `Z` and read paths do not select the exemption column.

**Step 2: Implement persisted fiscal behavior**

- Add `tax_exempt_at_sale` and, where line restoration needs it, `price_before_tax_exemption` to the narrow SELECT lists used by print, reprint, refund, void, and JoFotara sources.
- Keep refund allocations on stored `price_at_sale` and stored zero `tax_amount`; never reverse the exemption or consult the current catalog. Reprint and report paths likewise consume the persisted net sale. The existing report services already aggregate `price_at_sale`/`tax_amount`, so change no report production file unless a failing behavioral test proves a re-grossing branch.
- When voiding/repricing an exempt open table, pass `taxExempt: true` and `pricesAlreadyExempt: true` for persisted goods, regenerate the percentage service charge from that net base once, retain configured tax rates, and stamp all calculated tax amounts to zero.
- In `buildSalesSnapshot`, when the order is exempt, use the stored charged pre-tax `price_at_sale` as the line extension basis, tax zero, and category `E` only for a positive stored original `tax_rate`; retain `Z` for true zero-rated rows. Do not divide or subtract tax again in JoFotara.
- Preserve current six-decimal XML formatting.
- In credit-note construction, use the original invoice snapshot/source-item mapping to retain E versus Z; never infer all zero-tax lines as Z.
- Do not block checkout on JoFotara. Use the existing document-state/retry operations.

**Step 3: Controlled JoFotara gate**

Before enabling exempt invoices for a restaurant with automatic submission, submit one controlled exempt invoice and its test credit note against that restaurant's JoFotara credentials, then confirm acceptance and QR/document state in JoFotara Operations. Category `E` is the correct UBL/JoFotara classification, but this repository has no recorded live acceptance evidence for an exempt document; unit XML validity is not a substitute for ISTD acceptance.

**Step 4: Run tests and commit**

Run the Step 1 command. Expected: pass.

```powershell
git add backend/services/JofotaraXmlBuilder.js backend/services/JofotaraService.js backend/services/RefundService.js backend/modules/refunds/voidOpenTableOrder.js backend/routes/print.js backend/routes/pos/orders.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/refunds.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/shift.test.js
git commit -m "feat(fiscal): preserve tax exemption in refunds and JoFotara"
```

### Task 8: Run adversarial workflow verification and document deployment

**Files:**
- Create: `backend/tests/integration/taxExemptWorkflow.test.js`
- Modify: `docs/SPOOLER-CHANGES.md`

**Step 1: Add one compact cross-module integration test**

Do not duplicate every focused test from Tasks 1-7. This test must execute only the seams that no single owner test can prove, using real HTTP/database workflows rather than static string inspection:

1. grant permission; checkout one tax-inclusive `20.00` product with a fixed `0.15` modifier and percentage service charge, then prove the cart response, persisted order/items, receipt model, refund basis, audit, report aggregation, and JoFotara snapshot all share the same derived net money and zero tax; immediately start a second order and prove normal taxation returns;
2. exempt open table -> save -> reload from another POS session -> split -> settle, proving frozen raw prices survive while every charged price is derived once; then attempt an exempt/taxable table merge and prove the `409` rollback leaves both orders untouched;
3. reprint and refund the exempt sale after changing current global pricing settings, proving both use persisted exemption and the refund credit note retains category `E`;
4. exercise one unauthorized false-to-true transition and one malformed/forged request, proving both fail without order, item, audit, or idempotency residue.

Run:

```powershell
npx vitest run backend/tests/integration/taxExemptWorkflow.test.js
```

Expected: pass.

**Step 2: Run the complete relevant regression set**

```powershell
npx vitest run backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/serviceChargeParity.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionPersistence.test.js backend/tests/unit/checkoutFlow.test.js backend/tests/unit/tableRelationshipModuleWiring.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/permissions.test.js backend/tests/integration/checkout.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/productSalesMetrics.test.js backend/tests/integration/shift.test.js backend/tests/integration/taxExemptWorkflow.test.js pos-spooler-printer/tests/receipt-display.test.js
npm run build
```

Expected: all selected tests and the production build pass.

**Step 3: Record physical print deployment**

Add one checklist entry to `docs/SPOOLER-CHANGES.md` requiring:

- tracked spooler updated/restarted;
- an 80/88mm exempt customer receipt prints `(معفي من الضريبة)`;
- a 58mm exempt receipt does not wrap or clip the label;
- modifier price, subtotal, total, and QR still match the screen/backend;
- kitchen ticket output is unchanged.

The application remains backward-compatible before spooler rollout: an older receipt-v1 spooler receives a known tax mode and prints zero tax instead of dead-lettering the job, but it will not show the new Arabic label until updated.

**Step 4: Commit**

```powershell
git add backend/tests/integration/taxExemptWorkflow.test.js docs/SPOOLER-CHANGES.md
git commit -m "test(tax): cover exempt order lifecycle"
```

---

## Explicitly deferred follow-ups

These are useful Toast/MICROS ideas but are not prerequisites for the requested safe restoration:

- exemption certificate/reference number and customer/organization identity;
- dedicated tax-exempt sales report/export;
- manager-PIN override for otherwise ungranted users;
- per-item or per-tax-rate exemption;
- tax-exempt tender/coupon behavior;
- retroactive same-day closed-check adjustment.

The schema column, retained original tax rates, and audit event intentionally make the first two easy to add later without changing calculation ownership.

## Adversarial review prompt used

> Act as a hostile POS financial-systems reviewer and treat this plan as untrusted. Trace one value from frozen catalog/custom price through modifiers, service charge, discounts, frontend preview, hold JSON, open-table persistence, restore, split, merge/transfer, checkout, `orders`, `order_items`, receipt/spooler, refund/void, X/Z and sales reports, audit, JoFotara invoice, and JoFotara credit note. At every boundary prove: one authoritative exemption boolean, no client privilege escalation, no global-setting mutation, no stale-state leak, no reconstruction from current catalog data, no gross-to-net conversion twice, no mixed taxable/exempt merge, no rounding drift beyond the existing six-decimal/cent contracts, and no path that recreates removed tax. Reject every new file, field, option, or test that lacks a named invariant. Prefer an existing owner over a new abstraction, but do not hide necessary fiscal state to save a column. Read production callers as well as tests. Amend only the plan; do not implement.

## Completion checklist

- [ ] No global setting or product tax rate is mutated.
- [ ] Normal non-exempt golden totals are unchanged.
- [ ] Backend, not Vue, owns authorization and final totals.
- [ ] A normal tax-inclusive `20.00` sale becomes the same pre-tax amount in cart, DB, receipt, refund, reports, audit, and JoFotara.
- [ ] `price_at_sale` stores the charged pre-tax value and `price_before_tax_exemption` stores the exact reversible frozen source value.
- [ ] `0.15` modifier remains exactly `0.15` in every tax mode.
- [ ] Service-charge line remains, its inclusive tax component is removed from its charged price, and its tax is zero.
- [ ] Every reset/restore boundary has a named test.
- [ ] Exemption changes checkout fingerprint/idempotency identity.
- [ ] Paid order, reprint, refund, split, and JoFotara read persisted state.
- [ ] Existing receipt templates degrade safely and updated spooler prints the Arabic label.
- [ ] No new controller/repository/factory/module was created for one boolean.
- [ ] No dedicated report/reference workflow or unrelated tax refactor entered scope.

## Strict execution prompt

> Execute `docs/superpowers/plans/2026-07-31-tax-exempt-checks.md` exactly, inline and without subagents. Use Ponytail to reject every abstraction not demanded by the plan. Use test-first TDD for every task: make the named tests fail for the intended reason, implement the smallest production change, rerun the focused tests, inspect the diff, and commit only that task's files. Do not alter global tax settings, normal non-exempt formulas, price-list behavior, modifier definitions, closed paid-order rules, unrelated reports, browser-print architecture, or receipt-template builder UX. Treat the server as the authority: an exempt invoice must use the same lower pre-tax money in cart, checkout, `orders`, `order_items.price_at_sale`, receipts, refunds, reports, audit, and JoFotara. Preserve the original source price in `price_before_tax_exemption`, preserve original tax rates, keep modifier gross surcharge exact, and prove every stale-state boundary. Stop and report if JoFotara category E is rejected by ISTD; never relabel an exempt line as zero-rated merely to make submission pass. Do not merge or push unless separately instructed.
