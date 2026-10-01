# Table merge discount protection — F1

The tables audit reproduced two bills totalling 7 JD becoming an 8 JD bill when
merging discarded the source's order discount. The current schema stores one
order-wide discount rule; keeping a target percentage can also extend that rule
to previously undiscounted source items.

## Change and scope

`processTableAction` now rejects a merge when either locked order has a positive
order-level discount, returning HTTP 409 and `ORDER_DISCOUNT_MERGE_CONFLICT`.
Both bills, their items and table assignments remain intact. The response tells
the operator to keep the bills separate. The guard reads one additional column
in each existing order query and runs before item copying, snapshot mutations,
source deletion, audit creation or realtime publication.

This implements the audit's explicit rejection option. It does not implement
discount allocation between combined bills. Even equal percentage rules remain
separate: rounding and subsequent edits need a defined allocation policy before
that operation is offered. Zero-valued rules and line discounts remain supported;
ordinary transfer and swap do not combine pricing and remain available.

No schema, dependency, settings or frontend changes. Existing service-charge
consolidation is preserved. F2 (saved tax being replaced by catalog tax) remains
open and must be corrected before exposing Combine Bills. Other audit findings
and the new grouping/item-transfer workflows remain separate tasks.

## Verification

Baseline checkout matched the audit's `b269ec850063dca47e3889d8d989a974e7ef31a4`.
Work is on `codex/tables-workflow-hardening` in the shared checkout.

- Before the production edit, eight discount-conflict regressions failed because
  the endpoint returned 200. Four compatibility cases passed.
- After the edit, all 12 initially added cases passed.
- The final focused integration run passed **39 tests across six files**, including
  all 13 F1 cases. Another file and 279 tests were skipped by the focused filter;
  this was not a rerun of the entire earlier 300-test audit.
- Fixed, percentage, mixed, source-only, target-only, both-discounted and 100%
  source discounts reject without changing complete order/item/table snapshots,
  creating merge audit rows or emitting updates.
- Retrying a rejected merge leaves both bills intact. Real API reads and payments
  then settle the original invoices for 3 JD and 4 JD, release both tables, and
  close a shift with starting cash 20 JD, expected cash 27 JD and counted cash
  27 JD. The first checkout test incorrectly inspected `expected_cash` before
  closing; that fixture assumption was corrected, with no shift production edit.
- Existing selected merge coverage verifies service-charge snapshot rehoming and
  settlement, bundle children, priced notes/modifiers, tax stamping, audit failure
  rollback, recipe identities and connection release.
- `git diff --check` passed.

The focused integration command:

```powershell
npm run test:isolated -- backend/tests/integration/tableMergeDiscount.test.js backend/tests/integration/tables.test.js backend/tests/integration/tableConnectionLifetime.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/recipeLedgerSplitsMerges.test.js backend/tests/integration/serviceChargeSnapshots.test.js -t 'merge|swaps discounted|transfers a discounted|can retry'
```

Each run created and removed its own generated loopback database. The current UI
does not expose a Combine Bills button, so this change was exercised through the
real HTTP/database workflow. Hostinger, customer data and physical printers were
not exercised. No push, PR, release gate or deployment is part of this step.

## Measurements

One warm-up and three measured samples per condition; each sample used newly
seeded bills. Node 24.16.0 / MariaDB 10.4.32 on this development machine. Statements
count connection `query`/`execute` calls, excluding transaction lifecycle calls;
returned rows are not an `EXPLAIN ANALYZE` count of storage-engine row visits.

| Source lines / operation | Statements before → after | Returned rows before → after | HTTP median before | After, first run | After, repeat |
|---|---:|---:|---:|---:|---:|
| 1 / ordinary merge | 24 → 24 | 14 → 14 | 9.43 ms | 45.15 ms | 9.74 ms |
| 100 / ordinary merge | 321 → 321 | 212 → 212 | 68.57 ms | 42.60 ms | 71.86 ms |
| 1 / discounted merge, now rejected | 24 → 6 | 14 → 6 | 10.56 ms | 3.13 ms | 2.94 ms |
| 100 / discounted merge, now rejected | 321 → 6 | 212 → 6 | 64.17 ms | 2.76 ms | 2.80 ms |

The ordinary path adds no round trips or returned rows. Timing variation was
large enough to require a repeat and prevents a strong latency claim. The
rejected path performs bounded reads before loading items; every measured action
returned its connection exactly once. This is a correctness boundary, not a
claim that successful merges are optimized: their per-line work is still F8.

Original audit and reproduction scripts:
`scratch/tables-audit-20260913/report.md`.
This step's raw RED/GREEN, final integration, before/after/repeat measurements
and measurement harness are under `scratch/tables-f1-20260913/` (gitignored).

Rollback is the task-sized F1 commit revert; it requires no schema rollback but
would reopen the discounted-merge defect. For a future release, verify a
discounted merge returns this conflict on a dedicated test instance and that
both original bills remain payable. Do not run destructive customer tests.
