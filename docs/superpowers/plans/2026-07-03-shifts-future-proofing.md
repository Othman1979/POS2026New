# Shifts Page — Future-Proofing (Reuse & Tidy) Implementation Plan

> **For agentic workers:** use superpowers:subagent-driven-development (or superpowers:executing-plans) task-by-task. Steps use checkbox (`- [ ]`) syntax. **Run one Phase per agent dispatch; commit before the next.**
>
> **PREREQUISITE:** land `docs/superpowers/plans/2026-07-03-shifts-audit-fixes.md` FIRST. Phase 1 below (variance-zero helper) assumes the audit-fixes plan has NOT changed the variance markup, and the search rewrite there removes `filteredShifts` — if you see `filteredShifts` still present, the prerequisite is not merged; STOP.
>
> **Git hygiene:** do NOT `git stash` owner WIP. Stage only the files each phase names.

**Goal:** Reduce Shifts.vue's maintenance surface by adopting shared pieces the codebase already has — `src/utils/money.js` and `src/admin/components/ModalShell.vue` — fix the float-variance display via a central helper, tidy the hand-rolled filter popovers **in place** (owner: no new component), and close the mixed-language i18n gap. **Behavior-preserving except the variance-display fix (which is a correctness improvement) and the i18n label fix.**

**Scope target:** `src/admin/pages/Shifts.vue`, `src/utils/money.js`, `assets/js/admin/i18n.js`. Reuse-only — no new components.

**Tech Stack:** Vue 3 (`setup()`), Vite 6, Tailwind v4; Vitest.

## Global Constraints
- No new files. Owner prefers few files / no component sprawl.
- Verify each phase with `npm run build:admin` (green) + the described manual check.
- Do not touch backend or sales math.

---

## Phase 1 — Reuse shared `formatMoney` + fix variance float compare (C1)

**Why (evidence):** `Shifts.vue:832` defines a local `formatMoney` byte-identical to the exported `src/utils/money.js:4`. Separately, backend variance is a raw float subtraction (`backend/routes/admin/shifts.js:196` `parseFloat(actual) - parseFloat(expected)`), and the template compares it with `== 0` / `> 0` / `< 0` (`Shifts.vue:219-221, 293-298, 424-426`). A sub-cent float residue (e.g. chained `.10 - .05` DECIMAL casts) makes a truly-balanced drawer render `+0.00 JD` in amber instead of "Perfect".

**Files:** Modify `src/utils/money.js`, `src/admin/pages/Shifts.vue`.

- [ ] **Step 1:** In `src/utils/money.js`, add below `formatMoney`:
```javascript
// A drawer variance within half a cent is a perfect count — treats sub-cent float
// residue from DECIMAL subtraction as zero so "Perfect" shows instead of "+0.00 JD".
export const varianceIsZero = (v) => Math.abs(Number(v) || 0) < 0.005;
```
- [ ] **Step 2:** In `Shifts.vue`, delete the local `formatMoney` (`:832`) and import both from the shared util. Add to the import block near `:466`:
```javascript
import { formatMoney, varianceIsZero } from '../../utils/money.js';
```
Add `formatMoney` back into the `return {}` (it already is returned; keep it exposed to the template). `varianceIsZero` must also be added to the `return {}` object so the template can call it.
- [ ] **Step 3:** Replace the three variance blocks. In each of the desktop row (`:219`), mobile card (`:293`), and modal (`:424`) blocks, change the `v-if="...variance == 0"` guard to `varianceIsZero(...variance)` and the following `v-else-if="...variance > 0"` stays as-is (a positive residue is now caught by the first branch). Exact edits:
  - `:219` `shift.variance == 0` → `varianceIsZero(shift.variance)`
  - `:293` `shift.variance == 0` → `varianceIsZero(shift.variance)`
  - `:424` `selectedShift?.variance == 0` → `varianceIsZero(selectedShift?.variance)`
- [ ] **Step 4 (verify):** `npm run build:admin` green. Manual: a shift whose actual == expected shows "Perfect" (green ✓), not "+0.00 JD".

**Risk:** none to money math (display-only). `varianceIsZero(undefined)` → `true`; but the active-shift branch renders "Pending…" before the variance branches (`:218`, `:292`), and the modal variance block is inside `v-if="!selectedShift?.is_active"` (`:417`), so undefined never reaches it.
**Commit:** `refactor(shifts): reuse shared formatMoney + central varianceIsZero (fixes +0.00 amber)`

---

## Phase 2 — Adopt `ModalShell` for both modals (F1)

**Why (evidence):** the Open-Shift modal (`Shifts.vue:317-351`) and View/Audit modal (`:354-458`) hand-roll the fixed-overlay + card + header + close-button chrome. `src/admin/components/ModalShell.vue` already provides that plus Escape-to-close, backdrop-click-close, `role="dialog"`/`aria-modal`, and is the pattern TableMapEditor + Inventory adopted. Adopting it gives Escape/backdrop/a11y parity and deletes duplicated chrome.

**Files:** Modify `src/admin/pages/Shifts.vue`.

- [ ] **Step 1:** Register the component. Convert the default export to include a `components` option. Add the import near `:466`:
```javascript
import ModalShell from '../components/ModalShell.vue';
```
and add to the export object (it currently is `export default { setup() {...} }`):
```javascript
export default {
    components: { ModalShell },
    setup() { ... }
```
- [ ] **Step 2 (Open-Shift modal):** Replace the outer overlay+card+header (`:317` through the header close-button `:322`) with:
```html
            <ModalShell :show="showOpenModal" :title="$t('Open New Shift')" width-class="max-w-sm" @close="showOpenModal = false">
```
Keep the `<form @submit.prevent="submitOpenShift" ...>` and its inner content unchanged. Replace the two old closing `</div></div>` that closed the card+overlay (`:350-351`) with `</ModalShell>`. Delete the now-duplicated hand-rolled header block (the `<div class="px-6 py-4 border-b ...">...</div>` at `:319-322`) since ModalShell renders the title + close button. **Verify the `<form>` becomes the direct default-slot child** so the footer/button layout is preserved.
- [ ] **Step 3 (View/Audit modal):** Same transform for `:354`. The old header (`:357-360`) contains ONLY the dynamic title (`{{ $t('Shift Audit') }} #id`) plus a close button — there is **no** status pill in the header (the active/closed pill lives in the body's first row at `:364-377`, leave it there). Because the title is dynamic markup (not a plain string), use the `#header` slot for just the `<h3>`:
```html
            <ModalShell :show="showModal" width-class="max-w-lg" @close="showModal = false">
                <template #header>
                    <h3 class="font-display font-semibold text-foreground text-base tracking-tight">{{ $t('Shift Audit') }} <span data-no-i18n>#{{ selectedShift?.id }}</span></h3>
                </template>
                <div class="p-6 overflow-y-auto premium-scroll space-y-5">
                  <!-- existing body (:362-456) unchanged -->
                </div>
            </ModalShell>
```
ModalShell's header row already renders its own close button, so drop the old header's `<button>` (`:359`). Do NOT move or duplicate the body status pill.
- [ ] **Step 4 (verify):** `npm run build:admin` green. Manual for BOTH modals: opens, Escape closes, backdrop-click closes, X closes, focus/scroll intact, submit/print/force-close still work. ModalShell max height is `max-h-[90vh]`; the audit modal previously used `max-h-[95vh]` — confirm content still scrolls (the inner body already has `overflow-y-auto`).

**Risk:** ModalShell z-index is `z-[100]`; the old modals used `z-[60]`. Higher is fine (still above page). The Escape listener uses `immediate: true` (already fixed in ModalShell) so it works even though `showModal`/`showOpenModal` toggle after mount.
**Commit:** `refactor(shifts): adopt ModalShell for open + audit modals`

---

## Phase 3 — Tidy filter popovers in place (F2 / C3)

**Why (evidence):** the cashier (`Shifts.vue:45-66`) and status (`:69-92`) filters hand-roll the backdrop-div + absolute-panel pattern. Owner decision: clean **in place**, no shared component. Gaps: toggle buttons lack `aria-expanded`; `clearAllFilters` (`:651`) leaves open dropdowns open; two redundant "Reset" controls.

**Files:** Modify `src/admin/pages/Shifts.vue`.

- [ ] **Step 1 (aria-expanded):** On the cashier toggle button (`:46`) and status toggle button (`:70`), add `:aria-expanded="showCashierFilter"` / `:aria-expanded="showStatusFilter"` respectively, and `aria-haspopup="menu"`.
- [ ] **Step 2 (close dropdowns on clear):** In `clearAllFilters` (`:651`), add before the closing brace:
```javascript
            showCashierFilter.value = false;
            showStatusFilter.value = false;
```
- [ ] **Step 3 (mutual-exclusion already present):** the status toggle sets `showCashierFilter = false` and vice-versa (`:46`, `:70`) — leave as-is; it matches Inventory. No change.
- [ ] **Step 4 (de-dupe Reset — low-risk cosmetic):** there are two Reset affordances: the toolbar button (`:30-33`) and the active-filters-row button (`:158-160`). Keep BOTH (they serve different contexts — toolbar always-visible vs. contextual) but confirm both call `clearAllFilters`. No code change unless the owner asks to remove one; document the decision here rather than churn markup.
- [ ] **Step 5 (verify):** `npm run build:admin` green. Manual: open cashier filter → `aria-expanded="true"` in DOM; hit Reset while a dropdown is open → dropdown closes and filters clear.

**Risk:** none — additive attributes + two state resets.
**Commit:** `a11y(shifts): aria-expanded on filter toggles + close popovers on reset`

---

## Phase 4 — Fix mixed-language print labels (C2)

**Why (evidence):** `Shifts.vue:124` `$t('Print X جرد')` and `:128` `$t('Print Z جرد')` bake Arabic ("جرد") into the English i18n **key**. Those exact keys are **absent** from `assets/js/admin/i18n.js` (grep confirmed), so `$t` returns the key verbatim — the Arabic UI shows the literal string `Print X جرد`, and the English UI shows a stray Arabic word. Every other print label here is a clean key with an AR translation (`i18n.js:518-525`).

**Files:** Modify `src/admin/pages/Shifts.vue`, `assets/js/admin/i18n.js`.

- [ ] **Step 1:** In `Shifts.vue`, change the two labels:
  - `:124` `{{ $t('Print X جرد') }}` → `{{ $t('Print X Report') }}`
  - `:128` `? ... : $t('Print Z جرد')` → `: $t('Print Z Report')` (leave the `Reprint ${serial_label}` branch untouched)
- [ ] **Step 2:** In `assets/js/admin/i18n.js`, in the Arabic map next to the existing shift keys (near `:518`), add:
```javascript
    'Print X Report': 'طباعة جرد X',
    'Print Z Report': 'طباعة جرد Z',
```
**Git hygiene:** `i18n.js` is a shared file that may hold owner WIP keys — stage ONLY these two added lines (`git add -p assets/js/admin/i18n.js`), never the whole file blindly.
- [ ] **Step 3 (verify):** `npm run build:admin` green. Manual: EN UI shows "Print X Report"/"Print Z Report"; switch to AR → shows "طباعة جرد X"/"طباعة جرد Z".

**Risk:** none. If a duplicate-key lint exists (the Inventory audit hit UTF-8 BOM / dup-key issues), confirm no pre-existing `'Print X Report'` key before adding.
**Commit:** `i18n(shifts): clean X/Z print label keys + Arabic translations`

---

## Post-plan verification
- `npm run build:admin` — green.
- `npx vitest run backend/tests/` — green (no frontend test regressions; these are display/markup changes).
- Manual full pass: both modals (Escape/backdrop), variance "Perfect" display, filter a11y + reset-closes-dropdown, EN/AR print labels.

## Explicitly deferred
- Extracting a shared `FilterPopover` component (owner chose inline-only) — revisit only if a 3rd page needs it.
- Any backend change (lives in the audit-fixes plan).
