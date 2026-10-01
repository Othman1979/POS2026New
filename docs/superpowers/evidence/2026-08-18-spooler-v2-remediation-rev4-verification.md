# Spooler V2 Remediation Rev 4 — Verification Report

Date: 2026-08-18

Branch: `codex/spooler-v2-local-print-agent-continued`

Starting HEAD: `28c97aa3`

Status: automated verification passed; physical-printer and interrupted-Windows hardware gates remain open.

## Corrected defects

- Windows helper loss after the durable transport marker is classified `uncertain`; loss before the marker remains retry-safe.
- State-root stale-lock recovery is proven with two production-authorized Node processes crossing the same barrier. A deterministic stale-owner hard-link tombstone admits exactly one lock owner; the other contender fails closed.
- Installer ownership changes use one durable `Install` journal with exactly four phases: `install_prepared`, `install_v2_active`, `install_v2_registered`, and `install_committed`.
- Installer and updater recovery scripts are shared, hash-verified, and installed before the journal can authorize mutation.
- Reboot recovery consults authoritative station ownership. Unavailable, mismatched, or contradictory ownership disables the Windows service and retains recovery evidence instead of guessing.
- Updater journals persist `spoolerId`, allowing authoritative recovery to compare the local agent with the server-owned station.
- Print cancellation reuses `requestPrintJobCancellation`; it permits only `pending`, `sent`, and `local_accepted`, returns stable API codes, writes one outcome-specific audit event in the same transaction, and exposes a single confirmation action in the existing UI.
- Duplicated cancellation service and duplicate UI tests introduced by the previous implementation were removed.

## RED evidence reproduced before fixes

1. `node pos-spooler-printer/tests/v2-platform-helper.test.js`
   - Failed because helper exit inside `beforeWrite` returned `PLATFORM_HELPER_RESTARTING` without the required post-marker `uncertain` classification.
2. `npx vitest run backend/tests/integration/printQueueCancellation.test.js src/admin/pages/__tests__/spoolerV2Settings.spec.js`
   - 10 failures: wrong response field/codes, unsafe `processing` and repeated `cancel_requested` acceptance, wrong audit semantics, and modal-based UI.
3. `npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js`
   - Failed because the required Install journal phases, shared recovery implementation, and power-loss decision matrix were absent.
4. `npx vitest run backend/tests/unit/installerUpdateContract.test.js -t "persists station identity"`
   - Failed because updater journals omitted `spoolerId`.

## GREEN evidence

- Focused backend/UI gate: 4 files, 95 tests passed.
- `node pos-spooler-printer/tests/v2-platform-helper.test.js`: passed.
- `node pos-spooler-printer/tests/v2-hostile-runtime.test.js`: all hostile rows passed; the production-shaped two-authorized-contender barrier passed 15 consecutive runs; physical matrix explicitly not run.
- PowerShell parser: `SpoolerLayerState.ps1`, `Install-Spooler.ps1`, `Update-Spooler.ps1`, and `Repair-SpoolerStartup.ps1` all parse cleanly.
- `npm --prefix pos-spooler-printer test`: passed, including helper, transports, workers, status monitor, artifact renderer, journal, and hostile runtime suites.
- `npm run architecture` and `npm run architecture:check`: passed; 217 nodes, 59 flows, 446 steps, 4 documented defects, 156 distinct files.
- `npm run build:admin`: passed.
- `npm run test:unit`: schema drift preflight reported zero drift; 277 files and 2,994 tests passed in 1,118.06 seconds.
- `git diff --check`: passed.

## Gates that are still open

Automated evidence does not approve a customer canary. The following require the controlled Windows/printer lab and were not run here:

- affected long-report printer and its exact driver/firmware path;
- direct TCP thermal printer;
- Windows shared printer;
- write-only printer clone;
- paper-out and recovery behavior on the target model;
- DPAPI identity behavior across two physical machines;
- disk-full injection at each journal transition;
- interrupted fresh install, repair install, updater cutover, rollback, and reboot on Windows.

No deployment, merge, push, installer build, version bump, production migration, or customer-system action was performed.
