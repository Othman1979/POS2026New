// Disposable end-to-end Shifts report/spooler recovery audit.
// All HTTP, MySQL and printer traffic is loopback; no machine spooler or physical printer is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
process.env.POSAPP_REVIEW_DB = `posapp_review_recipe_p1_${crypto.randomBytes(6).toString('hex')}`;
process.env.SPOOLER_KEY = `shift-report-recovery-${crypto.randomBytes(16).toString('hex')}`;
require('./recipe-ledger-phase1-preload.cjs');

const mysql = require('mysql2/promise');
const { database, ...databaseOptions } = require('../../backend/tests/testDatabase.cjs').getTestDatabaseOptions();
const pool = require('../../backend/config/db');
const fixtures = require('../../backend/tests/helpers/fixtures');
const { createAgentRuntime } = require('../../pos-spooler-printer/v2/agent-runtime');
const { createSyncClient } = require('../../pos-spooler-printer/v2/sync-client');
const { openJobStore } = require('../../pos-spooler-printer/v2/job-store');
const { createTypstRenderer } = require('../../pos-spooler-printer/v2/typst-renderer');
const { createPrinterWorkers } = require('../../pos-spooler-printer/v2/printer-workers');
const { createTcpTransport } = require('../../pos-spooler-printer/v2/printer-transports');

const outputDirectory = path.join(root, 'scratch', 'shift-report-spooler-recovery');
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-shift-report-recovery-'));
const peers = new Set();
const sinks = new Set();
let appServer;
let io;
let createdDatabase = false;
let agent;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

async function waitFor(read, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await sleep(25);
    }
    throw new Error(`Timed out waiting for ${label}.`);
}

async function closeServer(server) {
    if (!server?.listening) return;
    server.closeAllConnections?.();
    let timeout;
    try {
        await Promise.race([
            new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error('Loopback server cleanup timed out.')), 3000);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

async function createSink(port = 0) {
    const connections = [];
    const errors = [];
    const server = net.createServer(socket => {
        peers.add(socket);
        const chunks = [];
        socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
        socket.on('end', () => connections.push(Buffer.concat(chunks)));
        socket.on('close', () => peers.delete(socket));
        socket.on('error', error => errors.push(error));
    });
    server.on('error', error => errors.push(error));
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const sink = { server, port: server.address().port, connections, errors };
    sinks.add(sink);
    return sink;
}

async function reservePort() {
    const reservation = await createSink();
    const port = reservation.port;
    await closeServer(reservation.server);
    sinks.delete(reservation);
    return port;
}

async function requestJson(baseUrl, route, { method = 'GET', cookie = '', body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(new Error(`${method} ${route} exceeded its response deadline.`)),
        15000
    );
    let response;
    let text;
    try {
        response = await fetch(`${baseUrl}${route}`, {
            method,
            headers: {
                ...(cookie ? { cookie } : {}),
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        text = await response.text();
    } finally {
        clearTimeout(timeout);
    }
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    assert(response.ok, `${method} ${route} failed (${response.status}): ${JSON.stringify(payload)}`);
    return { response, payload };
}

async function login(baseUrl) {
    const { response, payload } = await requestJson(baseUrl, '/api/auth/login', {
        method: 'POST',
        body: { user_number: '9001' },
    });
    assert.equal(payload.success, true);
    const values = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
    const cookie = values.map(value => value.split(';', 1)[0]).join('; ');
    assert(cookie, 'login did not return a session cookie');
    return cookie;
}

function createRenderer() {
    return createTypstRenderer({ stateRoot, executable: process.env.SPOOLER_TYPST_EXE, fontPath: process.env.SPOOLER_TYPST_FONT_DIR, env: process.env });
}

function startAgent(baseUrl, identity, { loseResultAckFor = null } = {}) {
    const store = openJobStore({ stateRoot });
    const renderer = createRenderer();
    const tcpTransport = createTcpTransport({ connectMs: 1000, writeIdleMs: 3000, totalMs: 10000 });
    const client = createSyncClient({
        baseUrl,
        agentId: identity.agentId,
        secret: identity.secret,
        bootstrapKey: process.env.SPOOLER_KEY,
        spoolerId: identity.spoolerId,
        spoolerName: 'Shift report recovery fixture',
        agentVersion: 'review',
        timeoutMs: 5000,
    });
    let lostAckResolve;
    const lostAck = new Promise(resolve => { lostAckResolve = resolve; });
    let discarded = false;
    const syncClient = {
        register: (...args) => client.register(...args),
        async sync(body, options) {
            const targetResult = loseResultAckFor != null
                && body.results?.some(result => Number(result.queue_id) === Number(loseResultAckFor));
            const response = await client.sync(body, options);
            if (targetResult && !discarded) {
                discarded = true;
                lostAckResolve(response);
                throw Object.assign(new Error('INTENTIONAL_RESULT_ACK_LOSS'), { code: 'INTENTIONAL_RESULT_ACK_LOSS' });
            }
            return response;
        },
    };
    let runtime;
    const workers = createPrinterWorkers({
        store,
        renderer,
        transportFor: () => tcpTransport,
        onResultReady: () => runtime?.wake(),
    });
    runtime = createAgentRuntime({
        store,
        syncClient,
        worker: workers,
        startupJitterMs: 0,
        random: () => 0,
        log: () => {},
    });
    runtime.start();
    return {
        store,
        runtime,
        renderer,
        lostAck,
        async stop() {
            await runtime.stop();
            await renderer.close();
        },
    };
}

async function queueReport(baseUrl, cookie, route, body) {
    const [[before]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM print_queue');
    const { payload } = await requestJson(baseUrl, route, { method: 'POST', cookie, body });
    assert.equal(payload.success, true);
    assert.equal(payload.print_queued, true);
    const [[row]] = await pool.query(
        'SELECT id, payload, status FROM print_queue WHERE id > ? ORDER BY id ASC LIMIT 1',
        [before.id]
    );
    assert(row, `route ${route} did not create a print_queue row`);
    return { queueId: Number(row.id), queuedPayload: JSON.parse(row.payload), response: payload };
}

async function acknowledged(queueId) {
    return waitFor(async () => {
        const [[row]] = await pool.query(
            'SELECT status, artifact_hash, artifact_bytes FROM print_queue WHERE id = ?',
            [queueId]
        );
        return row?.status === 'acknowledged' ? row : null;
    }, 30000, `queue ${queueId} acknowledgement`);
}

async function verifyDelivery(label, queued, sink, connectionIndex) {
    const row = await acknowledged(queued.queueId);
    const bytes = await waitFor(
        () => sink.connections[connectionIndex],
        5000,
        `${label} loopback bytes`
    );
    const local = agent.store.get(queued.queueId);
    assert(local?.artifact, `${label} has no durable local artifact metadata`);
    assert.equal(bytes.length, Number(row.artifact_bytes));
    assert.equal(sha256(bytes), row.artifact_hash);
    assert.equal(bytes.length, Number(local.artifact.bytes));
    assert.equal(sha256(bytes), local.artifact.hash);
    return {
        label,
        queue_id: queued.queueId,
        print_type: queued.queuedPayload.print_type,
        bytes: bytes.length,
        sha256: sha256(bytes),
        transport_confidence: 'bytes_sent',
    };
}

async function seedY(day) {
    const cart = {
        order_type_id: 1,
        items: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Recovery Y item ${index + 1}`, category_id: 1, qty: 2, price: 5, tax_rate: 0 })),
    };
    await pool.query(
        'INSERT INTO held_orders (user_id,reference_name,cart_data,subtotal,created_at) VALUES (2,?,?,1000,?)',
        ['RECOVERY-DETAIL-MUST-NOT-PRINT', JSON.stringify(cart), `${day} 08:30:00`]
    );
}

async function run() {
    assert(['127.0.0.1', 'localhost'].includes(String(databaseOptions.host || '127.0.0.1')));
    assert(/^posapp_review_recipe_p1_[a-f0-9]{12}$/.test(database));
    const admin = await mysql.createConnection(databaseOptions);
    try {
        await admin.query(`CREATE DATABASE \`${database}\``);
        createdDatabase = true;
    } finally {
        await admin.end();
    }
    await require('../../backend/tests/fixtures/seed').seedDatabase();
    await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='y_order_type_id'");

    const mainSink = await createSink();
    const spoolerId = `shift-report-${crypto.randomBytes(5).toString('hex')}`;
    const printerId = await fixtures.seedReceiptPrinter(pool, { name: 'Loopback report printer' });
    await pool.query(
        "UPDATE printers SET type='network', network_ip='127.0.0.1', network_port=?, spooler_id=?, status_capability='write_only' WHERE id=?",
        [mainSink.port, spoolerId, printerId]
    );

    const day = require('../../backend/utils/businessDate').getBusinessDate();
    const openShift = await fixtures.insertShift(pool, { opened_at: `${day} 07:00:00` });
    const closedShift = await fixtures.insertShift(pool, {
        status: 'closed', actual_cash: 50, opened_at: `${day} 05:00:00`, closed_at: `${day} 06:00:00`,
    });

    ({ server: appServer, io } = require('../../server'));
    await new Promise((resolve, reject) => {
        appServer.once('error', reject);
        appServer.listen(0, '127.0.0.1', () => {
            appServer.off('error', reject);
            resolve();
        });
    });
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    const cookie = await login(baseUrl);
    const identity = { agentId: crypto.randomUUID(), secret: crypto.randomBytes(32), spoolerId };
    agent = startAgent(baseUrl, identity);

    const successful = [];
    let queued = await queueReport(baseUrl, cookie, `/api/admin/shift-reports/${openShift}/print`, {
        delivery: 'spooler', receipt_printer_id: printerId, type: 'x_report',
    });
    successful.push(await verifyDelivery('X report', queued, mainSink, 0));

    queued = await queueReport(baseUrl, cookie, `/api/admin/shift-reports/${closedShift}/print`, {
        delivery: 'spooler', receipt_printer_id: printerId, type: 'z_report',
    });
    successful.push(await verifyDelivery('Z report', queued, mainSink, 1));

    await seedY(day);
    queued = await queueReport(baseUrl, cookie, '/api/admin/audit-reports/print-y', {
        delivery: 'spooler', receipt_printer_id: printerId, business_date: day,
    });
    assert.equal(queued.queuedPayload.print_type, 'y_held_items_report');
    assert.equal(queued.queuedPayload.data.orders, undefined, 'queued Y report leaked receipt/order detail');
    assert.equal(queued.queuedPayload.data.items.length, 100, 'large Y must retain every distinct item');
    assert.equal(queued.queuedPayload.data.summary.total, 1000);
    successful.push(await verifyDelivery('Y report', queued, mainSink, 2));

    // The server commits this result, but the client loses the response before it can
    // archive its completed journal record. A restart must replay only the outbox.
    await agent.stop();
    const beforeLostAckConnections = mainSink.connections.length;
    const lostAckQueued = await queueReport(baseUrl, cookie, `/api/admin/shift-reports/${closedShift}/print`, {
        delivery: 'spooler', receipt_printer_id: printerId, type: 'z_report',
    });
    agent = startAgent(baseUrl, identity, { loseResultAckFor: lostAckQueued.queueId });
    let lostAckTimeout;
    try {
        await Promise.race([
            agent.lostAck,
            new Promise((_, reject) => {
                lostAckTimeout = setTimeout(
                    () => reject(new Error('Timed out waiting for intentional result ACK loss.')),
                    30000
                );
            }),
        ]);
    } finally {
        clearTimeout(lostAckTimeout);
    }
    const lostAckRow = await acknowledged(lostAckQueued.queueId);
    await waitFor(() => mainSink.connections.length === beforeLostAckConnections + 1, 5000, 'lost-ACK first delivery');
    assert.equal(agent.store.get(lostAckQueued.queueId)?.state, 'completed');
    assert(agent.store.outbox().some(result => result.queue_id === lostAckQueued.queueId));
    await agent.stop();
    const deliveriesBeforeRestart = mainSink.connections.length;

    agent = startAgent(baseUrl, identity);
    await waitFor(() => agent.store.outbox().length === 0, 15000, 'journal result confirmation after restart');
    await sleep(750);
    assert.equal(mainSink.connections.length, deliveriesBeforeRestart, 'completed journal replay duplicated TCP delivery');
    assert.equal(agent.store.get(lostAckQueued.queueId)?.state, 'completed');

    // Fail before the transport marker, persist retry_wait, restart, then make the
    // same loopback endpoint available. Recovery should deliver exactly once.
    await agent.stop();
    const recoveryPort = await reservePort();
    await pool.query('UPDATE printers SET network_port=? WHERE id=?', [recoveryPort, printerId]);
    const preSendQueued = await queueReport(baseUrl, cookie, `/api/admin/shift-reports/${openShift}/print`, {
        delivery: 'spooler', receipt_printer_id: printerId, type: 'x_report',
    });
    agent = startAgent(baseUrl, identity);
    await waitFor(() => agent.store.get(preSendQueued.queueId)?.state === 'retry_wait', 30000, 'pre-send retry journal state');
    assert.equal(agent.store.get(preSendQueued.queueId)?.result?.failure_class, 'transient_safe');
    await agent.stop();

    const recoverySink = await createSink(recoveryPort);
    agent = startAgent(baseUrl, identity);
    const preSendRow = await acknowledged(preSendQueued.queueId);
    const recoveredBytes = await waitFor(() => recoverySink.connections[0], 10000, 'pre-send recovered delivery');
    await sleep(500);
    assert.equal(recoverySink.connections.length, 1);
    assert.equal(recoveredBytes.length, Number(preSendRow.artifact_bytes));
    assert.equal(sha256(recoveredBytes), preSendRow.artifact_hash);
    for (const sink of sinks) assert.deepEqual(sink.errors, [], 'loopback sink reported a network error');

    const evidence = {
        generated_database: database,
        network_scope: 'loopback-only',
        renderer: 'real Typst renderer',
        successful,
        lost_result_ack_recovery: {
            queue_id: lostAckQueued.queueId,
            server_status_before_restart: lostAckRow.status,
            durable_local_state_before_restart: 'completed',
            result_replayed_after_restart: true,
            tcp_deliveries_before_restart: deliveriesBeforeRestart,
            tcp_deliveries_after_restart: mainSink.connections.length,
            duplicate_delivery: false,
        },
        pre_send_recovery: {
            queue_id: preSendQueued.queueId,
            durable_state_before_restart: 'retry_wait',
            recovered_status: preSendRow.status,
            tcp_deliveries: recoverySink.connections.length,
            bytes: recoveredBytes.length,
            sha256: sha256(recoveredBytes),
        },
        limitation: 'TCP bytes_sent and hash equality do not prove physical paper completion or field-printer behavior.',
    };
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, 'results.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    const cleanupErrors = [];
    try { await agent?.stop(); } catch {}
    for (const socket of peers) socket.destroy();
    for (const sink of sinks) {
        try { await closeServer(sink.server); } catch (error) { cleanupErrors.push(error); }
    }
    try { if (io) await new Promise(resolve => io.close(resolve)); } catch (error) { cleanupErrors.push(error); }
    try { await closeServer(appServer); } catch (error) { cleanupErrors.push(error); }
    try { await pool.end(); } catch (error) { cleanupErrors.push(error); }
    if (createdDatabase) {
        try {
            const admin = await mysql.createConnection(databaseOptions);
            try { await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); }
        } catch (error) {
            console.error(`Could not remove generated review database ${database}: ${error.message}`);
            process.exitCode = 1;
        }
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
    if (cleanupErrors.length) {
        for (const error of cleanupErrors) console.error(`Cleanup failed: ${error.message}`);
        process.exitCode = 1;
    }
});
