# Garbled receipt/kitchen printing — reproduction and current-spooler audit (2026-09-24)

Companion to `2026-09-24-spooler-garbled-output-investigation.md`. No application code was changed. No printer, customer database, service or deployment was touched, and nothing was printed. Everything below ran against loopback or in-memory device models. Harness and outputs: ignored `scratch/spooler-garbled-repro/`.

## Bottom line

- A correct header followed by a long run of small random glyphs is what a thermal printer produces when its `GS v 0` raster framing breaks. Two things break it: a stream cut mid-band, where the next job's bytes are read as the rest of that band and then as text, or two streams mixed together. Both were reproduced byte for byte on the current code (HEAD `0076afcf` plus the uncommitted, layout-only Typst divider change). The runs used real Typst artifacts, the real job store, printer workers, TCP and Windows transports, the platform-helper protocol and the real `PosSpoolerPlatform.cs` logic. An ESC/POS framing emulator then rendered what the printer would print.
- The Typst renderer and the shared raster encoder are not the cause. Every artifact parses as whole bands plus its tail. Switching renderer is also not a fix: the damage happens downstream, in scheduling, timeouts and transports. Those mechanisms date from the 1.2.8-era V2 commits (2026-08-18/20), and their logic is unchanged between 1.2.21 (`0aab81ea`), 1.2.22 and HEAD apart from telemetry and the notification drain wait.
- In every truncation case, the ticket that prints the garbage is recorded **completed**. The interrupted ticket before it is recorded uncertain, or also completed when staff cancel it in the Windows queue. In interleave cases every ticket is recorded completed. The POS records therefore point at the wrong ticket, or at no ticket.
- Which mechanism hit this customer is not proven. The field checks below distinguish them; the most plausible ones need only a busy period and either a multi-session network printer or a printer pause.

## How it was reproduced without paper

| Part | What ran |
|---|---|
| Renderer | `renderer-router` in `typst-only` mode → `typst-renderer` → `thermal-raster`. Vendored typst 0.15.1 patched by `deployment/tools/patch-typst-fast-watch.js`, SHA-256 `726d603b…`, identical to the staged production binary. Noto fonts from `deployment/vendor`. Built-in receipt/kitchen templates via `compileTemplate`. |
| Queue | Real `openJobStore` (temp state root), `createPrinterWorkers`, production deadlines (TCP connect 5 s / write-idle 3 s / total ≥15 s; helper deadline 10 s; drain 10 s; notification drain strategy). |
| Direct IP | `createTcpTransport({ net })` against `virtual_printer.py`: 4 KB TCP receive window, 16 KB device buffer drained at 60 KB/s (≈100 mm/s, the XP-80C rate measured in the 2026-09-17 Windows transport review). Session policy is single (serve in order), multi (read all sessions into one buffer) or refuse, with optional stalls. |
| Windows | The real `PosSpoolerPlatform.cs`, compiled with the installer's csc flags. Only its 15 winspool/kernel32 P/Invoke declarations are redirected to `FakeWinspool.cs`: a FIFO queue, a print-rate device, `SetJob(DELETE)` that stops the printing job, change notifications and direct-print mode. A diff proves no other line differs. Driven by the real `startPlatformHelper` and `createWindowsTransport`. |
| Verdict | `escpos-emulator.cjs` parses the device's input stream with ESC/POS framing rules. It attributes every band, command and glyph to its job and renders the paper to PNG. |

Measured on this machine: Windows loopback lets Node hand ~128 KB (two 64 KB writes) to the TCP stack before a 4 KB-window receiver back-pressures it.

## Typst spooler trace (newest)

`renderer-router` routes receipt/kitchen jobs with `compiled_document_v1.nativeLayout` to Typst. The Typst watch process writes a PNG. The render token is verified and cut out. `thermal-raster` (threshold mode) encodes 72-byte × ≤256-row `GS v 0` bands, followed by the beep or drawer pulse and `LF LF LF GS V 0` (`v2/typst-renderer.js:297-326`). Framing is identical to Chromium's (`v2/artifact-renderer.js:685,694`) and to 1.2.21: the encoder diff since `0aab81ea` only adds an optional dither mode. Neither renderer emits `ESC @` or any resynchronisation.

| Real Typst artifact | Bytes | Raster rows | Bands | Parses cleanly from a clean state |
|---|---:|---:|---:|---|
| receipt, 3 items | 70,755 | 982 | 5 | yes (bands, drawer, LF×3, cut) |
| receipt, 12 items | 97,123 | 1,348 | 7 | yes |
| receipt, 30 items | 149,843 | 2,080 | 9 | yes |
| kitchen, 4 items | 61,898 | 859 | 5 | yes (bands, beep, LF×3, cut) |
| kitchen, 16 items | 138,898 | 1,928 | 9 | yes |
| kitchen, 40 items | 292,898 | 4,066 | 17 | yes |

## Status of the earlier findings

| Finding | In HEAD | Result here |
|---|---|---|
| Drain expiry calls `SetJob(DELETE)` even after seeing PRINTING (`PosSpoolerPlatform.cs:340`) | Yes, since `c4937c85` (1.2.8) | **Reproduced end to end.** Printing ticket truncated; next ticket garbled and recorded completed. |
| Helper write deadline also deletes (`PosSpoolerPlatform.cs:374-390`) | Yes, since `b1039d6c` | **Reproduced** on a "print directly to the printer" queue. |
| Two `printer_id`s on one endpoint send concurrently (`v2/printer-workers.js:209,275`) | Yes | **Reproduced.** Garbage on multi-session printers (all recorded completed). On single-session printers it produces write timeouts. A printer that refuses the second session is safe. |
| Next job dispatched after an uncertain send (`v2/printer-workers.js:138,219`) | Yes | **Reproduced.** That next job is the one that prints the garbage. |
| Admin accepts duplicate physical endpoints (`backend/routes/admin/printers.js:115,152`) | Yes | Code-verified. |
| No per-job initialisation/recovery | Yes (Chromium and Typst) | Verified on the Typst artifacts above. |

## New verified defects

1. **A TCP send is "completed" as soon as Windows TCP has the bytes, not when the printer has them.** `finishSocket` resolves on the local `end` callback (`v2/printer-transports.js:164`). Tickets under ~128 KB therefore "finish" within a few milliseconds (3–13 ms measured), and the lane opens the next session while the printer is still receiving the last one. On a printer that reads concurrent sessions into one buffer, **one correctly configured printer record** garbled all four back-to-back tickets, all recorded completed (13,719 glyphs). Per-`printer_id` serialisation does not serialise at the device.
2. **The 3 s TCP write-idle timeout (`printer-transports.js:6,117`) fires on ordinary busy printers.** It has two outcomes.
   - In these runs, chunks already handed to Windows were still delivered after `destroy()`, so the ticket printed in full but was recorded `uncertain`. This happened in 5 of 5 cases, and the red Reprint button invites a duplicate (`src/admin/pages/Settings.vue:646`).
   - When chunks were still unsent, the stream was cut. A 293 KB kitchen ticket stopped at exactly 262,144 bytes (both runs). The receipt sent 4 ms later lost its header band into the kitchen ticket's pending band and printed 317 glyphs. It was recorded completed.
3. **The victim is recorded completed.** This holds in every truncation case (TCP and Windows), so neither the journal nor `print_queue` flags the garbled ticket.
4. **A Windows queue shared by two records pushes queued tickets past their own 10 s drain budget while printing.** At 45 KB/s, a queued 293 KB ticket was deleted at 16.2 s with 270,471 bytes delivered, and the next receipt was garbled.
5. **An operator cancel counts as success.** `WaitForLocalQueueDrain` treats `JOB_STATUS_DELETED`, or a job that disappears, as `drained` (`PosSpoolerPlatform.cs:304,312,317`). When staff cancelled the printing document (40,907 of 61,898 bytes delivered), both it and the garbled next receipt were recorded completed.

## Code-level risks, not reproduced

- **Deadline-timer race.** `deadlineTimer.Dispose()` (`PosSpoolerPlatform.cs:420-424`) does not stop a callback already queued to the thread pool. Every `print_raw` holds a pool thread through its drain wait (`:582`), so a delayed callback can delete a fully submitted job after the flag check at `:419`, and the drain loop would then report it `drained`. This needs writes lasting about 10 s, so it is unlikely on spooled queues.
- **`escpos_status` probes.** These send `DLE EOT 1` on a separate session every 2 s whenever the `printer_id` lane is idle (`v2/status-monitor.js:8,65`, `printer-transports.js:231`). Because of defect 1, "lane idle" can still mean "printer receiving". On multi-session printers, and across aliases, a probe can land inside another raster. The effect depends on firmware. This is only active when that capability is configured; the default is `write_only`.
- **Helper recycle.** After `PLATFORM_HELPER_TIMEOUT`, `recycleIfIdle` kills the helper once no request is pending, even if the timed-out thread is still inside `WritePrinter`.

## Results

Direct IP (real TCP transport, 60 KB/s printer model):

| Scenario | Spooler record | Paper (emulated) |
|---|---|---|
| 1 record, single-session, 4 short tickets | all completed (3–9 ms each) | all clean |
| 1 record, single-session, long tickets | 1× `uncertain PRINTER_WRITE_TIMEOUT` | all clean (false uncertain) |
| 1 record, 5 s stop, 150 KB ticket | 1× uncertain | all clean (false uncertain) |
| 1 record, 5 s stop, 293 KB ticket | kitchen uncertain; receipt completed | kitchen cut at 262,144 B; **receipt garbled (317 glyphs)** |
| 2 records → 1 IP, single-session | 2× uncertain | all clean (false uncertain) |
| 2 records → 1 IP, multi-session | all completed | **all 4 garbled** |
| 1 record, multi-session | all completed | **all 4 garbled** |
| 2 records → 1 IP, printer refuses 2nd session | all completed (after retries) | all clean |

Windows printers (real helper logic, production defaults):

| Scenario | Queue event | Spooler record | Paper |
|---|---|---|---|
| 1 record, 4 short tickets | none | all completed | all clean |
| 12 s stop (paper change) | deleted at 10.0 s while printing, 46,784/61,898 B | kitchen `uncertain WINspool_DRAIN_UNKNOWN`; receipt completed | **receipt garbled (1,077 glyphs)** |
| 25 s stop | 1st deleted while printing; 2nd deleted while queued | uncertain, `uncertain WINspool_JOB_STUCK`, completed, completed | 1st truncated, **2nd never printed, 3rd garbled**, 4th clean |
| 2 records → 1 queue, 45 KB/s | queued ticket deleted at 16.2 s while printing | victim completed | **next receipt garbled (1,176 glyphs)** |
| Direct queue, 8 s stop | deadline delete at 10.0 s mid-write | `uncertain WINspool_WRITE_FAILED`; receipt completed | **receipt garbled (1,416 glyphs)** |
| Staff cancel the printing job | operator delete, 40,907/61,898 B | **both completed** | **receipt garbled (321 glyphs)** |

Reruns reproduced the same deletion points and victims.

## Candidate fixes tried in scratch (not applied)

| What-if | Result |
|---|---|
| TCP: `end()` resolves only after the printer closes its side (injected through `createTcpTransport`'s `net` option), 30 s idle, one sender per `ip:port` | All 4 failing TCP scenarios clean; peak one session; no false uncertain. Sends now take roughly print time (e.g. 1.3 s for 70 KB). |
| Windows A: `!printingSeen && SetJob(...)` | 12 s stop and shared queue: clean. 25 s stop: no garbage, but the queued ticket is still deleted (lost). |
| Windows B: never delete after `EndDocPrinter` | All cases clean and nothing lost; tickets print late and are labelled uncertain. |
| Resync preamble before each job: 18,432 × NUL (largest band payload, 72 B × 256 rows) then `ESC @` | 4/4 truncation victims parse clean; the interrupted ticket just ends early. 0/8 interleaved tickets fixed, since the preamble cannot undo mixing. |

## What this means for the customer incident

The photo fits two signatures. `print_queue` distinguishes them without printing.

- **Truncation.** Invoice 16469's row is `dead_letter` with `last_failure_class='uncertain'` and `PRINTER_WRITE_TIMEOUT`, `PRINTER_STREAM_TIMEOUT`, `WINspool_DRAIN_UNKNOWN`, `WINspool_DEADLINE_EXCEEDED` or `WINspool_WRITE_FAILED`. For a Windows queue it can also be `acknowledged` if staff cancelled the job in the queue. The next row to the same physical printer is `acknowledged`: that ticket's bytes became the glyphs, and it never printed properly.
- **Interleave.** 16469 and a neighbouring ticket to the same physical printer are both `acknowledged`, with overlapping send windows. For TCP, `duration_ms` is a few ms for tens of KB. The printer accepts concurrent sessions.

Evidence to collect, all read-only:

1. `SELECT q.id, q.created_at, q.last_seen_at, q.status, q.last_failure_class, q.last_error_code, q.printer_id, p.name, p.type, p.network_ip, p.network_port, p.windows_name, p.spooler_id, q.agent_id, q.print_type, q.artifact_bytes, q.duration_ms, q.transport_mode, q.renderer, q.spooler_version FROM print_queue q LEFT JOIN printers p ON p.id = q.printer_id WHERE q.created_at BETWEEN ? AND ? ORDER BY COALESCE(p.network_ip, p.windows_name), q.last_seen_at;` for the busy period around 16469.
2. `SELECT id, name, role, type, network_ip, network_port, windows_name, spooler_id, status_capability FROM printers;`. Look for duplicate endpoints, and for one device reachable both directly and through a Windows queue.
3. On each terminal: `Get-CimInstance Win32_Printer | Select Name, PortName, Direct, Shared, ShareName` and `Get-PrinterPort | Select Name, PrinterHostAddress, PortNumber`. `Direct=True` means "print directly to the printer" (the deadline case).
4. Printer models and firmware. With consent, while idle and outside service: `node scratch/spooler-garbled-repro/session-policy-probe.cjs <ip>`. It sends only `DLE EOT 1`, which prints nothing, and reports single-session, multi-session or refuses. It was validated against all three models.
5. Journal and artifact for 16469 and its neighbours: `C:/ProgramData/POS-Spooler/state/jobs/archive`, `state/artifacts` (14-day retention), and whether staff cancelled documents or changed paper at that time.

## Recommended fixes, in priority order

**P0 — one sender per physical device, finished only when the device has the bytes**

- Key the send lane by normalised endpoint (TCP `ip:port`; Windows queue name) instead of `printer_id` (`printer-workers.js:209,275,332`).
- TCP completion barrier: after `end()`, wait for the peer to close, bounded by a size-scaled deadline, and keep the lane blocked meanwhile (`printer-transports.js:155-169,198-206`).
- Reject duplicate network endpoints in admin POST/PUT (`backend/routes/admin/printers.js:115,152`), so a device has one owning station. Cross-terminal overlap can only be prevented there.

**P0 — never cut a raster on a timer, never send into an unknown parser state**

- Replace the 3 s per-chunk abort with a no-progress deadline in the tens of seconds, scaled by size (`printer-transports.js:6,117`).
- Windows drain expiry must not delete after `EndDocPrinter`. Report uncertain and keep the lane blocked until the job leaves the queue. Variant B was the only one with no garbage and no loss. If deleting stuck-but-unstarted jobs is required, re-check with `GetJob` immediately before `SetJob` and never delete once PRINTING was seen (variant A), accepting lost tickets on long stops (`PosSpoolerPlatform.cs:340`).
- Do not delete mid-write on deadline. Detect direct-print queues (`PRINTER_ATTRIBUTE_DIRECT` / `Win32_Printer.Direct`) and require spooling, or size the deadline (`PosSpoolerPlatform.cs:374-390`).
- Send the resync preamble (18,432 NUL + `ESC @`) before the next job on a device after any uncertain outcome. Preferably send it before every job, since truncations by other terminals or staff are invisible to this agent. First confirm on each customer printer model, with no paper, that the preamble alone feeds and prints nothing.

**P1 — truthful records**

- Do not report `JOB_STATUS_DELETED`, or a vanished job, as drained (`PosSpoolerPlatform.cs:304,312,317`).
- Record the endpoint and the previous job per result, and flag a "completed" ticket that follows an interrupted one on the same device.
- Once the barrier exists, stop reporting fully delivered sends as uncertain.

**P2**

- Make the deadline timer unable to delete after the post-`EndDoc` check (a guarded state instead of `Dispose()`).
- Gate `escpos_status` probes on endpoint idle, not lane idle.

Focused tests to land with the fixes (each fails today):

- workers: two `printer_id`s with the same endpoint never overlap sends.
- TCP transport: `send` does not resolve before the peer closes; a slow-but-progressing peer is not aborted at 3 s.
- helper, via a stub build like `windows/build-fake-helper.cjs`: drain expiry never calls `SetJob` after seeing PRINTING or after `EndDocPrinter`; DELETED is not drained.
- emulator-level: a truncated previous stream followed by preamble + next job parses clean.

## Limits

These are models, not printers. They cover framing (parser byte accounting), not firmware or print quality. Kernel buffering was measured on this workstation; customer machines and printer TCP stacks differ. Session policies, rates, buffer sizes and stall lengths are representative, and the fake Winspool completes a job when its last byte reaches the device, as Windows does at the port. Whether a given printer reads concurrent sessions, and whether it ignores NUL in standard mode, must be checked on the customer's models. The customer's spooler version, printer records and job history for 16469 have not been seen.

## Re-running

From `scratch/spooler-garbled-repro/`: `node escpos-emulator.cjs` (self-check), `node workload.cjs` (artifact ladder), `node tcp-scenarios.cjs [name…]`, `node windows-scenarios.cjs [name…]` (`REPRO_HELPER_VARIANT=no-delete-when-printing|no-delete-after-enddoc` for the what-ifs), `node preamble-experiment.cjs`, `node out-probe-selfcheck.cjs`. Set `REPRO_TYPST_RUNTIME` to a folder containing the patched `typst.exe` and `fonts/`. The session copy was built from `deployment/vendor` exactly as `scripts/build-installers.ps1` stages it. The existing focused spooler tests (`thermal-raster`, `v2-printer-transports`, `v2-printer-workers`, `v2-platform-helper`, `renderer-router`) pass on the current tree; none of them covers these behaviours.

## Addendum (same day): fixes on `codex/typst-transport-reliability`

`c4f86080`/`ea35d9be` implemented the P0/P1 items (endpoint lanes, TCP completion barrier, no Windows cancellation, deleted jobs not counted as printed, ownership, reprint confirmation). Reviewing them end to end with this harness showed the containment policy also held printers after benign stalls, non-closing firmware and restarts; `9c0d0ac3`, `f13cb26b` and `faa0c035` narrow the hold to real stream cuts. Details and evidence are in `2026-09-24-typst-transport-reliability.md` ("Review corrections"). The resync preamble from this report was deliberately not adopted: it does not fix interleaving and lacks per-model evidence that NUL padding is inert.
