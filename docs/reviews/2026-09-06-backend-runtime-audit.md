# Backend runtime audit — 2026-09-06

Audited the shared checkout on `codex/system-performance-audit`, based on `01ef8df1316484a19e1f655c676d0b86901f5914`. The changes address unnecessary historical report work and connections held while an operation waits for another pooled connection. No schema, dependency, deployment, or machine environment change was made.

## Verified problems and changes

`getFinancialEventsForPeriod` aggregated line discounts across all historical `order_items` before applying the requested date range. Its sales and service-fee filters also wrapped the indexed timestamps in `COALESCE`. [financialEventMetrics.js](../../backend/services/financialEventMetrics.js) now scopes the discount aggregate and uses the existing `paidOrderRangeWhere` definition for all three queries. Issued timestamps retain precedence; legacy rows still fall back to creation timestamps. Bundle child discounts remain excluded. No query was removed, and the financial definitions remain shared.

Table operations committed their transactions but retained the connection while awaiting kitchen routing or table broadcasts that queried the pool. When the pool is exhausted, an operation can wait for a connection it is itself holding. The following files now release the completed lease before those follow-ups:

- [executeCheckout.js](../../backend/modules/checkout/executeCheckout.js): release after commit and before duplicate-key recovery uses the pool. Removed the unreachable second `!user` rejection; the entry check remains.
- [saveTableOrder.js](../../backend/modules/tables/saveTableOrder.js): release for empty-table clear and saved orders. Read response identity before commit; kitchen normalization subsequently uses the pool.
- [voidOpenTableOrder.js](../../backend/modules/refunds/voidOpenTableOrder.js): release before kitchen-void normalization, dispatch, and notifications.
- [markTablePrinted.js](../../backend/modules/tables/markTablePrinted.js): release before the floor-plan refresh.
- [splitChecks.js](../../backend/modules/tables/splitChecks.js): release before create/rewrite/cancel notifications; clear transaction state after successful split creation.
- [tableRelationships.js](../../backend/modules/tables/tableRelationships.js): release before transfer/merge/join/disjoin follow-up reads. Join/disjoin PIN authorization now finishes before acquiring the transaction connection; failed authorization needs no transaction. Group locking and independent authorization auditing retain their existing ownership.

The first eight real-HTTP lease regression cases failed before the changes. A separate void case also failed before its correction. The added join/disjoin PIN case failed while authorization reads borrowed a second connection. The final ten-case file passes and covers saved-table settlement, kitchen follow-ups, empty clear, check-drop status, void, transfer, merge, join/disjoin, and split create/rewrite/cancel.

[ManagerOverrideService.js](../../backend/services/ManagerOverrideService.js) received only a comment correction during documentation: join/separate authorization now precedes leasing, while checkout can still invoke authorization inside its transaction.

## Measured report effect

The [probe](../../scripts/reviews/system-report-performance.cjs) recreates a guarded scratch fixture on local MariaDB **10.4.32**. It inserts 50,000 historical orders and one parent item per order, dated January 1, plus one September 6 order/item. Historical items each have a fixed line discount. It runs `ANALYZE TABLE orders, order_items`, then executes the same September 6 financial-period request six times on one connection. The first sample is excluded; the reported period value is the median of the remaining five. The discount query is then measured separately once, alongside `EXPLAIN` and the session `Rows_read` delta.

| Measurement | Before | After |
| --- | ---: | ---: |
| Financial-period metrics median | 195.866 ms | 14.199 ms |
| Discount query, separate sample | 129.383 ms | 0.449 ms |
| Discount query database rows read | 100,002 | 3 |

The old plan scans historical orders/items. The corrected plan uses the existing invoice timestamp range index and invoice-item lookup. These timings measure the financial-period service, not the entire Daily Summary HTTP request. `Rows_read` describes database work, not response rows transferred. Both measurements used the same recreated workload and sampling method; the after run overlapped other isolated verification on this shared development machine. Treat latency as indicative local evidence. The execution plans and row-read reduction demonstrate the removed work independently of a production throughput claim.

Evidence: [before JSON](../../scripts/reviews/system-report-performance-before.json), [after JSON](../../scripts/reviews/system-report-performance-after.json).

### Source provenance

The two measurements originally recorded workload, timings, session rows read, database version, and plans. **Their `sourceHead` and `financialMetricsBlob` fields were added afterward**, using the known audit base and Git source verification. The JSON now explicitly marks this with `sourceProvenance.recordedDuringMeasurement: false`. The probe was subsequently updated to record source fields automatically on future runs; it was not rerun for this documentation.

| Source | Git blob object ID for `backend/services/financialEventMetrics.js` | How verified |
| --- | --- | --- |
| Before | `6b97c067c2cddc250075266a006be30c3755dde4` | Derived from the known base commit with `git rev-parse` after measurement |
| After | `ee9fa9823c2f8f226f53a7c5118b6965497c0930` | Derived with `git hash-object` after measurement and checked again during documentation |

The after measurement ran with modified working-tree source while HEAD remained `01ef8df1316484a19e1f655c676d0b86901f5914`; HEAD alone does not identify that implementation. No contemporaneous source hash is claimed for these original measurements.

The measurement commands, run before and after the service edit respectively, were:

```powershell
$env:POSAPP_REVIEW_DB='posapp_review_recipe_p1_a077bac00001'
$env:NODE_OPTIONS='--require=./scripts/reviews/recipe-ledger-phase1-preload.cjs'
$env:POSAPP_PERFORMANCE_OUTPUT='scripts/reviews/system-report-performance-before.json'
node scripts/reviews/system-report-performance.cjs

$env:POSAPP_PERFORMANCE_OUTPUT='scripts/reviews/system-report-performance-after.json'
node scripts/reviews/system-report-performance.cjs
```

The script executes the checkout's current source. Running these two commands on unchanged source will measure that source twice. For a new measurement, choose a fresh `posapp_review_recipe_p1_<12 hex>` database name and a separate result filename; the probe recreates the selected scratch fixture and leaves its database for explicit cleanup.

## Verification record

**512 distinct cases in 16 files passed across the runs below.** This is a union, not one invocation: the first focused run had nine lifetime cases; the final lifetime file adds one PIN case. The 32 relationship follow-ups and ten final lifetime cases overlap earlier coverage and are not added again.

| Integration test file | Distinct passing cases |
| --- | ---: |
| `dailyReportsAdversarial.test.js` | 11 |
| `dailyReportsSummary.test.js` | 5 |
| `tableConnectionLifetime.test.js` | 10 |
| `checkoutPerformanceContract.test.js` | 12 |
| `checkoutPostCommit.test.js` | 5 |
| `tableOrderPostCommit.test.js` | 2 |
| `recipeLedgerReport.test.js` | 3 |
| `financialEventRange.test.js` | 1 |
| `tables.test.js` | 199 |
| `checkout.test.js` | 133 |
| `refunds.test.js` | 73 |
| `bundle.tables.test.js` | 35 |
| `tableSettlementContext.test.js` | 13 |
| `recipeLedgerReversals.test.js` | 4 |
| `recipeLedgerTables.test.js` | 3 |
| `recipeLedgerSplitsMerges.test.js` | 3 |

All files are under [backend/tests/integration](../../backend/tests/integration). The new financial case checks inclusive start/exclusive end, issued-date precedence, null-date fallback, unpaid/void exclusion, service fees, and exclusion of bundle-child discounts. Existing suites cover monetary/recipe conservation, refunds, concurrent table actions, authorization walls, transaction rollback, idempotency, and checkout command budgets.

| Recorded run | Result | Vitest wall time |
| --- | --- | ---: |
| Focused report/checkout/lifetime checks | 48 passed, 8 files | 47.03 s |
| Broader business-flow regressions | 463 passed, 8 files | 477.71 s |
| After moving join/disjoin authorization before leasing | 32 passed, 167 intentionally filtered out | 32.66 s |
| Final lifetime suite with asserted driver capacity of one | 10 passed | 11.15 s |

The broad run had already loaded the relationship implementation before the final authorization move. Its affected relationship/guard cases were rerun afterward. The removed second authentication branch was unreachable because `executeCheckout` rejects a missing user at entry before any reassignment. The only later change to `ManagerOverrideService` was its explanatory comment. No tests were rerun for this documentation-only follow-up.

Exact executed test commands follow. Each block ran from the repository root in its own PowerShell process:

```powershell
$env:POSAPP_REVIEW_DB='posapp_review_recipe_p1_a077bac00004'
$env:NODE_OPTIONS='--require=./scripts/reviews/recipe-ledger-phase1-preload.cjs'
npx vitest run tableConnectionLifetime financialEventRange checkoutPostCommit tableOrderPostCommit checkoutPerformanceContract dailyReportsSummary dailyReportsAdversarial recipeLedgerReport --reporter=dot
```

```powershell
$env:POSAPP_REVIEW_DB='posapp_review_recipe_p1_a077bac00005'
$env:NODE_OPTIONS='--require=./scripts/reviews/recipe-ledger-phase1-preload.cjs'
npx vitest run backend/tests/integration/tables.test.js backend/tests/integration/tableSettlementContext.test.js backend/tests/integration/bundle.tables.test.js backend/tests/integration/checkout.test.js backend/tests/integration/refunds.test.js backend/tests/integration/recipeLedgerTables.test.js backend/tests/integration/recipeLedgerSplitsMerges.test.js backend/tests/integration/recipeLedgerReversals.test.js --reporter=dot
```

```powershell
$env:POSAPP_REVIEW_DB='posapp_review_recipe_p1_a077bac00007'
$env:NODE_OPTIONS='--require=./scripts/reviews/recipe-ledger-phase1-preload.cjs'
npx vitest run backend/tests/integration/tables.test.js -t 'Table Operations|Disjoin guard' --reporter=dot
```

```powershell
$env:POSAPP_REVIEW_CONNECTION_LIMIT='1'
npm run test:isolated -- tableConnectionLifetime --reporter=dot
```

The final command used generated database `posapp_review_recipe_p1_9792d177b6a8`, cleaned by the runner. The fixture checks the effective MySQL driver `connectionLimit` in every case. Earlier shell-only `DB_CONNECTION_LIMIT=1` attempts were overridden to 25 by `.env.test` and provide no single-connection proof; they are excluded from the capacity claim. The optional, validated `POSAPP_REVIEW_CONNECTION_LIMIT` addition to [the existing preload](../../scripts/reviews/recipe-ledger-phase1-preload.cjs) reapplies this override after every dotenv load. Machine configuration remains untouched.

Ignored local raw output is retained at `scripts/reviews/system-backend-focused.log`, `system-backend-integration.log`, `system-backend-relationships.log`, and `system-backend-single-connection.log`. Seven manually named databases ending `a077bac00001` through `a077bac00007` were removed after verifying zero active sessions. No shared fixed-name migration fixture was used by these runs.

## Examined scope and remaining limits

Reviewed checkout database pricing/product context, paid-order immutability, idempotency/recovery, stock and recipe calls; table-group locks and saved-line/split conservation; refund frozen tender allocation, restock, and recipe reversal; held-order version/claim/replay checks and route commit ownership; inventory batch reads/updates; and financial/dashboard builders. Existing business authorities were preserved. Beyond the unreachable authentication branch and unused report import, no runtime deletion or abstraction change had a demonstrated benefit in this pass.

Independent read-only review also covered the parent audit's fixture destination guard, lock/fixture port agreement, generated-database runner cleanup, frontend test configuration, and atomic menu publication. No actionable issue was found in those changes. Their implementation evidence belongs to the overall system audit and [verification guidance](../agents/verification.md).

**Remaining checkout PIN path:** `executeCheckout` begins its transaction before some calls to its injected `authorizeManagerOverride` callback, including discount authorization, subscription-credit authorization, and an attempted override during a checkout-permission rejection. The HTTP adapter delegates to `ManagerOverrideService`, whose manager-candidate and overridable-permission reads use the pool. These awaited reads can still require a second connection while checkout holds one; a fully occupied pool can therefore stall that variant. Authorization audit writes intentionally use their independent asynchronous path. This pass did not move those checks across money/permission boundaries or merge their audits into the checkout transaction. The one-connection evidence covers the ten named ordinary/table cases and join/disjoin PIN authorization, not every checkout override or concurrent capacity scenario.

No production throughput, Hostinger behavior, customer hardware, or physical printing was tested here. Browser acceptance is recorded separately by the overall system audit. Database schema and architecture ownership did not change.
