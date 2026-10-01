const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { getBuiltinTemplate } = require('../../services/printTemplateDefaults');

const receiptDefinition = () => structuredClone(getBuiltinTemplate('receipt'));

describe('admin print template endpoints', () => {
    let adminCookie;
    let cashierCookie;

    beforeEach(async () => {
        await seedDatabase();
        const admin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = admin.headers['set-cookie'][0];
        const cashier = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashier.headers['set-cookie'][0];
    });

    afterAll(async () => {
        await pool.end();
    });

    const getWorkspace = docType => request(app)
        .get(`/api/admin/print-templates/${docType}`)
        .set('Cookie', adminCookie);
    const save = (docType, body, forwardedIp = null) => {
        const req = request(app)
            .post(`/api/admin/print-templates/${docType}/revisions`)
            .set('Cookie', adminCookie);
        if (forwardedIp) req.set('X-Forwarded-For', forwardedIp);
        return req.send(body);
    };
    const preview = (docType, body, ip = '198.51.100.10') => request(app)
        .post(`/api/admin/print-templates/${docType}/preview`)
        .set('Cookie', adminCookie)
        .set('X-Forwarded-For', ip)
        .send(body);

    async function createAdminCookie(userNumber, name) {
        await pool.query(
            "INSERT INTO users (user_number, name, role, is_active) VALUES (?, ?, 'admin', 1)",
            [userNumber, name]
        );
        const login = await request(app).post('/api/auth/login').send({ user_number: userNumber });
        return login.headers['set-cookie'][0];
    }

    it('is admin-only through the existing admin router', async () => {
        const res = await request(app)
            .get('/api/admin/print-templates/receipt')
            .set('Cookie', cashierCookie);

        expect(res.statusCode).toBe(403);
    });

    it('returns the stable receipt workspace without printer credentials or queue data', async () => {
        await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Front Receipt', 'receipt', 'windows', 'Front Receipt', 1)"
        );
        await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Kitchen', 'kitchen', 'windows', 'Kitchen', 1)"
        );

        const res = await getWorkspace('receipt');

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.template).toMatchObject({
            docType: 'receipt',
            lockVersion: 0,
            active: expect.objectContaining({ kind: 'builtin', definition: expect.any(Object) }),
            draft: expect.objectContaining({ kind: 'builtin', definition: expect.any(Object) }),
            revisions: []
        });
        expect(res.body.printers).toEqual([
            expect.objectContaining({ id: expect.any(Number), name: 'Front Receipt', role: 'receipt', endpointLabel: 'receipt:windows:primary:front receipt' })
        ]);
        expect(res.body.catalog).toMatchObject({ docType: 'receipt' });
        expect(res.body.builtin).toMatchObject({ kind: 'builtin', definition: expect.any(Object) });
        expect(res.body.fixtures).toContainEqual({ key: 'receipt-basic', label: 'Receipt' });
        expect(res.body).not.toHaveProperty('presets');
        expect(JSON.stringify(res.body)).not.toContain('windows_name');
        expect(JSON.stringify(res.body)).not.toContain('payload');
    });

    it('rejects unsupported document types, bad revisions, and unknown fixtures without leaking internals', async () => {
        expect((await getWorkspace('report')).statusCode).toBe(400);
        expect((await request(app)
            .get('/api/admin/print-templates/receipt/revisions/not-a-number')
            .set('Cookie', adminCookie)).statusCode).toBe(400);
        expect((await request(app)
            .get('/api/admin/print-templates/receipt/revisions/999999')
            .set('Cookie', adminCookie)).statusCode).toBe(404);

        const fixture = await preview('receipt', { definition: receiptDefinition(), fixtureKey: 'not-a-fixture' });
        expect(fixture.statusCode).toBe(400);
        expect(JSON.stringify(fixture.body)).not.toMatch(/SQL|mysql|ER_/i);
    });

    it('saves one immutable revision, returns the refreshed workspace, and reuses identical definitions', async () => {
        const definition = receiptDefinition();
        const first = await save('receipt', { definition, expectedLockVersion: 0 }, '203.0.113.77');

        expect(first.statusCode).toBe(200);
        expect(first.body).toMatchObject({
            success: true,
            template: expect.objectContaining({ docType: 'receipt', lockVersion: 1 }),
            printers: []
        });
        expect(first.body.catalog).toBeUndefined();
        expect(first.body.fixtures).toBeUndefined();
        expect(first.body.template.draft).toMatchObject({ kind: 'custom', revisionNo: 1 });

        const repeat = await save('receipt', { definition, expectedLockVersion: 1 });
        expect(repeat.statusCode).toBe(200);
        expect(repeat.body.template.lockVersion).toBe(2);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM print_template_revisions');
        expect(Number(count.count)).toBe(1);

        const revisionId = first.body.template.draft.id;
        const revision = await request(app)
            .get(`/api/admin/print-templates/receipt/revisions/${revisionId}`)
            .set('Cookie', adminCookie);
        expect(revision.statusCode).toBe(200);
        expect(revision.body).toMatchObject({ success: true, revision: { id: revisionId, revisionNo: 1, definition } });

        const [[audit]] = await pool.query(
            "SELECT ip_address FROM audit_events WHERE event_type = 'print_template_revision_saved' ORDER BY id DESC LIMIT 1"
        );
        expect(audit.ip_address).toBe('127.0.0.1');
    });

    it('rejects stale, malformed, oversized, and extra save fields before writing', async () => {
        const definition = receiptDefinition();
        expect((await save('receipt', { definition, expectedLockVersion: 0 })).statusCode).toBe(200);
        expect((await save('receipt', { definition, expectedLockVersion: 0 })).statusCode).toBe(409);
        expect((await save('receipt', { definition: { docType: 'receipt' }, expectedLockVersion: 1 })).statusCode).toBe(422);

        const tooLong = receiptDefinition();
        tooLong.bands[0].nodes[0].label.en = 'x'.repeat(501);
        expect((await save('receipt', { definition: tooLong, expectedLockVersion: 1 })).statusCode).toBe(422);
        expect((await save('receipt', { definition, expectedLockVersion: 1, revisionId: 99 })).statusCode).toBe(400);

        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM print_template_revisions');
        expect(Number(count.count)).toBe(1);
    });

    it('rejects non-object definitions and non-integer lock versions before creating a revision or audit event', async () => {
        const invalidDefinitions = ['{}', [], null, false];
        for (const definition of invalidDefinitions) {
            const response = await save('receipt', { definition, expectedLockVersion: 0 });
            expect(response.statusCode).toBe(400);
        }
        const definition = receiptDefinition();
        for (const expectedLockVersion of [null, true, '0', 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
            const response = await save('receipt', { definition, expectedLockVersion });
            expect(response.statusCode).toBe(400);
        }

        const [[revisions]] = await pool.query('SELECT COUNT(*) AS count FROM print_template_revisions');
        const [[audits]] = await pool.query(
            "SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'print_template_revision_saved'"
        );
        expect(Number(revisions.count)).toBe(0);
        expect(Number(audits.count)).toBe(0);
    });

    it('compiles only a server fixture, stamps preview provenance, and never writes a revision or queue job', async () => {
        const before = await pool.query('SELECT COUNT(*) AS count FROM print_template_revisions');
        const previewResponse = await preview('receipt', {
            definition: receiptDefinition(),
            fixtureKey: 'receipt-accepted-jofotara'
        });

        expect(previewResponse.statusCode).toBe(200);
        expect(previewResponse.body).toMatchObject({
            success: true,
            warnings: [],
            artifact: {
                docType: 'receipt',
                templateRevisionId: 'preview:unpublished',
                widthPx: 576
            }
        });
        expect(previewResponse.body.artifact.html).toContain('TEMPLATE PREVIEW — NOT A SALE');
        expect(previewResponse.body.artifact.html).toContain('compiled-document');
        expect(JSON.stringify(previewResponse.body)).not.toContain('jofotara_documents');

        const after = await pool.query('SELECT COUNT(*) AS count FROM print_template_revisions');
        const [[queue]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(after[0]).toEqual(before[0]);
        expect(Number(queue.count)).toBe(0);
    });

    it('rate limits preview by actor while forwarded IPs rotate and keeps another admin independent', async () => {
        const body = { definition: receiptDefinition(), fixtureKey: 'receipt-basic' };
        const firstCookie = await createAdminCookie('880001', 'Preview Limiter One');
        const secondCookie = await createAdminCookie('880002', 'Preview Limiter Two');
        const send = (cookie, forwardedIp) => request(app)
            .post('/api/admin/print-templates/receipt/preview')
            .set('Cookie', cookie)
            .set('X-Forwarded-For', forwardedIp)
            .send(body);

        for (let attempt = 0; attempt < 120; attempt += 1) {
            expect((await send(firstCookie, `203.0.113.${(attempt % 250) + 1}`)).statusCode).toBe(200);
        }
        expect((await send(firstCookie, '198.51.100.99')).statusCode).toBe(429);
        expect((await send(secondCookie, '198.51.100.99')).statusCode).toBe(200);
    });

    it('queues a server-fixture test print only for an active matching printer and reports its real lifecycle', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Template Receipt', 'receipt', 'windows', 'Template Receipt', 1)"
        );

        const printed = await request(app)
            .post('/api/admin/print-templates/receipt/test-print')
            .set('Cookie', adminCookie)
            .send({ revisionId: null, printerId: printer.insertId, fixtureKey: 'receipt-basic' });

        expect(printed.statusCode).toBe(200);
        expect(printed.body).toMatchObject({ success: true, queueId: expect.any(Number) });
        const [[job]] = await pool.query('SELECT payload FROM print_queue WHERE id = ?', [printed.body.queueId]);
        const payload = JSON.parse(job.payload);
        expect(payload.data.template_test).toMatchObject({ docType: 'receipt', fixtureKey: 'receipt-basic', revisionId: null });
        expect(payload.data.compiled_document_v1).toMatchObject({ templateRevisionId: 'builtin:receipt-v1' });
        expect(payload.data.compiled_document_v1.html).toContain('TEMPLATE TEST — NOT A SALE');
        expect(JSON.stringify(payload.data.compiled_document_v1.nativeLayout)).toContain('TEMPLATE TEST — NOT A SALE');

        const status = await request(app)
            .get(`/api/admin/print-templates/test-jobs/${printed.body.queueId}`)
            .set('Cookie', adminCookie);
        expect(status.statusCode).toBe(200);
        expect(status.body).toMatchObject({ success: true, job: { id: printed.body.queueId, status: 'pending', attempts: 0 } });
        expect(status.body.job.payload).toBeUndefined();
    });

    it('publishes without printer proof and applies the active revision to a printer added later', async () => {
        const saved = await save('receipt', { definition: receiptDefinition(), expectedLockVersion: 0 });
        const revisionId = saved.body.template.draft.id;

        const activated = await request(app)
            .post('/api/admin/print-templates/receipt/activate')
            .set('Cookie', adminCookie)
            .send({ revisionId, expectedLockVersion: 1, reason: 'Published from the print template admin.' });
        expect(activated.statusCode).toBe(200);
        expect(activated.body).toMatchObject({ success: true, template: { active: { id: revisionId } } });
        const [[proof]] = await pool.query(
            'SELECT COUNT(*) AS count FROM print_template_revision_tests WHERE revision_id = ?',
            [revisionId]
        );
        expect(Number(proof.count)).toBe(0);

        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Later Receipt', 'receipt', 'windows', 'Later Receipt', 1)"
        );
        const { resolveActiveTemplate } = require('../../services/printTemplateManager');
        const resolved = await resolveActiveTemplate(pool, 'receipt', { printerId: printer.insertId });
        expect(resolved).toMatchObject({ kind: 'custom', id: revisionId, templateRevisionId: revisionId });

        const restored = await request(app)
            .post('/api/admin/print-templates/receipt/activate')
            .set('Cookie', adminCookie)
            .send({ revisionId: null, expectedLockVersion: 2, reason: 'rollback' });
        expect(restored.statusCode).toBe(200);
        expect(restored.body).toMatchObject({ success: true, template: { active: { kind: 'builtin' } } });
    });

    it('rejects forged, stale, wrong-role, and obsolete-spooler test lifecycle transitions', async () => {
        const [receiptPrinter] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Template Receipt', 'receipt', 'windows', 'Template Receipt', 1)"
        );
        const [kitchenPrinter] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Template Kitchen', 'kitchen', 'windows', 'Template Kitchen', 1)"
        );
        const saved = await save('receipt', { definition: receiptDefinition(), expectedLockVersion: 0 });
        const revisionId = saved.body.template.draft.id;

        expect((await request(app)
            .post('/api/admin/print-templates/receipt/test-print').set('Cookie', adminCookie)
            .send({ revisionId: 999999, printerId: receiptPrinter.insertId, fixtureKey: 'receipt-basic' })).statusCode).toBe(404);
        expect((await request(app)
            .post('/api/admin/print-templates/receipt/test-print').set('Cookie', adminCookie)
            .send({ revisionId, printerId: kitchenPrinter.insertId, fixtureKey: 'receipt-basic' })).statusCode).toBe(409);

        const testPrint = await request(app)
            .post('/api/admin/print-templates/receipt/test-print').set('Cookie', adminCookie)
            .send({ revisionId, printerId: receiptPrinter.insertId, fixtureKey: 'receipt-basic' });
        expect(testPrint.statusCode).toBe(200);
        const confirmPath = `/api/admin/print-templates/receipt/revisions/${revisionId}/confirm-test`;
        expect((await request(app).post(confirmPath).set('Cookie', adminCookie).send({ queueId: testPrint.body.queueId })).statusCode).toBe(409);
        await pool.query("UPDATE print_queue SET status = 'acknowledged', acknowledged_at = UTC_TIMESTAMP(), spooler_version = '1.1.9' WHERE id = ?", [testPrint.body.queueId]);
        expect((await request(app).post(confirmPath).set('Cookie', adminCookie).send({ queueId: testPrint.body.queueId })).statusCode).toBe(409);
        await pool.query("UPDATE print_queue SET spooler_version = '1.2.0' WHERE id = ?", [testPrint.body.queueId]);
        expect((await request(app).post(confirmPath).set('Cookie', adminCookie).send({ queueId: 999999 })).statusCode).toBe(409);
        expect((await request(app).post(confirmPath).set('Cookie', adminCookie).send({ queueId: testPrint.body.queueId })).statusCode).toBe(200);
        expect((await request(app).post(confirmPath).set('Cookie', adminCookie).send({ queueId: testPrint.body.queueId })).statusCode).toBe(200);
        expect((await request(app)
            .post('/api/admin/print-templates/receipt/revisions/builtin/confirm-test').set('Cookie', adminCookie)
            .send({ queueId: testPrint.body.queueId })).statusCode).toBe(400);
        expect((await request(app)
            .post('/api/admin/print-templates/receipt/activate').set('Cookie', adminCookie)
            .send({ revisionId, expectedLockVersion: 0, reason: 'stale' })).statusCode).toBe(409);
    });

    it('rate limits test-print requests by actor after ten jobs', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Rate Receipt', 'receipt', 'windows', 'Rate Receipt', 1)"
        );
        const firstCookie = await createAdminCookie('880003', 'Test Print Limiter One');
        const secondCookie = await createAdminCookie('880004', 'Test Print Limiter Two');
        const body = { revisionId: null, printerId: printer.insertId, fixtureKey: 'receipt-basic' };
        const send = cookie => request(app)
            .post('/api/admin/print-templates/receipt/test-print')
            .set('Cookie', cookie)
            .send(body);

        for (let attempt = 0; attempt < 10; attempt += 1) expect((await send(firstCookie)).statusCode).toBe(200);
        expect((await send(firstCookie)).statusCode).toBe(429);
        expect((await send(secondCookie)).statusCode).toBe(200);
    });

    it('still rejects a wrong-role printer before queue insertion', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Wrong Role Receipt', 'receipt', 'windows', 'Wrong Role Receipt', 1)"
        );
        const saved = await save('receipt', { definition: receiptDefinition(), expectedLockVersion: 0 });
        const revisionId = saved.body.template.draft.id;
        const [[endpoint]] = await pool.query('SELECT active_endpoint_key FROM printers WHERE id = ?', [printer.insertId]);

        await pool.query("UPDATE printers SET role = 'kitchen' WHERE id = ?", [printer.insertId]);
        const { enqueuePrintJobs } = require('../../services/printDispatch');
        const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        await expect(enqueuePrintJobs(pool, [{
            printer_id: printer.insertId, printer_name: 'Wrong Role Receipt', print_type: 'receipt',
            data: {}
        }], { templateTest: {
            docType: 'receipt', revisionId, printerId: printer.insertId,
            printerEndpointKey: endpoint.active_endpoint_key, fixtureKey: 'receipt-basic'
        } })).rejects.toMatchObject({ statusCode: 409, code: 'PRINT_PRINTER_UNAVAILABLE' });
        const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(Number(after.count)).toBe(Number(before.count));
    });

    it('refuses confirmation when the tested printer endpoint changed after enqueue', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Endpoint Receipt', 'receipt', 'windows', 'Endpoint Receipt', 1)"
        );
        const saved = await save('receipt', { definition: receiptDefinition(), expectedLockVersion: 0 });
        const revisionId = saved.body.template.draft.id;
        const testPrint = await request(app)
            .post('/api/admin/print-templates/receipt/test-print').set('Cookie', adminCookie)
            .send({ revisionId, printerId: printer.insertId, fixtureKey: 'receipt-basic' });
        expect(testPrint.statusCode).toBe(200);
        await pool.query("UPDATE printers SET windows_name = 'Endpoint Receipt Reconfigured' WHERE id = ?", [printer.insertId]);
        await pool.query("UPDATE print_queue SET status = 'acknowledged', acknowledged_at = UTC_TIMESTAMP(), spooler_version = '1.2.0' WHERE id = ?", [testPrint.body.queueId]);
        const confirmation = await request(app)
            .post(`/api/admin/print-templates/receipt/revisions/${revisionId}/confirm-test`).set('Cookie', adminCookie)
            .send({ queueId: testPrint.body.queueId });
        expect(confirmation.statusCode).toBe(409);
        const [[tests]] = await pool.query('SELECT COUNT(*) AS count FROM print_template_revision_tests');
        expect(Number(tests.count)).toBe(0);
    });

    it('uses the authoritative receipt_config layout for a built-in receipt test print', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Configured Receipt', 'receipt', 'windows', 'Configured Receipt', 1)"
        );
        await pool.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('receipt_config', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
            [JSON.stringify({ layout: ['footer', 'header', 'meta', 'items', 'totals', 'payment', 'jofotara'] })]
        );
        const testPrint = await request(app)
            .post('/api/admin/print-templates/receipt/test-print').set('Cookie', adminCookie)
            .send({ revisionId: null, printerId: printer.insertId, fixtureKey: 'receipt-basic' });
        expect(testPrint.statusCode).toBe(200);
        const [[job]] = await pool.query('SELECT payload FROM print_queue WHERE id = ?', [testPrint.body.queueId]);
        const html = JSON.parse(job.payload).data.compiled_document_v1.html;
        expect(html.indexOf('Thank you!')).toBeLessThan(html.indexOf('Template Cafe'));
    });
});
