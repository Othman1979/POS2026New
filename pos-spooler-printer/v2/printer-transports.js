const crypto = require('crypto');
const fs = require('fs');
const net = require('net');

const DEFAULT_CONNECT_MS = 5000;
// A printer that is out of paper, cooling down or waiting for a cover to close keeps its
// TCP session alive and simply stops reading; that is a stall, not a cut stream. Aborting
// it is what truncates a raster and garbles the next ticket, so the no-progress budget is
// long. A dead peer is detected earlier by TCP keepalive/retransmission errors.
const DEFAULT_STALL_MS = 10 * 60 * 1000;
const DEFAULT_WRITE_IDLE_MS = DEFAULT_STALL_MS;
const DEFAULT_TOTAL_MS = DEFAULT_STALL_MS;
const DEFAULT_HELPER_MS = 10000;
const KEEPALIVE_DELAY_MS = 10000;
// Grace for a printer already known to keep its side open after our FIN (CUPS ships
// waiteof=false for such firmware): long enough to drain a kernel-buffered ticket.
const EOF_GRACE_NONCLOSING_MS = 2000;
// An endpoint not yet seen to close or hold gets a bounded look. Waiting out the stall
// budget instead (ten minutes) blocked that printer's lane after every restart, for a
// printer that simply never answers our FIN; bytes_sent is the truthful outcome either way.
// A merely slow closer must not be mistaken for a holder (the next job would then get only
// the short grace and could mix TCP sessions), so an endpoint is classified 'holds' only
// after this many consecutive timeouts.
const EOF_GRACE_UNKNOWN_MS = 15000;
const EOF_TIMEOUTS_TO_HOLD = 2;

function tcpTotalDeadlineMs(bytes, minimumMs = DEFAULT_TOTAL_MS) {
    const size = Math.max(0, Number(bytes) || 0);
    return minimumMs + Math.ceil(size / (8 * 1024)) * 1000;
}

function classified(code, failureClass, message = code) {
    const error = new Error(message);
    error.code = code;
    error.failureClass = failureClass;
    return error;
}

function validPort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function printerName(printer = {}) {
    const value = String(printer.printer_name || printer.windows_name || '').trim();
    if (!value || value.length > 255 || !/^[a-zA-Z0-9\s\-_()[\]\\.]+$/.test(value)) {
        throw classified('PRINTER_CONFIG_INVALID', 'permanent_safe', 'Invalid Windows printer name.');
    }
    return value;
}

function verifyArtifactHash(artifact, { timeoutMs = DEFAULT_HELPER_MS } = {}) {
    if (!artifact || !pathIsAbsolute(artifact.path) || !/^[0-9a-f]{64}$/i.test(String(artifact.hash || ''))) {
        throw classified('ARTIFACT_INVALID', 'permanent_safe', 'Immutable print artifact metadata is invalid.');
    }
    let stream;
    const readOp = new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        let bytes = 0;
        stream = fs.createReadStream(artifact.path, { highWaterMark: 64 * 1024 });
        stream.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
        stream.once('error', error => reject(classified('ARTIFACT_READ_FAILED', 'transient_safe', error.message)));
        stream.once('end', () => {
            const actual = hash.digest();
            const expected = Buffer.from(String(artifact.hash), 'hex');
            if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
                reject(classified('ARTIFACT_HASH_MISMATCH', 'permanent_safe', 'Immutable print artifact hash changed.'));
                return;
            }
            if (artifact.bytes != null && Number(artifact.bytes) !== bytes) {
                reject(classified('ARTIFACT_SIZE_MISMATCH', 'permanent_safe', 'Immutable print artifact size changed.'));
                return;
            }
            resolve({ bytes, hash: actual.toString('hex') });
        });
    });
    return withTimeout(readOp, timeoutMs, () => stream?.destroy(), 'ARTIFACT_READ_TIMEOUT', 'transient_safe')
        .finally(() => stream?.destroy());
}

function pathIsAbsolute(value) {
    return typeof value === 'string' && (value.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/'));
}

function withTimeout(promise, timeoutMs, onTimeout, code, failureClass) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try { onTimeout?.(); } finally { reject(classified(code, failureClass)); }
        }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function addOnce(emitter, event, listener) {
    if (typeof emitter.once === 'function') emitter.once(event, listener);
    else emitter.on?.(event, listener);
}

function removeListener(emitter, event, listener) {
    emitter.removeListener?.(event, listener);
}

function connectWithDeadline(socket, host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            removeListener(socket, 'connect', onConnect);
            removeListener(socket, 'error', onError);
            removeListener(socket, 'timeout', onTimeout);
            removeListener(socket, 'close', onClose);
            if (error) {
                socket.destroy();
                reject(error.failureClass ? error : classified('PRINTER_CONNECT_FAILED', 'transient_safe', error.message));
            } else resolve();
        };
        const onConnect = () => finish();
        const onError = error => finish(error);
        const timeoutError = () => classified('PRINTER_CONNECT_TIMEOUT', 'transient_safe', `TCP connection timeout to network printer ${host}:${port}`);
        const onTimeout = () => finish(timeoutError());
        const onClose = () => finish(classified('PRINTER_CONNECT_CLOSED', 'transient_safe'));
        const timer = setTimeout(() => finish(timeoutError()), timeoutMs);
        addOnce(socket, 'connect', onConnect);
        addOnce(socket, 'error', onError);
        addOnce(socket, 'timeout', onTimeout);
        addOnce(socket, 'close', onClose);
        try { socket.connect(port, host, onConnect); } catch (error) { finish(error); }
    });
}

function writeChunk(socket, chunk, idleMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => finish(classified('PRINTER_WRITE_TIMEOUT', 'uncertain')), idleMs);
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            removeListener(socket, 'error', onError);
            removeListener(socket, 'timeout', onTimeout);
            removeListener(socket, 'close', onClose);
            if (error) reject(error);
            else resolve();
        };
        const onError = error => finish(classified('PRINTER_WRITE_FAILED', 'uncertain', error.message));
        const onTimeout = () => finish(classified('PRINTER_WRITE_TIMEOUT', 'uncertain'));
        const onClose = () => finish(classified('PRINTER_WRITE_CLOSED', 'uncertain'));
        addOnce(socket, 'error', onError);
        addOnce(socket, 'timeout', onTimeout);
        addOnce(socket, 'close', onClose);
        try {
            socket.write(chunk, error => finish(error ? classified('PRINTER_WRITE_FAILED', 'uncertain', error.message) : null));
        } catch (error) {
            finish(classified('PRINTER_WRITE_FAILED', 'uncertain', error.message));
        }
    });
}

async function streamArtifact(socket, artifactPath, { idleMs, totalMs }) {
    let stream;
    try {
        stream = fs.createReadStream(artifactPath, { highWaterMark: 64 * 1024 });
        const operation = (async () => {
            for await (const chunk of stream) await writeChunk(socket, chunk, idleMs);
        })();
        await withTimeout(operation, totalMs, () => stream.destroy(), 'PRINTER_STREAM_TIMEOUT', 'uncertain');
    } catch (error) {
        if (error.failureClass) throw error;
        throw classified('PRINTER_STREAM_FAILED', 'uncertain', error.message);
    } finally {
        stream?.destroy();
    }
}

function finishSocket(socket, timeoutMs) {
    // end(callback) only means the LOCAL writable buffer drained. Keep the lane
    // until the receiver ends its side, otherwise the next connection can mix
    // with this stream on multi-session ESC/POS printers. EOF is not paper proof.
    // Every byte is already in the kernel here, so a peer that never answers our
    // FIN has not cut the stream: that resolves with eof=false and is reported as
    // a warning rather than an uncertain outcome. Only errors reject.
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, outcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            removeListener(socket, 'error', onError);
            removeListener(socket, 'end', onEnd);
            removeListener(socket, 'close', onClose);
            if (error) reject(error); else resolve(outcome);
        };
        const onError = error => finish(classified('PRINTER_CLOSE_FAILED', 'uncertain', error.message));
        const onEnd = () => finish(null, { eof: true });
        const onClose = () => finish(classified('PRINTER_CLOSE_INCOMPLETE', 'uncertain'));
        const timer = setTimeout(() => finish(null, { eof: false, warningCode: 'PRINTER_EOF_NOT_OBSERVED' }), timeoutMs);
        addOnce(socket, 'error', onError);
        addOnce(socket, 'end', onEnd);
        addOnce(socket, 'close', onClose);
        if (socket.destroyed) { onClose(); return; }
        if (socket.readableEnded) {
            // The peer half-closed before we finished writing yet kept accepting
            // our bytes (every write succeeded), so its EOF proves nothing here.
            finish(null, { eof: false, warningCode: 'PRINTER_EOF_EARLY' });
            try { socket.end(); } catch {}
            return;
        }
        try { socket.end(); } catch (error) { onError(error); }
    });
}

function createTcpTransport({ net: netModule = net, connectMs = DEFAULT_CONNECT_MS, writeIdleMs = DEFAULT_WRITE_IDLE_MS, totalMs = DEFAULT_TOTAL_MS, eofUnknownMs = EOF_GRACE_UNKNOWN_MS, eofHoldsMs = EOF_GRACE_NONCLOSING_MS } = {}) {
    // Learned per endpoint: 'closes' once a peer has ever answered our FIN, 'holds'
    // once it has let two consecutive full waits pass without doing so. A known closer that
    // times out is stalled, not reclassified.
    const eofBehaviour = new Map();
    const eofTimeouts = new Map();

    function target(printer = {}) {
        const host = String(printer.network_ip || '').trim();
        const port = validPort(printer.network_port || 9100);
        if (!netModule.isIP(host) || !port) throw classified('PRINTER_CONFIG_INVALID', 'permanent_safe', 'Invalid network printer address.');
        return { host, port };
    }

    async function send({ printer, artifact, markTransportStarted, markTransportSent }) {
        const { host, port } = target(printer);
        const endpoint = `${host}:${port}`;
        const socket = new netModule.Socket({ allowHalfOpen: true });
        // Keep late/between-phase socket errors handled as well as operation errors.
        let socketError;
        socket.on('error', error => { socketError = error; });
        const startedAt = Date.now();
        let marked = false;
        try {
            await connectWithDeadline(socket, host, port, connectMs);
            socket.resume?.(); // Drain unsolicited status bytes without retaining them.
            try { socket.setKeepAlive?.(true, KEEPALIVE_DELAY_MS); } catch {}
            await verifyArtifactHash(artifact);
            if (socketError) throw socketError;
            try {
                await markTransportStarted?.();
                marked = true;
            } catch (error) {
                throw error.failureClass ? error : classified(error.code || 'TRANSPORT_MARKER_FAILED', 'uncertain', error.message);
            }
            const jobTotalMs = tcpTotalDeadlineMs(artifact.bytes, totalMs);
            const deliveryStarted = Date.now();
            await streamArtifact(socket, artifact.path, { idleMs: writeIdleMs, totalMs: jobTotalMs });
            // Durable "every byte left this process": a restart from here is not a cut.
            try { await markTransportSent?.(); } catch (error) { console.error(`print job sent marker failed: ${error.message}`); }
            const remainingMs = Math.max(1, jobTotalMs - (Date.now() - deliveryStarted));
            const behaviour = eofBehaviour.get(endpoint);
            const closing = await finishSocket(socket, behaviour === 'closes' ? remainingMs
                : behaviour === 'holds' ? eofHoldsMs
                : Math.min(remainingMs, eofUnknownMs));
            if (closing.eof) {
                eofBehaviour.set(endpoint, 'closes');
                eofTimeouts.delete(endpoint);
            } else if (closing.warningCode === 'PRINTER_EOF_NOT_OBSERVED' && behaviour !== 'closes' && behaviour !== 'holds') {
                const timeouts = (eofTimeouts.get(endpoint) || 0) + 1;
                if (timeouts >= EOF_TIMEOUTS_TO_HOLD) { eofBehaviour.set(endpoint, 'holds'); eofTimeouts.delete(endpoint); }
                else eofTimeouts.set(endpoint, timeouts);
            }
            return {
                success: true,
                confidence: closing.eof ? 'peer_closed' : 'bytes_sent',
                warningCode: closing.warningCode || null,
                deviceStatus: 'unknown',
                durationMs: Date.now() - startedAt,
                transportMode: 'tcp'
            };
        } catch (error) {
            if (error.failureClass) throw error;
            throw classified(marked ? 'PRINTER_TRANSPORT_UNCERTAIN' : 'PRINTER_CONNECT_FAILED', marked ? 'uncertain' : 'transient_safe', error.message);
        } finally { socket.destroy(); }
    }

    return { send };
}

// Submission (print_raw) is bounded by the same stall budget as TCP: a direct-to-port
// queue blocks WritePrinter while the device is stalled. Observation (wait_job) is
// repeated in windows for as long as the OS keeps the job queued; the spooler owns
// the job and prints it whenever the device recovers, so there is nothing to give up on.
const DEFAULT_WINDOWS_SUBMIT_MS = DEFAULT_STALL_MS;
const DEFAULT_WINDOWS_OBSERVE_WINDOW_MS = 60000;

function createWindowsTransport({ helper, totalMs = DEFAULT_WINDOWS_SUBMIT_MS, observeWindowMs = DEFAULT_WINDOWS_OBSERVE_WINDOW_MS, env = process.env } = {}) {
    function clampDeadlineMs(value) {
        const deadline = Number(value);
        const normalized = Number.isFinite(deadline) ? Math.trunc(deadline) : DEFAULT_WINDOWS_SUBMIT_MS;
        return Math.min(15 * 60 * 1000, Math.max(5000, normalized));
    }

    function clampDrainMs(value) {
        const drain = Number(value);
        const normalized = Number.isFinite(drain) ? Math.trunc(drain) : observeWindowMs;
        return Math.min(300000, Math.max(2000, normalized));
    }

    // Everything after a successful submission leaves the stream intact: the spooler
    // holds the whole document. Only the physical outcome is unknown.
    function intact(error) {
        error.streamIntact = true;
        return error;
    }

    function drainStrategy() {
        return String(env?.SPOOLER_WINDOWS_DRAIN_STRATEGY || '').trim().toLowerCase() === 'poll'
            ? 'poll'
            : 'notify';
    }

    async function send({ printer, artifact, markTransportStarted, markTransportSent }) {
        const name = printerName(printer);
        if (!helper?.request) throw classified('PLATFORM_HELPER_UNAVAILABLE', 'transient_safe');
        if (helper.isReady?.() === false) throw classified('PLATFORM_HELPER_RESTARTING', 'transient_safe');
        const startedAt = Date.now();
        await verifyArtifactHash(artifact, { timeoutMs: DEFAULT_HELPER_MS });
        const deadlineMs = clampDeadlineMs(totalMs);
        const drainMs = clampDrainMs(printer?.drain_ms);
        let submitted;
        try {
            submitted = await helper.request(
                'print_raw',
                {
                    printer_name: name,
                    artifact_path: artifact.path,
                    artifact_sha256: artifact.hash,
                    queue_id: printer?.queue_id ?? null,
                    deadline_ms: deadlineMs,
                    drain_ms: drainMs,
                    drain_strategy: drainStrategy()
                },
                { beforeWrite: markTransportStarted, timeoutMs: deadlineMs + 2000 }
            );
        } catch (error) {
            if (error.failureClass) throw error;
            const code = error.code || 'WINspool_OUTCOME_UNKNOWN';
            if (code === 'WINspool_OPEN_FAILED' || code === 'WINspool_START_DOC_FAILED' || code === 'WINspool_START_PAGE_FAILED') {
                const mapped = classified(code, 'transient_safe', error.message);
                mapped.preByte = true;
                throw mapped;
            }
            if (code === 'ARTIFACT_HASH_MISMATCH') throw classified(code, 'permanent_safe', error.message);
            // A write failure may follow partial delivery. Never automatically reprint it.
            throw classified(code, 'uncertain', error.message);
        }
        const windowsJobId = submitted?.job_id ?? null;
        const retained = submitted?.retained !== false;
        try { await markTransportSent?.({ windows_job_id: windowsJobId }); } catch (error) { console.error(`print job sent marker failed: ${error.message}`); }
        let observation = submitted;
        try {
            // Legacy helpers observed inside print_raw and never answer "submitted".
            while (observation?.device_status === 'submitted' || observation?.device_status === 'queued') {
                observation = await helper.request(
                    'wait_job',
                    { printer_name: name, job_id: windowsJobId, drain_ms: drainMs, drain_strategy: drainStrategy(), retained },
                    { timeoutMs: drainMs + 5000 }
                );
            }
        } catch (error) {
            if (error.failureClass) throw intact(error);
            const code = error.code || 'WINspool_OUTCOME_UNKNOWN';
            const mapped = classified(code, 'uncertain', error.message);
            // A deleted or vanished retained job is the one outcome that can leave the
            // device mid-raster (an operator cancelled it); everything else is intact.
            if (code !== 'WINspool_JOB_DELETED' && code !== 'WINspool_JOB_MISSING') intact(mapped);
            throw mapped;
        }
        const deviceStatus = observation?.device_status || 'unknown';
        const drainWaitMode = ['notification', 'poll', 'poll_fallback'].includes(observation?.drain_wait_mode)
            ? observation.drain_wait_mode
            : null;
        return {
            success: true,
            confidence: deviceStatus === 'drained' ? 'spooler_drained' : 'os_accepted',
            deviceStatus,
            windowsJobId,
            warningCode: !retained ? 'WINspool_RETAIN_UNSUPPORTED'
                : observation?.retention_released === false ? 'WINspool_RETENTION_RELEASE_FAILED'
                : null,
            durationMs: Date.now() - startedAt,
            transportMode: drainWaitMode
        };
    }

    return { send };
}

module.exports = { createTcpTransport, createWindowsTransport, verifyArtifactHash, classified, tcpTotalDeadlineMs };
