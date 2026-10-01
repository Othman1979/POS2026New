const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getFailedPrintJobsCount } = require('../../services/printQueueWatchdog');
const { spoolerSyncWakeHub } = require('../../services/spoolerSyncWake');

describe('audited print queue reprints', () => {
    let adminCookie;
    let waiterCookie;

    beforeEach(async () => {
        await seedDatabase();
        const adminLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLogin.headers['set-cookie'][0];
        const waiterLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        waiterCookie = waiterLogin.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    async function acknowledgedJob(status = 'acknowledged') {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name) VALUES ('Receipt Printer', 'receipt', 'windows', 'Receipt-Printer')"
        );
        const payload = {
            printer_name: 'Receipt-Printer',
            printer_type: 'windows',
            print_type: 'receipt',
            data: {
                invoice_id: 77,
                total: 11.6,
                compiled_document_v1: { docType: 'receipt', html: '<main>historic receipt</main>', css: '' }
            }
        };
        const [result] = await pool.query(
            `INSERT INTO print_queue (
                payload, idempotency_key, payload_hash, printer_id, print_type,
                status, acknowledged_at
             ) VALUES (?, 'receipt-original-77', REPEAT('a', 64), ?,
                'receipt', ?, UTC_TIMESTAMP())`,
            [JSON.stringify(payload), printer.insertId, status]
        );
        return result.insertId;
    }

    it('blocks staff without reprint permission from cloning queue history', async () => {
        const queueId = await acknowledgedJob();
        global.__mockEmit__.mockClear();

        const res = await request(app)
            .post(`/api/admin/print-queue/${queueId}/reprint`)
            .set('Cookie', waiterCookie)
            .send({ reason: 'paper did not come out' });

        expect(res.statusCode).toBe(403);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue WHERE reprint_of_queue_id = ?', [queueId]);
        expect(Number(count.count)).toBe(0);
        expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(0);
    });

    it('lets admin create a new audited queue row without mutating the original', async () => {
        const queueId = await acknowledgedJob();
        const generationBefore = spoolerSyncWakeHub.generation();
        global.__mockEmit__.mockClear();

        const res = await request(app)
            .post(`/api/admin/print-queue/${queueId}/reprint`)
            .set('Cookie', adminCookie)
            .send({ reason: 'paper jam recovery' });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.job.reprint_of_queue_id).toBe(queueId);
        expect(res.body.job.id).not.toBe(queueId);
        expect(spoolerSyncWakeHub.generation()).toBe(generationBefore + 1);

        const [[original]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
        expect(original.status).toBe('acknowledged');

        const [[reprint]] = await pool.query(
            'SELECT id, status, reprint_of_queue_id, idempotency_key, payload FROM print_queue WHERE id = ?',
            [res.body.job.id]
        );
        expect(reprint.status).toBe('pending');
        expect(reprint.reprint_of_queue_id).toBe(queueId);
        expect(reprint.idempotency_key).toContain(`reprint:${queueId}:`);
        const payload = JSON.parse(reprint.payload);
        expect(Number(payload.printer_id)).toBeGreaterThan(0);
        expect(payload.reprint_of_queue_id).toBe(queueId);
        expect(payload.data.reprint_sequence).toBe(1);
        expect(payload.data.compiled_document_v1).toEqual({ docType: 'receipt', html: '<main>historic receipt</main>', css: '' });

        const [[audit]] = await pool.query(
            "SELECT event_type, entity_type, entity_id, new_value FROM audit_events WHERE event_type = 'print.reprint' ORDER BY id DESC LIMIT 1"
        );
        expect(audit.entity_type).toBe('print_queue');
        expect(Number(audit.entity_id)).toBe(queueId);
        expect(JSON.parse(audit.new_value).new_queue_id).toBe(res.body.job.id);
        const routeEvents = global.__mockEmit__.mock.calls
            .filter(([event, payload]) => event === 'print_queue_updated' && payload?.queueId !== undefined);
        expect(routeEvents).toHaveLength(1);
    });

    it('requires explicit acknowledgement before reprinting an uncertain ticket', async () => {
        const queueId = await acknowledgedJob('dead_letter');
        await pool.query("UPDATE print_queue SET last_failure_class = 'uncertain' WHERE id = ?", [queueId]);
        const denied = await request(app).post(`/api/admin/print-queue/${queueId}/reprint`).set('Cookie', adminCookie).send({ reason: 'paper check' });
        expect(denied.status).toBe(409);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue WHERE reprint_of_queue_id = ?', [queueId]);
        expect(Number(count.count)).toBe(0);
        const allowed = await request(app).post(`/api/admin/print-queue/${queueId}/reprint`).set('Cookie', adminCookie).send({ reason: 'paper checked, recovery complete', confirm_uncertain: true });
        expect(allowed.status).toBe(200);
    });

    it('keeps a committed reprint successful when browser notification throws', async () => {
        const queueId = await acknowledgedJob();
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'print_queue_updated') throw new Error('socket unavailable');
        });
        try {
            const res = await request(app)
                .post(`/api/admin/print-queue/${queueId}/reprint`)
                .set('Cookie', adminCookie)
                .send({ reason: 'verified paper jam' });
            expect(res.statusCode).toBe(200);
            const [[row]] = await pool.query(
                'SELECT status FROM print_queue WHERE id = ?',
                [res.body.job.id]
            );
            expect(row.status).toBe('pending');
            const [[audit]] = await pool.query(
                "SELECT COUNT(*) AS count FROM audit_events WHERE event_type='print.reprint' AND entity_id=?",
                [queueId]
            );
            expect(Number(audit.count)).toBe(1);
        } finally {
            global.__mockEmit__.mockImplementation(() => undefined);
        }
    });

    it('does not announce a reprint whose commit fails', async () => {
        const queueId = await acknowledgedJob();
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
                .post(`/api/admin/print-queue/${queueId}/reprint`)
                .set('Cookie', adminCookie)
                .send({ reason: 'paper jam' });

            expect(res.statusCode).toBe(500);
            const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue WHERE reprint_of_queue_id = ?', [queueId]);
            expect(Number(count.count)).toBe(0);
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'print_queue_updated')).toHaveLength(0);
        } finally {
            commitFailure.mockRestore();
        }
    });

    it('lets an admin manually recover a dead-lettered uncertain job', async () => {
        const queueId = await acknowledgedJob('dead_letter');
        const res = await request(app)
            .post(`/api/admin/print-queue/${queueId}/reprint`)
            .set('Cookie', adminCookie)
            .send({ reason: 'verified no kitchen ticket printed' });

        expect(res.statusCode).toBe(200);
        const [[reprint]] = await pool.query('SELECT status, reprint_of_queue_id FROM print_queue WHERE id = ?', [res.body.job.id]);
        expect(reprint.status).toBe('pending');
        expect(reprint.reprint_of_queue_id).toBe(queueId);
    });

    // The POS failed-print bell reads this list. It sits under /api/admin, so the only
    // thing standing between a cashier and it is the exception in routes/admin.js.
    describe('failed print list for the POS bell', () => {
        async function grantReprintToCashier() {
            await pool.query(
                'INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, ?)',
                [SEED.cashierUser.id, 'pos.reprint_receipt']
            );
            const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            return login.headers['set-cookie'][0];
        }

        it('refuses staff who cannot reprint, so the panel cannot be used to browse the queue', async () => {
            await acknowledgedJob('dead_letter');

            const res = await request(app)
                .get('/api/admin/print-queue/failed')
                .set('Cookie', waiterCookie);

            expect(res.statusCode).toBe(403);
            expect(res.body.jobs).toBeUndefined();
        });

        it('lets a cashier holding the reprint permission read it without admin rights', async () => {
            const queueId = await acknowledgedJob('dead_letter');
            const cashierCookie = await grantReprintToCashier();

            const res = await request(app)
                .get('/api/admin/print-queue/failed')
                .set('Cookie', cashierCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const job = res.body.jobs.find(row => row.id === queueId);
            expect(job).toBeDefined();
            expect(job.status).toBe('dead_letter');
            expect(job.reprintable).toBe(true);
        });

        // 'failed' counts towards the badge but the agent is still retrying it, so the
        // panel must show it without offering an action the server would reject.
        it('marks a still-retrying job unreprintable rather than hiding it', async () => {
            const queueId = await acknowledgedJob('failed');
            const cashierCookie = await grantReprintToCashier();

            const res = await request(app)
                .get('/api/admin/print-queue/failed')
                .set('Cookie', cashierCookie);

            expect(res.statusCode).toBe(200);
            const job = res.body.jobs.find(row => row.id === queueId);
            expect(job).toBeDefined();
            expect(job.reprintable).toBe(false);

            // And the claim holds against the real endpoint, not just the flag.
            const attempt = await request(app)
                .post(`/api/admin/print-queue/${queueId}/reprint`)
                .set('Cookie', cashierCookie)
                .send({ reason: 'should be refused' });
            expect(attempt.statusCode).toBe(409);
        });

        // The defect this covers: reprintQueueJob deliberately leaves the original row
        // dead_letter, so without an exclusion the badge counts it for ever. Measured live
        // at 2 against a queue with nothing outstanding - and one job had been reprinted
        // twice, because the first reprint did not clear the badge and read as a failure.
        it('stops counting and listing a job once it has been reprinted', async () => {
            const queueId = await acknowledgedJob('dead_letter');
            const cashierCookie = await grantReprintToCashier();
            const before = await getFailedPrintJobsCount(pool);

            const reprint = await request(app)
                .post(`/api/admin/print-queue/${queueId}/reprint`)
                .set('Cookie', cashierCookie)
                .send({ reason: 'paper reloaded' });
            expect(reprint.statusCode).toBe(200);

            expect(await getFailedPrintJobsCount(pool)).toBe(before - 1);

            const list = await request(app).get('/api/admin/print-queue/failed').set('Cookie', cashierCookie);
            expect(list.body.jobs.some(row => row.id === queueId)).toBe(false);

            // The original row is untouched - its history and evidence still stand.
            const [[original]] = await pool.query('SELECT status FROM print_queue WHERE id = ?', [queueId]);
            expect(original.status).toBe('dead_letter');
        });

        // The work must still surface exactly once, on the row someone can act on.
        it('counts the reprint itself when the reprint also fails, not both rows', async () => {
            const queueId = await acknowledgedJob('dead_letter');
            const cashierCookie = await grantReprintToCashier();
            const before = await getFailedPrintJobsCount(pool);

            const reprint = await request(app)
                .post(`/api/admin/print-queue/${queueId}/reprint`)
                .set('Cookie', cashierCookie)
                .send({ reason: 'first attempt' });
            const reprintId = reprint.body.job.id;
            await pool.query("UPDATE print_queue SET status = 'dead_letter' WHERE id = ?", [reprintId]);

            // One actionable item, not two and not zero.
            expect(await getFailedPrintJobsCount(pool)).toBe(before);
            const list = await request(app).get('/api/admin/print-queue/failed').set('Cookie', cashierCookie);
            expect(list.body.jobs.some(row => row.id === reprintId)).toBe(true);
            expect(list.body.jobs.some(row => row.id === queueId)).toBe(false);
        });

        // A reprint of a reprint must not resurrect the head of the chain.
        it('collapses a chain of reprints to its newest link', async () => {
            const queueId = await acknowledgedJob('dead_letter');
            const cashierCookie = await grantReprintToCashier();
            const before = await getFailedPrintJobsCount(pool);

            const first = await request(app).post(`/api/admin/print-queue/${queueId}/reprint`)
                .set('Cookie', cashierCookie).send({ reason: 'one' });
            const firstId = first.body.job.id;
            await pool.query("UPDATE print_queue SET status = 'dead_letter' WHERE id = ?", [firstId]);

            const second = await request(app).post(`/api/admin/print-queue/${firstId}/reprint`)
                .set('Cookie', cashierCookie).send({ reason: 'two' });
            expect(second.statusCode).toBe(200);
            await pool.query("UPDATE print_queue SET status = 'acknowledged' WHERE id = ?", [second.body.job.id]);

            // Everything in the chain is resolved, so nothing is outstanding.
            expect(await getFailedPrintJobsCount(pool)).toBe(before - 1);
        });

        it('never lists a job that is printing normally', async () => {
            const pendingId = await acknowledgedJob('pending');
            const cashierCookie = await grantReprintToCashier();

            const res = await request(app)
                .get('/api/admin/print-queue/failed')
                .set('Cookie', cashierCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.jobs.some(row => row.id === pendingId)).toBe(false);
        });
    });
});
