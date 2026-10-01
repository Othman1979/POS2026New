# Typst transport reliability — implementation and verification

Branch: `codex/typst-transport-reliability`. Scope: the current spooler transport, endpoint scheduling/recovery, station ownership, and truthful reprint handling. No physical printer, customer DB, installed service, deployment, GitHub gate, or remote branch was changed. Existing unrelated voice/frontend/Typst-layout work was preserved.

## Decision

The reproduced software failures are fixed and the focused local verification passes. This is suitable for a controlled customer-printer trial, not a claim that every printer firmware or physical paper outcome has been verified. Typst layout/raster bytes are unchanged by this work; Chromium is not used by the transport simulations.

## Changes

- **TCP delivery boundary:** successful local `end(callback)` no longer releases the lane. The socket half-closes its write side and waits for the receiver's EOF, with a bounded deadline. `allowHalfOpen` preserves our remaining writes if a peer ends its status channel early; that case still reports uncertain. Status bytes are consumed without accumulating buffers. Normal jobs have no added sleep or pacing timer.
- **Busy devices:** the TCP no-progress budget is 30 seconds instead of 3; the total budget is at least 120 seconds and grows with artifact size. Actual write/reset/close failures remain uncertain after the durable transport marker. The larger budgets are ceilings, not per-job waits.
- **Windows:** each OS job is retained before the first write, observed through the existing notification/poll fallback, then released after PRINTED/COMPLETE. Deleted or missing jobs are not success. Unsupported RETAIN fails before bytes. A RELEASE failure is a warning on the completed result, never a reason to reprint. No write or drain timer deletes an OS job. Default drain observation is 120 seconds; expiry preserves the OS job.
- **Native lifetime:** a timed-out `print_raw` remains tracked until the native response or process exit. Other independent printers can keep working, with at most 64 outstanding native print requests. Normal shutdown and parent stdin EOF/reader failure wait for native print work; they do not recycle the helper mid-write.
- **Physical endpoint lanes:** normalized IP/port and station-local Windows queue names share a lane across record aliases. Independent devices remain parallel, kitchen priority remains intact, and probes use the same endpoint exclusion.
- **Durable containment:** existing transport markers and uncertain results also hold the endpoint. Holds survive restart, result archival and retention cleanup; no additional successful-send journal write was introduced. Later jobs stay unsent and durable. Ordinary reconnect, timeout, status polling and Reprint cannot silently clear a hold.
- **Station ownership:** configuration writes are serialized with a DB-scoped named lock released before returning the connection. Same-device receipt/kitchen roles may share one owning station. Different owners or duplicate same-role aliases are rejected, including legacy port/IPv6 spellings. New claims also exclude conflicts installed before this validation existed. The server returns those conflicting IDs before local workers start, so previously saved jobs and probes stay blocked too. Long-poll wakeups preserve the agent's local recovery exclusions. Pending/failed/in-flight jobs prevent changing their printer's connection or owner. Agent B can still create jobs for an Agent A kitchen printer: claims remain based on the printer's owning station.
- **Recovery and UI:** `recover-printer.js` takes both state-root/native mutexes and requires explicit queue-clear/device-reset confirmation. It releases only the selected endpoint's observed holds and never reprints or rewrites job outcomes. Admin health exposes recovery/configuration warnings. Cashier/admin reprints of uncertain tickets require confirmation, enforced again under the server row lock. Arabic strings are included. All fresh/core/runtime packaging allowlists include the recovery command.

## Evidence

Before the first production edit, the current code reproduced four overlapping TCP sessions from one printer record. All four were recorded completed; the supplied ESC/POS emulator attributed **12,064 garbage glyphs** to the merged stream. The new receive-side completion barrier changed the same reproduction to **one active session, four clean tickets, zero glyphs**, with identical artifact bytes.

The maintained `scripts/reviews/typst-transport-reliability.cjs` renders actual bilingual Typst receipt/kitchen fixtures, then uses the real journal, workers, transports and compiled Windows helper. Only the hardware API/device side is simulated. Final byte checks:

| Scenario | Result |
|---|---|
| TCP burst through two IDs for one endpoint | 265,306 / 265,306 bytes identical; peak one connection |
| 293 KB kitchen ticket plus receipt, five-second TCP pause | 363,653 / 363,653 bytes identical; peak one connection |
| Windows queue shared by two printer IDs | 425,551 / 425,551 bytes identical |
| Windows twelve-second paper-change pause | 132,653 / 132,653 bytes identical |
| Operator cancellation during the kitchen ticket | 30,574-byte prefix received; original uncertain; next receipt remains rendered/unsent; hold survives reopen |

The separate native check executes partial 511-byte WritePrinter returns, unsupported retention, failed release, direct-write pause >10 seconds, drain expiry, and parent EOF. Paused tickets complete without our code deleting or aborting them. The final native run used packaged Node **22.23.0**. A real TCP test also checks an early peer EOF during an **8 MiB** artifact: the full artifact arrives, but the outcome stays uncertain because the expected post-send barrier was not observed.

The actual recovery CLI was tested in an isolated installed-file layout with the compiled native mutex: live state lock rejects it, missing confirmations reject it, confirmed recovery preserves the uncertain original and untouched queued successor.

Browser checks click both cashier and admin reprint controls in English and Arabic. Dismissing the confirmation sends no POST; acceptance carries `confirm_uncertain:true`; the recovery warning is visible. Both languages completed with **zero console/page/Vue errors**. Initial browser harness failures were fixture setup issues (missing CommonJS QR dependency optimization, a selector/case mismatch, and waiting for module initialization); they were corrected before the passing run. The cashier's new translation call also received its explicit `t` import.

Backend verification covers concurrent cross-role creates, alternate IPv6/port spellings, legacy conflicting assignments, blocked-claim recovery, Agent A/B routing, strict uncertain-reprint confirmation, queue health and installer contracts. The existing 25-job acceptance check preserves **one station write**. The final implementation adds one metadata query per active/draining sync, then reuses its conflict IDs for both kitchen and ordinary claims and the agent response. For 200 configured printers, 2,000 historical jobs and 20 pending matches, alternating measurements gave final medians **0.462 ms for the original claim / 1.077 ms for conflict detection plus claim** (one versus two queries). The queue still uses `idx_print_queue_owner_claim`; conflict detection scans only printer metadata. This small correctness cost is explicit, not a claimed speed gain or a customer-hardware benchmark.

Focused packaged-runtime checks passed: transport boundary, TCP delivery, endpoint safety, workers, transports, journal, status monitor, sync runtime, hostile recovery, print priority and composition. Native helper/lifetime and recovery checks passed separately. Backend/package suites, six existing Settings checks, production frontend build and architecture validation passed. The final startup/ownership/long-poll backend run passed **79 tests**; its matching runtime tests verify preexisting durable jobs remain blocked while an independent device works, omitted sync fields do not clear a conflict, and explicit clearance resumes the untouched ticket once. An older print-priority fixture deliberately kept every peer half-open; it was updated so the print peer returns EOF while the silent status probe remains preemptible.

Evidence JSON is under ignored `scratch/typst-transport-reliability/`, plus `scratch/typst-transport-backend.json`, `scratch/typst-transport-final-backend.json`, `scratch/typst-transport-ownership-final.json` and `scratch/typst-transport-startup-final.json`. Two Luna readers independently reviewed transport research and station routing, then the final corrections; neither edited source. The verification guide contains repeatable commands. Timings are local and vary between runs; no CPU/RAM or physical printing-speed improvement is inferred from them.

## Field recovery procedure

1. Stop the affected station's **POS Print Spooler** service. Identify/check the uncertain ticket; it may have printed partly or fully. Ensure no other configured sender is writing to that physical printer.
2. Clear or finish the affected Windows queue as appropriate, then power-cycle the affected printer to clear any partial parser data. Changing paper alone is not a parser reset.
3. From the installed spooler directory, list holds:

   ```powershell
   .\runtime\node\node.exe .\recover-printer.js
   ```

4. Use a listed uncertain queue ID for that endpoint after the checks above:

   ```powershell
   .\runtime\node\node.exe .\recover-printer.js --queue-id 123 --confirm-queue-cleared --confirm-printer-reset
   ```

5. Restart the service. Untouched queued jobs resume. Reprint the uncertain original only if the paper check shows it is needed. The tool checks local process ownership, but the physical-reset confirmations are operator attestations, not hardware measurements. A native helper still inside a print call keeps its mutex, so recovery cannot race it.

Ship the updated server and all owning agents for the full ownership/health/reprint behavior. No new DB tables, columns or migrations are required. Do not reassign active printer connections while terminals are generating orders; their queued payloads are immutable. A printer registered through both a Windows driver alias and direct IP cannot be identified as the same hardware from these stored fields alone: configure that hardware through one owning station and one transport path.

## Limits and technical sources

- A disconnect/power loss can still truncate the ticket already being printed. Software cannot recover ink already placed on paper or guarantee exactly-once physical printing without device support. This change contains the failure instead of sending subsequent tickets into the uncertain stream.
- TCP EOF is a connection boundary, not proof that paper emerged. Firmware that never closes its side will time out and require recovery rather than silently releasing another connection. Test that behavior on the customer's printer model before rollout. [Node socket semantics](https://nodejs.org/api/net.html#socketenddata-encoding-callback)
- Windows RETAIN/RELEASE needs provider support. PRINTED/COMPLETE remains a provider report; some port monitors report completion before paper finishes. Test the customer's actual driver, USB/shared/network queue and service account. [SetJob](https://learn.microsoft.com/en-us/windows/win32/printdocs/setjob), [JOB_INFO_1](https://learn.microsoft.com/en-us/windows/win32/printdocs/job-info-1)
- NUL-padding/ESC-reset recovery was deliberately not enabled. It did not fix interleaving and lacks universal printer compatibility evidence. Resetting a partially interpreted binary stream cannot be assumed safe merely because one emulator resynchronizes.

## Review corrections (2026-09-24, commits after `ea35d9be`)

An end-to-end review of the two commits above, with the real job store, workers, transports and the compiled helper against loopback device models (`scratch/spooler-garbled-repro/`), found the containment policy too broad. Three benign situations produced an uncertain outcome plus an endpoint hold that only the offline CLI could clear, i.e. a dead printer:

| Situation | Before the corrections | Evidence |
|---|---|---|
| Network printer firmware that keeps its side open after our FIN (real: Zebra, some HP; CUPS ships `waiteof=false` for it and its default wait treats a missing EOF as harmless) | first ticket `uncertain PRINTER_CLOSE_TIMEOUT` after the full budget although the printer received every byte; tickets 2 and 3 never sent | `nonclosing-experiment.cjs` |
| Windows queue stall longer than the drain budget (a slow paper change; production default 120 s) | `uncertain WINspool_DRAIN_UNKNOWN`, endpoint held, next ticket never sent, retained job left in the queue — while Windows printed the job correctly | `windows-stall-experiment.cjs` |
| Spooler restart after a complete write (update, reboot) | `AGENT_RESTART_AFTER_TRANSPORT` hold although every byte had left the process | job-store recovery path |

A provider that rejects `JOB_CONTROL_RETAIN` also failed every ticket permanently with no configuration escape, and the 30 s TCP no-progress abort still truncated rasters during an ordinary paper-out (a stalled printer keeps the session alive and stops reading; TCP itself does not give up).

Policy now: **hold the endpoint only on evidence that the stream was cut**; everything else is at most a warning or an uncertain outcome without a hold.

- `9c0d0ac3` TCP: ten-minute stall budget plus size allowance and TCP keepalive; missing EOF after a complete write completes with `PRINTER_EOF_NOT_OBSERVED`, an early peer FIN with `PRINTER_EOF_EARLY`; endpoints that never answer our FIN are learned and later wait only a two-second grace. `PRINTER_WRITE_*`, `PRINTER_STREAM_*` and socket errors still hold.
- `f13cb26b` durable `transport_sent_at` marker (`markTransportSent`, with the Windows job id): a restart after it is `AGENT_RESTART_AFTER_SEND` without a hold; `recordResult(..., { hold: false })` for stream-intact uncertain outcomes.
- `faa0c035` Windows: `print_raw` submits only (document name carries the queue id) and answers `submitted`; the agent persists the sent marker, then observes with repeated bounded `wait_job` windows for as long as the spooler keeps the job queued, releasing retention after PRINTED/COMPLETE. `RETAIN` failure degrades to `WINspool_RETAIN_UNSUPPORTED` (completion inferred from the job leaving the queue). Helper timeouts or observation errors after submission are uncertain without a hold; only a deleted or vanished retained job (operator cancel) holds.

Re-verified after the corrections: `typst-transport-reliability.cjs` (all five scenarios byte-identical, cancel still contained), the two experiments above (every ticket completes, no holds, retained jobs released), and the spooler suite. Not changed: station ownership, reprint confirmation, the recovery CLI. Known limits: the recovery CLI remains the only exit from a genuine hold (an admin-side "printer reset done" action is the natural follow-up); a retained job left by a crash between RETAIN and RELEASE stays in the Windows queue until cleared by hand; Windows-type duplicates across stations are not detected (no shared device identity between `windows_name` records).
