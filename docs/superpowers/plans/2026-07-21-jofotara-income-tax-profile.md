# JoFotara Income-Tax Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` or `subagent-driven-development` to implement this plan task-by-task. Keep each checkbox independently verifiable.

**Goal:** Support JoFotara income-tax invoices for restaurants that are not registered for general sales tax, while preserving the existing sales-tax integration and allowing an installation-wide, safely switchable tax-registration profile with independent credentials.

**Architecture:** Add one core `tax_registration_type` setting with `sales_tax` and `income_tax` values. It is the source of truth for new POS calculations and JoFotara document creation, while each saved order, held order, and JoFotara ledger row freezes the profile that created it. Profile-specific adapters share order loading, discount allocation, idempotency, transport, QR, and admin actions; only tax calculation, credentials, and UBL rendering differ.

**Tech Stack:** Node.js/CommonJS, Express 5, mysql2/InnoDB, Vue 3, native `fetch`, Vitest/Supertest.

## Official Rules Used

Source: `C:\Users\bash\Downloads\e-Invoicing DocumentatiUpdated2-1.pdf`.

- Page 9 separates income-tax invoices for taxpayers not registered in sales tax from general and special sales-tax invoices.
- A new income-tax invoice uses code `388` and immediate-payment type name `011` (pages 11–12).
- An income-tax return uses code `381` and immediate-payment type name `011` (pages 22–23).
- Income-tax documents contain no document-level or line-level `<cac:TaxTotal>` (pages 17–20 and 27–30).
- `TaxExclusiveAmount` is the sum of unit price multiplied by quantity before discounts. `TaxInclusiveAmount` and `PayableAmount` equal that amount minus line allowances; no sales tax is added.
- JoFotara does not accept a generic order-discount line. Line discounts and the prorated order discount must be represented as line allowances.
- A return references the accepted original invoice number, UUID, and payable amount, carries a reason, and cannot exceed the originally sold quantities.
- Buyer name is mandatory for receivable invoices and for immediate-payment invoices above JOD 10,000 (pages 14–15). This POS does not currently implement receivable JoFotara documents, so cash/card/split remain immediate-payment documents.
- The API endpoint and transport shape stay unchanged. Only the selected profile's credentials may be used.

## Non-Negotiable Invariants

- The selector is global per installation, not per cashier, order type, or invoice.
- `sales_tax` preserves the currently implemented `012`/`381` XML and POS calculations.
- `income_tax` uses entered public selling prices as no-sales-tax amounts: effective item, modifier, and service-charge sales-tax amounts are zero. Do not mutate catalog tax-rate or service-charge configuration rows when switching profiles.
- Existing orders and existing JoFotara documents are backfilled as `sales_tax`.
- A profile change affects only new unsaved work. Saved tables, held orders, paid orders, retries, and returns retain their frozen profile.
- A return always inherits the accepted original document's profile, even if the global setting has changed.
- A rejected retry reuses the original XML/UUID/ICV and the credential set belonging to the frozen profile.
- An accepted document is never resubmitted under another profile.
- The existing JoFotara enable toggle remains global. Each profile has its own client ID, secret key, income-source sequence, seller tax number, and registered seller name.
- Empty credentials stay empty. Never seed sample identity or secret values, expose secrets in GET responses, or write them to logs/audit events.
- Cash, card, and split map to immediate-payment types only: `012` for sales tax and `011` for income tax. Do not implement `021`/`022` receivable behavior without a real credit-sales workflow.
- Service charge remains an ordinary legal invoice line. In income-tax mode its full customer-facing amount is a zero-tax line.
- Priced modifiers remain folded into their parent product line. In income-tax mode their full surcharge is included without extracting sales tax.
- XML preview must use the exact production builder for the order's frozen profile, make no HTTP call, and create no ledger row.

## File Map

| File | Responsibility |
|---|---|
| `backend/migrations/2026-07-21-jofotara-income-tax-profile.sql` | Profile setting, profile credentials, frozen columns, backfill |
| `backend/tests/fixtures/seed.js` | Test-schema and setting parity |
| `scripts/validate-schema-drift.js` | Required columns/settings validation |
| `backend/config/taxRegistration.js` | Validate profile names and resolve profile-scoped settings |
| `backend/routes/system.js` | Expose the active profile to POS clients |
| `backend/routes/pos/helpers.js` | Load authoritative profile with checkout settings |
| `backend/routes/pos/checkout.js` | Freeze profile on paid/register orders and honor held/table snapshots |
| `backend/routes/pos/tables.js` | Freeze profile on table creation and reuse it on later saves/splits |
| `backend/routes/pos/orders.js` | Freeze profile in held-order payloads |
| `backend/routes/pos/refunds.js` | Reuse the original order profile |
| `backend/services/PosCalculator.js` | Apply zero effective sales tax in income-tax mode |
| `backend/services/ServiceChargeCalculator.js` | Apply zero effective service-charge tax in income-tax mode |
| `backend/services/TableSettlementContext.js` | Carry the table's frozen profile through settlement |
| `assets/js/composables/useTerminal.js` | Load the active profile |
| `assets/js/composables/stores/orderSessionStore.js` | Calculate/display income-tax carts without sales tax and preserve table profile |
| `backend/services/JofotaraXmlBuilder.js` | Shared snapshot allocation plus profile-specific UBL rendering |
| `backend/services/JofotaraService.js` | Freeze profile, select credentials, retry, return, and preview rules |
| `backend/routes/admin/jofotara.js` | Profile-aware settings API |
| `src/admin/pages/Settings.vue` | Global selector and separate profile credential forms |
| `src/admin/pages/Orders.vue` | Display the frozen profile in JoFotara state without changing workflow |
| `assets/js/admin/i18n.js` | Natural Arabic settings/status copy |
| `backend/tests/unit/jofotaraXmlBuilder.test.js` | Exact sales/income UBL and amount tests |
| `backend/tests/unit/PosCalculator.test.js` | Income-tax item/modifier/discount calculations |
| `backend/tests/unit/serviceChargeCalculator.test.js` | Income-tax service-charge calculation |
| `backend/tests/integration/jofotara.test.js` | Switching, credentials, retries, returns, preview |
| `backend/tests/integration/checkout.test.js` | Register checkout profile freezing |
| `backend/tests/integration/tables.test.js` | Saved/printed table stability across a profile switch |
| `backend/tests/integration/heldOrders.test.js` | Held-order profile stability |
| `backend/tests/integration/refunds.test.js` | Original-profile refund calculations |

---

### Task 1: Add the global profile and migrate credentials safely

**Interfaces:**

```js
const TAX_REGISTRATION_TYPES = Object.freeze({
  SALES_TAX: 'sales_tax',
  INCOME_TAX: 'income_tax'
});

function normalizeTaxRegistrationType(value) // throws on invalid values
function profileSettingKeys(profile) // returns the five scoped JoFotara keys
function jofotaraConfigFromSettings(settings, profile)
```

- [ ] Add a failing schema-drift assertion for `orders.tax_registration_type_at_sale`, `jofotara_documents.tax_registration_type`, `tax_registration_type`, and both credential groups.
- [ ] Create `backend/migrations/2026-07-21-jofotara-income-tax-profile.sql` as an idempotent migration.
- [ ] Add `orders.tax_registration_type_at_sale ENUM('sales_tax','income_tax') NULL` next to `tax_inclusive_at_sale`.
- [ ] Add `jofotara_documents.tax_registration_type ENUM('sales_tax','income_tax') NOT NULL DEFAULT 'sales_tax'` next to `document_kind`. Do not add an index; existing source/order indexes already serve lookups.
- [ ] Backfill every existing order and JoFotara document to `sales_tax`, then make `orders.tax_registration_type_at_sale` non-null for new rows while preserving the explicit backfill.
- [ ] Seed `tax_registration_type='sales_tax'` so deploying this migration cannot silently change current installations.
- [ ] Replace the five generic JoFotara credential keys with two explicit groups:

```text
jofotara_sales_tax_client_id
jofotara_sales_tax_secret_key
jofotara_sales_tax_income_source_sequence
jofotara_sales_tax_seller_tax_number
jofotara_sales_tax_seller_registered_name

jofotara_income_tax_client_id
jofotara_income_tax_secret_key
jofotara_income_tax_income_source_sequence
jofotara_income_tax_seller_tax_number
jofotara_income_tax_seller_registered_name
```

- [ ] Copy the current generic values into the `sales_tax` group only when the scoped destination is empty. Seed the `income_tax` group as empty strings. Keep `jofotara_enabled` unchanged.
- [ ] After the copy succeeds, delete the five obsolete generic credential rows so there is only one authority and no duplicated secret. The migration must be safe to rerun.
- [ ] Mirror the columns and settings in `backend/tests/fixtures/seed.js` and add the new migration to the repository's schema-drift expectations.
- [ ] Add `backend/config/taxRegistration.js`; keep it a small pure mapping/validation module, not a class or registry framework.
- [ ] Run `node scripts/validate-schema-drift.js`; expect failure before applying the migration and PASS after applying it to the development database.
- [ ] Commit: `feat(tax): add switchable registration profiles`.

### Task 2: Make income tax an authoritative POS calculation mode

**Interfaces:**

```js
calculateExpectedTotals(data, cartItems, productMap, taxInclusivePricing, {
  taxRateOverrides,
  taxRegistrationType
})

resolveEffectiveTaxRate(storedRate, taxRegistrationType)
// income_tax => 0; sales_tax => validated storedRate
```

- [ ] Write failing unit tests in `backend/tests/unit/PosCalculator.test.js` for an income-tax cart containing a normal item, a priced modifier, line discount, order discount, and mixed stored catalog rates. Expect zero tax and a payable total made from entered prices minus discounts.
- [ ] Add a failing service-charge test proving income-tax mode uses the configured percentage but does not add or extract the configured service-charge sales tax.
- [ ] Extend `loadCheckoutSettings` in `backend/routes/pos/helpers.js` to return validated `taxRegistrationType` with `sales_tax` as the legacy fallback only when the setting row is absent.
- [ ] Pass the profile explicitly into `PosCalculator` and `ServiceChargeCalculator`. Do not scatter direct settings reads or mutate product records.
- [ ] In income-tax mode, freeze `order_items.tax_rate=0`, `order_items.tax_amount=0`, and `modifier_tax_amount=0` for newly saved lines. Preserve the full priced-modifier surcharge in `price_at_sale`/`modifier_surcharge`.
- [ ] In income-tax mode, freeze service-charge lines at zero tax while preserving the full charge amount.
- [ ] Keep all existing sales-tax inclusive/exclusive behavior byte-for-byte equivalent under `sales_tax`.
- [ ] Expose `tax_registration_type` from `backend/routes/system.js`; load it in `assets/js/composables/useTerminal.js`.
- [ ] Update `assets/js/composables/stores/orderSessionStore.js` so the cart displays the same zero-sales-tax totals the backend will validate. Do not hide product prices or alter the product catalog.
- [ ] Disable the tax-inclusive-pricing control in the settings UI while `income_tax` is selected, with a short explanation that entered prices are used without sales tax. Preserve its saved value so switching back to `sales_tax` restores the previous behavior.
- [ ] Run:

```powershell
npx vitest run backend/tests/unit/PosCalculator.test.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/unit/orderSessionStore.test.js
```

Expected: PASS, including all pre-existing sales-tax cases.

- [ ] Commit: `feat(pos): calculate income-tax orders without sales tax`.

### Task 3: Freeze the profile across register, tables, held orders, and refunds

**Interfaces:**

- New register order: snapshot the authoritative current profile.
- Existing table order: use `orders.tax_registration_type_at_sale`, never the current setting.
- Held order: store `tax_registration_type_at_hold` inside server-written `cart_data`.
- Split check: inherit the parent table/held profile.
- Refund: inherit the original order profile.

- [ ] Add a register integration test: create an income-tax checkout, change the setting to sales tax, and assert the saved order/items/totals remain income-tax snapshots.
- [ ] Add table tests: save an income-tax table, switch globally to sales tax, reopen/add/save/guest-checkout, and assert there is no stale-total error and the table remains income-tax.
- [ ] Add the reverse table test for a sales-tax table surviving a switch to income tax.
- [ ] Add held-order tests proving hold/claim/checkout preserves `tax_registration_type_at_hold`, including split checks created from a table.
- [ ] Add a refund test proving the refund calculation uses the original order profile after the global setting changes.
- [ ] Update `backend/routes/pos/checkout.js` INSERT/UPDATE/lock queries to write or reuse `tax_registration_type_at_sale` alongside `tax_inclusive_at_sale`.
- [ ] Update `backend/routes/pos/tables.js` and `backend/services/TableSettlementContext.js` to carry the frozen profile through every save, reopen, split, merge, and settlement path.
- [ ] Update `backend/routes/pos/orders.js` to write `tax_registration_type_at_hold` into held-order JSON and trust only the server-written value on claim/checkout.
- [ ] Update `backend/routes/pos/refunds.js` to use the original order snapshot; never consult the current global profile for saved sales.
- [ ] Keep legacy NULL fallback limited to pre-migration rows and immediately persist the resolved `sales_tax` value when such a row is touched.
- [ ] Run:

```powershell
npx vitest run backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/refunds.test.js
```

Expected: PASS with both direction-of-switch scenarios covered.

- [ ] Commit: `feat(pos): freeze tax profile across order lifecycles`.

### Task 4: Split the legal snapshot into sales-tax and income-tax profiles

**Interfaces:**

```js
buildInvoiceSnapshot({ profile, order, items, customer, seller })
buildCreditNoteSnapshot({ profile, refund, refundItems, originalSnapshot, originalDocument })
renderInvoiceXml(snapshot, identity)
renderCreditNoteXml(snapshot, identity)
```

- [ ] Keep the existing sales-tax builder fixtures as regression tests before refactoring exports.
- [ ] Add income-tax snapshot tests containing normal products, zero-price modifiers, priced modifiers, line discounts, prorated order discount, service charge, Arabic text, and rounding residue.
- [ ] Extract only genuinely shared logic: parent financial-line selection, order-discount allocation, XML escaping, seller/buyer blocks, identities, and reconciliation assertions.
- [ ] For `income_tax`, build each legal line from the full saved customer-facing `price_at_sale × quantity`. Do not subtract `modifier_tax_amount`, derive VAT, or use the product's catalog tax rate.
- [ ] Allocate line and order discounts into line allowances. Require:

```text
line extension = line gross - line allowance
document TaxExclusiveAmount = sum(line gross)
document AllowanceTotalAmount = sum(line allowance)
document TaxInclusiveAmount = sum(line extension)
document PayableAmount = sum(line extension)
```

- [ ] Reconcile income-tax payable against the saved `orders.total` within the existing monetary tolerance. A mismatch is a blocking `JOFOTARA_TOTAL_MISMATCH`; never adjust a large difference to force acceptance.
- [ ] Treat service charge as an ordinary zero-tax line and priced modifiers as part of their parent line.
- [ ] Store `taxRegistrationType` inside `legal_snapshot_json` as a second immutable assertion in addition to the ledger column.
- [ ] Replace fake buyer identity values such as `TN='-'`. For immediate-payment invoices at or below JOD 10,000, emit only buyer fields that actually exist. Above JOD 10,000, require an attached customer with a non-empty name before preview/submission. Do not invent receivable support or synthetic national/tax numbers.
- [ ] Build returns from saved `refund_items`, preserve the original buyer/seller/profile snapshot, and validate returned quantities against the original document's remaining quantities.
- [ ] Run `npx vitest run backend/tests/unit/jofotaraXmlBuilder.test.js`; expect all old and new profile cases to PASS.
- [ ] Commit: `feat(jofotara): build profile-aware legal snapshots`.

### Task 5: Render the official income-tax invoice and return XML

**Interfaces:**

- Income invoice: `<cbc:InvoiceTypeCode name="011">388</cbc:InvoiceTypeCode>`.
- Income return: `<cbc:InvoiceTypeCode name="011">381</cbc:InvoiceTypeCode>`.
- Neither income document may contain `<cac:TaxTotal>`.

- [ ] Add exact XML tests for element order, namespaces, `011`, `388`, `381`, JOD/JO currency attributes, ICV, UUID, seller identity, buyer rules, allowances, totals, return reason, and `BillingReference`.
- [ ] Keep the existing sales-tax renderer and its `012` tax blocks unchanged.
- [ ] Add a dedicated income renderer branch inside `backend/services/JofotaraXmlBuilder.js`; do not implement this by rendering sales-tax XML and deleting tags with broad regular expressions.
- [ ] Omit every document and line `<cac:TaxTotal>` in income XML.
- [ ] Emit income invoice lines with ID, quantity, extension, item name, price amount, and allowance charge only as documented.
- [ ] Emit the return's original invoice number, accepted UUID, original payable amount, and non-empty reason.
- [ ] Assert the frozen profile is known before rendering. Reject any unrecognized value rather than falling back to sales tax.
- [ ] Run the focused XML test and compare a generated income invoice/return against PDF pages 10–20 and 21–30.
- [ ] Commit: `feat(jofotara): render income-tax invoices and returns`.

### Task 6: Make submission, retry, preview, and return profile-safe

**Interfaces:**

```js
prepareInvoiceDocument(invoiceId, actorUserId)
prepareCreditNote(refundId, actorUserId)
credentialsForProfile(settings, frozenProfile)
```

- [ ] Add integration tests proving an income invoice uses only income credentials and a sales invoice uses only sales credentials. Capture request headers through the existing stubbed `fetchImpl` without logging secrets.
- [ ] Store the order's frozen profile in `jofotara_documents` when the ledger row is first inserted.
- [ ] On a rejected retry, read the ledger's frozen profile, select that profile's current credentials, and reuse the stored XML/UUID/ICV.
- [ ] On a return, require an accepted original, copy its frozen profile, and select credentials for that profile regardless of the current global selector.
- [ ] On XML preview, use the saved order profile. A legacy paid order backfilled as `sales_tax` must preview as `012` even after the installation switches to income tax.
- [ ] Include `tax_registration_type` in `publicState` for clear admin diagnosis, but never include credential fields.
- [ ] Preserve all current idempotency and `pending|submitting|accepted|rejected|unknown` behavior.
- [ ] Keep HTTP submission outside checkout/refund transactions and outside the ledger-preparation transaction.
- [ ] Add audit event metadata containing only document ID, result, HTTP status, and frozen profile.
- [ ] Run `npx vitest run backend/tests/integration/jofotara.test.js`; expect profile-switch, retry, return, preview, and secret-redaction cases to PASS.
- [ ] Commit: `feat(jofotara): submit with frozen profile credentials`.

### Task 7: Add a clear settings selector and independent credential forms

**Interfaces:**

```json
GET /api/admin/jofotara/settings
{
  "enabled": true,
  "tax_registration_type": "income_tax",
  "profiles": {
    "sales_tax": { "client_id": "...", "secret_configured": true, "income_source_sequence": "...", "seller_tax_number": "...", "seller_registered_name": "..." },
    "income_tax": { "client_id": "...", "secret_configured": false, "income_source_sequence": "...", "seller_tax_number": "...", "seller_registered_name": "..." }
  }
}
```

- [ ] Change `backend/routes/admin/jofotara.js` to accept only `sales_tax|income_tax`; reject unknown values with HTTP 400.
- [ ] Return both profile forms but only boolean `secret_configured` flags. Never return either secret.
- [ ] Preserve a blank secret on PUT, clear only the explicitly targeted profile when `clear_secret=true`, and prevent one form from overwriting the other.
- [ ] In `src/admin/pages/Settings.vue`, add one installation-wide selection labeled naturally:
  - English: `Sales-tax registered` / `Income tax only`
  - Arabic: `مسجل في ضريبة المبيعات` / `ضريبة الدخل فقط`
- [ ] Show a direct explanation: changing the selection applies to new sales; saved invoices and tables keep their original profile.
- [ ] Show the active profile's credential form first and keep the inactive profile's saved data available without mixing readiness state.
- [ ] Require a confirmation when changing the global profile because it changes new POS calculations. Do not add multi-step setup or per-terminal selectors.
- [ ] Keep natural Arabic labels, including `تسلسل مصدر الدخل`, `الرقم الضريبي للبائع`, and `اسم البائع المسجل`. Avoid translating legal codes or credentials.
- [ ] In `src/admin/pages/Orders.vue`, show a compact read-only `Sales tax` / `Income tax` label in the JoFotara state modal so support can identify the frozen profile. Do not add another row action.
- [ ] Run `npm run build:admin`; expect a successful Vue/Vite build with no render warnings.
- [ ] Commit: `feat(admin): configure JoFotara tax profiles`.

### Task 8: Prove end-to-end safety and prepare deployment

- [ ] Run the focused suites first:

```powershell
npx vitest run backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/unit/PosCalculator.test.js backend/tests/unit/serviceChargeCalculator.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/checkout.test.js backend/tests/integration/tables.test.js backend/tests/integration/heldOrders.test.js backend/tests/integration/refunds.test.js
```

Expected: PASS.

- [ ] Run `node scripts/validate-schema-drift.js`; expect PASS against the migrated development database.
- [ ] Run `npm run build:admin`; expect PASS with no Vue compiler errors.
- [ ] Manually verify four exact flows on the feature branch:
  1. Existing sales-tax installation still checks out and previews `012` XML with tax totals.
  2. Income-tax installation checks out the same priced cart with zero sales tax and previews `011` XML with no `TaxTotal`.
  3. A saved sales-tax table can be reopened and settled after switching globally to income tax without recalculation drift.
  4. An accepted income invoice can be returned after switching globally to sales tax; the return remains `011` and uses income-profile credentials.
- [ ] Inspect generated XML for a cart containing a priced modifier, line discount, order discount, service charge, Arabic name, and zero-rated item. Confirm every total reconciles to the saved order.
- [ ] Verify an XML preview leaves `jofotara_documents` unchanged and no request reaches the JoFotara client.
- [ ] Verify logs and audit rows contain neither profile's secret key.
- [ ] Prepare a phpMyAdmin-safe migration copy and matching verification query only after the development migration succeeds. The verify query must report the selector, both credential groups, frozen columns, and backfill counts without reading secret values.
- [ ] Commit: `test(jofotara): prove income-tax profile switching`.

## Definition of Done

- The installation has exactly one valid active tax-registration profile.
- New income-tax sales calculate no sales tax anywhere in register, tables, held orders, refunds, receipts, or reports.
- Existing sales-tax behavior remains unchanged.
- Saved work cannot change tax profile when the global selector changes.
- Income invoices and returns use `011`, omit all `TaxTotal` elements, and reconcile exactly to saved totals.
- Sales invoices and returns continue using `012` with their existing tax details.
- Each profile's credentials are isolated, preserved, and never exposed.
- Preview, retry, accepted-document idempotency, QR display, and manual submission remain operational.
- No special-tax `013/023`, receivable `021/022`, vouchers, or automatic checkout submission is introduced by this work.
