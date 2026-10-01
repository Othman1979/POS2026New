const assert = require('assert');
const http = require('http');
const { once } = require('events');
const { createSyncClient, V2_SYNC_WAIT_MS } = require('../v2/sync-client');

function clientOptions(baseUrl, overrides = {}) {
    return {
        baseUrl,
        agentId: '11111111-1111-4111-8111-111111111111',
        secret: Buffer.alloc(32, 1),
        bootstrapKey: 'local-test-only',
        spoolerId: 'primary',
        ...overrides
    };
}

async function withServer(handler, run) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await closed;
    }
}

async function stalledBody({ cancel = false } = {}) {
    let headersReceived;
    const headers = new Promise(resolve => { headersReceived = resolve; });
    let peerClosed;
    const closed = new Promise(resolve => { peerClosed = resolve; });
    await withServer((_req, res) => {
        res.on('close', peerClosed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"agent_status":');
    }, async baseUrl => {
        const caller = new AbortController();
        const reason = new Error('local runtime stopped');
        const client = createSyncClient(clientOptions(baseUrl, {
            timeoutMs: cancel ? 10000 : 250,
            fetchFn: async (...args) => {
                const response = await fetch(...args);
                headersReceived();
                return response;
            }
        }));
        const started = performance.now();
        const request = client.sync({ protocol_version: 2 }, { signal: caller.signal });
        // Observe rejection immediately, including while the first headers are in flight.
        const outcome = request.then(value => ({ value }), error => ({ error }));
        let guard;
        const deadline = new Promise((_, reject) => {
            guard = setTimeout(() => reject(new Error(`${cancel ? 'caller cancellation' : 'deadline'} must close a stalled response body`)), 1500);
        });
        try {
            await Promise.race([headers, deadline, outcome.then(result => { throw result.error || new Error('response unexpectedly completed'); })]);
            if (cancel) caller.abort(reason);
            const result = await Promise.race([outcome, deadline]);
            if (cancel) assert.strictEqual(result.error, reason);
            else assert.strictEqual(result.error?.name, 'TimeoutError');
            await Promise.race([closed, deadline]);
            console.log(`ok - stalled sync body ${cancel ? 'canceled' : 'timed out'} and connection closed (${Math.round(performance.now() - started)} ms)`);
        } finally {
            clearTimeout(guard);
        }
    });
}

(async () => {
    await stalledBody();
    await stalledBody({ cancel: true });
    let received;
    await withServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        received = JSON.parse(body);
        if (req.url.endsWith('/register')) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end('{"code":"station_busy"}');
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"agent_status":"active","jobs":[]}');
        }
    }, async baseUrl => {
        const client = createSyncClient(clientOptions(baseUrl));
        assert.deepStrictEqual(await client.sync({ protocol_version: 2, wait_ms: 99999 }), { agent_status: 'active', jobs: [] });
        assert.strictEqual(received.wait_ms, V2_SYNC_WAIT_MS);
        assert.strictEqual(received.spooler_id, 'primary');
        await assert.rejects(client.register(), error => error.status === 409 && error.code === 'station_busy');
    });
    console.log('v2-sync-client tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
