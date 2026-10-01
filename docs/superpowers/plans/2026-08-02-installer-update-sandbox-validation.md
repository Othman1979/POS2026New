# Packaged Update Disposable-Windows Acceptance Plan

> **Luna execution contract:** Execute this plan on `codex/installer-update-path` with `test-driven-development`, ponytail/full, and max effort. Work inline without subagents. Commit each task group. Do not merge or push. Never run an installer or updater against the development host. Preserve the unrelated untracked `posapp.7z` exactly.

**Goal:** Close the remaining evidence gap for the packaged POSAPP Server and POS Print Spooler update path by running the real update EXEs in a disposable Windows environment and proving data/configuration preservation, rollback, idempotency, and reboot recovery.

**Scope:** This plan validates updates from the last packaged baseline at commit `e6938caa` (server `1.0.0`, spooler `1.2.0`) to the current branch release (server `1.0.1`, spooler `1.2.1`). It does not change update architecture, fresh-install behavior, database policy, or physical printing.

**Architecture:** Keep the production updater modules unchanged unless the acceptance run exposes a real defect. Strengthen the existing update smoke probe, add a deliberately narrow silent-mode contract to the two existing Inno sources, then add one host runner and one guest runner. The host prepares a baseline bundle, launches Windows Sandbox with networking disabled, and collects results. The guest provisions the old packaged state, seeds representative business data, forces rollback failures after mutation begins, runs the actual update EXEs, reruns them for idempotency, reboots, and verifies fresh startup-health evidence.

**Why this plan exists:** Static/unit tests and stage probes already cover the updater logic. They cannot prove that a compiled EXE, Windows services, MariaDB, Inno Setup, NSSM, Program Files ACLs, ProgramData configuration, reboot tasks, and spooler registration work together on Windows.

---

## Evidence gathered before planning

1. `tests/installer/update-smoke.ps1` currently calls the installed `verify-install.js` with the original fresh-install `verify.json`. That file pins the old `expectedVersion`, `expectedCommit`, and `expectedSchemaVersion`; after a successful update it can reject the new release. The update smoke must verify the current target explicitly instead of reusing stale fresh-install expectations.
2. The smoke probe currently preserves only table row counts and accepts `after >= before`. Deleting one row and inserting another can pass. Preservation must fingerprint all baseline columns and rows for selected business tables, ordered by their baseline primary keys. Added target columns must not invalidate the fingerprint.
3. `-AfterReboot` currently checks only service state. `tests/installer/fresh-install-smoke.ps1` already has the correct pattern: require startup-health result files newer than the current boot time and successful elevated SYSTEM startup tasks. Reuse that pattern.
4. Both update-only Inno flows require interactive checkbox pages and show custom success `MsgBox` calls. Inno's `/SUPPRESSMSGBOXES` does not suppress custom `[Code]` `MsgBox` calls. The EXEs need an explicit silent acceptance parameter and must skip custom success UI only when `WizardSilent` is true.
5. Inno Setup officially supports `/VERYSILENT`, `/SUPPRESSMSGBOXES`, `/NORESTART`, `/LOG=...`, and custom command-line values through `{param:Name|Default}`. Silent execution must still fail closed unless the dedicated acceptance parameter is present.
6. Windows Sandbox on this machine exposes `wsb start/list/exec/share/stop`. `wsb exec` returns an exit code but no process output, so the guest must write structured results to a writable mapped result folder.
7. Microsoft documents that Windows Sandbox data persists through restarts initiated inside the Sandbox on Windows 11 22H2 and later. Closing the Sandbox remains destructive. This supports a real reboot test on the current host without touching its installed POS services.
8. The current host can validate its own Windows 11-class Sandbox image. It cannot honestly prove Windows 10 build 19045 compatibility. The same guest runner must remain runnable in a reverted Windows 10 22H2 VM, and that row stays `pending` until actually run there.
9. The old and current root/spooler dependency locks differ only in release identity; dependency content is compatible. A detached temporary worktree at `e6938caa` can reuse the current verified vendor/runtime caches to build old stages without downloading or modifying the current worktree, but the runner must first prove the baseline/current dependency entries and vendor lock are identical after excluding only the top-level version fields.
10. A post-mutation rollback can be tested without a production fault-injection flag: after the updater has validated and stopped the relevant service, a guest-only watcher removes a late manifest source file. The managed swap must fail and the updater must restore the old release, metadata, installed manifest, service, and preserved data/configuration.

Official references:

- Windows Sandbox CLI: <https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli>
- Windows Sandbox mapped folders/configuration: <https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file>
- Windows Sandbox lifecycle/reboot persistence: <https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/>
- Inno Setup command line: <https://jrsoftware.org/ishelp/topic_setupcmdline.htm>
- Inno Setup constants/custom parameters: <https://jrsoftware.org/ishelp/topic_consts.htm>

---

## Non-negotiable safety and quality constraints

- Never run `POSAPP-Server-Setup.exe`, `POSAPP-Spooler-Setup.exe`, either update EXE, `Install-PosServer.ps1`, or `Install-Spooler.ps1` on the development host.
- The host runner must refuse to continue if the current host already has any of the test services and a caller attempts a local/guest phase there.
- The guest runner must require both an explicit disposable-environment switch and a private sentinel file created by the host runner. It must also require a Windows workstation x64 VM/Sandbox environment before touching `C:\Program Files` or `C:\ProgramData`.
- Disable Sandbox networking. The spooler talks only to the POS server inside the guest through `127.0.0.1`.
- Map the artifact bundle read-only. Map only the result directory writable.
- Never serialize DB passwords, spooler keys, env contents, or `secrets.json` into result JSON, transcripts, process arguments, or host logs. Store only file hashes and non-secret station identity.
- Use the existing `Install-PosServer.ps1`, `Install-Spooler.ps1`, updater scripts, build script, migration runner, release metadata, and smoke-test helpers. Do not create another installer framework or generic test framework.
- Do not add a production fault-injection switch or change updater behavior merely to make rollback testing easy.
- The exact-data fingerprint must cover the baseline columns that existed before the update, not `SELECT *` after the update. This allows additive schema changes while proving old values were preserved.
- A server failure after target migrations can leave approved additive migrations and their ledger entries applied while application files roll back. That is the designed compatibility contract: the old application must become healthy against the additive schema, and all pre-existing column values must remain identical. Do not claim that schema was rolled back.
- Results under `tests/installer/results` or a temporary validation directory are evidence, not source artifacts, and must remain ignored/uncommitted.
- A passing Windows 11 Sandbox run must not be described as Windows 10 evidence. Physical printer verification remains explicitly outside scope.
- Clean up the temporary detached worktree and stop the Sandbox in `finally`, on both pass and failure.

---

## Target files

Modify:

- `tests/installer/update-smoke.ps1`
- `deployment/server/POSAPP-Server.iss`
- `deployment/spooler/POSAPP-Spooler.iss`
- `backend/tests/unit/installerUpdateContract.test.js`
- `deployment/README.md`

Create only:

- `tests/installer/run-update-sandbox.ps1` — host orchestration and baseline bundle preparation
- `tests/installer/update-sandbox-guest.ps1` — disposable guest phases and evidence writer

Do not create helper modules unless implementation proves that both new scripts contain a substantial, identical block that cannot cleanly remain in one owner. Prefer two explicit scripts over a generic harness hierarchy.

---

## Task 1 — Make the update smoke probe truthful

### Red

Extend `backend/tests/unit/installerUpdateContract.test.js` with contract assertions that fail until `tests/installer/update-smoke.ps1`:

- accepts explicit `-ResultDirectory` and `-BaselinePath` parameters;
- snapshots exact baseline table fingerprints rather than only counts;
- discovers each selected table's baseline columns and primary-key ordering from `information_schema`;
- compares the same baseline columns after update and requires both identical row count and SHA-256;
- verifies current server/schema release without calling `verify-install.js` with stale fresh-install expectations;
- requires startup-health files fresh relative to `LastBootUpTime` when `-AfterReboot` is used;
- never writes credential values to its JSON result.

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js
```

Confirm the new assertions fail for the intended reasons.

### Green

Update `tests/installer/update-smoke.ps1`:

1. Add `-ResultDirectory` and `-BaselinePath`; default them to today's existing locations for manual compatibility.
2. Replace `Get-DbCounts` with a baseline-aware fingerprint function for:
   - `users`
   - `categories`
   - `products`
   - `customers`
   - `orders`
   - `held_orders`
3. At baseline capture:
   - retrieve ordered column names from `information_schema.columns`;
   - retrieve primary-key columns from `information_schema.statistics` ordered by `SEQ_IN_INDEX`;
   - require a primary key for every selected table;
   - safely quote identifiers after validating they contain only normal SQL identifier characters;
   - execute MariaDB in `-N -B` mode selecting those explicit columns ordered by the baseline primary key;
   - hash the exact UTF-8 output and record `columns`, `primaryKey`, `rowCount`, and `sha256`.
4. At comparison, use the column/PK lists stored in the baseline and require exact `rowCount` and `sha256`. A missing/renamed baseline column is a failure.
5. Replace the stale `verify-install.js --config verify.json` call with direct checks of:
   - `/health` target version/commit/schema;
   - `install.json` target release identity;
   - installed `release.json` target identity;
   - automatic migration ledger entries required by the target staged `auto-manifest.json`.
6. Reuse the fresh smoke's `Wait-StartupRepairResult` behavior for server and optional spooler startup-health files.
7. Preserve the existing env/config hashes, ports, station identity, printer-config hashes, and service checks.
8. Make result JSON name its phase and fail with a useful error while the transcript records only non-secret data.

### Verify and commit

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-smoke.ps1 -WhatIf -ResultDirectory "$env:TEMP\posapp-update-smoke-whatif"
```

Commit:

```text
test(installer): make update preservation evidence exact
```

---

## Task 2 — Add a fail-closed unattended contract to the real update EXEs

### Red

Add tests to `installerUpdateContract.test.js` requiring both update-only Inno branches to:

- reject silent mode unless `/ACCEPTUPDATE=1` is present;
- mark both confirmation values only in accepted silent mode;
- skip the update page in accepted silent mode;
- avoid custom success `MsgBox` calls in silent mode;
- leave interactive confirmation pages and messages unchanged;
- never accept or expose a password/key command-line parameter.

Run the focused test and see it fail.

### Green

Modify the existing `UpdateOnly` branches in both `.iss` files, without making separate installer sources:

1. Read `{param:ACCEPTUPDATE|0}`.
2. During initialization, if `WizardSilent` and the value is not exactly `1`, show no custom prompt, return failure, and mutate nothing.
3. In accepted silent mode, set both existing confirmation values and skip their page. Interactive mode remains exactly as now.
4. Guard success-only custom `MsgBox` calls with `if not WizardSilent`. Failure propagation must still produce a nonzero installer exit and the fixed `/LOG` file.
5. Do not pass restaurant data, DB secrets, spooler keys, ports, or paths through command-line parameters.

The acceptance runner will invoke the compiled EXEs as:

```text
/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /ACCEPTUPDATE=1 /LOG="<guest-result-log>"
```

Also test the negative path: silent execution without `/ACCEPTUPDATE=1` must exit nonzero before services, files, metadata, or DB state change.

### Verify and commit

Run the focused test and compile both update variants through the normal build command in Task 4. Commit:

```text
feat(installer): support fail-closed unattended update validation
```

---

## Task 3 — Add the disposable Windows acceptance runner

### Red

Extend `installerUpdateContract.test.js` to require the two scripts and pin the safety contract:

- host runner checks `wsb.exe`, current/previous release identity, artifact sidecars, and clean tracked state;
- host runner uses a detached temporary worktree and cleans it in `finally`;
- Sandbox networking and vGPU are disabled;
- artifact mapping is read-only and result mapping is the only writable share;
- guest runner requires disposable opt-in plus sentinel;
- guest never runs from a host path and refuses non-workstation/non-x64 systems;
- results redact secret fields;
- pre-reboot and post-reboot are distinct phases;
- all external processes have bounded waits/timeouts;
- the runner leaves Win10 and physical-printer rows pending rather than claiming them.

Run the focused test and see it fail.

### Green — host runner

Create `tests/installer/run-update-sandbox.ps1` with these responsibilities:

1. Parameters:
   - `-BaselineCommit` default `e6938caa`
   - `-ResultDirectory` default below ignored `tests/installer/results`
   - optional `-KeepSandboxOnFailure`
   - `-WhatIf`
2. Preflight:
   - Windows workstation x64;
   - `wsb.exe` and Windows Sandbox CLI available;
   - no tracked changes (ignore only `posapp.7z` and generated ignored artifacts; fail on any other tracked dirty state);
   - current update stages, EXEs, and `.sha256` sidecars exist and hashes agree;
   - target versions/commits match current `release.json` and package metadata;
   - baseline commit exists and reports server `1.0.0`, spooler `1.2.0`.
3. Prepare the previous release in a detached temporary worktree:
   - `git worktree add --detach <temp> e6938caa`;
   - link/copy the already verified `deployment/vendor` and root `node_modules` caches;
   - compare baseline/current root and spooler lock package graphs after excluding only top-level release-version fields, and require identical `deployment/vendor-lock.json` before cache reuse;
   - only after that proof, preseed baseline stage `server/node_modules`, `spooler/node_modules`, and spooler Puppeteer `.cache` from the current verified stage;
   - run the old `scripts/build-installers.ps1 -StageOnly -SkipDependencyInstall -OutputRoot <path below old deployment>`;
   - validate old server/spooler stages and copy only the required baseline stages into the disposable bundle;
   - always remove the worktree in `finally`.
4. Build a bundle containing:
   - baseline server/spooler stages and their old provisioning scripts;
   - current server/spooler update stages;
   - current update EXEs and sidecars;
   - guest script plus a random, non-secret sentinel file;
   - no repository `.env` or restaurant data.
5. Start Sandbox with networking disabled and vGPU disabled. Share the bundle read-only and result directory writable.
6. Execute guest `pre-reboot` as `System`. Since `wsb exec` has no stdout, require a phase result JSON and exit marker in the result share. Impose a bounded overall timeout and include installer logs.
7. Request a reboot inside Sandbox. Wait for the Sandbox to return, retrying bounded `wsb exec` calls rather than assuming immediate availability.
8. Execute guest `post-reboot`; require a final pass JSON.
9. Stop Sandbox and delete the temporary bundle/worktree unless `-KeepSandboxOnFailure` was explicitly supplied.
10. Write a host summary containing OS/build, artifact hashes, baseline/target identities, durations, phase results, and remaining pending environments. Never copy secret-bearing guest config files back.

`-WhatIf` must validate inputs and print intended destructive guest paths without starting Sandbox, creating services, or modifying Program Files/ProgramData.

### Green — guest runner

Create `tests/installer/update-sandbox-guest.ps1` with `-Phase pre-reboot|post-reboot`, explicit disposable opt-in, sentinel path, bundle path, and result path.

Pre-reboot phase:

1. Refuse unless:
   - disposable opt-in is present;
   - sentinel matches the host-provided value;
   - the bundle is a mapped read-only source copied to a guest-local working folder;
   - OS is workstation, native x64, build >= 19045;
   - the expected POS services do not already exist before baseline provisioning.
2. Provision the exact packaged baseline state from the old versioned stages by calling that commit's production provisioning scripts with the same response-file/ACL contract used by its installer. This deliberately validates the current update EXEs, not the already-covered old Inno wizard. Use a non-default port set that is known free in the guest. Provision the baseline spooler using the server-generated spooler key read only inside the guest. Never echo that key.
3. Seed nonempty representative rows through the private MariaDB client:
   - category and product;
   - customer;
   - completed order;
   - held order;
   - retain the seeded admin user.
   Use only columns valid in the baseline schema and assert the fixture is queryable through both SQL and server health/login.
4. Add representative spooler state/config files and a queued job marker under installer-owned ProgramData, then capture the baseline through the strengthened update smoke.
5. Negative silent gate: run each update EXE silently without `/ACCEPTUPDATE=1`; require nonzero and require every baseline fingerprint/config/release/service value unchanged.
6. Server rollback drill:
   - copy the current server update stage to a disposable local payload;
   - start a guest-only watcher that waits until `POSApp` becomes stopped, then removes a late manifest source file;
   - invoke `Update-PosServer.ps1` against that payload;
   - require nonzero failure in `managed swap`, old release/metadata/installed manifest restored, service healthy on the old version against any already-applied backward-compatible additive schema, exact pre-existing DB column values/config fingerprint unchanged, and no abandoned rollback directory;
   - record any newly applied migration ledger entries explicitly instead of pretending the schema transaction was reversed.
7. Spooler rollback drill using the same pattern while watching `POS Print Spooler`; require old release/metadata/manifest/service plus exact env, station, printer config, queue/state fingerprints restored. If the intended post-stop failure cannot be induced deterministically, fail the harness—do not report rollback as passed.
8. Run the actual current `POSAPP-Server-Update.exe` and `POSAPP-Spooler-Update.exe` with the approved silent flags and fixed log paths. Require exit code 0.
9. Run strengthened update smoke against the baseline:
   - current server/spooler version and commit;
   - exact baseline business-row fingerprints;
   - unchanged ports/env/my.ini;
   - unchanged spooler key file hash, station identity, printer config, queue/state;
   - migration ledger complete;
   - server/spooler health and ownership exact.
10. Rerun both real update EXEs. Require the `current` path, exit code 0, no new backup, no service restart timestamp change, and no data/config/metadata/manifest change.
11. Write a redacted pre-reboot JSON result and a reboot-request marker.

Post-reboot phase:

1. Read boot time and wait up to four minutes for fresh server and spooler startup-health JSON generated after that boot.
2. Require automatic/recovery configuration and running status for `POSAppMariaDB`, `POSAppPhpMyAdmin`, `POSApp`, and `POS Print Spooler`.
3. Require current target server health and spooler self-status.
4. Rerun the strengthened smoke with `-AfterReboot` against the original baseline fingerprint.
5. Require exact data/config/spooler state preservation again.
6. Write the final result with pass/fail per check, OS/build, versions/commits, artifact hashes, durations, and log paths. List `Windows 10 22H2 VM` and `physical printer output` as pending.

### Verify and commit

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/run-update-sandbox.ps1 -WhatIf
```

Commit:

```text
test(installer): add disposable packaged update acceptance
```

---

## Task 4 — Rebuild and run the real acceptance matrix

1. Confirm tracked worktree clean except planned commits and the unrelated `posapp.7z` remains untouched.
2. Rebuild all four installer artifacts with the canonical command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1
```

3. Verify all four `.sha256` sidecars and size gates.
4. Run the focused installer unit/contracts and existing probes:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-contract-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/server-update-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/spooler-update-probe.ps1
```

5. Run the disposable acceptance:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/run-update-sandbox.ps1
```

6. If any phase fails, use its JSON and Inno/updater logs to identify the first violated invariant. Add the smallest regression test, fix the real owner, rebuild affected artifacts, and rerun the entire disposable acceptance from a fresh Sandbox. Do not weaken a check merely to obtain green.
7. A successful run must prove all of:
   - old packaged baseline state provisioned from the old packaged stages and production provisioning scripts in disposable Windows;
   - wrong silent invocation rejected without mutation;
   - server rollback after stop/mutation restored old state;
   - spooler rollback after stop/mutation restored old state;
   - actual update EXEs reached target releases;
   - baseline business values, configuration, ports, key hash, station identity, printer config, queue/state preserved;
   - automatic migrations applied once;
   - rerun is current/idempotent;
   - reboot produced fresh healthy startup evidence.

Do not commit generated EXEs, stages, logs, result JSON, temporary bundles, or worktrees if they are already ignored by repository policy.

---

## Task 5 — Documentation, final adversarial audit, and handoff

Update `deployment/README.md` with:

- exact interactive update procedure;
- exact unattended flags and the mandatory `/ACCEPTUPDATE=1` gate;
- backup/rollback/current behavior;
- how to run the disposable acceptance;
- where redacted results/logs live;
- honest platform matrix: current Windows 11 Sandbox result, Windows 10 22H2 pending until a real VM run, physical printer pending.

Then perform a final adversarial review:

1. Diff from `af8ec698` and confirm every change belongs to this plan.
2. Search for secrets in tracked changes and result artifacts.
3. Search for forbidden production fault-injection flags, database bootstrap calls in update paths, fresh installer behavior changes, and any host-local installation invocation.
4. Confirm only the two intended new scripts were added.
5. Confirm temporary worktrees and Sandboxes were cleaned up.
6. Confirm `posapp.7z` is still untracked and unchanged.
7. Rerun focused tests after the final edit.

Commit:

```text
docs(installer): document validated packaged update workflow
```

Do not merge or push. Report:

- commits created;
- exact artifacts rebuilt and their sizes/hashes;
- disposable OS/build tested;
- each acceptance phase result;
- any real defect found and fixed;
- Windows 10/physical-printer items still pending;
- final `git status --short`.

---

## Acceptance boundary

This plan is complete only when the current-host disposable Windows run passes from baseline provisioning through post-reboot verification. If Windows Sandbox cannot run for an external host reason, implementation may be complete but acceptance remains blocked; report the exact external blocker and do not relabel static tests as equivalent evidence.
