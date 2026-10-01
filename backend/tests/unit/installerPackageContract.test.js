import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { computeSpoolerPayloadHash, stampSpoolerPayload, validatePayload, REQUIRED_PATHS } from '../../../deployment/tools/validate-payload.js';

const ROOT = path.resolve(__dirname, '../../..');

describe('fresh installer package contract', () => {
    it('bumps server and spooler patch identities atomically', () => {
        const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-version-bump-'));
        const writeJson = (relative, value) => {
            const target = path.join(fixture, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
        };
        writeJson('package.json', { name: 'posapp', version: '1.0.5' });
        writeJson('package-lock.json', { name: 'posapp', version: '1.0.5', packages: { '': { name: 'posapp', version: '1.0.5' } } });
        writeJson('pos-spooler-printer/package.json', { name: 'pos-spooler', version: '1.2.5' });
        writeJson('pos-spooler-printer/package-lock.json', { name: 'pos-spooler', version: '1.2.5', packages: { '': { name: 'pos-spooler', version: '1.2.5' } } });
        fs.mkdirSync(path.join(fixture, 'deployment/server'), { recursive: true });
        fs.mkdirSync(path.join(fixture, 'deployment/spooler'), { recursive: true });
        fs.writeFileSync(path.join(fixture, 'deployment/server/POSAPP-Server.iss'), '#define AppVersion "1.0.5"\n');
        fs.writeFileSync(path.join(fixture, 'deployment/spooler/POSAPP-Spooler.iss'), '#define AppVersion "1.2.5"\n');

        const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/bump-installer-versions.js'), '--root', fixture], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({ serverVersion: '1.0.6', spoolerVersion: '1.2.6' });
        expect(JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8')).version).toBe('1.0.6');
        expect(JSON.parse(fs.readFileSync(path.join(fixture, 'package-lock.json'), 'utf8')).packages[''].version).toBe('1.0.6');
        expect(JSON.parse(fs.readFileSync(path.join(fixture, 'pos-spooler-printer/package-lock.json'), 'utf8')).packages[''].version).toBe('1.2.6');
        expect(fs.readFileSync(path.join(fixture, 'deployment/server/POSAPP-Server.iss'), 'utf8')).toContain('#define AppVersion "1.0.6"');
        expect(fs.readFileSync(path.join(fixture, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8')).toContain('#define AppVersion "1.2.6"');
    });

    it('auto-commits one exact release identity only for compiled builds', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        for (const token of [
            'SkipVersionBump', 'bump-installer-versions.js', 'pending-installer-release.json',
            'chore(release): bump server to', 'git.exe', 'restore',
        ]) expect(build).toContain(token);
        expect(build).toContain('if (-not $StageOnly -and -not $SkipVersionBump');
        expect(build).toContain('Remove-Item -LiteralPath $pendingReleasePath -Force');
        expect(build.indexOf('bump-installer-versions.js')).toBeLessThan(build.indexOf("git -C $repo status --porcelain"));
        expect(build).not.toContain('--untracked-files=no');
        expect(build).toContain('$dependencyReuseRoot');
        expect(build).toContain("Move-Item -LiteralPath (Join-Path $serverStage 'node_modules')");
        expect(build).toContain("Move-Item -LiteralPath (Join-Path $spoolerStage '.cache')");
        expect(build).toContain('Remove-Item -Recurse -Force $stage');
        expect(fs.readFileSync(path.join(ROOT, 'scripts/build-baseline-installers.ps1'), 'utf8')).toContain("'-SkipVersionBump'");
    });

    it('pins the current server and spooler delivery identities', () => {
        const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const rootLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
        const spoolerPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'pos-spooler-printer/package.json'), 'utf8'));
        const serverInstaller = fs.readFileSync(path.join(ROOT, 'deployment/server/POSAPP-Server.iss'), 'utf8');
        const spoolerInstaller = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');

        const spoolerLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'pos-spooler-printer/package-lock.json'), 'utf8'));
        expect(rootPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(rootLock.version).toBe(rootPackage.version);
        expect(rootLock.packages[''].version).toBe(rootPackage.version);
        expect(serverInstaller).toContain(`#define AppVersion "${rootPackage.version}"`);
        expect(spoolerPackage.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(spoolerLock.version).toBe(spoolerPackage.version);
        expect(spoolerLock.packages[''].version).toBe(spoolerPackage.version);
        expect(spoolerInstaller).toContain(`#define AppVersion "${spoolerPackage.version}"`);
    });

    function createMinimalPayload(kind) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `pos-${kind}-`));
        for (const relative of REQUIRED_PATHS[kind]) {
            const target = path.join(root, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            let contents = 'fixture';
            if (relative === 'release.json') {
                contents = JSON.stringify({ version: '1.0.0', commit: 'a'.repeat(40), schemaVersion: 'posapp-fresh-baseline-v1', spoolerVersion: '1.2.0', ...(kind.startsWith('spooler') ? { runtimeProfile: 'typst-only' } : {}) });
            } else if (relative === 'backend/migrations/auto-manifest.json') {
                contents = JSON.stringify({ migrations: [] });
            }
            fs.writeFileSync(target, contents);
        }
        if (kind === 'spooler') stampSpoolerPayload(root, kind);
        return root;
    }

    it('requires pinned Typst without any bundled browser', () => {
        for (const [kind, paths] of Object.entries(REQUIRED_PATHS)) {
            if (!kind.startsWith('spooler')) continue;
            expect(paths).not.toContain('.cache/puppeteer');
            expect(paths).not.toContain('.puppeteerrc.cjs');
            if (kind !== 'spooler-update-core') expect(paths).toContain('.cache/typst/0.15.1/typst.exe');
        }
    });

    it('stages only the Typst runtime profile', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        expect(build).toContain("$runtimeProfile = 'typst-only'");
        expect(build).not.toContain('puppeteer/install.mjs');
        expect(build).toContain('Missing spooler application root');
        expect(REQUIRED_PATHS.spooler).toContain('.cache/typst/0.15.1/typst.exe');
    });

    it('builds only Typst spooler installers with no Chromium runtime dependency', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        const installer = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');
        const spoolerPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'pos-spooler-printer/package.json'), 'utf8'));
        expect(build).not.toContain("[ValidateSet('Full', 'TypstOnly')]");
        expect(build).toContain("runtimeProfile = $runtimeProfile");
        expect(build).toContain('$spoolerDefines = @()');
        for (const argumentsVariable of ['$spoolerSetupArguments', '$spoolerUpdateArguments', '$spoolerRuntimeArguments']) {
            expect(build).toContain(`Invoke-Native $iscc ${argumentsVariable}`);
        }
        expect(build).not.toMatch(/Invoke-Native \$iscc @\(\$spoolerDefines \+/);
        for (const artifact of [
            'POSAPP-Spooler-Typst-Only-Setup.exe',
            'POSAPP-Spooler-Typst-Only-Update.exe',
            'POSAPP-Spooler-Typst-Only-Runtime-Update.exe'
        ]) expect(`${build}\n${installer}`).toContain(artifact);
        expect(spoolerPackage.optionalDependencies?.puppeteer).toBeUndefined();
        expect(spoolerPackage.dependencies).not.toHaveProperty('puppeteer');
        const spoolerLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'pos-spooler-printer/package-lock.json'), 'utf8'));
        expect(Object.keys(spoolerLock.packages)).not.toContain('node_modules/puppeteer');
        expect(Object.keys(spoolerLock.packages)).not.toContain('node_modules/puppeteer-core');
        const gate = fs.readFileSync(path.join(ROOT, '.github/workflows/release-gate.yml'), 'utf8');
        const spoolerJob = gate.split(/^  spooler:/m)[1].split(/^  release-gate:/m)[0];
        expect(spoolerJob).toContain('scripts/setup-spooler-typst.ps1');
        expect(spoolerJob).not.toContain('setup-browser');
        const setup = fs.readFileSync(path.join(ROOT, 'scripts/setup-spooler-typst.ps1'), 'utf8');
        expect(setup).toContain('deployment/vendor-lock.json');
        expect(setup).toContain('Get-FileHash');
        expect(setup).toContain('patch-typst-fast-watch.js');
    });

    it('validates Typst-only payloads and rejects any Chromium residue', () => {
        const root = createMinimalPayload('spooler');
        try {
            const releasePath = path.join(root, 'release.json');
            const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
            release.runtimeProfile = 'typst-only';
            fs.writeFileSync(releasePath, JSON.stringify(release));
            stampSpoolerPayload(root, 'spooler');
            expect(validatePayload(root, 'spooler')).toMatchObject({ runtimeProfile: 'typst-only' });

            const forbidden = path.join(root, 'node_modules/puppeteer-core/index.js');
            fs.mkdirSync(path.dirname(forbidden), { recursive: true });
            fs.writeFileSync(forbidden, 'forbidden');
            stampSpoolerPayload(root, 'spooler');
            expect(() => validatePayload(root, 'spooler')).toThrow(/Forbidden Chromium file/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    // The spooler update layers copy from an explicit list in the build script, verbatim.
    // Entry points get added to it; the modules they require do not always follow. That is
    // not hypothetical - sharing one raw-print path between beep-tester and
    // print-width-calibration shipped both of them broken in the update payloads, because
    // raw-print.js was never added to the list. MODULE_NOT_FOUND at the moment somebody
    // reaches for a diagnostic on a till, which is the worst possible moment.
    //
    // So resolve it rather than maintaining it by hand: every local require of every staged
    // root-level module must itself be staged.
    it('stages every root-level module that a staged spooler module requires', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        const block = build.match(/\$spoolerApplicationRoots = @\(([\s\S]*?)\)/);
        expect(block, 'spoolerApplicationRoots list not found in the build script').toBeTruthy();
        const staged = new Set([...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]));

        const packageRoot = path.join(ROOT, 'pos-spooler-printer');
        const missing = [];
        for (const name of staged) {
            if (!/\.(js|cjs)$/.test(name)) continue;
            const file = path.join(packageRoot, name);
            if (!fs.existsSync(file)) continue;
            const source = fs.readFileSync(file, 'utf8');
            for (const match of source.matchAll(/require\('\.\/([^']+)'\)/g)) {
                const target = match[1];
                // Directory roots (v2/...) are staged whole; only root-level files matter.
                if (target.includes('/')) continue;
                const candidates = [target, `${target}.js`, `${target}.cjs`];
                if (!candidates.some(c => staged.has(c))) missing.push(`${name} requires ./${target}`);
            }
        }
        expect(missing, `unstaged local dependencies: ${missing.join(', ')}`).toEqual([]);
    });

    // Two hand-maintained copies of the same list: the build script's decides what is
    // copied into a spooler layer, the manifest tool's decides what the layer declares, and
    // validate-payload rejects any staged file the manifest omits. They must be identical.
    // Adding raw-print.js and print-width-calibration.js to one and not the other failed
    // the build with 'Unlisted core spooler application file' - true, but it names a file
    // rather than the drift. Compare them here so the mismatch is reported as what it is.
    it('keeps the build staging list and the spooler payload roots identical', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        const block = build.match(/\$spoolerApplicationRoots = @\(([\s\S]*?)\)/);
        expect(block).toBeTruthy();
        const staged = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();

        const { APPLICATION_ROOTS } = require('../../../deployment/tools/spooler-layer-manifest.js');
        const declared = [...APPLICATION_ROOTS].sort();

        expect(declared, 'spooler payload roots differ from the build staging list').toEqual(staged);

        // Update-Spooler.ps1 hardcoded its own third copy when the layer manifest was
        // removed. Before that it derived the copy list from the same source, so drift
        // was impossible; now nothing keeps them together. A root added to the other two
        // ships in the payload and lands on fresh installs, but Copy-OwnedApplication
        // never copies it - so updated tills keep the old tree and die on require().
        const updater = fs.readFileSync(path.join(ROOT, 'deployment/windows/Update-Spooler.ps1'), 'utf8');
        const updaterBlock = updater.match(/\$applicationRoots = @\(([\s\S]*?)\)/);
        expect(updaterBlock, 'Update-Spooler.ps1 must declare $applicationRoots').toBeTruthy();
        const copied = [...updaterBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
        expect(copied, 'the updater copies a different set of roots than the payload ships').toEqual(staged);
    });

    it('keeps server and spooler installers independent', () => {
        const serverInstaller = fs.readFileSync(path.join(ROOT, 'deployment/server/POSAPP-Server.iss'), 'utf8');
        const serverProvisioning = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        const spoolerInstaller = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');

        for (const token of ['localspooler', 'spooler-payload', 'Install-Spooler.ps1', 'InstallLocalSpooler']) {
            expect(serverInstaller).not.toContain(token);
            expect(serverProvisioning).not.toContain(token);
        }
        expect(spoolerInstaller).toContain('Install-Spooler.ps1');
        expect(spoolerInstaller).toContain('POSAPP-Spooler-Typst-Only-Setup');
    });

    it('keeps the Node ZIP as a build-only input and stages only approved server vendors', () => {
        const buildScript = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        expect(REQUIRED_PATHS.server).not.toContain('install/vendor/node-v22.23.0-win-x64.zip');
        expect(buildScript).toContain('$serverVendorPackageNames');
        for (const packageName of ['apache', 'php', 'phpmyadmin', 'nssm', 'vc-redist']) {
            expect(buildScript).toContain(`'${packageName}'`);
        }
        expect(buildScript).toContain('ServerInstallerMaxBytes');
        expect(buildScript).toContain('220MB');
        expect(buildScript).toContain("'POSAPP-Spooler-Typst-Only-Setup.exe'; MaxBytes = 100MB");
        expect(buildScript.indexOf('Installer exceeds size gate:')).toBeLessThan(
            buildScript.indexOf('Write-Utf8NoBom "$path.sha256"'),
        );
    });

    it('pins fast probes, phase evidence, and native Windows 10/11 x64 gates', () => {
        for (const installer of ['deployment/server/POSAPP-Server.iss', 'deployment/spooler/POSAPP-Spooler.iss']) {
            const script = fs.readFileSync(path.join(ROOT, installer), 'utf8');
            for (const directive of ['MinVersion=10.0.17763', 'ArchitecturesAllowed=x64os', 'ArchitecturesInstallIn64BitMode=x64os', 'Compression=lzma2/max', 'SolidCompression=yes']) {
                expect(script).toContain(directive);
            }
            expect(script).toContain('GetWindowsVersionEx');
        }

        const provisioning = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        expect(provisioning).not.toContain('Test-NetConnection');
        expect(provisioning).toContain('System.Net.Sockets.TcpListener');
        expect(provisioning).toContain('System.Net.Sockets.TcpClient');
        expect(provisioning).toContain('Set-InstallPhase');
        expect(provisioning).toContain('Failed phase:');
        expect(provisioning).toContain('vc_redist.x64.exe');
        expect(provisioning).toContain('AllowedExitCodes @(0, 3010)');
    });

    it('keeps server startup repair and gives the spooler to NSSM restart policy', () => {
        const serverInstaller = fs.readFileSync(path.join(ROOT, 'deployment/server/POSAPP-Server.iss'), 'utf8');
        const spoolerInstaller = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');
        const serverProvisioning = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        const spoolerProvisioning = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8');
        const serverRemoval = fs.readFileSync(path.join(ROOT, 'deployment/windows/Remove-PosRuntime.ps1'), 'utf8');
        const spoolerRemoval = fs.readFileSync(path.join(ROOT, 'deployment/windows/Remove-SpoolerRuntime.ps1'), 'utf8');

        expect(serverInstaller).toContain('Repair-PosStartup.ps1');
        expect(spoolerInstaller).not.toContain('Repair-SpoolerStartup.ps1');
        for (const service of ['POSAppMariaDB', 'POSAppPhpMyAdmin', 'POSApp']) {
            expect(serverProvisioning).toContain(`@('failureflag', '${service}', '1')`);
        }
        expect(spoolerProvisioning).toContain("@('failureflag', 'POS Print Spooler', '1')");
        expect(serverProvisioning).toContain("'POSAPP Startup Health Repair'");
        for (const token of ['New-ScheduledTaskTrigger -AtStartup', 'New-ScheduledTaskPrincipal', 'RestartCount 3', 'ExecutionTimeLimit', 'StartWhenAvailable']) {
            expect(serverProvisioning).toContain(token);
            expect(spoolerProvisioning).not.toContain(token);
        }
        expect(serverRemoval).toContain("Unregister-ScheduledTask -TaskName 'POSAPP Startup Health Repair'");
        expect(spoolerRemoval).toContain("Unregister-ScheduledTask -TaskName 'POSAPP Spooler Startup Health Repair'");
    });

    it('keeps server startup repair bounded, diagnosable, and data-safe', () => {
        const serverPath = path.join(ROOT, 'deployment/windows/Repair-PosStartup.ps1');
        expect(fs.existsSync(serverPath)).toBe(true);
        const server = fs.readFileSync(serverPath, 'utf8');

        for (const token of ['StartupDelaySeconds', 'startup-health.json', 'startup-repair.log', 'POSAppMariaDB', 'POSAppPhpMyAdmin', 'POSApp', '/health', 'mutates']) {
            expect(server).toContain(token);
        }
        for (const script of [server]) {
            expect(script).not.toContain('mariadb-install-db');
            expect(script).not.toContain('run-pending-migrations');
            expect(script).not.toContain('DROP DATABASE');
            expect(script).not.toContain('Remove-Item -Recurse');
            expect(script).not.toContain('Install-PosServer.ps1');
        }
    });

    it('repairs missing MariaDB registration without initializing existing data', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        expect(script).toContain("Join-Path $dbRoot 'mysql'");
        expect(script).toContain("'--install', 'POSAppMariaDB'");
        expect(script).toContain('"--defaults-file=$myCnf"');
        expect(script).toContain('existing initialized MariaDB data directory');
        expect(script).toMatch(/if \(\$repair[\s\S]*--install[\s\S]*POSAppMariaDB/);
    });

    it('rejects a server payload without private Node and bootstrap tools', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-stage-'));
        for (const relative of REQUIRED_PATHS.server.filter((item) => item !== 'runtime/node/node.exe')) {
            const target = path.join(root, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, relative === 'release.json'
                ? JSON.stringify({ version: '1.0.0', commit: 'a'.repeat(40), schemaVersion: 'posapp-fresh-baseline-v1', spoolerVersion: '1.2.0' })
                : 'fixture');
        }
        expect(() => validatePayload(root, 'server')).toThrow(/runtime[\\/]node[\\/]node\.exe/);
    });

    it('rejects forbidden files even when release metadata lists them', () => {
        const root = createMinimalPayload('spooler');
        fs.writeFileSync(path.join(root, '.env'), 'SPOOLER_KEY=secret');
        expect(() => validatePayload(root, 'spooler')).toThrow(/forbidden.*\.env/i);
    });

    it('rejects build tooling and unrelated archives from production runtimes', () => {
        const spooler = createMinimalPayload('spooler');
        fs.mkdirSync(path.join(spooler, 'runtime/node/node_modules/npm'), { recursive: true });
        fs.writeFileSync(path.join(spooler, 'runtime/node/node_modules/npm/package.json'), '{}');
        expect(() => validatePayload(spooler, 'spooler')).toThrow(/forbidden.*runtime[\\/]node[\\/]node_modules/i);

        const server = createMinimalPayload('server');
        fs.writeFileSync(path.join(server, 'install/vendor/unrelated.zip'), 'fixture');
        expect(() => validatePayload(server, 'server')).toThrow(/unexpected vendor archive/i);
    });

    it('rejects legacy manual service scripts from the spooler payload', () => {
        const spooler = createMinimalPayload('spooler');
        fs.writeFileSync(path.join(spooler, 'install.bat'), 'legacy');
        expect(() => validatePayload(spooler, 'spooler')).toThrow(/legacy spooler file/i);
    });

    it('rejects any changed spooler payload byte with one deterministic hash', () => {
        const spooler = createMinimalPayload('spooler');
        expect(validatePayload(spooler, 'spooler').fileCount).toBeGreaterThan(0);
        fs.writeFileSync(path.join(spooler, 'server.js'), 'changed');
        expect(() => validatePayload(spooler, 'spooler')).toThrow('Spooler payload hash mismatch');
    });

    it('keeps release metadata outside its own hash while hashing every owned payload file', () => {
        const spooler = createMinimalPayload('spooler');
        const releasePath = path.join(spooler, 'release.json');
        const before = computeSpoolerPayloadHash(spooler);
        const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
        release.note = 'release metadata may change without a self-referential hash';
        fs.writeFileSync(releasePath, JSON.stringify(release));
        expect(computeSpoolerPayloadHash(spooler)).toBe(before);
        fs.writeFileSync(path.join(spooler, 'package.json'), 'changed');
        expect(computeSpoolerPayloadHash(spooler)).not.toBe(before);
    });

    it('runs the server update contract probe', () => {
        // The probe covers the server updater's rollback, retired-file cleanup and
        // manifest validation - none of which any vitest test reaches. It was only
        // ever referenced from plan documents, so its assertions were not running.
        const probe = path.join(ROOT, 'tests/installer/update-contract-probe.ps1');
        expect(fs.existsSync(probe)).toBe(true);
        const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], {
            encoding: 'utf8', windowsHide: true
        });
        expect(result.stderr || '').toBe('');
        expect(result.status, result.stdout).toBe(0);
        expect(result.stdout).toContain('server update contract probe: PASS');
    }, 120000);

    it('computes the same payload hash in Node and Windows PowerShell', () => {
        const spooler = createMinimalPayload('spooler');
        const installer = path.join(ROOT, 'deployment/windows/Install-Spooler.ps1');
        const command = [
            `$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('${installer.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)`,
            `$functions=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('Get-FileSha256','Get-SpoolerPayloadHash')},$true)`,
            '$functions | ForEach-Object { Invoke-Expression $_.Extent.Text }',
            `Get-SpoolerPayloadHash '${spooler.replaceAll("'", "''")}'`,
        ].join(';');
        const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-spooler-hash-probe-'));
        const probe = path.join(probeRoot, 'probe.ps1');
        fs.writeFileSync(probe, command, 'utf8');
        try {
            const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probe], { encoding: 'utf8' });
            expect(result.status, result.stderr || result.stdout).toBe(0);
            expect(result.stdout.trim(), command).toBe(computeSpoolerPayloadHash(spooler));
        } finally {
            fs.rmSync(probeRoot, { recursive: true, force: true });
        }
    });
    it('pins every offline runtime dependency with a real sha256', () => {
        const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployment/vendor-lock.json'), 'utf8'));
        expect(lock.schemaVersion).toBe(1);
        expect(lock.packages.map((item) => `${item.name}@${item.version}`)).toEqual([
            'node@22.23.0',
            'mariadb@11.8.8',
            'apache@2.4.68',
            'php@8.4.16',
            'phpmyadmin@5.2.3',
            'nssm@2.24',
            'typst@0.15.1',
            'noto-sans@92345ac0dbb28d27dbd32f3a782e84c55eaac214',
            'noto-sans-arabic@92345ac0dbb28d27dbd32f3a782e84c55eaac214',
            'noto-emoji@92345ac0dbb28d27dbd32f3a782e84c55eaac214',
            'noto-ofl@92345ac0dbb28d27dbd32f3a782e84c55eaac214',
            'vc-redist@14.44.35211.0'
        ]);
        for (const item of lock.packages) {
            expect(item.file).toMatch(/\S/);
            expect(item.source).toMatch(/^https:\/\//);
            expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
    });

    it('patches only the verified Typst runtime before packaging it', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        expect(build).toContain("deployment\\tools\\patch-typst-fast-watch.js");
        expect(build).toContain("deployment\\patches\\typst-0.15.1-fast-watch.txt");
        expect(build).toContain("Join-Path $Destination 'POSAPP-PATCH.txt'");
        expect(build.indexOf('patch-typst-fast-watch.js')).toBeLessThan(build.indexOf("'^typst 0\\.15\\.1\\b'"));
        expect(REQUIRED_PATHS.spooler).toContain('.cache/typst/0.15.1/POSAPP-PATCH.txt');
        expect(REQUIRED_PATHS['spooler-update']).toContain('.cache/typst/0.15.1/POSAPP-PATCH.txt');
        expect(REQUIRED_PATHS['spooler-update-runtime']).toContain('.cache/typst/0.15.1/POSAPP-PATCH.txt');
    });

    it('keeps the release contract documented', () => {
        const readme = fs.readFileSync(path.join(ROOT, 'deployment/README.md'), 'utf8');
        expect(readme).toContain('Inno Setup 6.7.3');
        expect(readme).toContain('POSAppMariaDB');
        expect(readme).toContain('POS Print Spooler');
        expect(readme).toContain('C:\\ProgramData\\POSApp');
        expect(readme).toContain('C:\\ProgramData\\POS-Spooler');
    });

    it('defines an explicit production staging allowlist and release identity', () => {
        const script = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        expect(script).toContain('$serverStage');
        expect(script).toContain('$spoolerStage');
        expect(script).toContain('vendor-lock.json');
        expect(script).toContain('release.json');
        for (const forbidden of ['.git', '.env.test', 'node_modules', '*.map', '*.7z', 'playwright-report', 'test-results']) {
            expect(script).toContain(forbidden);
        }
    });

    it('keeps server installation fail-fast and scoped to approved resources', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        for (const required of ['POSAppMariaDB', 'POSApp', 'POSAppPhpMyAdmin', 'POSAPP Database Backup', 'Start-Transcript', 'try {', 'catch {', 'POSAPP_ENV_FILE', 'New-NetFirewallRule', 'System.Net.Sockets.TcpListener', 'System.Net.Sockets.TcpClient', 'Set-InstallPhase', 'Failed phase:', 'vc_redist.x64.exe', 'AllowedExitCodes @(0, 3010)']) {
            expect(script).toContain(required);
        }
        expect(script).not.toContain('Test-NetConnection');
        expect(script).toContain('*S-1-5-18:(OI)(CI)(F)');
        expect(script).toContain('*S-1-5-32-544:(OI)(CI)(F)');
        expect(script).toContain('Test-Path -LiteralPath $Target -PathType Container');
        expect(script).toContain("*S-1-5-18:F', '*S-1-5-32-544:F");
        expect(script).toContain('Remove-Item -LiteralPath $secretPath -Force');
        expect(script).toContain('install-error.txt');
        expect(script).toContain('Format-InstallError');
        expect(script).toContain('Format-NativeCommand');
        expect(script).toContain('posapp-service.err.log');
        expect(script).toContain('AppStderr');
        expect(script).toContain('AppParameters');
        expect(script).toContain('$Name stderr tail:');
        expect(script).toContain('=***');
        expect(script).toContain('AllowedExitCodes @(0, 3010)');
        expect(script).toContain("Join-Path $ServerStage 'install\\mariadb-runtime'");
        expect(script).toContain('Packaged MariaDB runtime is missing');
        expect(script).toContain('Move-Item -LiteralPath $mariaRuntimeSource -Destination $dbRuntime');
        expect(script).toContain('Reset-IncompleteFreshMariaDb');
        expect(script).toContain('Remove-OwnedService');
        expect(script).toContain('mariadb-install-db.exe');
        expect(script).toContain('mysql_install_db.exe');
        expect(script).not.toContain('ALLOWREMOTEROOTACCESS=');
        expect(script).not.toContain('REMOVE=DBInstance');
        expect(script).not.toContain('mariadb-msi-install.log');
        expect(script).not.toContain("Invoke-Native -File 'msiexec.exe'");
        expect(script).not.toContain("'/i', $mariaMsi");
        expect(script).toContain('Private');
        expect(script).toContain('Remove-Item');
        expect(script).not.toContain('InstallLocalSpooler');
    });

    it('packages and validates the automatic migration runtime without shipping migration history', () => {
        expect(REQUIRED_PATHS.server).toContain('backend/migrations/runPendingMigrations.js');
        expect(REQUIRED_PATHS.server).toContain('backend/migrations/auto-manifest.json');
        expect(REQUIRED_PATHS.server).toContain('deployment/tools/run-pending-migrations.js');

        // Check the shipped tail structurally rather than pinning its name. A frozen
        // literal here fails on every new migration for no reason of its own, and the
        // chain itself is already verified by automaticMigrations.test.js and by each
        // migration's own predecessor/checksum test.
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend/migrations/auto-manifest.json'), 'utf8'));
        const tail = manifest.migrations.at(-1);
        const previous = manifest.migrations.at(-2);
        expect(manifest.migrations.length).toBeGreaterThanOrEqual(20);
        expect(tail.file).toBe(`${tail.name}.auto.sql`);
        expect(tail.checksum).toMatch(/^[0-9a-f]{64}$/);
        expect(tail.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(tail.requires).toMatchObject({ name: previous.name, checksum: previous.checksum });
        expect(fs.existsSync(path.join(ROOT, 'backend/migrations', tail.file))).toBe(true);

        const payload = createMinimalPayload('server');
        const manifestPath = path.join(payload, 'backend/migrations/auto-manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify({
            migrations: [{ file: 'missing.auto.sql' }],
        }));
        expect(() => validatePayload(payload, 'server')).toThrow(/missing migration payload file/i);

        const buildScript = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        expect(buildScript).toContain("backend\\migrations\\runPendingMigrations.js");
        expect(buildScript).toContain("backend\\migrations\\auto-manifest.json");
        expect(buildScript).toContain('migration.file');
    });

    it('rejects a server payload missing a manifest-referenced migration preflight', () => {
        const payload = createMinimalPayload('server');
        const migrations = path.join(payload, 'backend/migrations');
        fs.writeFileSync(path.join(migrations, 'probe.auto.sql'), 'SELECT 1;');
        fs.writeFileSync(path.join(migrations, 'auto-manifest.json'), JSON.stringify({
            migrations: [{ file: 'probe.auto.sql', preflight: 'probe.preflight.sql' }],
        }));

        expect(() => validatePayload(payload, 'server')).toThrow(/missing migration payload file.*probe\.preflight\.sql/i);
    });

    it('stages optional migration preflights referenced by the automatic manifest', () => {
        const buildScript = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        expect(buildScript).toContain('migration.preflight');
    });

    it('keeps installation verification explicit and secret-free', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/tools/verify-install.js'), 'utf8');
        for (const required of ['validateRequiredSchema', '009384', '/health', 'backup', 'release']) {
            expect(script).toContain(required);
        }
        expect(script).not.toContain('DB_PASSWORD');
    });

    it('keeps server provisioning as one ordered executable transaction', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        const ordered = ['Assert-PortAvailable', 'vc_redist.x64.exe', "Join-Path $ServerStage 'install\\mariadb-runtime'", 'mariadb-install-db.exe', 'bind-address=127.0.0.1', 'bootstrap-database.js', 'run-pending-migrations.js', 'httpd.exe', 'POSApp', 'db-backup.js', 'verify-install.js'];
        const positions = ordered.map((token) => script.indexOf(token));
        positions[8] = script.indexOf('POSApp', positions[7]);
        expect(positions.every((position) => position >= 0)).toBe(true);
        for (let index = 1; index < positions.length; index += 1) expect(positions[index]).toBeGreaterThan(positions[index - 1]);
        expect(script).not.toMatch(/^[ \t]*&\s*(msiexec|httpd|sc\.exe|New-NetFirewallRule)/m);
        expect(script).toContain('bind-address=127.0.0.1');
    });

    it('resolves nested archive roots without rejecting duplicate markers', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        const start = script.indexOf('function Resolve-ArchiveRoot');
        const end = script.indexOf('function Render', start);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const resolver = script.slice(start, end);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-archive-root-'));
        const shallow = path.join(root, 'MariaDB 11.8', 'bin');
        const nested = path.join(root, 'nested', 'MariaDB 11.8', 'bin');
        fs.mkdirSync(shallow, { recursive: true });
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(shallow, 'mariadbd.exe'), 'fixture');
        fs.writeFileSync(path.join(nested, 'mariadbd.exe'), 'fixture');

        const quotedRoot = root.replace(/'/g, "''");
        const result = spawnSync('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `${resolver}\nResolve-ArchiveRoot '${quotedRoot}' 'bin\\mariadbd.exe'`
        ], { encoding: 'utf8' });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        const resolvedRoot = result.stdout.trim().split(/\r?\n/).pop();
        expect(fs.realpathSync.native(resolvedRoot)).toBe(
            fs.realpathSync.native(path.join(root, 'MariaDB 11.8'))
        );
        expect(script).toContain('Archive marker missing under');
    });

    it('defines a standalone spooler installer without server/database payloads', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');
        for (const required of ['80657A48-9BCB-4455-8CA9-A18139FDFC58', 'PrivilegesRequired=admin', 'x64', 'POS-Spooler', 'POS Print Spooler', 'POSAPP-Spooler-Typst-Only-Setup', 'Uninstall', 'PowerShell', 'ssPostInstall']) {
            expect(script).toContain(required);
        }
        expect(fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8')).toContain('PayloadRoot');
        expect(fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8')).toContain('C:\\ProgramData\\POS-Spooler');
        expect(fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8')).toContain('*S-1-5-32-544:(OI)(CI)(F)');
        expect(script).not.toContain('POSAppMariaDB');
        expect(script).not.toContain('phpMyAdmin');
        expect(script).toContain('SaveStringsToUTF8FileWithoutBOM');
        expect(script).toContain('DisableDirPage=yes');
        expect(script).toContain('function NextButtonClick');
        expect(script).toContain('POS server URL is required.');
        expect(script).toContain("SpoolerScript:=ExpandConstant('{tmp}\\spooler-install-payload\\deployment\\windows\\Install-Spooler.ps1')");
        expect(script).toContain("PayloadRoot:=ExpandConstant('{tmp}\\spooler-install-payload')");
        expect(script).not.toContain('-File "{app}\\deployment\\windows\\Install-Spooler.ps1"');
        expect(script).not.toContain('-PayloadRoot "{app}"');
    });

    it('defines a fresh server wizard with editable ports and a safe POS shortcut', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/server/POSAPP-Server.iss'), 'utf8');
        for (const required of ['E99DB275-DDA0-43A0-95CD-7AE07185122C', 'PrivilegesRequired=admin', 'x64', '3000', '3306', '8081', 'Restaurant name', 'POS App', 'POSAPP-Server-Setup']) {
            expect(script).toContain(required);
        }
        expect(script).toContain('Get-PortStatus.ps1');
        expect(script).toContain('function PortsAreAvailable');
        expect(script).toContain('Checking...');
        expect(script).toContain('-Ports ');
        expect(script).not.toContain('function PortIsAvailable');
        expect(script).not.toContain('PortIsAvailable(PosPort)');
        expect(script).not.toContain('[Tasks]');
        expect(script).not.toContain('WizardIsTaskSelected');
        expect(script).not.toContain('WizardIsComponentSelected');
        expect(script).not.toContain('spooler-payload');
        expect(script).toContain('CurStep = ssPostInstall');
        expect(script).toContain('try');
        expect(script).toContain('finally');
        expect(script).toContain('icacls.exe');
        expect(script).toContain('SaveStringsToUTF8FileWithoutBOM');
        expect(script).not.toContain('SuggestAvailablePort');
        expect(script).not.toContain('legacy');
        expect(script).not.toContain('XAMPP');
        expect(script).toContain('POS App.url');
        expect(script).not.toContain('CreateShellLink');
        // Shortcuts are written by the provisioning script with the resolved ports, never from wizard values (repair shows defaults).
        const provisioning = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        expect(script).not.toContain('[InternetShortcut]');
        expect(provisioning).toContain('[InternetShortcut]');
        expect(provisioning).toContain('URL=http://localhost:$PosPort/pos');
        expect(provisioning).toContain('URL=http://localhost:$PhpMyAdminPort/');
        expect(provisioning).toContain('[string]$ResultFile');
        expect(provisioning).toContain('phpMyAdmin password:');
        expect(provisioning).toContain('Spooler key:');
        expect(script).toContain('server-result.txt');
        expect(script).toContain('-ResultFile');
        expect(script).toContain('ReadTextFile(ResultPath)');
        expect(script).toContain('Server provisioning failed with exit code');
        expect(script).toContain("PosScript := ExpandConstant('{app}\\deployment\\windows\\Install-PosServer.ps1')");
        expect(script).toContain("ServerStage := ExpandConstant('{app}')");
        expect(script).toContain("VendorDir := ExpandConstant('{app}\\install\\vendor')");
        expect(script).not.toContain('-File "{app}\\deployment\\windows\\Install-PosServer.ps1"');
        expect(script).not.toContain('-ServerStage "{app}"');
        expect(script).not.toContain('-VendorDir "{app}\\install\\vendor"');
        expect(script).not.toContain('-LocalSpoolerPayload "{tmp}\\spooler-payload"');
        expect(script).toContain('*S-1-5-32-544:F');
        expect(script).toContain('DisableDirPage=yes');
        expect(script).toContain('Installing POS services and database...');
    });

    it('ships a VBS-free NSSM spooler service payload', () => {
        const buildScript = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        const validator = fs.readFileSync(path.join(ROOT, 'deployment/tools/validate-payload.js'), 'utf8');
        const installScript = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8');
        const spoolerPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'pos-spooler-printer/package.json'), 'utf8'));

        expect(REQUIRED_PATHS.spooler).toContain('install/vendor/nssm-2.24.zip');
        expect(buildScript).toContain('$spoolerVendorPackageNames');
        expect(buildScript).toContain("'nssm'");
        expect(buildScript).toContain("install/vendor");
        expect(validator).toContain('LOCKED_SPOOLER_VENDOR_ARCHIVES');
        expect(spoolerPackage.dependencies).not.toHaveProperty('node-windows');
        expect(spoolerPackage.devDependencies?.['node-windows']).toBeUndefined();
        for (const gone of ['install.bat', 'uninstall.bat', 'install-service.js', 'uninstall-service.js']) {
            expect(fs.existsSync(path.join(ROOT, 'pos-spooler-printer', gone)), gone).toBe(false);
        }
        for (const source of [installScript]) {
            for (const forbidden of ['install-service.js', 'node-windows', 'elevate.cmd', 'wscript', '.vbs']) {
                expect(source).not.toContain(forbidden);
            }
        }
        expect(buildScript).toContain("'install-service.js'");
        expect(validator).toContain("'install-service.js'");
        for (const required of [
            'nssm-2.24.zip', 'Expand-Archive', 'AppDirectory', 'AppParameters',
            'AppEnvironmentExtra', 'NODE_ENV=production', 'SPOOLER_ENV_FILE=',
            'SPOOLER_STATE_DIR=', 'SPOOLER_LOG_DIR=', 'AppStdout', 'AppStderr',
            'AppRotateFiles', 'AppRotateOnline', 'AppRotateSeconds', 'AppRotateBytes',
            'Get-ItemProperty', 'failureflag'
        ]) {
            expect(installScript).toContain(required);
        }
    });

    it('limits failed fresh-install cleanup to stale Program Files wrappers', () => {
        const installScript = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8');
        const cleanupBlock = installScript.slice(installScript.indexOf("if ($serviceOwnership -eq 'absent')"), installScript.indexOf("$node =", installScript.indexOf("if ($serviceOwnership -eq 'absent')")));

        expect(installScript).toContain("$daemonRoot = Join-Path $ProgramFilesRoot 'daemon'");
        expect(cleanupBlock).toContain('$daemonRoot');
        expect(cleanupBlock).toContain('Remove-Item');
        expect(cleanupBlock).not.toMatch(/ProgramDataRoot[\s\S]*Remove-Item[\s\S]*-Recurse/);
        expect(cleanupBlock).not.toMatch(/config[\s\S]*Remove-Item[\s\S]*-Recurse/);
        expect(cleanupBlock).not.toMatch(/state[\s\S]*Remove-Item[\s\S]*-Recurse/);
    });

    it('owns only exact registered spooler executables and configures the canonical service entry point', () => {
        const installScript = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8');

        expect(installScript).toContain('function Get-RegisteredExecutablePath([string]$ImagePath)');
        expect(installScript).toContain('[IO.Path]::GetFullPath($Path)');
        expect(installScript).toContain("if ($trimmed.StartsWith('\"'))");
        expect(installScript).toContain("IndexOf('\"', 1)");
        expect(installScript).toContain("if (Test-SamePath $registeredExecutable $nssmExecutable)");
        expect(installScript).toContain("elseif (Test-SamePath $registeredExecutable $legacyExecutable)");
        expect(installScript).toContain("throw 'POS Print Spooler is registered to an unexpected executable.'");
        expect(installScript).not.toContain('Test-PathInImage');
        expect(installScript).not.toContain('$serviceImagePath $ProgramFilesRoot');
        expect(installScript).not.toContain('$serviceImagePath $daemonRoot');

        expect(installScript).toContain('Configure-NssmService $nssmExecutable $serviceName $node $serverScript');
        expect(installScript).toContain("$serverScript = Join-Path $ProgramFilesRoot 'server.js'");
    });

    it('does not expose a bundled local-spooler task in the server wizard', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/server/POSAPP-Server.iss'), 'utf8');
        expect(script).not.toContain('localspooler');
        expect(script).not.toContain('WizardIsTaskSelected');
    });

    it('preserves durable data during runtime removal and repair', () => {
        const serverRemoval = fs.readFileSync(path.join(ROOT, 'deployment/windows/Remove-PosRuntime.ps1'), 'utf8');
        const spoolerRemoval = fs.readFileSync(path.join(ROOT, 'deployment/windows/Remove-SpoolerRuntime.ps1'), 'utf8');
        for (const forbidden of ['C:\\ProgramData\\POSApp\\database', 'C:\\ProgramData\\POSApp\\uploads', 'C:\\ProgramData\\POSApp\\backups']) expect(serverRemoval).not.toContain(forbidden + "' -Recurse");
        for (const forbidden of ['C:\\ProgramData\\POS-Spooler\\state', 'C:\\ProgramData\\POS-Spooler\\config']) expect(spoolerRemoval).not.toContain(forbidden + "' -Recurse");
        expect(serverRemoval).toContain('POSAppMariaDB');
        expect(serverRemoval).toContain('POSAPP Database Backup');
        expect(serverRemoval).toContain('$WhatIfPreference');
        expect(spoolerRemoval).toContain('POS Print Spooler');
        expect(spoolerRemoval).toContain('$WhatIfPreference');
        expect(spoolerRemoval).not.toContain('update-transaction.json');
        expect(spoolerRemoval).not.toContain('SpoolerTransactionJournal');
        expect(spoolerRemoval).toContain('Wait-ServiceRemoved');
        // Without the trailing detail this matched the unrelated duplicate-service-set
        // guard on line 46 and kept passing after the ownership refusal was deleted.
        expect(spoolerRemoval).toContain('Refusing to remove an unrecognized Windows service set:');
        expect(spoolerRemoval).toContain('Refusing to remove a POS Print Spooler service owned by');
        expect(fs.readFileSync(path.join(ROOT, 'deployment/server/POSAPP-Server.iss'), 'utf8')).toContain('Remove-PosRuntime.ps1');
        expect(fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8')).toContain('Remove-SpoolerRuntime.ps1');
        expect(fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8')).toContain('if IsRepairInstall then');
        expect(fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8')).toContain('Installing print spooler service...');
    });

    it('fully rolls back resources created by a failed fresh installation', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        expect(script).toContain("if ($created.posService) { try { Remove-OwnedService 'POSApp' }");
        expect(script).toContain("if ($created.apacheService) { try { Remove-OwnedService 'POSAppPhpMyAdmin' }");
        expect(script).toContain("try { Remove-OwnedService 'POSAppMariaDB' }");
        expect(script).toContain("{ $created.posService = $true; Invoke-Native $nssm @('install', 'POSApp', $posNodeExe) }");
        expect(script).toContain("{ $created.apacheService = $true; Invoke-Native $httpdExe @('-k', 'install'");
        expect(script).not.toContain('Database bootstrap completed before provisioning failed.');
        expect(script).toContain('if (-not $programDataExisted) {');
    });

    it('provides clean-Windows acceptance checks without mutating the host by default', () => {
        const script = fs.readFileSync(path.join(ROOT, 'tests/installer/fresh-install-smoke.ps1'), 'utf8');
        for (const required of ['POSAppMariaDB', 'POSAppPhpMyAdmin', 'POSApp', 'POS Print Spooler', 'Private', '009384', '/health', 'POS App', 'reboot', 'backup', 'Get-FileHash']) {
            expect(script).toContain(required);
        }
        expect(script).toContain('param(');
        expect(script).toContain('WhatIf');
        expect(script).toContain('009384 login');
        expect(script).toContain('Get-NetFirewallPortFilter');
        expect(script).toContain('qfailure');
        expect(script).not.toContain('Login check required');
    });

    it('preserves locked vendor archives and writes release JSON without a BOM', () => {
        const script = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        expect(script).toMatch(/install[\\/]vendor/);
        expect(script).toContain('Stage-MariaDbRuntime');
        expect(script).toContain('$serverVendorPackageNames');
        expect(script).toContain("install/mariadb-runtime");
        expect(script).toContain('mariadb-runtime-extract');
        expect(script).toContain('Expand-Archive -LiteralPath $ArchivePath');
        expect(script).not.toContain('msiexec.exe');
        expect(script).toContain('Write-Utf8NoBom');
        expect(script).not.toMatch(/Remove-ForbiddenPayloadFiles\s+\$serverStage[\s\S]*?\.Name -like '\*\.zip'/);
        expect(script).toContain("Invoke-Npm @('run', 'build')");
        expect(script).toContain('Release installers must be built from a clean worktree.');
        expect(script).toContain("deployment/out/toolchain/inno/ISCC.exe");
        expect(script).not.toContain('Remove-Item -Recurse -Force $toolchain');
    });

    it('runs the bundled npm CLI instead of inheriting the outer npm executable', () => {
        const script = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');

        expect(script).toContain("$npmCli = Join-Path $nodeToolRoot 'node_modules/npm/bin/npm-cli.js'");
        expect(script).toContain('Invoke-Native $nodeExe (@($npmCli) + $Arguments)');
        expect(script).not.toContain('$npmCmd');
    });

    it('passes a custom output root to both spooler and server Inno builds', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        const serverInstaller = fs.readFileSync(path.join(ROOT, 'deployment/server/POSAPP-Server.iss'), 'utf8');
        const spoolerInstaller = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');

        for (const installer of [serverInstaller, spoolerInstaller]) {
            expect(installer).toContain('#ifndef StageRoot');
            expect(installer).toContain('#ifndef InstallerOutputDir');
            expect(installer).toContain('OutputDir={#InstallerOutputDir}');
        }
        expect(build).toContain('$serverDefines = @("/DStageRoot=$stage", "/DInstallerOutputDir=$out")');
        expect(build).toContain('Invoke-Native $iscc (@($serverDefines) + @("/DAppVersion=$releaseVersion", $serverInstaller))');
        expect(serverInstaller).not.toContain('#define StageDir "..\\out\\stage');
    });

    it('writes Node and MariaDB configuration as UTF-8 and never copies app onto itself', () => {
        const script = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        expect(script).toContain('Write-Utf8NoBom');
        expect(script).not.toContain("Copy-Item (Join-Path $ServerStage '*') $ProgramFilesRoot");
        expect(script).toContain('pos.env.template');
        expect(fs.readFileSync(path.join(ROOT, 'deployment/templates/pos.env.template'), 'utf8')).toContain('SPOOLER_KEY={{SPOOLER_KEY}}');
        expect(script).toContain('Register-ScheduledTask');
        expect(script).toContain("Start-OwnedService 'POSAppPhpMyAdmin'");
        expect(script).toContain("Start-OwnedService 'POSApp' $posStderr");
        expect(script).toContain("Invoke-Native $nssm @('install', 'POSApp', $posNodeExe)");
        expect(script).toContain("$nssmQuotedPosScript = '\"\"\"' + $posScript + '\"\"\"'");
        expect(script).toContain("Invoke-Native $nssm @('set', 'POSApp', 'AppParameters', $nssmQuotedPosScript)");
        expect(script).not.toContain("Invoke-Native $nssm @('set', 'POSApp', 'AppParameters', \"`\"$posScript`\"\")");
        expect(script).toContain("Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\POSApp\\Parameters'");
        expect(script).toContain('NSSM stored an invalid POS application path.');
        expect(script).toContain('NSSM stored invalid POS application parameters.');
        expect(script).toContain("Invoke-Native $httpdExe @('-t', '-f', $apacheConf)");
        expect(script).not.toContain("Invoke-Native $nssm @('install', 'POSApp', (Join-Path $ProgramFilesRoot 'runtime\\node\\node.exe'), (Join-Path $ProgramFilesRoot 'server.js'))");
        expect(script).toContain("'NODE_ENV=production', 'LOG_LEVEL=info'");
        expect(script).toContain('POSAPP_LOG_DIR=$logDir');
    });

    it('keeps verification evidence and invokes the real backup output contract', () => {
        const install = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        const backup = fs.readFileSync(path.join(ROOT, 'scripts/db-backup.js'), 'utf8');
        expect(backup).toContain("'--output'");
        expect(install).toContain('expectedBackupSha256');
        expect(install).not.toContain('Remove-Item $verifyConfig');
    });

    it('does not reject owned repair ports and validates the connected spooler identity', () => {
        const server = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'), 'utf8');
        const spooler = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8');
        expect(server).toMatch(/if \(-not \$repair\) \{[\s\S]*Assert-PortAvailable/);
        expect(spooler).toContain('/api/spooler/v2/status');
        expect(spooler).not.toContain('/api/spooler/self-status');
        expect(spooler).toContain('spooler_id');
        expect(spooler).toContain('agent_id');
        expect(spooler).toContain('last_sync_at');
        expect(spooler).toContain('version');
        expect(spooler).not.toContain('$status.name -eq $SpoolerName');
    });

    it('makes smoke backup restoration and optional spooler checks real', () => {
        const script = fs.readFileSync(path.join(ROOT, 'tests/installer/fresh-install-smoke.ps1'), 'utf8');
        expect(script).toContain('RestoreDatabaseName');
        expect(script).toContain('mariadb.exe');
        expect(script).toContain('DROP DATABASE');
        expect(script).toContain('IncludeSpooler');
        expect(script).not.toContain("$config='C:\\ProgramData\\POSApp\\config\\verify.json'");
    });

    it('plans a fresh server install without touching its requested ProgramData root', () => {
        const programData = path.join(os.tmpdir(), `pos-plan-${process.pid}-${Date.now()}`);
        const result = spawnSync('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Install-PosServer.ps1'),
            '-RestaurantName', 'Plan Probe', '-ServerStage', 'C:\\missing-stage', '-VendorDir', 'C:\\missing-vendor',
            '-ProgramDataRoot', programData, '-WhatIf'
        ], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toMatchObject({ mode: 'fresh', restaurant: 'Plan Probe', mutates: false });
        expect(fs.existsSync(programData)).toBe(false);
    });

    it('accepts canonical online origins during fresh spooler provisioning', () => {
        const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-spooler-origin-'));
        const programFiles = path.join(payload, 'planned-files');
        const programData = path.join(payload, 'planned-data');
        for (const relative of [
            'server.js', 'runtime/node/node.exe', 'package.json', 'release.json', 'install/vendor/nssm-2.24.zip',
            '.cache/typst/0.15.1/typst.exe', '.cache/typst/0.15.1/POSAPP-PATCH.txt',
            '.cache/typst/0.15.1/fonts/NotoSans.ttf',
            '.cache/typst/0.15.1/fonts/NotoSansArabic.ttf', '.cache/typst/0.15.1/fonts/NotoEmoji.ttf'
        ]) {
            const target = path.join(payload, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, '{}');
        }
        const provision = (serverUrl) => spawnSync('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'),
            '-ServerUrl', serverUrl, '-SpoolerKey', 'probe-secret', '-SpoolerId', 'station-a', '-SpoolerName', 'Counter A',
            '-PayloadRoot', payload, '-ProgramFilesRoot', programFiles, '-ProgramDataRoot', programData, '-WhatIf',
        ], { encoding: 'utf8' });

        try {
            for (const [input, canonical] of [
                ['https://hashemi.shawermajwana.com', 'https://hashemi.shawermajwana.com'],
                ['https://hashemi.shawermajwana.com/', 'https://hashemi.shawermajwana.com'],
                ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
            ]) {
                const result = provision(input);
                expect(result.status, result.stderr).toBe(0);
                expect(JSON.parse(result.stdout.trim())).toMatchObject({ serverUrl: canonical, spooler_id: 'station-a', mutates: false });
                expect(`${result.stdout}\n${result.stderr}`).not.toContain('probe-secret');
            }
            for (const input of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?q=1', 'https://example.com/#fragment', 'https://example.com:99999']) {
                const result = provision(input);
                expect(result.status, input).not.toBe(0);
                expect(`${result.stdout}\n${result.stderr}`).not.toContain('probe-secret');
            }
            expect(fs.existsSync(programData)).toBe(false);
        } finally {
            fs.rmSync(payload, { recursive: true, force: true });
        }
    });

    it('accepts installer response JSON without optional additional environment settings', () => {
        const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-spooler-response-'));
        const configFile = path.join(payload, 'spooler-response.json');
        for (const relative of [
            'server.js', 'runtime/node/node.exe', 'package.json', 'release.json', 'install/vendor/nssm-2.24.zip',
            '.cache/typst/0.15.1/typst.exe', '.cache/typst/0.15.1/POSAPP-PATCH.txt',
            '.cache/typst/0.15.1/fonts/NotoSans.ttf',
            '.cache/typst/0.15.1/fonts/NotoSansArabic.ttf', '.cache/typst/0.15.1/fonts/NotoEmoji.ttf'
        ]) {
            const target = path.join(payload, relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, '{}');
        }
        fs.writeFileSync(configFile, JSON.stringify({
            ServerUrl: 'https://example.com',
            SpoolerKey: 'probe-secret',
            SpoolerId: 'station-a',
            SpoolerName: 'Counter A',
        }));

        try {
            const result = spawnSync('powershell.exe', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'),
                '-ConfigFile', configFile, '-PayloadRoot', payload,
                '-ProgramFilesRoot', path.join(payload, 'planned-files'),
                '-ProgramDataRoot', path.join(payload, 'planned-data'), '-WhatIf',
            ], { encoding: 'utf8' });

            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(result.stdout.trim())).toMatchObject({ serverUrl: 'https://example.com', spooler_id: 'station-a', mutates: false });
            expect(`${result.stdout}\n${result.stderr}`).not.toContain('probe-secret');
        } finally {
            fs.rmSync(payload, { recursive: true, force: true });
        }
    });

    it('validates the fresh spooler origin before leaving the installer page', () => {
        const installer = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');
        expect(installer).toContain('function IsValidServerOrigin');
        expect(installer).toMatch(/CurPageID = ServerPage\.ID[\s\S]{0,300}IsValidServerOrigin\(ServerPage\.Values\[0\]\)/);
    });

    it('auto-detects only an authoritative healthy local POS server for fresh spooler setup', () => {
        const detectorPath = path.join(ROOT, 'deployment/windows/Detect-LocalPosServer.ps1');
        const probePath = path.join(ROOT, 'tests/installer/local-spooler-detection-probe.ps1');
        expect(fs.existsSync(detectorPath)).toBe(true);
        expect(fs.existsSync(probePath)).toBe(true);

        const detector = fs.readFileSync(detectorPath, 'utf8');
        const spoolerInstaller = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');
        const spoolerProvisioning = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8');

        for (const token of [
            'E99DB275-DDA0-43A0-95CD-7AE07185122C',
            'install.json',
            'config\\pos.env',
            'SPOOLER_KEY',
            '127.0.0.1',
            '/health',
            'status',
            'db',
            'release.version',
        ]) expect(detector).toContain(token);
        expect(detector).not.toContain('secrets.json');
        expect(detector).toMatch(/43/);
        expect(detector).not.toMatch(/Test-NetConnection|TcpClient|TcpListener|port.?scan|discovery/i);
        expect(detector).not.toMatch(/Write-(?:Host|Output)[^\r\n]*(?:key|spoolerKey)/i);
        expect(detector).not.toMatch(/Write-(?:Host|Output)[\s\S]{0,160}spoolerKey/i);

        expect(spoolerInstaller).toContain('Detect-LocalPosServer.ps1');
        expect(spoolerInstaller).toMatch(/Source: .*Detect-LocalPosServer\.ps1.*dontcopy/i);
        expect(spoolerInstaller).toContain('ExtractTemporaryFile');
        expect(spoolerInstaller).toContain('icacls');
        expect(spoolerInstaller).toContain('DeleteFile');
        expect(spoolerInstaller).toContain('LocalServerDetected');
        expect(spoolerInstaller).toContain('TryDetectLocalPosServer');
        expect(spoolerInstaller).toMatch(/PageID = ServerPage\.ID[\s\S]*PageID = KeyPage\.ID/);
        expect(spoolerInstaller).not.toMatch(/LocalServerDetected[\s\S]{0,180}StationPage\.ID/);
        expect(spoolerProvisioning).not.toContain('Detect-LocalPosServer.ps1');
    });

    it('packages the durable agent entrypoint, helper, and source inventory without V2 opt-in', () => {
        const build = fs.readFileSync(path.join(ROOT, 'scripts/build-installers.ps1'), 'utf8');
        const installer = fs.readFileSync(path.join(ROOT, 'deployment/spooler/POSAPP-Spooler.iss'), 'utf8');
        const provisioning = fs.readFileSync(path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'), 'utf8');
        const manifest = fs.readFileSync(path.join(ROOT, 'deployment/tools/spooler-layer-manifest.js'), 'utf8');
        for (const token of ["'v2', 'windows-helper', 'bin'", '$helperBin', 'PosSpoolerPlatform.exe']) expect(build).toContain(token);
        expect(build).not.toContain("'v2-server.js'");
        for (const token of ['ENABLEV2', '-EnableV2', 'EnableV2']) expect(installer).not.toContain(token);
        expect(provisioning).not.toContain('$EnableV2');
        expect(provisioning).not.toContain('--prepare');
        expect(provisioning).not.toContain("targetScript = 'v2-server.js'");
        expect(provisioning).toContain("$serverScript = Join-Path $ProgramFilesRoot 'server.js'");
        expect(provisioning).toContain('v2-server.js');
        expect(provisioning).toContain('bin\\PosSpoolerPlatform.exe');
        expect(provisioning).not.toContain("if ($EnableV2 -and $serviceOwnership -notin @('nssm', 'absent'))");
        expect(provisioning).toContain('/api/spooler/v2/status');
        expect(provisioning).not.toContain('V2 spooler did not register and complete its first accepted sync.');
        expect(manifest).not.toContain("'v2-server.js'");
        for (const token of ["'v2'", "'bin'", "'windows-helper'"]) expect(manifest).toContain(token);
    });
});
