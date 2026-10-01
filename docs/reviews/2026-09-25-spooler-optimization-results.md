# Sequential spooler optimization results

Branch: `codex/typst-transport-reliability`. Baseline: `bafc5193`.
All measurements use isolated local fixtures; no physical printer, customer DB or installed service is modified.

## 1. Independent Windows job observation

Reproduced before changing production code with the real C# helper and the existing fake Winspool implementation. While Kitchen was paused, its 3-second observation blocked Register submission for **2941.8 ms**. The regression test failed as expected.

Moved `wait_job` onto bounded dedicated observation threads, outside the stdin reader and the print-submission thread pool. At most 64 observations can be outstanding; shutdown signals observations to close their handles, while preserving in-progress native writes. Endpoint serialization remains in the existing Node worker lanes. No OS job is canceled by an observation deadline.

Afterward Register submission took **0.87–0.95 ms**, both full artifact byte streams arrived, and Kitchen recovered after the pause. The 65th observation was rejected, and 64 paused observations shut down gracefully in **14.7 ms** with native exit code 0. These are command-submission measurements, not physical paper latency.

Passed: `v2-windows-observation`, `v2-platform-helper`, `v2-printer-workers`, `v2-print-priority`, and the native `v2-windows-delivery` scenarios (normal, partial writes, unsupported retention, release failure, 12-second paper change, direct write, operator cancellation, repeated observation windows, and parent EOF during a write).

## 2. Background status watcher

The native regression first reproduced `REQUEST_INVALID`: the JSON deserializer supplied `Object[]`, but the helper accepted only `ArrayList`. The helper now accepts validated JSON arrays, deduplicates queue aliases, and waits on all notification handles together. A passive 250 ms watchdog bounds normal shutdown; missing notification handles retry at 30 seconds instead of spinning. Native observation sequences prevent an older snapshot from overwriting a newer event, and logical aliases of the same Windows queue all receive the status.

With 64 queues, the last queue's scheduled paper-out event arrived **526–536 ms after the request**, including the fixture's deliberate **500 ms delay**. This demonstrates it does not wait through 63 sequential 200 ms waits; it is not a physical driver latency measurement. With no usable handles, the actual helper process used **0 ms measured CPU over 1.24 seconds**, rather than a busy loop. Empty watch replacement and graceful process shutdown passed.

Final review also reproduced a slow initial snapshot blocking the protocol reader: two simulated 800 ms `GetPrinter` calls delayed an independent Register submission **1591.7 ms**. Initial snapshots now publish from the watch thread through existing status events, including unavailable queues, instead of a duplicate synchronous snapshot in the request handler. The same fixture submitted in **6.24 ms**, delivered every artifact byte, and eventually published the slow status. Watch replies retain the existing `statuses` array, now empty; new observations arrive through the existing event channel.

Passed: native `v2-windows-watch`, `v2-windows-observation`, `v2-platform-helper`, and `v2-status-monitor`, including invalid arrays, the 64-printer bound, aliases, stale snapshots, helper restart sequences and unavailable queues.

## 3. Archived journal working set

The regression first retained **16.47 MiB** for 1,000 acknowledged jobs with 16 KiB payloads. It now retains **1.25 MiB**. Full archived JSON stays on disk and is loaded only for an explicit archived-record read. An in-memory active-job index bounds routine health, acceptance, outbox and runnable reads. No new on-disk format, database table or persistent index was added.

Three alternating baseline/current runs using synthetic 8 KiB payloads and ten active jobs:

| Archived jobs | Retained heap before → after | Median routine read cycle before → after | Read-cycle p95 before → after |
| ---: | ---: | ---: | ---: |
| 0 | 0.14 → 0.14 MiB | 0.031 → 0.031 ms | 0.044 → 0.041 ms |
| 1,000 | 8.58 → 1.17 MiB | 0.070 → 0.034 ms | 0.103 → 0.043 ms |
| 10,000 | 84.60 → 10.54 MiB | 0.449 → 0.069 ms | 0.666 → 0.090 ms |

Each timing above is the median of three separate-process results. The 10,000-job retained heap fell **87.5%**. This is journal heap, not total spooler memory. Startup still reads and parses the archive: observed 10,000-job open times overlapped widely (**423–941 ms before**, **485–972 ms after**), so no startup speed improvement is claimed. Rare explicit archive reads now perform disk I/O. Unresolved uncertain jobs keep their complete record and endpoint holds until explicit recovery.

Passed: archive replay/conflict identity, full payload after restart, cancellation, late artifact retention with failed atomic replacement, 14-day cleanup, uncertain endpoint hold/recovery with disk failure, result acknowledgement interrupted after rename, corrupt lazy reads failing closed, and stale active-file/archive precedence. Routine reads made **zero archive payload reads**. The existing journal, sync-runtime, printer worker, endpoint safety and printer recovery checks also passed.

Reproduce the paired measurement with `node scripts/reviews/spooler-journal-performance.cjs --baseline=07440189` (the script runs its isolated samples with forced GC). Raw local results: `scratch/spooler-journal-comparison.json`. The script creates and removes only its own random OS temporary directories. Test fixtures do not prove physical paper completion or deployed PC resource use.

## Combined verification

- The complete **43-file spooler suite** passed with the prepared Typst executable/fonts and packaged Node 22.23.0. After the final asynchronous snapshot change, native watch/observation/delivery, platform-helper and status-monitor regressions were checked again.
- Real isolated HTTP API → durable queue → Typst → loopback TCP passed for X, Z and a 100-item Y report, with exact artifact byte counts/hashes (56,270 / 60,670 / 231,174 bytes).
- A deliberately lost result acknowledgment followed by agent restart replayed the durable result without another ticket: **four TCP deliveries before and four after restart**. A separate pre-send connection failure recovered after restart with **one delivery**.
- The fixture created and removed its own guarded loopback database; no application/customer database, installed service or physical printer was changed. Receipt rendering and transport safety rules remain unchanged.
- Architecture generation/check and `git diff --check` passed. Logs: `scratch/spooler-optimization-final-suite.log`, `scratch/spooler-optimization-final-native.log`, `scratch/spooler-optimization-final-e2e.log`; API evidence: `scratch/shift-report-spooler-recovery/results.json`.
