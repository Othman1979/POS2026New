# Database performance implementation

Work proceeds sequentially: finish regression coverage, implementation, affected workflow tests and real measurements for one finding before starting another. Customer databases and deployed settings are outside this local implementation scope.

## 1. Shift discount aggregation — verified

The baseline financial cases passed for mixed fixed/percentage discounts, partial and full refunds, multiple shifts, legacy no-line orders, zero subtotals and date boundaries. A representative 4,100-order / 201-shift fixture then reproduced **205,200 row visits** for 100 selected invoices, failing a generous 2,000-visit regression limit.

The change uses a selected-invoice CTE to constrain both order items and refund items. Existing financial expressions and the unscoped SQL exports remain available to other consumers; the default SQL was compared with the baseline after whitespace normalization and is equivalent.

On the same generated 40,000-order / 10,000-refund fixture, the real full X payload improved from **9,073.618 ms median** (3 samples) to **26.056 ms median / 27.595 ms p95** (20 samples), after one warmup per variant. Row visits fell from **10,002,504 to 3,504**, with the same 8 queries. All measured X payloads and a separate Z payload were deeply equal to baseline, including 7.25 in total discounts. Evidence: `scratch/db-performance-implementation/shift.cjs` and `shift.json`; the owned fixture was removed successfully.

Verification: 3 focused real-database regression tests plus 2 financial-boundary tests passed. Another **131 integration tests** passed across audit reports, shift lifecycle, refunds, thermal report delivery and print rendering. These cover saved/default printers, archive/reprint, queue failure, permissions, date ranges, cash adjustments and report finances. Printing was simulated through the real delivery/rendering paths; no physical printer or customer deployment was exercised. Measurements are local MariaDB 10.4.32 on the audit host, not a Hostinger performance guarantee.

Rollback is a source revert of the scoped-query change; no schema or stored financial data changed. This item was closed before work on Orders statistics began.

## 2. Orders statistics — verified

The new regression first failed at **5,125 row visits** for a 100-order day among 4,100 orders. A separate financial fixture passed on baseline before production edits: all seven supported payment methods, inclusive start/exclusive end, different issue/creation dates, legacy null issue timestamps, later refunds, ignored void events, cashier/payment/shift/table/amount filters, historical invoice lookup and pagination.

The query now selects invoices with three disjoint indexable date branches, sharing the payment-method definition with the existing business-time expression. Every existing filter applies inside each branch; refund aggregation is limited to selected invoices. Both new tests and all 15 existing Orders statistics tests passed, including real HTTP refunds and JoFotara/subscription filters.

Twenty actual route-handler samples per variant on the 40,000-order fixture measured statistics at **24.116 → 6.735 ms median**, **50,000 → 2,121 row visits**. Seven filter combinations returned deeply identical complete responses. This harness includes both real route queries and serialization preparation but excludes HTTP/auth; HTTP behavior is covered by the integration tests. Evidence: `scratch/db-performance-implementation/orders.cjs` / `orders.json`, fixture removed.

The complete handler improved only **973.802 → 947.562 ms median**, because the separate paginated list still revisited historical refunds: the full handler read 1,051,722 rows after the statistics fix. That newly measured bottleneck is the next separate item; statistics alone does not make the whole page fast. No schema/data changes; rollback is a source revert.

## 3. Orders page detail aggregation — verified

A separate regression reproduced **46,066 row visits** for a ten-invoice page. The list now uses the same filtered, indexable candidate selection as statistics, applies pagination first, and scopes discount/refund-status aggregates to that page. Original sort order, public identities, permissions and response fields are preserved. No invoice content is changed.

All **18 Orders integration tests** passed after implementation. They cover net revenue, partial/full refunds, active discounts, subscription links, JoFotara return states, filtering and pagination. The additional final boundary checks include an empty business day and a page beyond the last result. The held-order checkout/retry/search/compiled-print workflow also passed against the changed Orders route.

Twenty baseline/current full-handler samples each, with seven extra filter comparisons, returned deeply identical complete responses. The whole Orders handler improved from **972.147 ms median / 1,011.696 ms p95 to 28.501 / 31.872 ms**, and **1,099,601 → 6,453 row visits**, still two SQL calls. Evidence: `scratch/db-performance-implementation/orders-list.cjs` / `orders-list.json`; fixture removed. These are instrumented local handler measurements, not browser/Hostinger timing. Rollback is a source revert; no migration is needed.

A subsequent selectivity check covered 1,000 matching invoices (`orders-broad.json`) and **all 40,000** (`orders-all-history.json`), with 20 samples per variant and equal full responses. All-history handler time improved **1,001.621 → 313.616 ms median**, **1,051.756 → 366.771 ms p95**; row visits **1,060,101 → 490,352**. Tradeoff: the all-history statistics component alone increased **79.810 → 122.357 ms** and **50,000 → 170,004 row visits** because candidate materialization is less selective. The complete request still improved substantially. No dynamic query threshold or optimizer hint was introduced merely to optimize this extreme case.

## 4. Y report date index — verified

The baseline regression visited **4,009 rows** to build a report containing one hold. Adding `held_orders(created_at,id)` makes that regression pass without changing report code or payload shape. The migration is appended after the exact unified-movements predecessor, with a checked preflight, normalized file hashes, identical operational/automatic SQL, verbatim cumulative Hostinger fallback and updated fresh-installer baseline hash.

The 30,000-hold benchmark measured the **full Y payload at 35.883 → 1.798 ms median**, **39.829 → 2.096 ms p95**, and **30,017 → 17 row visits**. Twenty samples per variant preserved all content; the newly generated `generated_at` field was excluded from equality and separately validated as a timestamp. Ten selected holds remained present. Evidence: `scratch/db-performance-implementation/y-report.cjs` / `y-report.json`; fixture removed.

One hundred insert/update/delete transactions per variant measured **1.423 → 1.479 ms median**, **1.776 → 2.700 ms p95**. The extra index has write/storage cost; this local single-client probe does not establish customer contention or tail latency. Report gains are much larger than the observed median write cost. Online DDL still needs metadata locks; production build duration has not been measured.

All 21 focused Y/installer/index-upgrade tests passed, plus **60 automatic-migration integration/unit checks**, including the complete historical upgrade chain, hash/fallback parity, exact predecessor, current-schema replay, interrupted index creation, wrong index shape and checksum rejection. Existing held rows/timestamps are preserved. Another **102 held lifecycle and thermal delivery tests passed**, including auto-fire, bundles, simultaneous Y requests, failed queue delivery and archive behavior. This item was closed before the next implementation began.

For rollout, allow the normal automatic migration to apply during an authorized deployment; inspect its ledger/checksum and the actual date-query plan afterward. Manual application requires the supplied read-only preflight first. A source rollback can retain this additive index: old application code remains compatible, and no business rows need reversal.

## 5. Daily Summary duplicate subscription aggregate — verified

The real HTTP regression first observed **four collection aggregate calls across two daily reports**, despite correct financial output. Daily Summary now passes its already calculated collection totals to subscription metrics within the same report invocation. Standalone subscription metrics still fetches its own totals; no global cache or cross-request reuse was added.

The same regression now observes **two calls across two reports**, with issue-day sales, later collection-day cash and outstanding debt unchanged. **45 focused integration/frontend/unit tests passed**, including collection/reversal/idempotency, daily financial adversarial cases, expenses, sales details, navigation/localization and standalone metrics. This is a measured one-round-trip reduction per Summary, not a claimed wall-clock speedup. The production change is three small edits in the two existing services; rollback is a source revert.

## 6. Concurrent authentication reads — verified

Baseline tests reproduced both duplicate cold/refresh work and a stale-result race: a delayed lookup could repopulate the cache after token/user/device invalidation. Pending work is now shared per hashed token and released on completion or failure. Invalidation cancels pending work; stale results cannot replace a fresh session or old permissions. Requests recheck against current state, with a three-attempt bound under continuous security changes. Unrelated warm tokens remain cached and unrelated pending users are tested to recover normally.

The final **14 concurrency tests** passed (the original baseline failed 11 of the first 12), plus 24 existing auth/session unit tests and **108 real integration tests** for login/logout, default-deny permissions, checkout authority, device access, durable expiry and socket revocation. No session timeout, cookie policy or permission rule changed.

Thirty alternating real-database bursts per variant, 20 verifications per burst, measured cold **40 → 2 SQL calls**, **1.740 → 0.592 ms median**; due refresh **20 → 1 call**, **1.905 → 0.305 ms median**. Warm controls stayed **0 → 0 calls**, **0.029 → 0.026 ms**. Evidence: `scratch/db-performance-implementation/auth.cjs` / `auth.json`, fixture removed. This measures the production verifier with real MariaDB calls, not network/customer request latency; refresh eligibility uses a controlled 61-second application-clock offset. Source rollback needs no migration. Cross-process session/cache coherence remains outside this local optimization.

## 7. Repeated held-order lock reads — verified

Save, kitchen follow-up and legacy baseline confirmation already hold the row lock before claim validation. A shared pure validator now checks that same row; callers without an existing locked row retain the locking API. The claim route still rereads after updating its lease/version, because that row has changed. Ownership, constant-time token comparison, lease expiry, version checks and the original transaction boundaries remain intact.

Both save and follow-up regressions failed with two identical locking reads before the change and passed with one afterward. **128 focused tests passed**, including held authority, retries, auto-fire, bundles, lifecycle and kitchen dispatch. Real HTTP claim/save runs used 1, 10 and 40 lines, five warmups and 25 measured iterations each, checking version advancement, persisted totals/cart and claim release after every save. Old and current route modules ran against equivalent generated fixtures with the current schema and other services.

Save consistently dropped **9 → 8 SQL calls**, **2 → 1 locking reads**, and **9 → 8 row visits**; claim remained at 10 calls. Local save medians were **3.866 → 3.915 ms** (one line), **4.388 → 3.963 ms** (ten), and **5.854 → 5.916 ms** (forty). These noisy timings do not establish a wall-clock speedup; the verified benefit is one eliminated round trip per mutation. Evidence: `scratch/db-performance-implementation/held/held.cjs` and `held/{baseline,current}/results.json`; both fixtures removed. No lock was weakened or transaction shortened by removing required work. Source rollback needs no migration. This item was closed before the split audit lookup work began.

## 8. Repeated audit-policy lookup during split creation — verified

Two-seat HTTP regressions first observed three identical actor-policy lookups. Split creation now submits its existing events as one transaction-bound batch with one actor/authorizer context. The batch checks the existing policy once, then performs the same individual event inserts in the same event order before commit. Single-event callers retain their prior return/serialization behavior. No long-lived policy cache, skipped audit entries, changed audit policy or write batching was introduced.

The regressions now observe one policy read and verify every held-row link and provenance payload. An injected failure on the second audit insert rolls back all created splits and provenance and preserves the parent order. **166 focused integration/unit tests passed**, covering split settlement, persisted bundle snapshots after catalog changes, service charges, inventory/recipe quantities, reports, concurrent revisions, notification failures and returned connections. Another **nine manager-override/audit integration tests passed**. Existing actor/manager policy behavior is retained, and a new unit check proves the next batch reads policy again.

Real HTTP measurements used one, four and eight seats, eight source lines, five warmups and 25 measured samples per variant. Total SQL calls fell **13 → 12**, **22 → 18** and **34 → 26**; policy reads fell **2/5/9 → 1**. The eight-seat request retained all **17 writes and three locking reads**. Every measured split retained the expected child count and all provenance/event payloads. Median request times were **4.285 → 4.679 ms**, **6.399 → 6.269 ms**, and **8.072 → 7.958 ms**; p95 did not improve. The defensible benefit is fewer repeated reads, not a proven wall-clock speedup on this loopback host. Evidence: `scratch/db-performance-implementation/split/split.cjs` and `split/{baseline,current}/results.json`; both owned fixtures removed. Source rollback needs no migration.

## Observations that do not justify another production edit yet

- **Subscription list:** the audit reproduced a 212.013 → 12.178 ms improvement with the same SQL/indexes after refreshing fixture statistics. Inspect the deployed plan/statistics before changing SQL or scheduling maintenance. No customer statistics were changed.
- **Print retry backlog:** an added index was not chosen and did not improve the measured query without a forced hint. A hint optimized one artificial backlog but lacks evidence across normal/due-job distributions. Existing retry ordering and recovery remain unchanged.
- **Shifts list:** its count/page pair measured 27.227 ms and 81,451 row visits; the plan materializes order-event checks. No equivalent faster candidate has been demonstrated. The expensive shift-discount work behind report building is fixed separately above.
- **Large held/split lists and customer subscription history:** supporting queries are already bounded in count. The remaining issue is payload/history size. Pagination or summaries need an explicit response/UI contract so operators retain all work, totals, and recovery behavior. No records were truncated.
- **Contains search:** exact barcode lookup is already indexed. Changing substring search would alter user-visible matching; no such product change was made.
- **Stock source hashing and lock waits:** existing revision/date scopes and transaction locks protect correctness. The deliberately blocked-row experiment does not establish production wait frequency or justify weakening locks. No background hash or lock change has a measured equivalent win here.

## Completion and limits

All eight implemented items were handled sequentially, with a failing regression or baseline measurement before the production change and focused verification before proceeding. No customer database, Hostinger deployment, physical printer, Windows support EXE or production configuration was changed. Only the Y-report item adds schema: one additive index and its normal migration/installer artifacts. Table consolidation remains out of scope.

Measurements used generated loopback data on Node 24.16.0 / MariaDB 10.4.32, with query cache and performance_schema off and a 16 MiB buffer pool, on an i7-14700KF desktop with about 32 GiB RAM. Row visits are session `Rows_read` deltas, not unique business rows. Report payload comparisons, real HTTP integration tests and simulated printing establish the stated local behavior; they do not prove low-end-device latency, Hostinger performance, production contention, multi-server cache coherence or absence of every possible failure. CI's Node 22 / MariaDB 11.4 environment has not been exercised by these local runs. Release gate, push and deployment remain separate work.

Final local verification checked all 11 retained implementation benchmarks: every owned database was removed and no connections remained attached to those database names. All ten changed production JavaScript files passed Node syntax checks; `git diff --check` passed. The verification artifact records current source hashes at `scratch/db-performance-implementation/final-verification.json`. The earlier unrelated sales/subscriptions schema-audit document was preserved.
