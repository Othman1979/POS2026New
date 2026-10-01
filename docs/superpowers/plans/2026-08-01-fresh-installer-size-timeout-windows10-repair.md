# Fresh Installer Size, Timeout, and Windows 10 Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work inline without subagents.

**Goal:** Reduce the fresh server installer from 362.64 MiB to at most 220 MiB, remove the confirmed localhost-probe delay, make slow-service failures identify their exact phase, and define an honest Windows 10/11 x64 acceptance contract without changing POS, database, or printer behavior.

**Architecture:** Keep the existing two offline installers, but make them genuinely independent: the server installer owns POS/MariaDB/phpMyAdmin only, and the standalone spooler installer owns Chromium and printing. Keep the existing ordered PowerShell provisioning transaction; replace only its slow localhost probes and improve phase evidence. Preserve current runtime versions and the full-Chrome spooler renderer in this repair so installer optimization cannot silently change customer or kitchen output.

**Tech Stack:** Inno Setup 6.7.3, Windows PowerShell 5.1, .NET sockets, Node.js 22.23.0, MariaDB 11.8.8, Apache 2.4.68, PHP 8.4.16, phpMyAdmin 5.2.3, Vitest.

## Global Constraints

- Work only on `codex/additive-schema-auto-repair`; do not merge or push.
- Do not touch `posapp.7z` or any unrelated archive.
- Use Ponytail: no new installer framework, bootstrapper, downloader, package manager, or runtime abstraction.
- The installers remain offline and self-contained.
- The server and spooler remain separate installable products with their existing AppIds.
- Installing a spooler on the server machine requires running `POSAPP-Spooler-Setup.exe` after the server installer; the server installer must not embed the spooler payload.
- Preserve MariaDB/phpMyAdmin/POS service ownership, protected secrets, rollback behavior, backups, migrations, firewall scope, and desktop shortcuts.
- Do not change the spooler browser engine in this plan. `chrome-headless-shell` is smaller, but Puppeteer documents that it does not completely match regular Chrome; receipt/kitchen rendering is too important to combine that risk with this repair.
- Supported installation target: Windows 10 22H2 (build 19045) or Windows 11 workstation editions on native x64 hardware. Reject older builds, Windows Server, and non-x64 OS installations instead of pretending they are supported.
- Windows 10 is an application compatibility target even though Microsoft ended general Windows 10 support on 2025-10-14 and MariaDB deprecated Windows 10 package support. Do not claim vendor support.
- A real clean Windows 10 22H2 x64 VM run remains a release gate. Local Windows 11 tests cannot prove Windows 10 installation.
- Mandatory test-first changes and focused commits after each task.

## Evidence Baseline

- `POSAPP-Server-Setup.exe`: 362.64 MiB.
- `POSAPP-Spooler-Setup.exe`: 166.55 MiB.
- Staged server: 609.79 MiB; staged spooler: 562.32 MiB.
- The server installer embeds the complete spooler payload through `deployment/server/POSAPP-Server.iss`, even when the optional task is not selected. Inno still carries those bytes in the downloadable EXE.
- Staged spooler Chromium cache: 408.22 MiB uncompressed.
- Server `install/vendor`: 119.58 MiB, including an unused 34.03 MiB Node ZIP. Provisioning executes `runtime/node/node.exe` and never consumes that ZIP.
- A local three-port closed-loopback benchmark took about 23,912 ms using `Test-NetConnection` and 17 ms using `TcpListener`. `Install-PosServer.ps1` repeats all three port checks after the already-fast wizard check and also uses `Test-NetConnection` inside its MariaDB wait loop.
- Current Inno `Compression=lzma2` already means `lzma2/max`; setting `/max` explicitly documents the contract but is not expected to produce a material reduction.

## Authoritative Compatibility Notes

- Inno Setup supports Windows 10 and 11 and allows build-aware `MinVersion`: https://jrsoftware.org/ishelp/topic_setup_minversion.htm
- `x64os` rejects ARM emulation and accepts native x64 Windows: https://jrsoftware.org/ishelp/topic_archidentifiers.htm
- Inno documents `lzma2/max` as the default and warns that higher levels cost substantially more memory: https://jrsoftware.org/ishelp/topic_setup_compression.htm
- Google lists Windows 10 or later for Chrome: https://support.google.com/chrome/a/answer/7100626
- PHP 8.4 Windows builds use Visual Studio 2022 and may require the VC++ 2015–2022 redistributable: https://windows.php.net/
- Microsoft recommends skipping VC redistributable installation when an equal or newer version is already registered: https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
- Microsoft ended general Windows 10 support on 2025-10-14: https://support.microsoft.com/en-us/windows/deployment/updates-lifecycle/windows-10-support-has-ended-on-october-14-2025
- MariaDB's platform policy deprecated Windows 10 22H2 after October 2025: https://mariadb.com/docs/release-notes/community-server/about/platform-deprecation-policy

---

### Task 1: Pin the repaired installer contract with failing tests

**Files:**
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Modify: `backend/tests/unit/spoolerPackageContract.test.js`

**Interfaces:**
- Consumes: current Inno, PowerShell, payload validator, and build-script text contracts.
- Produces: regression checks that Tasks 2–4 must satisfy.

- [ ] **Step 1: Change the server packaging test to require strict separation**

Assert that `deployment/server/POSAPP-Server.iss`:

```js
expect(script).not.toContain('localspooler');
expect(script).not.toContain('spooler-payload');
expect(script).not.toContain('Install-Spooler.ps1');
expect(script).not.toContain('InstallLocalSpooler');
```

Also assert that `deployment/windows/Install-PosServer.ps1` contains none of those ownership tokens, while `deployment/spooler/POSAPP-Spooler.iss` still owns `Install-Spooler.ps1` and `POSAPP-Spooler-Setup`.

- [ ] **Step 2: Pin the payload and size contracts**

Add checks that:

```js
expect(REQUIRED_PATHS.server).not.toContain('install/vendor/node-v22.23.0-win-x64.zip');
expect(buildScript).toContain('ServerInstallerMaxBytes');
expect(buildScript).toContain('SpoolerInstallerMaxBytes');
expect(buildScript).toContain('220MB');
expect(buildScript).toContain('180MB');
```

Require the server vendor copy allowlist to contain exactly `apache`, `php`, `phpmyadmin`, `nssm`, and `vc-redist`; the Node archive remains a verified build input but not a staged server runtime file.

- [ ] **Step 3: Pin fast probes, phase evidence, and Windows gates**

Add checks that both `.iss` files contain:

```text
MinVersion=10.0.19045
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
Compression=lzma2/max
SolidCompression=yes
```

Assert that `Install-PosServer.ps1`:

```js
expect(script).not.toContain('Test-NetConnection');
expect(script).toContain('System.Net.Sockets.TcpListener');
expect(script).toContain('System.Net.Sockets.TcpClient');
expect(script).toContain('Set-InstallPhase');
expect(script).toContain('Failed phase:');
```

Also pin a small shared `[Code]` check in each `.iss` file that uses `GetWindowsVersionEx` and requires `VER_NT_WORKSTATION`. The installer directives must enforce build 19045 and native x64; the code check only closes the Windows Server gap that `MinVersion` cannot distinguish.

- [ ] **Step 4: Run the tests and prove they fail for the intended missing behavior**

Run:

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js backend/tests/unit/spoolerPackageContract.test.js --reporter=verbose
```

Expected: failures for embedded local spooler, unused Node archive, current architecture/version directives, `Test-NetConnection`, missing phase evidence, and missing size budgets.

- [ ] **Step 5: Commit the red tests**

```powershell
git add backend/tests/unit/installerPackageContract.test.js backend/tests/unit/spoolerPackageContract.test.js
git commit -m "test: pin lean Windows installer contract"
```

---

### Task 2: Make server and spooler installers genuinely independent

**Files:**
- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `deployment/windows/Install-PosServer.ps1`
- Modify: `scripts/build-installers.ps1`
- Modify: `deployment/tools/validate-payload.js`
- Modify: `deployment/README.md`

**Interfaces:**
- Consumes: existing standalone `POSAPP-Spooler-Setup.exe` and locked vendor manifest.
- Produces: server installer containing POS/MariaDB/phpMyAdmin only; spooler remains separately installable on server or terminal machines.

- [ ] **Step 1: Remove the embedded local-spooler task from the server installer**

Delete the server `.iss` `[Tasks]` entry, the spooler-stage `[Files]` entry, and the copied `Install-Spooler.ps1`. Remove `InstallLocalSpooler`, `LocalSpoolerPayload`, its JSON field, its provisioning branch, and its metadata field from `Install-PosServer.ps1`. Preserve tolerance for old `install.json` documents containing the obsolete field by simply ignoring it.

- [ ] **Step 2: Stage only vendor artifacts consumed on the target machine**

In `scripts/build-installers.ps1`, replace the current “all non-MariaDB packages” copy rule with:

```powershell
$serverVendorPackageNames = @('apache', 'php', 'phpmyadmin', 'nssm', 'vc-redist')
foreach ($package in $lock.packages | Where-Object { $serverVendorPackageNames -contains $_.name }) {
    Copy-Item (Join-Path $vendorDir $package.file) (Join-Path $serverStage 'install/vendor') -Force
}
```

Keep the Node ZIP checksum validation and its use for the build toolchain. Keep the expanded MariaDB runtime. Do not move frontend/build dependencies between `dependencies` and `devDependencies`; Hostinger's production build behavior makes that a separate deployment concern.

- [ ] **Step 3: Narrow payload validation**

Remove the Node ZIP from `REQUIRED_PATHS.server`. Define the accepted server vendor archives from the same five filenames already locked by the build and reject any other archive under `install/vendor`. Do not weaken the global forbidden-file checks.

- [ ] **Step 4: Add build-time size regression gates**

After both Inno executables are created, measure their lengths and fail the release build above these budgets:

```powershell
$ServerInstallerMaxBytes = 220MB
$SpoolerInstallerMaxBytes = 180MB
```

Print a compact line for each artifact with bytes and MiB before writing its SHA-256 sidecar. Do not apply size gates during `-StageOnly`, because no EXE is created.

- [ ] **Step 5: Update deployment instructions**

Document that the server package never contains Chromium or spooler code. A server-attached USB printer uses the same standalone spooler installer as terminal B. Record the measured baseline and the new artifact sizes after Task 5's clean build.

- [ ] **Step 6: Run focused tests**

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js backend/tests/unit/spoolerPackageContract.test.js --reporter=verbose
```

Expected: separation/payload/size contract checks pass; probe and Windows checks remain red until Tasks 3–4.

- [ ] **Step 7: Commit**

```powershell
git add deployment/server/POSAPP-Server.iss deployment/windows/Install-PosServer.ps1 scripts/build-installers.ps1 deployment/tools/validate-payload.js deployment/README.md
git commit -m "build: separate server and spooler installers"
```

---

### Task 3: Remove confirmed port-check delay and make timeouts diagnosable

**Files:**
- Modify: `deployment/windows/Install-PosServer.ps1`
- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `tests/installer/runtime-config-probe.ps1`
- Test: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Consumes: loopback ports and the existing ordered provisioning transaction.
- Produces: millisecond localhost checks, condition-based waits, and phase-specific failure reports.

- [ ] **Step 1: Replace `Assert-PortAvailable` with a bind test**

Use the same native behavior as `Get-PortStatus.ps1`:

```powershell
function Assert-PortAvailable([int]$Port) {
    if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid port: $Port" }
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Port $Port is already occupied." }
    finally { $listener.Stop() }
}
```

Keep this second check because it closes the race between the wizard page and provisioning, but it must no longer perform network diagnostics.

- [ ] **Step 2: Replace `Wait-TcpPort` polling with bounded `TcpClient` attempts**

Add a private helper that attempts loopback connection with a 250 ms maximum per attempt, disposes the client every time, and returns a Boolean. Use it in a 90-second condition loop. On timeout include the current service state and relevant stderr/log tail rather than only the port number.

- [ ] **Step 3: Make HTTP waits tolerant and informative**

Keep `Invoke-WebRequest`, use a 90-second overall deadline and a 2-second per-request timeout, preserve the last exception text, and include it in the timeout error. Continue accepting only HTTP status codes 200–499 as the existing contract does.

- [ ] **Step 4: Add phase ownership to the transcript and result error**

Maintain one `$currentPhase` string and call `Set-InstallPhase` before these existing blocks:

```text
preflight
secrets-and-vc-runtime
mariadb-instance
database-bootstrap-and-migrations
apache-phpmyadmin
pos-service
backup-and-verification
shortcuts-and-metadata
```

`Format-InstallError` must include `Failed phase: <name>`. Do not add a second logging framework; `Write-Host` plus the existing transcript/result file is sufficient.

- [ ] **Step 5: Preserve the VC runtime prerequisite**

Keep the existing quiet VC++ runtime installation and allowed exit codes `0` and `3010`. Do not add registry-based skip logic in this repair: the measured delay is in network diagnostics, and skipping a prerequisite based only on registry state could hide a damaged runtime.

- [ ] **Step 6: Clarify the blocking installer status**

Change the Inno status text to state that first-time database and private web-tool setup may take several minutes on a slower PC and must not be closed. Do not introduce asynchronous Pascal polling or a custom wizard progress protocol.

- [ ] **Step 7: Add a runtime probe for the fast-port helper**

Extend `tests/installer/runtime-config-probe.ps1` to extract/evaluate the socket helper without mutating services, check one temporary occupied listener and one free port, and require completion within 2 seconds. This is a regression ceiling, not a microbenchmark claim.

- [ ] **Step 8: Run focused verification**

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js --reporter=verbose
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/runtime-config-probe.ps1
```

Expected: both commands exit 0; no `Test-NetConnection` remains in server provisioning.

- [ ] **Step 9: Commit**

```powershell
git add deployment/windows/Install-PosServer.ps1 deployment/server/POSAPP-Server.iss tests/installer/runtime-config-probe.ps1 backend/tests/unit/installerPackageContract.test.js
git commit -m "fix: remove installer port probe delays"
```

---

### Task 4: Enforce the Windows 10/11 workstation x64 target honestly

**Files:**
- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `tests/installer/fresh-install-smoke.ps1`
- Modify: `deployment/README.md`
- Test: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Consumes: Inno OS/architecture checks and the clean-VM smoke harness.
- Produces: installers that reject unsupported OS/architecture combinations and acceptance evidence that records the actual Windows build.

- [ ] **Step 1: Set installer gates**

Set the same directives in both `.iss` files:

```ini
MinVersion=10.0.19045
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
Compression=lzma2/max
SolidCompression=yes
```

Do not claim ARM64 compatibility with x64 emulation; the MariaDB/Apache/PHP/Chrome payload is locked and tested as Windows x64.

- [ ] **Step 2: Reject Windows Server explicitly**

Add the smallest shared `[Code]` helper to both `.iss` files. In `InitializeSetup`, call Inno's `GetWindowsVersionEx`, require `ProductType = VER_NT_WORKSTATION`, and show a direct unsupported-OS message before returning `False` otherwise. Do not introduce a general OS-detection module.

- [ ] **Step 3: Record OS evidence in the clean-VM harness**

Before service checks, collect `Win32_OperatingSystem.Caption`, `Version`, `BuildNumber`, `ProductType`, and `OSArchitecture`, plus `Win32_ComputerSystem.SystemType`, into `$results.environment`. Fail unless build is at least `19045`, `ProductType` is workstation (`1`), `OSArchitecture` is `64-bit`, and `SystemType` identifies x64 rather than ARM64. Print the environment record into the transcript.

- [ ] **Step 4: Define the acceptance matrix**

Document two mandatory clean, reverted VM rows for the same installer hashes:

```text
Windows 10 22H2 x64 (build 19045): server fresh install, standalone spooler, reboot recovery, conflict ports.
Windows 11 x64: server fresh install, standalone spooler, reboot recovery, conflict ports.
```

The current development host is Windows 11 build 26200; it cannot close the Windows 10 row.

- [ ] **Step 5: Run parser and contract checks**

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js --reporter=verbose
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/fresh-install-smoke.ps1 -WhatIf
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```powershell
git add deployment/server/POSAPP-Server.iss deployment/spooler/POSAPP-Spooler.iss tests/installer/fresh-install-smoke.ps1 deployment/README.md backend/tests/unit/installerPackageContract.test.js
git commit -m "build: gate installers to Windows 10 and 11 x64"
```

---

### Task 5: Build, measure, and attack the repaired packages

**Files:**
- Modify if flow ownership changed: `docs/architecture.json`
- Regenerate only: `docs/architecture.html`
- Modify: `deployment/README.md`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: final artifacts, hashes, measured size evidence, and an explicit remaining Windows 10 VM gate.

- [ ] **Step 1: Run all focused installer tests**

```powershell
npm run test:installer
npx vitest run backend/tests/unit/spoolerPackageContract.test.js backend/tests/unit/pendingMigrationCli.test.js --reporter=verbose
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/runtime-config-probe.ps1
```

Expected: all exit 0.

- [ ] **Step 2: Build both installers from the committed tree**

The build requires a clean tracked tree. Commit any Task 4 documentation/test adjustments first, then run:

```powershell
npm run build:installers
```

Expected: server payload validation, spooler payload validation, both Inno compiles, size budgets, and SHA-256 sidecars pass.

- [ ] **Step 3: Verify artifact hashes and sizes independently**

```powershell
Get-Item deployment/out/POSAPP-Server-Setup.exe, deployment/out/POSAPP-Spooler-Setup.exe | Select-Object Name,Length
Get-FileHash deployment/out/POSAPP-Server-Setup.exe -Algorithm SHA256
Get-FileHash deployment/out/POSAPP-Spooler-Setup.exe -Algorithm SHA256
```

Expected: server at most 220 MiB; spooler at most 180 MiB; calculated hashes exactly match `.sha256` sidecars.

- [ ] **Step 4: Prove payload separation**

Validate both stages and assert the server stage has no spooler or unused Node archive:

```powershell
node deployment/tools/validate-payload.js (Resolve-Path deployment/out/stage/server) server
node deployment/tools/validate-payload.js (Resolve-Path deployment/out/stage/spooler) spooler
Test-Path deployment/out/stage/server/install/vendor/node-v22.23.0-win-x64.zip
```

Expected: both validators exit 0; `Test-Path` prints `False`.

- [ ] **Step 5: Update architecture and release evidence**

Update the deployment flow to show standalone spooler ownership and fast socket preflight, then run:

```powershell
npm run architecture
npm run architecture:check
git diff --check
```

Record the exact artifact byte counts, hashes, release commit, local Windows 11 verification, and the still-open Windows 10 VM row in `deployment/README.md`. Never write “Windows 10 verified” until the clean VM record exists.

- [ ] **Step 6: Final commit**

```powershell
git add deployment/README.md docs/architecture.json docs/architecture.html
git commit -m "docs: record lean installer release evidence"
```

## Explicitly Deferred

- Switching the spooler from full Chrome to `chrome-headless-shell`. Official Puppeteer guidance says shell is smaller/faster but not behavior-identical; evaluate it only with a separate receipt/kitchen rendering and physical-printer plan.
- Reclassifying frontend dependencies to shrink server `node_modules`. Hostinger previously omitted Vite during production installation, so dependency ownership must be solved across cloud builds before changing it.
- Online/download-on-demand runtimes. Restaurants need an offline installer.
- Authenticode signing and SmartScreen reputation.
- Existing-XAMPP upgrade/migration is performed manually by the technician; no automated product path is planned.
