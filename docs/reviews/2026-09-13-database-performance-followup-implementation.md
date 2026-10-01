# Database performance follow-up implementation

Scope: implement the two supported follow-up candidates, sequentially: Shifts date eligibility, then platform provider summaries. Baseline: `4fc37fa4ac6cc89d3c16eb2c52c9e0e43d9c66e6` on `codex/schema-consolidation-audit`. The conditional subscription rewrite and rejected general Orders/queue rewrites are outside this implementation.

## Shifts date eligibility

The list count and page queries now test issued timestamps and legacy null-issued creation timestamps separately. This preserves issued-time precedence, date boundaries, payment exclusions, and the existing activity checks for refunds, voids, expenses and subscription collections. Existing indexes suffice. No migration, write-path change or setting is introduced.

Before the production edit, the new `shiftsDateQuery.test.js` behavior cases passed, while the historical-work regression failed at **8,467 row visits**, against a generous limit of 4,000. The limit measures database work, not elapsed time or a particular optimizer plan. Tests also cover date-filtered pagination, frozen closed-shift variance and old open shifts with other financial activity.

Verification: **80 tests passed** across `shiftsDateQuery`, `shift` and `shiftDiscountQuery`, including existing real API lifecycle, cash corrections and reports. Evidence: `scratch/shifts-date-red.json` and `scratch/shifts-date-green.json`.

The implemented route was compared with the exact baseline source on generated databases with 40,000 orders, 10,000 refunds and 600 shifts. Eight ordinary response comparisons and eight additional financial/boundary comparisons matched; the latter includes receivable activity, expenses, subscription collections and future-opened shifts. Twenty alternating timing samples per variant, after two warmups, measured:

| Shifts scope | Baseline median / p95 ms | Implemented median / p95 ms | Instrumented row visits |
|---|---:|---:|---:|
| One business day | 59.453 / 61.396 | 36.540 / 38.191 | 91,949 → 12,953 |
| Broad date range | 43.270 / 45.326 | 43.694 / 44.814 | 17,768 → 17,768 |

Timings above exclude measurement probes; row counts come from separate instrumented runs. Both execute nine application queries. Source syntax and whitespace checks passed. Evidence: `scratch/db-performance-followup/shifts-implemented-{edge,reads,timing}.{cjs,json}`. Each harness removed its own fixture. These checks complete the Shifts change before platform work starts.

## Platform provider summaries

`listProviders` now aggregates exact stored DECIMAL amounts in SQL and returns one balance row per provider. Positive outstanding balances and negative provider credits remain separate, with cents converted before transfer. Provider discovery, archived flags, name fallback, remittance-only providers and the public response shape are unchanged.

The allocation join is shared with the existing invoice-detail reader, so both paths retain the same reversal signs. The summary checks maximum absolute per-invoice refund, allocation and open amounts through the existing money validator. This retains individual amount limits and their error messages without incorrectly limiting a provider's combined total. Invoice totals remain bounded by their existing `DECIMAL(10,2)` column. No new index, table, cache, dependency or endpoint was added; transaction and write logic is unchanged.

Before editing production, six behavioral cases passed and the transfer regression failed: 500 invoices for two providers returned **502 DB rows**, against a summary work bound of four. After the edit, all **17 focused integration/unit cases** passed, including the four-row bound. Existing real API, transactional, report and held-settlement suites then passed **29 more tests**. They include idempotent retries, rollback, signed credit reversal, conflicting concurrent allocations and a real refund racing with reconciliation under the shared lock.

Evidence: `scratch/platform-summary-{red,green,workflows}.json`. The implemented service was also compared with baseline source on 40,000 orders / 4,000 platform invoices, including partial/full platform refunds, credit balances, remittance reversal and a remittance-only provider. Instrumented results:

| Provider fixture | Balance rows before → after | Serialized balance rows, bytes before → after | Application queries | DB row visits |
|---|---:|---:|---:|---:|
| One provider | 4,000 → 1 | 962,890 → 164 | 2 → 2 | 8,704 → 8,704 |
| Ten invoice providers plus remittance-only provider | 4,000 → 10 | 963,692 → 1,627 | 2 → 2 | 8,840 → 8,840 |

These are JSON serialization sizes measured by the harness, not MySQL wire bytes. Savings come from reduced transfer and JavaScript processing, rather than fewer database row reads. Larger follow-up runs used ten warmups and **120 alternating samples per variant per scope**, without SQL instrumentation. Every paired complete response matched:

| Platform scope | Baseline median / p95 ms | Implemented median / p95 ms |
|---|---:|---:|
| One provider | 36.481 / 42.357 | 25.764 / 28.681 |
| Ten invoice providers plus remittance-only provider | 36.530 / 40.219 | 26.184 / 28.084 |

The audit's slower candidate p95 did not recur in this longer implementation comparison. This establishes an improvement on this local fixture, not a guarantee for all deployment distributions. Evidence: `scratch/db-performance-followup/platform-implemented-{reads,timing}.{cjs,json}`. Both fixtures were removed, and oversized allocation rejection was checked against both baseline and implemented services.

## Completion checks

The two changes were implemented sequentially, with **126 passing focused tests** in total and separate failing-before/passing-after resource regressions. Local measurement environment: Node 24.16.0, MariaDB 10.4.32, 16 MiB InnoDB buffer pool, query cache off, `performance_schema` off, REPEATABLE READ. No Hostinger/customer workload, physical printer, browser UI or network outage was exercised for these read-path changes. Existing real HTTP route tests cover permissions and response behavior.

Syntax, whitespace, architecture consistency, evidence and fixture-cleanup checks accompany the final local commits. Final evidence hashes and database cleanup checks are recorded in `scratch/db-performance-followup/implementation-verification.json`. The unrelated untracked sales/subscriptions schema audit remains untouched. No push, PR, merge or deployment was requested or performed.

## Rollout and rollback

No deployment is performed by this task. Deploy through the normal Release gate when separately authorized. There are no schema changes or data conversions: rollback is the affected source commit's reversal and the normal application restart. After deployment, compare filtered shift IDs/counts and totals, platform provider outstanding/credit totals, request latency and database errors on the same representative dates and providers. Local generated-fixture timings are comparative evidence, not customer latency guarantees.
