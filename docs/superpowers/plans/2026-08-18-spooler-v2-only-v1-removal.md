# Spooler V2-Only Cleanup Implementation Plan

> **Execution:** Work directly in the normal checkout on `codex/spooler-v2-remove-v1`. Do not create a Git worktree. Use focused RED/GREEN tests per task, commit each task, and run the full gate only once at the end.

**Date:** 2026-08-18

**Revision:** rev 7 — Task 1 execution patch: four whole-block-as-one-line defects ((a) `backend/tests/unit/installerUpdateContract.test.js` both `it()` blocks, (b) `installerPackageContract.test.js` "keeps V2 opt-in" `it()`, (c) retarget not drop `http-client.test.js` ACK assertion, (d) `spoolerReceiptDisplay.test.js` missing from GREEN) plus Repair catch-all / dead-arm notes, probe rename, installer-smoke timing, and `report-html.test.js` exclusion. Prior: rev 6 — owner's verified Grok audit of rev 5 (`docs/superpowers/evidence/2026-08-19-spooler-v2-only-removal-plan-grok-audit.md`; all 19 findings confirmed against the tree) plus four framing corrections. **Task 3 (drop `spooler_stations.delivery_protocol`) is removed by owner decision**, not by oversight: the column drop was the most dangerous third of this plan and bought the deletion of one enum column. It is what forced the CHECK migration, the orphan-row cleanup, the baseline rewrite, the manifest re-pin, the ledger stamp, and the `automaticMigrations` replay. After Task 2 nothing reads the column for a delivery decision. Keep it in the database forever, dead. The surviving findings folded in here are H1–H4, H5(a), M1 (gate-item-3 half only), M2–M12. Dropped with the schema task: H5(b–e), H6, L1, and release-gate items 2/6/7. Prior history is in `docs/superpowers/evidence/2026-08-19-spooler-v2-only-removal-plan-review.md`. Read those two evidence files first if you are reviewing this plan rather than executing it.

**Status:** Tasks 1–3 committed on `codex/spooler-v2-remove-v1` (`8cbeb5d6`, `361c924b`, `11c2a9ef`). Review follow-up is a fourth commit: drop the dead `V1_CUTOVER_OUTCOME_UNKNOWN` reprint guard, refuse legacy daemon updates via `Fail ... blocked_ownership` before any mutation, share the failed+dead_letter badge count, and keep the station `FOR UPDATE` lock without selecting unused `first_v2_accepted_at`.

**Goal:** Remove legacy printer delivery completely. The durable HTTP agent becomes the only spooler. The final source, package, installer, updater, admin UI, tests, and architecture map contain no V1 Socket.IO/poll delivery, V1 rollback/cutover mode, or dual `server.js`/`v2-server.js` runtime. The `delivery_protocol` column remains in the schema by the owner decision above.

**Deliberate exception:** Keep `/api/spooler/v2` as the stable versioned wire URL and keep `spooler_agents.protocol_version = 2`. Those identify the protocol contract; they do not preserve a V1 implementation. Renaming them would force a pointless second fleet upgrade. The same rationale covers the wire field `station_protocol: 'v2'` after Task 2: keep the name, stop reading the column to populate it.

## Evidence and scope boundary

Current source has two delivery paths:

- Root `server.js` imports `backend/services/printQueue.js`, registers printer Socket.IO clients (`server.js:139-160`, `:321-380`), emits `print_job`, accepts `print_job_response`, and polls V1 printer status (`server.js:531-560`).
- `backend/routes/spooler.js` exposes the V1 HTTP poll/ack fallback.
- `pos-spooler-printer/server.js` is the V1 Socket.IO/poll agent; `v2-server.js` is the durable HTTP agent.
- `backend/services/printDispatch.js` still wakes V1 sockets after every enqueue, and `server.js:605-616` re-dispatches every 30 seconds.
- `delivery_protocol ENUM('v1','transitioning','v2')` currently keeps the server, admin page, installer, and recovery scripts branching between two generations. After Task 2 those branches are gone; the column itself is kept.
- The spooler package still ships `socket.io-client`, the old durable-seen store, poll fallback, and two entry points.

This removes only printer-delivery V1. Do not remove root Socket.IO: staff sessions, live order events, and printer-health UI notifications still use it. Do not alter receipt tax presentation or order accounting. `receiptDisplayV1.cjs` is shared receipt-format code, not transport state; rename it mechanically to `receipt-display.cjs` rather than changing its behavior.

### One behavior V1 owns that V2 has never implemented

`updateAuditPrintStatus` (`backend/services/printQueue.js:44`) is the only writer of `audit_report_documents.last_print_status / last_print_error / last_printed_at`, reached only from `settlePrintJob` (`backend/services/printQueue.js:206`, `:246`). `backend/services/spoolerSync.js` has no such write. `backend/routes/admin/auditReports.js:107` sets the column to `queued` at enqueue, `:124` sets `failed` on a dispatch error, and `:236` seeds `'queued'` in the document INSERT. **No route selects or exposes these fields today** — they are write-only durable audit state, not something the admin UI renders.

This is **already broken for stations on V2 today** — the plan does not introduce it — but deleting `printQueue.js` destroys the only implementation. Task 2 ports it. The reason is durable audit integrity, not UI: the system keeps writing `queued` and `failed` into a permanent audit record that nothing will ever advance, so every V2-printed audit document accumulates a false status forever. The port is small and the alternative is deliberate data rot in an audit table.

## Mandatory release gate

Implementation and local commits may proceed, but **the V2-only server must not be deployed until every configured station has already been upgraded with the current compatible updater**.

Gate items 2, 6, and 7 from rev 5 existed only to make a CHECK-then-drop of `delivery_protocol` fail closed. That schema task is gone, so those items are gone. Item 2's live-station half is folded into item 1: a V1 station with an active printer has zero `spooler_agents` rows and fails item 1.

Before deployment, record one read-only readiness result per target database proving:

1. every station **referenced by an active printer** has exactly one `active` or `draining` agent. Draining counts. The unique generated key `spooler_agents.active_station_key` (`backend/migrations/2026-08-17-spooler-v2-agents-v1.sql:32-35`; `deployment/database/baseline.sql:693-695`) proves **at most one** live agent; **zero is legal in the schema**, which is why this query exists. A mid-replace snapshot that shows zero is a retry, not a rollback-to-V1 event. A V1 station that still has an active printer fails here (zero agents) and is the folded remainder of old item 2.

```sql
SELECT p.spooler_id, COUNT(DISTINCT a.agent_id) AS live_agents
  FROM printers p
  LEFT JOIN spooler_agents a
    ON a.spooler_id = p.spooler_id AND a.status IN ('active','draining')
 WHERE p.is_active = 1
 GROUP BY p.spooler_id
HAVING COUNT(DISTINCT a.agent_id) <> 1;
```

3. every station **referenced by an active printer** has a live agent whose `last_sync_at` is non-null. Scope this like item 1; do not query "every `spooler_stations` row". `last_sync_at` lives on `spooler_agents` (`deployment/database/baseline.sql:689`), written only inside the `active`/`draining` arm of `runAgentSync` (`backend/services/spoolerSync.js:235` guards, `:264-265` writes). `spooler_stations` has no `last_sync_at`. Admin health already joins the live agent for that timestamp (`backend/routes/admin/printQueue.js:79`, `:126`).

   **"Fresh" means non-null `spooler_agents.last_sync_at` on that live agent.** It does **not** mean the 30-second online window (`FRESH_SYNC_MS` at `backend/routes/admin/printQueue.js:11`, used by `stationIsOnline` at `:22-30`; `REACHABLE_WINDOW_SECONDS = 30` at `backend/services/spoolerAgents.js:236`). Those windows fail a closed-store or brief-blip snapshot of an otherwise upgraded fleet. Do **not** treat `first_v2_accepted_at` as an upgrade signal: that column is written only on `sent → local_accepted` (`backend/services/spoolerSync.js:91-95`) and is what item 5 proves. Registration (`backend/services/spoolerAgents.js:181`) sets `delivery_protocol='v2'` and `v2_activated_at`; it does not set `first_v2_accepted_at`.

```sql
SELECT p.spooler_id, a.agent_id, a.last_sync_at
  FROM printers p
  LEFT JOIN spooler_agents a
    ON a.spooler_id = p.spooler_id AND a.status IN ('active','draining')
 WHERE p.is_active = 1
   AND (a.agent_id IS NULL OR a.last_sync_at IS NULL);
```

4. `agent_id IS NULL AND status IN ('processing','sent')` is zero. Table is `print_queue`. Same predicate as the registration guard (`backend/services/spoolerAgents.js:167-173` and `:142-148`). V2 never writes `processing`; V2 claim sets `status='sent'` and `agent_id` together (`backend/services/spoolerSync.js:218-226`). This item is the V1-stranding interlock, not a V2 exactly-once check.

   It does not see owned V2 work whose agent is already `revoked` and was not replace-terminalized (`replaceAgent` at `backend/services/spoolerAgents.js:310-316` is the only owned-work terminalizer). Run this sibling query as well. Rows here are not a V1-stranding case; **replace is the repair** and must have been used before the snapshot. A mid-replace zero-agent window is a retry of item 1, not a reason to add V1 code back.

```sql
SELECT q.id, q.spooler_id, q.status, q.agent_id, a.status AS agent_status
  FROM print_queue q
  LEFT JOIN spooler_agents a ON a.agent_id = q.agent_id
 WHERE q.agent_id IS NOT NULL
   AND q.status IN ('sent','local_accepted','cancel_requested')
   AND (a.agent_id IS NULL OR a.status NOT IN ('active','draining'));
```

5. one receipt and one kitchen ticket physically print on every station after upgrade;

8. **old installer and updater artifacts are withdrawn from distribution.** Station telemetry cannot prove this: it reports what is *installed*, not what media still exists on a technician's USB stick, a share, or a release folder, and that media is exactly what re-creates a V1 station after cutoff. This item is a signed checklist, not a proof. Record, and have the owner initial, each of:

   - the approved package version and its artifact SHA-256, one line per artifact (`POSAPP-Spooler-Setup.exe`, `POSAPP-Spooler-Update.exe`, `POSAPP-Spooler-Runtime-Update.exe` from `scripts/build-installers.ps1:452-458`, written under `deployment/out` at `:12`);
   - confirmation that every earlier spooler installer and updater artifact has been removed or archived out of each named location:
     1. `deployment/out` on the build machine;
     2. GitHub Releases for this repository, if any spooler installer was ever published there;
     3. the Hostinger package/deploy directory used for production;
     4. every technician USB stick or file share currently used to install stations (owner names the set; the repo cannot close it);
   - the installed release version per station, as a cross-check that no station is running something older than the approved hash.

   See "Known traps" for what an old package does after cutoff.

If any row fails, stop. Upgrade or repair that station using the compatible branch. Do not add V1 code back to this branch.

## Final invariants

- Only authenticated agent sync may claim or settle printer work.
- A pending job may have `agent_id IS NULL`, but no V1 claimant may assign, send, or settle it.
- Registration still refuses a station holding un-owned in-flight work (`agent_id IS NULL AND status IN ('processing','sent')`). This guard survives V1 removal; it is the last server-side interlock against reprinting work whose physical outcome is unknown.
- Existing `sent`, `local_accepted`, and `cancel_requested` V2 work survives updates and restarts.
- The installed service has one entry point: `pos-spooler-printer/server.js`, containing today's durable agent.
- Fresh install and update always install that agent; there is no `ENABLEV2`, prepare, abort, terminalize-V1, or rollback-to-V1 control.
- Update rollback may restore the immediately previous installed package after failure, but never restore server ownership to deleted V1 delivery.
- Unknown physical outcomes remain terminal/uncertain; removal must not introduce automatic duplicate printing.
- Existing `spooler.env`, DPAPI identity, state root, journal, and artifacts remain byte-for-byte preserved across update.
- Audit-report print status has a V2 writer covering both the printed and failed outcomes. Abandoning the column is not an available option.
- `spooler_stations.delivery_protocol` is not a delivery authority after Task 2. The column remains; no live path branches on it.

---

## Task 1 — Make the installed spooler package single-runtime

**Files:**

- Replace `pos-spooler-printer/server.js` with the durable agent currently in `pos-spooler-printer/v2-server.js`.
- Delete `v2-server.js`, `poll-fallback.js`, and `durable-seen-store.js`.
- Delete `migrateLegacy()` from `pos-spooler-printer/v2/job-store.js:133` and its call at `:183`, plus the `seen-print-jobs*` fixtures in `pos-spooler-printer/tests/v2-job-store.test.js` (`:66`, `:67`, `:70`, `:141`, `:145`, `:148`). It imports the V1 `seen-print-jobs.json` durable-seen file into the V2 job store, quarantining `seen-print-jobs.v1.backup.json`. It is V1 residue living inside V2. Deletion is **unconditional**: the owner asked for complete V1 removal, and keeping it is a product decision, not an executor one. Deletion is also safe, but **not** because a protocol enum proves the filesystem import ran. V2 claim only takes `agent_id IS NULL` and `pending` or due `failed` (`backend/services/spoolerSync.js:210-212`). V1 paper-without-ack is `processing`/`sent` (gate item 4). Local V1 "seen" is not required to suppress V2 reprint of already-acked work. An exception requires a written owner decision recorded here *before* execution begins.
- Delete the CLI flags `process.argv.includes('--prepare')` (`pos-spooler-printer/v2-server.js:98-102`) and `process.argv.includes('--rollback-v1')` (`:103-108`) with the move into `server.js`. Those are station cutover prepare and self-rollback, not a platform-helper flag. `pos-spooler-printer/v2/sync-client.js:38-39` is `post('/api/spooler/v2/prepare', ...)`. `deployment/windows/Install-Spooler.ps1:254-261` is the only production `--prepare` caller and goes away with `$EnableV2`. There is no helper `--prepare` in `pos-spooler-printer/v2/platform-helper.js` or `pos-spooler-printer/windows-helper/`. Helper startup is `startPlatformHelper` at `pos-spooler-printer/v2-server.js:75`, which runs unconditionally before the CLI branch. The `installerPackageContract.test.js` provisioning assertion is **not** a one-line flip of `:732` — rewrite the whole `it()` (see the backend-contract disposition below).
- Rename `receiptDisplayV1.cjs` to `receipt-display.cjs`. **Every referencing site**, verified: `pos-spooler-printer/renderDocument.js:6`, `deployment/tools/spooler-layer-manifest.js:12`, `scripts/build-installers.ps1:366`, `pos-spooler-printer/tests/receipt-display.test.js:4`, `backend/tests/unit/spoolerReceiptDisplay.test.js:2` `:15` `:203` `:204`, `backend/tests/unit/spoolerPackageContract.test.js:28`, `backend/tests/unit/installerUpdateContract.test.js:314`.
- Modify spooler `package.json`/`package-lock.json` (`main` already `'server.js'`; drop `start:v2` at `pos-spooler-printer/package.json:9` and `node --check v2-server.js` from the `test` script at `:8`), service scripts, README, tests, payload validator (`deployment/tools/validate-payload.js:26` currently requires `v2-server.js`), layer manifest (`deployment/tools/spooler-layer-manifest.js:16`), build script (`scripts/build-installers.ps1:367`), installer (`deployment/windows/Install-Spooler.ps1`), updater (`deployment/windows/Update-Spooler.ps1`), startup repair (`deployment/windows/Repair-SpoolerStartup.ps1`), layer state (`deployment/windows/SpoolerLayerState.ps1`), and Inno Setup (`deployment/spooler/POSAPP-Spooler.iss:73-80` `/ENABLEV2` → `-EnableV2`).
- Modify **root `package.json`**: `test:installer` names `backend/tests/unit/spoolerRegistry.test.js`, which Task 2 deletes. `vitest run` exits non-zero on a missing file, so the script breaks unless this is removed in the same branch.
- Installer smokes:
  - `tests/installer/spooler-update-probe.ps1:10` does **not** call self-status. It requires the literal phase label `'self-status verify'` (`Update-Spooler.ps1:519`) in the updater source. Deleting `Wait-SelfStatus` does not break it. **Rename the phase label and the probe token together** to `'registration verify'`.
  - `tests/installer/fresh-install-smoke.ps1:143-144` and `tests/installer/update-sandbox-guest.ps1:339` call `/api/spooler/self-status`, which **Task 2** deletes. Fix them **in this task anyway**: after the move, every fresh install/update is the durable agent as `server.js`, so `$status.connected` is already false on every V2 station (same reasoning as the Wait-SelfStatus paragraph below). Leaving them until Task 2 makes the first post-Task-1 installer smoke fail even though the route still exists. Retarget both to `POST /api/spooler/v2/status` with matching `agent_id` and non-null `last_sync_at`, not `connected`.

- [x] Add RED package/installer assertions that:
  - `package.json.main === 'server.js'`, no `start:v2`, and no spooler `socket.io-client`;
  - the spooler `test` script no longer runs `node --check v2-server.js`;
  - V1 files and `v2-server.js` are absent from the payload manifest;
  - installer has no `ENABLEV2` / `--prepare` and always targets `server.js`;
  - updater **and** `Repair-SpoolerStartup.ps1` accept installed `v2-server.js` only as the prior entry point during this upgrade, commit and target `server.js`, and restore the exact prior package/entry point if verification fails. Assert on both files: `Set-SpoolerRepairEntryPoint`'s `ValidateSet` and the journal `targetScript` check both name the entry point independently of the updater. **ValidateSet is an allow-list, not a default** — keep both `'server.js'` and `'v2-server.js'` in `Set-SpoolerRepairEntryPoint` (`deployment/windows/Repair-SpoolerStartup.ps1:37`) and `Set-SpoolerApplicationScript` (`deployment/windows/Update-Spooler.ps1:116`); restore uses the **parameter**, and a still-on-`v2-server.js` machine throws before NSSM is set if the set is narrowed to `server.js` (Update catch then disables the service at `:598-600`; Repair catch does the same at `:323-325`);
  - `Save-SpoolerJournal` (`deployment/windows/Update-Spooler.ps1:302-318`) persists `previousScript` and `targetScript` on **Update** journals. Today it writes phase, rollback roots, env hash, and recovery-script hashes, and writes **neither** script field. `deployment/windows/Install-Spooler.ps1:208-209` already writes both on Install journals (`previousScript` at `:208`, `targetScript = 'v2-server.js'` at `:209`); that Install read at Repair `:235` is safe. The Update gap is the defect;
  - the Repair catch-all arm at `deployment/windows/Repair-SpoolerStartup.ps1:291-307` (the arm a post-Task-1 `target_application_active` / `service_stopped` journal hits) calls `Set-SpoolerRepairEntryPoint` with the journal's `previousScript` after restoring files. Today it restores files and never repoints NSSM;
  - root `package.json` `test:installer` references only files that exist.

  **Backend contract-suite rewrites (this task's vitest GREEN, not the eleven-suite table).** These are whole-block rewrites, not one-line flips.

  `backend/tests/unit/installerUpdateContract.test.js` — full disposition. The plan previously named only `:314` (inventory) and `:634` (`$EnableV2 -or $v2ActiveBefore`). Task 1 also kills:

  - `it('keeps every packaged spooler layer file inside an exact inventory')` at `:310`. The inventory at `:313-315` lists `durable-seen-store.js`, `poll-fallback.js`, **and** `receiptDisplayV1.cjs`, not just the receipt module. Rewrite the list: drop the two V1 files; rename the receipt module to `receipt-display.cjs`; keep the rest.
  - `it('pins atomic V2 cutover, exact service ownership, and acceptance-aware recovery')` at `:620-636`. The six-phase loop at `:623-626` asserts `cutover_prepared` / `v1_drained` / `v1_stopped` / `v2_application_active` / `v2_registered` / `v2_verified` against **both** updater and repair. The token list at `:627` requires `EnableV2`, `Invoke-V2Prepare`, `Wait-V2Drain`, `Invoke-V2Abort`, `rollback-v1`, `v2PausedRecovery` (keep `Assert-ExclusiveSpoolerService`, `Wait-V2Registration`, `Set-SpoolerApplicationScript`). `:629` asserts `abort-prepare` and `rollback-self` in `backend/routes/spoolerV2.js` (Task 2 deletes those routes; this file is missing from Task 2's GREEN — see the Task 2 note). `:630` requires `SpoolerCutoverPhases`; `:631` requires the `$cutoverStarted` regex; `:634` is the gated verify. **Rewrite and retitle** against the single-runtime contract: exclusive-service, env-preserve (`:635` stay), unconditional `Wait-V2Registration`, `Save-SpoolerJournal` persists `previousScript`/`targetScript`, Repair catch-all repoints NSSM to `previousScript`, ValidateSet still lists both names. Drop every cutover / EnableV2 / prepare / abort / `$cutoverStarted` / gated-verify token, including the `:629` `abort-prepare` / `rollback-self` pair so Task 2 is not stranded.
  - `it('structurally restores the V1 entry point before rollback restart and journal deletion')` at `:638-649` is entirely V1 rollback. **Rewrite and retitle** to the remaining `$phase = 'rollback'` block: `Set-SpoolerApplicationScript` (now unconditional, prior filename) before `Start-Spooler` before `Remove-SpoolerTransactionJournal`. Keep the ordering; drop the V1-entry-point framing.

  `backend/tests/unit/installerPackageContract.test.js` — two whole `it()` rewrites, not flips:

  - `it('keeps V2 opt-in and packages its entrypoint, helper, and source inventory')` at `:725-737` dies as a block. Build tokens at `:730` (`v2-server.js` goes; keep `'v2', 'windows-helper', 'bin'`, `$helperBin`, `PosSpoolerPlatform.exe`). ISS tokens at `:731` (`ENABLEV2` / `-EnableV2` / `EnableV2` all **absent**). Provisioning tokens at `:732` (`$EnableV2`, `v2-server.js` as a target, `--prepare` all **absent**; keep `bin\PosSpoolerPlatform.exe`). Drop `$EnableV2 -and $serviceOwnership` at `:733`. Drop `'V2 spooler did not register and complete its first accepted sync.'` at `:735` (that is the `first_v2_accepted_at` bar this task forbids). Manifest tokens at `:736` drop `v2-server.js`; keep `'v2'`, `'bin'`, `'windows-helper'`. The title "keeps V2 opt-in" is what this task abolishes. Retitle to the single-runtime package contract. Keep `:734` `/api/spooler/v2/status`.
  - `it('does not reject owned repair ports and validates the connected spooler identity')` at `:612-619` asserts `Install-Spooler.ps1` contains `/api/spooler/self-status` (`:616`) and `$status.name -eq $SpoolerName` (`:619`). This task deletes the install else-branch that calls that route. Rewrite to `POST /api/spooler/v2/status` plus `agent_id` / `last_sync_at`; drop `connected` / `$status.name`. GREEN runs this file.

- [x] Run RED:

```powershell
npx vitest run backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js
```

- [x] Move the durable agent to `server.js`; rename the shared receipt module without changing its goldens.

- [x] **Resolve every spooler-package test in this task, before its GREEN run.** `pos-spooler-printer/tests/run-tests.js:5` executes *every* `*.test.js` in that directory, sorted, so `npm --prefix pos-spooler-printer test` fails the moment the V1 runtime, `v2-server.js`, `migrateLegacy()`, or the V1 ACK path disappears. Enumerate by every suite that touches any file this task changes, not by grepping for V1 artifact names. Eleven suites are affected; leaving any of them to Task 2 makes Task 1 unreachable.

  | Suite | Breaks because | Disposition |
  | --- | --- | --- |
  | `poll-fallback.test.js` | requires deleted `poll-fallback.js` | **Delete** |
  | `durable-seen-store.test.js` | requires deleted `durable-seen-store.js` | **Delete** |
  | `external-config.test.js` | `:6-24` read V1 `server.js` and assert Socket.IO tokens (`transports: ['websocket', 'polling']`, `createPollFallbackScheduler`, `tryAllTransports: true`); `:7` reads `poll-fallback.js`; `:28` `require('../v2-server')` for `assertProductionConfig`; `:47` and `:57` read and spawn `v2-server.js` | **Rewrite** — drop the V1 `server.js` contract; re-point `assertProductionConfig` and the spawn at `server.js`; keep the production-config coverage |
  | `receipt-display.test.js` | requires the pre-rename `receiptDisplayV1.cjs` | **Edit** — point at `receipt-display.cjs`, goldens unchanged |
  | `v2-job-store.test.js` | legacy fixtures at `:66`, `:67`, `:70`, `:141`, `:145`, `:148` | **Edit** — remove the `seen-print-jobs*` migration cases with `migrateLegacy()` itself |
  | `payload-integrity.test.js` | `require('../server')` at `:65`; calls `verifyQueuedPayloadIntegrity` and `processIncomingPrintJob` at `:84-85` | **Rewrite** — keep payload hashing and integrity refusal |
  | `transport-boundary.test.js` | `require('../server')` at `:163`, `Module._load` interception at `:30`/`:120`, `seen-print-jobs.json` at `:54`, `:197` | **Rewrite** — keep transport uncertainty and write-only boundaries |
  | `spooler-report-rendering.test.js` | `require('../server')` at `:153`; calls `processPrintJob`, `warmRenderingPipeline`, `startupWarmupPromise` | **Rewrite** — keep renderer, raster, and cut behavior |
  | `v2-hostile-runtime.test.js` | `require('../v2-server')` at `:13`; reads `v2-server.js` at `:16`; `:531-532` asserts updater `cutover_prepared` / `v2_application_active` and Repair `v1_drained` | **Edit** — re-point `v2-server` → `server.js`; drop the cutover source scans. **Do not** drop the `printQueue.js` read at `:19` / `:516` here — Task 2 deletes that file and owns that edit |
  | `installerUpdateContract.test.js` (this is `pos-spooler-printer/tests/installerUpdateContract.test.js`, a **different file** from `backend/tests/unit/installerUpdateContract.test.js`) | `:12-16` require journal phases `cutover_prepared`, `v1_drained`, `v1_stopped`, `v2_application_active`; `:68-75` require updater `--rollback-v1` and Repair `Invoke-SpoolerV2Recovery 'rollback-self'` / `/api/spooler/v2/abort-prepare` | **Edit** — drop cutover-phase and V1-rollback assertions; keep exclusive-service, env-preserve, and reboot-recovery coverage that still applies |
  | `http-client.test.js` | `:27-32` reads `server.js` and asserts it contains `fetchWithTimeout(... /api/spooler/ack ..., 10000)` — the V1 ACK path | **Edit** — **retarget**, do not drop. `fetchWithTimeout` is used by `pos-spooler-printer/v2/sync-client.js:19` with `timeoutMs = 10000`. Assert the production sync path uses the bounded helper with that deadline. Keep the hung-fetch timeout coverage of `fetchWithTimeout` at `:18-25`. Dropping the source assertion deletes the only structural proof that the live sync path has a deadline. |

  **Deliberate exclusion:** `pos-spooler-printer/tests/report-html.test.js:208` reads `../server.js` into a variable it never uses. The enumeration rule (“every suite touching any file this task changes”) selects it; the suite does not break on the move, so it stays out of the table. **Delete the dead `serverSource` read** in this task.

  **These three are rewrites, not re-points — budget for that.** The two runtimes share no module surface. V1 `pos-spooler-printer/server.js:589` exports `{ processIncomingPrintJob, processPrintJob, verifyQueuedPayloadIntegrity, warmRenderingPipeline, startupWarmupPromise }`; `pos-spooler-printer/v2-server.js:167-174` is `require.main === module` guarded at `:167`, then exports `{ main, defaultStateRoot, createHelperEventHandler, startupJitterMs, assertProductionConfig }`. The intersection is empty, so `require('../server')` after the move yields none of the functions these suites call. Re-target each assertion at the V2 module that owns the behavior:

  | V1 export under test | V2 owner |
  | --- | --- |
  | `verifyQueuedPayloadIntegrity` | `pos-spooler-printer/v2/printer-transports.js` → `verifyArtifactHash`; job-level identity in `pos-spooler-printer/v2/job-store.js:210-224` |
  | `processPrintJob`, `processIncomingPrintJob` | `pos-spooler-printer/v2/printer-workers.js` → `createPrinterWorkers`; acceptance and outbox in `pos-spooler-printer/v2/agent-runtime.js` |
  | `warmRenderingPipeline` | `pos-spooler-printer/v2/artifact-renderer.js` → `createArtifactRenderer` |

  `v2-server.js` is `require.main === module` guarded at `:167`, so requiring it in a test will not start the agent — but it will not give you the V1 surface either. Do not bulk-delete these suites: they are the only coverage for raster and cut behavior on the affected report printer. Remove individual assertions only where they were V1-transport-specific.

  **Do not re-point these three at `require('../server')` in Task 2.** Task 1's rewrite table is the instruction. The files stay.

- [x] Remove only the spooler package's Socket.IO client:

```powershell
npm --prefix pos-spooler-printer uninstall socket.io-client
```

- [x] Simplify install/update. The success / verify / install paths the fleet actually takes still target `v2-server.js` and still prove V1 socket presence once `$EnableV2` is deleted. Fix all of them in this task, not only rollback:

  - fresh install provisions `server.js`, `v2/`, helper, and runtime while preserving `spooler.env`;
  - **always** `Set-SpoolerApplicationScript 'server.js'` on commit. Today an already-V2 station takes the `elseif ($v2ActiveBefore)` arm at `deployment/windows/Update-Spooler.ps1:504-512` and writes `'v2-server.js'` again. `$v2ActiveBefore` (`:413`) is “NSSM currently points at `v2-server.js`,” which is every station the release gate allows in. **This window is not reproducible today:** when `$v2ActiveBefore` is true, NSSM already points at `v2-server.js`, so `:508` writes the value already there. It becomes harmful the moment this task makes the name actually change. Two executor readings of the current `if/elseif/else` both fail after the move: keep the `elseif` → NSSM is re-pinned to the deleted file; delete both `$EnableV2` arms and fall through to `else` → NSSM is never moved off the deleted file (`Copy-ManagedPayload` / `Remove-RetiredManagedPayload` have already removed `v2-server.js`);
  - **always** verify with V2 register + non-null `last_sync_at` via `Wait-V2Registration` (`deployment/windows/Update-Spooler.ps1:146-156` already waits on `/api/spooler/v2/status` with `station_protocol -eq 'v2'`, matching `agent_id`, and `last_sync_at` — it does **not** require `first_v2_accepted_at`). Delete `Wait-SelfStatus` (`:173-183`, used at `:528`). That function is `GET /api/spooler/self-status`; the route (`backend/routes/spooler.js:59-63`) reports `spoolerRegistry` socket presence (`connected: Boolean(state)`). A V2 HTTP agent never registers a printer socket, so `connected` stays false even while the durable agent is healthy. After Task 2 the route is deleted (404). `backend/tests/unit/installerUpdateContract.test.js:634` pins `"$EnableV2 -or $v2ActiveBefore"` — that is the **registration verification** condition at `:521`, not a reason to keep the else branch. That pin lives inside a whole `it()` this task rewrites (backend-contract disposition below); do not one-line-flip `:634` and leave the rest. After `$EnableV2` is gone, also drop the `$v2ActiveBefore` variable (`:42`, `:413`, `:416`, `:507`, `:521`) — it has no remaining job once NSSM commit and verify are unconditional;
  - **do not** copy the EnableV2 install check that requires `first_v2_accepted_at` (`deployment/windows/Install-Spooler.ps1:275-281`) onto every fresh install. That column is only set when a job moves `sent → local_accepted` (`backend/services/spoolerSync.js:93`). Copying it would refuse to commit until something has physically printed. The bar is registration plus a non-null `last_sync_at`;
  - hoist Install journal, `Register-SpoolerStartupRepair`, and catch-to-Repair **out of** `if ($EnableV2)` (`deployment/windows/Install-Spooler.ps1:199-216`, `:268-284`, `:306-321`). Today those exist only inside the switch; deleting `$EnableV2` without hoisting them removes crash recovery from fresh install. The remaining catch restores `spooler.env` and may delete the service; it does not journal. New Install `targetScript` is `'server.js'`. Accept in-flight Install journals whose `targetScript` is in `@('server.js','v2-server.js')` (`deployment/windows/Repair-SpoolerStartup.ps1:147-149` is equality against `'v2-server.js'` today): ISS `[Files]` copies `Repair-SpoolerStartup.ps1` to `{app}\deployment\windows` (`deployment/spooler/POSAPP-Spooler.iss:56`) **before** `ssPostInstall` runs Install-Spooler. New Repair is already on disk. The scheduled task from an earlier V2 install will run **new** Repair against **old** `targetScript='v2-server.js'`. Treat that value as a leftover commit target to rewrite only after the new payload is present, not as a throw;
  - `Get-ServiceOwnerState` (`deployment/windows/Update-Spooler.ps1:88-95`) **must keep** `v2-server.js` as a recognised existing script, or an already-V2 station becomes `invalid` and `:412` refuses the update;
  - `deployment/windows/Repair-SpoolerStartup.ps1` carries its own entry-point contract and must be updated with the updater, not after it. After this branch it must accept `v2-server.js` only as a *previous* recoverable entry point and always *commit* to `server.js`. Uncommitted recovery restores **previous** files + **previous** NSSM script (`v2-server.js` legal as previous). Committed / `v2_verified` uses `server.js` + new files. Stop using literal `server.js` as the V1 rollback target (`:261`, `:283` currently call `Set-SpoolerRepairEntryPoint 'server.js'` as the V1 rollback arm). After this task, literal `server.js` is the durable agent;
  - **both** halves of H4, in this task: persist `previousScript` / `targetScript` on every Update journal (`Save-SpoolerJournal`), **and** add `Set-SpoolerRepairEntryPoint ([string]$journal.previousScript)` to the catch-all arm at `:291-307`. In-process rollback at `deployment/windows/Update-Spooler.ps1:586` / `:605` does not survive reboot; Repair is the only recovery. If `previousScript` is missing on an old journal, disable the service rather than guess.
  - Once `$EnableV2` is deleted: `:474` always writes `service_stopped`, `:509`/`:511` always `target_application_active`, and `:534` always `committed`. Drop the `v2_registered` Update-journal write at `:526` with the EnableV2 verify branch so Repair's V2-authority arm is actually unreachable from new Update journals. Repair arms after that:
    - `:249` `committed`/`v2_verified` — cleanup, no file restore, no NSSM change. A verified update interrupted before journal removal still hits **this** arm, not catch-all. Keep it. Do **not** fold `committed` into catch-all and do **not** previousScript-repoint it: that would undo a verified update.
    - `:255` cutover (`cutover_prepared`/`v1_drained`/`v1_stopped`) — dead, delete.
    - `:267` V2-authority (`v2_application_active`/`v2_registered`) — dead after the `v2_registered` write is dropped, delete.
    - `:291-307` catch-all — `service_stopped`, `target_application_active`, and other uncommitted Update phases. previousScript NSSM repoint belongs here. Do not special-case those uncommitted phases against each other.
    - `Get-SpoolerV2Authority` (`:65`) and `Wait-SpoolerAcceptedV2` (`:86`) **must survive**: Install-mode recovery still calls them at `:214` and `:244`.
  - failure restores exact prior files **and** the exact prior NSSM application script. Note `deployment/windows/Update-Spooler.ps1:586` and `:605` currently gate `Set-SpoolerApplicationScript` on `$EnableV2`; when `$EnableV2` is deleted that restore must become unconditional, not deleted with it. A rollback that restores the old payload without repointing NSSM leaves the service running the restored **V1** `server.js`, which registers nowhere and prints nothing;
  - other live `v2-server.js` / `ENABLEV2` targets to rewrite in the same pass: `deployment/windows/Install-Spooler.ps1:143` (payload required files), `:181` (owned-script allow-list; keep `v2-server.js` as a recognised *existing* script), `:209` (`targetScript`), `:241`, `:256`; `deployment/windows/SpoolerLayerState.ps1:5` cutover phases (`:4` is the transaction mutex, not a phase list); `:256-269` `preserve_v2` / protocol `v1` install recovery. Drop cutover phases from the required set; keep Install phases, rewritten so the commit target is `server.js`;
  - remove V1 prepare/drain/abort/self-rollback phases and `/ENABLEV2`;
  - retain single-service detection, startup disabling during ambiguous recovery, and transaction-journal durability.

- [x] Add hostile installer tests for old `v2-server.js` -> `server.js`, crash before/after repoint, verification failure, reboot repair, and unchanged env hash. Include one test that a failed update restores the prior entry point when `$EnableV2` no longer exists. Include one test that an Update journal contains `previousScript`/`targetScript`, and one that the Repair catch-all arm repoints NSSM to `previousScript`.

- [x] Run GREEN:

```powershell
npx vitest run backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/spoolerReceiptDisplay.test.js
npm --prefix pos-spooler-printer test
```

- [x] Commit: `refactor(spooler): make durable agent the only runtime`.

---

## Task 2 — Remove V1 server delivery and cutover controls

**Files:**

- Modify root `server.js`.
- Delete `backend/routes/spooler.js`, `backend/services/printQueue.js`, and `backend/services/spoolerRegistry.js`.
- Make `backend/services/printDispatch.js` enqueue-only; update every caller of `dispatchClaimedPrintJobs` and `enqueueAndProcessJobs`. The complete verified call-site list is:
  - `server.js:607` (30-second periodic dispatcher)
  - `backend/routes/print.js:988`, `:1298`, `:1307`
  - `backend/routes/pos/orders.js:1075`, `:1239`, `:1608`
  - `backend/routes/pos/subscriptions.js:764`
  - `backend/routes/admin/subscriptions.js:802`
  - `backend/routes/admin/printTemplates.js:227`
  - `backend/services/printReprint.js:101` (the call is `:101` inside `if (io)` at `:100`)
  - `backend/services/printDispatch.js:118` (inside `dispatchReceiptPrint`, which serves `backend/services/expensePrint.js:9` and `backend/routes/admin/auditReports.js:115` `:305` `:344` `:455`)
- Modify `backend/routes/admin/printers.js` — it owns `spooler-agents/:spoolerId/rollback-v1` at `:252` (delete) alongside `drain` at `:210` and `replace` at `:225` (keep).
- Modify `backend/services/printerStatus.js` — `updatePrinterDeviceStatus` at `:85` exists only to guard V1 writes by protocol (`:97`) and is called only from the deleted `server.js:506` and `:555`. Remove it with its callers; keep `updatePrinterDeviceStatusesForStation`, which V2 uses.
- Modify `backend/tests/manual/spoolerV2MixedJobsHarness.js:267` and `backend/tests/manual/spoolerV2LoadHarness.js:66` — both POST `/api/spooler/v2/prepare`, which this task deletes, and Task 3 requires running the first of them.
- Modify `pos-spooler-printer/v2/sync-client.js:38-55` — still implements `prepare()` → `POST /api/spooler/v2/prepare` and `rollbackSelf()` → `POST /api/spooler/v2/rollback-self`. Delete both methods. Drop `await client.prepare()` at `pos-spooler-printer/tests/v2-sync-runtime.test.js:76`; keep register/sync.
- Modify `pos-spooler-printer/v2/agent-runtime.js:167` — drop `response.station_protocol !== 'v2'` as a pause condition; keep the `ACTIVE_STATUSES` / paused-status arms.
- Modify `backend/tests/unit/schemaAuthority.test.js:407-416` — this suite `fs.readFileSync`s `backend/services/printQueue.js` by literal path. Task 2 deletes that file, so the first GREEN file of a later task would throw `ENOENT` if this is left to Task 3. Retarget or drop the `printQueue` read here; keep the listen-before-migrate assertions against `server.js` and `printerStatus.js`.
- Modify `pos-spooler-printer/tests/v2-hostile-runtime.test.js:19` / `:516` — drop the `printQueue.js` source scan (file deleted). Task 1 already re-pointed `v2-server` → `server.js`.
- Simplify `spoolerAgents.js`, `spoolerSync.js`, `spoolerV2.js`, admin print-queue API, Settings UI, translations (`src/shared/i18n/ar.json:2491` **and the other V1 leftovers listed below**, not “the V1 label set asserted in `src/admin/pages/__tests__/spoolerV2Settings.spec.js:33`” — that array mixes keep-labels with V1 labels), and tests.

  **`delivery_protocol` after this task — verified against every production hit, not taken from the owner.** After the deletions and drops in this task, nothing reads the column for a decision. The two remaining decision conditions are `backend/services/spoolerSync.js:181-184`:

  ```
  const mayDeliverOwned = ['active', 'draining'].includes(locked.status)
      && station.delivery_protocol === 'v2';
  const mayClaimNew = locked.status === 'active'
      && station.delivery_protocol === 'v2';
  ```

  Drop the `&& station.delivery_protocol === 'v2'` conjunctions; keep the agent-status halves. Also drop every other live decision/read of the column in the same pass, or the “dead column” claim is false:

  | Site | Statement | Disposition |
  | --- | --- | --- |
  | `backend/services/spoolerSync.js:61` / `:70` | `SELECT delivery_protocol, first_v2_accepted_at ... FOR UPDATE`; `stationProtocol: station.delivery_protocol` | **Drop the column from the SELECT**; keep `first_v2_accepted_at`. Populate the wire field `station_protocol` as the constant `'v2'` |
  | `backend/services/spoolerAgents.js:249` | drain throws `station_not_v2` unless `delivery_protocol === 'v2'` | **Drop the protocol gate**; keep the `active` agent requirement at `:252-256` |
  | `backend/services/spoolerAgents.js:288` | replace throws the same | **Drop the protocol gate**; keep the live-agent / force / terminalize path |
  | `backend/services/spoolerAgents.js:164` | `station_not_prepared` on `'v1'` | **Delete** with prepare |
  | `backend/services/spoolerAgents.js:137-160` | rollback-reactivate on `'transitioning'` | **Delete** with rollback |
  | `backend/services/spoolerAgents.js:123` | `SELECT delivery_protocol ... FOR UPDATE` for those branches | **SELECT `spooler_id` FOR UPDATE** instead; `:162` same-agent re-register returns `stationProtocol: 'v2'` as a constant |
  | `backend/services/spoolerAgents.js:201` | `authenticateAgent` joins `s.delivery_protocol AS station_protocol` | **Stop selecting it**; throttle at `backend/routes/spoolerV2.js:52` sends the constant |
  | `backend/services/spoolerAgents.js:216-228` | `getStationCutoverStatus` returns `stationProtocol: row.delivery_protocol` | **Stop selecting it**; `/status` (`backend/routes/spoolerV2.js:110-125`) still exists for `Wait-V2Registration` and must keep returning `station_protocol: 'v2'` as a constant when a live agent exists |
  | `backend/services/spoolerAgents.js:181` | `UPDATE ... SET delivery_protocol = 'v2', v2_activated_at = COALESCE(...)` | **Keep.** Inert write. Same for the `INSERT IGNORE ... delivery_protocol) VALUES (?, 'v1')` at `:119` that creates the row |
  | `backend/routes/admin/printQueue.js:78`, `:115`, `:117-128`, `:310-313` | health SELECT and `v1`/`transitioning` branches; `terminalize-v1` | **Stop selecting and returning `delivery_protocol`**; drain/replace stay; rollback/terminalize go |
  | `src/admin/pages/Settings.vue:496`, `:505-510` | protocol label; `v-if` on `delivery_protocol === 'v2'` / `'transitioning'` | **Remove the protocol display and V1 prompts.** Gate drain on `agent_status === 'active'` only (`:505`); gate replace on `['active','draining']` (`:506`). If the `v-if` is left on the column after the API stops returning it, drain and replace never render. Rollback (`:507`, handler `:1415-1420`) and terminalize (`:508`) go away with the V1 prompts |
  | `pos-spooler-printer/v2/agent-runtime.js:167` | pause when `station_protocol !== 'v2'` | **Drop that conjunct**; keep agent-status pauses |

  Schema/baseline/validation keep the column (`deployment/database/baseline.sql:673`, `backend/tests/fixtures/seed.js:876`, `backend/services/schemaValidation.js:920`). Do not edit those in this task.

  Vue spec: flip `src/admin/pages/__tests__/spoolerV2Settings.spec.js:11` so `delivery_protocol` is **absent**; flip `:17-29` so `/rollback-v1` and `terminalize-v1` are **absent**. Keep drain/replace, health polling, and the keep-labels at `:33` (`Print station`, `Last sync`, `Helper`, `Download diagnostics`). Do not treat every string at `:33` as V1 — that list also has live V2 copy. `src/shared/i18n/ar.json` V1 leftovers beyond `:2491`: `"Rollback to V1"` (`:2507`), rollback confirm (`:2514`), V1 outcome strings (`:2516-2517`), `"Legacy"` / `"Old V1 service stopped and checked."` (`:2528-2529`). The word `rollback` at `src/shared/i18n/ar.json:61` is inside a receipt-template string (`"Built-in remains available for rollback..."`), not a V1 transport key — do not delete it. There is no `en.json`; English is the Vue key. No other Vue page carries `delivery_protocol` / `rollback-v1`.

- **Tests, split by disposition.** A test file is not obsolete just because it imports a deleted symbol. Open each before acting. **Do not** re-list `pos-spooler-printer/tests/poll-fallback.test.js` or `durable-seen-store.test.js` here — Task 1 already deleted them.

  *Delete outright* — every case exercises V1 transport or cutover, which stops existing:
  `backend/tests/integration/spoolerPoll.test.js`,
  `backend/tests/integration/spoolerSocketTransport.test.js`,
  `backend/tests/integration/spoolerV2Compatibility.test.js`,
  `backend/tests/integration/spoolerV2Cutover.test.js`,
  `backend/tests/unit/spoolerRegistry.test.js`,
  `backend/tests/unit/spoolerDurableSeenStore.test.js`.

  *Edit, keep the rest* — `backend/tests/unit/printDispatchOwnership.test.js`. Only `:102` ("claims and emits each station only its own jobs") is V1 socket dispatch. The other eight cases cover live behavior that this branch must not regress: enqueue through the supplied transaction executor (`:12`), the trusted kitchen artifact at the durable enqueue seam (`:24`), compile-once per fresh kitchen payload (`:52`), server-only revision override (`:69`), forged receipt-test-marker stripping (`:85`), and the three receipt-printer-selection cases (`:146`, `:151`, `:156`). Delete the one test and its `dispatchClaimedPrintJobs` import; keep the file.

  *Triage case by case, and port to the right layer* — `backend/tests/integration/printQueue.test.js`.

  `:265` ("marks serialized audit documents printed or failed from spooler ACKs") is **the only regression guard for the audit-status behavior this task ports**; rewrite it against the V2 settle path rather than deleting it. That one stays in the backend sync suite, because server settlement is where the write lives.

  The rest do **not** belong in `backend/tests/integration/spoolerV2Sync.test.js`. Under V2 the server no longer owns these behaviors: `backend/services/spoolerSync.js:131` sets `next_retry_at = NULL` on every settle, so retry timing is not a server concern at all, and payload integrity and transport uncertainty are decided in the agent (`pos-spooler-printer/v2/printer-workers.js`, `pos-spooler-printer/v2/agent-runtime.js`, `pos-spooler-printer/v2/printer-transports.js`, `pos-spooler-printer/v2/job-store.js`). Retarget as follows:

  | Case | Behavior | Disposition |
  | --- | --- | --- |
  | `:34` | database hash is authoritative; stored printer/type fields preserved exactly | **Port to backend** — payload identity survives in `printJobIdentity` and the V2 claim projection; assert it against a sync claim |
  | `:56` | acknowledged rows kept as durable history; ack from a different claimant rejected | **Port to backend** — V2 equivalent is agent ownership on settle (`backend/services/spoolerSync.js:116`); `backend/tests/integration/spoolerV2Sync.test.js` does not cover the durable-history half |
  | `:129` | dead-letter after max attempts; retry-due failures stay claimable | **Port to backend** — `backend/services/spoolerSync.js:212` still re-claims due `failed` rows, so the claimable half is live server behavior |
  | `:188` | integrity-mismatch dead-letter | **Port to agent tests** under `pos-spooler-printer/tests/` |
  | `:167` | uncertain outcome never auto-reprinted | **Port to agent tests** |
  | `:208` | kitchen safe-retry timing | **Port to agent tests** — existing V2 worker retry coverage in `v2-printer-workers.test.js` is the home; extend it rather than starting fresh |
  | `:244` | invalid printer configuration | **Port to agent tests** |
  | `:107` | lease-expiry reclaim by another claimant | **Delete** — V1 lease semantics; V2 uses agent ownership plus replay |

  Only genuinely missing **server settlement** behavior belongs in `spoolerV2Sync.test.js`, which already covers permanent-failure dead-lettering (`:274`) and unknown-outcome rejection (`:241`).

  *Edit surviving Task 2 GREEN suites that still contain uncut V1 cases:*

  `backend/tests/integration/spoolerV2Sync.test.js` helper **always** POSTs `/prepare` first (`:18-29`). Every registration test 404s during setup once this task deletes `/prepare`. Rewrite `register()` to skip prepare. Keep the `station_busy` half of `:103` (that is the RED coverage this task asks for at the in-flight guard); delete the transitioning assertion at `:122`. Delete `:535` (`rollbackStationToV1` / rollback-before-acceptance) and the leftover `SELECT delivery_protocol` at `:119`, `:127`, `:555`.

  `backend/tests/integration/spoolerV2Health.test.js` V1 cases, unclassified in rev 5:

  - `:198` late V1 printer-status response overwrite after cutover (`spoolerRegistry.register`, `query_printers_status`)
  - `:273` delayed V1 status after the printer moves
  - `:397` V1 status polling marking a V2 printer offline
  - `:413` connected legacy V1 station visible beside V2 cards
  - `:428` terminalizes only stranded V1 rows after locking a transitioning station

  Delete or retarget those five. Keep only cases that still test “stale writer cannot overwrite” without a V1 socket.

  *Edit* — `backend/tests/integration/printTemplates.test.js`. It exercises `backend/routes/admin/printTemplates.js:227`, which loses its `enqueueAndProcessJobs` dispatch, and calls the surviving `enqueuePrintJobs` directly at `:362-364`. Keep the suite; adjust only the assertions that depended on synchronous dispatch.

  Doing this here rather than at Task 3 keeps the full-suite run free of failures that are neither pre-existing nor regressions.

- [ ] Add RED `backend/tests/unit/spoolerV2OnlyContract.test.js` proving root `server.js` has no V1 route, claimer, dispatcher, or registry; old poll/ack are absent; staff Socket.IO remains.

- [ ] Add RED integration coverage for:
  - idempotent direct registration without prepare;
  - **registration still returns 409 `station_busy` when the station holds `agent_id IS NULL AND status IN ('processing','sent')`** (`backend/services/spoolerAgents.js:167-173`);
  - one active/draining agent per station;
  - sync as the only claim path with replay/cancel preserved;
  - old V1 endpoints return 404 and mutate nothing;
  - drain, forced replacement, cancellation, health, diagnostics, and registration after replacement;
  - no response contains `delivery_protocol`, `rollback_allowed`, or `v1_stranded_count`.

- [ ] Run RED:

```powershell
npx vitest run backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/printQueueCancellation.test.js
```

- [ ] Remove printer Socket.IO registration/dispatch/ack/status and V1 status polling from root `server.js`. Preserve staff/user Socket.IO middleware, rooms, revocation, and health broadcasts. `SPOOLER_KEY` stays: `backend/routes/spoolerV2.js:23` uses it as the V2 bootstrap secret for `/register` and `/status`.

- [ ] Publish the failed-print count after successful V2 settlement, with an observable contract. This is not conditional: `broadcastFailedPrintJobsCount()` has exactly three callers — `server.js:366` (V1 ack, deleted), `:610` (30-second dispatcher, deleted), and `:813`, which runs **once at startup** inside the boot block. Deleting the first two leaves the staff badge computed at boot and never updated again.

  "Broadcast after settlement" is not implementable as written, because `runAgentSync` confirms repeated terminal results idempotently (`backend/tests/integration/spoolerV2Sync.test.js:223`) and a re-confirmation must not look like a new failure. Make the transition observable instead:
  - return a `queueStateChanged` boolean from the sync transaction, true only when a settle actually moved a row into a terminal state (the `UPDATE ... WHERE status NOT IN ('acknowledged','dead_letter','canceled')` at `backend/services/spoolerSync.js:128-152` reports `affectedRows > 0`);
  - in the route, publish through `req.io` **after commit**, never inside the transaction;
  - assert both halves: a new `acknowledged`/`dead_letter` settlement emits exactly once, and repeating the same confirmation emits nothing.

  **The metric being broadcast is the wrong one.** `getFailedPrintJobsCount()` (`server.js:481-484`) is `SELECT COUNT(*) ... WHERE status = 'failed'`. V2 settle writes `acknowledged` / `dead_letter` / `canceled` (`backend/services/spoolerSync.js:26-33`, `:130-137`). It never writes `failed`. `failed` is leftover V1 retry state, which V2 then claims to `sent` (`:218`). After V1 claim/settle are deleted, new failures are `dead_letter`. Emitting on terminal settle refreshes a number V2 will not move. This is already broken for V2 stations today (same shape as the audit-status gap). Count the states the badge is meant to show: at least `failed` + `dead_letter`. Do not claim the staff badge is preserved by re-emitting the old query.

- [ ] Port the audit-report print status writer into V2 settlement. This is mandatory, not an executor choice. The fields are not rendered by any route, so the case rests on durable audit integrity: `backend/routes/admin/auditReports.js:107` and `:236` keep stamping `queued` into a permanent audit record that no V2 path ever advances. The port is roughly ten lines.
  - select `payload` alongside `status` at `backend/services/spoolerSync.js:115-118` (today `:115-118` selects **only** `status` — the plan names the statement that must gain `payload`, not a SELECT that already has it);
  - after the settle UPDATE at `:128-152` succeeds, apply the same `audit_report_documents` write inside the same transaction, covering **both** outcomes exactly as `backend/services/printQueue.js` does — success at `:206` (`last_print_status='printed'`, error cleared, `last_printed_at` stamped) and failure at `:246` (`last_print_status='failed'`, error truncated to 1000 chars). A port that handles only the success path leaves failed prints stuck at `queued`, which is the current bug wearing a new hat;
  - reuse `auditDocumentIdFromPayload` (`backend/services/printQueue.js:37`) rather than re-deriving the id — move it into a small shared module when `printQueue.js` is deleted;
  - the regression guard is the rewritten `backend/tests/integration/printQueue.test.js:265`, which must assert both the printed and failed transitions against a V2 sync settle.

- [ ] Delete V1 poll/ack/self-status routes, V1 claim/mark/settle, and registry.

- [ ] Turn `printDispatch.js` into enqueue-only code. Replace `enqueueAndProcessJobs` with `enqueuePrintJobs`; remove fire-and-forget dispatch calls from every site listed above. The durable agent's next sync is the wake mechanism (currently 2 s idle via `V2_NEXT_SYNC_MS` at `backend/services/spoolerSync.js:2`, longer under throttle `next_sync_ms: 5000` at `backend/routes/spoolerV2.js:48-59`, error backoff, or startup jitter `0–2001` at `pos-spooler-printer/v2-server.js:28-29`); add no second channel. This is sound relative to **today's** V2 path: `backend/services/spoolerSync.js:206-212` claims `pending` plus due `failed`, a superset of what the 30-second retry loop covered for V2 stations, and `claimPrintJobs` already returns `[]` unless `delivery_protocol === 'v1'` (`backend/services/printQueue.js:88-90`). Do not claim a hard ≤2 s bound.

- [ ] Simplify ownership:
  - registration inserts/locks station and is idempotent without prepare/transition checks, **but keeps the in-flight guard**;
  - authentication/sync require the active agent but no protocol branch;
  - retain drain, decommission, replacement, and uncertain-work terminalization;
  - delete prepare, abort, rollback, terminalize-V1 routes/services/audits.

- [ ] Simplify admin UI to station, agent status, sync age, local queue, renderer/helper, printer facts, drain, replace, cancel, reprint, diagnostics. Remove protocol labels and V1 prompts/translations.

- [ ] Run GREEN:

```powershell
npx vitest run backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/unit/printDispatchOwnership.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/auditReports.test.js backend/tests/integration/printTemplates.test.js src/admin/pages/__tests__/spoolerV2Settings.spec.js
```

  Every suite this task edits rather than deletes is in that list except the two spooler-package edits (`v2-sync-runtime.test.js`, `v2-hostile-runtime.test.js`), which Task 3's `npm --prefix pos-spooler-printer test` runs. `printDispatchOwnership.test.js`, `printTemplates.test.js`, and `schemaAuthority.test.js` are there because they survive the task and must be shown to survive it.

  `backend/tests/unit/installerUpdateContract.test.js:629` currently asserts `abort-prepare` and `rollback-self` in `backend/routes/spoolerV2.js`, which this task deletes. That file is not in this GREEN list. Task 1 rewrites the enclosing `it()` against the single-runtime contract and should already have dropped those two tokens; if they remain, drop them here and add this suite to GREEN.

- [ ] Commit: `refactor(server): remove legacy spooler delivery`.

---

## Task 3 — Prove deletion and close the branch

**Files:** update `docs/architecture.json`, regenerate HTML, and add `docs/superpowers/evidence/2026-08-18-spooler-v2-only-removal-verification.md`.

- [ ] Run deletion scan. Only unrelated business-version names in non-spooler code and historical docs may remain:

**Scan A — zero hits required, deployable and runtime files only.** Test files are excluded by design: a contract test proves a token's absence by containing that token inside `not.toContain('ENABLEV2')`, and the new `spoolerV2OnlyContract.test.js` this plan asks for must name every V1 symbol it forbids. Scanning tests for these strings can never reach zero and would push an executor to weaken the very assertions that prove the removal.

```powershell
rg -n -i "terminalize-v1|rollback-v1|abort-prepare|v1_drained|v1_stopped|poll-fallback|durable-seen-store|ENABLEV2|EnableV2|spoolerRegistry|enqueueAndProcessJobs|dispatchClaimedPrintJobs|print_job_response|spoolers_printer_status|receiptDisplayV1|prepareStationCutover|abortStationPrepare|rollbackStationToV1|station_not_prepared|Invoke-V2Prepare|Invoke-V2Abort|Wait-V2Drain|v2PausedRecovery|migrateLegacy|seen-print-jobs|claimPrintJobs|markPrintJobsSent|settlePrintJob|processPendingQueue|rollback-self|/api/spooler/v2/prepare|start:v2|Wait-SelfStatus|self-status|v1_stranded_count|rollback_allowed|--prepare|V1_CUTOVER_OUTCOME_UNKNOWN" server.js backend/routes backend/services pos-spooler-printer src scripts deployment/windows deployment/spooler deployment/tools package.json --glob "!*.md" --glob "!**/tests/**" --glob "!**/__tests__/**" --glob "!node_modules"
```

  Do **not** add `Wait-V2Registration` — that is the surviving V2 verify. Both exclusions are required. `!**/tests/**` does **not** match the Vue convention directory `src/admin/pages/__tests__/`, whose `spoolerV2Settings.spec.js` already carries `rollback-v1`, `terminalize-v1` and `delivery_protocol`, and which will keep carrying them as absence assertions after cleanup.

  Then review **all three** test roots by hand rather than by scan — `backend/tests`, `pos-spooler-printer/tests`, and `src/**/__tests__` — confirming every remaining occurrence is an absence assertion, not a live dependency.

**Scan B — `delivery_protocol` as a live decision, not as a kept column.** The column stays in schema, baseline, seed, schema-validation, applied migration history, and the inert register write. Zero-hit over those files fails under the literal recipe and is not this gate. Require zero hits in routes, UI, installer, and server:

```powershell
rg -n "delivery_protocol" server.js backend/routes src scripts deployment/windows --glob "!**/tests/**" --glob "!**/__tests__/**"
```

  Then inspect, do not forbid, the remaining hits in `backend/services` and schema files. Allowed after Task 2:

  | File | Why it may remain |
  | --- | --- |
  | `backend/services/spoolerAgents.js` | inert `INSERT` default at `:119` and `UPDATE` at `:181` only — no `===` / `!==` branch |
  | `backend/services/schemaValidation.js:920` | required-column probe; the count stays 5 |
  | `deployment/database/baseline.sql:673` | the column is kept |
  | `backend/tests/fixtures/seed.js:876` | the column is kept |
  | `backend/migrations/**`, `deployment/database/hostinger-manual-migrations.sql` | applied history is never edited retroactively (`CLAUDE.md`) |

  A hit in `spoolerSync.js`, `printerStatus.js`, `printQueue.js`, or any `if (station.delivery_protocol` is a failure of this gate. Tests are excluded because Task 2's RED coverage asserts that no response contains `delivery_protocol`, which requires the string.

**Tokens with legitimate survivors — inspect, do not forbid.** A single scan could never reach zero, because three of these tokens have required homes:

| Token | Must survive in | Why |
| --- | --- | --- |
| `socket.io-client` | root `package.json`, `src/**` | Staff/POS Socket.IO is explicitly preserved. Forbid it only under `pos-spooler-printer/`. |
| `v2-server.js` | `deployment/windows/Update-Spooler.ps1`, `deployment/windows/Repair-SpoolerStartup.ps1`, `backend/tests/unit/installerUpdateContract.test.js` | Task 1 requires both the updater and the startup-repair script to accept the installed `v2-server.js` as a prior recoverable entry point and to restore it on failure. |
| `delivery_protocol` | `backend/migrations/**`, `deployment/database/hostinger-manual-migrations.sql`, `deployment/database/baseline.sql`, `backend/services/schemaValidation.js`, `backend/services/spoolerAgents.js` (inert write only) | Applied history is immutable; the column is kept by owner decision. |

  Run these two scoped checks instead of forbidding the tokens outright:

```powershell
rg -n "socket.io-client" pos-spooler-printer --glob "!node_modules" --glob "!**/tests/**" --glob "!**/__tests__/**"
rg -n "v2-server.js" server.js backend/routes backend/services pos-spooler-printer src scripts deployment/spooler deployment/tools deployment/windows package.json --glob "!**/tests/**" --glob "!**/__tests__/**"
```

  `deployment/windows` is included deliberately, and every hit there must be read. `v2-server.js` may appear **only** as a previous/rollback compatibility value in `Update-Spooler.ps1` and `Repair-SpoolerStartup.ps1`. Ban only literal *target* writes: `Set-SpoolerApplicationScript 'v2-server.js'`, `Set-SpoolerRepairEntryPoint 'v2-server.js'`, `targetScript = 'v2-server.js'`. A `ValidateSet('server.js','v2-server.js')` is an allow-list, not a target, and is **not** a failure of this gate.

  Two further names must survive and are **not** V1 delivery: `compiled_document_v1` (load-bearing in the kitchen idempotency key) and `posapp-fresh-baseline-v1` (a manifest id). Neither matches any pattern above; keep it that way.

- [ ] Replace V1/V2 architecture with one flow: enqueue -> authenticated HTTP sync -> durable local journal -> printer worker -> transport -> confirmed result. Verify every changed `file:line` against its named symbol. Line numbers drift: `flow-checkout-receipt-socket` step 3 currently cites `backend/routes/print.js:853` (`docs/architecture.json:3124`); that line is a shift-sales SQL query (`backend/routes/print.js:847-854`). The real `enqueueAndProcessJobs` is `backend/routes/print.js:988`. Kitchen flow cites `backend/routes/print.js:1172` (`docs/architecture.json:3293`); live `:1172` is `SELECT id, parent_id FROM categories`. The enqueue is `backend/routes/print.js:1307` (and `:1298` for the bridge helper). Confirm the named symbol when rewriting. Regenerate HTML; never edit it manually.

  **Address entries by stable `id`, never by array position.** Nodes and flows both carry an `id`; use it. Disposition per entry:

  | id | Kind | Disposition |
  | --- | --- | --- |
  | `prn-spooler-route` | node | **Delete** — `backend/routes/spooler.js` is gone |
  | `prn-queue-service` | node | **Delete** — `backend/services/printQueue.js` is gone |
  | `prn-seen-store` | node | **Delete** — `durable-seen-store.js` is gone |
  | `prn-registry` | node | **Delete** — `backend/services/spoolerRegistry.js` is gone (`docs/architecture.json:883-887`) |
  | `prn-v2-entry` | node | **Merge into `prn-spooler-proc`** then **delete** — after Task 1 both would be `pos-spooler-printer/server.js` (`:1498-1502`) |
  | `prn-printer-status` | node | **Rewrite** — retarget the existing node from the guarded V1 writer `updatePrinterDeviceStatus` to the surviving `updatePrinterDeviceStatusesForStation`; do not delete and recreate it, which would churn the id for no reason |
  | `flow-poll-fallback` | flow | **Delete** |
  | `flow-spooler-id-collision` | flow | **Delete** — `backend/services/spoolerRegistry.js:13` (`docs/architecture.json:3458`) |
  | `flow-spooler-restart-dedupe` | flow | **Delete** — `pos-spooler-printer/durable-seen-store.js:29` (`docs/architecture.json:3323`), `backend/services/printQueue.js:201` (`docs/architecture.json:3351`) |
  | `prn-print-queue-admin-route` | node | **Rewrite, keep** — the admin print-queue API is retained and simplified, not removed |
  | `prn-queue-watchdog` | node | **Keep unchanged** — `printQueueWatchdog.js` is not V1; it aggregates `local_accepted` / `cancel_requested` |
  | `db-spooler-stations` | node | **Keep unchanged** — the table and the column stay; this plan does not rewrite baseline |
  | `dep-baseline` | node | **Keep unchanged** — baseline content and its pinned hash do not change in this plan |
  | `prn-spooler-proc` | node | **Rewrite** — after Task 1 this file **is** the durable agent; current sub still describes WebSocket-first Socket.IO + REST poll (`:1484-1488`) |
  | `prn-dispatch` | node | **Rewrite** — drop `enqueueAndProcessJobs` + Socket.IO (`:823`) |
  | `inf-boot-jobs` | node | **Rewrite** — drop “printer status polling, print-queue retry” (`:764`) |
  | `inf-socket-auth` | node | **Rewrite** — staff/customer remain; drop the spooler-key branch as a printer-delivery path (`:802`) |
  | `auth-socket-mw` | node | **Rewrite** — same (`:1457`) |
  | `core-socket` | node | **Rewrite** — “shared by staff, customer QR, and spooler clients” (`:1464`) is no longer true for printer delivery |
  | `prn-spooler-agents` | node | **Rewrite** — drop cutover + “safe pre-acceptance rollback” (`:890`) |
  | `prn-v2-job-store` | node | **Rewrite** — drop “V1 seen-store migration” (`:904`) |
  | `prn-v2-sync-client` | node | **Rewrite** — drop “preparation” (`:939`) |
  | `flow-spooler-v2-machine-identity` | flow | **Rewrite** — retarget `pos-spooler-printer/v2-server.js:47` (`docs/architecture.json:2924`) and `:58` (`docs/architecture.json:2952`) onto `server.js` after the move |
  | `flow-spooler-v2-local-runtime` | flow | **Rewrite** — retarget `pos-spooler-printer/v2-server.js:46` (`docs/architecture.json:2967`) onto `server.js` |
  | `flow-kitchen-station-routing` | flow | **Rewrite** — step to `prn-seen-store` (`docs/architecture.json:3306`) is a dangling edge once that node is deleted; retarget enqueue to `backend/routes/print.js:1307` |
  | `flow-spooler-v2-delivery` | flow | **Rewrite** — current first step is still `POST prepare` (`docs/architecture.json:2865-2868`) and a later step still cites `backend/services/printQueue.js:69` (`docs/architecture.json:2909`) |
  | `flow-spooler-handshake` | flow | **Delete or rewrite as V2 HTTP register** — entire V1 socket handshake, `spoolerRegistry.register`, `claimPrintJobs` (`:2814`) |
  | `flow-standalone-spooler-install` | flow | **Rewrite** — install flow survives; remove the `/ENABLEV2=1` step |
  | `flow-checkout-receipt-socket` | flow | **Rewrite and rename** — checkout receipt printing survives; it is no longer socket-delivered; cite `backend/routes/print.js:988`, not `:853` |
  | `flow-packaged-update` | flow | **Rewrite** — steps 10–11 still say `-EnableV2`, `v2-server.js`, abort/rollback (`:5006-5014`) |
  | `flow-spooler-v2-admin-health` | flow | **Rewrite** — drop “rollback and V1 cutover terminalization” (`:5083`) |
  | `flow-audited-reprint` | flow | **Rewrite** — step 8 `dispatchClaimedPrintJobs` (`docs/architecture.json:3418-3421`); the call is `backend/services/printReprint.js:101` |
  | `meta.conventions` claim on shared `claimPrintJobs/markPrintJobsSent` (`:41`) | text | **Rewrite** |
  | `meta.invariants` claim that only one live socket per `spooler_id` is accepted (`:87`) | text | **Delete** |
  | `meta.invariants` claim that `delivery_protocol` is the delivery authority (`:88`) | text | **Delete** |
  | `meta.invariants` claim that rollback is allowed only before V2 acceptance (`:89`) | text | **Rewrite** — keep replacement terminalization; drop rollback |
  | `meta.invariants` claim that V1 status writes are guarded by protocol (`:92`) | text | **Rewrite** — keep the V2 half about fresh authenticated `last_sync_at` |

  Re-derive the list before editing (`id` values are stable, positions are not) and confirm nothing outside it still references a deleted file. After the move, merge `prn-v2-entry` into `prn-spooler-proc` (both would otherwise be `server.js`).

- [ ] Run focused combined gates:

```powershell
npx vitest run backend/tests/unit/spoolerV2OnlyContract.test.js backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/schemaAuthority.test.js backend/tests/integration/spoolerV2Sync.test.js backend/tests/integration/spoolerV2Health.test.js backend/tests/integration/printQueueCancellation.test.js backend/tests/integration/auditReports.test.js src/admin/pages/__tests__/spoolerV2Settings.spec.js
npm --prefix pos-spooler-printer test
npm run test:installer
npm run build:admin
npm run architecture
npm run architecture:check
git diff --check
```

- [ ] Run `npm run test:unit` exactly once because this deletes transport/dependencies and changes installer and shared dispatch. Record every failure. A failure is "pre-existing" only if reproduced at branch base. Obsolete suites must already be deleted in Task 2, so no failure here should be explainable as "that test tested V1". This plan does not change schema, so `scripts/validate-schema-drift.js` (via `pretest:unit`) is not in scope as a migration step.

- [ ] Run the 50-job mixed receipt/kitchen/report harness (updated in Task 2 to drop `/prepare`). Require exactly-once terminal outcomes, no starvation, no duplicate idempotency key, bounded renderer/helper concurrency, and restart recovery.

- [ ] Keep physical gates open until tested on Windows: direct TCP, Windows share/Winspool, write-only clone, paper-out model, affected long report printer, DPAPI two-machine, disk-full transitions, and interrupted installer/updater reboot. Automation cannot waive them.

- [ ] Commit: `docs(spooler): verify V2-only delivery architecture`.

## Known traps

- **Old installer media after cutoff.** A station installed from a pre-cutoff package without `/ENABLEV2` gets the V1 agent, which connects by Socket.IO to a server with no printer handler and polls `/api/spooler/poll` for a 404. It reports as installed and running while printing nothing. This fails visibly rather than dangerously, but only gate item 8 prevents it.
- **Old updater media after cutoff — the immediately compatible updater was analysed and is safe; older artifacts were not.** This analysis covers the current dual-runtime `Update-Spooler.ps1` only. Packages predating its `v2ActiveBefore` handling may repoint the service to V1 by other paths and have not been traced; gate item 8 is what actually covers them, by withdrawing every earlier artifact from distribution. For the current updater: the cutover abort path (`deployment/windows/Update-Spooler.ps1:551-570`) is gated on `$cutoverStarted`, which is set only inside `if ($EnableV2)` at `:443-447`, and `$EnableV2` is forced false for an already-V2 station at `:414-418`. So an old updater on an already-V2 station never calls the deleted `/abort-prepare` or `--rollback-v1`. On a still-V1 station it calls `Invoke-V2Prepare` first, which 404s before `$cutoverStarted` or `$rollbackPrepared` is set, leaving the station untouched. Both cases fail safely; gate items 1 and 8 keep them out of the fleet anyway (item 1 because a V1 station with an active printer has zero agents). Do not re-derive this from `backend/tests/unit/installerUpdateContract.test.js:634` — that line pins the *registration verification* condition at `deployment/windows/Update-Spooler.ps1:521`, not the cutover-start condition.
- **`SPOOLER_KEY` looks like V1 config and is not.** It authenticates V1 sockets (`server.js:143`) and V1 poll (`backend/routes/spooler.js:39`), both deleted, *and* V2 bootstrap (`backend/routes/spoolerV2.js:23`), which stays. Removing it from `deployment/templates/pos.env.template` bricks agent registration.
- **`--prepare` in `pos-spooler-printer/v2-server.js:98` is station cutover prepare**, not a platform-helper flag. The statement is `if (process.argv.includes('--prepare')) { const result = await syncClient.prepare(); ... }`. `:103` is `--rollback-v1`, not “V1 station prepare.” `pos-spooler-printer/v2/sync-client.js:38-39` posts `/api/spooler/v2/prepare`. `backend/tests/unit/installerPackageContract.test.js:732` asserts that the **provisioning script** contains `--prepare`, in the same token list as `$EnableV2` and `v2-server.js`. Delete both CLIs with cutover in Task 1; do not preserve them.

## Adversarial checklist

Attack these before completion:

- old poll/ack client after cutoff: 404 and zero mutation;
- installed V2 service still pointing to `v2-server.js`: transactional repoint with exact rollback;
- failed update after `$EnableV2` deletion: NSSM restored to the prior entry point, not left on `server.js` over a restored V1 payload;
- power loss after NSSM is moved to `server.js` but before commit: Repair restores previous files **and** previous NSSM script from the Update journal's `previousScript` (the catch-all arm at `deployment/windows/Repair-SpoolerStartup.ps1:291-307`);
- in-flight EnableV2 Install journal (`targetScript='v2-server.js'`) read by new Repair: accepted as a leftover commit target, not thrown;
- ValidateSet still lists both names, so restore of a still-on-`v2-server.js` machine does not throw;
- duplicate/concurrent registration: one active agent, enforced by `spooler_agents.active_station_key` under `uq_spooler_agents_active_station`;
- registration attempted against a station holding un-owned `processing`/`sent` work: 409, no claim;
- restart with pending/sent/local-accepted/cancel-requested work: safe replay, no duplicate transport;
- drain with owned work: finish owned, claim no new work, then decommission;
- forced replacement: uncertain work dead-lettered, never silently retried;
- printer reassignment during health update: old agent cannot overwrite DB or staff cache;
- audit report printed on a V2 station: document status moves to `printed`; a failed print moves it to `failed` with the error recorded, not left at `queued`;
- 50 mixed jobs across printers: independent lanes, bounded renderer;
- staff Socket.IO auth/broadcast/revocation still works after printer Socket.IO deletion;
- staff failed-print badge counts `failed` + `dead_letter` and updates after V2 settle, not only `status = 'failed'`;
- Settings drain/replace still render, gated on `agent_status` only;
- no live path branches on `delivery_protocol`.

## Plan self-audit

These checks were run against this document and the working tree. Rerun them after any edit to this plan; four leftovers in rev 5 and three statement-vs-line defects across five rounds were things they catch when the *statement* is read, not only the line.

- [ ] **Every `file:line` anchor resolves and names what the prose claims.** Reading the *line* is not enough — read the statement it belongs to. Three defects across five rounds came from an INSERT column list taken for a SELECT, a test assertion matched to the wrong source line, and the `--prepare` trap in H2 (`pos-spooler-printer/v2-server.js:98` opened, the `syncClient.prepare()` statement not read).
- [ ] **Every task's GREEN command can pass using only work scheduled up to that task.** `pos-spooler-printer/tests/run-tests.js` executes every `*.test.js` in its directory, so any spooler test left broken by Task 1 makes Task 1 unreachable regardless of what Task 2 says. Enumerate the suites each task breaks by “every suite touching any file the task changes,” not by grepping for V1 artifact names — that query is what missed `http-client.test.js` in both prior passes. Confirm each appears in that same task's disposition list. Task 1: eleven pos-spooler-printer suites (plus `spoolerReceiptDisplay.test.js` on the vitest GREEN line). `report-html.test.js` is a deliberate exclusion: dead `server.js` read, never used. Task 2: `schemaAuthority.test.js` and `v2-hostile-runtime.test.js`'s `printQueue.js` read, because this task deletes that file. Also `installerUpdateContract.test.js:629` if Task 1 left `abort-prepare` / `rollback-self`.
- [ ] **Every deleted file, function, and route has all its referrers handled in the same task or earlier.** Grep for referrers, then open each one; coupling to a deleted symbol does not make a file obsolete. Two suites were nearly deleted whole for containing one V1 test each.
- [ ] **Every zero-hit scan excludes test roots** — `**/tests/**` *and* `**/__tests__/**` — and every token with a legitimate survivor is listed with where it survives. Scan A vs ValidateSet: ban target writes, not the allow-list. Scan B does not require zero hits in baseline/schema/the inert register write.
- [ ] **Every architecture entry is addressed by stable `id`,** never array position, with an explicit delete / rewrite / keep / merge disposition. Include every node and flow whose `file` this plan deletes, not only the ids that were already in rev 5's table.
- [ ] **Every gate item is provable from the evidence it names,** and no two gate items can deadlock each other on the same row. Item 3 is scoped like item 1, joins the live agent, and does not use `first_v2_accepted_at`. Items 2/6/7 are gone with the schema task.

## Done means

Code-complete means the three task commits plus the review follow-up, clean tree, no live V1 delivery code, recorded focused/full gates, and one-spooler architecture. `delivery_protocol` remaining in schema/baseline/the inert register write is the recorded owner decision, not leftover work. Release-ready additionally requires the fleet-readiness proof (gate items 1, 3, 4, 5, 8) and physical matrix for the target deployment. This plan authorizes no merge, push, deployment, or production migration.

Legacy daemon-based stations (`Get-ServiceOwnerState` = `legacy`, `daemon\posprintspooler.exe`) can no longer be updated; they must be reinstalled. That refusal is intentional and happens in `Fail ... 'blocked_ownership'` before rollback-copy.
