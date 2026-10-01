# Table action intent and replay recovery — F4

A delayed transfer could move a replacement bill, because the request identified
only two tables. Repeating a successful swap reversed it. Locks protected current
rows but could not establish the operator's intended bills or an earlier commit.

## Change and boundaries

`POST /api/pos/tables/transfer` now requires `operation_id` and `expected_tables`.
The expectation contains every source/destination group row's numeric `id`,
nullable `current_order_id`, `status`, and nullable `parent_table_id`. The server
normalizes and compares the complete set under the existing globally sorted group
locks, before loading orders/items or changing bills. Missing/malformed/stale
expectations return 409 / `TABLE_ACTION_CONFLICT`; malformed operation keys return
400 / `TABLE_ACTION_KEY_REQUIRED`.

`table_action_operations` holds one durable receipt per successful action, bound
to the actor, canonical request hash and exact result. Its unique operation lock
precedes the existing table-group locks. Concurrent duplicates wait for that
transaction, then return its stored result without another table mutation, merge
audit, stock change or broadcast. Reusing the key for another actor or request
returns 409 / `TABLE_ACTION_KEY_CONFLICT`. Failed transactions roll back the
receipt reservation with the bill changes. Replay evidence survives subsequent
moves, deleted/settled bills and operational reset. There are deliberately no
foreign keys or automatic expiry that could erase replay protection.

`GET /api/pos/tables/transfer/:operationId` checks the caller's receipt using the
unique key and the corresponding transfer/merge grant. A different actor cannot
read it. An absent committed receipt can still represent an in-flight request;
clients must retain the original operation ID and expected state for a retry.

The floor snapshots the source group when the action sheet opens. POS-to-floor
transfer takes the selected bill identity into that snapshot. Live floor updates
cannot replace it with a new bill. The client persists the request before sending
it, uses the existing 15-second header/body deadline, and reconciles unknown
outcomes through GET. An explicit retry checks status first, then resends only
the identical request if no committed receipt is visible. Reload performs a read,
not a mutation. Per-operation, per-actor localStorage records prevent simultaneous
tabs from overwriting or erasing another pending identity.

The recovery banner works in English/Arabic and at mobile width. The live POS
draft follows its own moved invoice without receiving a newer content revision.
An explicit bill reopen retains the existing server-review behavior: it reloads
saved quantities. Returning to the kept POS draft preserves unsaved quantities.
The UI still exposes transfer to empty roots only. No Swap/Combine Bills UI,
occupied-table grouping, item transfer, relocation printing or ownership-policy
change is included. Join/disjoin were inspected and used to test stale group
expectations; their feature/authorization policies were not expanded.

F1's discounted-merge rejection, F2's saved merge tax, F3's save revision,
service-charge consolidation, bundle/recipe identities, sorted group locks and
post-commit connection release remain in place. Healing and partial voids retain
their existing live-tax policy. F8's per-line merge work remains open.

## Migration and deployment

New migration: `2026-09-13-table-action-recovery-v1`, immediately after
`2026-09-12-held-report-date-index-v1`.

- Ledger checksum: `00d70c67196cead73af1f41767ecac4157373047f4289a02d9c27cac2d0c2d92`.
- Normalized execution SQL SHA-256: `7ae3ede6e1e32769dc2927cab148501ad0dc5c5866def31229079eb274c1f2d5`.
- The normal SQL, automatic manifest, cumulative manual fallback, fresh baseline,
  baseline checksum manifest, installer bootstrap ledger, startup schema checks,
  fixture schema and migration-chain assertions are updated. The baseline stays
  schema-only; the installer supplies settings, permissions and ledger seeds.
- Exact-predecessor upgrade and repeat startup preserve table data/receipts.
  Missing predecessor, incorrect predecessor checksum and target checksum conflict
  fail closed. Removing the unique operation index fails schema validation.
- Operational reset intentionally retains the receipts; its regression verifies
  replay does not execute again after the bills are removed.
- A fresh generated database passed the real installer bootstrap and runtime
  schema validator, then startup skipped every already-applied migration. Account
  and grant statements were intercepted, so local DB accounts were untouched.
  The populated receipt lookup uses `uq_table_action_operation`, estimated one row.
  The two focused installer contract tests also passed. An initial probe imported
  only schema DDL without bootstrap seeds and correctly failed required settings/
  permission checks; the final probe exercises the complete installation path.

This changes the action API contract. A future release must apply the migration
and deliver the matching frontend; old callers cannot omit the new fields. Revert
the application commit for rollback while retaining the receipt table/data; a
revert would reopen F4. No push, PR, release or deployment was authorized or run.

## Verification

Starting point: clean `56797547839aab9144d3b5e998121d5f741b6aac` on the shared
`codex/tables-workflow-hardening` checkout. All database work used newly generated,
guarded loopback databases. No configured application/customer DB was used.

- Before production changes: **19 backend failures** and **five frontend
  failures** reproduced incorrect behavior/missing recovery. Subsequent targeted
  RED/GREEN checks covered incomplete successful bodies and separate tab records.
- Initial focused backend run: **67 passed across five files**, including 22 F4,
  all 13 F1, all 17 F2, ten lease tests and five migration tests.
- Compatibility selection: **78 passed**, with four fixture failures caused by
  taking the new expected-state fixture snapshot *inside* the existing pooled-read
  observer/failure injector. Moving that setup read before instrumentation fixed
  all four; their original one-broadcast-read and post-commit-success assertions
  passed unchanged. Existing selected cases cover whole-group lock ordering,
  children, finalized bills/splits, bundle corruption, modifier/recipe/physical
  stock identities, service-charge behavior and merge-audit rollback.
- Final recovery run: **34 passed** (30 F4 plus the four corrected broadcast/
  post-commit checks; 16 unrelated tests skipped). These include malformed keys/expectations, changed source and
  destination bills, source/destination join and disjoin, printed-state change,
  transfer/swap/merge replay, distinct-key stale replay, concurrent duplicates,
  actor/request binding, subsequent moves, complete group transfer, reset, and
  connection loss before/after commit. The resource run uses pool capacity one;
  earlier default-capacity runs exercised concurrent requests with separate leases.
- Frontend/session/migration-unit checks: **383 passed across ten files**. The
  historical migration-list fixture was extended for the new successor. Lifecycle
  fixtures now supply the recovery-read facade; the final run had no unhandled
  rejections. Build and architecture generation/check passed.

The real built browser flow passed in English and Arabic. It rejects A's delayed
transfer after B replaces it; performs a reviewed transfer; aborts a reply only
after a real commit while also blocking status reads; reloads; and resolves that
receipt without a second POST. A request aborted before server delivery survives
reload and succeeds with the identical ID/expectations on explicit retry. The
native response deadline preserves a three-item POS draft while the saved bill
still has two items. Returning to that draft, saving, reloading and paying yields
6 JD by card plus the separate 2 JD cash bill. Each shift closes at expected and
counted cash **22 JD**, starting from 20 JD. Each language consumes exactly four
stock units; table moves do not create food jobs or alter persisted lines/stock.
No uncaught page errors occurred. The recovery control was also exercised at
390-pixel width in both languages and screenshots were visually inspected.

Cleanup independently checked all 16 database names retained in the current logs:
none remained. The prefix-wide read found only the unrelated older order-type
audit fixture `posapp_review_recipe_p1_3b0c1cf71f91`, recorded in its own scratch
folder; it was preserved. No F4 Node process remained, and each browser harness
closed its browser/server and removed its own database. One repeated resource log
overwrote the earlier generated name; the prefix-wide read also covers that earlier
run. `.env` and `.env.test` were unchanged.

The extended browser harness initially made two timing/behavior assumptions:
explicit reopening would keep unsaved item quantities, and an HTTP save response
meant the UI's subsequent reload had completed. The harness now returns through
browser Back to the kept draft, waits for Save completion, then reloads. These
corrections did not change the existing reopen/save production policy. Initial
screenshots captured transitions; final captures disable animations and wait for
the loaded floor. Failed attempts remain in scratch evidence.

Counts above overlap and must not be added. The entire historical backend suite
and historical fixed-database migration suite were not rerun. No Hostinger,
physical printer, exhaustive failure interleaving or customer performance test
was performed.

## Isolated measurements

One warm-up plus five samples for each operation/group size, with newly seeded
bills. The two group sizes are standalone roots or 20 children per root (42 table
rows). The stale case first moves the original source away and creates a new
bill, dissolving its old children as the existing transfer policy requires.
Measurements ran alone. A first baseline overlapping a frontend test was discarded
and retained as `before-overlapped`; the table uses the isolated replacement.

| Children per root / action | Statements before → after | Rows returned before → after | HTTP median ms before → after | Connection-held median ms before → after |
|---|---:|---:|---:|---:|
| 0 / transfer | 8 → 11 | 3 → 4 | 6.92 → 5.98 | 2.99 → 3.75 |
| 0 / stale transfer | 8 → 3 | 3 → 3 | 4.05 → 3.90 | 2.02 → 1.74 |
| 0 / swap | 12 → 15 | 4 → 5 | 5.18 → 6.62 | 3.16 → 4.36 |
| 0 / swap replay | 12 → 2 | 4 → 1 | 4.10 → 2.56 | 2.33 → 1.24 |
| 20 / transfer | 8 → 11 | 43 → 44 | 6.10 → 7.52 | 2.74 → 3.99 |
| 20 / stale transfer | 8 → 3 | 23 → 23 | 4.05 → 2.83 | 1.88 → 1.29 |
| 20 / swap | 12 → 15 | 44 → 45 | 4.91 → 7.23 | 2.97 → 4.53 |
| 20 / swap replay | 12 → 2 | 44 → 1 | 4.52 → 3.24 | 2.31 → 1.89 |

The durability guarantee costs **three constant statements** for a new successful
action and one returned receipt row. Successful transfer/swap connection hold
times increased about 0.8–1.6 ms in these local samples; this is a reported cost,
not a no-regression claim. A committed replay performs two statements and returns
one receipt row regardless of group size. Stale intent is rejected before order
or item reads. Every measured attempt releases exactly once. Statement counts
exclude transaction lifecycle calls; returned rows are not storage-engine row
visits. Timings are local diagnostics, not customer latency or throughput proof.
Successful merge timing was not re-benchmarked in this step.

Raw logs, JSON, browser captures, fixtures and measurement scripts are in ignored
`scratch/tables-f4-20260913/`. Main commands:

```powershell
npm run test:isolated -- backend/tests/integration/tableActionRecovery.test.js backend/tests/integration/tableActionMigration.test.js backend/tests/integration/tableMergeDiscount.test.js backend/tests/integration/tableMergeTax.test.js backend/tests/integration/tableConnectionLifetime.test.js
node node_modules/vitest/vitest.mjs run --config scratch/tables-f4-20260913/frontend.config.mjs
node scratch/tables-f4-20260913/browser.cjs
npm run test:isolated -- --config scratch/tables-f4-20260913/vitest.config.mjs
```

The measurement command additionally requires `TABLE_F4_MEASUREMENT=before|after`;
the before run was collected before production edits. Final resource, compatibility
and cleanup commands/results are retained in the same folder. After F4's verified
commit, continue with **F5 only** in the next local task on this branch, using
`gpt-6-astra` / `xhigh`. The original audit and F1/F2/F3 reviews remain the serial
handoff for the later fixes and approved features.
