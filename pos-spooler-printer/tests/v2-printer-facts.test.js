const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openJobStore } = require('../v2/job-store');
const { createPrinterWorkers } = require('../v2/printer-workers');
const { createAgentRuntime } = require('../v2/agent-runtime');

// Printer health is what finished jobs say. Nothing probes a printer, and nothing is
// reported between jobs.

const artifact = { path: 'a.bin', hash: 'a'.repeat(64), bytes: 1 };
let queueId = 0;
function accept(store, printerId, extra = {}) {
    queueId += 1;
    store.accept({ queue_id: queueId, idempotency_key: `k${queueId}`, payload_hash: 'b'.repeat(64),
        printer_id: printerId, print_type: 'receipt', printer_type: 'network', network_ip: `10.0.0.${printerId}`, network_port: 9100, data: {}, ...extra });
    return queueId;
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-printer-facts-'));
    try {
        const store = openJobStore({ stateRoot: root });
        const outcomes = new Map();
        const workers = createPrinterWorkers({
            store,
            renderer: { render: async () => artifact },
            transportFor: () => ({ async send({ printer, markTransportStarted }) {
                await markTransportStarted();
                const outcome = outcomes.get(printer.printer_id);
                if (outcome === 'perm') throw Object.assign(new Error('bad'), { code: 'PRINTER_CONFIG_INVALID', failureClass: 'permanent_safe' });
                if (outcome === 'fail') throw Object.assign(new Error('cut'), { code: 'PRINTER_WRITE_CLOSED', failureClass: 'uncertain' });
                return { success: true };
            } })
        });
        assert.deepStrictEqual(workers.health().printers, [], 'a printer with no finished job reports nothing');

        workers.start();
        accept(store, 1); workers.wake();
        await workers.idle();
        assert.deepStrictEqual(workers.health().printers, [{ printer_id: 1, device_status: 'ok' }]);

        outcomes.set(2, 'fail');
        accept(store, 2); workers.wake();
        await workers.idle();
        assert.deepStrictEqual(workers.health().printers.find(printer => printer.printer_id === 2), { printer_id: 2, device_status: 'error' });

        // The status follows the newest finished job.
        outcomes.set(1, 'perm');
        accept(store, 1); workers.wake();
        await workers.idle();
        assert.strictEqual(workers.health().printers.find(printer => printer.printer_id === 1).device_status, 'error');
        outcomes.delete(1);
        accept(store, 1); workers.wake();
        await workers.idle();
        assert.strictEqual(workers.health().printers.find(printer => printer.printer_id === 1).device_status, 'ok');
        await workers.stop();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    // The runtime sends a printer's status only when it changes.
    const bodies = [];
    let printers = [{ printer_id: 1, device_status: 'ok' }];
    const store = {
        health: () => ({ active: 0 }), runnable: () => [], outbox: () => [], unconfirmedAccepted: () => [],
        confirmAccepted() {}, confirmResults() {}, get: () => null, agentStatus: () => 'active', setAgentStatus() {}
    };
    const timers = [];
    const runtime = createAgentRuntime({
        store,
        syncClient: { sync: async body => { bodies.push(body); return { agent_status: 'active', jobs: [], next_sync_ms: 2000 }; } },
        worker: { start() {}, stop() {}, wake() {}, health: () => ({ printers }) },
        clock: { setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} }
    });
    runtime.start();
    const tick = async () => { const fn = timers.shift(); await fn(); await new Promise(resolve => setImmediate(resolve)); };
    await tick(); await tick(); await tick();
    assert.deepStrictEqual(bodies[0].health.printers, [{ printer_id: 1, device_status: 'ok', status_source: 'agent' }]);
    assert.deepStrictEqual(bodies[1].health.printers, [], 'an unchanged status is not resent');
    assert.deepStrictEqual(bodies[2].health.printers, []);
    printers = [{ printer_id: 1, device_status: 'error' }];
    await tick();
    assert.strictEqual(bodies[3].health.printers[0].device_status, 'error');
    await runtime.stop();
    console.log('v2-printer-facts tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
