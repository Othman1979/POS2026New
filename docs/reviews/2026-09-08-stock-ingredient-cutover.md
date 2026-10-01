# Ingredient cutover evidence

The internal `StockActivationService.readIngredientOpening` reader prepares exact opening evidence for ingredient authority migration. It does not activate ingredients or redirect their writers yet.

The caller owns a transaction and takes any source/product locks first. The reader locks the ingredient identity, reads the latest physical count with a current locking read, then aggregates only subsequent applicable movements using SQL decimal arithmetic. It returns the latest movement watermark as a string. Corrections to entries preceding the latest physical count do not change that observed baseline. Corrections to later entries still change expected stock.

No count returns an unknown quantity and a separately identified running delta. An explicit zero count is known zero. Known expected stock may be negative, but a balance exceeding the quantity ledger's supported range rejects cutover instead of truncating it. Quantity and movement IDs do not pass through binary-number accumulation.

The reader also returns an observation token bound to ingredient identity/state, latest count, movement watermark and exact quantities. A receipt and issue that cancel each other still change the token. This supplies the evidence a later activation command must compare under the same locks; it is not authorization by itself.

Five initial behavioral tests failed because the opening reader did not exist. Eight integration cases cover unknown/zero, successive counts and late corrections, six-place precision at large quantities, an older repeatable-read snapshot, invalid/missing identities, retained writer locks, range overflow, and observation changes despite unchanged balances. The observation case also failed before the token was implemented. The existing product activation tests run alongside these checks. Results: `scratch/stock-ingredient-opening-verification.json`.

This is not a performance benchmark or completed activation flow. Ingredient source adapters, durable cutover metadata/replay, unresolved-order preflight, activation API/UI and report source ownership still need integration. No application database or real ingredient authority was changed.

## Unresolved table-order preflight

`findIngredientOpenOrder` identifies the first unsettled table invoice that prevents ingredient cutover. It uses frozen `recipe_ledger_lines` identities when available, including explicit empty compositions. A missing referenced frozen record fails closed. Legacy lines without a frozen identity are checked against current direct recipes or bundle-member recipes; an explicit bundle recipe overrides its members, matching the current recipe resolver. Paid and voided invoices are not unresolved table orders.

Five scratch integration cases cover changed recipes, settled invoices, frozen empty compositions, legacy direct recipes, missing frozen records and bundle overrides. Together with opening-evidence tests, 13 cases pass in `scratch/stock-ingredient-cutover-verification.json`. This read-only result must be rechecked inside the eventual activation transaction under its source/catalog fence; it is not a concurrency fence itself. Held/split payload inspection and activation integration remain required. No claim of bounded preflight latency is made without measuring the unresolved-order query at scale.

## Held and split payload inspection

The internal `findIngredientHeldOrder` scans held identities in 25-row keyset pages. Both array carts and object carts with `items` are accepted. Frozen `recipe_line_key` compositions take precedence over current recipes, preserving an explicit empty composition and identifying a split line whose product recipe has changed. Missing/malformed frozen records or unreadable cart shapes return an explicit blocker. Current legacy lines resolve direct or bundle-member recipes.

The initial eight isolated cases passed in `scratch/stock-ingredient-held-green.json`; the preceding RED run failed because this reader did not exist. Cases include both cart shapes, frozen empty/changed recipes, malformed JSON, missing references, invalid lines and a matching hold beyond the first page.

Recipe lookups now use batches of at most 100 cart lines, deduplicating their frozen keys and legacy product IDs. A 205-line nonmatching cart executes five SQL calls total: two held-page reads and three recipe lookups. A matching ingredient in its final batch is still found. The final combined opening/open-order/held-order run passes 22 tests (`scratch/stock-ingredient-preflight-final.json`). This verifies query count, not latency or CPU/RAM savings. Large-backlog measurements are still required before exposing activation. A row-page bound alone is not a byte or execution-time bound. The caller still needs the activation concurrency fence and recheck. No source writer, public activation route or real ingredient was changed.
