# Table merge saved-tax preservation — F2

Two saved 5 JD items at 16% tax totalled 11.60 JD. Changing catalog tax to
8% and combining their bills changed the total to 10.80 JD. Merge copied the
saved line tax fields correctly, then `recomputeOrderTotals` fetched catalog
products and replaced both rates and categories during recalculation.

## Change and boundaries

Merge now calls `recomputeOrderTotals` with the internal `preserveSavedTax`
option. The existing calculator and line-stamping helpers use each persisted
line's own rate/category when no catalog product is supplied. This preserves
different saved tax rates for the same product, modifier snapshots, line
discounts, bundle parent tax, and zero-priced persisted bundle children. It also
avoids an unnecessary catalog query; it adds no saved-line matching abstraction.

The merge checks both locked orders' tax registration and accounting contexts
before item copying, snapshot mutation, deletion, audit insertion, or realtime
publication. Different registrations return HTTP 409 with
`TAX_REGISTRATION_CONTEXT_MISMATCH`. Different historical accounting modes
return HTTP 409 with `TAX_ACCOUNTING_CONTEXT_MISMATCH`. The existing exemption
conflict remains unchanged. Rejections tell the operator to keep bills separate.

New orders use normal accounting. `tax_inclusive_pricing` is a receipt display
setting. Different receipt preferences are allowed, while compatible historical
inclusive-accounting orders retain their saved prices. For the merge option,
a nullable historical accounting flag follows the normal-accounting fallback
already used by table save; current receipt settings do not reinterpret it.

All three callers were inspected. **Catalog healing and partial voids retain
their existing live-tax behavior**, which `taxSourceOfTruth.test.js` explicitly
requires. The new option is enabled only by merge. A later catalog-healing or
partial-void operation can therefore still re-tax an open merged bill under that
existing policy; this change does not promise permanent tax freezing after those
actions. Ordinary saved-table reload/save and payment preserve the merged lines.

Service-charge consolidation remains its separate existing rule. F1 still
rejects any positive order-wide discount; discounted Combine Bills is not
implemented. No schema, dependencies, frontend, permissions, deployment kit, or
architecture ownership boundaries changed. Per-line merge work remains F8.

## Verification

The starting checkout was clean at F1 commit
`e0c14006a65478da7a12db39b2888aea86e0f598`, on
`codex/tables-workflow-hardening` in the shared local project.

- Before production changes, the initial run had 12 behavior failures, one
  incomplete bundle-fixture failure, and one compatibility pass. After supplying
  the required bundle contents, that isolated regression also failed on money:
  21.60 JD instead of the saved 23.20 JD. These were assertions of the correct
  behavior, not the audit's assertions of the original defect.
- All 17 F2 cases subsequently passed. An intermediate run exposed two test-only
  assumptions: resave requires `current_order_id`, and quantity storage has six
  decimal places. Those were corrected without further production edits.
- The real HTTP/database flow saves the same product at 16% and 8%, changes its
  catalog to zero/exempt, merges at 11.20 JD, retries the committed merge without
  changing state, reloads, saves, and pays the surviving bill at 11.20 JD. Both
  tables are released and the shift closes at expected/counted 31.20 JD with
  starting cash 20 JD. This is an explicit replay after success, not a simulated
  network-response loss or a claim that all stale actions are protected (F4).
- Rejected registration, historical accounting, and exemption combinations
  retain complete order/item/table/audit snapshots and emit no realtime updates.
- Same-product distinct rates, zero-rated/exempt categories, saved exemptions,
  registration setting changes, priced modifiers with line discounts, bundle
  tax/children, receipt-display changes, and historical accounting are covered.
- The final focused suite passed **62 tests across nine files**, including all
  17 F2 and 13 F1 cases. Another file and 343 tests were skipped by the filter;
  this is not a rerun of the whole original audit. Existing selected cases
  verify merge audit-failure rollback, service-charge reconciliation/settlement
  and stale snapshot rejection, recipe identities, bundle integrity, connection
  release, catalog healing, partial voids, and paid-order immutability.

The focused compatibility command:

```powershell
npm run test:isolated -- backend/tests/integration/tableMergeTax.test.js backend/tests/integration/tableMergeDiscount.test.js backend/tests/integration/tables.test.js backend/tests/integration/tableConnectionLifetime.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/recipeLedgerSplitsMerges.test.js backend/tests/integration/serviceChargeSnapshots.test.js backend/tests/integration/taxSourceOfTruth.test.js backend/tests/unit/helpers.test.js -t 'merge|swaps discounted|transfers a discounted|can retry|Tax source-of-truth|recomputeOrderTotals|partial-void' --reporter=default --reporter=json --outputFile.json=scratch/tables-f2-20260913/integration.json
```

Every database run uses the isolated runner's own generated loopback database.
An independent schema-list check confirmed all **11 generated databases** from
this step were removed. `git diff --check` passed.
No customer/Hostinger database or physical printer was exercised. The floor has
no Combine Bills button, so acceptance uses the real HTTP/database workflow;
there is no new browser/build claim. Raw logs, RED/GREEN JSON, measurement
harnesses, and results are in ignored `scratch/tables-f2-20260913/`.

## Measurements

The HTTP harness uses one warm-up and three measured samples per condition,
with freshly seeded bills. One or 100 source lines and one target line all save
at 16%, then catalog tax changes to 8%. Before runs assert the original wrong
amount, and after runs assert the saved amount. Statements count `query` and
`execute`, excluding transaction lifecycle calls. Returned rows are not
storage-engine row visits. Every measured action releases its connection once.

| Source lines | Statements before → after | Returned rows before → after | Baseline HTTP median | After HTTP medians |
|---|---:|---:|---:|---:|
| 1 | 24 → 23 | 14 → 13 | 10.16 ms; repeat 10.09 ms | 12.74 / 16.70 / 13.46 ms |
| 100 | 321 → 320 | 212 → 211 | 66.97 ms; repeat 67.88 ms | 90.76 / 98.22 / 97.55 ms |

The repeated baseline loads only the two changed modules from the exact F1
commit into the test process; all other code remains current and the checkout
is untouched. Local HTTP timing regressed in these separate-process samples.
Most additional time appeared in the unchanged per-line matching and insertion
queries before recalculation, so those samples cannot isolate its cause. Query
count, returned data, and the existing lock order do not increase. These results
do not establish customer latency or a throughput improvement.

To control process drift, a final isolated harness alternated old/new service
calls in one process and pool, reversing their order each round. After one warm
pair, five measured pairs at 100 source lines produced median service time
**94.08 ms before / 77.00 ms after** and median connection hold time
**94.02 / 76.95 ms**. Ranges overlapped: 70.17–119.40 ms before and
68.27–108.33 ms after. This diagnostic loads the original relationship module
with the current pricing helper's unchanged default live-tax behavior, uses no
realtime emitter, and is a direct service comparison rather than HTTP latency.
It independently verifies the old/new amounts and 321/320 statement counts.
The opposing timing results leave latency inconclusive; they do not justify a
performance gain claim or establish a reproducible latency regression caused by
this edit. The concrete resource result is removal of one catalog read with no
new per-line work or lock lifetime policy. F8's per-line work remains open.

## Handoff and rollback

After verification and the task-sized F2 commit, continue with F3 only: expected
revision protection for stale table saves, starting with a failing regression.
The original audit in `scratch/tables-audit-20260913/report.md` and the F1 review
remain the authority for the remaining sequential work and approved features.
Do not remove the F1 or F2 boundaries while extending table actions.

Rollback is the F2 commit revert, which needs no schema rollback but reopens the
saved-tax merge defect. Future release validation should reproduce the two
5.80 JD bills on a dedicated test instance, merge after catalog drift, and verify
11.60 JD plus intact conflict behavior. Push, PR, release, and deployment are not
authorized by this task chain.
