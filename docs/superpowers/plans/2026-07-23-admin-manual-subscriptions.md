# Admin Manual Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator assign an actual dated customer subscription without creating fake revenue or an invoice.

**Architecture:** Paid subscription sales remain owned by POS checkout. Admin assignments use a new audited `POST /api/admin/subscriptions` path, store a null purchase invoice plus a required manual reason and creator, and snapshot the selected plan's credits and eligible products. Existing reads use left joins so paid and manual subscriptions share redemption and management behavior while refund remains purchase-only.

**Tech Stack:** Vue 3, Express, MySQL/InnoDB, Vitest, Supertest, Playwright.

## Global Constraints

- Keep the existing plan editor and paid POS checkout unchanged.
- Do not create an order, invoice, payment, refund, or revenue entry for a manual assignment.
- Require customer, plan, inclusive start/end dates, and an administrative reason.
- Use the existing Subscriptions page and one focused modal; add no dependency.
- Preserve English, Arabic, RTL, keyboard, and mobile behavior.

---

### Task 1: Manual-origin schema

**Files:**
- Create: `backend/migrations/2026-07-23-admin-manual-subscriptions.sql`
- Create: `backend/migrations/2026-07-23-admin-manual-subscriptions-verify.sql`
- Modify: `backend/tests/fixtures/seed.js`
- Modify: `backend/services/schemaValidation.js`
- Test: `backend/tests/unit/schemaAuthority.test.js`

**Interfaces:**
- Produces nullable `customer_subscriptions.purchase_invoice_id`, nullable `created_by`, nullable `manual_reason`, `fk_customer_subscriptions_created_by`, and `chk_customer_subscriptions_origin`.

- [ ] Write schema-authority assertions for the new guarded migration, nullable invoice, creator FK, reason column, and origin check.
- [ ] Run `npx vitest run backend/tests/unit/schemaAuthority.test.js` and confirm failure because the migration contract is absent.
- [ ] Add the guarded migration/verifier, fixture schema, and startup validation counts.
- [ ] Re-run the schema-authority test and confirm it passes.

### Task 2: Audited admin assignment API

**Files:**
- Modify: `backend/routes/admin/subscriptions.js`
- Modify: `backend/services/SubscriptionService.js`
- Test: `backend/tests/integration/subscriptionManagement.test.js`

**Interfaces:**
- Consumes: `POST /api/admin/subscriptions` body `{ customer_id, plan_id, starts_on, ends_on, reason }`.
- Produces: `{ success: true, subscription }` with `purchase_invoice_id: null`, `source: 'manual'`, plan credit/product snapshots, and audit event `subscription_manually_created`.

- [ ] Add integration cases proving a manual assignment creates no order, snapshots plan products, supports past/future ranges, and rejects missing reason or reversed dates.
- [ ] Run `npx vitest run backend/tests/integration/subscriptionManagement.test.js` and confirm the new cases fail with the missing POST route/schema.
- [ ] Implement the transactional route, audit event, staff socket event, and left-join/null mapping required by manual subscriptions.
- [ ] Ensure refund returns a clear conflict for manual subscriptions while cancel, extend, and redemption remain available.
- [ ] Re-run the integration test and confirm it passes.

### Task 3: Admin assignment UI

**Files:**
- Create: `src/admin/components/SubscriptionAssignmentModal.vue`
- Modify: `src/admin/pages/Subscriptions.vue`
- Modify: `src/shared/i18n.js`
- Test: `src/admin/pages/__tests__/subscriptionsPage.spec.js`
- Test: `tests/e2e/specs/admin.dashboard.spec.js`

**Interfaces:**
- Consumes existing `/api/admin/customers`, `/api/admin/subscription-plans`, and new `POST /api/admin/subscriptions`.
- Produces modal event `saved` so the existing page reloads plans, list, and metrics.

- [ ] Add failing source contracts for a distinct `Add Subscription` action, customer search, plan selector, two native date inputs, inclusive day preview, required reason, and manual/non-financial notice.
- [ ] Run the focused source test and confirm it fails because the workflow is absent.
- [ ] Build the single responsive modal and wire it to the Subscriptions command bar.
- [ ] Add Arabic strings and make the detail drawer show `Manual assignment` instead of a purchase invoice/refund action.
- [ ] Extend Playwright to create a manual subscription, verify its date range and source, and confirm the 390×844 modal fits.

### Task 4: Verification and commit

**Files:**
- Verify only; no additional production files.

- [ ] Apply the guarded migration to the local development schema and run its read-only verifier.
- [ ] Run focused unit/integration tests, the production build, and admin Playwright project.
- [ ] Run `git diff --check` and confirm only scoped files are staged.
- [ ] Commit with `feat(admin): add manual subscription assignments`.

