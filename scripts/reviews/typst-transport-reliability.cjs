// Real Typst -> immutable artifact -> journal/workers/transports -> virtual device.
// Loopback TCP and compiled native Winspool doubles only; no DB/service/paper.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'pos-spooler-printer/tests/fixtures');
const { createRenderer, receiptJob, kitchenJob, asQueueJob } = require(path.join(fixture, 'typst-workload.cjs'));
const { build } = require(path.join(fixture, 'windows/build-fake-helper.cjs'));
const { createTcpTransport, createWindowsTransport } = require('../../pos-spooler-printer/v2/printer-transports');
const { createPrinterWorkers } = require('../../pos-spooler-printer/v2/printer-workers');
const { openJobStore } = require('../../pos-spooler-printer/v2/job-store');
const { startPlatformHelper } = require('../../pos-spooler-printer/v2/platform-helper');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate, timeout = 45000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= end) throw new Error('Simulation exceeded its bounded deadline');
        await delay(25);
    }
}

async function tcpDevice(out, options) {
    const args = [path.join(fixture, 'virtual_printer.py'), '--out', out];
    for (const [key, value] of Object.entries(options)) args.push(`--${key}`, String(value));
    const child = spawn(process.env.PYTHON || 'python', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
    let port, status, exited = false, failure;
    child.on('error', error => { failure = error; });
    child.on('exit', code => { exited = true; if (code) failure = new Error(`Virtual printer exit ${code}`); });
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
        const event = JSON.parse(line);
        if (event.type === 'ready') port = event.port;
        if (event.type === 'status') status = event;
    });
    await waitUntil(() => { if (failure) throw failure; return port; }, 5000);
    return {
        printer: id => ({ printer_id: id, printer_type: 'network', network_ip: '127.0.0.1', network_port: port }),
        transport: createTcpTransport(),
        async finish() {
            await waitUntil(() => status?.buffered === 0 && status?.open === 0);
            child.stdin.end('quit\n');
            await waitUntil(() => exited, 5000);
            if (failure) throw failure;
            const connections = JSON.parse(fs.readFileSync(path.join(out, 'connections.json'))).connections;
            const points = connections.flatMap(c => [[c.accepted_ms, 1], [c.ended_ms, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            let open = 0, peak = 0;
            for (const [, delta] of points) { open += delta; peak = Math.max(peak, open); }
            return { bytes: fs.readFileSync(path.join(out, 'device.bin')), peak_connections: peak };
        },
        async close() { if (!exited) { child.kill(); await waitUntil(() => exited, 5000); } reader.close(); }
    };
}

async function windowsDevice(out, exe, settings) {
    const config = path.join(out, 'config.json');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ out, printers: { Kitchen: settings } }));
    const helper = await startPlatformHelper({ executable: exe, stateRoot: path.join(out, 'helper-state'),
        spawnFn: (file, args, options) => spawn(file, args, { ...options, env: { ...process.env, FAKE_WINSPOOL_CONFIG: config } }) });
    return {
        printer: id => ({ printer_id: id, printer_type: 'windows', printer_name: id % 2 ? 'Kitchen' : 'kitchen' }),
        transport: createWindowsTransport({ helper }),
        async finish() {
            const events = fs.readFileSync(path.join(out, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
            assert(!events.some(e => ['set_job_delete', 'abort_printer'].includes(e.reason)));
            return { bytes: fs.readFileSync(path.join(out, 'Kitchen.bin')), helper_events: events.filter(e => ['retain', 'release', 'deleted'].includes(e.event)) };
        },
        close: () => helper.close()
    };
}

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-typst-transport-'));
    const output = path.join(root, 'scratch/typst-transport-reliability');
    fs.mkdirSync(output, { recursive: true });
    const results = [];
    const renderer = createRenderer(temp);
    try {
        const specs = [await receiptJob(16469, 3), await kitchenJob(501, 4), await kitchenJob(502, 40)];
        const templates = [];
        for (let i = 0; i < specs.length; i++) {
            const artifact = await renderer.render({ ...specs[i], queue_id: i + 1 });
            assert.equal(artifact.renderer, 'typst');
            templates.push({ spec: specs[i], artifact });
        }
        const exe = build(temp).exe;
        const scenarios = [
            { name: 'tcp-alias-burst', tcp: { mode: 'merge', rate: 60000 }, items: [0, 1, 0, 1] },
            { name: 'tcp-long-paper-pause', tcp: { mode: 'merge', rate: 60000, 'stall-at': 30000, 'stall-ms': 5000 }, items: [2, 0] },
            { name: 'windows-alias-burst', windows: { rate: 60000 }, items: [0, 1, 2] },
            { name: 'windows-paper-pause', windows: { rate: 60000, stallAt: 30000, stallMs: 12000 }, items: [1, 0] },
            { name: 'windows-cancel-containment', windows: { rate: 60000, externalCancelAt: 30000 }, items: [1, 0], uncertain: true }
        ];
        for (const scenario of scenarios) {
            const out = path.join(temp, scenario.name);
            const device = scenario.tcp ? await tcpDevice(out, scenario.tcp) : await windowsDevice(out, exe, scenario.windows);
            const store = openJobStore({ stateRoot: path.join(out, 'state') });
            const sendOrder = [];
            const timings = [];
            const workers = createPrinterWorkers({ store, renderer, transportFor: () => ({ send: async options => {
                const start = performance.now();
                sendOrder.push(options.printer.queue_id);
                try { return await device.transport.send(options); }
                finally { timings.push({ queue_id: options.printer.queue_id, send_ms: +(performance.now() - start).toFixed(2) }); }
            } }) });
            const start = performance.now();
            try {
                scenario.items.forEach((index, i) => {
                    const template = templates[index];
                    store.accept(asQueueJob(template.spec, i + 1, device.printer(i % 2 + 1)));
                    store.markRendered(i + 1, template.artifact);
                });
                workers.start();
                await waitUntil(() => scenario.items.every((_, i) => ['completed', 'uncertain'].includes(store.get(i + 1).state)
                    || (scenario.uncertain && store.endpointHolds().some(hold => hold.uncertain))));
                await workers.idle();
                const received = await device.finish();
                const expected = Buffer.concat(sendOrder.map(id => fs.readFileSync(store.get(id).artifact.path)));
                if (scenario.uncertain) {
                    assert.equal(sendOrder.length, 1, 'no ticket follows an interrupted raster');
                    assert(received.bytes.length < expected.length);
                    assert.deepEqual(received.bytes, expected.subarray(0, received.bytes.length));
                    assert.equal(store.get(2).state, 'rendered', 'unsent ticket stays durable');
                    const reopened = openJobStore({ stateRoot: path.join(out, 'state') });
                    assert(reopened.endpointHold(device.printer(2)), 'recovery survives restart');
                } else {
                    assert.deepEqual(received.bytes, expected, `${scenario.name}: no loss, duplication, interleaving or changed raster byte`);
                    if (scenario.tcp) assert.equal(received.peak_connections, 1);
                }
                const result = { scenario: scenario.name, bytes_received: received.bytes.length,
                    expected_bytes: expected.length, complete_and_identical: !scenario.uncertain,
                    next_ticket_held: !!scenario.uncertain, peak_connections: received.peak_connections,
                    elapsed_ms: +(performance.now() - start).toFixed(2), timings };
                results.push(result);
                console.log(JSON.stringify(result));
            } finally { await workers.stop(); await device.close(); }
        }
        fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ measured_at: new Date().toISOString(), node: process.version,
            limits: 'Loopback and native API doubles. Not firmware, paper completion or whole-device memory measurements.', results }, null, 2));
    } finally { await renderer.close(); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
