# Users Page Bug-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five confirmed REAL bugs on the admin Users page: leading-zero/non-digit PIN corruption, failed-create silent data-loss, role privilege-escalation backdoor, method-fallthrough hang, and DELETE silent no-op.

**Architecture:** `user_number` becomes a validated digit-string end-to-end (matches the string-based login), never `parseInt`. `role` gains a server-side allowlist. `router.all` gets a 405 fallthrough. PUT/DELETE validate `id` and stop reporting success on non-writes. The frontend stops flipping a failed CREATE into EDIT mode and only toasts on real success.

**Tech Stack:** Express + mysql2 (backend), Vue 3 Composition API (frontend), Vitest (both test layers — NEVER jest).

## Global Constraints

- Test runner is **Vitest**. Run backend integration tests with `npx vitest run <file>`. `npx jest` gives false failures — do not use it.
- `user_number` DB column is `varchar(50) NOT NULL UNIQUE`. Login (`backend/routes/auth.js:152,168`) matches it as `String(...).trim()`. Never `parseInt` a `user_number`.
- PIN policy (owner-approved): digit-string, regex `^[0-9]{1,8}$` (1–8 digits, leading zeros preserved — matches the login pad cap in `src/components/Login.vue:88`).
- Allowed create/edit roles (owner-approved): `['cashier', 'waiter', 'admin']`. `programmer` and `table_manager` must be rejected by this route.
- `sendError` messages must NOT contain the word "table" or DB keywords (helper rewrites them — see [[senderror_db_sanitizer]]). Use plain phrasing.
- Copy the test-file require block verbatim from `backend/tests/integration/adminRouting.test.js:1-6` — those relative paths are proven correct.
- Do NOT `git stash` or touch unrelated working-tree files. Stage only the files each task changes.

---

## Evidence Table

| # | Claim | Evidence (current code) | Failure scenario | Proof after fix |
|---|-------|-------------------------|------------------|-----------------|
| 1 | Leading-zero PIN corruption → lockout | `backend/routes/admin/users.js:49,75` `parseInt(data.user_number,10)`; login string-matches `auth.js:152,168`; col varchar | Admin sets PIN `002026` → stored `2026` → cashier typing `002026` gets 401 | Create `0042` → login `0042` 200, login `42` 401 |
| 2 | Failed CREATE → EDIT `id:null` → silent data-loss | `Users.vue:571,576` `openModal(payload)` sets `isEditing=true`, `form.id=null`; PUT `users.js:93` `WHERE id=NULL` → 0 rows + `sendSuccess` `:98` | Dup-PIN create → fix PIN → Save → 2 success toasts, nothing saved | FE: failure re-opens same modal, no `openModal`; BE: PUT `id:null` → 400 |
| 3 | `role` no allowlist → hidden programmer backdoor | `users.js:59,85` trim only; enum allows `programmer` (`seed.js:76`); list filters `role!='programmer'` `:28,31`; `requireAdmin` treats programmer as admin (`middleware/auth.js:173`) | `POST {role:"programmer"}` → invisible god-mode account | `POST/PUT {role:"programmer"}` → 400 |
| 4 | `router.all` no `else` → hang | `users.js:24` branches GET/POST/PUT/DELETE only | `PATCH /api/admin/users` never responds | `PATCH` → 405 |
| 5 | DELETE unvalidated id → silent success | `users.js:100-107` no id check, always `sendSuccess` | `DELETE {id:99999}` → 200 "User deactivated." (0 rows) | `DELETE {id:99999}` → 404; `{id:"abc"}` → 400 |

---

## Task 1: Backend — `user_number` is a validated digit-string (leading zeros preserved)

**Files:**
- Modify: `backend/routes/admin/users.js` (POST branch ~47-71, PUT branch ~73-98, add helper near top)
- Test: `backend/tests/integration/users.test.js` (create)

**Interfaces:**
- Produces: `normalizeUserNumber(raw) -> string|null` (module-scope helper in `users.js`).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/integration/users.test.js`:

```js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Admin Users API', () => {
    let adminCookie;
    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    describe('PIN (user_number) is a digit-string, leading zeros preserved', () => {
        it('creates a leading-zero PIN and that exact PIN logs in; stripped form does not', async () => {
            const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Zero Lead', user_number: '0042', role: 'cashier', permissions: [], allowed_sections: '' });
            expect(create.statusCode).toBe(200);
            expect(create.body.success).toBe(true);

            const good = await request(app).post('/api/auth/login').send({ user_number: '0042' });
            expect(good.statusCode).toBe(200);
            expect(good.body.success).toBe(true);

            const stripped = await request(app).post('/api/auth/login').send({ user_number: '42' });
            expect(stripped.statusCode).toBe(401);
        });
        it('rejects a non-digit PIN', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Bad', user_number: '12ab', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('rejects an empty PIN', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Empty', user_number: '', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('rejects a PIN longer than 8 digits', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Long', user_number: '123456789', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('accepts an 8-digit PIN and it logs in', async () => {
            const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Eight', user_number: '10000042', role: 'cashier', allowed_sections: '' });
            expect(create.statusCode).toBe(200);
            const login = await request(app).post('/api/auth/login').send({ user_number: '10000042' });
            expect(login.statusCode).toBe(200);
        });
    });

    // <-- append new describe blocks above this line
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: FAIL — the leading-zero test fails because `parseInt('0042')` stores `42`, so login `0042` returns 401 while `42` returns 200 (inverted).

- [ ] **Step 3: Add the helper**

In `backend/routes/admin/users.js`, immediately AFTER the line:
```js
const { getCatalog } = require('../../services/PermissionService');
```
insert:
```js

// user_number is a login PIN stored as a string (varchar) so leading zeros
// survive; login (auth.js) matches it as a string. Reject non-digits and cap at
// 8 to match the login pad. NEVER parseInt a user_number — it strips leading zeros.
function normalizeUserNumber(raw) {
    const s = String(raw ?? '').trim();
    return /^[0-9]{1,8}$/.test(s) ? s : null;
}
```

- [ ] **Step 4: Replace the parseInt validation in BOTH POST and PUT**

The following 4-line block appears twice (POST and PUT), identical. Replace **both** occurrences (use replace_all):

OLD:
```js
            const userNum = parseInt(data.user_number, 10);
            if (isNaN(userNum) || userNum < 1 || userNum > 99999) {
                return sendError(res, 400, "User number must be a positive integer up to 99999.");
            }
```
NEW:
```js
            const userNumber = normalizeUserNumber(data.user_number);
            if (!userNumber) {
                return sendError(res, 400, "User number must be 1-8 digits (leading zeros allowed).");
            }
```

- [ ] **Step 5: Repoint the binds from `userNum` to `userNumber`**

In the POST branch, change the uniqueness check:
OLD: `const [check] = await pool.query("SELECT id FROM users WHERE user_number = ?", [userNum]);`
NEW: `const [check] = await pool.query("SELECT id FROM users WHERE user_number = ?", [userNumber]);`

and the INSERT bind:
OLD: `                [data.name, userNum, role, allowed_sections]`
NEW: `                [data.name, userNumber, role, allowed_sections]`

In the PUT branch, change the uniqueness check:
OLD: `const [check] = await pool.query("SELECT id FROM users WHERE user_number = ? AND id != ?", [userNum, data.id]);`
NEW: `const [check] = await pool.query("SELECT id FROM users WHERE user_number = ? AND id != ?", [userNumber, data.id]);`

and the UPDATE bind:
OLD: `                [data.name, userNum, role, allowed_sections, data.id]`
NEW: `                [data.name, userNumber, role, allowed_sections, data.id]`

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: PASS (all 5 PIN tests).

- [ ] **Step 7: Commit**

```bash
git add backend/routes/admin/users.js backend/tests/integration/users.test.js
git commit -m "fix(users): store user_number as digit-string, preserve leading zeros"
```

---

## Task 2: Backend — allowlist `role` (block hidden programmer/table_manager)

**Files:**
- Modify: `backend/routes/admin/users.js` (add `ALLOWED_ROLES` const; guard in POST + PUT)
- Test: `backend/tests/integration/users.test.js` (append block)

**Interfaces:**
- Consumes: `normalizeUserNumber` (Task 1).
- Produces: `ALLOWED_ROLES` (module-scope array).

- [ ] **Step 1: Write the failing test** — insert this describe block immediately ABOVE the `// <-- append new describe blocks above this line` marker in `users.test.js`:

```js
    describe('role is allowlisted (no hidden programmer/table_manager)', () => {
        it('rejects role=programmer on create', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'Sneaky', user_number: '7001', role: 'programmer' });
            expect(res.statusCode).toBe(400);
        });
        it('rejects role=table_manager on create', async () => {
            const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                .send({ name: 'TM', user_number: '7002', role: 'table_manager' });
            expect(res.statusCode).toBe(400);
        });
        it('accepts cashier, waiter and admin', async () => {
            const roles = ['cashier', 'waiter', 'admin'];
            for (let i = 0; i < roles.length; i++) {
                const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
                    .send({ name: 'Ok' + roles[i], user_number: '720' + i, role: roles[i], allowed_sections: '' });
                expect(res.statusCode).toBe(200);
            }
        });
        it('rejects PUT escalation to programmer', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send({ id: SEED.cashierUser.id, name: 'Test Cashier', user_number: SEED.cashierUser.user_number, role: 'programmer' });
            expect(res.statusCode).toBe(400);
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: FAIL — programmer/table_manager creates currently return 200.

- [ ] **Step 3: Add the allowlist const**

In `backend/routes/admin/users.js`, immediately AFTER the `normalizeUserNumber` helper added in Task 1, insert:
```js

// Roles this admin route may assign. `programmer` and `table_manager` are
// intentionally excluded — they are only mintable via seed/migration, and a
// `programmer` created here would be god-mode AND hidden from the list queries.
const ALLOWED_ROLES = ['cashier', 'waiter', 'admin'];
```

- [ ] **Step 4: Guard the role in BOTH POST and PUT**

The following line appears twice (POST and PUT), identical. Replace **both** (use replace_all):

OLD:
```js
            let role = data.role ? String(data.role).trim() : 'cashier';
```
NEW:
```js
            let role = data.role ? String(data.role).trim() : 'cashier';
            if (!ALLOWED_ROLES.includes(role)) {
                return sendError(res, 400, "Invalid role.");
            }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/admin/users.js backend/tests/integration/users.test.js
git commit -m "fix(users): allowlist assignable roles, block programmer/table_manager backdoor"
```

---

## Task 3: Backend — PUT requires a valid id (kills failed-create silent data-loss)

**Files:**
- Modify: `backend/routes/admin/users.js` (PUT branch)
- Test: `backend/tests/integration/users.test.js` (append block)

**Interfaces:**
- Consumes: `normalizeUserNumber`, `ALLOWED_ROLES` (Tasks 1–2).

- [ ] **Step 1: Write the failing test** — insert ABOVE the marker line in `users.test.js`:

```js
    describe('PUT requires a valid id (fixes failed-create mode-flip data loss)', () => {
        it('rejects PUT with a null id', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send({ id: null, name: 'Ghost', user_number: '7301', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('rejects PUT with a non-numeric id', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send({ id: 'abc', name: 'Ghost', user_number: '7302', role: 'cashier' });
            expect(res.statusCode).toBe(400);
        });
        it('updates a real user', async () => {
            const res = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
                .send({ id: SEED.cashierUser.id, name: 'Renamed', user_number: SEED.cashierUser.user_number, role: 'cashier', permissions: [], allowed_sections: '' });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: FAIL — `PUT {id:null}` currently returns 200 (`WHERE id=NULL` matches 0 rows but still sends success).

- [ ] **Step 3: Add id validation at the top of the PUT branch**

In the PUT branch, find:
```js
        else if (req.method === 'PUT') {
            const data = req.body;
            const userNumber = normalizeUserNumber(data.user_number);
```
and insert the id guard so it reads:
```js
        else if (req.method === 'PUT') {
            const data = req.body;
            const userId = parseInt(data.id, 10);
            if (isNaN(userId) || userId < 1) {
                return sendError(res, 400, "Valid user id is required.");
            }
            const userNumber = normalizeUserNumber(data.user_number);
```

- [ ] **Step 4: Use `userId` instead of `data.id` in the rest of the PUT branch**

Change the uniqueness check bind:
OLD: `const [check] = await pool.query("SELECT id FROM users WHERE user_number = ? AND id != ?", [userNumber, data.id]);`
NEW: `const [check] = await pool.query("SELECT id FROM users WHERE user_number = ? AND id != ?", [userNumber, userId]);`

Change the UPDATE bind:
OLD: `                [data.name, userNumber, role, allowed_sections, data.id]`
NEW: `                [data.name, userNumber, role, allowed_sections, userId]`

Change the two trailing calls:
OLD:
```js
            await replaceUserGrants(data.id, data.permissions, role);
            invalidateUserSessions(data.id);
```
NEW:
```js
            await replaceUserGrants(userId, data.permissions, role);
            invalidateUserSessions(userId);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/admin/users.js backend/tests/integration/users.test.js
git commit -m "fix(users): PUT rejects missing/invalid id instead of silent no-op success"
```

---

## Task 4: Backend — DELETE validates id + 405 for unsupported methods

**Files:**
- Modify: `backend/routes/admin/users.js` (DELETE branch + method fallthrough)
- Test: `backend/tests/integration/users.test.js` (append block)

- [ ] **Step 1: Write the failing test** — insert ABOVE the marker line in `users.test.js`:

```js
    describe('DELETE validates id; unsupported methods return 405', () => {
        it('rejects DELETE with a non-numeric id', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: 'abc' });
            expect(res.statusCode).toBe(400);
        });
        it('returns 404 when deactivating a non-existent user', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: 99999 });
            expect(res.statusCode).toBe(404);
        });
        it('deactivates a real user', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: SEED.cashierUser.id });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });
        it('still blocks deleting the primary admin (403)', async () => {
            const res = await request(app).delete('/api/admin/users').set('Cookie', adminCookie).send({ id: 1 });
            expect(res.statusCode).toBe(403);
        });
        it('returns 405 for an unsupported method (PATCH)', async () => {
            const res = await request(app).patch('/api/admin/users').set('Cookie', adminCookie).send({});
            expect(res.statusCode).toBe(405);
        });
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: FAIL — non-existent DELETE returns 200 (not 404), non-numeric id returns 200/500 (not 400), PATCH hangs (test times out or errors).

- [ ] **Step 3: Rewrite the DELETE branch and add the 405 fallthrough**

Replace the entire DELETE branch:
OLD:
```js
        else if (req.method === 'DELETE') {
            const { id } = req.body;
            if (id == 1 || id == req.user.id) {
                return sendError(res, 403, "Cannot delete primary admin or your own account.");
            }
            await pool.query("UPDATE users SET is_active = 0, session_token = NULL WHERE id = ?", [id]);
            invalidateUserSessions(id);
            return sendSuccess(res, { message: "User deactivated." });
        }
    } catch (e) {
```
NEW:
```js
        else if (req.method === 'DELETE') {
            const userId = parseInt(req.body?.id, 10);
            if (isNaN(userId) || userId < 1) {
                return sendError(res, 400, "Valid user id is required.");
            }
            if (userId === 1 || userId === req.user.id) {
                return sendError(res, 403, "Cannot delete primary admin or your own account.");
            }
            const [result] = await pool.query("UPDATE users SET is_active = 0, session_token = NULL WHERE id = ?", [userId]);
            if (result.affectedRows === 0) {
                return sendError(res, 404, "User not found.");
            }
            invalidateUserSessions(userId);
            return sendSuccess(res, { message: "User deactivated." });
        }
        else {
            return sendError(res, 405, "Method not allowed.");
        }
    } catch (e) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run backend/tests/integration/users.test.js`
Expected: PASS.

- [ ] **Step 5: Full backend regression + build**

Run: `npx vitest run` (whole backend suite — confirm no other test relied on the old permissive behavior).
Run: `npm run build:admin`
Expected: all green; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add backend/routes/admin/users.js backend/tests/integration/users.test.js
git commit -m "fix(users): DELETE validates id (400/404), add 405 for unsupported methods"
```

---

## Task 5: Frontend — no mode-flip on failed create; toast only on real success

**Files:**
- Modify: `src/admin/pages/Users.vue` (the `saveUser` function ~518-579)
- Test: `src/admin/pages/__tests__/usersPage.bugfix.spec.js` (create)

- [ ] **Step 1: Write the failing test**

Create `src/admin/pages/__tests__/usersPage.bugfix.spec.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, '../Users.vue'), 'utf8');

describe('Users.vue bug-fixes', () => {
  const saveUser = SRC.match(/const saveUser = async \(\) => \{[\s\S]*?\n        \};/)[0];

  it('does not fire the success toast optimistically (only inside the data.success branch)', () => {
    const beforeFetch = saveUser.split('await fetch')[0];
    expect(beforeFetch).not.toMatch(/showAdminToast/);
    expect(saveUser).toMatch(/data\.success[\s\S]*showAdminToast/);
  });

  it('re-opens the same modal on failure instead of openModal(payload) — no CREATE->EDIT mode flip', () => {
    expect(saveUser).not.toMatch(/openModal\(/);
    expect(saveUser).toMatch(/showModal\.value = true/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.bugfix.spec.js`
Expected: FAIL — current `saveUser` calls `showAdminToast` before `await fetch` and calls `openModal(payload)` in both failure branches.

- [ ] **Step 3: Replace the `saveUser` function**

In `src/admin/pages/Users.vue`, replace the entire `saveUser` function:

OLD (starts `const saveUser = async () => {` ends at its closing `};`):
```js
        const saveUser = async () => {
            if (!form.value.name || !form.value.user_number) {
                window.showAdminAlert(t("Name and PIN are required."));
                return;
            }

            const payload = {
                ...form.value,
                allowed_sections: form.value.allowed_sections.join(',')
            };

            const isEdit = isEditing.value;
            const backupUsers = [...users.value];
            const tempId = isEdit ? form.value.id : 'temp-user-' + Date.now();

            // Optimistic update
            if (isEdit) {
                const index = users.value.findIndex(u => u.id === form.value.id);
                if (index !== -1) {
                    users.value[index] = {
                        ...users.value[index],
                        ...payload
                    };
                }
            } else {
                users.value.push({
                    id: tempId,
                    ...payload,
                    is_active: 1
                });
            }

            showModal.value = false;
            window.showAdminToast(isEdit ? t("User updated.") : t("User created."), "success");

            const method = isEdit ? 'PUT' : 'POST';
            try {
                const res = await fetch('api/admin/users', {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                
                if (data.success) {
                    if (!isEdit) {
                        const index = users.value.findIndex(u => u.id === tempId);
                        if (index !== -1) {
                            users.value[index].id = data.id;
                        }
                    }
                } else {
                    users.value = backupUsers;
                    openModal(payload);
                    window.showAdminAlert(data.message || t("Action failed."));
                }
            } catch (e) {
                users.value = backupUsers;
                openModal(payload);
                window.showAdminAlert(t("Network error."));
            }
        };
```
NEW:
```js
        const saveUser = async () => {
            if (!form.value.name || !form.value.user_number) {
                window.showAdminAlert(t("Name and PIN are required."));
                return;
            }

            const payload = {
                ...form.value,
                allowed_sections: form.value.allowed_sections.join(',')
            };

            const isEdit = isEditing.value;
            const backupUsers = [...users.value];
            const tempId = isEdit ? form.value.id : 'temp-user-' + Date.now();

            // Optimistic update
            if (isEdit) {
                const index = users.value.findIndex(u => u.id === form.value.id);
                if (index !== -1) {
                    users.value[index] = {
                        ...users.value[index],
                        ...payload
                    };
                }
            } else {
                users.value.push({
                    id: tempId,
                    ...payload,
                    is_active: 1
                });
            }

            showModal.value = false;

            const method = isEdit ? 'PUT' : 'POST';
            try {
                const res = await fetch('api/admin/users', {
                    method: method,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();

                if (data.success) {
                    if (!isEdit) {
                        const index = users.value.findIndex(u => u.id === tempId);
                        if (index !== -1) {
                            users.value[index].id = data.id;
                        }
                    }
                    window.showAdminToast(isEdit ? t("User updated.") : t("User created."), "success");
                } else {
                    // Roll back and re-open the SAME modal with the form intact and its
                    // original mode preserved. Do NOT call openModal(payload) here: it
                    // flips a failed CREATE into EDIT mode with id:null, whose next Save
                    // fires PUT id:null -> 0 rows but a success message (silent data loss).
                    users.value = backupUsers;
                    showModal.value = true;
                    window.showAdminAlert(data.message || t("Action failed."));
                }
            } catch (e) {
                users.value = backupUsers;
                showModal.value = true;
                window.showAdminAlert(t("Network error."));
            }
        };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/admin/pages/__tests__/usersPage.bugfix.spec.js`
Expected: PASS.

- [ ] **Step 5: Build**

Run: `npm run build:admin`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/admin/pages/Users.vue src/admin/pages/__tests__/usersPage.bugfix.spec.js
git commit -m "fix(users): keep modal mode on failed save, toast only on real success"
```

---

## Self-Review

**Spec coverage:** #1 → Task 1. #2 → Task 3 (backend PUT guard) + Task 5 (frontend mode preservation) — both halves shipped. #3 → Task 2. #4 → Task 4 (405). #5 → Task 4 (DELETE 400/404). All five REAL bugs covered.

**Assumptions that could be false / regressions to watch:**
- *`normalizeUserNumber` trims before validating* — matches login's `.trim()`, so `" 0042 "` normalizes to `"0042"` on both sides. Consistent.
- *`role` allowlist could break an existing test that creates programmer/table_manager via this route* — verified: `permissions.test.js` and others insert those roles via raw SQL, not via `POST/PUT /api/admin/users`. Task 4 Step 5 runs the full suite to confirm.
- *DELETE `affectedRows===0 → 404` could false-404 an already-inactive user* — acceptable: the Users list is active-only, so an inactive user is never delete-target from the UI; a 404 there is honest ("nothing active to deactivate").
- *PUT deliberately does NOT use `affectedRows===0 → 404`* — mysql2 default (no `CLIENT_FOUND_ROWS`) reports `affectedRows:0` when a PUT submits unchanged values, which would false-404 a no-op edit. The `isNaN(userId)` 400 guard is what actually fixes the #2 data-loss (rejects `id:null`); a valid-but-nonexistent id staying 200 is a pre-existing minor and out of scope.
- *Frontend fix relies on `form.value` being intact on failure* — verified: `saveUser` never mutates `form.value`; it only reads it into `payload`. Re-opening via `showModal.value = true` shows the user's entered values, mode unchanged.

**Phases that must ship together:** Tasks 1–5 are one branch, one merge. Task 3 (backend) and Task 5 (frontend) are the two halves of bug #2 — do not ship one without the other.

**Type/name consistency:** `normalizeUserNumber` and `ALLOWED_ROLES` are defined once (Tasks 1–2) and consumed in both POST/PUT. `userNumber` (string) and `userId` (number) names are used consistently within each branch.

**Explicitly deferred to the future-proofing plan:** name trimming, `allowed_sections` validation, PIN input attributes, i18n keys, modal a11y, dead-code cleanup (see `2026-07-09-users-page-future-proofing.md`).

## Execution Handoff

Plan complete. Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — batch execution with checkpoints.
