# Subscription Partial Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an uncollected receivable subscription to be cancelled with an administrator-approved reduced balance, while preserving the original invoice and creating an exact saved partial refund.

**Architecture:** Extend the existing managed-subscription refund path instead of creating a second ledger. The original purchase invoice remains immutable; `refunds` and `refund_items` record the cancellation credit, while subscription balance reads consistently subtract saved refunds before collections.

**Tech Stack:** Node.js, Express, MySQL/MariaDB, Vue 3, Vitest/Supertest.

## Global Constraints

- This plan must complete before `2026-08-04-jofotara-manual-subscriptions-platforms.md`.
- Do not submit anything to JoFotara from subscription routes.
- Do not create a subscription adjustment table.
- Do not edit the original order total or order items.
- Initially support partial cancellation only when net collections equal zero; collected subscriptions retain their existing POS refund workflow.
- Admin-granted subscriptions without a purchase invoice remain non-financial.
- Use integer cents for every amount comparison.

---

### Task 1: Make saved refunds part of the subscription balance

**Files:**
- Modify: `backend/services/SubscriptionService.js`
- Modify: `backend/services/subscriptionMetrics.js`
- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/routes/pos/subscriptions.js`
- Test: `backend/tests/unit/subscriptionService.test.js`
- Test: `backend/tests/unit/subscriptionMetrics.test.js`
- Test: `backend/tests/integration/subscriptionCollections.test.js`

**Interfaces:**
- Produces: `billing.original_amount`, `billing.refunded_amount`, `billing.collected_amount`, and `billing.outstanding_amount` where outstanding is `max(0, original - refunded - collected)`.
- Preserves: collection/reversal rows as the cash ledger; refunds remain the fiscal sales-reduction ledger.

- [ ] **Step 1: Write failing projection tests**

Add cases proving a 100.00 receivable with a 50.00 saved refund and no collection reports 50.00 outstanding, and reports zero after a 50.00 collection. Assert cancelled subscriptions can still show `unpaid`, `partial`, or `paid` billing state instead of being forced to `closed` while an amount remains.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run backend/tests/unit/subscriptionService.test.js backend/tests/unit/subscriptionMetrics.test.js
npx vitest run backend/tests/integration/subscriptionCollections.test.js
```

Expected: failures show refunds are omitted from outstanding totals and cancellation forces `closed` too early.

- [ ] **Step 3: Update every subscription balance projection**

Use the same formula in detail, list, dashboard metrics, and mutation-time balance checks:

```sql
GREATEST(
  0,
  COALESCE(o.total, 0)
  - COALESCE(refunds.refunded_amount, 0)
  - COALESCE(collections.collected_amount, 0)
)
```

Add one grouped refund join per read query:

```sql
LEFT JOIN (
  SELECT invoice_id, SUM(amount_refunded) AS refunded_amount
  FROM refunds
  WHERE kind='refund'
  GROUP BY invoice_id
) refunds ON refunds.invoice_id=o.invoice_id
```

Do not subtract collection reversals twice; retain the existing signed collection aggregate.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/SubscriptionService.js backend/services/subscriptionMetrics.js backend/routes/admin/subscriptions.js backend/routes/pos/subscriptions.js backend/tests/unit/subscriptionService.test.js backend/tests/unit/subscriptionMetrics.test.js backend/tests/integration/subscriptionCollections.test.js
git commit -m "fix(subscriptions): include credits in receivable balance"
```

### Task 2: Add an exact managed partial-refund mode

**Files:**
- Modify: `backend/services/RefundService.js`
- Test: `backend/tests/integration/refunds.test.js`

**Interfaces:**
- Extend: `refundPaidOrder(conn, { ..., managedSubscriptionId, managedRefundAmount })`.
- `managedRefundAmount` is accepted only with a matching `managedSubscriptionId`, a single subscription sale root item, no prior refund, and an amount strictly between zero and the remaining invoice total.

- [ ] **Step 1: Write failing refund transaction tests**

Cover:

```js
await refundPaidOrder(conn, {
  invoiceId,
  managedSubscriptionId: subscriptionId,
  managedRefundAmount: 50,
  refundMethod: null,
  reason: 'Customer will settle half',
  actorId: adminId,
  refundShiftId: null
});
```

Assert one partial refund, exact header cents, refund-item totals equal the header, `refund_status='partial'`, unchanged order totals/items, no cash/card movement, and a managed-subscription audit reference. Reject the option without a matching subscription, with multiple root items, with prior refunds, or outside the remaining total.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx vitest run backend/tests/integration/refunds.test.js -t "managed partial subscription"
```

Expected: FAIL because `managedRefundAmount` is not implemented.

- [ ] **Step 3: Implement the narrow server-only mode**

Keep the ordinary quantity-based refund path unchanged. In the managed mode:

1. Convert the requested amount and remaining invoice amount to cents.
2. Require the subscription purchase shape: one root order item, quantity `1`, and no prior refund.
3. Allocate the exact requested cents proportionally between the frozen remaining subtotal and tax.
4. Store one refund item referencing the original order item. Its quantity is `max(0.001, round3(requested refund / original line total))`; its stored line subtotal/tax/total are the exact allocated cents and remain authoritative. The JoFotara credit-note builder already represents any difference as an allowance.
5. Mark the order partial from remaining money, not from the synthetic managed quantity, because the refunded amount is below the remaining total.
6. Do not restock the hidden subscription sale product.

The ordinary branch must produce byte-for-byte equivalent result fields to its current behavior.

- [ ] **Step 4: Run refund tests and verify GREEN**

```powershell
npx vitest run backend/tests/integration/refunds.test.js
```

Expected: all pass, including existing split-cent and ordinary partial-refund cases.

- [ ] **Step 5: Commit**

```powershell
git add backend/services/RefundService.js backend/tests/integration/refunds.test.js
git commit -m "feat(subscriptions): record partial cancellation credits"
```

### Task 3: Extend cancellation without reopening subscription usage

**Files:**
- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/routes/pos/subscriptions.js`
- Test: `backend/tests/integration/subscriptionManagement.test.js`
- Test: `backend/tests/integration/subscriptionCollections.test.js`

**Interfaces:**
- Extend: `POST /api/admin/subscriptions/:id/cancel` body with optional `remaining_amount_due`.
- Preserve: no amount means the existing full uncollected cancellation.
- Produce: saved partial refund ID and cancelled subscription with a revised outstanding balance.

- [ ] **Step 1: Write failing route tests**

For a 100.00 uncollected receivable, submit:

```json
{
  "reason": "Customer cancelled and agreed to settle half",
  "remaining_amount_due": 50.00
}
```

Assert a 50.00 partial refund, cancelled subscription, 50.00 outstanding, blocked redemptions, and an audit event containing original total, credited amount, remaining due, and refund ID. Reject active redemptions, any collection history, negative/over-total/non-cent amounts, client authority fields, and concurrent duplicate cancellation.

Add a collection test proving a cancelled subscription with 50.00 outstanding can accept exactly 50.00 and then reports paid. Continue rejecting partial, zero, and excessive collections.

- [ ] **Step 2: Run tests and verify RED**

```powershell
npx vitest run backend/tests/integration/subscriptionManagement.test.js
npx vitest run backend/tests/integration/subscriptionCollections.test.js
```

- [ ] **Step 3: Implement inside the existing cancellation transaction**

Under the existing subscription row lock:

1. Load authoritative invoice/refund/collection totals.
2. Require `payment_method='receivable'`, zero net collections, no active redemptions, and active status.
3. Convert `remaining_amount_due` to cents.
4. Compute `credit = original - remaining_due`; never accept a client-provided credit.
5. Call `refundPaidOrder` with `managedRefundAmount=credit`.
6. Mark the subscription cancelled and append one enriched `subscription_cancelled` event.

Permit collection on `status='cancelled'` only when the persisted revised outstanding balance is positive. Never reactivate credits or allow redemption after cancellation.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Step 2 command. Expected: all pass.

- [ ] **Step 5: Commit**

```powershell
git add backend/routes/admin/subscriptions.js backend/routes/pos/subscriptions.js backend/tests/integration/subscriptionManagement.test.js backend/tests/integration/subscriptionCollections.test.js
git commit -m "feat(subscriptions): settle cancelled receivables"
```

### Task 4: Add the minimal admin control

**Files:**
- Modify: `src/admin/components/SubscriptionDetailDrawer.vue`
- Modify: `src/admin/pages/Subscriptions.vue`
- Modify: `src/shared/i18n.js`
- Test: `src/admin/pages/__tests__/subscriptionsPage.spec.js`

**Interfaces:**
- Consume: existing cancel endpoint with optional `remaining_amount_due`.
- Display: original, credited/refunded, collected, and outstanding amounts separately.

- [ ] **Step 1: Write the failing frontend contract test**

Assert the cancellation prompt exposes a remaining-amount field only for uncollected receivables, explains that it cancels future meals, and submits `remaining_amount_due`. Assert no JoFotara submit button is added.

- [ ] **Step 2: Run and verify RED**

```powershell
npx vitest run src/admin/pages/__tests__/subscriptionsPage.spec.js
```

- [ ] **Step 3: Implement the narrow UI**

Reuse the existing cancellation confirmation/modal. Do not create a wizard. Default remaining due to `0.00` so current full-cancellation behavior remains one click. Show a computed cancellation credit before confirmation.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command. Expected: pass.

- [ ] **Step 5: Commit**

```powershell
git add src/admin/components/SubscriptionDetailDrawer.vue src/admin/pages/Subscriptions.vue src/shared/i18n.js src/admin/pages/__tests__/subscriptionsPage.spec.js
git commit -m "feat(admin): control subscription cancellation balance"
```

### Task 5: Verify the financial invariant

- [ ] Run:

```powershell
npx vitest run backend/tests/unit/subscriptionService.test.js backend/tests/unit/subscriptionMetrics.test.js
npx vitest run backend/tests/integration/subscriptionManagement.test.js
npx vitest run backend/tests/integration/subscriptionCollections.test.js
npx vitest run backend/tests/integration/refunds.test.js
npx vitest run src/admin/pages/__tests__/subscriptionsPage.spec.js
npm run build
git diff --check
```

Expected: all pass. Verify manually from database evidence that `original total - refunds - collections = outstanding`, the original invoice remains unchanged, and no `jofotara_documents` row is created by cancellation or collection.
