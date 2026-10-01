# POS Updater Real-Time Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server and spooler updater windows continuously show the current update phase, real file progress, and current relative file path while preserving the existing backup, rollback, migration, and verification behavior.

**Architecture:** Keep the existing PowerShell updater transaction as the sole owner of update work. Add one tiny line-oriented progress protocol to the already shared `InstallerUpdateState.ps1`, emit throttled events from the existing verification/copy loops and phase boundaries, and consume those events with Inno Setup's native `ExecAndLogOutput` callback and `CreateOutputProgressPage`. The JSON result file remains the authoritative success/failure result; progress output is display-only and must never alter rollback behavior.

**Tech Stack:** PowerShell 5.1, Inno Setup 6.7.3 Pascal Script, Vitest, existing installer contract tests.

## Global Constraints

- Work on `codex/updater-progress`; do not merge or push.
- Use Ponytail at full intensity and mandatory test-first TDD.
- Do not add npm packages, executables, background services, database migrations, database tables, or a second updater framework.
- Do not change release versions, update eligibility, payload contents, service ownership, database backup policy, migration policy, rollback semantics, or health verification semantics.
- Keep update scripts compatible with Windows PowerShell 5.1 and Windows 10 22H2/Windows 11.
- The UI must update while PowerShell is still running; replacing one blocking caption with several pre-call captions is not sufficient.
- Show only relative managed paths. Never emit secrets, environment values, database credentials, full configuration contents, or absolute customer-machine paths.
- File progress must be truthful: `completed` and `total` are exact counts for the active loop. Indeterminate phases hide the file progress bar instead of inventing a percentage or ETA.
- Throttle file events to avoid slowing updates: emit the first item, every 25th item, and the final item. Phase transitions always emit immediately.
- The existing result JSON and exit code remain authoritative. Progress parsing failures must not turn a successful update into a failure.
- Silent updater behavior remains silent and still requires `ACCEPTUPDATE=1`; do not create or show the progress page under `WizardSilent`.
- During interactive updates, cancellation remains unavailable once installation work has begun.

---

### Task 1: Stream Native Real-Time Progress Through Both Updaters

**Files:**
- Modify: `deployment/windows/InstallerUpdateState.ps1`
- Modify: `deployment/windows/Update-PosServer.ps1`
- Modify: `deployment/windows/Update-Spooler.ps1`
- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`
- Modify only if required by an existing file/line architecture reference: `docs/architecture.json`
- Regenerate only if architecture JSON changes: `docs/architecture.html`

**Interfaces:**
- PowerShell emits one display-only record per line:

  `POSAPP_PROGRESS|<step>|<stepTotal>|<completed>|<total>|<label>|<detail>`

- `step` and `stepTotal` are positive integers describing the transaction phase.
- `completed` and `total` are non-negative integers. `total = 0` means indeterminate and hides the file progress bar.
- `label` is concise installer-facing English text and must not contain `|`, CR, or LF.
- `detail` is blank or a relative managed path; Windows managed paths cannot contain `|`.
- `Write-UpdateProgress` writes directly to standard output and flushes it. It must not return pipeline output that could contaminate PowerShell function return values.
- `Test-UpdateProgressCheckpoint` returns true for item 1, each item divisible by 25, and the final item; false otherwise.
- `Read-UpdateManifest` gains optional progress arguments and emits exact verification counts without changing its returned manifest object.
- `Backup-ManagedPayload`, the managed live copy, and retired-file cleanup emit exact progress through shared helpers rather than duplicate loops.
- Both Inno scripts parse only lines beginning `POSAPP_PROGRESS|`; every other output line remains ordinary installer logging.

- [ ] **Step 1: Write failing contract and streaming tests**

Extend `backend/tests/unit/installerUpdateContract.test.js` with focused tests that require:

```js
it('streams a safe throttled updater progress protocol', () => {
  const helper = read('deployment/windows/InstallerUpdateState.ps1');
  expect(helper).toContain('function Write-UpdateProgress');
  expect(helper).toContain('function Test-UpdateProgressCheckpoint');
  expect(helper).toContain('POSAPP_PROGRESS|');
  expect(helper).toMatch(/\[Console\]::Out\.Flush\(\)/);
  expect(helper).not.toMatch(/Write-UpdateProgress[\s\S]{0,500}(DB_PASSWORD|SPOOLER_KEY|secrets\.json)/i);
});

it('uses native line callbacks instead of a frozen blocking updater call', () => {
  for (const file of [
    'deployment/server/POSAPP-Server.iss',
    'deployment/spooler/POSAPP-Spooler.iss',
  ]) {
    const source = read(file);
    expect(source).toContain('CreateOutputProgressPage');
    expect(source).toContain('ExecAndLogOutput');
    expect(source).toContain('POSAPP_PROGRESS|');
    expect(source).toContain('SetText');
    expect(source).toContain('SetProgress');
    expect(source).toContain('WizardForm.Refresh');
    expect(source).toMatch(/if not WizardSilent then[\s\S]*\.Show/);
    expect(source).toMatch(/finally[\s\S]*if not WizardSilent then[\s\S]*\.Hide/);
  }
});
```

Add a real PowerShell child-process test using `node:child_process.spawn`. The test must invoke a small inline PowerShell command that dot-sources `InstallerUpdateState.ps1`, emits one progress record, sleeps briefly, and emits a second record. Assert that the first complete line arrives before process exit, both lines match the seven-field protocol, and the detail is relative. Use a generous timeout and kill the child in `finally` so a failure cannot leave PowerShell running.

Add static assertions that both updater scripts emit all phase transitions and pass progress arguments into shared file operations. Pin at least these labels:

```text
Verifying update package
Verifying installed files
Backing up database
Preparing rollback
Applying database changes
Updating application files
Starting POSAPP
Verifying POSAPP
Connecting to POS server
Starting print spooler
Verifying print spooler
Cleaning up
```

- [ ] **Step 2: Run RED and confirm the correct failures**

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js
```

Expected: failures identify the absent progress writer/checkpoint contract, absent streaming records, and the current blocking `Exec(... ewWaitUntilTerminated ...)` updater calls.

- [ ] **Step 3: Implement the minimal shared progress protocol**

In `InstallerUpdateState.ps1`, add the smallest safe helpers:

```powershell
function ConvertTo-UpdateProgressField([string]$Value) {
    return (($Value -replace '[\r\n|]', ' ').Trim())
}

function Write-UpdateProgress {
    param(
        [int]$Step,
        [int]$StepTotal,
        [string]$Label,
        [string]$Detail = '',
        [int]$Completed = 0,
        [int]$Total = 0
    )
    $line = 'POSAPP_PROGRESS|{0}|{1}|{2}|{3}|{4}|{5}' -f $Step, $StepTotal, $Completed, $Total,
        (ConvertTo-UpdateProgressField $Label), (ConvertTo-UpdateProgressField $Detail)
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Test-UpdateProgressCheckpoint([int]$Completed, [int]$Total) {
    return $Completed -eq 1 -or $Completed -eq $Total -or ($Completed % 25) -eq 0
}
```

Do not use `Write-Output` inside `Write-UpdateProgress`; PowerShell pipeline output would become part of assignments such as `$manifest = Read-UpdateManifest ...`.

Extend the existing shared loops with optional step/label inputs. Emit only at `Test-UpdateProgressCheckpoint` checkpoints. Keep returned values byte-for-byte compatible in shape with current callers.

Extract the identical server/spooler managed-copy loop into one shared `Copy-ManagedPayload` helper only because both callers now require the same progress and path-safety behavior. Do not extract unrelated update orchestration.

- [ ] **Step 4: Emit truthful phase boundaries in server and spooler updates**

In `Update-PosServer.ps1`, use an eight-step transaction:

1. Verify update package and installed files.
2. Back up database.
3. Prepare rollback.
4. Stop POSAPP and apply database changes.
5. Update application files.
6. Start POSAPP.
7. Verify POSAPP health/schema/release.
8. Clean up and write metadata.

In `Update-Spooler.ps1`, use a six-step transaction:

1. Verify update package, installed files, and POS server connection.
2. Prepare rollback.
3. Stop print spooler.
4. Update application files.
5. Start and verify print spooler.
6. Clean up and write metadata.

Emit indeterminate records (`total = 0`) before database backup, migrations, service operations, health probes, and metadata/cleanup. Emit exact totals only from file loops. Keep the existing `$phase` values used in failure messages unchanged unless a label-only improvement is required; UI labels are not error-state identifiers.

- [ ] **Step 5: Replace the frozen Inno updater call with the native streaming page**

In both `.iss` files:

1. Create one `TOutputProgressWizardPage` in `InitializeWizard` under `#ifdef UpdateOnly`.
2. Add a small parser for the exact seven-field protocol. Ignore malformed and non-progress lines without raising an exception.
3. In the `TOnLog` callback, update the page with:
   - primary text: `Step X of Y — <label>`
   - secondary text: `<detail>` or blank
   - `SetProgress(completed, total)` when `total > 0`
   - `SetProgress(0, 0)` when `total = 0`
   - `WizardForm.Refresh` after each accepted event
4. Replace only the updater PowerShell invocation with `ExecAndLogOutput(..., ewWaitUntilTerminated, ..., @UpdateProgressLog)`.
5. Show the page immediately before launching PowerShell and hide it in `finally`.
6. Under `WizardSilent`, do not show/hide or refresh the page, but still run the same script and preserve the result-file behavior.
7. Keep the current exception text and result JSON handling.

Use Inno's native page. Do not add a custom WinForms/WPF window, polling timer, second executable, or filesystem watcher.

- [ ] **Step 6: Run GREEN verification**

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
npm run architecture:check
```

Expected: all tests pass and architecture validation succeeds.

Compile both updater definitions with the repository's pinned Inno Setup compiler and the existing prepared stages:

```powershell
& .\deployment\out\toolchain\inno\ISCC.exe /DUpdateOnly=1 /DAppVersion=1.0.2 .\deployment\server\POSAPP-Server.iss
& .\deployment\out\toolchain\inno\ISCC.exe /DUpdateOnly=1 /DAppVersion=1.2.2 .\deployment\spooler\POSAPP-Spooler.iss
```

Expected: both compile successfully with no Pascal Script errors. The generated ignored executables are verification artifacts and must not be committed.

- [ ] **Step 7: Review scope and behavior**

Inspect the complete diff and confirm:

- No updater safety step was removed or reordered incorrectly.
- The JSON result file and non-zero exit handling are unchanged.
- Interactive callbacks receive records while the child process is still alive.
- Full paths and secrets cannot enter progress records.
- File-event throttling is active.
- Silent mode creates no visible progress page.
- No release, database, dependency, payload, or installer-fresh-install changes slipped in.
- `git diff --check` is clean.

- [ ] **Step 8: Commit**

```powershell
git add deployment/windows/InstallerUpdateState.ps1 deployment/windows/Update-PosServer.ps1 deployment/windows/Update-Spooler.ps1 deployment/server/POSAPP-Server.iss deployment/spooler/POSAPP-Spooler.iss backend/tests/unit/installerUpdateContract.test.js docs/superpowers/plans/2026-08-10-updater-real-time-progress.md
git commit -m "feat: show real-time updater progress"
```

Do not merge or push.

## Final Verification

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
npm run architecture:check
git diff --check HEAD~1..HEAD
git status --short
```

Report the commit SHA, RED evidence, exact passing test counts, both Inno compile results, streaming-before-exit evidence, any remaining inability to automate a visible GUI assertion, and final branch status.
