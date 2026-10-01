# Packaged Installer Update Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `test-driven-development` and execute this plan task-by-task. Work only on `codex/installer-update-path`. Commit each task group. Do not merge or push.

**Goal:** Produce safe update-only EXEs for restaurants already installed by the packaged POSAPP Server and POS Print Spooler installers, preserving all live data and configuration while updating application code and applying approved additive migrations.

**Architecture:** Compile an update-only variant from each existing Inno Setup source, retaining the original AppId/AppName/install directory so Windows keeps one application and uninstaller identity. The update EXEs contain only replaceable application payloads, detect and verify the installed release before mutation, back up the live database, run the target release's existing automatic migration chain, swap only application-owned paths, verify the target release, and restore the old code on failure. Fresh provisioning remains owned by the existing installers and scripts; the update path cannot bootstrap a database or create ports, services, secrets, users, or runtimes.

**Tech Stack:** Inno Setup 6.7.3, Windows PowerShell 5.1, Node.js 22.23.0, Vitest, MariaDB/mysql2, NSSM, existing POSAPP migration runner.

## Global Constraints

- Work only on branch `codex/installer-update-path`; do not merge or push.
- Use ponytail/full: reuse current build, backup, migration, verification, and service contracts; add no updater daemon, download service, controller layer, or database framework.
- Never use the `brainstorming` skill.
- Scope is packaged-installer installations only. Source-code/XAMPP deployments are permanently technician-managed and outside the product updater; they must be rejected as unsupported.
- Update packages must never call `bootstrap-database.js`, `mariadb-install-db.exe`, secret generation, default-user seeding, port probing, firewall creation, service creation, database creation, or database deletion.
- Preserve `C:\ProgramData\POSApp`, `C:\ProgramData\POS-Spooler`, MariaDB data, uploads, backups, sessions, logs, POS/spooler env files, all ports, all secrets, spooler identity, printer mappings, queue state, and business data.
- Server update stops/restarts `POSApp` only. It must not stop, replace, or reconfigure `POSAppMariaDB` or `POSAppPhpMyAdmin`.
- Spooler update stops/restarts `POS Print Spooler` only and requires its configured POS server to pass health before mutation.
- Schema changes come only from `backend/migrations/auto-manifest.json`; the installer must execute the target-staged `deployment/tools/run-pending-migrations.js` using the existing protected maintenance env.
- Update migrations must remain additive and backward-compatible with the immediately previous packaged release so code rollback remains viable after an applied migration.
- Every distributable server update increments `package.json` from `1.0.0` to `1.0.1`; every distributable spooler update increments `pos-spooler-printer/package.json` from `1.2.0` to `1.2.1`.
- Version grammar is exactly unsigned `major.minor.patch`. Same version/same commit is already current; same version/different commit and all downgrades are blocked.
- Win10 22H2 build 19045 and Win11 native x64 remain the only supported operating systems.
- Keep the existing server AppId `{E99DB275-DDA0-43A0-95CD-7AE07185122C}` and spooler AppId `{80657A48-9BCB-4455-8CA9-A18139FDFC58}` exactly.
- The fresh `POSAPP-Server-Setup.exe` and `POSAPP-Spooler-Setup.exe` must retain their current behavior and pass their existing installer contracts.
- The new artifacts are `POSAPP-Server-Update.exe` and `POSAPP-Spooler-Update.exe`.
- Do not claim VM, reboot, database-preservation, or physical-printer success unless that exact environment was tested. Keep unavailable physical scenarios explicitly pending.

---

## Evidence and corrected design decision

The original plan's full-installer update design is rejected for this scope:

1. `scripts/build-installers.ps1` deliberately packs MariaDB, Apache, PHP,
   phpMyAdmin, VC runtime, NSSM, and private Node into the fresh server stage.
   Those are fresh/repair resources, not ordinary code-update resources.
2. The current fresh server package has a 220 MiB size gate and the spooler has
   a 180 MiB gate. Re-shipping fresh-only runtime payloads increases transfer
   and install time and repeats the timeout risk already observed.
3. `Install-PosServer.ps1` repair mode rebuilds phpMyAdmin/web tools and can
   repair MariaDB registration. Reusing that branch for normal code updates is
   broader and riskier than the requested application/schema update.
4. The current Inno `[Files]` section copies directly into ProgramFiles before
   provisioning verification. An update needs target validation and a rollback
   copy before installed application roots change.
5. The current spooler has no durable `install.json`; its first updater must
   adopt only an exactly-owned NSSM/legacy service plus valid env and installed
   release, not infer identity from one marker file.

Use two **update-only build variants**, one per existing product. They reuse the
same AppIds, AppNames, architecture mode, install directories, and uninstall
ownership. Official Inno Setup guidance confirms that the same AppId and same
install mode identify the same application and append to its existing uninstall
log. The update-only EXEs use the same Inno sources behind an `UpdateOnly`
compile define, avoiding a second drifting installer implementation.

References:

- <https://jrsoftware.org/ishelp/topic_setup_appid.htm>
- <https://jrsoftware.org/ishelp/topic_sameappnotes.htm>
- <https://jrsoftware.org/isfaq.php>
- <https://jrsoftware.org/ishelp/topic_appendnotes.htm>

## Update state contract

Each updater returns exactly one state before mutation:

| State | Required evidence | Action |
|---|---|---|
| `update` | Exact owned service/config, installed release agrees with metadata, target version is greater | Confirm and update |
| `current` | Installed and target version+commit match | Exit successfully without service/database mutation |
| `blocked_version_collision` | Same version, different commit | Refuse and require a correctly versioned package |
| `blocked_downgrade` | Target version lower than installed | Refuse |
| `blocked_ownership` | Wrong service executable/AppId/path | Refuse |
| `blocked_incomplete` | Some POSAPP artifacts exist but required owned state is missing/corrupt | Refuse with exact recovery evidence |
| `blocked_fresh` | No packaged installation exists | Refuse and direct technician to the fresh Setup EXE |

Server authority:

- `C:\ProgramData\POSApp\install.json` has the exact server AppId and release.
- `C:\Program Files\POSApp\release.json` agrees on version and commit.
- `POSApp` exists and its NSSM Application/AppDirectory/Parameters resolve to
  the expected private Node, install root, and `server.js`.
- Existing `backup.env` and POS env are present and readable by the elevated
  process.

Spooler authority:

- `POS Print Spooler` resolves to the expected NSSM path (or the specifically
  supported installer-owned legacy service during one-time adoption).
- `C:\ProgramData\POS-Spooler\config\spooler.env` contains valid URL, key,
  id, name, state, and log paths.
- `C:\Program Files\POS-Spooler\release.json` and package version are valid.
- After the first successful update, `C:\ProgramData\POS-Spooler\install.json`
  records the AppId, station id/name, server URL, and release only; never the
  spooler key.

## Managed update payloads

Server update stage includes only:

- `server.js`, `package.json`, `package-lock.json`, `release.json`;
- production `node_modules`;
- `dist`, `assets`, production `backend` code;
- automatic migration runner, manifest, and every referenced `.auto.sql`;
- `scripts/db-backup.js`;
- `deployment/tools/run-pending-migrations.js`,
  `deployment/tools/verify-install.js`, and the update payload validator;
- `deployment/windows/Repair-PosStartup.ps1` and update scripts.

It excludes MariaDB runtime/data, Apache, PHP, phpMyAdmin, VC runtime, NSSM,
private Node, baseline/bootstrap tools, templates, secrets, logs, tests, source
maps, and archives.

Spooler update stage includes only tracked spooler application source,
`package.json`, lockfile, production `node_modules`, the pinned Puppeteer browser
cache required by that exact package, `release.json`, and update scripts. It
excludes private Node, NSSM archive/binary, env/state/logs, tests, docs, manual
service scripts, and secrets.

Each update stage contains `update-payload-manifest.json` with:

```json
{
  "format": 1,
  "kind": "server-update",
  "version": "1.0.1",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "managedRoots": ["dist", "assets", "backend", "node_modules"],
  "files": [{ "path": "server.js", "bytes": 1, "sha256": "<64 lowercase hex>" }]
}
```

`managedRoots` is a fixed allowlist emitted by the build, not user input. The
updater may replace only listed roots/files under ProgramFiles after rejecting
absolute paths, `..`, reparse points, and any resolved path outside the exact
install root. ProgramData can never appear in the manifest.

## Update transaction

### Post-implementation hardening contract (2026-08-02)

The update transaction must durably own the verified `update-payload-manifest.json`
for both products. It backs up and atomically restores that marker, uses the
union of previous and target managed files for rollback (including deleting
target-only files after a failed swap), and removes retired files only when
they were previously owned and remain under the exact managed roots. A first
manifest-less update may adopt existing files but must not treat the target
manifest as a complete historical inventory. Unknown files and whole
directories are never deleted.

Spooler service ownership compares the registered executable path exactly
(quoted/unquoted parsing, normalized paths, ordinal-ignore-case), requires the
owned NSSM executable to exist as a leaf, and rejects substring lookalikes.
Existing spooler `install.json` metadata is validated
against the installed release/package and `spooler.env`; when absent, one-time
adoption requires exact service ownership and exact state/log roots. Installed
`release.json.spoolerVersion` and `package.json.version` must agree, and
metadata never stores the spooler key.

The update smoke verifier derives the MariaDB client from the sibling
`POSApp-MariaDB` Program Files directory. Both Inno sources use stable,
product-specific local and `Global\\` setup mutexes; UpdateOnly builds set
`Uninstallable=no` while fresh builds remain uninstallable.

Server transaction:

1. Validate OS/elevation, target release/manifest/hashes, installed ownership,
   installed-vs-target version state, config paths, free space, and services.
2. Run the **target-staged** backup script with installed private Node and the
   existing maintenance env. Require the `.sql.gz` plus matching SHA-256.
3. Copy only affected current ProgramFiles roots/files to
   `C:\ProgramData\POSApp\tmp\update-rollback-<pid>` and validate the copy.
4. Stop `POSApp`; leave MariaDB and phpMyAdmin running.
5. Run the **target-staged** migration CLI with the existing maintenance env.
   A migration failure restarts the old POS and leaves code untouched.
6. Copy the validated target under `C:\Program Files\POSApp\.update-new-<pid>`;
   replace fixed managed roots and files; never replace runtime/database/
   web-tools/install/uninstaller paths.
7. Start `POSApp`. Verify health reports target version+commit and connected DB,
   run required schema validation through the existing verifier, verify stored
   ports/shortcuts did not change, then atomically write updated install metadata.
8. On swap/start/verification failure, stop POS, restore the rollback files,
   restart the previous POS, retain database backup and failure log, and do not
   rewrite release metadata. Additive/backward-compatible migrations make the
   restored previous code valid.
9. On success, delete temporary code rollback/staging and retain the normal DB
   backup according to existing backup policy.

Spooler transaction is equivalent without database work: validate server health
and owned state, back up affected ProgramFiles roots, stop only the spooler,
swap application payload, start it, verify `self-status` target version and exact
station identity, write non-secret metadata, and restore old code/env on failure.

---

### Task 1: Pin update identity and rejection contracts with tests

**Files:**

- Create: `backend/tests/unit/installerUpdateContract.test.js`
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**

- Consumes existing AppIds, install roots, service names, release.json fields,
  and `validatePayload(root, kind)`.
- Produces the state names, exact update artifact names, supported payload kinds,
  and safety tokens later tasks must implement.

- [ ] **Step 1: Write failing contract tests**

Add table-driven tests that require:

```js
const CASES = [
  ['1.0.0', 'a'.repeat(40), '1.0.1', 'b'.repeat(40), 'update'],
  ['1.0.1', 'b'.repeat(40), '1.0.1', 'b'.repeat(40), 'current'],
  ['1.0.1', 'a'.repeat(40), '1.0.1', 'b'.repeat(40), 'blocked_version_collision'],
  ['1.0.2', 'a'.repeat(40), '1.0.1', 'b'.repeat(40), 'blocked_downgrade'],
];
```

Require the two update artifact names, original AppIds, update-only stage names,
same install roots, no port/config wizard tokens in update mode, and update
scripts that do not contain forbidden fresh-provisioning tokens.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
```

Expected: FAIL because update state helpers, payload kinds, build outputs, and
update scripts do not exist.

- [ ] **Step 3: Commit the tests**

```powershell
git add backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
git commit -m "test(installer): define packaged update contracts"
```

### Task 2: Build deterministic update-only payloads

**Files:**

- Modify: `package.json`
- Modify: `pos-spooler-printer/package.json`
- Modify: both package lockfiles through `npm install --package-lock-only`
- Modify: `scripts/build-installers.ps1`
- Modify: `deployment/tools/validate-payload.js`
- Test: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**

- Produces stage roots `deployment/out/stage/server-update` and
  `deployment/out/stage/spooler-update`.
- Extends `validatePayload(root, kind)` with `server-update` and
  `spooler-update`.
- Produces `update-payload-manifest.json` matching the schema above.

- [ ] **Step 1: Add manifest/hash traversal tests and confirm RED**

Test valid update payloads plus missing file, changed hash, absolute path,
`..` traversal, duplicate normalized path, ProgramData path, reparse-point path,
wrong kind/version/commit, and a forbidden fresh-only runtime file.

- [ ] **Step 2: Implement the minimum stage builders**

Refactor only the existing copied-file lists needed to create the two update
stages. Reuse `Copy-FilteredTree`, `Install-ProductionDependencies`, release
generation, and SHA-256 helpers. Do not create a generic packaging framework.

Write `release.json` with `payloadKind` equal to `server-update` or
`spooler-update`. Generate the manifest only after the stage is complete; omit
the manifest itself from its own file list to avoid circular hashing.

- [ ] **Step 3: Validate both update stages**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1 -StageOnly
node deployment/tools/validate-payload.js "C:\xampp\htdocs\posapp\deployment\out\stage\server-update" server-update
node deployment/tools/validate-payload.js "C:\xampp\htdocs\posapp\deployment\out\stage\spooler-update" spooler-update
```

Expected: both validators exit 0 and print a JSON file count.

- [ ] **Step 4: Run focused tests and commit**

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
git add package.json package-lock.json pos-spooler-printer/package.json pos-spooler-printer/package-lock.json scripts/build-installers.ps1 deployment/tools/validate-payload.js backend/tests/unit/installerUpdateContract.test.js
git commit -m "feat(installer): build verified update payloads"
```

### Task 3: Implement one shared update-state and safe-copy helper

**Files:**

- Create: `deployment/windows/InstallerUpdateState.ps1`
- Create: `tests/installer/update-contract-probe.ps1`
- Modify: `tests/installer/startup-repair-probe.ps1`

**Interfaces:**

- `Read-ReleaseIdentity -Path -ExpectedKind` returns version, commit, kind.
- `Compare-PackagedRelease -Installed -Target` returns one state table row.
- `Read-UpdateManifest -Path -PayloadRoot -ExpectedKind` returns validated
  managed roots/files.
- `Assert-PathUnderRoot -Root -Candidate` rejects traversal/reparse escapes.
- `Backup-ManagedPayload` and `Restore-ManagedPayload` operate only on the
  validated manifest allowlist.

- [ ] **Step 1: Write the PowerShell probe and confirm RED**

The probe parses every installer PowerShell script, calls the pure state
functions for all four version cases, exercises traversal rejection, copies a
fixture payload, forces a simulated swap failure, and proves restoration returns
the original hashes. It also proves an unrelated file and ProgramData fixture
are unchanged.

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-contract-probe.ps1
```

Expected: FAIL because the shared helper does not exist.

- [ ] **Step 2: Implement the helper minimally**

Use `[version]` only after regex validation with
`^\d+\.\d+\.\d+$`. Resolve paths with `GetFullPath`, reject reparse points at
every existing path component, compare ordinal-ignore-case, and use literal
paths for every copy/move/remove. No registry or service mutation belongs here.

- [ ] **Step 3: Run probes and tests, then commit**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-contract-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/startup-repair-probe.ps1
npx vitest run backend/tests/unit/installerUpdateContract.test.js
git add deployment/windows/InstallerUpdateState.ps1 tests/installer/update-contract-probe.ps1 tests/installer/startup-repair-probe.ps1
git commit -m "feat(installer): add safe update state primitives"
```

### Task 4: Implement the server application/schema updater

**Files:**

- Create: `deployment/windows/Update-PosServer.ps1`
- Create: `tests/installer/server-update-probe.ps1`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**

- Parameters:

```powershell
param(
  [Parameter(Mandatory)][string]$PayloadRoot,
  [string]$ProgramFilesRoot = 'C:\Program Files\POSApp',
  [string]$ProgramDataRoot = 'C:\ProgramData\POSApp',
  [string]$ResultFile,
  [switch]$WhatIf
)
```

- Dot-sources `InstallerUpdateState.ps1`.
- Emits a non-secret JSON result containing state, installed/target release,
  backup path/hash, updated boolean, and log path.

- [ ] **Step 1: Write a mocked server transaction probe and confirm RED**

The probe uses isolated temporary ProgramFiles/ProgramData fixtures and injected
command/service delegates. Assert exact ordering:

```text
preflight -> database-backup -> rollback-copy -> stop POSApp -> target migrations
-> managed swap -> start POSApp -> health/schema verify -> metadata write -> cleanup
```

Assert migration failure restarts old POS without swapping code; start/health
failure restores old code and metadata; current state performs no mutation; all
blocked states perform no mutation. Assert stored ports/env file bytes remain
identical.

- [ ] **Step 2: Implement the server updater**

Use installed private Node to execute the target-staged backup and migration
scripts. Pass the existing absolute `backup.env`; never put credentials on the
command line or result file. Stop/start only `POSApp`. Use the shared managed
payload backup/swap/restore functions. Write `install.json` via temp file plus
same-directory atomic move only after target verification.

The first update from a manifest-less packaged install replaces the fixed
managed roots listed by the target manifest. Unknown files outside those roots
are retained and logged; no broad ProgramFiles deletion is allowed.

- [ ] **Step 3: Run focused verification and commit**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/server-update-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-contract-probe.ps1
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerCli.test.js backend/tests/unit/installerPackageContract.test.js
git add deployment/windows/Update-PosServer.ps1 tests/installer/server-update-probe.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "feat(installer): add data-preserving server updater"
```

### Task 5: Implement the spooler application updater

**Files:**

- Create: `deployment/windows/Update-Spooler.ps1`
- Create: `tests/installer/spooler-update-probe.ps1`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**

- Same path/result/WhatIf shape as the server updater, using defaults
  `C:\Program Files\POS-Spooler` and `C:\ProgramData\POS-Spooler`.
- Emits the same non-secret result fields plus spooler id/name/server URL; never
  emits the key.

- [ ] **Step 1: Write spooler transaction/adoption tests and confirm RED**

Cover valid current metadata, one-time adoption from exact NSSM service + env +
installed release, wrong executable, corrupt/missing env, server unavailable,
current, collision, downgrade, swap failure, self-status mismatch, and success.
Assert env/state/log bytes and printer configuration remain unchanged.

- [ ] **Step 2: Implement the spooler updater**

Preflight the stored server `/health` before mutation. Preserve the exact env;
stop only `POS Print Spooler`; swap only manifest-owned application roots; keep
installed Node/NSSM paths; restart and require self-status version/id/name match.
Write `C:\ProgramData\POS-Spooler\install.json` only after success, excluding
the key. Restore previous code and env on failure.

- [ ] **Step 3: Run focused verification and commit**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/spooler-update-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-contract-probe.ps1
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js
git add deployment/windows/Update-Spooler.ps1 tests/installer/spooler-update-probe.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "feat(installer): add configuration-preserving spooler updater"
```

### Task 6: Compile update-only variants from the existing Inno sources

**Files:**

- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `scripts/build-installers.ps1`
- Modify: `backend/tests/unit/installerUpdateContract.test.js`

**Interfaces:**

- `/DUpdateOnly=1` selects update stage, update output filename, update scripts,
  and update-only wizard behavior.
- Without `/DUpdateOnly`, current fresh installer behavior remains unchanged.

- [ ] **Step 1: Add failing Inno/build contract tests**

Require the original AppIds/AppNames/DefaultDirName/admin/x64/Win10 floors in
both modes. Update mode must stage payload under `{tmp}`, refuse missing packaged
state, show installed and target version, require confirmation, call only the
matching `Update-*.ps1`, show its result/error log, and expose no restaurant,
port, server URL, key, station id, or station name input.

- [ ] **Step 2: Add the single compile-time branch**

Keep one `.iss` per product. Conditionalize only stage/output/files/wizard
execution. Keep the same AppId and AppName so Inno appends to the existing
uninstall identity and updates its displayed version. Preserve the existing
fresh `[UninstallRun]`/`[UninstallDelete]` contract; the update cannot create a
second Add/Remove Programs entry.

Update mode copies payload and updater scripts to `{tmp}`, runs the updater,
then deletes temp files. It does not copy directly into `{app}` before the
PowerShell transaction succeeds.

- [ ] **Step 3: Compile all four EXEs and enforce size gates**

Extend `build-installers.ps1` to produce:

```text
POSAPP-Server-Setup.exe
POSAPP-Spooler-Setup.exe
POSAPP-Server-Update.exe
POSAPP-Spooler-Update.exe
```

Retain existing 220 MiB/180 MiB fresh gates. Set update gates to 90 MiB server
and 170 MiB spooler, write SHA-256 sidecars, and fail before sidecar creation on
missing/oversized output.

Run:

```powershell
npm run build:installers
```

Expected: exit 0, four EXEs and four `.sha256` files under `deployment/out`.

- [ ] **Step 4: Run installer contracts and commit**

```powershell
npx vitest run backend/tests/unit/installerUpdateContract.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/unit/installerCli.test.js
git add deployment/server/POSAPP-Server.iss deployment/spooler/POSAPP-Spooler.iss scripts/build-installers.ps1 backend/tests/unit/installerUpdateContract.test.js
git commit -m "feat(installer): compile state-aware update packages"
```

### Task 7: Add update smoke evidence and operator documentation

**Files:**

- Create: `tests/installer/update-smoke.ps1`
- Modify: `deployment/README.md`
- Modify: `docs/architecture.json`
- Generate: `docs/architecture.html`
- Modify: `package.json` test script only if the new focused tests are not
  already included by `test:installer`.

**Interfaces:**

- `update-smoke.ps1` accepts expected server/spooler versions and commits plus
  `-IncludeSpooler`, `-AfterReboot`, and `-WhatIf`.
- It records JSON/log evidence under `tests/installer/results` like the fresh
  smoke test.

- [ ] **Step 1: Write the smoke verifier**

Before update, record row counts and stable hashes/values for users, products,
categories, orders, held_orders, settings, schema ledger, ports, env files,
spooler identity, and printer configuration. After update, assert:

- existing business row counts/identities did not decrease;
- held orders remain restorable;
- only approved migrations were added and schema validation passes;
- ports, secrets, shortcuts, services, station identity, and printer mappings
  are unchanged;
- health/self-status report target release;
- automatic-start and startup-repair contracts remain present;
- after reboot, services and health recover without installer/database bootstrap.

`-WhatIf` must be non-mutating and list every check it would perform.

- [ ] **Step 2: Document exact technician workflow**

Document that update EXEs are only for packaged installs, require a version
bump, create a DB backup, preserve configuration, refuse downgrade/fresh/
ambiguous state, and leave exact logs. State that server and every spooler
station are updated independently, one machine at a time. Document recovery and
that source/XAMPP installations are upgraded manually by the technician, not by
a planned product workflow.

- [ ] **Step 3: Update deployment architecture and run static verification**

Add the update build/state/transaction flow to `docs/architecture.json`, then:

```powershell
npm run architecture
npm run architecture:check
npm run test:installer
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-contract-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/server-update-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/spooler-update-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-smoke.ps1 -WhatIf
```

Expected: every command exits 0.

- [ ] **Step 4: Commit documentation and smoke evidence**

```powershell
git add tests/installer/update-smoke.ps1 deployment/README.md docs/architecture.json docs/architecture.html package.json
git commit -m "docs(installer): add packaged update operations"
```

### Task 8: Whole-branch break pass and final verification

**Files:** All files changed since the plan commit.

- [ ] **Step 1: Inspect scope and forbidden mutations**

Run:

```powershell
git diff --check
git diff --stat master...HEAD
git diff master...HEAD -- deployment/windows deployment/server deployment/spooler scripts/build-installers.ps1 deployment/tools/validate-payload.js
```

Reject broad ProgramData/AppData deletion, secrets in logs/results/metadata,
fresh bootstrap tokens reachable from update scripts, user-configurable update
paths, service creation, port changes, unbounded wildcard deletion, or a second
migration implementation.

- [ ] **Step 2: Run fresh final verification**

```powershell
npm run architecture:check
npm run test:installer
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/runtime-config-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/startup-repair-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/update-contract-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/server-update-probe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/spooler-update-probe.ps1
npm run build:installers
```

Expected: all commands exit 0; four installer artifacts and checksums exist.

- [ ] **Step 3: Record honest remaining evidence**

Do not run or claim the destructive live update smoke on the development host.
Report the exact Win10/Win11 VM scenarios still pending: existing packaged
server update with live fixture DB, packaged spooler update, failure rollback,
reboot recovery, and physical receipt print. Do not merge or push.

## Plan attack checklist

The executor and reviewer must explicitly verify every item:

- [ ] Running an updater on a fresh machine refuses before creating any path.
- [ ] A source/XAMPP copy is not mistaken for a packaged install.
- [ ] Installed `install.json` and `release.json` disagreement blocks mutation.
- [ ] Wrong NSSM/service executable blocks mutation.
- [ ] Same-version/different-commit and downgrade packages block mutation.
- [ ] Target manifest traversal, reparse escape, missing file, or hash mismatch blocks mutation.
- [ ] Database backup and checksum exist before POS stops or migrations run.
- [ ] Target-staged migrations run against the existing maintenance env.
- [ ] Migration failure leaves old code/metadata and restarts old POS.
- [ ] Post-migration code failure restores old code without reverting additive DDL.
- [ ] Server updater never touches MariaDB/phpMyAdmin services or runtimes.
- [ ] Spooler updater never changes URL/key/id/name/env/state/printers.
- [ ] Update writes no secret to install metadata, result, transcript, or command line.
- [ ] First update from current manifest-less packaged installers works safely.
- [ ] Existing fresh installers still compile and retain their contract.
- [ ] Update installation retains one Add/Remove Programs entry and original uninstall behavior.
- [ ] No source-code/XAMPP upgrader, auto-download service, patch framework, or speculative runtime upgrader was added.

## Definition of done

The branch is ready for owner review only when Tasks 1–8 are committed, focused
tests/probes and all four installer builds pass freshly, the diff matches this
scope, and unperformed Win10/Win11/physical checks are reported as pending. The
branch must remain unmerged and unpushed.
