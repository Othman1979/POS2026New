# Spooler Updater Layered Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordinary POS spooler updates small and fast by updating only spooler application files while preserving the installed `spooler.env` byte-for-byte and retaining fail-closed runtime compatibility, rollback, service ownership, release verification, durable queue state, and no-duplicate-print invariants.

**Architecture:** Split the spooler into an application layer and an immutable runtime layer. `POSAPP-Spooler-Update.exe` carries only the application layer and requires an already-attested matching runtime layer. `POSAPP-Spooler-Runtime-Update.exe` is the explicit one-time/exception path that stages and swaps `node_modules` and Puppeteer Chromium before establishing the runtime attestation required by later core updates.

**Tech Stack:** PowerShell 5.1, Inno Setup 6.7.3, Node.js 22.23.0, npm lockfile v3, Vitest, existing installer probes and disposable Windows 10/11 acceptance VMs.

## Global Constraints

- Scope is the spooler updater only. Do not modify `deployment/windows/Update-PosServer.ps1`, server update staging, server update manifests, database backup behavior, migrations, server installer behavior, or server updater tests except to prove no regression from shared tooling.
- `C:\ProgramData\POS-Spooler\config\spooler.env` is the sole authority for mutable spooler configuration.
- Every updater path must leave `spooler.env` byte-for-byte unchanged on success, refusal, failure, and rollback. Do not normalize, regenerate, reorder, restore, or rewrite it.
- Preserve every unknown/comment/custom line in `spooler.env`, including customer-specific portless origins such as `https://hashemi.shawermajwana.com`.
- Parse the stored URL for requests in memory only. Never write the parsed or normalized value back to disk.
- Never include `spooler.env`, `SPOOLER_KEY`, certificates, private keys, logs, durable seen-store files, queue state, or printer configuration in either updater payload, result, progress output, metadata, or rollback set.
- Do not run `npm install`, `npm ci`, Puppeteer download, or any network dependency installation on a customer machine.
- Do not silently accept an unknown runtime. A core update must refuse before stopping the service when runtime attestation is absent or mismatched.
- Runtime transition may be expensive once. It must stage before stopping the service and retain the old runtime directories until target self-status succeeds.
- Updater, direct-script execution, and startup repair must serialize through the same machine-wide transaction lock. No second actor may inspect or mutate an in-progress transaction.
- Uncertain/in-flight print jobs remain governed by the durable seen-store and dead-letter rules. The updater must never delete, rewrite, or replay state.
- During any mutation window, Windows must be unable to auto-start a partially updated spooler. The transaction temporarily disables service startup and restores the recorded original startup mode only after commit or rollback recovery.
- Keep the existing spooler AppId `{80657A48-9BCB-4455-8CA9-A18139FDFC58}` and service name `POS Print Spooler`.
- Keep fresh spooler installer URL-entry/autodetection changes out of this plan. The updater must support manually provisioned online origins; redesigning fresh provisioning is deferred.
- Keep the pre-existing untracked `docs/superpowers/plans/2026-08-11-hostinger-database-connection-resilience.md` untouched.

---

## Locked File Structure

- Create `deployment/tools/spooler-layer-manifest.js`: build-time canonical inventory and content-ID generator for application, dependency, and browser layers.
- Create `deployment/windows/SpoolerLayerState.ps1`: spooler-only URL validation, layer-attestation validation, environment hash guarding, staging, directory swap, and rollback helpers.
- Modify `scripts/build-installers.ps1`: produce core and runtime-transition stages without duplicate dependency copies; calculate layer descriptors and enforce size/content gates.
- Modify `deployment/spooler/POSAPP-Spooler.iss`: compile the normal core updater and explicit runtime-transition updater, passing the update mode to PowerShell.
- Modify `deployment/windows/Update-Spooler.ps1`: consume the new layer contract, stop treating duplicated configuration in `install.json` as authority, preserve `spooler.env`, and select the core or runtime-transition transaction.
- Modify `deployment/windows/Repair-SpoolerStartup.ps1`: reconcile an interrupted spooler update transaction before attempting ordinary service repair.
- Modify `deployment/tools/validate-payload.js`: validate both spooler updater payload kinds and reject forbidden configuration/runtime content.
- Modify `backend/tests/unit/installerUpdateContract.test.js`: pin staging, layer, URL, preservation, rollback, secret-exclusion, and size contracts.
- Modify `tests/installer/spooler-update-probe.ps1`: filter progress records before JSON parsing and exercise portless HTTPS, stale metadata, exact env preservation, layer refusal, success, and rollback.
- Modify `tests/installer/update-contract-probe.ps1`: exercise application-only union rollback and runtime directory-swap rollback.
- Modify `tests/installer/update-smoke.ps1`: record installed layer identities and prove env/config/state hashes are unchanged.
- Modify `deployment/README.md`: document the core-versus-runtime decision and recovery procedure.
- Modify `docs/architecture.json`, then regenerate `docs/architecture.html`: record the new spooler-only layered update flow. Do not change the server update flow.

## Interfaces

### Build-time descriptor

`spooler-layer-manifest.js` must produce canonical JSON with this shape:

```json
{
  "format": 2,
  "kind": "spooler-update-core",
  "release": {
    "version": "1.2.6",
    "commit": "40-lowercase-hex"
  },
  "requiredRuntime": {
    "id": "64-lowercase-hex",
    "nodeVersion": "22.23.0",
    "platform": "win32",
    "arch": "x64",
    "dependenciesId": "64-lowercase-hex",
    "browserId": "64-lowercase-hex",
    "browserBuild": "win64-146.0.7680.76"
  },
  "application": {
    "id": "64-lowercase-hex",
    "files": [
      { "path": "server.js", "bytes": 1, "sha256": "64-lowercase-hex" }
    ]
  }
}
```

Runtime-transition payloads use `kind: "spooler-update-runtime"` and add complete `dependencies.files` and `browser.files` inventories. Canonical IDs are SHA-256 over UTF-8 JSON containing sorted forward-slash paths, byte lengths, and lowercase SHA-256 values. File timestamps, root package version fields, npm's hidden `node_modules/.package-lock.json`, and absolute build-machine paths are excluded. The build removes the hidden lockfile from deployable runtime stages so a release-version-only change cannot create a false dependency-layer change.

### Installed attestation

After a fresh package built with the new tooling or a successful runtime transition, `C:\Program Files\POS-Spooler\spooler-installed-layers.json` contains:

```json
{
  "format": 2,
  "appId": "{80657A48-9BCB-4455-8CA9-A18139FDFC58}",
  "runtime": {
    "id": "64-lowercase-hex",
    "nodeVersion": "22.23.0",
    "platform": "win32",
    "arch": "x64",
    "dependenciesId": "64-lowercase-hex",
    "browserId": "64-lowercase-hex",
    "browserBuild": "win64-146.0.7680.76"
  },
  "application": {
    "id": "64-lowercase-hex",
    "files": []
  },
  "release": {
    "version": "1.2.6",
    "commit": "40-lowercase-hex"
  }
}
```

This file contains no URL, key, station ID, station name, state path, log path, or printer value.

### Stored-origin validation

`Test-SpoolerServerOrigin([string]$Value)` returns a parsed absolute URI only when:

- scheme is exactly `http` or `https`;
- host is non-empty;
- optional port is in the URI implementation's valid range;
- username/password, query, and fragment are absent;
- path is empty or `/`.

Both `https://hashemi.shawermajwana.com` and `http://127.0.0.1:3000` are valid. The raw text remains untouched; only a local in-memory origin without trailing slash is used for `/health` and `/api/spooler/self-status`.

---

### Task 1: Repair the Existing Evidence Harness

**Files:**
- Modify: `tests/installer/spooler-update-probe.ps1`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: updater output containing zero or more `POSAPP_PROGRESS|...` lines followed by one JSON result.
- Produces: `Convert-UpdaterOutputToResult([string[]]$Lines)` returning the single parsed JSON result and rejecting missing or multiple JSON results.

- [ ] **Step 1: Add a failing contract test** requiring the probe to filter lines beginning `POSAPP_PROGRESS|` before `ConvertFrom-Json`, reject secret-bearing progress, and preserve the final JSON record.
- [ ] **Step 2: Run** `npx vitest run backend/tests/unit/installerUpdateContract.test.js` and confirm the new assertion fails against the current direct pipeline at `tests/installer/spooler-update-probe.ps1:35`.
- [ ] **Step 3: Implement the smallest parser** that captures updater output as an array, separates progress records, parses exactly one JSON record, and never prints the fake key fixture.
- [ ] **Step 4: Run** `powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/spooler-update-probe.ps1` and confirm the existing adoption/mismatch/corruption assertions execute instead of failing at JSON parsing.
- [ ] **Step 5: Run** `npx vitest run backend/tests/unit/installerUpdateContract.test.js` and confirm all focused contracts pass.
- [ ] **Step 6: Commit** only the probe and contract test with `test(installer): repair spooler update probe parsing`.

### Task 2: Define Deterministic Spooler Layers at Build Time

**Files:**
- Create: `deployment/tools/spooler-layer-manifest.js`
- Modify: `scripts/build-installers.ps1`
- Modify: `deployment/tools/validate-payload.js`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: staged spooler root, release identity, layer kind.
- Produces: the descriptor formats defined above and identical IDs for byte-identical inventories regardless of enumeration order or timestamps.

- [ ] **Step 1: Add failing tests** for deterministic ordering, path normalization, duplicate-path rejection, traversal rejection, lowercase SHA-256, root-version-insensitive dependency identity, and browser-build capture.
- [ ] **Step 2: Add failing packaging assertions** proving the core stage contains no `node_modules`, `.cache`, `runtime`, `install`, `spooler.env`, `.env`, key, certificate, or archive.
- [ ] **Step 3: Add a regression assertion** rejecting `node_modules/node_modules`; this pins the current duplicate-copy defect.
- [ ] **Step 4: Run** `npx vitest run backend/tests/unit/installerUpdateContract.test.js` and confirm failures name the absent layer generator and current duplicate copy.
- [ ] **Step 5: Implement canonical inventories** using `fs.readdirSync(..., { withFileTypes: true })`, explicit sorted relative paths, streaming SHA-256, and forward slashes. Never follow symlinks or junctions; reject them.
- [ ] **Step 6: Replace spooler update staging** with two explicit roots: `spooler-update-core` and `spooler-update-runtime`. Do not call `Copy-FilteredTree` on the full spooler root for the core stage. Copy the application allowlist directly.
- [ ] **Step 7: Remove the duplicate dependency copy** by ensuring the runtime stage receives `node_modules` exactly once and `.cache` exactly once. Remove `node_modules/.package-lock.json` from the deployable stage and assert that no runtime code requires it.
- [ ] **Step 8: Write both descriptors** and validate them before Inno compilation.
- [ ] **Step 9: Enforce build gates:** core unpacked payload below 5 MiB, core EXE below 5 MiB, zero dependency/browser files in core, and no nested dependency/cache roots in runtime transition.
- [ ] **Step 10: Run** `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1 -StageOnly -SkipDependencyInstall` using the prepared stage prerequisites and inspect file counts/bytes.
- [ ] **Step 11: Run** `npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js`.
- [ ] **Step 12: Commit** the generator, build script, validator, and focused tests with `build(installer): split spooler application and runtime layers`.

### Task 3: Make `spooler.env` an Immutable Update Input

**Files:**
- Create: `deployment/windows/SpoolerLayerState.ps1`
- Modify: `deployment/windows/Update-Spooler.ps1`
- Modify: `tests/installer/spooler-update-probe.ps1`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: raw env-file bytes and parsed required values.
- Produces: `Get-SpoolerEnvSnapshot`, `Assert-SpoolerEnvUnchanged`, and `Test-SpoolerServerOrigin` without any env-file write primitive.

- [ ] **Step 1: Add a fixture** whose raw `spooler.env` contains CRLF, comments, unknown customer settings, unusual ordering, no final newline, and `CLOUD_SERVER_URL=https://hashemi.shawermajwana.com`.
- [ ] **Step 2: Add failing tests** proving portless HTTPS and explicit-port HTTP pass while `ftp`, credentials, query, fragment, non-root path, malformed port, and whitespace-only host fail.
- [ ] **Step 3: Add static failing tests** forbidding any `WriteAllText`, `Set-Content`, `Out-File`, `Move-Item`, `Copy-Item`, or `Remove-Item` target resolving to `spooler.env` from either spooler updater script.
- [ ] **Step 4: Add failing behavior tests** proving stale `install.json.serverUrl`, station ID, or station name do not override or reject the valid env file.
- [ ] **Step 5: Run the focused tests** and confirm the current mandatory-port regex and metadata comparison fail.
- [ ] **Step 6: Implement URI parsing** with `[Uri]::TryCreate`, exact scheme/userinfo/query/fragment/path checks, and in-memory trailing-slash removal only.
- [ ] **Step 7: Capture the env snapshot** as path, length, and SHA-256 before any service operation. Check it immediately before service stop, immediately before service start, after successful self-status, and after failure handling.
- [ ] **Step 8: If the hash changes**, do not restore the file. Roll back application/runtime files, restart the service against the currently present env file, return `blocked_config_changed`, and identify only the path—not its contents—in the error.
- [ ] **Step 9: Remove mutable configuration duplication** from new `install.json` writes. Legacy mutable fields may be read only for migration diagnostics; they cannot authorize or block the update.
- [ ] **Step 10: Run** the focused Vitest contract and PowerShell probe and confirm the custom env fixture hash is identical before/after every non-service path.
- [ ] **Step 11: Commit** with `fix(installer): preserve spooler environment as immutable input`.

### Task 4: Implement Fast Core-Update Eligibility and Transaction

**Files:**
- Modify: `deployment/windows/SpoolerLayerState.ps1`
- Modify: `deployment/windows/Update-Spooler.ps1`
- Do not modify: `deployment/windows/InstallerUpdateState.ps1`; spooler-only layer behavior belongs in `SpoolerLayerState.ps1` so the server updater cannot change accidentally.
- Modify: `tests/installer/update-contract-probe.ps1`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: target core descriptor and installed layer attestation.
- Produces: `Compare-SpoolerRuntimeAttestation`, application-only rollback union, durable transaction journal, atomic installed-attestation write, and a structured `runtime_transition_required` refusal.

- [ ] **Step 1: Add failing eligibility tests** for missing attestation, malformed descriptor, wrong AppId, runtime-ID mismatch, wrong Node/platform/architecture, downgrade, same-version/different-commit, and valid matching runtime.
- [ ] **Step 1a: Add concurrency tests** proving a second updater, direct script launch, or startup-repair invocation refuses while `Global\POSAPP-Spooler-UpdateTransaction` is held and does not stop the service.
- [ ] **Step 2: Assert refusal ordering:** every runtime/config/ownership refusal occurs before `Stop-Spooler`, rollback staging, or any Program Files mutation.
- [ ] **Step 3: Add an application rollback fixture** containing one changed file, one new file, one retired file, and untouched runtime/config/state files.
- [ ] **Step 4: Run focused tests** and confirm the current format-1 whole-tree transaction fails the new application-only requirements.
- [ ] **Step 5: Acquire the machine-wide transaction lock and implement core preflight** validating payload hashes, service ownership, env snapshot, online server health, installed release, installed attestation, required runtime identity, and the installed recovery-capable startup-repair script. Release the lock in `finally` after every refusal/success/failure path.
- [ ] **Step 6: Build rollback from only the previous and target application inventories.** Never derive rollback entries from runtime inventories or ProgramData.
- [ ] **Step 7: Write the durable journal before mutation**, including application rollback paths, original service startup mode, old/target release identities, layer IDs, and env hash. Use `FileOptions.WriteThrough`, `Flush(true)`, and same-directory atomic replacement; recovery must validate actual file/directory existence because power can fail after a rename/copy but before its next phase record.
- [ ] **Step 8: Recheck env hash, set service startup to Disabled while the verified old service is still running, journal that durable guard, then stop the spooler and journal the observed stopped state.** Copy only target application files and remove only retired application files.
- [ ] **Step 9: Restore the recorded startup mode, start the service, and verify self-status** for target version, env-derived station ID/name, and connection status. Preserve the existing 60-second bounded wait.
- [ ] **Step 10: Atomically write** new release metadata and installed layer attestation only after successful health verification, journal `committed`, then remove rollback and journal files.
- [ ] **Step 11: On failure or startup-repair recovery before commit**, keep/return the service to Disabled until old application files and metadata are restored; then restore the original startup mode, restart the previous release, and recheck the env hash without rewriting it.
- [ ] **Step 12: Add forced-process-termination and reboot tests** during each core application-copy/metadata boundary, proving the service cannot process jobs before recovery.
- [ ] **Step 13: Run** the PowerShell rollback probe plus focused Vitest contracts.
- [ ] **Step 14: Commit** with `feat(installer): add attested core spooler updates`.

### Task 5: Implement the Explicit Runtime-Transition Transaction

**Files:**
- Modify: `deployment/windows/SpoolerLayerState.ps1`
- Modify: `deployment/windows/Update-Spooler.ps1`
- Modify: `deployment/windows/Repair-SpoolerStartup.ps1`
- Modify: `tests/installer/update-contract-probe.ps1`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: complete verified dependency/browser inventories and application descriptor.
- Produces: a one-time transition from legacy/unknown runtime metadata to format-2 installed attestation without trusting or deleting the previous runtime before target verification.

- [ ] **Step 1: Add failing transition tests** for a legacy installation with no attestation, a format-1 manifest, a nested duplicate dependency tree, and a stale legacy `install.json` URL.
- [ ] **Step 2: Add interruption tests** at: payload verification, staging copy, before stop, after stop, after old-runtime rename, after new-runtime activation, target startup, self-status, metadata commit, and cleanup. Simulate process termination and machine reboot rather than only catchable PowerShell exceptions.
- [ ] **Step 3: Acquire the machine-wide transaction lock, calculate required staging/rollback bytes, and refuse before stop when the Program Files volume lacks the new runtime size plus rollback metadata and a 10%/256 MiB minimum safety margin.** Then stage under `C:\Program Files\POS-Spooler\.update-staging-<pid>` and verify the staged dependency/browser inventory before stopping the service.
- [ ] **Step 4: Install the new recovery-capable startup-repair script before the first destructive rename**, verify its hash, keep the existing scheduled-task path unchanged, and add an explicit `ProgramFilesRoot` parameter to startup repair for sandbox and recovery validation.
- [ ] **Step 5: Write a durable secret-free journal** at `C:\ProgramData\POS-Spooler\tmp\update-transaction.json` using `FileOptions.WriteThrough`, `Flush(true)`, and same-directory atomic replacement. It records transaction ID, mode, phase, Program Files staging/rollback directory names, old/target release identities, old/target layer IDs, application rollback manifest path, original service startup mode, and pre-update env hash. It contains no URL, key, station identity, printer value, or raw env data.
- [ ] **Step 6: Recheck env hash and service ownership**, journal phase `prepared`, set startup to Disabled while the verified old service is still running, journal the durable guard, then stop the service and journal phase `service_stopped`. On reboot, SCM therefore cannot launch either old or target code before journal reconciliation.
- [ ] **Step 7: Rename existing `node_modules` and `.cache`** to unique same-volume rollback names, journal each completed rename, then rename staged directories into their final names and journal `target_runtime_active`. Never recursively copy the old runtime into ProgramData.
- [ ] **Step 8: Apply the application transaction**, journal `target_application_active`, start the target service, and verify self-status.
- [ ] **Step 9: On success**, atomically write release/installed attestation, journal `committed`, then remove the old runtime/staging/application rollback and finally remove the journal.
- [ ] **Step 10: On catchable failure before commit**, remove/deactivate target files, rename old runtime directories back according to the journal, restore application/release metadata, restart the old release, verify env hash, and remove the journal only after old-release recovery succeeds.
- [ ] **Step 11: Extend startup repair** to acquire the transaction lock and read/validate the journal before ordinary service repair. It must reconcile from both the recorded phase and actual directory/file existence because the last phase write may trail a completed filesystem operation. For any pre-commit state it restores the previous application/runtime before restoring the original startup mode; for `committed` it keeps the target, restores startup mode, and performs cleanup. Invalid paths, IDs, reparse points, or impossible state combinations fail closed and leave the service Disabled with a secret-free recovery report.
- [ ] **Step 12: If cleanup alone fails after committed target health**, report `updated_cleanup_pending` and leave uniquely named inert rollback directories plus the committed journal for the next startup-repair pass; never roll a healthy committed target backward.
- [ ] **Step 13: Run focused tests and probes** and inspect that runtime rollback directories are under Program Files, the journal/ordinary application rollback are the only ProgramData temporary writes, and no path can reach config/state/logs or follow a reparse point.
- [ ] **Step 14: Commit** with `feat(installer): add spooler runtime transition updates`.

### Task 6: Compile Two Explicit Spooler Update Packages

**Files:**
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `scripts/build-installers.ps1`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Produces: `POSAPP-Spooler-Update.exe` in core mode and `POSAPP-Spooler-Runtime-Update.exe` in runtime-transition mode.

- [ ] **Step 1: Add failing Inno contract tests** requiring explicit modes and preventing the core definition from referencing runtime-stage files.
- [ ] **Step 2: Add silent-mode tests** requiring `ACCEPTUPDATE=1` for both packages and preserving the existing no-cancel transaction rule after mutation begins.
- [ ] **Step 3: Pass `-Mode Core` or `-Mode RuntimeTransition`** to `Update-Spooler.ps1`; do not infer mode from file presence.
- [ ] **Step 4: Keep `SolidCompression=yes`** because the core payload is now tiny and the runtime payload intentionally extracts completely. Do not place optional skipped runtime files inside the core stream.
- [ ] **Step 5: Compile both artifacts** with pinned Inno Setup and verify SHA-256 sidecars.
- [ ] **Step 6: Inspect artifacts** by extracting them into disposable directories and assert exact allowed roots, zero secret/config files, and no nested `node_modules`.
- [ ] **Step 7: Record measured compressed/unpacked sizes and file counts** in the test output. Fail the build when the core exceeds 5 MiB or gains runtime roots.
- [ ] **Step 8: Commit** with `build(installer): produce core and runtime spooler updates`.

### Task 7: Harden Preservation and No-Duplicate-Print Acceptance

**Files:**
- Modify: `tests/installer/spooler-update-probe.ps1`
- Modify: `tests/installer/update-smoke.ps1`
- Modify: `deployment/README.md`
- Test: `pos-spooler-printer/tests/payload-integrity.test.js`
- Test: `pos-spooler-printer/tests/durable-seen-store.test.js`

**Interfaces:**
- Produces: before/after evidence with release identity, runtime/app layer IDs, env/config/state hashes, service identity, and updater result.

- [ ] **Step 1: Extend smoke snapshots** with installed layer IDs and exact hashes for env, all config files, and all durable state files.
- [ ] **Step 2: Add a seeded seen-store fixture** containing completed, printing/uncertain, failed, and dead-letter identities. Verify the updater does not alter any byte before the spooler itself resumes normal processing.
- [ ] **Step 3: Add redacted result assertions** proving no key or raw env contents appear in stdout, progress, result JSON, update log, Inno log, or installed metadata.
- [ ] **Step 4: Document technician choice:** use core update when eligible; use runtime transition only on `runtime_transition_required`; never uninstall first; retain the previous artifact until physical printing is confirmed.
- [ ] **Step 5: Run** `npm --prefix pos-spooler-printer test` and the focused installer suites.
- [ ] **Step 6: Commit** with `test(installer): prove spooler update state preservation`.

### Task 8: Disposable Windows Acceptance and Failure Injection

**Files:**
- Modify: `tests/installer/run-update-sandbox.ps1`
- Modify: `tests/installer/update-sandbox-guest.ps1`
- Modify: `deployment/README.md`

**Interfaces:**
- Consumes: the exact committed core/runtime artifact hashes.
- Produces: machine-readable Windows 10 and Windows 11 acceptance results; this task must not run against a customer machine first.

- [ ] **Step 1: Revert a clean Windows 10 22H2 x64 VM**, install the last accepted spooler package, configure a fake portless HTTPS origin fixture, and record all hashes/identities.
- [ ] **Step 2: Confirm core refusal** on a legacy machine lacking format-2 attestation; verify service and all files remain untouched.
- [ ] **Step 3: Run runtime transition**, inject each planned failure point one at a time from a reverted snapshot, and prove old service recovery plus byte-identical env/config/state.
- [ ] **Step 4: Run successful runtime transition**, reboot, verify startup repair, then run a core update and measure extraction, preflight, stopped-service time, total time, bytes, and file counts.
- [ ] **Step 5: Repeat the exact artifact hashes** on a reverted Windows 11 x64 VM.
- [ ] **Step 6: Reject acceptance** for any env/config/state hash change, unknown service mutation, unbounded wait, leftover active staging runtime, secret-bearing log, wrong release/layer identity, or automatic replay of uncertain print state.
- [ ] **Step 7: Record results** in `deployment/README.md` with OS builds and exact artifact hashes; do not claim customer readiness from local tests alone.
- [ ] **Step 8: Commit** with `test(installer): validate layered spooler updates on Windows`.

### Task 9: Physical Printer Gate and Architecture Handoff

**Files:**
- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`
- Modify: `deployment/README.md`

- [ ] **Step 1: On a controlled non-customer station**, record printer models, spooler ID, previous/target versions, env/config/state hashes, and artifact hashes without recording the key.
- [ ] **Step 2: Queue and complete one customer receipt and one kitchen ticket**, then apply the core updater while no job is in physical-processing state.
- [ ] **Step 3: Verify one physical copy of each post-update ticket**, correct Arabic/rendering/cutting/beep behavior, acknowledgements, durable seen-store settlement, and no duplicate queue settlement.
- [ ] **Step 4: Repeat with a deliberately uncertain fixture** and prove it remains dead-letter/manual-review rather than auto-printing.
- [ ] **Step 5: Update the architecture flow** so only the spooler branch describes core/runtime layering; keep the server updater branch unchanged.
- [ ] **Step 6: Run** `npm run architecture` and `npm run architecture:check`.
- [ ] **Step 7: Run final focused verification:** installer contracts, installer package contracts, PowerShell probes, spooler tests, artifact extraction checks, and `git diff --check`.
- [ ] **Step 8: Review the complete diff** for server-updater changes, secrets, unexpected ProgramData writes, unrelated files, and size-gate bypasses. Any hit blocks release.
- [ ] **Step 9: Commit** documentation and architecture evidence with `docs(installer): record layered spooler update acceptance`.

---

## Adversarial Design Review

| Attack | Expected result | Design control |
|---|---|---|
| Portless production HTTPS origin | Accepted without rewriting | URI parser accepts default ports; env snapshot remains byte-identical |
| Customer added unknown env settings/comments | Preserved | Updater reads required keys but never serializes the file |
| Stale URL/station values in `install.json` | Do not block or override | Mutable configuration removed from metadata authority |
| Missing runtime attestation | Core refuses before stop | Explicit `runtime_transition_required` |
| Runtime ID mismatch | Core refuses before stop | Exact required/installed runtime-ID comparison |
| Tampered core payload | Refused | SHA-256 inventory verification before mutation |
| Nested duplicate `node_modules` from old build | Runtime transition replaces it; core refuses legacy | Explicit transition plus nested-root build rejection |
| Failure while staging runtime | Old service remains running | All large copy/hash work happens before stop |
| Failure after old runtime rename | Old directories renamed back | Same-volume rollback names retained until health success |
| Failure after application copy | Application union restored | New files removed; changed/retired files restored |
| `spooler.env` changed concurrently | No overwrite; update rolls back and reports blocked | Repeated hash checks; no restoration write |
| POS server unavailable | Refuse before stop | `/health` preflight using env-derived origin |
| Server disappears after stop | Target fails self-status and transaction rolls back | Bounded health verification plus old app/runtime restoration |
| Spooler service points at unknown executable | Refuse before mutation | Existing exact NSSM/legacy ownership validation retained |
| Reparse point inside staged runtime | Refuse | Inventory generator/updater reject links and assert roots |
| Insufficient disk for side-by-side runtime | Refuse before stop | Exact staged byte count plus 10%/256 MiB free-space margin |
| Concurrent updater/startup repair/direct script | Second actor refuses without mutation | Shared `Global\POSAPP-Spooler-UpdateTransaction` lock |
| Power loss during directory swap | Startup repair deterministically restores pre-commit state or finishes committed cleanup | Atomic secret-free journal, same-volume rename order, retained rollback directories |
| SCM starts service after power loss mid-update | Service remains stopped until reconciliation | Transaction records original mode and sets startup Disabled before mutation |
| Power fails after filesystem operation but before phase write | Recovery inspects real paths and chooses the only valid pre-commit restoration | Write-through journal plus idempotent state reconciliation |
| Cleanup deletion fails after healthy commit | Keep target healthy; report cleanup pending | Commit boundary precedes best-effort inert rollback cleanup |
| Secret leaks through progress/result/log | Test fails and release blocks | Redacted structured output; no raw env serialization |
| Existing uncertain print job | Never automatically replayed | ProgramData state untouched; durable seen-store rules unchanged |
| Same version, different commit | Refused | Existing release comparison retained |
| Downgrade | Refused | Existing semantic release comparison retained |
| Core package accidentally gains Chromium/dependencies | Build fails | Forbidden-root and 5 MiB gates |
| Server updater behavior changes | Release blocks | No server file changes; focused server contract regression |

## Rejected Approaches

- **Run `npm ci` during update:** rejected because npm deliberately removes the existing dependency tree, needs package sources/cache, reruns lifecycle scripts, and creates customer-machine drift and network dependence.
- **Trust only `package-lock.json`:** rejected because a lockfile describes the intended dependency tree, not the exact installed native/browser bytes.
- **Ship dependencies inside every updater but skip copying:** rejected because Inno solid compression still carries and extracts a huge stream, while payload verification still hashes thousands of files.
- **Silently adopt any legacy runtime:** rejected because the application could start against missing, altered, or ABI-incompatible dependencies.
- **Hash every installed dependency on every core update:** rejected because it preserves the current dominant delay and defeats layer attestation.
- **Use the fresh installer as the permanent update path:** rejected because repair rewrites `spooler.env` and currently rejects portless online origins.
- **Store mutable configuration in `install.json`:** rejected because technicians legitimately change `spooler.env`, making duplicated metadata stale and dangerous.
- **Restore `spooler.env` after concurrent change:** rejected because rollback would overwrite a legitimate technician/customer update.
- **Move to MSI/MSP or MSIX now:** rejected as an unnecessary installer-platform migration for a problem solved safely within the existing Inno/PowerShell system.

## Threat Model Boundary

The updater defends against corrupted packages, malformed/stale metadata, interrupted processes, power loss, disk exhaustion, concurrent updater actors, service/network failure, and accidental configuration mutation. It does not claim to defend against a malicious local Administrator or SYSTEM process: such an actor can replace the service executable, updater, attestation, certificates, and Windows trust state directly. Exact service ownership, payload hashes, path checks, and future Authenticode signing remain defense-in-depth rather than a security boundary against local administrators.

## Release Decision

The design is accepted for implementation only. It is not authorized for customer deployment until Tasks 1-9 pass against the same committed artifact hashes. No test plan can establish literal 100% safety; the release standard is that every known failure mode above is either prevented before mutation, transactionally rolled back, or proven safe through clean-VM and physical-printer evidence.
