# Explicit product stock activation

Implemented locally on `codex/ingredients-ui-fix`. This completes the operator activation slice for immutable, separately stocked 1:1 products. It does **not** complete package A or B–J. No application database was migrated or real item activated; all mutations below used generated loopback fixtures.

## Behavior

- Product editor offers an on-demand Arabic eligibility check. Existing known quantity becomes exactly one opening movement. An unknown balance stays unknown, with no invented opening quantity; the operator must count before a linked sale or receipt.
- Activation locks the stock setting and product in a caller-owned READ COMMITTED transaction, rechecks eligibility and observed product version, and commits the identity, balance, link, operation result and audit together. Only admin/programmer access is allowed. Deadlock retry reuses the same intent.
- Preflight blocks open table orders, held/split product references, malformed held payloads, negative stock, inactive/bundle/note/subscription-plan products, recipe consumers and orphaned existing stock identities. Numeric/string IDs and legacy array/current object holds are supported.
- A response-loss retry returns the original activation, even when the product is now active. The UI persists the original key in session storage before POST, retains it on uncertain errors and allows confirmation after reopening. Definite conflicts refresh eligibility before a new attempt.
- Tracked product quantities cannot be changed by catalog PUT, switched to bundle stock, replaced by catalog import or silently disabled through stock settings. Maintenance reset now rejects active stock history before deleting source invoices. Its rejection is HTTP 409, not a generic server error.
- The product editor keeps unsaved catalog edits when activation succeeds and omits tracked stock from later catalog saves. The receipts/counts link opens the matching product. Unknown stock is not displayed as zero or unlimited after activation, and quick receipts stay disabled until counted. Healthy balances no longer receive the low-stock badge/color. A short Arabic description distinguishes deliveries from a physical count. Touched controls use the product ink palette.

## Verification

- `stockActivation.test.js`: **14 passed** after the query optimization. Concurrent duplicate request, single opening/audit, stale version, cashier denial, known and unknown quantity, explicit zero count/retry, open table blockers, four held ID/layout formats, four malformed JSON shapes, competing recipe policy, and a closed legacy invoice refunded once after activation.
- `stockLinkedWriters.test.js`: **10 passed** with the activation integration work. Covers linked checkout/refund/split/merge, bypass guards, receipt/count parity and concurrency behavior.
- `maintenanceReset.test.js`: **11 passed**, including retained source invoices/holds/movements after a rejected reset and unchanged legacy reset behavior.
- `stockActivationPanel.spec.js`: **5 passed**. Lost-response/reopen replay, blocked/dirty state, refreshed 409 observation, stale product response and single in-flight request/server-error retention.
- `productStockActivation.spec.js`: **3 passed**. Preserve unsaved catalog edits, omit tracked stock, prevent close/save/tab changes during activation, reject a competing recipe tab and preserve unknown quantity.
- `i18nCatalog.spec.js`: **3 passed**. Production admin build passed. Architecture generation/check passed with 243 nodes, 69 flows and the existing one recorded architecture defect.
- Visible in-app browser: Arabic desktop known activation retained 10 and opened the corresponding receipts/count row. At **390×844**, activated an unknown product, verified disabled receipt buttons and the first-count explanation, saved an explicit zero, then received five. Database inspection showed activation with no quantity movement, count `0.000000` establishing known quantity, then receipt `5.000000`. Mobile screenshots are under ignored `scratch/stock-activation-browser/`; these are local review artifacts, not production evidence.

## Measured costs

Run `node scripts/reviews/stock-activation-performance.cjs`. It creates a fresh allowlisted database, measures preflight against absent targets in 0/100/1,000/10,000 holds of 20 lines each, posts 105 real opening transactions (5 warmup + 100 timed), asserts movement count, and drops only its newly created fixture.

The initial query searched whole carts eight times. The accepted query extracts the four supported product-ID paths, then checks numeric and string membership. It adds no dependency or persistent cache and never sends carts to Node. [Raw before/after evidence](2026-09-08-stock-activation-performance.json):

| Held orders | Samples per run | Initial p95 | ID projection p95 |
| --- | ---: | ---: | ---: |
| 0 | 100 | 1.32 ms | 1.70 ms |
| 100 | 100 | 10.04 ms | 7.54 ms |
| 1,000 | 100 | 109.27 ms | 77.04 ms |
| 10,000 | 25 | 1,029.17 ms | 679.95 ms |

At 10,000 holds this run improved p95 by **34%**; Node CPU was 2.52 → 1.24 ms/check. Known activation with no holds was 5.77 → 5.36 ms p95 over 100 committed operations. Empty-queue p95 did not improve. These are two sequential workstation runs, not repeated low-end certification or a proof of whole-server CPU savings. Node CPU excludes database work; RSS endpoints include retained fixture allocations and garbage collection, so their differences are not memory-saving evidence.

The held-order check **still scans JSON and scales with the backlog**. Activation holds a product lock while rechecking; a very large queue can therefore delay a concurrent sale of that product. No scan is added to ordinary checkout. Indexed held-product projection or another measured bounded alternative remains necessary before claiming negligible activation interference at arbitrary backlog size. This run does not satisfy the plan's 2-CPU/4-GiB, million-movement, reporting-worker or full-checkout release gates.

## Remaining scope

Ingredient/preparation adapters and activation, unified product/recipe composition, original-stock returns after remapping, indexed stock/report projections and worker generation guarantees remain unimplemented here. Procurement, durable count sessions, advanced recipes/preparation, lots/transfers, fixed-point valuation/period close, purchasing intelligence and staged imports remain in the binding implementation plan. The default location and 1:1 mapping in this slice do not stand in for those packages.
