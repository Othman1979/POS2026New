# Orders Refund and JoFotara Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add truthful refund and JoFotara filters and compact status markers to Order History without duplicating JoFotara Operations.

**Architecture:** Extend the existing paginated Orders endpoint with two validated filter parameters and a grouped JoFotara-return summary. Render those fields through small local status maps in the existing desktop row and mobile card, using the existing filter popover and i18n source.

**Tech Stack:** Express, MySQL/MariaDB, Vue 3 Options API as already used by `Orders.vue`, Vitest, Supertest.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-08-orders-refund-jofotara-status-design.md` exactly.
- Use mandatory test-first TDD: observe the focused test fail for the missing behavior before production edits.
- No database migration, new dependency, new API route, new API owner, new generic status component, or broad Orders refactor.
- Preserve pagination, stats, refund calculations, JoFotara submission behavior, printing, and all unrelated dirty work.
- Do not touch or stage `posapp.7z`.
- Use short natural Arabic; do not expose raw English status keys.

---

### Task 1: Server-side filters and return summary

**Files:**
- Modify: `backend/tests/integration/adminOrdersStats.test.js`
- Modify: `backend/routes/admin/orders.js`

**Interfaces:**
- Consumes query parameters `refund_status=none|partial|full` and `jofotara_status=not_submitted|accepted|needs_attention`.
- Produces the existing order fields plus `jofotara_status` normalized to `not_submitted` when no invoice document exists, and `jofotara_return_status` as `null|not_submitted|pending|submitting|accepted|rejected|unknown`.

- [ ] **Step 1: Write failing integration coverage**

Add focused tests that seed several orders, refund rows, original invoice documents, and credit-note documents, then assert:

```js
const refunded = await request(app)
  .get('/api/admin/orders?refund_status=partial')
  .set('Cookie', adminCookie);
expect(refunded.body.orders.every(order => order.refund_status === 'partial')).toBe(true);

const accepted = await request(app)
  .get('/api/admin/orders?jofotara_status=accepted')
  .set('Cookie', adminCookie);
expect(accepted.body.orders.map(order => order.invoice_id)).toEqual([acceptedInvoiceId]);

const notSent = await request(app)
  .get('/api/admin/orders?jofotara_status=not_submitted')
  .set('Cookie', adminCookie);
expect(notSent.body.orders.map(order => order.invoice_id)).toContain(unsubmittedInvoiceId);

const attention = await request(app)
  .get('/api/admin/orders?jofotara_status=needs_attention')
  .set('Cookie', adminCookie);
expect(attention.body.orders.map(order => order.invoice_id)).toEqual(
  expect.arrayContaining([pendingInvoiceId, rejectedInvoiceId, unknownInvoiceId])
);
```

Also prove that the filtered `pagination.total` and `stats.total_revenue` match the filtered orders; an invalid value is ignored; two refunds do not duplicate the order; and an accepted plus missing return summarizes as `not_submitted`, while any unknown return summarizes as `unknown`.

- [ ] **Step 2: Run RED**

Run:

```powershell
npx vitest run backend/tests/integration/adminOrdersStats.test.js
```

Expected: the new assertions fail because the endpoint ignores the parameters and does not return `jofotara_return_status`.

- [ ] **Step 3: Implement the minimum query changes**

In `backend/routes/admin/orders.js`:

- Accept only the documented filter values.
- Add `o.refund_status = ?` for a valid refund status.
- Add JoFotara predicates using `EXISTS`/`NOT EXISTS` against `jofotara_documents` so the same `filterClause` remains valid in both stats and list queries.
- Keep the single original-document join for row display and normalize its missing status with `COALESCE(jd.status, 'not_submitted')`.
- Add one grouped derived table keyed by `refunds.invoice_id` that counts saved `kind='refund'` rows and their matching `jofotara_documents` (`source_key=CONCAT('refund:', r.id)`), then derive `jofotara_return_status` using the precedence in the design.
- Do not join raw refund rows into the order list.

- [ ] **Step 4: Run GREEN**

Run the same focused integration file and require all tests to pass.

- [ ] **Step 5: Leave the task uncommitted for controller review**

Do not stage or commit: the working tree contains approved overlapping JoFotara work. The controller will review and commit the combined branch deliberately.

---

### Task 2: Orders filters and compact status markers

**Files:**
- Modify: `src/admin/pages/__tests__/ordersSetupBindings.spec.js`
- Modify: `src/admin/pages/Orders.vue`
- Modify: `src/shared/i18n.js`

**Interfaces:**
- Consumes Task 1 fields and query values.
- Produces `selectedRefundStatus` and `selectedJofotaraStatus` filter state, query serialization, reset/chip behavior, and the approved desktop/mobile markers.

- [ ] **Step 1: Write failing UI contract tests**

Extend the existing source-binding test to require:

```js
expect(source).toContain("params.set('refund_status', selectedRefundStatus.value)");
expect(source).toContain("params.set('jofotara_status', selectedJofotaraStatus.value)");
expect(source).toContain("selectedRefundStatus.value = ''");
expect(source).toContain("selectedJofotaraStatus.value = ''");
expect(source).toContain('jofotara_return_status');
```

Assert the template contains both filter groups, removable active-filter notes, and status-marker rendering in both desktop and mobile sections. Assert every new English key has an Arabic translation and that the Arabic values contain none of the raw English status labels.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run src/admin/pages/__tests__/ordersSetupBindings.spec.js
```

Expected: fail because the filter state, query parameters, markers, and translations do not exist.

- [ ] **Step 3: Implement the approved UI**

In `Orders.vue`:

- Add two single-choice filter groups inside the existing popover.
- Add their active notes to the existing filter-note row and make that row visible when either new filter is active.
- Count each selected group once in `activeFilterCount`; while touching the counter, include the already-existing `isDiscounted` filter so its visible chip and count agree.
- Clear both in `clearAllFilters`.
- Reset page to 1 and refetch when either selection changes, following the page's existing watcher pattern.
- Serialize only non-empty values into `fetchOrders`.
- Define local status maps/functions for invoice and return labels/classes; do not create a new file.
- Render the same compact marker line below invoice identity on desktop and mobile, and remove the old refund marker from the payment area so it is relocated rather than duplicated.
- Hide JoFotara markers for `payment_method === 'voided'`.
- Show the return marker only when `refund_status !== 'none'`, original `jofotara_status === 'accepted'`, and `jofotara_return_status` is non-null.

In `i18n.js`, add natural Arabic for the filter labels and marker text, including:

```js
'JoFotara sent': 'مرحل',
'JoFotara not sent': 'لم يرحل',
'JoFotara return sent': 'المرتجع مرحل',
'JoFotara return not sent': 'المرتجع لم يرحل',
'Partial refund': 'مرتجع جزئي',
'Full refund': 'مرتجع كامل',
```

Use similarly short wording for sending, rejected, and review states. Keep these contextual Orders keys separate from the Operations wording (`لم تُرسل`) rather than changing that page indirectly. Reuse an existing translation key only when it expresses the exact same context.

- [ ] **Step 4: Run GREEN and build**

```powershell
npx vitest run src/admin/pages/__tests__/ordersSetupBindings.spec.js
npm run build
```

Expected: focused test and production build pass.

- [ ] **Step 5: Leave the task uncommitted for controller review**

Do not stage or commit. Preserve every pre-existing edit in these overlapping files.

---

### Task 3: Integrated verification and scope audit

**Files:**
- Modify only a Task 1 or Task 2 file if a focused verification exposes a defect.

**Interfaces:**
- Verifies the completed feature; produces no new architecture.

- [ ] **Step 1: Run focused regression tests**

```powershell
npx vitest run backend/tests/integration/adminOrdersStats.test.js backend/tests/integration/jofotara.test.js src/admin/pages/__tests__/ordersSetupBindings.spec.js src/admin/pages/__tests__/jofotaraOperationsLocalization.spec.js
```

- [ ] **Step 2: Run production build and diff hygiene**

```powershell
npm run build
git diff --check
```

- [ ] **Step 3: Audit the final diff**

Confirm from the actual diff that filtering occurs before `LIMIT/OFFSET`, stats use the same filter predicates, aggregate joins cannot multiply orders, all statuses map to human Arabic, desktop and mobile remain equivalent, and no migration/submission/printing behavior changed.

- [ ] **Step 4: Report the exact verification result**

Do not stage or commit. Report changed files, RED/GREEN evidence, commands, results, and any concern to the controller.
