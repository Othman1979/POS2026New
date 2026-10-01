const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');
const PlatformRemittanceService = require('../../services/PlatformRemittanceService');

describe('platform reconciliation admin routes', () => {
    let adminCookie;
    let cashierCookie;
    let invoiceSequence;

    beforeEach(async () => {
        await seedDatabase();
        adminCookie = await loginSeedUser(request, app, 'adminUser');
        cashierCookie = await loginSeedUser(request, app, 'cashierUser');
        invoiceSequence = 61000;
    });

    afterAll(async () => {
        await pool.end();
    });

    async function createPlatformOrder(total = 10, orderTypeId = SEED.orderType.id) {
        const invoiceNumber = invoiceSequence++;
        const [result] = await pool.query(`
            INSERT INTO orders
                (invoice_number,user_id,order_type_id,subtotal,tax,total,payment_method,
                 invoice_issued_at,created_at,cash_amount,card_amount,amount_tendered,change_due)
            VALUES (?,?,?, ?,0,?,'platform','2026-08-01 10:00:00','2026-08-01 10:00:00',0,0,0,0)
        `, [invoiceNumber, SEED.adminUser.id, orderTypeId, total, total]);
        await pool.query(
            `INSERT INTO order_items (invoice_id,product_id,item_name,quantity,price_at_sale,tax_rate,tax_amount)
             VALUES (?,?,?,1,?,0,0)`,
            [result.insertId, SEED.product1.id, 'Platform Route Item', total]
        );
        return Number(result.insertId);
    }

    async function receivable(invoiceId, orderTypeId = SEED.orderType.id) {
        const result = await PlatformRemittanceService.listReceivables(pool, orderTypeId);
        const row = result.find(entry => entry.invoice_id === invoiceId);
        if (!row) throw new Error(`Missing receivable ${invoiceId}`);
        return row;
    }

    it('requires an administrator and exposes providers, receivables, list, and detail routes', async () => {
        const invoiceId = await createPlatformOrder(10);
        const providers = await request(app)
            .get('/api/admin/platform-remittances/providers')
            .set('Cookie', adminCookie);
        expect(providers.status).toBe(200);
        expect(providers.body.success).toBe(true);
        expect(providers.body.providers).toEqual(expect.arrayContaining([
            expect.objectContaining({ order_type_id: SEED.orderType.id, provider_name: SEED.orderType.name })
        ]));

        const receivables = await request(app)
            .get(`/api/admin/platform-remittances/receivables?order_type_id=${SEED.orderType.id}`)
            .set('Cookie', adminCookie);
        expect(receivables.status).toBe(200);
        expect(receivables.body.receivables).toEqual(expect.arrayContaining([
            expect.objectContaining({ invoice_id: invoiceId, open_amount: 10 })
        ]));

        const list = await request(app)
            .get('/api/admin/platform-remittances')
            .set('Cookie', adminCookie);
        expect(list.status).toBe(200);
        expect(list.body.remittances).toEqual([]);

        const unauthenticated = await request(app).get('/api/admin/platform-remittances/providers');
        expect(unauthenticated.status).toBe(401);
        const cashier = await request(app)
            .get('/api/admin/platform-remittances/providers')
            .set('Cookie', cashierCookie);
        expect(cashier.status).toBe(403);
    });

    it('records a partial allocation, returns it from list/detail, and returns the exact retry', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        const payload = {
            order_type_id: SEED.orderType.id,
            invoice_allocations: [{ invoice_id: invoiceId, balance_token: open.balance_token, allocation_amount: '5.00' }],
            adjustments: [{ direction: 'deduction', category: 'commission', amount: '1.00' }],
            net_received: '4.00',
            settled_on: '2026-08-02',
            reference: 'ROUTE-1',
            idempotency_key: 'route-remittance-1'
        };
        const recorded = await request(app)
            .post('/api/admin/platform-remittances')
            .set('Cookie', adminCookie)
            .send(payload);
        expect(recorded.status).toBe(200);
        expect(recorded.body.remittance).toMatchObject({
            invoice_allocations: 5,
            deductions: 1,
            net_received: 4,
            unreconciled_difference: 0
        });

        const retry = await request(app)
            .post('/api/admin/platform-remittances')
            .set('Cookie', adminCookie)
            .send(payload);
        expect(retry.status).toBe(200);
        expect(retry.body.remittance.id).toBe(recorded.body.remittance.id);

        const detail = await request(app)
            .get(`/api/admin/platform-remittances/${recorded.body.remittance.id}`)
            .set('Cookie', adminCookie);
        expect(detail.status).toBe(200);
        expect(detail.body.remittance.id).toBe(recorded.body.remittance.id);

        const incompatible = await request(app)
            .post('/api/admin/platform-remittances')
            .set('Cookie', adminCookie)
            .send({ ...payload, net_received: '5.00' });
        expect(incompatible.status).toBe(409);
        expect(incompatible.body.code).toBe('PLATFORM_REMITTANCE_IDEMPOTENCY_CONFLICT');
    });

    it('translates strict input failures and stale balances to public API errors', async () => {
        const invoiceId = await createPlatformOrder(10);
        const open = await receivable(invoiceId);
        const common = {
            order_type_id: SEED.orderType.id,
            invoice_allocations: [{ invoice_id: invoiceId, balance_token: open.balance_token, allocation_amount: '10.00' }],
            adjustments: [],
            net_received: '10.00',
            settled_on: '2026-08-02',
            idempotency_key: 'route-invalid-1'
        };
        const unknown = await request(app)
            .post('/api/admin/platform-remittances')
            .set('Cookie', adminCookie)
            .send({ ...common, unexpected: true });
        expect(unknown.status).toBe(400);
        expect(unknown.body.code).toBe('PLATFORM_REMITTANCE_UNKNOWN_FIELD');

        const tooManyAdjustments = await request(app)
            .post('/api/admin/platform-remittances')
            .set('Cookie', adminCookie)
            .send({
                ...common,
                idempotency_key: 'route-invalid-2',
                adjustments: Array.from({ length: 51 }, () => ({ direction: 'deduction', category: 'commission', amount: '1.00' }))
            });
        expect(tooManyAdjustments.status).toBe(400);
        expect(tooManyAdjustments.body.code).toBe('PLATFORM_REMITTANCE_INVALID_ADJUSTMENTS');

        const [staleHeader] = await pool.query(
            `INSERT INTO platform_remittances
                (order_type_id, provider_name_at_entry, settled_on, net_received, recorded_by, idempotency_key)
             VALUES (?, 'Dine In', '2026-08-01', 5, ?, 'route-stale-source')`,
            [SEED.orderType.id, SEED.adminUser.id]
        );
        await pool.query(
            'INSERT INTO platform_remittance_lines (remittance_id, invoice_id, allocated_amount) VALUES (?,?,5)',
            [staleHeader.insertId, invoiceId]
        );
        const stale = await request(app)
            .post('/api/admin/platform-remittances')
            .set('Cookie', adminCookie)
            .send({ ...common, idempotency_key: 'route-stale-1' });
        expect(stale.status).toBe(409);
        expect(stale.body.code).toBe('PLATFORM_REMITTANCE_STALE_BALANCE');
    });

    it('blocks deleting a type with platform history but preserves ordinary deletion', async () => {
        await pool.query("INSERT INTO order_types (id, name, requires_hash, is_active) VALUES (3, 'Talabat', 0, 1)");
        await createPlatformOrder(10, 3);
        const blocked = await request(app)
            .delete('/api/admin/order_types')
            .set('Cookie', adminCookie)
            .send({ id: 3 });
        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('ORDER_TYPE_HAS_HISTORY');

        await pool.query("INSERT INTO order_types (id, name, requires_hash, is_active) VALUES (4, 'Careem', 0, 0)");
        await pool.query(
            `INSERT INTO platform_remittances
                (order_type_id, provider_name_at_entry, settled_on, net_received, recorded_by, idempotency_key)
             VALUES (4, 'Careem', '2026-08-01', 0, ?, 'route-delete-remittance-history')`,
            [SEED.adminUser.id]
        );
        const remittanceBlocked = await request(app)
            .delete('/api/admin/order_types')
            .set('Cookie', adminCookie)
            .send({ id: 4 });
        expect(remittanceBlocked.status).toBe(409);
        expect(remittanceBlocked.body.code).toBe('ORDER_TYPE_HAS_HISTORY');

        const ordinary = await request(app)
            .delete('/api/admin/order_types')
            .set('Cookie', adminCookie)
            .send({ id: 2 });
        expect(ordinary.status).toBe(200);
        const [[remaining]] = await pool.query('SELECT id FROM order_types WHERE id = 2');
        expect(remaining).toBeUndefined();
    });
});
