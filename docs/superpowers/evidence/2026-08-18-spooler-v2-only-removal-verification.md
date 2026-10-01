# Spooler V2-only delivery verification

Date: 2026-08-19  
Branch: `codex/spooler-v2-remove-v1`  
Commits:

- `8cbeb5d6` `refactor(spooler): make durable agent the only runtime`
- `361c924b` `refactor(server): remove legacy spooler delivery`
- `11c2a9ef` `docs(spooler): verify V2-only delivery architecture`
- this commit: `refactor(spooler): remove V1 reprint branch and dedupe queue-state reads`

This plan authorizes no merge, push, deployment, or production migration. Fleet-readiness gate items 1, 3, 4, 5, 8 and the physical printer matrix remain open.

## Deletion scans

### Scan A — deployable and runtime files

Tokens: `terminalize-v1|rollback-v1|abort-prepare|v1_drained|v1_stopped|poll-fallback|durable-seen-store|ENABLEV2|EnableV2|spoolerRegistry|enqueueAndProcessJobs|dispatchClaimedPrintJobs|print_job_response|spoolers_printer_status|receiptDisplayV1|prepareStationCutover|abortStationPrepare|rollbackStationToV1|station_not_prepared|Invoke-V2Prepare|Invoke-V2Abort|Wait-V2Drain|v2PausedRecovery|migrateLegacy|seen-print-jobs|claimPrintJobs|markPrintJobsSent|settlePrintJob|processPendingQueue|rollback-self|/api/spooler/v2/prepare|start:v2|Wait-SelfStatus|self-status|v1_stranded_count|rollback_allowed|--prepare|V1_CUTOVER_OUTCOME_UNKNOWN`

Zero hits in `server.js`, `backend/routes`, `backend/services`, `src` (except `__tests__` absence assertions), `scripts`, `package.json`, and `pos-spooler-printer` (except `tests/`).

`deployment/README.md` still mentions “self-status” in historical prose. Scan A excludes `*.md`.

### Scan B — `delivery_protocol` as a live decision

Zero hits in `server.js`, `backend/routes`, `src` (except the Vue spec absence assertion), `scripts`, and `deployment/windows`.

Inspected survivors:

| File | Why it remains |
| --- | --- |
| `backend/services/spoolerAgents.js` | inert `INSERT ... delivery_protocol) VALUES (?, 'v1')` and `UPDATE ... delivery_protocol = 'v2'`; no `===` / `!==` branch |
| `backend/services/schemaValidation.js` | required-column probe; count stays 5 |
| `deployment/database/baseline.sql` | column kept |
| `backend/tests/fixtures/seed.js` | column kept |
| `backend/migrations/**`, `deployment/database/hostinger-manual-migrations.sql` | applied history, not edited |

No hits in `spoolerSync.js`, `printerStatus.js`, or any `if (station.delivery_protocol`.

### Token survivors

- `socket.io-client` is absent from `pos-spooler-printer/` production code; the package test asserts that. Root `package.json` still lists it for staff/POS Socket.IO.
- `v2-server.js` remains only as a previous/rollback allow-list value in `Update-Spooler.ps1`, `Repair-SpoolerStartup.ps1`, and `Install-Spooler.ps1`. No `Set-SpoolerApplicationScript 'v2-server.js'`, `Set-SpoolerRepairEntryPoint 'v2-server.js'`, or `targetScript = 'v2-server.js'`.
- `compiled_document_v1` and `posapp-fresh-baseline-v1` are unchanged and are not V1 delivery.

### Test-root review

Remaining tokens in `backend/tests`, `pos-spooler-printer/tests`, and `src/**/__tests__` are absence assertions or 404 probes (`spoolerV2OnlyContract`, `spoolerV2Settings.spec.js`, `spoolerV2Sync`/`Health` deleted-route cases, installer contracts). No live import of deleted V1 modules.

Task 2 defect found and fixed during execution: `Repair-SpoolerStartup.ps1` still called `/abort-prepare` and `v2-server.js --rollback-self` after those routes died. Recovery now remaps `rollback_previous` / `rollback_fresh` to restore/remove without a V1 protocol dance.

Scan A still cannot catch a deleted error-code string that never matched a scanned token. `V1_CUTOVER_OUTCOME_UNKNOWN` survived in Settings reprint until this follow-up. Conclusion: do not add a general i18n orphan scanner (English keys live in Vue; Arabic is a catalog and would be noisy). Add deleted spooler error codes such as `V1_CUTOVER_OUTCOME_UNKNOWN` to Scan A, and spot-check `$t('...')` / `t('...')` copy that still names V1, cutover, or rollback.

## Architecture

Updated `docs/architecture.json` by stable `id`, then `npm run architecture` / `npm run architecture:check`.

Deleted nodes: `prn-spooler-route`, `prn-queue-service`, `prn-seen-store`, `prn-registry`, `prn-v2-entry` (merged into `prn-spooler-proc`).  
Deleted flows: `flow-poll-fallback`, `flow-spooler-id-collision`, `flow-spooler-restart-dedupe`.  
Rewritten: enqueue → authenticated HTTP sync → local journal → worker → transport → confirmed result. Checkout receipt flow is no longer socket-delivered. Server.js line anchors that went past EOF after the V1 deletion were retargeted to the named symbols (`startServer`, `onServerStarted`, JoFotara interval, Y-archive cleanup, static serving).

Check: `architecture.json OK: 212 nodes, 56 flows, 422 steps, 4 defects, 152 distinct files — all present`.

## Focused gates

| Gate | Result |
| --- | --- |
| Focused vitest (Task 3 list) | 10 files, 239 passed |
| `npm --prefix pos-spooler-printer test` | passed (`node --check server.js` + `tests/run-tests.js`) |
| `npm run test:installer` | 6 files, 102 passed |
| `npm run build:admin` | passed, vite 6.4.3, 5.69s |
| `npm run architecture` / `architecture:check` | passed |
| `git diff --check` | no whitespace errors (CRLF warnings only) |

## `npm run test:unit` (once)

- `pretest:unit` schema-drift: zero drift between `posapp` and `posapp_test`.
- Independent re-verification of `11c2a9ef`: 271 files / 2977 tests all passing; spooler package suite exit 0; build green.
- The `taxExemptWorkflow` failure recorded at first run is **not a regression**. It fails only when the suite runs before the 06:00 business-day rollover (the original evidence run) and passes after 06:00. The test is owned by a separate task; do not change it here.

## 50-job mixed harness

Updated in Task 2: both harnesses register directly, no `/prepare`.

- Deterministic local: 50/50 `completed`, 20 kitchen / 20 receipt / 10 report, 0 duplicate markers, 0 duplicate submissions, other kitchen lane progressed while printer 1 was offline, recovered kitchen delay 3000ms.
- Live HTTP sync against disposable `*_test` DB: same 50/50 contract, recovered kitchen delay 3174ms, report max delay 157ms. The process then leaked the 30s print-queue watchdog `setInterval` after `pool.end()` (pre-existing harness/server interval ownership, not a delivery regression). The JSON summary printed success before that.

## Physical gates (open)

Not run on this host. Still required before release: direct TCP, Windows share/Winspool, write-only clone, paper-out, long report printer, DPAPI two-machine, disk-full, interrupted installer/updater reboot. Hostile runtime recorded `physical_matrix: not run`.

## Release gate (open)

Fleet upgrade before deploy is still required. Old installer media without `/ENABLEV2` still installs a V1 agent that will 404 against this server. `SPOOLER_KEY` remains the V2 bootstrap secret.

Legacy daemon-based stations (`daemon\posprintspooler.exe`, `Get-ServiceOwnerState` = `legacy`) can no longer be updated. `Update-Spooler.ps1` now `Fail`s those with `blocked_ownership` before rollback-copy. Reinstall with the current package.

## Review follow-up

- Settings reprint no longer special-cases `V1_CUTOVER_OUTCOME_UNKNOWN`. Nothing writes that code anymore.
- `Assert-ExclusiveSpoolerService` only accepts `owned`. Legacy hits `Fail ... blocked_ownership` first; today a raw assert throw was caught with `$rollbackPrepared` still false and rethrown without a structured result code.
- Failed-print badge count lives in `printQueueWatchdog.getFailedPrintJobsCount`. `server.js` already imported that module; `spoolerV2.js` does not import `server.js`, so this avoids a cycle.
- Sync still `SELECT ... FOR UPDATE`s `spooler_stations`, but only `spooler_id`.
- `getStationCutoverStatus` renamed to `getStationStatus` (two production referrers).

Follow-up verification (this commit):

| Gate | Result |
| --- | --- |
| Focused vitest | 6 files, 99 passed |
| `npm run build:admin` | passed, 8.13s |
| Scan A / Scan B | zero hits in required deployable roots (`V1_CUTOVER_OUTCOME_UNKNOWN` added to Scan A) |
| `npm run test:unit` | 271 files, **2979 passed / 2979** (schema-drift zero) |
