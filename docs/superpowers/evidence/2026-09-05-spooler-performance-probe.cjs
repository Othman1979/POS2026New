// Local-only audit. No customer printers, database, or network endpoints.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../../../pos-spooler-printer/package.json'));
const { createArtifactRenderer } = req('./v2/artifact-renderer');
const { createPrinterWorkers } = req('./v2/printer-workers');
const { createTcpTransport } = req('./v2/printer-transports');
const net = require('node:net');
const crypto = require('node:crypto');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-performance-audit-'));

async function tcpProbe() {
    const peers = new Set(), clients = [];
    const server = net.createServer({ allowHalfOpen: true }, socket => {
        peers.add(socket); socket.on('data', () => {}); socket.on('error', () => {});
        socket.on('close', () => peers.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const printer = { network_ip: '127.0.0.1', network_port: server.address().port };
    const transport = createTcpTransport({ net: { ...net, Socket: class extends net.Socket {
        constructor() { super(); clients.push(this); }
    } } });
    const file = req.resolve('./package.json');
    const contents = fs.readFileSync(file);
    try {
        for (let i = 0; i < 3; i++) await transport.send({ printer,
            artifact: { path: file, bytes: contents.length, hash: crypto.createHash('sha256').update(contents).digest('hex') }, markTransportStarted() {} });
        await delay(150);
        assert.equal(clients.filter(s => !s.destroyed).length, 0);
        console.log(JSON.stringify({ experiment: 'half_open_peer', successfulSends: 3, openClients: clients.filter(s => !s.destroyed).length, openPeers: peers.size }));
        for (const capability of ['write_only', 'escpos_status']) {
            const before = clients.length, start = performance.now();
            let result;
            try { result = await transport.probe({ ...printer, status_capability: capability }); }
            catch (error) { result = error.code; }
            console.log(JSON.stringify({ experiment: 'nonresponding_probe', capability, wallMs: Math.round(performance.now() - start), connections: clients.length - before, result }));
        }
    } finally {
        clients.forEach(socket => socket.destroy()); peers.forEach(socket => socket.destroy());
        await new Promise(resolve => server.close(resolve));
    }
}

async function retryProbe() {
    let row = { queue_id: 1, printer_id: 1, state: 'queued', created_at: new Date().toISOString(), job: { queue_id: 1, printer_id: 1, print_type: 'kitchen', data: {} } };
    const store = {
        get: () => row,
        runnable: () => ['queued', 'rendered', 'retry_wait'].includes(row.state) ? [row] : [],
        markRendered: (_, artifact) => { row = { ...row, state: 'rendered', artifact }; return row; },
        recordRetry: (_, result) => { row = { ...row, state: 'retry_wait', result }; },
        markTransportStarted: () => { row = { ...row, state: 'transport_started' }; },
        recordResult: (_, result) => { row = { ...row, state: result.outcome, result }; }
    };
    let renders = 0, sends = 0, retry;
    let clock = Date.now();
    const workers = createPrinterWorkers({ store, now: () => clock,
        timers: { setTimeout: (fn, ms) => { retry = () => { clock += ms; fn(); }; return 1; }, clearTimeout() {} },
        renderer: { render: async () => { renders++; return { path: 'unused', bytes: 1, hash: 'a' }; } },
        transportFor: () => ({ send: async ({ markTransportStarted }) => {
            sends++;
            if (sends === 1) throw Object.assign(new Error('controlled pre-byte connection refusal'), { code: 'ECONNREFUSED', failureClass: 'transient_safe' });
            markTransportStarted(); return { success: true, confidence: 'bytes_sent' };
        } })
    });
    workers.start(); await workers.idle();
    assert.equal(row.state, 'retry_wait');
    retry(); await workers.idle(); await workers.stop();
    assert.equal(row.state, 'completed');
    assert.equal(renders, 1, 'transport retry must reuse its artifact');
    console.log(JSON.stringify({ experiment: 'prebyte_retry', renders, sends, state: row.state }));
}

async function pageDeadlineProbe() {
    let rejectPage;
    const renderer = createArtifactRenderer({ stateRoot: root, canvas: {}, limits: { renderMs: 30 },
        puppeteer: { launch: async () => ({ isConnected: () => true,
            newPage: () => new Promise((_, reject) => { rejectPage = reject; }), close: async () => {} }) }
    });
    let settled = false;
    const run = renderer.renderHtml({ queue_id: 2 }, '<body id="receipt-body">test</body>').catch(() => {}).finally(() => { settled = true; });
    await delay(120);
    console.log(JSON.stringify({ experiment: 'newPage_deadline', configuredRenderMs: 30, observedAfterMs: 120, settled }));
    assert.equal(settled, true);
    rejectPage(new Error('audit cleanup')); await run; await renderer.close();
}

async function laneProbe() {
    const rows = [];
    const sent = [];
    const store = {
        get: id => rows.find(row => row.queue_id === id),
        runnable: () => rows.filter(row => row.state === 'queued' || row.state === 'rendered'),
        markRendered(id, artifact) { Object.assign(this.get(id), { state: 'rendered', artifact }); },
        markTransportStarted(id) { this.get(id).state = 'transport_started'; },
        recordResult(id, result) { this.get(id).state = result.outcome; }
    };
    const workers = createPrinterWorkers({ store,
        renderer: { render: async () => ({ path: 'unused', bytes: 1, hash: 'a' }) },
        transportFor: job => ({ send: async ({ markTransportStarted }) => {
            markTransportStarted(); sent.push(job.printer_id); return { success: true };
        } })
    });
    workers.start(); await workers.idle();
    let release;
    const probe = workers.runExclusive(1, 'probe', signal => new Promise(resolve => {
        release = resolve;
        signal.addEventListener('abort', () => resolve({ skipped: true }), { once: true });
    }));
    for (const id of [1, 2]) rows.push({ queue_id: id, printer_id: id, state: 'queued', created_at: new Date().toISOString(), job: { queue_id: id, printer_id: id, print_type: 'kitchen' } });
    workers.wake(); await delay(30);
    assert.equal(sent.length, 2);
    console.log(JSON.stringify({ experiment: 'probe_lane_contention', sentAfterPreemption: [...sent] }));
    release({}); await probe; await workers.idle(); await workers.stop();
    assert.deepEqual([...sent].sort(), [1, 2]);
}

async function realRendering() {
    // Run from pos-spooler-printer so Puppeteer resolves its project cache config.
    process.chdir(path.resolve(__dirname, '../../../pos-spooler-printer'));
    const renderer = createArtifactRenderer({ stateRoot: root, puppeteer: req('puppeteer'), canvas: req('canvas') });
    try {
        for (const [index, rows] of [1, 1, 10, 50].entries()) {
            const start = performance.now();
            const html = '<html><body style="margin:0"><div id="receipt-body" style="width:576px;font:24px Arial">'
                + '<div style="height:40px">Kitchen / مطبخ — test item × 1</div>'.repeat(rows) + '</div></body></html>';
            const artifact = await renderer.renderHtml({ queue_id: 100 + index, print_type: 'kitchen', data: {} }, html);
            console.log(JSON.stringify({ experiment: 'real_browser_synthetic_kitchen', cold: index === 0, rows, wallMs: Math.round(performance.now() - start), bytes: artifact.bytes, height: artifact.height }));
        }
        const start = performance.now();
        const artifact = await renderer.render(req('./tests/fixtures/v2-report-200-rows'));
        console.log(JSON.stringify({ experiment: 'real_browser_existing_200row_report', wallMs: Math.round(performance.now() - start), bytes: artifact.bytes, height: artifact.height }));
    } finally { await renderer.close(); }
}

(async () => {
    console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: os.cpus()[0].model }));
    await retryProbe(); await pageDeadlineProbe(); await laneProbe(); await tcpProbe(); await realRendering();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    // Only the directory returned by mkdtemp above is removed.
    fs.rmSync(root, { recursive: true, force: true });
});
