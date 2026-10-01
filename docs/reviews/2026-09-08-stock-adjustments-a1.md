# Inventory implementation A1 — safe product adjustments

Implemented 2026-09-08. This is the first independently reviewable part of package A, not completion of the advanced inventory plan.

## Behavior

- `POST /api/admin/stock/adjustments` accepts a product, receipt/count, six-decimal quantity, durable request key and observed stock version for counts. Admin/programmer authorization is inherited from the existing admin router.
- Receipt quantity is added to the locked current balance. Counts fail with 409 if any intervening sale, receipt, return or void changed the version, including a sale/return that leaves the quantity unchanged.
- `stock_operations` stores the unique key, canonical payload/actor hash and original result in the same transaction as stock and audit. Retry returns the original result; a changed intent conflicts. The client retains uncertain requests in session storage across navigation/reload and refreshes current stock after a replay.
- Product PUT stock changes require `expected_stock_version`; non-stock edits omit stock in the modal. Stock audits now share the product mutation transaction. Existing external clients sending absolute stock without a version receive 409 and must reload/adapt.
- Replenishment inputs capture the observed version when focused. A later socket refresh cannot silently bless an old physical observation. Buttons are disabled during the request.
- Untracked products reject receipts until an explicit opening count. Missing quantity is not zero; precision beyond six places is rejected; large decimal strings remain exact in storage.

## Writer coverage and remaining authority work

| Current writer | A1 protection | Remaining A work |
|---|---|---|
| InventoryService sale deduction | Existing locks/delta retained; version advances in the same UPDATE | Frozen stock authority and unified movement adapter |
| InventoryService restore/restock | Atomic delta and version advance | Source-linked movement/reversal identity |
| RefundService physical return | Existing refund transaction + version advance | Disposition policy and original authority mapping |
| voidOpenTableOrder return | Existing void transaction + version advance | Source-linked movement/reversal identity |
| Admin stock receipt/count | Durable operation key, transactional audit, delta/version checks | Stock item/location/lot movement posting |
| Product PUT | Version check and transactional stock audit | Explicit unified count adapter |
| Product create/batch create | Opening product stock, default version zero | Explicit opening movement after stock activation |
| Import | New product identities/default version zero | Import preflight, opening movement, migrated-item rejection |
| Category copy | Existing null/untracked or zero stock policy, default version zero | Explicit opening movement |
| Subscription product creation | Untracked plan product; adjustment endpoint rejects plan products | Preserve plan restrictions during identity migration |
| Checkout, table/order, held and subscription callers | Continue through the services above | Enumerate/freeze every source authority before activation |

No historical movements are invented. `stock_operations` is currently an adjustment request record, **not** proof that all physical stock movements are journaled. No item has switched to unified stock authority. Identity/location/lot schema and the full adapter baseline remain A2; this avoids maintaining an incomplete second stock ledger during A1.

## Measurements

[Raw results](2026-09-08-stock-adjustment-performance.json), reproduced with `node scripts/reviews/stock-adjustment-performance.cjs`. The script creates/drops only its own guarded loopback fixture. Baseline service source is commit `3dd0bc60`. Three alternating before/after rounds, 1,000 timed transactions each, plus 25 warmups per phase; one product with sufficient tracked quantity.

| Round | Baseline stock deduction p95 | A1 p95 | Baseline Node CPU/call | A1 Node CPU/call |
|---|---:|---:|---:|---:|
| 1 | 1.397 ms | 1.294 ms | 0.313 ms | 0.234 ms |
| 2 | 1.408 ms | 1.373 ms | 0.266 ms | 0.266 ms |
| 3 | 1.335 ms | 1.368 ms | 0.187 ms | 0.188 ms |

New durable receipt: 1,000 transactions, p50 1.395 ms, p95 2.372 ms, p99 3.964 ms, Node CPU 0.515 ms/call. Final quantities were asserted after both deduction and receipt phases.

This establishes no material stock-service regression on this workstation. It does not establish a speed improvement from adding a version counter. CPU/timing variation includes warmup and shared-host noise. Deduction uses the same existing read/update commands; no additional checkout query is introduced by the version counter. RSS endpoint samples stayed approximately 89–98 MiB including fixture construction and retained driver objects; these are not peak or incremental memory measurements.

Environment: Node 24.16.0, local MariaDB, i7-14700KF. Database CPU/RAM, full checkout timing, many-item contention and low-end hardware remain unmeasured. The v2 low-end certification gates are still outstanding.

## Verification

- RED: five new integration cases failed on missing adjustment endpoint/version column before implementation. GREEN covers actual HTTP posting, concurrent receipts/replay, stale counts and product edits, sale/return ABA, untracked/precision behavior and exact decimal storage.
- Four client tests cover lost response plus reload, refusing different pending intent, clearing a definite count conflict, and retaining the key through an expired-login response. Request keys use browser getRandomValues, including HTTP LAN deployments.
- Arabic built-app browser checks: receipt 1→6, concurrent receipt invalidates count and preserves 11, lost-response receipt plus retry preserves 16, mobile 390 px fits without horizontal overflow. Browser mutations used the dedicated review database on port 3013; no application data was used.
- Checkout command limits were stale after earlier frozen-cost snapshots. Loading the pre-change InventoryService, RefundService, void route and product route from `3dd0bc60` reproduced the same four failures. Updated budgets are 21 without a recipe and 26 with a recipe, unchanged for one versus ten lines. This is budget maintenance for existing behavior, not a new query allowance for A1.
- Migration covers exact-predecessor upgrade, no-op rerun, additive partial-state recovery, missing predecessor/checksum rejection, ordered manifest hash and verbatim fallback parity. Fresh-install SQL and its hash plus startup schema requirements are updated together.

Final focused backend run: 189 passing tests across eight files. The separate refund run passed all 73 cases. All 12 historical migration cases passed across the full run and corrected first-case rerun. Build, browser and architecture checks passed. Startup bootstrap validation measured 34.46 seconds with A1 and 34.55 seconds with the original validator; its former 30-second test timeout was below both measurements and is now 90 seconds. These are startup metadata checks, not checkout latency.

Production deployment and GitHub integration are not part of this local execution. Release gate must pass before any later merge. Rollback after posting means keeping the new version/operation data and forward repair; do not drop operation identities or resume unversioned absolute stock writes.

## Next

Complete A2: stock catalog and location/lot identity, frozen sale authority, full movement adapters, legacy open-order/refund activation preflight and reconciliation. Then B introduces bounded lists and report generations. Procurement, counts, advanced recipes/preparation, traceability, valuation and planning retain their ordered packages and gates in the v2 plan.
