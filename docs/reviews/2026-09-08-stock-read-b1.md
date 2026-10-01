# B1: bounded stock reads

This implements the first read-service slice of package B, not the complete inventory plan. The existing inventory UI is not switched to this endpoint yet. Ingredient activation, barcode/attention projections, daily facts and the worker remain required before B is complete.

## Behavior

`GET /api/admin/stock/items` is protected by the existing administrator/programmer router. It returns 50 items by default, at most 100, ordered by name and ID with a cursor bound to the selected filters. Active stock authority is required. Name search uses a literal prefix; filters cover active status, legacy source kind and location. It selects the identities first and hydrates balances only for that page. There is no movement-history scan, offset pagination or global count.

Quantities remain six-place decimal strings. Missing positions and any unknown position in the selected scope produce an unknown balance, not zero. A known zero remains zero. Multiple lots sum exactly. A location filter excludes unknown positions in other locations.

The additive `2026-09-08-stock-read-index-v1` migration supplies `(tracking_state,is_active,name,id)`. It is registered after sale snapshots, included in the manual fallback and fresh installer, and required by startup validation. No application database was migrated.

## Measured query choices

[Raw stages and EXPLAIN plans](2026-09-08-stock-read-performance.json) were collected with `node scripts/reviews/stock-read-performance.cjs`. Each generated loopback fixture contains 10,000 items and balances. Each query has 25 warmups and 1,000 timed calls. These are sequential workstation service measurements, excluding HTTP/authentication and database CPU/memory.

| Query | Initial p95 ms | Final p95 ms |
| --- | ---: | ---: |
| Default page | 6.210 | 1.008 |
| Name prefix | 0.872 | 1.030 |
| Next prefix page | 0.864 | 1.261 |
| Inactive | 2.981 | 1.256 |
| Location | 4.739 | 1.415 |

Adding the index alone regressed prefix queries to 4.4–5.0 ms because MariaDB chose the active-state index and scanned many matching-state entries. Prefix/cursor requests now explicitly use the name index. Location selection uses an item/location primary-key probe instead of materializing all positions. Balance hydration uses the primary key to restrict work to the selected IDs rather than scanning a location's entire balance index.

Responses were 10,458–10,660 bytes for 50 rows. Default and location latency improved, but the final prefix queries are slower than the initial run. Node CPU varies by query, and RSS endpoints include fixture allocation and GC. **No general CPU or memory saving is established.** Sparse location/source filters, many lots per item, mixed reader/writer load, one-million-movement history, and the 2-CPU/4-GiB deployment gate remain unverified. This endpoint alone does not certify package B's full resource contract.

## Verification

- 132 focused tests passed: stock reads, automatic migration manifest/fallback rules and schema authority.
- Three dedicated index migration tests passed: exact predecessor upgrade/preservation/no-op; falsely current ledger with missing index rejected; missing or mismatched predecessor rejected.
- Historical July 29 upgrade, damaged-schema repair and fresh installer checks passed against scratch databases (2 tests, 115.51 seconds). The stale fresh-baseline checksum and migration ledger assertion order found during verification were corrected.
- Admin production build passed. Arabic catalog checks passed earlier in this slice; no UI layout changed.
- Read tests include Arabic equal-name pagination without duplicates, cursor/filter conflicts, page limits, literal wildcard search, role enforcement, unknown/zero/negative quantities and exact multi-lot/location behavior.

The added index has a write/storage cost that this read benchmark does not quantify. No claim of lower checkout CPU or production deployment is made.
