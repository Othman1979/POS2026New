const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { build } = require('./fixtures/windows/build-fake-helper.cjs');
const { startPlatformHelper } = require('../v2/platform-helper');

(async () => {
    if (process.platform !== 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-native-watch-'));
    const { exe } = build(root);
    let helper, child;
    const events = [];
    async function waitUntil(predicate, message, timeout = 2000) {
        const deadline = performance.now() + timeout;
        while (!predicate() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert(predicate(), message);
    }
    async function start(printers, suffix) {
        const config = path.join(root, `${suffix}.json`);
        fs.writeFileSync(config, JSON.stringify({ out: path.join(root, suffix), printers }));
        return startPlatformHelper({ executable: exe, stateRoot: path.join(root, `state-${suffix}`),
            onEvent: event => events.push({ ...event, at: performance.now() }),
            spawnFn: (file, args, options) => (child = spawn(file, args, { ...options, env: { ...process.env, FAKE_WINSPOOL_CONFIG: config } })) });
    }
    try {
        const printers = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`Printer${i}`, i === 63
            ? { statusAfterMs: 500, nextStatus: 16 } : {}]));
        helper = await start(printers, 'many');
        const requested = performance.now();
        const response = await helper.watchPrinters(Object.keys(printers));
        assert.deepEqual(response.statuses, [], 'initial status reads must use the asynchronous event stream');
        await waitUntil(() => new Set(events.map(event => event.status?.printer_name)).size === 64,
            'JSON arrays reach the real native watch command and publish all initial statuses');
        const deadline = performance.now() + 1500;
        while (!events.some(event => event.status?.printer_name === 'Printer63' && event.status.device_status === 'paper_out') && performance.now() < deadline)
            await new Promise(resolve => setTimeout(resolve, 10));
        const changed = events.find(event => event.status?.printer_name === 'Printer63' && event.status.device_status === 'paper_out');
        assert(changed, 'last printer notification must not wait behind 63 sequential 200ms waits');
        for (const invalid of [{ printer_names: 'Kitchen' }, { printer_names: [1] }, { printer_names: [''] },
            { printer_names: Array.from({ length: 65 }, (_, i) => `P${i}`) }]) {
            await assert.rejects(helper.request('watch_printers', invalid), error => error.code === 'REQUEST_INVALID');
        }
        const aliasStart = events.length;
        await helper.request('watch_printers', { printer_names: ['Printer0', 'printer0'] });
        await waitUntil(() => events.length > aliasStart, 'deduplicated queue gets an initial status');
        assert.equal(events.slice(aliasStart).filter(event => event.status?.printer_name?.toLowerCase() === 'printer0').length, 1);
        const replacement = performance.now();
        assert.equal((await helper.watchPrinters([])).statuses.length, 0);
        assert(performance.now() - replacement < 1000, 'watch replacement stops the former waiter promptly');
        await helper.close();
        assert.equal((await helper.exited).code, 0);
        helper = await start({}, 'missing');
        await helper.watchPrinters(['MissingPrinter']);
        await waitUntil(() => events.some(event => event.status?.printer_name === 'MissingPrinter' && event.status.device_status === 'offline'),
            'missing queues still publish their initial status without a notification handle');
        // Measure actual child CPU with no fake printer threads to hide a busy loop.
        const sample = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$p=[Diagnostics.Process]::GetProcessById(${child.pid}); $p.Refresh(); $before=$p.TotalProcessorTime.TotalMilliseconds; $clock=[Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds 1200; $p.Refresh(); @{cpu_ms=($p.TotalProcessorTime.TotalMilliseconds-$before);wall_ms=$clock.Elapsed.TotalMilliseconds}|ConvertTo-Json -Compress`],
        { encoding: 'utf8', windowsHide: true }));
        assert(sample.cpu_ms < sample.wall_ms * 0.2, `empty watch must sleep, used ${sample.cpu_ms} CPU ms`);
        console.log(JSON.stringify({ test: 'native printer status watch', printers: 64,
            event_after_request_ms: changed.at - requested, empty_watch: sample }));
        await helper.close();
        helper = await start({ SlowStatus: { statusDelayMs: 800 }, Register: { rate: 500000 } }, 'slow-status');
        const watching = helper.watchPrinters(['SlowStatus']);
        await new Promise(resolve => setTimeout(resolve, 50));
        const bytes = Buffer.alloc(2000, 0xa5);
        const artifact = path.join(root, 'fast.bin');
        fs.writeFileSync(artifact, bytes);
        const submitted = performance.now();
        const printed = await helper.request('print_raw', { printer_name: 'Register', artifact_path: artifact,
            artifact_sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        const submissionMs = performance.now() - submitted;
        assert(submissionMs < 500, `slow status read blocked independent print submission for ${submissionMs.toFixed(1)} ms`);
        const completed = await helper.request('wait_job', { printer_name: 'Register', job_id: printed.job_id,
            retained: true, drain_ms: 2000, drain_strategy: 'notify' });
        assert.equal(completed.device_status, 'drained');
        assert.deepEqual(fs.readFileSync(path.join(root, 'slow-status', 'Register.bin')), bytes);
        await watching;
        await waitUntil(() => events.some(event => event.status?.printer_name === 'SlowStatus'), 'slow status query eventually publishes its snapshot');
        console.log(JSON.stringify({ test: 'slow Windows status query', simulated_status_query_ms: 1600, independent_submission_ms: submissionMs }));
    } finally { await helper?.close(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
