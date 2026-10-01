# Database performance follow-up audit

Audit only, on `codex/schema-consolidation-audit` at `4fc37fa4`. Production source, schema, configuration and deployed data remain unchanged. Experiments run sequentially in generated loopback databases; candidate source is compiled in memory from the current modules. Timings below include the real route handler or service and its SQL, but exclude HTTP/auth/browser/network latency unless stated otherwise. Instrumented handler/service totals also include session-status probes and measurement payload serialization; individual SQL timings exclude those probes. Samples alternate current/candidate order, with two warmups and twenty measured samples per variant. Full returned payloads are compared. Row visits mean session `Rows_read`, not distinct business records.

## 1. Shifts listing: smaller date-predicate change is promising

Source: `backend/routes/admin/shifts.js`, GET date filtering. Fixture: 40,000 orders/items, 10,000 refunds/items, 600 shifts, with historical shifts containing new paid, legacy-timestamp, void and refund activity.

The first candidate replaced the activity conditions with a union of eligible shift IDs. It preserved results but was rejected: the optimizer correlated that union with each of 600 shifts. Daily handler time increased **70.884 → 156.652 ms**; broad range **53.381 → 219.427 ms**. Fewer-looking conditions did not produce less work. Evidence: `scratch/db-performance-followup/shifts.cjs` / `shifts.json`.

The smaller candidate retains the existing conditions and splits only the paid-order `COALESCE(invoice_issued_at, created_at)` check into two disjoint `EXISTS` checks: issued timestamp, or null issued timestamp with creation timestamp. Existing indexes suffice; no new table, cache or index is needed.

| Scope | Current median / p95 ms | Candidate median / p95 ms | Row visits | SQL calls |
|---|---:|---:|---:|---:|
| One business day, complete response | 71.868 / 83.280 | 46.498 / 49.990 | 91,949 → 12,953 | 9 → 9 |
| All history, ten-shift page | 53.181 / 56.298 | 52.944 / 61.395 | 17,768 → 17,768 | 9 → 9 |

The daily count/page queries each fell from about 40,727 visits to about 1,229. Broad-date behavior retained the inexpensive opening-date shortcut; its p95 did not improve. Eight filter/range/page comparisons matched complete responses, followed by eight more on a fixture containing active and canceled expenses, subscription cash collections, open shifts, receivables, future-opened shifts and exact end-boundary timestamps. Explicit expected IDs and cash fields passed. Two preliminary edge-fixture setup attempts were corrected for the existing receivable constraints before collecting successful validation evidence; neither was an application defect.

Recommendation: implement this smaller predicate change with permanent regression coverage and normal release validation. Do not implement the union candidate. Evidence: `shifts-paid-range.cjs` / `.json`, `shifts-edge.cjs` / `.json` in the same scratch directory. All these owned fixtures were removed.

## 2. Orders: reject both blanket replacements

Source: `backend/routes/admin/orders.js`. The first candidate grouped selected orders and refunds once before calculating statistics. Daily handler time improved **28.599 → 25.299 ms**, but all-history time worsened **304.370 → 379.770 ms**, despite fewer row visits (**490,352 → 410,350**). Grouping/materialization cost matters as well as reads. Do not use this as the general statistics query. Evidence: `orders.cjs` / `.json`. That first harness's invoice-number search matched no row because the generated numbers were null; it is an empty-search control, not positive lookup evidence.

The second candidate selected a limited page of IDs before loading full rows. Subsequent fixtures assigned actual public invoice/order numbers, asserted successful lookups, and preserved all full responses in ten filter comparisons. Results:

| Request | Current median / p95 ms | Candidate median / p95 ms | Row visits |
|---|---:|---:|---:|
| Daily, 50 rows | 30.058 / 32.901 | 27.530 / 28.859 | 6,459 → 12,596 |
| All history, 50 rows | 308.541 / 318.686 | 301.225 / 323.318 | 490,352 → 496,489 |
| Exact invoice 9 | 14.959 / 17.524 | 3.901 / 4.334 | 13 → 13 |
| Refunded invoice 4 | 14.982 / 16.441 | 3.790 / 4.183 | 17 → 17 |
| Historical refunded invoice 40,000 | 14.625 / 16.280 | 3.697 / 4.091 | 17 → 17 |
| Daily, 200 rows | 36.718 / 39.927 | 130.526 / 132.086 | 7,470 → 76,820 |
| All history, page 100 × 200 rows | 398.268 / 406.733 | 414.145 / 439.173 | 570,563 → 560,713 |

Recommendation: retain the existing general Orders query. A dedicated simpler exact-invoice read is a lower-priority possibility, worth about 11 ms in these local controls, but neither tested rewrite is a safe general improvement. Avoid adding selectivity thresholds/hints just to rescue a losing candidate. Evidence: `orders-page-ids.cjs` / `.json` and `orders-page-controls.cjs` / `.json`. All owned fixtures removed.

## 3. Subscription lists: statistics first, then scoped usage aggregation

Source: `backend/routes/admin/subscriptions.js`, list route. Current SQL calculates active redeemed quantities twice through correlated expressions. A scratch candidate joins one grouped usage result and reuses it for both used credits and derived status.

The first unrefreshed 500-subscription probe visited **472,504 rows** and took **185.432 ms**. That is a single initial probe, not a median benchmark. After fixture statistics refresh, twenty alternating samples measured the unchanged current list at **10.211 ms / 1,116 visits**. This reinforces the earlier statistics-sensitive finding; it does not authorize changing customer statistics automatically.

| Fresh-statistics request | Current median / p95 ms | Grouped usage median / p95 ms | Row visits |
|---|---:|---:|---:|
| 500 subscriptions, first 50 | 10.211 / 11.838 | 6.332 / 7.516 | 1,116 → 1,004 |
| 5,000 subscriptions, first 50 | 86.806 / 91.187 | 49.107 / 53.219 | 11,116 → 10,005 |
| One ID among 500 | 1.949 / 2.688 | 2.301 / 4.846 | 9 → 505 |
| One ID among 5,000 | 1.974 / 2.247 | 5.813 / 6.140 | 9 → 5,005 |

Twenty full-response comparisons cover both sizes, active/exhausted/expired/canceled filters, exact ID, customer-name search, no match and deep empty pages. Usage includes active and reversed redemptions. The fixture uses one customer/plan and manually created subscriptions; it is a stress distribution and does not validate all billed-subscription financial paths. The outstanding-billing filter is an empty control here. One preliminary fixture status value was corrected to the schema's `reversed` value before the successful measurements.

Recommendation: inspect deployed plans/statistics first. Grouped usage is promising for broad lists, but a production version must scope the aggregate to selected subscriptions or preserve the indexed selective lookup path. Do not replace both blindly. Evidence: `scratch/db-performance-followup/subscriptions.cjs` / `.json`; fixture removed.

## 4. Platform summaries: move summary work to SQL

Source: `backend/services/PlatformRemittanceService.js`, `listProviders`. The current implementation already uses two batched queries; there is no per-provider SQL loop. The original audit's statement about a per-provider query loop was inaccurate. The remaining work is that it loads every receivable row, formats several amounts and creates balance tokens before reducing rows to provider totals.

A scratch summary query computes per-invoice integer cents using the existing refund/allocation semantics, then separately sums positive outstanding amounts and absolute credits by provider. Provider discovery/names, active flags, remittance-only providers and the output mapper stay unchanged. The candidate checks out-of-range amounts rather than silently accepting data the current money parser rejects.

| Fixture | Current median / p95 ms | Summary SQL median / p95 ms | Balance query rows / bytes |
|---|---:|---:|---:|
| One provider, 4,000 platform invoices | 57.171 / 62.007 | 31.953 / 35.153 | 4,000 / 962,890 → 1 / 86 |
| Ten invoice providers plus one remittance-only provider | 57.317 / 59.954 | 32.461 / 33.681 | 4,000 / 963,692 → 10 / 845 |

Both variants still execute two queries. Total database row visits remain **8,704 / 8,840** respectively. The balance SQL itself became slightly slower (about 25 → 29 ms), while the complete service became faster by transferring and processing far less data. The returned summary HTTP shape is unchanged; these measurements exercise the service with real SQL, not HTTP transport.

Full outputs match with archived providers, remittance-only providers, partial/full platform refunds, provider credits and remittance reversal. An intentionally oversized allocation sum is rejected by both variants with `PLATFORM_REMITTANCE_INVALID_AMOUNT`. Recommendation: implement a dedicated summary read, preserving per-invoice rounding, positive/negative separation, validation and existing allocation writes. No new index/schema is needed for this measured win. Evidence: `scratch/db-performance-followup/platform.cjs` / `.json`; fixture removed.

## 5. Print queue: backlog cost confirmed; candidate rejected

Source: `backend/services/spoolerSync.js`, the locking queue selection used by `runAgentSync`. Fixture: 20,000 generated jobs, five printers across two stations, inactive printers, assigned jobs, cancellations, pending jobs and failed jobs with null, due or future retry timestamps. These are queue protocol/service checks with placeholder payloads; no physical printer or receipt rendering was exercised.

The candidate selects eligible IDs through three disjoint limited branches, joins full job data afterward and rechecks eligibility under the existing outer `FOR UPDATE`. Station/agent locks, ownership updates and replay logic remain in the compiled service. The following timings cover the selection SQL only, excluding instrumentation probes and transaction setup:

| Distribution, existing indexes | Current median / p95 ms | Candidate median / p95 ms | Row visits |
|---|---:|---:|---:|
| Healthy pending queue | 0.325 / 0.437 | 0.543 / 0.830 | 11 → 22 |
| 19,980 future retries followed by 20 due jobs | 36.104 / 39.477 | 14.002 / 15.916 | 19,991 → 40,002 |
| All jobs waiting for a future retry | 35.103 / 37.318 | 13.538 / 15.280 | 20,000 → 40,000 |
| Mixed printers/statuses | 55.101 / 58.207 | 14.179 / 16.065 | 10,703 → 14,294 |

Stable-fixture IDs and full selected rows matched. A scratch-only `(printer_id, agent_id, status, next_retry_at, id)` index helped the candidate's mixed-printer case (**4.900 ms**) but did not consistently help retry backlogs. With that index the healthy candidate measured **0.872 ms median / 11.040 ms p95**, versus current **0.395 / 0.705**. Its healthy median row count was 22, but the first sample visited 40,022; the per-query first-sample rows in the JSON must not be mistaken for its median. No blanket index recommendation follows from these results.

The cancellation control rejected the candidate as written. A separate transaction locks the first eligible row, selection starts, that row is canceled and the blocker commits. Both variants remained pending before unlock and excluded the canceled job. Across three repetitions each, current selection returned ten valid jobs (IDs 2–11), but the candidate returned nine (IDs 2–10): its limited preliminary set did not refill after eligibility changed. This is a candidate behavior difference, not a reproduced production defect. Lock-wait metadata was visible in only the first current-query run; the harness does not infer missing locks from the other metadata snapshots.

Actual `runAgentSync` concurrency checks passed for both variants: two simultaneous requests from the same agent returned the same ten valid `queue_id` values with ten owned rows; two different stations received ten disjoint IDs each with twenty uniquely owned rows. These successes do not override the cancellation difference or establish full spooler/network correctness.

Recommendation: retain current production selection. Large deferred-retry backlogs are a real tuning opportunity, but the tested rewrite/index combination is not ready to implement. Evidence: `scratch/db-performance-followup/queue.cjs` / `.json` and `queue-services.cjs` / `.json`; the latter is the corrected ID/concurrency evidence. Owned fixtures removed.

## Instrumentation control and priorities

The two strongest candidates received additional sequential timing runs without session-status probes, intermediate JSON serialization or SQL trace collection. Real current/candidate handlers/services share the same borrowed connection, with two warmups and twenty alternating measured samples each. All twenty paired response comparisons passed in every timed scope. These are separate fresh generated fixtures, so compare within each row rather than subtracting instrumentation overhead between runs.

| Scope without instrumentation | Current median / p95 ms | Candidate median / p95 ms |
|---|---:|---:|
| Shifts, one business day | 63.164 / 68.363 | 41.329 / 53.303 |
| Shifts, broad date range | 44.814 / 46.979 | 45.085 / 46.511 |
| Platform summary, one provider | 42.790 / 47.935 | 28.939 / 30.170 |
| Platform summary, ten invoice providers plus remittance-only provider | 45.938 / 50.532 | 30.774 / 62.170 |

The median improvements survive removal of instrumentation. The multi-provider platform candidate's p95 worsened in this control, despite the lower median and previously lower instrumented p95. Tail-latency improvement is therefore not established; a future implementation needs longer steady-state sampling on representative deployment settings before claiming that benefit. Evidence: `shifts-timing.cjs` / `.json`, `platform-timing.cjs` / `.json`, generated by `prepare-plain-timings.cjs`. Financial overflow rejection was also retained in the latter run.

Recommended order, still one implementation at a time:

1. **Shifts date eligibility** (`backend/routes/admin/shifts.js:84`): strongest small change. Daily uninstrumented median improved about 35%, and measured row visits fell about 86%; broad dates were effectively unchanged. Add permanent behavior regressions before modifying production.
2. **Platform provider summary** (`backend/services/PlatformRemittanceService.js:713`): about 32–33% lower uninstrumented median and dramatically less returned data. Preserve exact money validation/rounding and measure the remaining p95 concern. This is a dedicated read-path improvement; settlement writes need no redesign.
3. **Subscriptions usage aggregation** (`backend/routes/admin/subscriptions.js:524`): conditional improvement. Check actual plans/statistics, then evaluate an aggregate scoped to selected subscriptions. The tested global aggregate slows exact-ID reads.
4. **Exact-invoice Orders lookup**: optional, smaller follow-up. Do not apply either rejected general Orders rewrite.
5. **Deferred print retries** (`backend/services/spoolerSync.js:245`): confirmed backlog cost, no acceptable replacement yet. Preserve current locking selection until a candidate also handles cancellation/refill and healthy-queue overhead correctly.

## Verification and limits

- Local Node **24.16.0**, MariaDB **10.4.32**, **16 MiB** InnoDB buffer pool, query cache off, `performance_schema` off, `REPEATABLE READ`. These settings and synthetic distributions differ from Hostinger and CI; timings are comparative local evidence, not promised customer latency. No live slow-query workload or production lock-wait distribution was collected.
- Twelve final experiment artifacts completed with successful payload/control assertions and their owned fixture databases removed. Fifty-six recorded actual `ANALYZE FORMAT=JSON` plans parsed without `analysis_error`. Timing-only controls deliberately contain no plan instrumentation.
- Final read-only schema/process checks found none of this audit's databases or connections remaining. One unrelated older review database, `posapp_review_recipe_p1_3b0c1cf71f91`, remains and was preserved; it is identified by the existing `scratch/order-type-workflow-audit/posapp_review_recipe_p1_3b0c1cf71f91.json` artifact at revision `49c736b8`. No cleanup of another task's data was attempted.
- Final tracked diff is empty against `4fc37fa4`; six relevant source files also match committed content after newline normalization. Evidence hashes and cleanup results are in `scratch/db-performance-followup/final-verification.json`.
- No production code, permanent test, schema, configuration or customer data changed. The new durable output is this audit report; experiment scripts/results remain ignored under `scratch/`. The pre-existing untracked sales/subscriptions schema report was preserved. Nothing was committed, pushed, released or deployed.

This audit supports focused next changes and rejects several tempting general rewrites. It does not establish complete correctness, customer-device performance, network-failure behavior or physical printing reliability.
