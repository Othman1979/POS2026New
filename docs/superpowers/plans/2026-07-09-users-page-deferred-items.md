# Users Page Deferred-Items Fix Plan

> **For agentic workers:** Execute this VERBATIM, task-by-task, test-first. Steps use checkbox (`- [ ]`) syntax. Every file path and OLD→NEW block is exact — do not improvise.

**Goal:** Close the three deferred Users-page items: (#14) optional admin manager-override PIN, (#18) visible keyboard focus ring, (#19) stop leaking raw 500 error text.

**Architecture:** Small, contained edits to `backend/routes/admin/users.js`, `src/admin/pages/Users.vue`, and `assets/js/admin/i18n.js`. No new components. #14 adds an admin-only, bcrypt-hashed override PIN field (4–8 digits, blank-on-edit = keep).

**Tech Stack:** Express + mysql2, Vue 3 Composition API, Vitest.

## Base-State (read carefully)

Two prior passes are already applied: a bug-fix pass (merged to master) and a future-proofing pass (on branch `chore/users-page-future-proofing`, NOT yet merged). This fix STACKS on the future-proofing branch. The OLD blocks below reference that already-hardened code (it has `normalizeUserNumber`, `ALLOWED_ROLES`, `sanitizeAllowedSections`, name-trim, the PIN input attributes, modal a11y, and Arabic i18n keys). If any OLD block does not match byte-for-byte, STOP and report — do not adapt it.

## Environment

- Repo root: `C:\xampp\htdocs\posapp` — run ALL commands from here.
- OS: Windows, PowerShell. Backend: Node/Express + mysql2. Frontend: Vue 3. Tests: Vitest.

## Setup

1. `git status` must be clean. If not, STOP and report (do not stash/reset).
2. `git checkout chore/users-page-future-proofing`
3. `git checkout -b chore/users-page-deferred-items`

## Hard Rules — Non-Negotiable

1. TDD, test-first, for Tasks 1 and 2: (a) write the failing test exactly as given, (b) run it RED for the predicted reason, (c) apply the change, (d) run it GREEN, (e) commit. Task 3 is a mechanical string change with no forceable failing test — see its note.
2. Test command is ONLY `npx vitest run <path>`. NEVER `jest`/`npx jest` (false failures here). Never edit test scripts/config.
3. Apply the OLD→NEW blocks VERBATIM. Do not rename, reorder, reformat, or add anything not written here. Resist initiative.
4. If any OLD block does not match the file exactly, STOP and report the mismatch. Never guess or force an edit.
5. One commit per task, using the given commit message. `git add` ONLY that task's listed files. NEVER `git add -A`/`git add .`.
6. Do NOT push, merge, open a PR, or start the app. Stop after Task 3.
7. Paste the real RED and GREEN terminal output for every test run. No claims without proof.

---

## TASK 1 — Optional Manager Override PIN for admin accounts (#14)

Admins created here have `admin_pin=NULL` and can never approve manager overrides, and no screen sets it. Add an optional, admin-only "Manager Override PIN" field: bcrypt-hashed, 4–8 digits, blank-on-edit means keep the existing PIN.

**Files:**
- Modify: `backend/routes/admin/users.js`
- Modify: `src/admin/pages/Users.vue`
- Modify: `assets/js/admin/i18n.js`
- Create: `backend/tests/integration/usersAdminPin.test.js`
- Modify (append): `src/admin/pages/__tests__/usersPage.quality.spec.js`

- [ ] **STEP 1: Write the failing BACKEND test.** Create `backend/tests/integration/usersAdminPin.test.js`:

```js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Admin Users API — manager override PIN', () => {
    let adminCookie;
    beforeEach(async () => {
        await seedDatabase();
        const adminRes = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it('hashes admin_pin on create and it approves manager overrides', async () => {
        const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Mgr One', user_number: '9401', role: 'admin', admin_override_pin: '4242' });
        expect(create.statusCode).toBe(200);

        const [rows] = await pool.query("SELECT admin_pin FROM users WHERE user_number = '9401'");
        expect(rows[0].admin_pin).toBeTruthy();
        expect(rows[0].admin_pin.startsWith('$2')).toBe(true);

        const ok = await request(app).post('/api/auth/manager_override').set('Cookie', adminCookie).send({ admin_pin: '4242' });
        expect(ok.statusCode).toBe(200);
    });

    it('rejects an override PIN that is not 4-8 digits', async () => {
        const res = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Bad Pin', user_number: '9402', role: 'admin', admin_override_pin: '12' });
        expect(res.statusCode).toBe(400);
    });

    it('ignores an override PIN for non-admin roles (admin_pin stays null)', async () => {
        const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Cash Pin', user_number: '9403', role: 'cashier', admin_override_pin: '7777', allowed_sections: '' });
        expect(create.statusCode).toBe(200);
        const [rows] = await pool.query("SELECT admin_pin FROM users WHERE user_number = '9403'");
        expect(rows[0].admin_pin).toBeNull();

        const denied = await request(app).post('/api/auth/manager_override').set('Cookie', adminCookie).send({ admin_pin: '7777' });
        expect(denied.statusCode).toBe(401);
    });

    it('PUT with a blank override PIN keeps the existing admin_pin', async () => {
        const create = await request(app).post('/api/admin/users').set('Cookie', adminCookie)
            .send({ name: 'Keep Pin', user_number: '9404', role: 'admin', admin_override_pin: '5252' });
        expect(create.statusCode).toBe(200);
        const [before] = await pool.query("SELECT id, admin_pin FROM users WHERE user_number = '9404'");
        const id = before[0].id;

        const put = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
            .send({ id, name: 'Keep Pin', user_number: '9404', role: 'admin', admin_override_pin: '' });
        expect(put.statusCode).toBe(200);
        const [after] = await pool.query("SELECT admin_pin FROM users WHERE id = ?", [id]);
        expect(after[0].admin_pin).toBe(before[0].admin_pin);

        const ok = await request(app).post('/api/auth/manager_override').set('Cookie', adminCookie).send({ admin_pin: '5252' });
        expect(ok.statusCode).toBe(200);
    });
});
```

- [ ] **STEP 2: Run it RED:** `npx vitest run backend/tests/integration/usersAdminPin.test.js`
  Expected: fails — `admin_pin` is never set, override returns 401.

- [ ] **STEP 3: Backend edits in `backend/routes/admin/users.js`.**

  **(3a)** Add the hash import. After this line:
```js
const { getCatalog } = require('../../services/PermissionService');
```
  add:
```js
const { hashPin } = require('../../middleware/auth');
```

  **(3b)** Add PIN-hash computation to BOTH POST and PUT. This block appears twice (identical) — replace BOTH (replace_all):
  OLD:
```js
            let allowed_sections = null;
            if (role !== 'admin') {
                allowed_sections = await sanitizeAllowedSections(data.allowed_sections);
                if (allowed_sections === false) {
                    return sendError(res, 400, "Invalid section selection.");
                }
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

            let adminPinHash = null;
            if (role === 'admin') {
                const rawPin = String(data.admin_override_pin ?? '').trim();
                if (rawPin.length > 0) {
                    if (!/^[0-9]{4,8}$/.test(rawPin)) {
                        return sendError(res, 400, "Manager override PIN must be 4-8 digits.");
                    }
                    adminPinHash = await hashPin(rawPin);
                }
            }
```

  **(3c)** POST INSERT — persist admin_pin:
  OLD:
```js
            const [result] = await pool.query(
                "INSERT INTO users (name, user_number, role, allowed_sections) VALUES (?, ?, ?, ?)",
                [name, userNumber, role, allowed_sections]
            );
```
  NEW:
```js
            const [result] = await pool.query(
                "INSERT INTO users (name, user_number, role, allowed_sections, admin_pin) VALUES (?, ?, ?, ?, ?)",
                [name, userNumber, role, allowed_sections, adminPinHash]
            );
```

  **(3d)** PUT — set admin_pin only when a new one was provided (blank keeps existing):
  OLD:
```js
            await pool.query(
                "UPDATE users SET name = ?, user_number = ?, role = ?, allowed_sections = ? WHERE id = ?",
                [name, userNumber, role, allowed_sections, userId]
            );
            await replaceUserGrants(userId, data.permissions, role);
```
  NEW:
```js
            await pool.query(
                "UPDATE users SET name = ?, user_number = ?, role = ?, allowed_sections = ? WHERE id = ?",
                [name, userNumber, role, allowed_sections, userId]
            );
            if (adminPinHash) {
                await pool.query("UPDATE users SET admin_pin = ? WHERE id = ?", [adminPinHash, userId]);
            }
            await replaceUserGrants(userId, data.permissions, role);
```

- [ ] **STEP 4: Run it GREEN:** `npx vitest run backend/tests/integration/usersAdminPin.test.js`

- [ ] **STEP 5: Write the failing FRONTEND assertion.** Append INSIDE `src/admin/pages/__tests__/usersPage.quality.spec.js`, immediately ABOVE the line `  // <-- append new it() blocks above this line`:
```js
  it('modal has an admin-only Manager Override PIN field', () => {
    expect(SRC).toMatch(/v-if="hasGodMode"/);
    expect(SRC).toMatch(/v-model="form\.admin_override_pin"/);
    expect(SRC).toMatch(/admin_override_pin: ''/);
  });
```

- [ ] **STEP 6: Run it RED:** `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`

- [ ] **STEP 7: Frontend edits in `src/admin/pages/Users.vue`.**

  **(7a)** form ref default — add the field:
  OLD:
```js
        const form = ref({
            id: null,
            name: '',
            user_number: '',
            role: 'cashier',
            permissions: [],
            allowed_sections: []
        });
```
  NEW:
```js
        const form = ref({
            id: null,
            name: '',
            user_number: '',
            role: 'cashier',
            permissions: [],
            allowed_sections: [],
            admin_override_pin: ''
        });
```

  **(7b)** openModal EDIT branch — add the field (never prefilled; write-only):
  OLD:
```js
                form.value = {
                    id: user.id,
                    name: user.name,
                    user_number: user.user_number,
                    role: user.role,
                    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
                    allowed_sections: user.allowed_sections ? user.allowed_sections.split(',').map(Number) : []
                };
```
  NEW:
```js
                form.value = {
                    id: user.id,
                    name: user.name,
                    user_number: user.user_number,
                    role: user.role,
                    permissions: Array.isArray(user.permissions) ? [...user.permissions] : [],
                    allowed_sections: user.allowed_sections ? user.allowed_sections.split(',').map(Number) : [],
                    admin_override_pin: ''
                };
```

  **(7c)** openModal CREATE branch — add the field:
  OLD:
```js
                form.value = {
                    id: null,
                    name: '',
                    user_number: '',
                    role: 'cashier',
                    permissions: permissionCatalog.value.filter(p => p.default_cashier && p.implemented).map(p => p.perm_key),
                    allowed_sections: []
                };
```
  NEW:
```js
                form.value = {
                    id: null,
                    name: '',
                    user_number: '',
                    role: 'cashier',
                    permissions: permissionCatalog.value.filter(p => p.default_cashier && p.implemented).map(p => p.perm_key),
                    allowed_sections: [],
                    admin_override_pin: ''
                };
```

  **(7d)** Add the admin-only field markup in the modal, between the name/PIN/role grid and the permissions block:
  OLD:
```html
                        </div>

                        <!-- Permissions for Cashiers/Waiters -->
                        <div v-if="!hasGodMode" class="border-t border-zinc-200 pt-4 space-y-4">
```
  NEW:
```html
                        </div>

                        <!-- Manager Override PIN (admins only) -->
                        <div v-if="hasGodMode">
                            <label class="block text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">{{ $t('Manager Override PIN') }}</label>
                            <input type="text" v-model="form.admin_override_pin" maxlength="8" inputmode="numeric" pattern="[0-9]*" :placeholder="isEditing ? $t('Leave blank to keep current') : $t('Optional')" class="w-full bg-muted border border-zinc-300 rounded-lg py-2 px-3 text-xs font-medium text-foreground focus:bg-card focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 transition-all outline-none placeholder:text-muted-foreground h-9 tabular-nums">
                            <p class="text-[10px] text-muted-foreground mt-1.5">{{ $t('Used to approve manager overrides at the register.') }}</p>
                        </div>

                        <!-- Permissions for Cashiers/Waiters -->
                        <div v-if="!hasGodMode" class="border-t border-zinc-200 pt-4 space-y-4">
```

- [ ] **STEP 8: i18n — add Arabic for the new labels.** In `assets/js/admin/i18n.js`, find:
```js
    'Other': 'أخرى',
```
  and insert immediately AFTER it:
```js
    'Manager Override PIN': 'رمز موافقة المدير',
    'Leave blank to keep current': 'اتركه فارغاً للإبقاء على الحالي',
    'Optional': 'اختياري',
    'Used to approve manager overrides at the register.': 'يُستخدم للموافقة على تجاوزات المدير في الصندوق.',
    'Manager override PIN must be 4-8 digits.': 'يجب أن يكون رمز موافقة المدير من 4 إلى 8 أرقام.',
```

- [ ] **STEP 9: Run GREEN + build:**
  `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
  `npm run build:admin`

- [ ] **STEP 10: Commit** (stage ONLY these five files):
```bash
git add backend/routes/admin/users.js src/admin/pages/Users.vue assets/js/admin/i18n.js backend/tests/integration/usersAdminPin.test.js src/admin/pages/__tests__/usersPage.quality.spec.js
git commit -m "feat(users): optional manager override PIN for admin accounts"
```

---

## TASK 2 — Restore visible keyboard focus ring on the Users page (#18)

`focus:outline-none` removes the focus ring on 13 interactive elements, leaving keyboard users with no visible focus. Add a `:focus-visible` ring wherever it is removed.

**Files:**
- Modify: `src/admin/pages/Users.vue`
- Modify (append): `src/admin/pages/__tests__/usersPage.quality.spec.js`

- [ ] **STEP 1: Write the failing test.** Append INSIDE `src/admin/pages/__tests__/usersPage.quality.spec.js`, ABOVE the `// <-- append new it() blocks above this line` marker:
```js
  it('every focus:outline-none also restores a visible focus-visible ring', () => {
    expect(SRC).not.toMatch(/focus:outline-none(?! focus-visible)/);
    expect(SRC).toMatch(/focus-visible:ring-2 focus-visible:ring-teal-500\/40/);
  });
```

- [ ] **STEP 2: Run RED:** `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`

- [ ] **STEP 3:** In `src/admin/pages/Users.vue`, replace EVERY occurrence (replace_all) of the exact string:
```
focus:outline-none
```
  with:
```
focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40
```
  (There are 13. Do NOT touch strings that read `outline-none` without the `focus:` prefix — those are inputs that already have their own focus ring.)

- [ ] **STEP 4: Run GREEN + build:**
  `npx vitest run src/admin/pages/__tests__/usersPage.quality.spec.js`
  `npm run build:admin`

- [ ] **STEP 5: Commit** (stage ONLY these two files):
```bash
git add src/admin/pages/Users.vue src/admin/pages/__tests__/usersPage.quality.spec.js
git commit -m "a11y(users): restore visible focus-visible ring on Users page"
```

---

## TASK 3 — Stop leaking raw error text on 500 (#19)

`sendError(res, 500, e.message)` returns raw internals to the client on non-production. The full error is already logged via `logAdminRouteError`. Return a generic message instead.
**NOTE:** no TDD red test here — a 500 cannot be deterministically forced through this route without invasive mocking. This is a mechanical 2-line change verified by grep + full suite.

**Files:**
- Modify: `backend/routes/admin/users.js`

- [ ] **STEP 1:** In `backend/routes/admin/users.js`, replace EVERY occurrence (replace_all) of:
```js
        sendError(res, 500, e.message);
```
  with:
```js
        sendError(res, 500, "An unexpected error occurred.");
```
  (There are two — one in the `/permissions` catch, one in the `/users` catch.)

- [ ] **STEP 2: Verify** — run and paste the output of:
  `git grep -n "500, e.message" -- backend/routes/admin/users.js`
  Expected: no output.

- [ ] **STEP 3: Commit** (stage ONLY this file):
```bash
git add backend/routes/admin/users.js
git commit -m "chore(users): generic 500 message (stop leaking e.message)"
```

---

## Definition of Done

- 3 task commits on `chore/users-page-deferred-items`, each with the exact message above.
- Full suite green: `npx vitest run` (paste the summary line).
- `npm run build:admin` succeeds (paste the final line).
- Report: branch name, `git log --oneline chore/users-page-future-proofing..HEAD`, total tests passing, build status, and anything you had to STOP on.
