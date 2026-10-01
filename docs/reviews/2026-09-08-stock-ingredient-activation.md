# Explicit ingredient quantity-ledger activation

Implemented locally on `codex/ingredients-ui-fix`. This completes the operator activation slice for recipe ingredients: durable cutover metadata, a concurrency fence, source-identity provenance, writer redirection, report ownership after the watermark, an admin API, and an Arabic editor panel. It does **not** complete packages A or B–J. No application database was migrated or real ingredient activated; mutations below used generated loopback fixtures and one disposable review database.

## Behavior

- The ingredient editor offers an on-demand Arabic eligibility check. A later physical count is the opening baseline; receipts and usage before that count are not replayed. Unknown stock stays unknown (no invented opening movement). Estimate is the default availability policy so uncounted usage can be recorded; an optional checkbox requires a count before usage (strict).
- Activation locks `stock_enabled` and the ingredient in a caller-owned READ COMMITTED transaction, rechecks the observation token plus open/held recipes, and commits the identity, opening or unknown balance, link, provenance, dirty marker, operation result and audit together. Only admin/programmer access is allowed. Deadlock retry reuses the same intent. Replay uses `stock_operations.request_key` plus a payload hash bound to ingredient, token, policy and actor.
- Preflight blocks disabled stock tracking, inactive ingredients, orphaned existing identities, unresolved table recipes (frozen `recipe_ledger_lines` first, then current/bundle recipes) and held/split carts, including malformed JSON. This is rechecked under the ingredient lock; a GET preview alone is not a fence.
- After activation, `RecipeLedgerService.insertRows` journals only linked identities in the same transaction. Provenance is keyed by source type/id/line, not reconstructed movement IDs (`readBack:false` paths included). Pre-count receipt/waste corrections do not change current stock. Usage/reversal/receipt/waste/count map onto the quantity ledger. `source_type=void` is not treated as an invoice when dirtying report scopes.
- Report fact streaming skips linked `ingredient_movements` after the stored watermark and skips stock movements whose source kind is `ingredient_cutover`, so an opening baseline is not counted as a day's receipt.
- The UI persists the original request key in session storage before POST, retains it on uncertain errors, and allows confirmation after reopening. Definite 409 conflicts refresh eligibility before a new attempt. The ingredients list shows a “Quantity ledger” badge. Controls use the product ink palette, not teal.

## Schema

Migration `2026-09-08-stock-ingredient-cutover-v1` adds `stock_ingredient_links` and `stock_operation_sources`. It does not foreign-key `ingredient_id` to `ingredients`, matching `stock_items.legacy_ingredient_id`: recipe-ledger tables are applied by later automatic migrations and are absent from the July 29 baseline load. Links still foreign-key stock items and operations. Ledger checksum is the SHA-256 of the migration name; the automatic SQL SHA-256 is `78e3387d13c6875cddca6bbc4fc9482daa76d8cb275f1b0e9e434ceb3fff8708`. Predecessor is `2026-09-08-stock-availability-policy-v1`.

## Verification

- `stockIngredientActivation.test.js`: **4 passed**. Concurrent duplicate request, single opening/audit/provenance, stale observation, cashier 403, unknown estimate waste to a negative unknown balance, fact stream without opening/cutover double-count, open table and held blockers, checkout usage after a count, and a pre-count receipt correction that does not change stock (`40` opening − `10` sale = `30`).
- `stockIngredientCutoverMigration.test.js`: **2 passed**. Predecessor upgrade, preserved stock identity, rerun no-op, fail-closed missing/conflicting predecessor and required schema.
- Existing ingredient preflight and product activation: `stockIngredientOpening`, `stockIngredientOrders`, `stockIngredientHeld`, `stockActivation` passed in the same isolated process as the first green post-fix run.
- `stockAvailabilityMigration`, `stockReportFactsMigration`, `stockReportGenerationMigration`: passed after successor cleanup of the new tables.
- `schemaAuthority.test.js` and `unit/automaticMigrations.test.js`: passed, including Hostinger fallback byte parity.
- `integration/automaticMigrations.test.js`: **12 passed** on a clean `posapp_auto_migration_test` (not in parallel with a leftover failed run).
- Frontend: `ingredientActivationPanel`, `ingredientSetupHistory`, `ingredientsPage`, `i18nCatalog` — **19 passed**. `npm run build:admin` passed. Architecture generation/check passed with 254 nodes, 71 flows, and the existing one recorded architecture defect.

These are focused results, not a full backend suite or low-end certification.

Visible in-app browser against `scripts/reviews/recipe-ledger-phase3-browser-server.cjs` on loopback 3013 with a fresh `posapp_review_recipe_p1_*` fixture (not application data): Arabic RTL login as Test Admin, create ingredient **دجاج**, enable the quantity ledger while still uncounted (estimate), then receive **10 kg**. The list showed the **سجل الكمية** badge, today's incoming **10**, and expected remaining still **—**. Independent SQL on that fixture showed `stock_operations` `activation` then `receipt`, provenance `ingredient_cutover` plus `ingredient_manual`, stock movement `10000.000000` g with `establishes_known=0`, and `quantity_known=0` on the balance. At **390×844** the same row rendered as a stacked card with those values. Screenshots were saved only as local review artifacts.

## Measured costs

No new million-row or 2-CPU/4-GiB run was collected for this slice. Writer journaling adds one link lookup plus stock posting inside the existing recipe-ledger transaction after ingredient locks; it does not claim a CPU saving. The 205-line held preflight still only proves SQL call count. Use the existing `scripts/reviews/stock-*.cjs` harnesses rather than a new one.

## Remaining scope

Package A still lacks general resolved compositions/shared physical stock, original-stock returns after mapping changes, and a complete writer registry. Package B still lacks production invalidation on every source transaction, worker initialization/scheduling, a published-fact reader/API, freshness UI, bounded working-list switch, and barcode/attention/location projections. Packages C–J remain unimplemented. No application data was migrated or deployed.
