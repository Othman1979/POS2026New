const { spawn } = require('child_process');
const readline = require('readline');

const REQUEST_TIMEOUT_MS = 10000;

async function startPlatformHelper({
    executable,
    stateRoot,
    onEvent = () => {},
    spawnFn = spawn,
    restartOnExit = false,
    restartDelayMs = 100,
    requestTimeoutMs = REQUEST_TIMEOUT_MS
}) {
    let child = null;
    let reader = null;
    let closed = false;
    let ready = false;
    let childExited = false;
    let restartTimer = null;
    let nextId = 1;
    let watchPayload = null;
    let readyResolve;
    let readyReject;
    let readyPromise = Promise.resolve();
    let exitedResolve;
    let exclusiveTail = Promise.resolve();
    let retiring = false;
    let retireChild = null;
    const exited = new Promise(resolve => { exitedResolve = resolve; });
    const pending = new Map();
    const acceptedPrints = new Set();
    const printsIdleWaiters = new Set();

    function notifyPrintsIdle() {
        if (hasActivePrintRaw()) return;
        for (const resolve of printsIdleWaiters) resolve();
        printsIdleWaiters.clear();
    }

    function rejectPending(error) {
        for (const entry of [...pending.values()]) {
            if (typeof entry.finish === 'function') entry.finish(error);
            else {
                clearTimeout(entry.timer);
                entry.reject?.(error);
            }
        }
        pending.clear();
        acceptedPrints.clear();
        notifyPrintsIdle();
    }

    function acceptingRequests() {
        return !closed && child && ready && !childExited && !retiring;
    }

    function childWritable(targetChild) {
        return !closed && child === targetChild && !childExited;
    }

    function hasActivePrintRaw() {
        if (acceptedPrints.size > 0) return true;
        for (const entry of pending.values()) {
            if (entry.command === 'print_raw') return true;
        }
        return false;
    }

    function recycleIfIdle() {
        if (!retiring || !retireChild || hasActivePrintRaw()) return;
        const target = retireChild;
        retireChild = null;
        try { target.kill(); } catch {}
    }

    function beginRetirement(targetChild) {
        ready = false;
        retiring = true;
        retireChild = targetChild;
        recycleIfIdle();
    }

    async function requestOnChild(command, payload = {}, { beforeWrite, timeoutMs } = {}) {
        if (closed) {
            const error = new Error('PLATFORM_HELPER_CLOSED');
            error.code = 'PLATFORM_HELPER_CLOSED';
            error.failureClass = 'transient_safe';
            throw error;
        }
        if (!acceptingRequests()) {
            const error = new Error('PLATFORM_HELPER_RESTARTING');
            error.code = 'PLATFORM_HELPER_RESTARTING';
            error.failureClass = 'transient_safe';
            throw error;
        }
        const targetChild = child;
        let printToken = null;
        let nativePending = false;
        if (command === 'print_raw') {
            if (acceptedPrints.size >= 64) {
                throw Object.assign(new Error('PLATFORM_HELPER_BUSY'), { code: 'PLATFORM_HELPER_BUSY', failureClass: 'transient_safe' });
            }
            printToken = {};
            acceptedPrints.add(printToken);
        }
        const releasePrint = () => {
            if (!printToken) return;
            acceptedPrints.delete(printToken);
            printToken = null;
            recycleIfIdle();
            notifyPrintsIdle();
        };
        try {
            let transportStarted = false;
            if (typeof beforeWrite === 'function') {
                await beforeWrite();
                transportStarted = true;
            }
            if (!childWritable(targetChild)) {
                const error = new Error('PLATFORM_HELPER_RESTARTING');
                error.code = 'PLATFORM_HELPER_RESTARTING';
                error.failureClass = transportStarted ? 'uncertain' : 'transient_safe';
                throw error;
            }
            if (!acceptingRequests() && command !== 'print_raw') {
                const error = new Error('PLATFORM_HELPER_RESTARTING');
                error.code = 'PLATFORM_HELPER_RESTARTING';
                error.failureClass = 'transient_safe';
                throw error;
            }
            const id = nextId++;
            const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : requestTimeoutMs;
            return await new Promise((resolve, reject) => {
                const finish = (error, result) => {
                    if (!pending.has(id)) return;
                    const entry = pending.get(id);
                    pending.delete(id);
                    nativePending = false;
                    clearTimeout(entry.timer);
                    releasePrint();
                    if (error) reject(error);
                    else resolve(result);
                };
                const timer = setTimeout(() => {
                    const error = new Error('PLATFORM_HELPER_TIMEOUT');
                    error.code = 'PLATFORM_HELPER_TIMEOUT';
                    error.failureClass = command === 'print_raw' ? 'uncertain' : 'transient_safe';
                    if (command === 'print_raw') {
                        // A JS deadline cannot cancel WritePrinter safely. Retain the
                        // request/token until the native reply (or process exit), so
                        // another timeout cannot recycle the child mid-raster. Other
                        // printers can still use independent native worker threads.
                        reject(error);
                        return;
                    }
                    finish(error);
                    beginRetirement(targetChild);
                }, timeout);
                pending.set(id, { finish, timer, command });
                nativePending = command === 'print_raw';
                try {
                    targetChild.stdin.write(`${JSON.stringify({ id, command, payload })}\n`, error => {
                        if (!error || !pending.has(id)) return;
                        error.failureClass = 'uncertain';
                        finish(error);
                    });
                } catch (error) {
                    error.failureClass = 'uncertain';
                    finish(error);
                }
            });
        } catch (error) {
            if (!nativePending) releasePrint();
            throw error;
        }
    }

    function scheduleRestart() {
        if (closed || !restartOnExit || restartTimer !== null) return;
        restartTimer = setTimeout(() => {
            restartTimer = null;
            spawnChild().catch(error => {
                onEvent({ type: 'fatal', code: error.code || 'PLATFORM_HELPER_RESTART_FAILED' });
                scheduleRestart();
            });
        }, restartDelayMs);
    }

    async function spawnChild() {
        if (closed) return;
        ready = false;
        retiring = false;
        retireChild = null;
        childExited = false;
        readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        child = spawnFn(executable, ['--state-root', stateRoot], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        reader = readline.createInterface({ input: child.stdout });
        reader.on('line', line => {
            let message;
            try { message = JSON.parse(line); } catch {
                onEvent({ type: 'protocol_error', code: 'PLATFORM_HELPER_INVALID_JSON' });
                return;
            }
            if (message.type === 'ready') {
                if (closed || retiring) return;
                ready = true;
                readyResolve();
                if (watchPayload) {
                    const replayPayload = watchPayload;
                    runExclusive(() => requestOnChild('watch_printers', replayPayload))
                        .then(result => {
                            for (const status of result?.statuses || []) {
                                onEvent({ type: 'event', event: 'printer_status', status });
                            }
                        })
                        .catch(error => {
                            if (watchPayload === replayPayload) watchPayload = null;
                            onEvent({ type: 'watch_error', code: error.code });
                        });
                }
                return;
            }
            if (message.type === 'fatal') {
                const error = new Error(message.code || 'PLATFORM_HELPER_FATAL');
                error.code = message.code;
                readyReject(error);
                onEvent(message);
                return;
            }
            if (Number.isInteger(message.id) && pending.has(message.id)) {
                const entry = pending.get(message.id);
                if (message.error) {
                    const error = new Error(message.error.code || 'PLATFORM_HELPER_REQUEST_FAILED');
                    error.code = message.error.code;
                    entry.finish(error);
                } else {
                    entry.finish(null, message.result);
                }
                return;
            }
            onEvent(message);
        });
        child.once('exit', (code, signal) => {
            ready = false;
            childExited = true;
            reader?.close();
            reader = null;
            const error = new Error(`PLATFORM_HELPER_EXITED (${code ?? signal ?? 'unknown'})`);
            error.code = 'PLATFORM_HELPER_EXITED';
            readyReject(error);
            rejectPending(error);
            if (closed || !restartOnExit) exitedResolve({ code, signal });
            else scheduleRestart();
        });
        child.once('error', error => {
            ready = false;
            childExited = true;
            readyReject(error);
            rejectPending(error);
            if (closed || !restartOnExit) exitedResolve({ error });
            else scheduleRestart();
        });
        const startingChild = child;
        const readyTimer = setTimeout(() => {
            const error = Object.assign(new Error('PLATFORM_HELPER_START_TIMEOUT'), { code: 'PLATFORM_HELPER_START_TIMEOUT' });
            readyReject(error);
            beginRetirement(startingChild);
        }, requestTimeoutMs);
        try { await readyPromise; } finally { clearTimeout(readyTimer); }
    }

    try {
        await spawnChild();
    } catch (error) {
        // No caller owns this helper until startup returns successfully.
        await close();
        throw error;
    }

    function runExclusive(operation) {
        const current = exclusiveTail.then(operation, operation);
        exclusiveTail = current.catch(() => {});
        return current;
    }

    async function request(command, payload = {}, options = {}) { return requestOnChild(command, payload, options); }

    async function watchPrinters(printerNames) {
        const requested = { printer_names: Array.from(new Set((printerNames || []).map(String))).slice(0, 64) };
        watchPayload = requested;
        try {
            return await requestOnChild('watch_printers', requested);
        } catch (error) {
            if (watchPayload === requested) watchPayload = null;
            throw error;
        }
    }

    async function close() {
        if (closed) return;
        closed = true;
        ready = false;
        if (restartTimer !== null) clearTimeout(restartTimer);
        restartTimer = null;
        // Shutdown must not turn a caller timeout into a mid-stream kill. Keep
        // the pipe and native mutex alive until accepted native writes settle.
        if (hasActivePrintRaw()) await new Promise(resolve => printsIdleWaiters.add(resolve));
        rejectPending(Object.assign(new Error('PLATFORM_HELPER_CLOSED'), { code: 'PLATFORM_HELPER_CLOSED' }));
        if (child && !childExited) {
            try { child.stdin.end(); } catch {}
            const killTimer = setTimeout(() => child.kill(), 2000);
            await exited;
            clearTimeout(killTimer);
        } else exitedResolve({ code: 0, signal: null });
    }

    return { request, watchPrinters, runExclusive, close, exited, isReady: () => ready };
}

module.exports = { startPlatformHelper };
