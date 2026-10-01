# Recipe ledger — performance and maintainability review

Implementation status: the findings below were addressed in the [measured performance fixes](2026-09-06-recipe-ledger-performance-fixes.md). This document retains the original observations and baseline.

Reviewed application: `dfb5262d`, following Phases 1–3. Measurements were taken on September 6, 2026, before the interruption; on resumption the application commit and tracked backend/frontend content were verified unchanged. This is a review with reproducible evidence, not an implementation or production performance signoff.

**Conclusion: there are confirmed avoidable regressions.** The ledger does not discard all the previous optimizations: checkout still batches ordinary lines, the shared connection pool is retained, and recipe writes stay inside the existing transaction. However, the disabled checkout budget is broken, the enabled path repeats work, and one correctness fallback can lock unrelated ingredients. Address these before the combined Phase 4 acceptance review.

The earlier correctness reviews did not include the existing checkout performance contract. That was a verification gap: passing functional regressions did not establish performance parity.

## Checkout: comparison with the earlier optimization

The [earlier checkout plan](../superpowers/plans/2026-08-28-checkout-safe-performance-refactor.md) set the ordinary cash checkout budget at 15 database protocol commands, including transaction controls and post-commit fiscal preparation. The feature was added after that optimization.

| Ordinary cash sale, stock/fiscal off | One line | Ten lines |
|---|---:|---:|
| Before ledger, `74820d4b` | 15 | 15 |
| Current, ledger disabled | 16 | 16 |
| Current, ledger enabled, no recipe | 19 | 19 |
| Current, ledger enabled, recipe present | 23 | 23 |

These are command counts, not latency percentages. The existing [checkout performance contract](../../backend/tests/integration/checkoutPerformanceContract.test.js) passed **8/8** against pre-ledger application source loaded without switching the checkout. It passed **5/8** against current code: one-line, ten-line and tracked-stock command-budget cases fail. The tracked-stock main query count increased from 14 to 15 as well. Current one/ten-line measurements used eight warmed samples per scenario; local medians were approximately 5.5–7.6ms. Loopback timing cannot quantify Hostinger network latency or concurrent checkout throughput.

Both current checkout modes leased and released two connections per request, including fiscal preparation. No unreleased lease appeared in these measurements. This is not a production pool-load test.

## Prioritized findings

### P1 — an empty saved composition can lock every ingredient

[RecipeLedgerService.js:218–243](../../backend/services/RecipeLedgerService.js) discovers ingredients from movement rows. A saved line with an empty composition has a key but no movement rows. The fallback at line 237 therefore executes:

```sql
SELECT id FROM ingredients ORDER BY id FOR UPDATE
```

A two-connection service probe held the transaction for such a saved line, then attempted to lock an unrelated ingredient. The second operation failed with `ER_LOCK_WAIT_TIMEOUT`. This is demonstrated contention, not merely an optimizer concern. A busy system can serialize work that has no ingredient in common.

This fallback was introduced in Phase 2 to preserve correctness when an older transaction snapshot cannot see a committed composition. Removing the lock alone would reintroduce that failure. The correction must distinguish a known empty saved composition from an invisible composition, avoid unnecessary synchronization of unchanged saved lines where authoritative context permits it, and retain the concurrent refund/Count regressions. This is the highest-risk part of the cleanup and deserves its own focused design and proof.

### P2 — repeated work on the checkout path

[OrderPricing.js:58](../../backend/services/OrderPricing.js) already loads `recipe_ledger_enabled`. [RecipeLedgerService.js:377](../../backend/services/RecipeLedgerService.js) reads it again when checkout calls the ledger. This explains the disabled-path regression exactly.

The enabled one-line trace also contains:

- A movement-reference lookup for newly minted keys whose nonexistence is already known.
- One ingredient lock selecting only IDs, followed by another ingredient lock selecting IDs/costs.
- A full inserted-movement readback even though synchronization callers use only the written count and changed ingredient IDs.
- Current bundle/recipe loading for all supplied lines, even on unchanged saved lines whose composition must remain frozen.

Restore the existing disabled-path budget first. Reuse transaction-local settings and loaded ingredient metadata, resolve current composition only for new lines, and keep detailed movement readback where the response actually needs it. Do not add a cross-request settings/composition cache or discard necessary current reads.

An unchanged one-line table save measured 24 commands, including six ledger queries despite writing no movement. Not all six are removable: synchronization still needs authoritative state where lines have changed or share usage.

### P2 — the day report computes and transfers much more than it uses

[RecipeLedgerService.js:888](../../backend/services/RecipeLedgerService.js) selects every movement column for the selected date and aggregates them in JavaScript. At line 952 it builds the entire Daily Summary to read only `summary.sales_collected`.

On the stress fixture, the route issued **28 commands** and transferred **100,000 movement rows** for a report with 102 ingredient rows. Of those commands, 23 came from the full sales-summary builder, including prior-period comparisons, expenses, subscriptions, platform reconciliation, hourly sales and shift state. The local median was approximately 307ms over three measured samples.

Aggregate ingredient flow/cost/reason values in SQL, keeping Count details needed by the existing response contract. Reuse the existing financial metric calculation at a smaller interface instead of building unrelated report sections or duplicating financial formulas. Retain the consistent read transaction added in Phase 3; shortening its work also shortens its connection occupancy.

### P2 — realtime events multiply full summary requests

[Ingredients.vue:172](../../src/admin/pages/Ingredients.vue) starts a new GET on every notification, even when a previous request is running. Its sequence counter protects the rendered result but does not stop server-side work. Local saves also reload through both the saved callback and the socket event.

The actual browser measured:

- One ingredient save → **two** full list GETs.
- Ten committed receipt events while the first GET was held → **ten** outstanding list GETs.

Use one in-flight refresh plus a pending-refresh flag so a burst produces a bounded follow-up and the latest event is not lost. Coalesce the local-save and socket refresh paths. Aborting old requests alone is insufficient to guarantee that database work stops.

### P2 — opening counts contain an N+1 read pattern

[RecipeLedgerService.js:564](../../backend/services/RecipeLedgerService.js) locks/reads each ingredient sequentially, then the insert helper reads those ingredients again. Measured service query counts, excluding caller transaction/audit commands:

| Opening ingredients | Queries |
|---:|---:|
| 1 | 5 |
| 10 | 14 |
| 100 | 104 |

Batch the ingredient read in sorted ID order and reuse it for validation/costs. Keep the opening operation atomic and preserve replay payload validation. This is less urgent than checkout contention, but it is a straightforward round-trip reduction.

### P2 — summary cost depends on movement volume since the latest Count

The summary query now uses an indexed latest-Count lookup and returns one row per ingredient. Phase 1 removed the former whole-history transfer. However, the remaining post-Count sum still scans the relevant movement interval.

With 100 generated ingredients, approximately 100,000 historical movements and 1,000 movements on the selected day:

| State | Local summary median, five samples |
|---|---:|
| Old Counts, long post-Count intervals | 124.1ms |
| Recent Counts, same history and daily workload | 8.1ms |

The 100,000-movements-on-one-day stress profile measured 277.8ms. It is deliberately a stress case, not a statement about the restaurant's actual daily volume. `ANALYZE FORMAT=JSON` confirms the old-Count tail scans: 100 loops with approximately 1,000 rows each. History paging remained bounded in returned rows: the 50-row page used three queries and measured about 2.2ms on a 1,000-movement ingredient.

Coalescing refreshes and avoiding full summaries for unrelated purposes are the first fixes. A persisted balance projection may eventually be justified by measured production volume, but adding one now would introduce another consistency responsibility. Counting stock must remain a real business action, not a required performance workaround.

## Duplication, overengineering and future editability

The ledger is **not broadly overengineered**. Stable saved-line identity, original cost snapshots, exact fractional reversals, idempotency and lock ordering all protect demonstrated failures. Do not remove them merely to shorten the code. Keeping one transaction owner and batching append operations are sound choices. No additional runtime dependency, worker, queue, database pool or background projection was introduced by the feature.

The concrete simplicity opportunities are smaller:

- `src/admin/components/IngredientFormModal.vue:L60`, `IngredientMovementModal.vue:L57`, `IngredientOpeningModal.vue:L28`, `src/admin/pages/Ingredients.vue:L105`, `ReportsIngredients.vue:L100`, `src/print/ingredientReportPresentation.js:L1`: **shrink:** repeated unit tables and conversions. Replace with one small pure presentation utility; preserve form-specific blank/null handling locally.
- `backend/services/RecipeLedgerService.js:L248`: **delete:** unused non-current mode of `loadRecorded`; both production callers require current reads. Keep one private implementation with the required locking behavior.
- `backend/services/RecipeLedgerService.js:L977`: **shrink:** internal context/record loading helpers exposed as public exports despite no external caller. Keep them private and make the supported interface easier to identify.

For the mechanical duplication cleanup only, estimated **net: -30 lines possible.** This is an estimate, not a reason to chase a line-count target. Performance/locking changes are separate from that count.

Future edits currently require understanding unit conversion in several Vue/print files and understanding unrelated reporting code inside the transaction service. Centralize unit rules first. Keep the transaction service's caller contract explicit: transaction ownership, current-read behavior, frozen composition, idempotency and post-commit notification. Consider moving report implementation behind a small read interface when performing the measured report cleanup; do not introduce repository layers, generic transaction frameworks, or split files solely because the service is long.

## Suggested implementation order and acceptance

1. Restore the disabled checkout contract without increasing its expected budget. Remove proven duplicate work on new-line and unchanged-line paths; measure the enabled budget explicitly.
2. Resolve the broad empty-composition lock with concurrent saved-line, split-refund and Count proofs. Do not simply delete the correctness guard.
3. Bound UI refreshes, narrow recipe-picker/portions reads, and reduce report aggregation/financial work while preserving response and accounting semantics.
4. Batch opening reads and consolidate unit rules. Keep the existing fractional and unit-conversion cases as behavioral checks.
5. Record command ceilings for disabled/enabled checkout, opening batches and bounded browser refreshes; then continue Phase 4 acceptance.

## Evidence and limits

The [compact evidence](../../scripts/reviews/recipe-ledger-performance-summary.json) records measured counts, runtime, source identity and workload limits. Reproduction scripts are [checkout/scaling/locking](../../scripts/reviews/recipe-ledger-performance-review.cjs), [opening batches](../../scripts/reviews/recipe-ledger-performance-opening.cjs), [real browser request counts](../../scripts/reviews/recipe-ledger-performance-browser.py), and [pre-ledger source loader](../../scripts/reviews/recipe-ledger-performance-baseline-preload.cjs). Full SQL traces and MariaDB plans remain in the local raw result file.

All measurements used explicitly named scratch databases and the isolated loopback browser server. Runtime: MariaDB 10.4.32, repeatable-read. The pre-ledger application was loaded from Git into the test process; the shared checkout was not switched or reverted. The resumed review verified unchanged source and reused the measurements instead of repeating unchanged suites. The browser server is no longer running. There was no production access, deployment, performance fix, or business-data repair during this review. No claim is made about production p95, hardware printing, high-concurrency throughput, or current Hostinger pool pressure.
