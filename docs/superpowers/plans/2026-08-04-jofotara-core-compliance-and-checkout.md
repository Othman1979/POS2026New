# JoFotara Core Compliance and Checkout Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `executing-plans`, `test-driven-development`, `ponytail`, and `verification-before-completion`. Implement this plan task-by-task with mandatory red-green-refactor TDD. Do not broaden the scope, create a generic integration framework, or use subagents unless the user separately authorizes them. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary POS and table checkouts produce correct JoFotara invoices and returns, accept only verified JoFotara responses, and never make a restaurant customer wait excessively on a slow or failed tax API. Give automatic JoFotara at most ten seconds to enrich the first backend-spooler receipt with its official QR; otherwise print that receipt once without the QR, show a JoFotara warning toast, and leave fiscal follow-up to JoFotara Operations.

**Architecture:** Keep `JofotaraService.js` as the single fiscal workflow owner and deepen its existing idempotent `source_key` state machine. A normal checkout remains a local database transaction. After that transaction commits, the existing checkout route performs one short, local-only preparation step that creates the frozen `pending` JoFotara document when automatic submission is required; this step never contacts JoFotara and any failure is returned as fiscal follow-up state without turning the sale into a failed payment. The POS requests the register kitchen ticket, closes the paid checkout, shows payment success, and races one narrowly authenticated fiscal finalization request against a strict ten-second receipt deadline. Accepted within that window prints the first receipt with the official QR. A confirmed rejection/unknown/request failure performs one authoritative status read and prints immediately; otherwise the deadline performs that single status read and prints with QR only if acceptance is already durable. Every other result prints once without QR, warns, and stops receipt follow-up. A stable checkout-receipt request ID makes the existing print-queue unique key the durable exactly-once guard, so a late result, browser replay, or changed QR payload cannot create another automatic receipt. XML corrections stay in the existing builder; no controller/repository layer, generic queue, new runtime module, or new table is introduced.

**Tech stack:** Node.js/CommonJS, Express, Vue 3/Pinia, MySQL/MariaDB, Vitest/Supertest, existing backend print queue and tracked spooler renderer. No new package and no database migration.

## Status and source authority

- Status: implementation plan complete; not implemented.
- Sole compliance source: `C:\Users\bash\Downloads\e-Invoicing DocumentatiUpdated2-1.pdf` (all 81 pages reviewed).
- Relevant source evidence:
  - Page 14: buyer identifiers are numeric and use `NIN`, `PN`, or `TN`; buyer name is mandatory for receivable invoices and cash invoices above JOD 10,000.
  - Pages 49-52: return documents require the original reference, reason, taxable amounts, tax subtotals, and zero prepaid amount.
  - Page 78: `Z` is exempt at 0%, `O` is ordinary zero-rated at 0%, and `S` uses the supported positive rates 1, 2, 3, 4, 5, 7, 8, 10, or 16.
  - Page 81: a successful response carries the official QR that must appear on the seller's invoice.
- The PDF does not document an anonymous-buyer sentinel. Per the approved product decision, this phase uses numeric `TN/0` for restaurant customers and does not add customer NIN/PN/TN storage. A low-value live acceptance check is therefore a release gate, not a reason to weaken validation.
- Clarification: the deferred “point 4” from the audit is customer tax-identity collection. The numbered implementation tasks below are execution order; Task 4 below is the separate, included credit-note correctness work.

## Scope boundary

### Included

- Fail-closed JoFotara HTTP response classification.
- Atomic validation of the one selected sales-tax or income-tax profile when enabling JoFotara or automatic submission.
- Supported JoFotara sales-tax-rate validation at enablement and relevant non-subscription catalog/settings write boundaries.
- Correct sales-tax categories `Z`, `O`, and `S`.
- Anonymous customer identity as `schemeID="TN"` with value `0`.
- Correct cash/receivable type names for invoices and returns.
- Complete sales-tax credit-note XML without string-replacing finished XML.
- Checkout-owned automatic submission for ordinary register, restored ordinary hold paid through the normal checkout route, table, and split-check checkouts.
- A ten-second backend-spooler receipt fast path: include an official QR if accepted in time, otherwise print once without it, warn, and never auto-reprint later.
- Crash recovery based on `invoice_issued_at`, including a table opened before automation was enabled but paid afterward.

### Explicitly deferred

- Subscription-specific JoFotara behavior: plan purchases, manual subscriptions, redemptions, collections, reversals, and subscription refunds. Subscription purchase invoices must be mechanically excluded from the new automatic checkout preparation, direct finalization, recovery scan, and receipt requirement. Preserve their current behavior and do not edit either subscriptions route in this phase.
- Platform settlement/remittance JoFotara behavior. `payment_method='platform'` remains excluded, and the existing zero-document regression test must remain green.
- Customer NIN/PN/TN schema, UI, validation, address expansion, or lookup. Ordinary restaurant buyers use `TN/0`; do not add columns, forms, or fabricated customer tax data. Existing buyer-name rules for receivable and cash-over-JOD-10,000 documents remain fail-closed.
- Special-sales-tax invoice types `013` and `023`.
- Browser receipt printing. The official-QR guarantee in this phase applies to the backend/spooler customer-receipt path only.
- Z/X reports, kitchen-ticket design, receipt-template-builder design, and physical-printer layout work.
- Remote “test credentials” submission from the settings screen.
- A generic job queue, event bus, adapter framework, controller layer, repository layer, or one-file-per-operation split.

## Non-negotiable invariants

1. No JoFotara HTTP request occurs inside `executeCheckout()` or any database transaction.
2. A committed payment is never returned or displayed as a failed checkout because JoFotara or printing failed.
3. The checkout route durably prepares the fiscal document after payment commit and before responding whenever possible. Preparation is local-only; the sale remains successful if it fails, and recovery can repair the missing row.
4. A register kitchen dispatch request is issued before the JoFotara HTTP request begins. This is an ordering guarantee, not a claim that a physical printer finishes first. Table checkout does not create a second kitchen ticket.
5. A customer receipt is queued after at most the ten-second provider window plus one bounded 500ms local status reconciliation. It includes the official QR only if acceptance is durably saved; otherwise it prints once without JoFotara data and shows a warning toast.
6. An HTTP 2xx response alone is never acceptance. Explicit success plus a usable official QR is required. Ambiguous transport or response states are `unknown`, not guessed as accepted or rejected.
7. `unknown` is never automatically retried; `accepted` is never submitted twice; concurrent direct/recovery attempts converge through the existing `source_key` lock/state machine.
8. Held saves, held kitchen fires, held deletes, unpaid table saves, platform bulk close, and subscription purchases do not trigger automatic JoFotara work in this phase.
9. The selected tax profile is scalar and exclusive. The inactive profile may remain stored but is never combined with the selected profile.
10. Legal snapshots remain immutable. Returns reuse the original accepted snapshot's profile, buyer, seller, payment terms, tax category, and rate.
11. Automatic submission applies to sales invoices created by checkout only. Credit notes remain visible and manually submittable in JoFotara Operations; the background scanner does not submit them automatically.
12. No schema changes means no migration file, automatic-chain entry, repair step, fresh-baseline edit, or fallback SQL file is added.
13. The cashier UI, checkout modal, cart reset, next-sale availability, and first customer receipt never wait for the external 30-second JoFotara timeout.
14. One checkout creates one automatic customer-receipt issuance set (primary plus the already-configured duplicate copy, if enabled). Later acceptance, recovery, Operations submission, socket events, or status reads never create another automatic receipt. A user may explicitly reprint from Orders.

## Target interfaces

Keep these interfaces in existing files; do not create a new service or API file.

```js
// backend/config/taxRegistration.js
const JOFOTARA_SALES_TAX_RATES = Object.freeze([0, 1, 2, 3, 4, 5, 7, 8, 10, 16]);
function isSupportedJofotaraSalesTaxRate(value) {}
function requiresJofotaraSalesTaxRates(settings) {}

// backend/services/JofotaraService.js
async function loadAutomaticInvoicePolicy(executor, invoiceId) {}
async function prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId }) {}
async function submitCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId, fetchImpl }) {}

// POST /api/pos/checkout/jofotara
// request
{ "idempotency_key": "checkout UUID", "shift_id": 123 }

// checkout response fragment after local preparation
{ "jofotara": { "required": true, "status": "pending|preparation_failed", "code": null } }

// finalization response when disabled/manual/ineligible
{ "success": true, "required": false, "status": "not_required" }

// response after an attempted automatic submission
{ "success": true, "required": true, "status": "accepted|rejected|unknown", "document": { } }

// POST /api/pos/checkout/jofotara/status (read-only; same owned checkout key)
{ "idempotency_key": "checkout UUID", "shift_id": 123 }
{ "success": true, "required": true, "status": "pending|submitting|accepted|rejected|unknown", "document": { } }
```

`loadAutomaticInvoicePolicy()` returns the saved invoice facts plus `enabled`, `autoSubmit`, `autoSubmitSince`, `eligible`, `withinCutoff`, and `excludedReason`. Eligibility requires a finalized payment method in the existing fiscal allowlist, a real invoice number/issue time, no linked `customer_subscriptions.purchase_invoice_id`, and a non-platform source. The checkout trigger requires `enabled && autoSubmit && eligible && withinCutoff`; this prevents an old idempotency key from submitting a pre-enable invoice. Enabled automation with a missing cutoff is a configuration conflict: direct preparation/submission does not guess, recovery submits nothing, and the receipt compiler fails closed. Once a JoFotara row exists, its state remains authoritative even if automation is later disabled.

## Cashier-visible outcome contract

| Mode/result | Sale and kitchen | Customer receipt | Follow-up |
|---|---|---|---|
| JoFotara disabled or manual | Checkout succeeds normally | Existing backend receipt prints immediately without waiting for JoFotara | Administrator may submit later from JoFotara Operations |
| Automatic, accepted within 10s | Checkout succeeds immediately | First receipt prints once with the official QR | None |
| Automatic, rejected/unknown/request failure | Checkout remains successful | First receipt prints once without JoFotara data immediately after the terminal failure is confirmed | One warning; administrator resolves it in JoFotara Operations |
| Automatic, still pending/submitting at 10s | Checkout remains successful | Client performs one final authoritative status read, then prints once: with QR if accepted, otherwise without QR | Warning toast; submission may finish later, but it never triggers another receipt |
| Spooler queue request fails | Checkout remains successful | Do not generate a second automatic print request | Show a print warning; an authorized user may reprint explicitly from Orders |

The ten-second deadline controls only receipt enrichment. It must not cancel, roll back, or reclassify the committed sale, and it must not convert an uncertain provider result into a retryable rejection. Retrying delivery of the original spooler job is transport recovery, not a second application-generated receipt.

## File map

### Runtime files to modify

- `backend/config/taxRegistration.js`
- `backend/services/JofotaraClient.js`
- `backend/services/JofotaraXmlBuilder.js`
- `backend/services/JofotaraService.js`
- `backend/services/printDocumentCompiler.js`
- `backend/services/printJobIdentity.js`
- `backend/routes/admin/jofotara.js`
- `backend/routes/admin/products.js`
- `backend/routes/admin/import.js`
- `backend/routes/system.js`
- `backend/routes/pos/checkout.js`
- `src/pos/stores/orderSession/orderSessionApi.js`
- `src/pos/stores/orderSessionStore.js`

### Existing tests to extend

- `backend/tests/unit/jofotaraClient.test.js`
- `backend/tests/unit/taxRegistration.test.js`
- `backend/tests/unit/jofotaraXmlBuilder.test.js`
- `backend/tests/unit/printDocumentCompiler.test.js`
- `backend/tests/unit/printJobIdentity.test.js`
- `backend/tests/unit/orderSessionStore.test.js`
- `backend/tests/integration/jofotara.test.js`
- `backend/tests/integration/products.test.js`
- `backend/tests/integration/settingsValidation.test.js`
- `backend/tests/integration/print.authz.test.js`
- `backend/tests/integration/platformHeldSettlement.test.js` (regression only; no production platform edit)

### Files deliberately not modified

- `backend/modules/checkout/executeCheckout.js`
- `backend/routes/pos/subscriptions.js`
- `backend/routes/admin/subscriptions.js`
- `backend/routes/admin/platformRemittances.js`
- `src/admin/pages/Settings.vue` (it already displays the backend's validation message)
- Browser print applications and spooler report paths.

## Task 1: Make JoFotara response acceptance fail closed

**Files:**
- Modify: `backend/tests/unit/jofotaraClient.test.js`
- Modify: `backend/services/JofotaraClient.js`

- [ ] **Step 1: Write failing response-classification tests**

Add cases proving:

- HTTP 200 + a currently established explicit success value (`SUBMITTED` or `PASS`) + non-empty exact `EINV_QR` field is accepted.
- The long opaque value returned in the QR field is preserved byte-for-byte for storage and printing. Do not decode, re-hash, normalize, truncate, or interpret it as money/document identity.
- HTTP 200 with `{}`, invalid JSON, or success text without a QR is `unknown`, never accepted.
- HTTP 200 with `NOT_SUBMITTED`, `ERROR`, `REJECT`, or a non-empty `ERRORS` array and no contradictory success/QR evidence is rejected.
- A non-2xx response with an explicit validation rejection is rejected; a non-2xx empty/invalid/5xx response or one carrying contradictory success/QR evidence is `unknown`, never accepted.
- Timeout/network failure remains `unknown` and never leaks credentials.
- A random nested field whose key merely contains `qr` cannot satisfy the official-QR requirement.
- A real JoFotara duplicate response saying the document was already submitted is never treated as a fresh rejection that the user may keep retrying. Until the live response proves it carries enough accepted identity + official QR evidence, classify it as `unknown` with public code `JOFOTARA_ALREADY_SUBMITTED`, preserve the response for Operations, and disable resubmission.
- Calling checkout finalization or the administrator submit endpoint for a locally `accepted` source returns the stored accepted document and performs zero HTTP calls.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
npm run test:unit -- backend/tests/unit/jofotaraClient.test.js
```

Expected: the 2xx-without-QR cases fail because `httpOk` currently acts as acceptance.

- [ ] **Step 3: Implement the smallest parser correction**

In `parseResponse(httpOk, body)`:

- Keep defensive extraction only for the currently established application response fields `EINV_STATUS`, `EINV_RESULTS.status`, `EINV_RESULTS.ERRORS`, and exact `EINV_QR` keys. Do not treat every key containing the letters `qr` as authoritative.
- Treat those field names and success tokens as the existing provider-contract assumption, not as a fact documented by the supplied PDF. Pin them in tests and confirm the exact live response shape at the release gate.
- Classify as `accepted` only when the response is 2xx, an established explicit success token is present, and `qrText` is a non-empty string.
- Classify as `rejected` only when explicit rejection evidence is present without contradictory acceptance evidence.
- Classify every ambiguous response—including invalid JSON, unclassified 4xx/5xx, and contradictory status/QR combinations—as `unknown`.
- Recognize the exact duplicate/already-submitted shape captured by the controlled live test. Store it as `unknown`/`JOFOTARA_ALREADY_SUBMITTED` unless that real response also supplies the same-document accepted identity and official QR required by the acceptance contract. Do not add a broad `/already/i` guess before seeing the provider payload.
- Give unverifiable parsed responses a useful non-secret error such as `JoFotara response could not be verified.` so Operations does not show a blank reason.

Do not add retries here.

- [ ] **Step 4: Run GREEN**

```powershell
npm run test:unit -- backend/tests/unit/jofotaraClient.test.js
```

Expected: all client tests pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/JofotaraClient.js backend/tests/unit/jofotaraClient.test.js
git commit -m "fix(jofotara): require verified QR acceptance"
```

## Task 2: Validate the selected profile and supported sales-tax rates atomically

**Files:**
- Modify: `backend/config/taxRegistration.js`
- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/routes/admin/jofotara.js`
- Modify: `backend/routes/admin/products.js`
- Modify: `backend/routes/admin/import.js`
- Modify: `backend/routes/system.js`
- Modify: `backend/tests/unit/taxRegistration.test.js`
- Modify: `backend/tests/integration/jofotara.test.js`
- Modify: `backend/tests/integration/products.test.js`
- Modify: `backend/tests/integration/settingsValidation.test.js`

- [ ] **Step 1: Write failing unit tests for the rate policy**

Pin the exact allowed set `0,1,2,3,4,5,7,8,10,16`, rejecting negatives, unsupported positives such as `6.5`, values over 100, `NaN`, empty strings, and malformed strings. Prove that rate enforcement is active only when JoFotara is enabled and the selected profile is `sales_tax`.

- [ ] **Step 2: Write failing settings integration tests**

Extend `jofotara.test.js` to prove:

- Enabling JoFotara with incomplete selected-profile credentials/seller fields returns a public 409 and changes no settings.
- Enabling automatic submission while JoFotara is disabled is rejected atomically.
- Both profile records may be stored, but only `tax_registration_type` is active and only that profile must be complete.
- Enabling the sales-tax profile is rejected when an active product or enabled service charge has an unsupported rate; the response lists the bad rates without exposing credentials.
- Enabling the income-tax profile does not apply the sales-tax-rate list.
- The automation cutoff is stamped only on a false-to-true transition of the combined `enabled && auto_submit` state and remains server-owned.
- A concurrent settings enable and product/service-charge write cannot commit an unsupported active rate after validation; both paths lock the same JoFotara policy rows in the same order.

- [ ] **Step 3: Write failing catalog/settings boundary tests**

When JoFotara sales-tax mode is enabled:

- Product create, update, batch create, and spreadsheet import reject an active product with rate `6.5` before committing any row.
- The same paths allow 0, 8, and 16.
- Activating an existing inactive product validates its effective saved rate even when `tax_rate` is omitted.
- Enabling a service charge validates its effective saved rate; changing the rate validates only when the effective service charge is enabled.
- Disabled JoFotara and the income-tax profile preserve the existing general 0-100 catalog behavior.

Do not add subscription-plan cases; that boundary is explicitly deferred.

- [ ] **Step 4: Run the focused tests and confirm RED**

```powershell
npm run test:unit -- backend/tests/unit/taxRegistration.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/products.test.js backend/tests/integration/settingsValidation.test.js
```

- [ ] **Step 5: Add one shared policy to `taxRegistration.js`**

Add the frozen allowed-rate list plus pure predicates. Keep `tax_registration_type` as the sole active-profile selector. Do not add per-profile enabled flags.

- [ ] **Step 6: Make JoFotara settings validation prospective and atomic**

In the existing `PUT /jofotara/settings` handler:

1. Acquire one connection and begin a transaction.
2. Load all JoFotara `SETTING_KEYS` plus `service_charge_enabled` and `service_charge_tax_rate`, not only three current values, with `FOR UPDATE` so two settings saves or a catalog-policy write cannot pass against stale state.
3. Build `nextSettings = { ...currentSettings, ...values }` before writing.
4. Reject contradictory `auto_submit=1` with `enabled=0`.
5. If the resulting integration is enabled, call the existing seller/credential validator for the selected profile and, for sales tax, scan distinct active product rates plus the effective enabled service-charge rate.
6. If combined automation changes from off to on, read database `NOW()` and include `jofotara_auto_submit_since` in the same upsert.
7. Perform one upsert and commit. Roll back every failure.

Do not contact JoFotara from settings save.

- [ ] **Step 7: Guard future non-subscription writes**

Reuse the existing settings access plus the shared pure predicates at the existing write boundaries. Each affected mutation must use its existing transaction or one small transaction, lock the JoFotara policy rows in the same order as the settings route, load the policy once, validate the effective active state/rate, then mutate and commit. Do not query settings once per imported row and do not add a repository abstraction.

- [ ] **Step 8: Run GREEN**

```powershell
npm run test:unit -- backend/tests/unit/taxRegistration.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/products.test.js backend/tests/integration/settingsValidation.test.js
```

- [ ] **Step 9: Commit**

```powershell
git add backend/config/taxRegistration.js backend/services/JofotaraService.js backend/routes/admin/jofotara.js backend/routes/admin/products.js backend/routes/admin/import.js backend/routes/system.js backend/tests/unit/taxRegistration.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/products.test.js backend/tests/integration/settingsValidation.test.js
git commit -m "fix(jofotara): validate active fiscal profile"
```

## Task 3: Correct invoice buyer identity and Z/O/S tax categories

**Files:**
- Modify: `backend/tests/unit/jofotaraXmlBuilder.test.js`
- Modify: `backend/tests/integration/jofotara.test.js`
- Modify: `backend/services/JofotaraXmlBuilder.js`

- [ ] **Step 1: Write failing snapshot/XML tests**

Prove all of the following:

- A tax-exempt sales invoice uses `Z`, 0%, and zero tax even when the product's configured rate is positive.
- An ordinary configured 0% sales line uses `O`, not `Z`.
- A positive supported rate uses `S` and preserves its configured rate after cent reconciliation.
- Mixed `O` and `S` lines preserve their own categories/rates.
- Unsupported positive sales rates fail before a legal document is stored or submitted.
- Sales-tax and income-tax customer XML always emits the same minimal anonymous-buyer structure: `<cbc:ID schemeID="TN">0</cbc:ID>`, country `JO`, and the PDF-shaped customer tax scheme using company ID `0`; it does not invent an address or a real taxpayer number.
- Receivable and cash-over-JOD-10,000 buyer-name requirements remain unchanged.
- Six-decimal money/quantity formatting remains unchanged.

Update the existing integration expectation from legacy `E` to `Z`.

- [ ] **Step 2: Run RED**

```powershell
npm run test:unit -- backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js
```

- [ ] **Step 3: Implement the category and buyer policy in the existing builder**

- Make `invoiceBuyer()` return the anonymous numeric ID `0`; do not inspect nonexistent customer tax fields and do not add schema.
- Render the same minimal `TN/0` anonymous party consistently for sales and income profiles, including the fixed `JO` country and customer tax-scheme structure already used by the sales renderer. Keep optional legal name/telephone sourced only from existing saved customer data.
- Fail closed under the existing buyer-name rules for receivable and cash-over-JOD-10,000 invoices. Do not pretend this phase supports identified corporate/tax buyers.
- Classify sales lines as `Z` for invoice-level exemption, `O` for ordinary 0%, and `S` for a positive supported rate.
- In `reconcileLastLineExtension()`, preserve the line's frozen category and configured rate. Reconciliation may adjust amounts by rounding residue; it must not reinterpret fiscal classification from `tax > 0`.
- Assert supported sales rates before rendering/storing the snapshot.

- [ ] **Step 4: Run GREEN**

```powershell
npm run test:unit -- backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js
```

- [ ] **Step 5: Commit**

```powershell
git add backend/services/JofotaraXmlBuilder.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js
git commit -m "fix(jofotara): emit anonymous buyer and tax categories"
```

## Task 4: Build complete cash and receivable credit notes

**Files:**
- Modify: `backend/config/taxRegistration.js`
- Modify: `backend/services/JofotaraXmlBuilder.js`
- Modify: `backend/tests/unit/taxRegistration.test.js`
- Modify: `backend/tests/unit/jofotaraXmlBuilder.test.js`
- Modify: `backend/tests/integration/jofotara.test.js`

- [ ] **Step 1: Write failing return tests**

Cover this matrix:

| Profile | Original terms | Invoice/return `name` |
|---|---:|---:|
| Income tax | Cash | `011` |
| Income tax | Receivable | `021` |
| Sales tax | Cash | `012` |
| Sales tax | Receivable | `022` |

For a sales-tax return assert:

- Type code `381`.
- Billing reference includes the original document number, accepted UUID, and original payable amount.
- Payment means includes the saved refund reason.
- Every return line includes taxable amount and preserves the accepted original category/rate. Legacy `E` is normalized to the PDF's exempt `Z`; an accepted legacy `Z` remains `Z` because a return must mirror the legal document that JoFotara already accepted rather than reclassifying it from today's catalog rules.
- Every refund line must resolve to its frozen original snapshot line. Missing original-line evidence fails closed rather than guessing a category or rate.
- Document tax subtotals group by category and rate and reconcile for mixed rates.
- `PrepaidAmount` is `0.000000`.
- Returned quantity cannot exceed the original quantity and totals still reconcile to the saved refund.
- Completing a refund does not automatically call JoFotara. The credit note remains listed in Operations and requires an explicit administrator submission in this phase.

- [ ] **Step 2: Run RED**

```powershell
npm run test:unit -- backend/tests/unit/taxRegistration.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js
```

- [ ] **Step 3: Remove the misleading generic `return` type constant**

Keep only `cash` and `receivable` names in `JOFOTARA_INVOICE_TYPE_NAMES`. In `buildCreditNoteSnapshot()` obtain payment terms from `originalSnapshot.paymentTerms`. For older snapshots lacking that property, infer only from the frozen original `invoiceTypeName`; fail closed if it is not one of the known names.

- [ ] **Step 4: Deepen the existing renderer instead of adding a second renderer**

Change the signature to:

```js
function renderSalesInvoiceXml(snapshot, identity, { creditNote = false } = {}) {}
```

Use a small private grouping helper for document tax subtotals. Conditional rendering supplies type `381`, original reference, reason, return taxable amounts, grouped subtotals, and zero prepaid amount. `renderCreditNoteXml()` validates the original reference and delegates to this renderer. Delete the current finished-XML `.replace()` choreography.

- [ ] **Step 5: Run GREEN**

```powershell
npm run test:unit -- backend/tests/unit/taxRegistration.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js
```

- [ ] **Step 6: Commit**

```powershell
git add backend/config/taxRegistration.js backend/services/JofotaraXmlBuilder.js backend/tests/unit/taxRegistration.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/integration/jofotara.test.js
git commit -m "fix(jofotara): complete fiscal credit notes"
```

## Task 5: Durably prepare checkout invoices and add a narrowly authenticated finalizer

**Files:**
- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/tests/integration/jofotara.test.js`
- Modify: `backend/tests/integration/checkoutPostCommit.test.js`
- Modify: `backend/tests/integration/platformHeldSettlement.test.js` (regression only)

- [ ] **Step 1: Write failing post-commit preparation tests**

Prove:

- Enabled automatic ordinary register, table, and split-check checkout commits the order, then creates exactly one `pending` document with frozen snapshot/XML before returning. No `fetch` call occurs during checkout.
- Disabled/manual/pre-cutoff checkout returns `jofotara.required:false` and creates no document.
- Cash and receivable subscription purchases return `jofotara.required:false` and create no document. Assert this through the real `customer_subscriptions.purchase_invoice_id` relationship, not a client flag.
- Platform bulk close, unpaid table save, held save/fire/delete, and ordinary hold deletion create no document. Preserve the existing platform zero-document regression.
- Replaying the checkout idempotency key finds or creates the same `source_key`; it never duplicates the document.
- If local snapshot/config preparation fails after payment commit, checkout still returns HTTP 200 with its normal sale result plus `jofotara: { required:true, status:'preparation_failed', code }`; the saved order and checkout attempt remain committed.

- [ ] **Step 2: Run RED**

```powershell
npm run test:unit -- backend/tests/integration/jofotara.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/platformHeldSettlement.test.js
```

- [ ] **Step 3: Split local preparation from network claiming inside the existing service**

Do not duplicate the current snapshot/XML builder path. Refactor the private `prepareSalesDocument()` just enough to support two modes:

- local ensure: validate/load the saved invoice and selected frozen profile, create the existing `pending` row plus legal snapshot/XML if absent, and commit without changing it to `submitting`;
- submission claim: lock the same `source_key`, preserve the existing accepted/submitting/unknown rules, validate current credentials, and atomically change only an eligible row to `submitting` before network I/O.

`prepareCheckoutInvoiceIfAutomatic()` performs the automatic policy check and local ensure in one short transaction. Its SQL must exclude `payment_method='platform'` and any order for which `EXISTS (SELECT 1 FROM customer_subscriptions WHERE purchase_invoice_id=o.invoice_id)`. It returns a small public `{ required, status, code }` result and never calls `submitXml()`.

`loadAutomaticInvoicePolicy()` must use the same finalized-payment, invoice-number, cutoff, platform, and subscription predicates so preparation, finalization, recovery, and printing cannot disagree.

- [ ] **Step 4: Attach local preparation after the existing checkout commit**

In the successful `POST /api/pos/checkout` branch, after `executeCheckout()` returns:

1. Call `prepareCheckoutInvoiceIfAutomatic({ invoiceId: result.invoice_id, actorUserId: req.user.id })`.
2. Attach its public state to `result.jofotara`.
3. Catch only this post-commit fiscal failure, log the invoice ID/public code, attach `preparation_failed`, and still return the normal successful checkout response.
4. Never move this call into `executeCheckout()` and never call JoFotara HTTP here.

This means the client may wait for a short local database/XML step, but the kitchen never waits on the external government endpoint. If the process dies between order commit and local preparation, Task 7's no-document recovery path repairs it.

- [ ] **Step 5: Write failing finalization/authentication/concurrency tests**

Prove:

- Disabled/manual/ineligible returns `required:false` without `fetch`.
- A prepared eligible checkout submits once and returns the public accepted/rejected/unknown state.
- A repeated call for accepted returns stored state without another network call.
- Another cashier's key, another shift's key, a missing/unknown key, subscription purchase, and platform invoice cannot select or submit an invoice.
- Two simultaneous finalization calls plus a competing recovery pass produce at most one external send; the other caller observes `submitting`/stored state rather than issuing another request.
- Rejected/unknown fiscal results never alter the already committed sale.
- The read-only status lookup returns the current durable state without claiming, submitting, retrying, or calling `fetch`.
- Status lookup uses the same cashier/shift/idempotency-key ownership checks; it cannot inspect another cashier's checkout.

- [ ] **Step 6: Add the finalization route beside the checkout route**

In `backend/routes/pos/checkout.js`:

1. Normalize `idempotency_key` with `normalizeCheckoutAttemptKey()`.
2. Use the existing `findOwnedCheckoutAttempt(pool, { key, userId, shiftId })` to bind it to the authenticated cashier and shift.
3. Return 404/409 for missing or conflicting ownership.
4. Call `submitCheckoutInvoiceIfAutomatic()` only after finding the committed attempt; it must recheck the authoritative saved policy/exclusions and submit the existing pending row (or idempotently repair a missing eligible row) through the existing locked state machine.
5. Return fiscal status separately from checkout status.
6. Add `POST /api/pos/checkout/jofotara/status` beside it. Resolve the same owned checkout attempt, call only a read-only public-state service method, and never trigger submission from this endpoint.

Do not call this route from `executeCheckout()`, `orders.js` platform settlement, table save, or held-order routes.

- [ ] **Step 7: Run GREEN**

```powershell
npm run test:unit -- backend/tests/integration/jofotara.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/platformHeldSettlement.test.js
```

Expected: checkout post-commit guarantees and the existing platform zero-document assertion remain green.

- [ ] **Step 8: Commit**

```powershell
git add backend/services/JofotaraService.js backend/routes/pos/checkout.js backend/tests/integration/jofotara.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/platformHeldSettlement.test.js
git commit -m "feat(jofotara): prepare and finalize checkout invoices"
```

## Task 6: Sequence kitchen, JoFotara, and backend receipt correctly in the POS

**Files:**
- Modify: `src/pos/stores/orderSession/orderSessionApi.js`
- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `backend/services/printJobIdentity.js`
- Modify: `backend/tests/unit/orderSessionStore.test.js`
- Modify: `backend/tests/unit/printJobIdentity.test.js`

- [ ] **Step 1: Write failing order-session tests with deferred promises and fake timers**

Pin the exact order of effects:

1. Checkout HTTP succeeds with its local JoFotara preparation state.
2. Register kitchen dispatch is requested immediately after that response and before the unresolved finalization/JoFotara promise.
3. Local checkout state is finalized, payment success is shown, and `ui.isProcessing` becomes false without awaiting JoFotara.
4. When automatic fiscal work is required, one finalization promise races the ten-second deadline without blocking the checkout UI; there is no interval polling.
5. Exactly one backend receipt issuance set is dispatched: with QR if accepted by the deadline, otherwise without JoFotara data.

Also prove:

- Rejected, unknown, thrown, and network-failed fiscal finalization print the normal backend receipt once without JoFotara data as soon as that terminal failure is known; they never suppress the customer's receipt or consume the remaining deadline.
- `preparation_failed` still attempts the authenticated finalizer once, allowing its idempotent repair path to create/submit the missing document; if that fails, it follows the same post-payment warning path.
- A failed/timed-out finalization request does not immediately assume failure: the client checks the authoritative status endpoint because the backend request may still have completed after the browser stopped waiting.
- At ten seconds, or immediately after an early request failure, perform exactly one authoritative status read with its own 500ms ceiling. If accepted, print with QR; for every other state, timeout, or unreachable status endpoint, print without QR immediately and stop receipt follow-up.
- Rejected, unknown, preparation failure, or unresolved-at-deadline shows one non-blocking warning that the sale and receipt succeeded but JoFotara needs attention in Operations. None of these states set generic `checkoutError`.
- A provider response that arrives after the fallback receipt was queued may update the durable document state, but cannot queue or mutate another receipt.
- A table checkout calls fiscal finalization but does not dispatch a new kitchen ticket.
- A restored ordinary held order paid through the normal checkout follows the same sequence.
- Starting another sale while the previous fiscal request is pending cannot print the new mutable `lastOrder`; the eventual receipt uses the captured completed-order payload and original checkout key.
- A race between finalization response, deadline status read, socket notifications, and spooler dispatch queues the primary/configured-duplicate receipt set exactly once.
- A later accepted state and a later Operations submission cause zero automatic spooler calls. Explicit reprint from Orders remains unchanged.
- A replay with the same deterministic checkout-receipt request ID but a changed payload (for example QR now present) resolves to the original queue row rather than inserting a second job.
- Receipts without an explicit request ID retain today's distinct-job behavior, so explicit Orders reprints are not accidentally deduplicated.
- Browser printing retains its existing behavior and is not redesigned by these tests.

Advance fake timers through the ten-second deadline and 500ms status ceiling; assert at most one status request and never make this test actually sleep.

- [ ] **Step 2: Run RED**

```powershell
npm run test:unit -- backend/tests/unit/orderSessionStore.test.js
```

- [ ] **Step 3: Add the request to the existing API owner**

Add only:

```js
export const finalizeJofotaraCheckout = payload =>
  jsonRequest('api/pos/checkout/jofotara', 'POST', payload);

export const getJofotaraCheckoutStatus = payload =>
  jsonRequest('api/pos/checkout/jofotara/status', 'POST', payload);
```

- [ ] **Step 4: Reorder only the successful-checkout block**

Preserve current duplicate-key protection. After a successful checkout response, request the register kitchen ticket, capture the immutable completed-order receipt payload, finalize local checkout state, and show payment success immediately. If fiscal work is not required, preserve the existing manual/disabled receipt behavior. If it is required—including `preparation_failed`—start one private receipt-fast-path helper and do not make `processCheckout()` wait on it before releasing checkout state. The helper uses `Promise.race([observedFinalizationPromise, tenSecondDeadline])`; it does not poll. Convert rejection into a settled result before racing so a late failure cannot become an unhandled promise rejection. A terminal finalization response decides immediately. A thrown request or the deadline causes exactly one read-only status request, itself raced against a 500ms ceiling, before deciding the receipt.

Keep two local timing constants: the ten-second provider window and 500ms status-check ceiling. Do not shorten the backend's 30-second provider timeout merely to make the receipt faster; that would manufacture more `unknown` documents. At the decision point, queue the captured completed-order payload with accepted QR data only when available. Give the primary copy `print_request_id: checkout-receipt:<invoice_id>:primary`; give the intentional configured duplicate `checkout-receipt:<invoice_id>:duplicate`. Mark the in-memory checkout key decided before dispatch for same-page race suppression, but rely on the database print-queue uniqueness for crash/replay durability. Preserve the normal spooler error warning if the one dispatch fails; do not automatically issue another application job. If the table-admin redirect must occur, wait only for this bounded receipt decision, never the provider timeout.

- [ ] **Step 5: Make explicit receipt request IDs durable in the existing queue identity helper**

In `buildPrintIdempotencyKey()` keep current behavior for every receipt that omits `print_request_id`: it receives a random request ID and repeated manual prints remain distinct. For a receipt with an explicit `print_request_id`, build the identity from receipt type + resolved printer + that explicit request ID without the mutable payload hash. The existing unique `print_queue.idempotency_key` and `ON DUPLICATE KEY` insert then make the first queued payload win even if a replay later includes/removes JoFotara QR data. Do not add a column or a new idempotency service.

Add focused tests proving primary and configured duplicate keys differ, same explicit ID survives payload/QR changes, omitted IDs remain distinct, and audited/manual reprints remain distinct.

Do not add a new store, composable, state machine, or facade entry.

- [ ] **Step 6: Run GREEN**

```powershell
npm run test:unit -- backend/tests/unit/orderSessionStore.test.js backend/tests/unit/printJobIdentity.test.js
```

- [ ] **Step 7: Commit**

```powershell
git add src/pos/stores/orderSession/orderSessionApi.js src/pos/stores/orderSessionStore.js backend/services/printJobIdentity.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/printJobIdentity.test.js
git commit -m "fix(pos): bound fiscal receipt wait"
```

## Task 7: Keep receipt printing prompt while recovering missed fiscal work

**Files:**
- Modify: `backend/services/printDocumentCompiler.js`
- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/tests/unit/printDocumentCompiler.test.js`
- Modify: `backend/tests/integration/print.authz.test.js`
- Modify: `backend/tests/integration/jofotara.test.js`

- [ ] **Step 1: Write failing receipt-fallback tests**

For every stable paid invoice, prove:

- A valid accepted document contributes its official QR to the queued receipt.
- No document and `pending`, `submitting`, `rejected`, or `unknown` documents still compile and queue the normal receipt with no JoFotara data.
- A malformed accepted row with missing QR or mismatched invoice identity never contributes untrusted JoFotara data, but it also never blocks the customer's normal receipt.
- Disabled/manual/pre-cutoff/subscription/platform receipts preserve their existing immediate behavior.
- Held/guest/kitchen jobs remain unaffected.
- Compiling/queueing a normal fallback receipt does not mutate the fiscal document or mark it accepted/rejected.

- [ ] **Step 2: Write failing recovery tests**

Prove:

- Recovery selects an eligible `pending` invoice only after its document `created_at` is at least two minutes old, allowing checkout its one primary automatic attempt.
- Recovery selects a finalized no-document invoice whose `invoice_issued_at` is after the cutoff and at least two minutes old even if its table `created_at` is before the cutoff; it first creates the same pending document through the shared preparation path, then claims/submits it.
- The same table while `payment_method='unpaid_table'` is not selected.
- Platform invoices and every invoice linked by `customer_subscriptions.purchase_invoice_id` remain excluded.
- Accepted, submitting, rejected, unknown, and newly created pending documents are not automatically retried/claimed.
- Refund/credit-note rows are not selected by the automatic scanner; they remain manual Operations work.
- A direct finalizer racing recovery produces exactly one external request and one terminal document state.
- Recovery or later acceptance performs zero spooler calls; it updates fiscal state only.

- [ ] **Step 3: Run RED**

```powershell
npm run test:unit -- backend/tests/unit/printDocumentCompiler.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/jofotara.test.js
```

- [ ] **Step 4: Make JoFotara enrichment optional in the existing compiler**

Keep all receipt money and identity authority unchanged. The compiler may attach JoFotara data only for accepted + matching identity + valid QR. Every absent, unfinished, rejected, unknown, or malformed fiscal state returns no JoFotara enrichment and continues building the ordinary receipt. Log malformed accepted identity/QR evidence without exposing credentials; do not change document state here and do not introduce a separate fallback compiler.

- [ ] **Step 5: Correct the scanner cutoff without adding receipt behavior**

In `processOperationsOnce()`, process sales invoices only:

- existing `pending` documents older than the two-minute grace window; and
- eligible finalized invoices with no document, `o.invoice_issued_at >= auto_submit_since`, and `o.invoice_issued_at <= NOW() - INTERVAL 2 MINUTE`.

Use `invoice_issued_at`, never table/order `created_at`, for the automation cutoff. Apply the same finalized payment-method allowlist plus explicit platform and `NOT EXISTS customer_subscriptions` exclusions. Route both candidate shapes through the same preparation/claim state machine used by direct finalization. Do not select `submitting`, `accepted`, `rejected`, or `unknown`, and remove credit notes from the automatic branch without removing their Operations listing/manual submit endpoint. The scanner must not import or call print services.

- [ ] **Step 6: Add real queue-boundary integration tests**

Exercise the complete backend path in backend print mode:

1. Accepted before receipt dispatch queues one issuance set containing the exact official QR/document identity.
2. Pending, rejected, unknown, unavailable status, and accepted-without-valid-QR each queue one ordinary issuance set without JoFotara data.
3. Change the document to accepted after that fallback job is queued and prove the queue count does not increase.
4. Submit manually from Operations after fallback and prove the queue count still does not increase.
5. Explicitly reprint the accepted invoice through the existing Orders path and prove only that user action creates the later QR-bearing job.

- [ ] **Step 7: Run GREEN**

```powershell
npm run test:unit -- backend/tests/unit/printDocumentCompiler.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/platformHeldSettlement.test.js
```

- [ ] **Step 8: Commit**

```powershell
git add backend/services/printDocumentCompiler.js backend/services/JofotaraService.js backend/tests/unit/printDocumentCompiler.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/jofotara.test.js
git commit -m "fix(jofotara): preserve prompt single receipt issuance"
```

## Task 8: Adversarial verification and release gate

**Files:** no production edits expected.

- [ ] **Step 1: Run the complete focused fiscal suite**

```powershell
npm run test:unit -- backend/tests/unit/jofotaraClient.test.js backend/tests/unit/taxRegistration.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/unit/printDocumentCompiler.test.js backend/tests/unit/printJobIdentity.test.js backend/tests/unit/orderSessionStore.test.js backend/tests/integration/jofotara.test.js backend/tests/integration/products.test.js backend/tests/integration/settingsValidation.test.js backend/tests/integration/print.authz.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/platformHeldSettlement.test.js
```

- [ ] **Step 2: Run the full unit/integration suite once**

```powershell
npm run test:unit
```

Expected: zero failures. Do not rerun it again merely because no code changed after this run.

- [ ] **Step 3: Build the production frontend**

```powershell
npm run build
```

Expected: Vite build succeeds without warnings introduced by this phase.

- [ ] **Step 4: Inspect the implementation diff against the invariants**

```powershell
git diff --check
git diff --stat master...HEAD
rg -n "Jofotara|JoFotara|jofotara" backend/modules/checkout/executeCheckout.js backend/routes/pos/subscriptions.js backend/routes/admin/subscriptions.js backend/routes/admin/platformRemittances.js
```

Expected: no whitespace errors; no new JoFotara code in the deliberately untouched checkout transaction, subscription, or platform files.

- [ ] **Step 5: Perform one controlled low-value live acceptance test before enabling production automation**

Use the selected real profile credentials on a non-production or controlled low-value sale:

1. Enable JoFotara with auto-submit and confirm the selected profile validates.
2. Checkout one ordinary register sale using supported rates.
3. Confirm the checkout response already has a durable pending row and that the register kitchen dispatch request occurs before the external JoFotara call.
4. Confirm the real response uses the exact explicit status/QR fields pinned by `JofotaraClient` tests. The PDF does not define those JSON keys; if the live shape differs, leave the result `unknown`, verify the government portal before any retry, and add only the observed exact fields with new tests.
5. Capture the normal accepted response and one deliberate duplicate submission response with HTTP status, JSON key paths, value types, status tokens, error entries, government UUID, and opaque QR length. Redact credentials and personal/business-sensitive values; do not paste the full QR payload into documentation or logs.
6. Confirm the response is accepted and the first backend-spooler customer receipt contains the official QR.
7. Attempt to submit that locally accepted invoice again through every exposed path and confirm zero provider calls. If testing the provider's duplicate response requires a separately controlled document whose local state is intentionally not accepted, confirm the response becomes non-retryable Operations evidence rather than a retry loop.
8. Repeat with a controlled response delayed beyond ten seconds: confirm the paid checkout remains released, exactly one receipt prints without JoFotara data after the bounded 500ms reconciliation, and the later accepted state causes no second receipt.
9. Repeat with a rejection/network failure and confirm the normal receipt prints promptly once while Operations shows the fiscal problem.
10. Confirm JoFotara accepts the chosen anonymous `TN/0` convention.
11. Open a table before the cutoff, enable automation, then pay the table and confirm it submits at checkout/through recovery if the browser is interrupted without delaying its receipt beyond the 10.5-second hard ceiling.
12. Confirm held saves/fires/deletes and platform bulk close create no JoFotara document.
13. Confirm cash and receivable subscription purchases create no JoFotara document and remain printable through their existing deferred behavior.
14. Create a refund and confirm it is visible in JoFotara Operations but is not submitted until an administrator explicitly chooses submit.

If JoFotara rejects `TN/0`, leave automation disabled and reopen the deferred customer-ID decision. Do not classify the rejection as success or replace it with a locally generated QR. The ordinary customer receipt still prints under the explicit ten-second fallback policy.

- [ ] **Step 6: Final commit only if verification required test-only corrections**

First inspect `git status --short`. If verification required corrections, stage only the concrete test or runtime files shown there and commit them with:

```powershell
git commit -m "test(jofotara): close fiscal workflow regressions"
```

Do not create an empty commit.

## Aggressive plan-attack checklist

The executor must answer all of these with passing evidence before handoff:

- Can HTTP 200 with empty JSON or no QR become accepted? **No.**
- Can enabling settings partially write before validation fails? **No.**
- Can both tax profiles become active at once? **No; one scalar selector.**
- Can an unsupported active sales-tax rate be introduced through product create/update/batch/import or enabled service charge? **No, except the explicitly deferred subscription-plan writer.**
- Can a table opened before enablement escape submission after payment? **No; checkout trigger plus `invoice_issued_at` recovery.**
- Can a browser close after checkout commit but before finalization silently lose the invoice? **No; checkout leaves a pending row, and no-document recovery covers a process crash before preparation.**
- Can JoFotara network latency hold the kitchen ticket? **No; only the short local preparation precedes the checkout response.**
- Can JoFotara failure roll back or visually fail a committed payment? **No.**
- Can JoFotara latency/failure delay the first customer receipt toward the provider's 30-second timeout? **No; the hard client ceiling is 10.5 seconds including the final local status check.**
- Can pending/rejected/unknown/unavailable fiscal state suppress the customer's receipt? **No; it removes only JoFotara enrichment.**
- Can a late acceptance or Operations submission automatically print a confusing second receipt? **No.**
- Can a browser/process replay with the same checkout receipt but changed QR payload insert a second queue row? **No; the explicit request ID is the stable database key and the first job wins.**
- Can an application-level spooler error automatically create a second receipt job? **No; only explicit Orders reprint may do that.**
- Can an accepted invoice be resent by a double click or recovery race? **No; existing locked `source_key` state machine.**
- Can platform settlement be pulled into JoFotara accidentally? **No; `platform` remains ineligible and its regression assertion stays green.**
- Can a subscription purchase be pulled into JoFotara by using normal cash/card/receivable checkout? **No; the authoritative purchase-invoice relationship excludes it at preparation, finalization, recovery, and printing policy.**
- Can a refund be automatically submitted by the background scanner? **No; credit notes are explicit Operations work in this phase.**
- Did this phase add customer tax-ID fields, subscription logic, a generic queue, a new module, or a migration? **No.**

## Honest residual risks after completion

- `TN/0` is an approved product convention but is not documented in the supplied PDF. The controlled live acceptance test is mandatory.
- The supplied PDF does not define the JoFotara JSON response field names or success tokens. The parser deliberately preserves only the exact established application fields and fails unknown; the controlled live test must confirm them before automation is enabled.
- By explicit product decision, a timeout/rejection/unresolved automatic submission produces the restaurant receipt without an official JoFotara QR rather than delaying the customer. Fiscal state remains truthful in Operations, and a later acceptance does not alter or automatically reprint that receipt.
- Subscription-specific invoices and their later collection/refund lifecycle remain deferred; this phase does not claim those flows are JoFotara-complete.
- Platform sales/remittances remain deliberately outside JoFotara.
- Credit-note XML is corrected, but automatic credit-note submission is deliberately disabled; administrators submit returns from JoFotara Operations.
- Browser receipts remain outside the official-QR guarantee.
- Special-sales-tax invoice types remain unsupported.
