import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('lightweight managed spooler bootstrap', () => {
    const script = read('deployment/spooler-service/spooler-service.ps1');
    const canonicalInstaller = read('deployment/windows/Install-Spooler.ps1');

    it('uses the canonical installer instead of registering a second service layout', () => {
        expect(script).toContain("Join-Path $stagingRoot 'deployment\\windows\\Install-Spooler.ps1'");
        expect(script).toContain('-PayloadRoot $stagingRoot -ConfigFile $responseFile');
        expect(script).not.toMatch(/@\('install',\s*\$ServiceName/);
        expect(script).not.toContain("'set', $ServiceName, 'AppDirectory'");
        expect(canonicalInstaller).toContain('SPOOLER_NOT_YET_REGISTERED');
        expect(canonicalInstaller).toContain("$ProgramFilesRoot = 'C:\\Program Files\\POS-Spooler'");
        expect(canonicalInstaller).toContain("$ProgramDataRoot = 'C:\\ProgramData\\POS-Spooler'");
    });

    it('hydrates a fresh protected stage and stamps the canonical payload hashes', () => {
        for (const token of [
            "bootstrap-$PID",
            "Invoke-Native 'icacls.exe'",
            "@('ci', '--omit=dev', '--no-audit', '--no-fund')",
            "validate-payload.js",
            "'--stamp-spooler'",
        ]) expect(script).toContain(token);
        expect(script).not.toContain('Dependencies: already present');
        expect(script).not.toMatch(/npm\s+install \(no package-lock/i);
        expect(script.indexOf("node_modules/request")).toBeGreaterThan(script.indexOf("@('ci', '--omit=dev', '--no-audit', '--no-fund')"));
        expect(script.indexOf("node_modules/request")).toBeLessThan(script.indexOf("validate-payload.js"));
        const runtimeOnPath = script.indexOf('$env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"');
        expect(runtimeOnPath).toBeGreaterThan(-1);
        expect(runtimeOnPath).toBeLessThan(script.indexOf("@('ci', '--omit=dev', '--no-audit', '--no-fund')"));
        expect(script).not.toContain('setup-browser');
    });

    it('waits for the elevated bootstrap and returns its real exit code', () => {
        expect(script).toContain('-Verb RunAs -Wait -PassThru');
        expect(script).toContain('exit $elevated.ExitCode');
    });

    it('reads every pinned runtime download from vendor-lock and verifies its checksum', () => {
        expect(script).toContain("deployment\\vendor-lock.json");
        const lock = JSON.parse(read('deployment/vendor-lock.json'));
        const packageNames = [...script.matchAll(/Get-VendorPackage '([^']+)'/g)].map(match => match[1]);
        expect(packageNames.length).toBeGreaterThan(0);
        for (const packageName of packageNames) {
            expect(script).toContain(`Get-VendorPackage '${packageName}'`);
            expect(lock.packages.filter(entry => entry.name === packageName)).toHaveLength(1);
        }
        expect(script.match(/Invoke-WebRequest/g)).toHaveLength(1);
        expect(script).toContain('Get-FileHash');
        expect(script).toContain('$actual -ne ([string]$Package.sha256).ToLowerInvariant()');
        expect(script).toContain('Remove-Item -LiteralPath $Destination -Force');
        expect(script).toContain("Join-Path $stagingRoot '.cache\\typst\\0.15.1'");
        expect(script).toContain("deployment\\tools\\patch-typst-fast-watch.js");
        expect(script).toContain("deployment\\patches\\typst-0.15.1-fast-watch.txt");
        expect(script).toContain("Invoke-Native $nodeExe @($typstPatchTool, (Join-Path $typstRuntime 'typst.exe'))");
        expect(script).toContain("Join-Path $typstRuntime 'POSAPP-PATCH.txt'");
        expect(script).toContain("'^typst 0\\.15\\.1\\b'");
    });

    it('keeps configuration out of arguments and deletes the source secret only after verification', () => {
        for (const required of ['CLOUD_SERVER_URL', 'SPOOLER_KEY', 'SPOOLER_ID', 'SPOOLER_NAME']) {
            expect(script).toContain(`'${required}'`);
        }
        expect(script).toContain('replace-with-the-pos-spooler-key');
        expect(script).toContain('ConvertTo-Json');
        expect(script).toContain('AdditionalEnv = $additionalEnv');
        expect(canonicalInstaller).toContain('$allowedAdditionalEnv');
        expect(script).toContain("Invoke-Native 'icacls.exe' @($responseFile");
        expect(script).toContain('$installVerified = $true');
        expect(script.indexOf('$installVerified = $true')).toBeLessThan(script.indexOf('Remove-Item -LiteralPath $sourceEnv'));
        expect(script).not.toMatch(/-SpoolerKey\s+\$/);
    });

    it('refuses unknown service ownership and preserves state during explicit removal', () => {
        expect(script).toContain('The existing POS Print Spooler is not updater-managed.');
        expect(script).toContain('Run uninstall.cmd from the folder that currently owns it, then run install.cmd again.');
        expect(script).toContain('Test-SamePath $registeredExecutable $sourceNssm');
        expect(script).toContain('Test-SamePath $registeredExecutable $managedNssm');
        expect(script).toContain("Join-Path $ProgramFilesRoot 'deployment\\windows\\Remove-SpoolerRuntime.ps1'");
        expect(script).toContain('config and state were preserved');
        expect(script).not.toMatch(/Remove-Item[^\r\n]*(?:state|config)/i);
    });

    it('checks the actual supported machine floor before downloading anything', () => {
        expect(script).toContain('[Environment]::Is64BitOperatingSystem');
        expect(script).toContain('Get-CimInstance Win32_OperatingSystem');
        expect(script).toContain('$build -lt 17763');
        expect(script.indexOf('$build -lt 17763')).toBeLessThan(script.indexOf('Get-VerifiedArchive'));
    });

    it('ships canonical support files from a current staged release without heavy runtime files', () => {
        const bundler = read('scripts/build-spooler-bundle.js');
        expect(bundler).toContain("require(path.join(ROOT, 'deployment/tools/spooler-layer-manifest.js'))");
        expect(bundler).toContain('APPLICATION_ROOTS');
        expect(bundler).toContain('payload-roots.json');
        for (const support of [
            'deployment/vendor-lock.json',
            'deployment/tools/spooler-layer-manifest.js',
            'deployment/tools/patch-typst-fast-watch.js',
            'deployment/tools/validate-payload.js',
            'deployment/patches/typst-0.15.1-fast-watch.txt',
            'deployment/windows/Install-Spooler.ps1',
            'deployment/windows/Remove-SpoolerRuntime.ps1',
        ]) expect(bundler).toContain(`'${support}'`);
        for (const excluded of ['node_modules', '.cache', 'runtime', 'install', '.env']) {
            expect(bundler).toContain(`'${excluded}'`);
        }
        expect(bundler).toContain('stagedRelease.commit');
        expect(bundler).toContain('gitHead');
        expect(bundler).toContain("'status', '--porcelain'");
        expect(bundler).toContain('does not match HEAD');
        expect(bundler).toContain("validatePayload(STAGE, 'spooler')");
        expect(bundler).toContain('collectInventory(STAGE, APPLICATION_ROOTS)');
        expect(bundler).toContain('Typst and pinned fonts');
        // That call predates the change, so on its own it proves nothing. What the
        // commit actually removed is the attestation comparison.
        expect(bundler).not.toContain('.application.id');
        expect(bundler).toContain("fs.mkdirSync(path.dirname(destination), { recursive: true })");
    });

    it('ships a wrapper for every declared action', () => {
        const declared = script.match(/\[ValidateSet\(([^)]+)\)\]/)[1]
            .split(',').map(value => value.trim().replace(/'/g, ''));
        for (const verb of declared) {
            const wrapper = path.join(ROOT, 'deployment/spooler-service', `${verb}.cmd`);
            expect(fs.existsSync(wrapper), `${verb}.cmd missing`).toBe(true);
            expect(fs.readFileSync(wrapper, 'utf8')).toContain(`-Action ${verb}`);
        }
    });

    it('offers verified reconnect and explicit safe identity rotation after config maintenance', () => {
        const maintenancePath = path.join(ROOT, 'pos-spooler-printer/maintenance/Refresh-Agent.ps1');
        expect(fs.existsSync(maintenancePath)).toBe(true);
        const maintenance = fs.readFileSync(maintenancePath, 'utf8');
        for (const token of [
            'Enter-SpoolerMaintenanceMutex',
            'Get-SpoolerRegistrationStatus',
            'Test-FreshSpoolerSync',
            "Join-Path $stateRoot 'jobs\\active'",
            'LOCAL_JOURNAL_NOT_EMPTY',
            'agent.json.retired-',
            'station_occupied',
            '-Verb RunAs',
            'Get-SpoolerEntryPointPath',
            "@('POS Print Spooler', 'POSPrintSpooler', 'POSAPPSpooler')",
            'Exactly one owned spooler service is required',
        ]) expect(maintenance).toContain(token);
        expect(maintenance.indexOf('LOCAL_JOURNAL_NOT_EMPTY')).toBeLessThan(maintenance.indexOf('Move-Item -LiteralPath $identityPath'));
        expect(maintenance).toContain("if ([string]$baseline.agent_status -in @('active', 'draining'))");
        expect(maintenance.indexOf("if ([string]$baseline.agent_status -in @('active', 'draining'))")).toBeLessThan(maintenance.indexOf('Move-Item -LiteralPath $identityPath'));
        expect(maintenance).not.toMatch(/Remove-Item[^\r\n]*agent\.json/i);
        expect(maintenance).not.toMatch(/Write-(?:Host|Output)[^\r\n]*(?:SPOOLER_KEY|x-spooler-key)/i);
        const cleanup = maintenance.slice(maintenance.lastIndexOf('finally {'));
        expect(cleanup).toContain('Start-Service -Name $serviceName');
        expect(cleanup.indexOf('Start-Service -Name $serviceName')).toBeLessThan(cleanup.indexOf('Exit-SpoolerMaintenanceMutex'));

        expect(script).toContain("'refresh'");
        expect(script).toContain("'rebind'");
        expect(script).toContain("Join-Path $ProgramFilesRoot 'maintenance\\Refresh-Agent.ps1'");
        expect(script).toMatch(/'rebind'[\s\S]*-ResetIdentity/);
        expect(read('deployment/spooler-service/refresh.cmd')).toContain('-Action refresh');
        expect(read('deployment/spooler-service/rebind.cmd')).toContain('-Action rebind');
        expect(read('pos-spooler-printer/maintenance/refresh.cmd')).toContain('Refresh-Agent.ps1');
        expect(read('pos-spooler-printer/maintenance/rebind.cmd')).toContain('-ResetIdentity');

        const manifest = read('deployment/tools/spooler-layer-manifest.js');
        const builder = read('scripts/build-installers.ps1');
        expect(manifest).toContain("'maintenance'");
        expect(builder).toContain("'maintenance'");
    });
});
