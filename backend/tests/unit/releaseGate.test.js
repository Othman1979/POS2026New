const { requireReleaseChecks, requiredResults } = require('../../../scripts/ci/require-release-checks.cjs');
const { collectDiagnostics, collectWindowsDiagnostics } = require('../../../scripts/ci/database-diagnostics.cjs');
const { verifyWindowsSelfHostedRunner } = require('../../../scripts/ci/windows-self-hosted-preflight.cjs');
const { verifyBrowserResult } = require('../../../scripts/ci/release-browser.cjs');
const { sha256Text } = require('../../../scripts/verify-fontawesome-subset.cjs');

describe('required release evidence', () => {
    const passed = () => Object.fromEntries(requiredResults.map(key => [key, 'success']));
    it('verifies generated CSS independently of Windows line endings', () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-css-hash-'));
        const lf = path.join(directory, 'lf.css');
        const crlf = path.join(directory, 'crlf.css');
        try {
            fs.writeFileSync(lf, '.a { color: red; }\n.b { color: blue; }\n');
            fs.writeFileSync(crlf, '.a { color: red; }\r\n.b { color: blue; }\r\n');
            expect(sha256Text(crlf)).toBe(sha256Text(lf));
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    it('accepts all successful jobs', () => expect(() => requireReleaseChecks(passed())).not.toThrow());
    it.each(requiredResults.flatMap(key => ['skipped', 'failure', 'cancelled', undefined].map(status => [key, status])))(
        'rejects %s = %s even when every other job passed', (key, status) => {
            expect(() => requireReleaseChecks({ ...passed(), [key]: status })).toThrow(key);
        }
    );
    const permissionResult = () => ({ complete: true, removed: true, pageErrors: [], runs: [['en',1440],['ar',390]].map(([language,width]) => ({
        language, width, firstSave: 200, laterEditDenied: 403, lostCreateReplyRecovered: true, approvalKeepsCashierRole: true
    })) });
    it('rejects missing Arabic evidence, baseline-only results, page errors and unremoved fixtures', () => {
        expect(() => verifyBrowserResult('permissions-browser.cjs', permissionResult())).not.toThrow();
        for (const change of [
            { runs: permissionResult().runs.slice(0, 1) }, { complete: false }, { removed: false },
            { pageErrors: ['Uncaught error'] }, { runs: [{ language: 'en', width: 1440, baseline: true }] }
        ]) expect(() => verifyBrowserResult('permissions-browser.cjs', { ...permissionResult(), ...change })).toThrow();
    });
    it('retains container state and host diagnostics even when SQL and logs cannot run', () => {
        const execute = vi.fn((command, args) => ({ status: args[0] === 'exec' ? 1 : 0, stdout: command === 'free' ? 'memory available' : '', stderr: 'database unavailable' }));
        const report = collectDiagnostics('abcdef123456', execute);
        expect(report.innodb.status).toBe(1);
        expect(report.hostMemory.stdout).toBe('memory available');
        expect(execute.mock.calls[0][1]).toEqual(['inspect', '--format', '{{json .State}}', 'abcdef123456']);
        expect(execute.mock.calls.every(call => call[2].timeout === 10000)).toBe(true);
        expect(() => collectDiagnostics('other; command', execute)).toThrow();
    });
    it('accepts only a Windows loopback disposable database for the self-hosted gate', async () => {
        const connection = { query: vi.fn().mockResolvedValueOnce([[{ version: '10.4.32', port: 3306 }]]).mockResolvedValueOnce([{}]), end: vi.fn() };
        await expect(verifyWindowsSelfHostedRunner({ DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'posapp_test' }, {
            platform: 'win32', createConnection: vi.fn().mockResolvedValue(connection)
        })).resolves.toMatchObject({ database: 'posapp_test', version: '10.4.32', port: 3306 });
        expect(connection.query.mock.calls[1][0]).toContain('CREATE DATABASE IF NOT EXISTS `posapp_test`');
        await expect(verifyWindowsSelfHostedRunner({ DB_HOST: 'db.example.com', DB_NAME: 'posapp_test' }, { platform: 'win32' }))
            .rejects.toThrow('loopback-only');
        await expect(verifyWindowsSelfHostedRunner({ DB_HOST: '127.0.0.1', DB_NAME: 'posapp' }, { platform: 'win32' }))
            .rejects.toThrow('Refusing release gate database');
    });
    it('captures local Windows service and MariaDB diagnostics without printing configuration', async () => {
        const execute = vi.fn().mockReturnValue({ status: 0, stdout: '{"Name":"mysql","Status":4}', stderr: '' });
        const connection = {
            query: vi.fn().mockResolvedValueOnce([[{ Variable_name: 'Uptime', Value: '10' }]])
                .mockResolvedValueOnce([[{ Status: 'InnoDB healthy' }]]),
            end: vi.fn().mockResolvedValue()
        };
        const report = await collectWindowsDiagnostics({ DB_HOST: '127.0.0.1' }, {
            execute, createConnection: vi.fn().mockResolvedValue(connection)
        });
        expect(report.service.stdout).toContain('mysql');
        expect(report.database.innodb).toBe('InnoDB healthy');
        expect(execute.mock.calls[0][0]).toBe('powershell.exe');
    });
    it('clears previous browser success before launching a child and retains failure evidence', () => {
        const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
        const directory = path.resolve(__dirname, '../../../scripts/ci');
        const summaryPath = path.resolve(directory, '../../scratch/release-browser.json');
        const files = new Map([[summaryPath, JSON.stringify({ complete: true, workflows: [{ passed: true }] })]]);
        const fakeModule = { exports: {} }, fakeProcess = { execPath: process.execPath, env: {} };
        let atLaunch;
        const modules = {
            'node:fs': { mkdirSync() {}, rmSync: file => files.delete(file), writeFileSync: (file, value) => files.set(file, value) },
            'node:child_process': { spawnSync() {
                atLaunch = JSON.parse(files.get(summaryPath));
                return { status: 1 };
            } }
        };
        const fakeRequire = name => modules[name] || require(name);
        fakeRequire.main = fakeModule;
        vm.runInNewContext(fs.readFileSync(path.join(directory, 'release-browser.cjs'), 'utf8'), {
            require: fakeRequire, module: fakeModule, __dirname: directory, process: fakeProcess, console: { error() {} }
        });
        expect(atLaunch).toEqual({ complete: false, workflows: [] });
        expect(fakeProcess.exitCode).toBe(1);
        expect(JSON.parse(files.get(summaryPath))).toEqual({ complete: false, workflows: [] });
    });
});
