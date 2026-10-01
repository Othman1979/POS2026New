import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

// Everything attached to a print payload is persisted to print_queue.payload, shipped to
// the spooler agent, and written to its on-disk journal under %ProgramData% - a directory
// every local Windows account can read. The route used to read the entire settings table
// to get the four letterhead fields, which put the JoFotara client ids and secret keys on
// every receipt ever printed, in the database and on every till's disk.
//
// This asserts the property, not the implementation: nothing outside the letterhead
// allowlist reaches the queue. A future field added to settings cannot leak by default.
describe('print payloads never carry credentials', () => {
    const SECRET = 'jofotara-secret-value-that-must-never-be-printed';
    const LETTERHEAD = [
        'jofotara_income_tax_seller_tax_number', 'jofotara_sales_tax_seller_tax_number',
        'receipt_config', 'store_address', 'store_name', 'store_phone',
        'tax_inclusive_pricing', 'tax_registration_type'
    ];

    let adminCookie;
    let userId;
    let shiftId;

    function expectSafeStoreInfo(payload) {
        const raw = JSON.stringify(payload);
        expect(raw).not.toContain(SECRET);
        expect(raw).not.toMatch(/jofotara_\w*(?:secret_key|client_id)/);
        expect(Object.keys(payload.storeInfo).sort()).toEqual(LETTERHEAD);
    }

    beforeAll(async () => {
        await seedDatabase();

        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
        userId = SEED.adminUser.id;

        await pool.query(`
            INSERT INTO printers (name, role, type, windows_name, is_active)
            VALUES ('Receipt Printer', 'receipt', 'windows', 'Receipt-Printer', 1)
            ON DUPLICATE KEY UPDATE is_active = 1
        `);

        const [shiftRes] = await pool.query(
            "INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (?, 50.00, 'open', '2026-06-30 09:00:00')",
            [userId]
        );
        shiftId = shiftRes.insertId;

        // Real credential-shaped settings, so a leak is detectable by value and not only
        // by key name.
        const credentials = [
            'jofotara_sales_tax_secret_key',
            'jofotara_sales_tax_client_id',
            'jofotara_income_tax_secret_key',
            'jofotara_income_tax_client_id'
        ];
        for (const key of credentials) {
            await pool.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
                [key, SECRET]
            );
        }
        for (const [key, value] of [
            ['store_name', 'Corner Cafe'],
            ['store_address', 'Amman'],
            ['store_phone', '060000000'],
            ['receipt_config', '{}'],
            ['tax_inclusive_pricing', '0'],
            ['tax_registration_type', 'sales_tax'],
            ['jofotara_sales_tax_seller_tax_number', 'SALES-123'],
            ['jofotara_income_tax_seller_tax_number', 'INCOME-456'],
        ]) {
            await pool.query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
                [key, value]
            );
        }
    });

    afterAll(async () => {
        await pool.end();
    });

    it('queues a receipt with the letterhead and none of the credentials', async () => {
        const [orderRes] = await pool.query(`
            INSERT INTO orders (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method, cash_amount, card_amount)
            VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 0)
        `, [userId, shiftId]);

        const response = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'receipt', invoice_id: orderRes.insertId });
        expect(response.statusCode).toBe(200);

        const [rows] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        expect(rows).toHaveLength(1);
        const raw = typeof rows[0].payload === 'string' ? rows[0].payload : JSON.stringify(rows[0].payload);

        // Scan the whole serialized payload, not just storeInfo: a credential must not
        // reach the queue by any route, including one added later.
        expect(raw).not.toContain(SECRET);
        expect(raw).not.toMatch(/jofotara_\w*(?:secret_key|client_id)/);

        // The letterhead the receipt actually renders still arrives. getSettings returns
        // only rows that exist, so assert the absence of extras rather than an exact set.
        const payload = JSON.parse(raw);
        expect(payload.data.storeInfo.store_name).toBe('Corner Cafe');
        expect(payload.data.storeInfo.jofotara_sales_tax_seller_tax_number).toBe('SALES-123');
        expect(Object.keys(payload.data.storeInfo).filter(key => !LETTERHEAD.includes(key))).toEqual([]);
    });

    it('keeps credentials out of stored X, Items, and Y report payloads', async () => {
        const xResponse = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'x_audit', business_date: '2026-07-01' });
        expect(xResponse.statusCode).toBe(200);
        expectSafeStoreInfo(xResponse.body.print_payload);

        const [[xDocument]] = await pool.query(
            "SELECT payload_json FROM audit_report_documents WHERE report_type = 'x_audit' ORDER BY id DESC LIMIT 1"
        );
        expectSafeStoreInfo(JSON.parse(xDocument.payload_json));

        const itemsResponse = await request(app)
            .post('/api/admin/audit-reports/print-items')
            .set('Cookie', adminCookie)
            .send({ business_date: '2026-07-01' });
        expect(itemsResponse.statusCode).toBe(200);
        expectSafeStoreInfo(itemsResponse.body.print_payload);

        await pool.query(
            "UPDATE settings SET setting_value = '1' WHERE setting_key = 'y_order_type_id'"
        );
        await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Credential boundary Y', ?, 5.00, '2026-07-01 08:00:00')`,
            [userId, JSON.stringify({
                order_type_id: 1,
                items: [{ id: 1, product_id: 1, name: 'Test Burger', category_id: 1, qty: 1, price: 5, tax_rate: 16 }],
            })]
        );

        const yResponse = await request(app)
            .post('/api/admin/audit-reports/print-y')
            .set('Cookie', adminCookie)
            .send({ business_date: '2026-07-01' });
        expect(yResponse.statusCode).toBe(200);
        expectSafeStoreInfo(yResponse.body.print_payload);
        const [[yArchive]] = await pool.query('SELECT report_payload FROM master_held ORDER BY id DESC LIMIT 1');
        expectSafeStoreInfo(JSON.parse(yArchive.report_payload));
    });

    it('refuses to return an unredacted legacy audit or Y archive payload', async () => {
        const unsafePayload = {
            print_type: 'audit_report',
            report_type: 'z_audit',
            storeInfo: { store_name: 'Legacy', jofotara_sales_tax_secret_key: SECRET },
            payload_hash: 'a'.repeat(64),
        };
        await pool.query(
            `INSERT INTO audit_report_documents
                (report_type, serial_no, serial_label, business_date, business_start_at,
                 business_end_at, z_business_date_lock, payload_json, payload_hash, issued_by_user_id)
             VALUES ('z_audit', 99, 'Z-99', '2026-07-03', '2026-07-03 03:00:00',
                     '2026-07-04 03:00:00', '2026-07-03', ?, ?, ?)`,
            [JSON.stringify(unsafePayload), unsafePayload.payload_hash, userId]
        );
        const auditResponse = await request(app)
            .post('/api/admin/audit-reports/print')
            .set('Cookie', adminCookie)
            .send({ report_type: 'z_audit', business_date: '2026-07-03' });
        expect(auditResponse.statusCode).toBe(409);
        expect(JSON.stringify(auditResponse.body)).not.toContain(SECRET);

        const [archive] = await pool.query(
            `INSERT INTO master_held
                (business_start_at, business_end_at, report_payload, held_orders_payload,
                 generated_by_user_id, expires_at)
             VALUES ('2026-07-03 03:00:00', '2026-07-04 03:00:00', ?, '[]', ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
            [JSON.stringify({ ...unsafePayload, print_type: 'y_held_items_report' }), userId]
        );
        const archiveResponse = await request(app)
            .get(`/api/admin/audit-reports/y-archives/${archive.insertId}/print-payload`)
            .set('Cookie', adminCookie);
        expect(archiveResponse.statusCode).toBe(409);
        expect(JSON.stringify(archiveResponse.body)).not.toContain(SECRET);
    });
});
