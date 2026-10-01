# Stock writer consolidation — 2026-09-08

This continues package A. It does not activate the unified ledger or complete A2–J.

## Correctness

An isolated database regression demonstrated that two sale lines with mixed string/numeric product IDs and string quantities deducted only three of five units: stock 10 became 7. The deduction service now normalizes both identifiers and quantities before aggregation. A second case covers two numeric identifiers with string quantities, which previously concatenated quantities and could reject a valid sale as insufficient stock.

RefundService and open-table voids now use the existing `restoreStockForCart` adapter inside their existing transactions. It aggregates repeated products, preserves untracked NULL balances, and increments each affected product version in one statement. Refund money and recipe reversals retain their existing paths. Stock versions remain monotonic conflict tokens, not counts of returned order lines.

Replaced an export-shape test with a behavioral batch bound: 100 return lines for two products produce their aggregated quantities in one write. No schema, new dependency, runtime setting or authority cutover was introduced.

## Measured comparison

Run `node scripts/reviews/stock-return-performance.cjs`. It creates and drops only its own guarded loopback database. Ten distinct products, 0.125 units returned each, 25 warmups plus 1,000 timed transactions per phase, three alternating before/after rounds. The old phase reproduces the previous refund SQL loop; the new phase invokes the actual shared service. Final stock is asserted for every product.

| Round | Before p95 | After p95 | Before Node CPU/operation | After Node CPU/operation |
|---|---:|---:|---:|---:|
| 1 | 2.610 ms | 1.321 ms | 0.625 ms | 0.214 ms |
| 2 | 2.802 ms | 1.158 ms | 0.549 ms | 0.091 ms |
| 3 | 2.588 ms | 1.264 ms | 0.244 ms | 0.091 ms |

Stock statements fall from ten to one, excluding unchanged BEGIN/COMMIT. Raw evidence: [stock-return-performance.json](2026-09-08-stock-return-performance.json). CPU includes warmups. This is a shared i7-14700KF workstation, Node 24.16.0 and local MariaDB; not low-end certification or complete refund HTTP latency. RSS endpoints range roughly 90–98 MiB and include fixtures/retained driver allocations; they do not prove an incremental memory reduction. Database CPU/RAM remains unmeasured.

## Verification and remaining work

The original mixed-ID regression failed before the fix (7 instead of 5). Refunds, checkout performance contracts and existing refund wiring checks passed all 89 cases. Adjustment and inventory-service checks cover the new aggregation regressions and batching.

Still outstanding: physical stock identity, source-linked journal adapters, frozen sale authority and activation reconciliation (A2), then bounded stock/report projections (B), procurement/counts (C–D), recipe/preparation versions (E–F), traceability/valuation (G–H), planning/imports/permissions and operator acceptance (I–J). This change must not be described as completion of that plan. No application data was migrated and no deployment or GitHub integration was performed.
