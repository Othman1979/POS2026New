# Admin-Granted Subscription POS Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `ponytail`, `test-driven-development`, `vue`, and `verification-before-completion`. Execute inline; do not delegate.

**Goal:** Make an admin-granted subscription visibly available to the cashier, explain exactly when it can be redeemed, and preserve the existing financial, permission, shift, stock, and kitchen-print contracts.

**Architecture:** Keep `customer_subscriptions.purchase_invoice_id IS NULL` and the internal `source: 'manual'` contract unchanged. Correct only the POS selection/presentation behavior and human-facing Admin terminology, then add one backend characterization proving that an active admin grant travels through the existing lookup and redemption pipeline.

**Tech Stack:** Vue 3 Composition API, existing i18n dictionary, Vitest source-contract tests, Supertest/MySQL integration tests.

## Global Constraints

- Do not add a migration, endpoint, controller, service, composable, or dependency.
- Do not make pending, expired, completed, cancelled, or refunded subscriptions redeemable.
- Do not change permissions, open-shift ownership, stock deduction, audit events, idempotency, or kitchen-printer routing.
- Do not turn an admin grant into a sale, receivable, invoice, payment, JoFotara document, or revenue.
- Keep the persisted/API value `manual`; change only operator-facing copy to `Admin Granted`.
- Do not touch unrelated untracked plans, `posapp.7z`, or `skills/`.

---

## Self-Guidance Prompt

> Act as the owner of the subscription domain, not a line-count refactorer. First prove the end-to-end contract from admin creation through the customer snapshot, business-date state derivation, cashier selection, redemption validation, shift ownership, stock handling, and kitchen queue. Treat `manual` as a financial provenance value, never as an entitlement restriction. Write the smallest failing UI contract first. Preserve every server-side guard. Prefer active, then pending, then historical subscriptions; keep a customer with any subscription in the redemption/history workspace so an operator can see why it is unavailable. Replace misleading operator copy without renaming stored values. Attack the solution with active, future, closed, mixed-history, no-shift, permission-denied, unrouted-kitchen, and multiple-subscription cases. If a proposed change requires schema work or changes money behavior, it is outside scope. Finish only after focused tests, the real backend integration path, production build, diff inspection, and a stale-copy search are clean.

## Evidence and Contract Map

- `backend/routes/admin/subscriptions.js` creates admin grants with no purchase invoice, copies the plan's eligible product snapshot, and writes `subscription_manually_created` audit history.
- `backend/services/SubscriptionService.js#listUsableSubscriptionsForCustomer` returns all customer subscriptions without filtering `purchase_invoice_id` or `manual_reason`, derives state using the business date, and attaches frozen eligible products.
- `backend/routes/pos/subscriptions.js` exact-phone lookup uses that service. Redemption uses the same subscription ID and does not inspect source; it independently enforces active dates/status, remaining credits, permission, cashier shift, product eligibility/availability, stock, idempotency, and kitchen routing.
- `src/components/pos/SubscriptionModal.vue` currently selects active-or-first, but switches to Sell unless an active subscription exists. That hides a pending admin grant behind the wrong default workspace and then uses a generic no-eligible-products message for every non-active state.
- Local evidence on 2026-07-30 showed the admin-created subscription beginning 2026-08-01 returned by lookup with products but correctly derived as `pending`. Its source was not the blocker; its start date was.

### Task 1: Pin the broken cashier contract and backend continuity

**Files:**
- Modify: `src/components/pos/__tests__/subscriptionModal.spec.js`
- Modify: `backend/tests/integration/subscriptionRedemptions.test.js`

**Interfaces:**
- Consumes: `GET /api/pos/customer-subscriptions`, `POST /api/pos/subscription-redemptions`, `SubscriptionModal.vue`.
- Produces: regression coverage for pending visibility, state-specific explanation, and active admin-grant redemption.

- [ ] Add a Vitest contract asserting that search prefers `active`, then `pending`, keeps any found subscriptions in `redeem` mode, displays `Starts on`, and contains separate pending/non-active explanations.
- [ ] Run `npx vitest run src/components/pos/__tests__/subscriptionModal.spec.js`; expect the new test to fail on the current active-only mode expression and missing copy.
- [ ] Add a Supertest characterization that creates a currently active admin grant, verifies exact-phone lookup returns `source: 'manual'`, `state: 'active'`, and eligible products, then redeems it as the cashier through a configured kitchen route.
- [ ] Run `npx vitest run backend/tests/integration/subscriptionRedemptions.test.js`; expect the characterization to pass without backend production changes. Any failure means the evidence is wrong and implementation must stop for root-cause correction.

### Task 2: Correct POS selection and unavailable-state presentation

**Files:**
- Modify: `src/components/pos/SubscriptionModal.vue`
- Modify: `src/shared/i18n.js`
- Test: `src/components/pos/__tests__/subscriptionModal.spec.js`

**Interfaces:**
- Consumes: existing subscription `state`, `starts_on`, `ends_on`, and `eligible_products` fields.
- Produces: deterministic selection and an honest redemption workspace; no API changes.

- [ ] In `searchCustomer`, select the first active subscription, otherwise the first pending subscription, otherwise the first returned subscription.
- [ ] Set `mode` to `redeem` whenever `subscriptions.length > 0`; use `sell` only when none exist.
- [ ] Add `Starts on` beside existing subscription facts.
- [ ] When an inactive selection has no rendered meals, show a pending-specific start-date explanation or a generic closed-state explanation. Show `No eligible meals are configured...` only for an active subscription whose frozen eligible-product list is actually empty.
- [ ] Leave `selectedUsableSubscription` active-only and keep the submit button's existing guard.
- [ ] Add only the two new English/Arabic explanation strings to `src/shared/i18n.js`.
- [ ] Run the focused modal test; expect PASS.

### Task 3: Replace misleading Admin terminology without changing provenance

**Files:**
- Modify: `src/admin/pages/Subscriptions.vue`
- Modify: `src/admin/components/SubscriptionAssignmentModal.vue`
- Modify: `src/admin/components/SubscriptionDetailDrawer.vue`
- Modify: `src/admin/pages/__tests__/subscriptionsPage.spec.js`
- Modify: `src/shared/i18n.js`

**Interfaces:**
- Consumes: internal `source === 'manual'` checks.
- Produces: operator copy `Admin Granted`, while all internal source checks and refund guards remain unchanged.

- [ ] Write failing Admin contract assertions for `Admin Granted`, `Admin grant / complimentary`, and the no-payment explanation, while continuing to assert `source === 'manual'` and the manual refund exclusion.
- [ ] Run the focused Admin test; expect FAIL because the old `Manual` labels remain.
- [ ] Update list, mobile card, assignment mode, assignment notice, and detail heading copy. Do not rename `form.mode`, `source`, `manual_reason`, API codes, or audit event names.
- [ ] Add the matching Arabic translations and run the focused Admin test; expect PASS.

### Task 4: Hostile verification and scoped commit

**Files:**
- Verify only; no planned production files.

- [ ] Re-run both focused Vitest files and `backend/tests/integration/subscriptionRedemptions.test.js`.
- [ ] Run `npm run build` to catch Vue template and bundling failures.
- [ ] Search production UI for stale subscription labels and verify every remaining `manual` reference is an internal contract or unrelated feature.
- [ ] Inspect `git diff --check`, `git diff --stat`, and the full diff. Confirm no backend production, migration, accounting, JoFotara, printer, shift, permission, or unrelated untracked file changed.
- [ ] Commit only the plan, focused tests, POS modal, Admin subscription UI, and i18n changes.

## Hostile Plan Review

- **Pending grant:** visible and selected, but `selectedUsableSubscription` remains null; quantities and Redeem stay disabled.
- **Active grant:** follows the same endpoint as a paid subscription and is proven through kitchen queue creation.
- **Expired/completed/cancelled/refunded only:** visible as history with an explicit unavailable explanation; the operator can still choose Renew.
- **Multiple subscriptions:** active wins; if none are active, pending wins over closed history; API ordering remains untouched.
- **Permission/no shift:** unchanged backend rejection remains authoritative; no UI copy claims otherwise.
- **No kitchen route:** unchanged all-or-nothing backend rejection prevents credit consumption.
- **Money/audit:** an admin grant remains non-financial and audited; no fake invoice or shift revenue is introduced.
- **Attack result:** the original wider idea of changing backend source semantics is rejected. The minimal plan fixes the actual UI inconsistency and pins the already-correct backend contract.
