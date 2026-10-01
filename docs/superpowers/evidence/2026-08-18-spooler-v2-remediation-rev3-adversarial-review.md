# Spooler V2 remediation rev 3 — independent adversarial review

Date: 2026-08-18
Branch: `codex/spooler-v2-local-print-agent-continued` @ `f5321e2a`
Scope: hostile re-audit of the remediation recorded in `2026-08-18-spooler-v2-audit-remediation-rev3.md`
Method: four parallel boundary reviewers (runtime/journal, transport/helper, server protocol, installer/updater) under the adapted hostile-review protocol, plus orchestrator re-verification of every HIGH against source, plus independent experiments and an independent full-suite run.

## Verdict

The rev-3 verdict — *"no remaining defect in the audited runtime/journal, transport/helper, server ownership, migration-authority, or installer-recovery boundaries"* — does not hold. **Four HIGH findings stand**, three of them introduced or left open by the two newest commits (`084fcb20`, `8a80ef66`), which are precisely the commits that received the least independent review.

The recurring pattern is not sloppiness — it is that each late fix **moved** its defect rather than closing it:

| Fix | What it closed | What it opened |
| --- | --- | --- |
| `8a80ef66` helper-exclusive queue | marker ordering across concurrent helper requests | one untimed file read now stalls every Windows printer on the station (T1) |
| `8a80ef66` installer ambiguous-recovery | rollback committing on a lost response | service stopped while still auto-startable (I1) |
| `6fcac46c` state-root lock | helper-scoped lock dying with the helper | Node lock fails open on stale-lock recovery (R1) |
| `ef8a685b` acceptance-aware rollback | in-process catch respects accepted work | boot-time consumer of the same journal does not (I3) |

Genuinely closed and verified: **H1, H2, H4, M1, M2, M7, M9, M10**, each with non-tautological regression tests. The migration-authority commit is correct. Details in "Verified clean".

Not canary-ready.

---

## HIGH

### T1 — One untimed artifact read stalls every Windows printer on the station, permanently

**CONFIRMED** (orchestrator-verified; reviewer reproduced against real source with a differential run against `8a80ef66^`).

`send()` wraps its whole body in `serializeHelper` (`pos-spooler-printer/v2/printer-transports.js:244`), which in production resolves to `helper.runExclusive` (`pos-spooler-printer/v2/platform-helper.js:158`) — a bare `exclusiveTail.then(operation, operation)` FIFO with **no per-slot timeout**; the next operation starts only when the previous one *settles*. Inside that lock:

- `await verifyArtifactHash(artifact)` (`printer-transports.js:250`) — a full `fs.createReadStream` + SHA-256 with **no deadline** (`:39-59`), and it never touches the helper.
- `await markTransportStarted?.()` (`:252`) — a journal fsync, also unguarded.
- every *other* await in the closure is `withTimeout`-wrapped (`:257-263`, `:282`, `:296`).

`createWindowsTransport({ helper })` is instantiated once (`pos-spooler-printer/v2-server.js:113`) and returned by `transportFor` for every Windows printer, so the blast radius is the whole station.

Sequence: a stalled artifact read (AV lock, failing storage, UNC state root — `pathIsAbsolute` explicitly accepts UNC) holds the single global slot; every subsequent print, probe and watch for every Windows printer queues behind it and never runs. `close()` never touches `exclusiveTail`, and the hang is Node-side file I/O unrelated to child liveness, so neither a helper restart nor shutdown clears it — only an agent restart.

Differential proof this is a regression: the same experiment against `8a80ef66^` settles the unrelated job normally, because pre-fix `send()` had no shared queue.

Invariant violated: a printer lane never stalls permanently.

Smallest fix: hoist `verifyArtifactHash` out of the serialized closure (it needs no helper) and give it the same `withTimeout` treatment as its neighbours, classified `transient_safe` — nothing is marked at that point. Same for `markTransportStarted`.

Note: even short of a hang, a merely slow read now serializes across printers, which is what the per-printer lane design exists to prevent.

### I1 — Installer's ambiguous-recovery branch stops the service before disabling it

**CONFIRMED** (orchestrator-verified).

`deployment/windows/Install-Spooler.ps1:307-315` — the safe-fallback arm added by `8a80ef66`:

```powershell
Stop-Service $serviceName -Force
$currentService.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
if ($currentService) { Set-Service $serviceName -StartupType Disabled }
throw "V2 ownership recovery is ambiguous; ..."
```

Every other disable site in the codebase does the opposite, correctly: `Repair-SpoolerStartup.ps1:149`, `:161`, `:179` and `Update-Spooler.ps1:586-588` all set `Disabled` **then** stop. This branch is the sole outlier and is the newest code in the file.

Sequence: the station reaches this arm with `StartupType=Automatic` (set at `:206`). Power loss between the confirmed stop and the `Set-Service` — or a throw from `Set-Service` itself, which has no `-ErrorAction` override and no local try/catch — leaves an auto-start service pointed at an entry point that is by construction unverified. At the next boot SCM starts it before `Repair-SpoolerStartup.ps1` runs (that task deliberately delays 75s, `:132`).

The regression test added in the same commit (`backend/tests/unit/installerUpdateContract.test.js:672`) only asserts Disabled-before-*throw-message*. `'Stop-Service $serviceName -Force'` occurs three times in the catch block (`:282`, `:297`, `:310`) and `catchBlock.indexOf(...)` binds to the first, so no assertion in the file can observe the `:310` vs `:313` ordering.

Invariant violated: after any interruption the station converges on working V1, working V2, or a deliberately disabled service.

Smallest fix: swap the two blocks, matching the three sites that already get it right.

### I2 — Install-Spooler.ps1's entire recovery sequence is unjournaled

**CONFIRMED** (orchestrator-verified: `grep -c journal deployment/windows/Install-Spooler.ps1` → `0`).

`Update-Spooler.ps1` and `Repair-SpoolerStartup.ps1` both participate in the transaction journal; `Install-Spooler.ps1` never writes one. So after any interrupted install/cutover, `Repair-SpoolerStartup.ps1:138` reads `$null` and falls through to the generic arm (`:196-203`), which checks only whether the service is `Running` — it never compares the configured NSSM entry point against a known-good value, and never queries authoritative station protocol.

Concrete second instance, `Install-Spooler.ps1:279-286`: the catch stops the service (`:282-283`) while the entry point is still `v2-server.js`, and only reverts it at `:285`. Power loss in between leaves an `Automatic` service pointed at a V2 entry point the server never accepted for that station, and boot-time recovery cannot detect it.

This generalises I1: the whole catch block (`:259-329`) is ~15 mutating lines of REST calls and service transitions that self-heal only if the process survives to finish them.

Smallest fix: write a durable `{previousScript, targetScript}` marker before touching an existing service's entry point (reuse `Save-SpoolerJournal`/`Update-SpoolerJournalPhase`), and teach the `Repair-SpoolerStartup.ps1` fallback to force the last-known-good entry point before starting.

### I3 — Boot-time repair stops a healthy, job-accepting V2 station and then loops forever

**CONFIRMED** (orchestrator-verified across all four hops).

`Update-Spooler.ps1:576-578` deliberately refuses to roll back a station that has accepted real work (`$cutoverAccepted` ← `first_v2_accepted_at`): it sets `$v2PausedRecovery`, disables future starts (`:625-627`), and **leaves the running V2 service alone**. It also leaves the journal at phase `v2_registered`/`v2_application_active`.

`Repair-SpoolerStartup.ps1:160-162` handles those phases with **no acceptance check at all** — `Set-SpoolerRepairServiceStartupMode 'Disabled'` then an unconditional `Stop-SpoolerForRepair`, then attempts rollback/abort. The server correctly rejects it: `backend/services/spoolerAgents.js:369-371` throws 409 `v2_rollback_locked` when `first_v2_accepted_at` is set or unresolved rows exist. The rethrow at `Repair-SpoolerStartup.ps1:174-177` means the restore/entry-point/journal-removal steps (`:166-173`) never run.

Sequence: a working, printing V2 station is halted by an ordinary reboot (Windows Update, power cycle). The journal is never cleared, so every subsequent boot repeats stop → 409 → disable; `Update-Spooler.ps1:368-370` refuses to run at all while a journal exists (`blocked_recovery_required`); `docs/printing-runbook.md` documents no manual exit from this state.

Precision: `--rollback-v1` is locally side-effect-free (`v2-server.js:95-99` passes `store: null`; `v2/sync-client.js:51-54` is a pure POST), so the local print journal is not destroyed. This is a stuck-availability defect, not data loss.

Smallest fix: before the unconditional stop at `Repair-SpoolerStartup.ps1:162`, consult the same signal `Update-Spooler.ps1` already computes (`first_v2_accepted_at` / active agent). If work was accepted and the service is running, leave it running, log, and stop retrying on every boot.

---

## MEDIUM

### R1 — The state-root lock fails open; single-instance is still enforced by the helper mutex H3 called insufficient

**CONFIRMED race; severity revised down from HIGH after tracing the masking link.**

`pos-spooler-printer/v2/state-root-lock.js:55-60` — the stale-owner reclaim path does `unlinkSync` then `create()` with nothing re-verifying the winner. Two processes that both observe a dead-PID lock both unlink and both create; the second deletes the first's fresh lock.

Proven against the real module with barrier-synchronised process starts: **15/15 trials produced 2–4 simultaneous owners.** Measured vulnerable window (unlink + open + write + fsync): **~1.5 ms**.

Consequence proven at the journal level — two stores on one root produce a lost update:

```
A after transport start: transport_started
B wrote: rendered            (B's stale snapshot overwrites A)
after restart, journal says: rendered
appears in runnable() again: true      → the job prints a second time
```

`mutate()`'s terminal guard does not help: `transport_started` is not terminal, and this is a lost update, not an illegal transition.

**Why MEDIUM, not HIGH:** the C# helper still takes a `Global\POSAPP-Spooler-V2-<hash>` kernel mutex (`windows-helper/PosSpoolerPlatform.cs:342`) and emits `{type:'fatal', code:'STATE_ROOT_LOCKED'}` on loss (`:346`). `startPlatformHelper` is awaited at `v2-server.js:68` — before `openJobStore` at `:80` — the fatal rejects startup (`platform-helper.js:113-118`), and the catch does `await close(); throw` → `process.exit(1)`. The losing process dies before it can touch the journal.

It still needs fixing, because:

1. `docs/architecture.json` was rewritten in `f5321e2a` to assert the Node process owns exclusion and to demote the helper to *"provides DPAPI, Winspool, and printer change notifications"*. The map documents a guarantee the code does not have.
2. H3's stated premise was that the Node lock must be self-sufficient, since the agent can pull and TCP-print with no helper. Any change that opens the journal before the helper, or makes the helper optional for TCP-only stations, converts this directly into the duplicate print demonstrated above.
3. Neither `084fcb20` nor `8a80ef66` touched this file; it has been unexamined since `6fcac46c`.

Smallest fix: make stale reclamation single-winner with an atomic primitive — `fs.renameSync(lockPath, lockPath + '.' + bootId)` then `create()`. Verified empirically: the second racer's rename fails `ENOENT`, so exactly one process can retire a given stale lock; the loser retries and finds a live owner. (A first hypothesis — hold the fd open so Windows blocks deletion — was **tested and disproved**: libuv opens with `FILE_SHARE_DELETE`, so unlink succeeds anyway.)

### T2 — M6 narrowed, not closed: a helper death after the readiness check still manufactures `uncertain`

**CONFIRMED** (reviewer reproduced).

`printer-transports.js:248` checks `helper.isReady()` once, at the top of the exclusive turn. The hash read (`:250`) and the marker write (`:252`) both follow. A helper death landing in that gap makes `requestOnChild` (`platform-helper.js:39-66`) reject on its `!child || !ready` early return — **before any `child.stdin.write`** — but that rejection carries no signal distinguishing "never sent" from "sent then failed", so `send()`'s catch (`:271-274`) stamps `uncertain`.

Result: a manual-reprint casualty for a job that provably never printed — the exact outcome M6's fix was written to eliminate, in a smaller window. Safe direction (no duplicate paper): every post-marker failure path resolves to `uncertain`, never a silent success.

Smallest fix: tag the never-written rejection path (e.g. `error.neverWritten = true`) and classify it `transient_safe`.

### S1 — The cancellation channel has no production caller

**CONFIRMED** (orchestrator-verified by grep).

`requestPrintJobCancellation` (`backend/services/spoolerSync.js:11`) is called only from `backend/tests/integration/spoolerV2Sync.test.js`. No route imports it; order-void never touches `print_queue`. The `cancel_requested` enum value, the migration that appends it, the sync-response field and the agent-side handling all exist for a capability nothing can currently invoke.

This is the D3 gap from the original plan review — built, tested, unreachable. Plausibly scoped to a later task, but it should be a recorded decision rather than a canary-time surprise.

### A1 — An unclassified render error retries forever and is never reported

**CONFIRMED mechanism; real-world triggerability unverified.**

`pos-spooler-printer/v2/artifact-renderer.js:511` evaluates `htmlForJob(job)` **as an argument** to `renderHtml(...)`, so anything it throws that is not `COMPILED_DOCUMENT_INVALID` bypasses `renderHtml`'s own classifier and arrives with no `failureClass`. `pos-spooler-printer/v2/printer-workers.js:79-81` then falls to `scheduleRetry`; `retryDelays` clamps the delay but **nothing clamps the attempt count**.

The job never reaches a terminal state, so `outbox()` never reports it — the receipt never prints and the server is never told. Local health shows only an elevated `retry_wait` count.

Smallest fix: in the `else` branch, once `attempts` exceeds `retryDelays(record).length`, record `permanent_failure` instead of scheduling another retry.

### I4 — Install-Spooler.ps1 does not take the transaction mutex the other two scripts use

**PLAUSIBLE** (mechanism verified; no concrete racing interleaving executed).

`Update-Spooler.ps1:366` and `Repair-SpoolerStartup.ps1:134` both acquire `Enter-SpoolerUpdateTransaction` (`SpoolerLayerState.ps1:212-225`); `Install-Spooler.ps1` has zero references to it. `POSAPP-Spooler.iss:36`'s `SetupMutex` only serialises the Inno Setup wrapper, not a Task-Scheduler-launched repair. The repair task's 75-second delay is exactly the window an admin reinstalling a just-rebooted station would land in; both scripts then write the same NSSM `AppParameters` and toggle the same service uncoordinated.

Smallest fix: wrap the mutating section in the same enter/exit pattern.

---

## LOW / NOTE

- **Tests never exercise the production serialization branch.** `serializeHelper` has two arms; `runExclusive` appears **nowhere** in `pos-spooler-printer/tests/v2-printer-transports.test.js` (verified). Every serialization test — including the one asserting *"Windows helper submissions must be globally serialized"* — supplies a mock without `runExclusive` and so exercises the local `helperTail` fallback, a separately-written duplicate. The wiring `8a80ef66` introduced is untested end to end.
- **`fakeStore.retainArtifactForCleanup`** (`tests/v2-printer-workers.test.js:22`) omits the real `JOB_NOT_TERMINAL` guard. Masks nothing today; a future change that reached the call site in a non-terminal state would pass for the wrong reason.
- **C# watch generations share one static stop flag.** `PosSpoolerPlatform.cs:260-265` nulls `WatchThread` even when the 1500 ms join times out, and `StartWatch` then resets `StopWatching = false`, so a slow-exiting thread never sees its stop request and leaks printer/change-notification handles. PLAUSIBLE — needs real driver latency to fire.
- **`status_disabled` is now unreachable for the TCP probe.** Every `STATUS_UNSUPPORTED` in `printer-transports.js` `probe()` is returned, never thrown, so `status-monitor.js:59` can never set it. This may be the intended M10 correction (no permanent capability downgrade) or an over-correction — confirm intent.
- **Stale assertion message.** `tests/v2-platform-helper.test.js:141` still says "recycle the serial helper"; `recycleAfterPrint` was deleted by `8a80ef66`. Passes for a different reason than it states.
- **Stale `locked.status` re-read.** `backend/services/spoolerSync.js:230` gates the health tail on a value read before the in-transaction decommission at `:166`, so the tail runs once for a just-decommissioned agent. Inert — the admin join excludes those rows.
- **V1 and V2 share `SPOOLER_STATE_DIR`.** Both resolve the same root and `<root>/artifacts`, but V1 never takes the lock. `cleanup()` only deletes journal-referenced files, so this is orphan-artifact accumulation, not corruption.

---

## Verified clean

Attacked and could not break:

- **H1** — `mutate()`'s terminal guard covers every mutator; `requestCancel` and `retainArtifactForCleanup` carry correctly-scoped guards of their own; `confirmAccepted`'s `allowTerminal` only touches a flag, never `state`. Workers re-read `store.get()` with no `await` between check and action.
- **H2** — `agent_id` is written in exactly one place server-side and **never cleared back to NULL**, which is what makes a single `IS NULL` predicate sufficient rather than a guard needing repetition. `admin/printers.js:164` still reassigns `spooler_id` unconditionally, as the original finding said; the fix is correctly at the claim boundary. Backstopped in the schema: `spooler_agents.active_station_key` is a STORED generated column under a UNIQUE key, so InnoDB refuses a second active agent per station even if the app-level lock were bypassed.
- **H4** — `runExclusive`'s finally mirrors `runLane`'s restart; the regression test drives a real probe-then-arrival race.
- **M1** — reactivation is structurally symmetric with fresh registration.
- **M2** — the C# `finally` calls `AbortPrinter`, never `EndDocPrinter`; the `WritePrinter` loop advances `offset` correctly on short writes.
- **M7** — `Status == 0` maps to `"unknown"`; every path stamps `os_reported`, so `device_confirmed` cannot be earned accidentally.
- **M9** — the revoked-agent gate reads a fresh `FOR UPDATE` row.
- **M10** — `(v & 0x93) !== 0x12` is exactly right.
- **M3/M4/M5/M8** — present as specified, each with a test that fails against the pre-fix behaviour.
- **Marker ordering** — holds on both transports; no path skips the marker while attempting bytes.
- **Failed-watch replay does not loop** — microtask ordering guarantees the payload is cleared before the next `ready`.
- **Lock ordering** — `stations → agents → print_queue` identical in all five transactional functions; no `await` straddles an external call.
- **Durable writes** — `writeAtomic` temp+fsync+rename with in-memory revert on failure; boot sweeps orphaned `.tmp`.
- **H6 where it was actually fixed** — `Update-Spooler.ps1:583-611` orders disable → stop → restore entry point → restart → delete journal correctly, and neither newest commit touched that file.

### Migration authority (`8d30016e`) — correct

Verified independently:

- all 20 manifest `sha256` values match their files;
- Hostinger fallback parity holds for all 18 post-floor blocks, in manifest order; the two excluded entries are the floor and its predecessor, as the rules require;
- the bug it fixes is real: `2026-08-01-additive-schema-reconciliation` is `repeatable: true` and runs *before* `2026-08-17` in every pass, so its former `MODIFY COLUMN status enum(7-values)` would have truncated `local_accepted`/`cancel_requested` on every migration run;
- no sibling repeatable migration touches `print_queue.status`; the remaining 7-value statements are all inert pre-floor files;
- the `2026-08-17` enum append is at the end of the value list, isolated, `ALGORITHM=INSTANT, LOCK=NONE`.

One NOTE: a database whose ledger already records `2026-08-17` but whose `print_queue.status` column is absent (partial restore) would get the 7-value column from the reconciliation and nothing would upgrade it. Narrow; arguably drift-repair's domain.

### Architecture map

`npm run architecture:check` passes independently — 217 nodes, 59 flows, 446 steps, all referenced files present. The map correctly re-describes the H3 lock change, but see R1: it now asserts an exclusion guarantee the code does not provide.

---

## Independent verification runs

- **Full repository Vitest, once: 2,979/2,980 tests, 275/276 files.** One failure: `backend/tests/integration/tables.test.js` → *"allows only one winner when payment races an unpaid-group edit"*, `expected [200, 404] to deeply equal [200, 409]`.
  Rerun in isolation: **195/195 passed**. So it is an order/load-dependent race flake, unrelated to the spooler — but the rev-3 claim of 2,980/2,980 is **not reproducible**, and a concurrency test that flakes under load is exactly the kind that can mask a real regression.
- `npm run architecture:check` — passed.
- Manifest hash + fallback parity + ordering — scripted check, passed.
- State-root lock race — 15/15 reproduction, window measured at ~1.5 ms.
- Journal lost-update between two owners — reproduced.
- `renameSync` single-winner semantics — verified before recommending.
- Open-fd-blocks-unlink hypothesis — **disproved**, and discarded.

No merge, push, deployment, migration, or station cutover was performed.

## Recommended order of work

1. **T1** — the only finding that degrades a station in normal operation with no crash, reboot or interruption required.
2. **I3**, then **I1**, then **I2** — all three halt stations, and I3 fires on an ordinary reboot.
3. **R1** — plus correct `docs/architecture.json`, which currently documents the wrong exclusion guarantee.
4. **A1**, **T2**, **S1**, **I4**.
5. The test-honesty gaps: supply `runExclusive` in the transport tests and give `fakeStore` the real terminal guard. Both currently pass for the wrong reason, and the first would have caught T1.
