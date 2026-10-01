import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { stampSpoolerPayload } from '../../../deployment/tools/validate-payload.js';

const ROOT = path.resolve(process.cwd());
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('packaged installer update contract', () => {
  it('keeps the server updater transaction helper and release states intact', () => {
    const state = read('deployment/windows/InstallerUpdateState.ps1');
    const updater = read('deployment/windows/Update-PosServer.ps1');
    for (const token of ['blocked_version_collision', 'blocked_downgrade', 'blocked_ownership', 'blocked_incomplete', 'blocked_fresh']) {
      expect(state).toContain(token);
    }
    expect(updater).toContain('InstallerUpdateState.ps1');
    expect(updater).toContain("[ValidateSet('Core', 'RuntimeTransition')]");
    expect(updater).toContain('runtime_transition_required');
  });

  it('keeps ordinary server updates dependency-free and gates runtime transitions', () => {
    const build = read('scripts/build-installers.ps1');
    const updater = read('deployment/windows/Update-PosServer.ps1');
    for (const token of ['server-update-core', 'server-update-runtime', 'server-dependency-manifest.json']) expect(build).toContain(token);
    expect(build).toMatch(/\$serverRuntimeRoots\s*=\s*@\(\$serverApplicationRoots \+ 'node_modules'\)/);
    expect(updater).toContain('Assert-ServerDependencyInventory');
    expect(updater).toContain('Get-ApplicationOnlyManifest');
  });

  it('keeps updater source identities aligned with package contracts', () => {
    const serverVersion = JSON.parse(read('package.json')).version;
    const spoolerVersion = JSON.parse(read('pos-spooler-printer/package.json')).version;
    expect(read('deployment/server/POSAPP-Server.iss')).toContain(`#define AppVersion "${serverVersion}"`);
    expect(read('deployment/spooler/POSAPP-Spooler.iss')).toContain(`#define AppVersion "${spoolerVersion}"`);
  });

  it('retains installer identity, update mutex, and uninstall boundary', () => {
    for (const [file, appId, mutex] of [
      ['deployment/server/POSAPP-Server.iss', 'E99DB275-DDA0-43A0-95CD-7AE07185122C', 'POSAPP-Server-Installer'],
      ['deployment/spooler/POSAPP-Spooler.iss', '80657A48-9BCB-4455-8CA9-A18139FDFC58', 'POSAPP-Spooler-Installer'],
    ]) {
      const source = read(file);
      expect(source).toContain(appId);
      expect(source).toContain(`SetupMutex=${mutex},Global\\${mutex}`);
      expect(source).toContain('[UninstallRun]');
      expect(source).toContain('[UninstallDelete]');
    }
  });

  it('keeps UpdateOnly execution explicit and non-interactive-safe', () => {
    for (const file of ['deployment/server/POSAPP-Server.iss', 'deployment/spooler/POSAPP-Spooler.iss']) {
      const source = read(file);
      expect(source).toContain('{param:ACCEPTUPDATE|0}');
      expect(source).toContain('WizardSilent');
      expect(source).toMatch(/#ifdef UpdateOnly[\s\S]*?Uninstallable=no/);
      expect(source).toMatch(/if not WizardSilent then[\s\S]*\.Show/);
      expect(source).toMatch(/finally[\s\S]*if not WizardSilent then[\s\S]*\.Hide/);
    }
  });

  it('reports server reachability as an install warning', () => {
    const install = read('deployment/windows/Install-Spooler.ps1');
    const setup = read('deployment/spooler/POSAPP-Spooler.iss');
    expect(install).toContain('SPOOLER_SERVER_UNREACHABLE');
    expect(install).toContain('SPOOLER_SERVER_UNHEALTHY');
    expect(install).toContain('SPOOLER_NOT_YET_REGISTERED');
    expect(install).toMatch(/warnings\s*=\s*@\(\$warnings\)/);
    expect(setup).toContain('The spooler could not confirm the POS server yet.');
  });

  it('accepts a response file without optional AdditionalEnv', () => {
    const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-spooler-response-'));
    const configFile = path.join(payload, 'spooler-response.json');
    for (const relative of [
      'server.js', 'runtime/node/node.exe', 'package.json', 'release.json', 'install/vendor/nssm-2.24.zip',
      '.cache/typst/0.15.1/typst.exe', '.cache/typst/0.15.1/POSAPP-PATCH.txt',
      '.cache/typst/0.15.1/fonts/IBMPlexSansArabic-Regular.ttf',
      '.cache/typst/0.15.1/fonts/IBMPlexSansArabic-SemiBold.ttf', '.cache/typst/0.15.1/fonts/IBMPlexSansArabic-Bold.ttf',
      '.cache/typst/0.15.1/fonts/IBM-Plex-OFL.txt', '.cache/typst/0.15.1/fonts/NotoSans.ttf',
      '.cache/typst/0.15.1/fonts/NotoSansArabic.ttf', '.cache/typst/0.15.1/fonts/NotoEmoji.ttf'
    ]) {
      const target = path.join(payload, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{}');
    }
    fs.writeFileSync(configFile, JSON.stringify({ ServerUrl: 'https://example.com', SpoolerKey: 'probe-secret', SpoolerId: 'station-a', SpoolerName: 'Counter A' }));
    try {
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Install-Spooler.ps1'),
        '-ConfigFile', configFile, '-PayloadRoot', payload,
        '-ProgramFilesRoot', path.join(payload, 'planned-files'), '-ProgramDataRoot', path.join(payload, 'planned-data'), '-WhatIf',
      ], { encoding: 'utf8' });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ serverUrl: 'https://example.com', spooler_id: 'station-a', mutates: false });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('probe-secret');
    } finally {
      fs.rmSync(payload, { recursive: true, force: true });
    }
  });

  it('trusts successful NSSM writes without registry readback', () => {
    const install = read('deployment/windows/Install-Spooler.ps1');
    const update = read('deployment/windows/Update-Spooler.ps1');
    const configure = install.slice(install.indexOf('function Configure-NssmService'), install.indexOf('$configDir ='));
    const updateSetter = update.slice(update.indexOf('function Set-SpoolerApplicationScript'), update.indexOf('$mutex = $null'));
    expect(configure).not.toContain('Get-ItemProperty');
    expect(updateSetter).not.toContain('Get-ItemProperty');
    expect(configure).toContain('Invoke-Native');
    expect(updateSetter).toContain('$LASTEXITCODE -ne 0');
  });

  it('removes a half-configured service of the owned name', () => {
    const remove = read('deployment/windows/Remove-SpoolerRuntime.ps1');
    expect(remove).not.toContain("throw 'Refusing to remove an unrecognized Windows service.'");
    expect(remove).toContain('Removing a POS Print Spooler service with unexpected configuration');
    expect(remove).toContain('& sc.exe delete $serviceName');
  });

  it('copies the identity files last so a half-replaced update stays retryable', () => {
    // Copy-OwnedApplication deletes each destination before copying it, with no
    // staging and no rollback. If release.json lands before the bulk, a copy that
    // dies partway leaves a station claiming the new version with the old code:
    // Get-ReleaseState then reports 'current', the updater exits 0, and re-running
    // it is a silent no-op. Only the full setup recovers that.
    const roots = read('deployment/windows/Update-Spooler.ps1').match(/\$applicationRoots = @\(([\s\S]*?)\)/);
    expect(roots).toBeTruthy();
    const ordered = [...roots[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    const identity = ['package.json', 'package-lock.json', 'release.json'];
    for (const file of identity) {
      expect(ordered, `${file} must be declared`).toContain(file);
    }
    expect(ordered.slice(-identity.length).sort()).toEqual([...identity].sort());
  });

  it('writes AppParameters with the same quoting from both writers', () => {
    // PowerShell strips one layer of quotes building a native command line, so
    // '"' + path + '"' reaches nssm bare. nssm stores AppParameters verbatim and
    // launches "<Application>" <AppParameters>, so a path under Program Files gives
    // node argv[1] = C:\Program. It crash-loops while nssm reports Running, and the
    // ownership check - which expects the quoted form - calls the station
    // unrecognised. The read-back that used to catch this was removed in Task 3.
    const install = read('deployment/windows/Install-Spooler.ps1');
    const update = read('deployment/windows/Update-Spooler.ps1');
    const quoting = /'"""' \+ \$\w+ \+ '"""'/;
    expect(install).toMatch(quoting);
    expect(update).toMatch(quoting);
    expect(update).not.toMatch(/AppParameters \('"' \+ \$\w+ \+ '"'\)/);
  });

  it('still refuses a spooler service that belongs to another installation', () => {
    const remove = read('deployment/windows/Remove-SpoolerRuntime.ps1');
    // Downgrading the ownership refusal left the service NAME as the only thing
    // identifying ours - and the hand-copy installer registers the same name from
    // its own folder. Uninstalling the packaged spooler would then stop and delete
    // a working hand-copy till. `nssm install` writes ImagePath immediately, so an
    // ImagePath we can read that names a different nssm is somebody else's install;
    // one we cannot read is our own unfinished work and still gets cleaned up.
    expect(remove).toMatch(/if \(\$actualExe -and \$actualExe -ne \$expectedExe\)/);
    expect(remove).toContain('Refusing to remove a POS Print Spooler service owned by');
  });

  it('resolves the service by key name, not by display name', () => {
    const remove = read('deployment/windows/Remove-SpoolerRuntime.ps1');
    // Get-Service -Name also matches DisplayName on Windows PowerShell 5.1, while
    // sc.exe knows key names only. Without this, a foreign service merely showing
    // our display name gets Stop-Service -Force'd - taking its dependents down -
    // before sc.exe delete fails 1060 and throws.
    expect(remove).toContain('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$serviceName');
    expect(remove).toMatch(/is displaying the name/);
  });

  it('carries no spooler transaction or startup-recovery model', () => {
    for (const relative of ['deployment/windows/SpoolerLayerState.ps1', 'deployment/windows/Repair-SpoolerStartup.ps1']) {
      expect(fs.existsSync(path.join(ROOT, relative)), `${relative} should be gone`).toBe(false);
    }
    expect(fs.existsSync(path.join(ROOT, 'deployment/windows/InstallerUpdateState.ps1'))).toBe(true);
    for (const relative of [
      'deployment/windows/Install-Spooler.ps1', 'deployment/windows/Update-Spooler.ps1',
      'deployment/windows/Remove-SpoolerRuntime.ps1', 'deployment/spooler/POSAPP-Spooler.iss',
    ]) {
      const source = read(relative);
      expect(source).not.toContain('update-transaction.json');
      expect(source).not.toContain('SpoolerTransactionJournal');
      expect(source).not.toContain('Repair-SpoolerStartup');
      expect(source).not.toContain('SpoolerLayerState');
      expect(source).not.toContain('InstallerUpdateState');
    }
  });

  it('serializes every spooler maintenance surface with one process mutex', () => {
    for (const relative of [
      'deployment/windows/Install-Spooler.ps1', 'deployment/windows/Update-Spooler.ps1',
      'deployment/windows/Remove-SpoolerRuntime.ps1', 'pos-spooler-printer/maintenance/Refresh-Agent.ps1',
    ]) {
      const source = read(relative);
      expect(source).toContain('[Threading.Mutex]::new');
      expect(source).toContain('Global\\POSAPP-Spooler-Service-Mutation');
      expect(source).toContain('WaitOne(0)');
      expect(source).toContain('ReleaseMutex()');
    }
  });

  it('updates by stopping, replacing, and starting while preserving configuration', () => {
    const update = read('deployment/windows/Update-Spooler.ps1');
    const stop = update.indexOf("$phase = 'stop spooler'");
    const replace = update.indexOf("$phase = 'replace application'", stop);
    const start = update.indexOf("$phase = 'start spooler'", replace);
    expect(stop).toBeGreaterThan(-1);
    expect(replace).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(replace);
    expect(update).toContain('Assert-EnvUnchanged');
    expect(update).not.toMatch(/Write-Utf8NoBom\s+\$envPath|Set-Content[^\r\n]*\$envPath/);
  });

  it('keeps core and runtime spooler payloads separate', () => {
    const build = read('scripts/build-installers.ps1');
    const update = read('deployment/windows/Update-Spooler.ps1');
    expect(build).toContain('spooler-update-core');
    expect(build).toContain('spooler-update-runtime');
    expect(update).toContain("[ValidateSet('Core', 'RuntimeTransition')]");
    expect(update).toContain('runtime_transition_required');
    expect(update).toContain('node_modules');
    expect(update).toContain('.cache');
    expect(update).toContain('runtimeSha256');
    expect(update).toContain('Assert-SpoolerPayloadHash');
    // The fresh-install corruption gate was covered by nothing: the only test that
    // executes Install-Spooler.ps1 passes -WhatIf, which returns before this line.
    expect(read('deployment/windows/Install-Spooler.ps1')).toMatch(/^Assert-SpoolerPayloadHash \$PayloadRoot/m);
    expect(update).not.toContain('spooler-installed-layers.json');
    expect(build).toContain("'--stamp-spooler'");
    expect(build).not.toContain('spooler-installed-layers.json');
    expect(build).not.toContain('spooler-layer-manifest.json');
    expect(update).toContain('$runtimeSha256 = if');
    expect(update).toMatch(/\$Mode -eq .Core. -and \$installedRelease\.runtimeSha256 -ne \$targetRelease\.runtimeSha256/);
  });

  it('keeps Typst-only transitions profile-safe and configuration-preserving', () => {
    const build = read('scripts/build-installers.ps1');
    const update = read('deployment/windows/Update-Spooler.ps1');
    expect(build).toContain("runtimeProfile = $runtimeProfile");
    expect(update).toContain('Assert-RuntimeProfilePayload');
    expect(update).toContain("$installedRelease.runtimeProfile -ne $targetRelease.runtimeProfile");
    expect(update).toContain("Remove-Item -LiteralPath (Join-Path $ProgramFilesRoot '.puppeteerrc.cjs')");
    for (const forbidden of ['node_modules\\puppeteer', 'node_modules\\puppeteer-core', 'node_modules\\@puppeteer', '.cache\\puppeteer']) {
      expect(update).toContain(forbidden);
    }
    expect(update).toContain('Assert-EnvUnchanged');
    expect(update).not.toMatch(/Write-Utf8NoBom\s+\$envPath|Set-Content[^\r\n]*\$envPath/);
  });

  it('preflights a Full-to-Typst-only runtime transition without changing station configuration', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-transition-'));
    const payload = path.join(fixture, 'payload');
    const programFiles = path.join(fixture, 'program-files');
    const programData = path.join(fixture, 'program-data');
    const write = (root, relative, contents = 'fixture') => {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    };
    try {
      write(payload, '.cache/typst/0.15.1/typst.exe');
      write(payload, 'node_modules/dotenv/index.js');
      write(payload, 'release.json', JSON.stringify({
        version: '1.2.1', spoolerVersion: '1.2.1', commit: 'b'.repeat(40),
        schemaVersion: 'posapp-fresh-baseline-v1', payloadKind: 'spooler-update-runtime',
        runtimeProfile: 'typst-only'
      }));
      stampSpoolerPayload(payload, 'spooler-update-runtime');

      write(programFiles, 'package.json', JSON.stringify({ version: '1.2.0' }));
      write(programFiles, 'release.json', JSON.stringify({
        spoolerVersion: '1.2.0', commit: 'a'.repeat(40), runtimeSha256: '1'.repeat(64)
      }));
      const nodeTarget = path.join(programFiles, 'runtime/node/node.exe');
      fs.mkdirSync(path.dirname(nodeTarget), { recursive: true });
      fs.copyFileSync(process.execPath, nodeTarget);
      const envPath = path.join(programData, 'config/spooler.env');
      write(programData, 'config/spooler.env', [
        'CLOUD_SERVER_URL=https://pos.example', 'SPOOLER_KEY=secret', 'SPOOLER_ID=station-a',
        'SPOOLER_NAME=Counter A', `SPOOLER_STATE_DIR=${path.join(fixture, 'state')}`, 'SPOOLER_LOG_DIR=C:\\logs',
        'SPOOLER_RENDERER=chromium', ''
      ].join('\r\n'));
      const before = fs.readFileSync(envPath);
      write(path.join(fixture, 'state'), 'jobs/active/pending.json', JSON.stringify({ state: 'queued' }));
      const pending = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Update-Spooler.ps1'),
        '-Mode', 'RuntimeTransition', '-PayloadRoot', payload,
        '-ProgramFilesRoot', programFiles, '-ProgramDataRoot', programData, '-WhatIf'
      ], { encoding: 'utf8' });
      expect(pending.status).not.toBe(0);
      expect(pending.stderr + pending.stdout).toMatch(/Legacy queue still has pending work/);
      fs.rmSync(path.join(fixture, 'state/jobs/active/pending.json'));
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Update-Spooler.ps1'),
        '-Mode', 'RuntimeTransition', '-PayloadRoot', payload,
        '-ProgramFilesRoot', programFiles, '-ProgramDataRoot', programData, '-WhatIf'
      ], { encoding: 'utf8' });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const lines = result.stdout.trim().split(/\r?\n/);
      const outcome = JSON.parse(lines.slice(lines.findIndex(line => line.trim().startsWith('{'))).join('\n'));
      expect(outcome).toMatchObject({ state: 'update', updated: false, mutates: false, mode: 'RuntimeTransition' });
      expect(outcome.installed.runtimeProfile).toBe('full');
      expect(outcome.target.runtimeProfile).toBe('typst-only');
      expect(fs.readFileSync(envPath)).toEqual(before);

      const corePayload = path.join(fixture, 'core-payload');
      write(corePayload, 'release.json', JSON.stringify({
        version: '1.2.1', spoolerVersion: '1.2.1', commit: 'b'.repeat(40),
        schemaVersion: 'posapp-fresh-baseline-v1', payloadKind: 'spooler-update-core',
        runtimeProfile: 'typst-only'
      }));
      stampSpoolerPayload(corePayload, 'spooler-update-core', payload);
      const coreResult = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Update-Spooler.ps1'),
        '-Mode', 'Core', '-PayloadRoot', corePayload,
        '-ProgramFilesRoot', programFiles, '-ProgramDataRoot', programData, '-WhatIf'
      ], { encoding: 'utf8' });
      expect(coreResult.status).not.toBe(0);
      const coreLines = coreResult.stdout.trim().split(/\r?\n/);
      const coreOutcome = JSON.parse(coreLines.slice(coreLines.findIndex(line => line.trim().startsWith('{'))).join('\n'));
      expect(coreOutcome).toMatchObject({ state: 'runtime_transition_required', updated: false, mutates: false, mode: 'Core' });
      expect(fs.readFileSync(envPath)).toEqual(before);

      // A full-profile payload is never a valid update target, even with an explicit rollback flag.
      write(payload, '.puppeteerrc.cjs');
      write(payload, '.cache/puppeteer/chrome-headless-shell/fixture');
      write(payload, 'node_modules/puppeteer/index.js');
      write(payload, 'release.json', JSON.stringify({
        version: '1.2.21', spoolerVersion: '1.2.21', commit: 'c'.repeat(40),
        payloadKind: 'spooler-update-runtime', runtimeProfile: 'full'
      }));
      stampSpoolerPayload(payload, 'spooler-update-runtime');
      write(programFiles, 'release.json', JSON.stringify({
        spoolerVersion: '1.2.22', commit: 'd'.repeat(40), runtimeSha256: '2'.repeat(64), runtimeProfile: 'typst-only'
      }));
      write(programFiles, 'package.json', JSON.stringify({ version: '1.2.22' }));
      const rollback = spawnSync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'deployment/windows/Update-Spooler.ps1'),
        '-Mode', 'RuntimeTransition', '-PayloadRoot', payload,
        '-ProgramFilesRoot', programFiles, '-ProgramDataRoot', programData, '-WhatIf'
      ], { encoding: 'utf8' });
      expect(rollback.status).not.toBe(0);
      expect(rollback.stderr + rollback.stdout).toMatch(/Release identity does not match spooler-update-runtime/);
      expect(fs.readFileSync(envPath)).toEqual(before);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('returns structured failures and keeps the key out of results', () => {
    const update = read('deployment/windows/Update-Spooler.ps1');
    const setup = read('deployment/spooler/POSAPP-Spooler.iss');
    expect(update).toContain("state = 'blocked_incomplete'");
    expect(update).toContain('error = $failure.Exception.Message');
    expect(update).not.toMatch(/Write-Result[\s\S]{0,500}SPOOLER_KEY/);
    expect(setup).toContain("ReadTextFile(ExpandConstant('{commonappdata}\\POS-Spooler\\logs\\update-error.txt'))");
  });

  it('streams progress without exposing configuration', () => {
    const update = read('deployment/windows/Update-Spooler.ps1');
    const setup = read('deployment/spooler/POSAPP-Spooler.iss');
    expect(update).toContain('POSAPP_PROGRESS|');
    expect(update).toContain('[Console]::Out.Flush()');
    expect(setup).toContain('ExecAndLogOutput');
    expect(setup).toContain('POSAPP_PROGRESS|');
  });

  it('still refuses duplicate or legacy services before install mutation', () => {
    const install = read('deployment/windows/Install-Spooler.ps1');
    const gate = install.indexOf('Assert-ExclusiveInstallService');
    const copy = install.indexOf('Copy-Item (Join-Path $PayloadRoot');
    expect(gate).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(gate);
    expect(install).toContain("@('POS Print Spooler', 'POSPrintSpooler', 'POSAPPSpooler')");
    expect(install).toContain('Legacy daemon-based spooler service cannot be installed over');
  });
});
