# Spooler V2 — independent working-tree audit (Rev 5.2)

Date: 2026-08-18
Branch: `codex/spooler-v2-local-print-agent-continued`
HEAD at review: `0a65e3c8` (`fix(spooler-v2): publish the stale-lock tombstone atomically`)
Uncommitted: Rev 5.2 lock/test/docs in

- `pos-spooler-printer/v2/state-root-lock.js`
- `pos-spooler-printer/tests/v2-hostile-runtime.test.js`
- `docs/architecture.json` / `docs/architecture.html`
- `docs/superpowers/evidence/2026-08-18-spooler-v2-independent-review-handover.md`
- `docs/superpowers/evidence/2026-08-18-spooler-v2-rev5-lock-and-ordering-fixes.md`

Audience: Sol
Method: read `Claude.md` and `docs/architecture.json` first; inspect the live working tree, not HEAD-only; do not trust commit messages, plans, handover documents, or passing tests; attack the newest lock fixes hardest; run focused suites plus a deterministic temp-dir harness. No production files were modified. Experiments lived outside the repo at `%TEMP%\grok-spooler-v2-audit\hostile-experiments.js`.

Physical USB / shared / TCP / write-only / paper-feedback gates were **not** run. Keep them separate from automated proof.

---

## Verdict

**Do not canary. Do not treat Rev 5.2 as lock-complete.**

The delivery protocol is in good shape: one station authority, one active agent, accept-before-settle, no V1 steal, no V2 lease reclaim, post-marker work becomes outcome-unknown, reprint is a new row. Those paths were attacked and did not break.

The newest lock work stopped a real dual-owner race by refusing to clear damaged ownership files. That is the right paper-safety call and the wrong operational ending: **one crash in `writeOwnerFile`, one corrupt tombstone, or one `linkSync` failure, and the station never prints again without manual file deletion.** Repair does not know those files exist.

A second lost-print hole sits in drain: replay and cancels are sent only while the agent is `active`, so a job claimed then never locally accepted can stick in `sent` forever after drain.

Windows paper is still a software story sitting on `os_accepted` / helper kill / one global Winspool FIFO. That is a physical gate, not an automated pass.

---

## 1. Confirmed defects

Ordered by severity. File:line is the current working tree.

### HIGH — Crash or corruption of `agent.lock` permanently lockouts the station

`writeOwnerFile` creates `agent.lock` with `wx`, then writes. Parse failure of that file is fail-closed **before** stale reclaim, even when `staleReclaimAuthorized: true`.

```25:33:pos-spooler-printer/v2/state-root-lock.js
function writeOwnerFile(target, owner) {
    const descriptor = fs.openSync(target, 'wx', 0o600);
    try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}
```

```100:107:pos-spooler-printer/v2/state-root-lock.js
        try {
            existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        } catch {
            throw lockedError();
        }
        if (!Number.isInteger(existing?.pid) || existing.pid < 1 || typeof existing?.boot_id !== 'string') {
            throw lockedError();
        }
```

**Sequence (reproduced in the temp harness):**

1. Exclusive-create `agent.lock`, then crash before the JSON write (or plant an empty/corrupt lock).
2. Next authorized start throws `STATE_ROOT_LOCKED`.
3. Repeat. The file stays. NSSM restart-loops. `Repair-SpoolerStartup.ps1` never opens `agent.lock`.

Harness: empty lock, crash-after-`wx`, and a second process all stayed `STATE_ROOT_LOCKED`. This is the same lockout class Rev 5 tried to kill on tombstones, still live on the lock file itself. The helper mutex already proves single-starter; that authorization is not used here.

### HIGH — Rev 5.2 corrupt-tombstone “fix” is permanent lockout with no recovery

Rev 5.2 correctly stopped clearing an unreadable shared tombstone (that path *did* admit two owners). It now leaves the tombstone forever.

```58:68:pos-spooler-printer/v2/state-root-lock.js
function resolveStaleTombstone(stalePath) {
    let claimant;
    try {
        claimant = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
    } catch {
        return lockedError();
    }
    if (!Number.isInteger(claimant?.pid) || claimant.pid < 1 || typeof claimant?.boot_id !== 'string') {
        return lockedError();
    }
```

**Sequence (reproduced):** stale lock + empty `agent.lock.stale-*` → three authorized acquires → `STATE_ROOT_LOCKED, STATE_ROOT_LOCKED, STATE_ROOT_LOCKED`, tombstone still present. The hostile test then `unlinkSync`s the file; production cannot. Disk damage, a partial name, or a planted `{}` bricks the station until a technician deletes files by hand.

### HIGH — Drain drops replay and cancels, so a claimed-but-never-accepted job can stick forever

Replay and `cancel_requested` are sent only when the locked agent is `active`:

```181:193:backend/services/spoolerSync.js
        if (locked.status === 'active' && station.delivery_protocol === 'v2') {
            const [cancels] = await conn.query(
                "SELECT id FROM print_queue WHERE agent_id = ? AND status = 'cancel_requested' ORDER BY id ASC",
                [locked.agent_id]
            );
            // ...
            const [replayRows] = await conn.query(
                `SELECT ... FROM print_queue
                  WHERE agent_id = ? AND status = 'sent'`,
```

New intake is already blocked by `capacity: 0` while draining (`pos-spooler-printer/v2/agent-runtime.js:91-93`) and `remaining = capacity - replayRows.length`. Drain did not need to hide replay.

**Sequence:**

1. Sync claims a row (`pending` → `sent`) and returns `jobs[]`.
2. Process dies after HTTP 200, before `store.accept` fsync/rename (`agent-runtime.js:147-153`, `job-store.js:96-106`). Same if the disk write throws.
3. Admin drain (`backend/services/spoolerAgents.js:257`).
4. Agent restarts as `draining`. Sync applies accepts/results, but sends **no** `sent` replay and **no** cancels.
5. Local journal is empty, so `drain_complete` can be true. Server still has `sent` → decommission refuses (`spoolerSync.js:158-178`).
6. Job never prints, never accepts, never settles, until force-replace dead-letters it.

This is lost paper, not duplicate paper. The integration drain test accepts first, then drains (`backend/tests/integration/spoolerV2Sync.test.js:453-469`). Hostile “lost response replay” is a source scan.

### HIGH — Hung Windows `print_raw` is marked uncertain, then the helper is killed without `AbortPrinter`

Transport timeout does not cancel the helper:

```255:265:pos-spooler-printer/v2/printer-transports.js
                const result = await withTimeout(
                    helper.request('print_raw', { ... }, { beforeWrite: markTransportStarted }),
                    totalMs,
                    null,
                    'PLATFORM_HELPER_TIMEOUT',
                    'uncertain'
                );
```

The helper’s own 10s timer then `child.kill()`. `AbortPrinter` exists only in C# `finally` (`windows-helper/PosSpoolerPlatform.cs:253-257`), which does not run on process kill after `StartDocPrinter`.

**Sequence:** kitchen job, `WritePrinter` blocks → JS records `uncertain` / dead-letter → helper process is killed → RAW job can remain in the Windows queue. Next ticket on that printer stacks behind it. Partial paper is OS/driver-dependent (see §2). No test kills the helper mid-`WritePrinter`.

### MEDIUM — Worker `stop()` leaks `owned` IDs for `retry_wait` jobs

`stop()` clears render/lane queues and retry timers, but not `owned` for jobs waiting on those timers (`printer-workers.js:229-241`, `51-67`). `collect()` skips `owned` (`164-166`). `agent-runtime` does in-process `stopWorkers` / `startWorkers` on pause/resume (`155-166`).

**Sequence (reproduced against production workers):** one kitchen send fails `transient_safe` → `retry_wait`, `sends=1` → `stop()` → `start()` → still `sends=1`. Job never reprints until process restart. Current revoke/rollback paths usually exit the process or stay paused, so this is a live landmine more than a daily canary path.

### MEDIUM — Urgent sync ignores `next_sync_ms` and the throttle delay

```167:171:pos-spooler-printer/v2/agent-runtime.js
            const urgent = accepted.length > 0
                || store.unconfirmedAccepted().length > 0
                || store.outbox().length > 0
                || (response.jobs || []).length > 0;
            schedule(urgent ? 0 : syncDelay(response.next_sync_ms, 2000));
```

Server throttle is a **200** with empty confirms (`backend/routes/spoolerV2.js:47-59`). The client does not treat that as backoff.

**Sequence (reproduced):** one unconfirmed local accept, server returns `throttled: true, next_sync_ms: 5000` forever → **5 syncs in 206ms**. Low-end terminals burn the event loop; the server’s 40/10s limiter is the only brake, and the client immediately slams it again.

### MEDIUM — One blocked Windows printer stalls every Windows printer

JS lanes are per `printer_id`. Production uses one helper and `helper.runExclusive` for every `print_raw` / status / watch (`printer-transports.js:237-253`, `v2-server.js:114`). `WritePrinter` is synchronous on the helper stdin thread.

Architecture invariant “another kitchen lane progresses during an offline printer” is true for TCP vs Windows, false for two Windows printers. `v2-printer-transports.test.js` **requires** that global serialize. Hostile lane isolation uses mock `send` and cannot see it.

### MEDIUM — V1 printer-health timer stomps V2 station health

`checkPrintersStatus` (`server.js:530-567`) walks every active printer. No socket in `spoolerRegistry` → `device_status='offline', source='spooler'`. V2 never registers there. A leftover V1 socket with the same `spooler_id` can also overwrite V2 facts.

This is not dual paper (`device_status` is not in any claim predicate). It does break “V2 station health is authoritative only from a fresh authenticated `last_sync_at`”. Compatibility tests only prove V1 cannot *claim*.

### MEDIUM — V2 has no production env start gate

Invariant and V1 `server.js:55-58` require `CLOUD_SERVER_URL` + `SPOOLER_KEY` before start. `v2-server.js` starts the helper, takes the lock, and may mint `agent.json` first. `createSyncClient` only checks URL shape (`sync-client.js:14-15`). Empty `SPOOLER_KEY` is sent. `external-config.test.js` only reads V1.

### MEDIUM — TCP “total” deadline is stacked, not total

Production: connect 5s + hash (up to 10s) **outside** `tcpTotalDeadlineMs`, then stream, then `finishSocket` gets another write-idle. `socket.setTimeout` is never armed, so the `timeout` listeners in connect/write are dead. Transport tests use 100/100/500ms fake sockets that finish on the next tick.

### MEDIUM — Chromium launch timeout does not kill the process

Render timeout SIGKILLs (`artifact-renderer.js:380-384`, `464-467`). Launch timeout only `controller.abort()` and later `instance.close()` if launch still resolves (`398-401`). Wedged `puppeteer.launch` can leave `chrome-headless-shell`. Hostile “browser hang survival” is a source scan.

### LOW — Default packaged install is still V1; V1 install has no journal/repair

`deployment/windows/Install-Spooler.ps1:199-216` journals and registers boot repair only inside `if ($EnableV2)`. Default NSSM target is `server.js` (`:241`). Docs claim the standalone installer always journals and always registers repair. `pos-spooler-printer/install-service.js:11` still hard-wires V1 `server.js`.

### LOW — Dead `STATUS_UNSUPPORTED` rethrow

`printer-transports.js:229` rethrows a code that is only returned, never thrown. Harmless. DLE EOT n=1 is online/offline, not paper.

### LOW — Journal / telemetry residuals (not reprint paths)

- `worker.health().active` overwrites `store.health().active` in the sync body (`agent-runtime.js:42-45`, `printer-workers.js:254-256`). Capacity still uses journal depth. `local_queue_depth` and part of `drain_complete` report lane concurrency. Decommission is still gated on DB unresolved, so this is an ops lie, not a silent decommission.
- `markRendered` after `transport_started` is allowed by `mutate` (`job-store.js:190-208`, `272-274`). Workers re-check `RUNNABLE_STATES` before send, so there is no current production caller. Relocated barrier, not a closed store invariant.
- Crash after artifact rename and before `markRendered` leaves an orphan `.bin` (`artifact-renderer.js:468-473`). `cleanup()` only deletes artifacts attached to archived records. Leak, not a reprint.

---

## 2. Plausible risks that need hardware or external evidence

Keep these out of the automated proof.

| Risk | Why software cannot close it |
|---|---|
| Partial paper after `AbortPrinter` or helper kill | Bytes may already be on the port |
| Windows `os_accepted` with paper sitting in the OS queue | Offline/paper-out drivers often still accept RAW |
| TCP `bytes_sent` on a write-only / print-server box | No paper sensor |
| ESC/POS `device_confirmed` / `ok` while paper is out | Probe is DLE EOT n=1, not n=4 |
| Helper leftover holding `Global\POSAPP-Spooler-V2-*` after a hard Node kill | Next V2 start exits 73; needs a real process tree |
| Updater `Copy-Item` of a running `PosSpoolerPlatform.exe` | NSSM is not configured to kill the process tree |
| `linkSync` on FAT32/exFAT/SMB state dir | First start works; stale reclaim fail-closes |
| PID reuse making a dead claimant look live | `process.kill(pid, 0)` only; heals when that PID exits |
| Forced replace while the old terminal is still printing, then admin reprint | Server dead-letters; old agent can still finish local work; reprint is a new `pending` row (`backend/services/printReprint.js:44-80`) |
| Disk-full at each journal rename | Need injection on the real volume |
| Interrupted `/ENABLEV2=1` install with POS URL down | Repair `catch {}` treats authority as unavailable and can **Disable** the service |

Post-marker admin cancel finishing as `acknowledged` is the existing “cannot unprint” rule, not a new reprint bug. The architecture line that “in-transport jobs are rejected” is wrong: the server has no in-transport status (`print_queue` cancel allowlist includes `local_accepted`; agent no-ops cancel once `transport_started` at `job-store.js:264`; server then ACKs `completed` from `cancel_requested`). Integration test `v2-cancel-but-completed` locks that in.

---

## 3. Claims disproved by experiment or live code

| Claim | Result |
|---|---|
| Authorized reclaim recovers any damaged lock/tombstone | **False.** Empty `agent.lock` and corrupt tombstone never recover (harness). |
| Rev 5.2 only “fails closed for diagnosis” | **False as operations.** Fail-closed is permanent; repair cannot delete the files. |
| Hostile “concurrent capacity-one and station ownership guards” | **Overstated in that file** (regex). The **backend** test `spoolerV2Sync.test.js:207-217` *does* run two real syncs; it passed. |
| Hostile “idle agent budgets 1/5/10/50/100” | **Not a budget.** In-process FakeClock, `db_peak_connections: 0`, hundreds of fake syncs/sec. |
| V2 refuses to start in production without URL + key | **False.** Only V1 has that gate. |
| Another kitchen lane always progresses while one printer is offline | **False for two Windows printers** (single helper FIFO). |
| `spooler_stations.protocol_mode` | **Column does not exist.** It is `delivery_protocol`. |
| Full suite 2,994/2,994 is current-tree evidence | **Stale.** That number is rev 5.0. This tree has uncommitted Rev 5.2. |
| “Clearing a tombstone never grants ownership” | Already disproved in Rev 5.1; current code no longer clears corrupt shared tombstones. |
| Drain is “no new intake” only | **False.** Drain also suppresses `sent` replay and `cancel_requested`. |

Attacks that **did not** break paper safety:

- Two production-authorized lock contenders → one owner (hostile test, still green).
- Dead-claimant tombstone → next start recovers (hostile test).
- Atomic publish: tombstone content is complete at `linkSync` (hostile test).
- `transport_started` restart → `uncertain`, not runnable (hostile durability + `job-store.js:113-131`).
- Post-marker retry blocked (`recordRetry` throws; workers only retry `transient_safe`).
- TCP/Windows marker is before first byte / before stdin write.
- Accept is not visible to sync until after durable rename (`job-store.js:104-106`).
- V1 claim on a `v2` station returns `[]` (`backend/services/printQueue.js:88-91`).
- Concurrent capacity-one, cutover, replacement, rollback-after-accept: **33/33** backend integration tests passed, including real `FOR UPDATE` order.

---

## 4. Existing findings verified closed

Checked against **this tree**, not the handover.

| Prior finding | Status now |
|---|---|
| R1 dual owners on stale reclaim via racing `unlink`+`create` | **Closed** for the live two-contender barrier and atomic claimant publish |
| Rev 5.0 empty-tombstone clear → two `ACQUIRED` | **Closed** by fail-closed retain (replaced by lockout, §1) |
| Interrupted *valid dead* claimant reclaim | **Closed** — `interrupted_reclaim_cleared`, next start wins |
| T2 helper death after ready-check manufacturing false uncertain | **Closed** — `beforeWrite` + post-check (`platform-helper.js:54-62`) |
| Artifact hash inside helper FIFO stalling all Windows printers | **Closed as stated** — hash hoisted; remaining issue is `print_raw` itself still global |
| V1 reclaim of V2 `sent` after printer repoint | **Closed** — `agent_id IS NULL` + v1 station gate; compatibility test passed |
| Two active agents on one station | **Closed** — `uq_spooler_agents_active_station` |
| V2 auto-reassign of agent-owned rows | **Closed** — claim is `agent_id IS NULL` and only `pending`/`failed` |
| Rollback after first server accept | **Closed** — `first_v2_accepted_at` / unresolved rows |
| Replacement leaving rows claimable by the new agent | **Closed** — dead-letter, `agent_id` kept |
| Cancel-during-render never transports | **Closed** — workers test + `RUNNABLE_STATES` check |
| Prior note that V1 reclaim lacked `agent_id IS NULL` | **Stale.** Current `printQueue.js:97` has the guard |

---

## 5. Documentation / tests that overstate reality

- **`v2-hostile-runtime.test.js`** mixes real lock/journal experiments with source-token “gates” (capacity locks, updater phases, transport marker, helper/browser hang, lost-response replay). The JSON output looks like a release matrix. It is not.
- **Idle-agent row** reports request rates and p95 with no HTTP, no MySQL, no helper.
- **Architecture map** `file:line` pins are stale on several V2 steps (`job-store.js:53`, `printer-workers.js:13/75/84/130`, `spoolerSync.js:43`, `spoolerAgents.js:269`, `printer-transports.js:236`, `agent-runtime.js:37/54/83`, `printQueue.js:352`). `npm run architecture:check` only proves the line exists. Named symbols were confirmed; the pins often point at the wrong one.
- **Invariant** still says `protocol_mode`.
- **Handover** “277/277, 2,994/2,994” is rev 5.0. Rev 5.2 is uncommitted and only focused-tested.
- **`external-config.test.js` / installer contract tests** assert V1 strings / PS1 tokens, not V2 start or an interrupted SCM install.
- **Release-gate / mixed-jobs harness** default mode is a local virtual scheduler, not `/sync`.
- **Architecture “in-transport jobs are rejected”** cites a line that is no longer the cancel handler. Server cannot see `transport_started`.

---

## 6. What was actually run on this tree

| Gate | Result |
|---|---|
| `node tests/v2-hostile-runtime.test.js` from `pos-spooler-printer` | pass (12 rows), including Rev 5.2 lock flags |
| `v2-job-store`, `v2-printer-workers`, `v2-printer-transports`, `v2-agent-identity`, `v2-platform-helper`, `v2-status-monitor`, `v2-sync-runtime` | pass |
| Vitest `spoolerV2Sync` + `spoolerV2Cutover` + `spoolerV2Compatibility` | 33/33 |
| Temp harness `hostile-experiments.js` | 7/7 hypothesized lockout / leak / sync-spin behaviours confirmed |
| `npm run architecture:check` | OK (217 nodes, 59 flows, 446 steps) |
| Full repository Vitest (2,994) | **not rerun** on this uncommitted tree |
| Physical USB / shared / TCP / write-only / paper-out | **not run** |

Harness confirmations:

- `empty_agent_lock_authorized_reclaim` → `STATE_ROOT_LOCKED`, lock remains
- `corrupt_tombstone_never_recovers` → three starts all locked, tombstone remains
- `crash_after_lock_excl_create` → authorized start stays locked
- `cleanup_unlinks_empty_claim_during_publish` → fail-closed, not dual-own
- `second_process_empty_lock` → child `STATE_ROOT_LOCKED`
- `worker_stop_start_retry_owned_leak` → `sends` stayed 1 after in-process restart
- `urgent_sync_ignores_next_sync_ms` → 5 syncs in 206ms against a 5000ms throttle

---

## 7. What to fix before a canary

Minimum to change the verdict:

1. Authorized single-starter reclaim of *unreadable* `agent.lock` (helper mutex already authorizes this), without reopening a live write.
2. An operator/repair path for retained corrupt tombstones that is not “delete ProgramData by hand.”
3. Drain must still replay `sent` and emit `cancel_requested`. Keep new intake at capacity 0.
4. Helper timeout must abort the Winspool job instead of killing the process and hoping.
5. Client must honor `next_sync_ms` / `throttled`.
6. The physical matrix in §2, kept separate from CI.

Until then this branch is **automated-protocol-strong, recovery-weak, hardware-unproven.**
