const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { build } = require('./fixtures/windows/build-fake-helper.cjs');
const { startPlatformHelper } = require('../v2/platform-helper');
const { createWindowsTransport } = require('../v2/printer-transports');

// Compile the actual helper, replacing only Winspool calls with a FIFO device.
// No OS printer/service/database is contacted. Timed pauses are device fixtures.
(async () => {
    if (process.platform !== 'win32') { console.log('SKIP v2-windows-delivery: the native helper needs Windows'); return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-windows-delivery-'));
    const { exe } = build(root);
    const bytes = Buffer.alloc(150000, 0xa5);
    const artifact = { path: path.join(root, 'ticket.bin'), bytes: bytes.length,
        hash: crypto.createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(artifact.path, bytes);
    const results = [];
    try {
        for (const scenario of [
            { name: 'normal', settings: { rate: 500000 } },
            { name: 'partial-writes', settings: { rate: 500000, partialWrite: 511 } },
            { name: 'retain-unsupported', settings: { rate: 500000, retainFails: true }, warning: 'WINspool_RETAIN_UNSUPPORTED', noRetain: true },
            { name: 'release-failure', settings: { rate: 500000, releaseFails: true }, warning: 'WINspool_RETENTION_RELEASE_FAILED' },
            { name: 'paper-change', settings: { rate: 500000, stallAt: 30000, stallMs: 12000 } },
            { name: 'direct-write', settings: { rate: 500000, direct: true, stallAt: 30000, stallMs: 10500 } },
            { name: 'operator-cancel', settings: { rate: 100000, externalCancelAt: 30000 }, error: /WINspool_JOB_(DELETED|MISSING)/ },
            // A stall longer than one observation window is not an outcome: the OS keeps
            // the job and prints it when the device recovers, so observation repeats.
            { name: 'long-stall', settings: { rate: 500000, stallAt: 30000, stallMs: 3000 }, drain: 2000, minWaits: 2 }
        ]) {
            const out = path.join(root, scenario.name);
            const config = path.join(root, `${scenario.name}.json`);
            fs.writeFileSync(config, JSON.stringify({ out, printers: { Kitchen: scenario.settings, Register: { rate: 500000 } } }));
            const helper = await startPlatformHelper({ executable: exe, stateRoot: path.join(root, `state-${scenario.name}`),
                spawnFn: (file, args, options) => spawn(file, args, { ...options, env: { ...process.env, FAKE_WINSPOOL_CONFIG: config } }) });
            const commands = [];
            const transport = createWindowsTransport({ helper: { ...helper, request: (command, payload, options) => { commands.push(command); return helper.request(command, payload, options); } } });
            const started = Date.now();
            try {
                const sentMarks = [];
                const operation = () => transport.send({ printer: { printer_name: 'Kitchen', drain_ms: scenario.drain }, artifact, markTransportStarted() {}, markTransportSent: details => sentMarks.push(details) });
                if (scenario.error) {
                    await assert.rejects(operation(), error => scenario.error.test(error.code) && error.failureClass === 'uncertain' && error.streamIntact !== true);
                } else {
                    const result = await operation();
                    assert.equal(result.confidence, 'spooler_drained');
                    assert.equal(result.warningCode, scenario.warning || null);
                    assert.equal(sentMarks[0]?.windows_job_id, result.windowsJobId, 'the sent marker carries the OS job id');
                    assert.deepEqual(fs.readFileSync(path.join(out, 'Kitchen.bin')), bytes);
                }
                assert.equal(commands[0], 'print_raw');
                assert(commands.slice(1).every(command => command === 'wait_job'));
                if (scenario.minWaits) assert(commands.length - 1 >= scenario.minWaits, `observation repeated while the OS still held the job (${commands.length - 1} windows)`);
                // Observation expiry leaves the existing OS job intact; it can
                // finish after paper returns. Sending to another device is safe.
                if (scenario.drain) {
                    await transport.send({ printer: { printer_name: 'Register' }, artifact, markTransportStarted() {} });
                    for (let i = 0; i < 60 && fs.statSync(path.join(out, 'Kitchen.bin')).size < bytes.length; i++)
                        await new Promise(resolve => setTimeout(resolve, 50));
                    assert.deepEqual(fs.readFileSync(path.join(out, 'Kitchen.bin')), bytes);
                }
                const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
                assert(!events.some(e => e.reason === 'set_job_delete' || e.reason === 'abort_printer'), 'our deadlines never truncate OS documents');
                assert.equal(events.some(e => e.event === 'retain'), !scenario.noRetain);
                if (!scenario.error && !scenario.warning) assert(events.some(e => e.event === 'release'));
                results.push({ scenario: scenario.name, ms: Date.now() - started, observation_windows: commands.length - 1, result: scenario.error ? 'uncertain, no automatic cancel' : 'complete bytes' });
            } finally { await helper.close(); }
        }
        // Closing the parent's input pipe must not terminate a native direct write.
        const out = path.join(root, 'parent-eof');
        const config = path.join(root, 'parent-eof.json');
        fs.writeFileSync(config, JSON.stringify({ out, printers: { Kitchen: { rate: 500000, direct: true } } }));
        const child = spawn(exe, ['--state-root', path.join(root, 'parent-eof-state')], {
            windowsHide: true, env: { ...process.env, FAKE_WINSPOOL_CONFIG: config }, stdio: ['pipe', 'pipe', 'pipe']
        });
        try {
            let output = '';
            child.stdout.on('data', chunk => { output += chunk; });
            const ended = new Promise(resolve => child.once('exit', resolve));
            child.stdin.end(JSON.stringify({ id: 1, command: 'print_raw', payload: {
                printer_name: 'Kitchen', artifact_path: artifact.path, artifact_sha256: artifact.hash
            } }) + '\n');
            assert.equal(await ended, 0);
            assert.deepEqual(fs.readFileSync(path.join(out, 'Kitchen.bin')), bytes);
            assert(output.includes('"device_status":"submitted"'), 'native worker completes the submission after protocol EOF');
            results.push({ scenario: 'parent-eof', result: 'native write completed before process exit' });
        } finally { if (child.exitCode === null) child.kill(); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    console.table(results);
    console.log('v2-windows-delivery tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
