// Real Typst and durable artifacts; no printer or application database.
// SPOOLER_TYPST_EXE/FONT_DIR may point at the pinned external runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const root = path.resolve(__dirname, '../..');
const spooler = path.join(root, 'pos-spooler-printer');
const report = require(path.join(spooler, 'tests/fixtures/v2-report-200-rows'));
const source = ['typst-renderer.js', 'compiled-document-typst.js', 'report-typst.js'].map(name => fs.readFileSync(path.join(spooler, 'v2', name), 'utf8')).join('\n');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-spooler-render-audit-'));
const receiptTransport = process.env.SPOOLER_RECEIPT_TRANSPORT === '1';
const noDelay = process.env.SPOOLER_TCP_NODELAY === '1';
let receiver;
let pendingDelivery;
const peers = new Set();
const { createTcpTransport } = require(path.join(spooler, 'v2/printer-transports'));
const transport = createTcpTransport({ net: noDelay ? { isIP: net.isIP, Socket: class extends net.Socket { constructor() { super(); this.setNoDelay(true); } } } : net });
const { createTypstRenderer } = require(path.join(spooler, 'v2/typst-renderer'));
const renderer = createTypstRenderer({ stateRoot: scratch, executable: process.env.SPOOLER_TYPST_EXE, fontPath: process.env.SPOOLER_TYPST_FONT_DIR, env: {} });
const compiledOnly = process.env.SPOOLER_COMPILED_ONLY === '1';
const jobs = compiledOnly ? [] : [
    { name: 'receipt', job: { queue_id: 9101, print_type: 'receipt', data: {
        storeInfo: { store_name: 'مطعم الاختبار' },
        items: Array.from({ length: 8 }, (_, i) => ({ name: `وجبة ${i + 1} Meal`, qty: 2, price: 3.5, total: 7 })), total: 56
    } } },
    { name: 'kitchen', job: { queue_id: 9102, print_type: 'kitchen', data: {
        storeInfo: { store_name: 'مطعم الاختبار' },
        items: Array.from({ length: 12 }, (_, i) => ({ name: `وجبة ${i + 1} Meal`, qty: 2, note: 'بدون بصل — no onion' }))
    } } },
    { name: 'report_200_rows', job: report }
];
(async () => {
    if (process.env.SPOOLER_RESOURCE_READY) {
        while (!fs.existsSync(process.env.SPOOLER_RESOURCE_READY)) await new Promise(resolve => setTimeout(resolve, 20));
    }
    const { getBuiltinTemplate, getTemplateFixture, listTemplateFixtures } = require(path.join(root, 'backend/services/printTemplateDefaults'));
    const { compileTemplate } = require(path.join(root, 'backend/services/printTemplateEngine'));
    for (const type of ['receipt', 'kitchen']) {
        for (const { key } of listTemplateFixtures(type)) {
            const { artifact } = await compileTemplate(getBuiltinTemplate(type), getTemplateFixture(type, key), {
                mode: 'runtime', templateRevisionId: `builtin:${type}-v1`, printRequestedAt: '2026-09-07T00:00:00.000Z'
            });
            jobs.push({ name: `compiled_${key}`, job: { queue_id: 9300 + jobs.length, print_type: type, data: { compiled_document_v1: artifact } } });
        }
    }
    const output = { renderer: 'typst', compiled_only: compiledOnly, renderer_sha256: crypto.createHash('sha256').update(source).digest('hex'), node: process.version, samples: [] };
    output.receipt_transport = receiptTransport;
    output.tcp_no_delay = noDelay;
    if (receiptTransport) {
        receiver = net.createServer(socket => {
            peers.add(socket); socket.on('close', () => peers.delete(socket));
            const delivery = pendingDelivery;
            const hash = crypto.createHash('sha256'); let bytes = 0;
            socket.on('error', error => delivery.reject(error));
            socket.on('data', chunk => {
                if (!bytes) delivery.firstByteMs = performance.now() - delivery.start;
                bytes += chunk.length; hash.update(chunk);
            });
            socket.on('end', () => delivery.resolve({ bytes, hash: hash.digest('hex'), first_byte_ms: delivery.firstByteMs }));
        });
        await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    }
    const rounds = Number(process.env.SPOOLER_RENDER_ROUNDS || 1);
    assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 100);
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    for (let round = 0; round < rounds; round++) {
    for (const { name, job } of jobs) {
        if (receiptTransport && job.print_type !== 'receipt' && job.print_type !== 'kitchen') continue;
        for (let iteration = 0; iteration < 4; iteration++) {
            const cpu = process.cpuUsage();
            const start = performance.now();
            const artifact = await renderer.render(job);
            const elapsed = performance.now() - start;
            const used = process.cpuUsage(cpu);
            assert.equal(crypto.createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex'), artifact.hash);
            let delivery;
            if (receiptTransport) {
                const transportStart = performance.now();
                const received = new Promise((resolve, reject) => { pendingDelivery = { start, resolve, reject }; });
                let markerWritten = false;
                const result = await transport.send({ printer: { network_ip: '127.0.0.1', network_port: receiver.address().port }, artifact,
                    markTransportStarted: () => { markerWritten = true; } });
                delivery = await received;
                assert.ok(markerWritten && result.success);
                assert.equal(delivery.hash, artifact.hash);
                assert.equal(delivery.bytes, artifact.bytes);
                delivery.transport_ms = performance.now() - transportStart;
            }
            output.samples.push({ name, round, warmup: iteration === 0, elapsed_ms: elapsed, render_ms: artifact.render_ms, raster_ms: artifact.raster_ms,
                delivery,
                node_cpu_ms: (used.user + used.system) / 1000, node_rss_bytes: process.memoryUsage().rss,
                hash: artifact.hash, bytes: artifact.bytes, height: artifact.height });
        }
    }
    }
    delay.disable();
    output.event_loop_delay_ms = { p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 };
    console.log(JSON.stringify(output, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await renderer.close(); for (const peer of peers) peer.destroy(); if (receiver) await new Promise(resolve => receiver.close(resolve)); fs.rmSync(scratch, { recursive: true, force: true }); });
