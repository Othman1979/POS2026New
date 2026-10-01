# Second review: order-type numbering and settings recovery

The second source review and local experiments found three defects and reproduced them before changing production code. The table handoff defect was confirmed from the automated PR review before merge; the earlier browser fixture created its table directly through the API and missed this UI boundary. This is not a guarantee for every device or failure combination.

## Findings fixed

1. **P2: recipe tracking changes left shared availability cached.** Pausing/resuming recipe tracking updates shared product balances, even though `recipe_ledger_enabled` is not catalog metadata. The narrowed settings invalidation omitted that dependency. A real HTTP/DB regression in both numbering modes observed a stale catalog `304` and a cached low-stock dashboard warning after the balance became unknown. Backend catalog/dashboard invalidation and the POS settings-event refresh now include recipe tracking. Numbering and receipt-only saves still avoid product reloads. The original count-version conflict and successful fresh-count assertions remain in the test.
2. **P2: lost print replies were reported as known failures.** Timeout already warned of uncertainty, but connection loss and truncated JSON still displayed “Printing failed.” Both new cases failed before the fix. Any missing/unreadable print acknowledgement now warns that printing was not confirmed. An explicit server rejection retains the failure message. No automatic resend or browser fallback was added.
3. **P1: table save/reopen omitted the order type.** The UI save payload, normalized active-table state and backend table responses omitted `order_type_id`; the detailed reader also omitted the scope needed to format an issued `B-1` reference. Regression tests reproduced the missing type and the reference degrading to `1`. The existing payload, readers and realtime rows now retain these fields without another database round trip. The browser experiment now edits/saves an existing non-default table as a waiter, reopens it as a cashier and pays both split seats.

## Additional experiments

- Destroy the connection holding the uncommitted first daily prefix map while another connection requests the same type. The waiting transaction receives `C-1`; subsequent allocations receive `A-1` and `C-2`. The abandoned reservation and map roll back together.
- Start sixteen alternating holds/checkouts for the same type concurrently. All succeed with exactly `C-1` through `C-16`; the eight paid invoices total 46.40. A different type starts at `A-1`, and the next hold receives `C-17`.
- Deliver an expired settings response after a successful recovery. The recovered name and backend-print mode remain intact, and no deadline timers remain.
- Repeat the complete built English/Arabic POS and V2 spooler fixture after the fixes. It covers settings failure/Retry, committed checkout responses lost/truncated/timed out, reload recovery, numbering-mode changes before retry, tables/split seats, held/platform orders, and print-admission uncertainty.

## Verification

| Check | Result |
| --- | --- |
| Full frontend suite | 119 files, 773 tests passed |
| Linked stock writers and settings invalidation | 2 files, 41 tests passed |
| Numbering, automatic migrations, fresh baseline, reset and schema authority | 6 files, 200 tests passed |
| Final table handoff, settlement, store and realtime regressions | 7 files, 300 tests passed |
| Built browser | English 1280px and Arabic 1024px at 4x CPU throttle; no uncaught page errors |
| Real loopback workflow | 234 paid invoices; zero duplicate scoped numbers; four closed shifts with zero variance |
| Connection accounting | 1,549 acquisitions and releases; zero remaining checked-out connections, queued acquisitions or connection errors |
| Print simulation | 47 jobs, 2,293,002 bytes; all byte counts and hashes match; TCP delivery phase 3,875 ms |
| Build and architecture | Passed; the architecture map's one previously recorded defect is unchanged |

The final four alternating 50-sale batches with four concurrent cashiers measured off/on/on/off median latency of 8.49/8.35/8.76/7.08 ms and p95 of 12.27/11.91/13.51/9.70 ms. The earlier run measured medians of 9.89/11.11/10.85/9.65 ms and p95 of 14.13/39.98/16.47/12.83 ms. Typed numbering has extra counter queries; these samples do not prove zero overhead or Hostinger capacity. No concurrent test or benchmark ran during those measurements.

Evidence is ignored under `scratch/second-review-*.log` and `scratch/order-type-workflow-audit/results.json`, including RED failures, GREEN runs, revision/diff/harness hashes and generated fixture identity. Generated loopback databases are removed by their harnesses. The fresh-kit SQL import and GitHub Release gate are separate integration checks recorded in the release/kit evidence.

The final expanded browser run completed all five committed-response recovery cases, the waiter save/cashier reopen workflow in both languages, both split seats, and simulated printing. Its network fixture observes the actual retry request so a late reply cannot satisfy the retry assertion; cancelled badge requests from an abandoned page do not fail the fixture, while the active reply must still complete without dismissing payment. See `scratch/second-review-table-workflow-verified.log` for this complete run.

Physical printers/drivers, a live Hostinger deployment, live JoFotara submission and a complete production-worker/process-crash soak were not exercised. The Hostinger source ZIP does not install the separate Windows spooler; its renderer/journal source changes require a corresponding spooler update on affected machines.

## Release gate follow-up

The first GitHub run exposed an unrelated brittle assertion in `productionLogger.test.js`: on Linux, the asynchronous initial stdout write finished after the synchronous fatal flush, producing levels `[50,60,30]`. All three records survived. The installed Pino/SonicBoom implementation permits this ordering. The test now checks the exact three levels and their content without requiring pipe arrival order; production logging is unchanged. All three focused logger tests passed, and 60 separate Node processes retained every record and structured error on the local Windows runtime. A fresh Release gate is required for the amended PR head.

The superseded run also exposed an older `backend/tests/unit/useTerminal.test.js` fixture that the frontend-only selection did not include. Its print mocks omitted successful initial settings, its race tests expected the old competing-request behavior, and a failed browser test left fake timers active. The fixture now supplies real response-shaped settings, tests the intentional coalesced follow-up semantics, resets module state per case and restores timers unconditionally. The surrounding five-file terminal/checkout/store/event selection passed all 297 tests; no production change was needed for this fixture correction. The subsequent full backend unit selection passed **1,728 tests in 147 files**; the two Windows installer package/update contract files were excluded from that local selection and remain covered by the required Windows installer job.
