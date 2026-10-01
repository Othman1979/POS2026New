# Shifts Page — Audit-Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:test-driven-development for every phase (failing test first) and superpowers:subagent-driven-development (or superpowers:executing-plans) to run it task-by-task. Steps use checkbox (`- [ ]`) syntax. **Run one Phase per agent dispatch; commit before the next.**
>
> **Git hygiene:** the owner may have unrelated WIP in the tree. Do NOT `git stash`. When committing, stage ONLY the files this plan names (`git add <exact file>` per listed file) — never `git add -A`.

**Goal:** Fix the confirmed defects found in the Shifts page audit: a latent request-hang, two backend validation holes, the fake-global search (server-side fix, per owner decision), and an unguarded overlapping-fetch race. Behavior changes are intentional and each ships with a test.

**Scope target:** `src/admin/pages/Shifts.vue` (registry key `shifts`) → `backend/routes/admin/shifts.js` (mounted `backend/routes/admin.js:40`, gated `requireAuth`+`requireAdmin`). NOT `ReportsShifts.vue` (separate page).

**Tech Stack:** Vue 3 (Options-API `setup()`), Vite 6, Tailwind v4; Express 5 + `mysql2/promise`; Vitest + supertest. Test runner is **Vitest** (`npx vitest run`), never jest.

**Regression net:** `backend/tests/integration/shift.test.js` already covers `GET /api/admin/shifts` with `adminCookie` + an `insertShiftAt(...)` helper and date-range assertions. Every backend phase must keep it green and adds its own case there.

## Global Constraints

- Failing test FIRST, then the fix. Prove red → green.
- Money stays net-of-refunds — do NOT touch the existing refund/discount SQL (`getRefundsByShift`, `NET_TOTAL`, `REFUNDS_ROLLUP_JOIN`, `getShiftDiscountsByShift`). None of these phases change sales math.
- RTL/i18n untouched here (i18n cleanup lives in the future-proofing plan).
- Verify each phase: `npx vitest run backend/tests/integration/shift.test.js` and, for frontend phases, `npm run build:admin`.

---

## Phase 1 — Backend: 405 on unhandled methods (fix the hang)

**Why (evidence):** `backend/routes/admin/shifts.js:19` is `router.all('/shifts', ...)`. The body handles `GET` (`:24`), `POST` (`:205`), `PUT` (`:242`) and has **no final `else`**. A `DELETE`/`PATCH`/`OPTIONS` request enters the `try`, matches nothing, reaches the end of the function, and **returns no response → the request hangs** (Express never sends anything). Latent today (the UI sends only GET/POST/PUT) but a real no-response bug.

**Files:** Modify `backend/routes/admin/shifts.js`; add a test to `backend/tests/integration/shift.test.js`.

- [ ] **Step 1 (red):** In `shift.test.js`, inside the existing `describe('Shift Integration Tests', ...)`, add:
```javascript
describe('Method guard', () => {
    it('returns 405 for unsupported methods instead of hanging', async () => {
        const res = await request(app)
            .delete('/api/admin/shifts')
            .set('Cookie', adminCookie);
        expect(res.statusCode).toBe(405);
        expect(res.body.success).toBe(false);
    });
});
```
Run `npx vitest run backend/tests/integration/shift.test.js` — it must FAIL by timing out / not returning 405.

- [ ] **Step 2 (green):** In `shifts.js`, the `if (method === 'GET') { ... } else if (method === 'POST') { ... } else if (method === 'PUT') { ... }` chain ends around `:327`. Add a final `else` immediately after the `PUT` block closes and before the outer `} catch (e) {`:
```javascript
        else {
            return sendError(res, 405, 'Method not allowed.');
        }
```
Re-run the test → green. Confirm the whole file still green.

**Risk:** none — pure addition of an unreachable-until-now branch.
**Commit:** `fix(shifts): return 405 on unsupported methods (was hanging)`

---

## Phase 2 — Backend: validate `user_id` (POST) and `id` (PUT)

**Why (evidence):** POST open-shift (`shifts.js:205`) reads `data.user_id` and runs `SELECT id FROM shifts WHERE user_id = ? FOR UPDATE` (`:219`) with no presence check — a missing `user_id` makes `mysql2` throw *"Bind parameters must not contain undefined"* → **500 instead of 400**. Same for PUT force-close `data.id` (`:244`) used at `:257`.

**Files:** Modify `backend/routes/admin/shifts.js`; add tests to `shift.test.js`.

- [ ] **Step 1 (red):** Add to `shift.test.js`:
```javascript
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
```
Run → both FAIL (currently 500).

- [ ] **Step 2 (green — POST):** In the `POST` branch, immediately after `const data = req.body;` (`:206`) and BEFORE the `validateCashAmount` call, add:
```javascript
            const userId = parseInt(data.user_id, 10);
            if (!userId || Number.isNaN(userId)) {
                return sendError(res, 400, 'A valid cashier must be selected.');
            }
```
Then replace the two later uses of `data.user_id` in this branch (`:221` FOR-UPDATE query bind, and `:229` INSERT bind, and `:233` the emit payload) with `userId`.

- [ ] **Step 3 (green — PUT):** In the `PUT` branch, right after `const shift_id = data.id;` (`:244`), add:
```javascript
            if (!parseInt(shift_id, 10)) {
                return sendError(res, 400, 'A valid shift id is required.');
            }
```
Re-run → green. Full-file green.

**Note (report, do not fix here):** the eligible-cashiers query (`:31`) excludes only `programmer`, so `admin` users appear as assignable cashiers. If that is unintended, raise it with the owner — it is a policy decision, out of scope for this bug-fix plan.

**Risk:** low; the new 400s are unreachable from the current UI (frontend already guards) so no UX regression.
**Commit:** `fix(shifts): 400 on missing user_id/id instead of 500`

---

## Phase 3 — Server-side search (retire fake-global client filter)

**Why (evidence):** `Shifts.vue:662` `filteredShifts` filters only the **loaded page** of `shifts.value`; `fetchShifts` (`:513`) sends no `search` param; the backend GET has **zero** search support (grep: 0 `LIKE`). Footer (`:307`) shows `filteredShifts.length` (client-filtered) `of` `totalRecords` (server total). Failure: a cashier whose shifts are on page 2 yields "No shifts found" while a match exists; footer reads "3 of 128". Owner decision: fix server-side.

> **SHIP-TOGETHER:** the backend param and the frontend rewrite are two halves of one fix. Do not merge one without the other.

**Files:** Modify `backend/routes/admin/shifts.js`, `src/admin/pages/Shifts.vue`; test in `shift.test.js`.

- [ ] **Step 1 (red — backend):** Add to `shift.test.js` (uses the existing `insertShiftAt` / seeded cashier `SEED.cashierUser`):
```javascript
it('GET ?search filters by cashier name across pages', async () => {
    await insertShiftAt('2026-07-01 08:00:00'); // seeded cashier
    const res = await request(app)
        .get(`/api/admin/shifts?search=${encodeURIComponent(SEED.cashierUser.name)}`)
        .set('Cookie', adminCookie);
    expect(res.statusCode).toBe(200);
    expect(res.body.shifts.length).toBeGreaterThan(0);
    expect(res.body.shifts.every(s => s.cashier_name === SEED.cashierUser.name)).toBe(true);
});
```
Run → FAILS if the seed has >1 cashier with shifts (search is ignored today). If the seed only has one cashier, temporarily also assert an id-search returns a subset; either way confirm the param is currently a no-op before implementing.

- [ ] **Step 2 (green — backend):** In `shifts.js`, the GET `where`/`params` builder: the `status` block closes at `:59`. Immediately after it (before `const startDateStr` at `:61`) insert:
```javascript
            const searchStr = String(req.query.search || '').trim();
            if (searchStr) {
                where.push('(CAST(s.id AS CHAR) LIKE ? OR u.name LIKE ?)');
                const like = `%${searchStr}%`;
                params.push(like, like);
            }
```
`where`/`params` are built and consumed positionally by BOTH the COUNT query (`:99`) and the main query (`:104`), and each `where.push` is paired with its `params.push` in sequence — inserting here keeps them aligned. Re-run → green.

- [ ] **Step 3 (frontend — send the param):** In `Shifts.vue` `fetchShifts` (`:513`), after the `status` param block (`:522-524`), add:
```javascript
                if (searchQuery.value.trim()) {
                    params.set('search', searchQuery.value.trim());
                }
```

- [ ] **Step 4 (frontend — debounce + refetch):** At the top of `setup()` add a module-safe timer alongside the other refs:
```javascript
        let searchTimer = null;
```
Add a watcher (place it next to the other `watch(...)` calls, ~`:614`):
```javascript
        watch(searchQuery, () => {
            currentPage.value = 1;
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(fetchShifts, 300);
        });
```
(300 ms mirrors the Inventory page's `productSearchTimer` pattern.)

- [ ] **Step 5 (frontend — delete the client filter):** Remove the `filteredShifts` computed (`:662-669`). Replace every template reference to `filteredShifts` with `shifts`:
  - `:184` `v-if="filteredShifts.length === 0"` → `shifts.length === 0`
  - `:192` `v-for="shift in filteredShifts"` → `v-for="shift in shifts"`
  - `:235` mobile empty `v-if` → `shifts.length === 0`
  - `:242` mobile `v-for` → `v-for="shift in shifts"`
  - `:307` footer `{{ filteredShifts.length }}` → `{{ shifts.length }}`
  Remove `filteredShifts` from the `return {}` object (`:856`). The active-filter **search chip** (`:143-146`) stays and still works.

- [ ] **Step 6 (verify):** `npx vitest run backend/tests/integration/shift.test.js` green; `npm run build:admin` green. Manual: search a cashier name whose shifts are NOT on page 1 → results appear; footer reads "N of <server-total>".

**Risk:** `CAST(s.id AS CHAR) LIKE` is index-unfriendly but the shifts table is small and already fully scanned for aggregates; acceptable. Debounce means the watcher fires once settled — do not also leave a duplicate immediate fetch.
**Commit:** `feat(shifts): server-side search by id/cashier (retire page-scoped filter)`

---

## Phase 4 — Guard overlapping fetches (stale-response race)

**Why (evidence):** `fetchShifts` (`:513`) has no request sequencing. Two watchers (`:614` cashier/status, `:636` date/period) plus the new search watcher can fire overlapping requests; `clearAllFilters` (`:651`) mutates keys watched by both → 2 concurrent fetches. Whichever resolves last wins → a stale page can render over a newer one.

**Files:** Modify `src/admin/pages/Shifts.vue`; test optional (documented manual check).

- [ ] **Step 1:** In `setup()`, near the other module-locals, add:
```javascript
        let fetchSeq = 0;
```
- [ ] **Step 2 (surgical — do NOT rewrite the whole function; make exactly these 4 edits inside the existing `fetchShifts` at `:513`, leaving all param-building and the `fetch(...)` call byte-for-byte unchanged):**
  1. Immediately after `const fetchShifts = async () => {` insert as the first line: `const seq = ++fetchSeq;`
  2. Leave `isLoading.value = true;` where it is.
  3. Directly after `const data = await res.json();` insert a new line: `if (seq !== fetchSeq) return;  // a newer fetch superseded this one`
  4. In the `finally {` block, change `isLoading.value = false;` to `if (seq === fetchSeq) isLoading.value = false;`

  Resulting shape (for reference only — verify the params block between is your existing code, not retyped):
```javascript
        const fetchShifts = async () => {
            const seq = ++fetchSeq;
            isLoading.value = true;
            try {
                /* existing URLSearchParams building + fetch stays EXACTLY as-is */
                const res = await fetch(`api/admin/shifts?${params.toString()}`);
                const data = await res.json();
                if (seq !== fetchSeq) return;  // a newer fetch superseded this one
                if (data.success) { /* existing assignment block unchanged */ }
            } catch (error) {
                console.error("Failed to load shifts");
            } finally {
                if (seq === fetchSeq) isLoading.value = false;
            }
        };
```
- [ ] **Step 3 (verify):** `npm run build:admin` green. Manual: rapidly toggle Period / flip cashier filter — the final rendered list always matches the last selection (no flicker to a stale set).

**Risk:** minimal; token pattern is the same one used by the table-session hardening work.
**Commit:** `fix(shifts): sequence fetchShifts to drop stale overlapping responses`

---

## Post-plan verification (run before declaring done)
- `npx vitest run backend/tests/integration/shift.test.js` — all green.
- `npx vitest run backend/tests/` — no regressions.
- `npm run build:admin` — green.
- Manual smoke: open shift, force-close (with & without open tables → 409 path), edit starting cash, print X/Z, search across pages, rapid filter toggles.

## Explicitly deferred (not in this plan)
- Admin-listed-as-cashier policy (Phase 2 note) — owner decision.
- No admin UI "force override open tables" button (backend supports `?force=true` at `shifts.js:270` but the frontend never sends it) — UX decision, not a bug.
