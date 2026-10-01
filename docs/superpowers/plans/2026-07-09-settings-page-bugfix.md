# Settings Page — Bug-Fix Plan (2026-07-09)

Audit source: parallel FE (`vue` + `how-to-write-component`) + BE (`nodejs-backend-patterns` + `mysql`) agents, findings verified against live code by orchestrator. This plan covers **confirmed bugs / data-loss / RCE / validation holes only**. Cleanup, i18n, a11y, perf → separate future-proofing plan.

## Ground rules (READ FIRST — lower-model executor)
- **Test runner is Vitest**, never jest: `npx vitest run <file>`. `npx jest` gives false failures here.
- Full-suite baseline command: `npx vitest run` (from repo root `C:\xampp\htdocs\posapp`). **Run it BEFORE any change, record the pass count**, so you can prove no regressions.
- Backend integration tests boot the real app: `const { app } = require('../../../server')`, seed via `const { seedDatabase, SEED } = require('../fixtures/seed')`, drive via `supertest`. Login = `POST /api/auth/login` with `{ user_number: SEED.adminUser.user_number }`, capture `res.headers['set-cookie'][0]`, resend as `.set('Cookie', cookie)`. SEED has `adminUser`, `cashierUser`, `waiterUser`.
- **There is NO Vue SFC test harness** (no `@vue/test-utils`, no jsdom mount). Frontend-only tasks (T1, T2) are verified by `npm run build:admin` (must stay green) **plus a manual browser check** described per task. Do not invent a mount test.
- Branch: `fix/settings-page-bugs`. Owner may have unrelated WIP — do **not** `git stash`; stage only the specific files you edit. Never `git add` a whole file that also holds owner WIP.
- TDD: for every backend task, write the failing test FIRST, run it, see it fail for the right reason, then implement, then see it pass.
- Money/enum guards fail **closed** (return 400 on bad input), matching the project's money-guard convention.

## Baseline evidence table
| ID | Claim | Evidence (verified) | Failure scenario |
|----|-------|--------------------|------------------|
| R1 | Refresh button is a no-op | `Settings.vue:42` binds `@click="loadData"`; `loadData` defined `:828`, used `:881/957/989/1062/1074`, **absent from return block `:1153-1162`** (grep-confirmed) | User clicks Refresh → nothing; only recovery is full page reload |
| R2 | Silent load-fail → Save writes defaults over real config | `loadData` catch only `console.error` (`:874-878`) then `isLoading=false`; refs keep hardcoded defaults (`:704-720`); `saveSettings` (`:886-904`) POSTs full snapshot; backend upserts every provided key (`system.js:104-113`) | GET settings fails → General tab shows defaults → admin hits Save → store config/service-charge/flags wiped, persisted |
| R3 | brand-icon deletes old icon BEFORE validating new upload | `system.js:234` `deleteExistingIcons()` unconditional, THEN `upload()` + `uploadErr`/`!req.file` checks `:239-241` | Failed upload (too big / bad type / empty) → old icon already gone, DB path stale → broken logo until a successful re-upload |
| R4 | Icon upload = live RCE (Apache serves `/uploads`, owner-confirmed) | Filename = `'store_icon' + path.extname(client.originalname)` (`system.js:214`); only gate is client `Content-Type` (`:222-223`), no content sniff; SVG allowed | Admin/attacker uploads `x.php` with header `Content-Type: image/png` → written `uploads/store_icon.php` → served by Apache at `/posapp/uploads/store_icon.php` → **PHP executes = RCE**. SVG w/ `<script>` = stored XSS on Apache path (bypasses helmet CSP) |
| S1 | No server-side validation of money/enum settings | `system.js:78-83` validates only `admin_language`+`duplicate_customer_receipt`; `85-113` upserts the rest raw | `service_charge_percentage:"abc"`/`-50`/`99999`, junk `table_mode`/`print_method` persist → feed checkout math (NaN/garbage totals) |
| S2 | `router.all` chains hang on unsupported methods | `printers.js:12-33` (order_types) & `:36-124` (printers): if/else-if for GET/POST/PUT/DELETE, **no else**; `products.js:306` does `else → 405` | `PATCH /api/admin/printers` → falls out of `try`, never calls `res.*` → socket hangs till timeout (no 405) |
| S3 | printers: undefined binds → 500; no required/enum/port validation | `printers.js:59-104`; mysql2 throws on `undefined` bind | POST printer missing `name` → mysql2 undefined-bind throw → 500 instead of 400; bad port/enum stored |
| S4 | order_types: undefined binds → 500; name not required/trimmed | `printers.js:17-27` | POST order_type with no `name` → 500; PUT/DELETE with no `id` → 500; whitespace/dup names accepted |

**Confirmed NOT bugs (do not "fix"):** partial single-key POST does not wipe other keys (`ON DUPLICATE KEY UPDATE` per-key, `system.js:108-111`); settings-key injection blocked by `allowed_keys` allow-list (`:85-91`); printer+categories & delete writes are already transactional w/ rollback+`conn.release()` in `finally` (`printers.js:62-118`); all SQL parameterized. Leave these alone.

---

## Task 1 — R1: expose `loadData` so the Refresh button works
**File:** `src/admin/pages/Settings.vue`
**Anchor:** the `return { ... }` object, ends at line 1161 with `storeIcon, fileInput, isUploadingIcon, handleIconUpload, handleIconRemove`.
**Change:** add `loadData` to the returned object. Exact edit — replace:
```js
            activeTab, isLoading, isSaving, toastMessage,
```
with:
```js
            activeTab, isLoading, isSaving, toastMessage, loadData,
```
**Verify:**
- `npm run build:admin` → green.
- Manual: open Settings, open DevTools Network, click the rotate-right Refresh button (top-right) → observe a fresh `GET api/system/settings` (+ printers/categories/order_types/print-queue) fire. Before the fix, nothing fires.
**Risk:** none — pure export addition.
**Commit:** `fix(settings): expose loadData so Refresh button re-fetches (was dead no-op)`

---

## Task 2 — R2: surface load failure, block Save-over-defaults
**File:** `src/admin/pages/Settings.vue`
**Goal:** if the initial settings load fails, do NOT silently show defaults that Save can then persist. Show an error state and disable Save until a successful load.

**Steps:**
1. Add a ref near the other state (after `isLoading` at `:745`):
```js
        const loadFailed = ref(false);
```
2. In `loadData` (`:828`), set `loadFailed.value = false;` at the top of the `try`, treat a non-success settings response as a failure, and set the flag in `catch`. Replace the settings block start (`:832-834`):
```js
                // 1. Load General Settings
                const resSet = await fetch('api/system/settings');
                const dataSet = await resSet.json();
                if (dataSet.success) {
```
with:
```js
                // 1. Load General Settings
                const resSet = await fetch('api/system/settings');
                const dataSet = await resSet.json();
                if (!dataSet.success) throw new Error('settings load failed');
                if (dataSet.success) {
```
   and in the `catch` (`:874-878`) add the flag:
```js
            } catch (error) {
                console.error("Failed to load settings data", error);
                loadFailed.value = true;
            } finally {
                isLoading.value = false;
            }
```
3. In `saveSettings` (`:884`), refuse to save if the load failed. Add at the very top of the function body (before `isSaving.value = true;`):
```js
            if (loadFailed.value) {
                await window.showAdminAlert(t("Settings failed to load — reload before saving to avoid overwriting saved values."));
                return;
            }
```
4. Template: show a load-error banner and disable the Save button when `loadFailed`. In the General tab wrapper (`:57`), immediately inside, add a banner:
```html
                    <div v-if="loadFailed" class="m-6 mb-0 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold flex items-center gap-2">
                        <i class="fa-solid fa-triangle-exclamation"></i>{{ $t('Could not load current settings. Refresh before making changes.') }}
                    </div>
```
   and on the Save button (`:29`) add `|| loadFailed` to `:disabled`:
```html
                    <button v-if="activeTab === 'general'" @click="saveSettings" :disabled="isSaving || loadFailed" ...
```
5. Add `loadFailed` to the return object (Task 1's line):
```js
            activeTab, isLoading, isSaving, toastMessage, loadData, loadFailed,
```
6. Add the two new i18n keys (`Settings failed to load — reload before saving to avoid overwriting saved values.`, `Could not load current settings. Refresh before making changes.`) to BOTH `en` and `ar` dictionaries in `assets/js/admin/i18n.js` (find the object literal; `en` maps key→same English, `ar` maps key→Arabic — copy the Arabic phrasing style of nearby keys; if unsure, ask owner for the Arabic string, do not leave it English in `ar`).
**Verify:**
- `npm run build:admin` green.
- Manual: in DevTools, block `api/system/settings` (Network → block request URL), reload Settings → red banner shows, Save button disabled. Unblock, click Refresh → banner clears, Save enabled.
**Risk:** the `if (!dataSet.success) throw` + the existing `if (dataSet.success)` are intentionally both present so the assignment block is unreachable on failure without deleting it (keeps the diff minimal); confirm no lint error on the always-true second `if`.
**Commit:** `fix(settings): block save-over-defaults when initial settings load fails (silent data-loss)`

---

## Task 3 — R3 + R4: secure brand-icon upload (validate-before-delete, magic-byte sniff, drop SVG)
**File:** `backend/routes/system.js`
**Why one task:** switching to in-memory upload lets us validate the real file bytes BEFORE deleting the old icon (fixes R3) and BEFORE writing, and lets us derive the extension from sniffed content instead of the client filename (fixes R4). SVG is dropped (no reliable magic bytes; it is the XSS vector).

**Test first —** extend `backend/tests/integration/systemIcon.test.js`. Add real magic-byte buffers and these cases (place inside the existing `describe('POST /api/system/brand-icon', ...)`):
```js
        const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,0]);
        const JPG = Buffer.from([0xff,0xd8,0xff,0xe0, 0,0,0,0]);

        it('should reject a PHP payload disguised as image/png (content sniff)', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', Buffer.from('<?php system($_GET[0]); ?>'), { filename: 'x.php', contentType: 'image/png' });
            expect(res.statusCode).toBe(400);
            const uploadsDir = path.join(__dirname, '../../../uploads');
            const files = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
            expect(files.some(f => f.startsWith('store_icon.'))).toBe(false); // nothing written
        });

        it('should reject an SVG upload', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
            expect(res.statusCode).toBe(400);
        });

        it('should accept a real PNG and store it as store_icon.png', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', PNG, { filename: 'whatever.bin', contentType: 'image/png' });
            expect(res.statusCode).toBe(200);
            expect(res.body.store_icon).toBe('/uploads/store_icon.png');
        });

        it('should NOT delete the existing icon when a later upload is invalid (validate before delete)', async () => {
            // valid PNG first
            await request(app).post('/api/system/brand-icon').set('Cookie', adminCookie)
                .attach('icon', PNG, { filename: 'a.png', contentType: 'image/png' });
            // now an invalid upload
            await request(app).post('/api/system/brand-icon').set('Cookie', adminCookie)
                .attach('icon', Buffer.from('not an image'), { filename: 'b.png', contentType: 'image/png' });
            // old icon must survive
            const uploadsPath = path.join(__dirname, '../../../uploads/store_icon.png');
            expect(fs.existsSync(uploadsPath)).toBe(true);
            const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'store_icon'");
            expect(rows[0].setting_value).toBe('/uploads/store_icon.png');
        });
```
Run `npx vitest run backend/tests/integration/systemIcon.test.js` → new cases fail (current handler writes the .php/.svg and deletes-before-validate).

**Implement —** replace the multer storage + POST handler block (`system.js:201-265`). New version:
```js
// In-memory upload so we can sniff real bytes before touching disk/DB.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 } // 1 MB
}).single('icon');

// Map sniffed magic bytes -> canonical, safe extension. Extension is NEVER
// taken from the client filename (kills path-traversal + .php/.svg RCE/XSS).
function sniffImageExt(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null; // GIF/SVG/PHP/HTML/anything else -> rejected
}

// POST /api/system/brand-icon (requireAuth, requireAdmin)
router.post('/brand-icon', requireAuth, requireAdmin, async (req, res) => {
    const uploadErr = await new Promise(resolve => upload(req, res, resolve));
    if (uploadErr) return sendError(res, 400, uploadErr.message);
    if (!req.file) return sendError(res, 400, 'No file uploaded.');

    const ext = sniffImageExt(req.file.buffer);
    if (!ext) return sendError(res, 400, 'Only PNG, JPG, ICO, and WEBP image files are allowed.');

    // Validate passed — now (and only now) remove old icons and write the new one.
    try {
        await deleteExistingIcons();
    } catch (err) {
        logSystemRouteError(req, err, 'Error cleaning old icons');
    }

    const filename = `store_icon.${ext}`;
    const relativePath = `/uploads/${filename}`;
    try {
        const dir = path.join(__dirname, '../../uploads');
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(path.join(dir, filename), req.file.buffer);

        await pool.query(
            `INSERT INTO settings (setting_key, setting_value) VALUES ('store_icon', ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
            [relativePath]
        );

        invalidateCatalogCache();
        invalidateDashboardCache();
        triggerStaticMenuGeneration();
        if (req.io) req.io.to('staff').emit('settings_changed', { keys: ['store_icon'] });

        return sendSuccess(res, { store_icon: relativePath });
    } catch (dbErr) {
        logSystemRouteError(req, dbErr, 'Failed to save store icon.');
        return sendError(res, 500, dbErr.message);
    }
});
```
Notes:
- Delete the old `storage`/`multer.diskStorage` block and the old `upload` definition (`system.js:201-230`) — the new `upload` above replaces it. Keep `deleteExistingIcons()` (`:180-199`) unchanged.
- Keep the DELETE `/brand-icon` handler (`:267-287`) as-is.
- The existing test `should reject invalid file types` (`systemIcon.test.js:82-91`) asserts message `Only PNG, JPG, ICO, SVG, and WEBP` — **update that assertion** to the new message (`Only PNG, JPG, ICO, and WEBP`) since SVG is now rejected; the `.txt` case still 400s (fails the sniff).

**Frontend copy sync (SVG dropped):**
- `Settings.vue:99` change `PNG, JPG, ICO, SVG or WEBP — max 1 MB` → `PNG, JPG, ICO or WEBP — max 1 MB` (and the matching i18n keys in `en`+`ar`).
- `Settings.vue:89` `accept="image/*"` may stay, but optionally tighten to `accept="image/png,image/jpeg,image/x-icon,image/webp"`.

**Verify:** `npx vitest run backend/tests/integration/systemIcon.test.js` all green; then `npx vitest run` full suite green; `npm run build:admin` green. Manual: upload a real PNG → logo shows; rename a `.php` to upload → 400, nothing written under `uploads/`.
**Risk:** SVG store icons are no longer supported — confirm no customer currently uses an SVG logo (if they do, they must re-upload PNG). This is the intended security trade-off; note it in the deploy handoff.
**Commit:** `fix(settings): harden brand-icon upload — sniff magic bytes, drop SVG, validate before delete (RCE/XSS + icon data-loss)`

---

## Task 4 — S1: server-side validation of money/enum settings
**File:** `backend/routes/system.js`, POST `/settings` (`:74-131`).
**Test first —** new file `backend/tests/integration/settingsValidation.test.js` (model on `systemIcon.test.js` boot/login/teardown):
```js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('POST /api/system/settings validation', () => {
    let adminCookie;
    beforeAll(async () => {
        await seedDatabase();
        const r = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = r.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    const post = (body) => request(app).post('/api/system/settings').set('Cookie', adminCookie).send(body);

    it('rejects non-numeric service_charge_percentage', async () => {
        const res = await post({ service_charge_percentage: 'abc' });
        expect(res.statusCode).toBe(400);
    });
    it('rejects out-of-range service_charge_percentage', async () => {
        expect((await post({ service_charge_percentage: '150' })).statusCode).toBe(400);
        expect((await post({ service_charge_percentage: '-5' })).statusCode).toBe(400);
    });
    it('rejects unknown table_mode', async () => {
        expect((await post({ table_mode: 'moon' })).statusCode).toBe(400);
    });
    it('rejects unknown print_method', async () => {
        expect((await post({ print_method: 'telepathy' })).statusCode).toBe(400);
    });
    it('accepts valid values', async () => {
        const res = await post({ service_charge_percentage: '12.5', service_charge_tax_rate: '0', low_stock_threshold: '5', table_mode: 'dynamic', print_method: 'backend' });
        expect(res.statusCode).toBe(200);
        const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='service_charge_percentage'");
        expect(rows[0].setting_value).toBe('12.5');
    });
});
```
Run → fails (current handler 200s on everything). **Implement —** insert a validation block in POST `/settings` right after the `duplicate_customer_receipt` coercion (`system.js:83`), before `const allowed_keys`:
```js
        const numInRange = (v, lo, hi) => {
            if (v === undefined) return true;            // key not sent -> untouched
            const n = Number(v);
            return Number.isFinite(n) && n >= lo && n <= hi;
        };
        if (!numInRange(data.service_charge_percentage, 0, 100)) return sendError(res, 400, "Invalid service charge percentage.");
        if (!numInRange(data.service_charge_tax_rate, 0, 100)) return sendError(res, 400, "Invalid service charge tax rate.");
        if (!numInRange(data.low_stock_threshold, 0, 1000000)) return sendError(res, 400, "Invalid low stock threshold.");
        if (data.table_mode !== undefined && !['fixed', 'dynamic'].includes(data.table_mode)) return sendError(res, 400, "Invalid table mode.");
        if (data.print_method !== undefined && !['browser', 'backend'].includes(data.print_method)) return sendError(res, 400, "Invalid print method.");
```
(Leave `admin_language` and `duplicate_customer_receipt` coercion as-is — already shipped, tested elsewhere.)
**Verify:** `npx vitest run backend/tests/integration/settingsValidation.test.js` green; full suite green.
**Risk:** the FE currently can submit these values; after this, an out-of-range submit 400s and shows `data.message` via `showAdminAlert`. Acceptable. Also add matching **client** min/max guard in a follow-up (future-proofing) — not required for the security fix.
**Commit:** `fix(settings): validate money/enum settings server-side (reject junk before it feeds POS math)`

---

## Task 5 — S2: return 405 on unsupported methods (order_types + printers)
**File:** `backend/routes/admin/printers.js`
**Test first —** extend `backend/tests/integration/adminRouting.test.js` (inside the `Admin Full Route Access Check` describe or a new one):
```js
        it('should return 405 (not hang) for unsupported method on printers/order_types', async () => {
            const r1 = await request(app).patch('/api/admin/printers').set('Cookie', adminCookie).send({});
            expect(r1.statusCode).toBe(405);
            const r2 = await request(app).patch('/api/admin/order_types').set('Cookie', adminCookie).send({});
            expect(r2.statusCode).toBe(405);
        });
```
Run → hangs/fails (no response today). **Implement —** add an `else` to both `if/else-if` chains, matching `products.js:306`:
- order_types (after the DELETE branch, before `} catch`, i.e. after `printers.js:27`):
```js
        } else {
            return sendError(res, 405, "Method not allowed.");
        }
```
- printers (after the DELETE branch, after `printers.js:118`):
```js
        } else {
            return sendError(res, 405, "Method not allowed.");
        }
```
**Verify:** `npx vitest run backend/tests/integration/adminRouting.test.js` green (the PATCH test now returns 405 instead of hanging); full suite green.
**Risk:** none — only affects methods the UI never sends.
**Commit:** `fix(admin): 405 instead of hang on unsupported methods for printers/order_types`

---

## Task 6 — S3 + S4: input validation on printers + order_types (400 not 500)
**File:** `backend/routes/admin/printers.js`
**Test first —** new file `backend/tests/integration/printersValidation.test.js` (boot/login like above):
```js
    // order_types
    it('order_types POST without name -> 400 not 500', async () => {
        const res = await request(app).post('/api/admin/order_types').set('Cookie', adminCookie).send({ requires_hash: false });
        expect(res.statusCode).toBe(400);
    });
    it('order_types PUT without id -> 400', async () => {
        const res = await request(app).put('/api/admin/order_types').set('Cookie', adminCookie).send({ name: 'X' });
        expect(res.statusCode).toBe(400);
    });
    // printers
    it('printers POST without name -> 400 not 500', async () => {
        const res = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({ role: 'receipt', type: 'windows' });
        expect(res.statusCode).toBe(400);
    });
    it('printers POST with bad role -> 400', async () => {
        const res = await request(app).post('/api/admin/printers').set('Cookie', adminCookie).send({ name: 'P', role: 'boss', type: 'windows', windows_name: 'x' });
        expect(res.statusCode).toBe(400);
    });
```
**Implement —** at the top of each mutating branch in `printers.js`, add guards that return `sendError(res, 400, ...)` before touching the DB. Precise insertions:
- **order_types POST** (before `:19`): `const name = (req.body.name || '').trim(); if (!name) return sendError(res, 400, "Order type name is required."); ` and use `name` in the INSERT instead of `req.body.name`.
- **order_types PUT** (before `:23`): same `name` guard + `if (!req.body.id) return sendError(res, 400, "Order type id is required.");` and use `name`.
- **order_types DELETE** (before `:26`): `if (!req.body.id) return sendError(res, 400, "Order type id is required.");`
- **printers POST** (before `:60`): 
```js
            const name = (req.body.name || '').trim();
            if (!name) return sendError(res, 400, "Printer name is required.");
            if (!['receipt', 'kitchen'].includes(req.body.role)) return sendError(res, 400, "Invalid printer role.");
            if (!['windows', 'network'].includes(req.body.type)) return sendError(res, 400, "Invalid connection type.");
            if (req.body.type === 'network') {
                if (!req.body.network_ip) return sendError(res, 400, "Network IP is required.");
                const port = Number(req.body.network_port);
                if (!Number.isInteger(port) || port < 1 || port > 65535) return sendError(res, 400, "Invalid network port.");
            }
            if (req.body.type === 'windows' && !req.body.windows_name) return sendError(res, 400, "Windows printer name is required.");
```
  and pass `name` (not `req.body.name`) into the INSERT bind array (`:67`). Also coerce undefined optional binds to `null` in the bind array to avoid mysql2 undefined-throw: `req.body.network_ip ?? null`, `req.body.network_port ?? null`, `req.body.windows_name ?? null`.
- **printers PUT** (before `:83`): same name/role/type/network/windows guards + `if (!req.body.id) return sendError(res, 400, "Printer id is required.");`, use `name`, and `?? null` on optional binds (`:90`).
- **printers DELETE** (before `:106`): `if (!req.body.id) return sendError(res, 400, "Printer id is required.");`
**Verify:** `npx vitest run backend/tests/integration/printersValidation.test.js` green; the existing `adminRouting` printers GET test still green; full suite green.
**Risk:** the FE already blocks empty name/ip client-side, so these guards only catch malformed/direct API calls — no UX regression. Enum lists must match the FE `<select>` values exactly (verified: role `receipt`/`kitchen`, type `windows`/`network`).
**Commit:** `fix(admin): validate printers/order_types input, return 400 not 500 on missing fields`

---

## Ship order & final verification
1. Do tasks in order T1→T6 (independent, but T3 & T4 both edit `system.js` — do T3 then T4, staging hunks separately; T5 & T6 both edit `printers.js` — T5 then T6).
2. After all: `npx vitest run` (full suite) MUST match baseline pass count + the new tests. `npm run build:admin` MUST be green.
3. Do NOT push. Report the diff + test counts to owner for review before merge (per page-audit rule: owner re-verifies).

## Plan self-review (attacked before handoff)
- *Assumption that could be false:* that Apache executes `.php` under `/uploads`. Owner confirmed Apache serves `/uploads`; even if PHP handler were off, dropping client-controlled extensions + SVG is correct hardening regardless. Fix does not depend on the assumption.
- *Test passing for wrong reason:* T3's "not written" check reads the uploads dir — ensure `afterAll` cleanup (already in `systemIcon.test.js:29-41`) runs so a prior test's `store_icon.png` doesn't mask the assertion; the invalid-upload test uses a fresh invalid buffer and asserts the PRIOR valid png survives, which is the correct signal.
- *Regression risk:* changing the invalid-file-type message breaks the existing assertion at `systemIcon.test.js:90` — Task 3 explicitly updates it. Do not skip that.
- *Ships-together:* T3's backend SVG-drop and the FE copy change (`PNG, JPG, ICO or WEBP`) should land in the same commit so UI text doesn't advertise an unsupported format.
- *Deferred (NOT in this plan):* audit_events on config writes (S6), boot-time schema ensure (S7), cache-invalidate on icon change (S5), i18n gaps, a11y, cosmetic — all in the future-proofing plan.
- *i18n gate:* T2 and T3 add/adjust user-visible English strings — their `ar` translations must be added, or the page shows English under Arabic (known page-wide limitation for backend `data.message`, but these are `$t()` frontend strings so they MUST be translated). If Arabic wording is unknown, ask owner rather than leaving English in the `ar` map.
