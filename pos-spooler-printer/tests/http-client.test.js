const assert = require('assert');
const { fetchTextWithTimeout } = require('../http-client');

(async () => {
    let capturedSignal;
    const hungFetch = (_url, options) => new Promise((_resolve, reject) => {
        capturedSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });

    const keepProcessAlive = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(
            fetchTextWithTimeout('https://example.invalid/ack', {}, 5, hungFetch),
            error => error?.name === 'TimeoutError'
        );
    } finally {
        clearTimeout(keepProcessAlive);
    }
    assert.strictEqual(capturedSignal.aborted, true);

    const caller = new AbortController();
    let listenerRemoved = 0;
    const originalRemove = caller.signal.removeEventListener.bind(caller.signal);
    caller.signal.removeEventListener = (...args) => {
        listenerRemoved += 1;
        return originalRemove(...args);
    };
    let callerSignal;
    const callerHungFetch = (_url, options) => new Promise((_resolve, reject) => {
        callerSignal = options.signal;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    const callerKeepAlive = setTimeout(() => {}, 2000);
    const callerRequest = fetchTextWithTimeout('https://example.invalid/caller-abort', {}, 1000, callerHungFetch, caller.signal);
    const callerReason = new Error('runtime stopped');
    caller.abort(callerReason);
    try {
        await assert.rejects(callerRequest, error => error === callerReason);
    } finally {
        clearTimeout(callerKeepAlive);
    }
    assert.strictEqual(callerSignal.aborted, true);
    assert.strictEqual(listenerRemoved, 1, 'the caller abort listener must be removed after rejection');

    const alreadyAborted = new AbortController();
    const alreadyReason = new Error('already stopped');
    alreadyAborted.abort(alreadyReason);
    await assert.rejects(
        fetchTextWithTimeout('https://example.invalid/already-aborted', {}, 1000, async (_url, options) => {
            assert.strictEqual(options.signal.aborted, true);
            throw options.signal.reason;
        }, alreadyAborted.signal),
        error => error === alreadyReason
    );

    let clearCalls = 0;
    const originalClearTimeout = global.clearTimeout;
    global.clearTimeout = timer => {
        clearCalls += 1;
        return originalClearTimeout(timer);
    };
    try {
        const completed = await fetchTextWithTimeout(
            'https://example.invalid/complete',
            {},
            1000,
            async () => ({ ok: true, text: async () => 'complete' })
        );
        assert.strictEqual(completed.response.ok, true);
        assert.strictEqual(completed.text, 'complete');
        await assert.rejects(
            fetchTextWithTimeout('https://example.invalid/sync-throw', {}, 1000, () => {
                throw new Error('sync failure');
            }),
            /sync failure/
        );
    } finally {
        global.clearTimeout = originalClearTimeout;
    }
    assert.strictEqual(clearCalls, 2, 'normal and synchronous-failure paths must clear their deadline timers');

    process.stdout.write('ok - aborts a hung HTTP request at the configured deadline\n');
})().catch(error => {
    process.stderr.write(`not ok - aborts a hung HTTP request at the configured deadline\n${error.stack}\n`);
    process.exitCode = 1;
});
