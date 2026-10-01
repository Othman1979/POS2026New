# Normal Register Order Workflow Reliability Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make normal register sales easy to change and hard to corrupt across retries, cashier/shift changes, held-order settlement, customer persistence, and kitchen printing, without changing table-settlement behavior or redesigning the schema or permission system.

**Self-prompt:** Work only in `codex/register-order-workflow`. Treat checkout as a financial state machine: browser draft → authorized server calculation → one persisted sale → durable print jobs → clean local reset. Trace identity and ownership at every transition. Reproduce each defect before editing. Prefer one deep module over helpers spread through the store or route. Reuse `PermissionService`; do not invent a role framework. Preserve all table branches. Keep SQL atomic and indexed. Follow Vue `script setup` reactivity rules. Stop only when focused tests, nearby regressions, schema drift, build, query/latency checks, and the untouched table worktree check are green.

**Architecture:** Add a frontend checkout-attempt cache module and backend checkout-attempt module so retry identity has one interface on each runtime. Add a held-kitchen dispatch module that owns the fired-state claim, stable print identity, and compensation on failure. Keep pricing, receipt presentation, permission catalog, and table settlement in their existing implementations.

**Tech Stack:** Vue 3 Composition API, Pinia, Node/Express, MySQL/MariaDB InnoDB, Vitest, Supertest.

---

### Task 1: Bind checkout retries to the cashier and shift

**Files:**
- Create: `assets/js/composables/stores/checkoutAttemptCache.js`
- Create: `backend/services/CheckoutAttemptService.js`
- Modify: `assets/js/composables/stores/orderSessionStore.js`
- Modify: `backend/routes/pos/checkout.js`
- Test: `backend/tests/unit/orderSessionStore.test.js`
- Test: `backend/tests/unit/checkoutAttemptCache.test.js`
- Test: `backend/tests/integration/checkout.test.js`

**Steps:**
1. Add failing frontend tests proving same cart rotates its key after actor or shift changes, order notes affect identity, old cache versions are not reused, and cached data contains no raw customer/cart data.
2. Add failing backend tests proving an idempotency key longer than the schema limit returns 400 and one cashier cannot receive another cashier's duplicate sale.
3. Implement the frontend cache interface with versioned hashed fingerprints, TTL, and actor/shift/order-intent inputs.
4. Implement backend key normalization and actor-owned duplicate lookup/recovery. Return 409 for another actor's key.
5. Run the focused unit and checkout integration tests.

### Task 2: Remove untrusted register lineage and customer race

**Files:**
- Modify: `backend/routes/pos/checkout.js`
- Test: `backend/tests/integration/checkout.test.js`

**Steps:**
1. Add a failing test proving a normal register request cannot persist a forged `parent_invoice_id` or borrow the parent's waiter.
2. Add a failing concurrent checkout test for two new sales using the same customer phone.
3. Derive parent lineage only from the locked, authenticated split-held payload. Normal register orders persist `NULL` and use the active cashier as waiter.
4. Replace SELECT-then-INSERT customer persistence with one atomic `INSERT ... ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` statement.
5. Run checkout tests and compare query count for a customer checkout before/after.

### Task 3: Do not re-authorize a claimed held service charge

**Files:**
- Modify: `backend/routes/pos/checkout.js`
- Test: `backend/tests/integration/serviceChargeSnapshots.test.js`

**Steps:**
1. Add a failing regression: authorized user saves a fee-bearing register hold; cashier without `pos.service_charge` claims it and can settle it with `pos.checkout`.
2. Keep direct service-charge creation gated. Exempt only a valid server-claimed snapshot; snapshot ownership/token/version validation remains mandatory.
3. Run service-charge and checkout permission tests.

### Task 4: Make held kitchen fire retry-safe

**Files:**
- Create: `backend/services/HeldOrderKitchenDispatch.js`
- Modify: `backend/routes/pos/orders.js`
- Modify: `src/components/OrderNotes.vue`
- Test: `backend/tests/unit/heldOrderKitchenDispatch.test.js`
- Test: `backend/tests/integration/bundle.heldOrders.fire.test.js`

**Steps:**
1. Add failing tests proving print/enqueue failure resets `kitchen_fired`, retry uses a stable batch ID, zero routed printers does not permanently mark fired, and concurrent requests have one winner.
2. Implement one deep dispatch interface: conditional state claim → stable `held-{id}` batch → durable print call → compensation on failure/zero routes.
3. Use held row ID as stable kitchen reference, removing the racy daily `COUNT(*) + 1` query.
4. Fix Vue response handling to read top-level `count`, with no reactive destructuring or undeclared template state.
5. Run held kitchen integration and receipt contract tests.

### Task 5: Adversarial verification and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-07-15-register-order-workflow.md`

**Steps:**
1. Run focused unit/integration suites: checkout, held orders/fire, service-charge snapshots, permissions, shift, print authorization/queue, and store state.
2. Run schema drift validation and admin build.
3. Measure simple checkout latency/query count and held-fire query count. Confirm no new full scans or N+1 paths.
4. Run nearby table tests only as regression evidence; distinguish the five known master baseline failures from new failures.
5. Confirm `C:/xampp/htdocs/posapp/.worktrees/table-settlement-context` status and head are unchanged.
6. Review the diff for accidental table behavior, debug output, untranslated user-facing text, stale Vue state, and unbounded storage.
7. Commit the register branch only. Do not merge it and do not touch the table-settlement branch.

### Narrow schema hygiene found during verification

- Added `backend/migrations/2026-07-15-drop-duplicate-checkout-indexes.sql` to remove only the redundant named unique indexes when their original equivalent indexes are also present.
- Aligned the test seed's `order_items.created_at` definition with the development schema.
- The migration is guarded, was applied twice successfully, and leaves one unique index on `orders.idempotency_key` and one on `customers.phone`.

### Verification record

- Checkout integration: 83/83 passed.
- Focused store/cache/dispatch/presentation unit tests: 130/130 passed.
- Service-charge snapshots: 38/38 passed.
- Held orders: 32/32 passed; held kitchen fire: 14/14 passed.
- Shift, print authorization, and print queue: 60/60 passed.
- Nearby open-table-number and reports regressions: 11/11 and 7/7 passed.
- Full repository run: 117 files and 1,391 tests passed; the same 14 master-baseline failures remain in five table-only suites.
- Schema drift: zero. Admin build: passed. JavaScript syntax and diff whitespace checks: passed.
- Customer persistence uses one atomic indexed statement instead of a select/insert pair. Held kitchen dispatch removes the daily `COUNT(*) + 1` query, locks one primary-key row, and reuses the held order time so retries hash to the same durable print job. Duplicate checkout/customer indexes were reduced from two to one each.
