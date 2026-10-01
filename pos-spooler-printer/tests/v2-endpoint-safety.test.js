const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openJobStore } = require('../v2/job-store');
const { createPrinterWorkers } = require('../v2/printer-workers');
const { printerEndpoint } = require('../v2/printer-endpoint');

const job = (id, printerId, ip = '127.0.0.1') => ({ queue_id: id, printer_id: printerId,
    printer_type: 'network', network_ip: ip, network_port: 9100, print_type: 'kitchen',
    idempotency_key: `endpoint-${id}`, payload_hash: 'a'.repeat(64), data: {} });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-endpoint-safety-'));
    let workers;
    try {
        assert.equal(printerEndpoint({ type: 'windows', windows_name: ' Kitchen ' }),
            printerEndpoint({ printer_type: 'windows', printer_name: 'kitchen' }));
        assert.equal(printerEndpoint({ network_ip: '2001:0DB8:0:0:0:0:0:1' }),
            printerEndpoint({ network_ip: '2001:db8::1' }));
        let store = openJobStore({ stateRoot: root });
        const sends = [], active = new Map();
        let peakSame = 0, peakTotal = 0;
        const renderer = { render: async () => ({ path: 'fixture.bin', bytes: 1, hash: 'a'.repeat(64) }) };
        const transport = { async send({ printer, markTransportStarted }) {
            const key = printerEndpoint(printer);
            markTransportStarted();
            sends.push(printer.queue_id);
            active.set(key, (active.get(key) || 0) + 1);
            peakSame = Math.max(peakSame, active.get(key));
            peakTotal = Math.max(peakTotal, [...active.values()].reduce((a, b) => a + b, 0));
            await delay(20);
            active.set(key, active.get(key) - 1);
            if (printer.queue_id === 4) throw Object.assign(new Error('cut'), { code: 'PRINTER_WRITE_CLOSED', failureClass: 'uncertain' });
            return { success: true };
        } };
        for (const spec of [job(1, 1), job(2, 2), job(3, 3, '127.0.0.2')]) store.accept(spec);
        workers = createPrinterWorkers({ store, renderer, transportFor: () => transport });
        workers.start(); await workers.idle();
        assert.equal(peakSame, 1, 'aliases share one physical lane');
        assert.equal(peakTotal, 2, 'independent devices still run in parallel');
        assert.equal(store.get(2).state, 'completed');
        store.accept(job(4, 1)); store.accept(job(5, 2)); store.accept(job(6, 3, '127.0.0.2'));
        workers.wake(); await workers.idle();
        assert.equal(store.get(4).state, 'uncertain');
        assert.equal(store.get(6).state, 'completed');
        assert(!sends.includes(5), 'next ticket must not enter a damaged parser');
        store.confirmResults([4]);
        await workers.stop();
        store = openJobStore({ stateRoot: root });
        assert.deepEqual(store.endpointHold(job(5, 2)).queue_ids, [4], 'hold survives archive and restart');
        workers = createPrinterWorkers({ store, renderer, transportFor: () => transport });
        workers.start(); await workers.idle(); assert(!sends.includes(5)); await workers.stop();
        const held = store.endpointHold(job(5, 2));
        assert.throws(() => store.recoverEndpoint(held.endpoint, [99]), /HOLD_CHANGED/);
        store.recoverEndpoint(held.endpoint, held.queue_ids);
        assert.equal(store.get(4).state, 'uncertain', 'recovery cannot change history or reprint');
        store = openJobStore({ stateRoot: root });
        assert.equal(store.endpointHold(job(5, 2)), null);
        workers = createPrinterWorkers({ store, renderer, transportFor: () => transport });
        workers.start(); await workers.idle(); await workers.stop();
        assert.equal(store.get(5).state, 'completed');
        assert.equal(sends.filter(id => id === 4).length, 1);
        store.accept(job(10, 4, '127.0.0.4')); store.accept(job(11, 5, '127.0.0.5'));
        store = openJobStore({ stateRoot: root });
        workers = createPrinterWorkers({ store, renderer, transportFor: () => transport });
        workers.setBlockedPrinters([4]);
        workers.start(); await workers.idle();
        assert.equal(store.get(10).state, 'queued', 'server conflict blocks previously durable jobs before startup');
        assert.equal(store.get(11).state, 'completed', 'another station-owned device remains usable');
        workers.setBlockedPrinters([]); await workers.idle(); await workers.stop();
        assert.equal(store.get(10).state, 'completed', 'explicitly cleared configuration resumes untouched work');
        assert.equal(sends.filter(id => id === 10).length, 1);
        store.accept(job(7, 1)); store.markTransportStarted(7);
        store = openJobStore({ stateRoot: root });
        assert.equal(store.get(7).result.error_code, 'AGENT_RESTART_AFTER_TRANSPORT');
        assert.deepEqual(store.endpointHold(job(7, 1)).queue_ids, [7]);
        store.recoverEndpoint(store.endpointHold(job(7, 1)).endpoint, [7]);
        // Past the sent marker every byte had left the process: uncertain, but no hold.
        store.accept(job(8, 1)); store.markTransportStarted(8); store.markTransportSent(8, { windows_job_id: 41 });
        assert.deepEqual(store.endpointHold(job(8, 1)).queue_ids, [8], 'an in-flight send still owns its endpoint');
        store = openJobStore({ stateRoot: root });
        assert.equal(store.get(8).state, 'uncertain');
        assert.equal(store.get(8).result.error_code, 'AGENT_RESTART_AFTER_SEND');
        assert.equal(store.get(8).windows_job_id, 41);
        assert.equal(store.endpointHold(job(8, 1)), null, 'a restart after the sent marker does not hold the endpoint');
        assert.throws(() => store.markTransportSent(8), /JOB_NOT_TRANSPORT_STARTED/);
        store.accept(job(9, 1)); store.markTransportStarted(9);
        store.recordResult(9, { outcome: 'uncertain', error_code: 'PLATFORM_HELPER_TIMEOUT' }, { hold: false });
        assert.equal(store.endpointHold(job(9, 1)), null, 'a stream-intact uncertain outcome does not hold the endpoint');
    } finally {
        await workers?.stop();
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('v2-endpoint-safety tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
