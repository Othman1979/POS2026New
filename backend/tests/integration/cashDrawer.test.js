const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('Cash drawer', () => {
    let cashierCookie;
    let adminCookie;
    let waiterCookie;
    let receiptPrinterId;

    async function login(userNumber) {
        const response = await request(app).post('/api/auth/login').send({ user_number: userNumber });
        return response.headers['set-cookie'][0];
    }

    beforeEach(async () => {
        await seedDatabase();
        cashierCookie = await login(SEED.cashierUser.user_number);
        adminCookie = await login(SEED.adminUser.user_number);
        waiterCookie = await login(SEED.waiterUser.user_number);
        const [printer] = await pool.query(`
            INSERT INTO printers (name, role, type, windows_name, is_active)
            VALUES ('Drawer Printer', 'receipt', 'windows', 'Drawer Printer', 1)
        `);
        receiptPrinterId = printer.insertId;
    });

    afterAll(async () => {
        await pool.end();
    });

    it('queues one drawer pulse and audits a cashier without requiring a manager PIN', async () => {
        const response = await request(app)
            .post('/api/pos/log_drawer_pop')
            .set('Cookie', cashierCookie)
            .send({ receipt_printer_id: receiptPrinterId });

        expect(response.statusCode).toBe(200);
        expect(response.body).toMatchObject({ success: true, printer_id: receiptPrinterId });

        const [jobs] = await pool.query(
            "SELECT printer_id, print_type, status, payload FROM print_queue WHERE print_type = 'cash_drawer'"
        );
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({ printer_id: receiptPrinterId, print_type: 'cash_drawer', status: 'pending' });
        expect(JSON.parse(jobs[0].payload).data).toMatchObject({
            requested_by_user_id: SEED.cashierUser.id,
            reason: 'No sale / Manual drawer open',
        });

        const [events] = await pool.query(
            "SELECT user_id, manager_id, event_type, new_value FROM audit_events WHERE event_type = 'drawer_pop'"
        );
        expect(events).toHaveLength(1);
        expect(events[0].user_id).toBe(SEED.cashierUser.id);
        expect(events[0].manager_id).toBeNull();
        expect(JSON.parse(events[0].new_value)).toMatchObject({ printer_id: receiptPrinterId });
    });

    it('allows an admin to open the drawer without writing a drawer audit event', async () => {
        const response = await request(app)
            .post('/api/pos/log_drawer_pop')
            .set('Cookie', adminCookie)
            .send({ receipt_printer_id: receiptPrinterId });

        expect(response.statusCode).toBe(200);
        const [[{ queued }]] = await pool.query(
            "SELECT COUNT(*) AS queued FROM print_queue WHERE print_type = 'cash_drawer'"
        );
        const [[{ audited }]] = await pool.query(
            "SELECT COUNT(*) AS audited FROM audit_events WHERE event_type = 'drawer_pop'"
        );
        expect(Number(queued)).toBe(1);
        expect(Number(audited)).toBe(0);
    });

    it('rejects waiter access and does not queue or audit anything', async () => {
        const response = await request(app)
            .post('/api/pos/log_drawer_pop')
            .set('Cookie', waiterCookie)
            .send({ receipt_printer_id: receiptPrinterId });

        expect(response.statusCode).toBe(403);
        const [[{ queued }]] = await pool.query("SELECT COUNT(*) AS queued FROM print_queue WHERE print_type = 'cash_drawer'");
        const [[{ audited }]] = await pool.query("SELECT COUNT(*) AS audited FROM audit_events WHERE event_type = 'drawer_pop'");
        expect(Number(queued)).toBe(0);
        expect(Number(audited)).toBe(0);
    });

    it('fails without a usable receipt printer and writes neither side of the guard', async () => {
        await pool.query('UPDATE printers SET is_active = 0 WHERE id = ?', [receiptPrinterId]);

        const response = await request(app)
            .post('/api/pos/log_drawer_pop')
            .set('Cookie', cashierCookie)
            .send({ receipt_printer_id: receiptPrinterId });

        expect(response.statusCode).toBe(409);
        const [[{ queued }]] = await pool.query("SELECT COUNT(*) AS queued FROM print_queue WHERE print_type = 'cash_drawer'");
        const [[{ audited }]] = await pool.query("SELECT COUNT(*) AS audited FROM audit_events WHERE event_type = 'drawer_pop'");
        expect(Number(queued)).toBe(0);
        expect(Number(audited)).toBe(0);
    });
});
