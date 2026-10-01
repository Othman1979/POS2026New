const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createTcpTransport, createWindowsTransport } = require('../v2/printer-transports');
const { openJobStore } = require('../v2/job-store');

function temporaryArtifact(contents = 'kitchen') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-boundary-'));
    const file = path.join(root, 'artifact.bin');
    fs.writeFileSync(file, contents);
    return {
        root,
        path: file,
        hash: crypto.createHash('sha256').update(contents).digest('hex'),
        bytes: Buffer.byteLength(contents)
    };
}

class FakeSocket extends EventEmitter {
    constructor({ mode = 'success' } = {}) {
        super();
        this.mode = mode;
        this.chunks = [];
        this.destroyed = false;
    }
    setTimeout() {}
    connect(_port, _host, callback) {
        queueMicrotask(() => {
            if (this.mode === 'timeout-before-connect') this.emit('timeout');
            else if (this.mode === 'error-before-connect') this.emit('error', new Error('ECONNREFUSED before connect'));
            else callback?.();
        });
    }
    write(chunk, callback) {
        if (this.mode === 'write-error') {
            queueMicrotask(() => this.emit('error', new Error('WRITE_FAILED')));
            return false;
        }
        this.chunks.push(Buffer.from(chunk));
        queueMicrotask(() => { this.emit('drain'); callback?.(); });
        return false;
    }
    end(callback) { queueMicrotask(() => { callback?.(); this.emit('end'); this.emit('close'); }); }
    destroy() { this.destroyed = true; this.emit('close'); }
}

function fakeNet(mode) {
    const net = {
        isIP: value => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value).trim()) && !String(value).includes('300') ? 4 : 0,
        Socket: class extends FakeSocket {
            constructor() { super({ mode }); net.socket = this; }
        }
    };
    return net;
}

(async () => {
    const artifact = temporaryArtifact();
    try {
        await assert.rejects(
            createTcpTransport({ net: fakeNet('timeout-before-connect'), connectMs: 20, writeIdleMs: 20, totalMs: 50 }).send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 }, artifact, markTransportStarted: () => {}
            }),
            error => error.failureClass === 'transient_safe' || error.failureClass === 'permanent_safe'
        );
        assert.strictEqual(fakeNet('timeout-before-connect').socket, undefined);

        const timeoutNet = fakeNet('timeout-before-connect');
        await assert.rejects(
            createTcpTransport({ net: timeoutNet, connectMs: 20, writeIdleMs: 20, totalMs: 50 }).send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 }, artifact, markTransportStarted: () => { throw new Error('MUST_NOT_START'); }
            }),
            error => error.message !== 'MUST_NOT_START'
        );

        await assert.rejects(
            createTcpTransport({ net: fakeNet('error-before-connect'), connectMs: 20, writeIdleMs: 20, totalMs: 50 }).send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 }, artifact, markTransportStarted: () => {}
            }),
            error => error.failureClass !== 'uncertain'
        );

        await assert.rejects(
            createTcpTransport({ net: fakeNet('success'), connectMs: 20, writeIdleMs: 20, totalMs: 50 }).send({
                printer: { network_ip: '192.168.1.300', network_port: 9100 }, artifact, markTransportStarted: () => {}
            }),
            error => error.code === 'PRINTER_CONFIG_INVALID' && error.failureClass === 'permanent_safe'
        );

        const writeNet = fakeNet('write-error');
        await assert.rejects(
            createTcpTransport({ net: writeNet, connectMs: 50, writeIdleMs: 50, totalMs: 200 }).send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 }, artifact, markTransportStarted: () => {}
            }),
            error => error.failureClass === 'uncertain'
        );

        await assert.rejects(
            createTcpTransport({ net: fakeNet('success'), connectMs: 50, writeIdleMs: 50, totalMs: 200 }).send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 },
                artifact,
                markTransportStarted: () => { throw Object.assign(new Error('MARKER_FAILED'), { code: 'MARKER_FAILED' }); }
            }),
            error => error.failureClass === 'uncertain'
        );

        const helper = {
            request: async () => { throw Object.assign(new Error('Windows copy failed after launch.'), { failureClass: 'uncertain' }); }
        };
        await assert.rejects(
            createWindowsTransport({ helper, totalMs: 200 }).send({
                printer: { printer_name: 'Kitchen-Test' }, artifact, markTransportStarted: () => {}
            }),
            error => error.failureClass === 'uncertain'
        );

        const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-boundary-store-'));
        try {
            const store = openJobStore({ stateRoot: storeRoot });
            store.accept({
                queue_id: 88,
                idempotency_key: 'kitchen-boundary',
                payload_hash: 'a'.repeat(64),
                printer_id: 7,
                print_type: 'kitchen'
            });
            store.markRendered(88, artifact);
            store.markTransportStarted(88);
            store.recordResult(88, { outcome: 'completed' });
            const again = store.accept({
                queue_id: 88,
                idempotency_key: 'kitchen-boundary',
                payload_hash: 'a'.repeat(64),
                printer_id: 7,
                print_type: 'kitchen'
            });
            assert.strictEqual(again.state, 'completed');
            assert.strictEqual(store.runnable().length, 0);
        } finally {
            fs.rmSync(storeRoot, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(artifact.root, { recursive: true, force: true });
    }
    console.log('transport-boundary tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
