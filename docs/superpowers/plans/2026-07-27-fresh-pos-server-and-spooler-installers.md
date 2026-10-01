# Fresh POS Server and Spooler Installers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task in inline execution. Do not use subagents for this project. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce two offline Windows installers: a fresh POS server installer that creates the complete local restaurant stack from zero, and a standalone spooler installer for every Windows computer that owns a physical printer.

**Architecture:** `POSAPP-Server-Setup.exe` installs immutable application/runtime files under `C:\Program Files\POSApp` and durable configuration, database data, uploads, backups, and logs under `C:\ProgramData\POSApp`. `POSAPP-Spooler-Setup.exe` installs the tracked spooler independently and keeps its configuration and durable print state under `C:\ProgramData\POS-Spooler`; the server installer may invoke this same spooler installer for a printer attached to the server. Both packages are built from explicit allowlists and pinned offline dependencies using Inno Setup 6.7.3.

**Tech Stack:** Inno Setup 6.7.3, PowerShell 5.1-compatible installation scripts, Node.js 22.23.0 x64 LTS private runtime, MariaDB 11.8.8 x64, Apache HTTP Server 2.4.68 x64, PHP 8.4.16 thread-safe x64, phpMyAdmin 5.2.3, NSSM 2.24, existing Express/Vue/mysql2 application, existing tracked spooler and Puppeteer browser runtime.

## Global Constraints

- Target only genuinely fresh Windows 10/11 or supported Windows Server x64 installations; legacy XAMPP/POS discovery and migration are technician-managed and outside the installer product scope.
- Produce exactly two distributable installers: `POSAPP-Server-Setup.exe` and `POSAPP-Spooler-Setup.exe`.
- The server installer must work without internet access after the EXE has been copied to the restaurant server.
- The standalone spooler installer must work without internet access after the EXE has been copied to a printer terminal.
- `POSAppMariaDB`, `POSApp`, `POSAppPhpMyAdmin`, and every installed `POS Print Spooler` service must use automatic startup and run before any Windows user logs in; POS and spooler services must restart after unexpected process failure.
- The server installer must create an all-users desktop shortcut named `POS App` targeting `http://localhost:{{POS_PORT}}/pos` with the selected port rendered into the URL.
- Default ports are POS `3000`, MariaDB `3306`, and phpMyAdmin `8081`; occupied defaults must trigger an editable port page with a suggested available value.
- Recheck every selected port immediately before installing services; never stop or reconfigure the process that owns a conflicting port.
- Bind MariaDB and phpMyAdmin to `127.0.0.1`; expose only the selected POS port through a Windows Firewall `Private` profile rule.
- Keep `mysql2`; do not introduce Prisma, an ORM, containers, XAMPP, or a generic deployment framework.
- phpMyAdmin is bundled as the technician database screen and uses cookie authentication; it does not own schema migrations, backups, or application validation.
- A fresh database comes from one canonical baseline plus an explicit migration manifest, never by replaying every historical migration file.
- Seed initial POS user number `009384`, name `Administrator`, role `admin`, active `yes`; leave manager override PIN unset.
- Generate database root, restricted application-user, `posapp_maintenance`, and spooler secrets during installation; never ship default database passwords.
- phpMyAdmin uses `posapp_maintenance`, which has full rights only on `posapp.*`; its generated password is shown once at installation completion and retained only in the ACL-protected maintenance option file for technician recovery.
- The shared spooler key is shown once at server-install completion and remains only in the ACL-protected `pos.env`; technicians enter it into standalone spooler installers until a future pairing workflow is separately approved.
- Ship production artifacts only: no `.git`, source maps, tests, fixtures, plans, development environment files, archives, or development dependencies.
- Do not implement hardware binding, activation servers, licence expiry, or DRM. Copying only `C:\Program Files\POSApp` must fail because durable configuration and credentials live outside it.
- Do not implement the future application or spooler updater. Do establish stable service names, release metadata, and durable paths so a later updater can replace binaries without touching data.
- The server installer offers `Install a local printer spooler` as an option and invokes the same standalone spooler installer used on Terminal B/C.
- Remote cashier terminals install nothing; they open the server through its restaurant LAN URL.
- Uninstall preserves MariaDB data, uploads, backups, and spooler state by default. Business-data deletion requires a separate explicit destructive maintenance action, not a normal uninstall checkbox.
- Do not distribute an Inno Setup-built commercial package until the appropriate Inno Setup commercial licence has been obtained.

## Explicit Non-Goals

- Existing restaurant/XAMPP upgrades, database migration discovery, and XAMPP removal.
- Automatic application updates or spooler updates.
- Automatic LAN discovery, central spooler deployment, or a new pairing API.
- Browser printing changes.
- A second POS server on printer terminals.
- Source-code obfuscation beyond excluding development material and source maps from release payloads.

## Release and Runtime Ownership

```text
C:\Program Files\POSApp\
├── app\                 # server.js, backend runtime, dist, required assets
├── runtime\node\        # private node.exe runtime
├── web-tools\apache\    # private localhost-only Apache
├── web-tools\php\       # private PHP
├── web-tools\phpmyadmin\
├── tools\                # bootstrap/verify/backup launchers
└── release.json          # app/build/schema/package identity

C:\ProgramData\POSApp\
├── config\pos.env
├── config\install.json
├── config\db-maintenance.cnf
├── database\            # MariaDB data directory
├── uploads\
├── backups\
└── logs\

C:\Program Files\POS-Spooler\
├── app\
├── runtime\node\
├── browser\
└── release.json

C:\ProgramData\POS-Spooler\
├── config\spooler.env
├── state\
└── logs\
```

## Planned File Map

**Create:**

- `deployment/README.md` — build prerequisites, artefact ownership, and clean-machine release procedure.
- `deployment/vendor-lock.json` — pinned filenames, versions, source URLs, SHA-256 values, and signature expectations.
- `deployment/database/baseline.sql` — authoritative empty current schema and canonical catalogue/settings seeds.
- `deployment/database/manifest.json` — baseline identity and ordered post-baseline migrations; initially empty after the baseline.
- `deployment/templates/pos.env.template` — installer-owned production environment template.
- `deployment/templates/spooler.env.template` — installer-owned spooler configuration template.
- `deployment/templates/httpd.conf.template` — localhost-only phpMyAdmin Apache configuration.
- `deployment/templates/php.ini.template` — minimal phpMyAdmin PHP configuration.
- `deployment/templates/config.inc.php.template` — cookie-authenticated phpMyAdmin configuration.
- `deployment/tools/installer-config.js` — validation, free-port suggestion, secret generation, and config rendering.
- `deployment/tools/bootstrap-database.js` — create database/users, import baseline/manifest, seed `009384`, and verify.
- `deployment/tools/verify-install.js` — database, release, service-facing HTTP, and durable-path verification.
- `deployment/windows/Install-PosServer.ps1` — native server/service/firewall/bootstrap orchestration.
- `deployment/windows/Install-Spooler.ps1` — native standalone spooler/service orchestration.
- `deployment/windows/Remove-PosRuntime.ps1` — stop/remove application services and firewall rule while preserving business data.
- `deployment/windows/Remove-SpoolerRuntime.ps1` — stop/remove spooler service while preserving configuration/state.
- `deployment/server/POSAPP-Server.iss` — server installer wizard and packaging.
- `deployment/spooler/POSAPP-Spooler.iss` — standalone spooler installer wizard and packaging.
- `scripts/build-installers.ps1` — clean allowlisted staging and both installer builds.
- `backend/tests/unit/installerConfig.test.js` — installer configuration unit contract.
- `backend/tests/unit/installerPackageContract.test.js` — release allowlist/vendor/template/static installer contract.
- `backend/tests/integration/installerBaseline.test.js` — restore a disposable database from the baseline and run schema/business seed checks.
- `pos-spooler-printer/tests/external-config.test.js` — external config and persistent-state contract.
- `tests/installer/fresh-install-smoke.ps1` — clean Windows acceptance automation.

**Modify:**

- `package.json` — add installer test/build scripts and a real release version input.
- `server.js` — load installer-owned environment, use durable uploads, and expose release identity in health responses.
- `backend/config/db.js` — honor `DB_PORT` and fail closed on missing production database credentials.
- `backend/config/logger.js` — write production logs to the configured durable log directory.
- `backend/routes/system.js` — store brand icons in the configured durable uploads directory.
- `backend/services/printDocumentCompiler.js` — read store icons from the same durable uploads directory.
- `scripts/db-backup.js` — use configured durable backup directory and bundled `mariadb-dump` without XAMPP fallback.
- `pos-spooler-printer/server.js` — load `SPOOLER_ENV_FILE`, require URL/key in production, and preserve current local-development behavior.
- `pos-spooler-printer/install-service.js` — accept installer-owned runtime/config/log paths rather than assuming the source directory.
- `pos-spooler-printer/README.md` — document standalone installer ownership and manual development setup separately.
- `docs/superpowers/plans/2026-07-26-deferred-pos-server-installer.md` — mark it superseded and link to this approved plan.

---

### Task 1: Lock the release contract and vendor supply chain

**Files:**
- Create: `deployment/vendor-lock.json`
- Create: `deployment/README.md`
- Create: `backend/tests/unit/installerPackageContract.test.js`
- Modify: `package.json`
- Modify: `docs/superpowers/plans/2026-07-26-deferred-pos-server-installer.md`

**Interfaces:**
- Produces: `deployment/vendor-lock.json` entries with `{ name, version, file, source, sha256, authenticodePublisher? }`.
- Produces: `npm run test:installer` and `npm run build:installers` commands used by all later tasks.

- [ ] **Step 1: Write the failing vendor-lock contract test**

```js
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

describe('fresh installer package contract', () => {
  it('pins every offline runtime dependency with a real sha256', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployment/vendor-lock.json'), 'utf8'));
    expect(lock.schemaVersion).toBe(1);
    expect(lock.packages.map(item => `${item.name}@${item.version}`)).toEqual([
      'node@22.23.0',
      'mariadb@11.8.8',
      'apache@2.4.68',
      'php@8.4.16',
      'phpmyadmin@5.2.3',
      'nssm@2.24',
      'vc-redist@14.44.35211.0'
    ]);
    for (const item of lock.packages) {
      expect(item.file).toMatch(/\S/);
      expect(item.source).toMatch(/^https:\/\//);
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx vitest run backend/tests/unit/installerPackageContract.test.js`

Expected: FAIL because `deployment/vendor-lock.json` does not exist.

- [ ] **Step 3: Download each immutable vendor artefact on the build machine and record verified identity**

Use official vendor release pages where available. For the third-party Apache Windows binary, verify its Authenticode signature and published checksum before recording it. Store build inputs under ignored `deployment/vendor/`; do not commit redistributable binaries until their licence permits repository storage.

Generate each real digest instead of typing it:

```powershell
$artifact = 'deployment/vendor/node-v22.23.0-win-x64.zip'
$nodeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash.ToLowerInvariant()
if ($nodeSha256.Length -ne 64) { throw 'Node SHA-256 generation failed.' }
```

Write that value into the Node entry together with `name=node`, `version=22.23.0`, `file=node-v22.23.0-win-x64.zip`, and the immutable official release URL. Repeat the same verified process for every version asserted by the test. The contract rejects missing or non-hex digests.

- [ ] **Step 4: Document the immutable/durable layout and exact build prerequisites**

`deployment/README.md` must state:

```text
Supported target: Windows x64 clean installation only.
Build tool: Inno Setup 6.7.3 stable.
Server AppId: {E99DB275-DDA0-43A0-95CD-7AE07185122C}
Spooler AppId: {80657A48-9BCB-4455-8CA9-A18139FDFC58}
Server services: POSAppMariaDB, POSApp, POSAppPhpMyAdmin
Spooler service: POS Print Spooler
Durable data never belongs below Program Files.
```

- [ ] **Step 5: Add package scripts**

```json
{
  "scripts": {
    "test:installer": "vitest run backend/tests/unit/installerPackageContract.test.js",
    "build:installers": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1"
  }
}
```

Preserve all existing scripts.

- [ ] **Step 6: Mark the Prisma/XAMPP decision document superseded**

Add at its top:

```markdown
> **Superseded on 2026-07-27:** The approved fresh-install direction includes private phpMyAdmin and two installers. See [Fresh POS Server and Spooler Installers](./2026-07-27-fresh-pos-server-and-spooler-installers.md). This file is historical and must not guide implementation.
```

- [ ] **Step 7: Run the focused contract test**

Run: `npm run test:installer`

Expected: the vendor/package contract passes; the later not-yet-created test paths may be omitted from the script until their task adds them.

- [ ] **Step 8: Commit**

```powershell
git add package.json deployment/README.md deployment/vendor-lock.json backend/tests/unit/installerPackageContract.test.js docs/superpowers/plans/2026-07-26-deferred-pos-server-installer.md
git commit -m "docs(installer): lock fresh deployment contract"
```

### Task 2: Externalize production configuration and durable paths

**Files:**
- Create: `deployment/templates/pos.env.template`
- Create: `backend/tests/unit/installerConfig.test.js`
- Modify: `server.js`
- Modify: `backend/config/db.js`
- Modify: `backend/config/logger.js`
- Modify: `backend/routes/system.js`
- Modify: `backend/services/printDocumentCompiler.js`
- Modify: `scripts/db-backup.js`

**Interfaces:**
- Consumes: environment variables written from `pos.env.template`.
- Produces: `POSAPP_ENV_FILE`, `POSAPP_DATA_DIR`, `POSAPP_UPLOAD_DIR`, `POSAPP_LOG_DIR`, `POSAPP_BACKUP_DIR`, `MYSQLDUMP_PATH`, and honored `DB_PORT`.

- [ ] **Step 1: Write failing tests for production configuration ownership**

Test these exact contracts:

```js
it('requires production DB credentials and honors DB_PORT', () => {
  const source = read('backend/config/db.js');
  expect(source).toContain('port:');
  expect(source).toContain('DB_PORT');
  expect(source).toContain('NODE_ENV === \'production\'');
});

it('routes mutable files through ProgramData variables', () => {
  expect(read('server.js')).toContain('POSAPP_UPLOAD_DIR');
  expect(read('backend/config/logger.js')).toContain('POSAPP_LOG_DIR');
  expect(read('scripts/db-backup.js')).toContain('POSAPP_BACKUP_DIR');
  expect(read('scripts/db-backup.js')).not.toContain('C:\\\\xampp\\\\mysql');
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npx vitest run backend/tests/unit/installerConfig.test.js`

Expected: FAIL on missing external path handling and ignored `DB_PORT`.

- [ ] **Step 3: Add the production environment template**

The template must contain exactly these installer-replaced tokens:

```dotenv
PORT={{POS_PORT}}
NODE_ENV=production
ENFORCE_HTTPS=false
DB_HOST=127.0.0.1
DB_PORT={{DB_PORT}}
DB_USER=posapp_runtime
DB_PASSWORD={{DB_APP_PASSWORD}}
DB_NAME=posapp
DB_CONNECTION_LIMIT=10
DB_QUEUE_LIMIT=50
SPOOLER_KEY={{SPOOLER_KEY}}
JSON_BODY_LIMIT=1mb
FORM_BODY_LIMIT=1mb
SESSION_IDLE_TIMEOUT_MS=1800000
LOG_LEVEL=info
BACKUP_RETENTION_DAYS=7
POSAPP_DATA_DIR={{DATA_DIR}}
POSAPP_UPLOAD_DIR={{UPLOAD_DIR}}
POSAPP_LOG_DIR={{LOG_DIR}}
POSAPP_BACKUP_DIR={{BACKUP_DIR}}
MYSQLDUMP_PATH={{MARIADB_DUMP_EXE}}
```

- [ ] **Step 4: Load the installer-owned environment before application imports**

At the top of `server.js`, resolve `process.env.POSAPP_ENV_FILE` first and fall back to the repository `.env` only outside installed production. Do not allow an installed production service to silently use empty/default database credentials.

- [ ] **Step 5: Make database and mutable paths explicit**

- Add `port: Number(process.env.DB_PORT || 3306)` to the mysql2 pool.
- Throw a startup configuration error in production when `DB_USER`, `DB_PASSWORD`, or `DB_NAME` is absent.
- Replace repository-relative production upload/log/backup paths with their corresponding environment paths.
- Keep current repository-relative fallbacks for development and tests.
- Use the same resolved upload directory in static serving, brand-icon writes/deletes, and receipt-template logo compilation.

- [ ] **Step 6: Make backup execution XAMPP-independent**

Use `MYSQLDUMP_PATH`; invoke `mariadb-dump` with:

```text
--single-transaction --quick --routines --triggers --events --hex-blob --default-character-set=utf8mb4
```

Keep password out of the visible command string by continuing to use the child environment. Write output below `POSAPP_BACKUP_DIR` and retain checksum/status behavior.

- [ ] **Step 7: Run focused and existing affected tests**

Run:

```powershell
npx vitest run backend/tests/unit/installerConfig.test.js backend/tests/unit/printDocumentCompiler.test.js backend/tests/integration/systemIcon.test.js
```

Expected: PASS.

- [ ] **Step 8: Expand the installer test script now that both unit contracts exist**

Set:

```json
"test:installer": "vitest run backend/tests/unit/installerConfig.test.js backend/tests/unit/installerPackageContract.test.js"
```

- [ ] **Step 9: Commit**

```powershell
git add deployment/templates/pos.env.template server.js backend/config/db.js backend/config/logger.js backend/routes/system.js backend/services/printDocumentCompiler.js scripts/db-backup.js backend/tests/unit/installerConfig.test.js
git commit -m "refactor(runtime): externalize installed POS state"
```

### Task 3: Create and prove the canonical clean database baseline

**Files:**
- Create: `deployment/database/baseline.sql`
- Create: `deployment/database/manifest.json`
- Create: `deployment/tools/bootstrap-database.js`
- Create: `backend/tests/integration/installerBaseline.test.js`

**Interfaces:**
- Consumes: `{ adminUserNumber, adminName, database, appUser, appPassword, maintenanceUser, maintenancePassword }` plus a mysql2 executor with administrative privileges.
- Produces: `bootstrapDatabase(options): Promise<{ baselineVersion: 1, schemaValid: true }>`.

- [ ] **Step 1: Write the disposable-database failing test**

The test must create only the hard-coded database `posapp_installer_test`, reject any other destructive target, execute the baseline, call `validateRequiredSchema`, and assert:

```js
expect(await tableCount(conn)).toBe(44);
expect(await scalar(conn, "SELECT COUNT(*) FROM users WHERE user_number='009384' AND role='admin' AND is_active=1")).toBe(1);
expect(await scalar(conn, 'SELECT COUNT(*) FROM orders')).toBe(0);
expect(await scalar(conn, 'SELECT COUNT(*) FROM products')).toBe(0);
expect(await scalar(conn, 'SELECT COUNT(*) FROM customers')).toBe(0);
expect(await scalar(conn, "SELECT COUNT(*) FROM print_templates WHERE document_type IN ('receipt','kitchen')")).toBe(2);
```

Also assert every guarded migration represented by the baseline has its exact shipped migration name/checksum in `schema_migrations`.

- [ ] **Step 2: Run the baseline test and confirm RED**

Run: `npx vitest run backend/tests/integration/installerBaseline.test.js`

Expected: FAIL because the baseline and bootstrap module do not exist.

- [ ] **Step 3: Generate schema-only SQL from the current verified development schema**

Use the pinned MariaDB client with `--no-data --routines --triggers --events --skip-comments --default-character-set=utf8mb4`. Normalize auto-increment counters and remove environment-specific definers. Review every table against `backend/tests/fixtures/seed.js`, but never copy fixture users/products/orders into production.

- [ ] **Step 4: Add only canonical production seeds**

The baseline may seed:

- Required settings and permissions catalog.
- Required order types.
- Receipt and kitchen `print_templates` rows.
- Exact guarded migration ledger fingerprints already included in the baseline.

The Node bootstrap inserts `009384` using parameters rather than string substitution. `admin_pin` remains `NULL`.

- [ ] **Step 5: Create the future migration manifest**

Generate the baseline digest and write it into `manifest.json`:

```powershell
$baseline = 'deployment/database/baseline.sql'
$baselineSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $baseline).Hash.ToLowerInvariant()
if ($baselineSha256.Length -ne 64) { throw 'Baseline SHA-256 generation failed.' }
```

The saved JSON must have `schemaVersion: 1`, baseline ID `posapp-fresh-baseline-v1`, file `baseline.sql`, the generated 64-character digest, and an empty `migrations` array. The bootstrap rejects a digest mismatch before executing SQL.

- [ ] **Step 6: Implement minimal bootstrap behavior**

`bootstrapDatabase` must:

1. Validate identifiers against `/^[A-Za-z0-9_]+$/`.
2. Verify baseline checksum.
3. Create `posapp` with `utf8mb4`.
4. Import the baseline as a whole.
5. Create `posapp_runtime` with only the application privileges required on `posapp.*`.
6. Create `posapp_maintenance` with full rights on `posapp.*` and no global/remote rights.
7. Insert administrator `009384` only when the users table is empty.
8. Run `validateRequiredSchema`.
9. Return the baseline version and validation status.

Use one administrative connection and close it in `finally`. Do not add a migration framework.

- [ ] **Step 7: Run the disposable baseline test twice**

Run the same test twice. Expected: both runs PASS and the second run creates no duplicate seed rows.

- [ ] **Step 8: Expand the installer test script with the proven baseline test**

Set:

```json
"test:installer": "vitest run backend/tests/unit/installerConfig.test.js backend/tests/unit/installerPackageContract.test.js backend/tests/integration/installerBaseline.test.js"
```

- [ ] **Step 9: Commit**

```powershell
git add package.json deployment/database deployment/tools/bootstrap-database.js backend/tests/integration/installerBaseline.test.js
git commit -m "feat(installer): add authoritative clean database baseline"
```

### Task 4: Build allowlisted production payloads and release identity

**Files:**
- Create: `scripts/build-installers.ps1`
- Modify: `package.json`
- Modify: `server.js`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Produces: `deployment/out/stage/server`, `deployment/out/stage/spooler`, and immutable `release.json` in each payload.
- Produces: health payload fields `release.version`, `release.commit`, `release.schemaVersion`.

- [ ] **Step 1: Extend the failing package contract**

Assert the staging script contains an explicit allowlist and that a staged dry run excludes:

```text
.git, .env, .env.test, docs, backend/tests, tests, skills, node_modules dev dependencies,
*.map, *.7z, *.zip, playwright-report, test-results
```

- [ ] **Step 2: Run the package contract and confirm RED**

Run: `npx vitest run backend/tests/unit/installerPackageContract.test.js`

- [ ] **Step 3: Implement clean staging**

`scripts/build-installers.ps1` must:

1. Require a clean target staging directory below `deployment/out`.
2. Verify every vendor file against `vendor-lock.json` before use.
3. Run `npm ci` and `npm run build` on the build machine.
4. Copy only `server.js`, `backend` excluding tests/fixtures/migration appliers, `dist`, required static assets, production `package.json/package-lock.json`, and production dependencies.
5. Stage the tracked spooler excluding tests, `.env`, logs, certificates, archives, and development state.
6. Run `npm ci --omit=dev` in isolated stage directories.
7. Install Puppeteer Chrome into the staged spooler's packaged browser cache at build time.
8. Copy the private Node runtime into both payloads.
9. Write `release.json` with version, Git commit, build timestamp, schema baseline, spooler version, and payload checksum manifest.
10. Invoke Inno Setup only after stage verification passes.

- [ ] **Step 4: Expose release identity without secrets**

Load `release.json` once at startup. Add it to `/health` and `/api/health` responses under `release`; never expose installation paths, database credentials, or spooler keys.

- [ ] **Step 5: Run package contract and build dry run**

Run:

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-installers.ps1 -StageOnly
```

Expected: contract PASS; both stage directories exist; forbidden files scan returns zero.

- [ ] **Step 6: Commit**

```powershell
git add scripts/build-installers.ps1 package.json server.js backend/tests/unit/installerPackageContract.test.js
git commit -m "build(installer): stage production-only release payloads"
```

### Task 5: Implement port validation, secret generation, and configuration rendering

**Files:**
- Create: `deployment/tools/installer-config.js`
- Create: `deployment/templates/spooler.env.template`
- Create: `deployment/templates/httpd.conf.template`
- Create: `deployment/templates/php.ini.template`
- Create: `deployment/templates/config.inc.php.template`
- Modify: `backend/tests/unit/installerConfig.test.js`

**Interfaces:**
- Produces: `validatePort(value): number`.
- Produces: `suggestAvailablePort(preferred, isAvailable): Promise<number>`.
- Produces: `generateSecret(bytes = 32): string`.
- Produces: `renderTemplate(template, values): string`, which rejects unresolved `{{TOKEN}}` values.
- Produces CLI commands `check-port`, `suggest-port`, `write-server-config`, and `write-spooler-config`.

- [ ] **Step 1: Write failing behavioral tests**

Cover:

```js
expect(validatePort('3000')).toBe(3000);
expect(() => validatePort('0')).toThrow();
expect(() => validatePort('65536')).toThrow();
expect(await suggestAvailablePort(3000, p => p !== 3000)).toBe(3001);
expect(generateSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(() => renderTemplate('x={{MISSING}}', {})).toThrow(/MISSING/);
```

Add a real socket test that listens on an ephemeral loopback port and confirms `check-port` reports it occupied without stopping it.

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npx vitest run backend/tests/unit/installerConfig.test.js`

- [ ] **Step 3: Implement the minimal configuration CLI**

Use Node standard library only: `net`, `crypto`, `fs`, and `path`. Atomic configuration writes use a sibling temporary file followed by `rename`. Create directories before writing and never log rendered secrets.

- [ ] **Step 4: Define exact private web-tool templates**

- Apache: `Listen 127.0.0.1:{{PHPMYADMIN_PORT}}`, deny directory listing, serve only phpMyAdmin, and write logs to `{{LOG_DIR}}`.
- PHP: enable only extensions required by phpMyAdmin, set session directory below ProgramData, disable `display_errors`, and cap uploads to a documented database-import size.
- phpMyAdmin: cookie authentication, random 32-byte blowfish secret, `127.0.0.1`, selected DB port, and no stored database username/password.
- Spooler: require `CLOUD_SERVER_URL`, `SPOOLER_KEY`, `SPOOLER_ID`, `SPOOLER_NAME`, and `SPOOLER_STATE_DIR`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run backend/tests/unit/installerConfig.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add deployment/tools/installer-config.js deployment/templates backend/tests/unit/installerConfig.test.js
git commit -m "feat(installer): render validated machine configuration"
```

### Task 6: Install and verify the fresh POS server stack

**Files:**
- Create: `deployment/windows/Install-PosServer.ps1`
- Create: `deployment/tools/verify-install.js`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Consumes parameters: `RestaurantName`, `PosPort`, `DatabasePort`, `PhpMyAdminPort`, `InstallLocalSpooler`, and staged payload paths.
- Produces: exit `0` only after MariaDB, database bootstrap, Apache/phpMyAdmin, POS service, firewall, backup task, and HTTP verification succeed.

- [ ] **Step 1: Add failing static orchestration assertions**

Assert the script uses exact service names, checks port availability before mutation, checks every native process exit code, writes a transcript below ProgramData logs, and has a catch block that removes only resources created during the failed attempt.

- [ ] **Step 2: Run the contract and confirm RED**

Run: `npx vitest run backend/tests/unit/installerPackageContract.test.js`

- [ ] **Step 3: Implement fail-fast installation orchestration**

The script must execute in this order:

1. Start transcript logging with secret redaction discipline.
2. Recheck all three ports by attempting loopback binds.
3. Create Program Files and ProgramData directories.
4. Apply Windows ACLs: Administrators/SYSTEM full control; Users read/execute on app binaries; no ordinary-user access to config maintenance credentials.
5. Install MariaDB MSI silently with service `POSAppMariaDB`, selected port, ProgramData data directory, remote root disabled, anonymous account disabled, and HeidiSQL/development components excluded.
6. Force MariaDB `bind-address=127.0.0.1` and restart the service.
7. Run `bootstrap-database.js` using a temporary ACL-protected option file; remove the temporary root credential file after restricted accounts and permanent maintenance configuration are created.
8. Render/install Apache, PHP, and phpMyAdmin; register Apache service as `POSAppPhpMyAdmin` bound to loopback.
9. Install POS through bundled NSSM as service `POSApp`, using private `node.exe`, `server.js`, application directory, `NODE_ENV=production`, and `POSAPP_ENV_FILE`.
10. Set `POSAppMariaDB`, `POSAppPhpMyAdmin`, and `POSApp` to automatic startup; set `POSApp` dependency on `POSAppMariaDB`; configure NSSM to restart POS after unexpected exits without requiring a logged-in user.
11. Add one inbound TCP firewall rule for selected POS port on `Private` profile only.
12. Register daily `POSApp Database Backup` task using private Node and the installed backup script.
13. Run `verify-install.js`.
14. Write `install.json` without secrets; create an all-users desktop `POS App` shortcut whose URL is assembled as `http://localhost:` + selected POS port + `/pos`, an all-users Start Menu POS shortcut, and a local-only phpMyAdmin Start Menu shortcut.
15. Show the generated `posapp_maintenance` password and shared spooler key once on the completion page; retain them only in their Administrators/SYSTEM-readable configuration files.

- [ ] **Step 4: Implement verification gates**

`verify-install.js` must fail unless:

- MariaDB responds on selected loopback port.
- `validateRequiredSchema` passes.
- Exactly one active `009384` administrator exists.
- `/health` reports connected DB and expected release identity.
- phpMyAdmin returns HTTP success only on loopback.
- Required durable directories are writable by their services.
- A database backup can be created, decompressed, and its checksum verified.

- [ ] **Step 5: Run static contract and PowerShell parser checks**

Run:

```powershell
npx vitest run backend/tests/unit/installerPackageContract.test.js
$null = [scriptblock]::Create((Get-Content -Raw deployment/windows/Install-PosServer.ps1))
node --check deployment/tools/verify-install.js
```

Expected: PASS/no parser exception.

- [ ] **Step 6: Commit**

```powershell
git add deployment/windows/Install-PosServer.ps1 deployment/tools/verify-install.js backend/tests/unit/installerPackageContract.test.js
git commit -m "feat(installer): provision fresh POS server stack"
```

### Task 7: Make the tracked spooler externally configurable and installable offline

**Files:**
- Create: `deployment/windows/Install-Spooler.ps1`
- Create: `pos-spooler-printer/tests/external-config.test.js`
- Modify: `pos-spooler-printer/server.js`
- Modify: `pos-spooler-printer/install-service.js`
- Modify: `pos-spooler-printer/README.md`

**Interfaces:**
- Consumes: `ServerUrl`, `SpoolerKey`, `SpoolerId`, `SpoolerName`, staged runtime/browser paths.
- Produces: Windows service `POS Print Spooler` and durable config/state below ProgramData.

- [ ] **Step 1: Write failing spooler external-config tests**

Assert:

- `SPOOLER_ENV_FILE` overrides the source-directory `.env`.
- Production startup refuses a missing `CLOUD_SERVER_URL` or `SPOOLER_KEY`.
- `SPOOLER_STATE_DIR` resolves to ProgramData during installed execution.
- Service installation uses the bundled private Node executable and configured log paths.
- No production fallback points at `posjo.triple7foodmasters.com`.

- [ ] **Step 2: Run spooler tests and confirm RED**

Run: `node pos-spooler-printer/tests/external-config.test.js`

- [ ] **Step 3: Implement external config loading and fail-closed production startup**

Preserve repository `.env` loading for development. Installed services set `SPOOLER_ENV_FILE=C:\ProgramData\POS-Spooler\config\spooler.env`; production must reject missing URL/key before opening sockets or processing jobs.

- [ ] **Step 4: Implement standalone spooler orchestration**

`Install-Spooler.ps1` must:

1. Validate the POS URL as `http://host:port` or `https://host:port`.
2. Verify `/health` and the expected POS release shape before installation.
3. Validate non-empty stable station ID/name and shared key.
4. Copy only staged spooler binaries, private Node runtime, production dependencies, and packaged Chrome.
5. Preserve an existing ProgramData config/state directory during repair.
6. Render `spooler.env` atomically.
7. Install/start `POS Print Spooler` through the existing node-windows service owner adjusted for private paths; require automatic startup before user login and restart-on-failure behavior.
8. Verify its reported version/station in server spooler status before returning success.

Do not add automatic LAN discovery or a new server pairing endpoint.

- [ ] **Step 5: Run full spooler tests**

Run:

```powershell
Set-Location pos-spooler-printer
npm test
Set-Location ..
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add deployment/windows/Install-Spooler.ps1 pos-spooler-printer
git commit -m "feat(spooler): support standalone offline installation"
```

### Task 8: Build the standalone spooler installer wizard

**Files:**
- Create: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Consumes: staged spooler payload and `Install-Spooler.ps1`.
- Produces: `deployment/out/POSAPP-Spooler-Setup.exe`.

- [ ] **Step 1: Add failing Inno contract assertions**

Assert stable AppId, admin privileges, x64-only mode, Program Files destination, ProgramData preservation, required station fields, service stop-before-replace behavior, and no bundled POS/database/phpMyAdmin payload.

- [ ] **Step 2: Run the package contract and confirm RED**

Run: `npx vitest run backend/tests/unit/installerPackageContract.test.js`

- [ ] **Step 3: Implement the minimal spooler wizard**

Pages:

1. POS server URL.
2. Shared spooler key.
3. Unique station ID and friendly name.
4. Receipt/kitchen beep preferences.
5. Ready/install/result.

The wizard calls the PowerShell installer with sensitive values delivered through an ACL-protected temporary configuration file, not visible command-line arguments. Always delete that file after success or failure.

- [ ] **Step 4: Implement repair-safe uninstall behavior**

Normal uninstall removes the service and Program Files payload but retains `C:\ProgramData\POS-Spooler\config` and `state`. Display the retained path at completion.

- [ ] **Step 5: Compile and inspect**

Run:

```powershell
& "$env:ProgramFiles(x86)\Inno Setup 6\ISCC.exe" deployment/spooler/POSAPP-Spooler.iss
Get-AuthenticodeSignature deployment/out/POSAPP-Spooler-Setup.exe
```

Expected: compilation succeeds. During development, signature may be `NotSigned`; production release requires the project signing certificate.

- [ ] **Step 6: Commit**

```powershell
git add deployment/spooler/POSAPP-Spooler.iss backend/tests/unit/installerPackageContract.test.js
git commit -m "feat(installer): package standalone POS spooler"
```

### Task 9: Build the fresh POS server installer wizard

**Files:**
- Create: `deployment/server/POSAPP-Server.iss`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Consumes: staged server payload, vendor packages, `Install-PosServer.ps1`, and standalone spooler installer.
- Produces: `deployment/out/POSAPP-Server-Setup.exe`.

- [ ] **Step 1: Add failing server-wizard contract assertions**

Assert stable AppId, admin/x64 requirements, three port defaults, editable conflict resolution, restaurant name, optional local-spooler task, Private-profile firewall language, and no legacy-upgrade controls.

Also assert an all-users desktop icon named `POS App` targets the selected runtime URL rather than hard-coding port `3000`.

- [ ] **Step 2: Run contract and confirm RED**

Run: `npx vitest run backend/tests/unit/installerPackageContract.test.js`

- [ ] **Step 3: Implement the installer pages**

Wizard flow:

```text
Welcome
→ Restaurant name
→ Components: server (fixed), phpMyAdmin (fixed), local spooler (optional)
→ Ports (hidden when all defaults are available; shown automatically on conflict; Advanced button always opens it)
→ Ready summary with localhost and LAN ownership
→ Install
→ Verified result and shortcuts
```

For each occupied default, show the owner PID/process when Windows reports it, suggest the next free port, allow editing, and validate `1..65535` with no duplicates. Recheck immediately before calling `Install-PosServer.ps1`.

- [ ] **Step 4: Pass secrets through a protected response file**

Inno generates installer inputs in `{tmp}`, applies an ACL limited to Administrators/SYSTEM/current elevated user, invokes PowerShell, and deletes the file in `finally`. Do not put generated DB/spooler secrets into the Inno log.

- [ ] **Step 5: Invoke the exact standalone spooler package when selected**

After server health succeeds, run `POSAPP-Spooler-Setup.exe` with the local server URL and an installer-owned protected response file. Do not duplicate spooler service logic inside the server installer.

- [ ] **Step 6: Compile both installers**

Run: `npm run build:installers`

Expected:

```text
deployment/out/POSAPP-Server-Setup.exe
deployment/out/POSAPP-Spooler-Setup.exe
```

Both artefacts must have SHA-256 sidecar files.

- [ ] **Step 7: Verify generated shortcuts use the selected port**

Inspect the server installer script and compiled-install result. With POS port `3017`, the desktop shortcut must resolve exactly to `http://localhost:3017/pos`; phpMyAdmin remains a separate local-only Start Menu shortcut.

- [ ] **Step 8: Commit**

```powershell
git add deployment/server/POSAPP-Server.iss backend/tests/unit/installerPackageContract.test.js
git commit -m "feat(installer): package fresh POS server"
```

### Task 10: Add safe uninstall and repair ownership

**Files:**
- Create: `deployment/windows/Remove-PosRuntime.ps1`
- Create: `deployment/windows/Remove-SpoolerRuntime.ps1`
- Modify: `deployment/server/POSAPP-Server.iss`
- Modify: `deployment/spooler/POSAPP-Spooler.iss`
- Modify: `backend/tests/unit/installerPackageContract.test.js`

**Interfaces:**
- Produces runtime removal without deleting business data.
- Preserves exact durable roots consumed by a future repair/updater.

- [ ] **Step 1: Add failing preservation tests**

The contract must reject uninstall scripts containing recursive removal of:

```text
C:\ProgramData\POSApp\database
C:\ProgramData\POSApp\uploads
C:\ProgramData\POSApp\backups
C:\ProgramData\POS-Spooler\state
C:\ProgramData\POS-Spooler\config
```

- [ ] **Step 2: Run contract and confirm RED**

- [ ] **Step 3: Implement runtime-only removal**

Server removal stops/removes `POSApp` and `POSAppPhpMyAdmin`, removes the POS firewall rule and scheduled backup task, and removes immutable application/web-tool files. It leaves MariaDB service/data and all durable POS directories intact and prints their locations.

Spooler removal stops/removes `POS Print Spooler` and immutable spooler files, retaining config/state.

- [ ] **Step 4: Implement repair behavior using the same AppIds**

Running the same installer version again may repair missing immutable files and services. It must read existing `install.json`/spooler config rather than generating new secrets or reseeding the database. This is repair behavior only—not a general application updater.

- [ ] **Step 5: Run package contracts**

Run: `npm run test:installer`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add deployment/windows/Remove-PosRuntime.ps1 deployment/windows/Remove-SpoolerRuntime.ps1 deployment/server/POSAPP-Server.iss deployment/spooler/POSAPP-Spooler.iss backend/tests/unit/installerPackageContract.test.js
git commit -m "feat(installer): preserve durable state on repair and removal"
```

### Task 11: Execute automated clean-Windows acceptance

**Files:**
- Create: `tests/installer/fresh-install-smoke.ps1`
- Modify: `deployment/README.md`

**Interfaces:**
- Consumes: both compiled installer EXEs and a clean Windows x64 VM snapshot.
- Produces: timestamped acceptance transcript and machine-readable results below `tests/installer/results` (ignored by Git).

- [ ] **Step 1: Write smoke assertions before running the installer**

The script must fail unless it can verify:

- All expected services are running and configured for automatic start.
- `POSApp` depends on `POSAppMariaDB`; POS and spooler recovery actions restart them after an unexpected exit.
- MariaDB listens only on loopback and the selected DB port.
- phpMyAdmin listens only on loopback and the selected web-tools port.
- POS listens on the selected LAN port.
- Only the POS Private-profile firewall rule exists.
- `009384` logs in and `/health` reports the packaged release.
- Database contains canonical seeds and zero orders/products/customers.
- A backup and checksum are created.
- Reboot returns every service to healthy state.
- The all-users desktop `POS App` shortcut exists and opens `/pos` on the selected POS port.
- A second browser machine on the LAN can open the POS.

- [ ] **Step 2: Run default-port installation on a clean VM**

Expected: unattended payload installation completes, verification passes, reboot passes.

- [ ] **Step 3: Run conflict-port installation on a reverted clean VM**

Occupy `3000`, `3306`, and `8081` with harmless listeners. Confirm the wizard reports conflicts, proposes available ports, does not stop the listeners, applies selected alternatives consistently, and passes all verification.

- [ ] **Step 4: Run failure rollback on a reverted clean VM**

Force database bootstrap failure with a deliberately corrupted baseline in a non-release test build. Confirm POS/phpMyAdmin services do not remain running, the firewall rule is absent, logs identify the failed stage, and no seeded business database is presented as successful.

- [ ] **Step 5: Run standalone Terminal B spooler installation**

On a second Windows VM:

1. Open POS through Terminal A's LAN URL.
2. Install only `POSAPP-Spooler-Setup.exe`.
3. Confirm no POS, MariaDB, Apache, or phpMyAdmin service was installed.
4. Confirm station/version appears on the server.
5. Confirm durable state survives spooler repair.

- [ ] **Step 6: Commit acceptance automation and evidence instructions**

```powershell
git add tests/installer/fresh-install-smoke.ps1 deployment/README.md
git commit -m "test(installer): automate clean Windows acceptance"
```

### Task 12: Complete physical restaurant workflow acceptance

**Files:**
- Modify: `deployment/README.md`
- Modify: `docs/printing-runbook.md`

**Interfaces:**
- Produces: signed release acceptance checklist for the exact installer SHA-256 values.

- [ ] **Step 1: Record the installer hashes and target-machine facts**

Record Windows build, installer hashes, MariaDB/Node/PHP/Apache/phpMyAdmin versions, selected ports, printer models, and service versions.

- [ ] **Step 2: Test real selling workflows**

Complete on the installed system:

- Login `009384`.
- Configure restaurant settings and store logo.
- Create categories/products/modifiers/bundles.
- Open/close shift.
- Cash sale, card sale, and split-tender sale.
- Hold/recall order.
- Open/save/transfer/split/settle table workflows.
- Refund and printed-table void.
- Subscription sale/redemption if enabled.
- JoFotara disabled-state operation, then configured sandbox/test submission where credentials permit.
- X/Z/category/Y reports through the spooler.

- [ ] **Step 3: Test physical customer and kitchen printing**

- Local server-attached printer.
- Terminal B-attached printer through standalone spooler.
- Customer receipt and kitchen ticket.
- Kitchen void ticket.
- Arabic/multiline notes.
- Activated custom receipt/kitchen template.
- USB disconnect/reconnect and durable queue recovery.
- Internet disconnected while LAN remains connected.

- [ ] **Step 4: Test backup restore on a separate clean database instance**

Restore the generated backup, run schema validation, compare core table row counts and financial totals, and confirm the restored database is not substituted into production during the test.

- [ ] **Step 5: Run final scoped verification**

Run:

```powershell
npm run test:installer
npm run build
Set-Location pos-spooler-printer
npm test
Set-Location ..
```

Expected: all pass. Keep the wider application suite decision proportional to any application-runtime changes made during execution.

- [ ] **Step 6: Commit release documentation**

```powershell
git add deployment/README.md docs/printing-runbook.md
git commit -m "docs(installer): record fresh deployment acceptance"
```

## Final Release Gate

Do not call the installer restaurant-ready until all are true:

- Both EXEs install without internet on clean Windows x64.
- Default and conflict-port scenarios pass.
- Baseline restore and current schema validation pass.
- Only `009384` and canonical non-business seeds exist initially.
- MariaDB/phpMyAdmin are loopback-only and only POS has a Private-profile LAN firewall rule.
- Server-local and Terminal B standalone spoolers print real customer/kitchen tickets.
- Reboot, repair, failure rollback, backup creation, and separate restore verification pass.
- Production packages contain no repository metadata, secrets, source maps, tests, fixtures, plans, or development dependencies.
- Installer hashes and acceptance evidence are recorded against the release commit.

## Deferred Follow-Up Projects

These are intentionally not implementation tasks in this plan:

1. Read-only legacy restaurant inventory collector.
2. Evidence-driven XAMPP/database upgrader.
3. POS binary updater using `release.json` and preserved ProgramData.
4. Standalone spooler updater preserving station config/state.
5. Optional stronger licensing or machine binding if the practical threat model changes.

## Self-Review Result

- Scope coverage: server installer, standalone spooler, optional local spooler, phpMyAdmin, configurable ports, canonical database, `009384`, backups, services, shortcuts, durable paths, casual-copy resistance, offline installation, rollback, and physical acceptance are each mapped to tasks.
- Scope exclusions: no legacy migration, updater, DRM, Prisma, XAMPP, ORM, or LAN discovery work is hidden inside the plan.
- Placeholder scan: runtime files reject unresolved template tokens and unverified checksums; execution steps explicitly replace build-time digest markers before commit.
- Interface consistency: service names, ports, durable paths, environment keys, release metadata, and installer AppIds remain identical across tasks.
