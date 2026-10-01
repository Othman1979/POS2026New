# Subscription Receivables and Shift-Safe Collections Implementation Plan

> **Status:** Design only. Implementation may proceed behind the mandatory default-off feature gate, but production enablement for a tax profile is forbidden until the JoFotara receivable contract gate in Phase 0 is satisfied for that profile.
>
> **For the inline executor:** REQUIRED SKILLS: ponytail, executing-plans, test-driven-development, security-review, mysql, Vue, verification-before-completion, and JoFotara integration. Work on a `codex/` feature branch. Do not use subagents. Do not merge to `master` as part of execution.

**Goal:** Preserve ordinary paid subscription sales and manual assignments while adding a theft-resistant receivable workflow in which a subscription may be issued and used before payment, and any later cash/card collection is attributed to the real collection date, operator, and open shift without recording a second sale.

**Architecture:** Keep `orders` as the only sales-invoice authority. A receivable subscription is an ordinary finalized order whose `payment_method` is `receivable`, whose `payment_due_on` is explicit, and whose cash/card fields are zero. `customer_subscriptions.purchase_invoice_id` links the entitlement to that invoice. A narrow append-only `subscription_collections` ledger records later money movement and reversals. Outstanding balance and billing state are derived from the invoice total and signed collection ledger; they are never copied into a mutable balance column.

**Stack:** Express 5, MySQL/MariaDB with mysql2 and InnoDB, Vue 3/Pinia, Vitest/Supertest, Playwright, existing JoFotara services, existing receipt presentation/template/spooler path.

## Global constraints

- No card-terminal provider work, browser-printing work, generic accounting framework, general customer-credit account, or unrelated refactor.
- Preserve the current paid-now, manual/complimentary, redemption, split-payment, JoFotara operations, receipt-template, and spooler behavior unless a task explicitly changes its contract.
- Do not trust client totals, dates, actor IDs, shift IDs, billing states, or outstanding balances.
- Do not run the full suite after every small edit. Run each phase's focused tests, then the full gates once in Phase 8.
- Do not proceed past a failed JoFotara contract gate by guessing.
- Keep all financial writes transactional, idempotent, parameterized, and auditable.
- Do not add dependencies or split functions into new files unless the existing ownership cannot hold a genuinely independent deep module.

---

## 1. Evidence and non-negotiable conclusions

### Current behavior

- `backend/routes/admin/subscriptions.js` creates a manual entitlement with `purchase_invoice_id=NULL`, a mandatory reason, no order, no shift, no payment, and no JoFotara document.
- `src/admin/components/SubscriptionAssignmentModal.vue` correctly warns that manual assignment records no payment or invoice.
- `src/components/pos/SubscriptionModal.vue` and `src/pos/stores/orderSessionStore.js` put a subscription plan’s hidden sale product into the cart and use the normal checkout.
- `backend/modules/checkout/executeCheckout.js` already owns the critical paid-sale guarantees: database pricing, tax snapshot, payment validation, invoice identity, idempotency, authenticated-user shift locking, order/item writes, subscription activation, receipt data, and post-commit dispatch.
- Subscription start/end dates do not choose the order date. `executeCheckout.js` sets `createdAt` on the server, and shift ownership is resolved from the authenticated user’s open shift.
- Admin/programmer checkout currently may finalize paid orders without a shift. That exception must not be used for subscription cash collection.
- `customer_subscriptions` currently derives `source` only from invoice presence: invoice means sale; no invoice means manual. A receivable invoice therefore fits the existing commercial origin without weakening the manual-origin constraint.
- `backend/services/financialSql.js` and many report routes currently assume sale and collection occur together because cash/card live on `orders`. A later-payment feature is incomplete unless those consumers are intentionally updated.
- `backend/services/JofotaraService.js` currently accepts only cash/card/split orders. `JofotaraXmlBuilder.js` currently emits `011` or `012`, the cash variants.
- Official JoFotara guidance distinguishes cash from receivable invoices and requires buyer information for receivables. The production-verified project reference covers sales-tax receivables as `022`; `021` for income-tax receivables is not covered by that production reference and must remain an external validation gate.
- JoFotara credit notes do **not** inherit the receivable invoice's `021`/`022` code in the current proven flow. The current builder correctly uses the configured return profile (`011` for income tax, `012` for sales tax) with document type `381`. Do not change that without separate live evidence.
- `backend/services/subscriptionMetrics.js` already uses canonical invoice time for subscription sale metrics. The older `calculateSubscriptionMetrics()` in `SubscriptionService.js` still uses `DATE(o.created_at)` and should be deleted if truly unused, not extended as a second implementation.

### Brutal constraint

The application cannot detect cash physically taken by a cashier who never records any transaction. It can prevent date/shift manipulation, restrict who may grant credit, make every recorded credit sale immediately visible, and leave an immutable audit trail. Management still needs cash counts and exception review.

### Scope decisions

- Existing paid-now POS sale/renewal stays unchanged in behavior.
- Existing admin manual/complimentary assignment stays available and clearly non-financial.
- Pay-later means a real receivable invoice and grants redeemable credits immediately.
- V1 accepts only full settlement of the current outstanding balance. The ledger supports multiple rows so partial settlement can be added later, but no partial-payment UI or API is exposed now.
- Admin may issue a receivable but may not collect/refund/reverse money without a POS open shift.
- A receivable reason is mandatory and immutable. The due date is also immutable in V1; changing it after issuance would be an easy way to hide overdue debt and would require a separately designed amendment/audit workflow.
- The original order remains `payment_method='receivable'` after settlement. Collection never rewrites it to cash/card because that would corrupt the legal invoice type and sale-date reporting.
- No card-terminal provider work, generic accounting system, generic customer credit account, inventory work, browser printing, or unrelated page refactor is included.

---

## 2. State machine and authority model

### Subscription origin

| Origin | Invoice | Money at issue | Redeemable | Refund semantics |
|---|---:|---:|---:|---|
| Manual/complimentary | No | None | Yes, subject to dates/credits | No financial refund |
| Paid now | Cash/card/split invoice | Recorded on issue shift | Yes | Existing paid refund rules |
| Receivable | `receivable` invoice | Zero | Yes | Credit-note/cancel debt; return collected money if settled |

### Receivable billing state (derived, never stored)

```text
invoice total
  - active collection rows
  + active reversal rows
  = outstanding balance

outstanding == total                       -> unpaid
0 < outstanding < total                   -> partial (schema-safe; unreachable from V1 UI)
outstanding == 0                           -> paid
outstanding > 0 and business_date > due    -> overdue presentation overlay
refunded/cancelled subscription            -> closed
```

### Date ownership

| Fact | Authority | Meaning |
|---|---|---|
| `invoice_issued_at` | Server clock in checkout | Sale/revenue and JoFotara issue time |
| `starts_on`, `ends_on` | Validated business input | Entitlement period only |
| `payment_due_on` | Validated business input | Expected payment deadline only |
| collection `created_at` | Server clock | Actual money event time |
| collection `business_date` | Server `getBusinessDate(created_at)` | Z/X, drawer, audit and collection reporting day |
| collection `shift_id` | Authenticated user’s locked open shift | Drawer that received/returned money |

Cash/card endpoints must reject any client fields that attempt to supply collection time, business date, operator, or shift authority.

### Permission model

- Keep `pos.subscriptions` for ordinary subscription selling and redemption.
- Add `pos.subscription_credit` for issuing receivable subscriptions. Default it off for cashiers and make it explicitly assignable. Admin/programmer roles retain administrative access.
- Mark `pos.subscription_credit` as `implemented=1`, `default_cashier=0`, and `overridable=1` in the canonical permission catalog. The existing override service already returns the approving manager ID; retain that ID on the issuance audit.
- A cashier without that direct permission may issue credit only through the existing manager-override path; the audit event must retain the approving manager ID. Do not create a second PIN system.
- Collection requires `pos.subscriptions` plus ordinary checkout permission and the authenticated user’s open shift.
- Refund/reversal retains the existing refund/manager rules and additionally requires a current open shift.

---

## 3. Database contract

### Orders

Extend `orders`:

```sql
payment_method ENUM('cash','card','split','receivable','unpaid_table','voided') NOT NULL,
payment_due_on DATE NULL,
receivable_reason VARCHAR(255) NULL,
buyer_name_at_sale VARCHAR(100) NULL,
buyer_phone_at_sale VARCHAR(20) NULL,
buyer_address_at_sale TEXT NULL
```

Add `idx_orders_receivable_due (payment_method, payment_due_on, invoice_id)` for outstanding/overdue administration. Verify its intended range plan with `EXPLAIN` against seeded paid and receivable rows; do not add additional speculative collection indexes.

Add `chk_orders_receivable_terms`:

```sql
CHECK (
  (payment_method='receivable'
    AND payment_due_on IS NOT NULL
    AND CHAR_LENGTH(TRIM(receivable_reason)) > 0
    AND CHAR_LENGTH(TRIM(buyer_name_at_sale)) > 0
    AND COALESCE(cash_amount,0)=0
    AND COALESCE(card_amount,0)=0
    AND COALESCE(amount_tendered,0)=0
    AND COALESCE(change_due,0)=0)
  OR
  (payment_method<>'receivable'
    AND payment_due_on IS NULL
    AND receivable_reason IS NULL
    AND buyer_name_at_sale IS NULL
    AND buyer_phone_at_sale IS NULL
    AND buyer_address_at_sale IS NULL)
)
```

The service also enforces `payment_due_on >= business date of invoice issue`; this cross-value date rule is clearer in code and integration tests than in a timezone-dependent database check. The frozen buyer columns prevent a later customer edit from changing a pending JoFotara document or reprinted legal receipt.

### Buyer identity

Do **not** add speculative tax/national-ID fields before Phase 0 proves they are required. The official manual says buyer information is required but does not publish a precise API field-minimum. First validate the existing customer name/phone/address plus the reference implementation's accepted placeholder identifier. If JoFotara rejects that shape, stop and amend this plan with the exact proven customer fields and corresponding customer CRUD/schema changes before Phase 1. Do not guess a mandatory identity schema.

### Subscription collection ledger

Create only one new financial table:

```sql
CREATE TABLE subscription_collections (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_id BIGINT UNSIGNED NOT NULL,
  shift_id INT NOT NULL,
  received_by INT NOT NULL,
  kind ENUM('collection','reversal') NOT NULL DEFAULT 'collection',
  cash_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  card_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  amount_tendered DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  change_due DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  business_date DATE NOT NULL,
  reverses_collection_id BIGINT UNSIGNED NULL,
  reason VARCHAR(255) NULL,
  idempotency_key VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscription_collections_idempotency (idempotency_key),
  UNIQUE KEY uq_subscription_collections_reversal (reverses_collection_id),
  KEY idx_subscription_collections_subscription (subscription_id, kind, id),
  KEY idx_subscription_collections_shift (shift_id, business_date, id),
  KEY idx_subscription_collections_date (business_date, kind, id),
  CONSTRAINT fk_subscription_collections_subscription
    FOREIGN KEY (subscription_id) REFERENCES customer_subscriptions(id),
  CONSTRAINT fk_subscription_collections_shift
    FOREIGN KEY (shift_id) REFERENCES shifts(id),
  CONSTRAINT fk_subscription_collections_user
    FOREIGN KEY (received_by) REFERENCES users(id),
  CONSTRAINT fk_subscription_collections_reversal
    FOREIGN KEY (reverses_collection_id) REFERENCES subscription_collections(id),
  CONSTRAINT chk_subscription_collections_amount
    CHECK (
      cash_amount >= 0 AND card_amount >= 0
      AND amount_tendered >= 0 AND change_due >= 0
      AND cash_amount + card_amount > 0
      AND (
        (kind='collection' AND amount_tendered >= cash_amount + card_amount AND change_due = amount_tendered - cash_amount - card_amount)
        OR
        (kind='reversal' AND amount_tendered=0 AND change_due=0)
      )
    ),
  CONSTRAINT chk_subscription_collections_reversal_shape CHECK (
    (kind='collection' AND reverses_collection_id IS NULL)
    OR
    (kind='reversal' AND reverses_collection_id IS NOT NULL AND CHAR_LENGTH(TRIM(reason)) > 0)
  )
);
```

Amounts remain positive; `kind` supplies the sign. `cash_amount` and `card_amount` are the net amounts applied to the debt and drawer. `amount_tendered` follows the existing checkout convention: for split payments it is the combined card amount plus physical cash tendered, so `change_due = amount_tendered - cash_amount - card_amount`; it is not cash-only tender. This preserves deterministic reprints without inventing a second payment vocabulary. A reversal must exactly mirror the original cash/card amounts and stores zero tender/change. No route may update or delete ledger rows. `invoice_id` is deliberately absent: the authoritative invoice is already uniquely reachable through `customer_subscriptions.purchase_invoice_id`, so storing it again would permit mismatched subscription/invoice pairs.

### Migration authority

Create:

- `backend/migrations/2026-07-29-subscription-receivables-preflight.sql`
- `backend/migrations/2026-07-29-subscription-receivables.sql`
- `backend/migrations/2026-07-29-subscription-receivables-verify.sql`

Update in the same schema commit:

- `backend/tests/fixtures/seed.js`
- `deployment/database/baseline.sql`
- `deployment/tools/bootstrap-database.js`
- `backend/services/schemaValidation.js`
- `backend/tests/unit/schemaAuthority.test.js`
- `backend/tests/integration/installerBaseline.test.js`
- `deployment/database/manifest.json`: keep `migrations: []`, update the baseline checksum after changing `baseline.sql`, and retain the current fresh-installer policy because `scripts/build-installers.ps1` deliberately excludes backend migration files while packaging `deployment/database`.

Backfill behavior is intentionally trivial: all existing orders receive `payment_due_on=NULL`; no existing order is converted to receivable; all existing subscriptions preserve their current origin.

The `orders` enum/check alteration may rebuild or lock the table on the deployed MariaDB version. Before applying it to any existing restaurant, rehearse it against a recent database copy, record duration and disk growth, take a verified backup, schedule a maintenance window, stop application writes, and run preflight/apply/verify. Do not claim `ALGORITHM=INPLACE` support without confirming it on the bundled MariaDB version.

---

## 4. Financial report contract

Do not silently redefine existing fields. Add explicit receivable values and only combine them in drawer totals where cash really moved.

| Output | Issue date | Due date | Collection date |
|---|---:|---:|---:|
| Gross/net sales and tax | Count receivable invoice | No effect | No second sale |
| Cash sales/card sales | Immediate tenders only | No effect | Do not call collection a sale |
| Receivable issued | Invoice total | No effect | No effect |
| Outstanding receivables | Opening/closing balance | Used for overdue label | Reduced by collection |
| Receivable cash/card collections | No effect | No effect | Count by real shift/day |
| Expected drawer cash | No receivable amount at issue | No effect | Add cash collection; subtract cash reversal/refund |
| JoFotara | Submit one receivable invoice | No resubmission | No second invoice |
| Subscription entitlement | Starts per explicit period | No effect | Payment does not reset credits/dates |

Create shared helpers in `backend/services/financialSql.js`:

- signed collection amount SQL;
- `getSubscriptionCollectionsByShift(executor, shiftIds, range?)` returning cash/card/net/reversal counts;
- `getSubscriptionCollectionRangeTotals(executor, range)` for daily/audit reports;
- outstanding-balance SQL scoped to one subscription/invoice.

Wire, with focused assertions, every current consumer identified by `rg`:

- `backend/routes/auth.js`
- `backend/routes/admin/shifts.js`
- `backend/routes/admin/reports.js`
- `backend/routes/admin/auditReports.js`
- `backend/routes/print.js`
- `backend/services/auditReportBuilder.js`
- `backend/services/expenseService.js`
- `backend/services/financeMetrics.js`
- `backend/services/financialEventMetrics.js`
- `backend/services/shiftMetrics.js`
- `backend/services/dailyReportBuilder.js` and its dimension/detail builders where payment totals are exposed
- `backend/services/dailyReportDimensions.js`
- `backend/services/dailySalesDetailsBuilder.js`
- `backend/services/dailyRefundReportBuilder.js`
- `backend/services/categoryItemsReportBuilder.js`
- `backend/services/productSalesMetrics.js`
- `backend/services/subscriptionMetrics.js`
- `backend/routes/admin/customers.js`
- `backend/routes/admin/orders.js`

Classify each consumer before changing it:

1. **Sales consumer:** include the receivable invoice at issue time; do not add later collections.
2. **Tender/drawer consumer:** keep immediate order tenders and add signed collection movement separately.
3. **Legal-finalized guard:** treat receivable as finalized where appropriate, without treating it as cash-paid.
4. **Unrelated consumer:** prove no change is required with a focused assertion or source note; do not mechanically edit it.

Delete `calculateSubscriptionMetrics()` from `SubscriptionService.js` only after `rg` and tests prove it has no production caller; otherwise convert its date filter to canonical business-range parameters rather than leaving a second calendar-date implementation.

Subscription admin metrics should expose separate keys:

- `subscription_sales_issued`
- `subscription_immediate_collections`
- `subscription_receivable_collections`
- `subscription_outstanding`
- `subscription_overdue_count`
- existing redemption/deferred-value metrics

Do not keep the ambiguous label “Subscription Collections” pointing at invoice revenue.

---

## 5. TDD execution phases

Each phase is a separate commit. Start with the named failing tests, implement only enough to pass, then run the focused command. Do not run the whole suite after every small step; run it at the release gate.

For every phase, follow this checklist before moving forward:

- [ ] Re-read the phase scope and inspect every listed production caller.
- [ ] Write the smallest failing contract/adversarial test first.
- [ ] Run the focused test and confirm it fails for the intended missing behavior, not fixture drift.
- [ ] Implement the smallest deep change at the existing ownership seam.
- [ ] Run the phase's complete focused command and make it green.
- [ ] Inspect `git diff --check`, `git diff --stat`, and the actual diff for scope creep, duplicated money logic, client authority, and stale paths.
- [ ] Commit only the phase files with the phase commit message; do not mix unrelated existing work.

### Phase 0 — Validate the legal/JoFotara contract and freeze the feature flag

**Files:**

- Modify: `backend/config/taxRegistration.js`
- Modify: `backend/services/JofotaraXmlBuilder.js`
- Test: `backend/tests/integration/jofotara.test.js`
- Test: `backend/tests/unit/jofotaraXmlBuilder.test.js` (create if the builder has no focused unit file)
- Document: `docs/JOFOTARA-RECEIVABLE-VALIDATION.md`

**Red tests:**

1. Sales-tax receivable snapshot emits `InvoiceTypeCode name="022"` and value `388`.
2. Income-tax receivable snapshot emits `name="021"` and value `388`, but stays disabled until controlled live acceptance is obtained because the production reference does not verify this path.
3. Cash snapshots remain `012`/`011` byte-for-byte except for deliberately added fields.
4. Receivable issuance rejects missing proven-required buyer fields with a stable public code.
5. Credit note for a receivable keeps the original tax registration profile and billing reference but uses the existing configured return name (`012` sales-tax return or `011` income-tax return), never `022`/`021` without new live evidence.

**Implementation:**

- Make invoice payment terms an explicit builder input derived from the persisted order, never the request body.
- Add constants for cash and receivable variants per tax profile.
- Extend snapshot validation and frozen documents; do not infer receivable from zero cash. Build the receivable customer from the order's frozen buyer snapshot, not the mutable `customers` row.
- Validate one representative XML per tax profile against the official guide. JoFotara has no known public sandbox: controlled live validation must use an authorized real test invoice or direct ISTD/accountant confirmation. Record sanitized request/result evidence in the document and never issue a fake live invoice merely to satisfy a test.
- Keep a server setting such as `subscription_receivables_enabled=0` by default. It may be enabled only after this phase’s external validation passes.
- A change to the active `tax_registration_type` must atomically reset `subscription_receivables_enabled=0`. Re-enabling requires validation evidence for the newly active profile. This blocks an already-enabled sales-tax store from silently issuing unvalidated income-tax receivables after a settings change; disabling issuance must not affect existing-debt operations.
- Keep current credit-note construction on `011`/`012`; Phase 0 adds regression tests around it but must not alter its code unless an existing defect is independently proven.

**Focused test:**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js backend/tests/unit/jofotaraXmlBuilder.test.js
```

**Stop condition:** If the active profile's invoice code or minimum buyer shape cannot be externally validated, do not enable that profile in production. The executor may continue the remaining code, schema, and local verification behind `subscription_receivables_enabled=0`, recording the profile as unvalidated. If validation proves that new buyer schema is required, stop before expanding schema and amend the plan with the exact evidence. Keep paid-now/manual workflows unchanged. Credit notes retain the already proven configured `011`/`012` return path; do not invent a receivable return code.

### Phase 1 — Add schema authority and derived collection math

**Files:** migration/baseline/fixture/schema files listed in Section 3; modify `backend/services/financialSql.js`; add `backend/tests/unit/subscriptionCollectionMath.test.js`.

**Red tests:** schema preflight rejects drift; migration is idempotent/checksummed; verify script catches a missing column/index/check; fixture and baseline match; signed collection math yields unpaid/paid/partial/reversed balances without floating drift.

**Implementation:** apply the exact Section 3 schema; add `subscription_receivables_enabled=0` and the `pos.subscription_credit` permission to migration/baseline/bootstrap/schema authority; use decimal values and existing money rounding; add query helpers but do not wire routes yet.

**Focused test:**

```powershell
node scripts/validate-schema-drift.js
npx vitest run backend/tests/unit/schemaAuthority.test.js backend/tests/integration/installerBaseline.test.js backend/tests/unit/subscriptionCollectionMath.test.js
```

### Phase 2 — Teach canonical checkout to issue subscription receivables

**Files:**

- Modify: `backend/services/CheckoutValidation.js`
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `backend/services/SubscriptionService.js`
- Modify: `backend/routes/pos/checkout.js`
- Modify: `backend/services/PermissionService.js` and permission seed/bootstrap locations
- Test: `backend/tests/integration/subscriptionPurchase.test.js`
- Test: `backend/tests/integration/checkout.test.js`
- Test: `backend/tests/unit/checkoutModuleWiring.test.js`

**Red tests:**

1. Paid-now subscription behavior remains unchanged.
2. `receivable` is rejected for non-subscription carts, table orders, split checks, edits, and ordinary products.
3. Receivable subscription requires the credit permission, customer/buyer fields, active plan, one canonical plan product, valid explicit due date, and server-calculated totals.
4. Cash/card/split rejects `payment_due_on`; receivable rejects any tender/change.
5. Start/end/due dates cannot alter server invoice time or collection fields.
6. Cashier receivable issuance binds their actual open shift; spoofed/closed/other-user shift is rejected or replaced according to the stricter receivable rule.
7. Admin receivable issuance may have `shift_id=NULL`; it still records the authenticated issuer.
8. Duplicate idempotency key returns the same order and subscription.
9. Concurrent duplicate issuance creates one invoice/subscription.
10. Receivable reason and due date cannot be edited after issuance, and frozen buyer fields do not change when the customer record changes.
11. The checkout route permits a missing/empty client cart only for a valid receivable `subscription_purchase`; every other empty cart keeps the current rejection.

**Implementation:**

- Add a strict subscription-only receivable branch to `executeCheckout`; do not generalize credit checkout.
- In that branch only, derive the one cart line from the locked plan's `sale_product_id`; ignore client `cart`, `subtotal`, `tax`, `total`, price, tender, and change anchors and replace them with the canonical database product plus server pricing/tax calculation. The HTTP route may bypass its empty-cart rejection only after recognizing this narrow intent shape. This lets Admin and POS use one deep checkout interface without duplicating tax-inclusive math. Paid-now checkout retains its existing cart/submitted-total anti-tamper anchors.
- Require an open shift for POS cashier issuance. Allow admin dashboard issuance without money and without a shift.
- Set invoice fields server-side: `payment_method='receivable'`, zero tenders, canonical issue time, validated due date, normalized reason, and buyer snapshot loaded from the locked customer.
- Reuse the existing manager-override interface for a cashier who lacks direct credit permission, and persist the approving manager in the audit event.
- Rename `createSubscriptionFromPaidOrder` to the truthful `createSubscriptionFromInvoicedOrder` (or add an explicit accepted-payment argument) and accept only cash/card/split/receivable. Preserve invoice uniqueness and entitlement snapshot behavior.
- Reuse existing order pricing, tax, item, invoice sequence, audit, print and post-commit paths.
- Audit `subscription_receivable_issued` with invoice, customer, plan, due date, issuer, and shift, but no client-supplied money metadata.
- Keep the existing order permanently marked `receivable`; settlement state is derived from the collection ledger.

**Focused test:**

```powershell
npx vitest run backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/checkout.test.js backend/tests/unit/checkoutModuleWiring.test.js
```

### Phase 3 — Make JoFotara operations and customer receipts receivable-aware

**Files:**

- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/services/JofotaraXmlBuilder.js`
- Modify: `backend/services/ReceiptPresentation.js`
- Modify: `backend/services/ReceiptPresentationSources.js`
- Modify: `backend/services/printDocumentModel.js`
- Modify: `backend/services/printDocumentCompiler.js`
- Modify: `backend/services/printTemplateEngine.js`
- Modify: `backend/services/printTemplateDefaults.js`
- Modify: `pos-spooler-printer/receiptDisplayV1.cjs`
- Modify: `pos-spooler-printer/server.js`
- Test: `backend/tests/integration/jofotara.test.js`
- Test: `backend/tests/integration/printTemplates.test.js`
- Test: `backend/tests/unit/jofotaraXmlBuilder.test.js`
- Test: `backend/tests/unit/receiptPresentation.test.js`
- Test: `backend/tests/unit/receiptPresentationContract.test.js`
- Test: `backend/tests/unit/receiptPresentationParity.test.js`
- Test: `backend/tests/unit/printTemplateEngine.test.js`
- Test: `backend/tests/unit/printTemplateParity.test.js`
- Test: `backend/tests/unit/spoolerReceiptDisplay.test.js`
- Test: `backend/tests/unit/spoolerPackageContract.test.js`

**Red tests:** receivable orders enter JoFotara pending/operations exactly once; type profile is frozen from the order; retry behavior remains safe; customer receipt shows “Receivable,” issue date, due date, invoice total, collected amount, and outstanding balance; no kitchen-ticket change; cash receipt snapshots remain stable.

**Implementation:** include `receivable` in `JofotaraService.loadInvoice`, unresolved/auto-submit selection, `printDocumentModel` finalized-document checks, and compiler receipt eligibility—but never treat it as cash-paid. Extend `receipt_display_v1` and print-template bindings rather than adding spooler money calculations. The initial receipt shows full outstanding. A later collection reprints the same invoice identity/JoFotara QR with a clearly labelled payment section; it does not manufacture a second invoice. Cash/paid templates and kitchen tickets remain unchanged.

**Focused test:**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js backend/tests/integration/printTemplates.test.js backend/tests/unit/jofotaraXmlBuilder.test.js backend/tests/unit/receiptPresentation.test.js backend/tests/unit/receiptPresentationContract.test.js backend/tests/unit/receiptPresentationParity.test.js backend/tests/unit/printTemplateEngine.test.js backend/tests/unit/printTemplateParity.test.js backend/tests/unit/spoolerReceiptDisplay.test.js backend/tests/unit/spoolerPackageContract.test.js
```

### Phase 4 — Add admin receivable issuance and immediate visibility

**Files:**

- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `src/admin/components/SubscriptionAssignmentModal.vue`
- Modify: `src/admin/pages/Subscriptions.vue`
- Modify: `src/admin/components/SubscriptionDetailDrawer.vue`
- Modify: `src/shared/i18n.js`
- Test: `backend/tests/integration/subscriptionManagement.test.js`
- Test: `src/admin/pages/__tests__/subscriptionsPage.spec.js`
- Test: `src/admin/pages/__tests__/subscriptionsLocalization.spec.js`

**Red tests:**

1. Manual mode remains null-invoice with mandatory reason and no payment fields.
2. Receivable mode calls canonical checkout issuance, not a second SQL implementation.
3. Admin receivable appears in list/detail immediately with invoice number, issuer, issued date, due date, original amount, collected amount, outstanding amount, and unpaid/overdue/paid state.
4. State/search filters can select outstanding and overdue without confusing entitlement `pending` with billing `unpaid`.
5. Admin cannot post a collection from the dashboard.
6. Mobile list/detail retains all high-risk facts without horizontal dependence.
7. The feature toggle cannot be enabled until the current tax profile's validation evidence is recorded; disabling it blocks new receivables but never hides or disables collection of existing debt.
8. Changing `tax_registration_type` atomically disables new receivable issuance; a failed settings write cannot leave the new profile paired with the old enablement state.

**Implementation:** make the Add Subscription modal choose exactly `Manual / complimentary` or `Pay later / receivable`. Manual mode continues to POST `/api/admin/subscriptions`. Receivable mode constructs only the customer/plan/date/due/reason intent and POSTs the existing `/api/pos/checkout` route with an idempotency key and `subscription_purchase.payment_terms='receivable'`; server checkout constructs the canonical line and totals. It must not add a second admin SQL issuance route or duplicate POS pricing math. Do not add “cash received” to admin. Keep entitlement state and billing state as separate columns/badges. Add overview cards for outstanding and overdue. Add the guarded feature toggle alongside the existing JoFotara/settings ownership, not as an unprotected client flag. Save a tax-profile change and the forced receivable-disable in one database transaction.

**Focused test:**

```powershell
npx vitest run backend/tests/integration/subscriptionManagement.test.js src/admin/pages/__tests__/subscriptionsPage.spec.js src/admin/pages/__tests__/subscriptionsLocalization.spec.js
```

### Phase 5 — Add POS pay-later choice and full-balance collection

**Files:**

- Modify: `backend/routes/pos/subscriptions.js`
- Modify: `backend/services/SubscriptionService.js`
- Modify: `src/components/pos/SubscriptionModal.vue`
- Modify: `src/components/pos/CheckoutModal.vue` only if its existing payment controls can be reused without a dependency bag
- Modify: `src/pos/stores/orderSessionStore.js`
- Modify: `src/pos/stores/orderSession/orderSessionApi.js`
- Modify: `src/pos/stores/orderSession/checkoutFlow.js`
- Modify: `src/pos/useCart.js` only for a required stable facade method
- Test: `backend/tests/integration/subscriptionCollections.test.js` (new)
- Test: `src/components/pos/__tests__/subscriptionModal.spec.js`
- Test: order-session boundary/store tests

**Red tests:**

1. Customer lookup returns receivable billing facts alongside entitlements.
2. An unpaid receivable subscription remains redeemable within its dates/credits.
3. Collection requires the exact customer/subscription, credit invoice, current open shift, permission, and full outstanding amount.
4. Server ignores/rejects supplied shift, business date, received-by user, invoice date, and alternate amount.
5. Future due date plus collection today records today’s server business date and current shift.
6. Cash, card, and split collection validate exactly; no applied overpayment, zero payment, or partial V1 payment.
   Cash and split may accept excess physical cash tender only when `change_due` exactly reconciles under the existing combined-tender convention; the debt and drawer receive the net cash amount, while tender/change are retained for receipt reprints.
7. Duplicate idempotency key returns the original collection.
   If the same key belongs to another subscription or actor, return a stable conflict without revealing the other collection payload.
8. Two concurrent full-collection attempts lock subscription/invoice/ledger deterministically and only one succeeds.
9. Collection creates no order, order item, subscription, invoice number, or JoFotara document.
10. Successful collection emits `subscription_changed` and `shifts_changed`, returns updated balance, and queues the updated customer receipt.

**Implementation:**

- Add `POST /api/pos/subscriptions/:id/collections`.
- Resolve the subscription owner before the transaction with a plain read, then lock in the same order used by redemption/checkout: authenticated open shift, customer, subscription, purchase order, existing collection rows. Recheck idempotency after the customer lock. Document and keep this order in reversal/refund paths.
- Derive outstanding under lock and require V1 payment total to equal it.
- Insert one collection ledger row with server actor/shift/time/business date and unique idempotency key.
- Keep cash/card amounts off the original order.
- In the POS subscription workspace, show `Redeem`, `Sell/Renew`, and an outstanding-payment panel after exact phone lookup. “Collect payment” uses a compact cash/card/split control and clearly states invoice date versus due date.
- Pay-later issuance is visible only with `pos.subscription_credit`; ordinary paid sale remains on the current checkout.

**Focused test:**

```powershell
npx vitest run backend/tests/integration/subscriptionCollections.test.js backend/tests/integration/subscriptionRedemptions.test.js src/components/pos/__tests__/subscriptionModal.spec.js backend/tests/unit/orderSessionStore.test.js backend/tests/unit/orderSessionBoundaries.test.js
```

### Phase 6 — Wire shift, Z/X, daily, audit and admin financial outputs

**Files:** all report consumers in Section 4 and their existing tests.

**Red test matrix:** seed (a) JOD 100 receivable issued on Day A/Shift A, due Day C, (b) JOD 100 collected cash on Day B/Shift B, then assert:

- Day A sales/tax includes 100; cash/card sales includes 0; outstanding includes 100.
- Shift A sales includes 100; expected cash does not.
- Day B sales includes 0 from this event; receivable cash collections includes 100.
- Shift B expected cash increases 100; cash sales remains separately identifiable.
- Due date changes no sales or drawer value.
- JoFotara has one invoice.
- Subscription KPI does not count 200.
- Z/X and printed report expose the collection separately and reconcile the drawer.

Add card, split, reversal, refund and cross-business-day variants. Keep all aggregation in shared helpers; route code only composes labelled outputs.

**Focused tests:**

```powershell
npx vitest run backend/tests/integration/auditReports.test.js backend/tests/integration/businessDayReconciliation.test.js backend/tests/integration/adminOrdersStats.test.js backend/tests/integration/dailyReportsAdversarial.test.js backend/tests/integration/dailyReportsExpenses.test.js backend/tests/integration/dailyReportsSalesDetails.test.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/expenses.test.js backend/tests/unit/dailyReportMath.test.js backend/tests/unit/dailyReportPrintContract.test.js backend/tests/unit/expenseMetrics.test.js backend/tests/unit/subscriptionMetrics.test.js
```

### Phase 7 — Cancellation, refund and collection reversal

**Files:**

- Modify: `backend/services/RefundService.js`
- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/routes/pos/subscriptions.js`
- Modify: `backend/services/SubscriptionService.js`
- Modify: detail/POS UI actions
- Test: `backend/tests/integration/subscriptionManagement.test.js`
- Test: `backend/tests/integration/subscriptionCollections.test.js`
- Test: `backend/tests/integration/refunds.test.js`
- Test: `backend/tests/integration/jofotara.test.js`
- Test: `backend/tests/unit/refundVoidModuleWiring.test.js`

**Rules and red tests:**

- Active redemptions must still be reversed before cancelling/refunding a subscription sale.
- Uncollected receivable cancellation records no cash refund, closes the entitlement, and queues one credit note with the original tax profile plus configured `011`/`012` return code.
- Collected receivable refund allocates from the persisted collection tender, uses the refunding user’s current open shift, returns money once, and submits one credit note using the existing configured `011`/`012` return code.
- Mistaken collection reversal appends a linked reversal with matching tender, current shift, actor, server date and mandatory reason; it restores outstanding balance and never alters the original row.
- A collection can be reversed once; a refunded/cancelled invoice cannot be collected; a reversed collection cannot be reversed again.
- Concurrent refund/reversal/collection races serialize and produce one legal end state.
- Existing paid-now and manual refund behavior remains unchanged.

The admin dashboard may cancel a completely uncollected receivable because no drawer moves. Any cash/card refund or collection reversal must be completed from POS with an open shift. Do not silently keep the current admin-only money button and reuse the original sale shift: `RefundService.js` currently writes `order.shift_id`, which is wrong for a later drawer event. Pass an explicitly server-resolved current refund shift for this managed subscription path and test that ordinary refund behavior is not accidentally broadened.

If the original JoFotara invoice is pending/rejected/unknown, save the local cancellation/refund once and surface both documents in JoFotara Operations. The credit note must wait for the original to be accepted so it can reference the accepted UUID. Never drop the return, guess a UUID, or blindly retry an unknown original.

Do not treat a collection reversal as a sales refund. Keep the audit names and report columns distinct.

**Focused test:**

```powershell
npx vitest run backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionCollections.test.js backend/tests/integration/refunds.test.js backend/tests/integration/jofotara.test.js backend/tests/unit/refundVoidModuleWiring.test.js
```

### Phase 8 — Browser workflows, deployment safety and release gate

**Files:**

- Create: `tests/e2e/specs/subscription-receivables.spec.js`

**Browser workflows (desktop and narrow mobile):**

1. Cashier sells a paid-now subscription; existing workflow/receipt is unchanged.
2. Authorized cashier issues a receivable due at month end; it is immediately visible in admin and redeemable.
3. Unauthorized cashier cannot issue credit but can still sell/redeem normally.
4. Admin issues receivable without shift; no drawer changes.
5. Cashier finds customer by phone and redeems while unpaid.
6. Cashier collects today against a future due date; admin shows paid today and reports place cash in today’s shift.
7. Overdue receivable is prominent in admin and POS lookup.
8. Duplicate-click/network retry cannot duplicate invoice or collection.
9. Refund and reversal workflows show reasons and correct balances.
10. Customer thermal receipt matches `receipt_display_v1`; kitchen ticket is unchanged.
11. Editing the customer after issuance does not change the receivable's JoFotara buyer snapshot or reprinted receipt identity.
12. Disabling new receivable issuance leaves existing receivables visible, redeemable, collectible, reversible, refundable, and reportable.

**Focused browser test:**

```powershell
npx playwright test tests/e2e/specs/subscription-receivables.spec.js
```

**Release checks:**

```powershell
node scripts/validate-schema-drift.js
npm run architecture:check
npm run test:unit
npm run build:admin
npm run test:installer
```

Run the relevant Playwright project/workflows, then perform:

- migration preflight/apply/verify on a disposable copy of a real schema;
- fresh installer baseline creation and schema validation;
- database backup and restore rehearsal;
- configured JoFotara receivable invoice and credit-note validation for both enabled tax profiles;
- spooler customer-receipt check for issue, collection and refund;
- Z/X reconciliation with cash, card, split, reversal and expense events;
- feature-disable test proving existing paid/manual workflows continue if receivables remain disabled.

Do not enable `subscription_receivables_enabled` by default until every release gate passes.

---

## 6. Plan attack results

The plan was attacked against these likely failure modes:

- **Future due date used to hide today’s cash:** impossible through API fields; a collection uses server time and locked current shift. Choosing receivable instead leaves a visible outstanding debt and audit trail.
- **Double sale on collection:** prevented because collection inserts only a ledger row and reuses the original invoice identity.
- **Revenue/cash timing conflated:** prevented by the report matrix and separate collection rollups.
- **Admin cash without shift:** forbidden; admin dashboard can issue debt only.
- **Entitlement accidentally blocked while unpaid:** receivable is an invoiced subscription and remains redeemable; billing state is separate from entitlement state.
- **Manual subscription mistaken for debt:** manual rows have no invoice and retain their existing required reason/source.
- **Mutable balance drift:** no balance/status column; derive under lock from invoice plus signed ledger.
- **Duplicate/racing collection:** unique idempotency plus deterministic `FOR UPDATE` locks and exact-outstanding validation.
- **JoFotara cash code reused:** Phase 0 and frozen order profile explicitly gate `021`/`022`.
- **Receivable return code guessed:** corrected; credit notes retain configured `011`/`012` and type `381` unless separately proven otherwise.
- **Customer edited before delayed submission:** frozen buyer-at-sale fields drive JoFotara and receipt presentation.
- **Collection references wrong invoice:** `invoice_id` was removed from the ledger; the invoice is derived through the subscription's unique purchase link.
- **Second JoFotara document on collection:** collection is excluded from JoFotara document creation.
- **Old reports silently wrong:** every cash/card/order consumer found by `rg` is in the Phase 6 inventory, with a two-day test matrix.
- **Installer/schema drift:** migration, fixture, baseline, bootstrap ledger, runtime validation and installer test change together.
- **Overengineering:** one new ledger table, no generic AR framework, no partial UI, no new controller/repository layers, and canonical checkout is reused.

Remaining external uncertainties are intentionally stop gates, not guesses:

1. configured JoFotara acceptance of receivable buyer fields and both tax-profile codes;
2. the restaurant accountant’s preferred wording/presentation for receivable collections and credit-note timing;
3. physical thermal output for the updated customer receipt.

**Honest pre-execution rating:** 9/10 as a design. It is materially safer than adding a due-date field to the current subscription row. It is not a small change: the report/refund/JoFotara phases are mandatory because the feature separates sale time from cash time. Skipping any of them would reduce it below production quality.
