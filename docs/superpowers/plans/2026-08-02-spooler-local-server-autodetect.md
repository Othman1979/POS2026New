# Spooler Local Server Auto-Detection Implementation Plan

> **For Luna:** Execute this single integrated task with mandatory test-driven development. Work inline without subagents on `codex/installer-update-path`. Commit the implementation. Do not merge or push. Do not start Windows Sandbox and do not run either Setup or Update EXE.

**Goal:** When fresh POS Print Spooler Setup runs on the same machine as a valid packaged POSAPP Server, automatically use its loopback URL and generated spooler key, skip the redundant URL/key wizard pages, and retain the existing manual workflow everywhere else.

**Architecture:** Add one narrow PowerShell detector invoked by the existing elevated Inno wizard. It reads only packaged-server authority (`C:\ProgramData\POSApp\install.json` and protected `config\secrets.json`), validates ownership/port/key, verifies loopback health, and writes two lines to a caller-created protected temporary file. The existing Inno wizard consumes those values and conditionally skips two pages; `Install-Spooler.ps1` remains the single provisioning owner.

**Tech Stack:** Inno Setup 6, Windows PowerShell 5.1, Vitest.

## Global constraints

- Ponytail/full: no LAN scanning, UDP discovery, registry service, backend endpoint, configuration framework, or new dependency.
- Auto-detection applies only to fresh, non-`UpdateOnly` spooler Setup.
- Authoritative server ownership requires AppId `{E99DB275-DDA0-43A0-95CD-7AE07185122C}`.
- Derive URL exactly as `http://127.0.0.1:<install.json posPort>`; never guess port 3000.
- Read the key only from `C:\ProgramData\POSApp\config\secrets.json` property `spoolerKey`. It must match the generated 32-byte base64url shape: exactly 43 characters from `[A-Za-z0-9_-]`.
- Detection succeeds only when `/health` returns `status=ok`, `db=connected`, and a nonempty `release.version`.
- On missing, malformed, mismatched, inaccessible, or unhealthy local server evidence, return “not detected” and show the existing manual URL/key pages unchanged.
- Never print, log, display, serialize into installer messages, or pass the key through command-line arguments.
- The Inno caller must create the temporary result file first and restrict it to SYSTEM and Administrators with `icacls`; the detector only overwrites that protected file.
- Delete the detection result in `finally` after loading it.
- Do not change `Install-Spooler.ps1`, server installer behavior, update-only behavior, station ID/name workflow, repair semantics, service registration, or backend code.
- Do not run Sandbox or install any EXE. Verification is focused tests, PowerShell parsing/probe, canonical artifact build, and checksum validation only.

## Files

- Create: `deployment/windows/Detect-LocalPosServer.ps1`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Create: `tests/installer/local-spooler-detection-probe.ps1`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

## TDD execution

### 1. RED: pin the contract

Add a focused test in `installerPackageContract.test.js` that requires:

- both new PowerShell files exist;
- fresh spooler `.iss` embeds the detector with `dontcopy`, calls `ExtractTemporaryFile`, protects the result with `icacls`, and deletes it;
- the wizard stores a `LocalServerDetected` Boolean and skips only `ServerPage` and `KeyPage` when true;
- StationPage is never skipped by local detection;
- the detector references the exact AppId, `install.json`, `config\secrets.json`, `spoolerKey`, `127.0.0.1`, `/health`, `status`, `db`, and `release.version`;
- the detector contains no port scan/discovery and emits no key to stdout;
- `Install-Spooler.ps1` remains unchanged by this task.

Run:

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js
```

Confirm failure because the detector/probe and Inno wiring do not yet exist.

### 2. GREEN: implement the detector

Create `Detect-LocalPosServer.ps1` with this interface:

```powershell
param(
    [Parameter(Mandatory)][string]$ResultFile,
    [string]$ProgramDataRoot = 'C:\ProgramData\POSApp',
    [int]$HealthTimeoutSeconds = 4
)
```

Behavior:

1. Require `ResultFile` to already exist as a file.
2. Read and validate `install.json` and `config\secrets.json`.
3. Require exact packaged AppId, integer port 1–65535, and exact 43-character base64url key.
4. Call `http://127.0.0.1:<port>/health` with the bounded timeout.
5. Require healthy status/database/release.
6. Atomically overwrite the existing result with exactly two UTF-8-no-BOM lines: URL then key.
7. Exit `0` on detection. For every unavailable/invalid/unhealthy case, leave no secret output and exit `2`.

Do not add a verbose mode or partial-detection format.

### 3. GREEN: wire the existing wizard

In the fresh `[Files]` branch add the detector as a `dontcopy` temporary file.

In the non-`UpdateOnly` wizard branch:

1. Keep creating ServerPage, KeyPage, and StationPage so manual fallback is unchanged.
2. Run a `TryDetectLocalPosServer` function during `InitializeWizard` only when this is not a repair install.
3. Pre-create the detector result file, restrict it with the same SYSTEM/Administrators `icacls` contract already used for `spooler-response.json`, extract the detector, and invoke PowerShell without putting the key in arguments.
4. Accept only exit `0` plus exactly two valid nonempty lines; populate ServerPage/KeyPage values and set `LocalServerDetected := True`.
5. On any other outcome, retain `False` and empty/manual fields without aborting Setup.
6. Delete the result file in `finally`.
7. Extend the existing `ShouldSkipPage` so a valid local detection skips only ServerPage and KeyPage. StationPage remains visible.
8. Keep final `spooler-response.json` creation and `Install-Spooler.ps1` invocation unchanged so provisioning still has one owner.

### 4. Behavioral probe

Create `local-spooler-detection-probe.ps1` using only temporary directories and a local test HTTP listener/job. It must verify:

- valid packaged metadata + valid key + healthy response => exit `0`, exact loopback URL/key result, no key on stdout;
- missing metadata => exit `2`;
- wrong AppId => exit `2`;
- invalid key => exit `2`;
- unhealthy response => exit `2`;
- temporary fixtures are removed in `finally`.

The probe must not read real `C:\ProgramData\POSApp` and must not install or start Windows services.

### 5. Verification and artifact build

Run:

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerUpdateContract.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/local-spooler-detection-probe.ps1
```

Parse all touched PowerShell files with `System.Management.Automation.Language.Parser`, run `git diff --check`, then run the canonical builder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1
```

Verify all four generated `.sha256` sidecars. Do not run any installer, updater, Windows Sandbox, or service mutation.

### 6. Review and commit

Review the diff against the global constraints. Search tracked changes for accidental key logging, command-line secrets, port scanning, backend edits, and `Install-Spooler.ps1` changes. Preserve unrelated `posapp.7z` exactly.

Commit:

```text
feat(installer): detect local POS server for spooler setup
```

Report the commit, focused test/probe results, artifact sizes/hashes, and final `git status --short`. Do not merge or push.
