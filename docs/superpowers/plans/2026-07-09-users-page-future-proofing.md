# Users Page Future-Proofing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the admin Users page after the bug-fix pass: trim persisted names, validate `allowed_sections`, constrain the PIN input, add missing i18n keys, add modal accessibility, and remove dead code.

**Architecture:** Small, isolated hardening edits to `backend/routes/admin/users.js`, `src/admin/pages/Users.vue`, and `assets/js/admin/i18n.js`. No new components, no restructuring. Each change is independently testable via Vitest (backend integration + frontend source-assertion specs, matching the `shiftsPage.quality.spec.js` precedent).

**Tech Stack:** Express + mysql2, Vue 3 Composition API, Vitest.

## Global Constraints

- **Depends on** `2026-07-09-users-page-bugfix.md` being merged first. This plan edits the SAME POST/PUT branches and assumes they already use `normalizeUserNumber`, `ALLOWED_ROLES`, `userNumber` (string), and `userId` (number). Re-read the current file before editing.
- Test runner is **Vitest** (`npx vitest run <file>`). Never jest.
- `sendError` messages must not contain "table" or DB keywords (see [[senderror_db_sanitizer]]).
- Seed data: `sections` has exactly one row `(id=1, 'Test Section')`. Use id `1` as the valid section and `999` as a non-existent one in tests.
- Frontend page tests are source-text assertions (readFileSync of the `.vue`), mirroring `src/admin/pages/__tests__/shiftsPage.quality.spec.js`.
- Do NOT `git stash` or touch unrelated working-tree files. Stage only the files each task changes.

## Already resolved by the bug-fix plan (do NOT re-do)

- **#6 PIN length mismatch** and **#7 uniqueness collapse** — fixed by `normalizeUserNumber` (digit-string, 1–8, exact string uniqueness).
- **#10 toast-before-await** — fixed in bug-fix Task 5 (toast moved into the `data.success` branch).

## Explicitly deferred (need owner/product decision — no task here)

- **#14** New admin created with `admin_pin = NULL` → cannot do manager-override. Confirm whether the override PIN is meant to be set here or elsewhere.
- **#18** Pervasive `focus:outline-none` with no `focus-visible` replacement — a global CSS-rule decision, tracked project-wide.
- **#19** `sendError(500, e.message)` leaks raw error on non-production `NODE_ENV` — environment-scoped, low impact.

---

## Evidence Table

| # | Claim | Evidence | Failure scenario | Proof after fix |
|---|-------|----------|------------------|-----------------|
| 8 | `name` persisted un-trimmed | `users.js` INSERT/UPDATE bind raw `data.name`; max-len check on raw length | `"  John  "` stored with padding | Create name `"  John  "` → GET shows `"John"` |
| 9 | `allowed_sections` unvalidated CSV | `users.js` stores `String(data.allowed_sections).trim()` unchecked | `"abc,999"` persisted; waiter later sees no tables | non-numeric → 400; non-existent id dropped |
| 11 | PIN input unconstrained | `Users.vue:284` `type="text"`, no maxlength/inputmode/pattern | paste `"12ab99999"` reaches backend | input has `maxlength="8" inputmode="numeric"` |
| 13 | 3 i18n keys missing → Arabic shows English | `i18n.js` has no `Other`/`User deactivated.`/`Failed to deactivate user.` | `ar` admin sees English text | keys present in `i18n.js` |
| 15 | Dead `return` entries | `Users.vue:611,617` export `users`, `permissionCatalog` — not in template | — | removed from return |
| 16 | DELETE sends redundant `activeUserId` | `Users.vue:596` body includes it; backend ignores | — | body is `{ id: id }` |
| 12 | Modal missing dialog a11y | `Users.vue:265-266` no role/aria/Esc/backdrop-close | SR/keyboard users stranded | role="dialog" + Esc close present |

---

## Task 1: Backend — trim `name` before validating and storing (#8)

**Files:**
- Modify: `backend/routes/admin/users.js` (POST + PUT)
- Test: `backend/tests/integration/usersHardening.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/integration/usersHardening.test.js`:

```js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Admin Users API — hardening', () => {
    let adminCookie;
    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    async function listUsers() {
        const res = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
        return res.body.users;
    }

    describe('name is trimmed before storage', () => {
        it('stores a padded name without surrounding whitespace', async () => {
            const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: '  John Padded  ', user_number: '8001', role: 'cashier', allowed_sections: '' });
            expect(create.statusCode).toBe(200);
            const users = await listUsers();
            const john = users.find(u => u.user_number === '8001');
            expect(john).toBeDefined();
            expect(john.name).toBe('John Padded');
        });
    });

    // <-- append new describe blocks above this line
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/tests/integration/usersHardening.test.js`
Expected: FAIL — stored name is `"  John Padded  "` (raw), not `"John Padded"`.

- [ ] **Step 3: Trim the name in BOTH POST and PUT**

This validation block appears twice (POST and PUT), identical. Replace **both** (replace_all):

OLD:
```js
            if (!data.name || String(data.name).trim().length === 0 || String(data.name).length > 100) {
                return sendError(res, 400, "Name must be between 1 and 100 characters.");
            }
```
NEW:
```js
            const name = String(data.name ?? '').trim();
            if (name.length === 0 || name.length > 100) {
                return sendError(res, 400, "Name must be between 1 and 100 characters.");
            }
```

- [ ] **Step 4: Bind the trimmed `name` in the INSERT and UPDATE**

In the POST INSERT bind:
OLD: `                [name, userNumber, role, allowed_sections]`  *(after bug-fix this is already `name`? NO — bug-fix used `data.name`)*
Locate the POST INSERT:
OLD: `                [data.name, userNumber, role, allowed_sections]`
NEW: `                [name, userNumber, role, allowed_sections]`

In the PUT UPDATE bind:
OLD: `                [data.name, userNumber, role, allowed_sections, userId]`
NEW: `                [name, userNumber, role, allowed_sections, userId]`

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run backend/tests/integration/usersHardening.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/admin/users.js backend/tests/integration/usersHardening.test.js
git commit -m "chore(users): trim name before validation and storage"
```

---

## Task 2: Backend — validate `allowed_sections` (#9)

**Files:**
- Modify: `backend/routes/admin/users.js` (add helper; POST + PUT)
- Test: `backend/tests/integration/usersHardening.test.js` (append block)

**Interfaces:**
- Produces: `async sanitizeAllowedSections(raw) -> string | null | false` (false = invalid → 400).

- [ ] **Step 1: Write the failing test** — insert ABOVE the marker line in `usersHardening.test.js`:

```js
    describe('allowed_sections is validated', () => {
        it('rejects a non-numeric section token with 400', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'BadSec', user_number: '8101', role: 'cashier', allowed_sections: 'abc' });
            expect(res.statusCode).toBe(400);
        });
        it('drops a non-existent section id (stores null)', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'GhostSec', user_number: '8102', role: 'cashier', allowed_sections: '999' });
            expect(res.statusCode).toBe(200);
            const list = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
            const u = list.body.users.find(x => x.user_number === '8102');
            expect(u.allowed_sections == null || u.allowed_sections === '').toBe(true);
        });
        it('keeps a valid existing section id', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'GoodSec', user_number: '8103', role: 'cashier', allowed_sections: '1' });
            expect(res.statusCode).toBe(200);
            const list = await request(app).get('/api/admin/users').set('Cookie', adminCookie);
            const u = list.body.users.find(x => x.user_number === '8103');
            expect(u.allowed_sections).toBe('1');
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/tests/integration/usersHardening.test.js`
Expected: FAIL — `"abc"` is currently stored verbatim (200, not 400).

- [ ] **Step 3: Add the helper**

In `backend/routes/admin/users.js`, immediately AFTER the `ALLOWED_ROLES` const (added by the bug-fix plan), insert:
```js

// Keep only well-formed, existing section ids from a client CSV.
// Returns a CSV string, or null (nothing valid), or false (a token was non-numeric -> 400).
async function sanitizeAllowedSections(raw) {
    const tokens = String(raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) return null;
    if (tokens.some(t => !/^[0-9]+$/.test(t))) return false;
    const ids = tokens.map(Number);
    const [rows] = await pool.query("SELECT id FROM sections WHERE id IN (?)", [ids]);
    const valid = new Set(rows.map(r => r.id));
    const kept = ids.filter(n => valid.has(n));
    return kept.length ? kept.join(',') : null;
}
```

- [ ] **Step 4: Use the helper in BOTH POST and PUT**

This block appears twice (POST and PUT), identical. Replace **both** (replace_all):

OLD:
```js
            let allowed_sections = data.allowed_sections ? String(data.allowed_sections).trim() : null;
            if (role === 'admin' || role === 'programmer') {
                allowed_sections = null;
            }
```
NEW:
```js
            let allowed_sections = null;
            if (role !== 'admin') {
                allowed_sections = await sanitizeAllowedSections(data.allowed_sections);
                if (allowed_sections === false) {
                    return sendError(res, 400, "Invalid section selection.");
                }
            }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run backend/tests/integration/usersHardening.test.js`
Expected: PASS.

- [ ] **Step 6: Full backend regression**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add backend/routes/admin/users.js backend/tests/integration/usersHardening.test.js
git commit -m "chore(users): validate allowed_sections against real section ids"
```

---

## Task 3: Frontend — constrain the PIN input (#11)

**Files:**
- Modify: `src/admin/pages/Users.vue` (PIN input ~line 284)
- Test: `src/admin/pages/__tests__/usersPage.quality.spec.js` (create)

- [ ] **Step 1: Write the failing test**

Create `src/admin/pages/__tests__/usersPage.quality.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, '../Users.vue'), 'utf8');

describe('Users.vue quality/hardening', () => {
  it('PIN input is constrained (maxlength 8, numeric)', () => {
    const tag = SRC.match(/<input[^>]*form\.user_number[^>]*>/)[0];
    expect(tag).toMatch(/maxlength="8"/);
    expect(tag).toMatch(/inputmode="numeric"/);
    expect(tag).toMatch(/pattern="\[0-9\]\*"/);
  });

  // <-- append new it() blocks above this line
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: FAIL — the input has none of those attributes.

- [ ] **Step 3: Add the attributes**

In `src/admin/pages/Users.vue`, find the PIN input:
OLD:
```html
                                <input type="text" v-model="form.user_number" placeholder="1234" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
```
NEW:
```html
                                <input type="text" v-model="form.user_number" placeholder="1234" maxlength="8" inputmode="numeric" pattern="[0-9]*" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/pages/Users.vue src/admin/pages/__tests__/usersPage.quality.spec.js
git commit -m "chore(users): constrain PIN input to 8 numeric digits"
```

---

## Task 4: Add the 3 missing i18n keys (#13)

**Files:**
- Modify: `assets/js/admin/i18n.js`
- Test: `src/admin/pages/__tests__/usersPage.quality.spec.js` (append)

- [ ] **Step 1: Write the failing test** — insert ABOVE the marker line in `usersPage.quality.spec.js`:

```js
  it('i18n has Arabic for the Users-page dynamic keys', () => {
    const I18N = readFileSync(resolve(__dirname, '../../../../assets/js/admin/i18n.js'), 'utf8');
    expect(I18N).toMatch(/'Other':\s*'[^']+'/);
    expect(I18N).toMatch(/'User deactivated\.':\s*'[^']+'/);
    expect(I18N).toMatch(/'Failed to deactivate user\.':\s*'[^']+'/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: FAIL — those three keys are absent.

- [ ] **Step 3: Add the keys**

In `assets/js/admin/i18n.js`, find the line:
```js
    'User created.': 'تم إنشاء المستخدم.',
```
and insert immediately AFTER it:
```js
    'User deactivated.': 'تم إلغاء تفعيل المستخدم.',
    'Failed to deactivate user.': 'فشل إلغاء تفعيل المستخدم.',
    'Other': 'أخرى',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/js/admin/i18n.js src/admin/pages/__tests__/usersPage.quality.spec.js
git commit -m "chore(i18n): add Arabic for Other, User deactivated, Failed to deactivate user"
```

---

## Task 5: Frontend — remove dead `return` entries + redundant DELETE payload (#15, #16)

**Files:**
- Modify: `src/admin/pages/Users.vue` (setup return ~610-618; `deleteUser` body ~596)
- Test: `src/admin/pages/__tests__/usersPage.quality.spec.js` (append)

- [ ] **Step 1: Write the failing test** — insert ABOVE the marker line in `usersPage.quality.spec.js`:

```js
  it('setup() does not export dead refs (users, permissionCatalog)', () => {
    const ret = SRC.match(/return \{[\s\S]*?\};\s*\n\s*\}\s*\n\}/)[0];
    expect(ret).not.toMatch(/\busers,/);
    expect(ret).not.toMatch(/permissionCatalog/);
  });

  it('deleteUser does not send the redundant activeUserId field', () => {
    const fn = SRC.match(/const deleteUser = async \(id\) => \{[\s\S]*?\n        \};/)[0];
    expect(fn).not.toMatch(/activeUserId: activeUserId\.value/);
    expect(fn).toMatch(/JSON\.stringify\(\{ id: id \}\)/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: FAIL — `users` and `permissionCatalog` are exported; delete body includes `activeUserId`.

- [ ] **Step 3: Remove `users` and `permissionCatalog` from the return**

In `src/admin/pages/Users.vue`, in the `return { ... }` of `setup()`:

OLD:
```js
        return {
            users, sections, isLoading, searchQuery, filteredUsers, activeUserId,
```
NEW:
```js
        return {
            sections, isLoading, searchQuery, filteredUsers, activeUserId,
```

OLD:
```js
            permissionCatalog, groupedCatalog, catLabel, isArabic
```
NEW:
```js
            groupedCatalog, catLabel, isArabic
```

(`users` and `permissionCatalog` remain live refs inside `setup()` — `filteredUsers` and `groupedCatalog` close over them. Only the template-facing exports are removed.)

- [ ] **Step 4: Remove the redundant `activeUserId` from the DELETE body**

OLD:
```js
                    body: JSON.stringify({ id: id, activeUserId: activeUserId.value })
```
NEW:
```js
                    body: JSON.stringify({ id: id })
```

- [ ] **Step 5: Run test to verify it passes, then build**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: PASS.
Run: `npm run build:admin`
Expected: succeeds (confirms the template still references only exported symbols).

- [ ] **Step 6: Commit**

```bash
git add src/admin/pages/Users.vue src/admin/pages/__tests__/usersPage.quality.spec.js
git commit -m "chore(users): drop dead setup exports and redundant delete payload field"
```

---

## Task 6: Frontend — modal accessibility (#12)

**Files:**
- Modify: `src/admin/pages/Users.vue` (modal markup ~265-272; script imports + onMounted/onUnmounted)
- Test: `src/admin/pages/__tests__/usersPage.quality.spec.js` (append)

- [ ] **Step 1: Write the failing test** — insert ABOVE the marker line in `usersPage.quality.spec.js`:

```js
  it('modal has dialog semantics and can close on backdrop click', () => {
    expect(SRC).toMatch(/role="dialog"/);
    expect(SRC).toMatch(/aria-modal="true"/);
    expect(SRC).toMatch(/aria-labelledby="userModalTitle"/);
    expect(SRC).toMatch(/id="userModalTitle"/);
    expect(SRC).toMatch(/@click\.self="showModal = false"/);
  });

  it('Escape closes the modal', () => {
    expect(SRC).toMatch(/const handleModalKeydown = \(e\) => \{[\s\S]*?Escape[\s\S]*?showModal\.value = false/);
    expect(SRC).toMatch(/window\.addEventListener\('keydown', handleModalKeydown\)/);
    expect(SRC).toMatch(/window\.removeEventListener\('keydown', handleModalKeydown\)/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: FAIL — none of these exist.

- [ ] **Step 3: Add dialog semantics + backdrop close**

Find the modal backdrop + container:
OLD:
```html
            <div v-if="showModal" class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4 animate-fade-in">
                <div class="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-scale-in flex flex-col max-h-[90vh]">
```
NEW:
```html
            <div v-if="showModal" @click.self="showModal = false" class="fixed inset-0 z-[100] flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm p-4 animate-fade-in">
                <div role="dialog" aria-modal="true" aria-labelledby="userModalTitle" class="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-scale-in flex flex-col max-h-[90vh]">
```

Then give the title an id:
OLD:
```html
                        <h3 class="font-display font-semibold text-foreground text-base tracking-tight">
```
NEW:
```html
                        <h3 id="userModalTitle" class="font-display font-semibold text-foreground text-base tracking-tight">
```

- [ ] **Step 4: Add the Escape handler**

Change the vue import:
OLD: `import { ref, onMounted, computed } from 'vue';`
NEW: `import { ref, onMounted, onUnmounted, computed } from 'vue';`

Find the existing `onMounted(` block:
OLD:
```js
        onMounted(() => {
            const userStr = sessionStorage.getItem('pos_user');
            if (userStr) {
                activeUserId.value = JSON.parse(userStr).id;
            }
            fetchUsersAndSections();
        });
```
NEW:
```js
        const handleModalKeydown = (e) => {
            if (e.key === 'Escape' && showModal.value) showModal.value = false;
        };

        onMounted(() => {
            const userStr = sessionStorage.getItem('pos_user');
            if (userStr) {
                activeUserId.value = JSON.parse(userStr).id;
            }
            fetchUsersAndSections();
            window.addEventListener('keydown', handleModalKeydown);
        });

        onUnmounted(() => {
            window.removeEventListener('keydown', handleModalKeydown);
        });
```

- [ ] **Step 5: Run test to verify it passes, then build**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
Expected: PASS.
Run: `npm run build:admin`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/admin/pages/Users.vue src/admin/pages/__tests__/usersPage.quality.spec.js
git commit -m "a11y(users): dialog semantics, backdrop + Escape close on user modal"
```

---

## Self-Review

**Spec coverage:** #8 → Task 1. #9 → Task 2. #11 → Task 3. #13 → Task 4. #15/#16 → Task 5. #12 → Task 6. Deferred #14/#18/#19 documented above with rationale. #6/#7/#10 noted as already fixed.

**Assumptions that could be false / regressions to watch:**
- *`sanitizeAllowedSections` runs an extra `SELECT` per save* — negligible at users-table scale; runs only for cashier/waiter (admins short-circuit to null).
- *Task 5 return-block regex* — `\busers,` matches only the standalone `users,` export; `filteredUsers,` (capital U) and `activeUserId` are not matched. Verified against the current return text. The build in Step 5 is the real safety net: if the template referenced a removed symbol, `npm run build:admin` fails.
- *Task 6 window keydown listener* — added in `onMounted`, removed in `onUnmounted`; only closes when `showModal.value` is true, so it never interferes with the page when the modal is shut. `@click.self` on the backdrop closes only when the click lands on the backdrop itself, not on the dialog.
- *Task 1 `const name` declared in both POST and PUT branches* — separate `else if` block scopes, so no redeclaration error.

**Ordering:** This whole plan depends on the bug-fix plan being merged first (it edits the post-bug-fix POST/PUT branches). Within this plan, tasks are independent and may ship in one branch; run the full `npx vitest run` after Task 2 and `npm run build:admin` after Tasks 3/5/6.

**Type/name consistency:** `sanitizeAllowedSections` (async, returns string|null|false) is defined once and used in both branches. `handleModalKeydown` is referenced in both `onMounted` and `onUnmounted` with the same name.

## Execution Handoff

Plan complete. Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — batch execution with checkpoints.
