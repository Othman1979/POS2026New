const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { build } = require('./fixtures/windows/build-fake-helper.cjs');
const { startPlatformHelper } = require('../v2/platform-helper');

// Actual helper protocol/threads, simulated Winspool. No OS printer is contacted.
(async () => {
    if (process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-observation-'));
    const { exe } = build(root);
    const bytes = Buffer.alloc(50000, 0xa5);
    const artifact = path.join(root, 'ticket.bin');
    fs.writeFileSync(artifact, bytes);
    const common = { artifact_path: artifact, artifact_sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    let helper;
    try {
        const config = path.join(root, 'fake.json');
        const output = path.join(root, 'output');
        fs.writeFileSync(config, JSON.stringify({ out: output, printers: {
            Kitchen: { rate: 500000, stallAt: 1000, stallMs: 3500 }, Register: { rate: 500000 }
        } }));
        helper = await startPlatformHelper({ executable: exe, stateRoot: path.join(root, 'state'),
            spawnFn: (file, args, options) => spawn(file, args, { ...options, env: { ...process.env, FAKE_WINSPOOL_CONFIG: config } }) });
        const first = await helper.request('print_raw', { ...common, printer_name: 'Kitchen' });
        const observe = helper.request('wait_job', { printer_name: 'Kitchen', job_id: first.job_id,
            retained: true, drain_ms: 3000, drain_strategy: 'notify' });
        await new Promise(resolve => setTimeout(resolve, 50));
        const start = performance.now();
        const second = await helper.request('print_raw', { ...common, printer_name: 'Register' });
        const secondMs = performance.now() - start;
        assert(secondMs < 1000, `independent Windows printer blocked for ${secondMs.toFixed(1)} ms`);
        const secondResult = await helper.request('wait_job', { printer_name: 'Register', job_id: second.job_id,
            retained: true, drain_ms: 2000, drain_strategy: 'notify' });
        assert.equal(secondResult.device_status, 'drained');
        assert.deepEqual(fs.readFileSync(path.join(output, 'Register.bin')), bytes);
        const initial = await observe;
        assert.equal(initial.device_status, 'queued', 'a paper delay keeps the first OS job intact');
        const recovered = await helper.request('wait_job', { printer_name: 'Kitchen', job_id: first.job_id,
            retained: true, drain_ms: 2000, drain_strategy: 'notify' });
        assert.equal(recovered.device_status, 'drained');
        assert.deepEqual(fs.readFileSync(path.join(output, 'Kitchen.bin')), bytes);
        const events = fs.readFileSync(path.join(output, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert(!events.some(event => ['set_job_delete', 'abort_printer'].includes(event.reason)));
        console.log(JSON.stringify({ test: 'independent Windows observation', second_submission_ms: secondMs,
            first_observation_ms: 3000, both_artifacts_complete: true }));
        await helper.close();
        fs.writeFileSync(config, JSON.stringify({ out: path.join(root, 'bounded-output'), printers: {
            Kitchen: { rate: 500000, stallAt: 1000, stallMs: 120000 }
        } }));
        helper = await startPlatformHelper({ executable: exe, stateRoot: path.join(root, 'bounded-state'),
            spawnFn: (file, args, options) => spawn(file, args, { ...options, env: { ...process.env, FAKE_WINSPOOL_CONFIG: config } }) });
        const paused = await helper.request('print_raw', { ...common, printer_name: 'Kitchen' });
        const wait = { printer_name: 'Kitchen', job_id: paused.job_id, retained: true, drain_ms: 60000, drain_strategy: 'notify' };
        const outstanding = Array.from({ length: 64 }, () => helper.request('wait_job', wait, { timeoutMs: 65000 }).catch(error => error));
        await assert.rejects(helper.request('wait_job', wait), error => error.code === 'PLATFORM_HELPER_BUSY');
        const closeAt = performance.now();
        await helper.close();
        await Promise.all(outstanding);
        assert.equal((await helper.exited).code, 0, 'EOF releases observations without forcibly killing the helper');
        console.log(JSON.stringify({ test: 'bounded Windows observations', maximum: 64, graceful_close_ms: performance.now() - closeAt }));
    } finally {
        await helper?.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
