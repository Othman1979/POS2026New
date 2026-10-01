# Table save revision protection — F3

An unchanged stale cart could remove a newer bill discount. Terminal A loaded
4 JD of drinks. Another request saved a fixed 1 JD discount, making the bill
3 JD. A's old cart still matched the reminted saved lines, so saving it returned
200 and restored the total to 4 JD. Invoice identity alone did not detect this.

## Change

Table-order GET and successful save responses now return `version`. Edits must
send that value as the numeric `expected_version`. `lockTableSession` checks it
against the locked order after the existing group/identity/status checks and
before loading items or the service-charge snapshot. Missing, malformed and
stale revisions return 409 / `TABLE_ORDER_VERSION_CONFLICT`.

The existing `orders.version` column is reused. Successful saves increment it
inside their existing order UPDATE. New orders start at the schema default 1;
historical NULL is read as 1 and becomes 2 on its next save. The version is a
bill-content revision, not a table-relationship operation identifier.

The POS stores the loaded version with its active table, sends it on save and
retains it on a failed or uncertain response. Revision conflicts show an English
or Arabic warning. They do not reload the bill, clear the cart, replace the
local discount/note or mark unsaved lines as saved. Explicit reopening loads
the current server bill for review, after which saving uses its new version.
A retry after a lost committed reply is rejected with the old revision; the
operator reopens the bill to confirm its saved contents.

The order/group lock sequence and transaction lifetime policy are unchanged.
There are no additional queries, schema changes, dependencies or caches.

## Writer audit

Before editing production code, searches of runtime order UPDATE statements
and version references found no existing `orders.version` reader or writer.
Held orders, stock and service-charge snapshots have separate version columns.

| Writer | Relevance to open-table revisions |
|---|---|
| `saveTableOrder.js` | Advances the revision with the existing money/discount UPDATE. Its tax-registration and service-charge writes are in that same transaction. |
| `OrderPricing.recomputeOrderTotals` | Advances the revision with the final totals UPDATE. This covers successful merge, catalog healing and partial void recalculation without adding per-line work. |
| `splitChecks.js` | Advances it when backfilling either nullable historical registration or accounting mode. Active checks retain their existing save refusal; backfills remain detectable after cancelling the checks. |
| `tableRelationships.js` transfer/swap | Only relocate orders; existing table/invoice/group checks still apply. Expected relationship identities and operation retry safety remain F4. Merge changes content through `recomputeOrderTotals`. |
| `voidOpenTableOrder.js` | Partial voids recalculate above. Full void changes payment status and releases the table, so the existing session guard rejects edits. |
| `executeCheckout.js` | Settlement/edit finalizes payment status. Closing split parents marks them voided; active split checks block ordinary parent saves. |
| `RefundService.js`, `invoiceSequence.js` | Paid-invoice refund/tax metadata and issued invoice identity are outside the open-table edit path. |

GET remains an unlocked read. If another transaction commits between its order
and item reads, the returned older revision will fail a subsequent save; it
cannot authorize overwriting the newer bill. This avoids holding write locks
while building read responses.

F1's discounted-merge rejection and F2's saved merge-tax policy remain intact.
Catalog healing and partial voids still use their existing live-tax policy;
this fix does not permanently freeze tax across those actions.

## Verification

Baseline: `5f91b04992fcb13115099dabf7d281cc8ad02380`, clean shared checkout on
`codex/tables-workflow-hardening`. All database work used generated loopback
fixtures, never the configured application database or an assumed disposable
`posapp_test`.

Before production changes, the 14 new backend cases failed behaviorally: stale
and malformed-version requests returned 200, and simultaneous same-revision
saves both succeeded. Two frontend regressions failed because the loaded
revision was not retained/sent. A separate warning regression failed before
adding the visible conflict toast. Raw evidence is under
`scratch/tables-f3-20260913/`.

Existing money/stock fixtures now explicitly supply a current revision so they
continue reaching their original validation boundaries. Their shared test-only
helper is deliberately not used by the stale-save regressions, which retain
the revision from the original GET.

| Verification | Result |
|---|---|
| Broad affected integration files | 456 passed across 14 files; includes F1's 13 and F2's 17 cases |
| Final F3, settlement-context and tax-policy run | 35 passed: 18 F3, 13 settlement-context, 4 live-tax/finalization cases |
| Focused connection, post-commit and corruption checks | 10 lease cases, 2 post-commit cases and 1 existing corruption guard passed |
| Frontend session/persistence/workspace/split/lifecycle checks | 311 passed across 6 files, including the two new draft/revision cases |
| Build and architecture generation/check | Passed |
| Built UI with real API/database | English and Arabic desktop; full conflict/reopen/save/lost-response/retry/reload/payment flow passed |
| Cleanup and diff check | All 9 generated databases independently confirmed absent; `git diff --check` passed |

These rows overlap; their counts must not be added. The broad run contained
the original 17 F3 cases. The final run includes the added historical-accounting
case and cash-close assertions. The first focused attempt at that added case
used an invalid NULL registration in the current NOT NULL enum, which became
an empty enum value in the fixture. Correcting the test to use the supported
nullable accounting flag required no production change. The current baseline's
registration backfill branch is defensive legacy compatibility, not a claim
that current schemas permit NULL registration.

The F3 regressions verify the original same-item overwrite, absent/malformed
versions, simultaneous saves (one commit, one conflict), merge and catalog-heal
invalidation, rollback after injected item-persistence failure, retry after
rollback, partial void, saved discount through cash payment and shift close,
historical NULL versions, and splitting/backfilling/cancelling before a stale
save. The existing tests retain modifier/bundle identities, recipe and physical
stock behavior, service-charge snapshot guards, rollback and connection release.

The browser fixture uses the real built POS and an independent API writer.
It saves 4 JD, applies a 1 JD discount elsewhere, and verifies that stale UI
saves leave the server at 3 JD while retaining the local three-item draft.
After explicit reopen/review, it saves again, adds one drink and aborts the
HTTP response only after `route.fetch()` confirms the real commit. The retry
keeps the committed 5 JD bill and its item identities unchanged. Exactly one
new kitchen job and one additional stock unit are recorded. Explicit reopen,
browser reload and card payment then preserve 5 JD, release the table and close
the shift with expected/counted cash both 20 JD. Both languages passed without
uncaught page errors. This was desktop Chromium, not mobile or physical printing.

Commands and raw evidence:

- `npm run test:isolated -- backend/tests/integration/tableSaveRevision.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/integration/taxSourceOfTruth.test.js` — final 35-case recovery run.
- The complete broad 14-file command and results are in `scratch/tables-f3-20260913/integration.log` and `integration.json`; the focused lease/post-commit command is in `final-focused.log`.
- `node node_modules/vitest/vitest.mjs run --config scratch/tables-f3-20260913/frontend.config.mjs` — the 311-case frontend run with DB setup disabled.
- `npm run build:admin`, `npm run architecture`, `npm run architecture:check`.
- `node scratch/tables-f3-20260913/browser.cjs` — guarded browser fixture; JSON, logs and screenshots alongside it.
- `node scratch/tables-f3-20260913/verify-cleanup.cjs` — read-only independent database cleanup confirmation.

## Isolated measurements

The real HTTP harness runs one warm-up and five measured samples per condition,
with newly seeded bills. It compares one and 100 distinct saved lines, both for
a current unchanged save and a stale request following another discount save.
The original stale requests deliberately demonstrate the bad successful write;
the after samples require 409 and unchanged money. Measurements ran alone.
Statements count transaction `query`/`execute` calls, excluding lifecycle calls;
returned rows are not storage-engine row visits. Every sample released once.

| Lines / operation | Statements before → after | Returned rows before → after | HTTP median before → after | Connection-held median before → after |
|---|---:|---:|---:|---:|
| 1 / current save | 15 → 15 | 20 → 20 | 11.67 → 7.36 ms | 7.74 → 4.97 ms |
| 100 / current save | 114 → 114 | 119 → 119 | 36.03 → 24.87 ms | 31.98 → 22.22 ms |
| 1 / stale save | 17 → 4 | 21 → 4 | 9.84 → 2.77 ms | 6.24 → 1.18 ms |
| 100 / stale save | 116 → 4 | 120 → 4 | 31.22 → 2.92 ms | 27.90 → 1.24 ms |

The concrete result is no additional normal-save query/row work and rejection
before item loading/writes regardless of cart length. Normal-save timings were
lower in these later samples, but that is not evidence that the small revision
check makes successful saves faster. These are local loopback diagnostics, not
customer latency, storage-engine scan counts or a concurrency throughput claim.
The simultaneous-save regression exercises lock serialization, not exhaustive
deadlock/failure interleavings. No Hostinger, customer database, installed
spooler or physical printer was exercised.

## Deployment and continuation

This changes the table-edit API contract: clients must reload with the updated
frontend and reopen existing bills to obtain the revision. There is no database
migration. Rollback is the task-sized F3 commit revert, which reopens the stale
discount overwrite. No push, PR, release or deployment is authorized here.

After F3 verification and commit, continue with F4 only in a new local task on
the same branch, using GPT-6 Astra / xhigh. The original audit and the F1/F2
reviews remain the serial handoff for the remaining fixes and later features.
