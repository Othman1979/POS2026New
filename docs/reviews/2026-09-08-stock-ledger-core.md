# Stock ledger core — implementation in progress

**Current status: A2 is not complete.** The quantity schema is registered and source-context writers are connected. HTTP linked-product checkout/retry/refund and receipts/counts for reconciled 1:1 packaged links are verified in scratch databases. No activation route exists and no application item has changed authority. Ingredient adapters, general resolved compositions, frozen sale authority and activation preflight still need implementation. B–J remain incomplete. Earlier sections below record the progression from the initially isolated core.

Follow-up: [product snapshots and cutover concurrency](2026-09-08-stock-sale-snapshots.md) records the implemented packaged-product snapshot seam and the core gap-lock fix. The normal 100-line post now uses at most 10 statements. General recipe authority and activation remain incomplete; earlier counts below describe the earlier code.

## Implemented

- Explicit stock items, product links, locations, lots, balances and append-only movements. Database constraints reject invalid measure/unit pairs, conflicting legacy identities, cross-item lot references and duplicate operation lines.
- One real default lot per item; default and virtual in-transit locations. Physical balances start unknown. Transit starts at known zero because it is a virtual location.
- Six-decimal quantity arithmetic using integers, including values beyond JavaScript's safe scaled-number range. SQL/JSON boundaries use decimal strings.
- Internal posting primitive with a 100-line cap, ordered identity/lot/balance locking, durable actor/payload-bound retry identities, observed-version counts, original-operation references and caller-owned rollback.
- Counts can establish an unknown balance, including explicit zero. Receipts do not invent an opening quantity. Ordinary issues cannot consume unknown, insufficient, expired or quarantined stock.
- Transfers conserve quantities per item and lot; source and destination move in the same transaction. No public endpoint accepts arbitrary signed movements.
- Batched reads and writes: the 100-line integration case uses 11 statements within the caller transaction, excluding BEGIN/COMMIT. This is a measured statement bound, not a checkout latency or low-end resource certification.

## Verified

`npm run test:isolated -- backend/tests/integration/stockLedgerCore.test.js backend/tests/integration/stockAdjustments.test.js backend/tests/unit/inventoryService.test.js`

27 tests passed: 13 new core cases and 14 existing adjustment/service cases. Core cases cover exact journal reconciliation; unknown versus zero; simultaneous same-key opening replay; competing last-unit issues; stale counts; rollback; expired/quarantined lot behavior; invalid precision and operation size; cross-item lots and duplicate keys; overflow; repeatable evidence DDL; transfer conservation/rollback; and 100-line posting bounds.

Architecture generation and validation passed. The new nodes are explicitly marked not activated. No application database, machine configuration, deployment or GitHub integration was changed.

## Cutover findings and remaining implementation

Activation remains unavailable because these paths must be integrated and verified first:

1. Checkout, saved-table edits, progressive splits and subscription redemption/reversal must freeze their stock authority and resolved lines. Refunding an old invoice must retain its original physical mapping.
2. Existing product adjustments and catalog counts must update the ledger and product compatibility projection atomically. New product/copy/import stock needs explicit opening behavior.
3. Catalog replacement in `backend/routes/admin/import.js` hard-deletes product identities after detaching old order/refund rows. Contrary to the previous architecture convention, ordinary soft deletion is not its only behavior. An active stock link must block replacement; a foreign key now protects that link in the evidence schema, but the route still needs a clear conflict response and concurrency coverage.
4. Recipe publication must reject simultaneous packaged and recipe stock authority for the same sale units. Stock settings must not turn an activated item's authority off.
5. Open/held/split preflight and an opening reconciliation must run before per-item activation. Then register the migration, exact predecessor/checksum, manual fallback, startup floor, fresh baseline and installer changes together.
6. Ingredient adapters and bounded report projections (B) remain required before procurement and the subsequent packages. The remaining C–J contracts have not been replaced by this core primitive.

The core currently blocks ordinary negative issues and unauthorized lot allocation. Later valuation, disposition and recorded-override handlers must add their reviewed policies explicitly; they are not implicitly implemented by accepting an operation kind.

## Follow-up correctness and cleanup

The live product adjustment service now reuses `stockQuantity` instead of maintaining a second decimal parser/formatter. Durable request hashes retain the same canonical six-decimal representation; a regression verifies that `0002.000` and numeric `2` replay one receipt rather than posting twice.

Expired/quarantined stock can now be explicitly disposed of while remaining blocked from ordinary issue. Previously the core applied its issue restriction to waste as well. Unsafe numeric stock references are rejected before SQL, preventing JavaScript integer rounding from selecting a different identity; large identities must arrive as strings.

Focused verification after these changes: 30 tests passed across stock ledger core, stock adjustments and inventory service. The ledger itself remains inactive; this cleanup does not complete its live adapters or any later package.

## Product adapter integration in progress

`StockProductAdapter.journalProductDeltas` now records source-linked movements for the initial immutable 1:1 packaged-product links. The caller must hold the product locks and perform the versioned compatibility write in the same transaction. Before commit, the adapter verifies the resulting product quantity/version against the ledger result. Shared or non-1:1 mappings fail explicitly pending their resolved-composition adapter.

The isolated core suite now passes 17 cases. New database cases prove a 10-to-8 product/ledger update and deliberately break the writer (product deducts three while ledger deducts two): reconciliation rejects the mismatch and rollback restores both quantities to 10. Live writer wiring, frozen authority and activation still follow; the adapter is not exposed as a public action.

The existing `InventoryService` deduction, restoration and order-restock methods now accept the source context and invoke the adapter within the caller's transaction. Deduction carries its locked product version; restoration obtains sorted product locks when journaling. A real service sale/return of 0.217391 units verifies both exact parity and retained invoice/refund source references. A linked product with NULL compatibility stock fails rather than silently bypassing the journal. Existing callers remain on their old path until the schema and source-context rollout is completed together.

Focused service integration verification: 46 tests passed across ledger core, adjustments, inventory service and checkout performance contracts. No additional query is executed on the current no-context checkout path. This is transitional integration, not authority activation: the next required work is production source-context callers, migration registration/startup baseline, count adapters, frozen authority, and the activation preflight/reconciliation. Performance of the activated path still requires measurement.

## Registered schema and production source callers

All product deduction/restoration callers now pass a source type/ID, actor and business date: checkout/edit/settlement, table saves, paid refunds, unpaid voids and subscription redemption/reversal. Refund and void source rows are inserted in the same transaction before stock restoration, allowing movements to reference the actual refund ID. Linked stock cannot be edited through legacy product counts/receipts, catalog replacement, adding a concurrent recipe, or disabling stock tracking. These are temporary explicit rejections pending the corresponding ledger-native actions; no user-facing activation is enabled.

Migration `2026-09-08-stock-ledger-core-v1` follows the exact A1 predecessor. Ledger checksum: `39f4cfdf202f95c4568e9592aa07cd80fd587ea658b0665a92a7ba9e2f5b56a4`. Automatic SQL, verbatim manual fallback, fresh 61-table baseline, bootstrap location seeds and startup authority floor are updated together. Installation creates no product links or inferred opening quantities.

Verified: 110 focused core/adjustment/schema checks; the broader refund/subscription/manifest/checkout run passed 142 cases with one expected query-budget failure. After measuring and updating that exact budget, its focused rerun passed. The linked HTTP, new migration, manifest, fresh installer and checkout run passed 64 cases with the same old total-command assertion; the corrected focused rerun passed. The new migration cases cover exact-predecessor upgrade, no-op, additive partial state and missing/altered predecessor rejection. Fresh installation also executed successfully.

The linked HTTP journey posts a sale, retries its checkout key, and refunds it: product and ledger quantities go 10→9→10 with exactly two source-linked movements. Bypass checks return 409 and preserve both quantities. This is manual linking in a guarded fixture, not proof of a completed activation workflow.

The extra unlinked-product identity lookup was measured with `node scripts/reviews/stock-adjustment-performance.cjs --baseline=48e9ca67 --source-context`. Three alternating rounds of 1,000 timed transactions each had p95 changes 1.492→1.826 ms, 1.658→1.909 ms and 1.636→1.961 ms. Node CPU/call changed 0.281→0.578 ms, 0.359→0.578 ms and 0.453→0.813 ms. Raw evidence: [source-context performance](2026-09-08-stock-source-context-performance.json). The 0.251–0.333 ms latency increase is below the provisional 2 ms allowance, but CPU increased. This is workstation stock-service evidence for the unlinked path, not an activated checkout or low-end certification. The tracked checkout command contract now explicitly requires one stock-link lookup (15 main SQL queries, 18 total captured commands).

The exact July 29 historical upgrade/repair/no-op integration case passed in 91.7 seconds. Its file-level timeout was raised from 90 to 180 seconds; the earlier command-line timeout did not override that file setting. This is migration correctness evidence, not a startup performance improvement. A later focused run passed 87 schema-authority, linked-writer and core-migration checks in 4.86 seconds.

## Linked product receipts and counts

The existing adjustment endpoint now journals receipts and observed-version counts for reconciled immutable 1:1 packaged links. Product locks precede stock identity locks. The ledger computes the movement and resulting quantity, and the same transaction updates the product projection and audit. A mismatched projection fails closed instead of silently reconciling through an unrelated receipt. Raw product PUT remains blocked.

One operation retains both its resolved ledger intent and its original public adjustment result. Retrying a receipt or count after a later adjustment returns that original result without creating a movement; changing quantity under the same key or posting a stale observed count returns 409. Business-date changes do not change the public retry identity. Shared compositions and unknown linked compatibility stock still require the later activation/composition workflow.

The initial focused run passed 13 linked HTTP and existing adjustment cases. Exact fractional receipt/count coverage verifies 10→10.217391→8.123456, with movements +0.217391 and -2.093935; a mismatched ledger rejects without committing either a new movement or a product write.

The subsequent table, split/merge and settlement run passed all 19 regression cases. Four of five expanded linked-writer cases passed; one new assertion incorrectly expected a nested response envelope. After correcting it to the endpoint's flat response shape, all five linked-writer cases passed, including exact original-result replay and simultaneous duplicate/independent receipts (10→13 with two movements).
