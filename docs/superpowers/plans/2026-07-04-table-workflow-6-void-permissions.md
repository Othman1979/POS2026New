# Void Permission Model Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development to run this task-by-task in the current session (or superpowers:executing-plans across sessions), and superpowers:test-driven-development for every task (failing test FIRST, prove red → green). Steps use checkbox (`- [ ]`) syntax. **Run one Task per agent dispatch; commit before the next.**
>
> **Git hygiene:** the owner has unrelated WIP in the tree (`git status` shows modified `orderSessionStore.js`, `tables.js`, and two test files already staged for other work). Do NOT `git stash`. When committing, stage ONLY the files each Task names (`git add <exact file>` per listed file) — never `git add -A`.

**Goal:** Make the void-permission wall identical everywhere the same physical action happens — removing/reducing/voiding saved units on an open `unpaid_table` order. Today three code paths enforce three different permission sets for that one action; the most destructive path (whole-order void) demands the *least* permission. This plan states one canonical model and aligns every backend gate and every frontend UX gate to it. Each behavior change ships with a test.

## Architecture — the canonical void-permission model

**Server is the authority. Frontend gates are UX only** (they stop a disabled button from mutating local cart state; they never decide the DB outcome). The four Tasks below realign both layers to a single rule.

**CANONICAL RULE.** Removing, reducing, or voiding **saved/printed units on an open `unpaid_table` order** requires the operator to hold **BOTH** `pos.void_item` **AND** `pos.void_printed_item` (plus `waiter.edit_locked` for any edit of a saved table order). `admin`/`programmer` satisfy all grants implicitly (`userHas` short-circuits for them). This one rule governs three server paths and two client gates:

| Path | File / anchor | Today | Canonical |
|---|---|---|---|
| Per-line reduce on table save | `tables.js` `hasVoidPermission` (~:1210) + `canVoidPrinted` (~:1238) + `ensureCanUpdateTable`/`canEditLocked` (~:1248/:1267) | `void_item` + `void_printed_item` + `edit_locked` | ✅ already correct — the reference implementation |
| Whole-order (empty-cart) table void | `tables.js` empty-cart branch (~:975) | `void_item` only | **P2-1:** add `void_printed_item` + `edit_locked` |
| `/refunds` `intent='void'` on an open table | `refunds.js` top gate (~:14) | `pos.refund` only | **P3-2:** additionally require `void_item` + `void_printed_item` + `edit_locked` |
| `clearCart` (local clear of a saved cart) | `orderSessionStore.js` `clearCart` (~:1486) | `void_printed_item` only | **P3-11:** require `void_item` + `void_printed_item` + `canUpdateTable` (`edit_locked`) |
| `removeSelectedCartItem` / `applyLiveNumpad` (local delete/reduce/qty of a saved line) | `orderSessionStore.js` (~:1558/:1583/:1602) | `void_item` + `void_printed_item` | **P3-16:** also require `canUpdateTable` (`edit_locked`) to match the backend precondition |

Why "saved == printed" here: a table save fires the kitchen ticket, so `existingItemsForPrint` in `tables.js` (~:1176-1188) is simply *every* saved `order_items` row — the printed-void gate (`canVoidPrinted`) therefore fires on **any** reduction of a saved line. The `/refunds` `intent='void'` path only ever runs against an `unpaid_table` order (paid orders are rejected 409 at `refunds.js:55` before any void work), so its lines are likewise saved/printed by definition. The whole-order empty-cart void removes *all* those printed units at once — it is strictly more destructive than reducing one line, so it must not require a *weaker* permission.

**Paid-order refunds are OUT of scope of this rule.** `intent='refund'` (a money refund on a `cash`/`card` order) stays gated on `pos.refund` only — it is not a table void and must not start demanding void grants. Task 2 places its new gate so it can never touch the refund path.

**sendError sanitizer (do not trip it).** `helpers.js` `sendError` (`:23-31`) rewrites any message containing `ER_`/`SQLSTATE`/`mysql`/`SQL Error`, **or** both (`Table`|`table`) **and** `exist`, into a generic string. Every new/changed error message below deliberately avoids the word `exist`, so messages survive verbatim.

**Error → HTTP status mapping in `tables.js`** (catch block `:1514-1534`): a thrown `Error` whose message `startsWith('Forbidden:')` becomes **403**; `startsWith('Conflict:')` becomes 409; an `err.statusCode` set explicitly wins. That is why the new `tables.js` throws below use the `Forbidden:` prefix.

## Tech Stack

Vue 3 (Pinia `setup()` stores) + Vite; Express 5 + `mysql2/promise`. Tests: **Vitest** — `npx vitest run <file>` (NEVER jest; jest gives false pool-closed/race failures here). Backend integration via `supertest` against `server.js` `app`, seeded by `backend/tests/fixtures/seed.js` (`seedDatabase()` + `SEED`). Frontend store units run under Vitest with `pinia` + `fetch`/`window` mocks and a hoisted `mockPermissionsState.can`.

## Global Constraints

- **Failing test FIRST**, then the minimal fix. Prove red → green with real command output pasted into the task.
- **Server is the authority; FE gates are UX.** Do not weaken or "simplify" any existing backend gate. Only ADD the checks named here.
- **Do NOT change the per-line reduce path** (`tables.js` ~:1203-1244) — it is already canonical and is the pattern the other paths copy.
- **Do NOT re-touch working-tree baseline already applied:** the void-reason modal is gone; `removeSelectedCartItem`'s void-perm condition is already `(!canVoidItems || !canBypassPrintedLock)` (correct) — Task 4 only ADDS `|| !canUpdateTable`, it does not alter the void-perm logic.
- Every new error message avoids the substring `exist` (sanitizer) and, in `tables.js`, uses the `Forbidden:` prefix to map to 403.
- After EACH task re-run the full trio to catch cross-path regressions:
  `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/unit/orderSessionStore.test.js`

---

## Task 1 — P2-1: Whole-order (empty-cart) table void must require `pos.void_printed_item` + `waiter.edit_locked`

**Finding P2-1** — `backend/routes/pos/tables.js` empty-cart void branch (~:972-1066) gates only on `hasVoidPermission(req.user)` (~:975) + ownership (~:984), then `return`s (~:1065) **before** the per-line printed gate (~:1238) is ever reached. Result: voiding an ENTIRE printed order needs only `pos.void_item`, while reducing ONE printed line needs `pos.void_item` AND `pos.void_printed_item` — the more destructive action needs the lesser permission. No current UI POSTs an empty cart (the client early-returns on an empty cart), so exposure is crafted-request only — but the backend is the authority and is internally inconsistent.

**Files:** modify `backend/routes/pos/tables.js`; add tests to `backend/tests/integration/tables.test.js`.

**Interfaces:**
- Helpers already imported at the top of `tables.js` (`:20`, `:33`, `:35`): `hasVoidPermission(user)`, `canVoidPrinted(user)`, `canEditLocked(user)` — all `=> boolean`. No new imports needed.
- Reuse the existing `grantWaiter(keys)` helper in `tables.test.js` (~:876) and `createTableOrder(cookie, tableId, items, subtotal, tax, total) => invoiceId` (~:53).

- [ ] **Step 1 (red — full failing test):** In `tables.test.js`, inside the existing `describe('Saved-item modification: permission/admin only, no manager-PIN override', ...)` block (so `grantWaiter` is in scope), append:
```javascript
        it('rejects a whole-order (empty-cart) void without pos.void_printed_item', async () => {
            // Waiter can create + edit (edit_locked) and has pos.void_item, but LACKS
            // pos.void_printed_item — so a whole-order void must be denied, exactly as
            // reducing a single printed line would be.
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked', 'pos.void_item']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, cart: [] });

            expect(res.statusCode).toBe(403);
            expect(res.body.message).toMatch(/permission/i);

            // Order stays open + table stays occupied — nothing was voided or freed.
            const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(order.payment_method).toBe('unpaid_table');
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(Number(invoiceId));
        });

        it('lets a waiter with BOTH void perms whole-order void an open table', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked', 'pos.void_item', 'pos.void_printed_item']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, cart: [] });

            expect(res.statusCode).toBe(200);

            const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(order.payment_method).toBe('voided');
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table.id]);
            expect(table.status).toBe('available');
            expect(table.current_order_id).toBeNull();
        });
```

- [ ] **Step 2 (run → FAIL):** `npx vitest run backend/tests/integration/tables.test.js`
  Expected: the first new test FAILS — today the empty-cart branch only checks `hasVoidPermission`, so the `void_item`-only waiter succeeds and the response is `200` / order becomes `voided` (assertion `expect(res.statusCode).toBe(403)` fails). The second test PASSES already (both-perms user is allowed today too) — it is the regression guard.

- [ ] **Step 3 (minimal fix):** In `tables.js`, the empty-cart void branch currently reads (~:973-977):
  BEFORE:
```javascript
            if (order_id) {
                // Verify void permissions — permission/admin only, no manager-PIN override.
                if (!hasVoidPermission(req.user)) {
                    throw new Error("Forbidden: You do not have permission to void a table order.");
                }
```
  AFTER:
```javascript
            if (order_id) {
                // Verify void permissions — permission/admin only, no manager-PIN override.
                if (!hasVoidPermission(req.user)) {
                    throw new Error("Forbidden: You do not have permission to void a table order.");
                }
                // A whole-order void removes ALL saved/printed units at once — it is strictly
                // more destructive than reducing one printed line, so it must clear the SAME
                // wall as the per-line path: the printed-void grant AND table-edit capability.
                // (Server is the authority here; the FE never POSTs an empty cart.)
                if (!canVoidPrinted(req.user)) {
                    throw new Error("Forbidden: You do not have permission to void printed items.");
                }
                if (!canEditLocked(req.user)) {
                    throw new Error("Forbidden: You do not have permission to update table orders.");
                }
```
  Note: both new messages hit the `Forbidden:` → 403 mapping (`tables.js:1517`), and neither contains `exist`, so `sendError` leaves them intact.

- [ ] **Step 4 (run → PASS):** `npx vitest run backend/tests/integration/tables.test.js` — both new tests green; the whole file green (the existing per-line reduce tests still pass — they already grant both void perms).

- [ ] **Step 5 (regression trio):** `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/unit/orderSessionStore.test.js` — all green.

- [ ] **Step 6 (commit):** `git add backend/routes/pos/tables.js backend/tests/integration/tables.test.js` then
  `git commit -m "fix(tables): whole-order void requires void_printed_item + edit_locked (align with per-line gate)"`

**Risk:** none for real users — the empty-cart path is unreachable from the current UI. Pure hardening of a crafted-request hole; no legitimate flow loses access (any operator who could reduce a line already holds both grants).

---

## Task 2 — P3-2: `/refunds` `intent='void'` must require `pos.void_item` + `pos.void_printed_item` + `waiter.edit_locked` (not just `pos.refund`)

**Finding P3-2** — `backend/routes/pos/refunds.js` gates the whole handler on `isAdminUser || hasRefundPermission` (`:14`). `intent='void'` then deletes/reduces `order_items` on an open `unpaid_table` order (`:232-295`, whole-order `:235-252`, partial `:253-291`). That is the identical physical action the table-save path walls behind `pos.void_item` + `pos.void_printed_item`, yet here it needs only `pos.refund`. A `pos.refund`-only operator can strip printed units off a live table through this endpoint.

**Rule for this task (put at the top of the added gate as a comment):** when `intent='void'` (which, by `refunds.js:55`, only ever runs against an `unpaid_table` order), a non-admin operator must additionally hold `pos.void_item` AND `pos.void_printed_item` AND `waiter.edit_locked` — the identical wall the table-save path applies, because the refund modal's void is a saved-table edit. `intent='refund'` (paid orders) is untouched and stays on `pos.refund` only.

> **Policy note (CONFIRMED by owner — Option A):** `waiter.edit_locked` IS required to void an open `unpaid_table` order via the refund modal. Any non-admin/programmer removing saved/printed units from an open table must hold `pos.refund` + `pos.void_item` + `pos.void_printed_item` + `waiter.edit_locked`; admin/programmer bypass. Paid refunds (`intent='refund'`) stay `pos.refund` only. A non-waiter void role lacking `waiter.edit_locked` must be granted it to keep the ability — this is intentional, not a gap.

**Files:** modify `backend/routes/pos/refunds.js`; modify + add tests in `backend/tests/integration/refunds.test.js`.

**Interfaces:**
- `refunds.js` currently destructures from `./helpers`: `isAdminUser`, `hasRefundPermission` (`:6`). ADD `hasVoidPermission`, `canVoidPrinted`, `canEditLocked` (all already exported from `helpers.js`: `:600`, `:604`, `:611`).
- `refunds.test.js` currently imports `seedDatabase, SEED` (`:4`) and builds `adminCookie`/`cashierCookie`/`waiterCookie` in `beforeEach` (`:9-17`). Helpers `seedOpenTableOrder()` (`:20`) and `seedPaidOrder()` (`:131`) already exist. This task adds an `invalidateUserSessions` import + a `grantWaiter(keys)` helper mirroring `tables.test.js:876`.

- [ ] **Step 0 (test scaffolding — add import + helper):** At the top of `refunds.test.js`, after `const { seedDatabase, SEED } = require('../fixtures/seed');` (`:4`), add:
```javascript
const { invalidateUserSessions } = require('../../middleware/auth');
```
  Inside the top `describe('POST /api/pos/refunds', ...)` block, directly after the `seedOpenTableOrder` helper (~:36), add:
```javascript
  // Grant the seeded waiter (id 3) an exact permission set, then return a fresh cookie.
  async function grantWaiter(keys) {
    await pool.query('DELETE FROM user_permissions WHERE user_id = ?', [SEED.waiterUser.id]);
    if (keys.length) {
      await pool.query('INSERT INTO user_permissions (user_id, perm_key) VALUES ?', [keys.map(k => [SEED.waiterUser.id, k])]);
    }
    invalidateUserSessions(SEED.waiterUser.id);
    const relog = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
    return relog.headers['set-cookie'][0];
  }
```

- [ ] **Step 1 (red — full failing test):** Add these four tests inside the same `describe`:
```javascript
  it('rejects intent=void from a pos.refund-only user lacking the void grants (403)', async () => {
    const cookie = await grantWaiter(['tables.access', 'pos.refund']); // no void perms
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, intent: 'void' });
    expect(res.status).toBe(403);
    // DB untouched — no refund row, order still open, table still occupied.
    const [[c]] = await pool.query('SELECT COUNT(*) c FROM refunds');
    expect(c.c).toBe(0);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
    const [[table]] = await pool.query('SELECT status FROM restaurant_tables WHERE id = 1');
    expect(table.status).toBe('occupied');
  });

  it('allows intent=void for a user with pos.refund + both void grants + waiter.edit_locked', async () => {
    const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked', 'pos.refund', 'pos.void_item', 'pos.void_printed_item']);
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, intent: 'void' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('void');
  });

  it('rejects intent=void when the user has both void grants but NOT waiter.edit_locked (403)', async () => {
    const cookie = await grantWaiter(['tables.access', 'pos.refund', 'pos.void_item', 'pos.void_printed_item']); // no edit_locked
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, intent: 'void' });
    expect(res.status).toBe(403);
    const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
    expect(order.payment_method).toBe('unpaid_table');
  });

  it('still lets a pos.refund-only user refund a PAID order (void gate must not leak)', async () => {
    const cookie = await grantWaiter(['pos.refund']); // refund grant only
    const { invoiceId } = await seedPaidOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, intent: 'refund', refund_method: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('refund');
  });
```

- [ ] **Step 2 (run → FAIL):** `npx vitest run backend/tests/integration/refunds.test.js`
  Expected: TWO tests FAIL — today `intent='void'` needs only `pos.refund`, so BOTH the refund-only waiter AND the both-void-grants-without-`waiter.edit_locked` waiter get `200` (their `expect(res.status).toBe(403)` assertions fail). The full-grant success test (refund + both void + `edit_locked`) and the paid-refund test PASS already and serve as regression guards.

- [ ] **Step 3 (minimal fix — imports):** In `refunds.js`, the require block (`:4-8`):
  BEFORE:
```javascript
const {
    pool, logger, getSettings, roundMoney, calculateLineTotal,
    sendError, sendSuccess, isAdminUser, hasRefundPermission,
    broadcastTableUpdate, invalidateDashboardCache, recomputeOrderTotals
} = require('./helpers');
```
  AFTER:
```javascript
const {
    pool, logger, getSettings, roundMoney, calculateLineTotal,
    sendError, sendSuccess, isAdminUser, hasRefundPermission,
    hasVoidPermission, canVoidPrinted, canEditLocked,
    broadcastTableUpdate, invalidateDashboardCache, recomputeOrderTotals
} = require('./helpers');
```

- [ ] **Step 4 (minimal fix — the gate):** In `refunds.js`, the intent/state validation ends at `const kind = intent;` (`:63`). Insert the void-perm gate immediately AFTER that line and BEFORE the `// Voids now honor item selection` comment (`:65`). By this point `refunds.js:55-58` has already 409'd any `intent='void'` on a non-`unpaid_table` order, so this gate can only ever fire for open-table voids:
  BEFORE:
```javascript
        const kind = intent;

        // Voids now honor item selection (partial void). Omitted items => whole order.
        const effectiveItems = requestedItems;
```
  AFTER:
```javascript
        const kind = intent;

        // Canonical void wall: removing/reducing saved+printed units off an open
        // unpaid_table order is the SAME action the table-save path gates behind
        // pos.void_item + pos.void_printed_item + waiter.edit_locked. Hold this path
        // to it too — pos.refund alone is not enough to strip printed units off a
        // saved table. intent='refund' (paid orders, already validated as NOT
        // unpaid_table above) never reaches here, so money refunds stay on
        // pos.refund only. Admin/programmer satisfy all grants.
        if (kind === 'void' && !isAdminUser(req.user)) {
            if (!hasVoidPermission(req.user) || !canVoidPrinted(req.user) || !canEditLocked(req.user)) {
                await conn.rollback();
                return sendError(res, 403, 'You do not have permission to void printed items.');
            }
        }

        // Voids now honor item selection (partial void). Omitted items => whole order.
        const effectiveItems = requestedItems;
```
  Note: message has no `Table`/`exist` pair → survives `sendError`. `await conn.rollback()` matches the file's other early-exit pattern (e.g. `:47-49`).

- [ ] **Step 5 (fix the now-broken pre-existing test):** Applying Step 4 breaks the existing test **`refunds.test.js:78` — `it('allows a non-admin user holding the pos.refund grant (waiter)', ...)`**, because the seeded default waiter holds `pos.refund` but no void grants, so its `intent='void'` now returns 403 instead of 200. Update that test to grant the void perms (it becomes a second success-case guard using `grantWaiter`):
  BEFORE:
```javascript
  it('allows a non-admin user holding the pos.refund grant (waiter)', async () => {
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', waiterCookie)
      .send({ invoice_id: invoiceId, intent: 'void' });
    expect(res.status).toBe(200);
  });
```
  AFTER:
```javascript
  it('allows a non-admin user holding pos.refund + both void grants + edit_locked (waiter)', async () => {
    const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked', 'pos.refund', 'pos.void_item', 'pos.void_printed_item']);
    const invoiceId = await seedOpenTableOrder();
    const res = await request(app).post('/api/pos/refunds')
      .set('Cookie', cookie)
      .send({ invoice_id: invoiceId, intent: 'void' });
    expect(res.status).toBe(200);
  });
```
  Leave every other existing test untouched: the `intent='void'` hardening/partial tests (`:227`, `:244`, `:336-434`) all use `adminCookie` and admin bypasses the new gate; the `cashierCookie` 403 test (`:38`) trips the outer `pos.refund` gate first and is unaffected.

- [ ] **Step 6 (run → PASS):** `npx vitest run backend/tests/integration/refunds.test.js` — all green (three new tests + repurposed `:78` + the untouched suite).

- [ ] **Step 7 (regression trio):** `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/unit/orderSessionStore.test.js` — all green.

- [ ] **Step 8 (commit):** `git add backend/routes/pos/refunds.js backend/tests/integration/refunds.test.js` then
  `git commit -m "fix(refunds): intent=void requires void_item + void_printed_item (paid refund unchanged)"`

**Risk:** low. The only behavior change for non-admins is the new 403; paid refunds are provably unaffected (guarded by the paid-refund guard test). The one pre-existing test that assumed refund-only void is intentionally updated to the new model.

---

## Task 3 — P3-11: `clearCart` must gate a saved-order clear on BOTH void perms + `edit_locked`

**Finding P3-11** — `assets/js/composables/stores/orderSessionStore.js` `clearCart` (~:1486) reads `if (hasSavedItems && !canBypassPrintedLock.value)` — it checks only `pos.void_printed_item`, while the sibling saved-line mutators `removeSelectedCartItem` (~:1558) and `applyLiveNumpad` (~:1583/:1602) require BOTH void perms. `clearCart` is local-only (no persist, no DB impact) but the rule is inconsistent: an operator with `void_printed_item` but not `void_item` can wipe a saved cart locally.

**Files:** modify `assets/js/composables/stores/orderSessionStore.js`; add tests to `backend/tests/unit/orderSessionStore.test.js`.

**Interfaces:**
- `clearCart = async (opts = {}) => {...}` — `hasSavedItems = cart.value.some(i => i.originalQty && i.originalQty > 0)`.
- Computed gates already in the store: `canBypassPrintedLock` (`pos.void_printed_item`, `:520`), `canVoidItems` (`pos.void_item`, `:522`), `canUpdateTable` (`waiter.edit_locked`, `:345`).
- Test harness: hoisted `mockPermissionsState.can` (`:37`) drives `usePermissions().can(key)`. Mirror the existing `describe('useOrderSessionStore - saved row delete permissions', ...)` (`:797`) — set `global.window.showPosToast = vi.fn()` in `beforeEach`, use `can.mockImplementation((key) => key === 'pos.void_printed_item')`, and reset in `afterEach`. `window.showPosConfirm` is globally mocked to resolve `true` (`:17`).

- [ ] **Step 1 (red — full failing test):** In `orderSessionStore.test.js`, add a new describe (place it right after the existing `describe('useOrderSessionStore - saved row delete permissions', ...)` block, ~:824):
```javascript
describe('clearCart saved-order permission gate (P3-11)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    global.window.showPosToast = vi.fn();
  });
  afterEach(() => {
    mockPermissionsState.can.mockReset();
    mockPermissionsState.can.mockReturnValue(true);
  });

  it('blocks clearing a saved cart when the user lacks pos.void_item', async () => {
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.void_printed_item');
    const store = useOrderSessionStore();
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];

    await store.clearCart();

    expect(store.cart).toHaveLength(1); // unchanged
    expect(global.window.showPosToast).toHaveBeenCalledWith(
      'You do not have permission to clear a saved order.',
      'error'
    );
  });

  it('clears a saved cart when the user holds BOTH void perms + edit_locked', async () => {
    mockPermissionsState.can.mockReturnValue(true); // both void perms + edit_locked present
    const store = useOrderSessionStore();
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];

    await store.clearCart({ skipConfirm: true });

    expect(store.cart).toEqual([]);
  });

  it('blocks clearing a saved cart when the user lacks waiter.edit_locked (canUpdateTable)', async () => {
    // Both void perms present, waiter.edit_locked absent.
    mockPermissionsState.can.mockImplementation((key) => key === 'pos.void_item' || key === 'pos.void_printed_item');
    const store = useOrderSessionStore();
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];

    await store.clearCart();

    expect(store.cart).toHaveLength(1); // unchanged
    expect(global.window.showPosToast).toHaveBeenCalledWith(
      'You do not have permission to clear a saved order.',
      'error'
    );
  });
});
```

- [ ] **Step 2 (run → FAIL):** `npx vitest run backend/tests/unit/orderSessionStore.test.js`
  Expected: the two blocking tests FAIL — pre-fix the guard only checks `!canBypassPrintedLock.value`, so both the `pos.void_printed_item`-only case AND the missing-`edit_locked` case leave the guard `false` and `clearCart` empties the cart (`expect(store.cart).toHaveLength(1)` fails; no toast). The BOTH-perms success test PASSES already (regression guard).

- [ ] **Step 3 (minimal fix):** In `orderSessionStore.js` `clearCart` (~:1485-1489):
  BEFORE:
```javascript
    const hasSavedItems = cart.value.some(item => item.originalQty && item.originalQty > 0);
    if (hasSavedItems && !canBypassPrintedLock.value) {
      window.showPosToast?.(t("You do not have permission to clear a saved order."), "error");
      return;
    }
```
  AFTER:
```javascript
    const hasSavedItems = cart.value.some(item => item.originalQty && item.originalQty > 0);
    if (hasSavedItems && (!canVoidItems.value || !canBypassPrintedLock.value || !canUpdateTable.value)) {
      window.showPosToast?.(t("You do not have permission to clear a saved order."), "error");
      return;
    }
```

- [ ] **Step 4 (run → PASS):** `npx vitest run backend/tests/unit/orderSessionStore.test.js` — all three new tests green; the whole file green (the existing `clearCart clears customer...` test at `:832` uses a cart WITHOUT `originalQty`, so `hasSavedItems` is `false` and the guard never fires — unchanged).

- [ ] **Step 5 (regression trio):** `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/unit/orderSessionStore.test.js` — all green.

- [ ] **Step 6 (commit):** `git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js` then
  `git commit -m "fix(pos): clearCart gates saved-order clear on both void perms + edit_locked"`

**Risk:** none — UX-only local gate. `clearCart` now requires the full canonical set (`pos.void_item` + `pos.void_printed_item` + `canUpdateTable`/`edit_locked`); `removeSelectedCartItem`/`applyLiveNumpad` reach the same set in Task 4, so all three local saved-item gates are identical once Task 4 lands (until then `clearCart` is intentionally the stricter of the two — never looser).

---

## Task 4 — P3-16: `removeSelectedCartItem` / `applyLiveNumpad` must also gate on `canUpdateTable` (`edit_locked`)

**Finding P3-16** — `orderSessionStore.js` `removeSelectedCartItem` (~:1558) and `applyLiveNumpad` (~:1583/:1602) check only the two void perms, not `canUpdateTable`. A user with both void perms but no `waiter.edit_locked` can locally delete/reduce a saved line; the subsequent save then fails at the backend precondition (`tables.js` `ensureCanUpdateTable`/`canEditLocked` ~:1248/:1267) — so the line vanishes from the UI, then the save silently fails. DB stays correct (deny) but UX is broken (screen desyncs from server). The local gate must match the backend precondition: you must be table-edit-capable to touch a saved line at all.

**Files:** modify `assets/js/composables/stores/orderSessionStore.js`; add tests to `backend/tests/unit/orderSessionStore.test.js`.

**Interfaces:**
- `canUpdateTable` computed already exists (`:345`, `permissions.can('waiter.edit_locked')`), returns `false` when there is no active user.
- `removeSelectedCartItem = () => {...}` guard (~:1558); `applyLiveNumpad = () => {...}` guards (~:1583 NaN-qty branch, ~:1602 numeric-qty branch).
- Test harness identical to Task 3 (hoisted `mockPermissionsState.can`, `global.window.showPosToast`). `useOrderUiStore` is already imported (`:55`) for driving `numpadMode`/`numpadInput`.

- [ ] **Step 1 (red — full failing test):** In `orderSessionStore.test.js`, add a new describe after the Task-3 block:
```javascript
describe('saved-line edits also require canUpdateTable / edit_locked (P3-16)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    global.window.showPosToast = vi.fn();
  });
  afterEach(() => {
    mockPermissionsState.can.mockReset();
    mockPermissionsState.can.mockReturnValue(true);
  });

  it('removeSelectedCartItem is blocked when the user has both void perms but not edit_locked', () => {
    // Both void perms present, waiter.edit_locked absent.
    mockPermissionsState.can.mockImplementation(
      (key) => key === 'pos.void_item' || key === 'pos.void_printed_item'
    );
    const store = useOrderSessionStore();
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];
    store.selectedCartIndex = 0;

    store.removeSelectedCartItem();

    expect(store.cart).toHaveLength(1); // unchanged
    expect(global.window.showPosToast).toHaveBeenCalledWith(
      'You do not have permission to remove a saved item.',
      'error'
    );
  });

  it('applyLiveNumpad qty change on a saved line is blocked without edit_locked', () => {
    mockPermissionsState.can.mockImplementation(
      (key) => key === 'pos.void_item' || key === 'pos.void_printed_item'
    );
    const store = useOrderSessionStore();
    store.cart = [{ id: 10, name: 'Burger', price: 5, qty: 1, originalQty: 1 }];
    store.selectedCartIndex = 0;
    const ui = useOrderUiStore();
    ui.numpadMode = 'qty';
    ui.numpadInput = '2';

    store.applyLiveNumpad();

    expect(store.cart[0].qty).toBe(1); // qty NOT changed
    expect(global.window.showPosToast).toHaveBeenCalledWith(
      'You do not have permission to modify a saved item. Add a new line instead.',
      'error'
    );
  });
});
```

- [ ] **Step 2 (run → FAIL):** `npx vitest run backend/tests/unit/orderSessionStore.test.js`
  Expected: BOTH new tests FAIL — today, with both void perms true and `edit_locked` false, `(!canVoidItems || !canBypassPrintedLock)` is `false`, the guard is skipped, so `removeSelectedCartItem` splices the item (`toHaveLength(1)` fails) and `applyLiveNumpad` sets `qty` to `2` (`toBe(1)` fails).

- [ ] **Step 3 (minimal fix — three guards):**
  Guard A — `removeSelectedCartItem` (~:1558):
  BEFORE:
```javascript
      if (item.originalQty && item.originalQty > 0 && (!canVoidItems.value || !canBypassPrintedLock.value)) {
```
  AFTER:
```javascript
      if (item.originalQty && item.originalQty > 0 && (!canVoidItems.value || !canBypassPrintedLock.value || !canUpdateTable.value)) {
```
  Guard B — `applyLiveNumpad`, NaN-qty branch (~:1583):
  BEFORE:
```javascript
        if (item.originalQty && item.originalQty > 1) {
          if (!canVoidItems.value || !canBypassPrintedLock.value) {
```
  AFTER:
```javascript
        if (item.originalQty && item.originalQty > 1) {
          if (!canVoidItems.value || !canBypassPrintedLock.value || !canUpdateTable.value) {
```
  Guard C — `applyLiveNumpad`, numeric-qty branch (~:1602):
  BEFORE:
```javascript
      if (item.originalQty && targetQty !== item.originalQty) {
        if (!canVoidItems.value || !canBypassPrintedLock.value) {
```
  AFTER:
```javascript
      if (item.originalQty && targetQty !== item.originalQty) {
        if (!canVoidItems.value || !canBypassPrintedLock.value || !canUpdateTable.value) {
```
  (Do NOT alter the void-perm operands — this only APPENDS the `|| !canUpdateTable.value` term, per the baseline note.)

- [ ] **Step 4 (run → PASS):** `npx vitest run backend/tests/unit/orderSessionStore.test.js` — both new tests green; whole file green. The existing `saved row delete permissions` test (`:809`) still passes: it grants only `pos.void_printed_item`, so `!canVoidItems.value` is already `true` and the item stays blocked regardless of the new term. Default-`can=true` tests (e.g. `:341`, `:410`) have `canUpdateTable=true`, so the appended term is `false` and behavior is unchanged.

- [ ] **Step 5 (regression trio):** `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/unit/orderSessionStore.test.js` — all green.

- [ ] **Step 6 (commit):** `git add assets/js/composables/stores/orderSessionStore.js backend/tests/unit/orderSessionStore.test.js` then
  `git commit -m "fix(pos): saved-line remove/numpad require edit_locked (match backend precondition)"`

**Risk:** low. Adds a stricter local gate that mirrors the backend deny — it can only PREVENT a UI mutation that would have failed to persist anyway, eliminating the screen/DB desync. No user who could successfully save a saved-line edit loses the ability to do so.

---

## Post-plan verification (run before declaring done)
- `npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/refunds.test.js backend/tests/unit/orderSessionStore.test.js` — all green.
- `npx vitest run backend/tests/` — no regressions across the suite.
- Manual smoke (server is the authority — verify the DENY, not just the UI):
  - Crafted empty-cart POST to `/api/pos/table_order` as a `void_item`-only operator → 403, table still occupied.
  - `/api/pos/refunds` `intent='void'` as a `pos.refund`-only operator → 403; as a `refund`+both-void operator → table freed. Paid `intent='refund'` as `pos.refund`-only → still succeeds.
  - In `/pos`, as an operator missing `edit_locked` (but holding both void perms), select a saved line → Remove and numpad-qty are blocked with a toast (no vanish-then-silent-fail).

## Self-Review
- **Canonical model stated first, then every gate aligned to it.** The Architecture table maps all five touchpoints to the one rule; Tasks 1/2/3/4 each cite their finding id + exact file:line + defect and change only their gate. The already-correct per-line path is explicitly frozen.
- **Server-authority preserved.** Backend gates (Tasks 1, 2) are the enforcing walls; FE gates (Tasks 3, 4) are labeled UX-only and only ever tighten toward the backend. No backend check is weakened.
- **Sanitizer + status mapping checked for every new message.** No new message contains `exist`; `tables.js` throws use the `Forbidden:` prefix (→403); `refunds.js` uses an explicit `sendError(res, 403, ...)`. Confirmed against `helpers.js:23-31` and `tables.js:1514-1534`.
- **Pre-existing test breakage surfaced, not hidden.** Task 2 Step 5 explicitly repurposes `refunds.test.js:78` (the only test that assumed refund-only void) and documents why every other `intent='void'` test (admin cookie) and the `cashier` 403 test are unaffected. Tasks 3/4 verify the existing `saved row delete permissions` and `clearCart clears customer...` tests stay green by construction.
- **TDD shape is real, not performative.** Every task's Step 2 names the concrete failing assertion and the current (wrong) value; each regression-guard test that passes before the fix is labeled as such rather than dressed up as red.
- **Ordering is safe.** Tasks are independent gates; running them in order 1→4 and re-running the trio after each catches any cross-path surprise. No task depends on another's code.
- **Open assumption to verify during execution (re-open before coding):** line numbers cited (~) may have drifted from the owner's in-flight WIP on `orderSessionStore.js`/`tables.js` — each step anchors on a unique BEFORE snippet, not a raw line number, so match by text.

## Cross-plan file overlap
This plan edits three files also touched by sibling table-workflow plans. Sequence to avoid churn; re-run the trio after each merge.
- **`backend/routes/pos/tables.js`** — Task 1 edits the empty-cart void branch (~:975). Overlaps **Plans 1/2/3/7** (other `tables.js` regions). Distinct region; land whichever first, then rebase the other on text anchors.
- **`backend/routes/pos/refunds.js`** — Task 2 edits the permission-gate region (`:4-8` imports, gate inserted after `:63`). **Plan 5** touches the refunds **money** region (~:70-226). Non-overlapping line ranges, but SEQUENCE Plan 5 and this plan (do not merge both un-rebased) — both change the same file. Recommend this plan (top-of-handler gate) lands first; Plan 5 rebases below `:65`.
- **`assets/js/composables/stores/orderSessionStore.js`** — Tasks 3 & 4 edit `clearCart` (~:1486) and `removeSelectedCartItem`/`applyLiveNumpad` (~:1558/:1583/:1602). Overlaps **Plans 4/7**. Region-distinct; anchor on the BEFORE snippets.
- **Shared test files** — `backend/tests/integration/tables.test.js`, `backend/tests/integration/refunds.test.js`, `backend/tests/unit/orderSessionStore.test.js` are appended-to (new `it`/`describe` blocks; one existing `refunds.test.js:78` test repurposed). Additive; resolve any conflict by keeping both sets of tests.
