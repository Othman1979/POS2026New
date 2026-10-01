# Table closure fixes

Continuation of [the closure audit](2026-09-14-table-closure-audit.md), on `codex/tables-workflow-hardening`. Work is serial in the same task. No deployment or push is authorized or performed.

## Verification baseline repaired

Both previously failing unit tests were reproduced before any application edit. The public facade contract omitted the three implemented item-transfer functions used by `TableItemTransferModal`; its expected keys and function bindings now include them. The late-table-response test switched sessions before the first order read started. The loader correctly discarded that obsolete read after its QR-draft lookup. The test now waits for the first order request before switching, then resolves Table 2 first and Table 1 late, preserving the original stale-response assertion. All 39 focused tests pass. These are fixture corrections, not production changes.

The read-only cleanup script confirmed all five recorded databases from the prior audit were absent.

## A1: reject destructive parent voids while split checks exist

`voidOpenTableOrder` now requests `requireUnsplit` when locking an unpaid table. After table-group and parent-order locks, it checks for active held children and paid child invoices before loading items/service-charge state, writing history or restoring stock. Active checks return `SPLIT_CHECKS_OPEN` with a direction to the Split Board; paid anchors without held rows return `SPLIT_ALREADY_PAID`.

The existing active-split check was moved into `TableSettlementContext` and re-exported through its existing module interface. Its query now uses a current locking read, so an earlier identity probe's repeatable-read snapshot cannot conceal a split committed while a void waited. Existing Save/transfer/merge callers retain the same helper and query count. No schema, new index, audit exception or paid-refund behavior was introduced.

Evidence:

- Ten RED regressions failed before the change; all ten pass after it. They include fees on/off, ordinary/xyz void actors, no paid child/one paid child, Clear/full-item/partial-item attempts, a missing held remainder with a paid child, and a split committed after the void transaction's initial snapshot. Rejected attempts preserve complete order/item/table/split/history/stock/recipe/fee/queue state.
- Four real built browser scenarios pass: English desktop and Arabic mobile, fees on/off, including printed Arabic tables and an xyz cancellation actor. Clear remains open while another terminal splits and pays one check. The stale Clear is rejected without changes; the user then pays the remaining check through the real Split Board and payment dialog. Product stock ends at 98 from 100 for two sold drinks, recipe consumption stays two, no cancellation/refund history is created, and the table releases normally. No page errors; generated fixture removed.
- All 41 existing item-transfer checks passed. Their concurrency test had an unsafe barrier after acquiring transaction/receipt locks: an early response could leave its peer waiting and block the next fixture reset. The barrier now starts both requests before transaction locks, releases on either request's completion, and awaits both results before teardown. The concurrency assertion remains one success and one revision conflict; the corrected case passes. The aborted earlier fixture was explicitly checked for active connections, removed, and its absence verified.
- Neighboring regressions initially returned 105 passes and one old expectation that allowed clearing a paid-split parent. That expectation now asserts rejection with unchanged parent/items and empty cancellation history; all 17 archive tests pass on rerun. The production code was unchanged between those runs. The remaining 89 neighboring checks already passed, covering save revisions, merge money/discounts/resources, xyz policy, settlement context, connection release and module wiring.
- Read-only Luna review found no concrete issue in the production diff, import graph, lock order or query bounds. Syntax, whitespace and architecture checks pass. Frontend production source is unchanged; browser verification uses the previously verified production build and the current backend.

### Resource comparison

Compared the prior void writer at `72d4ea03` with the current writer, alternating three samples per size in one guarded fixture. Ordinary actor, no fee, no active split; each operation owns one connection and releases it before printing. Fixture setup is outside the measurements.

| Saved rows | Before / after queries | Returned rows (both) | Before / after median ms |
| ---: | ---: | ---: | ---: |
| 1 | 19 / 21 | 10 | 7.79 / 11.70 |
| 20 | 38 / 40 | 29 | 10.75 / 9.63 |
| 201 | 220 / 222 | 210 | 49.14 / 43.22 |

The safety check adds two indexed reads independent of item count. The one-row sample was 3.91 ms slower locally; the small mixed timing samples do not establish a speed improvement or customer latency. Existing history batching, one xyz policy lookup and connection release are preserved. The original active and paid-child indexes are reused. These measurements do not cover all fee/recipe combinations or physical printers.

Evidence: `scratch/tables-closure-audit-20260914/resume-unit-{red,green}.json`, `a1-{red,green}.json`, `a1-baseline-performance.json`, `a1-performance.json`, `a1-transfer-trace.json`, `a1-concurrent-transfer-fixed.log`, `a1-regressions-complete.json`, `a1-archive-green.json`, and `scratch/table-void-splits-browser/results.json` plus screenshots. Maintained commands are in [verification.md](../agents/verification.md).

## A2: authenticate progressive checks without optional audit history

Progressive v2 checkout now verifies the locked, server-owned held-order parent/table relations against the locked live table context. Register hold endpoints cannot write those relations. Legacy checks still require their original matching audit event. Existing item/bundle/money, parent/table, revision, tax and recipe validation remains active. This allows xyz-created and xyz-added checks to be paid while audit history stays suppressed; no new table or audit exception was introduced.

The new focused suite reproduced the failure and now passes all ten checks: ordinary/xyz actors with fees on/off, later checks after partial settlement, saved bundle snapshots after catalog changes, missing relations, forged parent/table and stale revisions. A non-manager cashier pays checks created by the administrator. Four real browser scenarios also pass in English desktop/Arabic mobile with fees on/off: create splits as xyz, pay a named check, add a check through Edit, reload and pay the remaining two. Paid siblings remain unchanged, three drinks consume stock and recipes once, the table releases, and no deleted/refund/audit history appears. Fixture selector/setup mistakes were corrected during harness development; the final complete run has no page errors and removes its database.

The transaction observations remove one optional audit query and one returned row per ordinary progressive payment: first-check fees-off 36/36 to 35/35 queries/rows, fees-on 39/39 to 38/38. Connections release on success and rejection. The respective one-shot local HTTP timings were 20.00 to 17.10 ms and 13.49 to 11.27 ms; these are resource observations, not a customer speed claim. xyz previously failed early, so its old failing latency is not comparable to successful payment. Read-only Luna review found no concrete bypass after correcting an initially misread assignment order.

All 95 selected neighboring checks pass across checkout, bundle, table split and audit policy suites (322 unrelated tests skipped by the split/progressive filter). They include legacy tax, malformed allocation, forged register-hold/bundle snapshots, concurrent payment, split edits and audit rollback. Syntax, whitespace and architecture generation/check pass.

Evidence: `scratch/tables-closure-audit-20260914/a2-{red,green,regressions}.json`, `a2-{baseline-metrics,metrics}.json`, and `scratch/table-split-provenance-browser/results.json` plus screenshots.

## A3: bind Clear and Remove to the reviewed bill

Clear and Remove now send the numeric bill revision captured from the loaded order. Clear captures it before confirmation opens. The void route and writer require that revision and compare it under the existing table/parent locks before loading money or changing any state. Missing and malformed revisions fail closed. A partial void advances the existing order revision, so replay or a concurrent identical request cannot apply the same cancellation twice. Paid refund requests remain independent.

Rejected and uncertain requests preserve the local cart and original revision. Transport/parser failures now say the result could not be confirmed and instruct reopening before retrying. Successful partial voids retain the existing authoritative reload and restoration of unsaved additions/increases. Clear's confirmation describes cancellation without promising history that xyz suppresses. Conflict and uncertain-outcome messages have Arabic translations.

The baseline reproduced 13 runtime failures (missing/invalid revision, stale requests without fees, duplicate/replayed partial voids), plus three frontend failures. Four fee variants initially failed in fixture setup because the concurrent save omitted its service-charge token; after adding the loaded token all 17 backend checks pass, as do all 20 frontend workflow tests. No production behavior was relaxed to fix the fixture. Existing current-intent API fixtures now explicitly load their revision; the new missing/stale/replay tests deliberately retain their original revision.

Four built-browser scenarios pass in English desktop/Arabic mobile, fees on/off, ordinary/xyz actors and printed Arabic bills. Clear stays open while a second terminal adds a burger; rejection preserves both server state and the original visible draft. After reopening, Remove commits and its response is deliberately dropped. The old row remains visible; repeating Remove returns 409 with the same request and no extra changes. Reopening shows the authoritative remaining items and normal Clear succeeds. Product and recipe quantities return to their original values. Ordinary void history stays zero-cash; xyz leaves no deleted/refund/audit history. No page errors and the generated fixture is removed. Harness setup/selector corrections supplied an open shift, separated item Remove from fee Remove, and kept the API language aligned with browser language.

Read-only Luna review found no concrete revision bypass or paid-refund regression. The new browser build and architecture generation/check pass. The alternating three-sample resource comparison against `22a2709d` adds no queries or returned rows: 1/20/201 saved rows remain 21/40/222 queries and 10/29/210 returned rows. One xyz policy read, bounded archive batches and connection release before printing remain intact. Median local timings were 26.13/17.82/259.40 ms before and 23.65/17.41/62.60 ms after; strong jitter (including a 119.72 ms one-row after sample) prevents a speed conclusion. No concurrent database suite ran during the measurement.

The neighboring selection finished with 230 passes and one stale fixture expectation: the service-charge test expected a retained parent but had created an unissued order now eligible for deletion. It now supplies a legacy order number, preserving its original foreign-key retention/cleanup assertion; that case and two stock-pause cases missed by the original filter pass (three total). No application edit was needed. All 233 selected neighboring checks are now verified, including actual refunds, subscription refunds, permission gates, stock/recipe reversals, merge/seating isolation, bill revisions, callback failures and saved-void UI actions. The four A1 split/paid-check browser cases also pass again against the new frontend contract. Revised screenshots wait for the notification transition to finish; Arabic stale-bill guidance is visually confirmed.

Evidence: `scratch/tables-closure-audit-20260914/a3-{red,green,green-corrected,regressions,fixtures-green}.json`, `a3-ui-{red,green}.log`, `a3-{baseline-performance,performance}.json`, and `scratch/table-void-revision-browser/results.json` plus screenshots.

## A4: separate unpaid cancellation history from paid refunds

Initial table payment now clears the old void status in its existing order update. That branch is already guarded by a locked `unpaid_table` payment method; finalized invoices cannot enter it. Canonical status calculation separately counts voids for unpaid/voided orders and actual refunds for paid orders. Its invoice-ID overload also loads the paid total, so complete item coverage alone cannot mark an under-refunded amount as full.

Testing beyond the badge found a related money defect: the paid refund writer subtracted cancelled subtotals from remaining refund entitlement even though those voids returned no cash. The writer now restricts both prior money and prior item quantities to `kind='refund'`. This also prevents legacy void rows with retained item links or misleading positive amounts from consuming paid refund entitlement. History remains intact and operational void reporting stays separate. No historical archive backfill or schema change was made.

Four runtime RED cases establish the stale paid status and invoice-ID coverage defects (one initial schema typo in the new fixture was corrected before reproducing the coverage failure). The first status-only fix exposed two actual refund-underpayment failures; the money/quantity filters resolve them. All six focused scenarios now pass: ordinary/xyz, fee on/off, multiple voids before payment, exact partial/full cash amounts, protected finalized invoices, repeat full refund rejection, legacy void evidence, History filters, stock restoration and 50 JD closing cash.

Four real built-browser flows pass in English desktop and Arabic mobile, fees on/off. They remove a saved burger through the POS, pay the remaining drinks, check that History's Not refunded/Partial refund filters show the correct invoice set, then use the real partial and full refund dialogs. The first cash refund is 2 JD and the last is 2/2.4 JD, totaling the paid 4/4.4 JD. History advances none/partial/full correctly; original stock and recipe quantities are restored and expected closing cash is 50 JD. xyz suppresses the unpaid void history while retaining both real refunds. Mobile verification uses the visible card/details actions and reopens the cart after its existing post-Remove reload. No page errors; fixture removed. Arabic full-refund History was visually inspected.

Checkout transaction queries/returned rows are unchanged: 32/29 without fees and 34/32 with fees, for both actor policies; leases return on completion. Ordinary one-shot local timings were 20.82 to 25.50 ms without fees and 18.45 to 16.13 ms with fees. These mixed samples do not support a performance claim. The refund filters reuse existing per-invoice queries and add no request or row loop. Read-only Luna review found no remaining paid-money or refundable-quantity reader in the inspected sibling flows that counts voids as refunds. Architecture generation/check and syntax/whitespace checks pass.

All 130 final selected financial regressions pass across seven files (16 unrelated cases skipped): paid refunds, void/archive rules, xyz policy, managed subscription cancellation, subscription collections, History filters, and Refunds & Voids report totals. This final run includes the stronger exact partial/full amount assertions and correct table-source filter in the six focused cases. No production changes followed that run.

Evidence: `scratch/tables-closure-audit-20260914/a4-{red,green,green-corrected,green-final,regressions}.json`, `a4-overload-red.log`, `a4-{baseline-metrics,metrics}.json`, and `scratch/table-paid-refund-status-browser/results.json` plus screenshots.

## Closure

All four recorded audit findings are fixed and locally verified. Each issue was implemented serially, tested adversarially and committed before the next. The distinct browser matrices cover 16 scenarios across the four fixes; A1's four cases were also rerun after the new void API contract. Tests use generated loopback fixtures, and the recorded fixture names are checked absent in `scratch/tables-closure-audit-20260914/cleanup.json`.

This verifies the documented local flows, not every possible customer environment or physical printer. No customer data, historical archive backfill, push, merge or deployment was performed. The original audit characterizations remain preserved as evidence of the prior failures.
