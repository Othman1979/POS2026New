const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { spoolerSyncWakeHub } = require('../../services/spoolerSyncWake');

describe('audited print queue cancellation', () => {
    let adminCookie;
    let waiterCookie;
    let printerId;

    beforeEach(async () => {
        await seedDatabase();
        const adminLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLogin.headers['set-cookie'][0];
        const waiterLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        waiterCookie = waiterLogin.headers['set-cookie'][0];
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name) VALUES ('Cancel Test', 'receipt', 'windows', 'Cancel-Test')"
        );
        printerId = printer.insertId;
    });

    afterAll(async () => {
        await pool.end();
    });

    async function queueJob(status) {
        const [result] = await pool.query(
            'INSERT INTO print_queue (payload, printer_id, print_type, status) VALUES (?, ?, ?, ?)',
            [JSON.stringify({ print_type: 'receipt', data: { invoice_id: 71 } }), printerId, 'receipt', status]
        );
        return result.insertId;
    }

    it('requires an authenticated administrator', async () => {
        const queueId = await queueJob('pending');
        expect((await request(app).post(`/api/admin/print-queue/${queueId}/cancel`)).statusCode).toBe(401);
        expect((await request(app).post(`/api/admin/print-queue/${queueId}/cancel`).set('Cookie', waiterCookie)).statusCode).toBe(403);
        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe('pending');
    });

    it.each([
        ['pending', 'canceled', 'spooler_print_job_canceled'],
        ['sent', 'cancel_requested', 'spooler_print_job_cancellation_requested'],
        ['local_accepted', 'cancel_requested', 'spooler_print_job_cancellation_requested']
    ])('moves %s to %s and audits the durable outcome atomically', async (initial, outcome, eventType) => {
        const queueId = await queueJob(initial);
        const generationBefore = spoolerSyncWakeHub.generation();
        global.__mockEmit__.mockClear();
        const res = await request(app)
            .post(`/api/admin/print-queue/${queueId}/cancel`)
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true, queue_id: queueId, outcome });
        const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(row.status).toBe(outcome);
        const [audits] = await pool.query(
            'SELECT event_type, user_id, old_value, new_value FROM audit_events WHERE entity_type = ? AND entity_id = ?',
            ['print_queue', queueId]
        );
        expect(audits).toHaveLength(1);
        expect(audits[0].event_type).toBe(eventType);
        expect(Number(audits[0].user_id)).toBe(SEED.adminUser.id);
        expect(JSON.parse(audits[0].old_value)).toEqual({ queue_id: queueId, status: initial });
        expect(JSON.parse(audits[0].new_value)).toEqual({ queue_id: queueId, status: outcome });
        expect(spoolerSyncWakeHub.generation()).toBe(
            generationBefore + (outcome === 'cancel_requested' ? 1 : 0)
        );
        expect(global.__mockTo__).toHaveBeenCalledWith('staff');
        // The wake hub also announces the request as an enqueue-style update; the route's own
        // event is the one that carries the queue id.
        const queueEvents = global.__mockEmit__.mock.calls
            .filter(([event, payload]) => event === 'print_queue_updated' && payload?.queueId === queueId);
        expect(queueEvents).toHaveLength(1);
        expect(queueEvents[0][1]).toEqual({ queueId, status: outcome });
    });

    it('keeps committed cancellation successful when browser notification throws', async () => {
        const queueId = await queueJob('pending');
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'print_queue_updated') throw new Error('socket unavailable');
        });
        try {
            const res = await request(app)
                .post(`/api/admin/print-queue/${queueId}/cancel`)
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id=?', [queueId]);
            expect(row.status).toBe('canceled');
            const [[audit]] = await pool.query(
                'SELECT COUNT(*) AS count FROM audit_events WHERE entity_type=? AND entity_id=?',
                ['print_queue', queueId]
            );
            expect(Number(audit.count)).toBe(1);
        } finally {
            global.__mockEmit__.mockImplementation(() => undefined);
        }
    });

    it.each(['pending', 'sent'])('does not announce a %s cancellation whose commit fails', async status => {
        const queueId = await queueJob(status);
        global.__mockEmit__.mockClear();
        const getConnection = pool.getConnection.bind(pool);
        const commitFailure = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await getConnection();
            conn.commit = async () => {
                delete conn.commit;
                throw new Error('commit lost');
            };
            return conn;
        });
        try {
            const res = await request(app)
                .post(`/api/admin/print-queue/${queueId}/cancel`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(500);
            const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
            expect(row.status).toBe(status);
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(0);
        } finally {
            commitFailure.mockRestore();
        }
    });

    it('cancels the job without an audit row when the administrator has xyz enabled', async () => {
        const queueId = await queueJob('pending');
        await pool.query('UPDATE users SET xyz = 1 WHERE id = ?', [SEED.adminUser.id]);
        try {
            const res = await request(app)
                .post(`/api/admin/print-queue/${queueId}/cancel`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
            expect(row.status).toBe('canceled');
            const [[audit]] = await pool.query(
                'SELECT COUNT(*) AS count FROM audit_events WHERE entity_type = ? AND entity_id = ?',
                ['print_queue', queueId]
            );
            expect(Number(audit.count)).toBe(0);
        } finally {
            await pool.query('UPDATE users SET xyz = 0 WHERE id = ?', [SEED.adminUser.id]);
        }
    });

    it.each(['processing', 'cancel_requested', 'acknowledged', 'dead_letter', 'canceled'])(
        'rejects non-cancelable %s without changing or auditing it',
        async status => {
            const queueId = await queueJob(status);
            global.__mockEmit__.mockClear();
            const res = await request(app)
                .post(`/api/admin/print-queue/${queueId}/cancel`)
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('PRINT_JOB_NOT_CANCELABLE');
            const [[row]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
            expect(row.status).toBe(status);
            const [[audit]] = await pool.query(
                'SELECT COUNT(*) AS count FROM audit_events WHERE entity_type = ? AND entity_id = ?',
                ['print_queue', queueId]
            );
            expect(Number(audit.count)).toBe(0);
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(0);
        }
    );

    it('returns the stable not-found contract', async () => {
        global.__mockEmit__.mockClear();
        const res = await request(app)
            .post('/api/admin/print-queue/2147483647/cancel')
            .set('Cookie', adminCookie);
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('PRINT_JOB_NOT_FOUND');
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(0);
    });
});
