const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createAgentRuntime } = require('../v2/agent-runtime');
const { openJobStore } = require('../v2/job-store');
const { createSyncClient } = require('../v2/sync-client');

class FakeClock {
    constructor() {
        this.nextId = 1;
        this.timers = new Map();
    }

    setTimeout(callback) {
        const id = this.nextId++;
        this.timers.set(id, callback);
        return id;
    }

    clearTimeout(id) {
        this.timers.delete(id);
    }

    async runNext() {
        const next = this.timers.entries().next().value;
        assert(next, 'expected the agent to schedule another connection attempt');
        this.timers.delete(next[0]);
        await next[1]();
        await new Promise(resolve => setImmediate(resolve));
    }
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch (error) {
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve(server.address());
        });
    });
}

(async () => {
    const agentId = '11111111-1111-4111-8111-111111111111';
    const stationId = 'kitchen-terminal';
    const bootstrapKey = 'test-bootstrap-key';
    const secret = crypto.randomBytes(32);
    const credential = secret.toString('base64url');
    const requests = [];
    let registered = false;

    const server = http.createServer(async (request, response) => {
        try {
            const body = await readJson(request);
            requests.push({ method: request.method, url: request.url, headers: request.headers, body });

            response.setHeader('content-type', 'application/json');
            if (request.url === '/api/spooler/v2/sync' && !registered) {
                response.statusCode = 401;
                response.end(JSON.stringify({ code: 'unauthorized_agent' }));
                return;
            }
            if (request.url === '/api/spooler/v2/register') {
                registered = true;
                response.statusCode = 201;
                response.end(JSON.stringify({ success: true, status: 'active', station_protocol: 'v2' }));
                return;
            }
            if (request.url === '/api/spooler/v2/sync') {
                response.end(JSON.stringify({
                    success: true,
                    agent_status: 'active',
                    station_protocol: 'v2',
                    confirmed_accepted: [],
                    confirmed_results: [],
                    cancel_requested: [],
                    health_warnings: [],
                    jobs: [],
                    next_sync_ms: 2000
                }));
                return;
            }
            response.statusCode = 404;
            response.end(JSON.stringify({ code: 'not_found' }));
        } catch (error) {
            response.statusCode = 500;
            response.end(JSON.stringify({ code: error.message }));
        }
    });

    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-connect-'));
    let runtime;
    try {
        const address = await listen(server);
        const client = createSyncClient({
            baseUrl: `http://127.0.0.1:${address.port}`,
            agentId,
            secret,
            bootstrapKey,
            spoolerId: stationId,
            agentVersion: 'test'
        });
        const store = openJobStore({ stateRoot });
        const clock = new FakeClock();
        const worker = {
            starts: 0,
            start() { this.starts += 1; },
            stop() {},
            health() { return { active: 0 }; }
        };
        runtime = createAgentRuntime({
            store,
            syncClient: client,
            worker,
            clock,
            startupJitterMs: 0,
            random: () => 0
        });

        runtime.start();
        await clock.runNext();
        assert.strictEqual(worker.starts, 0, 'workers must stay stopped until the server accepts the agent');
        await clock.runNext();
        assert.strictEqual(worker.starts, 1, 'workers must start after an accepted authenticated sync');

        assert.deepStrictEqual(requests.map(entry => entry.url), [
            '/api/spooler/v2/sync',
            '/api/spooler/v2/register',
            '/api/spooler/v2/sync'
        ]);
        assert(requests.every(entry => entry.method === 'POST'));

        const registration = requests[1];
        assert.strictEqual(registration.headers['x-spooler-key'], bootstrapKey);
        assert.strictEqual(registration.body.agent_id, agentId);
        assert.strictEqual(registration.body.spooler_id, stationId);
        assert.strictEqual(registration.body.wait_ms, undefined, 'registration must not negotiate sync waiting');
        assert.strictEqual(
            registration.body.token_hash,
            crypto.createHash('sha256').update(credential).digest('hex')
        );

        for (const sync of [requests[0], requests[2]]) {
            assert.strictEqual(sync.headers['x-agent-id'], agentId);
            assert.strictEqual(sync.headers['x-agent-token'], credential);
            assert.strictEqual(sync.body.spooler_id, stationId);
            assert.strictEqual(sync.body.wait_ms, 6000);
        }
        assert(!JSON.stringify(requests.map(entry => entry.body)).includes(credential),
            'the raw agent credential must remain in headers and never enter a request body');
    } finally {
        if (runtime) await runtime.stop();
        if (server.listening) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
        fs.rmSync(stateRoot, { recursive: true, force: true });
    }

    console.log('v2-agent-connect tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
