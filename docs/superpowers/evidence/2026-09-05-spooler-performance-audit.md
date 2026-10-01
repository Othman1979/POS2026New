# Spooler printing performance audit — 2026-09-05

## Scope and verdict

Audited current source at `8838abff`, branch `codex/operational-reset-corrections`: kitchen dispatch, authenticated sync, local journal, render scheduling, Chromium/raster output, TCP transport, status monitoring, Windows helper dispatch and retry boundaries. Audit only: no production code changes, customer connections, deployment, or physical printer tests.

There are real spooler-side improvement opportunities. The strongest candidates for **first ticket fast, later tickets slow on one TCP printer** are retained half-open connections and status probes sharing that printer's lane. Neither establishes the cause on the customer's hardware without its configuration and timings. Cold Chromium normally explains the opposite pattern.

## Reproduction and measurement

Runnable local harness: `docs/superpowers/evidence/2026-09-05-spooler-performance-probe.cjs`.

From repository root:

```powershell
& deployment/out/toolchain/node/node.exe docs/superpowers/evidence/2026-09-05-spooler-performance-probe.cjs
```

Uses temporary files and loopback TCP only; destroys its sockets and removes its own temporary directory. Renderer tests use real installed Puppeteer/Chrome and canvas. Retry/deadline/lane probes use controlled doubles around production modules. The initial findings below describe the audited baseline; the harness assertions were subsequently updated to require corrected behavior. See the remediation note at the end.

Measured on Windows, i7-14700KF, packaged Node 22.23.0. Three Node 22 runs (not a statistically representative percentile benchmark):

| Real rendering workload | Wall time range | Raster bytes | Height |
|---|---:|---:|---:|
| Synthetic kitchen, 1 row, fresh browser | 686–694 ms | 2,898 | 40 dots |
| Same workload, warm browser | 65–85 ms | 2,898 | 40 dots |
| Synthetic kitchen, 10 rows | 120–139 ms | 28,826 | 400 dots |
| Synthetic kitchen, 50 rows | 435–447 ms | 144,074 | 2,000 dots |
| Existing 200-row report fixture, warm | 1,527–1,550 ms | 535,206 | 7,430 dots |

Synthetic kitchen uses explicit 40-dot rows, not the customer's template. The report uses `pos-spooler-printer/tests/fixtures/v2-report-200-rows.js` through the normal renderer. Results include artifact generation/durability, not cloud pickup, actual network printer buffering or paper movement. This CPU is substantially different from the previously reported customer i3; do not promise these times there. An exploratory Node 24 run is excluded from the table because the packaged runtime is Node 22.

## Findings, in recommended order

### 1. TCP success leaves connection lifetime dependent on the printer

Evidence: `pos-spooler-printer/v2/printer-transports.js:155–199`.

`finishSocket()` resolves at the `socket.end()` callback and cancels its timeout. The successful path has no subsequent close bound or destruction. The callback means the writable side finished; it does not prove the peer closed its side. The exception path destroys the socket.

**Real loopback reproduction:** a reading `allowHalfOpen` peer received three successful sends. After 150 ms, all three client sockets and three peer sockets remained open. The peer received EOF in the earlier targeted experiment: this is not a failure to send FIN. The local probe deliberately closes everything afterward.

Impact: retained sockets and possible connection-slot pressure on printers that do not close their side. This pattern can accumulate after the first print; actual printer impact remains conditional.

Recommended correction: bounded successful teardown with late-error handling, without making an already-sent job retryable. Do not blindly destroy before buffered bytes finish or reinterpret a teardown problem as permission to print again. Test peers that close normally, remain half-open, close early, and reset after write completion.

### 2. Background status can delay an arriving print on the same printer

Evidence: `pos-spooler-printer/server.js:113`, `v2/status-monitor.js:4–76`, `v2/printer-workers.js:262–273`, `v2/printer-transports.js:204–231`.

The monitor learns a printer through transport selection, then polls every two seconds after each poll completes. An already-started probe owns the same lane as printing. New jobs must wait. An `escpos_status` probe can spend up to 1.5 seconds connecting plus 1.5 seconds awaiting status; failures have no per-printer backoff.

**Reproductions:** held probe on printer 1 blocked its kitchen send while printer 2 sent successfully. A connected but silent loopback status peer took 1,511–1,514 ms before `STATUS_PROBE_FAILED`. `write_only` took 0 ms and opened zero sockets.

This is especially relevant to the reported first-versus-later pattern because the printer is observed after it begins receiving jobs. **It does not explain a printer configured as `write_only`.**

Recommended correction: printing should have priority over cancellable diagnostic work; back off repeatedly unresponsive status checks. Preserve same-device byte isolation. Verify the customer's capability before changing it; do not enable status querying indiscriminately.

### 3. Page creation escapes the spooler's render timeout

Evidence: `pos-spooler-printer/v2/artifact-renderer.js:575–624`, `v2/printer-workers.js:322–323`.

`await instance.newPage()` happens before the page-work deadline and its cleanup block. A stalled page creation therefore occupies the one render queue beyond the configured render timeout, affecting every printer waiting for rendering.

**Reproduction:** configured render timeout 30 ms; a held `newPage()` was still pending at 120 ms. The harness explicitly rejected it afterward to clean up. This proves a gap in our timeout, not that real Puppeteer necessarily hangs forever: underlying protocol/process errors may eventually reject it.

Recommended correction: include page acquisition in the bounded rendering operation and clean up a page that resolves after timeout. Test that another kitchen job can proceed after recovery. Merely checking for a `withDeadline` symbol is insufficient.

### 4. Safe connection retries unnecessarily rerender the artifact

Evidence: `pos-spooler-printer/v2/printer-workers.js:103–117,322–323`, `v2/job-store.js:265–278`.

The retry retains the artifact but changes state to `retry_wait`. The renderer gate requires state `rendered`, so a pre-byte transport retry rasterizes again.

**Reproduction:** one kitchen job, first send deliberately refused before its marker, second send succeeds: **two renders, two sends, one completed job**. Fake clock avoids waiting the production retry interval; store double uses replacement records like the real store.

Recommended correction: reuse the existing immutable artifact for transport-only retries, retaining transport hash verification and explicit behavior for missing/corrupted files. This saves CPU, screenshots and disk writes when a printer is unavailable. Do not remove the existing retry pacing or post-marker uncertainty rule.

### 5. Unchanged agent status performs a synchronous durable write every successful sync

Evidence: `pos-spooler-printer/v2/agent-runtime.js` calls `store.setAgentStatus(currentStatus)` on each successful response; `v2/job-store.js:375` always uses `writeAtomic`, including `fsyncSync` at line 35.

Even repeated `active` responses rewrite `agent-runtime.json`. At the healthy 1.5-second hold plus 0.5-second reschedule cadence, this is approximately 43,200 writes/day if continuously running, excluding request time; active traffic changes the rate. This is a cadence calculation, not a field disk measurement.

Recommended correction: persist actual status changes, with correct startup/recovery behavior. Keep job acceptance, before-byte markers and terminal results durable. The redundant status write is separable from those safety-critical writes.

## Important limits and lower-priority opportunities

### Shared renderer and large documents

Rendering is serial. Priority helps kitchen jobs overtake *waiting* reports, but cannot interrupt an already-rendering report. The measured report occupies rendering for about 1.5 seconds on this PC; later kitchen work can wait that long. Transport lanes are independent after rendering. This is a deliberate resource tradeoff, not proof that introducing more browsers is worthwhile.

`server.js` does not call renderer `warm()`. Cold-start work remains on the first ticket. Warmup might help startup, but does not explain subsequent-only slowness. Do not add parallel browsers or change 256-dot band geometry without CPU/memory and physical-output measurements. Bounded raster clipping is valuable and should remain.

### Retained history and journal scan cost

`v2/job-store.js:6,70–92,303–359` loads active and archived full records into one Map. Retention is 14 days. Runnable/outbox/acceptance/health operations iterate retained entries; some allocate arrays even when all records are archived. Cleanup performs synchronous filesystem work hourly.

This makes memory/startup/scan work proportional to retained history, not just the 50-job active capacity. No representative large-journal benchmark was run, so magnitude is unquantified. If measured significant, keep lightweight deduplication identity separate from active work. Do not simply delete replay protection. As a size illustration only, 1,000 daily artifacts averaging 144 KB retained for 14 days would be about 2 GB before journal overhead; this is not an estimate of the customer's actual ticket size or volume.

### Current timing does not measure paper completion

`v2/printer-workers.js:229` records transport `duration_ms`; renderer artifacts separately contain `render_ms`, but the result does not expose a complete pickup/queue/render/send breakdown. `raster_ms` is always zero, not a measured raster duration. TCP `bytes_sent` is not a physical-print acknowledgement. The worker comment suggesting device time must not be interpreted as paper timing.

A small bounded stage-timing record would make the next field incident diagnosable. No per-chunk log spam, SQL tracing, telemetry platform, or template content logging is needed.

## Paths that should not be rewritten on this evidence

- Kitchen dispatch resolves/deduplicates matching printer destinations and durably queues jobs; no intentional fixed sleep found in that route.
- Sync already supports authenticated 1,500 ms long holds with advisory wakeups and 500 ms post-hold recovery cadence. A job arriving during the reschedule gap may wait that gap plus request/DB time. This is not legacy Socket.IO job delivery. No framework migration or new broker justified.
- Worker tests verify different-printer transport overlap, same-printer exclusion, retries and uncertainty boundaries. Keep these invariants.
- Windows `print_raw` is dispatched through helper thread-pool work (`windows-helper/PosSpoolerPlatform.cs:523–524`); it is not forced through the JS status-command serial tail. Windows queue draining checks at up to 400 ms intervals (`:267–296`), so its confidence/timing differs from raw TCP. No physical USB/shared-printer speed measured.
- Artifact hash verification reads before transport streams the file again. That extra read is visible, but removing the integrity check is not a justified performance cut.
- The restart-only taskkill process-not-found message is not timing evidence for kitchen transport.

## Verification and limitations

Six directly invoked test files passed under packaged Node 22.23.0:

- `v2-printer-transports.test.js`
- `v2-printer-workers.test.js`
- `v2-status-monitor.test.js`
- `v2-artifact-renderer.test.js`
- `v2-sync-runtime.test.js`
- `v2-hostile-runtime.test.js`

Expected injected EACCES/ENOSPC/hook errors appear in worker test output. All commands exited zero. The hostile harness includes source scans and fake-clock figures; its requests-per-second figures are **not** real HTTP/MySQL capacity measurements. Its source-only browser timeout check does not catch finding 3.

No customer-till CPU/RAM profile, network trace, printer model/firmware/capability inspection, real cloud timing, physical ticket stopwatch test, or USB/shared-printer test was performed. None of the above claims 100% physical performance verification.

Recommended sequence: fix successful TCP teardown, probe contention, render page-acquisition deadline, artifact reuse, then unchanged-status writes. Add compact stage timings before deciding on larger rendering/storage changes. No framework replacement is needed for these corrections.

## Remediation on the same branch

The five actionable findings above are now corrected in source:

- TCP sockets are destroyed after the end callback has completed (or on failure), with a lifetime error listener covering late/between-phase errors. Success remains `bytes_sent`, not paper confirmation. Local socket count in the half-open test changed from three to zero. A malicious/silent peer's own half remains its responsibility.
- A queued print cancels its lane's diagnostic probe using native AbortController. The lane stays held until the probe unwinds; no parallel send on that lane. Shutdown cancels probes too. Failed/unsupported checks retry after 30 seconds rather than every poll, but actual print jobs remain independent of diagnostic health. Changed targets discard stale probe results and reset diagnostic backoff.
- The existing render timeout now includes page acquisition. A late page closes without writing to the removed temporary artifact. A subsequent job creates a new browser and succeeds.
- Safe transport retries reuse the artifact. An artifact read failure rebuilds it on the next bounded retry; hash mismatch remains subject to existing integrity handling. The injected one-refusal case changed from two renders to one, still two send attempts and one completion.
- Identical durable status is not rewritten. A real-filesystem test performs 100 `active` updates with one status persistence, reopens the store without another write, then verifies a changed status and restoration after file deletion.

Added a real-loopback test `v2-print-priority.test.js`: an actual silent status connection is canceled when a kitchen job arrives; all print bytes arrive exactly once, the real journal completes, no diagnostic fault is recorded for cancellation, and client sockets close even against half-open peers. The test requires completion before the original 1.5-second status timeout (a generous 1-second bound).

Focused verification now covers eight files: the original six plus `v2-job-store.test.js` and `v2-print-priority.test.js`. Renderer regression also verifies late page cleanup and successful next-job recovery; worker tests verify both artifact reuse and rebuilding an unreadable artifact. No new dependency, database change, browser pool, logging service or render-layout change. The ponytail simplification review kept these fixes within existing modules. Larger observations in this audit remain out of scope.

No installer rebuild, push or deployment performed. Physical output on the affected printer is still a field verification, not established by these local tests.
