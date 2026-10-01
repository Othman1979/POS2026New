# Spooler Installer Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POSAPP-Spooler-Setup.exe` behave like an ordinary installer — lay down files, register the service, exit — so that a failed install can always be retried and a network problem is never an installation failure.

**Architecture:** The current installer implements a two-phase-commit transaction (journal file + boot-time recovery engine + per-layer attestation) around what is fundamentally a file copy and an `sc create`. That machinery is the source of the failures, not a defence against them: a leftover journal permanently blocks reinstallation, and its own recovery path calls a script the guard prevents from being installed. This plan removes the transaction model and replaces it with the industry-standard one — installation is idempotent and overwrites, update is stop/replace/start, rollback is "run the previous installer".

**Tech Stack:** Inno Setup 6 (`deployment/spooler/POSAPP-Spooler.iss`), Windows PowerShell 5.1 (`deployment/windows/*.ps1`), NSSM 2.24, Vitest for the contract tests.

## Evidence

Measured at `53fb89d1`, verified twice — once by reading, once by executing the guards against scratch roots.

| Measure | Value |
|---|---|
| Abort points in the install/update path | **209** |
| Lines in that path | 2,508 |
| Lines that exist only for the transaction model | 1,364 (54%) |
| Test lines pinned to the transaction model | ~1,900 |
| Aborts that verify NSSM obeyed its own `set` command | 7 |
| Aborts that require a live, healthy, correctly-keyed POS server | 4 |

Two guards were executed directly (`Install-Spooler.ps1` run with `-ProgramFilesRoot`/`-ProgramDataRoot` pointed at scratch directories and a stub POS server):

```
--- A. POS server unreachable (nothing listening on that port) ---
  exit code: 1
  reason: POS spooler provisioning failed. | Unable to connect to the remote server
  files written into the ProgramFiles root: 0

--- B. POS server healthy, but a journal is left from an earlier failed install ---
  exit code: 1
  reason: Installation failed and durable recovery requires technician attention.
          Install: An interrupted spooler transaction requires startup recovery before installation.
          Recovery: '...\deployment\windows\Repair-SpoolerStartup.ps1' is not recognized...
  files written into the ProgramFiles root: 0
  journal still on disk afterwards: True
```

Case B is a permanent deadlock, and it is caused by an ordering bug. The guard that refuses on a stale journal (`Install-Spooler.ps1`, `'An interrupted spooler transaction requires startup recovery before installation.'`) runs **before** `Install-SpoolerRecoveryScripts` puts `Repair-SpoolerStartup.ps1` on disk. So the catch block's recovery call fails with "is not recognized", the journal is never cleared, and every subsequent install — including one built from a fixed installer — hits the same wall. `C:\ProgramData\POS-Spooler\` is created by PowerShell, not by Inno, so Inno's rollback never removes it.

Two claims from the original audit did **not** survive re-verification and are corrected here:

- *"The signed `.exe` is the integrity boundary, so attestation is redundant."* — **wrong, there is no code signing.** Neither `POSAPP-Spooler.iss` nor `scripts/build-installers.ps1` invokes SignTool. The attestation is still the wrong control (an attacker who can alter the payload inside the installer can alter its manifest too, since both ship in the same unsigned file — it only catches accidental corruption), but the replacement is a signature plus one payload hash, not nothing.
- *"The startup-repair scheduled task duplicates NSSM's restart-on-failure."* — **wrong.** `Repair-SpoolerStartup.ps1` is the journal reconciliation engine, not a restart watchdog. It is deletable only as part of deleting the journal, which is how this plan treats it. (NSSM does restart the app on exit by default — no `AppExit` is configured — but that is unrelated to what this script does.)

## Global Constraints

- Windows floor stays `MinVersion=10.0.17763`, `ArchitecturesAllowed=x64os`.
- The service name stays `POS Print Spooler`. Exactly one may exist — two agents against one state directory is a real failure (`STATE_ROOT_LOCKED`), and that check is kept.
- Config, state and logs stay under `C:\ProgramData\POS-Spooler\`; service code stays under `C:\Program Files\POS-Spooler\`.
- `SPOOLER_KEY` must never appear in a command line, a log, or a result file. It is passed by response file and the response file is deleted after use. Unchanged by this plan.
- No new dependencies. No new PowerShell modules.
- Every task ends green on `npx vitest run backend/tests/unit/installer*.test.js backend/tests/unit/spooler*.test.js`.
- Do not restructure `deployment/spooler-service/` or `pos-spooler-printer/service/` — the hand-copy installers are out of scope. Task 6 makes one surgical edit to `deployment/spooler-service/spooler-service.ps1` because it writes an attestation that task deletes the reader for; nothing else in those folders changes.
- Sol is working in this repo concurrently. Stage explicit paths — never `git add -A` — and re-read a file before editing it.

## File Structure

| File | Responsibility after this plan |
|---|---|
| `deployment/windows/Install-Spooler.ps1` | Validate input, write config, lay files, register service, start it, report. No transaction. |
| `deployment/windows/Update-Spooler.ps1` | Stop, replace the subtree the payload owns, start. No transaction. |
| `deployment/windows/Remove-SpoolerRuntime.ps1` | Remove the service unconditionally; preserve config and state. |
| `deployment/windows/SpoolerLayerState.ps1` | **Deleted** (Task 5) |
| `deployment/windows/InstallerUpdateState.ps1` | **Deleted** (Task 5) |
| `deployment/windows/Repair-SpoolerStartup.ps1` | **Deleted** (Task 5) |
| `deployment/tools/validate-payload.js` | Reduced to one payload-hash check (Task 6) |
| `backend/tests/unit/installerUpdateContract.test.js` | Rewritten against the new contract (Tasks 5, 6) |

---

### Task 1: Stop refusing to install because of a stale journal

The hotfix. Ships alone, unblocks any till already bricked, and is safe to release before the rest of the plan is written.

An installer is a "make it so" operation. Finding leftover state from a previous attempt is the **normal** case for a retry, not an error condition.

**Files:**
- Modify: `deployment/windows/Install-Spooler.ps1` — the `if (Test-Path -LiteralPath $journalPath -PathType Leaf) { throw ... }` line inside the main `try`, and the `catch` block's recovery call
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new. Behaviour change only.

- [ ] **Step 1: Write the failing test**

Add to `installerUpdateContract.test.js`:

```js
it('retries over a leftover journal instead of refusing to install', () => {
    const script = read('deployment/windows/Install-Spooler.ps1');
    // A journal left by an interrupted attempt is the normal state on retry.
    // Refusing on it made every later install fail, including installs built
    // from a fixed installer, because nothing on the failure path cleared it.
    expect(script).not.toContain('An interrupted spooler transaction requires startup recovery before installation.');
    const guard = script.indexOf('Remove-SpoolerTransactionJournal $journalPath');
    const firstWrite = script.indexOf('Install-SpoolerRecoveryScripts');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstWrite);
});

it('installs its recovery scripts before anything that can need them', () => {
    const script = read('deployment/windows/Install-Spooler.ps1');
    expect(script.indexOf('Install-SpoolerRecoveryScripts'))
        .toBeLessThan(script.indexOf('Write-SpoolerTransactionJournal $journalPath $installJournal'));
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run backend/tests/unit/installerUpdateContract.test.js --reporter=verbose
```

Expected: both new tests FAIL — the first because the string is still present, the second because the ordering is currently reversed.

- [ ] **Step 3: Replace the guard with a clear-and-continue**

In `Install-Spooler.ps1`, inside the main `try`, replace:

```powershell
    if (Test-Path -LiteralPath $journalPath -PathType Leaf) { throw 'An interrupted spooler transaction requires startup recovery before installation.' }
    $recoveryEntries = Install-SpoolerRecoveryScripts -SourceRoot (Join-Path $PayloadRoot 'deployment\windows') -ProgramFilesRoot $ProgramFilesRoot -Names $recoveryScriptNames
```

with:

```powershell
    # Installing over a leftover journal is a retry, not a fault. Refusing here
    # bricked the machine permanently: the catch below calls Repair-SpoolerStartup.ps1
    # out of ProgramFiles, which the line under this one is what puts there, so on a
    # fresh box recovery failed with "is not recognized" and the journal survived to
    # block the next attempt. Recovery scripts land first, then the stale journal goes.
    $recoveryEntries = Install-SpoolerRecoveryScripts -SourceRoot (Join-Path $PayloadRoot 'deployment\windows') -ProgramFilesRoot $ProgramFilesRoot -Names $recoveryScriptNames
    if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
        Write-Output 'Clearing an interrupted transaction from a previous install attempt.'
        Remove-SpoolerTransactionJournal $journalPath
    }
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run backend/tests/unit/installerUpdateContract.test.js --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Reproduce the original deadlock and prove it is gone**

Rebuild the installers, then re-run the guard harness from the Evidence section with a planted journal. Case B must now proceed past the journal check instead of ending in "technician attention". Record the output in the commit message.

```bash
npx vitest run backend/tests/unit/installer*.test.js backend/tests/unit/spooler*.test.js --reporter=verbose
```

- [ ] **Step 6: Commit**

```bash
git add deployment/windows/Install-Spooler.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "fix(installer): retry over a leftover transaction instead of bricking"
```

---

### Task 2: Stop failing the install when the POS server cannot be reached

Proven by case A: with nothing listening, the install writes zero files and exits 1. A wrong key, a restarting server, slow DNS, or an Imunify360 block all produce the same outcome — an installation that "failed" even though nothing about the machine was wrong.

Connectivity is a runtime fact. The Print queue page already reports it continuously (Agent status / Last sync / station Paused), which is where a person can act on it.

**Files:**
- Modify: `deployment/windows/Install-Spooler.ps1` — `Get-SpoolerRegistrationStatus`, the `/health` check, and the post-start registration poll
- Modify: `deployment/spooler/POSAPP-Spooler.iss` — the `ssPostInstall` handler's failure message
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**
- Consumes: nothing new
- Produces: the result file gains a `warnings` array. The Inno handler reads it and shows warnings on the completion page instead of raising.

- [ ] **Step 1: Write the failing test**

```js
it('reports server reachability as a warning, never as an install failure', () => {
    const script = read('deployment/windows/Install-Spooler.ps1');
    for (const gate of [
        "throw 'POS server health/release verification failed.'",
        "throw 'POS server rejected the spooler key.'",
        "throw 'Spooler did not register and complete a fresh sync.'",
        "throw 'POS server does not support the V2 print agent. Update the POS server before installing this spooler.'"
    ]) expect(script).not.toContain(gate);
    expect(script).toContain('$warnings');
    expect(script).toContain('SPOOLER_SERVER_UNREACHABLE');
    expect(script).toContain('SPOOLER_NOT_YET_REGISTERED');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run backend/tests/unit/installerUpdateContract.test.js -t 'reachability' --reporter=verbose
```

Expected: FAIL — all four gates are present.

- [ ] **Step 3: Demote the gates to warnings**

Introduce a collector near the top of the script, beside the other state variables:

```powershell
$warnings = [Collections.Generic.List[string]]::new()
```

Replace the health check:

```powershell
$health = $null
try {
    $health = Invoke-RestMethod -Uri "$ServerUrl/health" -TimeoutSec 10
    if ($health.status -ne 'ok' -or -not $health.release.version) { $warnings.Add('SPOOLER_SERVER_UNHEALTHY') }
} catch {
    # The station is configured from the response file whether or not the server
    # answers now. Whether it can reach the server is a runtime fact, reported by
    # the Print queue page, not a reason to refuse to lay files down.
    $warnings.Add('SPOOLER_SERVER_UNREACHABLE')
}
```

Replace the two `throw`s inside `Get-SpoolerRegistrationStatus` with `return $null`, and make every caller tolerate `$null`.

Replace the post-start poll's terminal check:

```powershell
if ($null -eq $identity -or -not (Test-FreshSpoolerSync -Status $status -ExpectedAgentId ([string]$identity.agent_id) -PreviousLastSyncAt $previousLastSyncAt)) {
    $warnings.Add('SPOOLER_NOT_YET_REGISTERED')
}
```

Keep the poll and its deadline — a fast confirmation is still worth showing. It just stops being a gate.

- [ ] **Step 4: Write the warnings into the result file**

Where the script currently writes its success line, emit both:

```powershell
Write-Utf8NoBom $ResultFile (@{
    status = 'installed'
    spoolerId = $SpoolerId
    spoolerVersion = $spoolerVersion
    warnings = @($warnings)
} | ConvertTo-Json -Compress)
```

- [ ] **Step 5: Surface warnings in the wizard without failing**

In `POSAPP-Spooler.iss`, `CurStepChanged`, keep `RaiseException` only for a non-zero exit code. When the exit code is 0 and the result JSON carries warnings, append them to the completion message:

```pascal
if Pos('SPOOLER_SERVER_UNREACHABLE', CompletionText) > 0 then
  CompletionText := 'Installed. The spooler could not reach the POS server yet — check the server URL and key, then watch Settings > Print queue.';
```

- [ ] **Step 6: Run the tests, and re-run guard case A**

Case A must now install successfully against an unreachable server and report `SPOOLER_SERVER_UNREACHABLE`.

```bash
npx vitest run backend/tests/unit/installer*.test.js backend/tests/unit/spooler*.test.js --reporter=verbose
```

- [ ] **Step 7: Commit**

```bash
git add deployment/windows/Install-Spooler.ps1 deployment/spooler/POSAPP-Spooler.iss backend/tests/unit/installerUpdateContract.test.js
git commit -m "fix(installer): report server reachability instead of failing the install"
```

---

### Task 3: Delete the NSSM read-back verification

Seven aborts re-read the registry to confirm NSSM stored what `nssm set` was just told to store. If `nssm set` returns success and then lies, re-reading with the same API will not catch it — and `status.cmd` already dumps the live service configuration on demand.

**Files:**
- Modify: `deployment/windows/Install-Spooler.ps1` — `Configure-NssmService`, `Set-NssmApplicationScript`
- Modify: `deployment/windows/Update-Spooler.ps1` — the two entry-point checks
- Test: `backend/tests/unit/installerUpdateContract.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('trusts nssm set instead of re-reading the registry to check it', () => {
    const install = read('deployment/windows/Install-Spooler.ps1');
    const update = read('deployment/windows/Update-Spooler.ps1');
    for (const readback of [
        'NSSM stored an invalid spooler application path.',
        'NSSM stored an invalid spooler working directory.',
        'NSSM stored invalid spooler application parameters.',
        'NSSM stored missing spooler environment',
        'NSSM did not retain the requested spooler entry point.',
        'NSSM stored the wrong spooler entry point.',
        'NSSM could not set the spooler entry point'
    ]) {
        expect(install).not.toContain(readback);
        expect(update).not.toContain(readback);
    }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run backend/tests/unit/installerUpdateContract.test.js -t 'trusts nssm' --reporter=verbose
```

Expected: FAIL — all seven strings present.

- [ ] **Step 3: Remove the read-backs**

In `Configure-NssmService`, delete each `Get-ItemProperty ... HKLM:\SYSTEM\CurrentControlSet\Services\$Name\Parameters` block and its `throw`. `Invoke-Native` already fails on a non-zero exit code from `nssm set`, which is the signal that matters. `Set-NssmApplicationScript` reduces to its single `Invoke-Native` call. Do the same in `Update-Spooler.ps1`.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run backend/tests/unit/installer*.test.js backend/tests/unit/spooler*.test.js --reporter=verbose
```

- [ ] **Step 5: Install once on a clean VM and confirm the service still runs**

Rebuild, install, then `sc qc "POS Print Spooler"` and confirm `BINARY_PATH_NAME` points at `runtime\nssm\nssm.exe` and the service reaches Running.

- [ ] **Step 6: Commit**

```bash
git add deployment/windows/Install-Spooler.ps1 deployment/windows/Update-Spooler.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "refactor(installer): trust nssm set instead of verifying it wrote what it was told"
```

---

### Task 4: Make uninstall unconditional

`Remove-SpoolerRuntime.ps1` throws `'Refusing to remove an unrecognized Windows service.'` when the registered executable, working directory, or script does not match exactly. A half-configured service from a failed install matches nothing — so the install refuses to proceed and the uninstall refuses to clean up. There is no way out except editing the registry.

The ownership check is worth keeping as a *guard against removing somebody else's service*, but "a service by our name that we do not recognise" is our mess, and removing it is correct.

**Files:**
- Modify: `deployment/windows/Remove-SpoolerRuntime.ps1`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('removes a half-configured service of our own name rather than refusing', () => {
    const remove = read('deployment/windows/Remove-SpoolerRuntime.ps1');
    expect(remove).not.toContain("throw 'Refusing to remove an unrecognized Windows service.'");
    // Still refuses a service that belongs to something else entirely.
    expect(remove).toContain('POS Print Spooler');
    expect(remove).toContain('sc.exe');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run backend/tests/unit/installerUpdateContract.test.js -t 'half-configured' --reporter=verbose
```

- [ ] **Step 3: Downgrade the refusal to a warning**

```powershell
if ($actualExe -ne $expectedExe -or $actualRoot -ne $expectedRoot -or $actualScript -notin $allowedScripts) {
    # A service registered under our own name that we do not recognise is a
    # half-finished install of ours, not somebody else's service. Refusing left
    # machines that could neither install nor uninstall.
    Write-Warning "Removing a POS Print Spooler service with unexpected configuration: $image"
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run backend/tests/unit/installer*.test.js backend/tests/unit/spooler*.test.js --reporter=verbose
```

- [ ] **Step 5: Commit**

```bash
git add deployment/windows/Remove-SpoolerRuntime.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "fix(installer): let uninstall clean up a half-configured spooler service"
```

---

### Task 5: Delete the transaction model

The largest deletion, and the one that removes the class of failure rather than an instance. After Tasks 1–4 the journal no longer gates anything; this removes it, along with the boot-time recovery engine that exists only to reconcile it.

Update becomes: stop the service, replace the subtree the payload owns, start the service. If that fails, the operator runs the previous installer — which, after Task 1, always works.

**Files:**
- Delete: `deployment/windows/InstallerUpdateState.ps1` (354), `deployment/windows/SpoolerLayerState.ps1` (351), `deployment/windows/Repair-SpoolerStartup.ps1` (304)
- Modify: `deployment/windows/Install-Spooler.ps1`, `deployment/windows/Update-Spooler.ps1`, `deployment/windows/Remove-SpoolerRuntime.ps1`, `deployment/spooler/POSAPP-Spooler.iss`, `pos-spooler-printer/maintenance/Refresh-Agent.ps1`
- Rewrite: `backend/tests/unit/installerUpdateContract.test.js` (1,021 lines, 30 journal + 31 attestation references)

**Interfaces:**
- Consumes: nothing
- Removes: `Enter-SpoolerUpdateTransaction`, `Exit-SpoolerUpdateTransaction`, `Write-SpoolerTransactionJournal`, `Remove-SpoolerTransactionJournal`, `Read-SpoolerJson`, `Assert-SpoolerJournalSafety`, `Resolve-SpoolerInstallRecoveryAction`, `Get-SpoolerV2Authority`, `Disable-SpoolerForExplicitRepair`, `Register-SpoolerStartupRepair`, `Install-SpoolerRecoveryScripts`
- Keeps: `Assert-ExclusiveInstallService` — two agents on one state directory is a real failure with a real symptom

Note that the single-instance mutex used by `Enter-SpoolerUpdateTransaction` dies with its process (verified — it is a named `Threading.Mutex`, not a file), so it never leaks. Replace it with a plain mutex acquired in `Install-Spooler.ps1` and `Update-Spooler.ps1` directly; do not keep a 351-line file for it.

- [ ] **Step 1: Write the failing test**

Replace the journal and attestation sections of `installerUpdateContract.test.js` with:

```js
it('carries no transaction model', () => {
    for (const relative of [
        'deployment/windows/InstallerUpdateState.ps1',
        'deployment/windows/SpoolerLayerState.ps1',
        'deployment/windows/Repair-SpoolerStartup.ps1'
    ]) expect(fs.existsSync(path.join(ROOT, relative)), `${relative} should be gone`).toBe(false);

    for (const relative of [
        'deployment/windows/Install-Spooler.ps1',
        'deployment/windows/Update-Spooler.ps1',
        'deployment/spooler/POSAPP-Spooler.iss'
    ]) {
        const script = read(relative);
        expect(script).not.toContain('update-transaction.json');
        expect(script).not.toContain('SpoolerTransactionJournal');
        expect(script).not.toContain('Repair-SpoolerStartup');
    }
});

it('updates by stopping, replacing and starting', () => {
    const update = read('deployment/windows/Update-Spooler.ps1');
    expect(update).toContain('Stop-Service');
    expect(update).toContain('Start-Service');
    expect(update).toContain('POS Print Spooler');
});

it('still refuses to run two agents against one state directory', () => {
    expect(read('deployment/windows/Install-Spooler.ps1')).toContain('Assert-ExclusiveInstallService');
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run backend/tests/unit/installerUpdateContract.test.js --reporter=verbose
```

Expected: FAIL — all three files still exist.

- [ ] **Step 3: Delete the three files and their call sites**

```bash
git rm deployment/windows/InstallerUpdateState.ps1 deployment/windows/SpoolerLayerState.ps1 deployment/windows/Repair-SpoolerStartup.ps1
```

Remove every dot-source of them, the `$journalPath` variable and all its uses, `$recoveryScriptNames`, `Register-SpoolerStartupRepair`, and the scheduled-task registration and unregistration. In the `.iss`, drop the three `[Files]` entries that stage them. In `Refresh-Agent.ps1`, remove the `Enter-SpoolerUpdateTransaction` wrapper and the `'An interrupted spooler transaction must be repaired before maintenance.'` guard; keep the stop/start and the `LOCAL_JOURNAL_NOT_EMPTY` check, which is about *print jobs*, not this journal, and is unrelated.

- [ ] **Step 4: Rewrite Update-Spooler.ps1 around stop/replace/start**

The whole update reduces to: acquire the mutex, stop the service, copy the payload over `C:\Program Files\POS-Spooler`, start the service, wait for Running, report. Delete the phase machine, the layer-transition modes, and the rollback branches.

- [ ] **Step 5: Run the full installer and spooler suites**

```bash
npx vitest run backend/tests/unit/installer*.test.js backend/tests/unit/spooler*.test.js --reporter=verbose
```

- [ ] **Step 6: Full-lifecycle test on a clean VM**

Install, confirm the service runs and the station appears in Settings > Print queue. Run `POSAPP-Spooler-Update.exe`, confirm the version changes and the station reconnects. Kill the installer mid-run, then install again — it must succeed. Uninstall, then install again — it must succeed.

- [ ] **Step 7: Commit**

```bash
git add deployment/windows deployment/spooler/POSAPP-Spooler.iss backend/tests/unit/installerUpdateContract.test.js pos-spooler-printer/maintenance/Refresh-Agent.ps1
git commit -m "refactor(installer): replace the install transaction model with stop/replace/start"
```

---

### Task 6: Replace per-layer attestation with one payload hash

`validate-payload.js` (355 lines, 63 aborts) and `spooler-layer-manifest.js` verify that the payload matches a manifest that ships inside the same installer. That detects a corrupt copy, which is worth keeping, but it does not detect tampering — anyone who can alter the payload can alter the manifest beside it.

Keep the corruption check, in one line. Note separately that the real tampering control is a code-signing certificate, which the build does not currently use.

**Files:**
- Modify: `deployment/tools/validate-payload.js`, `deployment/tools/spooler-layer-manifest.js`, `scripts/build-installers.ps1`
- Modify: `backend/tests/unit/installerPackageContract.test.js` (884 lines, 9 layer references)

**Interfaces:**
- `installerPackageContract.test.js` imports `{ validatePayload, REQUIRED_PATHS }` from `deployment/tools/validate-payload.js`. Both exports must survive the rewrite — `validatePayload(payloadRoot)` keeps its signature and still throws on a bad payload; it just has one reason to throw instead of 63.
- That file has no `read` helper (unlike `installerUpdateContract.test.js`). Add one at the top beside the existing `ROOT`:
  ```js
  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  ```

- [ ] **Step 1: Write the failing test**

```js
it('verifies the payload with a single hash rather than a layer manifest', () => {
    const validate = read('deployment/tools/validate-payload.js');
    expect(validate).toContain('createHash');
    expect(validate.split('\n').length).toBeLessThan(120);
});

it('no longer writes or reads an installed-layer attestation', () => {
    // The string lives in build-installers.ps1 and Update-Spooler.ps1, not in
    // validate-payload.js - asserting it against the wrong file passes vacuously.
    for (const relative of ['scripts/build-installers.ps1', 'deployment/windows/Update-Spooler.ps1']) {
        expect(read(relative)).not.toContain('spooler-installed-layers.json');
    }
    const manifest = read('deployment/tools/spooler-layer-manifest.js');
    expect(manifest).toContain('APPLICATION_ROOTS');
    expect(manifest).toContain('collectInventory');
    for (const gone of ['createSpoolerLayerManifest', 'writeSpoolerLayerManifest', 'detectBrowserBuild']) {
        expect(manifest).not.toContain(gone);
    }
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npx vitest run backend/tests/unit/installerPackageContract.test.js -t 'single hash' --reporter=verbose
```

- [ ] **Step 3: Reduce validate-payload.js to a hash comparison**

At build time, write one SHA-256 over the sorted file list into `release.json`. At install time, recompute and compare. One abort, not 63.

- [ ] **Step 4: Keep APPLICATION_ROOTS, drop the attestation**

`spooler-layer-manifest.js` keeps `APPLICATION_ROOTS` and `collectInventory` — `scripts/build-spooler-bundle.js` and `scripts/build-installers.ps1` both use them to decide what ships. Delete `createSpoolerLayerManifest`, `writeSpoolerLayerManifest` and `detectBrowserBuild`, and narrow the `module.exports` to the two survivors.

Remove the attestation write at `scripts/build-installers.ps1` (`Write-Utf8NoBom (Join-Path $spoolerStage 'spooler-installed-layers.json')`) and every read of it in `Update-Spooler.ps1` (`$installedLayersPath`, and the rollback backup around it).

**Cross-boundary note.** `deployment/spooler-service/spooler-service.ps1:309` also writes `spooler-installed-layers.json`, and `backend/tests/unit/spoolerServiceBootstrap.test.js:30` asserts it does. That file is otherwise out of scope for this plan — but this task cannot leave it writing an attestation nothing reads. Make the minimal edit there: delete the attestation write and that one assertion. Do not restructure the hand-copy installer; that is its own decision (see *Out of scope*).

- [ ] **Step 5: Run the full suites and rebuild**

```bash
npx vitest run backend/tests/unit/installer*.test.js backend/tests/unit/spooler*.test.js --reporter=verbose
```

- [ ] **Step 6: Commit**

```bash
git add deployment/tools backend/tests/unit/installerPackageContract.test.js scripts/build-installers.ps1
git commit -m "refactor(installer): verify the payload with one hash instead of layer attestation"
```

---

## Expected result

| | before | after |
|---|---|---|
| Abort points | 209 | ~35 |
| Lines in the install/update path | 2,508 | ~700 |
| Test lines pinned to the machinery | ~1,900 | ~400 |
| Install fails because the server is down | yes | no |
| A failed install blocks the next one | yes, permanently | no |
| A half-configured service blocks uninstall | yes | no |

## Out of scope, worth deciding separately

- **Code signing.** There is none. It is the real integrity control, it removes SmartScreen warnings on every customer install, and it needs a certificate purchase — a business decision, not a code change.
- **WiX/MSI.** Inno has no native service support and no rollback, which is why all of this was hand-written. WiX gives `ServiceInstall`, `ServiceControl` and `MajorUpgrade` with the Windows Installer engine doing transactions properly. This plan makes the Inno path sane; migrating would make it correct. Separate project.
- **The 265 MB Chromium.** 62% of the payload. Driving the Edge that ships with Windows would drop the installer to roughly a third of its size. Unrelated to installer reliability.
- **The hand-copy bundles** in `deployment/spooler-service/` and `pos-spooler-printer/service/`. Three installers for one service is still two too many.
