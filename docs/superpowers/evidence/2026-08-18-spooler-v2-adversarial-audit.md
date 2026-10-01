# Spooler V2 — Adversarial Implementation Audit

**Date:** 2026-08-18
**Branch:** `codex/spooler-v2-local-print-agent-continued` (12 commits over master)
**Under audit:** the full V2 implementation — server protocol, agent runtime, renderer/transports, migration/installer — against `docs/superpowers/plans/2026-08-17-spooler-v2-local-print-agent.md` (rev 2.1) and the Phase-1 executor plan.
**Method:** four hostile reviewers, one per subsystem boundary, each ordered to assume the code broken and prove breaks with exact event sequences; every load-bearing HIGH re-verified against source by the orchestrator before inclusion. Nothing was modified. No fix was applied.

## The audit protocol (adapted, reusable)

Distilled from how Claude runs adversarial code review, encoded into each reviewer's system prompt so the method is repeatable, not ad-hoc:

1. **Hostile prior.** "Assume it is broken until proven otherwise. A plausible-sounding non-bug is a failure on your part." Removes the confirmation bias that makes a reviewer nod along to clean-looking code.
2. **Evidence standard.** Every claim cites `file:line` actually read this session. Every defect states three things: the invariant violated, an exact numbered event sequence from initial state to wrong outcome, and the smallest correction. No prose defect without a sequence.
3. **Confidence separation.** Findings are tagged CONFIRMED (source-proven sequence), PLAUSIBLE (needs runtime proof the reviewer cannot obtain), or NOTE (judgment call). Speculation is never laundered into fact.
4. **Bounded blast radius.** Each reviewer owns one subsystem so it is read in depth, not skimmed; a shared attack catalogue is worked item by item, and null results are reported ("clean areas attacked") so silence never masquerades as coverage.
5. **No fixing while auditing.** Reviewers may not edit, run the shared-DB test suite, or propose rewrites/threshold-tuning as corrections — only the smallest structural fix. Keeps the audit honest and the fix surface minimal.
6. **Verify before accepting.** The orchestrator independently re-reads the source behind every HIGH before it enters this report — reviewers find, they do not get believed on reputation.

Convergence check: two reviewers independently found the same canceled-job-still-prints defect from opposite ends (server cancel contract vs. worker lane), which is corroboration, not double-counting. It is listed once (H1).

## Revision history

- **rev 2 (2026-08-18, this document):** two corrections from Sol's review of rev 1, both re-verified against the codebase before acceptance — (a) the verdict's "clean area" claim about the `agent_id IS NULL` guard was unqualified and contradicted H2; it now names the exact path where the guard exists and the exact path where it does not; (b) H5 (garbage status byte) is **reclassified from HIGH to MEDIUM (M10)** after runtime reproduction plus a code check proving the probe gates no print. The defect stands; only its severity changes. HIGH count is five, not six. Section IDs H1-H4 and H6 are unchanged so earlier references still resolve.

## Verdict

The V2 architecture holds up under attack — pull-only ownership, the durable journal, station-then-agent lock ordering, and the transport_started/uncertain discipline all survived (see "Clean areas" per boundary). **One guard needs naming precisely, because a loose summary of it is misleading:** `AND q.agent_id IS NULL` exists in the **V2 claim** query (`spoolerSync.js:206`), which is what makes "a replacement agent can never receive the old agent's rows" true and survivable. It does **not** exist in the **V1 reclaim** query (`printQueue.js:92-105`), whose only protection is the station gate — and that gate is defeatable by a printer reassignment. That gap is H2. A guard verified on one path is not a property of the system.

The implementation is **not ship-ready**: **five CONFIRMED HIGH defects** — three put duplicate paper in front of a customer (H1, H2, H3), one silently never prints a kitchen ticket (H4), one leaves a station dead while reporting healthy (H6). All five have small, structural corrections. This is a fix-and-re-audit, not a redesign.

Test state at audit time: all V2-specific suites pass (backend 123/123; spooler package green). The green suites do **not** exercise any of the five HIGHs — every one lands in a coverage gap the reviewers named. Two pre-existing full-suite failures were run down (see Appendix); one is a real inert-guard regression introduced by this branch.

---

## CONFIRMED — HIGH (ship blockers)

### H1 — A canceled job still prints; the journal has no terminal-state barrier
**Found independently by the runtime and renderer reviewers. Invariant 6 / cancellation contract.**
`job-store.js` `mutate()` (178-191) rejects only missing/archived entries — it never checks `TERMINAL.has(previous.state)`, so it will flip `canceled → rendered → transport_started → completed`. The workers operate on in-memory record snapshots captured at `collect()` and never re-read store state before rendering or sending (`printer-workers.js:82-104, 152-165`).
Sequence: job accepted → `queued`, worker owns it into the render queue → a sync tick delivers `cancel_requested`, `requestCancel` sets `canceled` and puts a `canceled` result in the outbox (possibly already reported to the server) → the pump reaches its stale snapshot, renders, `markRendered` (no guard) → `markTransportStarted` → **bytes hit the printer** → `recordResult` overwrites `canceled` with `completed`. Physical paper for a ticket the server was told was canceled.
Smallest correction: `mutate()` throws on transitions out of terminal states; the lane loop and render pump re-read `store.get(id).state` and skip non-runnable records before `render`/`send`; classify the resulting `JOB_TERMINAL` as drop-ownership-no-result.

### H2 — V1 can seize a V2 `sent` row after an admin printer reassignment; double print
**Server reviewer. Invariant 4 ("a `sent` lease may replay only to the same active agent").**
The V1 claim predicate (`printQueue.js:97-102`) reclaims expired `sent` rows and has **no `q.agent_id IS NULL` condition** — its only guard is the station gate keyed to the *printer's* `spooler_id`, which `PUT /printers` rewrites unconditionally (`routes/admin/printers.js:164-167`). V2 replay never renews `locked_until` (`spoolerSync.js:188-194`), so every V2 `sent` row older than 120 s satisfies the V1 "sent-expired" branch.
Sequence: V2 station claims job Q (`sent`, `agent_id=A`, lease+120s); agent holds the payload, hasn't reported acceptance → lease expires → admin repoints the printer to a V1 station → that station's V1 poll matches Q via the sent-expired branch (no `agent_id` check), prints it, settles `acknowledged`; the V2 agent also prints Q from its journal, and its later acceptance/result no-op against the terminal row. Two copies, no dead-letter, both sides think they were sole owner.
Smallest correction: add `AND q.agent_id IS NULL` to the claimable-row predicate in `claimPrintJobs`. (Rollback/replace already terminalize agent-owned rows before a station returns to v1, so this costs nothing normally.)

### H3 — Single-instance lock dies with the helper; the agent keeps printing lockless
**Runtime reviewer. Invariant 16 (exactly one process may own a state root) — this is the D2 double-print the plan was written to kill.**
The only exclusivity is a named mutex held by the **helper** child process (`PosSpoolerPlatform.cs:327-338`); the Node agent that actually prints holds nothing. Clean double-start is caught, but: helper A crashes → mutex released with it → in the 100 ms restart window (or any pre-respawn moment) agent B starts, its helper takes the mutex, B runs workers → A's helper restart now fails `STATE_ROOT_LOCKED` forever, and **A ignores it** because `onEvent` only handles `printer_status`, not `type:'fatal'` (field name mismatch: helper emits `{type:'fatal'}`, `v2-server.js:31-33` reads `event.event`). A needs no helper to pull and TCP-print, so both processes print the same journal's jobs.
Smallest correction: hold the lock in the printing process — a Node-side `O_EXCL` lockfile with PID+liveness before identity load (spec §2.2 permits this) — or at minimum treat helper `fatal/STATE_ROOT_LOCKED` as fatal to the whole agent.

### H4 — A status probe permanently stalls a printer lane; kitchen ticket never prints
**Renderer reviewer. Per-printer serialization liveness.**
`statusMonitor` calls `workers.runExclusive`, which sets `lane.running=true` (`printer-workers.js:120-130`). If a render completes and calls `enqueueLane → runLane` during the ~3 s probe, `runLane` returns immediately (lane busy). When the probe's `finally` clears `lane.running` it calls only `notifyIdle()` — **never `runLane`** (126-129), unlike `runLane`'s own finally which does restart. No other path revives the lane; the job sits until a *new* job for that printer arrives, and `stop()`/`idle()` hang on the non-empty queue.
Smallest correction: `runExclusive`'s finally does `if (lane.queue.length > 0) runLane(Number(printerId))`.

### H5 — reclassified to MEDIUM in rev 2; see **M10**
Runtime reproduction confirmed the defect (a single `0x00` byte yields `deviceStatus: ok`, `confidence: device_confirmed`), but a code check proved it authorizes and blocks nothing: it is dishonest telemetry, not paper safety. Full finding and the severity reasoning are under M10.

### H6 — Updater rollback restores V1 files but not the service entry point, then deletes the journal
**Migration/installer reviewer. Spec gates "rollback before first acceptance → V1 resumes coherently" and "updater interrupted → coherent install".**
`Update-Spooler.ps1 -EnableV2` flips NSSM `AppParameters` to `v2-server.js` (`:516/519`). If the canary agent fails before registering (DPAPI/env/startup crash — the likeliest first-canary failure), the catch runs the rollback branch (`:583-604`): it restores the payload and restarts the service but **never calls `Set-SpoolerApplicationScript 'server.js'`**, so NSSM still points at `v2-server.js` (which `Restore-ManagedPayload` may have just deleted, since it was only added to the managed roots on this branch). `Start-Spooler` succeeds at the SCM level, node exits instantly, the service flaps — and `Remove-SpoolerTransactionJournal` (`:601`) then deletes the only recovery breadcrumb. `Repair-SpoolerStartup.ps1` (the one place that knows to reset the entry point) sees "Running" and reports healthy. Station dead until a technician hand-edits NSSM. Contract tests missed it — they only assert the token `Set-SpoolerApplicationScript` appears somewhere in the file.
Smallest correction: in the rollback catch, before `Start-Spooler`, restore the entry point (`if ($EnableV2) { Set-SpoolerApplicationScript 'server.js' }`); delete the journal only after the restored service verifies.

---

## CONFIRMED — MEDIUM (fix before fleet rollout)

- **M1 — Re-register after rollback skips the V1 drain check (server).** `registerAgent`'s reactivation branch (`spoolerAgents.js:137-152`) flips the station to `v2` without the `in_flight > 0 → 409 station_busy` check the fresh path runs (159-166), stranding any V1 row claimed after rollback in a state no code path can resolve (invisible to both health counters). Fix: run the same in-flight check inside the reactivation branch, same transaction.
- **M2 — Windows helper commits a partial job on write failure (renderer).** `PosSpoolerPlatform.cs:242-246` `finally` calls `EndPagePrinter`+`EndDocPrinter` on the exception path, committing the partial RAW doc; Node marks the job `uncertain`, operator reprints → partial + full duplicate. Fix: `AbortPrinter` on the exception path instead of EndDoc. *(Related latent bug the orchestrator found while verifying: the write loop at `:223-233` re-reads `buffer` from offset 0 on a short `WritePrinter`, duplicating leading bytes — same file, fold into the same fix.)*
- **M3 — One unacceptable job poisons the whole sync tick (runtime).** `agent-runtime.js:94-99` loops `store.accept()` in one try; a `PAYLOAD_IDENTITY_CONFLICT` (e.g. a redelivered migrated legacy row, hash `legacy:` never matches) throws and aborts the entire tick, and the server keeps redelivering → the agent stops accepting *all* work for *all* printers while looking "online with backoff". Fix: per-job try/catch; surface the conflict as a terminal `permanent_failure` result so the server stops redelivering.
- **M4 — Failed registration latches a permanent 401 loop (runtime).** `registeredAttempted` (`agent-runtime.js:146-158`) is set before the attempt and never reset; a transient 5xx on `register()` strands the agent retrying a 401 that can never succeed without re-registration → needs a manual restart, the exact failure V2 exists to remove. Fix: reset the flag on every successful sync; latch only on non-retryable 4xx.
- **M5 — `next_sync_ms` is not clamped (runtime).** `agent-runtime.js:130,144` trust the server hint; spec line 335 mandates a 5 s clamp. `3600000` → an hour of silence (cancel channel dead); `-1` (truthy) → `setTimeout(-1)` 0 ms hot loop. Fix: `Math.min(Math.max(Number(hint) || 2000, 500), 5000)`.
- **M6 — Helper-restart window turns retriable jobs terminal (renderer).** `printer-transports.js:229-251` marks `transport_started` then calls `helper.request`, which rejects `PLATFORM_HELPER_RESTARTING` synchronously — nothing was written — yet the catch classifies `uncertain`. Every job dispatched during a helper restart becomes a manual-reprint casualty. Fix: check `helper.isReady()` before `markTransportStarted`, throw `transient_safe`; keep `uncertain` only once the stdin write was attempted.
- **M7 — Winspool `Status == 0` laundered to `ok`/`device_confirmed` (renderer).** `PosSpoolerPlatform.cs:79` maps status 0 to `ok` for every non-bidirectional RAW queue (even printer unplugged); `printer-transports.js:261`/`status-monitor.js:109` then stamp `device_confirmed`. Fix: map `Status == 0` to `unknown`, or cap confidence below `device_confirmed` for os-reported states.
- **M8 — Render timeout awaits the hung browser before killing it (renderer).** `artifact-renderer.js:464-466` awaits `page.close()` inside `onTimeout` before `discardBrowser`'s SIGKILL, and `withDeadline` only rejects after `onTimeout` settles — if CDP is wedged (the exact failure the deadline exists for) the whole render queue stalls agent-wide. Fix: SIGKILL first, then best-effort `page.close()`.
- **M10 — DLE EOT probe accepts any single garbage byte as a healthy, `device_confirmed` printer (renderer; formerly H5).** `printer-transports.js:210-213` validates only `response.length === 1`, then reads bits 3/5 and stamps `confidence:'device_confirmed'`. A print-server echoing `0x00` reports `ok`/`device_confirmed`; a genuine DLE EOT n=1 reply carries fixed bits (`(v & 0x93) === 0x12`) that nothing checks. Conversely an ASB printer pushing 4 bytes is marked `STATUS_UNSUPPORTED` permanently. Violates plan invariant 13 ("unsupported printer-status protocols return `unknown`, never `ok`").
  **Why MEDIUM and not paper-safety HIGH** (verified in code, rev 2): the probe gates nothing. `send()` performs no preflight — connect → hash-verify → marker → stream (`printer-transports.js:171-193`), unlike V1 which did block on `preflightPrinter`. The lane calls `send()` directly (`printer-workers.js:84-88`). Server-side, `device_status` is only ever written (`printQueue.js:186,223`; `spoolerSync.js:134`; `printerStatus.js:36,106`) or displayed (`routes/admin/printQueue.js:173`) — it appears in no claim, dispatch, or retry predicate anywhere in `backend/`. The harm is therefore dishonest health telemetry: an operator may believe an unplugged or dumb RAW queue is healthy, which matters most when deciding whether an `uncertain` job needs a manual reprint. Same family as M7. Fix unchanged: require the fixed-bit pattern; anything else → `STATUS_UNSUPPORTED`.
- **M9 — Revoked agent's sync clobbers the `ROLLED_BACK_TO_V1` marker (server).** `runAgentSync`'s tail (`spoolerSync.js:230-258`) updates printer status and `spooler_agents.last_error` unconditionally, including for revoked agents; a stale agent's `health.last_error` overwrites the marker so the reactivation branch can never match again. Fix: gate the tail on `['active','draining'].includes(locked.status)`.

## CONFIRMED — LOW / hygiene

C6 journal `cleanup()` is never called in production → unbounded disk/memory growth (runtime); C8 corrupt legacy `seen-print-jobs.json` backup read is unguarded → boot crash-loop (runtime); C9 quarantine is silent → a quarantined runnable job vanishes with no signal (runtime); C10 no startup jitter passed (runtime); F2 the retroactively-edited 2026-08-01 migration runs the enum expansion as an *unguarded combined ALTER* first in the Hostinger fallback (migration — chain hashes verified consistent, low practical risk on MariaDB, but reintroduces the exact exposure the spec rule forbids); N-series honesty/wording notes per boundary.

## Notable PLAUSIBLE (need runtime/hardware proof)

- **P-transport TCP total deadline is a fixed 15 s regardless of artifact size** (`printer-transports.js:7`) — a ~1 MB 200-row report into a slow printer hits `PRINTER_STREAM_TIMEOUT` → `uncertain`, half-printed; the spec's own 200-row physical gate is at risk. Scale the deadline with `artifact.bytes`.
- **P-helper any request timeout kills the shared helper** — a hung status probe for printer B kills an in-flight `print_raw` for printer A → A `uncertain`. Kill only on `print_raw` timeout.
- **P-journal `transport_started → retry_wait` has no state guard** (`job-store.js:271`) — safe only because both transports currently classify post-marker failure `uncertain`; invariant 6 rests on transport discipline, not the journal meant to enforce it. One future misclassification = silent double print.
- **F3 installer `-EnableV2` failure on an existing station** can leave the entry point on `v2-server.js` with the server stuck `transitioning` (sibling of H6 on the install path).

## Cross-cutting gaps

- The green V2 suites cover none of the five HIGHs (nor M10); each sits in a named coverage gap (no cancel-vs-in-flight-worker test, no probe/garbage-byte test, the lock "test" is a regex over C# source, no printer-reassignment test, updater tests are token-presence only). Re-audit must add a failing test per HIGH before the fix.
- **Summary claims must name the path they were verified on.** Rev 1's verdict generalized `agent_id IS NULL` into a system property while the same document's H2 proved the V1 reclaim lacks it. The subordinate finding was code-checked; the summary sentence was written from architectural intent. When a report states a guard holds, it cites the query it read — every path, or the path is named.
- Physical gates remain correctly declared blockers; DPAPI two-machine, disk-full-at-every-transition, and real updater-interruption gates have no runnable artifact yet (migration reviewer F4).

## Appendix — pre-existing full-suite failures (ran down, not spooler HIGHs)
- `taxExemptWorkflow.test.js`: **passes in isolation** → order-dependent pollution in the full run, not a branch defect (polluter still worth finding).
- `webauthnSchemaMigration.test.js`: **fails in isolation — real regression this branch introduced.** The fixture seeds the ledger from every manifest entry's `requires` link; the new spooler-v2 entry `requires` webauthn, so the fixture re-inserts the very migration it means to exclude, and its predecessor-enforcement guard goes inert (skips instead of applying/rejecting). Smallest fix: `ledger.delete(WEBAUTHN_NAME)` after building the ledger in the fixture. The production boot path is unaffected — the spooler-v2 preflight explicitly accepts both the 7-value and 9-value enum shapes.
- The four `spoolerReceiptDisplay` failures are stale source-location assertions (behavior moved into the V2 renderer); update them to assert the renderer boundary, per the branch's own Task-13 note.
