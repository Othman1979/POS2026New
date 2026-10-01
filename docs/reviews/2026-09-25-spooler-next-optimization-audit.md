# Further spooler optimization audit

Read-only production audit of `codex/typst-transport-reliability` at `bafc5193`. No implementation, service changes, database access or physical printing. Probes used ignored scratch files, the actual C# helper with the existing fake Winspool adapter, and synthetic local journal records.

## 1. Windows job observation blocks commands for other printers

`pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs:591` sends only `print_raw` to the thread pool. `wait_job` executes synchronously on the stdin command reader via `ExecuteAndWrite`/`WaitJob`. Although Node has independent endpoint lanes, a long observation for printer A prevents the helper from reading printer B's next submission.

Reproduction: submit a 50 KB ticket to the fake Kitchen with a 3-second device pause, start a 2-second `wait_job`, then submit another ticket to Register. Register's submission acknowledgment took **1962.35 ms**, compared with **0.72 ms** without the other observation. The normal Node observation window is 60 seconds, so the defect is not limited to this short fixture. This is helper-command delay, not a measured physical print duration.

Recommendation: run bounded outstanding job observations outside the command reader, retaining one transport lane per physical endpoint, request-id correlation and orderly shutdown. Preserve completed/submitted/uncertain distinctions. Verify a long paper-out on A cannot delay B, while two jobs for A remain serialized and cancellation/restart never duplicate either ticket.

Evidence: `scratch/spooler-next-audit.cjs`; `scratch/spooler-next-audit-1790291799466/helper-results.json`.

## 2. Windows printer status-watch request rejects a valid JSON array

`PosSpoolerPlatform.cs:96` requires `System.Collections.ArrayList`, while the deployed .NET Framework `JavaScriptSerializer.DeserializeObject` returns `System.Object[]` for the `printer_names` array. The actual helper reproduced `REQUEST_INVALID` for the JS helper's normal `watch_printers` request. The type was independently checked under Windows PowerShell 5/.NET Framework. This concerns the background printer-status watcher; the per-job completion notification path is separate.

The status monitor consequently retries the watch every two seconds rather than maintaining the intended watch. Accept/validate the actual array contract, then test the real native protocol, not only a JS mock.

Related latent issue: `StartWatch` has no wait when its handle dictionary is empty, and otherwise waits sequentially up to 200 ms per handle. Add an explicit no-handle/backoff path and a stoppable wait over the handles. An empty-handle CPU spike was **not** demonstrated on the unmodified protocol, because the parser rejection occurs first; do not report one as measured. Microsoft's [wait functions documentation](https://learn.microsoft.com/en-us/windows/win32/sync/wait-functions) describes the multiple-object wait mechanism. Account for handle limits and shutdown rather than adding one busy loop per printer.

## 3. Keep archived payloads out of the active in-memory working set

`pos-spooler-printer/v2/job-store.js:119` loads all archived records, including their saved payloads, into the same Map as active work. The archive is retained for 14 days. `health`, `runnable`, `outbox` and `unconfirmedAccepted` repeatedly traverse that Map; several run within each sync cycle. Normal local capacity is only 50 active jobs, so history should not determine that cost.

Synthetic measurements with 8 KiB saved payloads per completed archived job, packaged Node 22.23.0, separate processes and forced GC around load:

| Archived jobs | Store open | Retained heap increase | Read-cycle median / p95 |
| ---: | ---: | ---: | ---: |
| 0 | 1.49 ms | 0.03 MiB | 0.024 / 0.035 ms |
| 1,000 | 48.88 ms | 8.48 MiB | 0.067 / 0.100 ms |
| 10,000 | 562.23 ms | 84.36 MiB | 0.677 / 1.180 ms |

The read cycle calls health, runnable, and the repeated accepted/outbox readers, without network or printing. These are workload-specific local observations, not customer archive counts or claimed post-fix savings. Memory is the stronger opportunity; sub-millisecond reader work alone would not justify a redesign.

Recommendation: keep active work and unresolved recovery holds fully resident; retain only a compact identity/outcome index for acknowledged completed history, with historical payloads left on disk and loaded when needed. Preserve replay conflict detection, archive retention and unresolved endpoint holds. First separate the active readers from archived entries, then verify compaction and restart behavior. Cache inexpensive diagnostic counts only where ownership/invalidation is explicit. [Node's filesystem documentation](https://nodejs.org/api/fs.html) also explains why unnecessary synchronous reads block the event loop; required durability writes must remain.

Evidence: `scratch/spooler-journal-audit.cjs`, generated `scratch/spooler-journal-audit-{0,1000,10000}-*/` fixtures.

## Lower-priority candidates

- Windows currently hashes an artifact in Node, then hashes it again through the native helper before writing. Do not remove integrity checks merely to reduce reads. Any consolidation must preserve verification before the first printer byte and correct failure classification; no timing benefit was established here.
- Native partial `WritePrinter` returns allocate/copy the remaining segment. Buffer-offset P/Invoke could reduce this for pathological partial writers, but normal full writes already reuse a 64 KiB buffer. Measure a real affected driver before adding complexity.
- Idle HTTP cadence and status probes already coalesce work and preserve responsiveness. Increasing their intervals trades freshness/latency for fewer calls; no new transport polling constant is recommended from this audit.

Priority: fix independent-printer command blocking, repair the native watch contract and empty-watcher behavior, then reduce retained journal payload memory. Preserve the existing serial endpoint delivery, fsync/atomic journals, sent markers and uncertain-send recovery rules throughout.
