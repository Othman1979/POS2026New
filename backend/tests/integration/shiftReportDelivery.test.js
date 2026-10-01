const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');
const { seedReceiptPrinter, insertShift } = require('../helpers/fixtures');

describe('Shifts thermal report delivery', () => {
    let cookie, firstPrinter, savedPrinter;
    beforeEach(async () => {
        await seedDatabase();
        cookie = await loginSeedUser(request, app, 'adminUser');
        firstPrinter = await seedReceiptPrinter(pool);
        savedPrinter = await seedReceiptPrinter(pool, { name: 'Saved printer', windows_name: 'Saved-Printer' });
    });
    afterAll(async () => { await pool.end(); });
    const post = (path, data) => request(app).post(`/api/admin${path}`).set('Cookie', cookie).send(data);
    const jobs = async () => (await pool.query('SELECT payload FROM print_queue ORDER BY id'))[0].map(row => JSON.parse(row.payload));

    it.each([
        ['X', '/audit-reports/print', { report_type: 'x_audit', business_date: '2026-07-01' }, 'audit_report'],
        ['Z', '/audit-reports/print', { report_type: 'z_audit', business_date: '2026-07-01' }, 'audit_report'],
        ['period', '/audit-reports/print-period', { start_date: '2026-07-01', end_date: '2026-07-02' }, 'audit_report'],
        ['items', '/audit-reports/print-items', { business_date: '2026-07-01' }, 'category_items_report'],
    ])('queues canonical %s data on the saved printer', async (_name, path, data, type) => {
        const res = await post(path, { ...data, delivery: 'spooler', receipt_printer_id: savedPrinter, summary: { total: 999999 } });
        expect(res.statusCode).toBe(200);
        expect(res.body.print_queued).toBe(true);
        const queued = await jobs();
        expect(queued).toHaveLength(1);
        expect(queued[0].printer_id).toBe(savedPrinter);
        expect(queued[0].print_type).toBe(type);
        expect(queued[0].data.summary).not.toEqual({ total: 999999 });
        if (res.body.document) {
            const [[document]] = await pool.query('SELECT last_print_status FROM audit_report_documents WHERE id=?', [res.body.document.id]);
            expect(document.last_print_status).toBe('queued');
        }
    });

    it.each(['', 'deleted-device-printer'])('falls back to the first active receipt printer for %s', async printerId => {
        const shiftId = await insertShift(pool);
        const res = await post(`/shift-reports/${shiftId}/print`, { type: 'x_report', delivery: 'spooler', receipt_printer_id: printerId });
        expect(res.statusCode).toBe(200);
        expect(res.body.print_queued).toBe(true);
        expect((await jobs())[0].printer_id).toBe(firstPrinter);
        expect((await jobs())[0].data.shift_id).toBe(shiftId);
    });

    async function seedY() {
        await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='y_order_type_id'", [String(SEED.orderType.id)]);
        const cart = { order_type_id: SEED.orderType.id, items: [{ id: 1, name: 'Y item', category_id: 1, qty: 1, price: 5, tax_rate: 0 }] };
        const [held] = await pool.query("INSERT INTO held_orders (user_id,reference_name,cart_data,subtotal,created_at) VALUES (2,'Y receipt secret',?,5,'2026-07-01 08:00:00')", [JSON.stringify(cart)]);
        return held.insertId;
    }

    it('queues summary/items-only Y and reprints its archive without removing another hold', async () => {
        await seedY();
        const res = await post('/audit-reports/print-y', { business_date: '2026-07-01', delivery: 'spooler', receipt_printer_id: savedPrinter });
        expect(res.statusCode).toBe(200);
        expect(res.body.print_queued).toBe(true);
        let queued = await jobs();
        expect(queued).toHaveLength(1);
        expect(queued[0].data.orders).toBeUndefined();
        expect(queued[0].data.summary.total).toBe(5);
        expect(queued[0].data.items).toHaveLength(1);
        const [[archive]] = await pool.query('SELECT report_payload,held_orders_payload FROM master_held WHERE id=?', [res.body.archive_id]);
        expect(JSON.parse(archive.report_payload).orders).toHaveLength(1);
        expect(JSON.parse(archive.held_orders_payload)).toHaveLength(1);
        const another = await seedY();
        const reprint = await post(`/audit-reports/y-archives/${res.body.archive_id}/print`, { delivery: 'spooler', receipt_printer_id: savedPrinter });
        expect(reprint.statusCode).toBe(200);
        expect(reprint.body.print_queued).toBe(true);
        queued = await jobs();
        expect(queued).toHaveLength(2);
        expect(queued[1].data).toEqual(queued[0].data);
        const [[remaining]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [another]);
        expect(remaining.id).toBe(another);
    });

    it.each(['no printer', 'queue failure'])('retains Y holds and creates no archive after %s', async failure => {
        const heldId = await seedY();
        if (failure === 'no printer') await pool.query('UPDATE printers SET is_active=0');
        else await pool.query("CREATE TRIGGER reject_report_queue BEFORE INSERT ON print_queue FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic queue failure'");
        try {
            const res = await post('/audit-reports/print-y', { business_date: '2026-07-01', delivery: 'spooler' });
            expect(res.statusCode).toBeGreaterThanOrEqual(400);
            const [[held]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [heldId]);
            expect(held.id).toBe(heldId);
            expect((await pool.query('SELECT id FROM master_held'))[0]).toHaveLength(0);
            expect(await jobs()).toHaveLength(0);
        } finally {
            if (failure === 'queue failure') await pool.query('DROP TRIGGER reject_report_queue');
        }
    });

    it('keeps A4 preparation printer independent and rejects cashier thermal access', async () => {
        await pool.query('UPDATE printers SET is_active=0');
        const a4 = await post('/audit-reports/print-items', { business_date: '2026-07-01' });
        expect(a4.statusCode).toBe(200);
        expect(await jobs()).toHaveLength(0);
        cookie = await loginSeedUser(request, app, 'cashierUser');
        const forbidden = await post('/audit-reports/print-items', { business_date: '2026-07-01', delivery: 'spooler' });
        expect(forbidden.statusCode).toBe(403);
        expect(await jobs()).toHaveLength(0);
    });

    it('archives and queues a held set once under simultaneous Y requests', async () => {
        await seedY();
        const requests = Array.from({ length: 4 }, () => post('/audit-reports/print-y', { business_date: '2026-07-01', delivery: 'spooler' }));
        const responses = await Promise.all(requests);
        expect(responses.map(res => res.statusCode).sort()).toEqual([200, 404, 404, 404]);
        expect(await jobs()).toHaveLength(1);
        expect((await pool.query('SELECT id FROM master_held'))[0]).toHaveLength(1);
        expect((await pool.query('SELECT id FROM held_orders'))[0]).toHaveLength(0);
    });

    it('skips inactive and kitchen printers even when saved on the device', async () => {
        await pool.query("UPDATE printers SET role='kitchen' WHERE id=?", [firstPrinter]);
        await pool.query('UPDATE printers SET is_active=0 WHERE id=?', [savedPrinter]);
        const receipt = await seedReceiptPrinter(pool, { name: 'Active receipt fallback' });
        for (const receipt_printer_id of [firstPrinter, savedPrinter]) {
            const res = await post('/audit-reports/print-items', { business_date: '2026-07-01', delivery: 'spooler', receipt_printer_id });
            expect(res.statusCode).toBe(200);
            expect((await jobs()).at(-1).printer_id).toBe(receipt);
        }
    });

    it.each(['expired', 'restored', 'missing'])('does not queue a %s Y archive', async state => {
        await seedY();
        const report = await post('/audit-reports/print-y', { business_date: '2026-07-01', delivery: 'spooler' });
        const id = report.body.archive_id;
        if (state === 'expired') await pool.query('UPDATE master_held SET expires_at=DATE_SUB(NOW(),INTERVAL 1 MINUTE) WHERE id=?', [id]);
        if (state === 'restored') {
            const restore = await post('/audit-reports/restore-y', { archive_id: id });
            expect(restore.statusCode).toBe(200);
        }
        const res = await post(`/audit-reports/y-archives/${state === 'missing' ? id + 999 : id}/print`, { delivery: 'spooler' });
        expect(res.statusCode).toBe({ expired: 410, restored: 409, missing: 404 }[state]);
        expect(await jobs()).toHaveLength(1);
        expect((await pool.query('SELECT id FROM held_orders'))[0]).toHaveLength(state === 'restored' ? 1 : 0);
    });
});
