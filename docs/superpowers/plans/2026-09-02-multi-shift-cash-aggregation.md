# Multi-shift Cash Aggregation Implementation Plan

> **For agentic workers:** Execute task-by-task on `codex/cash-aggregation-per-shift`, in the normal checkout, with each RED/GREEN cycle committed before continuing.

**Goal:** Stop adding drawer balance snapshots across shifts, attribute variance to the closing business window exactly once, and show truthful per-shift reconciliation on every browser and V2 spooler report.

**Architecture:** Sales, refunds, collections, expenses, variances, and counts remain aggregatable movements. `starting_cash`, `expected_cash`, and `actual_cash` remain per-shift snapshots and are never summed. New payloads carry authoritative server aggregates; renderers calculate a compatibility fallback from `shifts[]` only for old stored X/Z payloads.

**Tech stack:** Node.js/CommonJS, Express, MySQL, Vue 3, Vitest, Vue SSR tests, V2 spooler Node tests.

## Global constraints

- Starting point: `master` at `552d516f31538c91700adcbf4a5b4a7772067e5a`. If it moved, inspect and re-anchor; never reset newer work.
- No schema change, migration, new dependency, drawer identity, stored-document rewrite, deployment, merge, push, or installer rebuild.
- `report-html.js` and `v2/artifact-renderer.js` are both current V2 report surfaces.
- Never sum `starting_cash`, `expected_cash`, `actual_cash`, or `previous_shift_closing_cash`.
- Never infer drawer ownership from user, browser, station, printer, or matching balances.
- Never print a combined drawer-balance row, column, total, or dash placeholder.
- Show a drawer equation only when `shift.within_window === true`; missing flags on stale payloads are not permission to show it.
- Attribute variance using `closed_at >= start AND closed_at < end`.
- If any included shift is open, or any closed-in-window shift lacks an actual count, aggregate variance money is `null`.
- Preserve `cash_status.state`: `no_shifts | in_progress | review | balanced`.
- Focused tests per task; one combined affected verification at the end.

## Exact payload contracts

Daily `cash_status`:

```js
{
  state,
  open_shifts,
  closed_shifts,          // closed_at inside the requested window
  closed_outside_window, // included through activity/opening, closed elsewhere
  uncounted_shifts,       // closed inside, actual_cash or variance unavailable
  shifts_needing_review,
  net_variance,           // null while open/uncounted exists
  shortage_total,        // absolute sum of negative variances, or null
  overage_total           // sum of positive variances, or null
}
```

Remove `expected_cash`, `actual_cash`, and `variance` from this aggregate.

Audit `cash_reconciliation`:

```js
{
  cash_expenses_total,
  open_shifts,
  closed_shifts,
  closed_outside_window,
  uncounted_shifts,
  shifts_needing_review,
  net_variance_total,
  shortage_total,
  overage_total
}
```

Remove `starting_cash_total`, `expected_cash_total`, `actual_cash_total`, and `variance_total`. Each audit shift row gains boolean `closed_in_window` and `within_window`. Preserve a closed row's `actual_cash` and `variance` as null when no actual count exists.

Compatibility: presence of own property `cash_reconciliation.net_variance_total` identifies a new server payload. Old payloads fall back to summarizing `shifts[]`; their legacy aggregate keys are ignored and never rewritten.

---

### Task 1: Correct the daily producer and print contract

**Files:**
- Modify `backend/services/dailyReportBuilder.js:113-197`
- Modify `backend/tests/integration/dailyReportsSummary.test.js`
- Modify `backend/tests/integration/dailyReportsAdversarial.test.js:244-267`
- Modify `backend/tests/unit/dailyReportPrintContract.test.js`

- [ ] Add RED cases using existing fixtures:
  - Sequential shifts `100 -> 400/400`, `400 -> 700/700`: `summary.cash_collected=600`; no aggregate balance keys; two closed shifts; all variance totals zero.
  - Opposite differences `+4/-4`: `state='review'`, two reviews, net zero, shortage four, overage four.
  - One open shift: `state='in_progress'`; all three aggregate money fields null.
  - One closed shift explicitly updated to `actual_cash=NULL`: `uncounted_shifts=1`, `state='in_progress'`, all aggregate money fields null.
  - Cross-day shift opened `2026-07-01 22:00`, closed `2026-07-02 08:00`, variance `-3`, activity on both days: day 1 has `closed_outside_window=1`, day 2 owns `-3`, and a two-day range includes `-3` once.

Core assertions:

```js
expect(result.cash_status).toEqual({
  state: 'balanced', open_shifts: 0, closed_shifts: 2,
  closed_outside_window: 0, uncounted_shifts: 0,
  shifts_needing_review: 0, net_variance: 0,
  shortage_total: 0, overage_total: 0,
});
for (const key of ['expected_cash', 'actual_cash', 'variance']) {
  expect(result.cash_status).not.toHaveProperty(key);
}
```

- [ ] Run RED:

```powershell
npx vitest run backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsAdversarial.test.js backend/tests/unit/dailyReportPrintContract.test.js
```

- [ ] Extend the shift SELECT with `closed_at` and this MySQL flag:

```sql
CASE WHEN status='closed' AND closed_at >= ? AND closed_at < ? THEN 1 ELSE 0 END AS closed_in_window
```

Bind the query in this exact placeholder order:

```js
[
  period.business_start_at, period.business_end_at, // SELECT flag
  period.business_end_at,                           // opened_at < end
  period.business_start_at,                         // opened_at >= start
  period.business_start_at,                         // closed_at >= start
  period.business_start_at, period.business_end_at, // orders
  period.business_start_at, period.business_end_at, // refunds
  period.business_start_at, period.business_end_at, // collections
]
```

- [ ] Reduce rows with these classifications:

```js
const inside = s.status === 'closed' && Number(s.closed_in_window) === 1;
const outside = s.status === 'closed' && !inside;
const uncounted = inside && (s.actual_cash == null || s.expected_cash == null);
const variance = uncounted ? null : roundMoney(Number(s.actual_cash) - Number(s.expected_cash));
```

Only counted inside rows contribute to variance. `state='in_progress'` when open or uncounted exists; otherwise no closed-inside rows means `no_shifts`, reviewed rows mean `review`, else `balanced`. Update the print-contract fixture to the exact new shape; no sanitizer production change is expected.

- [ ] Run GREEN and commit:

```powershell
npx vitest run backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsAdversarial.test.js backend/tests/unit/dailyReportPrintContract.test.js
git add backend/services/dailyReportBuilder.js backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsAdversarial.test.js backend/tests/unit/dailyReportPrintContract.test.js
git commit -m "fix(reports): attribute daily variance by closing window"
```

---

### Task 2: Correct the audit producer, including close-only shifts

**Files:**
- Modify `backend/services/auditReportBuilder.js:86-200,292-353`
- Modify `backend/tests/integration/auditReports.test.js`

- [ ] Add RED cases for:
  - The sequential pair plus a 50 JD drawer expense: no balance totals, `cash_expenses_total=50`, both rows within-window.
  - A cross-day shift with activity on both dates: activity day reports outside-window; closing day owns variance.
  - A cross-day shift with no order/refund/void/expense/collection on its closing day: it must still appear on the closing day. This specifically proves `closed_at` is in the selector.
  - A closed row with `actual_cash=NULL`: row actual/variance null, `uncounted_shifts=1`, aggregate money null.
  - One open row: open count one and aggregate money null.

Assert the exact contract and absence of all four legacy totals. Freeze the JS clock before comparing two independently built hashes because `generated_at` is hashed:

```js
vi.useFakeTimers();
vi.setSystemTime(new Date('2026-07-03T12:00:00.000Z'));
try {
  const first = await buildAuditReportPayload(pool, options);
  const second = await buildAuditReportPayload(pool, options);
  expect(second.payload_hash).toBe(first.payload_hash);
} finally {
  vi.useRealTimers();
}
```

- [ ] Run RED:

```powershell
npx vitest run backend/tests/integration/auditReports.test.js
```

- [ ] Add these derived columns:

```sql
CASE WHEN s.status='closed' AND s.closed_at >= ? AND s.closed_at < ? THEN 1 ELSE 0 END AS closed_in_window,
CASE WHEN s.opened_at >= ? AND s.status='closed' AND s.closed_at >= ? AND s.closed_at < ? THEN 1 ELSE 0 END AS within_window
```

- [ ] Add this separate predicate inside the existing parenthesized selector; the derived column alone does not include the row:

```sql
OR (s.closed_at >= ? AND s.closed_at < ?)
```

Bind all placeholders in this exact SQL order:

```js
[
  range.start, range.end,               // closed_in_window
  range.start, range.start, range.end,  // within_window
  range.end,                            // opened_at < end
  range.start,                          // opened_at >= start
  range.start, range.end,               // closed_at inclusion
  range.start, range.end,               // orders
  range.start, range.end,               // refunds
  range.start, range.end,               // voided orders
  range.start, range.end,               // expenses
  range.start, range.end,               // subscription collections
]
```

Map flags with `Boolean(Number(value))` so JSON contains booleans. Preserve null explicitly instead of passing it through `toMoney`, which currently turns null into zero:

```js
const actualCash = shift.status === 'closed' && shift.actual_cash != null
  ? toMoney(shift.actual_cash)
  : null;
const variance = actualCash === null || shift.expected_cash == null
  ? null
  : toMoney(actualCash - Number(shift.expected_cash));
```

Build aggregates only from closed-in-window rows; count other closed included rows separately. `cash_expenses_total` remains a range-scoped movement.

- [ ] Run GREEN and commit:

```powershell
npx vitest run backend/tests/integration/auditReports.test.js
git add backend/services/auditReportBuilder.js backend/tests/integration/auditReports.test.js
git commit -m "fix(audit): reconcile shifts by their closing window"
```

---

### Task 3: Add deterministic renderer compatibility helpers

**Files:**
- Modify `src/print/auditReportPresentation.js`
- Create `src/print/__tests__/auditReportPresentation.spec.js`

- [ ] Add RED tests proving:

```js
expect(summarizeAuditShifts([
  { status: 'closed', closed_in_window: true, actual_cash: 104, variance: 4 },
  { status: 'closed', closed_in_window: true, actual_cash: 96, variance: -4 },
])).toMatchObject({
  closed: 2, closedOutsideWindow: 0, open: 0, uncounted: 0,
  needsReview: 2, netVariance: 0, shortage: 4, overage: 4,
});
expect(summarizeAuditShifts([
  { status: 'closed', closed_in_window: false, actual_cash: 96, variance: -4 },
])).toMatchObject({ closed: 0, closedOutsideWindow: 1, netVariance: 0 });
expect(summarizeAuditShifts([
  { status: 'closed', actual_cash: 96, variance: -4 },
])).toMatchObject({ closed: 1, closedOutsideWindow: 0, netVariance: -4 });
expect(summarizeAuditShifts([
  { status: 'closed', closed_in_window: true, actual_cash: null, variance: null },
])).toMatchObject({ uncounted: 1, netVariance: null, shortage: null, overage: null });
expect(shiftShowsEquation({ within_window: true })).toBe(true);
expect(shiftShowsEquation({ within_window: false })).toBe(false);
expect(shiftShowsEquation({})).toBe(false);
```

Test `reconciliationFrom(payload)` with and without new server fields. With them, server values win. Without them, fallback summarizes rows. Compare the two camelCase results for parity; do not import this ESM frontend file into CommonJS backend tests and do not claim shared implementation.

- [ ] Run RED:

```powershell
npx vitest run src/print/__tests__/auditReportPresentation.spec.js
```

- [ ] Implement exact rules:

```js
const belongsToWindow = s => s?.status === 'closed' && s.closed_in_window !== false;
const isOutsideWindow = s => s?.status === 'closed' && s.closed_in_window === false;
export const shiftShowsEquation = s => s?.within_window === true;
```

Missing `closed_in_window` counts as inside for stale verdict compatibility; missing `within_window` never shows an equation. `total` is every row, `closed` is closed-in-window (including uncounted), `closedOutsideWindow` is closed elsewhere, and `open` is every non-closed row. Detect new server data with `hasOwnProperty('net_variance_total')`, map snake_case to camelCase, and derive `total = closed + closedOutsideWindow + open` and `balanced = Math.max(0, closed - uncounted - needsReview)`.

Verdict order is: open -> incomplete; uncounted -> incomplete; needs-review -> review; `closed === 0` -> no shift settled in this window; otherwise balanced. A payload containing only outside-window closed rows must never be called balanced. Preserve the existing natural Arabic review wording. Net zero with `+4/-4` remains review.

- [ ] Run GREEN and commit:

```powershell
npx vitest run src/print/__tests__/auditReportPresentation.spec.js
git add src/print/auditReportPresentation.js src/print/__tests__/auditReportPresentation.spec.js
git commit -m "feat(print): summarize shift reconciliation by window"
```

---

### Task 4: Replace daily summary balance totals on browser surfaces

**Files:**
- Modify `src/admin/pages/ReportsSummary.vue:244-263`
- Modify `src/admin/pages/__tests__/dailyReportPayloads.spec.js`
- Create `src/admin/pages/__tests__/reportsSummaryCashStatus.spec.js`
- Modify `src/shared/i18n/ar.json`
- Modify `src/print/PrintReceiptApp.vue:220-233`
- Modify `src/print/AdminReportA4.vue` daily-summary field list
- Modify `src/print/__tests__/adminReportA4Rendering.spec.js`
- Modify `src/print/__tests__/reportPrintBranches.spec.js`

- [ ] RED: update the payload fixture to the exact new object. Create a source-contract test for `ReportsSummary.vue`—the payload test does not render that component. Assert all five new count/money fields are referenced and no `cash_status.expected_cash`, `.actual_cash`, or `.variance` reference remains.

- [ ] RED: add an A4 SSR case for `+4/-4`. Output contains `إجمالي العجز`, `إجمالي الزيادة`, `صافي فرق المناوبات`; it does not contain combined expected/actual labels. Extend the thermal source-contract slice with the same field-removal assertions.

- [ ] Run RED:

```powershell
npx vitest run src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/reportsSummaryCashStatus.spec.js src/print/__tests__/adminReportA4Rendering.spec.js src/print/__tests__/reportPrintBranches.spec.js
```

- [ ] On all browser surfaces, show shortage/overage/net only when `net_variance !== null`; otherwise show counts and “reconciliation in progress” with no partial money. Show open and uncounted counts separately.

- [ ] Fix cross-day wording without changing the enum: when `state='no_shifts'` and `closed_outside_window>0`, display “No shifts settled in this report window” / `لا توجد مناوبات أُغلقت ضمن فترة التقرير`, plus “N shifts settled on another business day” / `أُغلقت {count} مناوبة في يوم عمل آخر`.

- [ ] Remove the three old fields from `CASH_STATUS_FIELDS`; retain all sales, tax, tender, expense, refund, and platform sections.

- [ ] Run GREEN and commit:

```powershell
npx vitest run src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/reportsSummaryCashStatus.spec.js src/print/__tests__/adminReportA4Rendering.spec.js src/print/__tests__/reportPrintBranches.spec.js
git add src/admin/pages/ReportsSummary.vue src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/reportsSummaryCashStatus.spec.js src/shared/i18n/ar.json src/print/PrintReceiptApp.vue src/print/AdminReportA4.vue src/print/__tests__/adminReportA4Rendering.spec.js src/print/__tests__/reportPrintBranches.spec.js
git commit -m "fix(reports): present daily cash results per shift"
```

---

### Task 5: Use one browser audit presentation for X, Z, and period

**Files:**
- Modify `src/print/AdminReportA4.vue:39-56,82-92,137-185,508-628`
- Modify `src/print/PrintReceiptApp.vue:473-535`
- Modify `src/print/__tests__/adminReportA4Rendering.spec.js`
- Modify `src/print/__tests__/reportPrintBranches.spec.js`

- [ ] RED A4 SSR cases:
  - Sequential pair renders two `رصيد الافتتاح` labels and never aggregate `1,100.00` or `500.00`.
  - `+4/-4` renders `مناوبتان تحتاجان مراجعة`, never `الصندوق متوازن`.
  - `within_window:false` renders `نشاط ضمن نافذة التقرير` and `أرصدة المناوبة عند الإغلاق`, but no `= النقد المتوقع` equation.
  - `within_window:true` renders the equation.
  - A stale row without flags renders per-shift balances, ignores legacy totals, and shows no equation.
  - No period expected/actual/variance aggregate columns or dash placeholders survive.

- [ ] RED thermal source test: one per-shift audit branch serves period and non-period; all legacy `cash_reconciliation.*_total` expressions are absent.

- [ ] Run RED:

```powershell
npx vitest run src/print/__tests__/adminReportA4Rendering.spec.js src/print/__tests__/reportPrintBranches.spec.js
```

- [ ] Remove `isPerCashierAudit`, `auditCashRows`, the period compact shift table, and every aggregate balance verdict. Route verdicts through `reconciliationFrom(data)` and render per-shift blocks for all audit types.

- [ ] Every shift shows range-scoped activity under `نشاط ضمن نافذة التقرير` and its own starting/expected/actual/variance under `أرصدة المناوبة عند الإغلاق`. Show arithmetic operators and equality only through `shiftShowsEquation(rawShift)`.

- [ ] Apply the same rule to thermal. Delete period aggregate blocks instead of retaining empty columns.

- [ ] Run GREEN and commit:

```powershell
npx vitest run src/print/__tests__/adminReportA4Rendering.spec.js src/print/__tests__/reportPrintBranches.spec.js
git add src/print/AdminReportA4.vue src/print/PrintReceiptApp.vue src/print/__tests__/adminReportA4Rendering.spec.js src/print/__tests__/reportPrintBranches.spec.js
git commit -m "fix(print): render audit balances per shift"
```

---

### Task 6: Align both current V2 spooler renderers

**Files:**
- Modify `pos-spooler-printer/report-html.js:35-90,199-235`
- Modify `pos-spooler-printer/v2/artifact-renderer.js:175-265`
- Modify `pos-spooler-printer/tests/report-html.test.js`
- Modify `pos-spooler-printer/tests/v2-artifact-renderer.test.js`

- [ ] RED `report-html.test.js`: new daily shape renders Shortage/Overage/Net Variance, never Expected/Actual Cash; incomplete state renders no variance money.

- [ ] RED artifact test: legacy aggregate sentinels `1100` and `500` plus two shifts. HTML excludes sentinels, includes both shift identities/balances, and includes the equation only for the row with `within_window:true`.

- [ ] Run RED:

```powershell
node pos-spooler-printer/tests/report-html.test.js
node pos-spooler-printer/tests/v2-artifact-renderer.test.js
```

- [ ] Replace daily labels/lines in `report-html.js` with the Task 4 contract, including truthful incomplete and cross-day wording.

- [ ] In `v2/artifact-renderer.js`, delete aggregate `جرد الصندوق` balances. Render review counts and complete shortage/overage/net aggregates, then per-shift blocks. Gate equations on `s.within_window === true`. Missing flags render balances without equations. Keep escaping all user-provided text.

- [ ] Do not import frontend modules into the packaged spooler; keep the stale fallback local and minimal.

- [ ] Run GREEN and commit:

```powershell
node pos-spooler-printer/tests/report-html.test.js
node pos-spooler-printer/tests/v2-artifact-renderer.test.js
git add pos-spooler-printer/report-html.js pos-spooler-printer/v2/artifact-renderer.js pos-spooler-printer/tests/report-html.test.js pos-spooler-printer/tests/v2-artifact-renderer.test.js
git commit -m "fix(spooler): drop combined drawer balances from V2 reports"
```

---

### Task 7: Prove legacy evidence safety and document the invariant

**Files:**
- Modify `backend/tests/integration/auditReports.test.js`
- Modify `docs/architecture.json`
- Regenerate `docs/architecture.html`
- Modify `docs/superpowers/specs/2026-09-01-shift-audit-per-cashier-design.md`

- [ ] Insert an old-shape X/Z document using the existing test pattern and a known hash. Read `payload_json` and `payload_hash` back from MySQL before reprinting, because MySQL's JSON storage may normalize the originally inserted string. Reprint it and assert response hash is unchanged, `copy_label='REPRINT'`, and a second DB read returns the same `payload_json` and `payload_hash` as the first read. Browser and spooler rendering of old payloads is already proved by Tasks 5 and 6; do not pretend this backend test renders Vue.

- [ ] Run the integration file:

```powershell
npx vitest run backend/tests/integration/auditReports.test.js
```

- [ ] Update the existing daily-report architecture edge to: `shift rows closed in the report window drive cash_status; per-shift drawer balances are never summed`.

- [ ] Add invariant: `Starting, expected, and actual cash are per-shift snapshots. Reports may aggregate movements, counts, shortages, overages, and signed variance, but never drawer balances.`

- [ ] Append to the 2026-09-01 design: the equation is gated by `within_window === true`; period now shares the X/Z per-shift presentation.

- [ ] Regenerate, check, and commit:

```powershell
npm run architecture
npm run architecture:check
git add backend/tests/integration/auditReports.test.js docs/architecture.json docs/architecture.html docs/superpowers/specs/2026-09-01-shift-audit-per-cashier-design.md
git commit -m "docs(reports): record per-shift drawer balance invariants"
```

---

## Final verification gate

```powershell
npx vitest run backend/tests/integration/dailyReportsSummary.test.js backend/tests/integration/dailyReportsAdversarial.test.js backend/tests/integration/auditReports.test.js backend/tests/unit/dailyReportPrintContract.test.js src/admin/pages/__tests__/dailyReportPayloads.spec.js src/admin/pages/__tests__/reportsSummaryCashStatus.spec.js src/print/__tests__/auditReportPresentation.spec.js src/print/__tests__/adminReportA4Rendering.spec.js src/print/__tests__/reportPrintBranches.spec.js
npm --prefix pos-spooler-printer test
npm run architecture:check
npm run build:admin
git status --short
```

Required result:

- All commands pass and the worktree is clean.
- Sequential `100 -> 400`, `400 -> 700` never renders 1,100 JD as a drawer balance.
- Opposite shortages/overages never cancel into a balanced verdict.
- A close-only cross-day shift is present and attributed on its closing business day.
- Open or uncounted shifts never expose partial aggregate variance money.
- No browser or V2 spooler surface renders combined starting/expected/actual cash.
- Old X/Z JSON and hashes remain unchanged while all renderers ignore legacy aggregate totals.

## Out of scope

- Register/drawer identity and cash transfers.
- Sequential-balance heuristics.
- Backfills or stored-document rewriting.
- Changing the `shifts.actual_cash` schema default.
- Changes to sales, tax, refund, expense, subscription, platform, or checkout accounting.
