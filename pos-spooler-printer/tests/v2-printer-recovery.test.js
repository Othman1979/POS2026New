const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { openJobStore } = require('../v2/job-store');
const { acquireStateRootLock } = require('../v2/state-root-lock');

// Run the actual CLI and native state mutex in an isolated installed-file layout.
// No printer API is invoked: the helper only establishes/relinquishes its mutex.
(() => {
    if (process.platform !== 'win32') { console.log('SKIP native recovery CLI test: Windows required'); return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-recovery-cli-'));
    const source = path.resolve(__dirname, '..');
    const stateRoot = path.join(root, 'state');
    try {
        for (const file of ['recover-printer.js', 'v2/job-store.js', 'v2/printer-endpoint.js', 'v2/platform-helper.js', 'v2/state-root-lock.js']) {
            const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(source, file), dest);
        }
        fs.mkdirSync(path.join(root, 'bin'));
        execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
            '/nologo', '/optimize+', '/target:exe', `/out:${path.join(root, 'bin/PosSpoolerPlatform.exe')}`,
            '/r:System.Web.Extensions.dll', '/r:System.Security.dll', path.join(source, 'windows-helper/PosSpoolerPlatform.cs')
        ]);
        let store = openJobStore({ stateRoot });
        const job = id => ({ queue_id: id, printer_id: 4, printer_type: 'network', network_ip: '192.0.2.5', network_port: 9100,
            print_type: 'kitchen', idempotency_key: `recover-${id}`, payload_hash: 'a'.repeat(64) });
        store.accept(job(1)); store.markTransportStarted(1); store.recordResult(1, { outcome: 'uncertain' });
        store.accept(job(2));
        const run = args => spawnSync(process.execPath, [path.join(root, 'recover-printer.js'), '--state-root', stateRoot, ...args], {
            cwd: root, encoding: 'utf8', timeout: 10000,
            env: { ...process.env, SPOOLER_ENV_FILE: path.join(root, 'fixture.env'), NODE_PATH: path.join(source, 'node_modules') }
        });
        const lock = acquireStateRootLock({ stateRoot });
        try { const result = run([]); assert.notEqual(result.status, 0); assert.match(result.stderr, /STATE_ROOT_LOCKED/); }
        finally { lock.release(); }
        const listed = run([]); assert.equal(listed.status, 0, listed.stderr); assert.match(listed.stdout, /tcp:\[192\.0\.2\.5\]:9100/);
        const refused = run(['--queue-id', '1']); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /CONFIRMATION_REQUIRED/);
        const recovered = run(['--queue-id', '1', '--confirm-queue-cleared', '--confirm-printer-reset']);
        assert.equal(recovered.status, 0, recovered.stderr); assert.match(recovered.stdout, /"reprinted":false/);
        store = openJobStore({ stateRoot });
        assert.equal(store.endpointHold(job(1)), null);
        assert.equal(store.get(1).state, 'uncertain');
        assert.equal(store.get(2).state, 'queued');
        console.log('v2-printer-recovery tests passed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
})();
