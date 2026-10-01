# Shift-opening drawer reference implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current business day's latest trustworthy closed-shift drawer count in the POS opening modal without carrying it into the new shift.

**Architecture:** Extend the existing authenticated self-shift check with one nullable, server-derived amount. Keep the amount in a separate Vue ref and render it as read-only text; `startingCashInput` remains independent.

**Tech Stack:** Express, mysql2, Vue 3, Vitest, Supertest.

## Global constraints

- No schema change or migration.
- Reveal only `previous_shift_closing_cash`; never reveal prior cashier, shift ID, time, sales, expected cash, or variance.
- Use `getBusinessDayRange(getBusinessDate())` for the configured business day.
- Suppress the reference when the actor lacks `shift.open`, their own shift is open, any other shift is open, or no qualifying close exists.
- Never prefill, overwrite, or validate `starting_cash` from the reference.

---

### Task 1: Add the server-owned opening reference

**Files:**
- Modify: `backend/routes/auth.js`
- Test: `backend/tests/integration/shift.test.js`

**Interfaces:**
- Produces: `GET /api/auth/shifts?action=check&user_id=<self>` returns `{ success, shift, previous_shift_closing_cash: number|null }`.

- [ ] **Step 1: Write failing integration tests**

Add tests proving: the latest of multiple current-business-day closed shifts wins; yesterday's close returns `null`; a user without `shift.open` receives `null`; and any open shift suppresses the reference. Assert the response has no prior shift metadata fields.

- [ ] **Step 2: Run RED**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "opening drawer reference"`

Expected: FAIL because `previous_shift_closing_cash` is absent.

- [ ] **Step 3: Implement the minimum query**

Import `getBusinessDate` and `getBusinessDayRange`. After the existing own-open-shift lookup, initialize the reference to `null`. Only when there is no own shift and `canOpenShift(req.user)` is true, execute one parameterized query equivalent to:

```sql
SELECT s.actual_cash
FROM shifts s
WHERE s.status='closed'
  AND s.actual_cash IS NOT NULL
  AND s.closed_at >= ? AND s.closed_at < ?
  AND NOT EXISTS (SELECT 1 FROM shifts active WHERE active.status='open')
ORDER BY s.closed_at DESC, s.id DESC
LIMIT 1
```

Return `Number(row.actual_cash)` when present, otherwise `null`. Do not add fields from the selected row.

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run backend/tests/integration/shift.test.js -t "opening drawer reference"`

Expected: all matching tests pass.

- [ ] **Step 5: Commit**

```text
feat(shifts): expose safe opening drawer reference
```

### Task 2: Render the reference without carrying it forward

**Files:**
- Modify: `src/pos/useAuth.js`
- Modify: `src/components/PosTerminal.vue`
- Modify: `src/shared/i18n/ar.json`
- Modify: `src/utils/useAuthHydration.spec.js`
- Modify: `src/components/__tests__/posTerminalOwnership.spec.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

**Interfaces:**
- Consumes: `previous_shift_closing_cash: number|null` from Task 1.
- Produces: `previousShiftClosingCash` Vue ref, separate from `startingCashInput`.

- [ ] **Step 1: Write failing frontend tests**

Extend hydration coverage with a response containing `shift: null` and `previous_shift_closing_cash: 72.5`; assert `previousShiftClosingCash.value === 72.5` and `startingCashInput.value === 0`. Add a component contract assertion for a conditional read-only reference block and both translation keys.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/utils/useAuthHydration.spec.js src/components/__tests__/posTerminalOwnership.spec.js`

Expected: FAIL because the reference ref and modal block do not exist.

- [ ] **Step 3: Implement minimal hydration and UI**

Add module-scope `const previousShiftClosingCash = ref(null)`. During `checkActiveShift`, keep it `null` for an active shift; otherwise accept only a finite, non-negative numeric response value. Return the ref from `useAuth` and destructure it in `PosTerminal.vue`.

Render a conditional non-input block above the existing starting-cash label with:

```text
Previous shift drawer closing balance
For reference only. Count the drawer and enter the current amount.
```

Display the amount with two decimals and `JD`. Do not bind it to the input and do not modify `openMyShift`.

- [ ] **Step 4: Document the invariant and run GREEN**

Record that the reference is current-business-day, permission-gated, metadata-free, suppressed while any shift is open, and never opening-cash authority. Run `npm run architecture`, the two frontend tests above, `npm run architecture:check`, and the Task 1 integration tests.

- [ ] **Step 5: Commit**

```text
feat(pos): show previous drawer close at shift opening
```
