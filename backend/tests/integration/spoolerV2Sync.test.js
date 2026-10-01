const request = require('supertest');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const {
    SYNC_MAX,
    V2_THROTTLE_SYNC_MS,
    V2_POST_HOLD_SYNC_MS
} = require('../../routes/spoolerV2');
const { V2_IDLE_SYNC_MS, V2_NEXT_SYNC_MS, runAgentSync } = require('../../services/spoolerSync');
const { spoolerSyncWakeHub } = require('../../services/spoolerSyncWake');
const { resetLatestFailedPrintJobsCount } = require('../../services/printQueueWatchdog');

const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const AGENT_RATE = '44444444-4444-4444-8444-444444444444';
const AGENT_DRAIN_REPLAY = '55555555-5555-4555-8555-555555555555';
const AGENT_DRAIN_CANCEL = '66666666-6666-4666-8666-666666666666';
const AGENT_DRAIN_SETTLE = '77777777-7777-4777-8777-777777777777';
const AGENT_RETRY = '88888888-8888-4888-8888-888888888888';
const AGENT_AUDIT = '99999999-9999-4999-8999-999999999999';
const AGENT_BADGE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const AGENT_BAD_ARTIFACT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb001';
const AGENT_CADENCE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb01';
const SECRET_A = 'secret-token-a';
const SECRET_B = 'secret-token-b';
const SECRET_DRAIN = 'secret-token-drain';
const SECRET_PORT = 'secret-token-port';
const SECRET_BAD_ARTIFACT = 'secret-token-bad-artifact';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function register(agentId, spoolerId, secret, extra = {}) {
    return request(app)
        .post('/api/spooler/v2/register')
        .set('x-spooler-key', 'test-spooler-key')
        .send({
            protocol_version: 2,
            agent_id: agentId,
            spooler_id: spoolerId,
            token_hash: hash(secret),
            name: 'Test Agent',
            agent_version: '2.0.0',
            ...extra
        });
}

function sync(agentId, secret, body = {}, target = app) {
    return request(target)
        .post('/api/spooler/v2/sync')
        .set('x-agent-id', agentId)
        .set('x-agent-token', secret)
        .send({ protocol_version: 2, wait_ms: 0, accepted: [], results: [], health: {}, capacity: 1, ...body });
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for the spooler sync lifecycle boundary.');
}

async function insertJob(spoolerId, key) {
    const [printer] = await pool.query(
        "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES (?, 'kitchen', 'windows', ?, ?)",
        [`P-${key}`, `W-${key}`, spoolerId]
    );
    const payload = {
        print_type: 'kitchen',
        printer_id: printer.insertId,
        printer_name: `P-${key}`,
        data: { print_batch_id: key }
    };
    const [queue] = await pool.query(
        "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', ?, REPEAT('a', 64), ?, 'kitchen')",
        [JSON.stringify(payload), key, printer.insertId]
    );
    return queue.insertId;
}

beforeAll(async () => {
    process.env.SPOOLER_KEY = 'test-spooler-key';
    await seedDatabase();
});

afterAll(async () => {
    await pool.end();
});

describe('spooler V2 registration', () => {
    beforeEach(async () => {
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
    });

    it('holds only affected printers while station ownership still routes kitchen jobs to agent A', async () => {
        await register(AGENT_A, 'route-a', SECRET_A);
        await register(AGENT_B, 'route-b', SECRET_B);
        const kitchenA = await insertJob('route-a', 'kitchen-created-from-b');
        const receiptB = await insertJob('route-b', 'local-b');
        const [[row]] = await pool.query('SELECT printer_id FROM print_queue WHERE id = ?', [kitchenA]);
        const fromB = await sync(AGENT_B, SECRET_B, { capacity: 5 });
        expect(fromB.body.jobs.map(job => job.queue_id)).toEqual([receiptB]);
        const held = await sync(AGENT_A, SECRET_A, { capacity: 5, health: {
            blocked_printer_ids: [row.printer_id, 'invalid', -1], recovery_required: 1, last_error: 'PRINTER_RECOVERY_REQUIRED'
        } });
        expect(held.body.jobs).toEqual([]);
        const resumed = await sync(AGENT_A, SECRET_A, { capacity: 5, health: { recovery_required: 0, blocked_printer_ids: [] } });
        expect(resumed.body.jobs.map(job => job.queue_id)).toEqual([kitchenA]);
        const [[agent]] = await pool.query('SELECT last_error FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        expect(agent.last_error).toBeNull();
    });

    it('refuses pre-existing cross-station network aliases before either agent receives bytes', async () => {
        await register(AGENT_A, 'legacy-a', SECRET_A);
        await register(AGENT_B, 'legacy-b', SECRET_B);
        const first = await insertJob('legacy-a', 'legacy-network-a');
        const second = await insertJob('legacy-b', 'legacy-network-b');
        const [[a]] = await pool.query('SELECT printer_id FROM print_queue WHERE id = ?', [first]);
        const [[b]] = await pool.query('SELECT printer_id FROM print_queue WHERE id = ?', [second]);
        await pool.query("UPDATE printers SET type='network', network_ip='192.0.2.111', network_port='9100', role='kitchen' WHERE id=?", [a.printer_id]);
        await pool.query("UPDATE printers SET type='network', network_ip='192.0.2.111', network_port='09100', role='receipt' WHERE id=?", [b.printer_id]);
        const aReply = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        expect(aReply.body.jobs).toEqual([]);
        expect(aReply.body.blocked_printer_ids).toContain(a.printer_id);
        expect((await sync(AGENT_B, SECRET_B, { capacity: 5 })).body.jobs).toEqual([]);
        const [rows] = await pool.query('SELECT status, agent_id FROM print_queue WHERE id IN (?, ?)', [first, second]);
        expect(rows.every(row => row.status === 'pending' && row.agent_id === null)).toBe(true);
    });

    it('activates the first registration and makes an exact repeat idempotent', async () => {
        expect((await register(AGENT_A, 'station-1', SECRET_A)).status).toBe(201);
        expect((await register(AGENT_A, 'station-1', SECRET_A)).status).toBe(200);
        const [[row]] = await pool.query(
            'SELECT status, token_hash FROM spooler_agents WHERE agent_id = ?',
            [AGENT_A]
        );
        expect(row.status).toBe('active');
        expect(row.token_hash).toBe(hash(SECRET_A));
    });

    it('rejects a different agent on an occupied station', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const second = await register(AGENT_B, 'station-1', SECRET_B);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('station_occupied');
    });

    it('returns 409 station_busy when un-owned in-flight work still exists', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Busy', 'kitchen', 'windows', 'Busy', 'station-busy')"
        );
        const [queue] = await pool.query(
            `INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type,
                                      spooler_id, claimed_by)
             VALUES ('{}', 'sent', 'registration-busy', REPEAT('b', 64), ?, 'kitchen',
                     'station-busy', 'poll:station-busy')`,
            [printer.insertId]
        );

        const blocked = await register(AGENT_A, 'station-busy', SECRET_A);
        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('station_busy');

        await pool.query("UPDATE print_queue SET status = 'failed', claimed_by = NULL WHERE id = ?", [queue.insertId]);
        expect((await register(AGENT_A, 'station-busy', SECRET_A)).status).toBe(201);
    });

    it('rejects an existing agent id with another token hash', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        expect((await register(AGENT_A, 'station-1', SECRET_B)).status).toBe(401);
    });

    it('never creates an agent for a bad bootstrap key or malformed identity', async () => {
        const badKey = await request(app)
            .post('/api/spooler/v2/register')
            .set('x-spooler-key', 'wrong-key')
            .send({ protocol_version: 2, agent_id: AGENT_A, spooler_id: 'station-1', token_hash: hash(SECRET_A) });
        expect(badKey.status).toBe(401);
        expect((await register('not-a-uuid', 'station-1', SECRET_A)).status).toBe(400);
        expect((await register(AGENT_A, 'bad id!', SECRET_A)).status).toBe(400);
        const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM spooler_agents');
        expect(Number(n)).toBe(0);
    });
});

describe('spooler V2 sync lifecycle', () => {
    beforeEach(async () => {
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
    });

    it('authenticates with the raw secret and updates last_sync_at', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const res = await sync(AGENT_A, SECRET_A, { health: { agent_name: 'Front Till' } });
        expect(res.status).toBe(200);
        expect(res.body.agent_status).toBe('active');
        expect((await sync(AGENT_A, hash(SECRET_A))).status).toBe(401);
        expect((await sync(AGENT_A, 'wrong')).status).toBe(401);
        const [[row]] = await pool.query('SELECT name, last_sync_at FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        expect(row.name).toBe('Front Till');
        expect(row.last_sync_at).not.toBeNull();
    });

    it('claims kitchen work before older receipts and honors its reserved capacity', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Priority', 'kitchen', 'windows', 'Priority', 'station-1')"
        );
        const receiptPayload = JSON.stringify({ printer_id: printer.insertId, print_type: 'receipt', data: {} });
        const kitchenPayload = JSON.stringify({ printer_id: printer.insertId, print_type: 'kitchen', data: {} });
        const [receipt] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', 'priority-receipt', REPEAT('a', 64), ?, 'receipt')",
            [receiptPayload, printer.insertId]
        );
        const [kitchen] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', 'priority-kitchen', REPEAT('b', 64), ?, 'kitchen')",
            [kitchenPayload, printer.insertId]
        );

        const prioritized = await sync(AGENT_A, SECRET_A, { capacity: 1 });
        expect(prioritized.body.jobs.map(job => job.queue_id)).toEqual([kitchen.insertId]);
        const [[waitingReceipt]] = await pool.query('SELECT status, agent_id FROM print_queue WHERE id=?', [receipt.insertId]);
        expect(waitingReceipt).toMatchObject({ status: 'pending', agent_id: null });

        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: kitchen.insertId, payload_hash: 'b'.repeat(64) }],
            results: [{ queue_id: kitchen.insertId, outcome: 'completed' }],
            capacity: 0,
            kitchen_capacity: 0
        });
        const [secondKitchen] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', 'priority-kitchen-reserved', REPEAT('c', 64), ?, 'kitchen')",
            [kitchenPayload, printer.insertId]
        );
        const reserved = await sync(AGENT_A, SECRET_A, { capacity: 0, kitchen_capacity: 1 });
        expect(reserved.body.jobs.map(job => job.queue_id)).toEqual([secondKitchen.insertId]);
    });

    it('rejects a configured station mismatch before syncing or claiming work', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'station-mismatch');

        const response = await sync(AGENT_A, SECRET_A, { spooler_id: 'station-2' });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe('station_mismatch');
        const [[agent]] = await pool.query('SELECT last_sync_at FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        const [[job]] = await pool.query('SELECT status, agent_id, spooler_id FROM print_queue WHERE id = ?', [queueId]);
        expect(agent.last_sync_at).toBeNull();
        expect(job).toMatchObject({ status: 'pending', agent_id: null, spooler_id: null });
    });

    it('delivers new print work without waiting for the staff failure-count query', async () => {
        const agentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        await register(agentId, 'station-1', SECRET_A);
        const completedId = await insertJob('station-1', 'badge-old-job');
        await sync(agentId, SECRET_A);
        const nextId = await insertJob('station-1', 'badge-new-job');
        let unblockBadge;
        let badgeStarted = false;
        let guard;
        const badge = new Promise(resolve => { unblockBadge = resolve; });
        const originalQuery = pool.query.bind(pool);
        const query = vi.spyOn(pool, 'query').mockImplementation((sql, ...args) => {
            if (String(sql).startsWith('SELECT COUNT(*) AS count FROM print_queue WHERE')) {
                badgeStarted = true;
                return badge;
            }
            return originalQuery(sql, ...args);
        });
        const response = sync(agentId, SECRET_A, {
            accepted: [{ queue_id: completedId, payload_hash: 'a'.repeat(64) }],
            results: [{ queue_id: completedId, outcome: 'completed' }], capacity: 1
        }).then(value => value);
        try {
            await waitFor(() => badgeStarted);
            const received = await Promise.race([
                response,
                new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Print work waited for the staff badge')), 500); })
            ]);
            expect(received.status).toBe(200);
            expect(received.body.confirmed_results).toContain(completedId);
            expect(received.body.jobs.map(job => job.queue_id)).toEqual([nextId]);
        } finally {
            clearTimeout(guard);
            unblockBadge([[{ count: 0 }]]);
            await response;
            await new Promise(resolve => setImmediate(resolve));
            query.mockRestore();
        }
    });

    it('reports station recovery only for a working agent whose last sync is stale', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const { runAgentSync } = require('../../services/spoolerSync');
        const agent = { agent_id: AGENT_A, spooler_id: 'station-1' };
        await pool.query("UPDATE spooler_agents SET last_sync_at = UTC_TIMESTAMP() - INTERVAL 5 MINUTE WHERE agent_id = ?", [AGENT_A]);
        expect((await runAgentSync(pool, agent, { capacity: 1 })).stationRecovered).toBe(true);
        // A decommissioned agent keeps syncing but no longer refreshes last_sync_at: no wake each sync.
        await pool.query("UPDATE spooler_agents SET status = 'decommissioned', last_sync_at = UTC_TIMESTAMP() - INTERVAL 5 MINUTE WHERE agent_id = ?", [AGENT_A]);
        expect((await runAgentSync(pool, agent, { capacity: 1 })).stationRecovered).toBe(false);
    });

    it('sends the spooler only the native layout while the stored payload keeps the compiled markup', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const id = await insertJob('station-1', 'native-only');
        const compiled = {
            version: 1, kind: 'compiled_document_v1', docType: 'kitchen', widthPx: 576, compilerVersion: 1,
            templateRevisionId: 'builtin:kitchen-v1', html: '<main>markup</main>', css: 'main{color:#000}',
            nativeLayout: { version: 1, docType: 'kitchen', widthPx: 576, bands: [] }
        };
        const [[row]] = await pool.query('SELECT payload FROM print_queue WHERE id = ?', [id]);
        const stored = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
        stored.data.compiled_document_v1 = compiled;
        await pool.query('UPDATE print_queue SET payload = ? WHERE id = ?', [JSON.stringify(stored), id]);

        const res = await sync(AGENT_A, SECRET_A, { capacity: 1 });
        const job = res.body.jobs.find(item => item.queue_id === id);
        expect(job.payload_hash).toBe('a'.repeat(64));
        expect(job.data.compiled_document_v1.nativeLayout).toEqual(compiled.nativeLayout);
        expect(job.data.compiled_document_v1.templateRevisionId).toBe('builtin:kitchen-v1');
        expect(job.data.compiled_document_v1).not.toHaveProperty('html');
        expect(job.data.compiled_document_v1).not.toHaveProperty('css');
        // A replay of the still-unaccepted claim is trimmed the same way.
        const replay = await sync(AGENT_A, SECRET_A, { capacity: 1 });
        expect(replay.body.jobs.find(item => item.queue_id === id).data.compiled_document_v1).not.toHaveProperty('html');
        const [[after]] = await pool.query('SELECT payload, payload_hash FROM print_queue WHERE id = ?', [id]);
        const kept = typeof after.payload === 'string' ? JSON.parse(after.payload) : after.payload;
        expect(kept.data.compiled_document_v1.html).toBe(compiled.html);
        expect(kept.data.compiled_document_v1.css).toBe(compiled.css);
        expect(after.payload_hash).toBe('a'.repeat(64));
    });

    it('sends the lean payload only to agents at 1.2.23 or newer, and the full payload otherwise', async () => {
        const compiled = {
            version: 1, kind: 'compiled_document_v1', docType: 'kitchen', widthPx: 576, compilerVersion: 1,
            templateRevisionId: 'builtin:kitchen-v1', html: '<main>markup</main>', css: 'main{color:#000}',
            nativeLayout: { version: 1, docType: 'kitchen', widthPx: 576, bands: [] }
        };
        const cases = [['1.2.22', true], ['1.2.9', true], ['1.2.23', false], ['1.2.100', false], ['1.3.0', false], ['2.0.0', false], ['probe', true], [null, true]];
        for (const [version, full] of cases) {
            await pool.query('DELETE FROM print_queue');
            await pool.query('DELETE FROM printers');
            await pool.query('DELETE FROM spooler_agents');
            await pool.query('DELETE FROM spooler_stations');
            await register(AGENT_B, 'station-1', SECRET_B, { agent_version: version });
            const id = await insertJob('station-1', 'gate');
            const [[row]] = await pool.query('SELECT payload FROM print_queue WHERE id = ?', [id]);
            const stored = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
            stored.data.compiled_document_v1 = compiled;
            await pool.query('UPDATE print_queue SET payload = ? WHERE id = ?', [JSON.stringify(stored), id]);
            const res = await sync(AGENT_B, SECRET_B, { capacity: 1 });
            const sent = res.body.jobs.find(item => item.queue_id === id).data.compiled_document_v1;
            expect(sent.nativeLayout, String(version)).toEqual(compiled.nativeLayout);
            expect(sent.html === compiled.html, String(version)).toBe(full);
            expect(sent.css === compiled.css, String(version)).toBe(full);
        }
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printers');
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
    });

    it('skips the agent-row write for an unchanged idle sync younger than 10 s', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const agent = { agent_id: AGENT_A, spooler_id: 'station-1' };
        let agentWrites = 0;
        const counting = { async getConnection() {
            const connection = await pool.getConnection();
            return {
                beginTransaction: () => connection.beginTransaction(),
                commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release(),
                query(sql, ...args) {
                    if (/^UPDATE spooler_agents SET last_sync_at/.test(sql)) agentWrites += 1;
                    return connection.query(sql, ...args);
                }
            };
        } };
        const idle = { capacity: 1, health: { local_queue_depth: 0, agent_version: '2.0.0' } };
        await runAgentSync(counting, agent, idle);
        expect(agentWrites).toBe(1);
        await runAgentSync(counting, agent, idle);
        expect(agentWrites).toBe(1);
        // A changed health value writes immediately.
        await runAgentSync(counting, agent, { capacity: 1, health: { local_queue_depth: 3, agent_version: '2.0.0' } });
        expect(agentWrites).toBe(2);
        await runAgentSync(counting, agent, { capacity: 1, health: { local_queue_depth: 3, agent_version: '2.0.0', renderer: 'failed' } });
        expect(agentWrites).toBe(3);
        // Past 10 s the heartbeat refreshes even when nothing changed.
        await pool.query('UPDATE spooler_agents SET last_sync_at = UTC_TIMESTAMP() - INTERVAL 11 SECOND WHERE agent_id = ?', [AGENT_A]);
        await runAgentSync(counting, agent, { capacity: 1, health: { local_queue_depth: 3, agent_version: '2.0.0', renderer: 'failed' } });
        expect(agentWrites).toBe(4);
    });

    it('records station acceptance once for a batch while confirming every durable job', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const ids = [];
        for (let index = 0; index < 25; index++) ids.push(await insertJob('station-1', `accept-batch-${index}`));
        const { runAgentSync } = require('../../services/spoolerSync');
        const agent = { agent_id: AGENT_A, spooler_id: 'station-1' };
        await runAgentSync(pool, agent, { capacity: 25 });
        let stationWrites = 0;
        let queries = 0;
        const measured = { async getConnection() {
            const connection = await pool.getConnection();
            return {
                beginTransaction: () => connection.beginTransaction(),
                commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release(),
                query(sql, ...args) {
                    queries++;
                    if (String(sql).startsWith('UPDATE spooler_stations SET first_v2_accepted_at')) stationWrites++;
                    return connection.query(sql, ...args);
                }
            };
        } };
        const result = await runAgentSync(measured, agent, {
            accepted: ids.map(queue_id => ({ queue_id, payload_hash: 'a'.repeat(64) })), capacity: 0
        });
        expect(result.confirmedAccepted).toEqual(ids);
        const [[station]] = await pool.query('SELECT first_v2_accepted_at FROM spooler_stations WHERE spooler_id = ?', ['station-1']);
        const [[jobs]] = await pool.query("SELECT COUNT(*) AS n FROM print_queue WHERE status = 'local_accepted'");
        expect(station.first_v2_accepted_at).not.toBeNull();
        expect(Number(jobs.n)).toBe(25);
        console.log(`25-job acceptance: ${queries} queries, ${stationWrites} station writes`);
        expect(stationWrites).toBe(1);
    });

    it('advertises the fast cadence to a healthy agent', async () => {
        await register(AGENT_CADENCE, 'station-1', 'cadence-secret');
        const response = await sync(AGENT_CADENCE, 'cadence-secret');
        expect(response.body.throttled).toBeUndefined();
        // Deliberately the literal, not the constant: this is the pin on the shipped
        // default. If it fails, the environment set SPOOLER_SYNC_INTERVAL_MS.
        expect(response.body.next_sync_ms).toBe(500);
    });

    it('keeps legacy and invalid wait requests prompt while opting idle agents into a bounded hold', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);

        const started = Date.now();
        const legacy = await request(app)
            .post('/api/spooler/v2/sync')
            .set('x-agent-id', AGENT_A)
            .set('x-agent-token', SECRET_A)
            .send({ protocol_version: 2, accepted: [], results: [], health: {}, capacity: 1 });
        const invalid = await sync(AGENT_A, SECRET_A, { wait_ms: -1 });

        expect(legacy.status).toBe(200);
        expect(invalid.status).toBe(200);
        expect(Date.now() - started).toBeLessThan(1000);

        const heldPromise = sync(AGENT_A, SECRET_A, {
            wait_ms: 1500,
            health: { local_queue_depth: 0, worker_active: 0 }
        }).then(response => response);
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 1);
        expect(pool.connectionTelemetrySnapshot().inUse).toBe(0);
        spoolerSyncWakeHub.publish();
        const held = await heldPromise;
        expect(held.status).toBe(200);
        expect(held.body.next_sync_ms).toBe(V2_POST_HOLD_SYNC_MS);
        expect(spoolerSyncWakeHub.snapshot().waiters).toBe(0);
    });

    it('releases MySQL before waiting, then claims committed work without overwriting first-pass health', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Health', 'kitchen', 'windows', 'Health', 'station-1')"
        );
        const heldPromise = sync(AGENT_A, SECRET_A, {
            wait_ms: 1500,
            capacity: 5,
            health: {
                agent_name: 'Held Agent',
                agent_version: '2.9.1',
                local_queue_depth: 0,
                worker_active: 0,
                renderer: 'ready',
                helper: 'ready',
                printers: [{ printer_id: printer.insertId, device_status: 'paper_low', status_source: 'agent' }]
            }
        }).then(response => response);

        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 1);
        const during = pool.connectionTelemetrySnapshot();
        expect(during.inUse).toBe(0);
        const enqueuedBefore = during.enqueued;

        const queueId = await insertJob('station-1', 'held-commit');
        const beforeSecond = pool.connectionTelemetrySnapshot();
        spoolerSyncWakeHub.publish();
        const response = await heldPromise;
        const after = pool.connectionTelemetrySnapshot();

        expect(response.status).toBe(200);
        expect(response.body.jobs.map(job => job.queue_id)).toEqual([queueId]);
        expect(response.body.next_sync_ms).toBe(V2_POST_HOLD_SYNC_MS);
        expect(after.inUse).toBe(0);
        expect(after.enqueued).toBe(enqueuedBefore);
        expect(after.acquired - beforeSecond.acquired).toBe(after.released - beforeSecond.released);

        const [[agent]] = await pool.query(
            'SELECT name, agent_version, local_queue_depth, health_summary FROM spooler_agents WHERE agent_id = ?',
            [AGENT_A]
        );
        const [[healthPrinter]] = await pool.query(
            'SELECT device_status, status_source FROM printers WHERE id = ?',
            [printer.insertId]
        );
        expect(agent.name).toBe('Held Agent');
        expect(agent.agent_version).toBe('2.9.1');
        expect(Number(agent.local_queue_depth)).toBe(0);
        expect(JSON.parse(agent.health_summary)).toMatchObject({ renderer: 'ready', helper: 'ready' });
        expect(healthPrinter).toMatchObject({ device_status: 'paper_low', status_source: 'agent' });
    });

    it('uses a global wake only as a hint and never crosses station ownership', async () => {
        await register(AGENT_A, 'station-a', SECRET_A);
        await register(AGENT_B, 'station-b', SECRET_B);
        const waitBody = { wait_ms: 1500, capacity: 5, health: { local_queue_depth: 0, worker_active: 0 } };
        const firstPromise = sync(AGENT_A, SECRET_A, waitBody).then(response => response);
        const secondPromise = sync(AGENT_B, SECRET_B, waitBody).then(response => response);
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 2);

        const queueId = await insertJob('station-b', 'station-b-only');
        spoolerSyncWakeHub.publish();
        const [first, second] = await Promise.all([firstPromise, secondPromise]);

        expect(first.body.jobs).toEqual([]);
        expect(second.body.jobs.map(job => job.queue_id)).toEqual([queueId]);
    });

    it('keeps simultaneous terminal printers and their timing telemetry isolated', async () => {
        const terminalAgentA = 'c1111111-1111-4111-8111-111111111111';
        const terminalAgentB = 'd2222222-2222-4222-8222-222222222222';
        const terminalSecretA = 'terminal-secret-a';
        const terminalSecretB = 'terminal-secret-b';
        await register(terminalAgentA, 'terminal-a', terminalSecretA);
        await register(terminalAgentB, 'terminal-b', terminalSecretB);
        const [queueA, queueB] = await Promise.all([
            insertJob('terminal-a', 'terminal-a-ticket'),
            insertJob('terminal-b', 'terminal-b-ticket')
        ]);

        const [claimA, claimB] = await Promise.all([
            sync(terminalAgentA, terminalSecretA, { capacity: 5 }),
            sync(terminalAgentB, terminalSecretB, { capacity: 5 })
        ]);
        expect(claimA.body.jobs.map(job => job.queue_id)).toEqual([queueA]);
        expect(claimB.body.jobs.map(job => job.queue_id)).toEqual([queueB]);

        const [settleA, settleB] = await Promise.all([
            sync(terminalAgentA, terminalSecretA, {
                accepted: [{ queue_id: queueA, payload_hash: claimA.body.jobs[0].payload_hash }],
                results: [{
                    queue_id: queueA, outcome: 'completed', duration_ms: 71,
                    render_duration_ms: 42, local_duration_ms: 130,
                    renderer: 'typst', transport_mode: 'notification'
                }]
            }),
            sync(terminalAgentB, terminalSecretB, {
                accepted: [{ queue_id: queueB, payload_hash: claimB.body.jobs[0].payload_hash }],
                results: [{
                    queue_id: queueB, outcome: 'completed', duration_ms: 84,
                    render_duration_ms: 50, local_duration_ms: 155,
                    renderer: 'typst', transport_mode: 'notification'
                }]
            })
        ]);
        expect(settleA.status).toBe(200);
        expect(settleB.status).toBe(200);
        expect(settleA.body.confirmed_results).toContain(queueA);
        expect(settleB.body.confirmed_results).toContain(queueB);

        const [rows] = await pool.query(
            `SELECT id, printer_id, spooler_id, agent_id, duration_ms,
                    render_duration_ms, local_duration_ms, renderer, transport_mode
               FROM print_queue WHERE id IN (?, ?) ORDER BY id`,
            [queueA, queueB]
        );
        const rowsById = new Map(rows.map(row => [row.id, row]));
        const rowA = rowsById.get(queueA);
        const rowB = rowsById.get(queueB);
        expect(rowA).toEqual(expect.objectContaining({
            id: queueA, spooler_id: 'terminal-a', agent_id: terminalAgentA,
            duration_ms: 71, render_duration_ms: 42, local_duration_ms: 130,
            renderer: 'typst', transport_mode: 'notification'
        }));
        expect(rowB).toEqual(expect.objectContaining({
            id: queueB, spooler_id: 'terminal-b', agent_id: terminalAgentB,
            duration_ms: 84, render_duration_ms: 50, local_duration_ms: 155,
            renderer: 'typst', transport_mode: 'notification'
        }));
        expect(rowA.printer_id).not.toBe(rowB.printer_id);

        for (let cycle = 0; cycle < 10; cycle += 1) {
            const [insertA, insertB] = await Promise.all([
                pool.query(
                    "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES ('{}', 'pending', ?, REPEAT('a', 64), ?, 'kitchen')",
                    [`terminal-a-stress-${cycle}`, rowA.printer_id]
                ),
                pool.query(
                    "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES ('{}', 'pending', ?, REPEAT('b', 64), ?, 'kitchen')",
                    [`terminal-b-stress-${cycle}`, rowB.printer_id]
                )
            ]);
            const nextA = insertA[0].insertId;
            const nextB = insertB[0].insertId;
            const [nextClaimA, nextClaimB] = await Promise.all([
                sync(terminalAgentA, terminalSecretA, { capacity: 1 }),
                sync(terminalAgentB, terminalSecretB, { capacity: 1 })
            ]);
            expect(nextClaimA.body.jobs.map(job => job.queue_id)).toEqual([nextA]);
            expect(nextClaimB.body.jobs.map(job => job.queue_id)).toEqual([nextB]);
            const [nextSettleA, nextSettleB] = await Promise.all([
                sync(terminalAgentA, terminalSecretA, {
                    accepted: [{ queue_id: nextA, payload_hash: nextClaimA.body.jobs[0].payload_hash }],
                    results: [{ queue_id: nextA, outcome: 'completed', duration_ms: 70 + cycle,
                        render_duration_ms: 40, local_duration_ms: 125 + cycle,
                        renderer: 'typst', transport_mode: 'notification' }]
                }),
                sync(terminalAgentB, terminalSecretB, {
                    accepted: [{ queue_id: nextB, payload_hash: nextClaimB.body.jobs[0].payload_hash }],
                    results: [{ queue_id: nextB, outcome: 'completed', duration_ms: 80 + cycle,
                        render_duration_ms: 50, local_duration_ms: 145 + cycle,
                        renderer: 'typst', transport_mode: 'notification' }]
                })
            ]);
            expect(nextSettleA.status).toBe(200);
            expect(nextSettleB.status).toBe(200);
            expect(nextSettleA.body.confirmed_results).toContain(nextA);
            expect(nextSettleB.body.confirmed_results).toContain(nextB);
        }

        const [terminalCounts] = await pool.query(
            `SELECT agent_id, COUNT(*) AS count
               FROM print_queue
              WHERE spooler_id IN ('terminal-a', 'terminal-b') AND status = 'acknowledged'
              GROUP BY agent_id ORDER BY agent_id`
        );
        expect(terminalCounts.map(row => ({ agent_id: row.agent_id, count: Number(row.count) }))).toEqual([
            { agent_id: terminalAgentA, count: 11 },
            { agent_id: terminalAgentB, count: 11 }
        ]);
    });

    it.each([
        ['/api/spooler/v2/sync'],
        ['/api/spooler/v2/sync/'],
        ['/API/SPOOLER/V2/SYNC']
    ])('marks sync auth errors no-store for alias %s', async (path) => {
        const response = await request(app).post(path).send({ protocol_version: 2 });
        expect(response.status).toBe(401);
        expect(response.headers['cache-control']).toBe('no-store');
    });

    it('claims, durably accepts, and settles under one agent claimant', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-happy');

        const first = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        expect(first.body.jobs.map(job => job.queue_id)).toEqual([queueId]);
        let [[row]] = await pool.query('SELECT status, claimed_by, agent_id FROM print_queue WHERE id = ?', [queueId]);
        expect(row).toMatchObject({ status: 'sent', claimed_by: `agent:${AGENT_A}`, agent_id: AGENT_A });

        const second = await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }]
        });
        expect(second.body.confirmed_accepted).toEqual([queueId]);
        [[row]] = await pool.query('SELECT status, accepted_at, locked_until FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('local_accepted');
        expect(row.accepted_at).not.toBeNull();
        expect(row.locked_until).toBeNull();

        const third = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed', device_status: 'ok', duration_ms: 90,
                artifact_hash: 'c'.repeat(64), artifact_bytes: 1024,
                render_duration_ms: 41, local_duration_ms: 146,
                renderer: 'typst', transport_mode: 'notification' }]
        });
        expect(third.body.confirmed_results).toEqual([queueId]);
        [[row]] = await pool.query(
            `SELECT status, artifact_hash, artifact_bytes, render_duration_ms,
                    local_duration_ms, renderer, transport_mode
               FROM print_queue WHERE id = ?`,
            [queueId]
        );
        expect(row.status).toBe('acknowledged');
        expect(row.artifact_hash).toBe('c'.repeat(64));
        expect(Number(row.artifact_bytes)).toBe(1024);
        expect(Number(row.render_duration_ms)).toBe(41);
        expect(Number(row.local_duration_ms)).toBe(146);
        expect(row.renderer).toBe('typst');
        expect(row.transport_mode).toBe('notification');
    });

    it('announces a committed settlement to browsers even when the agent disconnects before the answer', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-settle-abort');
        const claim = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, { accepted: [{ queue_id: queueId, payload_hash: claim.body.jobs[0].payload_hash }] });
        global.__mockEmit__.mockClear();

        // A server this test owns, so it can see the agent's connection close.
        const server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const settle = sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed', device_status: 'ok', duration_ms: 90 }]
        }, server);
        // The agent hangs up right after the settlement commits, before the route answers.
        const getConnection = pool.getConnection.bind(pool);
        const disconnectAfterCommit = vi.spyOn(pool, 'getConnection').mockImplementationOnce(async () => {
            const conn = await getConnection();
            const commit = conn.commit.bind(conn);
            conn.commit = async () => {
                await commit();
                conn.commit = commit;
                settle.abort();
                let open = 1;
                await waitFor(() => {
                    server.getConnections((error, count) => { open = count; });
                    return open === 0;
                });
            };
            return conn;
        });
        // The route binds getFailedPrintJobsCount at require time, so watch its query on the pool.
        const isBadgeQuery = ([sql]) => typeof sql === 'string' && /SELECT COUNT\(\*\) AS count FROM print_queue WHERE/.test(sql);
        const poolQuery = vi.spyOn(pool, 'query');
        let badgeQueries;
        try {
            settle.end(() => {});
            await waitFor(() => global.__mockEmit__.mock.calls.some(([event]) => event === 'print_queue_updated'));
        } finally {
            disconnectAfterCommit.mockRestore();
            await new Promise(resolve => server.close(resolve));
            badgeQueries = poolQuery.mock.calls.filter(isBadgeQuery);
            poolQuery.mockRestore();
        }

        // The aborted answer never pays for the staff failed-jobs badge query.
        expect(badgeQueries).toEqual([]);
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'failed_print_jobs_count')).toEqual([]);

        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('acknowledged');
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated'))
            .toEqual([['print_queue_updated', { source: 'agent_settlement' }]]);
    });

    it('wakes watchdog diagnostics only for committed queue activity', async () => {
        const original = app.get('printQueueWatchdog');
        const wake = vi.fn();
        app.set('printQueueWatchdog', { wake });
        try {
            await register(AGENT_A, 'station-1', SECRET_A);
            const queueId = await insertJob('station-1', 'v2-watchdog-wake');

            const claimed = await sync(AGENT_A, SECRET_A, { capacity: 5 });
            expect(claimed.body.jobs.map(job => job.queue_id)).toEqual([queueId]);
            expect(wake).toHaveBeenCalledTimes(1);

            await sync(AGENT_A, SECRET_A, {
                accepted: [{ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash }]
            });
            expect(wake).toHaveBeenCalledTimes(2);

            const terminal = { results: [{ queue_id: queueId, outcome: 'completed' }] };
            await sync(AGENT_A, SECRET_A, terminal);
            expect(wake).toHaveBeenCalledTimes(3);

            await sync(AGENT_A, SECRET_A, terminal);
            await sync(AGENT_A, SECRET_A, { capacity: 0 });
            expect(wake).toHaveBeenCalledTimes(3);
        } finally {
            app.set('printQueueWatchdog', original);
        }
    });

    it('stores null rather than failing the sync when artifact metadata is malformed', async () => {
        await register(AGENT_BAD_ARTIFACT, 'station-1', SECRET_BAD_ARTIFACT);
        const queueId = await insertJob('station-1', 'v2-bad-artifact');

        const first = await sync(AGENT_BAD_ARTIFACT, SECRET_BAD_ARTIFACT, { capacity: 5 });
        await sync(AGENT_BAD_ARTIFACT, SECRET_BAD_ARTIFACT, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }]
        });
        const settled = await sync(AGENT_BAD_ARTIFACT, SECRET_BAD_ARTIFACT, {
            results: [{
                queue_id: queueId,
                outcome: 'completed',
                device_status: 'ok',
                duration_ms: 90,
                artifact_hash: 'not-a-hash',
                artifact_bytes: 'not-a-number',
                render_duration_ms: -1,
                local_duration_ms: 'forever',
                renderer: 'not-a-renderer',
                transport_mode: 'not-a-mode'
            }]
        });

        expect(settled.body.confirmed_results).toEqual([queueId]);
        const [[row]] = await pool.query(
            `SELECT status, artifact_hash, artifact_bytes, render_duration_ms,
                    local_duration_ms, renderer, transport_mode
               FROM print_queue WHERE id = ?`,
            [queueId]
        );
        expect(row.status).toBe('acknowledged');
        expect(row.artifact_hash).toBeNull();
        expect(row.artifact_bytes).toBeNull();
        expect(row.render_duration_ms).toBeNull();
        expect(row.local_duration_ms).toBeNull();
        expect(row.renderer).toBeNull();
        expect(row.transport_mode).toBeNull();
    });

    it('replays an unaccepted sent row immediately without another attempt', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-replay');
        await sync(AGENT_A, SECRET_A);
        const replay = await sync(AGENT_A, SECRET_A);
        expect(replay.body.jobs.map(job => job.queue_id)).toEqual([queueId]);
        const [[row]] = await pool.query('SELECT attempts FROM print_queue WHERE id = ?', [queueId]);
        expect(Number(row.attempts)).toBe(1);
    });

    it('serializes concurrent capacity-one syncs to one distinct outstanding job', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await insertJob('station-1', 'v2-conc-1');
        await insertJob('station-1', 'v2-conc-2');
        const [a, b] = await Promise.all([
            sync(AGENT_A, SECRET_A, { capacity: 1 }),
            sync(AGENT_A, SECRET_A, { capacity: 1 })
        ]);
        const distinct = new Set([...a.body.jobs, ...b.body.jobs].map(job => job.queue_id));
        expect(distinct.size).toBe(1);
    });

    it('applies acceptance before result and confirms repeated terminal messages idempotently', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-one-shot');
        const first = await sync(AGENT_A, SECRET_A);
        const requestBody = {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }],
            results: [{ queue_id: queueId, outcome: 'completed' }]
        };
        const oneShot = await sync(AGENT_A, SECRET_A, requestBody);
        expect(oneShot.body.confirmed_accepted).toEqual([queueId]);
        expect(oneShot.body.confirmed_results).toEqual([queueId]);
        const resend = await sync(AGENT_A, SECRET_A, requestBody);
        expect(resend.body.confirmed_accepted).toEqual([queueId]);
        expect(resend.body.confirmed_results).toEqual([queueId]);
        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('acknowledged');
    });

    it('confirms a terminal result after its acknowledged queue row was purged without confirming acceptance-only loss', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-retired-result');
        const claimed = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash }]
        });
        await pool.query('DELETE FROM print_queue WHERE id = ?', [queueId]);

        const retired = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed' }],
            capacity: 0
        });
        expect(retired.body.confirmed_results).toEqual([queueId]);

        const invalidResult = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId + 2000, outcome: 'made_up_outcome' }],
            capacity: 0
        });
        expect(invalidResult.body.confirmed_results).toEqual([]);

        const acceptanceOnly = await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId + 1000, payload_hash: 'a'.repeat(64) }],
            capacity: 0
        });
        expect(acceptanceOnly.body.confirmed_accepted).toEqual([]);
    });

    it('resolves a dead-letter parent only after its reprint succeeds', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const parentId = await insertJob('station-1', 'v2-reprint-parent');
        await pool.query("UPDATE print_queue SET status = 'dead_letter' WHERE id = ?", [parentId]);
        const [[parent]] = await pool.query('SELECT payload, printer_id FROM print_queue WHERE id = ?', [parentId]);
        const [child] = await pool.query(
            `INSERT INTO print_queue
                (payload, status, idempotency_key, payload_hash, printer_id, print_type,
                 reprint_of_queue_id, agent_id)
             VALUES (?, 'local_accepted', 'v2-reprint-child', REPEAT('b', 64), ?, 'kitchen', ?, ?)`,
            [parent.payload, parent.printer_id, parentId, AGENT_A]
        );

        const settled = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: child.insertId, outcome: 'completed' }],
            capacity: 0
        });
        expect(settled.body.confirmed_results).toEqual([child.insertId]);
        const [[resolved]] = await pool.query(
            'SELECT status, acknowledged_at FROM print_queue WHERE id = ?',
            [parentId]
        );
        expect(resolved.status).toBe('acknowledged');
        expect(resolved.acknowledged_at).not.toBeNull();
    });

    it('keeps a dead-letter parent unresolved when its reprint fails', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const parentId = await insertJob('station-1', 'v2-failed-reprint-parent');
        await pool.query("UPDATE print_queue SET status = 'dead_letter' WHERE id = ?", [parentId]);
        const [[parent]] = await pool.query('SELECT payload, printer_id FROM print_queue WHERE id = ?', [parentId]);
        const [child] = await pool.query(
            `INSERT INTO print_queue
                (payload, status, idempotency_key, payload_hash, printer_id, print_type,
                 reprint_of_queue_id, agent_id)
             VALUES (?, 'local_accepted', 'v2-failed-reprint-child', REPEAT('c', 64), ?, 'kitchen', ?, ?)`,
            [parent.payload, parent.printer_id, parentId, AGENT_A]
        );

        await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: child.insertId, outcome: 'permanent_failure', error_code: 'PAPER_OUT' }],
            capacity: 0
        });
        const [[unresolved]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [parentId]);
        expect(unresolved.status).toBe('dead_letter');
    });

    it('never settles an unaccepted job or an unknown outcome', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-invalid-result');
        await sync(AGENT_A, SECRET_A);
        expect((await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed' }]
        })).body.confirmed_results).toEqual([]);
        expect((await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'made_up_outcome' }]
        })).body.confirmed_results).toEqual([]);
        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('sent');
    });

    it('keeps sent cancellation ambiguous until the agent reports its terminal outcome', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'v2-cancel');
        await sync(AGENT_A, SECRET_A);
        const { requestPrintJobCancellation } = require('../../services/spoolerSync');
        expect(await requestPrintJobCancellation(pool, queueId)).toBe('cancel_requested');
        expect((await sync(AGENT_A, SECRET_A)).body.cancel_requested).toEqual([queueId]);
        await sync(AGENT_A, SECRET_A, { results: [{ queue_id: queueId, outcome: 'canceled' }] });
        let [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('canceled');

        const completedId = await insertJob('station-1', 'v2-cancel-but-completed');
        await sync(AGENT_A, SECRET_A);
        expect(await requestPrintJobCancellation(pool, completedId)).toBe('cancel_requested');
        await sync(AGENT_A, SECRET_A, { results: [{ queue_id: completedId, outcome: 'completed' }] });
        [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [completedId]);
        expect(row.status).toBe('acknowledged');
    });

    it('cancels server-owned pending work immediately and dead-letters permanent failure', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const { requestPrintJobCancellation } = require('../../services/spoolerSync');
        const pendingId = await insertJob('station-1', 'v2-cancel-pending');
        expect(await requestPrintJobCancellation(pool, pendingId)).toBe('canceled');

        const failId = await insertJob('station-1', 'v2-perm');
        const first = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, {
            accepted: first.body.jobs.map(job => ({ queue_id: job.queue_id, payload_hash: job.payload_hash })),
            results: [{ queue_id: failId, outcome: 'permanent_failure', error_code: 'PRINTER_CONFIG_INVALID', failure_class: 'permanent_safe' }]
        });
        const [[row]] = await pool.query('SELECT status, last_failure_class FROM print_queue WHERE id = ?', [failId]);
        expect(row.status).toBe('dead_letter');
        expect(row.last_failure_class).toBe('permanent_safe');
    });

    it('tells a revoked agent its status in-band and returns no jobs', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await insertJob('station-1', 'v2-revoked');
        await pool.query("UPDATE spooler_agents SET status = 'revoked', revoked_at = UTC_TIMESTAMP() WHERE agent_id = ?", [AGENT_A]);
        const res = await sync(AGENT_A, SECRET_A);
        expect(res.status).toBe(200);
        expect(res.body.agent_status).toBe('revoked');
        expect(res.body.jobs).toEqual([]);
        expect(res.body.next_sync_ms).toBe(V2_IDLE_SYNC_MS);
    });

    it('does not let a revoked agent overwrite rollback health or printer state', async () => {
        await register(AGENT_A, 'revoked-health', SECRET_A);
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Revoked', 'kitchen', 'windows', 'Revoked', 'revoked-health')"
        );
        await pool.query(
            "UPDATE spooler_agents SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), last_error = 'ROLLED_BACK_TO_V1' WHERE agent_id = ?",
            [AGENT_A]
        );

        const res = await sync(AGENT_A, SECRET_A, {
            health: {
                last_error: 'PRINTER_OFFLINE',
                printers: [{ printer_id: printer.insertId, device_status: 'paper_out', confidence: 'device_confirmed', status_source: 'agent' }]
            }
        });
        expect(res.body.agent_status).toBe('revoked');
        const [[agent]] = await pool.query('SELECT last_error FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        const [[savedPrinter]] = await pool.query('SELECT device_status FROM printers WHERE id = ?', [printer.insertId]);
        expect(agent.last_error).toBe('ROLLED_BACK_TO_V1');
        expect(savedPrinter.device_status).toBe('unknown');
    });

    it('throttles an authenticated runaway agent in-band', async () => {
        await register(AGENT_RATE, 'rate-station', 'rate-secret');
        let response;
        for (let i = 0; i < SYNC_MAX + 1; i += 1) response = await sync(AGENT_RATE, 'rate-secret');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            throttled: true,
            agent_status: 'active',
            station_protocol: 'v2',
            jobs: [],
            next_sync_ms: V2_THROTTLE_SYNC_MS
        });
    });

    it('bounds fractional capacity and normalizes an invalid failure class', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const firstId = await insertJob('station-1', 'bounded-1');
        await insertJob('station-1', 'bounded-2');
        const claimed = await sync(AGENT_A, SECRET_A, { capacity: 1.9 });
        expect(claimed.status).toBe(200);
        expect(claimed.body.jobs).toHaveLength(1);
        expect(claimed.body.jobs[0].queue_id).toBe(firstId);
        const settled = await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: firstId, payload_hash: claimed.body.jobs[0].payload_hash }],
            results: [{ queue_id: firstId, outcome: 'permanent_failure', failure_class: 'invented' }]
        });
        expect(settled.status).toBe(200);
        const [[row]] = await pool.query('SELECT status, last_failure_class FROM print_queue WHERE id = ?', [firstId]);
        expect(row).toMatchObject({ status: 'dead_letter', last_failure_class: 'permanent_safe' });
    });

    it('bounds accepted and result batches before entering the sync transaction', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'bounded-sync-input');
        const claimed = await sync(AGENT_A, SECRET_A);
        const accepted = Array.from({ length: 100 }, (_, index) => ({
            queue_id: 900000 + index,
            payload_hash: '0'.repeat(64)
        }));
        accepted.push({ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash });

        const boundedAccept = await sync(AGENT_A, SECRET_A, { accepted });
        expect(boundedAccept.body.confirmed_accepted).toEqual([]);
        let [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('sent');

        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash }]
        });
        const results = Array.from({ length: 100 }, (_, index) => ({
            queue_id: 900000 + index,
            outcome: 'completed'
        }));
        results.push({ queue_id: queueId, outcome: 'completed' });

        const boundedResult = await sync(AGENT_A, SECRET_A, { results });
        expect(boundedResult.body.confirmed_results).toEqual(results.slice(0, 100).map(item => item.queue_id));
        [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('local_accepted');
    });
});

describe('spooler V2 replacement', () => {
    beforeEach(async () => {
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
        await pool.query("DELETE FROM audit_events WHERE event_type LIKE 'spooler_%'");
    });

    it('forced replacement revokes the old agent and terminalizes unresolved rows as outcome unknown', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const sentId = await insertJob('station-1', 'rep-sent');
        const acceptedId = await insertJob('station-1', 'rep-accepted');
        const cancelId = await insertJob('station-1', 'rep-cancel');
        const first = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, {
            accepted: [acceptedId, cancelId].map(queueId => ({
                queue_id: queueId,
                payload_hash: first.body.jobs.find(job => job.queue_id === queueId).payload_hash
            }))
        });
        const { requestPrintJobCancellation } = require('../../services/spoolerSync');
        await requestPrintJobCancellation(pool, cancelId);

        const { replaceAgent } = require('../../services/spoolerAgents');
        const result = await replaceAgent(pool, { spoolerId: 'station-1', force: true, actorUserId: 1 });
        expect(result).toEqual({ revokedAgentId: AGENT_A, terminalizedCount: 3 });
        const [[audit]] = await pool.query(
            "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'spooler_agent_replaced' AND entity_type = 'spooler_agent'"
        );
        expect(Number(audit.n)).toBe(1);
        const [rows] = await pool.query(
            'SELECT id, status, last_error_code FROM print_queue WHERE id IN (?) ORDER BY id',
            [[sentId, acceptedId, cancelId]]
        );
        expect(rows).toHaveLength(3);
        for (const row of rows) {
            expect(row.status).toBe('dead_letter');
            expect(row.last_error_code).toBe('AGENT_REPLACED_OUTCOME_UNKNOWN');
        }

        const old = await sync(AGENT_A, SECRET_A);
        expect(old.body.agent_status).toBe('revoked');
        expect(old.body.jobs).toEqual([]);
        expect((await register(AGENT_B, 'station-1', SECRET_B)).status).toBe(201);
        expect((await sync(AGENT_B, SECRET_B, { capacity: 10 })).body.jobs).toEqual([]);
    });

    it('replaces an agent without an audit row when the administrator has xyz enabled', async () => {
        await register(AGENT_A, 'xyz-station', SECRET_A);
        await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [SEED.adminUser.id]);
        try {
            const { replaceAgent } = require('../../services/spoolerAgents');
            const result = await replaceAgent(pool, {
                spoolerId: 'xyz-station',
                force: true,
                actorUserId: SEED.adminUser.id
            });
            expect(result.revokedAgentId).toBe(AGENT_A);
            const [[audit]] = await pool.query(
                "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'spooler_agent_replaced' AND user_id = ?",
                [SEED.adminUser.id]
            );
            expect(Number(audit.n)).toBe(0);
        } finally {
            await pool.query('UPDATE users SET xyz = 0 WHERE id = ?', [SEED.adminUser.id]);
        }
    });

    it('refuses non-forced replacement while the old agent is reachable', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await sync(AGENT_A, SECRET_A);
        const { replaceAgent } = require('../../services/spoolerAgents');
        await expect(replaceAgent(pool, { spoolerId: 'station-1', force: false }))
            .rejects.toMatchObject({ statusCode: 409, code: 'agent_reachable' });
    });

    it('wakes an idle agent to observe draining in-band', async () => {
        await register(AGENT_A, 'drain-wake', SECRET_A);
        const heldPromise = sync(AGENT_A, SECRET_A, {
            wait_ms: 1500,
            capacity: 1,
            health: { local_queue_depth: 0, worker_active: 0 }
        }).then(response => response);
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 1);

        const { requestAgentDrain } = require('../../services/spoolerAgents');
        await requestAgentDrain(pool, { spoolerId: 'drain-wake', actorUserId: 1 });
        const response = await heldPromise;

        expect(response.body.agent_status).toBe('draining');
        expect(response.body.jobs).toEqual([]);
    });

    it('wakes an idle replaced agent to observe revocation in-band', async () => {
        await register(AGENT_A, 'replace-wake', SECRET_A);
        const heldPromise = sync(AGENT_A, SECRET_A, {
            wait_ms: 1500,
            capacity: 1,
            health: { local_queue_depth: 0, worker_active: 0 }
        }).then(response => response);
        await waitFor(() => spoolerSyncWakeHub.snapshot().waiters === 1);

        const { replaceAgent } = require('../../services/spoolerAgents');
        await replaceAgent(pool, { spoolerId: 'replace-wake', force: true, actorUserId: 1 });
        const response = await heldPromise;

        expect(response.body.agent_status).toBe('revoked');
        expect(response.body.jobs).toEqual([]);
    });

    it('requires explicit force even when an active or draining agent is stale', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await pool.query(
            "UPDATE spooler_agents SET status = 'draining', last_sync_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 MINUTE) WHERE agent_id = ?",
            [AGENT_A]
        );
        const { replaceAgent } = require('../../services/spoolerAgents');
        await expect(replaceAgent(pool, { spoolerId: 'station-1', force: false }))
            .rejects.toMatchObject({ statusCode: 409, code: 'force_required' });
        await expect(replaceAgent(pool, { spoolerId: 'station-1', force: true, actorUserId: 1 }))
            .resolves.toMatchObject({ revokedAgentId: AGENT_A });
    });

    it('drains without new intake and decommissions only after an empty confirmed journal', async () => {
        await register(AGENT_A, 'drain-station', SECRET_A);
        const queueId = await insertJob('drain-station', 'drain-one');
        const first = await sync(AGENT_A, SECRET_A);
        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }]
        });
        const { requestAgentDrain } = require('../../services/spoolerAgents');
        expect(await requestAgentDrain(pool, { spoolerId: 'drain-station', actorUserId: 1 }))
            .toMatchObject({ agentId: AGENT_A, status: 'draining' });
        const drained = await sync(AGENT_A, SECRET_A, {
            results: [{ queue_id: queueId, outcome: 'completed' }],
            health: { local_queue_depth: 0, drain_complete: true },
            capacity: 10
        });
        expect(drained.body.jobs).toEqual([]);
        expect(drained.body.agent_status).toBe('decommissioned');
        const [[audit]] = await pool.query(
            "SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'spooler_agent_decommissioned'"
        );
        expect(Number(audit.n)).toBe(1);
        expect((await register(AGENT_B, 'drain-station', SECRET_B)).status).toBe(201);
    });

    it('replays an owned sent row while draining and does not claim a new pending row', async () => {
        await register(AGENT_DRAIN_REPLAY, 'drain-replay', SECRET_DRAIN);
        const ownedId = await insertJob('drain-replay', 'drain-owned-sent');
        const pendingId = await insertJob('drain-replay', 'drain-unowned-pending');
        const first = await sync(AGENT_DRAIN_REPLAY, SECRET_DRAIN, { capacity: 1 });
        expect(first.body.jobs.map(job => job.queue_id)).toEqual([ownedId]);
        const [[before]] = await pool.query('SELECT attempts FROM print_queue WHERE id = ?', [ownedId]);
        const { requestAgentDrain } = require('../../services/spoolerAgents');
        await requestAgentDrain(pool, { spoolerId: 'drain-replay', actorUserId: 1 });
        const drained = await sync(AGENT_DRAIN_REPLAY, SECRET_DRAIN, { capacity: 0 });
        expect(drained.body.jobs.map(job => job.queue_id)).toEqual([ownedId]);
        expect(drained.body.next_sync_ms).toBe(V2_NEXT_SYNC_MS);
        const [[owned]] = await pool.query('SELECT attempts, status, agent_id FROM print_queue WHERE id = ?', [ownedId]);
        expect(Number(owned.attempts)).toBe(Number(before.attempts));
        expect(owned).toMatchObject({ status: 'sent', agent_id: AGENT_DRAIN_REPLAY });
        const [[pending]] = await pool.query('SELECT status, agent_id FROM print_queue WHERE id = ?', [pendingId]);
        expect(pending.status).toBe('pending');
        expect(pending.agent_id).toBeNull();
    });

    it('delivers owned cancel_requested ids while draining', async () => {
        await register(AGENT_DRAIN_CANCEL, 'drain-cancel', SECRET_DRAIN);
        const queueId = await insertJob('drain-cancel', 'drain-owned-cancel');
        await sync(AGENT_DRAIN_CANCEL, SECRET_DRAIN);
        const { requestPrintJobCancellation } = require('../../services/spoolerSync');
        const { requestAgentDrain } = require('../../services/spoolerAgents');
        expect(await requestPrintJobCancellation(pool, queueId)).toBe('cancel_requested');
        await requestAgentDrain(pool, { spoolerId: 'drain-cancel', actorUserId: 1 });
        const drained = await sync(AGENT_DRAIN_CANCEL, SECRET_DRAIN, { capacity: 0 });
        expect(drained.body.cancel_requested).toEqual([queueId]);
    });

    it('decommissions a draining agent only after the replayed row is accepted, settled, and the journal is empty', async () => {
        await register(AGENT_DRAIN_SETTLE, 'drain-settle', SECRET_DRAIN);
        const queueId = await insertJob('drain-settle', 'drain-replay-then-settle');
        const first = await sync(AGENT_DRAIN_SETTLE, SECRET_DRAIN);
        const { requestAgentDrain } = require('../../services/spoolerAgents');
        await requestAgentDrain(pool, { spoolerId: 'drain-settle', actorUserId: 1 });
        const stillOwned = await sync(AGENT_DRAIN_SETTLE, SECRET_DRAIN, {
            health: { local_queue_depth: 0, drain_complete: true },
            capacity: 0
        });
        expect(stillOwned.body.jobs.map(job => job.queue_id)).toEqual([queueId]);
        expect(stillOwned.body.agent_status).toBe('draining');
        expect(stillOwned.body.next_sync_ms).toBe(V2_NEXT_SYNC_MS);
        const settled = await sync(AGENT_DRAIN_SETTLE, SECRET_DRAIN, {
            accepted: [{ queue_id: queueId, payload_hash: first.body.jobs[0].payload_hash }],
            results: [{ queue_id: queueId, outcome: 'completed' }],
            health: { local_queue_depth: 0, drain_complete: true },
            capacity: 0
        });
        expect(settled.body.confirmed_accepted).toEqual([queueId]);
        expect(settled.body.confirmed_results).toEqual([queueId]);
        expect(settled.body.agent_status).toBe('decommissioned');
        expect(settled.body.next_sync_ms).toBe(V2_IDLE_SYNC_MS);
    });
});

describe('spooler V2 settlement ports', () => {
    beforeEach(async () => {
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
        // after the deletes, so a count read a previous test left in flight has landed
        resetLatestFailedPrintJobsCount(); // the tests above empty print_queue behind the server's back
    });

    it('projects the stored payload identity and database hash on claim', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Receipt A', 'receipt', 'windows', 'Receipt-A', 'station-1')"
        );
        const payload = {
            printer_id: 'historical-printer-id',
            print_type: 'historical-print-type',
            payload_hash: 'self-certified-payload-value',
            data: { total: 5 }
        };
        const [queue] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', 'identity-claim', NULL, ?, 'receipt')",
            [JSON.stringify(payload), printer.insertId]
        );
        const claimed = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        expect(claimed.body.jobs).toEqual([expect.objectContaining({
            queue_id: queue.insertId,
            printer_id: 'historical-printer-id',
            print_type: 'historical-print-type',
            payload_hash: null
        })]);
    });

    it('keeps acknowledged jobs terminal before purge and rejects settle from another agent', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        await register(AGENT_B, 'station-2', SECRET_B);
        const queueId = await insertJob('station-1', 'history-ack');
        const claimed = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash }],
            results: [{ queue_id: queueId, outcome: 'completed', duration_ms: 37,
                render_duration_ms: 18, local_duration_ms: 62,
                renderer: 'typst', transport_mode: 'notification' }]
        });
        const foreign = await sync(AGENT_B, SECRET_B, {
            results: [{ queue_id: queueId, outcome: 'completed', duration_ms: 9999,
                render_duration_ms: 9999, local_duration_ms: 9999,
                renderer: 'chromium', transport_mode: 'poll' }]
        });
        expect(foreign.body.confirmed_results).toEqual([]);
        const [[acknowledged]] = await pool.query(
            `SELECT status, claimed_by, locked_until, acknowledged_at, duration_ms,
                    render_duration_ms, local_duration_ms, renderer, transport_mode
               FROM print_queue WHERE id = ?`,
            [queueId]
        );
        expect(acknowledged.status).toBe('acknowledged');
        expect(acknowledged.claimed_by).toBeNull();
        expect(acknowledged.locked_until).toBeNull();
        expect(acknowledged.acknowledged_at).not.toBeNull();
        expect(Number(acknowledged.duration_ms)).toBe(37);
        expect(Number(acknowledged.render_duration_ms)).toBe(18);
        expect(Number(acknowledged.local_duration_ms)).toBe(62);
        expect(acknowledged.renderer).toBe('typst');
        expect(acknowledged.transport_mode).toBe('notification');
        const replay = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        expect(replay.body.jobs.map(job => job.queue_id)).not.toContain(queueId);
        const otherStation = await sync(AGENT_B, SECRET_B, { capacity: 5 });
        expect(otherStation.body.jobs.map(job => job.queue_id)).not.toContain(queueId);
    });

    it('stamps the printer last printed once a minute, only for printed jobs', async () => {
        await register(AGENT_A, 'stamp-station', SECRET_A);
        const firstId = await insertJob('stamp-station', 'stamp-1');
        const [[{ printer_id: printerId }]] = await pool.query('SELECT printer_id FROM print_queue WHERE id = ?', [firstId]);
        const extraIds = [];
        for (const key of ['stamp-2', 'stamp-3']) {
            const [extra] = await pool.query(
                "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', ?, REPEAT('a', 64), ?, 'kitchen')",
                [JSON.stringify({ print_type: 'kitchen', printer_id: printerId, data: { print_batch_id: key } }), key, printerId]
            );
            extraIds.push(extra.insertId);
        }
        const claimed = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        const accepted = claimed.body.jobs.map(job => ({ queue_id: job.queue_id, payload_hash: job.payload_hash }));
        const stamp = async () => (await pool.query('SELECT last_printed_at FROM printers WHERE id = ?', [printerId]))[0][0].last_printed_at;
        expect(await stamp()).toBeNull();
        await sync(AGENT_A, SECRET_A, {
            accepted,
            results: [{ queue_id: extraIds[0], outcome: 'permanent_failure', error_code: 'PRINTER_OFFLINE', failure_class: 'permanent_safe' }]
        });
        expect(await stamp()).toBeNull();
        await sync(AGENT_A, SECRET_A, { accepted, results: [
            { queue_id: firstId, outcome: 'completed' },
            { queue_id: extraIds[1], outcome: 'completed' }
        ] });
        const stamped = await stamp();
        expect(stamped).not.toBeNull();
        expect(Math.abs(Date.now() - new Date(`${stamped.toISOString().slice(0, 19)}Z`).getTime())).toBeLessThan(120000);
        // A later job inside the minute does not rewrite the stamp; one past the minute does.
        await pool.query("UPDATE printers SET last_printed_at = '2020-01-01 00:00:00' WHERE id = ?", [printerId]);
        const recent = await insertJob('stamp-station', 'stamp-4');
        await pool.query('UPDATE print_queue SET printer_id = ? WHERE id = ?', [printerId, recent]);
        const again = await sync(AGENT_A, SECRET_A, { capacity: 5 });
        await sync(AGENT_A, SECRET_A, {
            accepted: [{ queue_id: recent, payload_hash: again.body.jobs.find(job => job.queue_id === recent).payload_hash }],
            results: [{ queue_id: recent, outcome: 'completed' }]
        });
        expect((await stamp()).getUTCFullYear()).toBeGreaterThan(2020);
    });

    describe('last printed stamp settles with the transaction', () => {
        const AGENT_STAMP = 'cccccccc-cccc-4ccc-8ccc-cccccccc0001';
        const stampOf = async id => (await pool.query('SELECT last_printed_at FROM printers WHERE id = ?', [id]))[0][0].last_printed_at;
        const wrapDb = ({ failCommit = false } = {}) => {
            const log = [];
            return {
                log,
                getConnection: async () => {
                    const conn = await pool.getConnection();
                    return {
                        query: (sql, ...rest) => { log.push(String(sql)); return conn.query(sql, ...rest); },
                        beginTransaction: () => conn.beginTransaction(),
                        commit: () => (failCommit ? Promise.reject(new Error('commit failed')) : conn.commit()),
                        rollback: () => conn.rollback(),
                        release: () => conn.release()
                    };
                }
            };
        };
        const claimThree = async () => {
            await register(AGENT_STAMP, 'stamp-multi', 'secret-stamp');
            const ids = [];
            for (const key of ['multi-1', 'multi-2', 'multi-3']) ids.push(await insertJob('stamp-multi', key));
            const claimed = await sync(AGENT_STAMP, 'secret-stamp', { capacity: 5 });
            expect(claimed.body.jobs).toHaveLength(3);
            const accepted = claimed.body.jobs.map(job => ({ queue_id: job.queue_id, payload_hash: job.payload_hash }));
            const [rows] = await pool.query('SELECT id, printer_id FROM print_queue WHERE id IN (?)', [ids]);
            return { ids, accepted, printers: rows.map(row => row.printer_id) };
        };
        const agent = { agent_id: AGENT_STAMP, spooler_id: 'stamp-multi' };

        it('stamps every printer settled in one sync with a single statement', async () => {
            const { ids, accepted, printers } = await claimThree();
            const db = wrapDb();
            await runAgentSync(db, agent, { accepted, results: ids.map(id => ({ queue_id: id, outcome: 'completed' })) });
            for (const id of printers) expect(await stampOf(id)).not.toBeNull();
            expect(db.log.filter(sql => /UPDATE printers SET last_printed_at/.test(sql))).toHaveLength(1);
        });

        it('rolls the stamp back with a transaction that fails to commit', async () => {
            const { ids, accepted, printers } = await claimThree();
            await expect(runAgentSync(wrapDb({ failCommit: true }), agent, {
                accepted, results: ids.map(id => ({ queue_id: id, outcome: 'completed' }))
            })).rejects.toThrow('commit failed');
            for (const id of printers) expect(await stampOf(id)).toBeNull();
            const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM print_queue WHERE id IN (?) AND status = 'acknowledged'", [ids]);
            expect(Number(n)).toBe(0);
        });

        it('never re-stamps a printer from a replayed acknowledgement, even one that moved since', async () => {
            const { ids, accepted, printers } = await claimThree();
            const results = ids.map(id => ({ queue_id: id, outcome: 'completed' }));
            await sync(AGENT_STAMP, 'secret-stamp', { accepted, results });
            for (const id of printers) expect(await stampOf(id)).not.toBeNull();
            // The printers moved to another device: the edit cleared the stamp.
            await pool.query('UPDATE printers SET last_printed_at = NULL WHERE id IN (?)', [printers]);
            const replay = await sync(AGENT_STAMP, 'secret-stamp', { results });
            expect(replay.body.confirmed_results).toEqual(expect.arrayContaining(ids));
            for (const id of printers) expect(await stampOf(id)).toBeNull();
        });

        it('a replay changes nothing the admin view shows', async () => {
            const { ids, accepted } = await claimThree();
            const results = ids.map(id => ({ queue_id: id, outcome: 'completed' }));
            await runAgentSync(pool, agent, { accepted, results });
            expect((await runAgentSync(pool, agent, { results })).queueViewChanged).toBe(false);
        });
    });

    it('backfills last printed from surviving acknowledged rows and reruns without overwriting', async () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../migrations/2026-09-30-printer-last-printed-v1.sql'), 'utf8');
        const backfill = (source.match(/^UPDATE printers p SET p\.last_printed_at[^;]*/m) || [])[0];
        expect(backfill).toBeTruthy();
        const [printed] = await pool.query("INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('BF-printed', 'kitchen', 'windows', 'W-bf1', 'bf-station')");
        const [idle] = await pool.query("INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('BF-idle', 'kitchen', 'windows', 'W-bf2', 'bf-station')");
        const [kept] = await pool.query("INSERT INTO printers (name, role, type, windows_name, spooler_id, last_printed_at) VALUES ('BF-kept', 'kitchen', 'windows', 'W-bf3', 'bf-station', '2026-01-01 00:00:00')");
        const insertQueue = (printerId, key, status, at) => pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type, acknowledged_at) VALUES ('{}', ?, ?, REPEAT('b', 64), ?, 'kitchen', ?)",
            [status, key, printerId, at]
        );
        await insertQueue(printed.insertId, 'bf-old', 'acknowledged', '2026-05-01 10:00:00');
        await insertQueue(printed.insertId, 'bf-new', 'acknowledged', '2026-05-02 11:30:00');
        await insertQueue(printed.insertId, 'bf-dead', 'dead_letter', '2026-06-01 00:00:00');
        await insertQueue(kept.insertId, 'bf-kept', 'acknowledged', '2026-05-02 11:30:00');
        for (let run = 0; run < 2; run++) {
            await pool.query(backfill);
            const [rows] = await pool.query('SELECT id, last_printed_at FROM printers WHERE id IN (?, ?, ?)', [printed.insertId, idle.insertId, kept.insertId]);
            const at = id => rows.find(row => row.id === id).last_printed_at;
            expect(at(printed.insertId).toISOString().slice(0, 19)).toBe('2026-05-02T11:30:00');
            expect(at(idle.insertId)).toBeNull();
            expect(at(kept.insertId).toISOString().slice(0, 19)).toBe('2026-01-01T00:00:00');
        }
    });

    it('reclaims a retry-due failed row and does not reclaim a dead-lettered row', async () => {
        await register(AGENT_RETRY, 'retry-station', SECRET_PORT);
        const retryId = await insertJob('retry-station', 'retry-due');
        await pool.query(
            "UPDATE print_queue SET status = 'failed', attempts = 1, next_retry_at = '2000-01-01 00:00:00', agent_id = NULL, claimed_by = NULL WHERE id = ?",
            [retryId]
        );
        const retryClaim = await sync(AGENT_RETRY, SECRET_PORT, { capacity: 5 });
        expect(retryClaim.body.jobs.map(job => job.queue_id)).toContain(retryId);

        await sync(AGENT_RETRY, SECRET_PORT, {
            accepted: [{ queue_id: retryId, payload_hash: retryClaim.body.jobs[0].payload_hash }],
            results: [{ queue_id: retryId, outcome: 'permanent_failure', error_code: 'PRINTER_OFFLINE', failure_class: 'permanent_safe' }]
        });
        const [[row]] = await pool.query(
            'SELECT status, claimed_by, locked_until, last_error_code FROM print_queue WHERE id = ?',
            [retryId]
        );
        expect(row).toMatchObject({
            status: 'dead_letter',
            claimed_by: null,
            locked_until: null,
            last_error_code: 'PRINTER_OFFLINE'
        });
        const afterDeadLetter = await sync(AGENT_RETRY, SECRET_PORT, { capacity: 5 });
        expect(afterDeadLetter.body.jobs.map(job => job.queue_id)).not.toContain(retryId);
    });

    it('marks serialized audit documents printed or failed from V2 settlement', async () => {
        const [docResult] = await pool.query(`
            INSERT INTO audit_report_documents (
                report_type, serial_no, serial_label, business_date, business_start_at,
                business_end_at, payload_json, payload_hash, issued_by_user_id,
                last_print_status, last_printed_by_user_id
            )
            VALUES (
                'x_audit', 1, 'X-1', '2026-07-01', '2026-07-01 03:00:00',
                '2026-07-02 03:00:00', JSON_OBJECT('serial_label', 'X-1'), REPEAT('a', 64), 1,
                'queued', 1
            )
        `);
        const documentId = docResult.insertId;
        await register(AGENT_AUDIT, 'audit-station', SECRET_PORT);
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Audit', 'receipt', 'windows', 'Audit', 'audit-station')"
        );
        const successPayload = {
            print_type: 'audit_report',
            printer_id: printer.insertId,
            data: { audit_report_document_id: documentId, serial_label: 'X-1' }
        };
        const [successQueue] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', 'audit-success', REPEAT('a', 64), ?, 'audit_report')",
            [JSON.stringify(successPayload), printer.insertId]
        );
        const claimed = await sync(AGENT_AUDIT, SECRET_PORT, { capacity: 5 });
        await sync(AGENT_AUDIT, SECRET_PORT, {
            accepted: [{ queue_id: successQueue.insertId, payload_hash: claimed.body.jobs[0].payload_hash }],
            results: [{ queue_id: successQueue.insertId, outcome: 'completed' }]
        });
        const [[printedDoc]] = await pool.query(
            'SELECT last_print_status, last_print_error FROM audit_report_documents WHERE id = ?',
            [documentId]
        );
        expect(printedDoc.last_print_status).toBe('printed');
        expect(printedDoc.last_print_error).toBeNull();

        const [failedQueue] = await pool.query(
            "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, printer_id, print_type) VALUES (?, 'pending', 'audit-failed', REPEAT('b', 64), ?, 'audit_report')",
            [JSON.stringify(successPayload), printer.insertId]
        );
        const failedClaim = await sync(AGENT_AUDIT, SECRET_PORT, { capacity: 5 });
        await sync(AGENT_AUDIT, SECRET_PORT, {
            accepted: [{ queue_id: failedQueue.insertId, payload_hash: failedClaim.body.jobs[0].payload_hash }],
            results: [{
                queue_id: failedQueue.insertId,
                outcome: 'permanent_failure',
                error_code: 'Printer offline'
            }]
        });
        const [[failedDoc]] = await pool.query(
            'SELECT last_print_status, last_print_error FROM audit_report_documents WHERE id = ?',
            [documentId]
        );
        expect(failedDoc.last_print_status).toBe('failed');
        expect(failedDoc.last_print_error).toBe('Printer offline');
        // the route publishes the count after responding; let it land before the next test resets
        await waitFor(() => global.__mockEmit__.mock.calls.some(([event, count]) => event === 'failed_print_jobs_count' && Number(count) === 1));
    });

    it('broadcasts failed+dead_letter count only when settlement first terminals a row', async () => {
        await register(AGENT_BADGE, 'badge-station', SECRET_PORT);
        const queueId = await insertJob('badge-station', 'badge-emit');
        const claimed = await sync(AGENT_BADGE, SECRET_PORT, { capacity: 5 });
        global.__mockEmit__.mockClear();
        await sync(AGENT_BADGE, SECRET_PORT, {
            accepted: [{ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash }],
            results: [{ queue_id: queueId, outcome: 'permanent_failure', error_code: 'PRINTER_OFFLINE' }]
        });
        await waitFor(() => global.__mockEmit__.mock.calls.some(([event]) => event === 'failed_print_jobs_count'));
        const first = global.__mockEmit__.mock.calls.filter(([event]) => event === 'failed_print_jobs_count');
        expect(first).toHaveLength(1);
        expect(Number(first[0][1])).toBeGreaterThanOrEqual(1);
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(1);
        global.__mockEmit__.mockClear();
        await sync(AGENT_BADGE, SECRET_PORT, {
            results: [{ queue_id: queueId, outcome: 'permanent_failure', error_code: 'PRINTER_OFFLINE' }]
        });
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'failed_print_jobs_count')).toHaveLength(0);
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(0);
    });

    it('tells staff when a sync claims or accepts a job, so the queue view needs no timer', async () => {
        await register(AGENT_BADGE, 'badge-station', SECRET_PORT);
        const queueId = await insertJob('badge-station', 'badge-claim-event');
        global.__mockEmit__.mockClear();
        const queueEvents = () => global.__mockEmit__.mock.calls.filter(([event, payload]) => event === 'print_queue_updated' && payload?.source === 'agent_activity');

        const claimed = await sync(AGENT_BADGE, SECRET_PORT, { capacity: 5 });
        expect(claimed.body.jobs).toHaveLength(1);
        expect(queueEvents()).toHaveLength(1);

        await sync(AGENT_BADGE, SECRET_PORT, { accepted: [{ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash }] });
        expect(queueEvents()).toHaveLength(2);

        // A sync that changes nothing sends nothing.
        await sync(AGENT_BADGE, SECRET_PORT, { capacity: 5 });
        expect(queueEvents()).toHaveLength(2);
    });

    it('does not rebroadcast the failed count when a queue change leaves it unchanged', async () => {
        await register(AGENT_BADGE, 'badge-station', SECRET_PORT);
        const failedId = await insertJob('badge-station', 'badge-same-1');
        const okId = await insertJob('badge-station', 'badge-same-2');
        const claimed = await sync(AGENT_BADGE, SECRET_PORT, { capacity: 5 });
        const hashOf = id => claimed.body.jobs.find(job => job.queue_id === id).payload_hash;
        global.__mockEmit__.mockClear();
        await sync(AGENT_BADGE, SECRET_PORT, {
            accepted: [{ queue_id: failedId, payload_hash: hashOf(failedId) }],
            results: [{ queue_id: failedId, outcome: 'permanent_failure', error_code: 'PRINTER_OFFLINE' }]
        });
        await waitFor(() => global.__mockEmit__.mock.calls.some(([event]) => event === 'failed_print_jobs_count'));
        await sync(AGENT_BADGE, SECRET_PORT, {
            accepted: [{ queue_id: okId, payload_hash: hashOf(okId) }],
            results: [{ queue_id: okId, outcome: 'completed' }]
        });
        await waitFor(() => global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated').length === 2);
        await new Promise(resolve => setTimeout(resolve, 150)); // the count is published after the response
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'failed_print_jobs_count')).toHaveLength(1);
    });

    it('keeps committed settlement successful when queue notification throws', async () => {
        await register(AGENT_BADGE, 'badge-station', SECRET_PORT);
        const queueId = await insertJob('badge-station', 'badge-best-effort');
        const claimed = await sync(AGENT_BADGE, SECRET_PORT, { capacity: 5 });
        global.__mockEmit__.mockClear();
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'print_queue_updated') throw new Error('socket unavailable');
        });
        try {
            const settled = await sync(AGENT_BADGE, SECRET_PORT, {
                accepted: [{ queue_id: queueId, payload_hash: claimed.body.jobs[0].payload_hash }],
                results: [{ queue_id: queueId, outcome: 'permanent_failure', error_code: 'PRINTER_OFFLINE' }]
            });
            expect(settled.statusCode).toBe(200);
            expect(settled.body.confirmed_results).toEqual([queueId]);
            const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id=?', [queueId]);
            expect(row.status).toBe('dead_letter');
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(1);
        } finally {
            global.__mockEmit__.mockImplementation(() => undefined);
        }
    });

    it('returns 404 for deleted V1 poll/ack/prepare routes and mutates nothing', async () => {
        await register(AGENT_A, 'station-1', SECRET_A);
        const queueId = await insertJob('station-1', 'legacy-404');
        const [[{ n: before }]] = await pool.query('SELECT COUNT(*) AS n FROM print_queue WHERE id = ? AND status = ?', [queueId, 'pending']);
        const poll = await request(app).post('/api/spooler/poll').set('x-spooler-key', 'test-spooler-key').send({ spooler_id: 'station-1' });
        const ack = await request(app).post('/api/spooler/ack').set('x-spooler-key', 'test-spooler-key').send({ queue_id: queueId });
        const selfStatus = await request(app).post('/api/spooler/self-status').set('x-spooler-key', 'test-spooler-key').send({});
        const prepare = await request(app).post('/api/spooler/v2/prepare').set('x-spooler-key', 'test-spooler-key').send({ spooler_id: 'station-1' });
        const abort = await request(app).post('/api/spooler/v2/abort-prepare').set('x-spooler-key', 'test-spooler-key').send({ spooler_id: 'station-1' });
        const rollbackSelf = await request(app).post('/api/spooler/v2/rollback-self').set('x-agent-id', AGENT_A).set('x-agent-token', SECRET_A).send({});
        expect([poll.status, ack.status, selfStatus.status, prepare.status, abort.status, rollbackSelf.status]).toEqual([404, 404, 404, 404, 404, 404]);
        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(Number(before)).toBe(1);
        expect(row.status).toBe('pending');
    });

    it('does not include cutover fields on register or sync responses', async () => {
        const created = await register(AGENT_A, 'station-1', SECRET_A);
        const synced = await sync(AGENT_A, SECRET_A);
        for (const body of [created.body, synced.body]) {
            expect(body).not.toHaveProperty('delivery_protocol');
            expect(body).not.toHaveProperty('rollback_allowed');
            expect(body).not.toHaveProperty('v1_stranded_count');
            expect(body.station_protocol).toBe('v2');
        }
    });
});
