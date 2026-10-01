# Product stock snapshots and cutover concurrency

Implementation in progress, 2026-09-08. This completes the packaged-product snapshot seam, not the full inventory plan. No application product has been activated; all mutations below used generated loopback fixtures.

## Behavior implemented

- New order and subscription-redemption lines retain the server-resolved product stock authority. Linked lines freeze the stock item, six-place conversion and policy version. Untracked lines record that no product stock was deducted. Historical rows remain `legacy` with NULL snapshots; the migration does not invent their original mapping from current configuration.
- The snapshot is returned by the existing deduction path and written with the sale. It adds no lookup query to ordinary checkout. Client-supplied fields are ignored on fresh sales; progressive split fields are replaced with the locked parent's server record.
- Table merges, progressive split payloads and their paid child invoices retain the mapping. Ambiguous saved lines with different stock mappings cannot be coalesced through the product/name fallback.
- Paid refunds, open-table voids, table restocking and subscription reversals load the saved product authority. A sale that did not deduct product stock cannot add stock merely because tracking was enabled later.
- A linked mapping/version mismatch rejects a return and rolls back its refund row and stock update. Original-stock returns across deliberate mapping changes still require the general composition/return workflow; they are not implemented by this rejection. Legacy recipe usage remains on its existing frozen line-key mechanism and is not converted into unified recipe authority by these product columns.

## Cutover and concurrency defects found and fixed

The product-link lookup previously used the transaction's consistent snapshot. A transaction started before activation could miss the newly committed link even after acquiring the product lock. The adapter now uses a current locking read of product links. It locks stock identities before reading/locking default lot keys; the shared default location is read under a shared lock, not an exclusive mutex. Raw product-count and recipe-authority guards also use current link reads.

A deterministic two-connection test then exposed a separate serialization defect: an operation holding one product open prevented an independent product's stock operation from completing. The requested lock was `stock_operations.uq_stock_operation_request`, mode `X,GAP`. The missing-request-key `FOR UPDATE` check locked an insertion range across unrelated random keys.

The core now claims the operation with its unique INSERT after stock locks. Only a duplicate reads the already-existing row with a current lock. Replay still precedes stale-count validation. Invalid operations roll back the claimed row with the rest of the transaction. The independent-operation test failed twice with the former implementation and passed after this change while the first transaction remained open. The ordinary 100-line core post now requires at most **10 SQL statements**, previously 11, excluding BEGIN/COMMIT.

Extending the same test to two products in the same category exposed another unnecessary lock. Stock deduction reused the full catalog query with category joins and availability calculations, taking an exclusive category-row lock although it only needed product ID, name, quantity and version. Deduction now reads just those four fields from sorted product identities. The shared-category test failed before this change and passed afterward. Subscription pricing still has its own broader locking read; this does not claim removal of all application-level contention.

## Verification

- 52 focused cases passed across linked HTTP writers, snapshot migration, checkout query/command contracts, saved-line handling and inventory service behavior.
- 136 cases passed across the expanded linked-writer/core suites, saved-line ambiguity and startup schema checks before the final gap-lock change.
- After the gap-lock change, 50 linked-writer, core, adjustment and checkout-contract cases passed. Coverage includes stale pre-activation transaction snapshots, concurrent receipt retries, exact fractional counts, response replay, tampered client snapshot fields, changed mapping rejection, split preservation and merge preservation.
- Another 95 refund, subscription-management and legacy recipe-table cases passed. After narrowing the stock read, 27 linked-writer/inventory/checkout cases passed and one query-finder assertion failed because it required the former SQL alias. The finder now accepts either alias shape and still checks the query/command budget and absence of catalog joins; its focused rerun passed.
- The exact July 29 historical migration/repair chain and a real fresh installation both passed; combined run duration 112.86 seconds. This is correctness evidence, not startup optimization.
- The snapshot-specific migration test proves exact-predecessor upgrade, unchanged historical quantity with unknown mapping, additive partial-state recovery, no-op and missing/changed predecessor rejection.
- Architecture generation/check passes with 241 nodes, 68 flows and 508 steps. The existing unrelated recorded defect remains unchanged.

## Resource evidence

[Raw stock-service comparison](2026-09-08-stock-sale-snapshot-performance.json): three alternating rounds, 1,000 timed transactions per phase after 25 warmups. Both sides receive source context. The benchmark loads both InventoryService and StockProductAdapter from baseline commit `ae2ebaaf`, avoiding an accidental comparison that reuses the new adapter on both sides.

| Round | Baseline p95 | Current p95 | Baseline Node CPU/call | Current Node CPU/call |
|---|---:|---:|---:|---:|
| 1 | 1.603 ms | 1.486 ms | 0.297 ms | 0.421 ms |
| 2 | 1.755 ms | 1.642 ms | 0.312 ms | 0.344 ms |
| 3 | 1.693 ms | 1.525 ms | 0.297 ms | 0.344 ms |

The final unlinked service path reduced p95 by 0.113–0.168 ms (about 6–10%) after removing the unnecessary catalog read from deduction. CPU increased in all three rounds; this is not a CPU reduction claim. RSS endpoints were approximately 92–98 MiB and include retained fixture memory, so they do not establish incremental or peak memory cost. The linked path uses two additional bounded identity/key queries to preserve current-read lock ordering; the core removes one normal-post query. Its full checkout latency and resource cost still need measurement.

The separate deterministic concurrency test proves removal of one cross-product blocking mechanism; it does not quantify production throughput. Node v24.16.0, MariaDB on the shared i7-14700KF workstation. Full checkout, database CPU/RAM and 2-CPU/4-GiB device certification remain unproved.

## Remaining implementation

Operator activation/preflight, unknown opening balances through the public count path, ingredient adapters, general product/recipe compositions and original-stock remapped returns remain in A2. Packages B–J remain required. The new migration is registered for installation, not applied to the user's application database.
