# Shifts Page Bug-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 verified bugs on the admin Shifts page (`Shifts.vue`) + its two backend routes (`admin/shifts.js` force-close, `auth.js` update_cash): silent print failure, missing audit trail on drawer-mutating ops, stale UI state, a validation-500, a false-success, and a query-param truthiness bug.

**Architecture:** Backend fixes are Express + mysql2 handlers, tested with supertest integration tests in `backend/tests/integration/shift.test.js` (real MySQL `posapp_test` DB). Frontend fixes are edits to one Vue 3 SFC (`src/admin/pages/Shifts.vue`); they are guarded by **source-string assertion** tests (read the `.vue` file, regex-assert the code shape) — the established pattern in this repo (see `src/components/pos/RefundModal.ispaid.spec.js`), which avoids needing jsdom because vitest runs in `environment: 'node'`.

**Tech Stack:** Node.js/Express, mysql2, Vue 3 (Composition API, Options `setup()`), Vitest + supertest, Vite.

## Global Constraints

- **Test runner is Vitest, NOT jest.** Run tests with `npx vitest run <file>`. Do **NOT** run `npm test` — in this repo `npm test` runs `vite build`, not the test suite.
- **Build command:** `npm run build:admin` (= `vite build`). Must exit 0 (green) after all changes.
- **Prerequisite:** XAMPP MySQL must be running. The integration tests connect to the `posapp_test` database via `backend/tests/globalSetup.mjs`; every FE spec also boots that pool. If MySQL is down, even the FE source-assertion tests fail at global setup.
- **The working tree is clean at plan start.** Do all work on a new branch (Step 0). Do NOT `git stash`. Stage only the specific files each task changes.
- **Money formatting** already uses `src/utils/money.js` (`formatMoney`, `varianceIsZero`) on the frontend — do not add new money helpers.
- **Do NOT touch** the Items-report button label `<span data-no-i18n>تقرير الأصناف</span>` (Shifts.vue:138) — the owner hardcoded that Arabic deliberately.
- **Do NOT touch** the backend variance float math (`admin/shifts.js:203`) — it is a cosmetic/display concern deferred to the separate future-proofing plan, out of scope here.
- **audit_events schema** (already exists in `posapp_test`): columns `event_type` (VARCHAR 64), `user_id`, `manager_id`, `entity_type`, `entity_id`, `old_value` (TEXT/JSON), `new_value` (TEXT/JSON), `ip_address`, `created_at`. Mirror the in-transaction insert pattern used in `backend/routes/pos/refunds.js:396`.
- Every edit below is given as **Find this exact code** / **Replace with**. Match whitespace exactly. Line numbers are hints only — anchor on the code snippet, because earlier edits shift later line numbers.

---

## File Structure

- **Modify** `backend/routes/auth.js` — harden + transactionalize + audit the `update_cash` action (Task 1).
- **Modify** `backend/routes/admin/shifts.js` — add force-close audit_events (Task 2); fix `force` query-param truthiness (Task 3).
- **Modify** `backend/tests/integration/shift.test.js` — add backend tests for Tasks 1–3.
- **Modify** `src/admin/pages/Shifts.vue` — 4 frontend fixes (Tasks 4–7).
- **Create** `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js` — source-assertion tests for Tasks 4–7.

---

## Step 0: Create the working branch

- [ ] **Step 0.1: Branch off master**

```bash
git checkout -b fix/shifts-page-bugs
git status   # expect: clean working tree, on branch fix/shifts-page-bugs
```

---

## Task 1: Harden + audit `update_cash` (auth.js)

Fixes three bugs at once on `PUT /api/auth/shifts?action=update_cash`:
- **L1** — a request missing `shift_id` binds `undefined` into SQL → mysql2 throws → **500**. Should be a clean **400**.
- **L4** — editing a *closed* shift matches 0 rows (`WHERE ... status='open'`) but still returns `"Starting cash updated."` (false success). Should be **400**. Also the count-check and the update run on separate pooled connections (TOCTOU) — wrap them in one transaction.
- **H2 (part 1)** — a drawer-float edit writes **no `audit_events`** row. Add one, in the same transaction.

**Files:**
- Modify: `backend/routes/auth.js` (the `update_cash` branch, ~lines 478–502)
- Test: `backend/tests/integration/shift.test.js`

**Interfaces:**
- Produces: `PUT /api/auth/shifts?action=update_cash` now returns 400 (not 500) when `shift_id` is missing/invalid; returns 400 when the shift is not open; on success writes an `audit_events` row with `event_type='shift_cash_edited'`, `entity_type='shift'`, `entity_id=<shift id>`, `user_id=<editor's user id>`, `old_value={"starting_cash":<old>}`, `new_value={"starting_cash":<new>}`.
- Consumes (already imported in auth.js): `pool`, `sendError`, `sendSuccess`, `invalidateDashboardCache`, `canAccessShift`, `validateCashAmount` (via `require('./pos/helpers')`), `req.user.id`, `req.ip`.

- [ ] **Step 1.1: Write the failing tests**

Open `backend/tests/integration/shift.test.js`. Find the `Input validation` describe block near the end of the file:

```js
    describe('Input validation', () => {
        it('POST without user_id returns 400 not 500', async () => {
            const res = await request(app)
                .post('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ starting_cash: 50 });
            expect(res.statusCode).toBe(400);
        });
        it('PUT without id returns 400 not 500', async () => {
            const res = await request(app)
                .put('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ actual_cash: 50 });
            expect(res.statusCode).toBe(400);
        });
    });
});
```

Insert a NEW describe block immediately **before** the final closing `});` of the top-level `describe('Shift Integration Tests', ...)` — i.e. between the closing `});` of `Input validation` and the file's last `});`:

```js
    describe('update_cash hardening + audit (auth.js)', () => {
        it('returns 400 (not 500) when shift_id is missing', async () => {
            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ starting_cash: 50 });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('returns 400 (not a false success) when the shift is already closed', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20.00,
                status: 'closed',
                opened_at: '2026-07-01 08:00:00',
                closed_at: '2026-07-01 20:00:00',
            });
            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('open shift');
        });

        it('on success writes a shift_cash_edited audit row in the same transaction', async () => {
            const shiftId = await openCashierShift(50.00);
            const res = await request(app)
                .put('/api/auth/shifts?action=update_cash')
                .set('Cookie', cashierCookie)
                .send({ shift_id: shiftId, starting_cash: 75.00 });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const [audits] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'shift_cash_edited' AND entity_type = 'shift' AND entity_id = ?",
                [shiftId]
            );
            expect(audits).toHaveLength(1);
            expect(audits[0].user_id).toBe(SEED.cashierUser.id);
            expect(JSON.parse(audits[0].new_value).starting_cash).toBe(75);

            const [rows] = await pool.query("SELECT starting_cash FROM shifts WHERE id = ?", [shiftId]);
            expect(Number(rows[0].starting_cash)).toBe(75.00);
        });
    });
```

- [ ] **Step 1.2: Run the tests to verify they fail**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "update_cash hardening"`
Expected: The "missing shift_id" test FAILS (gets 500, not 400); the "already closed" test FAILS (gets 200 false-success); the "audit row" test FAILS (0 rows found). This proves the bugs exist.

- [ ] **Step 1.3: Implement the fix**

In `backend/routes/auth.js`, **Find this exact code**:

```js
        else if (method === 'PUT' && action === 'update_cash') {
            const { starting_cash, shift_id } = req.body;
            const access = await canAccessShift(req, shift_id);
            if (!access.allowed) return sendError(res, access.status, access.message);

            const { validateCashAmount } = require('./pos/helpers');
            const cash = validateCashAmount(starting_cash);
            if (!cash.valid) {
                return sendError(res, 400, cash.message);
            }

            if (req.user?.role !== 'programmer') {
                const [ordersCount] = await pool.query(
                    "SELECT COUNT(*) as count FROM orders WHERE shift_id = ?",
                    [shift_id]
                );
                if (ordersCount[0].count > 0) {
                    return sendError(res, 400, "Starting cash cannot be modified after transactions have occurred.");
                }
            }

            await pool.query("UPDATE shifts SET starting_cash = ? WHERE id = ? AND status = 'open'", [cash.value, shift_id]);
            invalidateDashboardCache();
            return sendSuccess(res, { message: "Starting cash updated." });
        }
```

**Replace with**:

```js
        else if (method === 'PUT' && action === 'update_cash') {
            const { starting_cash, shift_id } = req.body;
            const parsedShiftId = parseInt(shift_id, 10);
            if (!parsedShiftId) {
                return sendError(res, 400, "A valid shift id is required.");
            }
            const access = await canAccessShift(req, parsedShiftId);
            if (!access.allowed) return sendError(res, access.status, access.message);

            const { validateCashAmount } = require('./pos/helpers');
            const cash = validateCashAmount(starting_cash);
            if (!cash.valid) {
                return sendError(res, 400, cash.message);
            }

            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();

                // Lock the row; read prior state for the audit trail + status guard.
                const [rows] = await conn.query(
                    "SELECT starting_cash, status FROM shifts WHERE id = ? FOR UPDATE",
                    [parsedShiftId]
                );
                if (rows.length === 0) {
                    await conn.rollback();
                    return sendError(res, 404, "Shift not found.");
                }
                if (rows[0].status !== 'open') {
                    await conn.rollback();
                    return sendError(res, 400, "Starting cash can only be edited on an open shift.");
                }

                if (req.user?.role !== 'programmer') {
                    const [ordersCount] = await conn.query(
                        "SELECT COUNT(*) as count FROM orders WHERE shift_id = ?",
                        [parsedShiftId]
                    );
                    if (ordersCount[0].count > 0) {
                        await conn.rollback();
                        return sendError(res, 400, "Starting cash cannot be modified after transactions have occurred.");
                    }
                }

                const oldCash = parseFloat(rows[0].starting_cash || 0);
                await conn.query(
                    "UPDATE shifts SET starting_cash = ? WHERE id = ? AND status = 'open'",
                    [cash.value, parsedShiftId]
                );

                // Durable audit row in the SAME transaction as the mutation, so the
                // drawer-float edit and its trail commit together (atomic-audit policy).
                await conn.query(
                    `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                     VALUES ('shift_cash_edited', ?, 'shift', ?, ?, ?, ?)`,
                    [req.user.id, parsedShiftId,
                     JSON.stringify({ starting_cash: oldCash }),
                     JSON.stringify({ starting_cash: cash.value }),
                     req.ip || null]
                );

                await conn.commit();
                invalidateDashboardCache();
                return sendSuccess(res, { message: "Starting cash updated." });
            } catch (txErr) {
                await conn.rollback();
                throw txErr;
            } finally {
                conn.release();
            }
        }
```

- [ ] **Step 1.4: Run the tests to verify they pass**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "update_cash hardening"`
Expected: all 3 tests PASS.

- [ ] **Step 1.5: Commit**

```bash
git add backend/routes/auth.js backend/tests/integration/shift.test.js
git commit -m "fix(auth): harden update_cash — 400 on missing/closed shift + in-txn audit trail"
```

---

## Task 2: Audit force-close (admin/shifts.js)

**H2 (part 2)** — admin force-close (`PUT /api/admin/shifts`) closes another user's drawer, freezes `expected_cash`, and nulls their session token, but writes **no `audit_events`** row. The handler already runs inside a transaction (`conn`), so add the audit insert just before `commit`.

**Files:**
- Modify: `backend/routes/admin/shifts.js` (the `PUT` branch, just before `await conn.commit();`, ~line 329)
- Test: `backend/tests/integration/shift.test.js`

**Interfaces:**
- Produces: a successful force-close writes an `audit_events` row with `event_type='shift_force_closed'`, `entity_type='shift'`, `entity_id=<shift id>`, `user_id=<admin's user id>`, `old_value={"status":"open","cashier_user_id":<cashier id>}`, `new_value={"expected_cash":<computed>,"actual_cash":<counted>,"variance":<n>}`.
- Consumes (already in scope in that handler): `conn`, `req.user.id`, `req.ip`, `shift_id`, `shifts[0].user_id`, `computedExpectedCash`, `cash.value`.

- [ ] **Step 2.1: Write the failing test**

In `backend/tests/integration/shift.test.js`, inside the `update_cash hardening + audit (auth.js)` describe you added in Task 1 is NOT the right place — instead add a new describe block right after it (still before the file's final `});`):

```js
    describe('force-close audit (admin/shifts.js)', () => {
        it('writes a shift_force_closed audit row on successful force-close', async () => {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20.00,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });

            const res = await request(app)
                .put('/api/admin/shifts')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 20.00 });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const [audits] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'shift_force_closed' AND entity_type = 'shift' AND entity_id = ?",
                [shiftId]
            );
            expect(audits).toHaveLength(1);
            expect(audits[0].user_id).toBe(SEED.adminUser.id);
            expect(JSON.parse(audits[0].old_value).cashier_user_id).toBe(SEED.cashierUser.id);
        });
    });
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "force-close audit"`
Expected: FAIL — `audits` has length 0 (no audit row written yet).

- [ ] **Step 2.3: Implement the fix**

In `backend/routes/admin/shifts.js`, **Find this exact code** (inside the `PUT` branch):

```js
                // Terminate session token for the user of this shift in database
                await conn.query(
                    "UPDATE users SET session_token = NULL WHERE id = ?",
                    [shifts[0].user_id]
                );

                await conn.commit();
```

**Replace with**:

```js
                // Terminate session token for the user of this shift in database
                await conn.query(
                    "UPDATE users SET session_token = NULL WHERE id = ?",
                    [shifts[0].user_id]
                );

                // Durable audit row for this destructive admin action, in the SAME
                // transaction as the close so the two commit or roll back together.
                await conn.query(
                    `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, old_value, new_value, ip_address)
                     VALUES ('shift_force_closed', ?, 'shift', ?, ?, ?, ?)`,
                    [req.user.id, shift_id,
                     JSON.stringify({ status: 'open', cashier_user_id: shifts[0].user_id }),
                     JSON.stringify({
                         expected_cash: computedExpectedCash,
                         actual_cash: cash.value,
                         variance: Number((cash.value - computedExpectedCash).toFixed(3)),
                     }),
                     req.ip || null]
                );

                await conn.commit();
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "force-close audit"`
Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add backend/routes/admin/shifts.js backend/tests/integration/shift.test.js
git commit -m "fix(shifts): write in-txn audit_events on admin force-close"
```

---

## Task 3: Fix `force` query-param truthiness (admin/shifts.js)

**L2** — the open-table safety check is guarded by `if (!req.query.force)`. Query params are strings, so `?force=false` and `?force=0` are truthy → `!"false"` is `false` → the safety check is **skipped** (the exact opposite of intent). Change it to an explicit `=== 'true'` check so only `?force=true` overrides, and any other value (including none) runs the check.

**Files:**
- Modify: `backend/routes/admin/shifts.js` (the `PUT` branch, ~line 284)
- Test: `backend/tests/integration/shift.test.js`

**Interfaces:**
- Produces: `PUT /api/admin/shifts?force=false` (with an open unpaid table) → **409** (check runs); `PUT /api/admin/shifts?force=true` → **200** (override skips the check).

- [ ] **Step 3.1: Write the failing tests**

In `backend/tests/integration/shift.test.js`, add a new describe block after the `force-close audit` block (still before the file's final `});`):

```js
    describe('force query-param override semantics (admin/shifts.js)', () => {
        async function seedOpenTableShift() {
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 20.00,
                status: 'open',
                opened_at: '2026-07-01 08:00:00',
            });
            const [ins] = await pool.query(
                `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
                 VALUES ('FORCE-PARAM-TBL', ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
                [SEED.cashierUser.id, SEED.cashierUser.id, SEED.table.id, shiftId]
            );
            await pool.query(
                "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?",
                [ins.insertId, SEED.table.id]
            );
            return shiftId;
        }

        it('?force=false still runs the open-table safety check (returns 409)', async () => {
            const shiftId = await seedOpenTableShift();
            const res = await request(app)
                .put('/api/admin/shifts?force=false')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 20.00 });
            expect(res.statusCode).toBe(409);
            expect(res.body.success).toBe(false);
        });

        it('?force=true overrides the open-table check (returns 200)', async () => {
            const shiftId = await seedOpenTableShift();
            const res = await request(app)
                .put('/api/admin/shifts?force=true')
                .set('Cookie', adminCookie)
                .send({ id: shiftId, actual_cash: 20.00 });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });
```

- [ ] **Step 3.2: Run the tests to verify the first one fails**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "force query-param override"`
Expected: The `?force=false` test FAILS (currently returns 200 because the check is wrongly skipped). The `?force=true` test already passes.

- [ ] **Step 3.3: Implement the fix**

In `backend/routes/admin/shifts.js`, **Find this exact code**:

```js
                if (!req.query.force) {
```

**Replace with**:

```js
                if (req.query.force !== 'true') {
```

- [ ] **Step 3.4: Run the tests to verify they pass**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "force query-param override"`
Expected: both tests PASS.

- [ ] **Step 3.5: Commit**

```bash
git add backend/routes/admin/shifts.js backend/tests/integration/shift.test.js
git commit -m "fix(shifts): only ?force=true overrides open-table check (was string-truthy)"
```

---

## Task 4: Refresh audit status on reset + after mutations (Shifts.vue)

Fixes two bugs by routing all "reload after a change" callers through the existing `refreshAll()` helper (which calls both `fetchShifts()` and `fetchAuditStatus()`):
- **M1** — `clearAllFilters` (the always-visible toolbar **Reset**) never calls a fetch; it relies on filter watchers firing. If you are on page ≥ 2 with no active filters (all watched refs already at default), clicking Reset changes only `currentPage` (which nothing watches) → **no refetch** → grid keeps showing page-2 rows while the indicator says page 1.
- **M3** — `submitOpenShift`, `adminForceCloseShift`, and `updateStartingCash` call only `fetchShifts()`, never `fetchAuditStatus()`. Opening/closing a shift changes the audit toolbar's "N Open" badge and the Z-report enabled state, which then go stale until a manual Refresh.

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js` (created in this task)

**Interfaces:**
- Consumes: `refreshAll` (already defined in the SFC: `const refreshAll = () => { fetchShifts(); fetchAuditStatus(); };`).
- Produces: after this task the SFC calls `refreshAll()` in at least 4 places (submitOpenShift, adminForceCloseShift, updateStartingCash, clearAllFilters).

- [ ] **Step 4.1: Write the failing test**

Create `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js` with this content:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, '../Shifts.vue'), 'utf8');

describe('Shifts.vue bug-fixes', () => {
  it('M1: clearAllFilters triggers a refetch (fixes stale rows after Reset on page >= 2)', () => {
    const m = SRC.match(/const clearAllFilters = \(\) => \{[\s\S]*?\n        \};/);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/refreshAll\(\)/);
  });

  it('M3: mutation handlers refresh audit status too (refreshAll used >= 4 times)', () => {
    const count = (SRC.match(/refreshAll\(\)/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 4.2: Run the test to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`
Expected: both assertions FAIL (clearAllFilters has no `refreshAll()`; `refreshAll()` appears 0 times as a call).

- [ ] **Step 4.3: Implement — clearAllFilters (M1)**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```js
            showCashierFilter.value = false;
            showStatusFilter.value = false;
        };

        // filteredShifts retired (moved to server-side search)
```

**Replace with**:

```js
            showCashierFilter.value = false;
            showStatusFilter.value = false;
            refreshAll();
        };

        // filteredShifts retired (moved to server-side search)
```

- [ ] **Step 4.4: Implement — submitOpenShift (M3)**

**Find this exact code**:

```js
                if (data.success) {
                    showOpenModal.value = false;
                    fetchShifts();
                } else {
                    await window.showAdminAlert(data.message);
                }
```

**Replace with**:

```js
                if (data.success) {
                    showOpenModal.value = false;
                    refreshAll();
                } else {
                    await window.showAdminAlert(data.message);
                }
```

- [ ] **Step 4.5: Implement — adminForceCloseShift (M3)**

**Find this exact code**:

```js
                    showModal.value = false;
                    fetchShifts();
                } else {
                    await window.showAdminAlert(data.message);
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error while closing shift."));
```

**Replace with**:

```js
                    showModal.value = false;
                    refreshAll();
                } else {
                    await window.showAdminAlert(data.message);
                }
            } catch (e) {
                await window.showAdminAlert(t("Network error while closing shift."));
```

- [ ] **Step 4.6: Implement — updateStartingCash (M3)**

**Find this exact code**:

```js
                if (data.success) {
                    isEditingCash.value = false;
                    fetchShifts(); 
                    showModal.value = false; 
                } else {
                    await window.showAdminAlert(data.message);
                }
```

**Replace with**:

```js
                if (data.success) {
                    isEditingCash.value = false;
                    refreshAll();
                    showModal.value = false; 
                } else {
                    await window.showAdminAlert(data.message);
                }
```

- [ ] **Step 4.7: Run the test to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`
Expected: both assertions PASS.

- [ ] **Step 4.8: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.bugfix.spec.js
git commit -m "fix(shifts): refetch shifts + audit status on Reset and after open/close/cash-edit"
```

---

## Task 5: Sequence `fetchAuditStatus` against stale responses (Shifts.vue)

**M2** — `fetchShifts` guards against out-of-order responses with a `fetchSeq` token, but `fetchAuditStatus` has no such guard. It fires from mount, `refreshAll`, the date watcher, and after every audit print. If you change the business date quickly, an older response can resolve last and overwrite `auditStatus` with data for the wrong date (wrong Z-enable state, wrong reprint label, wrong "N Open" badge). Add an `auditSeq` token mirroring `fetchSeq`.

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`

- [ ] **Step 5.1: Add the failing test**

In `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`, add this `it` block inside the existing `describe('Shifts.vue bug-fixes', ...)`:

```js
  it('M2: fetchAuditStatus is guarded against stale overlapping responses', () => {
    expect(SRC).toMatch(/let auditSeq = 0/);
    const m = SRC.match(/const fetchAuditStatus = async \(\) => \{[\s\S]*?\n        \};/);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/\+\+auditSeq/);
    expect(m[0]).toMatch(/seq !== auditSeq/);
  });
```

- [ ] **Step 5.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js -t "M2"`
Expected: FAIL (no `auditSeq` yet).

- [ ] **Step 5.3: Implement — declare the token**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```js
        let searchTimer = null;
        let fetchSeq = 0;
```

**Replace with**:

```js
        let searchTimer = null;
        let fetchSeq = 0;
        let auditSeq = 0;
```

- [ ] **Step 5.4: Implement — guard the fetch**

**Find this exact code**:

```js
        const fetchAuditStatus = async () => {
            try {
                const params = new URLSearchParams({ business_date: filterDateFrom.value });
                const res = await fetch(`api/admin/audit-reports/status?${params.toString()}`);
                const data = await res.json();
                if (data.success) auditStatus.value = data;
            } catch (error) {
                console.error("Failed to load audit report status", error);
            }
        };
```

**Replace with**:

```js
        const fetchAuditStatus = async () => {
            const seq = ++auditSeq;
            try {
                const params = new URLSearchParams({ business_date: filterDateFrom.value });
                const res = await fetch(`api/admin/audit-reports/status?${params.toString()}`);
                const data = await res.json();
                if (seq !== auditSeq) return; // a newer audit-status fetch superseded this one
                if (data.success) auditStatus.value = data;
            } catch (error) {
                console.error("Failed to load audit report status", error);
            }
        };
```

- [ ] **Step 5.5: Run to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js -t "M2"`
Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.bugfix.spec.js
git commit -m "fix(shifts): sequence fetchAuditStatus to drop stale out-of-order responses"
```

---

## Task 6: Surface print failures in `printShiftReport` (Shifts.vue)

**H1** — `printShiftReport` swallows failures: on `!data.success` it only `console.error`s, and its `catch (e) { }` is empty. It is auto-invoked right after `adminForceCloseShift` succeeds, so a print failure leaves the shift closed (irreversible) with **no indication** the Z-report never printed. Alert the user on both failure paths, matching the sibling print functions.

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`

- [ ] **Step 6.1: Add the failing test**

In `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`, add inside the existing describe:

```js
  it('H1: printShiftReport surfaces failures (no silent empty catch)', () => {
    const m = SRC.match(/const printShiftReport = async \(\) => \{[\s\S]*?\n        \};/);
    expect(m).not.toBeNull();
    expect(m[0]).toMatch(/showAdminAlert/);
    expect(m[0]).not.toMatch(/catch \(e\) \{ \}/);
  });
```

- [ ] **Step 6.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js -t "H1"`
Expected: FAIL (`showAdminAlert` absent from that function; empty catch present).

- [ ] **Step 6.3: Implement the fix**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```js
                const data = await res.json();
                if (!data.success) console.error('Print error:', data.message);
            } catch (e) { } finally { isPrinting.value = false; }
```

**Replace with**:

```js
                const data = await res.json();
                if (!data.success) {
                    await window.showAdminAlert(data.message || t('Could not print the shift report.'));
                }
            } catch (e) {
                await window.showAdminAlert(t('Network error while printing the shift report.'));
            } finally {
                isPrinting.value = false;
            }
```

- [ ] **Step 6.4: Run to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js -t "H1"`
Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.bugfix.spec.js
git commit -m "fix(shifts): alert admin when shift-report print fails (was silent)"
```

---

## Task 7: Force-close counted-cash starts empty and is required (Shifts.vue)

**M4** — the force-close "Counted Cash" field is pre-seeded with the system-**expected** cash (`actualCashInput.value = shift.live_expected_cash`). An admin who force-closes without retyping records `actual == expected` → variance 0 → "Perfect", masking a real drawer shortage. Start the field empty and disable the Force Close button until a value is entered.

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`

- [ ] **Step 7.1: Add the failing test**

In `src/admin/pages/__tests__/shiftsPage.bugfix.spec.js`, add inside the existing describe:

```js
  it('M4: force-close Counted Cash starts empty and requires a value', () => {
    expect(SRC).not.toMatch(/actualCashInput\.value = shift\.live_expected_cash/);
    expect(SRC).toMatch(/actualCashInput\.value = ''/);
    const btn = SRC.match(/@click="adminForceCloseShift"[^>]*:disabled="([^"]*)"/);
    expect(btn).not.toBeNull();
    expect(btn[1]).toMatch(/actualCashInput === ''/);
  });
```

- [ ] **Step 7.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js -t "M4"`
Expected: FAIL (field is still pre-seeded; button disable does not check emptiness).

- [ ] **Step 7.3: Implement — start the field empty**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```js
        const openShiftModal = (shift) => {
            selectedShift.value = shift;
            actualCashInput.value = shift.live_expected_cash;
            isEditingCash.value = false; 
```

**Replace with**:

```js
        const openShiftModal = (shift) => {
            selectedShift.value = shift;
            actualCashInput.value = '';
            isEditingCash.value = false; 
```

- [ ] **Step 7.4: Implement — the ref default (cosmetic consistency)**

**Find this exact code**:

```js
        const actualCashInput = ref(0);
```

**Replace with**:

```js
        const actualCashInput = ref('');
```

- [ ] **Step 7.5: Implement — require a value before force-close**

**Find this exact code**:

```js
                            <button @click="adminForceCloseShift" :disabled="isClosing" class="w-full h-9 bg-destructive text-destructive-foreground font-medium text-xs rounded-lg hover:bg-destructive/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 focus:outline-none">
```

**Replace with**:

```js
                            <button @click="adminForceCloseShift" :disabled="isClosing || actualCashInput === '' || actualCashInput === null" class="w-full h-9 bg-destructive text-destructive-foreground font-medium text-xs rounded-lg hover:bg-destructive/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2 focus:outline-none">
```

- [ ] **Step 7.6: Run to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.bugfix.spec.js -t "M4"`
Expected: PASS.

- [ ] **Step 7.7: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.bugfix.spec.js
git commit -m "fix(shifts): force-close counted cash starts empty and is required (no fake 0 variance)"
```

---

## Final Verification

- [ ] **V.1: Run the full test suite — everything green**

Run: `npx vitest run`
Expected: ALL tests pass (the existing shift suite + the new Task 1–3 backend tests + the new `shiftsPage.bugfix.spec.js` FE tests). Zero failures. If any pre-existing test fails, STOP and report — do not "fix" it by changing assertions.

- [ ] **V.2: Build the admin bundle — green**

Run: `npm run build:admin`
Expected: exits 0, no Vue compile / Vite errors. (This catches any template typo introduced in Tasks 4–7.)

- [ ] **V.3: Manual smoke (if a running app + printer/spooler is available)**

These behavioral fixes are worth a quick manual pass; the FE source-tests only prove code shape, not runtime behavior:
1. **M1:** With > 50 shifts and no filters, page to page 2, click toolbar **Reset** → list returns to page 1 rows, indicator matches.
2. **M3:** Open a shift → the "N Open" badge / Z-report button state updates without a manual Refresh.
3. **H1 / M4:** Open the force-close modal → Counted Cash is **empty**, Force Close is **disabled**; type a value, force-close with the printer offline → you get an alert that the print failed (shift still closes).
4. **M2:** Rapidly switch the business date back and forth → the audit toolbar ends on the currently-selected date's status.

- [ ] **V.4: Confirm branch state**

```bash
git log --oneline master..HEAD   # expect 7 fix commits
git status                        # expect clean tree
```

---

## Owner Notes / Explicitly Deferred (do NOT do here)

These were found in the audit but are intentionally **out of this bug-fix plan** (they go in a separate future-proofing plan):
- **C1 backend variance float** (`admin/shifts.js:203`) — display precision only; frontend already renders via `varianceIsZero`. Left as-is.
- **M5 missing i18n keys** (Print queued / Could not print… etc.) — render English in Arabic mode. i18n cleanup, deferred.
- **L3 negative cash inputs** lack `min="0"` — backend `validateCashAmount` already rejects them (400 + alert). Cosmetic.
- **L5 Period toggle keyboard-inaccessible** (`class="hidden"` checkbox) — a11y, deferred.
- **Slop:** emoji/braggy comments (`// 🛑 THE FIX:` etc.), dead tombstone comments, duplicated variance/status-pill markup, `aria-haspopup="menu"` without `role="menu"`, `shifts.js:180-185` dead `total_discounts:0` fallback, the two disagreeing `cashiers` endpoints, pervasive `focus:outline-none`.
- **`force=true` override is unreachable from the UI** — Task 3 makes the query-param semantics correct, but no UI wires an override yet. Deciding whether admins should be *able* to override open tables is a product decision, not a bug fix.
- **auth.js `close` / `zreport` / `check` actions** share the same raw-`shift_id`/`user_id` → 500 class as L1, but they are outside the agreed scope (Shifts page + `update_cash`). Harden them in a follow-up.

---

## Plan Self-Review (done before handoff)

- **Assumption that could be false:** that `posapp_test` has the `audit_events` table. Verified — the migration `backend/migrations/2026-06-05-fraud-audit-tables.sql` creates it and existing suites (`refunds.test.js`, `security.test.js`) already assert on it, so it is present in the test DB.
- **Test that could pass for the wrong reason:** the FE source-assertion tests prove code *shape*, not behavior — hence V.3 manual smoke. The `refreshAll()` count test (`>= 4`) is coarse; the paired M1 body test pins the important call site (`clearAllFilters`).
- **Regression risk:** Task 4 routes mutation handlers through `refreshAll()`, which now also calls the newly-sequenced `fetchAuditStatus` (Task 5) — no double-apply risk because `fetchSeq`/`auditSeq` dedupe. Task 1 wraps `update_cash` in a transaction; the pre-existing "update_cash after first order is blocked" and "invalid value → 400" tests (shift.test.js) still exercise it and must stay green (covered by V.1).
- **Must ship together:** none. Each task is independent and independently testable/committable. Backend (1–3) and frontend (4–7) do not depend on each other.
- **Ordering:** Task 5 (`auditSeq`) after Task 4 is intentional — Task 4 increases `fetchAuditStatus` call frequency, so the sequencing guard is more valuable once both land, but neither breaks without the other.
