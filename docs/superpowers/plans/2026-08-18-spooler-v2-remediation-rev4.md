# Spooler V2 Remediation Rev 4 Implementation Plan

> **For agentic workers:** Use `executing-plans` and implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work in the available checkout; an isolated worktree is not required.

**Goal:** Close the independently reproduced rev-3 liveness, ownership-recovery, single-instance, cancellation, and error-classification gaps without redesigning Spooler V2 or weakening its no-duplicate-paper boundary.

**Architecture:** Keep the existing server-mediated V2 protocol, durable local journal, per-printer workers, and V1/V2 transition model. Make four narrow corrections: move fallible artifact preparation outside the helper-global lane while keeping the durable transport marker at the byte boundary; make the existing Windows kernel mutex authorize stale Node-lock recovery; journal installer ownership changes using the updater's existing transaction system; and connect the existing cancellation service to the existing admin print-queue surface.

**Tech stack:** Node.js, Express, Vue 3, Vitest, PowerShell, C# Windows helper, MySQL/MariaDB.

## Execution guide

Use this section to stay aligned with the existing branch while making reasonable implementation decisions from current code evidence.

### Starting context

- Repository: `C:\xampp\htdocs\posapp`
- Intended branch: `codex/spooler-v2-local-print-agent-continued`
- Implementation reference point: `f5321e2afb3c16a740315e613e82827db88907aa`
- Plan: `docs/superpowers/plans/2026-08-18-spooler-v2-remediation-rev4.md`

- [ ] **Preflight 1 — Read authority files completely**

Read, in this order:

```text
CLAUDE.md
docs/architecture.json
docs/superpowers/evidence/2026-08-18-spooler-v2-remediation-rev3-adversarial-review.md
docs/superpowers/plans/2026-08-18-spooler-v2-remediation-rev4.md
```

- [ ] **Preflight 2 — Verify Git identity without cleaning anything**

Run:

```powershell
Set-Location 'C:\xampp\htdocs\posapp'
git branch --show-current
git rev-parse HEAD
git status --short
```

The expected branch is `codex/spooler-v2-local-print-agent-continued`. If the plan is available at HEAD `f5321e2a`, at the plan-only descendant, or after one or more completed task commits, continue from the first incomplete task. The reference hash is for reviewing the eventual implementation diff, not a reason to stop execution.

The repository contains pre-existing untracked evidence and plan documents. They belong to the user. Do not delete, move, stage, commit, rename, or rewrite any of them except this Rev 4 plan if the user separately authorizes a plan correction. Never run `git clean`, `git reset --hard`, or `git checkout --`.

Inspect `git log --oneline --decorate -12` and current changes to understand what has already been completed. Do not reset or rewrite history merely to reproduce an exact starting hash. If task commits already exist, verify their files and tests, then continue from the first incomplete task rather than repeating work.

- [ ] **Preflight 3 — Inspect overlapping work before editing**

Run `git status --short` and inspect any existing change that overlaps the next task. Preserve unrelated work and incorporate legitimate partial task work where possible. Stop only when an overlapping user change creates a real conflict that cannot be resolved safely. Unrelated untracked documents are never a blocker and must remain untouched.

### Core execution rules

1. Execute Tasks 1–4 in order and verify each task before moving forward.
2. Create one focused commit per task using the listed commit message. Do not merge, push, deploy, tag, or bump versions.
3. RED is mandatory. Add the focused test first, run it, and record the exact failing assertion. A syntax error, missing fixture, or broken import is not valid RED evidence.
4. GREEN is mandatory. Run the exact focused commands after implementation. Do not claim a pass from inspection.
5. Never change a test merely to match incorrect production behavior. Assertions must encode the invariants stated here.
6. Do not add a dependency, environment variable, database migration, table, status enum, service, scheduled task name, queue, page, or second recovery system. The defined `mode: 'Install'` extension belongs in the existing journal.
7. Reuse existing helpers and surfaces. No new abstraction layer, transport framework, lock library, retry framework, or cancellation page.
8. Do not alter V1 delivery behavior except where Task 3 must preserve protocol ownership during interrupted V2 installation.
9. Do not touch production databases, Hostinger, customer machines, installer outputs, packaged artifacts, or release manifests.
10. Never expose or copy `SPOOLER_KEY`, database credentials, environment contents, agent secrets, or payload bodies into tests, logs, evidence, or commits.
11. A failure after transport may have started remains `uncertain`; it must never become automatically retryable. A failure proven before transport remains `transient_safe` or `permanent_safe` as specified.
12. Do not add a finite retry cap for offline printers. Only deterministic invalid document construction becomes permanent.
13. Do not use `Promise.race` as proof that synchronous journal `fsyncSync` is bounded or cancellable.
14. Do not declare the branch deployable or canary-ready. Physical printer and interrupted-Windows gates remain open after automated completion.

### Decision latitude

Follow the interfaces and outcomes below, but adapt local variable names, fixture setup, and the smallest supporting code to the source actually present. If evidence shows a listed internal signature cannot fit the current implementation safely, make the smallest equivalent adjustment, prove the same invariant with tests, and record the deviation in the verification report. Stop only for a genuine contradiction that would require redesigning the architecture or weakening the no-duplicate-paper invariant.

### Required interfaces

These contracts must exist when their owning task finishes:

```text
verifyArtifactHash(artifact, { timeoutMs })
  resolves only after the full file hash matches
  rejects ARTIFACT_READ_TIMEOUT / transient_safe after destroying the stream
  rejects ARTIFACT_HASH_MISMATCH / permanent_safe on mismatch

platformHelper.request(command, payload, { beforeWrite } = {})
  runs inside the caller-owned helper.runExclusive turn
  awaits beforeWrite immediately before child.stdin.write
  never calls beforeWrite when the captured helper child is not ready

acquireStateRootLock({ stateRoot, staleReclaimAuthorized = false })
  rejects STATE_ROOT_LOCKED for a live owner
  rejects STATE_ROOT_LOCKED for a stale owner without authorization
  reclaims a stale owner only after helper kernel-mutex arbitration

POST /api/admin/print-queue/:queueId/cancel
  pending -> HTTP 200 { success: true, queue_id, outcome: 'canceled' }
  sent | local_accepted -> HTTP 200 { success: true, queue_id, outcome: 'cancel_requested' }
  missing -> HTTP 404 { success: false, code: 'PRINT_JOB_NOT_FOUND' }
  any other status -> HTTP 409 { success: false, code: 'PRINT_JOB_NOT_CANCELABLE' }
```

The install journal extension is exactly:

```text
mode: Install
phases: install_prepared | install_v2_active | install_v2_registered | install_committed
required ownership fields:
  programFilesRoot
  serviceExisted
  previousScript
  targetScript
  originalServiceStartupMode
  spoolerId
  envPath
  envLength
  envSha256
  recoveryScripts
```

No synonymous field, extra phase, or second journal path is allowed.

---

## Scope and verified disposition

The following findings from `docs/superpowers/evidence/2026-08-18-spooler-v2-remediation-rev3-adversarial-review.md` were independently reproduced or confirmed from the active code and are in scope:

- **T1:** an unbounded artifact read occurs inside the helper-global serialized lane. A hung first read prevented a second Windows job from reaching its marker.
- **I1:** the installer's ambiguous-recovery branch stops the service before disabling automatic startup.
- **I2 / I4:** `Install-Spooler.ps1` neither journals its ownership transition nor takes the shared updater transaction mutex.
- **I3:** startup repair treats an already-accepted V2 cutover as rollbackable, stops it, receives the expected rollback rejection, and can repeat that failure.
- **R1:** stale Node lock removal is racy. The existing helper kernel mutex masks the race today, but the documented Node-only guarantee is false.
- **T2:** helper death after the readiness check but before command submission currently leaves a durable marker and returns `uncertain`, even though no helper command was written.
- **S1:** `requestPrintJobCancellation` has tests but no production route or UI caller.
- **A1:** a synchronous document-construction exception has no stable code/class and enters the transient retry loop.
- The C# watch generation stop flag can be reset while an older watcher is still exiting.
- The `status_disabled` branch is unreachable for the deliberately non-terminal unsupported/garbage status responses.
- Some tests bypass production `runExclusive` behavior or use a weaker fake-store terminal guard.

Three recommendations in the review must **not** be copied literally:

1. Do not reclaim a stale lock with `rename(old, retired)` alone. Two contenders can still rename each other's newly created lock. Use the helper's existing kernel mutex as the one startup arbiter, then hand ownership to the Node PID lock.
2. Do not add a global render-attempt cap. A genuinely offline printer must remain retryable. Classify deterministic document-input failures as permanent instead.
3. Do not change a post-marker helper error to `transient_safe`. Move the marker into a helper `beforeWrite` callback so it is absent before command bytes and present after them.

Verified exclusions:

- No migration or schema-authority change is needed.
- The unrelated `tables.test.js` full-suite race is not part of this spooler remediation; if it appears, record it and rerun that file in isolation without hiding the full-suite result.
- V1/V2 sharing the artifact root is not a demonstrated corruption path.
- The decommissioned-agent health write is stale but inert in the same transaction; do not widen this plan for it unless a focused RED test proves an externally visible mutation.
- Automated checks cannot close physical Windows/printer gates. The affected long-report printer, direct TCP, Windows share, write-only clone, paper-out, DPAPI two-machine, disk-full, and interrupted Windows installation gates remain explicit release blockers.

## Global constraints

- Preserve the durable rule: before transport starts, failures are safe to retry; after transport may have started, failures are uncertain and must not auto-print again.
- Never let status probing, hashing, rendering, or cleanup monopolize the helper-global print lane.
- Never use `Promise.race` to claim a synchronous `fsyncSync` journal write is interruptible.
- Reuse the existing transaction journal path and PowerShell helpers. Do not create a second recovery system.
- Preserve V1 delivery until the separately approved retirement milestone.
- Use focused RED/GREEN tests for each task. Run the complete spooler suite only in Task 4.
- Do not change versions, installers' public branding, dependencies, environment variables, database data, or deployment configuration.

## Task 1: Make the Windows transport lane bounded and truthful

**Files:**

- Modify: `pos-spooler-printer/v2/printer-transports.js`
- Modify: `pos-spooler-printer/v2/platform-helper.js`
- Modify: `pos-spooler-printer/v2/artifact-renderer.js`
- Modify: `pos-spooler-printer/v2/status-monitor.js`
- Modify: `pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`
- Modify: `pos-spooler-printer/tests/v2-printer-transports.test.js`
- Modify: `pos-spooler-printer/tests/v2-platform-helper.test.js`
- Modify: `pos-spooler-printer/tests/v2-artifact-renderer.test.js`
- Modify: `pos-spooler-printer/tests/v2-status-monitor.test.js`
- Modify: `pos-spooler-printer/tests/v2-printer-workers.test.js`

### 1.1 Write the RED tests

- [ ] **Step 1.1 — Add every Task 1 regression test before editing production code**

Add focused tests for these exact sequences:

1. A first Windows artifact stream never produces data; a second Windows job can still enter the helper lane. Destroying the first stream at its deadline must yield `ARTIFACT_READ_TIMEOUT` / `transient_safe` and leave no transport marker.
2. The helper is ready when a Windows send begins but exits before command submission. The helper must reject before calling `beforeWrite`; no marker exists and the result is `transient_safe`.
3. `beforeWrite` succeeds and command bytes are written, then the helper fails. The marker exists and the result is `uncertain`.
4. Two Windows sends use the real production `runExclusive`; only the request whose command reaches the byte boundary is marked.
5. `htmlForJob(job)` throws synchronously. The renderer returns a stable `ARTIFACT_DOCUMENT_INVALID` / `permanent_safe` failure.
6. A slow old watch generation cannot continue after a newer generation starts.
7. An invalid/unsupported status response is retried on a later polling cycle; it is not latched into a permanent `status_disabled` state.

Run:

- [ ] **Step 1.2 — Run each new regression test and preserve valid RED evidence**

```powershell
node pos-spooler-printer/tests/v2-printer-transports.test.js
node pos-spooler-printer/tests/v2-platform-helper.test.js
node pos-spooler-printer/tests/v2-artifact-renderer.test.js
node pos-spooler-printer/tests/v2-status-monitor.test.js
node pos-spooler-printer/tests/v2-printer-workers.test.js
```

Expected RED evidence: at least the hung-read, pre-write marker, deterministic-render classification, and watch-generation assertions fail for the current implementation. Do not substitute inspection for a RED run.

### 1.2 Implement the minimal boundaries

- [ ] **Step 1.3 — Implement only the Task 1 interfaces and classifications**

- Hoist Node artifact verification out of `helper.runExclusive`. Give the stream read a real deadline that destroys the stream on timeout. Return `ARTIFACT_READ_TIMEOUT` with `failureClass: 'transient_safe'`.
- Keep the C# helper's independent SHA-256 verification before `OpenPrinter`; the hoist must not remove final integrity checking.
- Extend the internal child request and public `platformHelper.request(command, payload, options)` with `options.beforeWrite`. The Windows transport must continue to call it from the existing `helper.runExclusive` turn; do not nest a second exclusive turn:
  1. enter the existing transport-owned exclusive turn;
  2. confirm the captured child is alive and ready;
  3. await `beforeWrite`;
  4. confirm the same child is still alive and ready;
  5. synchronously call `child.stdin.write` without another await in between.
- Pass `markTransportStarted` as `beforeWrite` for `print_raw`. Remove the earlier Windows marker call. Keep TCP's current marker-at-write boundary unchanged.
- If either readiness check fails before `stdin.write`, return `PLATFORM_HELPER_RESTARTING` / `transient_safe`. Once `stdin.write` is attempted, preserve the existing uncertain classification for timeout/exit.
- Catch only document creation/input errors around `htmlForJob(job)` and classify them `ARTIFACT_DOCUMENT_INVALID` / `permanent_safe`. Do not cap or terminalize genuine transient printer/network failures.
- Replace the C# static shared stop boolean with a monotonically increasing watch generation. Each thread captures its generation and exits when `Volatile.Read` no longer matches it. Increment on stop/restart; do not reset a shared flag for a newer watcher.
- Delete the unreachable `status_disabled` state and branch. Continue bounded polling after invalid or unsupported replies.
- Make test fakes enforce the production terminal-state guard and route Windows tests through the real `runExclusive` path.
- Replace the stale platform-helper assertion text `recycle the serial helper` with wording that names the behavior actually asserted; do not change the assertion just to preserve the old message.

### 1.3 Verify and commit

- [ ] **Step 1.4 — Run the focused GREEN and syntax gates**

Run the four focused spooler test files above. Do not run the complete spooler suite until Task 4.

```powershell
node --check pos-spooler-printer/v2-server.js
node --check pos-spooler-printer/v2/platform-helper.js
node --check pos-spooler-printer/v2/printer-transports.js
```

Commit only Task 1 files:

- [ ] **Step 1.5 — Review the scoped diff and create the Task 1 commit**

```powershell
git diff -- pos-spooler-printer/v2/printer-transports.js pos-spooler-printer/v2/platform-helper.js pos-spooler-printer/v2/artifact-renderer.js pos-spooler-printer/v2/status-monitor.js pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs pos-spooler-printer/tests/v2-printer-transports.test.js pos-spooler-printer/tests/v2-platform-helper.test.js pos-spooler-printer/tests/v2-artifact-renderer.test.js pos-spooler-printer/tests/v2-status-monitor.test.js pos-spooler-printer/tests/v2-printer-workers.test.js
git diff --check
git add pos-spooler-printer/v2/printer-transports.js pos-spooler-printer/v2/platform-helper.js pos-spooler-printer/v2/artifact-renderer.js pos-spooler-printer/v2/status-monitor.js pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs pos-spooler-printer/tests/v2-printer-transports.test.js pos-spooler-printer/tests/v2-platform-helper.test.js pos-spooler-printer/tests/v2-artifact-renderer.test.js pos-spooler-printer/tests/v2-status-monitor.test.js pos-spooler-printer/tests/v2-printer-workers.test.js
git commit -m "fix(spooler-v2): harden Windows transport boundaries"
git show --stat --oneline HEAD
```

**Task 1 gate:** the commit must contain only the listed files. All five focused test files and syntax checks must pass. Otherwise do not start Task 2.

## Task 2: Make single-instance startup ownership honest

**Files:**

- Modify: `pos-spooler-printer/v2/state-root-lock.js`
- Modify: `pos-spooler-printer/v2-server.js`
- Modify: `pos-spooler-printer/tests/v2-hostile-runtime.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`

### 2.1 Write the RED concurrency test

- [ ] **Step 2.1 — Add the controlled two-contender startup regression before production edits**

Add a two-process/barrier test around one stale state-root lock:

- Both processes observe the same stale PID state.
- Only the process holding the existing Windows helper kernel mutex may authorize stale-lock reclamation.
- Exactly one process acquires the Node lock and proceeds to identity/journal open.
- The loser exits before opening or mutating the journal.
- If the helper later dies, the live Node PID lock still prevents a replacement process from opening the journal.

Also assert that calling stale reclaim without explicit startup-arbiter authorization fails closed.

Run:

```powershell
node pos-spooler-printer/tests/v2-hostile-runtime.test.js
```

Expected RED evidence: the current read-unlink-create implementation permits both stale-reclaim contenders in the controlled interleaving or lacks the required authorization boundary.

### 2.2 Implement the two-stage handoff

- [ ] **Step 2.2 — Implement helper arbitration followed by Node lock ownership**

- Keep the existing Windows helper global mutex; do not invent another lock protocol.
- Reorder V2 startup:
  1. start and await helper readiness/mutex ownership;
  2. call `acquireStateRootLock({ stateRoot, staleReclaimAuthorized: true })`;
  3. load/create agent identity;
  4. open the durable job store;
  5. start workers and sync.
- In `state-root-lock.js`, require `staleReclaimAuthorized === true` before removing a stale existing lock. A live PID always fails closed. A stale lock without authorization also fails closed.
- Keep the Node lock for the full agent lifetime. Helper exit must not release it.
- Update architecture text to describe the real handoff: helper kernel mutex serializes startup/stale recovery; the Node PID lock owns the state root after startup. Remove any claim that Node lock acquisition precedes helper arbitration.

This plan intentionally targets the current mandatory-helper Windows agent. Do not add a speculative helper-less TCP startup mode.

### 2.3 Verify and commit

- [ ] **Step 2.3 — Run focused GREEN, regenerate architecture HTML, and commit**

```powershell
node pos-spooler-printer/tests/v2-hostile-runtime.test.js
node pos-spooler-printer/tests/v2-platform-helper.test.js
npm run architecture
npm run architecture:check
git diff -- pos-spooler-printer/v2/state-root-lock.js pos-spooler-printer/v2-server.js pos-spooler-printer/tests/v2-hostile-runtime.test.js docs/architecture.json docs/architecture.html
git diff --check
git add pos-spooler-printer/v2/state-root-lock.js pos-spooler-printer/v2-server.js pos-spooler-printer/tests/v2-hostile-runtime.test.js docs/architecture.json docs/architecture.html
git commit -m "fix(spooler-v2): serialize state-root ownership"
git show --stat --oneline HEAD
```

**Task 2 gate:** exactly one contender reaches identity/journal open, architecture check passes, and the commit contains only the five listed paths. Otherwise do not start Task 3.

## Task 3: Make install and reboot recovery converge to one protocol

**Files:**

- Modify: `deployment/windows/Install-Spooler.ps1`
- Modify: `deployment/windows/Repair-SpoolerStartup.ps1`
- Modify: `deployment/windows/SpoolerLayerState.ps1`
- Modify: `deployment/windows/Update-Spooler.ps1`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

### 3.1 Write RED structural and state-machine tests

- [ ] **Step 3.1 — Add installer interruption and accepted-V2 recovery tests before script edits**

Add tests for:

1. Ambiguous install recovery orders `Set-Service -StartupType Disabled` before `Stop-Service`, before the terminal throw. Scope the assertion to the exact ambiguous-recovery block; do not use a file-wide `IndexOf` that can match another stop call.
2. Install takes `Enter-SpoolerUpdateTransaction` before the first mutable service/application action and releases it in an outer `finally`.
3. A fresh install durably installs/registers startup repair before writing the install journal; install then writes the existing transaction journal before service entrypoint/startup mutation and advances through the defined install phases.
4. Power loss at each install phase leads on repair to exactly one of: authoritative V1 service, authoritative accepted V2 service, or disabled service with the journal retained. It must never guess a protocol.
5. A journal at `v2_application_active` or `v2_registered` with authoritative matching `agent_id`, station protocol `v2`, and `first_v2_accepted_at` set preserves V2, starts/verifies it, and finalizes the journal instead of calling rollback.
6. The same phases without accepted work use the existing rollback path.
7. If authority is unavailable or mismatched, repair disables startup before stopping and retains the journal.

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js
```

Expected RED evidence: Install currently has no mutex/journal lifecycle, the ambiguous branch has the unsafe order, and repair lacks the accepted-V2 convergence branch.

### 3.2 Reuse the existing transaction journal

- [ ] **Step 3.2 — Implement the single journaled ownership state machine**

- Move the existing `Install-SpoolerRecoveryScripts` body from `Update-Spooler.ps1` into `SpoolerLayerState.ps1` with the exact signature `Install-SpoolerRecoveryScripts([string]$SourceRoot, [string]$ProgramFilesRoot, [string[]]$Names)`. Make both installer and updater call that shared function. Do not leave a second local implementation.
- Acquire the shared update transaction mutex before Install's first mutable step; release it only from an outer `finally`.
- Before writing the install journal, atomically install the existing recovery-script set and register the existing startup-repair task. This must happen while the current service ownership is still unchanged. A crash before the journal therefore leaves the previous service untouched; a crash after the journal has a durable repair entrypoint, including on a fresh station.
- Use the existing journal path and atomic `Write-SpoolerTransactionJournal`. Add `mode: 'Install'` to the existing validator—do not create a second journal. Split `Assert-SpoolerJournalSafety` after its common format/id/mode checks: validate the exact Install fields/phases above and return; preserve every existing Core/RuntimeTransition validation unchanged.
- Store only recovery facts required for ownership:
  - `format`, `transactionId`, `mode`, `phase`;
  - `serviceExisted`, `previousScript` (`server.js`, `v2-server.js`, or null), `targetScript`;
  - `originalServiceStartupMode`, `spoolerId`, the validated durable `envPath`, and the existing validated `recoveryScripts` entries.
- Use four install phases: `install_prepared` before entrypoint/startup mutation, `install_v2_active`, `install_v2_registered`, and `install_committed`.
- Validate script names with a fixed whitelist and validate all paths under the existing install/program-data roots.
- For ambiguous recovery, disable automatic startup first, then stop/wait, retain the journal, and emit an explicit recovery failure.
- Implement the Install journal recovery matrix exactly:

| Phase | Authoritative state | Required recovery |
|---|---|---|
| `install_prepared` | V2 was not accepted | Existing service: restore `previousScript` and recorded startup mode. Fresh service: remove only a partially created service. Remove journal only after the resulting V1/absent state is verified. |
| `install_v2_active` or `install_v2_registered` | Matching local `agent_id`, protocol `v2`, and `first_v2_accepted_at` set | Preserve/select `v2-server.js`, restore recorded startup mode, start service, and verify the same agent syncs before committing/cleaning the journal. Never call abort or rollback. |
| `install_v2_active` or `install_v2_registered` | Protocol confirmed `v1` and no accepted V2 work | Restore `previousScript` for an existing service or remove the fresh failed service; restore recorded startup mode only for an existing service; then remove the journal. |
| Any non-committed phase | Status unavailable, contradictory, or agent mismatch | Set StartupType Disabled, then stop/wait, retain the journal, and fail explicitly. Do not guess. |
| `install_committed` | Target entrypoint and service health verified | Restore recorded startup mode if required, remove recovery artifacts, then remove the journal. |

- In startup repair, inspect the local durable `agent.json` and authoritative `/api/spooler/v2/status` before stopping both updater phases (`v2_application_active`, `v2_registered`) and installer phases (`install_v2_active`, `install_v2_registered`):
  - matching accepted V2: capture `recoveryStartUtc`, preserve/select `v2-server.js`, restore the recorded startup mode, start it, poll status every 750 ms for at most 45 seconds, and require protocol `v2`, the same local `agent_id`, non-null `first_v2_accepted_at`, and `last_sync_at >= recoveryStartUtc`; only then advance to committed and remove rollback artifacts/journal;
  - confirmed unaccepted V1/transition: use the existing abort/rollback and restore the recorded previous script;
  - unreachable, contradictory, or mismatched authority: disable before stop and retain the journal.
- A fresh install has `previousScript: null`; never invent `server.js` as its rollback target.
- Keep this journal scoped to service/protocol ownership. Do not add a speculative full payload rollback mechanism in this task.

### 3.3 Verify and commit

- [ ] **Step 3.3 — Run installer GREEN gates, parse the PowerShell scripts, and commit**

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
npm run test:installer
@('deployment/windows/Install-Spooler.ps1','deployment/windows/Repair-SpoolerStartup.ps1','deployment/windows/SpoolerLayerState.ps1','deployment/windows/Update-Spooler.ps1') | ForEach-Object { [void][ScriptBlock]::Create((Get-Content $_ -Raw)) }
git diff -- deployment/windows/Install-Spooler.ps1 deployment/windows/Repair-SpoolerStartup.ps1 deployment/windows/SpoolerLayerState.ps1 deployment/windows/Update-Spooler.ps1 backend/tests/unit/installerUpdateContract.test.js
git diff --check
git add deployment/windows/Install-Spooler.ps1 deployment/windows/Repair-SpoolerStartup.ps1 deployment/windows/SpoolerLayerState.ps1 deployment/windows/Update-Spooler.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "fix(installer): journal spooler ownership transitions"
git show --stat --oneline HEAD
```

**Task 3 gate:** PowerShell parsing, focused tests, and `test:installer` pass; every simulated interruption ends in authoritative V1, authoritative accepted V2, or disabled-with-journal. Otherwise do not start Task 4.

## Task 4: Expose audited cancellation and close the automated gate

**Files:**

- Modify: `backend/routes/admin/printQueue.js`
- Read but do not modify: `backend/services/spoolerSync.js` (reuse `requestPrintJobCancellation` unchanged)
- Add: `backend/tests/integration/printQueueCancellation.test.js`
- Modify: `src/admin/pages/Settings.vue`
- Modify: `src/admin/pages/__tests__/spoolerV2Settings.spec.js`
- Modify: `src/shared/i18n/ar.json`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Add: `docs/superpowers/evidence/2026-08-18-spooler-v2-remediation-rev4-verification.md`

### 4.1 Write RED route and UI tests

- [ ] **Step 4.1 — Add backend and UI cancellation regressions before production edits**

Backend integration cases:

- `POST /api/admin/print-queue/:queueId/cancel` requires admin authentication.
- Lock the queue row and call `requestPrintJobCancellation` in the same transaction.
- `pending` becomes terminal `canceled`; `sent` or `local_accepted` becomes `cancel_requested` for agent confirmation.
- Terminal/not-found jobs return stable non-500 codes and do not add duplicate audit rows.
- The audit event is committed atomically with the transition and includes queue id, old status, new status, user id, and no secrets/payload body.
- The response says `canceled` only for a durable pre-transport cancellation; otherwise it says `cancel_requested`.

UI source tests:

- The existing Print Queue settings table shows Cancel only for `pending`, `sent`, or `local_accepted` jobs.
- The action requires confirmation, disables while pending, calls the route, and refreshes queue health.
- Copy distinguishes “canceled” from “cancellation requested”; it never promises that paper already in transport was stopped.
- English source strings and natural Arabic catalog entries exist. Do not create a new page or modal workflow.

Run:

```powershell
npx vitest run backend/tests/integration/printQueueCancellation.test.js src/admin/pages/__tests__/spoolerV2Settings.spec.js
```

### 4.2 Implement the narrow vertical slice

- [ ] **Step 4.2 — Implement the existing-service-to-existing-UI cancellation path**

- Add the cancel route alongside the existing health/reprint routes.
- Start a DB transaction, select the row `FOR UPDATE`, reject missing with `PRINT_JOB_NOT_FOUND`, reject any status outside `pending`, `sent`, and `local_accepted` with `PRINT_JOB_NOT_CANCELABLE`, call the unchanged cancellation service with that connection, insert `spooler_print_job_cancellation_requested` or `spooler_print_job_canceled` into `audit_events`, commit, and return the exact HTTP contract above.
- Preserve the existing agent confirmation channel and terminal-state barriers; do not directly force a locally accepted job to `canceled`.
- Add a compact Cancel button beside Reprint in the existing actions cell with a single confirmation prompt and the same error handling pattern as reprint.
- Leave the stale but inert decommission health write unchanged; it is outside this remediation because no externally visible mutation was reproduced.
- Update architecture with the admin cancellation path and the corrected transport/startup/install boundaries from Tasks 1–3. Regenerate HTML.

### 4.3 Run the final hostile checks

- [ ] **Step 4.3 — Replay every hostile sequence listed below**

Before the full suite, replay these focused attacks:

- hung artifact A while Windows artifact B reaches its helper turn;
- helper death immediately before and after `beforeWrite`;
- two stale-lock contenders and helper-death handoff;
- power loss at every install journal phase;
- ordinary reboot after first accepted V2 job;
- cancellation before claim, after server send, after local accept, and after transport marker;
- slow old watch generation followed by a new watch;
- deterministic bad document versus genuinely offline printer.

Then run:

- [ ] **Step 4.4 — Run focused gates, then the complete automated gate exactly once**

```powershell
npm --prefix pos-spooler-printer test
npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/unit/installerUpdateContract.test.js src/admin/pages/__tests__/spoolerV2Settings.spec.js
npm run architecture
npm run architecture:check
npm run build:admin
npm run test:unit
git diff --check
```

Run `npm run test:unit` once and record its exact result. If the known unrelated tables race appears, keep the full failure in the report and run only that failing file separately to distinguish isolation from pollution. Do not describe the full suite as green unless it is green.

The verification report must list:

- [ ] **Step 4.5 — Write the evidence report without converting open hardware gates into passes**

- each reproduced RED and corresponding GREEN;
- exact commands and counts;
- any unrelated failure without waiver language;
- all still-open physical gates;
- a clear statement that automated completion does **not** authorize canary rollout.

Commit Task 4 only after focused and final checks:

- [ ] **Step 4.6 — Review the full branch scope and create the Task 4 commit**

```powershell
git diff -- backend/routes/admin/printQueue.js backend/tests/integration/printQueueCancellation.test.js src/admin/pages/Settings.vue src/admin/pages/__tests__/spoolerV2Settings.spec.js src/shared/i18n/ar.json docs/architecture.json docs/architecture.html docs/superpowers/evidence/2026-08-18-spooler-v2-remediation-rev4-verification.md
git diff --check
git add backend/routes/admin/printQueue.js backend/tests/integration/printQueueCancellation.test.js src/admin/pages/Settings.vue src/admin/pages/__tests__/spoolerV2Settings.spec.js src/shared/i18n/ar.json docs/architecture.json docs/architecture.html docs/superpowers/evidence/2026-08-18-spooler-v2-remediation-rev4-verification.md
git commit -m "fix(spooler-v2): expose audited print cancellation"
git show --stat --oneline HEAD
```

**Task 4 gate:** cancellation behavior and audit atomicity pass, complete automated results are recorded truthfully, architecture/build checks pass, and the commit contains only listed paths.

## Mandatory postflight

- [ ] **Postflight 1 — Verify the four task commits**

Run:

```powershell
git log --oneline --decorate -8
git log --format='%s' f5321e2afb3c16a740315e613e82827db88907aa..HEAD
```

The task commit subjects must appear once each and in this order:

```text
fix(spooler-v2): harden Windows transport boundaries
fix(spooler-v2): serialize state-root ownership
fix(installer): journal spooler ownership transitions
fix(spooler-v2): expose audited print cancellation
```

Do not create an empty commit for a task. Do not include the pre-existing untracked plans/evidence in any task commit.

- [ ] **Postflight 2 — Verify branch file scope**

Run:

```powershell
git diff --name-only f5321e2afb3c16a740315e613e82827db88907aa..HEAD
git status --short
```

Every tracked path must be one explicitly listed under Tasks 1–4. The original untracked documents must still be untracked and untouched. The Rev 4 plan may remain untracked because plan creation is not one of the implementation commits.

- [ ] **Postflight 3 — Report without taking release actions**

Report exactly:

1. branch and final HEAD;
2. four commit hashes and subjects;
3. per task: RED command plus failing assertion, GREEN commands plus pass counts;
4. complete spooler/unit/build/architecture results, including any unrelated failure;
5. all changed files;
6. all remaining physical/interrupted-Windows gates;
7. explicit confirmation: no merge, push, deploy, migration execution, installer build, version bump, Hostinger change, or customer canary.

Stop after reporting. Do not offer or perform integration automatically.

## Definition of done

- T1, T2, A1, R1, I1–I4, S1, and the watch-generation leak have direct RED/GREEN proof.
- No pre-transport failure leaves a marker; no post-write failure becomes auto-retryable.
- A hung artifact read cannot block another Windows printer's helper turn.
- A real offline printer remains retryable; only deterministic invalid document input becomes permanent.
- Exactly one V2 process can open the state root, including concurrent stale recovery.
- Every installer/reboot interruption converges to authoritative V1, authoritative accepted V2, or disabled-with-journal; never a guessed protocol.
- Cancellation is reachable, authenticated, audited, and honest about requested versus completed state.
- Architecture JSON/HTML agree with code.
- No schema migration, dependency, version bump, deploy, merge, push, or customer enablement occurred.
- Physical-printer and interrupted-Windows gates remain open until performed on the named hardware matrix.
