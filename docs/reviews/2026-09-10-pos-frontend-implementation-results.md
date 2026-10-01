# POS frontend performance and Orders remediation

Implemented in the shared Local checkout on `codex/pos-frontend-audit`, following the [audit](2026-09-10-pos-frontend-performance-audit.md) and [three-stage implementation checklist](../plans/2026-09-10-pos-frontend-performance-implementation.md). Baseline source: `1b1d9c5a20ea9006e6d6355a5c26d7655aa2d72b`. No deployment, push or PR is included.

## Changes

| Area | Result | Verification before changing production code |
| --- | --- | --- |
| Admin Orders details | Loading and error states contain no fabricated invoice totals/actions; stale successes/failures cannot replace another invoice. Closing or leaving cancels the read. Retry handles HTTP/validation failures. | 10 new failures demonstrated the old null and ownership behavior. |
| Held/history board | Serialized reads with one trailing refresh, reconnect recovery, explicit failure/Retry, early subscriptions, cancellation and disposal guards. Continuous notifications still publish progress and release callers. | 8 failures, plus a progress regression found during review. |
| Table split list | Concurrent callers share reads; events/mutations during a read await a final fresh result. Failed reads retain unpaid checks. | 4 failures across shared requests and failed snapshots. |
| Visible board loading | Only the selected list loads; metadata starts in parallel and refreshes on settings/reconnect. Tab changes cancel obsolete work. | 3 failures across initial requests, switching and metadata ownership. |
| Floor/split lifecycle | One initial split read, one read for a ten-event burst, no hidden debounce or presentation-clock work; split board refreshes on reconnect. | 6 failures across startup, event bursts, disposal, clocks and loading ownership. |
| Read deadlines | Selected operational GETs have a 15-second deadline through headers and JSON body. Cancelling/expiring reads releases recovery; mutation semantics are unchanged. | 4 HTTP-helper failures plus Orders and held-board stalled-body regressions. |
| Rendering | Read-only board snapshots avoid deep reactive wrapping; sorting parses each timestamp once. Catalog bindings reuse store quantities and derived styles. | Board behavior passed before/after; browser samples compare the same build/fixture workflow. Catalog cache/invalidation regressions failed first. |

## Measurements

Same synthetic 200-ticket board, Chromium on this Windows workstation, **4x CPU throttle**, before/after the board rendering changes:

| Action | Samples per variant | Before median main-thread work | After median main-thread work |
| --- | ---: | ---: | ---: |
| Held-board refresh | 15 | 82.5 ms | 53.6 ms |
| Open 200-row History | 3 | 427.8 ms | 318.6 ms |
| Cold 200-ticket board | 3 | 789.1 ms | 744.6 ms |

These are diagnostic samples, not guaranteed customer speedups or physical four-core/4-GB-PC measurements. The three-sample actions are especially sensitive to warmup and system noise. The measurement is accumulated CDP main-thread work through readiness and settling, not INP or click latency.

Request reductions are deterministic fixture checks: ten floor notifications now cause **one split-list GET**, down from ten; initial floor entry makes **one split-list GET**, down from two. Notes startup issues **three overlapping reads**, with no unused 200-row History payload. Previously four reads ran in sequence; at 150 ms per response, their delay accumulated to about 600 ms.

## Preserved boundaries and decisions

- KeepAlive and warm navigation remain in place. The cart, quantities, prices, tax, discounts, identity and saved English/Arabic note are checked across POS, notes and tables.
- No checkout, tax, stock, held-claim/version, kitchen dispatch, uncertain-print or table settlement authority was rewritten. HTTP deadlines are opt-in for the audited reads.
- Every ticket remains in the board and platform settlement calculations. No truncation or virtualization was introduced. Large initial boards can still produce long tasks; the changes reduce work without introducing variable-height scrolling/focus risks.
- Existing eager selling/operational modal loading remains. Expense/subscription open watchers currently rely on already-mounted components, and async splitting would need a separate first-open and obsolete-chunk recovery path. No new library or network dependency was added to a cashier action.
- `startTime` / `reportAllChanges` remains a separate upstream DevTools finding documented in the audit. No global error suppression was added.

## Verification

- Production Vite build: passed.
- Frontend: **698 tests across 113 files passed**.
- Focused read, lifecycle, quantity, sort and request ownership regressions are committed with their changes.
- Checkout browser contract passed: cash/card/split/platform flows, failed-print warning, invalid receipt handling, lost-response tender/key preservation, held handoff/recovery and no Vue/page errors, using local HTTP/print doubles.
- Category recovery browser checks passed in English/Arabic desktop/mobile, including failed reads, Retry, cancellation, late replies, cart preservation and native body deadlines.
- Isolated selling checks: **224 tests across 7 files passed**, covering checkout, held authority/kitchen dispatch, platform settlement, table workflows and session/draft persistence. The runner created and removed its own guarded loopback database.
- Final production-build matrix: **eight cases passed** across English/Arabic, desktop/mobile and native/4x CPU. Cart values and saved notes were preserved; Orders interactions produced zero runtime errors. Controlled HTTP failures, delayed/stale replies, reconnect recovery and disposed-board reads were checked.
- Extended diagnostics: **12 navigation cycles passed**, with sampled JS heap between **14.07 and 14.37 MiB**. This short synthetic run does not establish whole-machine memory usage or indefinite leak freedom.
- All three real **15-second stalled-body deadlines and Retry** recovered: Orders details, held orders and split checks. No production timeout was shortened for these browser checks.
- Desktop and mobile details and the Arabic held board were visually inspected; the existing layout and full ticket lists remain.

The [compact evidence](2026-09-10-pos-frontend-implementation-evidence.json) records source hashes, comparison sample counts, request counts, cart preservation, errors and recovery results. Raw logs and complete measurements are under ignored `scratch/pos-*`. The harness serves built assets with synthetic authenticated sessions and refuses unexpected business writes. No customer browser, production DB, payment provider or physical printer was used.
