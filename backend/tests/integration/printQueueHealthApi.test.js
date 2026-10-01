const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('admin print queue health API', () => {
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

    it('is admin-only and hides full print payloads from the list response', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Receipt', 'receipt', 'windows', 'Receipt', 1)"
        );
        await pool.query(
            "INSERT INTO print_queue (payload, status, print_type, printer_id, last_error) VALUES (?, 'failed', 'receipt', ?, 'offline')",
            [JSON.stringify({ data: { customer_name: 'Sensitive Customer', items: [{ name: 'Secret Item' }] } }), printer.insertId]
        );

        const forbidden = await request(app)
            .get('/api/admin/print-queue/health')
            .set('Cookie', waiterCookie);
        expect(forbidden.statusCode).toBe(403);

        const res = await request(app)
            .get('/api/admin/print-queue/health')
            .set('Cookie', adminCookie);
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.summary.some(row => row.status === 'failed')).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain('Sensitive Customer');
        expect(JSON.stringify(res.body)).not.toContain('Secret Item');
        expect(res.body.spooler.active).toBe(false);
    });

    it('adds printer capability/status columns with write-only defaults', async () => {
        await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Receipt', 'receipt', 'windows', 'Receipt', 1)"
        );

        const res = await request(app)
            .get('/api/admin/print-queue/health')
            .set('Cookie', adminCookie);

        expect(res.statusCode).toBe(200);

        const [columns] = await pool.query('SHOW COLUMNS FROM printers');
        const byName = Object.fromEntries(columns.map(col => [col.Field, col]));
        expect(byName.status_capability).toBeDefined();
        expect(byName.device_status).toBeDefined();
        expect(byName.status_checked_at).toBeDefined();
        expect(byName.status_source).toBeDefined();

        const [[printer]] = await pool.query('SELECT status_capability, device_status FROM printers LIMIT 1');
        expect(printer.status_capability).toBe('write_only');
        expect(printer.device_status).toBe('unknown');
    });
});
