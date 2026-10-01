# Expense cancellation: open and closed shifts

Implemented on `codex/schema-consolidation-audit`. The user approved both open and closed shifts, with counted cash preserved when canceling a closed-shift expense.

## Behavior

- Admins and programmers can cancel an active expense from any business day, including a custom date range. Cashiers cannot use the admin cancellation endpoint.
- The existing expense row remains with its original amount, note, creator and creation timestamp. Existing `status`, `canceled_by` and `canceled_at` record cancellation. Existing active-only expense reports exclude it from totals.
- An open drawer shift continues to calculate expected cash from active expenses. Its stored cash fields remain unchanged.
- A closed drawer shift adds only the canceled amount to frozen `expected_cash`, atomically with cancellation. Starting cash, counted `actual_cash`, closing time and other manual adjustments remain unchanged. Example: expected/count 44.75 plus cancellation of 5.25 becomes expected 50/count 44.75, variance -5.25.
- Outside-POS expense cancellation does not affect a shift. Zero expenses can be canceled.
- The service locks shift before expense, matching shift closing. Duplicate cancellation still returns 409 before any cash adjustment or print request.
- The transaction connection is released before notification and slip queuing. Notification or printer failure does not undo the committed correction. Existing cancellation-slip/reprint behavior is retained.
- The existing UI now exposes historical cancellation, identifies the expense in confirmation and explains the closed-shift cash effect. Pending clicks are suppressed; the mutation has a 30-second response/body deadline and is aborted on page exit. A lost reply causes one read-back, never an automatic POST retry. Confirmed canceled rows remain canceled if refreshing totals fails; a stalled report refresh does not keep other actions locked.

No new table, migration, setting, permission, dependency or generic service was introduced. The project performance/simplicity rule was separately saved in `AGENTS.md` (commit `1b1b3695`) and the requested durable memory note.

## Verification

Tests preceded the affected production edits. Backend RED reproduced ten failures caused by the old date/closed-shift restrictions; nine existing tests passed. After correcting a test setup-context mistake, frontend RED reproduced five behavior failures; confirmation dismissal already passed. A later focused regression reproduced the stalled-refresh button lock before that fix.

| Check | Result |
| --- | --- |
| Expenses integration, daily expense reports, expense metrics and service tests | 25 passed |
| Additional real DB cancellation/printing checks with pool capacity **1** | 2 passed, including zero amount |
| Cancellation UI, report localization and translation catalog | 15 passed |
| Built browser, English/Arabic at 1280/390 px, admin/programmer | All four combinations passed; 24 cancellations and 12 queued slips |
| Production admin build | Passed |
| Architecture generation and validation; diff whitespace validation | Passed |

Backend checks cover historical outside/open/closed expenses, actual cash 44.75 and 50, preserving an earlier expected-cash correction, rollback after an injected DB trigger failure, simultaneous duplicate cancellation, concurrent close/cancel requests, authority, shift-list/report variance and Z print payloads. Browser checks additionally exercise current-day and range controls, declined confirmation, disabled pending actions, a response lost **after a real commit**, and failed refresh after a successful response. Original expense/shift fields and each queued cancellation payload are checked against the database. The first browser run reached the print assertion but used the wrong fixture column name; this was corrected to `print_queue.payload`, and the complete matrix passed on the final build.

Focused commands and fixture boundaries are in `docs/agents/verification.md`. Raw results/screenshots are under ignored `scratch/expense-cancel-*`; the maintained browser harness is `scripts/reviews/expense-cancellation-browser.cjs`.

## Query/resource measurements

A separate generated loopback MariaDB experiment compared the previous service from `1b1b3695` with current source, alternating variants after warm-up. Forty measured operations per variant were rolled back, with no competing test workloads. Each history size also had the three target expenses.

| Cancellation path | Service queries, before → after | MariaDB rows read, before → after | Current median with 10,000 unrelated expense rows |
| --- | --- | --- | --- |
| Open shift | 5 → 5 | 8 → 8 | 0.821 ms |
| Outside POS | 4 → 4 | 7 → 7 | 0.765 ms |
| Closed shift | Previously rejected → 6 | Previously rejected → 9 | 1.166 ms |

Counts were identical with zero and 10,000 unrelated expense rows. The extra closed-shift query is the primary-key cash update; cancellation does not aggregate expense history. Baseline/current open-shift p95 was 1.197/1.248 ms, and outside p95 was 1.023/1.010 ms: these small local timings do not establish a speed improvement. The bounded work and one-connection completion are the useful results. Raw measurement: `scratch/expense-cancel-query-check.json`.

These are local fixture results. Service timings exclude HTTP, authorization, printing and commit I/O. No Hostinger/customer database, installed spooler or physical printer was exercised. No push, release or deployment was performed.
