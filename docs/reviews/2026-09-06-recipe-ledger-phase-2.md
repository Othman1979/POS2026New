# Recipe ledger Phase 2 review and corrections — Tasks 5–8

Phase 2 reviewed table save and checkout, splits and merges, refunds and voids, subscription redemptions, and catalog/settings integration against the current [recipe ledger plan](../superpowers/plans/2026-09-05-recipe-ledger.md). The reviewed baseline was `50cebe3f`, including the completed Phase 1 corrections.

Seven defects were reproduced and corrected. The final adversarial test file run against the original application source produced **12 failed assertions and 7 passing controls** across 19 tests. The failures below were observed through real HTTP handlers and a local database, with direct transaction tests for stale snapshots. They are not inferred from source inspection alone.

## Findings and corrections

| ID | Reproduction and observed baseline result | Correction |
| --- | --- | --- |
| F1 | Sell 200 g at 0.0045 per gram, change the ingredient cost to 0.009, then refund. The reversal used 0.009. An originally unknown cost also became 0.009. Growing a saved line across two cost changes and fully refunding left a net ingredient cost of +0.90 despite zero quantity. | [RecipeLedgerService.js](../../backend/services/RecipeLedgerService.js:249) retains outstanding quantities by usage cost. Reversals unwind the newest outstanding cost first and preserve explicit null costs. Each component carries the product-quantity change only once, including when a reversal spans multiple costs. Full refunds leave both quantity and known cost at zero. |
| F2 | Save one burger using 200 g; split it into three submitted thirds, settle all children, then refund each child's entire stored quantity. Three quantities of 0.333333 left product quantity 0.000001 and ingredient quantity -0.0002. | [splitChecks.js](../../backend/modules/tables/splitChecks.js:748) apportions the parent's six-place integer quantity across identified children before money allocation. Their stored quantities add back to the parent exactly. |
| F3 | Save two separate one-unit lines of the same product. Submit two split seats that both name the first saved item ID. Aggregate product quantity matched, so the request returned 200 even though it allocated two units from a one-unit identity. | The same split validation checks quantity against each identified parent, rejecting over-allocation and missing identified quantities. Rejection leaves no held checks. Legacy fallback splits retain the plan's existing null-key behavior. |
| F4 | Resave a one-unit table line twice in one cart using the same saved item ID. The server returned 200 and duplicated its recipe identity. | [SavedOrderLines.js](../../backend/modules/orders/SavedOrderLines.js:172) permits each saved table item ID to be claimed once. The duplicate request is rejected without changing the ledger. Checkout already rejected duplicate IDs and remains a passing control. |
| F5 | Save a burger at a 200 g recipe; add another line after changing the recipe to 250 g; resave both without their saved IDs. Matching financial fields hid the distinct frozen identities, and the request returned 200. | Fallback matching in [SavedOrderLines.js](../../backend/modules/orders/SavedOrderLines.js:119) includes recipe identity. Ambiguous identities require the saved IDs; the table request returns 409 and leaves the original -450 g intact. |
| F6 | Refund two half-unit children sharing a tiny component, including simultaneous HTTP refunds. Both succeeded but left -0.000001 ingredient quantity. A caller snapshot predating the initial usage also missed the composition completely and left -200 g after reversal. | [RecipeLedgerService.js](../../backend/services/RecipeLedgerService.js:218) locks the involved ingredients before current reads of the shared pool. Callers batch their requested reversals through `reverseLinesUsage`, preserving ingredient-before-movement lock order across all affected lines. Both concurrent child refunds and old-snapshot cases now finish at zero. |
| F7 | Reject `recipe_ledger_toggled` audit inserts with a database trigger, then submit a settings batch. HTTP returned 500, but the toggle and another setting were already persisted. Two simultaneous identical enables also wrote two 0-to-1 audits. | [system.js](../../backend/routes/system.js:227) locks the toggle, writes the entire settings batch, and records the actual transition in one transaction. Audit failure rolls everything back; simultaneous identical enables both succeed with exactly one transition audit. |

The refund, open-table void, redemption reversal, and legacy checkout cleanup callers use the batch reversal boundary. The service still never commits or emits. Each caller emits ingredient changes only after its transaction commits.

## Additional controls

The new [Phase 2 regression file](../../backend/tests/integration/recipeLedgerPhase2Regression.test.js) also verifies:

- Merge a legacy null-key line with a tracked line; resave, settle, and refund both independently without inventing historical usage.
- Keep an empty saved composition frozen after a recipe is added and the saved quantity grows.
- Void tracked usage while the feature is disabled, then add a new null-key line without charging ingredients.
- Rewrite a split board into three children; discard submitted forged keys and prices, preserve the server-owned key, settle the current revisions, and refund all quantities exactly.
- Allow new usage for a different ingredient while another ingredient transaction is still open.
- Inject a usage-insert failure and verify rollback of the order, table assignment, product stock, and ledger, with no ingredient event.
- Reverse a subscription redemption after both disabling the feature and changing ingredient cost; preserve the original cost and `redemption` source, and make replay write nothing further.

Existing integration checks also cover category copying to genuinely different product IDs, catalog replacement returning 409 before deleting a recipe-bearing catalog, persistence and validation of the toggle, and operational reset preserving ingredients, recipes, and movements.

## Verification

All **763 distinct tests across 35 files** are verified passing, including all 19 Phase 2 adversarial tests and the 10 Phase 1 regression cases.

The broad run passed 762 tests in 623 seconds and exposed one maintenance-test assertion that compared session IDs in unspecified SQL row order. An isolated rerun reproduced the same two IDs in the opposite order. Sorting both ID lists preserves the intended session-preservation assertion; all 10 maintenance tests then passed. No application code changed after the broad run started, so the other 34 files were not unnecessarily rerun. The [compact verification record](../../scripts/reviews/recipe-ledger-phase2-verification.json) lists every file, the RED cases, both verification runs, and the tested source hashes.

The broad coverage includes table and checkout flows, bundles, refunds and refund reports, settlement and post-commit behavior, subscription management/purchases/redemptions/collections/plans, platform held settlement, category copy, products/import, maintenance reset, settings validation and role checks, recipe service/admin/report integrations, and the relevant saved-line, split, arithmetic, stock, and module-wiring unit tests. `git diff --check` and syntax checks passed.

The [baseline preload](../../scripts/reviews/recipe-ledger-phase2-baseline-preload.cjs) loads only the eight reviewed application files from `50cebe3f` for the RED run, leaving the shared checkout intact. The regular isolation preload runs the same tests against the corrected source. Both use newly named scratch databases and the existing fixture; machine environment files, the business database, and the existing test database are untouched.

`npm run architecture` regenerated the affected map; `npm run architecture:check` passed with 231 nodes, 65 flows, and all 172 referenced files present.

## Boundaries and remaining work

The normal locking path uses the frozen ingredient IDs. If a caller's snapshot cannot see an existing key's initial composition, the service conservatively locks all ingredient master rows before reading current movement rows. Saved empty compositions take the same path. This can temporarily serialize otherwise unrelated ingredient writes in that case; this review does not claim a production throughput benchmark.

Cost reversal uses newest outstanding cost buckets first. Original null costs remain unknown. Existing historical ledger rows are not rewritten, so this change does not repair any already persisted residues or wrong-cost reversals. Legacy split requests without parent IDs still receive null keys, as explicitly specified by the current plan.

Verification here uses the actual backend HTTP flows and local MariaDB, not a browser or production database. No schema changes, deployment, push, or merge occurred. Phase 3 (Tasks 9–12: admin API, Ingredients UI, Recipe UI, and day report) and the final combined browser phase remain separate work.
