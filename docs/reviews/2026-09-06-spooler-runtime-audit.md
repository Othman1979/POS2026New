# Spooler runtime audit — 2026-09-06

Audited the shared checkout after `01ef8df1316484a19e1f655c676d0b86901f5914`, on `codex/system-performance-audit`. The five fixes described in the September 5 performance audit are already present. This pass found and corrected three additional reachable recovery defects. No database, printer hardware, customer environment, deployment, or machine configuration was changed.

## Verified defects and corrections

### HTTP body waits escaped both timeout and shutdown cancellation

`http-client.js` cleared its timeout and caller-abort listener when `fetch()` returned response headers. `v2/sync-client.js` then consumed `response.text()` outside that lifetime. A server/proxy that sent a partial body could hold the runtime's single-flight sync and `stop()` beyond the configured deadline.

The new loopback `v2-sync-client.test.js` writes successful headers and an unfinished JSON body. The first RED run, with a 100 ms configured timeout, was still pending at its 700 ms guard. With the fix, that same 100 ms probe rejected with `TimeoutError` and closed the connection in 115 ms; caller cancellation closed it in 4 ms. The final regression uses a more generous 250 ms configured timeout and a 1,500 ms failure guard: the measured successful run closed in 255 ms, with caller cancellation still 4 ms. These are local development-machine observations, not production latency promises.

The existing HTTP helper now returns the response and consumed text together. Its timeout and abort listener remain attached until body completion and are still cleared on success/failure. The original caller abort reason is preserved. Existing successful JSON and HTTP error-code handling remain verified. The test also checks the actual transmitted long-poll hint and station id.

Removed source-shape assertions that only searched the sync client for the timeout helper and constants; behavioral coverage now reaches the actual sync client with built-in fetch and a real loopback HTTP server. The existing helper-level abort and cleanup tests remain.

### Failed durable writes accumulated temporary journal files

`v2/job-store.js` closed its file descriptor after write/fsync failure, but the failed temporary-file removal was in a later block that those exceptions skipped. Repeated ENOSPC attempts accumulated partial/full `.tmp` files until restart, adding pressure during an existing disk failure.

The new regression injects ENOSPC separately during a partial write and during fsync. Three attempts previously left three temporary files. The outer cleanup now covers both stages and leaves zero temporary files. Tests verify that the in-memory state and reopened durable record remain queued, then that rendering metadata can be persisted when the injected failure ends. Durable transport markers and terminal-result rules are unchanged.

### A failed old Windows status subscription could restore an old target

The Windows watcher catch path wrote its captured printer object back after the await. If another job observed a changed Windows printer name meanwhile, a failure from the old subscription overwrote that new target and continued watching the previous printer.

`v2/status-monitor.js` now includes the Windows printer name in target identity and applies watch failures only while their target remains current. A controlled regression starts an old subscription, observes the replacement name, rejects the old request, and verifies that the next subscription uses the new name and its current health is accepted. This is a monitor simulation; no Windows printer subscription or print request was made by that regression.

## Performance observation left unchanged

`2026-09-06-spooler-journal-probe.cjs` creates its own temporary journal with 14,000 archived and 10 active synthetic records. It verifies replay/conflict behavior and times eight hot store operations per sample, after warmup, for three 500-iteration runs. Packaged Node 22.23.0 measured 0.622, 0.609, and 0.407 ms/sample; initial journal loading took 434 ms. The absolute measured steady-state cost does not justify adding a maintained active-record index in this change.

The records use intentionally small synthetic payloads. This does not measure representative full-ticket memory use, customer-machine startup, 14-day disk occupancy, or production throughput. Retention and replay protection remain intact.

```powershell
& deployment/out/toolchain/node/node.exe docs/reviews/2026-09-06-spooler-journal-probe.cjs
```

## Examined paths and verification

Read the current runtime composition, agent sync/cadence, job journal, status monitor, printer lanes/retries, TCP/Windows transports, helper lifecycle, renderer deadline/artifact paths, and server-side sync settlement/claims. Also inspected print dispatch, receipt selection, held-kitchen dispatch/routing, template compilation/settings reads, watchdog scheduling and queue purging. No new change to server-side print ownership or the database was justified in this bounded printing pass.

Eleven focused test files passed under packaged Node 22.23.0:

```powershell
$spoolerChecks = @(
  'http-client', 'v2-sync-client', 'v2-sync-runtime', 'v2-job-store',
  'v2-status-monitor', 'v2-print-priority', 'v2-printer-workers',
  'v2-printer-transports', 'v2-agent-connect', 'v2-platform-helper',
  'v2-hostile-runtime'
)
foreach ($check in $spoolerChecks) {
  & deployment/out/toolchain/node/node.exe "pos-spooler-printer/tests/$check.test.js"
  if ($LASTEXITCODE -ne 0) { throw "Spooler check failed: $check" }
}
```

The worker suite's injected EACCES/ENOSPC and failing-hook output is expected. The transport/priority tests use doubles and loopback sockets; they preserve exact-once local sends, same-printer exclusion, different-printer progress, safe pre-marker retries, and terminal uncertainty after possible sends. The Windows helper test uses fake print operations; its real temporary compiled helper only exercises DPAPI and duplicate-instance arbitration. The hostile suite contains both behavioral cases and source scans; its fake-clock requests-per-second figures are not HTTP/MySQL capacity evidence.

No physical paper-completion, USB/shared-printer performance, customer CPU/RAM, or live cloud behavior was verified. TCP completion remains `bytes_sent`, not paper completion. No installer was rebuilt. All changes are local source and focused regression/evidence files; architecture/ownership is unchanged.
