const request = require('supertest');
const crypto = require('crypto');
const { app, io } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getStaffPrinterStatuses, updatePrinterDeviceStatusesForStation } = require('../../services/printerStatus');

const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET_A = 'health-agent-secret';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function registerAgent(spoolerId = 'health-station') {
    return request(app)
        .post('/api/spooler/v2/register')
        .set('x-spooler-key', 'test-spooler-key')
        .send({
            protocol_version: 2,
            agent_id: AGENT_A,
            spooler_id: spoolerId,
            token_hash: hash(Buffer.from(SECRET_A).toString('base64url')),
            name: 'Health agent',
            agent_version: '2.0.0'
        });
}

async function syncAgent(spoolerId = 'health-station', body = {}) {
    const agent = await request(app)
        .post('/api/spooler/v2/sync')
        .set('x-agent-id', AGENT_A)
        .set('x-agent-token', Buffer.from(SECRET_A).toString('base64url'))
        .send({ protocol_version: 2, capacity: 0, accepted: [], results: [], health: {}, ...body });
    expect(agent.status).toBe(200);
    return agent;
}

describe('spooler V2 health ingestion and recovery', () => {
    let adminCookie;

    beforeAll(async () => {
        process.env.SPOOLER_KEY = 'test-spooler-key';
        await seedDatabase();
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM print_queue');
        await pool.query('DELETE FROM printer_categories');
        await pool.query('DELETE FROM printers');
        await pool.query('DELETE FROM spooler_agents');
        await pool.query('DELETE FROM spooler_stations');
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    it('updates only printer rows owned by the reporting station and keeps bounded warnings', async () => {
        await registerAgent();
        const [owned] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Owned', 'kitchen', 'windows', 'Owned', 'health-station')"
        );
        const [other] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Other', 'kitchen', 'windows', 'Other', 'other-station')"
        );
        const response = await syncAgent('health-station', {
            health: {
                renderer: 'ready',
                helper: 'ready',
                local_queue_depth: 2,
                oldest_local_job_age_ms: 3500,
                quarantined: 3,
                rejected_jobs: [{ queue_id: 10, error_code: 'PAYLOAD_IDENTITY_CONFLICT' }],
                cleanup_error: 'JOURNAL_CLEANUP_FAILED',
                last_error: 'PRINTER_WRITE_TIMEOUT',
                printers: [
                    { printer_id: owned.insertId, device_status: 'ok', confidence: 'device_confirmed', status_source: 'agent' },
                    { printer_id: other.insertId, device_status: 'paper_out', confidence: 'device_confirmed', status_source: 'agent' }
                ]
            }
        });
        expect(response.body.health_warnings).toContain('PRINTER_STATUS_STATION_MISMATCH');
        const [[ownedRow]] = await pool.query('SELECT device_status, status_source FROM printers WHERE id = ?', [owned.insertId]);
        const [[otherRow]] = await pool.query('SELECT device_status, status_source FROM printers WHERE id = ?', [other.insertId]);
        expect(ownedRow).toMatchObject({ device_status: 'ok', status_source: 'agent' });
        expect(otherRow.device_status).toBe('unknown');
        expect(otherRow.status_source).toBeNull();
        const [[agent]] = await pool.query('SELECT local_queue_depth, health_summary, last_error FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
        expect(Number(agent.local_queue_depth)).toBe(2);
        expect(JSON.parse(agent.health_summary)).toMatchObject({
            renderer: 'ready', helper: 'ready', oldest_local_job_age_ms: 3500,
            quarantined: 3,
            rejected_job_codes: ['PAYLOAD_IDENTITY_CONFLICT'],
            cleanup_error: 'JOURNAL_CLEANUP_FAILED'
        });
        expect(agent.last_error).toBe('PRINTER_WRITE_TIMEOUT');
    });

    it('shows each printer its stamped last printed time and its newest failed job', async () => {
        const [first] = await pool.query(
            "INSERT INTO printers (name, role, type, network_ip, network_port, spooler_id, last_printed_at) VALUES ('Owned', 'kitchen', 'network', '10.0.0.7', '9100', 'health-station', '2026-09-29 10:00:00')"
        );
        const [second] = await pool.query(
            "INSERT INTO printers (name, role, type, network_ip, network_port, spooler_id) VALUES ('Idle', 'kitchen', 'network', '10.0.0.8', '9100', 'health-station')"
        );
        const row = (printerId, status, extra) => pool.query(
            `INSERT INTO print_queue (payload, status, print_type, printer_id, spooler_id, ${extra.columns})
             VALUES ('{}', ?, 'kitchen', ?, 'health-station', ${extra.values})`, [status, printerId]);
        // Acknowledged rows are purged daily; only the printer stamp counts as "last printed".
        await row(second.insertId, 'acknowledged', { columns: 'acknowledged_at', values: "'2026-09-29 12:00:00'" });
        await row(first.insertId, 'dead_letter', { columns: 'last_error_code, last_seen_at', values: "'PRINTER_WRITE_CLOSED', '2026-09-29 10:05:00'" });
        await row(first.insertId, 'dead_letter', { columns: 'last_error_code, last_seen_at', values: "'PRINTER_WRITE_TIMEOUT', '2026-09-29 10:07:00'" });
        const health = await request(app).get('/api/admin/print-queue/health').set('Cookie', adminCookie);
        expect(health.status).toBe(200);
        const printed = health.body.printers.find(printer => printer.id === first.insertId);
        expect(new Date(printed.last_printed_at).toISOString()).toBe(new Date('2026-09-29T10:00:00Z').toISOString());
        expect(printed.last_error_code).toBe('PRINTER_WRITE_TIMEOUT');
        expect(new Date(printed.last_error_at).toISOString()).toBe(new Date('2026-09-29T10:07:00Z').toISOString());
        expect(health.body.printers.find(printer => printer.id === second.insertId))
            .toMatchObject({ last_printed_at: null, last_error_code: null, last_error_at: null });
    });

    it('reports the newest dead letter by id as the last error, one row per printer', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, network_ip, network_port, spooler_id) VALUES ('Reordered', 'kitchen', 'network', '10.0.0.9', '9100', 'health-station')"
        );
        const row = (code, seen) => pool.query(
            `INSERT INTO print_queue (payload, status, print_type, printer_id, spooler_id, last_error_code, last_seen_at)
             VALUES ('{}', 'dead_letter', 'kitchen', ?, 'health-station', ?, ?)`, [printer.insertId, code, seen]);
        await row('PRINTER_WRITE_TIMEOUT', '2026-09-29 11:30:00');
        await row('PRINTER_WRITE_CLOSED', '2026-09-29 08:30:00');
        const health = await request(app).get('/api/admin/print-queue/health').set('Cookie', adminCookie);
        const found = health.body.printers.filter(item => item.id === printer.insertId);
        expect(found).toHaveLength(1);
        expect(found[0].last_error_code).toBe('PRINTER_WRITE_CLOSED');
        expect(new Date(found[0].last_error_at).toISOString()).toBe(new Date('2026-09-29T08:30:00Z').toISOString());
    });

    it('drops malformed and oversized printer facts without rejecting sync or changing another station', async () => {
        await registerAgent();
        const [owned] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Owned', 'kitchen', 'windows', 'Owned', 'health-station')"
        );
        const statuses = Array.from({ length: 70 }, (_, index) => ({
            printer_id: index === 0 ? owned.insertId : 'not-an-id',
            device_status: 'paper_out'
        }));
        const response = await syncAgent('health-station', { health: { printers: statuses, renderer: 'bogus', helper: {}, last_error: 'contains spaces' } });
        expect(response.body.health_warnings).toEqual(expect.arrayContaining([
            'PRINTER_STATUS_BATCH_TRUNCATED',
            'PRINTER_STATUS_INVALID_ID',
            'HEALTH_LAST_ERROR_INVALID'
        ]));
        const [[row]] = await pool.query('SELECT device_status FROM printers WHERE id = ?', [owned.insertId]);
        expect(row.device_status).toBe('paper_out');
    });

    it('uses a bounded two-query batch for 64 printer statuses', async () => {
        const calls = [];
        const fakeDb = {
            query: async (sql, params) => {
                calls.push({ sql, params });
                if (/^SELECT id,/i.test(sql.trim())) {
                    return [[...Array.from({ length: 64 }, (_, index) => ({ id: index + 1, spooler_id: 'station', device_status: 'unknown', status_source: null }))], []];
                }
                return [{ affectedRows: 64 }, []];
            }
        };
        const result = await updatePrinterDeviceStatusesForStation(fakeDb, {
            spoolerId: 'station',
            statuses: Array.from({ length: 64 }, (_, index) => ({ printer_id: index + 1, device_status: 'ok', status_source: 'agent' }))
        });
        expect(calls).toHaveLength(2);
        expect(result.updated).toBe(64);
    });

    it('returns durable V2 station health, queue ownership facts, and redacted diagnostics', async () => {
        await registerAgent();
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, network_ip, network_port, spooler_id, status_capability) VALUES ('Kitchen', 'kitchen', 'network', '10.0.0.5', '9100', 'health-station', 'escpos_status')"
        );
        await pool.query(
            `INSERT INTO print_queue
                (payload, status, print_type, printer_id, spooler_id, agent_id,
                 sent_at, accepted_at, acknowledged_at, duration_ms,
                 render_duration_ms, local_duration_ms, renderer, transport_mode,
                 artifact_hash, artifact_bytes, last_error_code, last_failure_class)
             VALUES (?, 'acknowledged', 'kitchen', ?, 'health-station', ?,
                     UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP(), 70,
                     40, 125, 'typst', 'tcp', ?, 123, 'PRINTER_WRITE_TIMEOUT', 'uncertain')`,
            [JSON.stringify({ customer_name: 'must not leak', item: 'must not leak' }), printer.insertId, AGENT_A, 'a'.repeat(64)]
        );
        await pool.query(
            "INSERT INTO print_queue (payload, status, print_type, printer_id, spooler_id, agent_id) VALUES ('{}', 'cancel_requested', 'kitchen', ?, 'health-station', ?)",
            [printer.insertId, AGENT_A]
        );
        await pool.query(
            `INSERT INTO print_queue
                (payload, status, print_type, printer_id, spooler_id, agent_id,
                 sent_at, accepted_at, acknowledged_at, duration_ms)
             VALUES ('{}', 'acknowledged', 'kitchen', ?, 'health-station', ?,
                     UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP(), 90)`,
            [printer.insertId, AGENT_A]
        );
        await syncAgent('health-station', { health: {
            renderer: 'ready', helper: 'ready', local_queue_depth: 2, oldest_local_job_age_ms: 3500,
            quarantined: 2,
            rejected_jobs: [{ queue_id: 10, error_code: 'JOB_IDENTITY_INVALID' }],
            cleanup_error: 'JOURNAL_CLEANUP_FAILED'
        } });
        const health = await request(app).get('/api/admin/print-queue/health').set('Cookie', adminCookie);
        expect(health.status).toBe(200);
        expect(JSON.stringify(health.body)).not.toContain('delivery_protocol');
        expect(JSON.stringify(health.body)).not.toContain('rollback_allowed');
        expect(JSON.stringify(health.body)).not.toContain('v1_stranded_count');
        expect(health.body.stations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                spooler_id: 'health-station',
                name: 'Health agent',
                agent_id: AGENT_A,
                agent_status: 'active',
                online: true,
                local_queue_depth: 2,
                oldest_local_job_age_ms: 3500,
                renderer: 'ready',
                helper: 'ready',
                quarantined: 2,
                rejected_job_codes: ['JOB_IDENTITY_INVALID'],
                cleanup_error: 'JOURNAL_CLEANUP_FAILED',
                last_artifact_submission_at: expect.anything(),
                last_acknowledged_at: expect.anything()
            })
        ]));
        expect(health.body.recent.find(row => row.last_error_code === 'PRINTER_WRITE_TIMEOUT')).toEqual(expect.objectContaining({
            status: 'acknowledged',
            agent_id: AGENT_A,
            last_error_code: 'PRINTER_WRITE_TIMEOUT',
            last_failure_class: 'uncertain'
        }));
        expect(health.body.recent.find(row => row.status === 'cancel_requested')).toEqual(expect.objectContaining({ confidence: 'cancel_requested' }));
        const diagnostics = await request(app).get('/api/admin/print-queue/diagnostics').set('Cookie', adminCookie);
        expect(diagnostics.status).toBe(200);
        expect(diagnostics.headers['content-disposition']).toContain('print-queue-diagnostics.json');
        expect(JSON.stringify(diagnostics.body)).not.toContain('must not leak');
        expect(diagnostics.body).toMatchObject({ server_version: expect.any(String), stations: expect.any(Array), printers: expect.any(Array), queue: expect.any(Object), errors: expect.any(Array) });
        expect(diagnostics.body.queue.counts).toEqual(expect.arrayContaining([
            expect.objectContaining({ status: 'acknowledged', count: 2 }),
            expect.objectContaining({ status: 'cancel_requested', count: 1 })
        ]));
        expect(diagnostics.body.timings_ms.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({
                spooler_id: 'health-station',
                agent_id: AGENT_A,
                printer_id: printer.insertId,
                print_type: 'kitchen',
                renderer: 'typst',
                transport_mode: 'tcp',
                sample_size: 1,
                stages: expect.objectContaining({
                    render: expect.objectContaining({ p50: 40, sample_size: 1 }),
                    transport: expect.objectContaining({ p50: 70, sample_size: 1 }),
                    local_total: expect.objectContaining({ p50: 125, sample_size: 1 }),
                    local_overhead: expect.objectContaining({ p50: 15, sample_size: 1 })
                })
            })
        ]));
        expect(diagnostics.body.timings_ms.stages).toMatchObject({
            render: { p50: 40, sample_size: 1 },
            local_total: { p50: 125, sample_size: 1 },
            transport: { p50: 70, p95: 90, sample_size: 2 }
        });
        expect(diagnostics.body.timings_ms.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({
                renderer: null,
                transport_mode: null,
                sample_size: 1,
                stages: expect.objectContaining({
                    render: expect.objectContaining({ p50: null, sample_size: 0 }),
                    local_total: expect.objectContaining({ p50: null, sample_size: 0 }),
                    transport: expect.objectContaining({ p50: 90, sample_size: 1 })
                })
            })
        ]));
    });

    it('locks V2 printer ownership through the guarded health update', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id, device_status, status_source) VALUES ('MovingV2Kitchen', 'kitchen', 'windows', 'MovingV2Kitchen', 'station-a', 'offline', 'spooler')"
        );
        const conn = await pool.getConnection();
        let selectedResolve;
        let releaseSelect;
        const selected = new Promise(resolve => { selectedResolve = resolve; });
        const selectGate = new Promise(resolve => { releaseSelect = resolve; });
        let paused = false;
        let ownershipReadWasLocking = false;
        const gatedConnection = {
            query: async (sql, params) => {
                const result = await conn.query(sql, params);
                if (!paused && /^SELECT id,/i.test(sql.trim())) {
                    paused = true;
                    ownershipReadWasLocking = /FOR UPDATE/i.test(sql);
                    selectedResolve();
                    await selectGate;
                }
                return result;
            }
        };

        await conn.beginTransaction();
        const healthUpdate = updatePrinterDeviceStatusesForStation(gatedConnection, {
            spoolerId: 'station-a',
            statuses: [{ printer_id: printer.insertId, device_status: 'ok', status_source: 'agent' }]
        });
        await selected;
        let moveSettled = false;
        const move = pool.query('UPDATE printers SET spooler_id = ? WHERE id = ?', ['station-b', printer.insertId])
            .then(() => { moveSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 50));
        const movedBeforeHealthUpdate = moveSettled;
        releaseSelect();
        const result = await healthUpdate;
        await conn.commit();
        await move;
        conn.release();

        expect(ownershipReadWasLocking).toBe(true);
        expect(movedBeforeHealthUpdate).toBe(false);
        expect(result.accepted).toEqual([expect.objectContaining({ id: printer.insertId, device_status: 'ok' })]);
    });

    it('clears cached health when an admin reassigns a printer', async () => {
        await registerAgent('station-a');
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id, device_status, status_source) VALUES ('ReassignedKitchen', 'kitchen', 'windows', 'ReassignedKitchen', 'station-a', 'offline', 'spooler')"
        );
        await syncAgent('station-a', {
            health: {
                printers: [{
                    printer_id: printer.insertId,
                    device_status: 'offline',
                    status_source: 'agent'
                }]
            }
        });
        expect(getStaffPrinterStatuses()[printer.insertId]).toBeDefined();

        const response = await request(app)
            .put('/api/admin/printers')
            .set('Cookie', adminCookie)
            .send({
                id: printer.insertId,
                name: 'ReassignedKitchen',
                role: 'kitchen',
                type: 'windows',
                windows_name: 'ReassignedKitchen',
                spooler_id: 'station-b',
                status_capability: 'write_only',
                categories: []
            });

        expect(response.status).toBe(200);
        expect(getStaffPrinterStatuses()[printer.insertId]).toBeUndefined();
    });

    describe('station identity mismatch visibility', () => {
        const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        const syncWithStation = spoolerId => request(app)
            .post('/api/spooler/v2/sync')
            .set('x-agent-id', AGENT_A)
            .set('x-agent-token', Buffer.from(SECRET_A).toString('base64url'))
            .send({ protocol_version: 2, spooler_id: spoolerId, capacity: 0, accepted: [], results: [], health: {} });
        const healthStations = async () => (await request(app).get('/api/admin/print-queue/health').set('Cookie', adminCookie)).body.stations;
        const mismatchOf = async spoolerId => (await healthStations()).find(station => station.spooler_id === spoolerId)?.station_mismatch === true;
        const registerFresh = () => request(app)
            .post('/api/spooler/v2/register')
            .set('x-spooler-key', 'test-spooler-key')
            .send({ protocol_version: 2, agent_id: AGENT_B, spooler_id: 'new-station', token_hash: hash('fresh'), name: 'Fresh identity', agent_version: '2.0.0' });

        const registerFreshAs = spoolerId => request(app)
            .post('/api/spooler/v2/register')
            .set('x-spooler-key', 'test-spooler-key')
            .send({ protocol_version: 2, agent_id: AGENT_B, spooler_id: spoolerId, token_hash: hash('fresh'), name: 'Fresh identity', agent_version: '2.0.0' });

        beforeEach(async () => {
            await registerAgent('old-station');
            await pool.query("INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Bar receipt', 'receipt', 'windows', 'Bar receipt', 'new-station')");
        });

        it('shows the requested station without writing to the database or touching last_error', async () => {
            await pool.query("UPDATE spooler_agents SET last_error = 'PRINTER_RECOVERY_REQUIRED' WHERE agent_id = ?", [AGENT_A]);
            const originalQuery = pool.query.bind(pool);
            const spy = vi.spyOn(pool, 'query').mockImplementation((sql, values) => originalQuery(sql, values));
            try {
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    const response = await syncWithStation('new-station');
                    expect(response.status).toBe(409);
                    expect(response.body.code).toBe('station_mismatch');
                }
                expect(spy.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/i.test(String(sql)))).toEqual([]);
            } finally {
                spy.mockRestore();
            }
            const [[agent]] = await pool.query('SELECT last_error FROM spooler_agents WHERE agent_id = ?', [AGENT_A]);
            expect(agent.last_error).toBe('PRINTER_RECOVERY_REQUIRED');
            const stations = await healthStations();
            expect(stations.find(station => station.spooler_id === 'new-station')).toMatchObject({
                station_mismatch: true, printers: ['Bar receipt'], online: false
            });
            const old = stations.find(station => station.spooler_id === 'old-station');
            expect(old).toMatchObject({ station_mismatch: false, last_error: 'PRINTER_RECOVERY_REQUIRED', printers: [] });
        });

        it('shows a register-time mismatch', async () => {
            const response = await registerAgent('new-station');
            expect(response.status).toBe(409);
            expect(response.body.code).toBe('station_mismatch');
            expect(await mismatchOf('new-station')).toBe(true);
        });

        it('stops showing it once the machine stops asking', async () => {
            await syncWithStation('new-station');
            expect(await mismatchOf('new-station')).toBe(true);
            const realNow = Date.now();
            const clock = vi.spyOn(Date, 'now').mockReturnValue(realNow + 61 * 1000);
            try {
                expect(await mismatchOf('new-station')).toBe(false);
            } finally {
                clock.mockRestore();
            }
        });

        it('clears when the same agent syncs successfully under its own station again', async () => {
            await syncWithStation('new-station');
            expect(await mismatchOf('new-station')).toBe(true);
            expect((await syncWithStation('old-station')).status).toBe(200);
            expect(await mismatchOf('new-station')).toBe(false);
        });

        it('clears when a new agent registers for the station', async () => {
            await syncWithStation('new-station');
            expect(await mismatchOf('new-station')).toBe(true);
            expect((await registerFresh()).status).toBe(201);
            expect(await mismatchOf('new-station')).toBe(false);
        });

        describe('announcing changes to admin screens', () => {
            let staffEmits;
            let toSpy;
            beforeEach(() => {
                staffEmits = [];
                toSpy = vi.spyOn(io, 'to').mockImplementation(room => ({
                    emit: (event, payload) => { staffEmits.push({ room, event, payload }); }
                }));
            });
            afterEach(() => toSpy.mockRestore());
            const mismatchAnnouncements = () => staffEmits.filter(e => e.room === 'staff' && e.event === 'print_queue_updated' && e.payload?.source === 'station_mismatch');

            it('announces when a mismatch appears, once per real change, and when it clears', async () => {
                await syncWithStation('new-station');
                expect(mismatchAnnouncements()).toHaveLength(1);
                await syncWithStation('new-station');
                await syncWithStation('new-station');
                expect(mismatchAnnouncements()).toHaveLength(1);
                await syncWithStation('new-station');
                expect((await syncWithStation('old-station')).status).toBe(200);
                expect(mismatchAnnouncements()).toHaveLength(2);
                expect((await syncWithStation('old-station')).status).toBe(200);
                expect(mismatchAnnouncements()).toHaveLength(2);
            });

            it('announces when the mismatch changes kind, and when a registration clears it', async () => {
                await syncWithStation('new-station');
                const before = mismatchAnnouncements().length;
                await request(app)
                    .post('/api/spooler/v2/sync')
                    .set('x-agent-id', AGENT_A)
                    .set('x-agent-token', Buffer.from(SECRET_A).toString('base64url'))
                    .send({ protocol_version: 2, spooler_id: 'new-station', mismatch_state: 'healing', capacity: 0, accepted: [], results: [], health: {} });
                expect(mismatchAnnouncements()).toHaveLength(before + 1);
                expect((await registerFresh()).status).toBe(201);
                expect(mismatchAnnouncements()).toHaveLength(before + 2);
            });
        });

        it('does not let a wrong bootstrap key create or replace anything', async () => {
            const response = await request(app)
                .post('/api/spooler/v2/register')
                .set('x-spooler-key', 'wrong')
                .send({ protocol_version: 2, agent_id: AGENT_B, spooler_id: 'new-station', token_hash: hash('fresh') });
            expect(response.status).toBe(401);
            const [[{ count }]] = await pool.query('SELECT COUNT(*) AS count FROM spooler_agents');
            expect(Number(count)).toBe(1);
        });

        describe('what the health view may promise', () => {
            const stateOf = async spoolerId => (await healthStations()).find(station => station.spooler_id === spoolerId)?.station_mismatch_state;
            const syncReporting = (spoolerId, mismatchState) => request(app)
                .post('/api/spooler/v2/sync')
                .set('x-agent-id', AGENT_A)
                .set('x-agent-token', Buffer.from(SECRET_A).toString('base64url'))
                .send({ protocol_version: 2, spooler_id: spoolerId, capacity: 0, accepted: [], results: [], health: {}, mismatch_state: mismatchState });

            it('reports healing only when the agent says it is retrying by itself', async () => {
                await syncReporting('new-station', 'healing');
                expect(await stateOf('new-station')).toBe('healing');
            });

            it('reports blocked when the agent says so, or says nothing (an agent too old to heal)', async () => {
                await syncReporting('new-station', 'blocked');
                expect(await stateOf('new-station')).toBe('blocked');
                await syncReporting('new-station', undefined);
                expect(await stateOf('new-station')).toBe('blocked');
                await syncReporting('new-station', 'anything-else');
                expect(await stateOf('new-station')).toBe('blocked');
            });

            it('never reports healing while the server still holds unfinished work for the identity', async () => {
                await pool.query(
                    "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, agent_id, spooler_id, print_type) VALUES ('{}', 'sent', 'healing-but-held', REPEAT('a', 64), ?, 'old-station', 'receipt')",
                    [AGENT_A]
                );
                await syncReporting('new-station', 'healing');
                expect(await stateOf('new-station')).toBe('blocked');
            });
        });

        it('matches station ids case-insensitively, as the database does', async () => {
            await pool.query("INSERT INTO spooler_stations (spooler_id, delivery_protocol) VALUES ('Bar-PC', 'v2')");
            await pool.query("INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Bar kitchen', 'kitchen', 'windows', 'Bar kitchen', 'BAR-PC')");
            await syncWithStation('bar-pc');
            const stations = await healthStations();
            expect(stations.filter(station => station.spooler_id.toLowerCase() === 'bar-pc')).toHaveLength(1);
            expect(stations.find(station => station.spooler_id === 'Bar-PC')).toMatchObject({ station_mismatch: true, printers: ['Bar kitchen'] });
            expect((await registerFreshAs('BAR-PC')).status).toBe(201);
            expect(await mismatchOf('Bar-PC')).toBe(false);
        });

        describe('server-owned unfinished work in the 409 body', () => {
            const claim = async status => pool.query(
                "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, agent_id, spooler_id, print_type) VALUES ('{}', ?, ?, REPEAT('a', 64), ?, 'old-station', 'receipt')",
                [status, `unfinished-${status}-${crypto.randomUUID()}`, AGENT_A]
            );

            it('reports zero when the server holds nothing for the identity', async () => {
                const response = await syncWithStation('new-station');
                expect(response.status).toBe(409);
                expect(response.body.server_unfinished).toBe(0);
            });

            it('counts every unsettled status owned by the requesting agent, and only its own', async () => {
                for (const status of ['processing', 'sent', 'local_accepted', 'cancel_requested', 'acknowledged', 'failed']) await claim(status);
                await pool.query(
                    "INSERT INTO print_queue (payload, status, idempotency_key, payload_hash, agent_id, spooler_id, print_type) VALUES ('{}', 'sent', 'other-agent-row', REPEAT('b', 64), ?, 'x', 'receipt')",
                    [AGENT_B]
                );
                const response = await syncWithStation('new-station');
                expect(response.body.server_unfinished).toBe(4);
            });

            it('also reports it on a register-time mismatch', async () => {
                await claim('sent');
                const response = await registerAgent('new-station');
                expect(response.status).toBe(409);
                expect(response.body).toMatchObject({ code: 'station_mismatch', server_unfinished: 1 });
            });
        });
    });

    it('returns 404 for deleted V1 admin cutover routes', async () => {
        const terminalize = await request(app)
            .post('/api/admin/print-queue/stations/health-station/terminalize-v1')
            .set('Cookie', adminCookie)
            .send({ confirm_old_v1_service_stopped: true });
        const rollback = await request(app)
            .post('/api/admin/spooler-agents/health-station/rollback-v1')
            .set('Cookie', adminCookie)
            .send({});
        expect(terminalize.status).toBe(404);
        expect(rollback.status).toBe(404);
    });
});
