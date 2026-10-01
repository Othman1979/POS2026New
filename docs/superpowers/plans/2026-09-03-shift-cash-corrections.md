# Shift Cash Corrections Implementation Plan

> **For agentic workers:** Execute task-by-task on `codex/shift-cash-corrections`, in the normal checkout, with each RED/GREEN cycle committed before continuing. Do not execute until the owner says go.

**Goal:** Make the second cashier's starting cash default to the previous closing count, catch the "counted only my sales" mistake at close, explain a shift's variance on the admin Shifts page when its fingerprint says starting cash or closing count was mistyped, and let admins correct exactly those two numbers on closed shifts.

**Architecture:** No drawer identity, no cash-drop recording, no reasons. The count-in is the truth; the difference between one close and the next open is *shown*, never explained. Sales, refunds, collections, and expenses are never edited. Closed-shift `expected_cash` stays a frozen number: a starting-cash correction moves it by the same delta, it is never recomputed from orders. Hints are derived at read time from neighbouring shifts and never stored.

**Tech stack:** Node.js/CommonJS, Express, MariaDB, Vue 3, Vitest (backend integration + frontend specs).

## Evidence base

- Owner decisions (this thread): default = previous close, overridable with no explanation; corrections only from the admin Shifts page by admin/programmer; cashier sales untouchable; concurrent cashiers dropping cash into one another's box is handled on paper, not by the system.
- Vendor research: every product tracks cash per session and lets the count-in override a configured/prior float ([Simphony/Aloha/Toast](7c901c71-24e4-4430-8c70-9ebdb411413d), [Odoo/Square/Lightspeed/Loyverse](3db177bd-0300-4c4a-9f2c-e97f5d3de6b6)).
- Adversarial audit of this plan's first draft ([Grok](deca6711-e08f-4ab8-9d39-4be94f6d3d87)): rejected the `actual < starting` guard (false positive under refunds/expenses, e.g. start 100, sales 50, refunds 80, expenses 20 → expected 50, honest count 50), rejected the `next_shift_count` hint (dead once prefill exists; can wipe a real shortage), required neighbour lookup over all shifts rather than the current page, required cents comparisons, and required `403` for non-admin before the row lock. All adopted below.
- Fingerprint experiment (synthetic chains incl. refunds, expenses, cent rounding, and zero start): the two retained advisory fingerprints fire on their target mistakes and stay silent on correct chains, owner removals, and ordinary shortages. Known accepted ambiguity: a theft equal to the opening float can look like "count excluded opening", so hints never mutate data. There is deliberately no `closed_without_count` fingerprint: the schema stores `0.00` both when the drawer was genuinely empty and in historical rows that lack a distinct count marker.

## Current-code anchors (verify by symbol; lines drift)

| Concern | Location |
|---|---|
| Shift check: reference + suggestion | `backend/routes/auth.js` `action === 'check'` (~263-318) |
| Shift open/close/update_cash | `backend/routes/auth.js` (~396-617); `isAdminUser` at ~42 |
| Admin list + frozen variance | `backend/routes/admin/shifts.js` GET (~120-238) |
| Admin open form default 0 | `src/admin/pages/Shifts.vue` `openShiftForm` (~354, ~520) |
| Admin edit pencil (open only) | `src/admin/pages/Shifts.vue` (~400-409, `updateStartingCash` ~889) |
| POS open dialog | `src/components/PosTerminal.vue` (~179-209); `src/pos/useAuth.js` (~80-101) |
| POS close | `src/components/pos/ShiftReportModal.vue` (~37-50); `useAuth.closeShiftAndPrint` (~218) |
| Closed-shift payload (frozen) | `backend/services/shiftReportPayload.js` (~112-116) |
| Money helpers | `src/utils/money.js` (`varianceIsZero`, `formatMoney`), backend `roundMoney` |
| Existing tests | `backend/tests/integration/shift.test.js`; `src/utils/useAuthHydration.spec.js`; `src/admin/pages/__tests__/shiftsPage.*.spec.js`; `src/components/__tests__/posTerminalOwnership.spec.js` |

## Global constraints

- Start from current `origin/master`; re-anchor if it moved.
- No schema change, migration, new dependency, new route, drawer/terminal identity, cash-drop or reason capture, stored-document rewrite, deployment, merge, or push.
- Never recompute a closed shift's `expected_cash` from orders. Never touch `orders`, `refunds`, `expenses`, `subscription_collections`, or `final_*` columns from any correction path.
- All money comparisons in integer cents via `const cents = v => Math.round(Number(v) * 100)` (mysql2 returns `DECIMAL` columns as strings; `Number()` first) or via `varianceIsZero`/`roundMoney`; no raw float `<`/`===`.
- Hints are advisory: nothing auto-applies; every apply goes through the admin edit UI and the existing audit row.
- Static `$t` keys only; no new dynamic-count phrases in `src/shared/i18n/runtime.js`. Put numbers beside strings with `data-no-i18n`.
- Focused tests per task; one combined affected-tests run at the end.

## Contracts

`GET /api/auth/shifts?action=check` (unchanged shape, new precedence):

```js
{
  shift,
  previous_shift_closing_cash,  // unchanged: today's latest counted close, null while any shift is open
  suggested_starting_cash       // NEW precedence:
                                //  1. previous_shift_closing_cash when not null
                                //  2. configured first_shift_starting_cash when no shift has closed today
                                //  3. null otherwise (client shows 0, existing behaviour)
}
```

`GET /api/admin/shifts` rows gain:

```js
{
  ...existing,
  drawer_change_since_previous_close, // starting_cash − prev.actual_cash; null when no prev or another shift was open at opened_at
  variance_hint                       // null | { kind, suggested: { starting_cash } | { actual_cash } }
  // kind ∈ 'starting_cash_mismatch' | 'count_excluded_opening'
  // `suggested` is shaped like the update_cash body so "Apply" spreads it into the editor without a per-kind branch
}
```

`PUT /api/auth/shifts?action=update_cash` body `{ shift_id, starting_cash?, actual_cash? }` (at least one):

- `403` unless `isAdminUser(req.user)`. Check this immediately on entering `update_cash`, before body validation or any DB read, so callers cannot probe validation or shift existence.
- Open shift: `starting_cash` only; `actual_cash` → `400`.
- Closed shift: either or both. `starting_cash` delta `d` applies `expected_cash = ROUND(expected_cash + d, 2)`. `actual_cash` is set as given, rounded to cents.
- One `shift_cash_edited` audit row with `oldValue`/`newValue` containing every changed field, same transaction.
- Emits `shifts_changed { shift_id, action: 'edit' }` and invalidates the dashboard cache.

## Task 1: Default starting cash to the previous close

**Files:** `backend/routes/auth.js` (check action); `src/components/PosTerminal.vue` copy; `src/shared/i18n/ar.json`; `src/admin/pages/Shifts.vue` open form; `src/admin/pages/__tests__/shiftsCashCorrections.spec.js` (new; the single UI spec file for Tasks 1, 3, 4).

RED (`backend/tests/integration/shift.test.js`, describe `opening drawer reference`):
- `suggests the previous close over the configured float after a same-day close` — seed configured float 100, close a shift at 32.50, check → `previous_shift_closing_cash: 32.5`, `suggested_starting_cash: 32.5`. Update the existing `returns only the latest closing count…` expectation from `null` to `32.5`.
- `keeps the configured float for first-of-day opens while another shift is open` — existing `:78-98` stays green.
- `suggests nothing while any shift is open after a same-day close` — one closed at 32.50, one open → both fields `null`.
- `admin check for a selected cashier returns the same suggestion` — admin cookie, `user_id` of a cashier.
- Admin UI guard (`shiftsCashCorrections.spec.js`, three cases): (a) select A, select B, resolve A late → B's suggestion stands; (b) select A, select B, select A again, resolve the *first* A response late → it is discarded, only the latest A response applies; (c) select A, close the modal, reopen, select A, resolve the pre-close A response late → discarded; (d) type `75` while a request is in flight → `75` stands.

GREEN:
- In the check action, after computing `previousShiftClosingCash`: `if (previousShiftClosingCash !== null) suggestedStartingCash = previousShiftClosingCash;` keep the configured-float branch for `has_closed_shift = 0`.
- `PosTerminal.vue`: replace the reference paragraph with `Starting cash is prefilled from the previous closing count. Count the drawer and correct it if different.` (new key + Arabic). Keep the amount box.
- `Shifts.vue` open form: keep a module-level `let openShiftCheckSeq = 0`. On cashier select and on modal open: `const seq = ++openShiftCheckSeq`, reset the amount to `0`, clear `openShiftCashEdited`, then `await` `GET api/auth/shifts?action=check&user_id=…`. After the await, apply `suggested_starting_cash ?? 0` only if `seq === openShiftCheckSeq` and `openShiftCashEdited` is false. Set the flag from the amount input's `@input`. The counter is required: an id-only check fails for A→B→A and for close-modal→reopen→A, where a stale A response sees A selected again.
- Update `posTerminalOwnership.spec.js` catalogue assertion to the new key; keep the old keys in `ar.json` until unused, then delete.

Commit: `feat(shifts): default starting cash to the previous closing count`

## Task 2: Close-count guard for "counted only my sales"

**Files:** `src/pos/useAuth.js` `closeShiftAndPrint`; `src/components/pos/ShiftReportModal.vue` label/input; `src/shared/i18n/ar.json`; `src/utils/useAuthHydration.spec.js` (new `describe('closeShiftAndPrint count guard')`; it already stubs fetch/sessionStorage and imports `useAuth`).

Rule (from the fingerprint, not `actual < starting`): first require `actualCashInput` to be non-empty and `Number(actualCashInput)` to be finite and nonnegative. Only then convert each operand to integer cents *before* any arithmetic: `startingCents = cents(zReportData.starting_cash)`, `expectedCents = cents(zReportData.expected_cash)`, `actualCents = cents(actualCashInput)`; confirm when `startingCents > 0 && actualCents === expectedCents − startingCents`. Never `cents(e − s)`: that subtracts floats first. Invalid input skips this advisory check and continues to the existing server validation. The cashier never sees `e` (blind close stays), although the client already has it in the payload.

RED (`src/utils/useAuthHydration.spec.js`):
- `asks for confirmation when the count equals sales-only` — start 500, expected 900, typed 400 → `window.showPosConfirm` called once; declining aborts the PUT.
- `does not ask when the drawer is legitimately below the opening cash` — start 100, expected 50 (refunds/expenses), typed 50 → no confirm, PUT sent.
- `does not ask when starting cash is zero` — start 0, expected 400, typed 400.
- `does not misdiagnose blank or negative input as sales-only` — no confirmation; the request reaches existing server validation and fails normally.
- `matches on cents, not floats` — start 100.10, expected 250.30, typed 150.20 → confirm (150.20 vs 250.30 − 100.10 would fail under float subtraction).

GREEN: guarded confirmation before the PUT; message key `You counted only this shift's sales. Count everything in the drawer, including the opening cash. Continue anyway?`. Keep it as static text because `window.showPosConfirm` accepts a string, not HTML. Relabel the count field to `Total cash in drawer now (including opening cash)` and add `min="0"` to the input.

Commit: `fix(pos): confirm a closing count that omits the opening cash`

## Task 3: Admin-only corrections on closed shifts

**Files:** `backend/routes/auth.js` `update_cash`; `backend/tests/integration/shift.test.js`; `src/admin/pages/Shifts.vue` edit UI; `src/admin/pages/__tests__/shiftsCashCorrections.spec.js`; `src/shared/i18n/ar.json`.

RED (`shift.test.js`, describe `update_cash hardening + audit`):
- Rewrite `:859-874`: cashier on closed shift → `403`; admin on closed shift → `200`.
- Rewrite `:876-895`: cashier on own open empty shift → `403` (self-edit removed; cashiers set starting cash at open only).
- Rewrite every other cashier `update_cash` expectation to the same authorization contract: missing `shift_id` (`~849`), invalid cash (`~674`), and edit-after-orders (`~400`) all return `403`. Add an admin invalid-body case that still proves malformed authorized input returns `400`.
- Keep `:897-921` admin-after-sales on an open shift (`200`).
- New `closed starting_cash +20 moves expected_cash +20 and leaves orders untouched` — seed closed shift start 80, expected 130, actual 150; PUT start 100 → expected 150, variance 0 in `GET /api/admin/shifts`, order rows unchanged, `shiftReportPayload` shows 100/150/150.
- New `closed actual_cash only leaves expected_cash unchanged`.
- New `open shift rejects actual_cash with 400`.
- New `audit row carries every mutated field and emits shifts_changed`: a starting-cash edit includes old/new `starting_cash` and old/new `expected_cash`; an actual-cash edit includes old/new `actual_cash`. Assert the emit through the harness doubles `global.__mockTo__` (`'staff'`) and `global.__mockEmit__` (`'shifts_changed'`, payload) from `backend/tests/setup.js`; there is no `req.io` object exposed to tests.
- New `rounds 10.999 to 11.00`.
- Admin UI guard (`shiftsCashCorrections.spec.js`): (a) closed shift: editor shows both fields, Save awaits one confirmation, then one PUT with only the fields whose cent values changed; (b) open shift: the actual-cash input is not rendered, PUT carries `starting_cash` only; (c) changing nothing and pressing Save sends no request and exits edit mode; (d) editing only `actual_cash` on a closed shift sends a body without `starting_cash`.

GREEN:
- `if (!isAdminUser(req.user)) return sendError(res, 403, …)` as the first `update_cash` branch statement. Remove `canAccessShift` from this branch: the admin gate establishes authority and the transactional `SELECT ... FOR UPDATE` supplies the single existence/status read and `404`.
- Accept `starting_cash`/`actual_cash`; validate present ones; round to cents.
- Lock and read `status`, `starting_cash`, `expected_cash`, and `actual_cash`. Closed: `UPDATE shifts SET starting_cash = COALESCE(?, starting_cash), expected_cash = ROUND(expected_cash + ?, 2), actual_cash = COALESCE(?, actual_cash) WHERE id = ?` with `d = roundedNewStart − oldStart` or 0.
- Open: starting only; no `expected_cash` change (stays 0 until close).
- Audit old/new objects contain each field actually mutated, including the adjusted `expected_cash` for a starting-cash correction. Then `invalidateDashboardCache()` + `req.io.to('staff').emit('shifts_changed', …)` after commit.
- `Shifts.vue`: show the pencil for closed shifts too. Replace the starting-cash-only inline block with one edit mode (`isEditingCash`) holding `newStartingCash` always and `newActualCash` only `v-if="!selectedShift.is_active"` (hidden, not disabled, so an open shift can never send `actual_cash` and hit the server `400`), both `type="number" min="0"` (`shiftsPage.quality.spec.js` T5), one Save, one Cancel. Save builds the body from changed fields only: include `starting_cash` iff `cents(newStartingCash) !== cents(selectedShift.starting_cash)`, include `actual_cash` iff the shift is closed and `cents(newActualCash) !== cents(selectedShift.actual_cash)`; if the body is empty, exit edit mode without a request. This keeps audit rows to the fields the admin actually changed. Closed-shift Save asks one confirm first: `This changes a closed shift's drawer numbers. Sales are not affected. Continue?`

Commit: `feat(shifts): let admins correct starting and counted cash on closed shifts`

## Task 4: Variance hints and drawer-change on the admin Shifts page

**Files:** `backend/routes/admin/shifts.js` GET; `src/admin/pages/Shifts.vue` list row + detail; `src/shared/i18n/ar.json`.

Neighbour lookup (all shifts, not the page): for each closed row, one query over the page's ids:

```sql
SELECT s.id,
  (SELECT p.actual_cash FROM shifts p
     WHERE p.id <> s.id AND p.status='closed' AND p.closed_at <= s.opened_at
     ORDER BY p.closed_at DESC, p.id DESC LIMIT 1) AS prev_actual_cash,
  EXISTS (SELECT 1 FROM shifts o
     WHERE o.id <> s.id AND o.opened_at <= s.opened_at
       AND (o.closed_at IS NULL OR o.closed_at > s.opened_at)) AS overlapped_at_open
FROM shifts s WHERE s.id IN (?)
```

Derivation. Every DB value is a `DECIMAL` string from mysql2 (`"400.00" + "500.00"` is `"400.00500.00"`; `100.00 − 100.10` is `-0.0999…`), so convert every operand first and derive every output from cents:

```js
const startingCents = cents(shift.starting_cash);
const expectedCents = cents(shift.expected_cash);
const actualCents = cents(shift.actual_cash);
const prevCents = row.prev_actual_cash == null ? null : cents(row.prev_actual_cash);
const hasPrev = prevCents !== null && !row.overlapped_at_open;
const v = actualCents - expectedCents;

let variance_hint = null;
if (v !== 0) {
  if (hasPrev && v === prevCents - startingCents)
    variance_hint = { kind: 'starting_cash_mismatch', suggested: { starting_cash: prevCents / 100 } };
  else if (startingCents > 0 && v === -startingCents)
    variance_hint = { kind: 'count_excluded_opening', suggested: { actual_cash: (actualCents + startingCents) / 100 } };
}
const drawer_change_since_previous_close = hasPrev ? (startingCents - prevCents) / 100 : null;
```

Never infer whether a zero actual value was counted: the current schema has no separate count marker. Both outputs are JS numbers, never strings.

RED (`shift.test.js`, new describe `admin shift variance hints`):
- `flags a mistyped starting cash and suggests the previous close` — prev actual 100; start 80, expected 130, actual 150 → kind `starting_cash_mismatch`, `suggested.starting_cash` `toBe(100)`, `drawer_change_since_previous_close` `toBe(-20)`.
- `flags a count that omitted the opening cash` — start 500, expected 900, actual 400 → `count_excluded_opening`, `suggested.actual_cash` strictly equals the number `900` (`toBe(900)`, not `"900.00"` or `"400.00500.00"`).
- `derives decimals from cents, not float or string arithmetic` — prev actual 100.10, start 100.00, expected 350.00, actual 350.10 → `starting_cash_mismatch`, `suggested.starting_cash` `toBe(100.1)`, `drawer_change_since_previous_close` `toBe(-0.1)`; and start 100.10, expected 250.30, actual 150.20 → `count_excluded_opening`, `suggested.actual_cash` `toBe(250.3)`.
- `stays silent when no fingerprint matches` — one `it.each` table: ordinary shortage (500/900/880), correct chain (500/900/900), starting zero (0/400/380), zero actual with sales (100/150/0; no invented no-count state). All → `variance_hint: null`.
- `omits prev-based fields when another shift overlapped the open` — two concurrent shifts.
- `finds the previous close outside the current page and date filter` — prev yesterday, list filtered to today.
- `does not select the same shift as its own predecessor` — one shift whose second-resolution `opened_at` equals `closed_at` → previous-based fields remain null.
- `applies a suggestion through update_cash and the hint disappears`.
- Admin UI guard (`shiftsCashCorrections.spec.js`): clicking `Apply suggestion` opens the editor with `suggested` spread into the fields and sends no request. No spec for "unknown kinds are not rendered": the backend contract pins the kinds.

GREEN:
- Compute in the list loop after `variance`. Attach `variance_hint` and `drawer_change_since_previous_close`.
- `Shifts.vue`: row badge with static text per kind (`Starting cash may be wrong: previous shift closed with a different count`, `Closing count may have omitted the opening cash`), numbers beside as `data-no-i18n`; detail modal shows `Change since previous close` with the signed amount; `Apply suggestion` sets `isEditingCash = true` and assigns `suggested.starting_cash ?? current` / `suggested.actual_cash ?? current` into the Task 3 editor. No auto-apply.

Commit: `feat(shifts): explain likely starting-cash and count mistakes on the Shifts page`

## Task 5: Combined verification and docs

- Run: `node node_modules/vitest/vitest.mjs run backend/tests/integration/shift.test.js src/utils/useAuthHydration.spec.js src/admin/pages/__tests__ src/components/__tests__/posTerminalOwnership.spec.js src/shared/__tests__/i18nCatalog.spec.js`.
- `docs/architecture.json`: update the existing shift-opening invariant to include the previous counted close as the next sequential suggestion and its suppression while any shift remains open. Rewrite the existing per-shift cash-snapshot invariant so it states: closed-shift `expected_cash` is frozen at close, except that an audited admin starting-cash correction moves it by the same delta and never recomputes it from orders; actual-cash corrections alter only the count and variance. Record that variance hints are derived from neighbouring shifts at read time and never stored. Update the `auth-shifts-route` description and the shift flow with the admin correction boundary; do not add a second contradictory invariant. Then run `npm run architecture && npm run architecture:check`.
- Delete superseded `ar.json` keys once no source references them (`i18nCatalog.spec.js` guards unused keys).

Commit: `docs(shifts): record frozen-expected and derived-hint invariants`

## Explicitly out of scope

- Drawer/terminal identity, shared-drawer join question, cash drops, reasons, manager PIN on corrections, admin force-close changes, blind-count permission changes (cashier close is already blind), `zreport` live-vs-frozen split at `auth.js` `action === 'zreport'` (pre-existing; note only).
