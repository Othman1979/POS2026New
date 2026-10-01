# Installer-Owned Startup Self-Repair Implementation Plan

**Goal:** Make the server and spooler installers own safe Windows-startup recovery, persistent diagnostics, and an idempotent rerun repair path without running the full installer transaction at every boot or risking restaurant data.

## Evidence and boundaries

- `POSAppMariaDB`, `POSAppPhpMyAdmin`, `POSApp`, and `POS Print Spooler` already use automatic start and two SCM restart actions.
- `POSApp` already depends on `POSAppMariaDB`.
- The installers do not set `failureflag=1`, so Windows recovery is not explicitly enabled for services that stop with a reported nonzero error.
- The existing clean-VM smoke checks automatic start and recovery configuration but does not verify an installer-owned startup health task or durable startup result.
- Rerunning the server installer already preserves secrets/data and recreates missing POS/Apache services. It does not safely recreate a missing MariaDB service registration over an existing data directory.
- Never execute `Install-PosServer.ps1` automatically at every boot. It performs migrations, archive extraction, backups, firewall work, and full verification; using it as a watchdog would be slow and unsafe.
- Startup self-repair may start/restart known existing services and verify endpoints. It must never initialize, delete, restore, or rewrite database data.
- Missing/corrupt binaries or ambiguous database state must fail closed with a direct instruction to rerun the tracked installer in repair mode.
- Work only on `codex/additive-schema-auto-repair`; do not merge or push. Never touch `posapp.7z`.

## Task 1: Pin the self-repair contract first

**Files:**
- Modify `backend/tests/unit/installerPackageContract.test.js`
- Modify `backend/tests/unit/installerCli.test.js` only if a real non-mutating CLI probe is practical

- [ ] Require server and spooler Inno packages to install their owned startup-repair PowerShell script.
- [ ] Require all installed services to set both `sc.exe failure` and `sc.exe failureflag ... 1`.
- [ ] Require separate SYSTEM startup tasks named `POSAPP Startup Health Repair` and `POSAPP Spooler Startup Health Repair`.
- [ ] Require task retry settings, bounded execution, startup delay, persistent JSON status, and log output.
- [ ] Require server/spooler uninstall to unregister only their own startup task.
- [ ] Require failed fresh-install rollback to remove a newly created server startup task.
- [ ] Require startup repair scripts to contain no database initialization, migration, deletion, restore, or installer recursion.
- [ ] Require the server installer repair path to recreate a missing MariaDB service only through the existing `mariadbd.exe`, existing `my.ini`, and existing initialized data directory; never call `mariadb-install-db` in repair mode.
- [ ] Run the focused contract and prove it fails only for the missing behavior.

## Task 2: Add bounded server startup health repair

**Files:**
- Add `deployment/windows/Repair-PosStartup.ps1`
- Modify `deployment/server/POSAPP-Server.iss`
- Modify `deployment/windows/Install-PosServer.ps1`

The script must:

- [ ] Accept configurable Program Files/ProgramData roots and `StartupDelaySeconds`; support `-WhatIf` without service mutation.
- [ ] Read only ports from protected `install.json`; never read or log credentials.
- [ ] After the scheduled delay, check in dependency order: MariaDB service + TCP port, phpMyAdmin service + HTTP endpoint, POS service + `/health` status and connected DB.
- [ ] For an existing stopped service, start it and wait. For an existing running service with a failed probe, restart it once and probe again.
- [ ] Never recreate a missing service at startup. Record the exact missing service and instruct the technician to rerun `POSAPP-Server-Setup.exe` in repair mode.
- [ ] Aggregate component results into `C:\ProgramData\POSApp\logs\startup-health.json`, append a secret-free `startup-repair.log`, and return nonzero when any required component remains unhealthy.
- [ ] Bound individual connections and total waits so the task cannot hang indefinitely.

The installer must:

- [ ] Package the repair script into `{app}\deployment\windows`.
- [ ] Set `failureflag=1` after configuring recovery for MariaDB, Apache, and POS.
- [ ] Register `POSAPP Startup Health Repair` as SYSTEM/highest, at startup, with a 60-second script delay, `StartWhenAvailable`, three task retries, and a bounded execution time.
- [ ] Track fresh creation for rollback; repair installs update the task in place.

## Task 3: Add bounded spooler startup health repair

**Files:**
- Add `deployment/windows/Repair-SpoolerStartup.ps1`
- Modify `deployment/spooler/POSAPP-Spooler.iss`
- Modify `deployment/windows/Install-Spooler.ps1`

- [ ] Package and register a separate SYSTEM startup task owned by the standalone spooler installer.
- [ ] Set `failureflag=1` for `POS Print Spooler`.
- [ ] After a 75-second delay, safely start the existing service if stopped and verify it reaches Running.
- [ ] Do not treat temporary server/network unavailability as a broken Windows service and do not churn-restart a running spooler merely because the POS server is offline; the spooler already owns reconnect behavior.
- [ ] Persist a secret-free status JSON and repair log under `C:\ProgramData\POS-Spooler\logs`.
- [ ] On missing service, fail closed with a standalone-spooler installer repair instruction.

## Task 4: Make rerun repair close the missing-service gap

**Files:**
- Modify `deployment/windows/Install-PosServer.ps1`
- Modify `deployment/windows/Remove-PosRuntime.ps1`
- Modify `deployment/windows/Remove-SpoolerRuntime.ps1`
- Modify `tests/installer/fresh-install-smoke.ps1`

- [ ] In server repair mode only, if `POSAppMariaDB` registration is missing, require the existing runtime `mariadbd.exe`, existing `database\my.ini`, and an initialized data marker directory (`database\mysql`).
- [ ] If the installed MariaDB executable alone is missing during repair, restore the packaged runtime binaries before service registration while leaving `C:\ProgramData\POSApp\database` untouched. Do not replace a present runtime speculatively.
- [ ] Re-register only the Windows service using `mariadbd.exe --defaults-file=<existing my.ini> --install POSAppMariaDB`. Do not invoke database initialization or alter data.
- [ ] Continue through the existing service configuration, migration, backup, and verification transaction.
- [ ] Uninstall server/spooler tasks with their owning product while preserving ProgramData health history.
- [ ] Extend clean-VM smoke verification to require both SCM recovery flags and installed startup tasks; after reboot require fresh healthy status JSON and zero task result.
- [ ] Document a destructive clean-VM repair drill: delete each service registration one at a time, rerun the correct installer, verify data/release/health, and revert the VM between cases. Do not perform this drill on the development restaurant database.

## Task 5: Verification and release evidence

- [ ] Run `npm run test:installer`.
- [ ] Run focused spooler/migration contracts.
- [ ] Run both repair scripts in `-WhatIf` against isolated temporary metadata roots.
- [ ] Run runtime configuration and smoke `-WhatIf` probes.
- [ ] Run architecture generation/check after adding the startup repair flow.
- [ ] Commit tracked sources, then rebuild both installers from the clean tracked tree.
- [ ] Independently verify sizes, hashes, payload inclusion, and embedded release commit.
- [ ] Record final hashes and explicitly leave real Windows 10/11 reboot/service-deletion drills pending until performed in clean VMs.

## Explicitly not included

- No permanent watchdog service.
- No automatic database initialization, restore, table repair, or destructive filesystem cleanup.
- No full installer transaction at every boot.
- No customer-facing admin UI or cloud monitoring.
- No Windows toast framework.
- No spooler restart merely because the POS server/network is temporarily unavailable.
