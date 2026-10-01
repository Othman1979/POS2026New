# Independent A+B closure review

Reviewed shared branch `codex/ingredients-ui-fix`, based on `efede6a7` plus this closure change. **A+B is accepted for the next local implementation slice under the user's revised gates.** This supersedes this document's earlier incomplete-package status. It does not accept C–J, deploy migrations or certify production hardware.

## Correctness fixes

- All production multi-source transactions use an explicit connection facade. Report scopes collect transaction-locally, deduplicate, sort and flush immediately before the same source commit. Rollback discards scopes; abandoned leases are destroyed. There is no driver monkeypatch or post-commit invalidation window. See the [complete writer registry](2026-09-08-stock-source-writer-registry.md).
- Flat product compositions resolve up to 200 exact six-place physical components. Shared balances are authoritative. Original sale snapshots restore the original components and ratios after remapping, including mixed historical mappings and archived original stock. Ambiguous generalized legacy returns reject rather than guess.
- A real concurrent mixed product/recipe test reproduced a deadlock. Source preparation now locks the union of current and frozen product/recipe physical identities before the first stock post. It reuses fetched product rows and recipe context; ordinary checkout retains its existing query budget.
- Ingredient working balances replace repeated retained-history aggregation. Initialization is batched, uses current locked reads, and advances a bounded identity cursor across idle polls. Linked counts use physical balances, including consumption by another product sharing the ingredient. Before-count corrections preserve count boundaries; rollback leaves journal and projections unchanged.
- Published immutable count intervals and correction provenance replace live comparison history scans. Comparisons spanning backdated counts reconcile to the reference; missing dependent publication is explicitly incomplete. Daily flow/usage facts include physical shared-product activity while excluding duplicate mirrored operations from the operational report dimensions.
- Source discovery has durable per-source checkpoints and bounded reads; request handling does not discover history. The server-owned worker defers under local source transaction pressure and yields/relinquishes connections between bounded work. Generation checks prevent publishing superseded partial builds.
- Current shared-product availability is derived in POS/catalog/barcode, checkout, admin lists, activation inspection and dashboard alerts. Barcode aliases use an uncorrelated lookup. Working-list filters/search/order run on the server; independent receiving/count/waste pickers can find items beyond the loaded page. Missing daily facts remain distinct from zero.
- Historical catalog replacement and operational reset explicitly reject unsafe retained inventory/source history. Finalized invoice edits return 403 for every role. Existing pricing metadata affects future sales; procurement price-only adjustments are a C contract, not a missing mutable-paid-invoice writer.

## Concrete query cuts and bounds

- Opening/count batch processing no longer repeats initialization per line. The real one-versus-100 opening test uses **11 queries** for both sizes; the former 100-line path issued 309. It also verifies rollback and the resulting quantities.
- A warm recipe checkout uses **31 commands for both one and ten lines**, including its durable working projection. This is two more than the earlier 29-command path, not a claim that every path has fewer statements. Prepared source reads are reused to avoid additional duplicate queries. Ordinary stock checkout retains its existing 16-query/19-command contract.
- Stock pages are capped at 100 identities; daily hydration reads published facts, never source movement history. Operation pickers fetch 20 rows and skip daily hydration entirely. No local filter hides rows that should have matched a server continuation page.
- Discovery reads at most 128 rows per source, 512 total per pass; initialization walks 16 ingredient identities per pass. Fact writes and cleanup remain bounded to 500 rows per transaction. These are explicit code/query bounds, not hardware speed promises.

## Verification and corrections

All mutating checks use guarded loopback fixtures. No application database was reseeded or migrated. Evidence files below are local ignored artifacts; test sources are committed and rerunnable.

| Evidence | Result and scope |
| --- | --- |
| `scratch/ab-final-source-regressions.json` | 37-file source-flow selection: **375 passed, one failed**. The only failure was the old worker fact-count expectation, 1504 versus the new 1505 including a daily fact. No source-flow correctness assertion failed. |
| `scratch/ab-final-corrections.json` | **25/25 passed** after correcting that expectation and asserting actual daily usage/cost. Includes all worker tests, working-balance/backfill tests, recipe query-budget tests, inventory unit behavior and idle cursor retention. This closes the broad run's only failure; the broad run itself is not mislabeled green. |
| `scratch/ab-lock-and-query-green.json` | **41/41 passed**: real mixed-source concurrency, resolved/original compositions, shared reads, reset guards, count authority and checkout query budgets. |
| `scratch/ab-daily-query-parity.json` | **108/108 passed**: daily projection, count/reference parity and schema authority. |
| `scratch/ab-daily-projection-initial.json` | **67/67 passed**: package B, working balances and automatic-migration unit contracts/checksum/fallback parity. |
| `scratch/ab-upgrade-read-reset.json` | Automatic migration **12/12** and generation upgrade **3/3** passed. Two unrelated old reset/read expectations failed in this combined run; both were corrected and passed in the 41-test run above. |
| Frontend focused suites | **13/13 passed**; server filtering/continuation, stale request handling, global picker selection and retry/state preservation. |
| `scratch/stock-working-list-browser.json` | Built UI, English desktop and Arabic 390 px: main filter with no matches, receive an ingredient outside the first page, verify committed balance, no page errors or document overflow. |
| Build and architecture | Production admin build, architecture generation/check and diff whitespace check pass. |

The mixed-source RED artifact is `scratch/ab-mixed-stock-locks.json`; the final concurrency regression is in `stockResolvedCompositions.test.js`. Failed historical aggregate runs are not current passing evidence and have not been erased.

## Migrations and rollout boundary

Five ordered forward migrations cover resolved links, discovery checkpoints, published count intervals, working balances and published daily facts. Automatic checksums, manual fallback blocks and schema validation are updated together. Projection migrations withdraw old pointers and revoke obsolete worker claims before rebuilding; reruns are no-ops through the migration ledger. Deploy a single compatible application version during cutover: mixed old/new ingredient writers are unsupported. Preserve machine configuration. Deployment and production reconciliation remain separate authorized operations, not prerequisites to beginning C locally.

## Remaining plan

**No remaining A+B code blocker is identified by this review.** Hardware certification, comparative CPU/RSS/latency gates and the million-movement benchmark were explicitly removed by the user on 2026-09-08. No universal performance guarantee is claimed. Continue bounded-query and real correctness tests when extending these source writers.

Next: **C procurement plus J for C's permissions, imports, Arabic/mobile operation and rollout checks**, following [the execution handoff](2026-09-08-c-and-j-execution-handoff.md). D counts, E recipe versions, F preparation, G locations/lots, H valuation/close and I planning remain separate unimplemented advanced packages. J remains dependent on each future workspace; C's completion must not be called all of J. Accountant/operator acceptance and production rollout are not claimed.
