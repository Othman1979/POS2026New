# Full branch review

Date: 2026-09-09. Branch: `codex/ingredients-ui-fix`.

Review began at `71a04db5`, against merge base `021a4f13fb5f60ed63fb7021f22b7dac897e6c67` with fetched `origin/master`: 248 changed files. Three Luna reviewers read the stock/write paths, report/read paths, and frontend. They made no edits or database changes. The main reviewer checked findings, implemented corrections, and ran verification.

Application corrections are committed as `9f34790f` (UI and browser regression coverage) and `51b7093d` (activation safety, query reduction and catalog guards). All confirmed correctness findings and all failed verification files from this review are addressed. The local startup metadata-cost limitation is recorded separately below.

The product scope remains the [POS inventory core](../2026-09-09-pos-inventory-core-closeout.md). Product stock and ingredient recipes remain independent optional features. This review does not revive purchasing, warehouse transfers, or the superseded A–J plan. Historical migrations and source evidence remain for existing installations.

## Confirmed findings and corrections

| Area | Failure | Correction and regression evidence |
| --- | --- | --- |
| Recipe editing | Opening an existing recipe filtered out inactive ingredients. Saving another change could silently remove those lines. This can occur on an inactive product retaining a historical recipe; active-recipe ingredient deactivation is already guarded by the backend. | Retain and identify inactive lines. Saving requires explicit removal or reactivation. The component test verifies no PUT occurs until explicit removal, then checks the exact saved recipe. |
| Ingredient delivery/count picker | Load more replaced the previous page; a separate 20-row slice also hid appended results. | Append subsequent pages and show loaded options. Test selecting across both pages. |
| Waste picker | Load more discarded the previous page. | Append options and retain the first page. |
| Product replenishment | After a successful adjustment, a product could remain in the low-stock filtered list with a stale total. | Refresh the current server-filtered page after confirmation; remove the unused separate statistics refresh. Test that the replenished row and total disappear. |
| Optional stock | Disabling stock while viewing the quantity ledger left that filter selected. | Reconcile both replenishment and ledger views back to the product list when stock is disabled. |
| Ingredient report | Unknown actual consumption rendered as `null` with a unit. | Render an em dash; keep known zero distinct. |
| Product dialog | Its custom visible header did not provide ModalShell's accessible dialog name. | Pass the translated title through the existing dialog interface. |
| Stock panel spacing | The Arabic mobile panel placed labels directly against its clipped outer border. | Add an inset and flexible filter sizing; inspect the built English/Arabic views and check control bounds. |
| Ingredient activation | Bundle membership changes, clearing a bundle's overriding recipe, and restoring archived Y held carts could change the held-order evidence during activation. | Each writer takes the existing shared `stock_enabled` lock before other transaction work. Activation's exclusive lock serializes the scan. Real HTTP/database tests observe the lock wait, release it, and verify all three mutations persist. |
| Activation query cost | Repeated held products and frozen recipe keys were re-read for every cart. | Bounded negative caches retain only verified nonmatches for one scan. Malformed/missing evidence still blocks activation; matches still stop immediately. A new invocation reads changed recipes again. |
| Migration fixtures | The stock-adjustment and core-ledger tests dropped parent tables before newer dependent tables, preventing their upgrade checks from running. | Remove dependent fixture tables first while keeping foreign-key checks enabled; do not change production migration SQL or relax constraints. |
| Migration verification timeout | The report-facts upgrade case performed two full startup validations and exceeded its per-case timeout, leaving work running against the fixture during teardown. | Separate the wrong-index rejection into its own case. Preserve both validations and the upgrade/data-preservation assertions. |
| Receipt query-budget test | An old assertion still expected four queries, omitting the subsequently required balance projection, authority lookup, and report invalidation. | Keep the concurrent retry assertion and add an independent real 1-line/100-line receipt comparison. Both must have equal query count, at most nine, with all persisted quantities checked. |
| Bundle migration test | Repeated metadata checks exceeded the default 30-second test timeout, allowing teardown to begin before the check completed. | Reuse the migration's freshly verified return state instead of querying it twice again. Give this DDL/metadata case a 90-second ceiling so it completes before the next fixture reset. |
| Catalog replacement coverage/dead SQL | The old test expected historical product references to be detached, despite the new guard rejecting that operation. Two detachment UPDATEs remained after the guard. | Preserve the history guard, remove both unreachable UPDATEs, and test both rejection without mutations and replacement of an unused catalog. |
| Historical migration contract | The zero-valued expense test assumed its migration must remain startup's latest required version forever. | Verify it remains in the required ordered migration chain with matching checksums; retain the SQL, preflight, constraint and fallback checks. |

Two suspected report defects were rejected after tracing the actual code: count and checkout writers already share an ingredient lock before their differing stock/balance operations; a missing day after completed sparse backfill legitimately represents no source activity. Neither warranted a speculative change.

## Measured query reduction

The same generated loopback fixture contained 100 held carts, each with 100 lines alternating a repeated plain product and a frozen empty recipe. Both the implementation loaded from `71a04db5` and the corrected implementation returned no matching hold.

| Implementation | Actual SQL calls |
| --- | ---: |
| Before review | 205 |
| After review | 7 |

This is a 96.6% reduction in calls for that repeated-cart workload. The two caches are each capped at 1,000 entries and discarded after the scan. Tests cover later matching holds, the final cart batch, invalid evidence, and changes between invocations. This does not establish a general latency, CPU, memory, or physical printing gain. Raw local evidence: `scratch/branch-review-held-query-cut.json`; regression: `backend/tests/integration/stockIngredientHeld.test.js`.

### Rejected schema-query experiment

Startup schema validation is expensive on this local MariaDB instance. A narrower `TABLE_SCHEMA` predicate improved the plan of an individual `KEY_COLUMN_USAGE` probe, but adding those predicates to the complete validator did not demonstrate a saving: all 152 summary results matched, and the complete query still took approximately 91/99 seconds before/after under concurrent test load. These timings are diagnostic observations, not an isolated performance comparison. The candidate was not applied to production source. `REFERENTIAL_CONSTRAINTS` still showed all-database metadata scanning in EXPLAIN despite schema predicates; reducing that cost would need a separate, verified approach. No schema checks were removed to make tests pass.

## Verification

The full application sweep ran 395 files in 70 minutes 49 seconds: 389 files passed and six failed; 4,198 tests passed, five failed, and two were skipped after a setup failure. It began before the review corrections. Each failed file was reproduced, corrected, and rerun successfully below. Counts overlap across the full sweep and focused runs.

| Check | Final result | Local evidence |
| --- | --- | --- |
| Full sweep, including checkout, tables, refunds, optional inventory, costs, reports, print queue, installer and frontend | 4,198 passed; original six-file failures accounted for below | `scratch/branch-review-full.json` and `.log` |
| Adjustment and core-ledger migration fixtures | 5 passed | `scratch/branch-review-migration-fixed.json` |
| Bundle migration (unit/integration) and ingredient workflow/query scaling | 18 passed | `scratch/branch-review-extra-final.json` |
| Product/catalog routes and expense migration contract | 37 passed | `scratch/branch-review-catalog-final.json` |
| Separated report-facts upgrade, wrong-index rejection and predecessor checks | 3 passed | `scratch/branch-review-facts-final.json` |
| Focused recipe, bundle, Y-report and activation checks | 116 passed | `scratch/branch-review-backend-focused.json` |
| Complete frontend suite | 592 passed, zero failed or pending | `scratch/branch-review-frontend.json` |
| Focused UI regression cases | 36 passed | `scratch/branch-review-ui-green.log` |
| Final stock-list/settings frontend checks after panel spacing | 6 passed | `scratch/branch-review-ui-last.json` |
| Production frontend build after final UI edit | Passed | `scratch/branch-review-build.log` |

The three new lock tests passed both in the focused run and the full sweep after diagnostic polling was widened from 25 ms to 200 ms, allowing InnoDB's diagnostic snapshot to refresh. Their assertions still require an actual database wait and persisted writes. The report-facts cases now each complete their full schema query before another case changes the fixture. The verification guide now recommends retaining both default and JSON reporters, because JSON alone omitted the setup-hook error message in the initial run.

### Built-browser acceptance

Both existing browser runners passed on their own generated fixtures at English 1280 px and Arabic 390 px. Final stock-panel spacing is checked in the working-list rerun. Screenshots were visually inspected as well as checked for page errors, document overflow and stock-control bounds.

- Ingredient receiving succeeds for an item outside the currently filtered list; its real balance moves from 100 to 102 to 104 across the language runs.
- Delivery/count and waste pickers keep both pages after Load more.
- Disabling product stock exits the quantity-ledger view.
- An inactive product's historical inactive ingredient stays visible in its recipe. Saving remains blocked until explicit removal, then the edited recipe persists through the real API.
- The stock workspace retains three columns and two select filters, with no Receiving navigation entry.
- A real 105-line invoice is published by the report worker, walked without duplicate/missing meals, searched for its last meal, and opened in the calculation-detail view in both languages.

Commands: `node scripts/reviews/stock-working-list-browser.cjs` and `node scripts/reviews/stock-report-pagination-browser.cjs`. Evidence: `scratch/stock-working-list-browser.json`, `scratch/stock-report-pagination-browser.json`, and their referenced English/Arabic PNGs.

No application database was reset. Test and browser fixtures use generated allowlisted loopback databases and remove only their own databases. No push, merge, deployment, or GitHub release-gate claim is part of this review.

Architecture consistency and whitespace checks passed. The architecture map still contains its pre-existing CORS note; this review did not change that behavior.
