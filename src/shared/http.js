export async function fetchJsonResponse(resource, options) {
    const response = await fetch(resource, options);
    const data = await response.json();
    return { response, data };
}

export async function fetchJson(resource, options) {
    const { data } = await fetchJsonResponse(resource, options);
    return data;
}

// Covers headers AND JSON bodies, including transports that do not reject on
// abort. Mutations using this must retain their idempotency/uncertainty handling:
// cancelling the client's wait does not mean the server rolled back.
export async function fetchJsonResponseWithTimeout(resource, options = {}, timeoutMs = 15000) {
    if (options.signal?.aborted) throw options.signal.reason;
    const controller = new AbortController();
    const cancel = () => controller.abort(options.signal.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timeout = setTimeout(() => {
        controller.abort(new DOMException('Request timed out.', 'TimeoutError'));
    }, timeoutMs);
    try {
        return await Promise.race([
            fetchJsonResponse(resource, { ...options, signal: controller.signal }),
            aborted,
        ]);
    } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', onAbort);
        options.signal?.removeEventListener('abort', cancel);
    }
}

export const fetchReadJsonResponse = fetchJsonResponseWithTimeout;

// Bounds only the caller's wait; the request itself keeps going (use with
// keepalive for requests that must reach the server, like logout).
export const waitAtMost = (promise, timeoutMs) => new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    Promise.resolve(promise).catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
});

// The request may have reached the server: a deadline, abort, dropped link or
// unreadable body is an uncertain outcome, never a confirmed failure.
export const isUnansweredRequest = (error) => ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'].includes(error?.name);
