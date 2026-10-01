# Recipe ledger performance fixes

Implemented after the [performance review](2026-09-06-recipe-ledger-performance-maintainability.md), against parent `dfb5262d`. The fixes reduce checkout round trips, unrelated ingredient locks, report work, opening-count queries, and browser refresh amplification. All measurements below are local scratch-database results on MariaDB 10.4.32, not a production throughput claim.

## Measured results

| Operation | Before | Verified after |
|---|---:|---:|
| Checkout, recipes disabled, 1 or 10 lines | 16 commands | 15 commands |
| Checkout, enabled with no recipe, 1 or 10 lines | 19 commands | 18 commands |
| Checkout, recipe present, 1 or 10 lines | 23 commands | 20 commands |
| Unchanged table save | 24 commands | 21 commands |
| Opening count, 1 / 10 / 100 ingredients | 5 / 14 / 104 service queries | 4 / 4 / 4 |
| Large ingredient day report | 28 commands | 12 commands |
| Rows transferred across that report | 100,117 | 207 |
| Local median for that report | 307.2 ms | 98.5 ms |
| Summary, 100 ingredients and 100k daily movements | 277.8 ms | 137.4 ms |
| Summary, 100k history / 1k today / old Counts | 124.1 ms | 52.5 ms |
| Same history and daily volume, latest movements are Counts | 8.1 ms | 2.1 ms |
| One ingredient save in the browser | 2 list GETs | 1 list GET |
| Ten receipt events with the first GET held | 10 outstanding GETs | 1 active GET, then 1 follow-up |

Checkout command counts include transaction controls and fiscal preparation. Opening counts exclude the caller's transaction and audit commands. Checkout measurements use eight warmed samples; summary reads use five; day reports use three. Opening query counts are deterministic single-transaction probes. The report fixture has 100 generated ingredients and 100,000 usage rows, plus the two ingredients used by the checkout scenarios.

The picker now uses one master-data query. Portions read only ingredients referenced by the selected product, or by active recipes for the global portions view. In the stress fixture, the relevant recipe has one ingredient: portions read two rows across two queries and measured about 0.4–0.5 ms. The earlier portions probe used a different current business date, so its timing is not treated as a direct latency comparison.

## Changes and correctness boundaries

- **Checkout:** pass the settings already loaded in the transaction; resolve current recipes only for new lines; reuse locked ingredient costs; return counts and changed IDs without fetching inserted movement rows again. Manual operations still return the detailed rows their responses need.
- **Locking:** `recipe_ledger_lines` records each line's immutable ingredient IDs, including `[]`. Saved-line operations lock that record with a current read, then lock only its ingredients before reading remaining usage. Frozen quantities and original costs remain in `ingredient_movements`. This replaces the whole-ingredient-table fallback while retaining correctness with older transaction snapshots and shared split/refund keys. A missing saved-line record fails explicitly.
- **Reads:** replace two existing movement indexes with covering balance/day indexes. Pin history balance scans to the balance index so stale cardinality estimates cannot choose the narrow Count index and fetch every full movement row. When the latest movement is the latest Count, the summary returns that Count directly. Shopping and portions share the balance expression and omit daily aggregates.
- **Reports:** aggregate flows and costs in SQL and fetch Count details separately. Reuse the existing financial-event metric functions for net collected sales. Preserve the route's read-only repeatable-read transaction. Costs are summed before eight-decimal rounding, matching the Ingredients summary; a regression test catches the former fractional-cost discrepancy and verifies full cancellation on reversal.
- **Opening counts:** validate and lock all ingredients in one sorted batch and reuse those costs for insertion, preserving replay checks and all-or-nothing behavior.
- **Browser:** coalesce save callbacks and socket notifications, allow one request at a time, and retain one pending refresh. Discard stale responses after filter changes and cancel scheduled work on unmount. Shared presentation conversions keep form-specific blank/null handling in the forms.

Two indexes are replaced, so the number of movement indexes is unchanged. Their wider entries trade storage and index-write work for faster reads. The new line table adds one small persistent record per tracked line. Balances still derive from movement history; these changes do not make unlimited history constant-time or require operational Counts as a performance workaround.

## Verification

**158 unique automated cases passed** across the focused runs and corrections. This includes all existing recipe-ledger integration cases, the original eight checkout performance cases, four new enabled-checkout budgets, migration-chain checks, and affected UI/pure checks. The six new performance cases cover unrelated-ingredient contention, fractional report costs, missing saved-line records, a real partial-refund/report flow, restricted portions/picker reads, and atomic 100-ingredient opening counts.

**14 browser cases passed**, plus the measured refresh-burst/filter case. Affected recipe-editor and shopping cases were repeated after narrowing those reads. Coverage includes unit changes, unknown/blank Counts, opening retry after a lost response, history pagination/stale responses, Arabic mobile layout, and A4/thermal report rendering. The build and architecture generation/check passed.

The real checkout/refund/report case verifies collected sales of 11.6, used cost of 1.8 at original usage costs, distinct waste reasons, two Count records, variance, and closing stock. Its collected-sales result agrees with the existing full Daily Summary.

The [forward migration](../../backend/migrations/2026-09-06-recipe-ledger-performance-v1.auto.sql) was applied to the exact predecessor fixture from Git. The upgrade preserved all 503 seeded movement rows and backfilled empty, composed, fully reversed, removed, and 500-ingredient line records. Direct repeat and runner no-op passed; missing-predecessor and conflicting-checksum checks failed closed. The normal SQL, automatic SQL, manifest hash, and cumulative manual fallback were verified together. A MariaDB 10.4 empty-JSON-array/UNION issue found during this check was corrected by using the explicit `[]` JSON text.

The full migration-chain tests were extended for the new entry. Existing migration fixtures now use a parameterized ledger-name list and select predecessors by name instead of offsets from the end of the manifest. One full-chain repair case exceeded the default 30-second test timeout and passed when rerun with a 60-second allowance; no assertion was weakened.

Deployment order matters for the new line record: drain previous-version ledger writers, apply the backfill, then start the updated application. If the previous application version is later run again, rerun the idempotent backfill before returning to this version so any lines it created also have records. Rolling-version deployment compatibility was not tested.

## Evidence and reproduction

The [verification record](../../scripts/reviews/recipe-ledger-performance-verification.json) contains before/after counts, timings, test-file totals, browser evidence, migration outcomes, workload limits, and source SHA-256 values. The [original compact review evidence](../../scripts/reviews/recipe-ledger-performance-summary.json) preserves the original baseline.

Reproduction uses the existing isolated database preload and a fresh `POSAPP_REVIEW_DB` matching `posapp_review_recipe_p1_<12 hex digits>`:

- [Checkout, lock, and scaling measurements](../../scripts/reviews/recipe-ledger-performance-review.cjs), then [opening-count measurements](../../scripts/reviews/recipe-ledger-performance-opening.cjs). Both accept `POSAPP_PERFORMANCE_OUTPUT` for a separate result filename.
- [Exact-predecessor migration verification](../../scripts/reviews/recipe-ledger-performance-migration.cjs).
- [Browser refresh measurements](../../scripts/reviews/recipe-ledger-performance-browser.py) against the isolated loopback review server on port 3013; existing browser cases use `recipe-ledger-phase3-browser.py`.
- `vitest run recipeLedger checkoutPerformanceContract ingredientsPage reportsIngredients productRecipeEditor automaticMigrations --testTimeout=60000`, under the isolated preload. The migration-chain integration file separately creates and removes its explicitly named `posapp_auto_migration_test` database.

Raw traces, candidate-index experiments, and intermediate test outputs remain local. No production database, deployment, physical printer, or Hostinger concurrency test was involved. No dependency or environment-file changes were made.
