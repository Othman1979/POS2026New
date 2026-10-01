# Spooler V2 Rev 5.2 Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the confirmed Rev 5.2 availability, lost-ticket, transport-isolation, health, configuration, and evidence gaps without redesigning the V2 protocol or disturbing fielded V1 stations.

**Architecture:** Keep the existing HTTP sync protocol, journal, per-printer workers, persistent helper, and staged V1/V2 rollout. Repair ownership state through the helper-authorized startup boundary, deliver already-owned work while draining, make Windows helper work concurrent across printer lanes with bounded per-request retirement, and stop legacy health polling from owning V2 facts.

**Tech Stack:** Node.js CommonJS, Express, MySQL/MariaDB, Vitest, PowerShell, C#/.NET Framework Winspool helper.

## Global Constraints

- Work on the current `codex/spooler-v2-local-print-agent-continued` branch. Do not reset, clean, checkout, rebase, or discard existing working-tree changes.
- Read `CLAUDE.md`, `docs/architecture.json`, and `docs/superpowers/evidence/2026-08-18-spooler-v2-rev52-working-tree-audit.md` before editing.
- Do not add dependencies, schema migrations, environment variables, versions, installer builds, deployments, Hostinger changes, or customer-machine actions.
- Preserve V1 delivery and the intentional rule that V1 remains the installer default unless `/ENABLEV2=1` is explicitly supplied.
- Preserve the core paper invariant: pre-marker failure may retry; post-marker failure is uncertain and must never automatically print again.
- A helper timeout may attempt queue cleanup, but it must still report `uncertain`; deleting a Windows queue job cannot prove that paper did not print.
- Keep physical USB/shared/TCP/write-only/paper-out/long-report/DPAPI/disk-full/interrupted-Windows gates open. Automated tests cannot approve a customer canary.
- Use focused RED/GREEN tests per task. Run the complete spooler suite and one root Vitest pass only in Task 4.
- Commit once per task with the exact subjects below. Do not merge, push, deploy, or begin a canary.

## Verified Evidence and Disposition

| ID | Verified evidence | Required disposition |
|---|---|---|
| E1 | Empty/corrupt `agent.lock` remains `STATE_ROOT_LOCKED` forever; reproduced by the 7-case hostile harness | Task 1 |
| E2 | Corrupt shared reclaim tombstone remains forever; reproduced across three authorized starts | Task 1 |
| E3 | `sent` replay and `cancel_requested` delivery are inside `locked.status === 'active'`; draining can strand owned work | Task 2 |
| E4 | `worker.stop()` clears retry timers without clearing their `owned` IDs; restart did not resend | Task 2 |
| E5 | A throttled 200 response with `next_sync_ms: 5000` produced five syncs in about 212 ms | Task 2 |
| E6 | Journal `active` depth is overwritten by worker activity; `markRendered` can regress a post-marker row; renamed artifacts can become orphaned | Task 2 |
| E7 | One helper-global FIFO serializes all Windows printers; timeout kills the process while `AbortPrinter` exists only in the killed process | Task 3 |
| E8 | V1 status polling marks every printer without a V1 socket offline, including V2-owned printers | Task 4 |
| E9 | V2 starts helper/lock/identity before validating production URL/key | Task 4 |
| E10 | Architecture uses nonexistent `protocol_mode`, misstates cancellation, and has semantically stale line pins | Task 4 |

Explicitly excluded as disproved or intentional: TCP's separate connect/idle/stream deadlines, Puppeteer launch cleanup, and default-V1 installation. Do not change them.

---

### Task 1: Make State-Root Recovery Both Exclusive and Self-Healing

**Files:**
- Modify: `pos-spooler-printer/v2/state-root-lock.js`
- Modify: `pos-spooler-printer/v2-server.js` only if startup error reporting needs a stable recovery reason
- Modify: `pos-spooler-printer/tests/v2-hostile-runtime.test.js`
- Create: `pos-spooler-printer/tests/v2-state-root-lock.test.js`

**Interfaces:**
- Consumes: `acquireStateRootLock({ stateRoot, staleReclaimAuthorized })`
- Preserves: returned `{ release() }`
- Produces: stable reasons `corrupt_lock_quarantined` and `corrupt_tombstone_quarantined`; the current start always fails after quarantine and lets the next NSSM start acquire safely

- [ ] **Step 1: Add focused RED recovery tests**

Use real temporary directories and child processes. Pin these exact outcomes:

1. Normal lock publication exposes either no `agent.lock` or a complete valid JSON owner; never an empty/partial canonical lock.
2. Crash after writing the private owner file but before publication leaves only an inert private file; the next start removes it and acquires.
3. Empty, truncated, and schema-invalid `agent.lock`, with `staleReclaimAuthorized: true`, are atomically renamed to diagnostic files and the current call throws `STATE_ROOT_LOCKED` with reason `corrupt_lock_quarantined`; the next call acquires.
4. The same malformed lock with authorization false remains untouched and locked.
5. Empty, truncated, and schema-invalid deterministic stale tombstones are quarantined by one authorized caller; that caller fails, and the next authorized restart completes stale reclaim.
6. Four simultaneous authorized contenders around the quarantine/restart boundary produce at most one owner. No test may model a successful current call immediately after it quarantines ownership state.
7. A valid live owner or valid live claimant remains fail-closed and is never quarantined.

Run:

```powershell
node pos-spooler-printer/tests/v2-state-root-lock.test.js
node pos-spooler-printer/tests/v2-hostile-runtime.test.js
```

Expected RED: malformed state never recovers; canonical `agent.lock` still has a create-before-write window.

- [ ] **Step 2: Publish the canonical lock atomically**

Replace direct `openSync(lockPath, 'wx')` publication with complete-private-file then exclusive hard-link publication:

```js
function writeCompleteOwnerFile(target, owner) {
    const descriptor = fs.openSync(target, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

function publishOwnerFile(stateRoot, lockPath, owner) {
    const pendingPath = path.join(stateRoot, `agent.lock.pending-${owner.boot_id}`);
    try {
        writeCompleteOwnerFile(pendingPath, owner);
        fs.linkSync(pendingPath, lockPath); // EEXIST is the ownership decision.
    } finally {
        try { fs.unlinkSync(pendingPath); } catch {}
    }
}
```

Extend abandoned-private-file cleanup to both `agent.lock.claim-*` and `agent.lock.pending-*`. Preserve live private files; remove only unreadable or dead-owner private files.

- [ ] **Step 3: Quarantine malformed shared state without acquiring in the same call**

Add one helper that is called only after `staleReclaimAuthorized === true`:

```js
function quarantineCorruptState(target, owner, reason) {
    const diagnostic = `${target}.corrupt-${owner.boot_id}`;
    try {
        fs.renameSync(target, diagnostic);
    } catch {
        throw lockedError();
    }
    const error = lockedError();
    error.reason = reason;
    throw error; // Never acquire after repairing ownership state in this start.
}
```

Rules:

- Malformed canonical lock: unauthorized caller fails unchanged; authorized caller quarantines and exits.
- Malformed shared tombstone: unauthorized caller fails unchanged; authorized caller quarantines and exits.
- Valid live owner/claimant always fails unchanged.
- Valid dead claimant follows the existing interrupted-reclaim path.
- Do not automatically delete diagnostic `.corrupt-*` evidence. It is inert and does not participate in ownership.

- [ ] **Step 4: Run GREEN and concurrency repetition**

```powershell
node pos-spooler-printer/tests/v2-state-root-lock.test.js
1..25 | ForEach-Object { node pos-spooler-printer/tests/v2-hostile-runtime.test.js | Out-Null; if ($LASTEXITCODE -ne 0) { throw "hostile runtime failed on iteration $_" } }
node --check pos-spooler-printer/v2/state-root-lock.js
git diff --check
```

Expected: every recovery case heals on a later start; every concurrency repetition has exactly one owner; valid live ownership never moves.

- [ ] **Step 5: Commit**

```powershell
git add pos-spooler-printer/v2/state-root-lock.js pos-spooler-printer/v2-server.js pos-spooler-printer/tests/v2-state-root-lock.test.js pos-spooler-printer/tests/v2-hostile-runtime.test.js
git commit -m "fix(spooler-v2): make state-root recovery self-healing"
```

---

### Task 2: Finish Owned Work During Drain and Repair Local Runtime State

**Files:**
- Modify: `backend/services/spoolerSync.js`
- Modify: `backend/tests/integration/spoolerV2Sync.test.js`
- Modify: `pos-spooler-printer/v2/agent-runtime.js`
- Modify: `pos-spooler-printer/v2/printer-workers.js`
- Modify: `pos-spooler-printer/v2/job-store.js`
- Modify: `pos-spooler-printer/tests/v2-sync-runtime.test.js`
- Modify: `pos-spooler-printer/tests/v2-printer-workers.test.js`
- Modify: `pos-spooler-printer/tests/v2-job-store.test.js`

**Interfaces:**
- Preserves: `runAgentSync`, `createAgentRuntime`, `createPrinterWorkers`, and job-store public signatures
- Produces: draining agents receive owned replay/cancels but never new claims; throttled responses always control scheduling; worker restart cannot hide retryable rows

- [ ] **Step 1: Add RED server drain integration tests**

Add three real-DB cases:

1. Claim a job as `sent`, do not accept it, request drain, then sync with capacity 0. The same row must appear in `jobs`, `attempts` must remain unchanged, and a different pending row must not be claimed.
2. Put an owned row in `cancel_requested`, request drain, then sync. Its ID must appear in `cancel_requested`.
3. Accept and settle the replayed row, then report an empty journal. Only then may the agent become `decommissioned`.

Run:

```powershell
npx vitest run backend/tests/integration/spoolerV2Sync.test.js --reporter=verbose
```

Expected RED: the first two cases return neither replay nor cancellation.

- [ ] **Step 2: Split owned delivery from new intake**

In `runAgentSync`, use two explicit decisions:

```js
const mayDeliverOwned = ['active', 'draining'].includes(locked.status)
    && station.delivery_protocol === 'v2';
const mayClaimNew = locked.status === 'active'
    && station.delivery_protocol === 'v2';
```

- Under `mayDeliverOwned`, return `cancel_requested` and all owned `sent` replay rows.
- Calculate remaining capacity after replay.
- Query and mutate unowned `pending`/`failed` rows only under `mayClaimNew`.
- Do not increment attempts or refresh ownership for replay rows.
- Keep the unresolved-row decommission check unchanged; it must prevent decommission until replay/cancel work settles.

- [ ] **Step 3: Add RED runtime tests for stop/restart, throttling, and health truth**

Pin:

1. A `retry_wait` job survives `worker.stop(); worker.start(); worker.wake()` and sends again when its retry time arrives.
2. `response.throttled === true` schedules exactly `next_sync_ms`, even while accepted/results remain unconfirmed.
3. Non-throttled responses keep the existing immediate-sync behavior for durable accepts/results.
4. `health.local_queue_depth` is journal depth, while worker concurrency is reported separately as `worker_active`.
5. Drain completion requires journal depth zero, outbox zero, runnable zero, and `worker_active === 0`.
6. `markRendered` rejects `transport_started` and all terminal states without changing the record.
7. Cleanup removes an unreferenced `.bin` only after a one-hour grace period; referenced artifacts and recent files remain.

Run:

```powershell
node pos-spooler-printer/tests/v2-printer-workers.test.js
node pos-spooler-printer/tests/v2-sync-runtime.test.js
node pos-spooler-printer/tests/v2-job-store.test.js
```

- [ ] **Step 4: Implement the minimal runtime corrections**

In worker shutdown, clear ownership only after active lane/render work has reached idle:

```js
for (const timer of retryTimers) timers.clearTimeout(timer);
retryTimers.clear();
if (!isIdle()) await new Promise(resolve => idleWaiters.add(resolve));
owned.clear();
```

In the sync loop, honor throttle before calculating urgency:

```js
if (response.throttled === true) {
    schedule(syncDelay(response.next_sync_ms, 5000));
    return;
}
schedule(urgent ? 0 : syncDelay(response.next_sync_ms, 2000));
```

Make journal depth authoritative and preserve worker activity separately:

```js
function storeHealth() {
    const local = store.health();
    const workerHealth = worker.health?.() || {};
    return {
        ...workerHealth,
        ...local,
        worker_active: Number(workerHealth.active || 0),
        rejected_jobs: [...rejectedJobs],
        cleanup_error: cleanupError
    };
}
```

Use `worker_active` for the active-lane drain condition and `active` for `local_queue_depth`/capacity.

In `markRendered`, allow only `queued`, `rendered`, or `retry_wait`; throw stable `JOB_NOT_RUNNABLE` otherwise. In job-store cleanup, remove only unreferenced artifact `.bin` files older than one hour.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run backend/tests/integration/spoolerV2Sync.test.js --reporter=dot
node pos-spooler-printer/tests/v2-printer-workers.test.js
node pos-spooler-printer/tests/v2-sync-runtime.test.js
node pos-spooler-printer/tests/v2-job-store.test.js
git diff --check
git add backend/services/spoolerSync.js backend/tests/integration/spoolerV2Sync.test.js pos-spooler-printer/v2/agent-runtime.js pos-spooler-printer/v2/printer-workers.js pos-spooler-printer/v2/job-store.js pos-spooler-printer/tests/v2-sync-runtime.test.js pos-spooler-printer/tests/v2-printer-workers.test.js pos-spooler-printer/tests/v2-job-store.test.js
git commit -m "fix(spooler-v2): finish owned work during drain"
```

---

### Task 3: Isolate Windows Printer Lanes and Bound Winspool Cancellation

**Files:**
- Modify: `pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs`
- Modify: `pos-spooler-printer/v2/platform-helper.js`
- Modify: `pos-spooler-printer/v2/printer-transports.js`
- Modify: `pos-spooler-printer/tests/v2-platform-helper.test.js`
- Modify: `pos-spooler-printer/tests/v2-printer-transports.test.js`
- Modify: `pos-spooler-printer/tests/v2-printer-workers.test.js`

**Interfaces:**
- Extends `print_raw` payload with bounded `deadline_ms`
- Preserves numeric request/response IDs and `beforeWrite`
- Produces concurrent helper request execution for different printer lanes; same-printer serialization remains owned by `printer-workers.js`

- [ ] **Step 1: Add RED concurrency and timeout tests**

Pin these sequences with the real JS helper request machinery and a fake child:

1. Windows printer A never completes `print_raw`; printer B completes before A's deadline. Both markers correspond to their own request IDs.
2. Two jobs for the same printer remain serial through the existing worker lane.
3. When A times out, the helper stops accepting new commands before their marker, lets already-started B finish, then recycles once pending requests are empty.
4. A timed-out `print_raw` remains `uncertain`; B remains completed and is not converted to uncertain by A's timeout.
5. C# source/compiled integration proves `print_raw` dispatch is asynchronous, output remains locked, and a deadline attempts `SetJob(..., JOB_CONTROL_DELETE)` before Node's outer timeout.
6. Failure to delete the Windows queue job remains `uncertain`; it is never changed to `transient_safe` or `canceled`.

Run:

```powershell
node pos-spooler-printer/tests/v2-platform-helper.test.js
node pos-spooler-printer/tests/v2-printer-transports.test.js
node pos-spooler-printer/tests/v2-printer-workers.test.js
```

Expected RED: A blocks B behind `helper.runExclusive`; timeout kills the helper while B is pending.

- [ ] **Step 2: Dispatch `print_raw` asynchronously in the C# helper**

Keep `protect`, `unprotect`, status, and watch behavior unchanged. Extract response writing once and dispatch only `print_raw` through `ThreadPool.QueueUserWorkItem`; `OutputLock` already prevents interleaved JSON:

```csharp
private static void ExecuteAndWrite(object id, string command, Dictionary<string, object> payload)
{
    try
    {
        Write(new Dictionary<string, object> { { "id", id }, { "result", Execute(command, payload) } });
    }
    catch (Exception error)
    {
        string code = error is CryptographicException ? "DPAPI_FAILED" : error.Message;
        Write(new Dictionary<string, object> {
            { "id", id },
            { "error", new Dictionary<string, object> { { "code", code } } }
        });
    }
}
```

In the stdin loop, copy `id`, `command`, and `payload` into per-iteration locals. Queue `print_raw`; execute all other commands synchronously.

- [ ] **Step 3: Give Winspool its own bounded cancellation attempt**

Add the native operation and constant:

```csharp
[DllImport("winspool.drv", SetLastError = true, CharSet = CharSet.Unicode)]
private static extern bool SetJob(IntPtr hPrinter, int jobId, int level, IntPtr job, int command);
private const int JOB_CONTROL_DELETE = 5;
```

`print_raw` must:

1. Clamp `deadline_ms` to 5,000–60,000 ms.
2. Start a `Timer` only after `StartDocPrinter` returns the job ID.
3. On deadline, open a second printer handle and call `SetJob(... JOB_CONTROL_DELETE)` for that exact job ID.
4. Set an atomic deadline flag; any eventual return throws `WINspool_DEADLINE_EXCEEDED` rather than success.
5. Dispose the timer in `finally`; retain the existing `AbortPrinter` and `ClosePrinter` cleanup.

The Node outer timeout must be at least two seconds longer than `deadline_ms`. Both deadline and cleanup failure remain `uncertain`.

- [ ] **Step 4: Remove only the helper-global print serialization**

- `createWindowsTransport.send` must call `helper.request('print_raw', ...)` directly; do not wrap sends in helper-global `runExclusive`.
- Keep per-printer serialization in `printer-workers.js` unchanged.
- Keep status/watch serialization; they must not own the print path.
- In `platform-helper.js`, a timed-out `print_raw` sets the current helper to retiring/not-ready, rejects new requests before `beforeWrite`, waits for already-pending requests to settle, then kills/restarts the helper. If another request also times out, it is removed from pending so retirement cannot hang forever.
- Never kill the helper immediately while another already-started print request is pending.

- [ ] **Step 5: Run GREEN, compile, and commit**

```powershell
node pos-spooler-printer/tests/v2-platform-helper.test.js
node pos-spooler-printer/tests/v2-printer-transports.test.js
node pos-spooler-printer/tests/v2-printer-workers.test.js
$repo = (Resolve-Path '.').Path
$helperExe = Join-Path $env:TEMP 'PosSpoolerPlatform.rev52.exe'
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /optimize+ /target:exe /out:$helperExe /r:System.Web.Extensions.dll /r:System.Security.dll `
    (Join-Path $repo 'pos-spooler-printer\windows-helper\PosSpoolerPlatform.cs')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $helperExe)) { throw 'Winspool platform helper compilation failed.' }
git diff --check
git add pos-spooler-printer/windows-helper/PosSpoolerPlatform.cs pos-spooler-printer/v2/platform-helper.js pos-spooler-printer/v2/printer-transports.js pos-spooler-printer/tests/v2-platform-helper.test.js pos-spooler-printer/tests/v2-printer-transports.test.js pos-spooler-printer/tests/v2-printer-workers.test.js
git commit -m "fix(spooler-v2): isolate Windows printer lanes"
```

---

### Task 4: Restore Configuration, Health, Documentation, and Release Evidence

**Files:**
- Modify: `pos-spooler-printer/v2-server.js`
- Modify: `pos-spooler-printer/tests/external-config.test.js`
- Modify: `server.js`
- Modify: `backend/tests/integration/spoolerV2Health.test.js`
- Modify: `docs/architecture.json`
- Regenerate: `docs/architecture.html`
- Modify: `pos-spooler-printer/tests/v2-hostile-runtime.test.js`
- Create: `docs/superpowers/evidence/2026-08-18-spooler-v2-rev52-remediation-verification.md`

**Interfaces:**
- Produces: production startup fails before helper/identity state when URL/key is absent
- Produces: V1 polling owns only V1/missing-station rows; V2 sync remains authoritative for V2 printer health

- [ ] **Step 1: Add RED configuration and health tests**

Pin:

1. `NODE_ENV=production` plus missing/blank `CLOUD_SERVER_URL` exits before `startPlatformHelper` and before state files are created.
2. `NODE_ENV=production` plus missing/blank `SPOOLER_KEY` does the same.
3. Valid production URL/key proceeds; non-production behavior remains available for tests.
4. `checkPrintersStatus` does not write `offline/source=spooler` for a station whose `delivery_protocol='v2'`.
5. V1 and stations without a `spooler_stations` row retain existing behavior.

Run:

```powershell
node pos-spooler-printer/tests/external-config.test.js
npx vitest run backend/tests/integration/spoolerV2Health.test.js --reporter=verbose
```

- [ ] **Step 2: Validate production configuration before any mutable startup action**

Add and export:

```js
function assertProductionConfig(env = process.env) {
    if (env.NODE_ENV !== 'production') return;
    if (!String(env.CLOUD_SERVER_URL || '').trim()) throw new Error('CLOUD_SERVER_URL_REQUIRED');
    if (!String(env.SPOOLER_KEY || '').trim()) throw new Error('SPOOLER_KEY_REQUIRED');
}
```

Call it as the first statement in `main()`, before computing state root, starting the helper, acquiring the lock, or loading identity.

- [ ] **Step 3: Make legacy printer health protocol-aware**

Join the printer query to `spooler_stations` and select `COALESCE(station.delivery_protocol, 'v1') AS delivery_protocol`. Skip V1 socket/offline polling for `delivery_protocol === 'v2'`. Do not change print-claim predicates or V2 sync ingestion.

- [ ] **Step 4: Correct evidence and architecture semantics**

In `docs/architecture.json`:

- replace `spooler_stations.protocol_mode` with `delivery_protocol`;
- state that cancellation is guaranteed only before the local transport marker; `local_accepted` may become `cancel_requested`, while a completed post-marker job can still settle acknowledged;
- verify every touched V2 `file:line` against the named symbol, especially `spoolerSync`, `spoolerAgents`, `agent-runtime`, `job-store`, `printer-workers`, and `printer-transports`;
- document atomic canonical lock publication, quarantine-and-restart recovery, draining replay/cancel delivery, concurrent Windows requests, and V1/V2 health ownership;
- keep the physical printer gates explicit.

In `v2-hostile-runtime.test.js`, label source scans, fake-clock probes, and real child-process/DB tests separately. Do not present `db_peak_connections: 0` from an in-process fake as a database load result.

Regenerate HTML; never edit it manually.

- [ ] **Step 5: Run the final automated gates once**

```powershell
npm --prefix pos-spooler-printer test
npx vitest run backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/spoolerV2Compatibility.test.js --reporter=dot
npm run architecture
npm run architecture:check
npm run test:unit
git diff --check
```

Record exact commands, commit, pass/fail totals, and any pre-existing root-suite failures in the verification report. Do not call the root suite green if unrelated failures remain. Do not substitute the hostile JSON matrix for physical evidence.

- [ ] **Step 6: Re-run the tracked hostile cases**

Run the tracked tests created or extended in Tasks 1 and 2:

```powershell
node pos-spooler-printer/tests/v2-state-root-lock.test.js
node pos-spooler-printer/tests/v2-printer-workers.test.js
node pos-spooler-printer/tests/v2-sync-runtime.test.js
node pos-spooler-printer/tests/v2-hostile-runtime.test.js
```

Required changed outcomes:

- empty/corrupt lock: current start quarantines and fails; next start acquires;
- corrupt tombstone: current start quarantines and fails; next authorized restart recovers;
- retry stop/start: send count increases after retry time;
- throttled sync: no second request before `next_sync_ms`;
- prior unsafe partial-claim interleaving: never more than one owner.

- [ ] **Step 7: Commit**

```powershell
git add pos-spooler-printer/v2-server.js pos-spooler-printer/tests/external-config.test.js server.js backend/tests/integration/spoolerV2Health.test.js docs/architecture.json docs/architecture.html pos-spooler-printer/tests/v2-hostile-runtime.test.js docs/superpowers/evidence/2026-08-18-spooler-v2-rev52-remediation-verification.md
git commit -m "fix(spooler-v2): align health and release evidence"
```

## Final Stop Gate

The executor must stop after Task 4 and report:

- four commit hashes and subjects;
- focused and full-suite results with exact totals;
- the hostile-harness changed outcomes;
- the remaining physical gates;
- `git status --short` without deleting or absorbing unrelated files.

Even with every automated gate green, the branch remains **not approved for a customer canary** until the controlled physical matrix passes for the affected long-report printer, Windows share, direct TCP printer, write-only clone, paper-out/offline recovery, and interrupted Windows install/update.
