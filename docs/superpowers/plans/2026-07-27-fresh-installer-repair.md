# Fresh Windows Installer Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute exactly one task per run, inline, without subagents. Stop after the task's commit and report evidence before continuing.

**Goal:** Turn the existing installer scaffolding into two self-contained, buildable, fail-fast Windows installers that can pass clean-VM acceptance without touching an existing XAMPP installation.

**Architecture:** Keep one release builder, one server provisioning script, and one spooler provisioning script. Inno owns file installation and wizard UX; PowerShell owns Windows services, ACLs, firewall, and rollback; Node owns template rendering, database bootstrap, and post-install verification. Remove comment-based contracts and validate executable handoffs instead.

**Tech Stack:** Node.js 22.23.0, PowerShell 5.1+, Inno Setup 6.7.3, MariaDB 11.8.8 MSI, Apache 2.4.68, PHP 8.4.16, phpMyAdmin 5.2.3, NSSM 2.24, Vitest.

## Global Constraints

- This is fresh-install only. Do not detect, migrate, stop, uninstall, or modify XAMPP.
- Work only on `codex/fresh-pos-installers`; do not merge until the final automated gate passes.
- Do not run installers, create services, edit firewall rules, or connect to the live development database on `C:\xampp\htdocs\posapp`.
- Server AppId remains `{E99DB275-DDA0-43A0-95CD-7AE07185122C}`.
- Spooler AppId remains `{80657A48-9BCB-4455-8CA9-A18139FDFC58}`.
- Service names remain `POSAppMariaDB`, `POSApp`, `POSAppPhpMyAdmin`, and `POS Print Spooler`.
- Durable roots remain `C:\ProgramData\POSApp` and `C:\ProgramData\POS-Spooler`; uninstall never recursively deletes them.
- Build and install native Node dependencies with the packaged Node 22 runtime, never the developer machine's Node version.
- Secrets may exist only in ACL-protected response/configuration files. Never place them in command-line arguments, transcripts, Inno logs, `install.json`, or `release.json`.
- No test may pass because a required word appears in a comment. Tests must execute a function, CLI, parser, or payload validator.
- Do not add an ORM, installer framework, service abstraction, repository layer, generic plugin system, updater, licensing, LAN discovery, or existing-restaurant upgrader.
- Every task follows red → minimal implementation → green → commit. If the stated expected output is not reached, stop.

## Executor Control Prompt

Use this prompt for each small-executor run:

```text
Execute only Task N from docs/superpowers/plans/2026-07-27-fresh-installer-repair.md on branch codex/fresh-pos-installers. Read the whole task and Global Constraints first. Work inline; do not spawn subagents. Preserve unrelated untracked files. Do not install services, alter firewall rules, invoke MariaDB bootstrap against the live database, or run either installer on this host. Start from the required failing test, implement the minimum fix, run only the listed checks, inspect git diff, commit only the listed files, then stop and report exact commands/results. If any required artifact or tool is unavailable, stop rather than weakening the test or writing a comment to satisfy it.
```

## Finding-to-Task Map

| Review finding | Repair task |
|---|---|
| Build always throws; EXEs cannot be produced | Task 2 |
| Node, backup script, bootstrap, verifier, database and vendor inputs absent | Task 2 |
| Node 24 build vs packaged Node 22; frontend dependencies shipped | Task 2 |
| Bootstrap CLI is a no-op; verifier ignores arguments | Task 3 |
| Server provisioning omits secrets, env, Apache/PHP/phpMyAdmin and service creation | Task 4 |
| Inno executes before files exist; fake port suggestion; unsafe response files | Task 5 |
| Spooler copies `{app}` onto itself; local spooler is cosmetic | Task 6 |
| Repair/rollback incomplete; uninstall duplicated | Task 7 |
| Smoke checks contain false positives | Task 8 |
| String/comment tests, unignored build inputs, untracked governing plan | Tasks 1 and 9 |

---

### Task 1: Replace Fake Contracts with Executable Boundaries

**Files:**
- Modify: `.gitignore`
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Create: `deployment/tools/validate-payload.js`
- Test: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Produces `validatePayload(root, kind): { fileCount: number }` for `kind = 'server' | 'spooler'`.
- CLI form: `node deployment/tools/validate-payload.js <absolute-root> <server|spooler>`; exits nonzero on violation.
- Rejects missing required files, forbidden files, unresolved template tokens, and invalid release identity metadata.

- [ ] **Step 1: Ignore generated/vendor state and ensure the repair plan is tracked**

Append exactly:

```gitignore
# Fresh installer build inputs and generated output
deployment/vendor/
deployment/out/
tests/installer/results/
```

Do not ignore `deployment/vendor-lock.json`, installer definitions, templates, database baseline, or plans.

- [ ] **Step 2: Write failing executable payload tests**

Replace wizard/comment `toContain()` assertions with temporary-directory tests:

```js
import os from 'os';
import { validatePayload, REQUIRED_PATHS } from '../../../deployment/tools/validate-payload.js';

function createMinimalPayload(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pos-${kind}-`));
  const required = REQUIRED_PATHS[kind];
  for (const relative of required) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, relative === 'release.json'
      ? JSON.stringify({ version: '1.0.0', commit: 'a'.repeat(40), schemaVersion: 'posapp-fresh-baseline-v1', spoolerVersion: '1.2.0' })
      : 'fixture');
  }
  return root;
}

it('rejects a server payload without private Node and bootstrap tools', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-stage-'));
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ payloads: { server: {} } }));
  expect(() => validatePayload(root, 'server')).toThrow(/runtime[\\/]node[\\/]node\.exe/);
});

it('rejects forbidden files even when release metadata lists them', () => {
  const root = createMinimalPayload('spooler');
  fs.writeFileSync(path.join(root, '.env'), 'SPOOLER_KEY=secret');
  expect(() => validatePayload(root, 'spooler')).toThrow(/forbidden.*\.env/i);
});
```

Required server paths:

```text
server.js
package.json
package-lock.json
runtime/node/node.exe
scripts/db-backup.js
deployment/database/baseline.sql
deployment/database/manifest.json
deployment/tools/bootstrap-database.js
deployment/tools/installer-config.js
deployment/tools/verify-install.js
deployment/templates/pos.env.template
release.json
```

Required spooler paths:

```text
server.js
install-service.js
package.json
package-lock.json
runtime/node/node.exe
.cache/puppeteer
release.json
```

Forbidden anywhere: `.git`, `.env`, `.env.test`, `tests`, `docs`, `skills`, `*.map`, `*.7z`, `*.zip`, `playwright-report`, and `test-results`.

- [ ] **Step 3: Run RED**

Run:

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js
```

Expected: FAIL because `validate-payload.js` does not exist.

- [ ] **Step 4: Implement the validator with Node standard library only**

Implementation rules:

```js
function validatePayload(root, kind) {
  const required = REQUIRED_PATHS[kind];
  if (!required) throw new Error(`Unknown payload kind: ${kind}`);
  for (const relative of required) {
    if (!fs.existsSync(path.join(root, relative))) throw new Error(`Missing payload file: ${relative}`);
  }
  const files = walkFiles(root);
  for (const file of files) assertAllowed(file);
  const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
  if (!release.version || !release.commit || !release.schemaVersion) throw new Error('Invalid release identity');
  return { fileCount: files.length };
}

module.exports = { validatePayload, REQUIRED_PATHS };

if (require.main === module) {
  try {
    const [root, kind] = process.argv.slice(2);
    if (!root || !path.isAbsolute(root) || !kind) throw new Error('Usage: validate-payload.js <absolute-root> <server|spooler>');
    process.stdout.write(`${JSON.stringify(validatePayload(root, kind))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
```

Do not create classes, schemas, factories, or a generic validation framework.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js
git diff --check
git add .gitignore deployment/tools/validate-payload.js backend/tests/unit/installerPackageContract.test.js docs/superpowers/plans/2026-07-27-fresh-installer-repair.md
git commit -m "test(installer): enforce executable payload contracts"
```

Expected: tests pass; `git status` no longer lists `deployment/vendor/` or `deployment/out/`.

---

### Task 2: Build Self-Contained Payloads and Real Installer EXEs

**Files:**
- Modify: `scripts/build-installers.ps1`
- Modify: `package.json`
- Modify: `backend/tests/unit/installerPackageContract.test.js`
- Test: `deployment/tools/validate-payload.js`

**Interfaces:**
- `scripts/build-installers.ps1 -StageOnly` produces validated server/spooler directories.
- `scripts/build-installers.ps1` invokes both `.iss` files and writes `.sha256` sidecars.

- [ ] **Step 1: Add a failing staged-payload assertion**

Test the current `deployment/out/stage` when it exists and directly inspect the build script otherwise. The test must assert the script contains actual copy/extract operations for every required path, not comments.

Add a script-level dry mode:

```powershell
param([switch]$StageOnly, [switch]$SkipDependencyInstall)
```

`SkipDependencyInstall` is allowed only when `node_modules` and packaged Chrome already exist in the target stage; otherwise it fails.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js
```

Expected: FAIL for missing private Node and required server tools.

- [ ] **Step 3: Make Node 22 the only build/runtime Node**

In `build-installers.ps1`:

1. Verify all files from `vendor-lock.json`.
2. Expand `node-v22.23.0-win-x64.zip` below `deployment/out/toolchain/node`.
3. Define `$nodeExe` and `$npmCmd` from that extracted runtime.
4. Use `& $npmCmd ci`, `& $npmCmd run build`, and stage dependency installation through that runtime.
5. Fail when `& $nodeExe --version` is not exactly `v22.23.0`.

Do not use the machine's `node`, `npm`, or `npx` after toolchain extraction.

- [ ] **Step 4: Move frontend/build-only packages out of production dependencies**

Move these existing packages from `dependencies` to `devDependencies`, preserving their current version ranges and regenerating `package-lock.json` with packaged Node 22:

```text
@tailwindcss/vite
@vitejs/plugin-vue
chart.js
html2pdf.js
pinia
socket.io-client
tailwindcss
vite
vue
vue-router
```

Keep `xlsx` and `qrcode` in production dependencies because backend routes/services require them. Run the production server dependency check from the staged directory:

```powershell
& $stageNode -e "require('express'); require('mysql2'); require('xlsx'); require('qrcode'); console.log('server dependencies ok')"
```

Expected: `server dependencies ok`.

- [ ] **Step 5: Stage the complete server payload**

Copy exactly:

```text
server.js
backend/ excluding tests, fixtures and migration appliers
dist/
assets/
scripts/db-backup.js
deployment/database/
deployment/tools/bootstrap-database.js
deployment/tools/installer-config.js
deployment/tools/verify-install.js
deployment/tools/validate-payload.js
deployment/templates/
package.json
package-lock.json
runtime/node/ (expanded private Node)
install/vendor/ (the seven checksum-verified vendor archives/installers)
```

Run production dependency installation inside the server stage using Node 22. Remove `*.map` afterward. Do not copy repository `node_modules`.

- [ ] **Step 6: Stage the complete spooler payload**

Copy tracked spooler runtime excluding tests/machine state, then add:

```text
runtime/node/
.cache/puppeteer/
```

Run spooler `npm ci --omit=dev` and Puppeteer browser installation using Node 22. Verify `canvas` loads under the packaged runtime:

```powershell
& $stageNode -e "require('./node_modules/canvas'); console.log('canvas ok')"
```

Expected: `canvas ok`.

- [ ] **Step 7: Replace the 2.8 MB per-file manifest**

Keep embedded `release.json` to immutable identity only:

```json
{
  "version": "1.0.0",
  "commit": "<git commit>",
  "schemaVersion": "posapp-fresh-baseline-v1",
  "spoolerVersion": "1.2.0"
}
```

Do not enumerate dependency files or embed a self-referential archive hash in `release.json`. Validate staged contents before compilation and write SHA-256 sidecars for the final installer EXEs after compilation.

- [ ] **Step 8: Invoke Inno instead of throwing**

Replace the unconditional throw with:

```powershell
Invoke-Native $iscc.Source @((Join-Path $repo 'deployment/spooler/POSAPP-Spooler.iss'))
Invoke-Native $iscc.Source @((Join-Path $repo 'deployment/server/POSAPP-Server.iss'))
foreach ($exe in @('POSAPP-Spooler-Setup.exe', 'POSAPP-Server-Setup.exe')) {
    $path = Join-Path $out $exe
    if (-not (Test-Path $path)) { throw "Missing installer output: $exe" }
    (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant() | Set-Content "$path.sha256"
}
```

- [ ] **Step 9: Verify stage, compile when available, commit**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1 -StageOnly
node deployment/tools/validate-payload.js (Resolve-Path deployment/out/stage/server) server
node deployment/tools/validate-payload.js (Resolve-Path deployment/out/stage/spooler) spooler
npm run test:installer
```

Expected: both validators pass. If `ISCC.exe` is installed, also run `npm run build:installers` and require both EXEs plus sidecars. If unavailable, stop after committing Task 2 and record compilation as the Task 9 gate; do not claim EXEs exist.

```powershell
git add scripts/build-installers.ps1 package.json backend/tests/unit/installerPackageContract.test.js
git commit -m "build(installer): produce self-contained Windows payloads"
```

---

### Task 3: Make Bootstrap and Verification Real CLIs

**Files:**
- Modify: `deployment/tools/bootstrap-database.js`
- Modify: `deployment/tools/verify-install.js`
- Modify: `backend/tests/integration/installerBaseline.test.js`
- Create: `backend/tests/unit/installerCli.test.js`
- Modify: `package.json`

**Interfaces:**
- `bootstrap-database.js --config <protected-json>` applies baseline/seeds and exits nonzero on failure.
- `bootstrap-database.js --check <protected-json>` validates config and baseline without connecting.
- `verify-install.js --config <protected-json>` executes every configured gate.

- [ ] **Step 1: Write failing CLI tests with child_process.spawnSync**

Cover:

```js
expect(run('bootstrap-database.js', ['--check', config]).status).toBe(0);
expect(run('bootstrap-database.js', ['--config', missing]).status).not.toBe(0);
expect(run('verify-install.js', ['--config', missing]).status).not.toBe(0);
```

Assert `bootstrap-database.js` with no arguments exits nonzero instead of silently succeeding.

- [ ] **Step 2: Run RED**

```powershell
npx vitest run backend/tests/unit/installerCli.test.js
```

Expected: current bootstrap exits `0` with no work.

- [ ] **Step 3: Implement one strict argument parser in each CLI**

Accepted forms are only:

```text
--check <absolute-json-path>
--config <absolute-json-path>
```

Reject unknown arguments, relative paths, missing files, unresolved template tokens, absent passwords, and non-loopback database host. Add `if (require.main === module)` and call the existing exported functions.

The bootstrap JSON keys are exactly:

```json
{
  "host": "127.0.0.1",
  "port": 3306,
  "adminUser": "root",
  "adminPassword": "secret",
  "database": "posapp",
  "appUser": "posapp_runtime",
  "appPassword": "secret",
  "maintenanceUser": "posapp_maintenance",
  "maintenancePassword": "secret",
  "adminUserNumber": "009384",
  "adminName": "Administrator"
}
```

- [ ] **Step 4: Make verification perform real gates**

The verification JSON contains POS/phpMyAdmin URLs, DB credentials, durable paths, expected release identity, and backup path plus expected SHA-256. Parse it once; never read secrets from command arguments.

Verification must:

- validate schema;
- assert exactly one active `009384` admin and zero orders/products/customers;
- assert `/health` release version/commit/schema;
- require phpMyAdmin HTTP 2xx/3xx on `127.0.0.1`;
- create/write/delete a probe file in each durable directory;
- gunzip the backup and compare its compressed-file SHA-256 to the supplied checksum.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npx vitest run backend/tests/unit/installerCli.test.js backend/tests/integration/installerBaseline.test.js
npm run test:installer
node deployment/tools/bootstrap-database.js
```

Expected: tests pass; final command exits nonzero with usage text.

```powershell
git add deployment/tools/bootstrap-database.js deployment/tools/verify-install.js backend/tests/unit/installerCli.test.js backend/tests/integration/installerBaseline.test.js package.json
git commit -m "fix(installer): make database and verification CLIs executable"
```

---

### Task 4: Complete the Server Provisioning Transaction

**Files:**
- Modify: `deployment/windows/Install-PosServer.ps1`
- Modify: `deployment/templates/httpd.conf.template`
- Modify: `deployment/templates/php.ini.template`
- Modify: `deployment/templates/config.inc.php.template`
- Modify: `deployment/tools/installer-config.js`
- Modify: `backend/tests/unit/installerConfig.test.js`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- `Install-PosServer.ps1 -ConfigFile <protected-json> -PayloadRoot <installed-app>` performs a fresh install and records a cleanup ledger.
- Apache loads PHP through the packaged thread-safe `php8apache2_4.dll`; no separate PHP-FCGI service or port.

- [ ] **Step 1: Add a static orchestration test that checks ordered executable calls**

Parse the PowerShell source and assert ordered positions for:

```text
port checks → VC runtime → MariaDB → bind-address → bootstrap → Apache/PHP/phpMyAdmin → POS service → backup → verification
```

Also assert every `msiexec`, `httpd`, NSSM, `sc.exe`, and Node invocation routes through `Invoke-Native` or immediately checks `$LASTEXITCODE`.

- [ ] **Step 2: Run RED**

Expected failures: no Apache extraction/registration, no env rendering, and no bootstrap configuration write.

- [ ] **Step 3: Generate secrets and configs before service creation**

Use Node `crypto.randomBytes(32).toString('base64url')` through `installer-config.js`. Generate root, app, maintenance, blowfish, and spooler secrets once. Render atomically:

```text
C:\ProgramData\POSApp\config\pos.env
C:\ProgramData\POSApp\config\db-maintenance.cnf
C:\ProgramData\POSApp\web-tools\apache\conf\httpd.conf
C:\ProgramData\POSApp\web-tools\php\php.ini
C:\ProgramData\POSApp\web-tools\phpmyadmin\config.inc.php
```

Apply Administrators/SYSTEM-only ACLs before writing secrets. `install.json` contains ports, versions, paths, and release identity only.

- [ ] **Step 4: Install MariaDB correctly and locally**

Invoke MSI silently with service name, generated root password, selected port, ProgramData data directory, and remote root disabled. After installation, write a MariaDB config containing:

```ini
[mysqld]
bind-address=127.0.0.1
port=<selected DB port>
datadir=<ProgramData database path>
```

Restart `POSAppMariaDB`, wait for loopback readiness, write the protected bootstrap JSON, invoke the real bootstrap CLI, then delete the root credential file in `finally`.

- [ ] **Step 5: Install private Apache/PHP/phpMyAdmin**

Expand the verified archives under Program Files. Use the thread-safe PHP Apache module:

```apache
LoadModule php_module "{{PHP_ROOT}}/php8apache2_4.dll"
PHPIniDir "{{PHP_ROOT}}"
AddHandler application/x-httpd-php .php
DirectoryIndex index.php
Listen 127.0.0.1:{{PHPMYADMIN_PORT}}
```

Remove `proxy_fcgi`, `PHP_FCGI_PORT`, and the nonexistent FCGI service. Register Apache exactly:

```powershell
Invoke-Native $httpdExe @('-k','install','-n','POSAppPhpMyAdmin','-f',$httpdConf)
```

- [ ] **Step 6: Install POS, backup and verify**

Install NSSM from its expanded archive. Configure POS with packaged Node, `NODE_ENV=production`, and `POSAPP_ENV_FILE`. Set MariaDB dependency and automatic/restart recovery. Register the backup task with an absolute script path, working directory, and `POSAPP_ENV_FILE`. Start services, create one backup, compute its SHA-256, invoke `verify-install.js --config`, then write secret-free `install.json`.

- [ ] **Step 7: Implement exact rollback ownership**

Maintain a ledger of resources actually created in this attempt:

```powershell
$created = [ordered]@{ firewall=$false; task=$false; posService=$false; apacheService=$false; mariaService=$false; programFiles=$false; programData=$false }
```

On failure, remove only entries marked true, in reverse order. Never remove MariaDB data after bootstrap has successfully completed; instead stop and preserve it with an explicit failure log for manual review.

- [ ] **Step 8: Verify and commit**

```powershell
$null = [scriptblock]::Create((Get-Content -Raw deployment/windows/Install-PosServer.ps1))
npx vitest run backend/tests/unit/installerConfig.test.js backend/tests/unit/installerPackageContract.test.js
git diff --check
git add deployment/windows/Install-PosServer.ps1 deployment/templates deployment/tools/installer-config.js backend/tests/unit/installerConfig.test.js backend/tests/unit/installerPackageContract.test.js
git commit -m "fix(installer): provision the complete local server stack"
```

---

### Task 5: Make the Server Wizard Execute After File Installation

**Files:**
- Modify: `deployment/server/POSAPP-Server.iss`
- Create: `deployment/windows/Get-PortStatus.ps1`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Port helper returns JSON `{ port, available, processId, processName, suggestion }` without stopping listeners.
- Inno invokes provisioning only from `ssPostInstall`, after `[Files]` completes.

- [ ] **Step 1: Write failing wizard behavior tests**

Reject `Exec(...)` inside `NextButtonClick(wpReady)`. Require:

- `CurStepChanged(ssPostInstall)` provisioning;
- `try/finally` response deletion;
- `icacls` before response write/use;
- actual invocation of `Get-PortStatus.ps1`;
- no occurrence of a fake `SuggestAvailablePort` body;
- actual `[Files]` entry for `POSAPP-Spooler-Setup.exe`.

- [ ] **Step 2: Implement the port helper**

Use `Get-NetTCPConnection -State Listen -LocalPort`, `Get-Process`, and a bounded loop to find the next free port. Validate `1..65535`. Output compressed JSON and never stop or modify the owner process.

- [ ] **Step 3: Correct wizard flow**

Use:

```text
Welcome → Restaurant → Components → conditional/Advanced Ports → Ready → copy files → provision → verified finish
```

Add the helper to the server installer source list so it is available before the
post-install callback:

```ini
[Files]
Source: "..\windows\Get-PortStatus.ps1"; DestDir: "{tmp}"; Flags: dontcopy
```

At the start of `ssPostInstall`, call `ExtractTemporaryFile('Get-PortStatus.ps1')`
and pass the extracted absolute path to the response/configuration step.

Run port helper when defaults are checked and immediately before provisioning. Show PID/process where available. Reject duplicates. Hide default ports page only when all defaults are available; add an Advanced button that opens it.

- [ ] **Step 4: Protect and escape the response file**

Implement one `JsonEscape()` function covering backslash, quote, CR, LF, and tab. After writing `{tmp}\server-response.json`, invoke `icacls` to disable inheritance and grant only SYSTEM, Administrators, and the elevated user. Delete in a `try/finally` block.

- [ ] **Step 5: Run provisioning post-copy and bundle the exact spooler installer**

At `ssPostInstall`, invoke `Install-PosServer.ps1` from `{app}`. On nonzero exit, raise an installation error. If local spooler is selected, execute the bundled `POSAPP-Spooler-Setup.exe` only after `/health` succeeds; do not duplicate spooler service logic.

- [ ] **Step 6: Verify and commit**

```powershell
$null = [scriptblock]::Create((Get-Content -Raw deployment/windows/Get-PortStatus.ps1))
npx vitest run backend/tests/unit/installerPackageContract.test.js
git add deployment/server/POSAPP-Server.iss deployment/windows/Get-PortStatus.ps1 backend/tests/unit/installerPackageContract.test.js
git commit -m "fix(installer): run server provisioning after payload install"
```

---

### Task 6: Repair the Standalone and Local Spooler Flow

**Files:**
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `deployment/windows/Install-Spooler.ps1`
- Modify: `pos-spooler-printer/install-service.js`
- Modify: `backend/routes/spooler.js`
- Modify: `backend/services/spoolerRegistry.js`
- Modify: `pos-spooler-printer/tests/external-config.test.js`
- Modify: `backend/tests/unit/spoolerRegistry.test.js`

**Interfaces:**
- `Install-Spooler.ps1 -ConfigFile <protected-json> -PayloadRoot <installed-app>` configures files already installed by Inno; it never copies `{app}`.
- `GET /api/spooler/self-status` authenticates existing spooler key/id and returns only that station's connected/version state.

- [ ] **Step 1: Write RED tests**

Cover production env loading, packaged Node path, ProgramData logs/state, service automatic recovery, and authenticated self-status. Add a PowerShell source assertion that `Copy-Item $PayloadRoot $ProgramFilesRoot` does not exist.

- [ ] **Step 2: Remove self-copy and install with private Node**

Inno owns `[Files]`. PowerShell validates required files under `PayloadRoot`, writes config atomically, then invokes:

```powershell
& "$PayloadRoot\runtime\node\node.exe" "$PayloadRoot\install-service.js"
```

Pass `SPOOLER_ENV_FILE`, ProgramData stdout/stderr paths, and packaged Node path into node-windows. Stop an existing service before repair and restart it afterward.

- [ ] **Step 3: Move spooler provisioning to post-copy**

Apply the same JSON escaping, ACL, `try/finally`, and `ssPostInstall` rules as Task 5. Preserve existing ProgramData config during repair unless the user explicitly changed a wizard field.

- [ ] **Step 4: Verify station identity**

Add the narrow self-status endpoint using the existing registry; do not add discovery or pairing. Poll until the exact `spooler_id`, configured name, and packaged version are connected or timeout after 30 seconds.

- [ ] **Step 5: Run full spooler tests and commit**

```powershell
Set-Location pos-spooler-printer
npm test
Set-Location ..
npx vitest run backend/tests/unit/spoolerRegistry.test.js backend/tests/unit/installerPackageContract.test.js
git add deployment/spooler/POSAPP-Spooler.iss deployment/windows/Install-Spooler.ps1 pos-spooler-printer/install-service.js pos-spooler-printer/tests/external-config.test.js backend/routes/spooler.js backend/services/spoolerRegistry.js backend/tests/unit/spoolerRegistry.test.js
git commit -m "fix(installer): complete standalone spooler provisioning"
```

---

### Task 7: Make Repair, Failure Cleanup and Uninstall Honest

**Files:**
- Modify: `deployment/windows/Install-PosServer.ps1`
- Modify: `deployment/windows/Install-Spooler.ps1`
- Modify: `deployment/windows/Remove-PosRuntime.ps1`
- Modify: `deployment/windows/Remove-SpoolerRuntime.ps1`
- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Repair reads existing `install.json`/env files and preserves credentials.
- Removal scripts remove runtime registrations only; Inno removes immutable files.

- [ ] **Step 1: Add executable repair/removal tests**

Use temporary ProgramData fixtures and `-WhatIf`/planning mode to assert the returned action ledger. Require existing secrets and ports to be retained during repair. Reject any recursive removal whose resolved target is below ProgramData.

- [ ] **Step 2: Implement repair detection**

If `install.json` and protected env exist, verify release/AppId ownership, reuse ports and secrets, skip baseline/bootstrap, repair missing immutable files/services, and rerun verification. If ownership files are inconsistent, fail and require manual inspection.

- [ ] **Step 3: Simplify removal ownership**

`Remove-PosRuntime.ps1` removes only POS/Apache service registrations, firewall rule, and backup task. `Remove-SpoolerRuntime.ps1` removes only the spooler service. Delete duplicate `sc.exe` entries from Inno. Let Inno remove `{app}`. Print preserved ProgramData paths.

- [ ] **Step 4: Verify and commit**

```powershell
npm run test:installer
$null = [scriptblock]::Create((Get-Content -Raw deployment/windows/Remove-PosRuntime.ps1))
$null = [scriptblock]::Create((Get-Content -Raw deployment/windows/Remove-SpoolerRuntime.ps1))
git add deployment/windows deployment/server/POSAPP-Server.iss deployment/spooler/POSAPP-Spooler.iss backend/tests/unit/installerPackageContract.test.js
git commit -m "fix(installer): make repair and removal preserve state"
```

---

### Task 8: Replace False Smoke Checks with Real Acceptance Assertions

**Files:**
- Modify: `tests/installer/fresh-install-smoke.ps1`
- Modify: `deployment/tools/verify-install.js`
- Modify: `deployment/README.md`
- Test: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Smoke script consumes installed ports, release identity, admin credentials, and optional remote LAN probe URL.
- Every displayed PASS corresponds to a performed assertion.

- [ ] **Step 1: Add a test that forbids message-only checks**

Reject checks whose bodies only call `Write-Output`. Require database assertions, HTTP login, service recovery configuration, bind-address inspection, firewall profile/direction/port inspection, shortcut target inspection, backup restore verification command, and optional Terminal B probe.

- [ ] **Step 2: Fix PowerShell dependency/recovery checks**

Convert `sc.exe qc` output to one string before matching:

```powershell
$serviceConfig = (sc.exe qc POSApp) -join "`n"
if ($serviceConfig -notmatch 'POSAppMariaDB') { throw 'dependency missing' }
```

Inspect `sc.exe qfailure` and require restart actions for POS/spooler.

- [ ] **Step 3: Perform real application/database checks**

Authenticate `009384` through the real login endpoint using the installer-created initial credential contract. Query through the maintenance client and require canonical seeds plus zero orders/products/customers. Inspect MariaDB/Apache configuration files and listening addresses, not merely open ports.

- [ ] **Step 4: Verify shortcut, backup and reboot state**

Resolve the `.lnk` target through `WScript.Shell` and require the selected `/pos` URL. Restore the generated backup into a separate temporary database name, validate schema/row counts, then drop only that explicitly generated temporary database. `-AfterReboot` must require all automatic services and health.

- [ ] **Step 5: Run safe checks and commit**

```powershell
$null = [scriptblock]::Create((Get-Content -Raw tests/installer/fresh-install-smoke.ps1))
powershell -NoProfile -ExecutionPolicy Bypass -File tests/installer/fresh-install-smoke.ps1 -WhatIf
npm run test:installer
git add tests/installer/fresh-install-smoke.ps1 deployment/tools/verify-install.js deployment/README.md backend/tests/unit/installerPackageContract.test.js
git commit -m "test(installer): make acceptance checks evidence based"
```

Expected: `-WhatIf` performs no filesystem writes, service queries, or network calls and prints the planned checks only.

---

### Task 9: Build and Audit the Actual Release Artifacts

**Files:**
- Modify only if a verified build defect is found: `scripts/build-installers.ps1`, `.iss` files, installer scripts, or tests directly covering the defect
- Modify: `deployment/README.md`

**Interfaces:**
- Produces two EXEs and two matching SHA-256 sidecars from one clean release commit.

- [ ] **Step 1: Install/locate Inno Setup on the build machine**

Require Inno Setup 6.7.3 and confirm:

```powershell
& "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe" /?
```

- [ ] **Step 2: Build from a clean tracked tree**

```powershell
git status --short
npm run test:installer
npm run build:installers
```

Expected outputs:

```text
deployment/out/POSAPP-Server-Setup.exe
deployment/out/POSAPP-Server-Setup.exe.sha256
deployment/out/POSAPP-Spooler-Setup.exe
deployment/out/POSAPP-Spooler-Setup.exe.sha256
```

- [ ] **Step 3: Audit installer contents**

Run `validate-payload.js` against the exact staged directories that feed Inno,
then use Inno Setup's own `/LOG` compile output and the clean-VM installer run
to confirm the files copied into `{app}`. Do not introduce an unpinned archive
extractor solely for inspection. Confirm no repository metadata, secrets, tests,
source maps, docs, archives unrelated to installation, or development
dependencies. Confirm server includes all seven locked vendor inputs and
spooler contains private Node plus packaged Chrome.

- [ ] **Step 4: Record hashes and commit build documentation**

Record release commit and both SHA-256 values in `deployment/README.md`; do not commit EXEs or vendor binaries.

```powershell
git add deployment/README.md
git commit -m "docs(installer): record verified installer artifacts"
```

---

### Task 10: Clean-VM Release Gate

**Files:**
- Modify after execution: `deployment/README.md`
- Modify after execution: `docs/printing-runbook.md`

**Interfaces:**
- Consumes exact Task 9 EXE hashes.
- Produces VM transcripts and a signed physical-printer checklist.

- [ ] **Step 1: Default-port fresh install**

On a reverted Windows x64 VM, install the server package using `3000/3306/8081`. Require server smoke checks, reboot recovery, shortcut target, zero business rows, and backup restore to pass.

- [ ] **Step 2: Conflict-port fresh install**

On a reverted VM, occupy all three defaults with harmless listeners. Require the wizard to identify owners, propose alternatives, preserve listeners, install consistently, and pass smoke checks.

- [ ] **Step 3: Forced-failure rollback**

Use a non-release build with a corrupted baseline checksum. Require installer failure, no POS/Apache service, no firewall rule or backup task, diagnostic logs, and no successful install marker.

- [ ] **Step 4: Terminal B standalone spooler**

Install only the spooler EXE on a second VM. Require no server/database/web-tool services, exact station/version registration, repair preserving state, and successful receipt/kitchen jobs.

- [ ] **Step 5: Physical workflow and final documentation**

Complete the existing printing runbook with real customer receipt, kitchen, void, Arabic/multiline, template, USB reconnect, queue recovery, and LAN-without-internet tests. Record Windows build, ports, printer models, runtime versions, release commit, installer hashes, tester name, date, and PASS/FAIL evidence.

- [ ] **Step 6: Final commit**

```powershell
git add deployment/README.md docs/printing-runbook.md
git commit -m "docs(installer): record clean Windows release acceptance"
```

Do not merge until every Task 10 scenario passes against the exact Task 9 hashes.

## Self-Review Result

- All twelve review findings map to an implementation task.
- The plan removes fake string/comment contracts and replaces them with executable CLI, payload, PowerShell, build, VM, and physical checks.
- The same service names, AppIds, ports, ProgramData roots, release identity and spooler interface are used consistently.
- Scope remains fresh install only; updater, licensing, discovery and existing-restaurant migration remain excluded.
- No placeholder implementation steps remain.
