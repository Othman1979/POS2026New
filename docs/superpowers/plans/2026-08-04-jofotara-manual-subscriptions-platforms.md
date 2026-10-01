# Manual JoFotara Subscriptions and Platforms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make subscription purchases, subscription returns, finalized platform orders, and platform returns manually submit-able only through JoFotara Operations.

**Architecture:** Freeze special-source buyer identity at invoice finalization, then deepen the existing `JofotaraService` policy seam: classify invoice origin from authoritative database state, enforce submission surface inside the locked preparation transaction, and reuse the existing document/idempotency machinery. Operations gains source metadata, filtering, and a client-driven manual batch; subscription collections and platform reconciliation remain untouched.

**Tech Stack:** Node.js, Express, MySQL/MariaDB, Vue 3, Vitest/Supertest.

## Global Constraints

- **NUMBER ONE RULE: subscription and platform invoices and returns are never submitted automatically. They can be initiated only from JoFotara Operations.**
- Ordinary register and completed-table checkout automation remains unchanged.
- Platform close and subscription activation create zero JoFotara documents.
- A restored platform-typed hold paid through ordinary cash/card/split checkout remains a standard sale and may use the existing automatic JoFotara flow.
- Never infer platform fiscal treatment from `order_type_id` or `is_deferred_settlement`; only finalized `payment_method='platform'` selects Operations-only handling.
- Collection, redemption, remittance, allocation, adjustment, commission, reversal, and refund creation create zero JoFotara documents.
- Operations submission is manual and explicit; accepted and unknown documents are never batch-retried.
- A platform sale uses receivable JoFotara payment terms.
- A subscription purchase uses its frozen order payment terms.
- Never alter invoice totals for platform commissions or adjustments.
- Never automatically reprint after later JoFotara acceptance.
- Reuse `jofotara_documents`; add no queue or source table.
- The buyer-snapshot constraint migration must be wired into the normal migration, automatic repair chain, Hostinger fallback file, fresh baseline, installer manifest, and schema validation under the project migration rule.

## Evidence Baseline

- The authorized JoFotara PDF defines separate cash and receivable invoice codes and requires returns to reference the original invoice ID, UUID, and total. It does not define remittance or commission documents as customer sales invoices.
- `executeCheckout.js` finalizes platform holds as `payment_method='platform'` with zero tender and creates subscription purchases as ordinary finalized orders linked through `customer_subscriptions.purchase_invoice_id`.
- Restoring a held order and checking it out normally uses the selected ordinary payment method; retaining the Talabat/Careem order type does not make that paid invoice a platform receivable.
- `JofotaraService.js` currently excludes subscription/platform rows from automatic recovery, but Operations lists subscription purchases implicitly and the manual loader rejects platform payment method.
- `JofotaraService.js` currently treats only `receivable` as receivable payment terms, so platform XML would be wrong without an explicit correction.
- `SubscriptionDetailDrawer.vue` currently submits subscription returns outside Operations.
- `PlatformRemittanceService.js` owns remittances, allocations, commissions, adjustments, and reversals without creating orders; those records must stay outside JoFotara.
- `RefundService.js` persists platform/customer refunds against the originating invoice, and `prepareCreditNote()` already requires the accepted original document.
- `orders.buyer_*_at_sale` is currently populated only for receivable subscriptions; paid subscriptions and platforms could otherwise read a later-mutated customer row during delayed manual submission.

---

### Task 1: Freeze buyer identity for every special-source invoice

**Files:**
- Modify: `backend/modules/checkout/executeCheckout.js`
- Modify: `deployment/database/baseline.sql`
- Modify: `deployment/database/manifest.json`
- Modify: `deployment/database/hostinger-manual-migrations.sql`
- Modify: `backend/migrations/auto-manifest.json`
- Modify: `backend/services/schemaValidation.js`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `deployment/tools/bootstrap-database.js`
- Create: `backend/migrations/2026-08-04-special-source-buyer-snapshots.sql`
- Create: `backend/migrations/2026-08-04-special-source-buyer-snapshots.auto.sql`
- Test: `backend/tests/integration/subscriptionPurchase.test.js`
- Test: `backend/tests/integration/platformHeldSettlement.test.js`
- Test: `backend/tests/unit/automaticMigrations.test.js`
- Test: `backend/tests/integration/installerBaseline.test.js`

**Interfaces:**
- Produce: frozen `orders.buyer_name_at_sale`, `buyer_phone_at_sale`, and `buyer_address_at_sale` for invoiced subscription purchases and finalized platform orders.
- Preserve: receivable due-date/reason/tender constraints.

- [ ] **Step 1: Write failing persistence tests**

Create cash, card, and receivable subscription purchases plus a platform close. Assert each order freezes the customer values supplied at finalization. Update the linked `customers` row afterward and assert the order snapshot remains unchanged.

Add migration tests proving existing subscription/platform orders backfill buyer fields once, ordinary cash orders remain unchanged, and re-running the automatic/fallback migration does not overwrite an existing frozen snapshot.

Update the shared test schema constraint so integration tests exercise the same allowed buyer-snapshot shape as production.

- [ ] **Step 2: Run and verify RED**

```powershell
npx vitest run backend/tests/integration/subscriptionPurchase.test.js
npx vitest run backend/tests/integration/platformHeldSettlement.test.js
npx vitest run backend/tests/unit/automaticMigrations.test.js
npx vitest run backend/tests/integration/installerBaseline.test.js
```

Expected: paid subscriptions/platform orders currently leave buyer snapshot columns null.

- [ ] **Step 3: Write the migration through the configured Luna migration workflow**

Relax `chk_orders_receivable_terms` so due date/reason remain exclusive to `payment_method='receivable'`, while buyer snapshot columns may be present for finalized special-source orders. Backfill only null snapshots for:

```sql
o.payment_method='platform'
OR EXISTS (
  SELECT 1 FROM customer_subscriptions cs
  WHERE cs.purchase_invoice_id=o.invoice_id
)
```

Use the linked `customers` row as the one-time legacy fallback. Register the checksum and required schema evidence. The fallback script must tolerate an already-applied migration without overwriting data. Update `bootstrap-database.js` with the same migration ledger name/checksum because the fresh baseline already contains the final constraint.

- [ ] **Step 4: Freeze snapshots during checkout finalization**

Inside the existing checkout transaction, load/freeze the customer row when either `subscriptionPurchase` or `platformHeldOrderId` is present. Do not add another query if the customer was already loaded for a receivable subscription. Store the frozen fields in the existing order insert/update.

- [ ] **Step 5: Run and verify GREEN**

Run the Step 2 commands. Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add backend/modules/checkout/executeCheckout.js backend/migrations backend/services/schemaValidation.js backend/tests/fixtures/seed.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/unit/automaticMigrations.test.js backend/tests/integration/installerBaseline.test.js deployment/database deployment/tools/bootstrap-database.js
git commit -m "fix(orders): freeze special-source buyers"
```

### Task 2: Codify authoritative source classification and submission surfaces

**Files:**
- Modify: `backend/services/JofotaraService.js`
- Test: `backend/tests/integration/jofotara.test.js`

**Interfaces:**
- Add internal source kinds: `standard`, `subscription`, `platform`.
- Extend: `submitSalesInvoice({ invoiceId, actorUserId, fetchImpl, surface })`.
- Extend: `submitCreditNote({ refundId, actorUserId, fetchImpl, surface })`.
- Supported surfaces: `automatic`, `order`, `operations`.
- Only `operations` may submit `subscription` or `platform` sources.

- [ ] **Step 1: Write failing policy tests**

Cover all matrix cells:

| Source | automatic | order | operations |
|---|---:|---:|---:|
| standard | allowed by existing cutoff policy | allowed | allowed |
| subscription | rejected/not required | rejected | allowed |
| platform | rejected/not required | rejected | allowed |

Also assert client-provided source labels cannot affect classification, admin-granted subscriptions have no candidate, and platform payment terms render the profile-specific receivable code (`021`, `022`, or `023`). Pin the decisive distinction with two otherwise-identical held orders using the same deferred provider order type: bulk-close one as `payment_method='platform'` and classify it `platform`; restore and pay the other by cash/card/split and classify it `standard` with the existing automatic policy.

- [ ] **Step 2: Run and verify RED**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js -t "submission surface|platform receivable|subscription operations"
```

- [ ] **Step 3: Implement the policy inside the existing module**

Extend the locked invoice query with:

```sql
EXISTS (
  SELECT 1 FROM customer_subscriptions cs
  WHERE cs.purchase_invoice_id=o.invoice_id
) AS subscription_purchase
```

Classify platform only from the persisted `payment_method='platform'`; never inspect the order type flag for fiscal source classification. Reject an impossible platform/subscription dual classification as corrupt data. Permit `payment_method='platform'` in the manual invoice loader. Change payment terms to:

```js
const paymentTermsFor = order =>
  ['receivable', 'platform'].includes(order?.payment_method) ? 'receivable' : 'cash';
```

Load buyer fields with `COALESCE(o.buyer_name_at_sale, c.name)`, `COALESCE(o.buyer_phone_at_sale, c.phone)`, and `COALESCE(o.buyer_address_at_sale, c.address)` so new special-source rows use immutable values and legacy rows retain a best-effort fallback. Build the JoFotara customer object when any resolved buyer field exists; do not require `customer_id`, because a platform hold may carry a diner name without a phone/customer row.

Require `surface` at every submit call. Enforce the source/surface matrix after the order is locked and before creating or transitioning a document. Do not accept the surface from a request body.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/JofotaraService.js backend/tests/integration/jofotara.test.js
git commit -m "feat(jofotara): classify manual fiscal sources"
```

### Task 3: Make Operations the only special-source submission route

**Files:**
- Modify: `backend/routes/admin/jofotara.js`
- Modify: `backend/tests/integration/jofotara.test.js`

**Interfaces:**
- Add: `POST /api/admin/jofotara/operations/invoices/:invoiceId/submit`.
- Add: `POST /api/admin/jofotara/operations/refunds/:refundId/submit`.
- Preserve existing invoice/refund submit routes for standard Orders-page documents only.

- [ ] **Step 1: Write failing route tests**

Assert:

- Special sources return `409 JOFOTARA_OPERATIONS_REQUIRED` from the existing direct routes.
- The Operations routes submit them.
- The Operations routes require admin authentication/authorization through the existing admin router.
- A forged request body such as `{ "source_kind": "standard" }` changes nothing.
- Accepted replay returns stored state without a network call.
- Unknown state remains blocked.

- [ ] **Step 2: Run and verify RED**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js -t "Operations route|OPERATIONS_REQUIRED"
```

- [ ] **Step 3: Wire routes to trusted surfaces**

Pass `surface:'operations'` only from the new Operations routes and `surface:'order'` from existing direct routes. The checkout finalizer passes `surface:'automatic'` internally; never add a public automatic route.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/routes/admin/jofotara.js backend/services/JofotaraService.js backend/tests/integration/jofotara.test.js
git commit -m "fix(jofotara): enforce Operations-only special submissions"
```

### Task 4: Expose truthful Operations candidates and filters

**Files:**
- Modify: `backend/services/JofotaraService.js`
- Modify: `backend/routes/admin/jofotara.js`
- Test: `backend/tests/integration/jofotara.test.js`

**Interfaces:**
- Extend: `getJofotaraOperations({ limit, sourceKind, orderTypeId, status, issuedFrom, issuedTo })`.
- Each item adds: `source_kind`, `order_type_id`, `order_type_name`, `gross_total`, and `invoice_issued_at`.

- [ ] **Step 1: Write failing candidate tests**

Assert:

- Cash/card/receivable subscription purchases appear as `subscription` immediately after activation, including unpaid receivables.
- A finalized platform order appears as `platform` with provider and gross total.
- A restored order carrying the same provider `order_type_id` but finalized as cash/card/split appears as `standard`, not `platform`.
- Admin-granted subscriptions do not appear.
- Collections and redemptions add no candidate/document.
- Remittances, partial allocations, commissions, adjustments, incentives, and reversals add no candidate/document.
- Platform and subscription refunds appear as `waiting_for_original`, then become submit-able only after original acceptance.
- Filters are server validated and parameterized.

- [ ] **Step 2: Run and verify RED**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js
npx vitest run backend/tests/integration/subscriptionPurchase.test.js
npx vitest run backend/tests/integration/platformHeldSettlement.test.js
npx vitest run backend/tests/integration/platformRemittanceTransactions.test.js
```

- [ ] **Step 3: Extend the existing unresolved union**

Derive source kind in SQL from `orders.payment_method` and the authoritative subscription relationship. Join `order_types` only for display. Add `payment_method='platform'` to the not-submitted invoice branch, not to automatic candidates. Propagate the original order source kind to return rows.

Use allowlisted status/source values, positive integer provider IDs, validated ISO dates, and bound SQL parameters. Do not dynamically interpolate client values.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/JofotaraService.js backend/routes/admin/jofotara.js backend/tests/integration/jofotara.test.js backend/tests/integration/subscriptionPurchase.test.js backend/tests/integration/platformHeldSettlement.test.js backend/tests/integration/platformRemittanceTransactions.test.js
git commit -m "feat(jofotara): list manual subscription and platform work"
```

### Task 5: Prove the automatic scanner can never acquire special work

**Files:**
- Modify: `backend/services/JofotaraService.js`
- Test: `backend/tests/integration/jofotara.test.js`
- Test: `backend/tests/integration/checkoutPostCommit.test.js`
- Test: `backend/tests/integration/platformHeldSettlement.test.js`

**Interfaces:**
- Preserve: `prepareCheckoutInvoiceIfAutomatic()` returns `required:false` for subscription/platform.
- Preserve: `processJofotaraOperations()` may recover only ordinary automatic checkout invoices.

- [ ] **Step 1: Add adversarial automatic-leak tests**

Create special-source invoices in each state: no document, `pending`, `rejected`, `unknown`, and `accepted`. Enable automatic submission and age them beyond the recovery threshold. Assert zero provider calls and no status/attempt-count changes for subscription/platform rows.

Also assert platform bulk close and subscription checkout return no required automatic fiscal work and create zero documents. In the same regression, restore a hold from that provider, complete ordinary cash/card/split checkout, and assert the normal automatic checkout path remains eligible.

- [ ] **Step 2: Run tests**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js
npx vitest run backend/tests/integration/checkoutPostCommit.test.js
npx vitest run backend/tests/integration/platformHeldSettlement.test.js
```

Expected before hardening: any missing predicate is exposed.

- [ ] **Step 3: Keep explicit exclusions in both recovery branches**

Both the pending-document branch and missing-document branch must contain:

```sql
o.payment_method <> 'platform'
AND NOT EXISTS (
  SELECT 1 FROM customer_subscriptions cs
  WHERE cs.purchase_invoice_id=o.invoice_id
)
```

The submission service still rechecks `surface:'automatic'` under lock; SQL predicates are selection efficiency, not the only guard.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: all pass with zero special-source fetch calls.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/JofotaraService.js backend/tests/integration/jofotara.test.js backend/tests/integration/checkoutPostCommit.test.js backend/tests/integration/platformHeldSettlement.test.js
git commit -m "test(jofotara): lock manual sources out of automation"
```

### Task 6: Make the Operations UI usable for manual volume

**Files:**
- Modify: `src/admin/pages/JofotaraOperations.vue`
- Modify: `src/shared/i18n.js`
- Test: `src/admin/__tests__/jofotaraOperationsPage.spec.js`

**Interfaces:**
- Consume the new Operations submit routes.
- Consume Operations filters and source metadata.
- Batch is sequential client orchestration over one-document endpoints.

- [ ] **Step 1: Write failing frontend contract tests**

Assert source/provider/status/date filters, source labels, gross totals, selectable submit-able rows, explicit confirmation with selected count/total, Operations route paths, sequential per-row submission, independent result counts, and no selection for accepted/unknown/waiting rows.

Assert the page contains no timer, interval, scheduler, batch backend endpoint, raw XML, credential, or legal snapshot field.

- [ ] **Step 2: Run and verify RED**

```powershell
npx vitest run src/admin/__tests__/jofotaraOperationsPage.spec.js
```

- [ ] **Step 3: Implement the compact Operations controls**

Add source tabs/selector and provider/date/status filters using existing admin grid styles. Add row checkboxes and one “Submit selected” button. Process selected rows with a plain `for...of` loop so each response settles before the next; continue after a rejected item, stop only on authentication loss, and refresh once at the end.

Rename “Check now” to make its scope explicit, such as “Recover automatic sales.” It must not be the control used for selected subscription/platform documents.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add src/admin/pages/JofotaraOperations.vue src/shared/i18n.js src/admin/__tests__/jofotaraOperationsPage.spec.js
git commit -m "feat(admin): manage manual JoFotara work"
```

### Task 7: Remove competing special-source submission controls

**Files:**
- Modify: `src/admin/pages/Orders.vue`
- Modify: `src/admin/components/SubscriptionDetailDrawer.vue`
- Test: `src/admin/pages/__tests__/subscriptionsPage.spec.js`
- Test: `src/admin/__tests__/jofotaraOperationsPage.spec.js`

**Interfaces:**
- Orders retains standard invoice/return controls.
- Subscription details retain read-only JoFotara status and a navigation link to Operations.
- Platform/subscription source submissions exist only in Operations.

- [ ] **Step 1: Write failing UI-boundary tests**

Assert Orders cannot render a direct submit action for `payment_method='platform'` or a purchase invoice flagged as subscription. Assert the subscription drawer has no call to `/jofotara/refunds/:id/submit` and instead navigates to Operations with the relevant invoice/source query.

- [ ] **Step 2: Run and verify RED**

```powershell
npx vitest run src/admin/pages/__tests__/subscriptionsPage.spec.js src/admin/__tests__/jofotaraOperationsPage.spec.js
```

- [ ] **Step 3: Remove only the competing actions**

Keep QR/status display and manual receipt reprint in Orders. Remove special-source send/retry actions outside Operations. Do not remove ordinary order submission.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add src/admin/pages/Orders.vue src/admin/components/SubscriptionDetailDrawer.vue src/admin/pages/__tests__/subscriptionsPage.spec.js src/admin/__tests__/jofotaraOperationsPage.spec.js
git commit -m "fix(admin): centralize special fiscal submissions"
```

### Task 8: Verify returns, reconciliation isolation, printing, and idempotency

**Files:**
- Modify tests only unless a focused defect is exposed.
- Test: `backend/tests/integration/jofotara.test.js`
- Test: `backend/tests/integration/subscriptionManagement.test.js`
- Test: `backend/tests/integration/subscriptionCollections.test.js`
- Test: `backend/tests/integration/platformHeldSettlement.test.js`
- Test: `backend/tests/integration/platformRemittanceTransactions.test.js`
- Test: `backend/tests/integration/print.authz.test.js`

- [ ] **Step 1: Add end-to-end workflow regressions**

Subscription:

1. Activate an unpaid receivable subscription: Operations candidate exists, document does not.
2. Collect it: no new candidate/document.
3. Manually submit original from Operations: accepted once.
4. Cancel/refund: return candidate references original; no automatic call.
5. Manually submit return from Operations: accepted once.

Platform:

1. Close held platform order: customer receipt path remains immediate, candidate exists, document does not.
2. Record remittance with commission/adjustment/partial allocation: no JoFotara mutation.
3. Manually submit sale from Operations: receivable XML and accepted once.
4. Save customer refund: return candidate exists.
5. Manually submit return from Operations: original identity is referenced.

For both flows, later acceptance performs zero spooler calls and accepted replay performs zero provider calls.

- [ ] **Step 2: Run the complete focused suite**

```powershell
npx vitest run backend/tests/integration/jofotara.test.js
npx vitest run backend/tests/integration/subscriptionPurchase.test.js
npx vitest run backend/tests/integration/subscriptionManagement.test.js
npx vitest run backend/tests/integration/subscriptionCollections.test.js
npx vitest run backend/tests/integration/platformHeldSettlement.test.js
npx vitest run backend/tests/integration/platformRemittanceTransactions.test.js
npx vitest run backend/tests/integration/print.authz.test.js
npx vitest run src/admin/__tests__/jofotaraOperationsPage.spec.js src/admin/pages/__tests__/subscriptionsPage.spec.js
npm run build
git diff --check
```

Expected: all pass.

- [ ] **Step 3: Run the static no-leak audit**

```powershell
rg -n "submitSalesInvoice|submitCreditNote|prepareCheckoutInvoiceIfAutomatic|submitCheckoutInvoiceIfAutomatic" backend
rg -n "jofotara/.*/submit" src/admin
rg -n "jofotara" backend/routes/pos/subscriptions.js backend/services/PlatformRemittanceService.js backend/routes/admin/platformRemittances.js
```

Expected:

- Special submission calls exist only in admin JoFotara Operations routes/UI.
- POS subscription and platform reconciliation modules contain no JoFotara submission call.
- Checkout automatic calls remain only in ordinary checkout orchestration and are protected by locked source classification.

- [ ] **Step 4: Commit test closure**

```powershell
git add backend/tests src/admin/__tests__ src/admin/pages/__tests__
git commit -m "test(jofotara): close manual subscription and platform workflows"
```

## Adversarial Review Results Incorporated

1. **Operations currently lists subscription purchases implicitly.** The plan makes source classification explicit instead of adding a second subscription queue.
2. **Platform invoices currently fail manual loading.** The plan permits platform only in manual Operations and maps it to receivable terms.
3. **The subscription drawer currently submits returns directly.** The plan removes that competing path.
4. **A route-only UI restriction is bypassable.** The locked service enforces the trusted submission surface.
5. **A future recovery-query edit could acquire special pending rows.** Both SQL branches and the locked service independently reject them.
6. **Batch submission could become accidental automation.** It is user-selected, sequential, client-driven, and has no timer/queue/scheduler.
7. **Remittance commission could incorrectly reduce fiscal revenue.** Reconciliation modules remain untouched and regression tests assert zero fiscal mutation.
8. **A return can race ahead of its original.** Existing `waiting_for_original` and accepted-original enforcement remain authoritative.
9. **Later acceptance could duplicate printing.** Submission/recovery tests assert zero spooler calls; reprint remains a separate administrator action.
10. **Client source labels could forge eligibility.** Source kind is derived from `orders` plus `customer_subscriptions` under lock.
11. **Manual delay could make buyer identity mutable.** Subscription/platform finalization freezes buyer fields, and the migration backfills legacy special-source invoices once.
12. **A provider order type could incorrectly suppress an ordinary paid checkout.** Fiscal source classification uses finalized payment method only; paired bulk-close versus restored-checkout tests pin the distinction.
