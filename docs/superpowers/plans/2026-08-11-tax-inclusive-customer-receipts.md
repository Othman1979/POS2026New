# Tax-Inclusive Customer Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the existing `tax_inclusive_pricing` setting from a sale-calculation mode into a customer-receipt presentation preference: every new sale continues calculating and storing tax normally, while enabled customer receipts show gross item prices and hide separate subtotal/tax rows.

**Architecture:** Preserve `orders.tax_inclusive_at_sale` as the historical accounting-mode authority because refunds, table settlement, and JoFotara already depend on its old meaning. Add one nullable `orders.receipt_tax_inclusive_at_sale` snapshot for stable reprints. New orders always use exclusive accounting (`tax_inclusive_at_sale = 0`), while the new snapshot controls only `receipt_display_v1`; legacy orders and already-open tables/holds retain their frozen old behavior.

**Tech Stack:** Vue 3, Node.js/Express, MariaDB 10.4, Vitest, Playwright, Inno Setup packaging contracts.

## Global Constraints

- Do not change `products.price`, `products.tax_rate`, JoFotara tax categories, or historical order money.
- Product forms continue accepting gross prices and storing net prices through `grossToNet()`.
- `tax_inclusive_pricing=1` must never cause a new taxable order or order item to store zero tax.
- New sales must satisfy the existing accounting invariant: `subtotal - discount + tax + rounding = total`.
- The presentation-only receipt model may show gross rows with `taxMode='inclusive'`, `summary.taxAmount=0`, and hidden subtotal/tax, but persisted accounting tax remains non-zero.
- Existing orders with `receipt_tax_inclusive_at_sale IS NULL` keep their historical presentation derived from `tax_inclusive_at_sale`; do not backfill or reinterpret them.
- Existing open tables, split checks, platform holds, and register holds created under the old accounting mode retain their frozen accounting behavior until consumed. New ones use exclusive accounting and carry a separate receipt-display snapshot.
- Customer-receipt scope includes checkout receipt preview, browser print, spooler print, guest check, table/split guest check, Orders reprint, A4 receipt, and delivery invoice. It does not change JoFotara XML/PDF, reports, kitchen tickets, admin accounting columns, or tax-exemption authority.
- Keep the existing setting key for deployment compatibility; only its meaning and human copy change.
- No new table, dependency, controller, worker, or receipt model version.
- Use mandatory RED-GREEN TDD. Run only focused suites during tasks and one broader verification at the final gate.
- Do not merge, push, rebuild installers, or apply the migration to a production database while executing this plan.

## Evidence and Root Cause

- `backend/routes/admin/products.js` converts every entered gross product price to net at create/update (`grossToNet`); therefore the database never contains gross base prices for this setting to consume.
- `backend/services/PosCalculator.js` and `src/utils/posTotals.js` currently return `tax: 0` whenever `taxInclusivePricing` is true.
- Checkout, table save, split creation/settlement, held orders, refunds, and service-charge calculations consume that same flag. Tests currently assert this old behavior, including `orders.tax=0` and `order_items.tax_amount=0`.
- The receipt layer already hides subtotal/tax whenever `receipt_display_v1.taxMode === 'inclusive'`; the renderer is not the root cause.
- Product cards already show `price * (1 + tax_rate/100)`, and cart rows already use gross totals. The broken setting undercharges the sale before rendering.
- `orders.tax_inclusive_at_sale` is read by `JofotaraXmlBuilder`, `RefundService`, table mutation/settlement, split settlement, and historical receipt reconstruction. Reusing that column for the new display meaning would corrupt history and future refunds.
- Current automatic migration tip is `2026-08-10-call-center-held-orders-v1`, checksum `f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b`, normalized SQL SHA-256 `f1b384472c35fc84e30d7c970582cef03964a51773e7ea61c658bd77829121bc`.

## Chosen Design and Rejected Alternatives

1. **Chosen: one receipt snapshot column plus existing held JSON.** This preserves historical accounting semantics and makes reprints stable after settings changes.
2. **Rejected: repurpose `tax_inclusive_at_sale`.** It has an established financial meaning in refunds, JoFotara, tables, and historical data.
3. **Rejected: read the current setting during every reprint.** Old receipts would change when an administrator toggles the setting.
4. **Rejected: store gross prices in `products.price`.** That would reverse the catalog authority, require destructive money migration, and risk double taxation.

---

### Task 1: Add the Frozen Receipt-Display Snapshot

**Files:**
- Create: `backend/migrations/2026-08-11-receipt-tax-display-v1.sql`
- Create: `backend/migrations/2026-08-11-receipt-tax-display-v1.auto.sql`
- Modify: `backend/migrations/auto-manifest.json`
- Modify: `deployment/database/hostinger-manual-migrations.sql`
- Modify: `deployment/database/baseline.sql`
- Modify: `deployment/database/manifest.json`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/unit/automaticMigrations.test.js`
- Modify: `backend/tests/unit/callCenterMigrationEvidence.test.js`
- Modify: `backend/tests/unit/schemaAuthority.test.js`
- Modify: `backend/tests/integration/automaticMigrations.test.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Create: `backend/tests/unit/receiptTaxDisplayMigration.test.js`

**Interfaces:**
- Produces `orders.receipt_tax_inclusive_at_sale TINYINT(1) NULL`.
- `NULL` means “pre-migration row; use historical receipt-mode fallback.”
- `0` means customer copies show separate subtotal/tax.
- `1` means customer copies show gross item prices and hide subtotal/tax.
- Migration name: `2026-08-11-receipt-tax-display-v1`.
- Migration checksum: `90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3`.
- Auto SQL normalized SHA-256 for the exact SQL below, including its final LF: `8871974f40069bca8cdb92f6bc5a986578c365fec505d9cc67efa4528836d794`.

- [ ] **Step 1: Write failing migration/package tests**

Pin the exact predecessor, target name/checksum/hash, nullable column, no money updates, ledger-last rule, normal/auto equality, fallback parity, baseline/fixture parity, baseline-manifest SHA, installer payload inclusion, and schema authority count. Update the call-center evidence test to find its named manifest entry and assert that the new entry immediately follows it instead of permanently assuming call-center is the manifest tip. The scratch integration must:

1. seed the exact call-center predecessor ledger;
2. insert one historical order with `tax_inclusive_at_sale=1`, non-zero product rates, and saved money;
3. run the target migration;
4. assert every existing money/tax field is byte-identical and the new field is `NULL`;
5. rerun with no error/no duplicate effect.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run backend/tests/unit/receiptTaxDisplayMigration.test.js backend/tests/unit/automaticMigrations.test.js backend/tests/unit/callCenterMigrationEvidence.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js --reporter=dot
```

Expected: failures only for the missing migration, manifest entry, schema column, ledger, and fallback block.

- [ ] **Step 3: Add the exact normal and auto migration body**

```sql
-- 2026-08-11-receipt-tax-display-v1
-- Requires migration: 2026-08-10-call-center-held-orders-v1
-- Requires checksum: f9eabb919f1084a04f96261639514883df63fcaa0c983b8864d92ced3c68a52b
-- Requires normalized SQL SHA-256: f1b384472c35fc84e30d7c970582cef03964a51773e7ea61c658bd77829121bc
-- Freeze customer-receipt tax-inclusive presentation without changing sale tax accounting.
-- Existing rows remain NULL and continue using their historical receipt mode.

SET NAMES utf8mb4;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS receipt_tax_inclusive_at_sale TINYINT(1) NULL AFTER tax_inclusive_at_sale;

INSERT INTO schema_migrations (migration_name, checksum)
VALUES (
  '2026-08-11-receipt-tax-display-v1',
  '90e01d189af7669ed48de24352252b5ba3fc6323ba347d2eb40bfd52e36d5ee3'
)
ON DUPLICATE KEY UPDATE migration_name = VALUES(migration_name);
```

The two SQL files must be byte-identical after CRLF→LF normalization. Copy the auto body verbatim between matching cumulative fallback markers. Add the manifest entry immediately after the current tip with `repeatable: false` omitted, matching existing one-shot entries.

- [ ] **Step 4: Update schema authorities**

Add the nullable column after `tax_inclusive_at_sale` in baseline and fixture. Recompute and update the baseline SHA-256 in `deployment/database/manifest.json`. Add one exact `information_schema.COLUMNS` validator requirement checking table, name, `tinyint`, and nullable status. Add the new ledger row to fixture/bootstrap after the call-center row. Do not add an index or backfill.

- [ ] **Step 5: Run GREEN and parity checks**

```powershell
npx vitest run backend/tests/unit/receiptTaxDisplayMigration.test.js backend/tests/unit/automaticMigrations.test.js backend/tests/unit/callCenterMigrationEvidence.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js --reporter=dot
git diff --check
```

Expected: all focused tests pass; normal/auto/fallback hashes and order match; no existing row changes.

- [ ] **Step 6: Commit Task 1**

```powershell
git add backend/migrations deployment/database backend/tests/fixtures/seed.js deployment/tools/bootstrap-database.js backend/services/schemaValidation.js backend/tests/unit/receiptTaxDisplayMigration.test.js backend/tests/unit/automaticMigrations.test.js backend/tests/unit/callCenterMigrationEvidence.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/integration/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js
git commit -m "feat(db): freeze customer receipt tax display"
```

---

### Task 2: Decouple New-Sale Tax Accounting from Receipt Presentation

**Files:**
- Modify: `backend/services/OrderPricing.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/modules/tables/saveTableOrder.js`
- Modify: `backend/modules/tables/splitChecks.js`
- Modify: `backend/modules/tables/tableRelationships.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `backend/services/TableSettlementContext.js`
- Modify: `src/pos/useTerminal.js`
- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/stores/orderSession/tableOrderWorkflow.js`
- Modify: `src/pos/stores/orderSession/checkoutFlow.js`
- Modify: `src/components/pos/SplitCheckModal.vue`
- Test: `backend/tests/unit/PosCalculator.test.js`
- Test: `backend/tests/unit/posTotals.test.js`
- Test: `backend/tests/unit/posTotalsParity.test.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`
- Test: `backend/tests/integration/checkout.test.js`
- Test: `backend/tests/integration/tables.test.js`
- Test: `backend/tests/integration/heldOrders.test.js`
- Test: `backend/tests/integration/platformHeldSettlement.test.js`
- Test: `backend/tests/unit/splitChecks.test.js`

**Interfaces:**
- `loadCheckoutSettings(conn)` replaces `taxInclusivePricing` with `receiptTaxInclusiveDisplay` while retaining the same database key.
- New financial calculation calls pass `false` for `taxInclusivePricing` unless consuming a pre-existing server-frozen legacy order/hold whose accounting flag is `1`.
- New orders write `tax_inclusive_at_sale=0` and `receipt_tax_inclusive_at_sale=receiptTaxInclusiveDisplay ? 1 : 0`.
- New ordinary holds write `tax_inclusive_at_hold=0` and `receipt_tax_inclusive_at_hold=receiptTaxInclusiveDisplay ? 1 : 0` in `cart_data`.
- New split/platform payloads inherit both accounting and receipt-display snapshots independently.
- Legacy held JSON without `receipt_tax_inclusive_at_hold` uses its old `tax_inclusive_at_hold` value for both accounting and display until consumed.
- Existing order rows with a non-null receipt snapshot never change it on save/settlement.

- [ ] **Step 1: Replace tests that codify the broken new-sale contract**

Write RED cases proving that with `tax_inclusive_pricing=1`, a new `10.00 @ 16%` net item still produces:

```javascript
{
  subtotal: 10.00,
  tax: 1.60,
  total: 11.60,
  tax_inclusive_at_sale: 0,
  receipt_tax_inclusive_at_sale: 1,
  line_tax_amount: 1.60
}
```

Cover direct checkout, new table save, table settlement, new hold, held checkout, split child, platform settlement, line/item discount, order discount, service charge, mixed `16%/8%/0%`, income-tax registration, and tax exemption. Assert product rows are never updated.

Keep separate regression cases showing that an already-open table or legacy hold with old accounting flag `1` remains at its existing total and zero stored tax after deployment.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/splitChecks.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/platformHeldSettlement.test.js --reporter=dot
```

Expected: only the new presentation/accounting separation cases fail; existing legacy frozen-order cases remain green.

- [ ] **Step 3: Rename the loaded setting at the authority boundary**

Change `loadCheckoutSettings` to expose:

```javascript
receiptTaxInclusiveDisplay: s.tax_inclusive_pricing === '1'
```

Do not expose the setting as `taxInclusivePricing`. This makes accidental use in money calculations visible at review time.

- [ ] **Step 4: Separate accounting mode and receipt mode in every durable path**

Use two explicit local names:

```javascript
let accountingTaxInclusive = false;
let receiptTaxInclusiveDisplay = checkoutSettings.receiptTaxInclusiveDisplay;
```

For an existing server-frozen order/held payload:

```javascript
accountingTaxInclusive = Number(stored.tax_inclusive_at_sale ?? stored.tax_inclusive_at_hold) === 1;
receiptTaxInclusiveDisplay = stored.receipt_tax_inclusive_at_sale != null
  ? Number(stored.receipt_tax_inclusive_at_sale) === 1
  : stored.receipt_tax_inclusive_at_hold != null
    ? Number(stored.receipt_tax_inclusive_at_hold) === 1
    : accountingTaxInclusive;
```

Never accept either flag from an ordinary checkout request. Only database rows, locked held JSON, or the current server setting may author them.

Pass `accountingTaxInclusive` to `calculateExpectedTotals`, `stampLineTax`, exemption conversion, split allocation, and refund-compatible persisted context. Persist `receiptTaxInclusiveDisplay` separately.

- [ ] **Step 5: Make frontend live money always use normal tax for new carts**

Rename the terminal ref to `receiptTaxInclusiveDisplay`. Remove it from `posTotals`, `lineNet`, `lineTax`, service-charge, cart-total, and split-price calculations for new carts. Preserve `activeOrderTaxInclusive` only for a restored pre-existing table/split with frozen legacy accounting mode.

The POS product grid and cart row continue showing gross values. The cashier totals panel continues showing the real subtotal, tax, and total; this setting changes customer documents only.

- [ ] **Step 6: Verify GREEN and inspect the complete task diff**

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/splitChecks.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/platformHeldSettlement.test.js --reporter=dot
git diff --check
```

Reject the task if any new-sale calculation branch still passes the current setting into `calculateExpectedTotals`, `stampLineTax`, `lineTax`, or `posTotals`.

- [ ] **Step 7: Commit Task 2**

```powershell
git add backend/services/OrderPricing.js backend/modules/checkout/executeCheckout.js backend/modules/tables backend/routes/pos/orders.js backend/routes/pos/tables.js backend/services/TableSettlementContext.js src/pos src/components/pos/SplitCheckModal.vue backend/tests/unit/PosCalculator.test.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/splitChecks.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/platformHeldSettlement.test.js
git commit -m "fix(tax): keep receipt preference out of sale accounting"
```

---

### Task 3: Build Gross-Only Customer Receipt Presentations

**Files:**
- Modify: `backend/services/ReceiptPresentationSources.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/routes/print.js`
- Modify: `backend/routes/admin/orders.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `backend/routes/pos/tables.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `src/shared/i18n/ar.json`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Test: `backend/tests/unit/receiptPresentation.test.js`
- Test: `backend/tests/unit/receiptPresentationParity.test.js`
- Test: `backend/tests/unit/receiptPresentationContract.test.js`
- Test: `backend/tests/unit/spoolerReceiptDisplay.test.js`
- Test: `backend/tests/unit/printTemplateEngine.test.js`
- Test: `backend/tests/integration/print.authz.test.js`
- Test: `backend/tests/integration/adminRouting.test.js`
- Test: `backend/tests/integration/heldOrders.test.js`
- Test: `backend/tests/integration/tables.test.js`

**Interfaces:**
- `buildOrderPresentation({ order, items })` remains the public backend builder.
- `receiptDisplayInclusive(order)` resolves in this order: explicit `receipt_tax_inclusive_at_sale`; historical `tax_inclusive_at_sale`; positive-tax legacy inference; otherwise `legacy_unknown`.
- Inclusive customer presentation uses gross line prices, gross line-discount amounts, gross order-discount amount, `summary.taxAmount=0`, and the authoritative stored final total.
- Persisted `orders.subtotal`, `orders.tax`, `orders.total`, `order_items.price_at_sale`, and `order_items.tax_amount` remain unchanged.
- Existing renderers continue using `taxMode='inclusive'` to hide subtotal/tax; no model version bump and no second rendering branch.

- [ ] **Step 1: Write RED presentation vectors**

At minimum cover:

1. `10.00 @ 16%`, no discount → item `11.60`, total `11.60`, no subtotal/tax row.
2. Two `10.00 @ 16%`, 50% order discount → gross rows `23.20`, gross discount `11.60`, total `11.60`.
3. Fixed and percentage line discounts → original gross value, gross discount, and discounted gross line value are truthful.
4. Mixed `16%/8%/0%` plus order discount → gross rows and gross discount foot exactly to stored total.
5. Modifier surcharge remains untaxed according to the existing modifier contract.
6. Service charge appears as a localized financial line with its real configured tax rate.
7. Bundle children stay descriptive and zero-money.
8. Tax-exempt and income-tax orders do not invent gross tax.
9. Old `tax_inclusive_at_sale=1`, `receipt_tax_inclusive_at_sale=NULL` receipts remain byte-equivalent to current output.
10. Toggling the setting after checkout does not change reprint output.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/receiptPresentationContract.test.js backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js --reporter=dot
```

- [ ] **Step 3: Add one presentation-only gross adapter**

Keep accounting calculations untouched. In `ReceiptPresentationSources.js`, convert authoritative saved lines into receipt-only gross rows when display-inclusive is enabled:

```javascript
const calculateReceiptLineGross = (line, taxRate) =>
  calculateLineSubtotal(line, taxRate, false)
  + taxableLineTotal(line, taxRate, false) * (taxRate / 100);

const grossOriginal = calculateReceiptLineGross(originalLine, taxRate);
const grossAfterLineDiscount = calculateReceiptLineGross(discountedLine, taxRate);
const grossLineDiscount = Math.max(0, grossOriginal - grossAfterLineDiscount);
```

Use gross unit price and transform fixed per-unit line discounts to their gross equivalent; percentage labels remain the original percentage. Set presentation subtotal to the sum of gross rows after line discounts. Derive the displayed order-discount money from authoritative final money:

```javascript
const grossOrderDiscount = roundMoney(Math.max(0, grossSubtotal - storedTotal));
```

Pass `taxMode: 'inclusive'`, `summary.tax: 0`, and the stored `total` into the existing v1 builder. Let the existing bounded rounding row reconcile only legitimate cent residue. Do not calculate financial tax in a renderer.

For display-exclusive receipts, retain the current net rows + stored tax behavior exactly.

- [ ] **Step 4: Route every customer copy through the frozen snapshot**

Ensure order/detail/print SELECTs include `receipt_tax_inclusive_at_sale`. Ensure held/split builders read `receipt_tax_inclusive_at_hold` or the inherited order field. Verify these consumers receive the same `receipt_display_v1`:

- checkout success preview;
- provisional guest check;
- held-order preview and print;
- table and split guest check;
- Orders modal/reprint;
- browser receipt app;
- A4 and delivery customer copy;
- backend/spooler print.

Do not modify JoFotara builders, refund amounts, reports, or kitchen payloads.

- [ ] **Step 5: Correct setting copy and Arabic translation**

Use the natural copy:

```text
Tax-inclusive customer receipts
Customer receipts show item prices including tax and hide separate subtotal and tax rows. Tax is still calculated and recorded.
```

```text
إيصالات العميل بأسعار شاملة للضريبة
تظهر أسعار الأصناف شاملة للضريبة في إيصال العميل، مع إخفاء سطري المجموع الفرعي والضريبة. تبقى الضريبة محسوبة ومسجلة.
```

Remove the current claim that receipts show tax as `0.00 JD`; the row is hidden, while accounting tax remains recorded.

- [ ] **Step 6: Update architecture truthfully**

Change the architecture invariant and tax flow so they say:

- product base price remains net;
- all new sales calculate tax normally;
- `tax_inclusive_pricing` controls only the frozen customer-receipt presentation snapshot;
- historical `tax_inclusive_at_sale` remains an accounting compatibility field;
- receipt renderers format a server-authored v1 model and do no tax math.

Regenerate `docs/architecture.html` using the repository command, then run `npm run architecture:check`.

- [ ] **Step 7: Run GREEN and build**

```powershell
npx vitest run backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/receiptPresentationContract.test.js backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/tables.test.js --reporter=dot
npm run architecture:check
npm run build
git diff --check
```

- [ ] **Step 8: Commit Task 3**

```powershell
git add backend/services/ReceiptPresentationSources.js backend/modules/checkout/executeCheckout.js backend/routes/print.js backend/routes/admin/orders.js backend/routes/pos/orders.js backend/routes/pos/tables.js src/admin/pages/Settings.vue src/shared/i18n/ar.json docs/architecture.json docs/architecture.html backend/tests
git commit -m "feat(receipts): show gross prices without hiding tax accounting"
```

---

### Task 4: Adversarial Workflow and Browser Verification

**Files:**
- Modify: `tests/e2e/specs/cashier.checkout.spec.js`
- Modify focused tests only when a verified gap is found

**Interfaces:**
- No new production interface is expected in this task.
- This task may fix only defects directly violating this plan; unrelated findings are reported, not bundled.

- [ ] **Step 1: Run the financial regression matrix**

Verify enabled and disabled modes for:

- direct cash/card/split-tender checkout;
- table first save, edit, guest print, and settlement;
- held save, restore, re-hold, and checkout;
- split check creation/settlement;
- platform-held manual settlement;
- line discount, order discount, service charge, mixed tax rates, price override, bundles, tax exemption, and income-tax profile;
- partial/full refund and JoFotara sales/return XML regression suites.

Required assertions when the receipt setting is enabled for a new taxable sale:

```text
products.tax_rate unchanged
orders.tax > 0
SUM(order_items.tax_amount) == orders.tax within the existing cent contract
orders.tax_inclusive_at_sale == 0
orders.receipt_tax_inclusive_at_sale == 1
receipt rows are gross
receipt subtotal/tax rows are absent
receipt total == charged/stored total
JoFotara and refund math use stored accounting tax, not receipt presentation
```

- [ ] **Step 2: Run one scoped browser workflow**

At a 1024px touch-POS viewport in both light and graphite themes:

1. enable the setting in Admin Settings;
2. sell a known `16%` product with a line or order discount;
3. verify POS product/cart/totals remain correct and checkout charges gross total;
4. open receipt preview and verify gross line money, no subtotal/tax rows, visible final total;
5. print guest check and paid receipt;
6. disable the setting and reprint the old invoice—its presentation must remain inclusive;
7. create a new invoice—the new copy must show separate subtotal/tax.

Inspect response bodies and `receipt_display_v1`, not only visible text.

- [ ] **Step 3: Run final focused/full gates once**

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/posTotals.test.js backend/tests/unit/posTotalsParity.test.js backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/receiptPresentationContract.test.js backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/splitChecks.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js --reporter=dot
npm run build
npm run architecture:check
node scripts/validate-schema-drift.js
git diff --check
git status --short
```

Run the repository's full Vitest suite once only if the focused matrix is green and the executor's instructions require the full gate. Do not repeatedly rerun it for a single-file correction.

- [ ] **Step 4: Commit Task 4 only if it contains scoped changes**

```powershell
git add tests/e2e/specs/cashier.checkout.spec.js
git commit -m "test(receipts): cover tax-inclusive customer copies"
```

If Task 4 finds no defect and changes no files, do not create an empty commit.

## Final Review Checklist

- [ ] Search every `tax_inclusive_pricing`, `taxInclusivePricing`, `tax_inclusive_at_sale`, and `tax_inclusive_at_hold` caller and classify it as accounting compatibility or receipt presentation.
- [ ] No new sale reads the current receipt setting as an instruction to suppress tax.
- [ ] No historical order/hold money was backfilled or rewritten.
- [ ] Current setting changes do not alter old reprints.
- [ ] Existing legacy inclusive open orders remain settleable at their frozen amount.
- [ ] Product cards and cart rows remain gross; cashier totals remain financially explicit.
- [ ] Customer copies consistently show gross rows and total-only summary when enabled.
- [ ] Refunds, reports, JoFotara sales/returns, service-charge tax, and stock behavior remain unchanged except that new orders now correctly carry tax.
- [ ] Migration predecessor/checksum/hash are re-read from the manifest immediately before implementation; stop if the tip changed.
- [ ] Working tree contains only intentional task changes; no installers rebuilt, no production DB migration, no merge, and no push.
