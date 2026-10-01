# Spooler stack failure audit (connection drops, crashes, power loss)

Date: 2026-08-19. Master @ 18f198e0. Four parallel domain audits (server sync/ownership, agent durability/journal, print execution/transports, ops/deploy/recovery), every headline claim independently re-verified against source before acceptance.

**Overall: 6/10.** The exactly-once core is genuinely strong — adversarial reading found **no path to duplicate paper and no path to silent DB-state loss**. What drags the score down is self-healing and operator visibility: several dead-machine / broken-station scenarios park durably and wait for a human who has no signal to come looking.

## Domain scores

| Domain | Score | Verdict |
| --- | --- | --- |
| Server sync/ownership | 6/10 | Transactional core solid; lease is dead code; watchdog is a passive logger |
| Agent durability/journal | 7/10 | Excellent durability core; one CRITICAL crash-loop hole |
| Print execution/transports | 5/10 | Lanes/crash-recovery airtight; Winspool "completed" is a lie; no retry cap |
| Ops/deploy/recovery | 4/10 | Rigorous transactions; broken stations are invisible remotely; Drain footgun |

## CRITICAL (all re-verified)

1. **Agent crash-loops on any store write failure in the print path.** No `unhandledRejection`/`uncaughtException` handler exists in the package; `runLane`'s async IIFE has `.finally()` but no `.catch()` (v2/printer-workers.js:158-165) and `pumpRender` is fired unawaited via `queueMicrotask` (v2/printer-workers.js:269-274). `finishFailure` re-throws non-JOB_TERMINAL store errors (v2/printer-workers.js:107-110). ENOSPC/AV-lock during `recordRetry`/`recordResult`/`markRendered` → unhandled rejection → process exit → NSSM restarts → same job retriggers → crash-loop until disk clears. `store.accept()` and `store.cleanup()` failures ARE caught (v2/agent-runtime.js:111-119, 145-153) — the worker path just never got the same treatment.
2. **Winspool path: `completed` means "accepted by Windows spooler", never "printed".** PosSpoolerPlatform.cs PrintRaw returns hardcoded `device_status:"unknown"` after EndDocPrinter and the returned `job_id` is never followed up; JS maps to `success:true, confidence:'os_accepted'` (v2/printer-transports.js:271-277) and the worker records terminal `completed`. A powered-off/offline Windows printer still accepts jobs into its queue → an hour-long outage = an hour of receipts reported delivered that never printed. The honest `os_accepted` label exists and is tested — it is just never acted on.
3. **Server lease is write-only dead code.** `locked_until` is set on claim (backend/services/spoolerSync.js:228, V2_LEASE_SECONDS=120) and indexed (idx_print_queue_claim), but no query anywhere reads it. Jobs assigned to a dead machine (`sent`, agent_id set) are re-offered only to that same identity (spoolerSync.js:200-206); claim pulls only `agent_id IS NULL`. Recovery = manual force-replace → dead_letter. No timer, no alert.
4. **Interrupted update can disable the service with zero remote signal.** Update-Spooler.ps1:401 writes the `prepared` journal (containing the NEW repair script's sha256, computed from $PSScriptRoot) before line 403 refreshes on-disk recovery scripts. Power loss in that window → old Repair-SpoolerStartup.ps1 hash-mismatches the journal → catch disables the service and keeps the journal → all future updates blocked (`blocked_recovery_required`) → only evidence is a local log. Install-Spooler.ps1:193 orders these correctly; the updater does not.
5. **Drain is one-way with an uninformative confirm and undocumented recovery** (bit the owner live 2026-08-19). draining → decommissioned auto-transition (spoolerSync.js:168-189); no reactivate endpoint exists; agent treats decommissioned as PAUSED and polls forever, never re-registering. Recovery (rotate agent.json, restart service) exists only in code knowledge — docs/printing-runbook.md never mentions it. UI guard is a generic `window.confirm` (Settings.vue:1394-1396).

## HIGH

- **No retry cap anywhere** — `attempts` only clamps the backoff delay (v2/printer-workers.js:65-67). Dead-forever printer or chronically-timing-out render retries forever; the render queue is a single global serial pipeline, so one 30s-timeout job periodically starves rendering for the whole fleet.
- **`WINSPOOL_OPEN_FAILED` → terminal `uncertain`, no retry** — fires before any byte could move, yet the blanket default (v2/printer-transports.js:278-281) classifies helper errors without failureClass as uncertain. A merely-unreachable Windows printer permanently kills jobs; inverse of CRIT-2 on the same path.
- **No jitter on sync failure backoff** — fixed [2000,5000,10000] (v2/agent-runtime.js:1); startup jitter applied once, never per-retry. Fleet-synchronized retry bursts are the Imunify360 incident class, much milder over short-poll HTTP but unguarded.
- **Legacy daemon reinstall path undocumented** — Install-Spooler.ps1:221 skips NSSM config for legacy-owned services, then polls 45s for a registration that can never happen and fails with a generic message. Fix (Remove-SpoolerRuntime.ps1 first) documented nowhere.
- **Crash-looping agent indistinguishable from powered-off machine remotely** — no explicit NSSM AppExit/AppThrottle config, no event that reaches the admin UI; also stale-station visibility exists only inside Settings → Print Queue while the tab is open and visible (Settings.vue:1030-1036). DPAPI identity corruption (AGENT_IDENTITY_INVALID, permanent) is one of these indistinguishable crash-loops.

## MEDIUM

- Advertised sync `capacity` is advisory only; agent accepts everything the server sends, unbounded local queue growth possible (v2/agent-runtime.js:98-125) — amplifies CRIT-1 via disk.
- Chrome relaunch has no circuit breaker (v2/artifact-renderer.js:386-406); broken install = unbounded launch attempts, indistinguishable in health data from a printer problem.
- Blanket pre-write helper failures burn terminal `uncertain` slots for zero-risk conditions (stage-aware refinement would cut operator noise).
- Vestigial `processing`/`failed` print_queue states: zero writers in production code, still read in claim/watchdog queries.

## LOW / informational

- Watchdog logs a count-signature diff once and goes quiet; catches nothing actionable (backend/services/printQueueWatchdog.js:41-50).
- Customer receipt enqueue is a post-checkout client POST — sale can commit with no print job ever created, toast-only signal; kitchen dispatch by contrast is in-transaction (HeldOrderKitchenDispatch.js:333/463). Likely deliberate fail-open; asymmetry worth an owner decision.
- Retry pacing/archive retention are local-clock-only but nothing correctness-bearing depends on clock agreement (verified).

## Verified strong (adversarially, with citations in the four agent reports)

- Accept-then-settle two-phase protocol; fsync+atomic-rename journal writes; corrupt records quarantined not dropped.
- `transport_started` persisted before first byte on both transports; restart mid-print → terminal `uncertain`, never auto-retried → duplicate paper impossible.
- Settle idempotent and validated against the syncing agent's own identity; dead-lettered rows cannot be resurrected by a stale agent; reprint creates a new audited row.
- One-active-agent-per-station enforced by generated-column UNIQUE key at DB level; consistent station→agent lock order, no deadlock window.
- Per-printer lanes strictly serialized; offline printer blocks only its own lane; retry state survives restart via persisted next_retry_at.
- dead_letter → Socket.IO badge chain fully live end-to-end (spoolerV2.js:127-128 → AdminHeader.vue badge).
- Update/repair transactions hash-verified, fail-closed, reparse-safe; all pre-commit phases roll back cleanly (except CRIT-4's window).
- State-root lock stale-safe against hard kills (kill-tested).

## Priority order if fixed

1. CRIT-1 (one guard, hottest path) → 2. CRIT-4 (swap two lines in Update-Spooler.ps1) → 3. CRIT-5 (honest confirm text + runbook section; endpoint later) → 4. CRIT-3 (implement lease reclaim into `pending` for pre-transport states only — jobs past `sent` must reclaim to dead_letter, not retry) → 5. CRIT-2 (poll windowsJobId until spooler queue drains, or downgrade to a non-terminal `spooled` state) → 6. HIGHs (retry cap + open-failed reclass + jitter are each small).

No fixes were made in this audit; branch untouched.
