# Settings Page — Future-Proofing / Polish Plan (2026-07-09, rev2)

Companion to `2026-07-09-settings-page-bugfix.md` (already executed + MERGED to master). This plan is **cleanup, i18n, a11y, and perf only** — no data-loss/RCE. 6 tasks.

> **rev2 note:** all line anchors below were RE-VERIFIED against master AFTER the bug-fix merge (which shifted Settings.vue / i18n.js line numbers). Task 7 (audit_events on config writes) was **removed — owner declined**. Task 2 corrected (English uses identity fallback; there is no `en` dictionary — add Arabic only). Task 6 rewritten (the old "move to boot" approach was wrong and would break tests — see Task 6).

## Ground rules
- Test runner is **Vitest**: `npx vitest run <path>`, never jest. Baseline the full suite first (`npx vitest run`) and record the pass count (should be **958** on current master).
- **No SFC/mount test harness exists** (no `@vue/test-utils`). Frontend tasks (1,3,4,5) are verified by `npm run build:admin` (must stay green) + the manual browser check in each task. Do NOT invent a Vue mount test.
- Branch: `chore/settings-future-proofing`. Owner has an unrelated untracked file (`docs/superpowers/plans/2026-07-09-settings-page-future-proofing.md` — this very doc, before it's committed). Do **not** `git stash`. Stage only the specific files you edit (`git add <file>`), never `git add -A`.
- Owner preference: few files, no component sprawl. Do NOT create new components/files.
- One commit per task, using the commit message in the task.

## Shared Settings.vue prerequisite (applies to Tasks 4 & 5)
Both need `onUnmounted`. The vue import is currently (Settings.vue:697):
```js
import { ref, onMounted, computed } from 'vue';
```
Change it once (whichever of Task 4/5 you do first) to:
```js
import { ref, onMounted, onUnmounted, computed } from 'vue';
```
If it's already changed when the later task runs, leave it.

---

## Task 1 — S5: invalidate settings cache on icon upload/remove
**File:** `src/admin/pages/Settings.vue`. **Why:** `handleIconUpload` (:1092) and `handleIconRemove` (:1135) mutate the `store_icon` setting server-side but never call `invalidateSystemSettings()`, unlike `saveSettings` and `selectLanguage`. Low blast today (no admin view reads cached `store_icon`) but violates the cache contract — latent stale-icon bug. `invalidateSystemSettings` is already imported (Settings.vue:699).

**Edit 1 — upload success block (Settings.vue:1121-1123):**
```js
                if (data.success) {
                    storeIcon.value = data.store_icon;
                    showToast(t("Icon saved."));
```
Add `invalidateSystemSettings();` immediately after the `storeIcon.value = data.store_icon;` line:
```js
                if (data.success) {
                    storeIcon.value = data.store_icon;
                    invalidateSystemSettings();
                    showToast(t("Icon saved."));
```
**Edit 2 — remove success block (Settings.vue:1153-1155):**
```js
                if (data.success) {
                    storeIcon.value = null;
                    showToast(t("Icon removed."));
```
Add `invalidateSystemSettings();` immediately after `storeIcon.value = null;`:
```js
                if (data.success) {
                    storeIcon.value = null;
                    invalidateSystemSettings();
                    showToast(t("Icon removed."));
```
> **Coordination:** Task 5 also adds a line (`iconVersion.value++;`) right after these same two `storeIcon.value = …;` lines. If you do Task 5 first, add `invalidateSystemSettings();` after the `iconVersion.value++;` — order between the two added lines does not matter.

**Verify:** `npm run build:admin` green.
**Commit:** `chore(settings): invalidate settings cache after brand-icon change`

---

## Task 2 — i18n: add missing Arabic keys (Print Queue tab + printer capability)
**File:** `assets/js/admin/i18n.js`.
**IMPORTANT — English needs NOTHING.** `translateString` (i18n.js:1471) returns the original key verbatim when `language === 'en'` — it never reads a dictionary for English. There is **no `en` dictionary** (a dead one was removed in the bug-fix cleanup). **Add these keys to the `ar` object ONLY.** Do NOT create an `en` object.

Add the following keys at the end of the `ar` object literal, just before its closing `};` (the `ar` object currently ends around line 1245; it grows as you add keys). Grep each key in i18n.js first and skip any that already exist — a duplicate key in the object literal is a silent last-wins bug. (A grep of all keys below currently returns **no matches**, so all are safe, but verify per-key.)

Keys (provide accurate Arabic; if unsure of a term, STOP and ask the owner — do NOT leave the English value in the `ar` map):
- `'Print queue'`, `'Spooler'`, `'Printer status'`, `'Recent print jobs'`
- `'Capability'`, `'Checked'`, `'Job'`, `'State'`, `'Duration'`, `'Error'`, `'No print jobs found.'`
- `'Pending'`, `'Failed'`
- `'Status capability'`, `'Write only'`, `'ESC/POS status'`, `'SNMP status'`
- `'Acknowledged'`, `'Processing'`, `'Sent'`, `'Dead Letter'`, `'Paper Out'`, `'Cover Open'`, `'Jammed'`, `'Paper Low'`
- `'Reprint reason'`, `'Reprint queued.'`, `'Failed to queue reprint.'`

(These are consumed by `$t(...)` in Settings.vue: the Print Queue tab headers/labels, `$t(formatQueueLabel(...))` at the job/printer status badges, `$t(formatCapability(...))` at the capability badge, the printer-modal capability `<option>`s, and the reprint flow.)

**Verify:** `npm run build:admin` green. Grep i18n.js to confirm each key is present exactly once in `ar`. Manual: set admin language to Arabic, open the Print Queue tab + the printer modal → labels render Arabic, no stray English.
**Commit:** `chore(i18n): add missing Arabic keys for settings print-queue tab and printer capability`

---

## Task 3 — a11y: visible focus rings + tab semantics
**File:** `src/admin/pages/Settings.vue`. **Why:** several header controls use `focus:outline-none` / `outline-none` with no replacement ring → keyboard focus invisible.
**Changes:**
1. Tab buttons (Settings.vue:14, 17, 20, 23) and Refresh button (Settings.vue:42): each class string contains `focus:outline-none`. Replace that token with `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40` (replace-all is safe — these are the only `focus:outline-none` occurrences; do NOT touch inputs/selects that pair `outline-none` with `focus:ring-2`, those are already fine).
2. Language buttons (Settings.vue:116): the `:class` array's first string ends with `... gap-1 outline-none`. Change that `outline-none` token to `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40` (keep the existing `aria-pressed` on line 115).
3. Tab semantics: the tab-button container is Settings.vue:13 (`<div class="flex items-stretch gap-6 ...">`). Add `role="tablist"` to it. On each of the four tab buttons (:14,17,20,23) add `role="tab"` and `:aria-selected="activeTab === '…'"` matching that button's tab id (`'general'`, `'hardware'`, `'printQueue'`, `'orders'`).
**Verify:** `npm run build:admin` green. Manual: Tab-key through the header → visible ring on all four tabs + Refresh + language cards; AT announces tab role/selected.
**Commit:** `chore(a11y): visible focus rings + tab semantics on settings header`

---

## Task 4 — a11y: modal dialog semantics + Esc/backdrop dismissal
**File:** `src/admin/pages/Settings.vue` (printer modal backdrop Settings.vue:545, order-type modal backdrop Settings.vue:655). **Why:** neither modal has `role="dialog"`/`aria-modal`, Esc-to-close, or backdrop-click-close.
**Changes:**
1. **Backdrop click-to-close:** on the printer-modal backdrop div (:545) add `@click.self="showPrinterModal = false"`; on the order-type-modal backdrop div (:655) add `@click.self="showOrderTypeModal = false"`. (`.self` ensures only clicks on the dim area — not the panel — close it.)
2. **Dialog role:** on the inner panel div directly inside each backdrop (the `<div class="bg-card rounded-xl shadow-2xl ...">`) add `role="dialog" aria-modal="true"`.
3. **Esc-to-close (reliable window listener — do NOT use `@keydown.esc` on the backdrop; the backdrop isn't focused so it won't fire):** ensure `onUnmounted` is imported (see Shared prerequisite). Add, right after the existing `onMounted(() => loadData());` (Settings.vue:888):
```js
        const handleModalEsc = (e) => {
            if (e.key !== 'Escape') return;
            if (showPrinterModal.value) showPrinterModal.value = false;
            if (showOrderTypeModal.value) showOrderTypeModal.value = false;
        };
        onMounted(() => window.addEventListener('keydown', handleModalEsc));
        onUnmounted(() => window.removeEventListener('keydown', handleModalEsc));
```
(Multiple `onMounted`/`onUnmounted` calls are allowed in Vue — no need to merge with the existing `onMounted(() => loadData())`. If Task 5 also adds an `onUnmounted` for the toast timer, you may keep both or combine them.)
**Verify:** `npm run build:admin` green. Manual: open each modal → Esc closes it, clicking the dim backdrop closes it, X/Cancel still work, clicking inside the panel does NOT close it.
**Commit:** `chore(a11y): dialog roles + Esc/backdrop dismissal on settings modals`

---

## Task 5 — cosmetic FE polish (batch, one commit)
**File:** `src/admin/pages/Settings.vue`.
1. **Cache-bust once** (Settings.vue:86): `:src="storeIcon + '?v=' + Date.now()"` recomputes `Date.now()` on every render → the logo re-fetches on every keystroke in the store-name field. Add a ref `const iconVersion = ref(0);` (near the other icon refs, e.g. after `const isUploadingIcon = ref(false);`). Change the binding to `:src="storeIcon + '?v=' + iconVersion"`. Bump it on successful icon change: add `iconVersion.value++;` immediately after `storeIcon.value = data.store_icon;` (:1122) and after `storeIcon.value = null;` (:1154). *(Same two blocks as Task 1 — add both lines; order between them doesn't matter.)*
2. **Dead export:** remove `categories, ` from the return object (Settings.vue:1168 — `printers, categories, showPrinterModal, ...`). The bare `categories` ref is never used in the template (only `mainCategories`, `getSubcategories`, `getCategoryName`, `printerForm.categories`, and `p.categories` are — and those don't need the ref exported). Leave the `categories` ref declaration and its internal uses intact; only drop it from the `return {}`. (`spooler.socket_id` is also stored-but-unused — leave it, harmless.)
3. **`await` post-write reloads:** add `await` to the fire-and-forget `loadData()` calls in `deletePrinter` (Settings.vue:968), `savePrinter` (:1000), `saveOrderType` (:1073), `deleteOrderType` (:1085) — i.e. `await loadData();` — so a failed refresh doesn't leave a stale list under a success toast. (These are inside `async` functions already.)
4. **`selectLanguage` rollback** (Settings.vue:810-830): it flips the UI language before the server confirms and never rolls back. Capture the previous value and restore it on failure. Replace:
```js
        const selectLanguage = async (language) => {
            adminLanguage.value = language;
            setLanguage(language);

            try {
                const res = await fetch('api/system/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ admin_language: language })
                });
                const data = await res.json();
                if (data.success) {
                    invalidateSystemSettings();
                    showToast(t("Language updated."));
                } else {
                    await window.showAdminAlert(data.message || t("Failed to save settings."));
                }
            } catch (error) {
                await window.showAdminAlert(t("Network error."));
            }
        };
```
with:
```js
        const selectLanguage = async (language) => {
            const prev = adminLanguage.value;
            adminLanguage.value = language;
            setLanguage(language);

            try {
                const res = await fetch('api/system/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ admin_language: language })
                });
                const data = await res.json();
                if (data.success) {
                    invalidateSystemSettings();
                    showToast(t("Language updated."));
                } else {
                    setLanguage(prev);
                    adminLanguage.value = prev;
                    await window.showAdminAlert(data.message || t("Failed to save settings."));
                }
            } catch (error) {
                setLanguage(prev);
                adminLanguage.value = prev;
                await window.showAdminAlert(t("Network error."));
            }
        };
```
5. **Toast `aria-live`** (Settings.vue:6): add `role="status" aria-live="polite"` to the toast `<div v-if="toastMessage" ...>` so screen readers announce it.
6. **`toastTimeout` cleanup:** ensure `onUnmounted` is imported (Shared prerequisite). Add near the other lifecycle hooks:
```js
        onUnmounted(() => { if (toastTimeout) clearTimeout(toastTimeout); });
```
**Verify:** `npm run build:admin` green. Manual: type in the store-name field with a logo set → no logo flicker; delete a printer with the network offline → list stays consistent (no stale row under a success toast); switch language with the POST blocked → the UI language reverts.
**Commit:** `chore(settings): FE polish — cache-bust once, drop dead export, await reloads, language rollback, toast a11y`

---

## Task 6 — perf: memoize the printer-status schema check (one-time per process)
**File:** `backend/services/printerStatus.js` ONLY.
**Why:** `ensurePrinterStatusSchema` (printerStatus.js:19) runs `SHOW COLUMNS FROM printers` (+ idempotent `ALTER`s) on **every** call, and it is called per-request from `printers.js:46` (every `GET /printers`, reachable by any authed user) and from `listPrinterStatuses`/`updatePrinterDeviceStatus` and the spooler-status poll. The column set never changes at runtime, so the metadata query only needs to run once per process.

**Do NOT** move it to boot / `server.listen` and **do NOT** remove the per-request call: the `server.listen(...)` boot block (server.js:703) is **skipped under supertest** (`NODE_ENV==='test'`), and `server.js:497` is inside the spooler-poll loop, not boot — so the per-request call at `printers.js:46` is what guarantees the columns exist during tests. Removing it would break `printers`/`print-queue` tests. Instead, make the function itself a no-op after its first successful run.

**Change:** add a module-level flag and short-circuit. Replace (printerStatus.js:19-47):
```js
async function ensurePrinterStatusSchema(db) {
    const [columns] = await db.query('SHOW COLUMNS FROM printers');
    const names = new Set(columns.map(col => col.Field));
```
with:
```js
let printerStatusSchemaEnsured = false;

async function ensurePrinterStatusSchema(db) {
    if (printerStatusSchemaEnsured) return;
    const [columns] = await db.query('SHOW COLUMNS FROM printers');
    const names = new Set(columns.map(col => col.Field));
```
and add, at the very end of the function body (after the last `addPrinterColumnIfMissing(...)` await, before the closing `}` at :47):
```js
    printerStatusSchemaEnsured = true;
}
```
(The flag is set only after all columns are ensured, so a mid-way DB error leaves it false and the next call retries. Idempotent `ALTER`s remain guarded by `names.has`.)

**Verify:** `npx vitest run backend/tests/integration/printQueueHealthApi.test.js backend/tests/integration/adminRouting.test.js backend/tests/integration/printQueue.test.js` all green (printers list, health, and status all still work — first call ensures, later calls skip); then full `npx vitest run` green. No change to `server.js`, `printers.js`, or `printQueue.js`.
**Commit:** `perf(printers): memoize printer-status schema check to once per process`

---

## Ship order & verification
1. Do the Settings.vue tasks together to minimize churn: **Task 1 → Task 5 → Task 3 → Task 4** (all edit Settings.vue; anchors are stable code strings, but doing them in this order avoids the two of them fighting over the icon-success blocks — Task 1 and Task 5 both add a line there). Then **Task 2** (i18n.js) and **Task 6** (printerStatus.js) are independent.
2. After all six: `npx vitest run` full suite must be **958 + 0 new** (this plan adds no tests) with zero failures; `npm run build:admin` green.
3. `git log --oneline` → 6 new commits. `git status --short` → clean except this untracked plan doc (if not yet committed).
4. Do NOT push. Report to owner for review.

## Plan self-review (attacked before handoff — rev2)
- *Stale anchors:* every line number here was re-verified on master post-bug-fix-merge (Settings.vue handlers at 1092/1135, icon success at 1121/1153, Date.now at 86, categories export at 1168, loadData calls at 968/1000/1073/1085, selectLanguage at 810, modals at 545/655, import at 697). If a lower-model executor finds an anchor off by a line or two, it should match on the quoted code string, not the number.
- *Task 2 English trap:* the biggest correction from rev1 — there is NO `en` dictionary and English is identity fallback (i18n.js:1471). Adding an `en` object would reintroduce the exact dead code just removed. Arabic only.
- *Task 4 Esc reliability:* `@keydown.esc` on an unfocused backdrop div does NOT fire — hence the window listener. Verified the backdrop divs (545/655) are not focusable.
- *Task 6 test trap:* rev1 said "move to boot"; that breaks tests because `server.listen` is skipped under supertest and `server.js:497` is the poll loop, not boot. The flag-in-the-service variant keeps the per-request call (test-safe) while eliminating the repeated `SHOW COLUMNS`. Single file, no cross-file wiring.
- *Task 1/Task 5 collision:* both add a line after the two `storeIcon.value = …;` lines — called out explicitly in both tasks; order-independent.
- *Removed:* Task 7 (audit_events on settings/printers/order_types) — owner declined; do not implement.
- *No new tests:* all six are FE polish, i18n, or an internal no-op memoization with no new externally-observable behavior worth a test beyond the existing suite; the manual checks + existing 958 tests cover regressions.
