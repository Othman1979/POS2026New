# Recipe ledger review — Phase 1 (Tasks 1–4)

Reviewed 6 September 2026 at commit d6cc1ab2 on codex/inventory-recipe-research. The original review below did not change application code. The subsequently authorized corrections are documented in the [Phase 1 fixes and verification record](2026-09-06-recipe-ledger-phase-1-fixes.md). The preexisting uncommitted research/evidence documents were preserved.

## Ordered review phases

| Phase | Tasks | Scope | Status |
| --- | --- | --- | --- |
| 1 | 1–4 | Duplicate-line stock restoration; migration/fixture; pure arithmetic; transactional writes and reads | Reviewed; 8 confirmed correctness findings and 1 measured query-scaling finding below |
| 2 | 5–8 | Table/checkout integration; splits/merges; refunds/voids/subscriptions; catalog/setting | Pending |
| 3 | 9–12 | Admin API; Ingredients UI; Recipe editor; day report | Pending |
| 4 | 13 | Architecture, combined regression, English/Arabic browser verification | Pending |

The current checked-in 13-task plan is the baseline. Its explicit toggle/cost/pack/portion/report changes supersede the older research-only design for this review. Later-phase call sites were traced only where needed to reproduce a Phase 1 defect.

## Evidence and verdict by task

| Task | Evidence | Verdict |
| --- | --- | --- |
| 1 | Actual HTTP table save with duplicated product quantities 1 and 2, unchanged re-save, then checkout: starting stock 10 became 7, remained 7, remained 7; every response 200. Existing inventory/table/checkout tests passed. | No defect found in this fix |
| 2 | On MariaDB 10.4.32, loaded the pre-Task-2 fixture from Git 74820d4b, advanced it to the exact predecessor using the real runner, then applied the shipped migration. Runner retry and direct SQL repetition succeeded. Missing predecessor and conflicting checksum were rejected. Three new table definitions match the current fixture exactly; the two existing line tables have matching definitions with different column placement. Manifest/hash/evidence/fallback tests passed. | No defect found in the migration checks performed |
| 3 | Existing unit tests passed; independent exact arithmetic expectations and real HTTP portions/refund paths failed. | Findings F3 and F7 |
| 4 | Existing service tests passed; public HTTP responses, persisted rows, and controlled real two-connection transactions demonstrate failures. | Findings F1–F6, F8–F9 |

Existing test command, run with the review-only scratch preload:

~~~text
npx vitest run backend/tests/unit/inventoryService.test.js backend/tests/unit/recipeLedgerPure.test.js backend/tests/unit/recipeLedgerMigration.test.js backend/tests/integration/recipeLedgerSchema.test.js backend/tests/integration/recipeLedgerService.test.js backend/tests/integration/tables.test.js backend/tests/integration/checkout.test.js
~~~

Result: **7 files, 358 tests passed**, 364.79 seconds. This passing result does not cover the new adversarial cases.

The independent probe runner recorded **17 checks: 12 failed, 5 passed**. The 12 failures include separate service/HTTP reproductions of the same problems and map to eight correctness findings. One passing measurement check records the ninth finding's actual query behavior.

## Confirmed findings

### F1 — [P2] Summary combines a Count and tail from different database states

Location: [RecipeLedgerService.js:575](../../backend/services/RecipeLedgerService.js#L575), getIngredientSummaries's separate latestCounts/tails queries.

Reproduction: start at Count 100. After the summary reads that Count, commit Count 200 and receipt +10 before its tail query. The summary returns **110**, while a fresh read returns **210**. The only committed balances were 100, 200, and 210; 110 never existed.

The admin GET passes the pool directly, so these SELECTs do not share a transaction snapshot. This can corrupt the displayed expected quantity, shopping shortfall, portions, and opening prefill. The probe invokes the real service against MariaDB and delays only query boundaries; it does not replace database rows or calculations.

Correction needed: read the anchor and tail in one consistent database snapshot or one query. Preserve that consistency across all summary components.

### F2 — [P2] Count can persist a false variance after waiting for a receipt to commit

Location: [RecipeLedgerService.js:413](../../backend/services/RecipeLedgerService.js#L413), findByClientKey before loadIngredient; [countExpectations:381](../../backend/services/RecipeLedgerService.js#L381).

Reproduction with two actual transactions under the verified REPEATABLE-READ isolation:

1. Count is 100.
2. A receipt transaction writes +10 and keeps its ingredient lock.
3. The Count transaction's first client-key SELECT establishes its read snapshot; its ingredient lock waits.
4. Commit the receipt, then let Count 110 finish.
5. Stored rows are Count 100, receipt +10, Count 110, but the last Count stores **expected_qty 100** and reports **variance +10**. Expected was 110, variance 0.

The ingredient lock is acquired too late to stop the earlier consistent-read snapshot from being reused by the plain history SELECT.

Correction needed: establish accounting reads after the serialization point using an appropriate current/snapshot-read design. An ingredient lock alone does not refresh an existing repeatable-read snapshot.

### F3 — [P2] A fully refunded order can retain ingredient usage after fractional refunds

Location: [RecipeLedgerService.js:67](../../backend/services/RecipeLedgerService.js#L67), reversalRows; [loadRecorded:207](../../backend/services/RecipeLedgerService.js#L207).

Public HTTP reproduction: create a recipe with components 0.000001 g and 1 g per meal, check out one meal, refund 0.333333, 0.333333, then 0.333334 of the same sold line. All four requests succeed, refund_items sums to exactly 1.000000, and the order has refund_status full. Nevertheless:

~~~text
small component: net usage -0.000001; recorded remaining product quantity 1.000000
normal component: net usage 0.000000; recorded remaining product quantity 0.000000
~~~

A component reversal rounded to zero is omitted completely, including its product_qty decrement. loadRecorded takes productQty from an ingredient group, so that group's stale quantity prevents the final-refund remainder path from running. This is an explicitly accepted six-decimal edge case, not a claim of gram-scale loss in ordinary integer refunds.

Correction needed: maintain authoritative line refunded quantity independently of whether an individual ingredient's rounded reversal is zero; use cumulative exact allocation and apply the final remainder.

### F4 — [P2] Opening-count retry accepts a different request as successful replay

Location: [RecipeLedgerService.js:466](../../backend/services/RecipeLedgerService.js#L466), recordOpeningCounts replay branch.

HTTP reproduction: POST opening 100 with key K; repeat 100 with K; then POST opening 250 with K. Responses are **200 / 200 replay / 200 replay**, and only the original 100 remains stored. The changed payload should return 409. Changing the ingredient list is likewise not compared by this branch; the demonstrated case uses quantity only.

The branch returns stored movements before validating or comparing the normalized request. This is silent false success, not an overcount.

Correction needed: bind the entire ordered/canonicalized opening batch to its replay identity, compare the complete normalized payload, and reject mismatch.

### F5 — [P2] Unknown starting inventory is treated as a known zero-based balance

Locations: [RecipeLedgerService.js:388](../../backend/services/RecipeLedgerService.js#L388), no-Count countExpectations branch; [listMovements:671](../../backend/services/RecipeLedgerService.js#L671).

HTTP/DB reproduction: a new ingredient receives 10 before any Count. Summary correctly returns expected_remaining null, but history returns running_balance **10**. Now Count 100: it stores expected_qty **10** and shows variance_qty **90**, although no previous inventory anchor existed.

These are two manifestations of the same missing-anchor error. The current UI drawer does not render running_balance; that part is a confirmed API contract defect. The count variance is supplied to the Ingredients page.

Correction needed: no applicable Count means NULL expected/running balance and NULL initial variance. Usage totals and receipts can still be shown independently.

### F6 — [P2] Concurrent identical receipt retry returns an error instead of replay

Location: [RecipeLedgerService.js:413](../../backend/services/RecipeLedgerService.js#L413) through insertion; error surfaced by [admin route:10](../../backend/routes/admin/recipeLedger.js#L10).

Public HTTP reproduction: submit the same receipt/key twice, with both client-key lookups completed before either insert. One returns 200; the other returns **409 “An ingredient with this name already exists.”** SQL confirms exactly one receipt of 10 was saved.

The unique index prevents double-writing, but the pre-lock replay lookup is stale. The duplicate is not reloaded and compared after serialization. The generic duplicate-name error further misidentifies the failure.

Correction needed: perform concurrency-safe replay resolution and payload comparison after the winner commits, then return the original receipt with replay true.

### F7 — [P2] Floating-point division understates whole portions

Location: [RecipeLedgerService.js:112](../../backend/services/RecipeLedgerService.js#L112), portionsPossible.

Public HTTP reproduction: save a 0.1 g-per-meal recipe, enter Count 0.3 g, GET portions. The response says **2**, although the exact six-place quantities support **3**. The pure helper reproduces the same result.

Math.floor(0.3 / 0.1) operates on a binary approximation just below 3.

Correction needed: divide exact scaled base quantities before flooring; test exact multiples and values immediately below a whole portion. Do not add an arbitrary epsilon that could overstate genuinely insufficient inventory.

### F8 — [P2] A valid-length opening replay key cannot support a multi-ingredient batch

Location: [RecipeLedgerService.js:482](../../backend/services/RecipeLedgerService.js#L482); [migration client_key:67](../../backend/migrations/2026-09-05-recipe-ledger-v1.auto.sql#L67).

HTTP reproduction: opening two ingredients with a 64-character key passes the advertised key-length admission but returns **409 duplicate ingredient name**, and the transaction writes zero rows. The second derived key appends colon plus ingredient id beyond the 64-character column. On the verified database configuration it truncates to the first key and hits its unique constraint.

Correction needed: generate bounded deterministic per-entry keys from the batch identity, or use a separately validated batch identifier design. Check identical replay and changed-payload rejection afterward. The existing rollback correctly prevented a half-saved opening.

### F9 — [P2] Paginated history and latest-Count summaries still scan complete history

Locations: [RecipeLedgerService.js:576](../../backend/services/RecipeLedgerService.js#L576) and [listMovements:664](../../backend/services/RecipeLedgerService.js#L664).

Measured on a 20,000-row scratch ingredient: asking for two history rows returned two rows to the caller but fetched **2 + 20,000 rows** from SQL. The service loads full history and filters the prefix separately for every displayed row. This one local call took **20.31 ms**; this is not a claim that production is currently slow.

EXPLAIN on both latest-Count subqueries showed an index scan across approximately **20,035 movement entries**; the tail plan also used temporary/filesort operations. The presence of idx_im_ingredient_kind_id alone does not establish the bounded latest-Count access promised by the plan.

Correction needed: bounded per-ingredient latest-Count lookup, aggregate prefix before the page, and one forward fold over the page. Capture fresh EXPLAIN and row-read evidence for the corrected queries.

## Reproduction files and limits

- [Adversarial runner](../../scripts/reviews/recipe-ledger-phase1-probes.cjs)
- [Exact probe results](../../scripts/reviews/recipe-ledger-phase1-results.json)
- [Migration runner](../../scripts/reviews/recipe-ledger-phase1-migration.cjs)
- [Migration results and SHOW CREATE TABLE output](../../scripts/reviews/recipe-ledger-phase1-migration-results.json)
- [Database isolation preload](../../scripts/reviews/recipe-ledger-phase1-preload.cjs)

PowerShell, from the repository root; each runner creates a NEW scratch database and refuses to adopt an existing one:

~~~powershell
$env:POSAPP_REVIEW_DB = 'posapp_review_recipe_p1_' + [guid]::NewGuid().ToString('N').Substring(0,12)
$env:NODE_OPTIONS = '--require=C:/xampp/htdocs/posapp/scripts/reviews/recipe-ledger-phase1-preload.cjs'
node scripts/reviews/recipe-ledger-phase1-probes.cjs

$env:POSAPP_REVIEW_DB = 'posapp_review_recipe_p1_' + [guid]::NewGuid().ToString('N').Substring(0,12)
node scripts/reviews/recipe-ledger-phase1-migration.cjs
Remove-Item Env:NODE_OPTIONS
Remove-Item Env:POSAPP_REVIEW_DB
~~~

The probe runner intentionally records every failed expectation and continues so one defect does not hide later evidence; inspect the JSON/status summary, not its process exit alone. Its SQL wrappers only schedule deterministic race boundaries and count/query real results. Scratch databases remain available for inspection; the business database and existing posapp_test were not seeded, changed, or used for these checks.

No frontend/browser, production, or later-phase completeness claim is made. Phase 1 is not approved as correct: the findings above need correction and rerun before it can pass. The next review batch is Tasks 5–8.
