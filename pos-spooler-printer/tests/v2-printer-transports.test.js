const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createTcpTransport, createWindowsTransport, tcpTotalDeadlineMs } = require('../v2/printer-transports');

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for transport test condition.');
}

function temporaryArtifact(contents = 'receipt') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-transport-'));
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
    constructor({ failWrite = false, onWrite = null } = {}) {
        super();
        this.chunks = [];
        this.failWrite = failWrite;
        this.onWrite = onWrite;
        this.destroyed = false;
    }
    setTimeout() {}
    connect(_port, _host, callback) { queueMicrotask(callback); }
    write(chunk, callback) {
        if (this.failWrite) {
            queueMicrotask(() => this.emit('error', new Error('WRITE_FAILED')));
            return false;
        }
        this.chunks.push(Buffer.from(chunk));
        this.onWrite?.();
        queueMicrotask(() => { this.emit('drain'); callback?.(); });
        return false;
    }
    end(callback) { queueMicrotask(() => { callback?.(); this.emit('end'); this.emit('close'); }); }
    destroy() { this.destroyed = true; this.emit('close'); }
}

function fakeNet(options) {
    const net = {
        isIP: value => value === '127.0.0.1' ? 4 : 0,
        Socket: class extends FakeSocket {
            constructor() { super(options); net.socket = this; }
        }
    };
    return net;
}

(async () => {
    const artifact = temporaryArtifact('abc123');
    const largeArtifact = temporaryArtifact(Buffer.alloc(150000, 0x78));
    try {
        const net = fakeNet();
        const transport = createTcpTransport({ net, connectMs: 100, writeIdleMs: 100, totalMs: 500 });
        await assert.rejects(
            transport.send({ printer: { network_ip: 'not-an-ip', network_port: 9100 }, artifact, markTransportStarted: () => {} }),
            error => error.code === 'PRINTER_CONFIG_INVALID' && error.failureClass === 'permanent_safe'
        );

        const events = [];
        const orderedNet = fakeNet({ onWrite: () => events.push('first-byte') });
        const orderedTransport = createTcpTransport({ net: orderedNet, connectMs: 100, writeIdleMs: 100, totalMs: 500 });
        const result = await orderedTransport.send({
            printer: { network_ip: '127.0.0.1', network_port: 9100 },
            artifact,
            markTransportStarted: () => { events.push('marker'); }
        });
        events.push('complete');
        assert.deepStrictEqual(events, ['marker', 'first-byte', 'complete']);
        assert.strictEqual(result.confidence, 'peer_closed');
        assert.strictEqual(result.warningCode, null);
        assert.strictEqual(result.transportMode, 'tcp');
        assert.strictEqual(Buffer.concat(orderedNet.socket.chunks).toString(), 'abc123');

        const boundedNet = fakeNet();
        await createTcpTransport({ net: boundedNet, connectMs: 100, writeIdleMs: 100, totalMs: 500 }).send({
            printer: { network_ip: '127.0.0.1', network_port: 9100 },
            artifact: largeArtifact,
            markTransportStarted: () => {}
        });
        assert.strictEqual(boundedNet.socket.chunks.length, 3, '150KB artifact should stream in bounded chunks');
        assert(boundedNet.socket.chunks.every(chunk => chunk.length <= 64 * 1024));

        const markerFailure = fakeNet();
        await assert.rejects(
            createTcpTransport({ net: markerFailure, connectMs: 100, writeIdleMs: 100, totalMs: 500 }).send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 },
                artifact,
                markTransportStarted: () => { throw Object.assign(new Error('MARKER_FAILED'), { code: 'MARKER_FAILED' }); }
            }),
            error => error.code === 'MARKER_FAILED' && error.failureClass === 'uncertain'
        );
        assert.strictEqual(markerFailure.socket?.chunks.length || 0, 0);

        const failedWrite = fakeNet({ failWrite: true });
        await assert.rejects(
            createTcpTransport({ net: failedWrite, connectMs: 100, writeIdleMs: 100, totalMs: 500 }).send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 }, artifact, markTransportStarted: () => {}
            }),
            error => error.failureClass === 'uncertain'
        );

        await assert.rejects(
            transport.send({
                printer: { network_ip: '127.0.0.1', network_port: 9100 },
                artifact: { ...artifact, hash: '0'.repeat(64) },
                markTransportStarted: () => { throw new Error('MUST_NOT_START'); }
            }),
            error => error.code === 'ARTIFACT_HASH_MISMATCH' && error.failureClass === 'permanent_safe'
        );

        const requests = [];
        const helper = { request: async (command, payload) => {
            requests.push({ command, payload });
            return { job_id: 17, bytes_accepted: artifact.bytes, device_status: 'ok', drain_wait_mode: 'notification' };
        } };
        const windows = createWindowsTransport({ helper, totalMs: 500 });
        const windowsResult = await windows.send({
            printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => events.push('windows-marker')
        });
        assert.strictEqual(windowsResult.confidence, 'os_accepted');
        assert.strictEqual(windowsResult.transportMode, 'notification');
        assert.strictEqual(requests[0].command, 'print_raw');
        assert.strictEqual(requests[0].payload.artifact_sha256, artifact.hash);
        assert.strictEqual(requests[0].payload.drain_strategy, 'notify');

        const pendingByPrinter = new Map();
        const concurrentMarkers = [];
        const enteredWinspool = [];
        const concurrentHelper = {
            isReady: () => true,
            async request(command, payload, { beforeWrite } = {}) {
                assert.strictEqual(command, 'print_raw');
                assert(Number(payload.deadline_ms) >= 5000, 'print_raw must send a bounded deadline');
                await beforeWrite?.();
                enteredWinspool.push(payload.printer_name);
                return new Promise((resolve, reject) => pendingByPrinter.set(payload.printer_name, { resolve, reject, id: pendingByPrinter.size + 1 }));
            }
        };
        const concurrentWindows = createWindowsTransport({ helper: concurrentHelper, totalMs: 500 });
        const firstWindowsPrint = concurrentWindows.send({
            printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => concurrentMarkers.push('Kitchen-1')
        });
        const secondWindowsPrint = concurrentWindows.send({
            printer: { printer_name: 'Receipt-1' }, artifact, markTransportStarted: () => concurrentMarkers.push('Receipt-1')
        });
        await waitFor(() => pendingByPrinter.size === 2);
        assert.deepStrictEqual([...concurrentMarkers].sort(), ['Kitchen-1', 'Receipt-1']);
        assert.deepStrictEqual([...enteredWinspool].sort(), ['Kitchen-1', 'Receipt-1']);
        pendingByPrinter.get('Receipt-1').resolve({ job_id: 22, device_status: 'unknown' });
        const receiptResult = await secondWindowsPrint;
        assert.strictEqual(receiptResult.success, true);
        assert.strictEqual(receiptResult.windowsJobId, 22);
        assert(pendingByPrinter.has('Kitchen-1'), 'printer A must remain in flight after B completes');
        pendingByPrinter.get('Kitchen-1').reject(Object.assign(new Error('PLATFORM_HELPER_TIMEOUT'), {
            code: 'PLATFORM_HELPER_TIMEOUT',
            failureClass: 'uncertain'
        }));
        await assert.rejects(firstWindowsPrint, error => (
            error.code === 'PLATFORM_HELPER_TIMEOUT' && error.failureClass === 'uncertain'
        ));

        await assert.rejects(
            createWindowsTransport({
                helper: {
                    isReady: () => true,
                    request: async () => {
                        throw Object.assign(new Error('WINspool_DEADLINE_EXCEEDED'), { code: 'WINspool_DEADLINE_EXCEEDED' });
                    }
                },
                totalMs: 500
            }).send({ printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => {} }),
            error => error.code === 'WINspool_DEADLINE_EXCEEDED'
                && error.failureClass === 'uncertain'
                && error.failureClass !== 'transient_safe'
                && error.failureClass !== 'canceled'
        );

        async function windowsThrow(code) {
            return createWindowsTransport({
                helper: {
                    isReady: () => true,
                    request: async () => {
                        throw Object.assign(new Error(code), { code });
                    }
                },
                totalMs: 500
            }).send({ printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => {} });
        }

        await assert.rejects(
            windowsThrow('WINspool_OPEN_FAILED'),
            error => error.code === 'WINspool_OPEN_FAILED'
                && error.failureClass === 'transient_safe'
                && error.preByte === true
        );
        await assert.rejects(
            windowsThrow('WINspool_START_DOC_FAILED'),
            error => error.code === 'WINspool_START_DOC_FAILED'
                && error.failureClass === 'transient_safe'
                && error.preByte === true
        );
        await assert.rejects(
            windowsThrow('WINspool_START_PAGE_FAILED'),
            error => error.code === 'WINspool_START_PAGE_FAILED'
                && error.failureClass === 'transient_safe'
                && error.preByte === true
        );
        await assert.rejects(
            windowsThrow('ARTIFACT_HASH_MISMATCH'),
            error => error.code === 'ARTIFACT_HASH_MISMATCH'
                && error.failureClass === 'permanent_safe'
                && error.preByte !== true
        );
        await assert.rejects(
            windowsThrow('WINspool_WRITE_FAILED'),
            error => error.code === 'WINspool_WRITE_FAILED'
                && error.failureClass === 'uncertain'
                && error.preByte !== true
        );

        const drainCalls = [];
        function drainStatusHelper(deviceStatus) {
            return {
                isReady: () => true,
                request: async (command, payload, options = {}) => {
                    drainCalls.push({ command, payload, options });
                    return { job_id: 91, bytes_accepted: artifact.bytes, device_status: deviceStatus, drain_wait_mode: 'notification' };
                }
            };
        }

        const drained = await createWindowsTransport({ helper: drainStatusHelper('drained'), totalMs: 500 }).send({
            printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => {}
        });
        assert.strictEqual(drained.success, true);
        assert.strictEqual(drained.confidence, 'spooler_drained');
        assert.strictEqual(drained.transportMode, 'notification');
        assert.strictEqual(drainCalls[0].payload.drain_ms, 60000, 'observation windows default to one minute');
        assert.strictEqual(drainCalls[0].payload.drain_strategy, 'notify');
        assert.strictEqual(drainCalls[0].options.timeoutMs, 5000 + 2000, 'the submission request is bounded by the write deadline only');

        const rollbackCalls = [];
        const rollback = await createWindowsTransport({
            helper: {
                isReady: () => true,
                request: async (command, payload) => {
                    rollbackCalls.push({ command, payload });
                    return { job_id: 92, bytes_accepted: artifact.bytes, device_status: 'drained', drain_wait_mode: 'poll' };
                }
            },
            totalMs: 500,
            env: { SPOOLER_WINDOWS_DRAIN_STRATEGY: 'poll' }
        }).send({ printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => {} });
        assert.strictEqual(rollback.success, true);
        assert.strictEqual(rollback.transportMode, 'poll');
        assert.strictEqual(rollbackCalls[0].payload.drain_strategy, 'poll');

        // Submission and observation are separate: the OS keeps a queued job through
        // any device stall, so observation windows repeat until the job resolves.
        function observingHelper(answers, { retained = true, onWait } = {}) {
            const calls = [];
            return {
                calls,
                isReady: () => true,
                async request(command, payload, options = {}) {
                    calls.push({ command, payload, options });
                    if (command === 'print_raw') {
                        await options.beforeWrite?.();
                        return { job_id: 93, bytes_accepted: artifact.bytes, device_status: 'submitted', retained };
                    }
                    assert.strictEqual(command, 'wait_job');
                    onWait?.(payload);
                    const answer = answers.shift();
                    if (answer instanceof Error) throw answer;
                    return answer;
                }
            };
        }
        const sentMarks = [];
        const queuedHelper = observingHelper([
            { device_status: 'queued', drain_wait_mode: 'notification' },
            { device_status: 'queued', drain_wait_mode: 'notification' },
            { device_status: 'drained', drain_wait_mode: 'notification', retention_released: true }
        ]);
        const queued = await createWindowsTransport({ helper: queuedHelper, totalMs: 500, observeWindowMs: 3000 }).send({
            printer: { printer_name: 'Kitchen-1', queue_id: 501 }, artifact, markTransportStarted: () => {},
            markTransportSent: details => sentMarks.push(details)
        });
        assert.strictEqual(queued.success, true);
        assert.strictEqual(queued.confidence, 'spooler_drained');
        assert.strictEqual(queued.warningCode, null);
        assert.strictEqual(queued.windowsJobId, 93);
        assert.deepStrictEqual(sentMarks, [{ windows_job_id: 93 }], 'the sent marker is persisted before observation starts');
        assert.strictEqual(queuedHelper.calls[0].payload.queue_id, 501);
        assert.deepStrictEqual(queuedHelper.calls.map(call => call.command), ['print_raw', 'wait_job', 'wait_job', 'wait_job']);
        assert.strictEqual(queuedHelper.calls[1].payload.drain_ms, 3000);
        assert.strictEqual(queuedHelper.calls[1].payload.retained, true);
        assert.strictEqual(queuedHelper.calls[1].options.timeoutMs, 3000 + 5000);

        const unretained = await createWindowsTransport({ helper: observingHelper([
            { device_status: 'drained', drain_wait_mode: 'poll', retention_released: true, unretained_completion: true }
        ], { retained: false }), totalMs: 500 }).send({ printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => {} });
        assert.strictEqual(unretained.success, true, 'a provider without job retention still prints');
        assert.strictEqual(unretained.warningCode, 'WINspool_RETAIN_UNSUPPORTED');

        const deletedHelper = observingHelper([Object.assign(new Error('WINspool_JOB_DELETED'), { code: 'WINspool_JOB_DELETED' })]);
        await assert.rejects(
            createWindowsTransport({ helper: deletedHelper, totalMs: 500 }).send({ printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => {} }),
            error => error.code === 'WINspool_JOB_DELETED' && error.failureClass === 'uncertain' && error.streamIntact !== true
        );
        for (const failure of [
            Object.assign(new Error('WINspool_DRAIN_UNKNOWN'), { code: 'WINspool_DRAIN_UNKNOWN' }),
            Object.assign(new Error('PLATFORM_HELPER_TIMEOUT'), { code: 'PLATFORM_HELPER_TIMEOUT', failureClass: 'transient_safe' })
        ]) {
            await assert.rejects(
                createWindowsTransport({ helper: observingHelper([failure]), totalMs: 500 }).send({ printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => {} }),
                error => error.code === failure.code && error.streamIntact === true,
                `${failure.code} after submission leaves the stream intact`
            );
        }

        // Both drain errors occur after WritePrinter/EndDocPrinter. Deletion and
        // not observing PRINTING between polls cannot prove no bytes reached paper.
        await assert.rejects(
            windowsThrow('WINspool_JOB_STUCK'),
            error => error.code === 'WINspool_JOB_STUCK'
                && error.failureClass === 'uncertain'
                && error.preByte !== true
        );

        await assert.rejects(
            windowsThrow('WINspool_DRAIN_UNKNOWN'),
            error => error.code === 'WINspool_DRAIN_UNKNOWN'
                && error.failureClass === 'uncertain'
                && error.preByte !== true
        );

        // Hung artifact read test: must not block helper lane for second Windows job
        const hungArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-hung-'));
        const hungArtifactPath = path.join(hungArtifactDir, 'hung.bin');
        fs.writeFileSync(hungArtifactPath, 'content-that-will-be-read');
        let unblockSecond = null;
        const helperForHung = {
            isReady: () => true,
            runExclusive(operation) {
                const current = exclusiveTail.then(operation, operation);
                exclusiveTail = current.catch(() => {});
                return current;
            },
            async request(command, payload, { beforeWrite } = {}) {
                await beforeWrite?.();
                return { job_id: 88, device_status: 'ok' };
            }
        };
        const hungWindows = createWindowsTransport({ helper: helperForHung, totalMs: 500 });
        const originalCreateReadStream = fs.createReadStream;
        let hungStreamDestroyed = false;
        try {
            fs.createReadStream = (filePath, opts) => {
                if (filePath === hungArtifactPath) {
                    const { Readable } = require('stream');
                    const r = new Readable({ read() {} });
                    r.destroy = function(err) {
                        hungStreamDestroyed = true;
                        return Readable.prototype.destroy.call(this, err);
                    };
                    return r;
                }
                return originalCreateReadStream.call(fs, filePath, opts);
            };

            let hungMarkerCalled = false;
            const hungJobPromise = hungWindows.send({
                printer: { printer_name: 'Kitchen-1' },
                artifact: { path: hungArtifactPath, hash: 'a'.repeat(64), bytes: 100 },
                markTransportStarted: () => { hungMarkerCalled = true; }
            });

            // Second job for a normal artifact should still be able to proceed and finish through the helper lane
            const secondJobPromise = hungWindows.send({
                printer: { printer_name: 'Receipt-1' },
                artifact,
                markTransportStarted: () => events.push('second-unblocked-marker')
            });

            const secondResult = await secondJobPromise;
            assert.strictEqual(secondResult.success, true);
            assert.strictEqual(secondResult.confidence, 'os_accepted');

            await assert.rejects(
                hungJobPromise,
                error => error.code === 'ARTIFACT_READ_TIMEOUT' && error.failureClass === 'transient_safe'
            );
            assert.strictEqual(hungMarkerCalled, false, 'hung artifact must not leave a transport marker');
            assert.strictEqual(hungStreamDestroyed, true, 'hung stream must be destroyed on timeout');
        } finally {
            fs.createReadStream = originalCreateReadStream;
            fs.rmSync(hungArtifactDir, { recursive: true, force: true });
        }

        let restartMarker = false;
        const restartingWindows = createWindowsTransport({
            helper: {
                isReady: () => false,
                request: async () => { throw Object.assign(new Error('PLATFORM_HELPER_RESTARTING'), { code: 'PLATFORM_HELPER_RESTARTING' }); }
            },
            totalMs: 500
        });
        await assert.rejects(
            restartingWindows.send({ printer: { printer_name: 'Kitchen-1' }, artifact, markTransportStarted: () => { restartMarker = true; } }),
            error => error.code === 'PLATFORM_HELPER_RESTARTING' && error.failureClass === 'transient_safe'
        );
        assert.strictEqual(restartMarker, false);
        assert(tcpTotalDeadlineMs(1024 * 1024, 15000) > tcpTotalDeadlineMs(1024, 15000));
    } finally {
        fs.rmSync(artifact.root, { recursive: true, force: true });
        fs.rmSync(largeArtifact.root, { recursive: true, force: true });
    }
    console.log('v2-printer-transports tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
