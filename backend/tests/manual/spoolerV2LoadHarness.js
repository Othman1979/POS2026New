// Usage: node backend/tests/manual/spoolerV2LoadHarness.js <agentCount> <seconds> <cadenceMs>
// Destructive to the disposable test database only; never point this at customer data.
process.env.NODE_ENV = 'test';
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env.test'), override: true });
process.env.DB_NAME = process.env.DB_NAME || 'posapp_test';
process.env.DB_CONNECTION_LIMIT = '10';
process.env.SPOOLER_KEY = process.env.SPOOLER_KEY || 'test-spooler-key';
process.env.ENFORCE_HTTPS = 'false';
process.env.LOG_LEVEL = 'silent';

const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const { seedDatabase } = require('../fixtures/seed');
const agents = Number(process.argv[2] || 5);
const seconds = Number(process.argv[3] || 60);
const cadenceMs = Number(process.argv[4] || 500);
const latencies = [];
const healthLatencies = [];

function listen(server) {
    return new Promise((resolve, reject) => {
        const failed = error => reject(error);
        server.once('error', failed);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', failed);
            resolve();
        });
    });
}

async function postJson(base, route, headers, body) {
    const response = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    const responseText = await response.text();
    if (response.status >= 300) {
        throw new Error(`${route} -> ${response.status}: ${responseText.slice(0, 200)}`);
    }
    return responseText ? JSON.parse(responseText) : {};
}

async function main() {
    if (!Number.isInteger(agents) || agents < 1 || !Number.isFinite(seconds) || seconds < 1
        || !Number.isFinite(cadenceMs) || cadenceMs < 1) {
        throw new Error('agentCount, seconds, and cadenceMs must be positive numbers.');
    }
    if (!String(process.env.DB_NAME).endsWith('_test')) {
        throw new Error('Refusing to seed: DB_NAME must end with _test.');
    }

    await seedDatabase();
    const key = process.env.SPOOLER_KEY;
    const pool = require('../../config/db');
    const { server, io } = require('../../../server');

    let eventLoop;
    let onAcquire;
    let onRelease;
    try {
        await listen(server);
        const base = `http://127.0.0.1:${server.address().port}`;
        const runId = crypto.randomBytes(6).toString('hex');
        const identities = [];
        for (let index = 0; index < agents; index += 1) {
            const agentId = crypto.randomUUID();
            const secret = crypto.randomBytes(24).toString('hex');
            const spoolerId = `load-${runId}-${index}`;
            await postJson(base, '/api/spooler/v2/register', { 'x-spooler-key': key }, {
                protocol_version: 2,
                agent_id: agentId,
                spooler_id: spoolerId,
                token_hash: crypto.createHash('sha256').update(secret).digest('hex'),
                name: `Load ${index}`
            });
            identities.push({ agentId, secret });
        }

        let inUse = 0;
        let peakInUse = 0;
        onAcquire = () => { inUse += 1; peakInUse = Math.max(peakInUse, inUse); };
        onRelease = () => { inUse -= 1; };
        pool.on('acquire', onAcquire);
        pool.on('release', onRelease);
        eventLoop = monitorEventLoopDelay({ resolution: 20 });
        eventLoop.enable();
        const before = pool.connectionTelemetrySnapshot();
        const workloadStarted = performance.now();
        const deadline = Date.now() + seconds * 1000;
        let throttledResponses = 0;

        const healthSampler = (async () => {
            while (Date.now() < deadline) {
                const started = performance.now();
                const response = await fetch(`${base}/health`);
                if (!response.ok) throw new Error(`/health -> ${response.status}`);
                healthLatencies.push(performance.now() - started);
                await new Promise(resolve => setTimeout(resolve, cadenceMs));
            }
        })();

        await Promise.all([...identities.map(async ({ agentId, secret }, index) => {
            await new Promise(resolve => setTimeout(resolve, (index * 400) % 2000));
            while (Date.now() < deadline) {
                const started = performance.now();
                const response = await postJson(base, '/api/spooler/v2/sync', {
                    'x-agent-id': agentId,
                    'x-agent-token': secret
                }, { protocol_version: 2, accepted: [], results: [], health: {}, capacity: 1 });
                if (response.throttled === true) throttledResponses += 1;
                latencies.push(performance.now() - started);
                await new Promise(resolve => setTimeout(resolve, cadenceMs));
            }
        }), healthSampler]);

        eventLoop.disable();
        const elapsedSeconds = (performance.now() - workloadStarted) / 1000;
        const after = pool.connectionTelemetrySnapshot();
        const delta = Object.fromEntries(Object.keys(after).map(name => [name, after[name] - before[name]]));
        latencies.sort((a, b) => a - b);
        const percentile = quantile => Math.round(latencies[Math.min(
            latencies.length - 1,
            Math.floor((latencies.length - 1) * quantile)
        )]);
        healthLatencies.sort((a, b) => a - b);
        const healthPercentile = quantile => Math.round(healthLatencies[Math.min(
            healthLatencies.length - 1,
            Math.floor((healthLatencies.length - 1) * quantile)
        )]);
        const result = {
            agents,
            seconds,
            cadence_ms: cadenceMs,
            syncs: latencies.length,
            throttled_responses: throttledResponses,
            request_rate_per_second: Number((latencies.length / elapsedSeconds).toFixed(2)),
            p50_ms: percentile(0.50),
            p95_ms: percentile(0.95),
            p99_ms: percentile(0.99),
            health: {
                requests: healthLatencies.length,
                p50_ms: healthPercentile(0.50),
                p95_ms: healthPercentile(0.95)
            },
            pool: { ...delta, peak_in_use: peakInUse, active_at_end: inUse },
            event_loop_delay_ms: {
                mean: Number((eventLoop.mean / 1e6).toFixed(2)),
                p95: Number((eventLoop.percentile(95) / 1e6).toFixed(2)),
                max: Number((eventLoop.max / 1e6).toFixed(2))
            }
        };
        console.log(JSON.stringify(result));
        if (throttledResponses !== 0) throw new Error(`Observed ${throttledResponses} throttled sync responses.`);
        if (delta.enqueued !== 0) throw new Error(`Observed ${delta.enqueued} queued DB acquisitions.`);
        if (inUse !== 0) throw new Error(`Observed ${inUse} DB connections still acquired at completion.`);
    } finally {
        eventLoop?.disable();
        if (onAcquire) pool.off('acquire', onAcquire);
        if (onRelease) pool.off('release', onRelease);
        await new Promise(resolve => io.close(resolve));
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await pool.end();
    }
}

// Requiring server.js starts its module-scope intervals (server.js:61, :376 and the
// ones init arms), so the event loop never drains and the watchdog goes on polling a
// pool this harness has already ended. A harness whose entire output is one JSON line
// has nothing left to do, so flush that line and leave deliberately. Without this a
// PASSING run hangs forever holding test-database connections - only the failure path
// below used to terminate.
function leave(code) {
    process.stdout.write('', () => process.exit(code));
}

main().then(() => leave(0), error => {
    console.error(error);
    leave(1);
});
