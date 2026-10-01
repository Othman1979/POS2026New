import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
const request = require('supertest');
const QRCode = require('qrcode');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { withBundleIntegrityChecksDisabled } = require('../helpers/bundleIntegrityFixtures');
const templateEngine = require('../../services/printTemplateEngine');

describe('Print Authorization (C2)', () => {
    let cashierACookie; // Cashier A (owns order A)
    let cashierBCookie; // Cashier B (no reprint permission)
    let adminCookie;    // Admin (has reprint permission automatically)
    let userAId;
    let userBId;
    let shiftId;

    beforeAll(async () => {
        await seedDatabase();

        // Login users
        const loginA = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cashierACookie = loginA.headers['set-cookie'][0];
        userAId = SEED.cashierUser.id;

        const loginB = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        cashierBCookie = loginB.headers['set-cookie'][0];
        userBId = SEED.waiterUser.id;

        const loginAdmin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        adminCookie = loginAdmin.headers['set-cookie'][0];

        // Ensure we have a printer
        await pool.query(`
            INSERT INTO printers (name, role, type, windows_name, is_active)
            VALUES ('Receipt Printer', 'receipt', 'windows', 'Receipt-Printer', 1)
            ON DUPLICATE KEY UPDATE is_active = 1
        `);

        // Create a shift
        const [shiftRes] = await pool.query(`
            INSERT INTO shifts (user_id, starting_cash, status, opened_at)
            VALUES (?, 50.00, 'open', '2026-06-30 09:00:00')
        `, [userAId]);
        shiftId = shiftRes.insertId;
    });

    afterAll(async () => {
        await pool.end();
    });

    afterEach(() => vi.restoreAllMocks());

    const setDuplicateReceipt = (value) => pool.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ('duplicate_customer_receipt', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
        [value]
    );

    it('blocks printing another cashier\'s receipt when requester has no reprint permission', async () => {
        // Create an order owned by Cashier A (userAId)
        const [orderRes] = await pool.query(`
            INSERT INTO orders (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method, cash_amount, card_amount)
            VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 0)
        `, [userAId, shiftId]);
        const invoiceId = orderRes.insertId;

        // Try to print it as Cashier B (no reprint permission)
        const resB = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierBCookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId });
        expect(resB.statusCode).toBe(403);
        expect(resB.body.success).toBe(false);

        // Cashier A (owner) prints the checkout receipt
        const resA = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId, print_request_id: `checkout-receipt:${invoiceId}:primary` });
        expect(resA.statusCode).toBe(200);

        // Try to print it as Admin (admin bypasses)
        const resAdmin = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId });
        expect(resAdmin.statusCode).toBe(200);
    });

    it('lets the order owner print the checkout receipt once but requires pos.reprint_receipt to reprint it', async () => {
        const [orderRes] = await pool.query(`
            INSERT INTO orders (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method, cash_amount, card_amount)
            VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 0)
        `, [userAId, shiftId]);
        const invoiceId = orderRes.insertId;
        const print = (cookie, extra = {}) => request(app).post('/api/print/print').set('Cookie', cookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId, ...extra });
        const jobCount = async () => Number((await pool.query(
            "SELECT COUNT(*) AS count FROM print_queue WHERE print_type = 'receipt' AND JSON_EXTRACT(payload, '$.data.invoice_id') = ?",
            [invoiceId]
        ))[0][0].count);

        const primary = { print_request_id: `checkout-receipt:${invoiceId}:primary` };
        expect((await print(cashierACookie, primary)).statusCode).toBe(200);
        await setDuplicateReceipt('1');
        expect((await print(cashierACookie, { print_request_id: `checkout-receipt:${invoiceId}:duplicate` })).statusCode).toBe(200);
        await setDuplicateReceipt('0');
        expect(await jobCount()).toBe(2);
        // Replaying the checkout id returns the existing job instead of a second paper.
        expect((await print(cashierACookie, primary)).statusCode).toBe(200);
        expect(await jobCount()).toBe(2);

        const reprint = await print(cashierACookie);
        expect(reprint.statusCode).toBe(403);
        expect(reprint.body.success).toBe(false);
        expect(await jobCount()).toBe(2);

        expect((await print(adminCookie)).statusCode).toBe(200);
        // The order's waiter reprints once granted the permission.
        await pool.query('UPDATE orders SET waiter_id = ? WHERE invoice_id = ?', [userBId, invoiceId]);
        expect((await print(cashierBCookie)).statusCode).toBe(403);
        await pool.query('INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, ?)', [userBId, 'pos.reprint_receipt']);
        try {
            const relogin = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
            cashierBCookie = relogin.headers['set-cookie'][0];
            expect((await print(cashierBCookie)).statusCode).toBe(200);
        } finally {
            await pool.query('DELETE FROM user_permissions WHERE user_id = ? AND perm_key = ?', [userBId, 'pos.reprint_receipt']);
            cashierBCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number })).headers['set-cookie'][0];
        }
        expect(await jobCount()).toBe(4);
    });

    it('gives the owner no extra paper through the checkout id on another printer, a switched-off duplicate or a past sale', async () => {
        const sale = async (createdAt) => (await pool.query(`
            INSERT INTO orders (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method, cash_amount, card_amount, created_at)
            VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 0, ?)
        `, [userAId, shiftId, createdAt]))[0].insertId;
        const print = (invoiceId, extra) => request(app).post('/api/print/print').set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId, ...extra });
        const jobsFor = async (invoiceId) => Number((await pool.query(
            "SELECT COUNT(*) AS count FROM print_queue WHERE print_type = 'receipt' AND JSON_EXTRACT(payload, '$.data.invoice_id') = ?",
            [invoiceId]
        ))[0][0].count);

        const today = await sale(new Date());
        const [[first]] = await pool.query("SELECT id FROM printers WHERE role = 'receipt' AND is_active = 1 ORDER BY id LIMIT 1");
        const [second] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, is_active) VALUES ('Second Receipt', 'receipt', 'windows', 'Second-Receipt', 1)"
        );
        try {
            const primary = { print_request_id: `checkout-receipt:${today}:primary` };
            expect((await print(today, { ...primary, receipt_printer_id: first.id })).statusCode).toBe(200);
            expect((await print(today, { ...primary, receipt_printer_id: second.insertId })).statusCode).toBe(200);
            expect(await jobsFor(today)).toBe(1);
        } finally {
            await pool.query('UPDATE printers SET is_active = 0 WHERE id = ?', [second.insertId]);
        }

        await setDuplicateReceipt('0');
        expect((await print(today, { print_request_id: `checkout-receipt:${today}:duplicate` })).statusCode).toBe(403);

        const lastWeek = await sale(new Date(Date.now() - 7 * 24 * 3600 * 1000));
        expect((await print(lastWeek, { print_request_id: `checkout-receipt:${lastWeek}:primary` })).statusCode).toBe(403);
        expect(await jobsFor(lastWeek)).toBe(0);

        // A sale made just before the business-day cutoff still prints its checkout copy after it.
        const { getBusinessDayRange } = require('../../utils/businessDate');
        const dayStart = new Date(`${getBusinessDayRange().start.replace(' ', 'T')}Z`);
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date(dayStart.getTime() + 2 * 60 * 1000));
            const beforeCutoff = await sale(new Date(dayStart.getTime() - 3 * 60 * 1000));
            expect((await print(beforeCutoff, { print_request_id: `checkout-receipt:${beforeCutoff}:primary` })).statusCode).toBe(200);
            expect(await jobsFor(beforeCutoff)).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects malformed explicit print request ids before queueing', async () => {
        const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        const response = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', invoice_id: 1, print_request_id: '../not-a-safe-key' });

        expect(response.statusCode).toBe(400);
        const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(Number(after.count)).toBe(Number(before.count));
    });

    it('blocks printing a held/split check when user is not authorized', async () => {
        // Create a held split order owned by Cashier A
        const cartPayload = {
            items: [{ id: SEED.product1.id, qty: 1, price: 5.0, tax_rate: 16 }],
            is_split: true
        };
        const [heldRes] = await pool.query(
            "INSERT INTO held_orders (user_id, table_id, reference_name, cart_data, subtotal) VALUES (?, ?, 'Table 12 — Seat 2', ?, ?)",
            [userAId, SEED.table.id, JSON.stringify(cartPayload), 5.00]
        );
        const heldId = heldRes.insertId;

        // Create a user with 0 permissions
        const [newUserRes] = await pool.query(
            "INSERT INTO users (name, role, user_number, is_active) VALUES ('Zero Perms', 'waiter', '9999', 1)"
        );
        const newUserId = newUserRes.insertId;

        const loginZero = await request(app).post('/api/auth/login').send({ user_number: '9999' });
        const zeroCookie = loginZero.headers['set-cookie'][0];

        const resZero = await request(app)
            .post('/api/print/print')
            .set('Cookie', zeroCookie)
            .send({ print_type: 'receipt', payment_method: 'held', invoice_id: heldId });
        expect(resZero.statusCode).toBe(403);

        // Owner (A) can print it
        const resA = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', payment_method: 'held', invoice_id: heldId });
        expect(resA.statusCode).toBe(200);
    });

    it('queues saved receipt item tax fields for tax-inclusive line display', async () => {
        const [orderRes] = await pool.query(`
            INSERT INTO orders (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method, cash_amount, card_amount)
            VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 0)
        `, [userAId, shiftId]);
        const invoiceId = orderRes.insertId;

        await pool.query(`
            INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
            VALUES (?, ?, 'Taxed Burger', 2, 5.000000, 16.00, 1.600000)
        `, [invoiceId, SEED.product1.id]);

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload);
        expect(payload.print_type).toBe('receipt');
        expect(Number(payload.data.items[0].price)).toBeCloseTo(5, 2);
        expect(Number(payload.data.items[0].qty)).toBeCloseTo(2, 2);
        expect(Number(payload.data.items[0].tax_rate)).toBeCloseTo(16, 2);
        expect(Number(payload.data.items[0].tax_amount)).toBeCloseTo(1.6, 2);
    });

    it('prints the persisted scheduled date on a paid customer receipt', async () => {
        const [customer] = await pool.query(
            "INSERT INTO customers (name, phone, address) VALUES ('Scheduled Guest', '0795550182', 'Amman')"
        );
        const [orderRes] = await pool.query(`
            INSERT INTO orders
              (user_id, shift_id, order_type_id, customer_id, delivery_date,
               subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount)
            VALUES (?, ?, 1, ?, '2026-08-12 18:30:00',
                    10.00, 1.60, 11.60, 'cash', 11.60, 11.60, 0)
        `, [userAId, shiftId, customer.insertId]);
        await pool.query(`
            INSERT INTO order_items
              (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
            VALUES (?, ?, 'Scheduled Burger', 1, 10.000000, 16.00, 1.600000)
        `, [orderRes.insertId, SEED.product1.id]);

        const response = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'receipt', invoice_id: orderRes.insertId });

        expect(response.statusCode).toBe(200);
        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload).data;
        expect(payload.delivery_date).toBeTruthy();
        expect(payload.compiled_document_v1.html).toContain('Delivery:');
        expect(payload.compiled_document_v1.html).toContain('2026-08-12');
    });

    it('keeps the first queued receipt when the same checkout request is replayed after JoFotara acceptance', async () => {
        const [orderRes] = await pool.query(`
            INSERT INTO orders
              (user_id, shift_id, order_type_id, invoice_number, invoice_issued_at,
               subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount)
            VALUES (?, ?, 1, 9010, NOW(), 10.00, 1.60, 11.60, 'cash', 11.60, 11.60, 0)
        `, [userAId, shiftId]);
        const invoiceId = orderRes.insertId;
        await pool.query(`
            INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
            VALUES (?, ?, 'Replay Burger', 2, 5.00, 16.00, 1.60)
        `, [invoiceId, SEED.product1.id]);
        const printRequestId = `checkout-receipt:${invoiceId}:primary`;

        const [[beforeMismatch]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        const mismatch = await request(app).post('/api/print/print').set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId, print_request_id: 'checkout-receipt:999999:primary' });
        expect(mismatch.statusCode).toBe(400);
        const [[afterMismatch]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
        expect(Number(afterMismatch.count)).toBe(Number(beforeMismatch.count));

        const first = await request(app).post('/api/print/print').set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId, print_request_id: printRequestId });
        expect(first.statusCode).toBe(200);

        await pool.query(`
            INSERT INTO jofotara_documents
              (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, qr_text)
            VALUES (?, ?, 'invoice', '9010', UUID(), 'accepted', 'official-qr-after-first-print')
        `, [`invoice:${invoiceId}`, invoiceId]);
        const replay = await request(app).post('/api/print/print').set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId, print_request_id: printRequestId });
        expect(replay.statusCode).toBe(200);

        const [jobs] = await pool.query(
            'SELECT id, payload FROM print_queue WHERE idempotency_key LIKE ? ORDER BY id',
            [`%${printRequestId}%`]
        );
        expect(jobs).toHaveLength(1);
        expect(JSON.parse(jobs[0].payload).data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
    });

    it('reprints a persisted exempt receipt with its label after the global setting changes', async () => {
        await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
        const [orderRes] = await pool.query(`
            INSERT INTO orders
              (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method,
               cash_amount, card_amount, tax_inclusive_at_sale, tax_exempt_at_sale)
            VALUES (?, ?, 1, 17.00, 0.00, 17.00, 'cash', 17.00, 0.00, 1, 1)
        `, [userAId, shiftId]);
        const invoiceId = orderRes.insertId;
        await pool.query(`
            INSERT INTO order_items
              (invoice_id, product_id, item_name, quantity, price_at_sale, price_before_tax_exemption, tax_rate, tax_amount)
            VALUES (?, ?, 'Exempt Burger', 1, 17.000000, 20.000000, 16.00, 0.000000)
        `, [invoiceId, SEED.product1.id]);

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({ print_type: 'receipt', invoice_id: invoiceId });

        expect(res.statusCode).toBe(200);
        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload).data;
        expect(payload.receipt_display_v1).toMatchObject({
            taxExempt: true,
            summary: { subtotal: 17, taxAmount: 0, total: 17, taxLabel: '(معفي من الضريبة)' }
        });
    });

    it('prints authoritative Cash and Card allocations for a paid split receipt', async () => {
        const [orderRes] = await pool.query(`
            INSERT INTO orders
              (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method,
               amount_tendered, change_due, cash_amount, card_amount)
            VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'split', 15.00, 3.40, 5.00, 6.60)
        `, [userAId, shiftId]);

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', adminCookie)
            .send({
                print_type: 'receipt',
                invoice_id: orderRes.insertId,
                cash_amount: 0.01,
                card_amount: 0.01,
            });

        expect(res.statusCode).toBe(200);
        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload).data;
        expect(payload).toMatchObject({
            payment_method: 'split',
            cash_amount: '5.00',
            card_amount: '6.60',
            amount_tendered: '15.00',
            change_due: '3.40',
        });
    });

    it('split guest-check print includes tax on tax-exclusive bills (P3-8)', async () => {
        // Set setting to tax-exclusive
        await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");

        const cartPayload = {
            items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
            order_discount: null,
            is_split: true
        };
        const [heldRes] = await pool.query(
            "INSERT INTO held_orders (user_id, table_id, reference_name, cart_data, subtotal) VALUES (?, ?, 'Table 1 — Solo', ?, ?)",
            [userAId, SEED.table.id, JSON.stringify(cartPayload), 5.00]
        );
        const heldId = heldRes.insertId;

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', payment_method: 'held', invoice_id: heldId });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload);
        expect(payload.print_type).toBe('receipt');
        expect(Number(payload.data.subtotal)).toBe(5.00);
        expect(Number(payload.data.tax)).toBe(0.80);
        expect(Number(payload.data.total)).toBe(5.80);
    });

    it('split guest-check print excludes tax (rollup is 0) on tax-inclusive bills (P3-8)', async () => {
        // Set setting to tax-inclusive
        await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");

        const cartPayload = {
            items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
            order_discount: null,
            is_split: true
        };
        const [heldRes] = await pool.query(
            "INSERT INTO held_orders (user_id, table_id, reference_name, cart_data, subtotal) VALUES (?, ?, 'Table 1 — Solo2', ?, ?)",
            [userAId, SEED.table.id, JSON.stringify(cartPayload), 5.00]
        );
        const heldId = heldRes.insertId;

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', payment_method: 'held', invoice_id: heldId });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload);
        expect(payload.print_type).toBe('receipt');
        expect(Number(payload.data.subtotal)).toBe(5.00);
        expect(Number(payload.data.tax)).toBe(0.00);
        expect(Number(payload.data.total)).toBe(5.00);
    });

    it('uses a new split check accounting snapshot instead of the current receipt preference', async () => {
        await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
        const cartPayload = {
            items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
            order_discount: null,
            is_split: true,
            tax_inclusive_at_sale: 0,
            receipt_tax_inclusive_at_hold: 1,
        };
        const [heldRes] = await pool.query(
            "INSERT INTO held_orders (user_id, table_id, reference_name, cart_data, subtotal) VALUES (?, ?, 'Table 1 — Frozen', ?, ?)",
            [userAId, SEED.table.id, JSON.stringify(cartPayload), 5.00]
        );

        const res = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierACookie)
            .send({ print_type: 'receipt', payment_method: 'held', invoice_id: heldRes.insertId });

        expect(res.statusCode).toBe(200);
        const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
        const payload = JSON.parse(job.payload).data;
        expect(payload).toMatchObject({ subtotal: 5, tax: 0.8, total: 5.8 });
        expect(payload.receipt_display_v1).toMatchObject({ taxMode: 'inclusive' });
    });

    it('blocks printing kitchen ticket of an order with null waiter_id for unauthorized user (Task 2)', async () => {
        // Create an order with waiter_id = NULL, owned by Cashier A
        const [orderRes] = await pool.query(`
            INSERT INTO orders (user_id, waiter_id, shift_id, order_type_id, subtotal, tax, total, payment_method, cash_amount, card_amount)
            VALUES (?, NULL, ?, 1, 10.00, 1.60, 11.60, 'cash', 11.60, 0)
        `, [userAId, shiftId]);
        const invoiceId = orderRes.insertId;

        // Try to print it as Cashier B (no reprint permission, not owner, null waiter)
        const resB = await request(app)
            .post('/api/print/print')
            .set('Cookie', cashierBCookie)
            .send({ print_type: 'kitchen', invoice_id: invoiceId });
        expect(resB.statusCode).toBe(403);
        expect(resB.body.success).toBe(false);
    });

    describe('Receipt Presentation print.authz.test.js cases', () => {
        it('rebuilds numeric receipt v1 and ignores a forged submitted v1', async () => {
            const [orderRes] = await pool.query(`
                INSERT INTO orders (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale)
                VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'cash', 0)
            `, [userAId, shiftId]);
            const invoiceId = orderRes.insertId;

            await pool.query(`
                INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                VALUES (?, ?, 'Burger', 2, 5.00, 16.00, 1.60)
            `, [invoiceId, SEED.product1.id]);

            const forgedV1 = {
                version: 1,
                currency: 'JD',
                decimals: 2,
                taxMode: 'inclusive',
                status: 'original',
                rows: [],
                summary: {
                    subtotal: 0.01,
                    orderDiscountAmount: 0,
                    orderDiscountLabel: null,
                    taxAmount: 0,
                    taxLabel: null,
                    roundingAdjustment: 0,
                    total: 0.01
                }
            };

            const res = await request(app)
                .post('/api/print/print')
                .set('Cookie', adminCookie)
                .send({
                    print_type: 'receipt',
                    invoice_id: invoiceId,
                    receipt_display_v1: forgedV1
                });
            expect(res.statusCode).toBe(200);

            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            const payload = JSON.parse(job.payload);
            expect(payload.data.receipt_display_v1).toBeDefined();
            expect(payload.data.receipt_display_v1.summary.total).toBe(11.60);
            expect(payload.data.receipt_display_v1.taxMode).toBe('exclusive');
        });

        it('queues the ordinary receipt when an accepted JoFotara receipt has no official QR', async () => {
            const [orderRes] = await pool.query(`
                INSERT INTO orders
                  (user_id, shift_id, order_type_id, invoice_number, invoice_issued_at,
                   subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount)
                VALUES (?, ?, 1, 9001, NOW(), 10.00, 1.60, 11.60, 'cash', 11.60, 11.60, 0)
            `, [userAId, shiftId]);
            const invoiceId = orderRes.insertId;
            await pool.query(`
                INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                VALUES (?, ?, 'JoFotara Burger', 2, 5.00, 16.00, 1.60)
            `, [invoiceId, SEED.product1.id]);
            await pool.query(`
                INSERT INTO jofotara_documents
                  (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, qr_text)
                VALUES (?, ?, 'invoice', '9001', UUID(), 'accepted', '')
            `, [`invoice:${invoiceId}`, invoiceId]);
            const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');

            const res = await request(app)
                .post('/api/print/print')
                .set('Cookie', adminCookie)
                .send({ print_type: 'receipt', invoice_id: invoiceId });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
            expect(Number(after.count)).toBe(Number(before.count) + 1);
            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            expect(JSON.parse(job.payload).data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
            const [[document]] = await pool.query('SELECT status, attempt_count FROM jofotara_documents WHERE source_key=?', [`invoice:${invoiceId}`]);
            expect(document).toMatchObject({ status: 'accepted', attempt_count: 0 });
        });

        it('queues the ordinary receipt when an accepted JoFotara QR exceeds the compiler cap', async () => {
            const [orderRes] = await pool.query(`
                INSERT INTO orders
                  (user_id, shift_id, order_type_id, invoice_number, invoice_issued_at,
                   subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount)
                VALUES (?, ?, 1, 9003, NOW(), 10.00, 1.60, 11.60, 'cash', 11.60, 11.60, 0)
            `, [userAId, shiftId]);
            const invoiceId = orderRes.insertId;
            await pool.query(`INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                VALUES (?, ?, 'Large QR Burger', 2, 5.00, 16.00, 1.60)`, [invoiceId, SEED.product1.id]);
            await pool.query(`INSERT INTO jofotara_documents
                (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, qr_text)
                VALUES (?, ?, 'invoice', '9003', UUID(), 'accepted', ?)`, [`invoice:${invoiceId}`, invoiceId, 'x'.repeat(4097)]);
            const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');

            const res = await request(app).post('/api/print/print').set('Cookie', adminCookie)
                .send({ print_type: 'receipt', invoice_id: invoiceId });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
            expect(Number(after.count)).toBe(Number(before.count) + 1);
            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            expect(JSON.parse(job.payload).data.compiled_document_v1.html).not.toContain('data:image/png;base64,');
        });

        it('queues the ordinary payload when an accepted JoFotara receipt has no trusted model', async () => {
            const [orderRes] = await pool.query(`
                INSERT INTO orders
                  (user_id, shift_id, order_type_id, invoice_number, invoice_issued_at,
                   subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount)
                VALUES (?, ?, 1, 9004, NOW(), 10.00, 1.60, 11.60, 'cash', 11.60, 11.60, 0)
            `, [userAId, shiftId]);
            const invoiceId = orderRes.insertId;
            // This pre-v1 receipt's stored total does not foot to its saved line, so the
            // read model deliberately returns the documented legacy-model absence.
            await pool.query(`INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                VALUES (?, ?, 'Legacy Mismatch Burger', 1, 5.00, 16.00, 0.80)`, [invoiceId, SEED.product1.id]);
            await pool.query(`INSERT INTO jofotara_documents
                (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, qr_text)
                VALUES (?, ?, 'invoice', '9004', UUID(), 'accepted', 'official-qr-9004')`, [`invoice:${invoiceId}`, invoiceId]);
            const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');

            const res = await request(app).post('/api/print/print').set('Cookie', adminCookie)
                .send({ print_type: 'receipt', invoice_id: invoiceId });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
            expect(Number(after.count)).toBe(Number(before.count) + 1);
        });

        it('queues the ordinary receipt when an accepted JoFotara QR cannot compile', async () => {
            const [orderRes] = await pool.query(`
                INSERT INTO orders
                  (user_id, shift_id, order_type_id, invoice_number, invoice_issued_at,
                   subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount)
                VALUES (?, ?, 1, 9005, NOW(), 10.00, 1.60, 11.60, 'cash', 11.60, 11.60, 0)
            `, [userAId, shiftId]);
            const invoiceId = orderRes.insertId;
            await pool.query(`INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                VALUES (?, ?, 'QR Failure Burger', 2, 5.00, 16.00, 1.60)`, [invoiceId, SEED.product1.id]);
            await pool.query(`INSERT INTO jofotara_documents
                (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, qr_text)
                VALUES (?, ?, 'invoice', '9005', UUID(), 'accepted', 'official-qr-9005')`, [`invoice:${invoiceId}`, invoiceId]);
            const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
            vi.spyOn(templateEngine, 'compileTemplate').mockRejectedValue(Object.assign(new Error('QR renderer failed'), {
                code: 'TEMPLATE_QR_RENDER_FAILED'
            }));

            const res = await request(app).post('/api/print/print').set('Cookie', adminCookie)
                .send({ print_type: 'receipt', invoice_id: invoiceId });

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
            expect(Number(after.count)).toBe(Number(before.count) + 1);
        });

        it('adds the official QR to a fresh paid receipt reprint after JoFotara acceptance', async () => {
            const [orderRes] = await pool.query(`
                INSERT INTO orders
                  (user_id, shift_id, order_type_id, invoice_number, invoice_issued_at,
                   subtotal, tax, total, payment_method, amount_tendered, cash_amount, card_amount)
                VALUES (?, ?, 1, 9002, NOW(), 10.00, 1.60, 11.60, 'cash', 11.60, 11.60, 0)
            `, [userAId, shiftId]);
            const invoiceId = orderRes.insertId;
            await pool.query(`
                INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                VALUES (?, ?, 'Accepted Burger', 2, 5.00, 16.00, 1.60)
            `, [invoiceId, SEED.product1.id]);
            await pool.query(`
                INSERT INTO jofotara_documents
                  (source_key, order_invoice_id, document_kind, document_number, document_uuid, status, qr_text)
                VALUES (?, ?, 'invoice', '9002', UUID(), 'accepted', 'official-qr-reprint-9002')
            `, [`invoice:${invoiceId}`, invoiceId]);

            const res = await request(app)
                .post('/api/print/print')
                .set('Cookie', adminCookie)
                .send({ print_type: 'receipt', invoice_id: invoiceId });

            expect(res.statusCode).toBe(200);
            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            const html = JSON.parse(job.payload).data.compiled_document_v1.html;
            const img = html.match(/<img\b[^>]*\balt="JoFotara QR"[^>]*>/)[0];
            const width = img.match(/\bwidth="(\d+)"/)[1];
            const src = img.match(/\bsrc="([^"]+)"/)[1];
            expect(src).toBe(await QRCode.toDataURL('official-qr-reprint-9002', {
                errorCorrectionLevel: 'M', margin: 4, width: Number(width), type: 'image/png'
            }));
        });

        it('rebuilds a guest check from current cart inputs and strips forged v1, QR, and artifact fields', async () => {
            const res = await request(app)
                .post('/api/print/print')
                .set('Cookie', cashierACookie)
                .send({
                    print_type: 'receipt',
                    invoice_id: 'GUEST CHECK',
                    table_number: '12',
                    subtotal: 10.00,
                    tax: 0.00,
                    total: 10.00,
                    items: [{ id: SEED.product1.id, qty: 1, price: 10.00, tax_rate: 0, note: 'No onion' }],
                    receipt_display_v1: { version: 1, rows: [], summary: { total: 999 } },
                    jofotara: { status: 'accepted', qrText: 'forged' },
                    compiled_document_v1: { html: '<script>forged</script>' }
                });
            expect(res.statusCode).toBe(200);

            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            const payload = JSON.parse(job.payload).data;
            expect(payload.receipt_display_v1.summary.total).toBe(10);
            expect(payload.receipt_display_v1.rows).toHaveLength(1);
            // The guest check has its own row mapper, separate from the paid and held
            // ones. It rebuilds rows from client input, so the note has to survive that
            // rebuild or the customer's own bill omits what they asked for.
            expect(payload.receipt_display_v1.rows[0].note).toBe('No onion');
            expect(payload.compiled_document_v1.html).toContain('No onion');
            expect(payload.jofotara).toBeUndefined();
            expect(payload.compiled_document_v1).toMatchObject({ docType: 'receipt', templateRevisionId: 'builtin:receipt-v1' });
        });

        it('prints an open table guest check from its frozen receipt and accounting modes', async () => {
            await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='tax_inclusive_pricing'");
            const [orderRes] = await pool.query(`
                INSERT INTO orders
                  (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method,
                   tax_inclusive_at_sale, receipt_tax_inclusive_at_sale)
                VALUES (?, ?, 1, 10.00, 1.60, 11.60, 'unpaid_table', 0, 1)
            `, [userAId, shiftId]);

            const res = await request(app)
                .post('/api/print/print')
                .set('Cookie', cashierACookie)
                .send({
                    print_type: 'receipt',
                    invoice_id: 'GUEST CHECK',
                    source_invoice_id: orderRes.insertId,
                    tax_inclusive_at_sale: 1,
                    receipt_tax_inclusive_at_sale: 0,
                    items: [{ id: SEED.product1.id, qty: 1, price: 10.00, tax_rate: 16 }]
                });

            expect(res.statusCode).toBe(200);
            const [[job]] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            const presentation = JSON.parse(job.payload).data.receipt_display_v1;
            expect(presentation.taxMode).toBe('inclusive');
            expect(presentation.rows[0]).toMatchObject({ unitPrice: 11.6, netAmount: 11.6 });
            expect(presentation.summary).toMatchObject({ subtotal: 11.6, taxAmount: 0, total: 11.6 });
        });

        it('blocks numeric receipt reprint bundle corruption before queueing', async () => {
            let invoiceId;
            await withBundleIntegrityChecksDisabled(pool, async conn => {
                const [orderRes] = await conn.query(
                    `INSERT INTO orders (user_id, shift_id, order_type_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale)
                     VALUES (?, ?, 1, 0.00, 0.00, 0.00, 'cash', 0)`,
                    [userAId, shiftId]
                );
                invoiceId = orderRes.insertId;
                await conn.query(
                    `INSERT INTO order_items (invoice_id, product_id, item_name, parent_item_id, quantity, price_at_sale, tax_rate, tax_amount)
                     VALUES (?, ?, 'Orphan Bundle Child', 999999, 1, 0.00, 16.00, 0.00)`,
                    [invoiceId, SEED.product1.id]
                );
            });
            const [[before]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');

            const response = await request(app)
                .post('/api/print/print')
                .set('Cookie', adminCookie)
                .send({ print_type: 'receipt', invoice_id: invoiceId });

            expect(response.statusCode).toBe(409);
            expect(response.body.publicCode).toBe('BUNDLE_ORDER_CORRUPT');
            const [[after]] = await pool.query('SELECT COUNT(*) AS count FROM print_queue');
            expect(Number(after.count)).toBe(Number(before.count));
        });
    });
});
