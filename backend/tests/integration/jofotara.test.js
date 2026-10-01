const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const {
    submitSalesInvoice, submitCreditNote, getJofotaraOperations, getJofotaraOperationCount, processJofotaraOperations,
    prepareCheckoutInvoiceIfAutomatic, submitCheckoutInvoiceIfAutomatic
} = require('../../services/JofotaraService');

async function insertSale(profile = 'sales_tax') {
    const [[next]] = await pool.query('SELECT COALESCE(MAX(invoice_number), 7000) + 1 AS invoice_number FROM orders');
    const [result] = await pool.query(
        `INSERT INTO orders
         (invoice_number, user_id, subtotal, tax, tax_inclusive_at_sale, tax_registration_type_at_sale, total, payment_method, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, 'cash', '2026-07-21 09:00:00')`,
        [next.invoice_number, SEED.adminUser.id, profile === 'income_tax' ? 5.55 : 5.14, profile === 'income_tax' ? 0 : 0.41, profile, 5.55]
    );
    await pool.query(
        `INSERT INTO order_items
         (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount,
          modifier_surcharge, modifier_tax_amount)
         VALUES (?, 1, 'Burger & Cheese', 1, ?, ?, ?, 0.15, ?)`,
        [result.insertId, profile === 'income_tax' ? 5.55 : 5.15, profile === 'income_tax' ? 0 : 8,
            profile === 'income_tax' ? 0 : 0.411111, profile === 'income_tax' ? 0 : 0.011111]
    );
    return result.insertId;
}

async function insertExemptSale() {
    const [[next]] = await pool.query('SELECT COALESCE(MAX(invoice_number), 7000) + 1 AS invoice_number FROM orders');
    const [result] = await pool.query(
        `INSERT INTO orders
         (invoice_number, user_id, subtotal, tax, tax_inclusive_at_sale, tax_exempt_at_sale,
          tax_registration_type_at_sale, total, payment_method, created_at)
         VALUES (?, ?, 17.00, 0.00, 1, 1, 'sales_tax', 17.00, 'cash', '2026-07-21 09:00:00')`,
        [next.invoice_number, SEED.adminUser.id]
    );
    await pool.query(
        `INSERT INTO order_items
         (invoice_id, product_id, item_name, quantity, price_at_sale, price_before_tax_exemption,
          tax_rate, tax_amount)
         VALUES (?, 1, 'Exempt Burger', 1, 17.000000, 20.000000, 16.00, 0.000000)`,
        [result.insertId]
    );
    return result.insertId;
}

async function captureAutomaticPreparation(operation) {
    const originalGetConnection = pool.getConnection;
    const leases = [];
    const restoreLease = lease => {
        if (lease.restored) return;
        lease.restored = true;
        Object.assign(lease.connection, lease.original);
    };

    pool.getConnection = async function capturedGetConnection(...args) {
        const connection = await originalGetConnection.apply(this, args);
        const lease = {
            connection,
            commands: [],
            restored: false,
            original: {
                query: connection.query,
                beginTransaction: connection.beginTransaction,
                commit: connection.commit,
                rollback: connection.rollback,
                release: connection.release
            }
        };
        leases.push(lease);
        connection.query = async function capturedQuery(sql, ...queryArgs) {
            lease.commands.push({ type: 'query', sql: String(sql), params: queryArgs });
            return lease.original.query.call(this, sql, ...queryArgs);
        };
        for (const method of ['beginTransaction', 'commit', 'rollback']) {
            connection[method] = async function capturedTransactionCommand(...commandArgs) {
                lease.commands.push({ type: method });
                return lease.original[method].apply(this, commandArgs);
            };
        }
        connection.release = function capturedRelease(...releaseArgs) {
            restoreLease(lease);
            return lease.original.release.apply(this, releaseArgs);
        };
        return connection;
    };

    try {
        return { value: await operation(), leases };
    } finally {
        for (const lease of leases) restoreLease(lease);
        pool.getConnection = originalGetConnection;
    }
}

describe('JoFotara integration', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = login.headers['set-cookie'][0];
    });

    afterEach(() => vi.restoreAllMocks());

    afterAll(async () => { await pool.end(); });

    it('filters issue dates by business calendar midnight with an exclusive next-day boundary', async () => {
        const ids = [];
        for (const stamp of ['2026-07-20 20:59:59', '2026-07-20 21:00:00', '2026-07-21 20:59:59', '2026-07-21 21:00:00']) {
            const id = await insertSale(); ids.push(id);
            await pool.query('UPDATE orders SET invoice_issued_at=? WHERE invoice_id=?', [stamp, id]);
        }
        const result = await getJofotaraOperations({ issuedFrom: '2026-07-21', issuedTo: '2026-07-21' });
        expect(result.items.map(row => row.source_id).sort((a,b) => a-b)).toEqual(ids.slice(1,3));
    });

    it('reports whether the automatic recovery cadence is active', async () => {
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key IN ('jofotara_enabled','jofotara_auto_submit')");
        await expect(processJofotaraOperations()).resolves.toMatchObject({
            automatic_enabled: false,
            attempted: 0,
            stale: 0
        });

        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key IN ('jofotara_enabled','jofotara_auto_submit')");
        await pool.query("UPDATE settings SET setting_value=DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') WHERE setting_key='jofotara_auto_submit_since'");
        await expect(processJofotaraOperations()).resolves.toMatchObject({ automatic_enabled: true });
    });

    it('reconfigures the owned runner only after a successful settings commit', async () => {
        const original = app.get('jofotaraOperationsRunner');
        const configure = vi.fn();
        const emit = vi.fn();
        const io = app.get('io');
        vi.spyOn(io, 'to').mockReturnValue({ emit });
        app.set('jofotaraOperationsRunner', { configure });
        try {
            await request(app).put('/api/admin/jofotara/settings')
                .set('Cookie', adminCookie)
                .send({
                    enabled: true,
                    auto_submit: true,
                    profiles: {
                        sales_tax: {
                            client_id: 'client',
                            secret_key: 'secret',
                            income_source_sequence: '123',
                            seller_tax_number: '987654321',
                            seller_registered_name: 'Test Seller'
                        }
                    }
                })
                .expect(200);
            expect(configure).toHaveBeenCalledOnce();
            expect(configure).toHaveBeenCalledWith(true);
            expect(io.to).toHaveBeenCalledWith('staff');
            expect(emit).toHaveBeenLastCalledWith('jofotara_operations_changed', {
                configuration_changed: true,
                automatic_enabled: true
            });

            configure.mockClear();
            emit.mockClear();
            await request(app).put('/api/admin/jofotara/settings')
                .set('Cookie', adminCookie)
                .send({ tax_registration_type: 'other' })
                .expect(400);
            expect(configure).not.toHaveBeenCalled();
            expect(emit).not.toHaveBeenCalled();

            await request(app).put('/api/admin/jofotara/settings')
                .set('Cookie', adminCookie)
                .send({ enabled: false, auto_submit: false })
                .expect(200);
            expect(configure).toHaveBeenCalledOnce();
            expect(configure).toHaveBeenCalledWith(false);
            expect(emit).toHaveBeenLastCalledWith('jofotara_operations_changed', {
                configuration_changed: true,
                automatic_enabled: false
            });

            emit.mockImplementationOnce(() => { throw new Error('socket unavailable'); });
            configure.mockRejectedValueOnce(new Error('runner unavailable'));
            await request(app).put('/api/admin/jofotara/settings')
                .set('Cookie', adminCookie)
                .send({ enabled: false, auto_submit: false })
                .expect(200);
        } finally {
            app.set('jofotaraOperationsRunner', original);
        }
    });

    it('writes the selected profile credentials and never returns the secret value', async () => {
        const longSecret = 'jofotara-secret-segment.'.repeat(24);
        const initial = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie);
        expect(initial.statusCode).toBe(200);
        expect(initial.body.settings).toMatchObject({
            tax_registration_type: 'sales_tax',
            profiles: {
                sales_tax: { client_id: '', seller_tax_number: '', secret_configured: false },
                income_tax: { client_id: '', seller_tax_number: '', secret_configured: false }
            }
        });

        await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({ secret_key: longSecret }).expect(200);
        const saved = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie);
        expect(longSecret.length).toBeGreaterThan(255);
        expect(JSON.stringify(saved.body)).not.toContain(longSecret);
        expect(saved.body.settings.secret_configured).toBe(true);
        const [[stored]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'jofotara_sales_tax_secret_key'");
        expect(stored.setting_value).toBe(longSecret);
        const [legacy] = await pool.query("SELECT setting_key FROM settings WHERE setting_key = 'jofotara_secret_key'");
        expect(legacy).toHaveLength(0);
    });

    it('updates either profile without clearing the other profile or a blank secret', async () => {
        await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({
            tax_registration_type: 'income_tax',
            profiles: {
                sales_tax: { client_id: 'sales-client', secret_key: 'sales-secret' },
                income_tax: { client_id: 'income-client', secret_key: 'income-secret' }
            }
        }).expect(200);
        await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({
            profiles: { income_tax: { seller_registered_name: 'Income Seller', secret_key: '' } }
        }).expect(200);
        const response = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie);
        expect(response.body.settings.tax_registration_type).toBe('income_tax');
        expect(response.body.settings.profiles.sales_tax).toMatchObject({ client_id: 'sales-client', secret_configured: true });
        expect(response.body.settings.profiles.income_tax).toMatchObject({ client_id: 'income-client', seller_registered_name: 'Income Seller', secret_configured: true });

        await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({
            profiles: { income_tax: { clear_secret: true } }
        }).expect(200);
        const afterClear = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie);
        expect(afterClear.body.settings.profiles.sales_tax.secret_configured).toBe(true);
        expect(afterClear.body.settings.profiles.income_tax.secret_configured).toBe(false);
        await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({ tax_registration_type: 'other' }).expect(400);
    });

    it('rejects enabling an incomplete selected profile without changing settings', async () => {
        const before = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie);
        const response = await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({ enabled: true });
        expect(response.statusCode).toBe(409);
        expect(response.body.publicCode).toBe('JOFOTARA_SELLER_INCOMPLETE');
        const after = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie);
        expect(after.body.settings.enabled).toBe(before.body.settings.enabled);
        expect(after.body.settings.auto_submit).toBe(before.body.settings.auto_submit);
    });

    it('rejects enabling automatic submission while integration is disabled atomically', async () => {
        const response = await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({ auto_submit: true });
        expect(response.statusCode).toBe(409);
        expect(response.body.publicCode).toBe('JOFOTARA_AUTO_REQUIRES_ENABLED');
        const [[enabled]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='jofotara_auto_submit'");
        expect(enabled.setting_value).toBe('0');
    });

    it('downloads exact XML without enabling or creating a legal ledger row', async () => {
        const invoiceId = await insertSale();
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END
            WHERE setting_key IN (
                'jofotara_sales_tax_income_source_sequence',
                'jofotara_sales_tax_seller_tax_number',
                'jofotara_sales_tax_seller_registered_name'
            )`);
        const response = await request(app).get(`/api/admin/jofotara/invoices/${invoiceId}/xml`).set('Cookie', adminCookie);
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('application/xml');
        expect(response.text).toContain('<cbc:ID>7001</cbc:ID>');
        expect(response.text).toContain('<cbc:InvoiceTypeCode name="012">388</cbc:InvoiceTypeCode>');
        const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM jofotara_documents');
        expect(Number(count.n)).toBe(0);
    });

    it('classifies a persisted taxable exempt sale as Z with zero tax', async () => {
        const invoiceId = await insertExemptSale();
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END
            WHERE setting_key IN (
                'jofotara_sales_tax_income_source_sequence',
                'jofotara_sales_tax_seller_tax_number',
                'jofotara_sales_tax_seller_registered_name'
            )`);

        const response = await request(app)
            .get(`/api/admin/jofotara/invoices/${invoiceId}/xml`)
            .set('Cookie', adminCookie)
            .expect(200);

        expect(response.text).toContain('<cbc:ID schemeAgencyID="6" schemeID="UN/ECE 5305">Z</cbc:ID>');
        expect(response.text).toContain('<cbc:Percent>0.00</cbc:Percent>');
        expect(response.text).toContain('<cbc:TaxAmount currencyID="JO">0.000000</cbc:TaxAmount>');
    });

    it('lists receivables once and builds JoFotara from the frozen buyer snapshot', async () => {
        const invoiceId = await insertSale();
        const [customer] = await pool.query("INSERT INTO customers (phone,name,address) VALUES ('0799991000','Mutable Buyer','Old address')");
        await pool.query(
            `UPDATE orders SET payment_method='receivable', customer_id=?, payment_due_on='2026-08-31',
                    receivable_reason='Approved account', buyer_name_at_sale='Frozen Buyer',
                    buyer_phone_at_sale='0799991000', buyer_address_at_sale='Frozen address',
                    cash_amount=0, card_amount=0, amount_tendered=0, change_due=0
              WHERE invoice_id=?`,
            [customer.insertId, invoiceId]
        );
        await pool.query("UPDATE customers SET name='Changed Buyer', address='Changed address' WHERE id=?", [customer.insertId]);
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key IN (
                'jofotara_sales_tax_income_source_sequence','jofotara_sales_tax_seller_tax_number','jofotara_sales_tax_seller_registered_name'
            )`);

        const preview = await request(app).get(`/api/admin/jofotara/invoices/${invoiceId}/xml`).set('Cookie', adminCookie);
        expect(preview.statusCode).toBe(200);
        expect(preview.text).toContain('<cbc:InvoiceTypeCode name="022">388</cbc:InvoiceTypeCode>');
        expect(preview.text).toContain('Frozen Buyer');
        expect(preview.text).not.toContain('Changed Buyer');
        const operations = await getJofotaraOperations({ limit: 50 });
        expect(operations.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ source_type: 'invoice', source_id: invoiceId, status: 'not_submitted' })
        ]));
    });

    it('stores accepted invoices once and never sends an accepted invoice twice', async () => {
        const invoiceId = await insertSale();
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'tax_registration_type' THEN 'sales_tax'
            WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END
            WHERE setting_key IN (
                'jofotara_enabled', 'tax_registration_type', 'jofotara_sales_tax_client_id',
                'jofotara_sales_tax_secret_key', 'jofotara_sales_tax_income_source_sequence',
                'jofotara_sales_tax_seller_tax_number', 'jofotara_sales_tax_seller_registered_name'
            )`);
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr-data' }) };
        };
        const first = await submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'order' });
        const second = await submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'order' });
        expect(first).toMatchObject({ status: 'accepted', qr_text: 'qr-data' });
        expect(second.status).toBe('accepted');
        expect(calls).toBe(1);
        const [[row]] = await pool.query('SELECT attempt_count, request_xml FROM jofotara_documents WHERE source_key = ?', [`invoice:${invoiceId}`]);
        expect(Number(row.attempt_count)).toBe(1);
        expect(row.request_xml).toContain('<cbc:ID>7001</cbc:ID>');
    });

    it('rejects a persisted platform invoice from the order submission surface', async () => {
        const invoiceId = await insertSale();
        await pool.query(
            "UPDATE orders SET payment_method='platform', buyer_name_at_sale='Platform Buyer', cash_amount=0, card_amount=0, amount_tendered=0, change_due=0 WHERE invoice_id=?",
            [invoiceId]
        );
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr' }) });

        await expect(submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'order' }))
            .rejects.toMatchObject({ publicCode: 'JOFOTARA_OPERATIONS_REQUIRED' });
    });

    it('keeps special invoice and refund routes admin-only, Operations-only, and idempotent', async () => {
        const invoiceId = await insertSale();
        await pool.query(
            "UPDATE orders SET payment_method='platform', buyer_name_at_sale='Platform Buyer', cash_amount=0, card_amount=0, amount_tendered=0, change_due=0 WHERE invoice_id=?",
            [invoiceId]
        );
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const cashierLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const cashierCookie = cashierLogin.headers['set-cookie'][0];
        const provider = vi.spyOn(global, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'route-qr' })
        });

        await request(app).post(`/api/admin/jofotara/operations/invoices/${invoiceId}/submit`).expect(401);
        await request(app).post(`/api/admin/jofotara/operations/invoices/${invoiceId}/submit`).set('Cookie', cashierCookie).expect(403);

        const direct = await request(app).post(`/api/admin/jofotara/invoices/${invoiceId}/submit`).set('Cookie', adminCookie).send({ source_kind: 'standard' });
        expect(direct.statusCode).toBe(409);
        expect(direct.body.publicCode).toBe('JOFOTARA_OPERATIONS_REQUIRED');
        const operation = await request(app).post(`/api/admin/jofotara/operations/invoices/${invoiceId}/submit`).set('Cookie', adminCookie).send({ source_kind: 'standard' });
        expect(operation.statusCode).toBe(200);
        expect(operation.body.document).toMatchObject({ status: 'accepted', qr_text: 'route-qr' });
        await request(app).post(`/api/admin/jofotara/operations/invoices/${invoiceId}/submit`).set('Cookie', adminCookie).expect(200);
        expect(provider).toHaveBeenCalledTimes(1);

        const [refund] = await pool.query(
            `INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, reason, user_id)
             VALUES ('refund', ?, 'item', 5.14, 0.41, 5.55, 'Platform route return', ?)`,
            [invoiceId, SEED.adminUser.id]
        );
        await pool.query(
            `INSERT INTO refund_items
             (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
             SELECT ?, id, product_id, item_name, 1, 5.15, 5.14, 0.41, 5.55 FROM order_items WHERE invoice_id=? LIMIT 1`,
            [refund.insertId, invoiceId]
        );
        const directRefund = await request(app)
            .post(`/api/admin/jofotara/refunds/${refund.insertId}/submit`)
            .set('Cookie', adminCookie)
            .send({ source_kind: 'standard' });
        expect(directRefund.statusCode).toBe(409);
        expect(directRefund.body.publicCode).toBe('JOFOTARA_OPERATIONS_REQUIRED');
        const operationRefund = await request(app)
            .post(`/api/admin/jofotara/operations/refunds/${refund.insertId}/submit`)
            .set('Cookie', adminCookie)
            .send({ source_kind: 'standard' });
        expect(operationRefund.statusCode).toBe(200);
        expect(operationRefund.body.document.status).toBe('accepted');
        expect(provider).toHaveBeenCalledTimes(2);

        await pool.query("UPDATE jofotara_documents SET status='unknown' WHERE source_key=?", [`invoice:${invoiceId}`]);
        const unknown = await request(app)
            .post(`/api/admin/jofotara/operations/invoices/${invoiceId}/submit`)
            .set('Cookie', adminCookie);
        expect(unknown.statusCode).toBe(409);
        expect(unknown.body.publicCode).toBe('JOFOTARA_UNKNOWN');
        expect(provider).toHaveBeenCalledTimes(2);
    });

    it('keeps platform invoices and their returns Operations-only with receivable terms', async () => {
        const invoiceId = await insertSale();
        await pool.query(
            "UPDATE orders SET payment_method='platform', buyer_name_at_sale='Platform Buyer', cash_amount=0, card_amount=0, amount_tendered=0, change_due=0 WHERE invoice_id=?",
            [invoiceId]
        );
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const [[printBefore]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr' }) };
        };

        await expect(submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'operations' }))
            .resolves.toMatchObject({ status: 'accepted' });
        await expect(submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'operations' }))
            .resolves.toMatchObject({ status: 'accepted' });
        expect(calls).toBe(1);
        const [[invoiceDocument]] = await pool.query('SELECT request_xml FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
        expect(invoiceDocument.request_xml).toContain('<cbc:InvoiceTypeCode name="022">388</cbc:InvoiceTypeCode>');

        const [refund] = await pool.query(
            `INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, reason, user_id)
             VALUES ('refund', ?, 'item', 5.14, 0.41, 5.55, 'Platform return', ?)`,
            [invoiceId, SEED.adminUser.id]
        );
        await pool.query(
            `INSERT INTO refund_items
             (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
             SELECT ?, id, product_id, item_name, 1, 5.15, 5.14, 0.41, 5.55 FROM order_items WHERE invoice_id=? LIMIT 1`,
            [refund.insertId, invoiceId]
        );

        await expect(submitCreditNote({ refundId: refund.insertId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'order' }))
            .rejects.toMatchObject({ publicCode: 'JOFOTARA_OPERATIONS_REQUIRED' });
        const [[beforeOperations]] = await pool.query('SELECT COUNT(*) AS count FROM jofotara_documents WHERE source_key=?', [`refund:${refund.insertId}`]);
        expect(Number(beforeOperations.count)).toBe(0);
        await expect(submitCreditNote({ refundId: refund.insertId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'operations' }))
            .resolves.toMatchObject({ status: 'accepted' });
        await expect(submitCreditNote({ refundId: refund.insertId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'operations' }))
            .resolves.toMatchObject({ status: 'accepted' });
        expect(calls).toBe(2);
        const [[invoiceIdentity]] = await pool.query('SELECT id FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
        const [[returnDocument]] = await pool.query('SELECT original_document_id FROM jofotara_documents WHERE source_key=?', [`refund:${refund.insertId}`]);
        expect(Number(returnDocument.original_document_id)).toBe(Number(invoiceIdentity.id));
        const [[printAfter]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(Number(printAfter.count)).toBe(Number(printBefore.count));
    });

    it('reads a disabled automatic checkout disposition once without opening a transaction', async () => {
        const invoiceId = await insertSale();
        const captured = await captureAutomaticPreparation(() =>
            prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id })
        );

        expect(captured.value).toMatchObject({ required: false, status: 'not_required' });
        expect(captured.leases).toHaveLength(1);
        expect(captured.leases[0].commands.filter(command => command.type === 'query')).toHaveLength(1);
        expect(captured.leases[0].commands.some(command => command.type === 'beginTransaction')).toBe(false);
        expect(captured.leases[0].commands[0].sql).not.toMatch(/secret_key|request_xml|response_body/i);
        expect(captured.leases[0].commands[0].sql).not.toMatch(/select\s+\*/i);
    });

    it('reads an outside-cutoff automatic checkout disposition once without opening a transaction', async () => {
        const invoiceId = await insertSale();
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN '2099-01-01 00:00:00'
            ELSE setting_value END WHERE setting_key IN ('jofotara_enabled', 'jofotara_auto_submit', 'jofotara_auto_submit_since')`);
        const captured = await captureAutomaticPreparation(() =>
            prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id })
        );

        expect(captured.value).toMatchObject({ required: false, status: 'not_required' });
        expect(captured.leases).toHaveLength(1);
        expect(captured.leases[0].commands.filter(command => command.type === 'query')).toHaveLength(1);
        expect(captured.leases[0].commands.some(command => command.type === 'beginTransaction')).toBe(false);
    });

    it('rejects platform checkout preparation with one read and no transaction', async () => {
        const invoiceId = await insertSale();
        await pool.query("UPDATE orders SET payment_method='platform', invoice_issued_at=NOW() WHERE invoice_id=?", [invoiceId]);
        const captured = await captureAutomaticPreparation(() =>
            prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id })
        );
        expect(captured.value).toMatchObject({ required: false, status: 'not_required', code: 'platform' });
        expect(captured.leases).toHaveLength(1);
        expect(captured.leases[0].commands.filter(command => command.type === 'query')).toHaveLength(1);
        expect(captured.leases[0].commands.some(command => command.type === 'beginTransaction')).toBe(false);
    });
    it.each(['pending', 'submitting', 'accepted', 'rejected', 'unknown'])(
        'returns the stored %s standard document even when automatic creation is disabled',
        async status => {
            const invoiceId = await insertSale();
            await pool.query(`INSERT INTO jofotara_documents
                (source_key, order_invoice_id, document_kind, tax_registration_type, document_number, document_uuid, status)
                VALUES (?, ?, 'invoice', 'sales_tax', ?, UUID(), ?)`,
            [`invoice:${invoiceId}`, invoiceId, String(invoiceId), status]);
            const captured = await captureAutomaticPreparation(() =>
                prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id })
            );

            expect(captured.value).toMatchObject({ required: true, status });
            expect(captured.leases).toHaveLength(1);
            expect(captured.leases[0].commands.filter(command => command.type === 'query')).toHaveLength(1);
            expect(captured.leases[0].commands.some(command => command.type === 'beginTransaction')).toBe(false);
        }
    );

    it('observes automatic setting changes on the next checkout preparation', async () => {
        const invoiceId = await insertSale();
        await pool.query('UPDATE orders SET invoice_issued_at=NOW() WHERE invoice_id=?', [invoiceId]);
        await expect(prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id }))
            .resolves.toMatchObject({ required: false, status: 'not_required' });

        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);

        await expect(prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id }))
            .resolves.toMatchObject({ required: true, status: 'pending' });
    });

    it('lets recovery acquire an eligible invoice when automation is enabled after a disabled preflight', async () => {
        const invoiceId = await insertSale();
        await pool.query('UPDATE orders SET invoice_issued_at=DATE_SUB(NOW(), INTERVAL 3 MINUTE) WHERE invoice_id=?', [invoiceId]);
        await expect(prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id }))
            .resolves.toMatchObject({ required: false, status: 'not_required' });

        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 10 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        let calls = 0;
        const result = await processJofotaraOperations({
            fetchImpl: async () => {
                calls += 1;
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr-recovered' })
                };
            }
        });

        expect(result).toMatchObject({ attempted: 1, accepted: 1 });
        expect(calls).toBe(1);
        const [[document]] = await pool.query(
            'SELECT status FROM jofotara_documents WHERE source_key=?',
            [`invoice:${invoiceId}`]
        );
        expect(document.status).toBe('accepted');
    });

    it('creates only one pending document when automatic preparation races', async () => {
        const invoiceId = await insertSale();
        await pool.query('UPDATE orders SET invoice_issued_at=NOW() WHERE invoice_id=?', [invoiceId]);
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);

        const [first, second] = await Promise.all([
            prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id }),
            prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id })
        ]);

        expect(first).toMatchObject({ required: true, status: 'pending' });
        expect(second).toMatchObject({ required: true, status: 'pending' });
        expect(first.document.id).toBe(second.document.id);
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
        expect(Number(count.count)).toBe(1);
    });

    it('rechecks automatic policy after its preflight before creating a document', async () => {
        const invoiceId = await insertSale();
        await pool.query('UPDATE orders SET invoice_issued_at=NOW() WHERE invoice_id=?', [invoiceId]);
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);

        const originalGetConnection = pool.getConnection;
        let policyChanged = false;
        pool.getConnection = async function changedPolicyConnection(...args) {
            const connection = await originalGetConnection.apply(this, args);
            const originalQuery = connection.query;
            const originalRelease = connection.release;
            connection.query = async function changePolicyAfterPreflight(sql, ...queryArgs) {
                const result = await originalQuery.call(this, sql, ...queryArgs);
                if (!policyChanged && String(sql).includes('FROM orders o') && String(sql).includes('jofotara_auto_submit_since')) {
                    policyChanged = true;
                    await originalQuery.call(this,
                        "UPDATE settings SET setting_value='0' WHERE setting_key IN ('jofotara_enabled', 'jofotara_auto_submit')"
                    );
                }
                return result;
            };
            connection.release = function restoreChangedPolicyConnection(...releaseArgs) {
                connection.query = originalQuery;
                connection.release = originalRelease;
                return originalRelease.apply(this, releaseArgs);
            };
            return connection;
        };
        let result;
        try {
            result = await prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id });
        } finally {
            pool.getConnection = originalGetConnection;
        }

        expect(policyChanged).toBe(true);
        expect(result).toMatchObject({ required: false, status: 'not_required' });
        const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
        expect(Number(count.count)).toBe(0);
    });

    it('prepares an automatic checkout invoice locally without contacting JoFotara', async () => {
        const invoiceId = await insertSale();
        await pool.query("UPDATE orders SET invoice_issued_at=NOW() WHERE invoice_id=?", [invoiceId]);
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const result = await prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id });
        expect(result).toMatchObject({ required: true, status: 'pending' });
        const [[document]] = await pool.query('SELECT status, request_xml FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
        expect(document.status).toBe('pending');
        expect(document.request_xml).toContain('<Invoice');
    });

    it('finalizes a prepared checkout once and returns stored accepted state on replay', async () => {
        const invoiceId = await insertSale();
        await pool.query("UPDATE orders SET invoice_issued_at=NOW() WHERE invoice_id=?", [invoiceId]);
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        await prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id });
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr-checkout' }) };
        };
        const first = await submitCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl });
        const second = await submitCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl });
        expect(first).toMatchObject({ required: true, status: 'accepted' });
        expect(second).toMatchObject({ required: true, status: 'accepted' });
        expect(calls).toBe(1);
    });

    it('blocks a double-click while the first network request is in flight', async () => {
        const invoiceId = await insertSale();
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key IN (
                'jofotara_enabled', 'jofotara_sales_tax_client_id', 'jofotara_sales_tax_secret_key',
                'jofotara_sales_tax_income_source_sequence', 'jofotara_sales_tax_seller_tax_number',
                'jofotara_sales_tax_seller_registered_name'
            )`);
        let release;
        let started;
        const startedPromise = new Promise(resolve => { started = resolve; });
        const fetchImpl = async () => {
            started();
            await new Promise(resolve => { release = resolve; });
            return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'PASS', EINV_QR: 'qr' }) };
        };
        const first = submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'order' });
        await startedPromise;
        await expect(submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl, surface: 'order' })).rejects.toMatchObject({ publicCode: 'JOFOTARA_SUBMITTING' });
        release();
        await expect(first).resolves.toMatchObject({ status: 'accepted' });
    });

    it('submits only saved refunds and references the accepted original', async () => {
        const invoiceId = await insertSale();
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key IN (
                'jofotara_enabled', 'jofotara_sales_tax_client_id', 'jofotara_sales_tax_secret_key',
                'jofotara_sales_tax_income_source_sequence', 'jofotara_sales_tax_seller_tax_number',
                'jofotara_sales_tax_seller_registered_name'
            )`);
        const acceptedFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr' }) });
        await submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl: acceptedFetch, surface: 'order' });
        const [refund] = await pool.query(
            `INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, reason, user_id)
             VALUES ('refund', ?, 'item', 5.14, 0.41, 5.55, NULL, ?)`,
            [invoiceId, SEED.adminUser.id]
        );
        await pool.query(
            `INSERT INTO refund_items (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
             SELECT ?, id, product_id, item_name, 1, 5.15, 5.14, 0.41, 5.55 FROM order_items WHERE invoice_id = ? LIMIT 1`,
            [refund.insertId, invoiceId]
        );
        const rejectedFetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({
            EINV_STATUS: 'NOT_SUBMITTED',
            EINV_RESULTS: { status: 'ERROR', ERRORS: [{ EINV_CODE: 'bad-calculation', EINV_MESSAGE: 'Bad calculation' }] }
        }) });
        const rejected = await submitCreditNote({ refundId: refund.insertId, actorUserId: SEED.adminUser.id, fetchImpl: rejectedFetch, surface: 'order' });
        expect(rejected).toMatchObject({ status: 'rejected', last_error: 'JoFotara rejected the document: bad-calculation — Bad calculation' });
        await pool.query("UPDATE jofotara_documents SET request_xml='stale-rejected-xml' WHERE refund_id=?", [refund.insertId]);
        let retriedXml;
        const retryFetch = async (_url, options) => {
            retriedXml = Buffer.from(JSON.parse(options.body).invoice, 'base64').toString('utf8');
            return acceptedFetch();
        };
        const document = await submitCreditNote({ refundId: refund.insertId, actorUserId: SEED.adminUser.id, fetchImpl: retryFetch, surface: 'order' });
        expect(document.status).toBe('accepted');
        expect(retriedXml).not.toBe('stale-rejected-xml');
        const [[stored]] = await pool.query('SELECT request_xml, original_document_id FROM jofotara_documents WHERE refund_id = ?', [refund.insertId]);
        expect(stored.request_xml).toContain('<cbc:InvoiceTypeCode name="012">381</cbc:InvoiceTypeCode>');
        expect(stored.request_xml).toContain('<cac:BillingReference>');
        expect(stored.request_xml).toContain('<cbc:InstructionNote>إرجاع فاتورة</cbc:InstructionNote>');
        expect(stored.original_document_id).not.toBeNull();
    });

    it('archives accepted invoice and credit-note XML under the durable data folder', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-jofotara-'));
        const previousDataDir = process.env.DATA_DIR;
        process.env.DATA_DIR = dataDir;
        try {
            const invoiceId = await insertSale();
            await pool.query(`UPDATE settings SET setting_value = CASE setting_key
                WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
                WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
                WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
                ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
            const acceptedFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr' }) });
            await submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl: acceptedFetch, surface: 'order' });
            const [refund] = await pool.query(
                `INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, reason, user_id)
                 VALUES ('refund', ?, 'item', 5.14, 0.41, 5.55, 'Customer return', ?)`,
                [invoiceId, SEED.adminUser.id]
            );
            await pool.query(
                `INSERT INTO refund_items (refund_id, order_item_id, product_id, item_name, quantity, unit_price, line_subtotal, line_tax, line_total)
                 SELECT ?, id, product_id, item_name, 1, 5.15, 5.14, 0.41, 5.55 FROM order_items WHERE invoice_id=? LIMIT 1`,
                [refund.insertId, invoiceId]
            );
            await submitCreditNote({ refundId: refund.insertId, actorUserId: SEED.adminUser.id, fetchImpl: acceptedFetch, surface: 'order' });

            const archiveDir = path.join(dataDir, 'jofotara', 'xml');
            expect(fs.existsSync(archiveDir)).toBe(true);
            const files = fs.readdirSync(archiveDir);
            expect(files.some(file => file.startsWith('invoice-'))).toBe(true);
            expect(files.some(file => file.startsWith('credit-note-'))).toBe(true);
            const xml = files.map(file => fs.readFileSync(path.join(archiveDir, file), 'utf8'));
            expect(xml).toHaveLength(2);
            expect(xml.some(value => value.includes('<cbc:InvoiceTypeCode name="012">388</cbc:InvoiceTypeCode>'))).toBe(true);
            expect(xml.some(value => value.includes('<cbc:InvoiceTypeCode name="012">381</cbc:InvoiceTypeCode>'))).toBe(true);
        } finally {
            if (previousDataDir === undefined) delete process.env.DATA_DIR;
            else process.env.DATA_DIR = previousDataDir;
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it('archives submission XML before a failed request and allows archiving to be disabled', async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-jofotara-failed-'));
        const previousDataDir = process.env.DATA_DIR;
        process.env.DATA_DIR = dataDir;
        try {
            await pool.query(`UPDATE settings SET setting_value = CASE setting_key
                WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
                WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
                WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
                ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
            const failedFetch = async () => ({ ok: false, status: 500, text: async () => 'Government server error' });
            const firstInvoiceId = await insertSale();

            await submitSalesInvoice({ invoiceId: firstInvoiceId, actorUserId: SEED.adminUser.id, fetchImpl: failedFetch, surface: 'order' });

            const archiveDir = path.join(dataDir, 'jofotara', 'xml');
            expect(fs.existsSync(archiveDir)).toBe(true);
            expect(fs.readdirSync(archiveDir)).toHaveLength(1);
            expect(fs.readFileSync(path.join(archiveDir, fs.readdirSync(archiveDir)[0]), 'utf8')).toContain('<cbc:InvoiceTypeCode name="012">388</cbc:InvoiceTypeCode>');

            await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({ archive_xml: false }).expect(200);
            const settings = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie).expect(200);
            expect(settings.body.settings.archive_xml).toBe(false);
            const secondInvoiceId = await insertSale();
            await submitSalesInvoice({ invoiceId: secondInvoiceId, actorUserId: SEED.adminUser.id, fetchImpl: failedFetch, surface: 'order' });
            expect(fs.readdirSync(archiveDir)).toHaveLength(1);
        } finally {
            if (previousDataDir === undefined) delete process.env.DATA_DIR;
            else process.env.DATA_DIR = previousDataDir;
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it('previews and submits using the order profile, then retries with that profile credentials', async () => {
        const invoiceId = await insertSale('income_tax');
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'tax_registration_type' THEN 'sales_tax'
            WHEN 'jofotara_income_tax_client_id' THEN 'income-client'
            WHEN 'jofotara_income_tax_secret_key' THEN 'income-secret'
            WHEN 'jofotara_income_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_income_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_income_tax_seller_registered_name' THEN 'Income Seller'
            WHEN 'jofotara_sales_tax_client_id' THEN 'sales-client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'sales-secret'
            ELSE setting_value END WHERE setting_key IN (
                'jofotara_enabled', 'tax_registration_type', 'jofotara_income_tax_client_id',
                'jofotara_income_tax_secret_key', 'jofotara_income_tax_income_source_sequence',
                'jofotara_income_tax_seller_tax_number', 'jofotara_income_tax_seller_registered_name',
                'jofotara_sales_tax_client_id', 'jofotara_sales_tax_secret_key'
            )`);
        const preview = await request(app).get(`/api/admin/jofotara/invoices/${invoiceId}/xml`).set('Cookie', adminCookie);
        expect(preview.text).toContain('<cbc:InvoiceTypeCode name="011">388</cbc:InvoiceTypeCode>');
        expect(preview.text).not.toContain('<cac:TaxTotal>');

        const headers = [];
        const rejectedFetch = async (_url, options) => {
            headers.push(options.headers);
            return { ok: false, status: 400, text: async () => JSON.stringify({ EINV_STATUS: 'REJECTED' }) };
        };
        await submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl: rejectedFetch, surface: 'order' });
        await pool.query("UPDATE settings SET setting_value='changed-income-secret' WHERE setting_key='jofotara_income_tax_secret_key'");
        await submitSalesInvoice({ invoiceId, actorUserId: SEED.adminUser.id, fetchImpl: rejectedFetch, surface: 'order' });
        expect(headers.map(value => value['Client-Id'])).toEqual(['income-client', 'income-client']);
        expect(headers.map(value => value['Secret-Key'])).toEqual(['income-secret', 'changed-income-secret']);
        const [[stored]] = await pool.query("SELECT tax_registration_type, legal_snapshot_json, request_xml, attempt_count FROM jofotara_documents WHERE source_key=?", [`invoice:${invoiceId}`]);
        expect(stored.tax_registration_type).toBe('income_tax');
        expect(JSON.parse(stored.legal_snapshot_json).taxRegistrationType).toBe('income_tax');
        expect(stored.request_xml).toContain('<cbc:InvoiceTypeCode name="011">388</cbc:InvoiceTypeCode>');
        expect(Number(stored.attempt_count)).toBe(2);
    });

    it('lists unresolved work without exposing legal payloads or credentials and ages stale submissions to unknown', async () => {
        const missingInvoiceId = await insertSale();
        const staleInvoiceId = await insertSale();
        await pool.query(
            `INSERT INTO jofotara_documents
             (source_key, order_invoice_id, document_kind, document_number, document_uuid, status,
              request_xml, legal_snapshot_json, response_body, last_attempt_at, attempt_count)
             VALUES (?, ?, 'invoice', 'stale', UUID(), 'submitting', '<secret-xml/>', '{"private":true}',
                     'private-response', DATE_SUB(NOW(), INTERVAL 3 MINUTE), 1)`,
            [`invoice:${staleInvoiceId}`, staleInvoiceId]
        );

        const operations = await getJofotaraOperations({ limit: 50 });
        expect(operations.summary.total).toBe(2);
        expect(operations.summary.unknown).toBe(1);
        expect(operations.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ source_type: 'invoice', source_id: missingInvoiceId, status: 'not_submitted', can_submit: true }),
            expect.objectContaining({ source_type: 'invoice', source_id: staleInvoiceId, status: 'unknown', can_submit: false })
        ]));
        expect(JSON.stringify(operations)).not.toMatch(/secret-xml|private-response|legal_snapshot|request_xml|secret_key/i);
    });

    it('serves an authorized count matching invoice, refund and document work without changing submission status', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='jofotara_enabled'");
        const settingsResponse = await request(app).get('/api/system/settings').set('Cookie', adminCookie).expect(200);
        expect(settingsResponse.body.jofotara_enabled).toBe('1');
        const missingInvoiceId = await insertSale();
        const acceptedInvoiceId = await insertSale();
        const pendingInvoiceId = await insertSale();
        await pool.query(`INSERT INTO jofotara_documents
            (source_key, order_invoice_id, document_kind, document_number, document_uuid, status)
            VALUES (?, ?, 'invoice', 'accepted', UUID(), 'accepted'),
                   (?, ?, 'invoice', 'pending', UUID(), 'pending')`,
        [`invoice:${acceptedInvoiceId}`, acceptedInvoiceId, `invoice:${pendingInvoiceId}`, pendingInvoiceId]);
        await pool.query("INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, reason, user_id) VALUES ('refund', ?, 'item', 2, 0, 2, 'Return', ?)", [acceptedInvoiceId, SEED.adminUser.id]);
        await pool.query("INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, reason, user_id) VALUES ('refund', ?, 'item', 1, 0, 1, 'Waiting for original', ?)", [missingInvoiceId, SEED.adminUser.id]);

        const querySpy = vi.spyOn(pool, 'query');
        const count = await getJofotaraOperationCount();
        const statements = querySpy.mock.calls.map(([sql]) => String(sql).trim());
        querySpy.mockRestore();
        expect(count).toEqual({ total: 4 });
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/^SELECT\b/i);

        const response = await request(app).get('/api/admin/jofotara/operations/count').set('Cookie', adminCookie).expect(200);
        expect(response.body).toMatchObject({ success: true, total: 4 });
        expect(response.body).not.toHaveProperty('items');
        const operations = await getJofotaraOperations({ limit: 100 });
        expect(operations.summary.total).toBe(4);
        expect(operations.items).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: missingInvoiceId })]));
        expect(operations.items).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'waiting_for_original' })]));
        await request(app).get('/api/admin/jofotara/operations/count').expect(401);
        const cashierLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        await request(app).get('/api/admin/jofotara/operations/count').set('Cookie', cashierLogin.headers['set-cookie'][0]).expect(403);
    });

    it('leaves stale-submission reconciliation with the full Operations workflow', async () => {
        const invoiceId = await insertSale();
        await pool.query(`INSERT INTO jofotara_documents
            (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, last_attempt_at)
            VALUES (?, ?, 'invoice', 'stale', UUID(), 'submitting', DATE_SUB(NOW(), INTERVAL 3 MINUTE))`,
        [`invoice:${invoiceId}`, invoiceId]);
        expect(await getJofotaraOperationCount()).toEqual({ total: 1 });
        const [[before]] = await pool.query('SELECT status FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
        expect(before.status).toBe('submitting');
        const operations = await request(app).get('/api/admin/jofotara/operations').set('Cookie', adminCookie).expect(200);
        expect(operations.body.summary).toMatchObject({ total: 1, unknown: 1 });
        const [[after]] = await pool.query('SELECT status FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
        expect(after.status).toBe('unknown');
    });

    it('lists truthful platform Operations candidates with validated filters', async () => {
        const platformId = await insertSale();
        const restoredId = await insertSale();
        await pool.query("INSERT INTO order_types (id, name, requires_hash, is_active) VALUES (3, 'Talabat', 0, 1)");
        await pool.query("UPDATE orders SET payment_method='platform', order_type_id=3, invoice_issued_at='2026-07-23 10:00:00' WHERE invoice_id=?", [platformId]);
        await pool.query("UPDATE orders SET payment_method='cash', order_type_id=3, invoice_issued_at='2026-07-24 10:00:00' WHERE invoice_id=?", [restoredId]);

        const operations = await getJofotaraOperations({ sourceKind: 'platform', orderTypeId: 3, issuedFrom: '2026-07-23', issuedTo: '2026-07-23' });
        expect(operations.items).toEqual([expect.objectContaining({
            source_type: 'invoice', source_id: platformId, source_kind: 'platform', order_type_id: 3,
            order_type_name: 'Talabat', gross_total: 5.55, invoice_issued_at: expect.anything(), can_submit: true
        })]);
        const routeFiltered = await request(app)
            .get('/api/admin/jofotara/operations?source_kind=platform&order_type_id=3&status=not_submitted&issued_from=2026-07-23&issued_to=2026-07-23')
            .set('Cookie', adminCookie)
            .expect(200);
        expect(routeFiltered.body.items).toEqual([
            expect.objectContaining({ source_id: platformId, source_kind: 'platform', status: 'not_submitted' })
        ]);
        const all = await getJofotaraOperations({ limit: 20 });
        expect(all.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ source_id: platformId, source_kind: 'platform' }),
            expect.objectContaining({ source_id: restoredId, source_kind: 'standard', order_type_id: 3 })
        ]));
        const [platformRefund] = await pool.query("INSERT INTO refunds (kind, invoice_id, scope, subtotal_refunded, tax_refunded, amount_refunded, reason, user_id) VALUES ('refund', ?, 'item', 2, 0, 2, 'Platform return', ?)", [platformId, SEED.adminUser.id]);
        const waiting = await getJofotaraOperations({ limit: 20 });
        expect(waiting.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ source_id: platformRefund.insertId, source_kind: 'platform', status: 'waiting_for_original', gross_total: 2, can_submit: false })
        ]));
        await pool.query(`INSERT INTO jofotara_documents
            (source_key, order_invoice_id, document_kind, tax_registration_type, document_number, document_uuid, status)
            VALUES (?, ?, 'invoice', 'sales_tax', ?, UUID(), 'accepted')`, [`invoice:${platformId}`, platformId, String(platformId)]);
        const ready = await getJofotaraOperations({ limit: 20 });
        expect(ready.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ source_id: platformRefund.insertId, source_kind: 'platform', status: 'not_submitted', gross_total: 2, can_submit: true })
        ]));
        await request(app).get('/api/admin/jofotara/operations?source_kind=subscription').set('Cookie', adminCookie).expect(400);
        await request(app).get('/api/admin/jofotara/operations?source_kind=forged').set('Cookie', adminCookie).expect(400);
        await request(app).get('/api/admin/jofotara/operations?status=accepted').set('Cookie', adminCookie).expect(400);
        await request(app).get('/api/admin/jofotara/operations?order_type_id=0').set('Cookie', adminCookie).expect(400);
        await request(app).get('/api/admin/jofotara/operations?invoice_id=0').set('Cookie', adminCookie).expect(400);
        await request(app).get('/api/admin/jofotara/operations?issued_from=2026-02-30').set('Cookie', adminCookie).expect(400);
        await request(app).get('/api/admin/jofotara/operations?issued_from=2026-08-02&issued_to=2026-08-01').set('Cookie', adminCookie).expect(400);
    });
    it('sets the automation cutoff on enablement and never trusts a browser-supplied cutoff', async () => {
        await request(app).put('/api/admin/jofotara/settings').set('Cookie', adminCookie).send({
            enabled: true,
            auto_submit: true,
            auto_submit_since: '2000-01-01 00:00:00',
            profiles: {
                sales_tax: {
                    client_id: 'client', secret_key: 'secret', income_source_sequence: '123',
                    seller_tax_number: '987654321', seller_registered_name: 'Test Seller'
                }
            }
        }).expect(200);
        const response = await request(app).get('/api/admin/jofotara/settings').set('Cookie', adminCookie).expect(200);
        expect(response.body.settings.auto_submit).toBe(true);
        expect(response.body.settings.auto_submit_since).not.toBe('2000-01-01 00:00:00');
        const [[stored]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='jofotara_auto_submit_since'");
        expect(new Date(stored.setting_value).getFullYear()).toBeGreaterThan(2025);
    });

    it('recovers only aged fiscal work and leaves rejected and unknown documents untouched', async () => {
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 10 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const finalizedInvoiceId = await insertSale();
        await pool.query(`UPDATE orders
                             SET created_at=DATE_SUB(NOW(), INTERVAL 1 DAY),
                                 invoice_issued_at=DATE_SUB(NOW(), INTERVAL 3 MINUTE)
                           WHERE invoice_id=?`, [finalizedInvoiceId]);
        const rejectedInvoiceId = await insertSale();
        const unknownInvoiceId = await insertSale();
        for (const [invoiceId, status] of [[rejectedInvoiceId, 'rejected'], [unknownInvoiceId, 'unknown']]) {
            await pool.query(
                `INSERT INTO jofotara_documents
                 (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, attempt_count, last_attempt_at)
                 VALUES (?, ?, 'invoice', ?, UUID(), ?, 1, NOW())`,
                [`invoice:${invoiceId}`, invoiceId, String(invoiceId), status]
            );
        }
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr' }) };
        };

        const result = await processJofotaraOperations({ fetchImpl });
        expect(result).toMatchObject({ attempted: 1, accepted: 1 });
        expect(calls).toBe(1);
        const [rows] = await pool.query('SELECT order_invoice_id, status, attempt_count FROM jofotara_documents ORDER BY order_invoice_id');
        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ order_invoice_id: finalizedInvoiceId, status: 'accepted', attempt_count: 1 }),
            expect.objectContaining({ order_invoice_id: rejectedInvoiceId, status: 'rejected', attempt_count: 1 }),
            expect.objectContaining({ order_invoice_id: unknownInvoiceId, status: 'unknown', attempt_count: 1 })
        ]));
    });

    it('waits two minutes before retrying pending documents and never selects an unavailable status', async () => {
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 10 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const oldPendingId = await insertSale();
        const freshPendingId = await insertSale();
        await pool.query(`UPDATE orders SET invoice_issued_at=DATE_SUB(NOW(), INTERVAL 3 MINUTE) WHERE invoice_id IN (?, ?)`, [oldPendingId, freshPendingId]);
        await pool.query(`INSERT INTO jofotara_documents
            (source_key, order_invoice_id, document_kind, tax_registration_type, document_number, document_uuid,
             status, request_xml, legal_snapshot_json, created_at)
            SELECT CONCAT('invoice:', invoice_id), invoice_id, 'invoice', 'sales_tax', CAST(invoice_number AS CHAR), UUID(),
                   'pending', '<Invoice/>', '{}', CASE WHEN invoice_id=? THEN DATE_SUB(NOW(), INTERVAL 3 MINUTE) ELSE NOW() END
              FROM orders WHERE invoice_id IN (?, ?)`, [oldPendingId, oldPendingId, freshPendingId]);
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr-pending' }) };
        };

        const result = await processJofotaraOperations({ fetchImpl });

        expect(result).toMatchObject({ attempted: 1, accepted: 1 });
        expect(calls).toBe(1);
        const [[oldRow]] = await pool.query('SELECT status, attempt_count FROM jofotara_documents WHERE order_invoice_id=?', [oldPendingId]);
        const [[freshRow]] = await pool.query('SELECT status, attempt_count FROM jofotara_documents WHERE order_invoice_id=?', [freshPendingId]);
        expect(oldRow).toMatchObject({ status: 'accepted', attempt_count: 1 });
        expect(freshRow).toMatchObject({ status: 'pending', attempt_count: 0 });
    });

    it('uses invoice issuance time for recovery and excludes unpaid and platform orders', async () => {
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 10 MINUTE), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const eligibleId = await insertSale();
        const unpaidId = await insertSale();
        const platformId = await insertSale();
        await pool.query("INSERT INTO order_types (id, name, requires_hash, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 0, 1, 1)");
        await pool.query(`UPDATE orders SET created_at=DATE_SUB(NOW(), INTERVAL 1 DAY), invoice_issued_at=DATE_SUB(NOW(), INTERVAL 3 MINUTE) WHERE invoice_id IN (?, ?, ?)`, [eligibleId, unpaidId, platformId]);
        await pool.query('UPDATE orders SET order_type_id=3 WHERE invoice_id=?', [eligibleId]);
        await pool.query("UPDATE orders SET payment_method='unpaid_table' WHERE invoice_id=?", [unpaidId]);
        await pool.query("UPDATE orders SET payment_method='platform' WHERE invoice_id=?", [platformId]);
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return { ok: true, status: 200, text: async () => JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'qr-eligible' }) };
        };

        const result = await processJofotaraOperations({ fetchImpl });

        expect(result).toMatchObject({ attempted: 1, accepted: 1 });
        expect(calls).toBe(1);
        const [rows] = await pool.query('SELECT order_invoice_id, status FROM jofotara_documents');
        expect(rows).toEqual([expect.objectContaining({ order_invoice_id: eligibleId, status: 'accepted' })]);
        const [[eligible]] = await pool.query('SELECT order_type_id, payment_method FROM orders WHERE invoice_id=?', [eligibleId]);
        expect(eligible).toEqual({ order_type_id: 3, payment_method: 'cash' });
    });

    it('never lets automatic recovery acquire platform invoices in any document state', async () => {
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_auto_submit' THEN '1'
            WHEN 'jofotara_auto_submit_since' THEN DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 DAY), '%Y-%m-%d %H:%i:%s')
            WHEN 'jofotara_sales_tax_client_id' THEN 'client' WHEN 'jofotara_sales_tax_secret_key' THEN 'secret'
            WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321'
            WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const states = [null, 'pending', 'rejected', 'unknown', 'accepted'];
        const platformIds = [];
        for (const _state of states) platformIds.push(await insertSale());
        await pool.query('UPDATE orders SET invoice_issued_at=DATE_SUB(NOW(), INTERVAL 5 MINUTE), payment_method=\'platform\' WHERE invoice_id IN (?)', [platformIds]);
        for (let index = 1; index < states.length; index += 1) await pool.query(`INSERT INTO jofotara_documents
            (source_key, order_invoice_id, document_kind, tax_registration_type, document_number, document_uuid, status, attempt_count, created_at)
            VALUES (?, ?, 'invoice', 'sales_tax', ?, UUID(), ?, 7, DATE_SUB(NOW(), INTERVAL 5 MINUTE))`,
        [`invoice:${platformIds[index]}`, platformIds[index], `platform-${index}`, states[index]]);
        let calls = 0;
        const result = await processJofotaraOperations({ fetchImpl: async () => { calls += 1; throw new Error('platform work must not be sent'); } });
        expect(result.attempted).toBe(0);
        expect(calls).toBe(0);
        const [documents] = await pool.query('SELECT order_invoice_id, status, attempt_count FROM jofotara_documents ORDER BY order_invoice_id');
        expect(documents).toHaveLength(4);
        expect(documents.every(row => Number(row.attempt_count) === 7 && states.includes(row.status))).toBe(true);
        for (const invoiceId of platformIds) {
            await expect(prepareCheckoutInvoiceIfAutomatic({ invoiceId, actorUserId: SEED.adminUser.id }))
                .resolves.toMatchObject({ required: false, status: 'not_required' });
        }
        await expect(submitSalesInvoice({ invoiceId: platformIds[1], actorUserId: SEED.adminUser.id, surface: 'automatic' }))
            .rejects.toMatchObject({ publicCode: 'JOFOTARA_OPERATIONS_REQUIRED' });
    });
    it('serves the credential-free operations read model to administrators', async () => {
        await insertSale();
        const response = await request(app).get('/api/admin/jofotara/operations?limit=9999').set('Cookie', adminCookie).expect(200);
        expect(response.body.summary.total).toBe(1);
        expect(response.body.items).toHaveLength(1);
        expect(JSON.stringify(response.body)).not.toMatch(/client_id|secret|request_xml|response_body/i);
    });

    it('serves the complete stored JoFotara response only through a document detail endpoint', async () => {
        const invoiceId = await insertSale();
        await pool.query(`UPDATE settings SET setting_value = CASE setting_key
            WHEN 'jofotara_enabled' THEN '1' WHEN 'jofotara_sales_tax_client_id' THEN 'client'
            WHEN 'jofotara_sales_tax_secret_key' THEN 'secret' WHEN 'jofotara_sales_tax_income_source_sequence' THEN '123'
            WHEN 'jofotara_sales_tax_seller_tax_number' THEN '987654321' WHEN 'jofotara_sales_tax_seller_registered_name' THEN 'Test Seller'
            ELSE setting_value END WHERE setting_key LIKE 'jofotara_%'`);
        const rawResponse = { EINV_STATUS: 'NOT_SUBMITTED', trace: { code: 'X-500', details: ['one', 'two'] } };
        await submitSalesInvoice({
            invoiceId,
            actorUserId: SEED.adminUser.id,
            surface: 'order',
            fetchImpl: async () => ({ ok: false, status: 500, text: async () => JSON.stringify(rawResponse) })
        });

        const operations = await request(app).get('/api/admin/jofotara/operations').set('Cookie', adminCookie).expect(200);
        const item = operations.body.items.find(row => row.order_invoice_id === invoiceId);
        expect(item.document_id).toEqual(expect.any(Number));
        expect(JSON.stringify(item)).not.toContain('X-500');

        const detail = await request(app)
            .get(`/api/admin/jofotara/operations/documents/${item.document_id}/response`)
            .set('Cookie', adminCookie)
            .expect(200);
        expect(detail.body).toMatchObject({ status: 'rejected', http_status: 500, response: rawResponse });
        await request(app).get(`/api/admin/jofotara/operations/documents/${item.document_id}/response`).expect(401);
    });
});
