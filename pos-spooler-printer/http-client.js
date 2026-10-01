async function fetchTextWithTimeout(url, options = {}, timeoutMs = 10000, fetchFn = fetch, callerSignal = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }, timeoutMs);
    const forwardCallerAbort = () => controller.abort(callerSignal.reason);

    if (callerSignal) {
        if (callerSignal.aborted) forwardCallerAbort();
        else callerSignal.addEventListener('abort', forwardCallerAbort, { once: true });
    }

    try {
        const response = await fetchFn(url, { ...options, signal: controller.signal });
        // Fetch resolves at headers. Keep the deadline and shutdown signal attached
        // until the body has arrived too, so a partial response cannot strand sync.
        const text = await response.text();
        return { response, text };
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
    } finally {
        clearTimeout(timeout);
        callerSignal?.removeEventListener('abort', forwardCallerAbort);
    }
}

module.exports = { fetchTextWithTimeout };
