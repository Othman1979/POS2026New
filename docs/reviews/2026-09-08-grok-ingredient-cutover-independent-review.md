# Independent review of ingredient cutover at 27fd9a94

Verdict: changes required before accepting this slice or proceeding to B integration. This review does not claim exhaustive coverage of the full inventory plan.

## Fix verification

The three findings below are retained as the original review evidence and have now been corrected. Each successful legacy bulk insertion supplies its actual first insertion ID as an occurrence identity (without inferring individual consecutive row IDs). Operation keys include that occurrence, so repeated legitimate deltas differ; legacy source replay still avoids another insertion. Physical quantities are aggregated with fixed-point arithmetic within each bounded chunk, while provenance retains every original source row. Completed ledger replay does not insert provenance a second time. Zero quantity metadata-only usage does not create an invalid issue. Count/version reads use current locking reads.

The baseline manifest now matches the actual normalized SQL, and its table-count assertion includes both new cutover tables (70 total). The combined activation/installer/cutover-migration run passed **14/14**, including both original regressions, an actual HTTP shared-ingredient table sequence with quantities 1, 2, 2, 3, 3, and a real scratch database bootstrap through runtime schema validation. Evidence: `scratch/grok-cutover-fixed-verification.json`. Architecture generation/check also passes. These results do not certify full A+B performance or close the broader plan.

The existing recipe service, table and reversal regression files also pass **13/13** (`scratch/grok-cutover-legacy-regressions.json`). No frontend behavior changed in this fix; no UI redesign or low-end performance claim is made.

## Original reproduced blockers (now fixed)

1. `StockIngredientAdapter.js` passes individual ingredient rows directly into `ledger.post`. Two different meal lines consuming the same activated ingredient produce repeated stock keys; posting fails with `Combine repeated stock keys before posting.` The regression exercises `RecipeLedgerService.syncOrderLines` inside a real transaction and expects a combined -30 g result. Aggregate quantities by physical key while preserving every source's provenance; do not discard a meal line or weaken the ledger's duplicate-key invariant.

2. `requestKey` identifies usage through its delta and saved line/source, without a unique occurrence/version. Increasing a saved recipe line from quantity 1 to 2 to 3 generates identical -10 g requests. The second increase replays the original operation and then `recordSources` fails with a duplicate operation/ordinal primary key. A saved-line identity is not a mutation identity. Establish durable occurrence identity that distinguishes legitimate repeated edits and still recognizes network retry. Do not fix only the duplicate insert by ignoring it: that would silently lose stock usage.

3. `deployment/database/baseline.sql` changed without updating `deployment/database/manifest.json`. Calling the actual `readVerifiedBaseline()` fails with `Fresh database baseline checksum mismatch.` Declared hash: `b179c26e198924368f5853bd0a5d416ad0683c57a5268e45e5aae6aeade702d6`; actual normalized hash: `3946521d67c77f503a67f22498939aeb159478bd08714fa49df0dda648005e38`. Verify fresh installation through its real bootstrap after correcting the manifest; passing automatic migration tests does not cover this path.

## Reproduction

Two new behavioral regression tests are retained in `backend/tests/integration/stockIngredientActivation.test.js`, prefixed `independent review`. Run:

```
npm run test:isolated -- backend/tests/integration/stockIngredientActivation.test.js -t "independent review"
node -e "require('./deployment/tools/bootstrap-database').readVerifiedBaseline()"
```

Both new behavioral tests failed against the reviewed commit in a generated loopback database. JSON output: `scratch/grok-cutover-independent-review.json`. No application database or production code was modified by the reviewer.

After fixes, retain these regressions, add actual HTTP multi-meal/saved-table-edit coverage, run the cutover and migration checks serially, and verify fresh bootstrap. Then continue B and the remaining contract; this review does not reduce its scope.
