# Grok audit — V2-only V1-removal plan (rev 5)

**Date:** 2026-08-19  
**Reviewer:** Grok 4.6 (independent), for Sol  
**Subject:** `docs/superpowers/plans/2026-08-18-spooler-v2-only-v1-removal.md` rev 5 (working copy)  
**Prior history:** `docs/superpowers/evidence/2026-08-19-spooler-v2-only-removal-plan-review.md` — five rounds, ~28 confirmed findings, three withdrawn claims. §9 of that file names the recurring failure modes this audit was written to re-check.  
**Method:** read-only investigation against the tree at `codex/spooler-v2-remove-v1`, HEAD `da216b27` (“docs(spooler): plan V2-only legacy removal”). The spooler runtime under review is its parent `b65491e6`. No plan step was executed, no file other than this report was modified, no migration was applied, no test suite was run. Every `file:line` below was opened and the *statement* it belongs to was read.

**What this is.** Rev 5 survived a scripted self-audit of 117 anchors. That check is structural: the path exists and the line number is in range. It does not prove the surrounding claim is true. This report only records defects that were verified in the code. Agreement with the plan is omitted unless it is needed to show what was attacked and did not break.

**Standing relative to §9.** The same three classes of defect that produced rounds 2–5 are still present: a task’s GREEN command cannot pass using only work scheduled in that task; a `file:line` whose statement is not what the prose claims; a gate or proof that cannot pass from the evidence it names.

---

## How to read this

Each finding has:

1. **Severity** — High / Medium / Low, with the concrete consequence (what breaks, for whom, when).
2. **Evidence** — `file:line` opened in this audit, quoted or paraphrased from the statement, not from a grep hit or from the plan’s own anchors.
3. **Failure scenario** — the sequence that produces the bad outcome if the plan is executed as written.
4. **Fix direction** — one or two sentences, not a patch.

Findings are ordered by severity, then by how early in execution they strand the branch.

---

## High

### H1 — Task 1 GREEN is unreachable: two live spooler suites are missing from the eight-suite table

**Severity:** High. `npm --prefix pos-spooler-printer test` at the end of Task 1 cannot pass. The Task 1 commit cannot be taken.

**Evidence.** `pos-spooler-printer/tests/run-tests.js:5` executes **every** `*.test.js` in that directory, sorted. The plan already recorded this fact and listed eight suites. Checking the whole directory found two more that break the moment `v2-server.js` or the cutover journal/CLI disappears:

`pos-spooler-printer/tests/v2-hostile-runtime.test.js` is live V2 hostile coverage, not a leftover V1 suite:

```13:19:pos-spooler-printer/tests/v2-hostile-runtime.test.js
const { createHelperEventHandler, startupJitterMs } = require('../v2-server');
...
const V2_SOURCE = fs.readFileSync(path.join(ROOT, 'pos-spooler-printer', 'v2-server.js'), 'utf8');
...
const V1_CLAIM_SOURCE = fs.readFileSync(path.join(ROOT, 'backend', 'services', 'printQueue.js'), 'utf8');
```

`:531-532` of the same file still asserts that the updater contains `cutover_prepared` / `v2_application_active` and that Repair contains `v1_drained`. `:516` asserts `printQueue.js` contains `spooler_stations`. Task 1 deletes `v2-server.js` and the cutover phases; Task 2 deletes `printQueue.js`. The suite cannot even load after Task 1.

`pos-spooler-printer/tests/installerUpdateContract.test.js` is a **different file** from `backend/tests/unit/installerUpdateContract.test.js` (the one Task 1 GREEN already runs under vitest):

```12:16:pos-spooler-printer/tests/installerUpdateContract.test.js
        'cutover_prepared',
        'v1_drained',
        'v1_stopped',
        'v2_application_active',
```

`:68-75` require `Update-Spooler.ps1` to contain `--rollback-v1` and Repair to contain `Invoke-SpoolerV2Recovery 'rollback-self'` and `/api/spooler/v2/abort-prepare`. Task 1 removes those phases and CLIs.

`external-config.test.js` **is** in the table, as “Edit — drop the V1 reference, keep the config coverage.” That disposition is too small. The file is not only `poll-fallback`:

- `:6-24` read V1 `server.js` and assert Socket.IO tokens (`transports: ['websocket', 'polling']`, `createPollFallbackScheduler`, `tryAllTransports: true`).
- `:28` `require('../v2-server')` for `assertProductionConfig`.
- `:47` and `:57` read and spawn `v2-server.js`.

After Task 1 replaces `server.js` with the durable agent, the first 24 assertions fail even if `poll-fallback.js` is gone.

This is the same class as rev 5 St1 (Task 1 GREEN unreachable because `run-tests.js` runs every suite, and the disposition table was built from a partial list). Rev 5 listed eight suites; these two were not among them.

**Failure scenario.** Task 1 moves the durable agent to `server.js`, deletes `v2-server.js`, strips cutover phases, then runs GREEN. `run-tests.js` loads `v2-hostile-runtime.test.js` and throws `MODULE_NOT_FOUND` for `../v2-server`. If that file is patched in isolation, `installerUpdateContract.test.js` still fails on `v1_drained` / `--rollback-v1`. The Task 1 commit cannot be taken.

**Fix direction.** Add both suites to the Task 1 table as **edit**, not delete — hostile-runtime is the live V2 coverage for lock, replay, lane isolation, and transport markers. Re-point `v2-server` → `server.js`, drop the cutover/`printQueue.js` source scans, and treat `external-config.test.js` as a rewrite of the V1 `server.js` contract plus a re-point of `assertProductionConfig`.

---

### H2 — The known-trap for `--prepare` names the wrong statement. The plan tells the executor not to remove the V1 station-prepare CLI.

**Severity:** High. Following the trap preserves `POST /api/spooler/v2/prepare`. After Task 2 deletes that route, fresh install (and any leftover `--prepare` invocation) 404s.

**Evidence.** Plan “Known traps” says: `` `--prepare` in `v2-server.js:98` is the platform-helper flag, unrelated to V1 station prepare at `v2-server.js:103`. `installerPackageContract.test.js:732` asserts the helper token. Do not remove it. ``

The opened statements are:

```98:107:pos-spooler-printer/v2-server.js
    if (process.argv.includes('--prepare')) {
        const result = await syncClient.prepare();
        await close();
        return { helper, store: null, runtime: null, prepare: result, close };
    }
    if (process.argv.includes('--rollback-v1')) {
        const result = await syncClient.rollbackSelf();
        ...
    }
```

`sync-client.js:38-39` is `post('/api/spooler/v2/prepare', ...)`. That is station cutover prepare, not a helper flag.

`Install-Spooler.ps1:254-261` is the only production caller:

```254:261:deployment/windows/Install-Spooler.ps1
    if ($EnableV2) {
        ...
        & $node $v2Script --prepare
        if ($LASTEXITCODE -ne 0) { throw 'V2 station prepare failed during installation.' }
```

`installerPackageContract.test.js:732` asserts that the **provisioning script** contains `--prepare`, in the same token list as `$EnableV2` and `v2-server.js`. It is not asserting a helper flag.

There is no platform-helper `--prepare` anywhere in the tree. `pos-spooler-printer/v2/platform-helper.js` has no `prepare`. `windows-helper/` has none. The only `process.argv.includes` sites in the spooler package are `--prepare` and `--rollback-v1` in `v2-server.js`. Helper startup is `startPlatformHelper` at `v2-server.js:75`, which runs unconditionally before the CLI branch.

The plan has the lines backwards, and `:103` is `--rollback-v1`, not “V1 station prepare.” This is the same class as St2 (an `INSERT` column list read as a `SELECT`) and the retracted old-updater HIGH: the line number was opened, the statement it belongs to was not.

**Failure scenario.** The executor keeps `--prepare` because the trap says “Do not remove it.” Task 2 deletes `/api/spooler/v2/prepare`. A fresh install (or a leftover CLI after the move into `server.js`) calls it and 404s before the service is verified.

**Fix direction.** Delete `--prepare` and `--rollback-v1` with cutover. Do not describe either as a helper flag. Flip `installerPackageContract.test.js:732` so `--prepare` is absent from provisioning.

---

### H3 — After `$EnableV2` is deleted, the success / verify / install paths the fleet actually takes still target `v2-server.js` and still prove V1 socket presence

**Severity:** High. The first V2-only update of an already-V2 station (the required fleet state) can leave NSSM on a deleted file. The next update, and every fresh install without `/ENABLEV2`, can fail verification and roll back. Stations stop printing.

**Evidence.** The plan cites rollback (`Update-Spooler.ps1:586`, `:605`) and Repair ValidateSet (`Repair-SpoolerStartup.ps1:37`). It does not cite the success, verify, or install branches that run for an already-V2 station once `$EnableV2` is gone.

**Success-path NSSM write.** Already-V2 stations take the `elseif`:

```504:512:deployment/windows/Update-Spooler.ps1
    if ($EnableV2) {
        Set-SpoolerApplicationScript 'v2-server.js'
        Update-SpoolerJournalPhase 'v2_application_active'
    } elseif ($v2ActiveBefore) {
        Set-SpoolerApplicationScript 'v2-server.js'
        Update-SpoolerJournalPhase 'target_application_active'
    } else {
        Update-SpoolerJournalPhase 'target_application_active'
    }
```

`$v2ActiveBefore` (`:413`) is “NSSM currently points at `v2-server.js`.” That is every station the release gate allows in. Two executor readings both fail:

- Keep the `elseif` → NSSM is re-pinned to the file Task 1 just deleted.
- Delete both `$EnableV2` arms and fall through to `else` → NSSM is never moved off the deleted file. `Copy-ManagedPayload` / `Remove-RetiredManagedPayload` have already removed `v2-server.js`.

**Verify.** After a first update that does repoint NSSM to `server.js`, `$v2ActiveBefore` is false:

```521:530:deployment/windows/Update-Spooler.ps1
    if ($EnableV2 -or $v2ActiveBefore) {
        $v2AgentId = Get-V2AgentId ...
        $v2State = Wait-V2Registration ...
        ...
    } else {
        $status = Wait-SelfStatus $serverUrl ...
    }
```

`Wait-SelfStatus` (`:173-183`) is `GET /api/spooler/self-status`. That route (`backend/routes/spooler.js:59-63`) reports `spoolerRegistry` socket presence (`connected: Boolean(state)`). A V2 HTTP agent never registers a printer socket, so `connected` stays false even while the durable agent is healthy. After Task 2 the route is deleted (404). `installerUpdateContract.test.js:634` pins `"$EnableV2 -or $v2ActiveBefore"` — keeping that condition to satisfy the existing test preserves this else branch.

**Fresh install.** Without `$EnableV2`, `Install-Spooler.ps1` already targets `server.js` (`:241`), which is correct after the move. Verification is not:

```285:294:deployment/windows/Install-Spooler.ps1
    } else {
        do {
            try {
                $status = Invoke-RestMethod -Uri "$ServerUrl/api/spooler/self-status" ...
                if ($status.connected -and $status.spooler_id -eq $SpoolerId ...) { break }
```

The V2 journal, the `POSAPP Spooler Startup Health Repair` scheduled task, the `/api/spooler/v2/status` wait, and the catch-to-Repair handoff are **entirely** inside `if ($EnableV2)` (`:199-216`, `:268-284`, `:306-321`). Deleting the switch removes crash recovery from fresh install. The remaining catch restores `spooler.env` and may delete the service; it does not journal.

The EnableV2 install verify also requires `first_v2_accepted_at` (`:275-281`). That column is only set when a job moves `sent → local_accepted` (`spoolerSync.js:93`). Copying that check onto every fresh install would refuse to commit until something has physically printed. The plan’s update wording is “registration plus fresh sync,” which is the right bar; the current EnableV2 install check is a higher bar and must not be copied blindly.

**Other live `v2-server.js` / `ENABLEV2` targets not covered by the Task 1 Repair/Update punch list:**

- `Install-Spooler.ps1:143` (payload required files), `:181` (owned-script allow-list), `:209` (`targetScript = 'v2-server.js'`), `:241`, `:256`.
- `POSAPP-Spooler.iss:73-80` (`/ENABLEV2` → `-EnableV2`).
- `Update-Spooler.ps1:88-95` `Get-ServiceOwnerState` — **must keep** `v2-server.js` as a recognised existing script, or an already-V2 station becomes `invalid` and `:412` refuses the update.
- `SpoolerLayerState.ps1:4-5` cutover phases; `:256-269` `preserve_v2` / protocol `v1` install recovery.
- `scripts/build-installers.ps1:367`, `deployment/tools/spooler-layer-manifest.js:16`, `deployment/tools/validate-payload.js:26` — Task 1 does list these.
- `tests/installer/update-sandbox-guest.ps1:339`, `tests/installer/fresh-install-smoke.ps1:143-144`, `tests/installer/spooler-update-probe.ps1:10` still call `/api/spooler/self-status`. None is in any task’s file list.

**Failure scenario.**

1. Fleet is on `v2-server.js` (release gate).
2. New updater deletes `v2-server.js`, then either re-pins NSSM to the missing file (`elseif`) or leaves NSSM there (`else`). Service does not start. Printing stops.
3. If they do repoint to `server.js`, the *next* update (and every later package) takes `Wait-SelfStatus`. The V2 agent is never `connected` in the V1 registry → verify fails → rollback. After Task 2 the same call 404s.
4. A new station installed without `/ENABLEV2` takes the self-status else branch and never commits. There is no install journal to recover from.

**Fix direction.** Always `Set-SpoolerApplicationScript 'server.js'` on commit. Always verify with V2 register + fresh `last_sync_at` (`/api/spooler/v2/status`), not self-status. Hoist install journal, startup-repair registration, and catch-to-Repair out of `$EnableV2`. Keep `v2-server.js` only as a *previous* owned script in `Get-ServiceOwnerState` and in ValidateSet. Do not require `first_v2_accepted_at` to commit a fresh install.

---

### H4 — Reboot repair after the `v2-server.js` → `server.js` move restores the old files and leaves NSSM on the new name

**Severity:** High. A crash after NSSM is moved to `server.js`, then a reboot, starts the restored V1 `server.js` against a V2-only server. The station reports as installed and prints nothing.

**Evidence.** `Save-SpoolerJournal` writes phase, rollback roots, env hash, and recovery-script hashes. It does **not** write `previousScript` or `targetScript`:

```302:318:deployment/windows/Update-Spooler.ps1
function Save-SpoolerJournal(...) {
    $journal = [ordered]@{
        format = 1; transactionId = ...; mode = $ModeName; phase = $JournalPhase
        ...
        originalServiceStartupMode = $StartupMode
        envPath = ...; envLength = ...; envSha256 = ...
        recoveryScripts = @(...)
        runtimeRenames = @($script:runtimeRenames)
    }
```

The non-Install, non-cutover Repair arm — the arm a post-Task-1 `target_application_active` / `service_stopped` journal will hit — restores files and **never** calls `Set-SpoolerRepairEntryPoint`:

```291:303:deployment/windows/Repair-SpoolerStartup.ps1
        } else {
            Set-SpoolerRepairServiceStartupMode 'Disabled'
            Stop-SpoolerForRepair
            Restore-SpoolerRuntimeFromJournal $journal
            Restore-SpoolerApplicationFromJournal $journal
            ...
            Set-SpoolerRepairServiceStartupMode ([string]$journal.originalServiceStartupMode)
            Start-SpoolerForRepair
```

Today that is safe because an already-V2 update re-pins `v2-server.js` (`H3`) and the NSSM name does not change. Task 1 is the first update that *must* change the name. In-process rollback at `:586` / `:605` does not survive reboot; Repair is the only recovery.

Task 1 says two things that fight: “journals prior entry point” and “Repair always targets `server.js`.” Uncommitted recovery must restore *previous*, not the new target. Repair `:241` and `:274` currently call `Set-SpoolerRepairEntryPoint 'v2-server.js'` as the **complete-the-V2-cutover** arm; `:261` and `:283` call `'server.js'` as the **V1 rollback** arm. After Task 1, literal `server.js` is the durable agent, not V1. “Always target `server.js`” on a rollback of an interrupted already-V2 station starts the restored V1 binary under the new name.

**Failure scenario.** Updater swaps files, repoints NSSM to `server.js`, then the machine loses power. Reboot runs Repair. Old payload comes back (`server.js` = V1, `v2-server.js` = durable). NSSM still says `server.js`. Service runs V1, which connects by Socket.IO to a server with no printer handler (after Task 2) and polls `/api/spooler/poll` for a 404.

**Fix direction.** Persist `previousScript` / `targetScript` on every update journal. Uncommitted Repair: previous files + previous NSSM script (`v2-server.js` legal as previous). Committed / `v2_verified`: `server.js` + new files. Stop using literal `server.js` as the V1 rollback target. Keep both names in ValidateSet (that is an allow-list, not a default).

---

### H5 — Task 3 GREEN cannot pass with the files the plan names

**Severity:** High. The first GREEN file in Task 3 throws, or a fresh installer bootstrap refuses to start.

**Evidence.**

**(a) A file Task 2 deletes is still read by a suite Task 3 GREEN runs.**

Task 2 deletes `backend/services/printQueue.js`. Task 2’s GREEN list does not include `schemaAuthority.test.js`. Task 3 GREEN runs that file first.

```407:416:backend/tests/unit/schemaAuthority.test.js
    it('opens the HTTP port before slow migration checks and gates traffic until the schema is ready', () => {
        const printQueue = fs.readFileSync(path.join(ROOT, 'backend/services/printQueue.js'), 'utf8');
        const printerStatus = fs.readFileSync(path.join(ROOT, 'backend/services/printerStatus.js'), 'utf8');
        const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        ...
        expect(printQueue).not.toMatch(/ALTER TABLE|ensurePrintQueueSchema/);
```

That is `ENOENT` before any schema assertion runs.

**(b) The plan cites the wrong / incomplete `schemaValidation.js` statements.**

Task 3 files name `schemaValidation.js:920`. That line is the probe:

```917:920:backend/services/schemaValidation.js
             ,(SELECT COUNT(*) FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA=DATABASE()
                  AND TABLE_NAME='spooler_stations'
                  AND COLUMN_NAME IN ('spooler_id','delivery_protocol','v2_activated_at','first_v2_accepted_at','updated_at')) AS spooler_stations_columns
```

The required count is a separate constant:

```110:110:backend/services/schemaValidation.js
    ,spooler_stations_columns: 5
```

The ledger tip that `validateRequiredSchema` actually requires is a third site:

```1:2:backend/services/schemaValidation.js
const MIGRATION_NAME = '2026-08-17-spooler-v2-agents-v1';
const MIGRATION_CHECKSUM = 'e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985';
```

`:984-988` loads that name from `schema_migrations` and throws `The migration ledger entry is missing.` if it is absent. `schemaAuthority.test.js:6-7` and `:639` pin the same old tip; `:130` mocks `spooler_stations_columns: 5`.

Editing only `:920` (drop `delivery_protocol` from the `IN` list) makes the probe return 4 while `REQUIRED_COUNTS` still wants 5 → boot fails with `Missing or invalid requirements: spooler_stations_columns`.

**(c) Fresh-install ledger stamp is not in the file list.**

`deployment/tools/bootstrap-database.js:115-140` inserts `schema_migrations` only through the 2026-08-17 row. It is not named in Task 3.

`backend/tests/fixtures/seed.js:876` is named (the `CREATE TABLE` column). The ledger stamp at `seed.js:1327` is not. Seeded databases stay on the old tip after `schemaValidation` moves.

**(d) The GREEN test that actually boots a database uses the real validator.**

`installerBaseline.test.js:116-137` bootstraps `posapp_installer_test` with **no** `validate` override. The comment at `:136` is: “this must run the real `validateRequiredSchema` the server boots with.” The fake-executor test at `:62-66` still passes (`validate: async () => true`). The real scratch test applies the new baseline, inserts only the old tip, then validation fails.

`backend/tests/unit/installerPackageContract.test.js:303-306` pins `manifest.migrations.at(-1)` to `2026-08-17-spooler-v2-agents-v1`. After approval this fails `test:installer` (Task 4), which the plan added specifically so a missing file cannot sneak through.

**Failure scenario.** Task 2 is committed as written. Task 3 runs `npx vitest run backend/tests/unit/schemaAuthority.test.js ...` and dies on the deleted `printQueue.js`. If that is patched and only `:920` is edited, `REQUIRED_COUNTS` still wants 5 columns and the old ledger tip. Fresh install then fails `validateRequiredSchema` at boot. A human checking the test DB after `seed.js` DDL was updated, without the new ledger row, fails the same way.

**Fix direction.** Retarget or drop the `printQueue.js` read in Task 2 (when the file is deleted). In Task 3 update `schemaValidation.js` `:1-2`, `:110` (5→4), and `:920` together; stamp the new name/checksum in `bootstrap-database.js` and `seed.js:1327`; update `schemaAuthority.test.js` and `installerPackageContract.test.js` last-entry pins.

---

### H6 — CHECK-then-drop on the rewritten baseline cannot replay through `automaticMigrations.test.js`

**Severity:** High. After approval, adding `.auto.sql` + an `auto-manifest.json` entry makes the existing chain test fail, and a current-baseline replay cannot execute `ADD CHECK (delivery_protocol='v2')`.

**Evidence.** Predecessor `2026-08-17-spooler-v2-agents-v1` / `e2645cba5f636d9e50e7dea241d8548a61371666a94f9d6c7604946ad7e4b985` **is** the last auto-manifest entry (`backend/migrations/auto-manifest.json:198-209`). That part of the plan is correct. `deployment/database/manifest.json` is the baseline hash pin (`migrations: []`), not the auto-ledger.

The chain test is the problem:

```86:132:backend/tests/integration/automaticMigrations.test.js
            const baseline = fs.readFileSync(path.resolve(__dirname, '../../../deployment/database/baseline.sql'), 'utf8');
            await admin.query(baseline);
            ...
            await expect(runPendingMigrations(pool)).resolves.toEqual({
                applied: [..., SPOOLER_V2_NAME],
                skipped: [],
            });
```

It loads **current** `baseline.sql`, stamps only the July 29 ledger, then applies the entire auto-manifest. Expected `applied` ends at `2026-08-17-spooler-v2-agents-v1`. The second run hard-codes `skipped` to the same closed list.

`backend/migrations/2026-08-17-spooler-v2-agents-v1.sql:9-16` is `CREATE TABLE IF NOT EXISTS spooler_stations (... delivery_protocol ...)`. After Task 3 the baseline already created the table **without** that column. `CREATE TABLE IF NOT EXISTS` is a no-op and does not add the column. Plan Task 3 `:309-314` then requires `ADD CHECK (delivery_protocol='v2')` before `DROP COLUMN`. That is `Unknown column 'delivery_protocol'`.

Even if the CHECK is skipped, the test still fails because `applied` / `skipped` no longer match.

`DROP COLUMN IF EXISTS` is the local idempotent pattern (`2026-08-13-webauthn-registered-device-access.auto.sql:128-130`).

**Failure scenario.** Luna rewrites `baseline.sql` without `delivery_protocol` (Task 3). After explicit approval, `.auto.sql` and an `auto-manifest.json` entry are appended. The July-29-through-tip replay hits `Unknown column 'delivery_protocol'` at the CHECK, or — if that is skipped — the hardcoded `applied` list is wrong. Task 3 GREEN does not run this file; Task 4 `npm run test:unit` does, after the auto-manifest exists.

**Fix direction.** Do the fail-closed proof in preflight / a `SELECT`, and make `.auto.sql` idempotent on a no-column table (`DROP COLUMN IF EXISTS`, no CHECK against a missing column). Or change the chain test to start from the exact 2026-08-17 floor. Extend the hardcoded applied/skipped lists. If a CHECK is kept, name it (see L1).

---

## Medium

### M1 — Gate item 3 is unprovable as written and deadlocks with item 6 on leftover work

**Severity:** Medium. A dead station that still owns queue rows can block both the release gate and Task 3’s CHECK with no documented remedy. The same class as rev 4 Sp1 (two gate items deadlock on one row), in a new pair: item 3 vs item 6.

**Evidence.** Item 3: “every station has non-null `first_v2_accepted_at` and fresh `last_sync_at`.” Those are not both on the station.

| Column | Table | Writer |
|---|---|---|
| `first_v2_accepted_at` | `spooler_stations` (`baseline.sql:675`) | only `spoolerSync.js:93`, on `sent → local_accepted` |
| `last_sync_at` | `spooler_agents` (`baseline.sql:689`) | `spoolerSync.js:265`, only if agent `status IN ('active','draining')` |

`spooler_stations` has **no** `last_sync_at`. Admin health aliases the live agent’s timestamp (`backend/routes/admin/printQueue.js:79,126`). A query that does not join the live agent is not implementable as written.

“Fresh” is undefined. The only coded windows are `FRESH_SYNC_MS = 30s` (`printQueue.js` admin `:11`, `:22-30`) and `REACHABLE_WINDOW_SECONDS = 30` (`spoolerAgents.js:236`). Agent `nextSyncMs` is 2000 (`spoolerSync.js:2`). If “fresh” is read as the product’s 30-second online window, a snapshot taken while agents are idle (night, reboot, brief network blip) fails item 3 for every live station.

`first_v2_accepted_at` stays NULL for a correctly registered V2 station that has never accepted a job. Item 5 (physical print) is what would set it. Item 3 does not say that. Registration (`spoolerAgents.js:181`) sets `delivery_protocol='v2'` and `v2_activated_at`; it does not set `first_v2_accepted_at`.

Item 1 was scoped to “stations referenced by an active printer” specifically to kill the rev 4 deadlock (retired V2, no printer, only revoked agents). Item 3 was left as “every station.”

Item 6 will not delete a station with non-terminal queue work. Its printer join for *existence* requires `p.is_active = 1`, but the queue join uses `q.printer_id IN (SELECT id FROM printers WHERE spooler_id = s.spooler_id)` **without** `is_active`. Inactive printers keep leftover `pending` / `failed` rows attached and undeletable.

The item 6 terminal list `NOT IN ('acknowledged','dead_letter','canceled')` matches `spoolerSync.js:3` and is **wider** than the surrounding prose (`pending`/`sent`/`local_accepted`/`cancel_requested`): it also keeps `processing` and `failed`. Safer than the prose; not a join bug. `WHERE a.agent_id IS NULL` is the correct PK. `LEFT JOIN` multiplicity does not make `q.id IS NULL` wrong for orphans — multiplicity only happens when a printer or live queue exists, and those rows fail `p.id IS NULL` / `q.id IS NULL`.

**Deadlock table (station-row states vs items 1 / 3 / 6):**

| Row state | Item that fails | Item that cannot repair it |
|---|---|---|
| No live agent, no active printer, **non-terminal** queue (incl. `pending`/`failed` on **inactive** printers) | 3 (and 2 if still `v1`) | 6 will not list it; nothing to upgrade |
| Live agent, never accepted a job | 3 (`first_v2_accepted_at` NULL) | 6 will not list it; only item 5 / first accept repairs it |
| `v1` orphan, no agent/printer/queue | 2 and 3 | 6 **can** delete (order: 6 then recheck 2/3) |
| Active printer, zero live agents | 1 (and 3) | 6 will not delete; upgrade/replace is the repair |
| Mid-replace, zero live agents | 1 | transient |

The retired-V2-with-no-printer deadlock from rev 4 Sp1 **is** fixed: item 1 is now scoped, and item 6 no longer filters on `delivery_protocol`. The leftover-work pair is the surviving instance.

Item 6 passing on a read-only snapshot means no orphans remain. Item 3 as “every remaining `spooler_stations` row” still fails until orphans are deleted first. The plan’s “if any row fails, stop” does not state that order, and only item 6 has the delete remedy.

**Failure scenario.** Printers set `is_active=0` (or reassigned) while `pending`/`failed` rows remain. No live agent. Item 1 does not apply. Item 6 will not list the station. Item 3 cannot see `first_v2_accepted_at` or a fresh `last_sync_at`. If the row is still `v1`, Task 3’s CHECK fails forever. “Upgrade or repair that station using the compatible branch” has no machine. This is H1 from rev 1 wearing a new hat: fail-closed with no legal remedy.

**Fix direction.** Scope item 3 like item 1 (stations referenced by an active printer, join the live agent’s `last_sync_at`). Define “fresh” as the 30s window or as non-null, explicitly. Document cancel/drain of leftover queue rows as the only remedy for the leftover-work case. Do not treat `first_v2_accepted_at` as an upgrade signal; item 5 is what sets it. State that item 6’s approved delete runs, then items 2 and 3 are re-queried.

---

### M2 — Gate item 1 has no SQL; “exactly one” is only half-enforced by the schema

**Severity:** Medium. The gate is a deployment stop. Without a query, two reasonable readings disagree, and a mid-replace snapshot fails a live fleet.

**Evidence.** Item 1: “every station **referenced by an active printer** has exactly one `active` or `draining` agent.” No SQL is given (items 6 and 7 have queries; this one does not).

`spooler_agents.active_station_key` is generated as `spooler_id` only when `status IN ('active','draining')`, under `UNIQUE KEY uq_spooler_agents_active_station` (`2026-08-17-spooler-v2-agents-v1.sql:32-35`; `baseline.sql:693-695`). That proves **at most one** live agent per station. **Zero is legal.** Drain (`spoolerAgents.js:253-257`) flips the same row `active → draining`; replace (`:291-308`) selects `status IN ('active','draining')` as one row. Active **and** draining cannot coexist. The unique key is a backstop, not a readiness query.

`printers.spooler_id` is `NOT NULL DEFAULT 'primary'` (`baseline.sql:712`). A printer whose `spooler_id` has **no station row** is zero agents here, and is also gate 7. Overlap, not a deadlock.

Transient zero-agent window: `replaceAgent` revokes the live agent, then a later `/register` inserts the next. A snapshot during that gap fails item 1.

Needed query (failures = not ready):

```sql
SELECT p.spooler_id, COUNT(DISTINCT a.agent_id) AS live_agents
  FROM printers p
  LEFT JOIN spooler_agents a
    ON a.spooler_id = p.spooler_id AND a.status IN ('active','draining')
 WHERE p.is_active = 1
 GROUP BY p.spooler_id
HAVING COUNT(DISTINCT a.agent_id) <> 1;
```

**Failure scenario.** Operator writes “at least one active agent” and passes a draining-only station, or writes “status = active” and fails every station currently draining. Or they snapshot during replace and stop a healthy fleet.

**Fix direction.** Put the query in the plan. State that draining counts. State that a mid-replace zero is a retry, not a rollback-to-V1 event.

---

### M3 — Gate item 4 is the right V1-stranding predicate and does not cover leftover owned V2 work

**Severity:** Medium as a completeness gap for the gate, not as a V2 exactly-once break. Item 4 cannot see owned `sent` whose agent is already revoked and was not replace-terminalized.

**Evidence.** Item 4: `agent_id IS NULL AND status IN ('processing','sent')` is zero. Table is `print_queue`. Same predicate as the registration guard (`spoolerAgents.js:167-173` and `:142-148`).

V2 never writes `processing`. Claim sets `status='sent'` and `agent_id` together (`spoolerSync.js:218-226`). V2 in-flight with **non-null** `agent_id` is `sent` / `local_accepted` / `cancel_requested` (settle only from the last two, `:127`). So `agent_id IS NOT NULL AND status IN ('processing','sent')` is **not** a V2 bug; owned `sent` is normal.

Item 4 **misses**:

- `local_accepted` / `cancel_requested` (always owned in the live path; no production writer clears `agent_id`).
- `pending` / `failed` with `agent_id IS NULL` (normal unclaimed; V2 will claim them).
- Owned `sent` whose agent is already `revoked` and was **not** replace-terminalized (`replaceAgent` `:310-316` is the only owned-work terminalizer).

Those last rows are non-terminal, so item 6 will not delete the station; item 1 fails if a printer is still active.

`terminalize-v1` (`backend/routes/admin/printQueue.js:298-336`) is the **only** writer that dead-letters `agent_id IS NULL AND status IN ('processing','sent')`, and it requires `delivery_protocol='transitioning'`. After it is deleted, leaked un-owned `processing`/`sent` have no admin repair except SQL. Gate 4 is supposed to be zero first; after cutoff nothing new can create those rows because V1 claim is gone. Replace still covers **owned** V2 uncertain work. Rollback / terminalize-v1 are not a needed path for V2 uncertain work.

**Failure scenario.** A replace that revoked the agent without terminalizing (force path bug, or a crash between revoke and the terminalize UPDATE) leaves owned `sent` rows. Item 4 is green. Item 6 will not delete. Item 1 fails if a printer is still active. No remaining admin button terminalizes them.

**Fix direction.** Keep item 4 as the V1-stranding interlock (it is the right predicate). Add a sibling check for `agent_id IS NOT NULL AND status IN ('sent','local_accepted','cancel_requested')` whose agent is not `active`/`draining`, or state that replace is the repair and must have been used before the snapshot.

---

### M4 — Gate item 8 is still a checkbox

**Severity:** Medium. Rev 4 Sp1 correctly stopped pretending station telemetry proves media withdrawal. The remaining hole is that “every distribution location in use” is not a closed set.

**Evidence.** Item 8 requires: approved package version + artifact SHA-256; confirmation that earlier installer/updater artifacts are withdrawn from every distribution location; installed release version per station as a cross-check.

Telemetry reports what is *installed*, not what still exists on a USB stick, a share, a GitHub release, or a CI output folder. The plan’s own known trap (`:429`) says a pre-cutoff package without `/ENABLEV2` installs V1, which connects by Socket.IO to a server with no printer handler and polls `/api/spooler/poll` for a 404. That fails visibly rather than reprinting, but only item 8 prevents it. Confirmation is a signed checklist, not a proof.

**Failure scenario.** A technician’s USB still has `POSAPP-Spooler-Setup.exe` from before cutoff. A replacement PC is installed from it. The station reports as running and prints nothing.

**Fix direction.** Name the actual distribution locations this project uses (GitHub releases, the build-output folder, the Hostinger package dir, any known USB/share) as an enumerated list the owner initials. Do not claim the gate is closed by “confirmation.”

---

### M5 — Architecture disposition table omits nodes and flows whose `file` Task 1/2 delete

**Severity:** Medium. Task 4 GREEN `npm run architecture:check` fails, or the map keeps a trusted V1 story that `architecture:check` will not catch.

**Evidence.** `scripts/build-architecture.js:8-10,43`: a missing file is a hard error; line-number drift is also a hard error past end-of-file. Every id **in** the plan’s table exists and matches the named node/flow. `printQueueWatchdog.js` is not V1 (it aggregates `local_accepted` / `cancel_requested`, `:1,11-19`). Keep-unchanged is correct.

These ids are **not** in the table and point at files Task 1 or Task 2 delete:

| id | Kind | File that goes away |
|---|---|---|
| `prn-registry` | node | `backend/services/spoolerRegistry.js` (`architecture.json:883-887`) |
| `prn-v2-entry` | node | `pos-spooler-printer/v2-server.js` (`:1498-1502`) |
| `flow-spooler-id-collision` | flow | `spoolerRegistry.js:13` (`:3458`) |
| `flow-spooler-restart-dedupe` | flow | `durable-seen-store.js:29` (`:3323`), `printQueue.js:201` (`:3351`) |
| `flow-spooler-v2-machine-identity` | flow | `v2-server.js:47` (`:2924`), `:58` (`:2952`) |
| `flow-spooler-v2-local-runtime` | flow | `v2-server.js:46` (`:2967`) |
| `flow-kitchen-station-routing` | flow step | `to: prn-seen-store` (`:3306`) — dangling edge once that node is deleted |

Human-trusted stale survivors (`architecture:check` still passes if the file exists):

- `prn-spooler-proc` (`:1484-1488`) still describes WebSocket-first Socket.IO + REST poll on `server.js`. After Task 1 that file **is** the durable agent.
- `prn-dispatch` (`:823`) still `enqueueAndProcessJobs` + Socket.IO.
- `inf-boot-jobs` (`:764`) “printer status polling, print-queue retry.”
- `inf-socket-auth` / `auth-socket-mw` / `core-socket` still describe spooler clients sharing the staff Socket.IO server.
- `prn-spooler-agents` (`:890`) cutover + “safe pre-acceptance rollback.”
- `prn-v2-job-store` (`:904`) “V1 seen-store migration.”
- `prn-v2-sync-client` (`:939`) “preparation.”
- `flow-spooler-handshake` (`:2814`) entire V1 socket handshake, `spoolerRegistry.register`, `claimPrintJobs`.
- `flow-packaged-update` (`:4934`) steps 10–11: `-EnableV2`, `v2-server.js`, abort/rollback (`:5006-5014`).
- `flow-spooler-v2-admin-health` (`:5083`) “rollback and V1 cutover terminalization.”
- `flow-audited-reprint` step 8 (`:3418-3421`) `dispatchClaimedPrintJobs`.
- `flow-spooler-v2-delivery` (`:2857`) is in the table as rewrite, but its current first step is still `POST prepare` (`:2865-2868`) and a later step still cites `printQueue.js:69` (`:2909`).
- Meta: convention socket+poll → `printQueue.js` (`:41`); invariant one live socket / `spoolerRegistry.register` (`:87`); invariant rollback only before V2 acceptance (`:89`); invariant “V1 printer-status polling never overwrites V2” (`:92`). The plan names three meta bullets; it does not name `:41`, `:87`, `:89`.

Line drift (disposition still “rewrite,” but the current `file:line` is already the wrong statement): `flow-checkout-receipt-socket` step 3 cites `print.js:853` (`architecture.json:3123`); that line is a shift-sales SQL query (`print.js:847-854`). The real `enqueueAndProcessJobs` is `print.js:988`. Kitchen flow cites `print.js:1172` for enqueue (`architecture.json:3293`); live `:1172` is a category query.

“Re-derive the list before editing” is how rev 2 shipped wrong array indices (S5). The self-audit claim that every architecture entry is addressed by stable `id` with a disposition is false of the table as written.

**Failure scenario.** Executor follows the table, deletes `prn-seen-store` and `prn-spooler-route`, regenerates HTML. `architecture:check` fails on `prn-registry`, `prn-v2-entry`, `flow-spooler-id-collision`, `flow-spooler-restart-dedupe`, and the `v2-server.js` identity/runtime flows. Task 4 GREEN cannot pass. If they only fix CI failures and leave `prn-spooler-proc` / `flow-spooler-handshake` / `flow-packaged-update`, the human map still describes V1 delivery as current.

**Fix direction.** Add delete / rewrite / keep for every node and flow whose `file` is deleted or whose steps cite those files. After the move, merge `prn-v2-entry` into `prn-spooler-proc` (both would otherwise be `server.js`). Rewrite `flow-spooler-handshake` as V2 HTTP register or delete it. Confirm `file:line` against the named symbol when rewriting, not against the drifted number.

---

### M6 — Task 1 says rewrite three suites; Task 2 says re-point. The export surfaces do not overlap.

**Severity:** Medium. An executor who follows Task 2 after a real Task 1 rewrite can undo it by `require('../server')` and looking for V1 exports that will never exist. Raster/cut coverage disappears, or GREEN stays red.

**Evidence.** Task 1 (`:140-148`) says the three suites are **rewrites**, not re-points, because the two runtimes share no module surface. That is true:

V1 `pos-spooler-printer/server.js:589`:

```589:589:pos-spooler-printer/server.js
module.exports = { processIncomingPrintJob, processPrintJob, verifyQueuedPayloadIntegrity, warmRenderingPipeline, startupWarmupPromise };
```

V2 `pos-spooler-printer/v2-server.js:167-174` is `require.main === module` guarded, then:

```174:174:pos-spooler-printer/v2-server.js
module.exports = { main, defaultStateRoot, createHelperEventHandler, startupJitterMs, assertProductionConfig };
```

Intersection is empty. Requiring `../server` after the move yields none of the functions these suites call.

The suites actually call the V1 names:

- `payload-integrity.test.js:65,84-85` → `verifyQueuedPayloadIntegrity`, `processIncomingPrintJob`
- `spooler-report-rendering.test.js:153-160` → `processPrintJob`, `warmRenderingPipeline`, `startupWarmupPromise`
- `transport-boundary.test.js:163,169,190,197` → `processIncomingPrintJob`, `startupWarmupPromise`, `seen-print-jobs.json`

Task 2 (`:229-237`) repeats the three files as “re-point” / “after Task 1 the durable agent *is* `../server`, so much of this is a harness change rather than a rewrite.” That second sentence is false. Task 2 also re-lists `poll-fallback.test.js` / `durable-seen-store.test.js` as deletions already performed in Task 1 (harmless if the files are gone; noise if an executor looks for them).

**Failure scenario.** Task 1 rewrites the three suites onto `v2/printer-transports.js`, `v2/printer-workers.js`, `v2/artifact-renderer.js` as the table says. Task 2 then “re-points” them at `require('../server')` and looks for `processPrintJob`. The exports are not there. GREEN fails, or the executor bulk-deletes the only raster/cut coverage.

**Fix direction.** Delete the Task 2 “re-point / harness change” paragraph. Task 1’s rewrite table is the instruction. Keep the files.

---

### M7 — Surviving Task 2 GREEN suites still contain uncut V1 cases; `sync-client.js` is in no task’s file list

**Severity:** Medium. Task 2 GREEN fails with no disposition, or an executor deletes a whole live suite to clear it (the S2 / S7 pattern: one V1 test among nine live ones).

**Evidence.** Task 2 GREEN includes `spoolerV2Sync.test.js` and `spoolerV2Health.test.js` and does not classify these cases.

`spoolerV2Sync.test.js` helper **always** POSTs `/prepare` first:

```18:29:backend/tests/integration/spoolerV2Sync.test.js
async function prepare(spoolerId) {
    return request(app)
        .post('/api/spooler/v2/prepare')
        ...
}
async function register(...) {
    await prepare(spoolerId);
    return request(app).post('/api/spooler/v2/register') ...
}
```

Every registration test 404s during setup once Task 2 deletes `/prepare`. `:103` (“keeps a busy V1 station transitioning until in-flight work is resolved”) asserts `delivery_protocol === 'transitioning'` (`:122`). The `station_busy` half of that test is the RED coverage Task 2 asks for (`:247`); the transitioning half is cutover. `:535` calls `rollbackStationToV1` and asserts rollback-before-acceptance.

`spoolerV2Health.test.js` V1 cases, unclassified:

- `:198` late V1 printer-status response overwrite after cutover (`spoolerRegistry.register`, `query_printers_status`).
- `:273` delayed V1 status after the printer moves.
- `:397` V1 status polling marking a V2 printer offline.
- `:413` connected legacy V1 station visible beside V2 cards.
- `:428` terminalizes only stranded V1 rows after locking a transitioning station.

`pos-spooler-printer/v2/sync-client.js:38-55` still implements `prepare()` → `POST /api/spooler/v2/prepare` and `rollbackSelf()` → `POST /api/spooler/v2/rollback-self`. The file is not in Task 1 or Task 2’s file list. After the `v2-server.js` → `server.js` move, those methods live on in the durable agent.

`pos-spooler-printer/tests/v2-sync-runtime.test.js:76` calls `client.prepare()`. It is not in any task. Task 2 GREEN does not run spooler-package tests. Task 4’s `npm --prefix pos-spooler-printer test` is the first time it fails.

**Failure scenario.** Task 2 deletes `/prepare` and `rollbackStationToV1`. GREEN runs `spoolerV2Sync.test.js`. `register()` 404s in `beforeEach` of every case, including the live claim/settle/drain/replace ones that must survive. An executor who “fixes” GREEN by deleting the file drops the only integration coverage of exactly-once settle, replay, drain, and replacement.

**Fix direction.** Rewrite `register()` to skip prepare. Keep the `station_busy` half of `:103`; delete the transitioning assertion. Delete `:535`. Delete or retarget the five V1 health cases (keep only those that still test “stale writer cannot overwrite” without a V1 socket). Delete `prepare` / `rollbackSelf` from `sync-client.js` in Task 2 and drop `v2-sync-runtime.test.js:76`.

---

### M8 — Task 4 Scan A fights Task 1’s ValidateSet; the Vue spec cites the wrong lines

**Severity:** Medium. An executor can “fix” Scan A by dropping `v2-server.js` from ValidateSet and brick rollback of a still-on-`v2-server.js` machine. Vue GREEN can pass with V1 still in Settings, or fail after a correct Settings cleanup.

**Evidence.**

**Scan A vs ValidateSet.** Task 4 (`:379`): every `v2-server.js` hit in `deployment/windows` must be read; a hit that names it as a target entry point — “an NSSM repoint, a journal `targetScript`, a **ValidateSet default**” — is a stale repair target and a failure of this gate.

Task 1 requires both names in ValidateSet, because restore uses the **parameter**, not a second field:

```37:37:deployment/windows/Repair-SpoolerStartup.ps1
function Set-SpoolerRepairEntryPoint([ValidateSet('server.js','v2-server.js')][string]$ScriptName) {
```

```116:116:deployment/windows/Update-Spooler.ps1
function Set-SpoolerApplicationScript([ValidateSet('server.js','v2-server.js')][string]$ScriptName) {
```

Repair `:235` is `Set-SpoolerRepairEntryPoint ([string]$journal.previousScript)`. Update `:586` is `Set-SpoolerApplicationScript ([IO.Path]::GetFileName($serviceScriptBefore))`. If `$serviceScriptBefore` / `previousScript` is `v2-server.js` and ValidateSet is only `server.js`, PowerShell throws before NSSM is set. Update catch then disables the service (`:598-600`). Repair catch does the same (`:323-325`).

ValidateSet is an allow-list, not a default. The Scan A rule as written treats it as a forbidden target.

**In-flight Install journals.** Repair `:149` is equality, not “previous or target”:

```147:149:deployment/windows/Repair-SpoolerStartup.ps1
    if ([string]$Journal.mode -eq 'Install') {
        ...
        if ([string]$Journal.targetScript -ne 'v2-server.js') { throw 'Spooler Install target script is invalid.' }
```

Rewriting that to `eq 'server.js'` makes an in-flight EnableV2 install journal unreadable. ISS `[Files]` copies `Repair-SpoolerStartup.ps1` to `{app}\deployment\windows` (`POSAPP-Spooler.iss:56`) **before** `ssPostInstall` runs Install-Spooler (`:278-298`). Install-Spooler then refuses a pre-existing journal (`:198`). New Repair is already on disk. The scheduled task from an earlier V2 install will run **new** Repair against **old** `targetScript='v2-server.js'`. Throw → service Disabled, journal kept.

**Vue spec.** Task 2 cites `src/shared/i18n/ar.json:2491` and “the V1 label set asserted in `spoolerV2Settings.spec.js:33`.”

`:11` still requires Settings.vue to **contain** `delivery_protocol`:

```10:14:src/admin/pages/__tests__/spoolerV2Settings.spec.js
    it('renders durable station health and confidence without claiming paper was printed', () => {
        for (const text of ['stations', 'delivery_protocol', 'last_sync_at', ...]) {
            expect(settings).toContain(text);
```

`:17-29` still require `/rollback-v1` and `terminalize-v1`.

`:33` mixes keep-labels (`Print station`, `Last sync`, `Helper`, `Download diagnostics`) with V1 labels (`Delivery protocol`, `Legacy`, `Old V1 service stopped and checked.`). Treating “the V1 label set at :33” as a delete list would strip live V2 UI copy.

Drain / replace are gated on the column Task 2 removes from the API:

```505:506:src/admin/pages/Settings.vue
<button v-if="station.delivery_protocol === 'v2' && station.agent_status === 'active'" @click="drainSpoolerStation(station)" ...>
<button v-if="station.delivery_protocol === 'v2' && ['active', 'draining'].includes(station.agent_status)" @click="replaceSpoolerStation(station)" ...>
```

Task 2 RED: no response contains `delivery_protocol`. If the `v-if` is left in place, drain and replace never render. Rollback (`:507`) and terminalize (`:508`) go away with the V1 prompts, which is intended.

`ar.json` V1 leftovers beyond `:2491`: `"Rollback to V1"` (`:2507`), rollback confirm (`:2514`), V1 outcome strings (`:2516-2517`), `"Legacy"` / `"Old V1 service stopped and checked."` (`:2528-2529`). `"rollback"` at `:61` is receipt-template rollback, not transport — do not delete it. There is no `en.json`; English is the Vue key (`src/shared/i18n/` contains only `ar.json` and `runtime.js`). No other Vue page carries `delivery_protocol` / `rollback-v1`.

Task 4 Scan A / Scan B will fail if those strings remain in `Settings.vue`. i18n keys like `"Delivery protocol"` do **not** match Scan A tokens. GREEN includes the spec: an executor who cleans Settings without rewriting `:10-29` fails GREEN; one who only edits `:33` can keep V1 in Settings, pass GREEN, and fail Task 4 scans.

**Failure scenario.** Executor drops `v2-server.js` from ValidateSet to make Scan A zero. A still-on-`v2-server.js` machine hits an update failure. Restore throws. Service is left Disabled. Separately, Settings cleanup removes protocol labels but leaves the `v-if`; drain and replace vanish from the admin page while the routes still exist.

**Fix direction.** Ban only literal *target* writes (`Set-… 'v2-server.js'`, `targetScript = 'v2-server.js'`). Keep both names in ValidateSet. Accept Install `targetScript` in `@('server.js','v2-server.js')` and treat `v2-server.js` as a leftover commit target to rewrite only after the new payload is present. Flip spec `:11` and `:17-29` to absence assertions; keep drain/replace gated on `agent_status` only; do not treat every string at `:33` as V1.

---

### M9 — Staff badge “updates” a counter V2 settle never changes

**Severity:** Medium. After V1 is gone the staff failed-print badge stays at 0 even when jobs dead-letter. The plan treats “broadcast after settle” as the fix.

**Evidence.** Task 2 (`:262-267`) correctly identifies the three callers of `broadcastFailedPrintJobsCount()` — `server.js:366` (V1 ack, deleted), `:610` (30-second dispatcher, deleted), `:813` (once at startup) — and correctly requires an observable `queueStateChanged` from `affectedRows > 0` on the settle UPDATE, published through `req.io` after commit. The `FOUND_ROWS` half is implementable: `buildDatabasePoolOptions` does not set `foundRows` / `CLIENT_FOUND_ROWS`; the settle UPDATE always changes `status` (from `local_accepted` / `cancel_requested` to a terminal) **and** `last_seen_at`; a re-confirmation hits `TERMINAL.has(row.status)` at `spoolerSync.js:120-122` and never runs the UPDATE (`spoolerV2Sync.test.js:223`).

The metric being broadcast is the wrong one:

```481:484:server.js
async function getFailedPrintJobsCount() {
    try {
        const [rows] = await db.query("SELECT COUNT(*) as count FROM print_queue WHERE status = 'failed'");
        return rows[0].count;
```

V2 settle writes `acknowledged` / `dead_letter` / `canceled` (`spoolerSync.js:26-33`, `:130-137`). It never writes `failed`. `failed` is leftover V1 retry state, which V2 then claims to `sent` (`:218`). The count actually drops when a leftover `failed` row is **claimed**, which the plan does not flag. After V1 claim/settle are deleted, new failures are `dead_letter`. Emitting on terminal settle refreshes a number V2 will not move.

This is already broken for V2 stations today (same shape as the audit-status gap). The plan does not cause it. What it causes is permanence: the only remaining badge refresh is wired to a query that cannot see V2 failures.

**Failure scenario.** V2-only fleet. A kitchen ticket permanently fails. Settle writes `dead_letter`. `queueStateChanged` is true, `failed_print_jobs_count` is emitted, the count is 0. Staff badge stays empty.

**Fix direction.** Count the states the badge is meant to show (at least `failed` + `dead_letter`), or change the contract. Do not claim the staff badge is preserved by re-emitting the old query.

---

### M10 — `migrateLegacy()` deletion is safe; the safety claim is not

**Severity:** Medium as an overclaim (rev 4 Sp6 class), not as a reprint bug. The plan should not justify an unconditional delete with a gate item that does not prove the import ran.

**Evidence.** Plan Task 1 (`:106`): deletion is safe “because release gate item 2 requires every station to be on V2 already — every station has run this migration exactly once.”

Gate item 2 is `spooler_stations.delivery_protocol='v2'`. That is a database enum. `migrateLegacy` (`pos-spooler-printer/v2/job-store.js:133-183`) is local filesystem: no-op if `seen-print-jobs.json` is missing or the marker exists. The process that **first writes** `delivery_protocol='v2'` (`registerAgent`) does open the store first (`v2-server.js:88` then runtime → register). That call is often a no-op (no V1 seen file on a station that was V2 from first install).

Deletion is still safe for a **different** reason: V2 claim only takes `agent_id IS NULL` and `pending` or due `failed` (`spoolerSync.js:210-212`). V1 paper-without-ack is `processing`/`sent` (gate 4). Local V1 “seen” is not required to suppress V2 reprint of already-acked work. Unowned `processing`/`sent` are blocked by the registration guard and by gate 4.

**Failure scenario.** None for reprint, if gate 4 is actually zero. The defect is that an executor who later “restores `migrateLegacy` for safety” because the stated justification does not hold is solving a problem that does not exist, against the owner’s unconditional-delete instruction (rev 5 Sp5).

**Fix direction.** Keep the unconditional delete. Replace the gate-item-2 sentence with the claim-predicate reason.

---

### M11 — Scan A omits tokens the plan itself deletes; leftover prepare / self-status would pass the stated proof

**Severity:** Medium as a proof hole (rev 5 St3 class: a deletion outside the proof), Low as a runtime issue if H2 / H3 / M7 are fixed.

**Evidence.** Scan A’s token list does not include, and these are live today:

| Token | Live |
|---|---|
| `claimPrintJobs` / `markPrintJobsSent` / `settlePrintJob` / `processPendingQueue` | `server.js:42-44`, `:293-350`; `printDispatch.js:3` |
| `/api/spooler/v2/prepare` / `rollback-self` | `spoolerV2.js:64`, `:141`; `sync-client.js:38-55` |
| `start:v2` | `pos-spooler-printer/package.json:9` |
| `Wait-SelfStatus` / `self-status` | `Update-Spooler.ps1:173-183,528`; `Install-Spooler.ps1:288`; `backend/routes/spooler.js:59` |
| `Wait-V2Registration` | `Update-Spooler.ps1:146,523` — this one **must survive** as the V2 verify |
| `v1_stranded_count` / `rollback_allowed` / `mergeLegacyStationHealth` | `backend/routes/admin/printQueue.js:33,68-69,139-140` |
| `rollbackSpoolerStation` | `Settings.vue:1415,1620` |

`--rollback-v1` *is* covered (`rollback-v1`). `--prepare` on the durable agent is not. `start:v2` lives under `pos-spooler-printer/package.json`, which **is** a Scan A root (`pos-spooler-printer` as a directory). The token is simply missing from the pattern. Root `package.json` as a file path is only the repo-root file; that is not a hole, because the nested package.json is already under `pos-spooler-printer`.

Scan B omitting `deployment/windows` / `pos-spooler-printer` / `deployment/spooler` is **not** a hole: `delivery_protocol` does not appear there. `deployment/templates` has no Scan A tokens (`SPOOLER_KEY` stay is correct). There is no `public/` directory. `seed.js` is not a Scan B root; it is in Task 3’s file list for the column, not the ledger stamp (H5).

`rg` is installed on this Windows host. The four commands can run. Tests are excluded by both `**/tests/**` and `**/__tests__/**`. Contract tests that must contain the forbidden token as an absence assertion will not poison Scan A. That part of rev 5 is correct.

**Failure scenario.** H2 / H3 / M7 leftovers (`sync-client.prepare`, Install self-status, `start:v2`) survive every stated deletion scan. Task 4 reports proof of deletion. First fresh install or second update hits them in production.

**Fix direction.** Add `claimPrintJobs|markPrintJobsSent|settlePrintJob|processPendingQueue|rollback-self|/api/spooler/v2/prepare|start:v2|Wait-SelfStatus|self-status|v1_stranded_count|rollback_allowed` to Scan A, or to a scoped inspect list if any must survive. Do not add `Wait-V2Registration`.

---

### M12 — Enqueue-only does not starve today’s V2 path; the “≤2 second sync” claim overstates throttled cases

**Severity:** Medium only as an overclaim. Not a delivery regression if the rest of Task 2 is followed.

**Evidence.** Already true for V2 today: `claimPrintJobs` returns `[]` unless `delivery_protocol === 'v1'` (`printQueue.js:88-91`). `dispatchClaimedPrintJobs` and the 30-second loop never wake a V2 station. `V2_NEXT_SYNC_MS = 2000`. Agent schedules `urgent ? 0 : clamp(next_sync_ms, 500, 5000)` (`v2/agent-runtime.js:28-30,182`). In-flight tick is one HTTP sync (`timeoutMs = 10000` in `sync-client.js:12`), not a hanging long poll.

Not a 2s bound: startup jitter `0–2001` (`v2-server.js:28-29`); throttle `next_sync_ms: 5000` (`spoolerV2.js:48-59`); error backoff `[2000,5000,10000]`; `station_protocol !== 'v2'` or paused ⇒ 5s. Relative to **today’s** V2 path, removing dispatch does not starve. The plan’s “the durable agent's <=2 second sync is the wake mechanism” overstates the throttled/backoff cases only.

**Fix direction.** Keep “add no second channel.” Soften “≤2 s” to “the agent’s next sync, currently 2 s idle, longer under throttle/backoff.”

---

## Low

### L1 — Named CHECK is required for Hostinger-safe `.auto.sql`

**Severity:** Low. Scratch may work if Luna inspects `SHOW CREATE TABLE`; the approved `.auto.sql` cannot drop an unnamed CHECK.

**Evidence.** Plan `:311-313` says add an enforced CHECK then drop “that CHECK” with no `CONSTRAINT` name. This repo’s Hostinger-safe form is named: `2026-08-04-special-source-buyer-snapshots.auto.sql:6-8` uses `DROP CONSTRAINT IF EXISTS chk_orders_receivable_terms` then `ADD CONSTRAINT chk_orders_receivable_terms CHECK (...)`. `runPendingMigrations.js:11-15` rejects `DELIMITER` / routines / definers, so the drop cannot look up a generated name in a procedure. `spooler_stations` currently has no CHECK (`baseline.sql:671-678`), so an unnamed add would become something like `spooler_stations_chk_1`, which is not a stable contract.

MariaDB 10.2+ does enforce CHECK on existing rows; the CHECK-then-drop idiom is legitimate and stays inside the `CLAUDE.md` prohibition on routines. The defect is the missing name, not CHECK support.

**Fix direction.** Specify a fixed name (e.g. `chk_spooler_stations_delivery_v2`) and use `ADD CONSTRAINT ... CHECK` / `DROP CONSTRAINT IF EXISTS` in both the evidence file and `.auto.sql`. Combined with H6, prefer a preflight `SELECT` over a CHECK on a column the new baseline no longer has.

---

### L2 — `printTemplates.test.js` omitted from Task 4’s focused combined gates is not a defect

Recorded so it is not re-litigated. Task 2 GREEN includes `backend/tests/integration/printTemplates.test.js`. Task 4’s focused list omits it, then runs `npm run test:unit` (`package.json:13`, vitest with no path), which includes that file. Same for `printDispatchOwnership.test.js`. A regression after Task 2 would be caught at the full suite, not at the focused combined gate.

---

### L3 — Production dispatch call-site list is complete

Recorded so it is not re-litigated. The plan’s list matches live code: `server.js:607`; `print.js:988,1298,1307`; `pos/orders.js:1075,1239,1608`; `pos/subscriptions.js:764`; `admin/subscriptions.js:802`; `admin/printTemplates.js:227`; `printReprint.js:101`; `printDispatch.js:118` (inside `dispatchReceiptPrint`, which serves `expensePrint.js:9` and `auditReports.js:115,305,344,455`). `test:installer` in root `package.json` is named in Task 1. `app.use('/api/spooler', spoolerRoutes)` at `server.js:633` is covered by Task 2’s `server.js` work. `updatePrinterDeviceStatus` is called only from `server.js:506` and `:555` plus its definition at `printerStatus.js:85`. `receiptDisplayV1` sites match Task 1.

---

## What I attacked and could not break

Named so the owner knows what is actually covered, not restated from the plan.

- **Predecessor is the latest auto-manifest entry.** `auto-manifest.json:198-209`, `schemaValidation.js:1-2`, `bootstrap-database.js:140`, last Hostinger block (`hostinger-manual-migrations.sql:1659`). No later dated migration file exists. Using `2026-08-17-spooler-v2-agents-v1` / `e2645cba…` as predecessor is correct. `deployment/database/manifest.json` is the baseline hash pin (`sha256` `24cd18a5…`, `migrations: []`), not the auto-ledger. `installerBaseline.test.js:66` hashes `normalizeSqlText(baseline)` (CRLF→LF only) against that pin. Editing `baseline.sql` without re-pinning fails, and the plan does name `manifest.json` for that.

- **Cited DDL lines are the CREATE TABLE column.** `seed.js:876` and `baseline.sql:673` are the `delivery_protocol enum('v1','transitioning','v2')` lines. `:920` is the validation probe. Those three statements are real. The defect is the **other** authority sites (H5), not a wrong line at those anchors.

- **Gate 6 SQL join bug does not break existence.** `a.agent_id` is the PK; there is no `a.id`. Terminal set matches `spoolerSync.js:3`. `LEFT JOIN` multiplicity only happens when a printer or live queue exists; those rows are excluded. A true orphan produces one all-NULL join row. `q.id IS NULL` remains a correct absence test. Queue OR is justified: claim is the first writer of `print_queue.spooler_id` (`spoolerSync.js:219`); unclaimed `pending`/`failed` are only reachable via `printer_id`. No `delivery_protocol` filter — the rev 4 item 1↔6 deadlock on a retired V2 row is gone.

- **Orphan predicates vs real schema.** `spooler_agents.status` is `enum('active','draining','revoked','decommissioned')`. `printers.is_active` is `tinyint(1) DEFAULT 1`. Enqueue does not set `spooler_id` (`printDispatch.js:55-58`). No FK from `printers` / `print_queue` / `spooler_agents` to `spooler_stations`, so the DELETE is schema-legal. `spooler_agents.active_station_key` is generated from `status`, not `delivery_protocol`. `printers.active_endpoint_key` uses `spooler_id`, not `delivery_protocol`. No views. `DROP COLUMN delivery_protocol` does not collide with those objects. The only production `DELETE FROM spooler_stations` in the tree is still the test at `spoolerV2Compatibility.test.js:39`.

- **At most one live agent.** Unique generated key forbids two `active`/`draining` rows on one station. Drain is not two agents. “Exactly one” as a readiness bar is still a query (M2); as a structural invariant it already holds.

- **V2 does not legitimately need `agent_id IS NULL AND status IN ('processing','sent')`.** Item 4 is not blocking a live V2 state.

- **Settle `affectedRows=0` on a real first transition because `FOUND_ROWS` is off.** Status + `last_seen_at` both change; the pool does not set `foundRows`. Skip-on-zero matches current V1 settle (`printQueue.js:205-207`, `:245-247`). Audit write after UPDATE, inside the same `conn` transaction, was not shown to deadlock with any opposing document-then-queue lock.

- **V2 already does not use the 30-second dispatcher.** Removing it does not starve V2 jobs. “Add no second channel” is correct.

- **Old updater abort on already-V2.** `$cutoverStarted` is set only inside `if ($EnableV2)` after `Invoke-V2Prepare` (`:443-447`). Already-V2 forces `$EnableV2` false (`:414-418`). Abort (`:551-570`) is gated on `$cutoverStarted`. Both already-V2 and still-V1 (prepare 404s before `$cutoverStarted`) fail safely. Do not re-derive this from `installerUpdateContract.test.js:634` — that pins the *registration verification* condition at `:521`, not cutover-start. The plan’s trap on this point is correct.

- **In-process Update rollback after making `:586`/`:605` unconditional** (and keeping `v2-server.js` in ValidateSet) does restore the prior entry over the prior files. That specific EnableV2-deletion hole the plan calls out is real in current code and is correctly described. H4 is the reboot-shaped sibling, not a contradiction of this.

- **`SPOOLER_KEY` is still required** for V2 bootstrap (`backend/routes/spoolerV2.js:23`). Removing it from `deployment/templates/pos.env.template` would brick agent registration. The plan’s trap on this point is correct.

- **`compiled_document_v1` and `posapp-fresh-baseline-v1` do not match Scan A.** They must survive. The plan keeps it that way.

- **Disposition-table ids that *are* listed exist and match.** `prn-spooler-route`, `prn-queue-service`, `prn-seen-store`, `prn-printer-status`, `flow-poll-fallback`, `prn-print-queue-admin-route`, `prn-queue-watchdog`, `db-spooler-stations`, `dep-baseline`, `flow-spooler-v2-delivery`, `flow-standalone-spooler-install`, `flow-checkout-receipt-socket`.

- **`printQueueWatchdog.js` is not V1 delivery.**

- **Scan B hole in windows / spooler package / Inno.** `delivery_protocol` is absent there.

- **No other Vue pages** carry `delivery_protocol` / `rollback-v1` / `terminalize`.

- **No English i18n catalog** besides implicit Vue keys.

- **ISS file list does not name two JS entry points.** It copies `{#StageDir}\*`. Removing `/ENABLEV2` and staging only durable `server.js` is enough for a fresh ISS install to run one entry, *if* `v2-server.js` is gone from the stage (Task 1 delete + `build-installers.ps1:364-368`). ISS-only ENABLEV2 deletion without staging changes would still copy `v2-server.js` if it remains in stage.

- **No test asserts `journal.targetScript -eq 'v2-server.js'` by field name.** The GREEN hazard for backend vitest is the cutover / ENABLEV2 token tests Task 1 already frames as RED work (`installerUpdateContract.test.js:620-636`, `:663-682`; `installerPackageContract.test.js:725-737`). Those are expected RED→GREEN, not a missing-file defect. The missing-file defect is the **spooler-package** copy of `installerUpdateContract.test.js` (H1).

- **Registration in-flight guard vs “idempotent without prepare.”** The guard that must survive is the **new-insert** COUNT at `spoolerAgents.js:167-173` (and rollback-reactivate `:142-148`). Same-agent re-register at `:161-162` already returns without re-checking in-flight. Unique key still throws `ER_DUP_ENTRY` → `station_occupied` (`:188-189`). The plan text at `:247` and `:280` is specific enough **if followed**. After prepare is removed, `:164-166` (`station_not_prepared` on `'v1'`) goes away; the in-flight COUNT is then the only server interlock on un-owned `processing`/`sent`.

- **Replace still terminalizes owned V2 uncertain work.** Deleting rollback / terminalize-v1 does not remove that path.

- **CLAUDE.md workflow shape.** The plan assigns Luna the evidence `.sql` before approval, forbids draft edits to `auto-manifest.json` / fallback, and after approval requires `.auto.sql`, one manifest entry, and a verbatim Hostinger block. Predecessor name/checksum are stated. That matches the database-migration workflow. The misses are the extra authority files (H5, H6), not a missing BEGIN/END marker step.

- **`pos-spooler-printer/install-service.js:11`** hard-wires `server.js` (becomes correct after the move). It is **not** in the payload (`build-installers.ps1:225` excludes it). Not a fleet launcher.

---

## What I could not verify

A confident report that quietly skipped these would be worse than naming them.

- **Physical matrix.** Direct TCP, Windows share/Winspool, write-only clone, paper-out, affected long report printer, DPAPI two-machine, disk-full, interrupted installer/updater reboot. The plan leaves those open. This audit did not run them.
- **Live `ADD CHECK` enforcement on this XAMPP MariaDB build.** No SQL was executed. Repo history and MariaDB 10.2+ behaviour say existing non-`v2` rows fail the ADD; that was not re-proved on this machine.
- **Whether any production row is the leftover-work shape in M1** (inactive or deleted printers + non-terminal `print_queue` rows + no agent). `printers.js:188` deletes the printer and categories only; leftover jobs with `printer_id` pointing at a gone printer would not match the orphan join (`printer_id` gone, `spooler_id` still NULL). That is an edge over-delete of the **station row**, not a reprint path I could prove is present. I did not query a live customer database.
- **Whether stations upgraded only with the updater (never an EnableV2 install) have `POSAPP Spooler Startup Health Repair` registered.** The updater never registers that task; only `Install-Spooler.ps1` inside `$EnableV2` does. If the fleet has no task, H4’s Repair path never runs — update in-process rollback is then the only recovery, and a reboot mid-swap is unrecoverable for a different reason.
- **Gate 8 “every distribution location in use”** is still a checkbox. I cannot close a set of USB sticks and shares from the repo.
- **Tests were not run.** Static reading was enough for the findings above. I did not run vitest, `architecture:check`, `validate-schema-drift.js`, or the four `rg` scans. `rg` is installed on this host (`rg.exe` via WinGet); the commands *can* run. `npm run test:unit` was not run, per the audit prompt (only one vitest process; the suite shares `posapp_test`).
- **Whether Task 2 will already rewrite `spoolerV2Sync.test.js:119-130` and `:555-558`** (they `SELECT delivery_protocol` today). Task 2 GREEN includes that file; Task 3 GREEN includes it again. If Task 2 leaves those SELECTs, Task 3’s column drop fails them. The plan’s “all station fixtures” would cover it **if** followed. M7 is the unclassified-case finding; this is the leftover-SELECT gap if M7 is only partly done.
- **Exact executor interpretation of Task 4 “ValidateSet default.”** The contradiction is in the text (M8); which way an executor resolves it is not knowable from the document.

---

## Mapping to the failure modes §9 asked this audit to re-check

| Recurring class | Surviving instance in rev 5 |
|---|---|
| Task N GREEN unreachable because work sits in Task N+1 | **H1** (two spooler suites), **H5(a)** (`schemaAuthority` reads `printQueue.js` after Task 2 deletes it) |
| Deletion list / disposition table built without opening the file | **H1** eight-suite table, **M5** architecture ids, **M7** unclassified cases inside GREEN suites |
| A proof scan that can never return zero, or that misses a deleted symbol | **M8** Scan A vs ValidateSet (zero only by bricking rollback), **M11** tokens the plan deletes but does not scan |
| Two release-gate items deadlock on the same row | **M1** item 3 vs item 6 on leftover queue work (item 1 vs 6 retired-V2 pair **is** fixed) |
| A referenced symbol whose only implementation is deleted with no replacement | **M9** badge still counts `status='failed'`; **H2** `--prepare` kept by a false trap then the route is deleted |
| Stable identifiers replaced with array indices | Not repeated. Dispositions are by `id`. The new hole is **missing ids** (M5), not wrong indices. |
| A product decision left optional to the executor | **H2** “do not remove `--prepare`” is a wrong product instruction; **M10** `migrateLegacy` justification vs unconditional delete (rev 5 already made deletion unconditional — do not reopen it) |
| A claim scoped wider than the artifact examined | **H2** (`:98` is not a helper flag), **H5(b)** (`:920` is not the required count or the ledger tip), **M10** (gate item 2 does not prove the FS import ran) |

---

## Verdict

Rev 5’s scripted self-audit is doing what it claims: the 117 anchors resolve, Task 1’s eight named suites are in Task 1, Scan A excludes both test-root conventions, architecture entries that *are* listed use stable `id`s, and the retired-V2 item 1↔6 deadlock is gone.

That is not the same as correctness. H2, H3, and H4 are installer/runtime paths the previous rounds did not open: a known trap that names the wrong statement, the success/verify/install branches that run once `$EnableV2` is gone, and a Repair journal that does not record the NSSM name Task 1 is about to change. H1 and H5 are the same GREEN-unreachable class as St1, in new files. H6 is the first time the CHECK-then-drop idiom is checked against the *rewritten* baseline the chain test actually loads.

I would not start implementation without rewriting H1–H6. M1, M5, M7, and M8 are the next tier: they will strand Task 2 GREEN, Task 4 `architecture:check`, the release gate, or rollback of a still-on-`v2-server.js` machine.

This report authorizes no merge, push, deployment, or production migration. It does not execute the plan.
