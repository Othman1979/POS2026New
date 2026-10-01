# Spooler V2 Architecture Decision and Fable Review Brief

**Date:** 2026-08-17
**Plan under review:** `docs/superpowers/plans/2026-08-17-spooler-v2-local-print-agent.md`
**Implementation status:** Nothing executed
**Purpose:** Give an adversarial reviewer the evidence, corrections, open gates, and exact attack surface without asking them to rediscover the entire repository.

## Verdict

The current spooler should not be discarded, and it should not receive another narrow reconnect patch. Its architectural position is correct: an installed local agent is required for unattended thermal printers. Its internal boundaries are not yet strong enough for long-term use.

The recommended refactor keeps the durable server queue, idempotency, local Arabic rendering, printer routing, installer, and updater. It replaces:

- socket-owned job claims;
- WebSocket and HTTP as competing delivery paths;
- an in-memory local execution queue;
- a whole-file JSON seen store;
- global printer serialization;
- full-height report screenshots/canvases;
- repeated `Buffer.concat` output assembly;
- Windows `copy /B` transport;
- periodic unbounded PowerShell printer discovery;
- binary online/offline labels that overstate device truth.

The design is intentionally smaller than adopting QZ Tray or PrintNode beside the existing agent: one pull-only job API, one local journal, one renderer, and two transport adapters. V2 has no Socket.IO client lifecycle.

## Confirmed current defects and evidence

| Finding | Evidence | Consequence |
|---|---|---|
| Rejection permanently kills both transports | `pos-spooler-printer/server.js`, `spooler_rejected` disables poll and Socket.IO reconnect | A transient stale registry collision requires manual service restart |
| Server disconnect does not auto-reconnect | server uses `socket.disconnect(true)` after duplicate rejection; Socket.IO treats it as server disconnect | Removing only the client kill switch is insufficient |
| 401/403 disables polling permanently | `pos-spooler-printer/poll-fallback.js` | Transient WAF/auth deployment incidents can strand the agent |
| Registry truth is in-memory socket state | `backend/services/spoolerRegistry.js` | Stale sockets and multi-worker hosting cannot provide durable ownership |
| Claim identity changes with every socket | `server.js:285-295`, `settlePrintJob` checks exact claimant | A job finishing across reconnect can have its response rejected until redelivery |
| Socket and poll use different claimants | socket ID versus `poll:<spooler_id>` | Transport switching strands already claimed work for the lease window |
| Poll stop aborts active work | `poll-fallback.js:stop()` aborts its controller | Reconnect can abandon a poll response whose rows were already claimed |
| Client dedupes completed work only | `hasCompletedJob` plus in-memory queue | Duplicate delivery before completion can enqueue two physical prints |
| Local queue is memory-only and global | `localPrintQueue` in `pos-spooler-printer/server.js` | Process death loses local intent; a report can delay unrelated kitchen printers |
| Accepted work is reclaimed after 120 seconds | `claimPrintJobs` reclaims expired `sent` rows | A slow backlog can redeliver work still queued locally |
| Safe transient failures exhaust `max_attempts` | `settlePrintJob` terminalizes by attempt count | A printer that returns later may never receive the original ticket |
| Full-height report is resident several times | screenshot PNG, decoded image, canvas, RGBA `ImageData`, raster array | Tall reports create peak memory and event-loop pressure on Celeron terminals |
| Output assembly repeatedly copies prior bytes | `BufferConnector.write()` uses `Buffer.concat([old,data])` | Long multi-band reports pay increasing copy cost |
| Windows raw print is an unbounded shell command | `exec(copy /B ...)` has no timeout | A wedged Windows spooler freezes the single local worker and invites lease redelivery |
| Printer discovery is periodic unbounded PowerShell | `setInterval(updateLocalPrintersStatus, 60000)` with no timeout/single-flight | A wedged print subsystem accumulates processes and load |
| Network health is only TCP connect | `checkNetworkPrinter` connects then destroys | UI may show `ok` without paper/status feedback |

These findings are source-proven. The Fable experiments additionally reproduced the duplicate in-flight print and lease-expiry redelivery chain.

## Report-gibberish evidence

The photographed X/Z/items output is not normal Arabic mojibake. The print path renders Arabic to pixels before transport. Structured random glyphs across the paper are consistent with a printer interpreting raster payload bytes as text after rejecting or losing synchronization with the raster command.

Current evidence supports, but does not physically prove, a command-size/emulation/driver incompatibility:

- short receipts and kitchen tickets work on the same installation;
- long reports are much taller and produce far larger raster payloads;
- the old renderer sent one full-height `GS v 0` image;
- 1.2.8 now sends repeated 256-row `GS v 0` bands;
- Epson documents `GS v 0` as model-dependent and provides status/graphics commands with finite limits;
- only one customer/model is reported affected.

What is not proven:

- the installed spooler version on the affected machine;
- exact model/firmware/driver/port;
- whether 1.2.8 banding still fails physically;
- whether direct TCP and Windows RAW produce the same outcome;
- whether a smaller `GS v 0` band or `ESC *` profile fixes that model.

Therefore the plan contains a mandatory short/long physical discriminator before adding another raster profile. Declaring it fixed from automated tests would be dishonest; changing binary commands without that discriminator would be guessing.

## External architecture evidence

### Print.js is not a replacement

Its own documentation describes printing PDF, HTML, images, and JSON from the browser. That solves browser print UX, not unattended raw thermal transport, durable local recovery, or device monitoring.

### QZ Tray validates capabilities but adds a second system

QZ supports raw ESC/POS and Winspool printer/job status. Silent printing requires signed messages and either commercial certificates or private-root management. It could replace parts of our local transport, but it would not replace our server queue, restaurant idempotency, offline retry, or operator recovery. Running it beside our Node agent creates two desktop runtimes and two support surfaces.

### Odoo validates the local-agent boundary

Odoo uses an IoT Box or Windows Virtual IoT to connect local printers/peripherals to a cloud or self-hosted database. Odoo explicitly distinguishes directly supported smart ePOS printers from ESC/POS printers that require the IoT system.

### Star validates outbound agent/printer pull

CloudPRNT uses outbound HTTP polling, job retrieval, completion confirmation, status codes, and optionally MQTT for low latency. It does not rely on a server believing one long-lived socket is the durable job owner.

### Microsoft validates a native Windows seam

The supported raw flow is `OpenPrinter`, `StartDocPrinter`, `WritePrinter`, and completion calls. Printer/job change notifications exist, but Microsoft warns Winspool calls are synchronous and may block depending on network, driver, and server. A killable helper process is therefore a containment boundary, not ornamental abstraction.

### Epson validates capability-aware status

`DLE EOT` can report offline, cover-open, paper-end, and errors, but supported parameters and behavior vary by model. A non-response must remain unknown; it cannot be converted to healthy.

## Corrections to Fable's proposed implementation section

The lifecycle diagnosis is valuable. The proposed fixes are not a sufficient long-term architecture.

1. **Batch 10 is not a proof.** Device speed and report height are unbounded relative to a 120-second lease. V2 claims actual local capacity and removes automatic reassignment after durable local acceptance.
2. **A 2.5-second occupant probe can evict a live Celeron.** The main event loop already experiences synchronous raster stalls. V2 uses durable installation identity and explicit replacement.
3. **An in-flight Set dies with the process.** V2 uses atomic local records from receipt through server-confirmed result.
4. **Keeping poll alive after duplicate rejection weakens ownership.** V2 has one short HTTP sync loop and no socket connection.
5. **A wake-only V2 socket is still unjustified complexity.** A measured two-second pull loop supplies bounded latency, recovery, result upload, and health/status through one channel without touching staff/customer Socket.IO behavior.
6. **`destroy()` versus `end()` is not the established defect.** The measured loopback probe delivered the complete buffer both ways. V2 uses artifact length/hash, backpressure, and explicit deadlines.
7. **PowerShell containment is still the wrong steady-state interface.** V2 uses the supported Winspool APIs in a supervised helper.

## New design decisions that need hostile review

These are the newest and therefore least-proven parts of the corrected plan:

1. The local acceptance handshake must not create a window where neither server nor agent owns the job.
2. `local_accepted` must never auto-reassign, but an explicit replacement/recovery flow must not strand work forever.
3. The one-active-agent database rule and bootstrap registration must resist a second installation. The V2 secret is DPAPI machine-protected so copying `agent.json` does not clone authority; exact full-machine imaging remains an explicitly unsupported recovery case.
4. Repeated outbox results must be idempotent even after server rollback/restart.
5. Local safe retries must not turn a permanent poison payload into an infinite loop.
6. Per-printer lanes plus one render slot must preserve same-printer order and low-resource bounds.
7. Killing a blocked Winspool helper after a submit request must conservatively preserve uncertainty.
8. The V1/V2 cutover must make dual delivery impossible per station.
9. The current 1.2.8 report artifact must be physically tested before a compatibility profile becomes default.
10. Updater rollback must not downgrade or delete a V2 journal containing unsettled jobs.
11. The two-second idle sync interval must survive measured 1/10/50/100-agent load without starving the server DB pool or checkout traffic.
12. Replacing an unreachable agent cannot prove that its local accepted work will never print. The plan must preserve that ambiguity, never reassign those rows, and require confirmed old-terminal shutdown plus audited recovery.
13. Sync must replay existing unaccepted rows before new claims and serialize on the agent row; otherwise a lost response waits for a lease and concurrent capacity-one requests can claim two jobs.
14. Network status probes must share the printer lane and never interleave DLE EOT bytes with print bytes.
15. Cancellation after local acceptance cannot be called successful until the agent durably confirms it before `transport_started`.
16. V1 rollback is safe only before the first V2 local acceptance; afterward the updater must restore a working V2 binary or pause for recovery, never feed V2-owned jobs to V1.
17. V1-to-V2 cutover must drain or explicitly terminalize every V1 in-flight row before V2 activation.

## Adversarial scenarios already applied to the plan

| Attack | Plan response |
|---|---|
| V2 Socket.IO disconnect/rejection bug class | V2 has no Socket.IO connection; HTTP sync is the only lifecycle |
| Internet drops after local accept | Agent continues rendering/printing and queues result locally |
| Agent dies after local accept | Journal restores queued/rendered state |
| Agent dies after first printer byte | Durable `transport_started` restores as uncertain |
| Server dies after receiving result | Agent resends outbox; settlement is idempotent |
| Sync response is lost | Existing `sent` rows replay on the next sync before any new claim |
| Two syncs race with capacity one | Agent-row serialization and outstanding-row subtraction return at most one distinct job |
| Lease expires while job is locally queued | `local_accepted` is not automatically claimable |
| Second installation uses same station | Its distinct durable identity is rejected; explicit replacement is required |
| `agent.json` is copied to another terminal | DPAPI machine-scope unprotect fails before sync or workers start |
| Acceptance and completion arrive in one sync | Server applies acceptance before idempotent result settlement |
| Old agent accepted work but its ACK was lost, then admin replaces it | Old unresolved rows become `AGENT_REPLACED_OUTCOME_UNKNOWN`; they are never delivered to the replacement |
| Old unreachable terminal later starts after forced replacement | It validates identity before starting workers and remains paused; operator resolves its journal manually |
| Windows API hangs | Child process is killed; Node agent/status/sync survive |
| Large report uses hundreds of bands | Artifact streaming avoids full output concatenation and full-height RGBA |
| Report targets receipt printer while kitchen has separate printer | Per-printer lanes prevent transport head-of-line blocking |
| Cheap clone ignores status query | Capability becomes write-only/unknown; printing remains supported |
| Status query races an artifact write | Per-printer serialization prevents byte interleaving |
| Printer accepts bytes but paper jams | UI says bytes/OS accepted, not paper printed; operator recovery remains |
| Update is interrupted | Transaction restores a coherent app while preserving env and journal |
| Rollback is requested after V2 accepted work | Updater restores working V2 or pauses; V1 delivery remains disabled |
| V1 owns an in-flight row during cutover | V2 activation waits or requires explicit outcome-unknown recovery |

## Honest plan strength

- **Architecture:** strong enough for implementation review. It removes V2 socket lifecycle and dual delivery rather than tuning timers.
- **Server/local state model:** strong, but must be model-tested at every crash point before product code is trusted.
- **Windows helper:** technically grounded in supported APIs; needs a proof-of-concept and a real printer integration test.
- **Real-time status:** achievable for Winspool and capable ESC/POS devices, explicitly unavailable for many cheap clones.
- **Report corruption:** diagnosis is strong; closure is blocked on one current-version physical test at the affected hardware.
- **Rollout:** safe only if V1/V2 station ownership is persisted, in-flight V1 work is resolved before cutover, and rollback never starts V1 after V2 has accepted work.

This is not claimed 100% defect-free. It is ready for an adversarial plan review, not execution, because the Windows helper and acceptance handshake are new design surfaces and the report hardware evidence remains absent.

## Prompt for Fable

Review `docs/superpowers/plans/2026-08-17-spooler-v2-local-print-agent.md` against the current repository. Do not turn the task into implementation and do not restate the plan. Try to break the newest boundaries: pull-only V2 sync under 1/10/50/100-agent load, lost-response replay, concurrent capacity accounting, registration and DPAPI-protected identity, one-active-agent ownership, same-sync acceptance plus completion ordering, `local_accepted` recovery and cancellation, forced replacement while the old terminal is unreachable, restart-before-worker identity validation, disk-full transitions, crash points, V1/V2 coexistence, per-printer scheduling and priority, bounded report artifacts, Winspool helper containment, status-probe byte isolation, capability-aware status, and updater rollback with unsettled local jobs. Specifically search for any path that can assign a V2 job outside sync, claim beyond real capacity, wait for a lease after response loss, automatically reassign an old agent's outcome-unknown work, let a revoked agent print its journal, interleave status and print bytes, or treat a copied identity file as a second valid terminal. Verify every load-bearing claim in source or an official primary reference. Separate confirmed defects from judgment calls and physical-printer gates. If you find a defect, show the exact event sequence that violates an invariant and the smallest correction; do not propose threshold tuning as a correctness proof.

## Sources

- Current repository: `pos-spooler-printer/server.js`, `pos-spooler-printer/poll-fallback.js`, `pos-spooler-printer/durable-seen-store.js`, `backend/services/printQueue.js`, `backend/services/spoolerRegistry.js`, `backend/routes/spooler.js`, `server.js`
- Existing field diagnosis: `docs/deferred-spooler-long-report-raster-corruption.md`
- Fable lifecycle report: `docs/superpowers/evidence/2026-08-17-spooler-lifecycle-review.md`
- Print.js: <https://printjs.crabbly.com/>
- QZ Tray: <https://qz.io/docs/what-is-raw-printing>, <https://qz.io/docs/printer-status>, <https://qz.io/docs/signing>
- Odoo IoT: <https://www.odoo.com/documentation/19.0/applications/general/iot.html>, <https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/hardware_network/receipt_printers.html>
- Star CloudPRNT: <https://star-m.jp/products/s_print/sdk/StarCloudPRNT/manual/en/protocol-reference/index.html>
- Microsoft Winspool: <https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer>, <https://learn.microsoft.com/en-us/windows/win32/printdocs/getjob>, <https://learn.microsoft.com/en-us/windows/win32/printdocs/findfirstprinterchangenotification>
- Microsoft Windows DPAPI: <https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata>
- Epson DLE EOT: <https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/dle_eot.html>
