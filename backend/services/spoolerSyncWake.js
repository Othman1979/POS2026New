const logger = require('../config/logger');

function createSpoolerSyncWakeHub({
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    onSubscriberError = () => {}
} = {}) {
    let currentGeneration = 0;
    let closed = false;
    const waiters = new Map();
    const subscribers = new Set();

    function generation() {
        return currentGeneration;
    }

    function waitForChange(agentId, since, { timeoutMs = 0, signal = null } = {}) {
        if (closed) return Promise.resolve('closed');
        if (Number(since) !== currentGeneration) return Promise.resolve('changed');
        if (signal?.aborted) return Promise.resolve('aborted');

        const key = String(agentId);
        waiters.get(key)?.finish('superseded');

        return new Promise(resolve => {
            const entry = {
                timer: null,
                onAbort: null,
                settled: false,
                finish(reason) {
                    if (entry.settled) return;
                    entry.settled = true;
                    if (entry.timer !== null) clearTimeoutFn(entry.timer);
                    if (entry.onAbort) signal.removeEventListener('abort', entry.onAbort);
                    if (waiters.get(key) === entry) waiters.delete(key);
                    resolve(reason);
                }
            };

            waiters.set(key, entry);
            entry.timer = setTimeoutFn(
                () => entry.finish('timeout'),
                Math.max(0, Number(timeoutMs) || 0)
            );
            if (signal) {
                entry.onAbort = () => entry.finish('aborted');
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
        });
    }

    function publish() {
        if (closed) return currentGeneration;
        currentGeneration += 1;
        for (const entry of [...waiters.values()]) entry.finish('changed');
        for (const listener of [...subscribers]) {
            try {
                listener(currentGeneration);
            } catch (error) {
                try { onSubscriberError(error); } catch {}
            }
        }
        return currentGeneration;
    }

    function subscribe(listener) {
        if (closed || typeof listener !== 'function') return () => {};
        subscribers.add(listener);
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            subscribers.delete(listener);
        };
    }

    function close() {
        if (closed) return;
        closed = true;
        for (const entry of [...waiters.values()]) entry.finish('closed');
        subscribers.clear();
    }

    function snapshot() {
        return { generation: currentGeneration, waiters: waiters.size, closed };
    }

    return { generation, waitForChange, subscribe, publish, close, snapshot };
}

const spoolerSyncWakeHub = createSpoolerSyncWakeHub({
    onSubscriberError(error) {
        logger.error({ err: error }, 'Spooler sync wake subscriber failed.');
    }
});
let publishErrorLogged = false;

function safePublishSpoolerSyncWake() {
    try {
        return spoolerSyncWakeHub.publish();
    } catch (error) {
        if (!publishErrorLogged) {
            publishErrorLogged = true;
            logger.error({ err: error }, 'Failed to publish the spooler sync wake.');
        }
        return null;
    }
}

async function commitAndPublishSpoolerSyncWake(conn, publish = safePublishSpoolerSyncWake) {
    await conn.commit();
    publish();
}

module.exports = {
    createSpoolerSyncWakeHub,
    spoolerSyncWakeHub,
    safePublishSpoolerSyncWake,
    commitAndPublishSpoolerSyncWake
};
