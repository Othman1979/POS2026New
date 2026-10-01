# Shifts Page Future-Proofing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Non-bug cleanup + hardening for the admin Shifts page: harden 3 API validation holes, remove a dead endpoint + dead code, round backend variance, add 6 missing Arabic i18n keys, fix input constraints and a keyboard-a11y gap, strip AI-slop comments/aria, and de-duplicate the variance-display logic.

**Architecture:** Backend changes are Express + mysql2 handlers in `auth.js` / `admin/shifts.js`, tested with supertest integration tests in `backend/tests/integration/shift.test.js` (real MySQL `posapp_test`). Frontend changes edit one Vue 3 SFC (`src/admin/pages/Shifts.vue`) + the i18n dictionary (`assets/js/admin/i18n.js`); they are guarded by **source-string assertion** tests (read the file, regex-assert its shape) — the established pattern here (`RefundModal.ispaid.spec.js`, `shiftsPage.bugfix.spec.js`), which needs no jsdom because vitest runs `environment: 'node'`.

**Tech Stack:** Node.js/Express, mysql2, Vue 3 (Options `setup()`), Vitest + supertest, Vite.

## Global Constraints

- **Test runner is Vitest, NOT jest.** Run tests with `npx vitest run <file>`. Do **NOT** run `npm test` — in this repo `npm test` runs `vite build`, not the tests.
- **Build command:** `npm run build:admin` (= `vite build`). Must exit 0 after all changes.
- **Prerequisite:** XAMPP MySQL must be running (integration tests + every FE spec boot the `posapp_test` pool via `backend/tests/globalSetup.mjs`).
- **The working tree is clean at plan start** (the bug-fix branch was merged to master). Do all work on a NEW branch (Step 0). Do NOT `git stash`. Stage only the specific files each task changes.
- **Do NOT touch** the Items-report button label `<span data-no-i18n>تقرير الأصناف</span>` — the owner hardcoded that Arabic on purpose.
- **Every edit below is given as “Find this exact code” / “Replace with”.** Match whitespace exactly. Line numbers are hints — anchor on the code text; earlier edits shift later line numbers.
- This is a **future-proofing** plan (cleanup + hardening). None of it changes a user-visible happy path. If any task’s test reveals a real behavior break, STOP and report.

---

## File Structure

- **Modify** `backend/routes/auth.js` — 3 validation guards (Task 1); delete orphan cashiers action (Task 2).
- **Modify** `backend/routes/admin/shifts.js` — round variance + drop dead fallback key (Task 3).
- **Modify** `assets/js/admin/i18n.js` — 6 missing print-message keys (Task 4).
- **Modify** `src/admin/pages/Shifts.vue` — input `min` (Task 5), Period-toggle a11y (Task 6), comment/aria cleanup (Task 7), variance-display helper (Task 8).
- **Modify** `backend/tests/integration/shift.test.js` — backend tests (Tasks 1–3).
- **Create** `src/admin/pages/__tests__/shiftsPage.quality.spec.js` — source-assertion tests (Tasks 4–8).

---

## Step 0: Create the working branch

- [ ] **Step 0.1**

```bash
git checkout -b chore/shifts-future-proofing
git status   # expect: clean, on branch chore/shifts-future-proofing
```

---

## Task 1: Harden the 3 `auth.js` validation holes (check / zreport / close)

`GET check` (raw `user_id`), `GET zreport` (raw `shift_id`), and `PUT close` (raw `shift_id`) pass the id straight into mysql2. A missing id binds `undefined` → mysql2 throws → **500**. Add a `parseInt` guard to each so a missing/invalid id returns a clean **400** (mirrors the `update_cash` fix already on master). Not reachable from the Shifts UI, but hardens the API against crafted/direct calls and keeps error semantics consistent.

**Files:**
- Modify: `backend/routes/auth.js` (three action branches)
- Test: `backend/tests/integration/shift.test.js`

**Interfaces:**
- Produces: `GET /api/auth/shifts?action=check` with no `user_id` → 400; `GET ...?action=zreport` with no `shift_id` → 400; `PUT ...?action=close` with no `shift_id` → 400.

- [ ] **Step 1.1: Write the failing tests**

In `backend/tests/integration/shift.test.js`, add a new describe block immediately before the file’s final top-level `});`:

```js
    describe('auth /shifts validation guards (Task 1)', () => {
        it('GET check without user_id returns 400 (not 500)', async () => {
            const res = await request(app)
                .get('/api/auth/shifts?action=check')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('GET zreport without shift_id returns 400 (not 500)', async () => {
            const res = await request(app)
                .get('/api/auth/shifts?action=zreport')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('PUT close without shift_id returns 400 (not 500)', async () => {
            const res = await request(app)
                .put('/api/auth/shifts?action=close')
                .set('Cookie', cashierCookie)
                .send({ actual_cash: 50 });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });
```

- [ ] **Step 1.2: Run to verify they fail**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "validation guards"`
Expected: all 3 FAIL with statusCode 500 (undefined-bind).

- [ ] **Step 1.3: Guard `check`**

In `backend/routes/auth.js`, **Find this exact code**:

```js
        if (method === 'GET' && action === 'check') {
            const { user_id } = req.query;
            if (!canAccessUser(req, user_id)) return sendError(res, 403, "Forbidden: Cannot inspect another user's shift.");
```

**Replace with**:

```js
        if (method === 'GET' && action === 'check') {
            const { user_id } = req.query;
            if (!parseInt(user_id, 10)) {
                return sendError(res, 400, "A valid user id is required.");
            }
            if (!canAccessUser(req, user_id)) return sendError(res, 403, "Forbidden: Cannot inspect another user's shift.");
```

- [ ] **Step 1.4: Guard `zreport`**

**Find this exact code**:

```js
        else if (method === 'GET' && action === 'zreport') {
            const { shift_id } = req.query;
            const access = await canAccessShift(req, shift_id);
```

**Replace with**:

```js
        else if (method === 'GET' && action === 'zreport') {
            const { shift_id } = req.query;
            if (!parseInt(shift_id, 10)) {
                return sendError(res, 400, "A valid shift id is required.");
            }
            const access = await canAccessShift(req, shift_id);
```

- [ ] **Step 1.5: Guard `close`**

**Find this exact code**:

```js
        else if (method === 'PUT' && action === 'close') {
            const { actual_cash, shift_id } = req.body;
            const access = await canAccessShift(req, shift_id);
```

**Replace with**:

```js
        else if (method === 'PUT' && action === 'close') {
            const { actual_cash, shift_id } = req.body;
            if (!parseInt(shift_id, 10)) {
                return sendError(res, 400, "A valid shift id is required.");
            }
            const access = await canAccessShift(req, shift_id);
```

- [ ] **Step 1.6: Run to verify they pass**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "validation guards"`
Expected: all 3 PASS.

- [ ] **Step 1.7: Commit**

```bash
git add backend/routes/auth.js backend/tests/integration/shift.test.js
git commit -m "fix(auth): 400 (not 500) on missing id in shifts check/zreport/close"
```

---

## Task 2: Remove the orphan `cashiers` action in `auth.js`

`GET /api/auth/shifts?action=cashiers` is dead code: a grep of the whole app (`*.{vue,js}`) shows every caller uses the **admin** route `GET /api/admin/shifts?action=cashiers` (`Orders.vue`, `Shifts.vue`). No frontend and no test calls the auth-route version. Remove it; requests to it then fall through to the existing `else → 404 "Invalid shift action."`.

> If you (the executor) find ANY caller of `api/auth/shifts?action=cashiers` while working — grep again to be sure — STOP and report instead of deleting; the fallback is to instead align its WHERE clause to `WHERE u.is_active = 1 AND u.role != 'programmer'`.

**Files:**
- Modify: `backend/routes/auth.js` (delete the `cashiers` branch)
- Test: `backend/tests/integration/shift.test.js`

- [ ] **Step 2.1: Confirm it is an orphan**

Run: `git grep -n "auth/shifts?action=cashiers" -- '*.vue' '*.js'`
Expected: **no output** (zero callers). If there is output, STOP (see note above).

- [ ] **Step 2.2: Write the failing test**

In `backend/tests/integration/shift.test.js`, add a new describe block before the file’s final top-level `});`:

```js
    describe('auth /shifts cashiers action removed (Task 2)', () => {
        it('GET auth /shifts?action=cashiers is gone -> 404, not a shift list', async () => {
            const res = await request(app)
                .get('/api/auth/shifts?action=cashiers')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(404);
            expect(res.body.success).toBe(false);
        });
    });
```

- [ ] **Step 2.3: Run to verify it fails**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "cashiers action removed"`
Expected: FAIL — currently returns 200 with a cashiers array.

- [ ] **Step 2.4: Delete the orphan branch**

In `backend/routes/auth.js`, **Find this exact code**:

```js
        else if (method === 'GET' && action === 'cashiers') {
            if (!isAdminUser(req.user)) return sendError(res, 403, "Forbidden: Admin privileges required.");
            const [rows] = await pool.query(`
                SELECT u.id, u.name 
                FROM users u 
                LEFT JOIN shifts s ON u.id = s.user_id AND s.status = 'open' 
                WHERE u.is_active = 1 AND s.id IS NULL
            `);
            return sendSuccess(res, { cashiers: rows });
        }
        else if (method === 'GET' && action === 'zreport') {
```

**Replace with**:

```js
        else if (method === 'GET' && action === 'zreport') {
```

- [ ] **Step 2.5: Run to verify it passes**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "cashiers action removed"`
Expected: PASS (404).

- [ ] **Step 2.6: Commit**

```bash
git add backend/routes/auth.js backend/tests/integration/shift.test.js
git commit -m "chore(auth): remove orphan /shifts?action=cashiers (admin route is the only caller)"
```

---

## Task 3: Round backend variance + drop dead fallback key (admin/shifts.js)

Two cleanups in the shift-list aggregation loop:
- **Round variance (C1):** `shift.variance` is a raw float subtraction, so it can carry sub-cent float residue (e.g. `-0.09999999999999432`). Round to 2 decimals so the API returns a clean money value (the UI already tolerates it via `varianceIsZero`, but the raw field should be tidy).
- **Dead key:** the `aggregatesMap` fallback object declares `total_discounts: 0`, but `total_discounts` is always read from the separate `discountsMap` two lines later — the fallback key is never read. Remove it.

**Files:**
- Modify: `backend/routes/admin/shifts.js`
- Test: `backend/tests/integration/shift.test.js`

- [ ] **Step 3.1: Write the failing test**

In `backend/tests/integration/shift.test.js`, add a new describe block before the file’s final top-level `});`:

```js
    describe('admin shifts variance rounding (Task 3)', () => {
        it('returns a variance rounded to 2 decimals (no float residue)', async () => {
            // actual 52.00 vs frozen expected 52.10 -> exactly -0.10, not -0.0999999...
            const shiftId = await insertShift(pool, {
                user_id: SEED.cashierUser.id,
                starting_cash: 10.00,
                expected_cash: 52.10,
                actual_cash: 52.00,
                status: 'closed',
                opened_at: '2026-07-01 08:00:00',
                closed_at: '2026-07-01 20:00:00',
            });
            const res = await request(app)
                .get('/api/admin/shifts?limit=200')
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            const row = res.body.shifts.find(s => s.id === shiftId);
            expect(row).toBeDefined();
            expect(row.variance).toBe(-0.1);
        });
    });
```

- [ ] **Step 3.2: Run to verify it fails**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "variance rounding"`
Expected: FAIL — `variance` is `-0.09999999999999432`, not `-0.1`.

- [ ] **Step 3.3: Round the variance**

In `backend/routes/admin/shifts.js`, **Find this exact code**:

```js
                        const frozenExpected = parseFloat(shift.expected_cash || 0);
                        shift.variance = parseFloat(shift.actual_cash || 0) - frozenExpected;
```

**Replace with**:

```js
                        const frozenExpected = parseFloat(shift.expected_cash || 0);
                        shift.variance = Number(((parseFloat(shift.actual_cash || 0)) - frozenExpected).toFixed(2));
```

- [ ] **Step 3.4: Remove the dead fallback key**

**Find this exact code**:

```js
                    const agg = aggregatesMap[shift.id] || {
                        gross_sales: 0,
                        cash_sales: 0,
                        card_sales: 0,
                        total_discounts: 0
                    };
```

**Replace with**:

```js
                    const agg = aggregatesMap[shift.id] || {
                        gross_sales: 0,
                        cash_sales: 0,
                        card_sales: 0
                    };
```

- [ ] **Step 3.5: Run to verify it passes**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "variance rounding"`
Expected: PASS.

- [ ] **Step 3.6: Commit**

```bash
git add backend/routes/admin/shifts.js backend/tests/integration/shift.test.js
git commit -m "chore(shifts): round variance to 2dp + drop unused total_discounts fallback key"
```

---

## Task 4: Add the 6 missing print-message i18n keys

`printAuditReport` and `printItemsReport` in `Shifts.vue` call `t()` with 6 keys that are absent from `assets/js/admin/i18n.js`, so they render as English literals in Arabic mode. Add them with Arabic values, in the print-messages block right after the shift-report keys.

**Files:**
- Modify: `assets/js/admin/i18n.js`
- Test: `src/admin/pages/__tests__/shiftsPage.quality.spec.js` (created here)

- [ ] **Step 4.1: Write the failing test**

Create `src/admin/pages/__tests__/shiftsPage.quality.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VUE = readFileSync(resolve(__dirname, '../Shifts.vue'), 'utf8');
const I18N = readFileSync(resolve(__dirname, '../../../../assets/js/admin/i18n.js'), 'utf8');

describe('Shifts.vue future-proofing', () => {
  it('T4: all 6 print-message i18n keys exist in the dictionary', () => {
    const keys = [
      'Print queued',
      'Could not print audit report.',
      'Network error while printing audit report.',
      'Items report queued for printing.',
      'Could not print items report.',
      'Network error while printing the items report.',
    ];
    for (const k of keys) {
      expect(I18N.includes(`'${k}':`)).toBe(true);
    }
  });
});
```

- [ ] **Step 4.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T4"`
Expected: FAIL — the keys are missing.

- [ ] **Step 4.3: Add the keys**

In `assets/js/admin/i18n.js`, **Find this exact code**:

```js
    'Network error while printing the shift report.': 'خطأ في الشبكة أثناء طباعة تقرير المناوبة.',
    'Shift Reconciliation': 'تسوية المناوبة',
```

**Replace with**:

```js
    'Network error while printing the shift report.': 'خطأ في الشبكة أثناء طباعة تقرير المناوبة.',
    'Print queued': 'تم الإرسال للطباعة',
    'Could not print audit report.': 'تعذر طباعة تقرير الجرد.',
    'Network error while printing audit report.': 'خطأ في الشبكة أثناء طباعة تقرير الجرد.',
    'Items report queued for printing.': 'تم إرسال تقرير الأصناف للطباعة.',
    'Could not print items report.': 'تعذر طباعة تقرير الأصناف.',
    'Network error while printing the items report.': 'خطأ في الشبكة أثناء طباعة تقرير الأصناف.',
    'Shift Reconciliation': 'تسوية المناوبة',
```

- [ ] **Step 4.4: Run to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T4"`
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add assets/js/admin/i18n.js src/admin/pages/__tests__/shiftsPage.quality.spec.js
git commit -m "i18n(shifts): add Arabic for audit/items print-status messages"
```

---

## Task 5: Add `min="0"` to the 3 cash number inputs

The Starting-Cash-Float (open modal), Edit-Starting-Cash (inline), and Counted-Cash (force-close) number inputs have no `min`, so the browser accepts negative values. The backend `validateCashAmount` already rejects negatives, but the input should constrain them client-side.

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.quality.spec.js`

- [ ] **Step 5.1: Add the failing test**

Add inside the `describe('Shifts.vue future-proofing', ...)` in `shiftsPage.quality.spec.js`:

```js
  it('T5: all three cash number inputs constrain to min="0"', () => {
    const numberInputs = VUE.match(/<input[^>]*type="number"[^>]*>/g) || [];
    expect(numberInputs.length).toBeGreaterThanOrEqual(3);
    for (const inp of numberInputs) {
      expect(inp).toMatch(/min="0"/);
    }
  });
```

- [ ] **Step 5.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T5"`
Expected: FAIL — inputs have no `min`.

- [ ] **Step 5.3: Starting Cash Float input**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```html
                                <input v-model.number="openShiftForm.starting_cash" type="number" step="0.01" required class="w-full bg-muted border border-zinc-300 rounded-lg py-2.5 logical-ps-9 logical-pe-4 text-sm font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground tabular-nums">
```

**Replace with**:

```html
                                <input v-model.number="openShiftForm.starting_cash" type="number" step="0.01" min="0" required class="w-full bg-muted border border-zinc-300 rounded-lg py-2.5 logical-ps-9 logical-pe-4 text-sm font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground tabular-nums">
```

- [ ] **Step 5.4: Edit-Starting-Cash inline input**

**Find this exact code**:

```html
                                    <input type="number" v-model.number="newStartingCash" step="0.01" class="w-20 bg-card border border-zinc-300 rounded p-1 text-end text-foreground font-semibold focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 text-xs outline-none tabular-nums">
```

**Replace with**:

```html
                                    <input type="number" v-model.number="newStartingCash" step="0.01" min="0" class="w-20 bg-card border border-zinc-300 rounded p-1 text-end text-foreground font-semibold focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 text-xs outline-none tabular-nums">
```

- [ ] **Step 5.5: Counted-Cash (force-close) input**

**Find this exact code**:

```html
                                <input v-model.number="actualCashInput" type="number" step="0.01" class="w-full bg-card border border-zinc-300 rounded-lg py-2 px-3 text-sm font-medium text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground tabular-nums">
```

**Replace with**:

```html
                                <input v-model.number="actualCashInput" type="number" step="0.01" min="0" class="w-full bg-card border border-zinc-300 rounded-lg py-2 px-3 text-sm font-medium text-foreground focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground tabular-nums">
```

- [ ] **Step 5.6: Run to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T5"`
Expected: PASS.

- [ ] **Step 5.7: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.quality.spec.js
git commit -m "fix(shifts): constrain cash number inputs to min=0"
```

---

## Task 6: Make the Period toggle keyboard-accessible

The Period toggle hides its checkbox with `class="hidden"` (`display:none`), which removes it from tab order — keyboard/AT users can’t reach Period mode. Switch to `class="sr-only"` (visually hidden but focusable) and give the wrapping `<label>` a visible `focus-within` ring.

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.quality.spec.js`

- [ ] **Step 6.1: Add the failing test**

Add inside the describe in `shiftsPage.quality.spec.js`:

```js
  it('T6: Period toggle checkbox is focusable (sr-only, not display:none)', () => {
    const label = VUE.match(/<label[^>]*>\s*<input type="checkbox" v-model="isPeriodMode"[^>]*>/);
    expect(label).not.toBeNull();
    // the checkbox must not be display:none
    expect(VUE).not.toMatch(/<input type="checkbox" v-model="isPeriodMode" class="hidden"/);
    expect(VUE).toMatch(/<input type="checkbox" v-model="isPeriodMode" class="sr-only"/);
    // the label shows a focus ring when the control is focused
    expect(label[0]).toMatch(/focus-within:ring/);
  });
```

- [ ] **Step 6.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T6"`
Expected: FAIL — checkbox is still `class="hidden"`, label has no `focus-within`.

- [ ] **Step 6.3: Implement**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```html
                        <label class="flex items-center gap-1.5 h-9 px-3 border rounded-lg text-xs font-medium cursor-pointer transition-colors" :class="isPeriodMode ? 'border-teal-500 bg-teal-100 text-teal-700' : 'border-zinc-300 bg-muted text-foreground hover:bg-zinc-200'">
                            <input type="checkbox" v-model="isPeriodMode" class="hidden" />
```

**Replace with**:

```html
                        <label class="flex items-center gap-1.5 h-9 px-3 border rounded-lg text-xs font-medium cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-teal-500/50" :class="isPeriodMode ? 'border-teal-500 bg-teal-100 text-teal-700' : 'border-zinc-300 bg-muted text-foreground hover:bg-zinc-200'">
                            <input type="checkbox" v-model="isPeriodMode" class="sr-only" />
```

- [ ] **Step 6.4: Run to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T6"`
Expected: PASS.

- [ ] **Step 6.5: Manual check (if app is running)**

Load the Shifts page, press Tab until focus reaches the "Period" pill (it should show a teal ring), press Space → Period mode toggles and the "To" date field appears.

- [ ] **Step 6.6: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.quality.spec.js
git commit -m "a11y(shifts): make Period toggle keyboard-focusable (sr-only + focus ring)"
```

---

## Task 7: Strip AI-slop comments + the misleading `aria-haspopup`

Remove low-quality artifacts: the emoji/braggy `// 🛑 THE FIX:` comment, two chatty inline comments in the print payload, two dead “tombstone” comments, and the `aria-haspopup="menu"` on the two filter buttons (their popovers are plain `<div>`s, not ARIA menus — the attribute makes a false promise; `aria-expanded` alone is the correct disclosure semantics).

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.quality.spec.js`

- [ ] **Step 7.1: Add the failing test**

Add inside the describe in `shiftsPage.quality.spec.js`:

```js
  it('T7: AI-slop comments and misleading aria-haspopup are gone', () => {
    expect(VUE).not.toMatch(/🛑/);
    expect(VUE).not.toMatch(/THE FIX/);
    expect(VUE).not.toMatch(/Ensure starting cash is sent/);
    expect(VUE).not.toMatch(/Send the newly formatted order types/);
    expect(VUE).not.toMatch(/filteredShifts retired/);
    expect(VUE).not.toMatch(/formatMoney imported/);
    expect(VUE).not.toMatch(/aria-haspopup/);
  });
```

- [ ] **Step 7.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T7"`
Expected: FAIL.

- [ ] **Step 7.3: Replace the emoji comment**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```js
                if (data.success) {
                    // 🛑 THE FIX: Update the local state so the print function knows the shift is closed
                    // and includes the actual cash the admin just typed in!
                    selectedShift.value.is_active = 0;
```

**Replace with**:

```js
                if (data.success) {
                    // Sync local state so the auto-print below sees the shift as closed
                    // with the cash the admin just counted.
                    selectedShift.value.is_active = 0;
```

- [ ] **Step 7.4: Remove the chatty inline comments (print payload)**

**Find this exact code**:

```js
                starting_cash: shift.starting_cash, // Ensure starting cash is sent
```

**Replace with**:

```js
                starting_cash: shift.starting_cash,
```

**Find this exact code**:

```js
                order_type_breakdown: shift.order_type_breakdown, // Send the newly formatted order types!
```

**Replace with**:

```js
                order_type_breakdown: shift.order_type_breakdown,
```

- [ ] **Step 7.5: Remove the two tombstone comments**

**Find this exact code**:

```js
        // filteredShifts retired (moved to server-side search)

        const openShiftModal = (shift) => {
```

**Replace with**:

```js
        const openShiftModal = (shift) => {
```

**Find this exact code**:

```js
        // formatMoney imported from '../../utils/money.js'

        const formatDateTime = (dateVal) => {
```

**Replace with**:

```js
        const formatDateTime = (dateVal) => {
```

- [ ] **Step 7.6: Remove `aria-haspopup` from both filter buttons**

**Find this exact code**:

```html
 type="button" :aria-expanded="showCashierFilter" aria-haspopup="menu">
```

**Replace with**:

```html
 type="button" :aria-expanded="showCashierFilter">
```

**Find this exact code**:

```html
 type="button" :aria-expanded="showStatusFilter" aria-haspopup="menu">
```

**Replace with**:

```html
 type="button" :aria-expanded="showStatusFilter">
```

- [ ] **Step 7.7: Run to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T7"`
Expected: PASS.

- [ ] **Step 7.8: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.quality.spec.js
git commit -m "chore(shifts): strip slop comments + false aria-haspopup on filter buttons"
```

---

## Task 8 (lower priority — do last): De-duplicate the variance display

The closed-shift variance branch (Pending / Perfect / +over / −short) is copy-pasted in 3 places (desktop table, mobile card, modal), each re-implementing `varianceIsZero` / `> 0` / `formatMoney(Math.abs(...))`. Extract the branch logic into one in-file helper `varianceInfo(v)` returning `{ kind, text }`; each site keeps its own size classes but reads `kind`/`text`. (The animated status-pill markup is intentionally left as-is — it is pure markup repetition that can only be de-duplicated with a shared component, which the owner declined in favour of in-file helpers.)

> This task touches money-display markup in 3 spots. It has no test that proves pixel output — the source test only proves the helper is wired. **Do Step 8.6 (manual check) before committing.** If the app isn’t runnable, still complete the edits but note in the commit that manual verification is pending.

**Files:**
- Modify: `src/admin/pages/Shifts.vue`
- Test: `src/admin/pages/__tests__/shiftsPage.quality.spec.js`

**Interfaces:**
- Produces: `varianceInfo(v)` → `{ kind: 'pending'|'perfect'|'over'|'short', text: string }`, defined in `setup()` and returned from it.

- [ ] **Step 8.1: Add the failing test**

Add inside the describe in `shiftsPage.quality.spec.js`:

```js
  it('T8: variance display goes through the varianceInfo() helper', () => {
    expect(VUE).toMatch(/const varianceInfo = \(v\) =>/);
    // used at all 3 render sites (multiple calls each)
    expect((VUE.match(/varianceInfo\(/g) || []).length).toBeGreaterThanOrEqual(6);
    // old duplicated branch removed from the template
    expect(VUE).not.toMatch(/v-else-if="shift\.variance > 0"/);
    expect(VUE).not.toMatch(/v-else-if="selectedShift\?\.variance > 0"/);
    // helper is exposed to the template
    expect(VUE).toMatch(/varianceInfo,/);
  });
```

- [ ] **Step 8.2: Run to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T8"`
Expected: FAIL.

- [ ] **Step 8.3: Define the helper**

In `src/admin/pages/Shifts.vue`, **Find this exact code**:

```js
        const openShiftModal = (shift) => {
```

**Replace with**:

```js
        // Single source of truth for the closed-shift variance branch. Each render
        // site keeps its own size classes and reads .kind / .text from here.
        const varianceInfo = (v) => {
            if (v === null || v === undefined) return { kind: 'pending', text: '' };
            if (varianceIsZero(v)) return { kind: 'perfect', text: '' };
            if (v > 0) return { kind: 'over', text: '+' + formatMoney(v) + ' JD' };
            return { kind: 'short', text: '-' + formatMoney(Math.abs(v)) + ' JD' };
        };

        const openShiftModal = (shift) => {
```

(Note: Task 7 Step 7.5 removed the `// filteredShifts retired` comment that used to sit above `openShiftModal`, so this anchor is correct only after Task 7. If you are doing tasks out of order and the anchor doesn’t match, add the helper immediately before `const openShiftModal = (shift) => {` wherever it is.)

- [ ] **Step 8.4: Expose it from `setup()`**

**Find this exact code**:

```js
            isPrinting, printShiftReport, formatMoney, varianceIsZero, fetchShifts, nextPage, prevPage,
```

**Replace with**:

```js
            isPrinting, printShiftReport, formatMoney, varianceIsZero, varianceInfo, fetchShifts, nextPage, prevPage,
```

- [ ] **Step 8.5: Refactor the 3 render sites**

**Site 1 — desktop table. Find this exact code**:

```html
                                    <span v-if="shift.is_active" class="text-xs font-medium text-muted-foreground/60 italic">{{ $t('Pending...') }}</span>
                                    <span v-else-if="varianceIsZero(shift.variance)" class="inline-flex items-center gap-1 text-xs font-semibold text-teal-700"><i class="fa-solid fa-check text-[10px]"></i> {{ $t('Perfect') }}</span>
                                    <span v-else-if="shift.variance > 0" class="text-xs font-semibold text-amber-600 tabular-nums" data-no-i18n>+{{ formatMoney(shift.variance) }} JD</span>
                                    <span v-else class="text-xs font-semibold text-destructive tabular-nums" data-no-i18n>-{{ formatMoney(Math.abs(shift.variance)) }} JD</span>
```

**Replace with**:

```html
                                    <span v-if="varianceInfo(shift.variance).kind === 'pending'" class="text-xs font-medium text-muted-foreground/60 italic">{{ $t('Pending...') }}</span>
                                    <span v-else-if="varianceInfo(shift.variance).kind === 'perfect'" class="inline-flex items-center gap-1 text-xs font-semibold text-teal-700"><i class="fa-solid fa-check text-[10px]"></i> {{ $t('Perfect') }}</span>
                                    <span v-else class="text-xs font-semibold tabular-nums" :class="varianceInfo(shift.variance).kind === 'over' ? 'text-amber-600' : 'text-destructive'" data-no-i18n>{{ varianceInfo(shift.variance).text }}</span>
```

**Site 2 — mobile card. Find this exact code**:

```html
                                    <span v-if="shift.is_active" class="text-[10px] font-medium text-muted-foreground/60 italic">{{ $t('Pending...') }}</span>
                                    <span v-else-if="varianceIsZero(shift.variance)" class="inline-flex items-center gap-0.5 text-[10px] font-semibold text-teal-700">
                                        <i class="fa-solid fa-check text-[9px]"></i>
                                        <span>{{ $t('Perfect') }}</span>
                                    </span>
                                    <span v-else-if="shift.variance > 0" class="text-[11px] font-bold text-amber-600 tabular-nums" data-no-i18n>+{{ formatMoney(shift.variance) }} JD</span>
                                    <span v-else class="text-[11px] font-bold text-destructive tabular-nums" data-no-i18n>-{{ formatMoney(Math.abs(shift.variance)) }} JD</span>
```

**Replace with**:

```html
                                    <span v-if="varianceInfo(shift.variance).kind === 'pending'" class="text-[10px] font-medium text-muted-foreground/60 italic">{{ $t('Pending...') }}</span>
                                    <span v-else-if="varianceInfo(shift.variance).kind === 'perfect'" class="inline-flex items-center gap-0.5 text-[10px] font-semibold text-teal-700">
                                        <i class="fa-solid fa-check text-[9px]"></i>
                                        <span>{{ $t('Perfect') }}</span>
                                    </span>
                                    <span v-else class="text-[11px] font-bold tabular-nums" :class="varianceInfo(shift.variance).kind === 'over' ? 'text-amber-600' : 'text-destructive'" data-no-i18n>{{ varianceInfo(shift.variance).text }}</span>
```

**Site 3 — modal. Find this exact code**:

```html
                                    <span v-if="varianceIsZero(selectedShift?.variance)" class="text-teal-700 font-semibold flex items-center gap-1"><i class="fa-solid fa-check"></i> {{ $t('Perfect') }}</span>
                                    <span v-else-if="selectedShift?.variance > 0" class="text-amber-600 font-semibold tabular-nums" data-no-i18n>+{{ formatMoney(selectedShift.variance) }} JD</span>
                                    <span v-else class="text-destructive font-semibold tabular-nums" data-no-i18n>-{{ formatMoney(Math.abs(selectedShift.variance)) }} JD</span>
```

**Replace with**:

```html
                                    <span v-if="varianceInfo(selectedShift?.variance).kind === 'perfect'" class="text-teal-700 font-semibold flex items-center gap-1"><i class="fa-solid fa-check"></i> {{ $t('Perfect') }}</span>
                                    <span v-else class="font-semibold tabular-nums" :class="varianceInfo(selectedShift?.variance).kind === 'over' ? 'text-amber-600' : 'text-destructive'" data-no-i18n>{{ varianceInfo(selectedShift?.variance).text }}</span>
```

- [ ] **Step 8.6: Run test + build + manual check**

Run: `npx vitest run src/admin/pages/__tests__/shiftsPage.quality.spec.js -t "T8"` → PASS
Run: `npm run build:admin` → exits 0
Manual (if app runnable): open the Shifts list and a closed-shift modal; verify variance shows correctly for a balanced shift ("Perfect"), an over shift (`+X.XX JD`, amber), a short shift (`-X.XX JD`, red), and an active shift ("Pending...") in **all three** views (desktop table, mobile card ≤ md width, modal).

- [ ] **Step 8.7: Commit**

```bash
git add src/admin/pages/Shifts.vue src/admin/pages/__tests__/shiftsPage.quality.spec.js
git commit -m "refactor(shifts): de-duplicate variance display via varianceInfo() helper"
```

---

## Final Verification

- [ ] **V.1: Full suite green**

Run: `npx vitest run`
Expected: ALL tests pass (existing + the new Task 1–3 backend tests + the new `shiftsPage.quality.spec.js`). Zero failures. If a pre-existing test fails, STOP and report — do not edit it.

- [ ] **V.2: Build green**

Run: `npm run build:admin`
Expected: exits 0.

- [ ] **V.3: Branch state**

```bash
git log --oneline master..HEAD   # expect 8 commits (Tasks 1-8)
git status                        # clean
```

---

## Owner Notes / Explicitly Deferred (do NOT do here)

- **Status-pill de-duplication** — left as-is on purpose (Task 8 note). It’s pure animated markup; only a shared component would DRY it, and the owner chose in-file helpers.
- **Pervasive `focus:outline-none`** on action/menu buttons — a global `:focus-visible` rule would be the right fix, but it touches shared admin styling beyond this page; deferred.
- **`force=true` open-table override is unreachable from the UI** — wiring an override control is a product decision, not cleanup.
- **`cashiers` list still includes admins** (admin route `role != 'programmer'`) — this is the current, intended behavior; whether admins should be selectable cashiers is a separate policy decision.

---

## Plan Self-Review (done before handoff)

- **Assumption that could be false:** that `auth /shifts?action=cashiers` is a true orphan. Mitigated: Task 2 Step 2.1 re-greps and instructs STOP-if-caller-found, with an align-instead fallback. The grep at plan-writing time found zero callers.
- **Test that could pass for the wrong reason:** the FE source-assertion tests prove code shape, not runtime rendering — hence the Task 6 and Task 8 manual checks. Task 5’s regex requires `min="0"` on **every** `type="number"` input, so a missed input fails the test.
- **Regression risk:** Task 8 is the only markup-structural change (money display ×3). It merges the over/short branches into one conditional-class span and drops the standalone `v-else-if="… > 0"`; the source test asserts the old branch is gone and the helper is wired, and Step 8.6 requires a visual pass. Task 3’s rounding is covered by the existing `closed-shift variance uses the frozen expected_cash` test (`toBeCloseTo(…,2)`) plus the new exact-`-0.1` test.
- **Ordering dependency:** Task 8 Step 8.3 anchors on `const openShiftModal` which is where Task 7 Step 7.5 removed the `// filteredShifts retired` tombstone — do Task 7 before Task 8 (the plan order). A note in Step 8.3 covers the out-of-order case.
- **Must ship together:** none. Every task is independent and independently testable/committable.
- **No new production files** (respects the owner’s few-files rule); the only new file is one test spec, which is justified as the regression guard for Tasks 4–8.
