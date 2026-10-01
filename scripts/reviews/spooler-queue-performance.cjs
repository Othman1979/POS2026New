// Four independent loopback printer sinks, real journal/renderer/TCP transport.
// No physical printer, application database, or machine service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const spooler = path.join(root, 'pos-spooler-printer');
const { openJobStore } = require(path.join(spooler, 'v2/job-store'));
const { createTypstRenderer } = require(path.join(spooler, 'v2/typst-renderer'));
const { createPrinterWorkers } = require(path.join(spooler, 'v2/printer-workers'));
const { createTcpTransport } = require(path.join(spooler, 'v2/printer-transports'));
const report = require(path.join(spooler, 'tests/fixtures/v2-report-200-rows'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-spooler-queue-audit-'));
const store = openJobStore({ stateRoot: scratch });
const servers = [];
const peers = new Set();
const expected = new Map();
const observations = new Map();
let onRender;
let workers;
let protocolFailure = null;
const nativeRenderer = createTypstRenderer({ stateRoot: scratch, executable: process.env.SPOOLER_TYPST_EXE, fontPath: process.env.SPOOLER_TYPST_FONT_DIR, env: {} });
const renderer = { ...nativeRenderer, async render(job) {
    const result = nativeRenderer.render(job);
    const callback = onRender; onRender = null; callback?.();
    return result;
} };
(async () => {
    for (let printerId = 1; printerId <= 4; printerId++) {
        expected.set(printerId, []);
        const server = net.createServer(socket => {
            peers.add(socket); socket.on('close', () => peers.delete(socket));
            socket.on('error', error => { protocolFailure = error; });
            const submission = expected.get(printerId).shift();
            const hash = crypto.createHash('sha256'); let bytes = 0;
            socket.on('data', chunk => {
                if (!submission) { protocolFailure = new Error('unexpected connection'); return; }
                if (!bytes) submission.first_byte_ms = performance.now() - submission.acceptedAt;
                bytes += chunk.length; hash.update(chunk);
            });
            socket.on('end', () => {
                if (!submission) return;
                submission.received_bytes = bytes; submission.received_hash = hash.digest('hex'); submission.received = true;
            });
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server);
    }
    const transport = createTcpTransport();
    const receipt = { print_type: 'receipt', data: { storeInfo: {}, items: [{ name: 'Meal وجبة', qty: 2, price: 4 }], total: 8 } };
    const cached = await renderer.render({ ...receipt, queue_id: 999 });
    workers = createPrinterWorkers({ store, renderer, transportFor: job => ({
        async send(input) {
            const observation = observations.get(job.queue_id);
            observation.hash = input.artifact.hash; observation.bytes = input.artifact.bytes;
            expected.get(job.printer_id).push(observation);
            return transport.send(input);
        }
    }) });
    const samples = [];
    for (let sample = 0; sample < 3; sample++) {
        const base = sample * 10;
        function accept(id, printerId, job, label, artifact) {
            observations.set(id, { sample, label, queue_id: id, acceptedAt: performance.now() });
            store.accept({ ...job, queue_id: id, printer_id: printerId, printer_type: 'network', network_ip: '127.0.0.1',
                network_port: servers[printerId - 1].address().port, idempotency_key: `burst-${id}`, payload_hash: 'a'.repeat(64) });
            if (artifact) store.markRendered(id, artifact);
        }
        onRender = () => {
            accept(base + 2, 2, { print_type: 'kitchen', data: { storeInfo: {}, items: [{ name: 'وجبة Meal', qty: 2 }] } }, 'new_kitchen');
            accept(base + 3, 3, receipt, 'new_receipt');
            accept(base + 4, 4, receipt, 'ready_artifact', cached);
            workers.wake();
        };
        accept(base + 1, 1, report, 'report'); workers.start(); workers.wake();
        await workers.idle();
        const deadline = Date.now() + 1000;
        while ([1, 2, 3, 4].some(id => !observations.get(base + id)?.received) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(protocolFailure, null);
        for (const id of [1, 2, 3, 4]) {
            const observation = observations.get(base + id);
            assert.equal(store.get(base + id).state, 'completed');
            assert.equal(observation.received_hash, observation.hash);
            assert.equal(observation.received_bytes, observation.bytes);
            const { acceptedAt, received, ...result } = observation; samples.push(result);
        }
        await workers.stop();
    }
    console.log(JSON.stringify({ renderer: 'typst', node: process.version, samples }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await workers?.stop(); await renderer.close();
    for (const socket of peers) socket.destroy();
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
});
