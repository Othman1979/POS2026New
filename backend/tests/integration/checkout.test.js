// integration/checkout.test.js — Integration tests for checkout operations
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { invalidateUserSessions } = require('../../middleware/auth');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { withBundleIntegrityChecksDisabled } = require('../helpers/bundleIntegrityFixtures');
const { BUNDLE_ORDER_CORRUPT_MESSAGE } = require('../../services/bundleIntegrity');
const { executeCheckout } = require('../../modules/checkout/executeCheckout');
const PlatformRemittanceService = require('../../services/PlatformRemittanceService');

describe('Checkout Integration Tests', () => {
    let cashierCookie;
    let cashierShiftId;
    let adminCookie;

    beforeEach(async () => {
        // Reset DB state before each test so tests are completely isolated and independent
        await seedDatabase();

        // Login cashier to get cookie
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = loginRes.headers['set-cookie'][0];

        // Login admin to get cookie
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        // Drain pool
        await pool.end();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // Helper: open a shift for cashier
    async function openShift() {
        const res = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
        expect(res.statusCode).toBe(200);

        // Fetch shift_id from DB
        const [rows] = await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [SEED.cashierUser.id]);
        cashierShiftId = rows[0].id;
        return cashierShiftId;
    }

    async function claimHeldForCheckout(id, token = 'e'.repeat(64)) {
        const [[row]] = await pool.query('SELECT version FROM held_orders WHERE id=?', [id]);
        const response = await request(app)
            .post(`/api/pos/held_orders/${id}/claim`)
            .set('Cookie', cashierCookie)
            .send({ claim_token: token, expected_version: Number(row?.version || 1) });
        expect(response.statusCode).toBe(200);
        return {
            response,
            order: response.body.order,
            claim: response.body.claim,
            context: {
                id,
                claim_token: response.body.claim.claimToken,
                expected_version: response.body.claim.version,
                operation_id: `77777777-7777-4777-8777-${String(id).padStart(12, '0')}`
            }
        };
    }

    async function createAllocatedSplitFixture() {
        await openShift();
        const [orderResult] = await pool.query(
            `INSERT INTO orders
                (user_id, waiter_id, table_id, shift_id, subtotal, tax, total,
                 payment_method, tax_inclusive_at_sale, created_at)
             VALUES (?, ?, ?, ?, 4.09, 0.66, 4.75, 'unpaid_table', 0, NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const parentInvoiceId = orderResult.insertId;
        await pool.query(
            `INSERT INTO order_items
                (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
             VALUES (?, ?, ?, 1, 4.092, 16, 0.65)`,
            [parentInvoiceId, SEED.product1.id, SEED.product1.name]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?",
            [parentInvoiceId, SEED.table.id]
        );

        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: parentInvoiceId,
                splits: [
                    { referenceName: 'Table 1 - Allocated A', subtotal: 2.38, items: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }] },
                    { referenceName: 'Table 1 - Allocated B', subtotal: 2.37, items: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }] }
                ]
            });
        expect(splitRes.statusCode).toBe(200);
        const [held] = await pool.query('SELECT id, cart_data FROM held_orders ORDER BY id');
        return { parentInvoiceId, held };
    }

    const allocatedSplitCheckoutPayload = ({ held, parentInvoiceId, subtotal, total, key }) => ({
        cart: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }],
        shift_id: cashierShiftId,
        subtotal,
        tax: 0.33,
        total,
        payment_method: 'cash',
        amount_tendered: total,
        change_due: 0,
        split_check_id: held.id,
        parent_invoice_id: parentInvoiceId,
        is_split: true,
        table_id: SEED.table.id,
        idempotency_key: key
    });

    async function seedSettlementTable({
        tableId,
        product = SEED.product1,
        qty = 1,
        lineDiscountType = null,
        lineDiscountValue = 0,
        orderDiscountType = null,
        orderDiscountValue = 0,
        withServiceCharge = false
    }) {
        const grossProductSubtotal = Number(product.price) * qty;
        const lineDiscount = lineDiscountType === 'fixed'
            ? Number(lineDiscountValue) * qty
            : lineDiscountType === 'percent'
                ? grossProductSubtotal * (Number(lineDiscountValue) / 100)
                : 0;
        const productSubtotal = Math.max(0, grossProductSubtotal - lineDiscount);
        const fee = withServiceCharge ? Math.round(productSubtotal * 10) / 100 : 0;
        const subtotal = Math.round((productSubtotal + fee) * 100) / 100;
        const orderDiscount = orderDiscountType === 'fixed'
            ? Number(orderDiscountValue)
            : orderDiscountType === 'percent'
                ? subtotal * (Number(orderDiscountValue) / 100)
                : 0;
        const discountedSubtotal = Math.max(0, subtotal - orderDiscount);
        const discountRatio = subtotal > 0 ? discountedSubtotal / subtotal : 1;
        const productTax = productSubtotal * discountRatio * (Number(product.tax_rate) / 100);
        const tax = Math.round(productTax * 100) / 100;
        const total = Math.round((discountedSubtotal + tax) * 100) / 100;
        const snapshotId = withServiceCharge ? `00000000-0000-4000-8000-${String(tableId).padStart(12, '0')}` : null;

        if (snapshotId) {
            await pool.query(
                `INSERT INTO service_charge_snapshots
                    (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
                 VALUES (?, 10, 0, 'open_order', 'order', NULL, ?, 2)`,
                [snapshotId, SEED.adminUser.id]
            );
        }

        const [orderResult] = await pool.query(
            `INSERT INTO orders
                (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax,
                 total, payment_method, discount_type, discount_value,
                 tax_inclusive_at_sale, service_charge_snapshot_id)
             VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'unpaid_table', ?, ?, 0, ?)`,
            [
                SEED.waiterUser.id,
                SEED.waiterUser.id,
                tableId,
                cashierShiftId,
                subtotal,
                tax,
                total,
                orderDiscountType,
                orderDiscountValue,
                snapshotId
            ]
        );
        const invoiceId = orderResult.insertId;
        if (snapshotId) {
            await pool.query(
                'UPDATE service_charge_snapshots SET holder_id=? WHERE id=?',
                [String(invoiceId), snapshotId]
            );
        }

        const [itemResult] = await pool.query(
            `INSERT INTO order_items
                (invoice_id, product_id, item_name, quantity, price_at_sale,
                 tax_rate, tax_amount, discount_type, discount_value, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [
                invoiceId,
                product.id,
                product.name,
                qty,
                product.price,
                product.tax_rate,
                productTax,
                lineDiscountType,
                lineDiscountValue
            ]
        );
        let feeItemId = null;
        if (withServiceCharge) {
            const [feeResult] = await pool.query(
                `INSERT INTO order_items
                    (invoice_id, product_id, item_name, quantity, price_at_sale,
                     tax_rate, tax_amount, note, sort_order)
                 VALUES (?, NULL, '10% Service Charge', 1, ?, 0, 0,
                         'Auto-Gratuity', 1)`,
                [invoiceId, fee]
            );
            feeItemId = feeResult.insertId;
        }
        await pool.query(
            `UPDATE restaurant_tables
                SET status='occupied', current_order_id=?, parent_table_id=NULL
              WHERE id=?`,
            [invoiceId, tableId]
        );

        return {
            invoiceId,
            itemId: itemResult.insertId,
            feeItemId,
            snapshotId,
            fee,
            subtotal,
            tax,
            total
        };
    }

    const settlementCheckoutPayload = ({ tableId, fixture, key, cart }) => ({
        edit_invoice_id: fixture.invoiceId,
        table_id: tableId,
        shift_id: cashierShiftId,
        cart: cart || [{
            id: SEED.product1.id,
            product_id: SEED.product1.id,
            name: SEED.product1.name,
            qty: 1,
            price: SEED.product1.price,
            tax_rate: SEED.product1.tax_rate,
            order_item_id: fixture.itemId,
            discountType: null,
            discountValue: 0
        }],
        subtotal: fixture.subtotal,
        tax: fixture.tax,
        total: fixture.total,
        payment_method: 'cash',
        amount_tendered: fixture.total,
        change_due: 0,
        order_discount_type: null,
        order_discount_value: 0,
        idempotency_key: key
    });

    async function snapshotSettlementState(invoiceIds, tableIds) {
        const placeholders = values => values.map(() => '?').join(',');
        const [orders] = await pool.query(
            `SELECT * FROM orders WHERE invoice_id IN (${placeholders(invoiceIds)}) ORDER BY invoice_id`,
            invoiceIds
        );
        const [items] = await pool.query(
            `SELECT * FROM order_items WHERE invoice_id IN (${placeholders(invoiceIds)}) ORDER BY invoice_id,id`,
            invoiceIds
        );
        const [tables] = await pool.query(
            `SELECT * FROM restaurant_tables WHERE id IN (${placeholders(tableIds)}) ORDER BY id`,
            tableIds
        );
        const [refunds] = await pool.query(
            `SELECT * FROM refunds WHERE invoice_id IN (${placeholders(invoiceIds)}) ORDER BY id`,
            invoiceIds
        );
        const [audits] = await pool.query(
            `SELECT * FROM audit_events WHERE entity_id IN (${placeholders(invoiceIds)}) ORDER BY id`,
            invoiceIds
        );
        const [stock] = await pool.query('SELECT id,stock FROM products ORDER BY id');
        const [invoiceSequences] = await pool.query('SELECT * FROM invoice_sequences ORDER BY sequence_name');
        return { orders, items, tables, refunds, audits, stock, invoiceSequences };
    }

    async function bindLiveTableOrder(tableId, invoiceId) {
        await pool.query(
            `UPDATE restaurant_tables
                SET status='occupied', current_order_id=?, parent_table_id=NULL
              WHERE id=?`,
            [invoiceId, tableId]
        );
    }

    async function waitForAuditCount(eventType, entityId, expected, timeoutMs = 1000) {
        const deadline = Date.now() + timeoutMs;
        let count = 0;
        do {
            const [[row]] = await pool.query(
                "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = ? AND entity_id = ?",
                [eventType, entityId]
            );
            count = Number(row.c);
            if (count === expected) return count;
            await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return count;
    }

    function failNextConnectionQuery(predicate, message) {
        const originalGetConnection = pool.getConnection;
        pool.getConnection = async function () {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            const originalRelease = conn.release;
            let failed = false;
            conn.query = async function (sql, params) {
                if (!failed && predicate(sql, params)) {
                    failed = true;
                    throw new Error(message);
                }
                return originalQuery.call(this, sql, params);
            };
            conn.release = function () {
                conn.query = originalQuery;
                conn.release = originalRelease;
                pool.getConnection = originalGetConnection;
                return originalRelease.call(this);
            };
            return conn;
        };
    }

    function hideNextIdempotencyPreflight() {
        const originalGetConnection = pool.getConnection;
        let hidden = false;
        pool.getConnection = async function () {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            const originalRelease = conn.release;
            conn.query = async function (sql, params) {
                if (!hidden && typeof sql === 'string' &&
                    sql.replace(/\s+/g, ' ').includes('FROM orders WHERE idempotency_key = ? LIMIT 1')) {
                    hidden = true;
                    return [[]];
                }
                return originalQuery.call(this, sql, params);
            };
            conn.release = function () {
                conn.query = originalQuery;
                conn.release = originalRelease;
                pool.getConnection = originalGetConnection;
                return originalRelease.call(this);
            };
            return conn;
        };
        const restore = () => { pool.getConnection = originalGetConnection; };
        restore.wasHidden = () => hidden;
        return restore;
    }

    function rejectDuplicateRollback() {
        const originalGetConnection = pool.getConnection;
        const state = {
            preflightHidden: false,
            rollbackAttempted: false,
            released: false,
            destroyed: false
        };

        pool.getConnection = async function () {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            const originalRollback = conn.rollback;
            const originalRelease = conn.release;
            const originalDestroy = conn.destroy;
            const restore = () => {
                conn.query = originalQuery;
                conn.rollback = originalRollback;
                conn.release = originalRelease;
                conn.destroy = originalDestroy;
                pool.getConnection = originalGetConnection;
            };

            conn.query = async function (sql, params) {
                if (!state.preflightHidden && typeof sql === 'string' &&
                    sql.replace(/\s+/g, ' ').includes('FROM orders WHERE idempotency_key = ? LIMIT 1')) {
                    state.preflightHidden = true;
                    return [[]];
                }
                return originalQuery.call(this, sql, params);
            };
            conn.rollback = async function () {
                state.rollbackAttempted = true;
                throw new Error('Rollback unavailable');
            };
            conn.release = function () {
                state.released = true;
                restore();
                return originalDestroy.call(this);
            };
            conn.destroy = function () {
                state.destroyed = true;
                restore();
                return originalDestroy.call(this);
            };
            return conn;
        };

        return {
            state,
            restore: () => { pool.getConnection = originalGetConnection; }
        };
    }

    function synchronizeCustomerLookups(phone, expectedReads = 2) {
        const originalGetConnection = pool.getConnection;
        let writeCount = 0;
        let releaseBarrier;
        const barrier = new Promise(resolve => { releaseBarrier = resolve; });

        pool.getConnection = async function () {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            const originalRelease = conn.release;
            conn.query = async function (sql, params) {
                if (typeof sql === 'string' && sql.includes('GET_LOCK') && params?.[0] === `posapp:customer:${phone}`) {
                    writeCount += 1;
                    if (writeCount === expectedReads) releaseBarrier();
                    await barrier;
                }
                return originalQuery.call(this, sql, params);
            };
            conn.release = function () {
                conn.query = originalQuery;
                conn.release = originalRelease;
                return originalRelease.call(this);
            };
            return conn;
        };
        return () => { pool.getConnection = originalGetConnection; };
    }

    it('rejects creating a new custom (open) item on a fresh checkout', async () => {
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ name: 'Open Thing', price: 9.99, qty: 1, tax_rate: 0 }], // no id → product_id null
            subtotal: 9.99, tax: 0, total: 9.99, amount_tendered: 10, payment_method: 'cash'
        });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/open item|custom item|not available/i);
    });

    it('rejects a browser-supplied platform payment method', async () => {
        await openShift();

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'platform',
                amount_tendered: 0,
                cash_amount: 0,
                card_amount: 0,
                change_due: 0,
                idempotency_key: 'browser-platform-payment-rejected'
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/invalid payment method/i);
        const [orders] = await pool.query("SELECT invoice_id FROM orders WHERE idempotency_key = 'browser-platform-payment-rejected'");
        expect(orders).toHaveLength(0);
    });

    it('derives a direct platform payment from the configured order type and ignores browser tender values', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: 3,
                order_type_is_deferred_settlement: true,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 100,
                cash_amount: 5.8,
                card_amount: 99,
                change_due: 94.2,
                customer_name: 'Platform Guest',
                customer_address: 'Amman',
                idempotency_key: 'direct-platform-server-derived'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            payment_method: 'platform',
            amount_tendered: 0,
            cash_amount: 0,
            card_amount: 0,
            change_due: 0,
            jofotara: { required: false, status: 'not_required', code: 'platform' }
        });
        const [[order]] = await pool.query(
            `SELECT order_type_id, payment_method, amount_tendered, cash_amount, card_amount, change_due,
                    buyer_name_at_sale, buyer_address_at_sale
               FROM orders WHERE invoice_id=?`,
            [res.body.invoice_id]
        );
        expect(order).toMatchObject({
            order_type_id: 3,
            payment_method: 'platform',
            buyer_name_at_sale: 'Platform Guest',
            buyer_address_at_sale: 'Amman'
        });
        expect(Number(order.amount_tendered)).toBe(0);
        expect(Number(order.cash_amount)).toBe(0);
        expect(Number(order.card_amount)).toBe(0);
        expect(Number(order.change_due)).toBe(0);
        const receivables = await PlatformRemittanceService.listReceivables(pool, 3);
        expect(receivables.find(row => row.invoice_id === res.body.invoice_id)).toMatchObject({
            order_type_id: 3,
            open_amount: 5.8
        });
    });

    it('does not let browser edit_order_id escape direct platform accounting', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: 3,
                edit_order_id: 999999,
                order_type_is_deferred_settlement: true,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'forged-edit-order-id-platform'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            payment_method: 'platform',
            amount_tendered: 0,
            cash_amount: 0,
            card_amount: 0,
            change_due: 0
        });
        const [[order]] = await pool.query(
            'SELECT payment_method, shift_id, order_type_id FROM orders WHERE invoice_id=?',
            [res.body.invoice_id]
        );
        expect(order).toMatchObject({
            payment_method: 'platform',
            shift_id: cashierShiftId,
            order_type_id: 3
        });
    });

    it('rejects checkout when the browser and database disagree on platform settlement', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: 3,
                order_type_is_deferred_settlement: false,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'stale-order-type-settlement-mode'
            });

        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({
            success: false,
            code: 'ORDER_TYPE_SETTLEMENT_CHANGED'
        });
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key=?',
            ['stale-order-type-settlement-mode']
        );
        expect(orders).toHaveLength(0);
    });

    it('rejects a stale platform screen after the database changes the order type to ordinary settlement', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Former Platform', 1, 0)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: 3,
                order_type_is_deferred_settlement: true,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'platform',
                amount_tendered: 0,
                change_due: 0,
                idempotency_key: 'stale-platform-screen'
            });

        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({
            success: false,
            code: 'ORDER_TYPE_SETTLEMENT_CHANGED'
        });
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key=?',
            ['stale-platform-screen']
        );
        expect(orders).toHaveLength(0);
    });

    it('requires a settlement-mode snapshot for a selected direct order type', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: 3,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'missing-order-type-settlement-mode'
            });

        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({
            success: false,
            code: 'ORDER_TYPE_CONTEXT_REQUIRED'
        });
    });

    it('requires an open shift even when the browser labels a finalized checkout unpaid_table', async () => {
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                order_type_id: 3,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'unpaid_table',
                amount_tendered: 0,
                change_due: 0,
                idempotency_key: 'forged-unpaid-table-without-shift'
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/active open shift/i);
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key=?',
            ['forged-unpaid-table-without-shift']
        );
        expect(orders).toHaveLength(0);
    });

    it('requires checkout permission even when the browser labels a finalized checkout unpaid_table', async () => {
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (30, '9030', 'Unprivileged Cashier', 'cashier', 1)
        `);
        const login = await request(app).post('/api/auth/login').send({ user_number: '9030' });
        const cookie = login.headers['set-cookie'][0];
        const [shift] = await pool.query(
            "INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (30, 0, 'open', NOW())"
        );
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Talabat', 1, 1)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: shift.insertId,
                order_type_id: 3,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'unpaid_table',
                amount_tendered: 0,
                change_due: 0,
                idempotency_key: 'forged-unpaid-table-without-permission'
            });

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/not authorized to check out/i);
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key=?',
            ['forged-unpaid-table-without-permission']
        );
        expect(orders).toHaveLength(0);
    });

    it('does not make checkout permission overridable through a manager PIN', async () => {
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (30, '9030', 'Unprivileged Cashier', 'cashier', 1)
        `);
        const login = await request(app).post('/api/auth/login').send({ user_number: '9030' });
        const cookie = login.headers['set-cookie'][0];
        const [shift] = await pool.query(
            "INSERT INTO shifts (user_id, starting_cash, status, opened_at) VALUES (30, 0, 'open', NOW())"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: shift.insertId,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                manager_pin: SEED.adminUser.pin,
                idempotency_key: 'manager-pin-cannot-grant-checkout'
            });

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/not authorized to check out/i);
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key=?',
            ['manager-pin-cannot-grant-checkout']
        );
        expect(orders).toHaveLength(0);
    });

    it('rejects a stale direct checkout selection after its order type is deactivated', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Disabled Platform', 0, 1)"
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: 3,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'disabled-platform-rejected'
            });

        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({ success: false, code: 'ORDER_TYPE_UNAVAILABLE' });
        const [[count]] = await pool.query(
            'SELECT COUNT(*) AS count FROM orders WHERE idempotency_key=?',
            ['disabled-platform-rejected']
        );
        expect(Number(count.count)).toBe(0);
    });

    it('should successfully checkout an order via Cash (Happy Path)', async () => {
        await openShift();

        const cart = [
            { id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: null, discountValue: 0 } // burger: 5.00, 16% tax
        ];

        // Total = 5.00 + 0.80 tax = 5.80
        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 5.00,
            tax: 0.80,
            total: 5.80,
            payment_method: 'cash',
            amount_tendered: 10.00,
            change_due: 4.20,
            order_discount_type: null,
            order_discount_value: 0,
            idempotency_key: 'happy_path_cash_key'
        };

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.invoice_id).toBeDefined();

        // Verify order saved in DB
        const [orders] = await pool.query("SELECT * FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
        expect(orders).toHaveLength(1);
        expect(Number(orders[0].total)).toBe(5.80);
        expect(orders[0].payment_method).toBe('cash');
        expect(Number(orders[0].change_due)).toBe(4.20);

        // Verify items saved in DB
        const [items] = await pool.query("SELECT * FROM order_items WHERE invoice_id = ?", [res.body.invoice_id]);
        expect(items).toHaveLength(1);
        expect(items[0].product_id).toBe(SEED.product1.id);
        expect(items[0].item_name).toBe(SEED.product1.name);
        expect(Number(items[0].quantity)).toBe(1);
    });

    it.each(['true', 1])('rejects non-boolean tax exemption payload %p without creating an order', async (taxExempt) => {
        await openShift();

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                tax_exempt: taxExempt,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: `tax-exempt-invalid-${String(taxExempt)}`
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/tax exemption must be a boolean/i);
        const [orders] = await pool.query(
            'SELECT invoice_id FROM orders WHERE idempotency_key = ?',
            [`tax-exempt-invalid-${String(taxExempt)}`]
        );
        expect(orders).toHaveLength(0);
    });

    it('requires pos.tax_exempt for an ordinary cashier exemption', async () => {
        await openShift();

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0,
                total: 5,
                tax_exempt: true,
                payment_method: 'cash',
                amount_tendered: 5,
                change_due: 0,
                idempotency_key: 'tax-exempt-permission-required'
            });

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/tax exempt/i);
        const [orders] = await pool.query(
            "SELECT invoice_id FROM orders WHERE idempotency_key = 'tax-exempt-permission-required'"
        );
        expect(orders).toHaveLength(0);
    });

    it('rejects tax exemption under the income-tax registration profile', async () => {
        await pool.query("UPDATE settings SET setting_value = 'income_tax' WHERE setting_key = 'tax_registration_type'");
        await pool.query(
            "INSERT INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.tax_exempt')",
            [SEED.cashierUser.id]
        );
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = loginRes.headers['set-cookie'][0];
        await openShift();

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0,
                total: 5,
                tax_exempt: true,
                payment_method: 'cash',
                amount_tendered: 5,
                change_due: 0,
                idempotency_key: 'tax-exempt-income-tax-rejected'
            });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/income-tax registration profile/i);
        const [orders] = await pool.query(
            "SELECT invoice_id FROM orders WHERE idempotency_key = 'tax-exempt-income-tax-rejected'"
        );
        expect(orders).toHaveLength(0);
    });

    it('persists an authorized exemption with normal sale accounting and audit evidence', async () => {
        await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
        await pool.query('UPDATE products SET price = 20.000000, tax_rate = 16 WHERE id = ?', [SEED.product1.id]);
        await pool.query(
            "INSERT INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.tax_exempt')",
            [SEED.cashierUser.id]
        );

        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = loginRes.headers['set-cookie'][0];
        await openShift();

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 20 }],
                shift_id: cashierShiftId,
                subtotal: 20,
                tax: 0,
                total: 20,
                tax_exempt: true,
                payment_method: 'cash',
                amount_tendered: 20,
                change_due: 0,
                idempotency_key: 'tax-exempt-authoritative-sale'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, tax_exempt: true, subtotal: 20, tax: 0, total: 20 });

        const [[order]] = await pool.query(
            'SELECT tax_exempt_at_sale, subtotal, tax, total FROM orders WHERE invoice_id = ?',
            [res.body.invoice_id]
        );
        expect(Number(order.tax_exempt_at_sale)).toBe(1);
        expect(Number(order.subtotal)).toBe(20);
        expect(Number(order.tax)).toBe(0);
        expect(Number(order.total)).toBe(20);

        const [[item]] = await pool.query(
            'SELECT price_at_sale, price_before_tax_exemption, tax_rate, jofotara_tax_category, tax_amount FROM order_items WHERE invoice_id = ?',
            [res.body.invoice_id]
        );
        expect(Number(item.price_at_sale)).toBeCloseTo(20, 6);
        expect(Number(item.price_before_tax_exemption)).toBeCloseTo(20, 6);
        expect(Number(item.tax_rate)).toBe(16);
        expect(item.jofotara_tax_category).toBe('Z');
        expect(Number(item.tax_amount)).toBe(0);

        const [[audit]] = await pool.query(
            "SELECT event_type, new_value FROM audit_events WHERE event_type = 'tax_exempt_checkout' AND entity_id = ? ORDER BY id DESC LIMIT 1",
            [res.body.invoice_id]
        );
        expect(audit?.event_type).toBe('tax_exempt_checkout');
        const auditValue = JSON.parse(audit.new_value);
        expect(auditValue).toMatchObject({ final_tax: 0, exempt_total: 20 });
        expect(auditValue.original_total).toBeCloseTo(23.2, 2);
        expect(auditValue.tax_removed).toBeCloseTo(3.2, 2);
    });

    it('charges the current category-owned register price instead of a forged cashier price', async () => {
        await openShift();
        await pool.query('UPDATE categories SET price_list_root_id = id WHERE id = ?', [SEED.category.id]);
        await pool.query('UPDATE products SET tax_rate = 8 WHERE id = ?', [SEED.product1.id]);
        await pool.query(
            'INSERT INTO product_price_overrides (price_list_root_id, product_id, price) VALUES (?, ?, ?)',
            [SEED.category.id, SEED.product1.id, 0.925926]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 99 }],
                shift_id: cashierShiftId,
                subtotal: 0.93,
                tax: 0.07,
                total: 1.00,
                payment_method: 'cash',
                amount_tendered: 1.00,
                change_due: 0,
                idempotency_key: 'category-price-authoritative-register'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, subtotal: 0.93, tax: 0.07, total: 1 });
        const [[line]] = await pool.query(
            'SELECT price_at_sale, tax_rate, tax_amount FROM order_items WHERE invoice_id = ?',
            [res.body.invoice_id]
        );
        expect(Number(line.price_at_sale)).toBeCloseTo(0.925926, 4);
        expect(Number(line.tax_rate)).toBe(8);
        expect(Number(line.tax_amount)).toBeCloseTo(0.074072, 6);
    });

    it('keeps Talabat and Careem prices separate for matching category and product names', async () => {
        await openShift();
        await pool.query(`
            INSERT INTO categories (id, parent_id, name, is_active, is_notes, price_list_root_id)
            VALUES
                (20, NULL, 'Talabat', 1, 0, NULL),
                (21, 20, 'Meals', 1, 0, 20),
                (22, NULL, 'Careem', 1, 0, NULL),
                (23, 22, 'Meals', 1, 0, 22)
        `);
        await pool.query('UPDATE categories SET price_list_root_id = id WHERE id IN (20, 22)');
        await pool.query(`
            INSERT INTO products (id, category_id, barcode, name, price, tax_rate, is_active, is_bundle)
            VALUES
                (20, 21, 'TALABAT-CHICKEN', 'Chicken Meal', 5.000000, 8, 1, 0),
                (22, 23, 'CAREEM-CHICKEN', 'Chicken Meal', 5.000000, 8, 1, 0)
        `);
        await pool.query(`
            INSERT INTO product_price_overrides (price_list_root_id, product_id, price)
            VALUES (20, 20, 0.925926), (22, 22, 1.851852)
        `);

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [
                    { id: 20, qty: 1, price: 99 },
                    { id: 22, qty: 1, price: 99 }
                ],
                shift_id: cashierShiftId,
                subtotal: 2.78,
                tax: 0.22,
                total: 3.00,
                payment_method: 'cash',
                amount_tendered: 3.00,
                change_due: 0,
                idempotency_key: 'talabat-careem-separate-prices'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, subtotal: 2.78, tax: 0.22, total: 3 });
        const [lines] = await pool.query(
            `SELECT product_id, item_name, price_at_sale, tax_rate, tax_amount
               FROM order_items
              WHERE invoice_id = ?
              ORDER BY product_id`,
            [res.body.invoice_id]
        );
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ product_id: 20, item_name: 'Chicken Meal' });
        expect(Number(lines[0].price_at_sale)).toBeCloseTo(0.925926, 4);
        expect(Number(lines[0].tax_rate)).toBe(8);
        expect(Number(lines[0].tax_amount)).toBeCloseTo(0.074072, 6);
        expect(lines[1]).toMatchObject({ product_id: 22, item_name: 'Chicken Meal' });
        expect(Number(lines[1].price_at_sale)).toBeCloseTo(1.851852, 4);
        expect(Number(lines[1].tax_rate)).toBe(8);
        expect(Number(lines[1].tax_amount)).toBeCloseTo(0.148152, 6);
    });

    it('keeps category pricing canonical through modifiers and line/order discounts', async () => {
        await openShift();
        const modifiers = JSON.stringify([{ name: 'Extra', options: [{ name: 'Cheese', price: 0.15 }] }]);
        await pool.query('UPDATE categories SET price_list_root_id = id WHERE id = ?', [SEED.category.id]);
        await pool.query('UPDATE products SET tax_rate = 8, modifiers = ? WHERE id = ?', [modifiers, SEED.product1.id]);
        await pool.query(
            'INSERT INTO product_price_overrides (price_list_root_id, product_id, price) VALUES (?, ?, ?)',
            [SEED.category.id, SEED.product1.id, 4]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: 4.15,
                    selectedModifiers: [{ group: 'Extra', option: 'Cheese', price: 0.15 }],
                    discountType: 'percent',
                    discountValue: 10
                }],
                order_discount_type: 'percent',
                order_discount_value: 20,
                manager_pin: SEED.adminUser.pin,
                shift_id: cashierShiftId,
                subtotal: 3.73,
                tax: 0.24,
                total: 3.22,
                payment_method: 'cash',
                amount_tendered: 5,
                change_due: 1.78,
                idempotency_key: 'category-price-modifier-discount-stack'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, subtotal: 3.73, tax: 0.24, total: 3.22 });
        const [[line]] = await pool.query(
            `SELECT price_at_sale, tax_rate, tax_amount, modifier_surcharge, modifier_tax_amount,
                    discount_type, discount_value
               FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL`,
            [res.body.invoice_id]
        );
        expect(Number(line.price_at_sale)).toBe(4.15);
        expect(Number(line.tax_rate)).toBe(8);
        expect(Number(line.modifier_surcharge)).toBe(0.15);
        expect(Number(line.modifier_tax_amount)).toBeCloseTo(0.011111, 6);
        expect(Number(line.tax_amount)).toBeCloseTo(0.2384, 6);
        expect(line.discount_type).toBe('percent');
        expect(Number(line.discount_value)).toBe(10);
    });

    it('still checks out a product that was already in the cart when it became sold out', async () => {
        await openShift();
        await pool.query('UPDATE products SET is_available = 0 WHERE id = ?', [SEED.product1.id]);

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: null, discountValue: 0 }],
                shift_id: cashierShiftId,
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 5.80,
                change_due: 0,
                idempotency_key: 'sold_out_existing_cart'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, total: 5.80 });
        const [lines] = await pool.query(
            'SELECT product_id, quantity, price_at_sale FROM order_items WHERE invoice_id = ?',
            [res.body.invoice_id]
        );
        expect(lines).toHaveLength(1);
        expect(lines[0].product_id).toBe(SEED.product1.id);
        expect(Number(lines[0].quantity)).toBe(1);
        expect(Number(lines[0].price_at_sale)).toBe(5);
    });

    it('allows the configured Y order type to checkout like any ordinary held order', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('y_order_type_id', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
            [String(SEED.orderType.id)]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: SEED.orderType.id,
                order_type_is_deferred_settlement: false,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'y-type-ordinary-checkout'
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const [[order]] = await pool.query(
            'SELECT order_type_id, payment_method, total FROM orders WHERE invoice_id = ?',
            [res.body.invoice_id]
        );
        expect(order.order_type_id).toBe(SEED.orderType.id);
        expect(order.payment_method).toBe('cash');
        expect(Number(order.total)).toBe(5.8);
    });

    it('applies the configured default order type to a new register checkout', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('default_order_type_id', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
            [String(SEED.orderType.id)]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: null, discountValue: 0 }],
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                order_type_is_deferred_settlement: false,
                order_discount_type: null,
                order_discount_value: 0,
                idempotency_key: 'default-order-type-checkout'
            });

        expect(res.statusCode).toBe(200);
        const [[order]] = await pool.query('SELECT order_type_id FROM orders WHERE invoice_id = ?', [res.body.invoice_id]);
        expect(order.order_type_id).toBe(SEED.orderType.id);

        const switched = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price, discountType: null, discountValue: 0 }],
                shift_id: cashierShiftId,
                subtotal: 2,
                tax: 0,
                total: 2,
                payment_method: 'cash',
                amount_tendered: 2,
                change_due: 0,
                order_type_id: 2,
                order_type_is_deferred_settlement: false,
                hash_number: 'TAKEAWAY-2',
                order_discount_type: null,
                order_discount_value: 0,
                idempotency_key: 'explicit-order-type-overrides-default'
            });
        expect(switched.statusCode).toBe(200);
        const [[switchedOrder]] = await pool.query(
            'SELECT order_type_id FROM orders WHERE invoice_id = ?',
            [switched.body.invoice_id]
        );
        expect(switchedOrder.order_type_id).toBe(2);
    });

    it('should successfully checkout an order via Card (Happy Path)', async () => {
        await openShift();

        const cart = [
            { id: SEED.product2.id, qty: 2, price: SEED.product2.price, discountType: null, discountValue: 0 } // drink: 2.00, 0% tax -> 2x = 4.00
        ];

        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 4.00,
            tax: 0.00,
            total: 4.00,
            payment_method: 'card',
            amount_tendered: 4.00,
            change_due: 0.00,
            order_discount_type: null,
            order_discount_value: 0
        };

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const [orders] = await pool.query("SELECT * FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
        expect(orders[0].payment_method).toBe('card');
        expect(Number(orders[0].card_amount)).toBe(4.00);
    });

    it('should successfully checkout an order via Split payment (Happy Path)', async () => {
        await openShift();

        const cart = [
            { id: SEED.product1.id, qty: 2, price: SEED.product1.price, discountType: null, discountValue: 0 } // 2x burger = 10.00, 1.60 tax -> 11.60
        ];

        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 10.00,
            tax: 1.60,
            total: 11.60,
            payment_method: 'split',
            amount_tendered: 11.60,
            cash_amount: 5.00,
            card_amount: 6.60,
            change_due: 0.00,
            order_discount_type: null,
            order_discount_value: 0,
            idempotency_key: 'split-tender-happy-path'
        };

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body).toMatchObject({ payment_method: 'split', cash_amount: 5.00, card_amount: 6.60 });

        const [orders] = await pool.query("SELECT * FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
        expect(orders[0].payment_method).toBe('split');
        expect(Number(orders[0].cash_amount)).toBe(5.00);
        expect(Number(orders[0].card_amount)).toBe(6.60);

        const retry = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);
        expect(retry.statusCode).toBe(200);
        expect(retry.body.message).toMatch(/duplicate request/i);
        expect(retry.body).toMatchObject({ payment_method: 'split', cash_amount: 5.00, card_amount: 6.60 });
    });

    it.each([
        ['zero cash', 0, 11.60, 11.60, 0],
        ['zero card', 11.60, 0, 11.60, 0],
        ['one-cent allocation gap', 5.00, 6.59, 11.60, 0],
        ['insufficient physical cash', 5.00, 6.60, 10.60, 0],
        ['incorrect change', 5.00, 6.60, 16.60, 4.00],
    ])('rejects invalid split tender: %s', async (_case, cashAmount, cardAmount, amountTendered, changeDue) => {
        await openShift();
        const before = await pool.query('SELECT COUNT(*) AS count FROM orders');
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 10.00,
                tax: 1.60,
                total: 11.60,
                payment_method: 'split',
                amount_tendered: amountTendered,
                cash_amount: cashAmount,
                card_amount: cardAmount,
                change_due: changeDue,
            });
        const after = await pool.query('SELECT COUNT(*) AS count FROM orders');

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(Number(after[0][0].count)).toBe(Number(before[0][0].count));
    });

    it('should block cashier checkout when cashier has no active open shift', async () => {
        // Do NOT open shift
        const cart = [
            { id: SEED.product1.id, qty: 1, price: SEED.product1.price }
        ];

        const payload = {
            cart,
            subtotal: 5.00,
            tax: 0.80,
            total: 5.80,
            payment_method: 'cash',
            amount_tendered: 6.00,
            change_due: 0.20
        };

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res.statusCode).toBe(400); // verifyToken or shift verification throws
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('active open shift is required');
    });

    it('should block checkout when client-submitted totals mismatch server-calculated totals', async () => {
        await openShift();

        const cart = [
            { id: SEED.product1.id, qty: 1, price: SEED.product1.price } // burger 5.00 -> total 5.80
        ];

        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 5.00,
            tax: 0.80,
            total: 5.00, // client total 5.00 != server total 5.80 → Total assert fires first
            payment_method: 'cash',
            amount_tendered: 5.00,
            change_due: 0
        };

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/Total mismatch/i);
    });

    it('keeps one unique database guard for checkout retries and customer phones', async () => {
        const [indexes] = await pool.query(
            `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND ((TABLE_NAME = 'orders' AND COLUMN_NAME = 'idempotency_key')
                 OR (TABLE_NAME = 'customers' AND COLUMN_NAME = 'phone'))`
        );

        expect(indexes.filter(index => index.TABLE_NAME === 'orders')).toHaveLength(1);
        expect(indexes.filter(index => index.TABLE_NAME === 'customers')).toHaveLength(1);
        expect(indexes.every(index => Number(index.NON_UNIQUE) === 0)).toBe(true);
    });

    it('should recover duplicate checkouts atomically via idempotency key', async () => {
        await openShift();

        const cart = [
            { id: SEED.product2.id, qty: 1, price: SEED.product2.price } // total 2.00
        ];

        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 2.00,
            tax: 0.00,
            total: 2.00,
            payment_method: 'cash',
            amount_tendered: 2.00,
            change_due: 0,
            idempotency_key: 'my_unique_idempotency_key_1'
        };

        // First checkout (creates the order)
        const res1 = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res1.statusCode).toBe(200);
        expect(res1.body.success).toBe(true);
        const firstInvoiceId = res1.body.invoice_id;

        // Second checkout (duplicate idempotency key)
        const res2 = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res2.statusCode).toBe(200);
        expect(res2.body.success).toBe(true);
        expect(res2.body.message).toContain('duplicate request');
        expect(res2.body.invoice_id).toBe(firstInvoiceId);

        // Verify there is only ONE order stored in DB with this idempotency key
        const [orders] = await pool.query("SELECT * FROM orders WHERE idempotency_key = ?", ['my_unique_idempotency_key_1']);
        expect(orders).toHaveLength(1);
    });

    it('returns the idempotent response on a duplicate key without depending on the index name (Task 1)', async () => {
        await openShift();
        const key = 'idemp-recovery-1';
        const body = {
            cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
            shift_id: cashierShiftId,
            subtotal: 5.00, tax: 0.80, total: 5.80,
            payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
            idempotency_key: key
        };
        const first = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
        expect(first.statusCode).toBe(200);
        const second = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
        expect(second.statusCode).toBe(200);
        expect(second.body.invoice_id).toBe(first.body.invoice_id);
    });

    it('rejects the original duplicate error and destroys the connection when rollback fails', async () => {
        await openShift();
        const key = 'duplicate-rollback-failure';
        await pool.query(
            `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, idempotency_key)
             VALUES (?, ?, 2.00, 0.00, 2.00, 'cash', ?)`,
            [SEED.cashierUser.id, cashierShiftId, key]
        );
        const connection = rejectDuplicateRollback();
        const logSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
        let response;
        let loggedOriginalError = false;

        try {
            response = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                    shift_id: cashierShiftId,
                    subtotal: 2.00,
                    tax: 0.00,
                    total: 2.00,
                    payment_method: 'cash',
                    amount_tendered: 2.00,
                    change_due: 0,
                    idempotency_key: key
                });
            loggedOriginalError = logSpy.mock.calls.some(([details, message]) =>
                details?.err?.code === 'ER_DUP_ENTRY' && message === 'Checkout failed.'
            );
        } finally {
            connection.restore();
            logSpy.mockRestore();
        }

        expect(connection.state).toMatchObject({
            preflightHidden: true,
            rollbackAttempted: true,
            released: false,
            destroyed: true
        });
        expect(response.statusCode).toBe(500);
        expect(response.body).toMatchObject({
            success: false,
            message: 'Checkout failed. Please try again and contact support if the issue persists.'
        });
        expect(response.body.message).not.toContain('duplicate request');
        expect(loggedOriginalError).toBe(true);
    });

    it('rejects an idempotency key owned by another cashier', async () => {
        await openShift();
        const key = 'cashier-owned-checkout-attempt';
        const body = {
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            shift_id: cashierShiftId,
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            idempotency_key: key
        };
        const first = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
        expect(first.statusCode).toBe(200);

        const second = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            ...body,
            shift_id: null
        });

        expect(second.statusCode).toBe(409);
        const [orders] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key = ?', [key]);
        expect(orders).toHaveLength(1);
    });

    it('replays the original sale when the same cashier retries a key from another shift', async () => {
        await openShift();
        const firstShiftId = cashierShiftId;
        const key = 'shift-owned-checkout-attempt';
        const body = {
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            shift_id: firstShiftId,
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            idempotency_key: key
        };
        const first = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
        expect(first.statusCode).toBe(200);

        await pool.query("UPDATE shifts SET status='closed', closed_at=NOW() WHERE id = ?", [firstShiftId]);
        await openShift();
        const retry = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            ...body,
            shift_id: cashierShiftId
        });

        expect(retry.statusCode).toBe(200);
        expect(retry.body.duplicate).toBe(true);
        expect(retry.body.invoice_id).toBe(first.body.invoice_id);
        const [orders] = await pool.query('SELECT invoice_id, shift_id FROM orders WHERE idempotency_key = ?', [key]);
        expect(orders).toHaveLength(1);
        expect(String(orders[0].shift_id)).toBe(String(firstShiftId));
    });

    it('lets a lost-response replay of a payload sent with a closed shift find the rerouted sale', async () => {
        const closedShiftId = await openShift();
        await pool.query("UPDATE shifts SET status='closed', closed_at=NOW() WHERE id = ?", [closedShiftId]);
        const currentShiftId = await openShift();
        const key = 'rerouted-lost-response-attempt';
        const body = {
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            shift_id: closedShiftId,
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            idempotency_key: key
        };
        const first = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
        expect(first.statusCode).toBe(200);
        const [committed] = await pool.query('SELECT shift_id FROM orders WHERE idempotency_key = ?', [key]);
        expect(String(committed[0].shift_id)).toBe(String(currentShiftId));

        const status = await request(app).post('/api/pos/checkout/jofotara/status')
            .set('Cookie', cashierCookie)
            .send({ idempotency_key: key, shift_id: closedShiftId });
        expect(status.statusCode).toBe(200);

        const replay = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
        expect(replay.statusCode).toBe(200);
        expect(replay.body.duplicate).toBe(true);
        expect(replay.body.invoice_id).toBe(first.body.invoice_id);
        const [orders] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key = ?', [key]);
        expect(orders).toHaveLength(1);

        const other = await request(app).post('/api/pos/checkout/jofotara/status')
            .set('Cookie', adminCookie)
            .send({ idempotency_key: key, shift_id: closedShiftId });
        expect(other.statusCode).toBe(409);
    });

    it('rejects an idempotency key longer than the orders column', async () => {
        await openShift();
        const response = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            shift_id: cashierShiftId,
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            idempotency_key: 'x'.repeat(81)
        });

        expect(response.statusCode).toBe(400);
        expect(response.body.message).toMatch(/idempotency/i);
    });


    it('should block editing financial details of an order once its shift is closed', async () => {
        await openShift();

        // 1. Create order
        const cart = [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }];
        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 2.00,
            tax: 0.00,
            total: 2.00,
            payment_method: 'cash',
            amount_tendered: 2.00,
            change_due: 0
        };

        const res1 = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);
        const invoiceId = res1.body.invoice_id;

        // 2. Close the shift
        const closeRes = await request(app)
            .put('/api/auth/shifts?action=close')
            .set('Cookie', cashierCookie)
            .send({ actual_cash: 52.00, shift_id: cashierShiftId });
        expect(closeRes.statusCode).toBe(200);

        // 3. Login as admin to edit finalized order
        const adminLoginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminLoginRes.headers['set-cookie'][0];

        // 4. Try to edit order from closed shift with modified financial details (price change)
        const modifiedCart = [{ id: SEED.product2.id, qty: 1, price: 3.00 }]; // price increased from 2.00 to 3.00
        const modifiedPayload = {
            edit_invoice_id: invoiceId,
            edit_order_id: res1.body.order_id,
            cart: modifiedCart,
            shift_id: cashierShiftId,
            subtotal: 3.00,
            tax: 0.00,
            total: 3.00,
            payment_method: 'cash',
            amount_tendered: 3.00,
            change_due: 0
        };

        const res2 = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send(modifiedPayload);

        // JoFotara compliance: a finalized invoice is immutable for everyone, admin included —
        // the finalized-order guard rejects the edit before any closed-shift logic is reached.
        expect(res2.statusCode).toBe(403);
        expect(res2.body.success).toBe(false);
        expect(res2.body.message).toContain('Finalized invoices cannot be edited');
    });

    it('should return 400 when cart is empty', async () => {
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({ cart: [] });

        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain('empty');
    });

    it('rejects a reduced cart when cashing out a table (settle-only)', async () => {
        await openShift();

        // Seed an unpaid table order with 2 burgers directly (cashier cannot create one).
        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (700001, ?, ?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 2, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await bindLiveTableOrder(SEED.table.id, invoiceId);

        // Cashier settles with only 1 burger — a reduction at settle.
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table.id
            });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toContain('Items cannot be changed while cashing out');

        // Order untouched
        const [rows] = await pool.query("SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]);
        expect(rows[0].payment_method).toBe('unpaid_table');
    });

    it('blocks creating a brand-new order on an empty table at checkout', async () => {
        await openShift();

        // Cashier opens an empty table, adds an item, and hits Pay — no edit_invoice_id
        // because the table has no saved order. This must be rejected: a table order has
        // to be taken at the table (POST /table_order) before it can be cashed out.
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table.id
            });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toContain('taken at the table first');

        // No order was created on that table.
        const [rows] = await pool.query(
            "SELECT COUNT(*) AS c FROM orders WHERE table_id = ? AND payment_method = 'cash'",
            [SEED.table.id]
        );
        expect(Number(rows[0].c)).toBe(0);
    });

    it('rejects an online checkout whose total is tampered below the item sum', async () => {
        await openShift();
        // Honest line items + subtotal (1x Test Burger @5.00, 16% tax => 5.80) but a
        // deflated client total. assertNearMoney('Total', 1.00, 5.80) fires before
        // validatePayments, giving a clear "Total mismatch" error.
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 1.00,
                payment_method: 'cash', amount_tendered: 1.00, change_due: 0
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Total mismatch/i);
    });

    it('cannot forge a split-settle via parent_invoice_id to ring up a new table order', async () => {
        await openShift();
        // Empty table, no edit_invoice_id, no real split_check_id — only a forged
        // parent_invoice_id. The create-gate must still block this (kitchen bypass).
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table.id,
                parent_invoice_id: 999999
            });
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toContain('taken at the table first');

        const [rows] = await pool.query(
            "SELECT COUNT(*) AS c FROM orders WHERE table_id = ? AND payment_method = 'cash'",
            [SEED.table.id]
        );
        expect(Number(rows[0].c)).toBe(0);
    });

    it('ignores client parent_invoice_id on a normal register sale', async () => {
        await openShift();
        const [parent] = await pool.query(
            `INSERT INTO orders (user_id, waiter_id, subtotal, tax, total, payment_method)
             VALUES (?, ?, 2.00, 0, 2.00, 'cash')`,
            [SEED.adminUser.id, SEED.adminUser.id]
        );

        const response = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            shift_id: cashierShiftId,
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            parent_invoice_id: parent.insertId,
            idempotency_key: 'normal-register-forged-parent'
        });

        expect(response.statusCode).toBe(200);
        const [[order]] = await pool.query(
            'SELECT waiter_id, parent_invoice_id FROM orders WHERE invoice_id = ?',
            [response.body.invoice_id]
        );
        expect(order).toEqual({ waiter_id: SEED.cashierUser.id, parent_invoice_id: null });
    });

    it('atomically reuses one customer when simultaneous sales submit the same new phone', async () => {
        const phone = '0797000001';
        const restorePool = synchronizeCustomerLookups(phone);
        const sale = key => request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            customer_phone: phone,
            customer_name: 'Race Customer',
            customer_address: 'Amman',
            idempotency_key: key
        });

        let responses;
        try {
            responses = await Promise.all([
                sale('customer-race-attempt-1'),
                sale('customer-race-attempt-2')
            ]);
        } finally {
            restorePool();
        }

        expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
        const [[customerCount]] = await pool.query('SELECT COUNT(*) AS count FROM customers WHERE phone = ?', [phone]);
        const [[orderCount]] = await pool.query(
            'SELECT COUNT(*) AS count FROM orders WHERE idempotency_key IN (?, ?)',
            ['customer-race-attempt-1', 'customer-race-attempt-2']
        );
        expect(Number(customerCount.count)).toBe(1);
        expect(Number(orderCount.count)).toBe(2);
    });

    it('reuses one normalized customer when checkout submits a formatted variant', async () => {
        const [existing] = await pool.query(
            "INSERT INTO customers (phone,name,address) VALUES ('079-123 4567','Old name','Old address')"
        );
        const response = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            customer_phone: '079 123-4567',
            customer_name: 'Updated name',
            customer_address: 'Updated address',
            idempotency_key: 'normalized-customer-reuse'
        });

        expect(response.statusCode).toBe(200);
        const [customers] = await pool.query(
            "SELECT id,name,address FROM customers WHERE phone_normalized='0791234567' ORDER BY id"
        );
        expect(customers).toEqual([{ id: existing.insertId, name: 'Updated name', address: 'Updated address' }]);
        const [[order]] = await pool.query(
            "SELECT customer_id FROM orders WHERE idempotency_key='normalized-customer-reuse'"
        );
        expect(Number(order.customer_id)).toBe(Number(existing.insertId));
    });

    it('accepts any number as the customer phone, however short, and finds the customer by it again', async () => {
        const response = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            customer_phone: '123',
            customer_name: 'House customer',
            idempotency_key: 'short-customer-phone'
        });

        expect(response.statusCode).toBe(200);
        const [[order]] = await pool.query(
            "SELECT o.customer_id, c.phone_normalized, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.idempotency_key='short-customer-phone'"
        );
        expect(order).toMatchObject({ phone_normalized: '123', name: 'House customer' });
        const lookup = await request(app).get('/api/pos/customer_lookup?phone=123').set('Cookie', adminCookie);
        expect(lookup.statusCode).toBe(200);
        expect(lookup.body.customer).toMatchObject({ name: 'House customer' });
    });

    it('refuses checkout when legacy rows make the normalized customer identity ambiguous', async () => {
        await pool.query(`INSERT INTO customers (phone,name) VALUES
            ('079-123 4567','First duplicate'),('079 123-4567','Second duplicate')`);
        const response = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
            subtotal: 2.00, tax: 0, total: 2.00,
            payment_method: 'cash', amount_tendered: 2.00, change_due: 0,
            customer_phone: '0791234567',
            customer_name: 'Unsafe overwrite',
            idempotency_key: 'normalized-customer-ambiguous'
        });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('CUSTOMER_PHONE_AMBIGUOUS');
        const [[orders]] = await pool.query(
            "SELECT COUNT(*) AS count FROM orders WHERE idempotency_key='normalized-customer-ambiguous'"
        );
        expect(Number(orders.count)).toBe(0);
    });

    it('settles a table when the cart matches the saved items exactly', async () => {
        await openShift();

        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (700002, ?, ?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table2.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 2, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await bindLiveTableOrder(SEED.table2.id, invoiceId);

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 10.00, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 11.60, change_due: 0,
                table_id: SEED.table2.id
            });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const [[order]] = await pool.query('SELECT payment_method, total FROM orders WHERE invoice_id = ?', [invoiceId]);
        expect(order.payment_method).toBe('cash');
        expect(Number(order.total)).toBe(11.6);
        const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table2.id]);
        expect(table).toEqual({ status: 'available', current_order_id: null });
    });

    it('settles a saved table with its historical order type after that type is deactivated', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Former Type', 0, 0)"
        );
        const [ins] = await pool.query(
            `INSERT INTO orders
                (order_id, user_id, waiter_id, table_id, shift_id, order_type_id,
                 subtotal, tax, total, payment_method, created_at)
             VALUES (700003, ?, ?, ?, ?, 3, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table2.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await bindLiveTableOrder(SEED.table2.id, invoiceId);

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                order_type_id: 3,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table2.id
            });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, payment_method: 'cash' });
    });

    it('rejects table settlement when line IDs are swapped across products', async () => {
        await openShift();
        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at)
             VALUES (700004, ?, ?, ?, ?, 7.00, 0.80, 7.80, 'unpaid_table', 0, NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        const [burgerResult] = await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        const [drinkResult] = await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Drink', 1, 2.00, 0, '')",
            [invoiceId, SEED.product2.id]
        );
        await bindLiveTableOrder(SEED.table.id, invoiceId);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            edit_invoice_id: invoiceId,
            cart: [
                { id: SEED.product1.id, order_item_id: drinkResult.insertId, qty: 1, price: 5 },
                { id: SEED.product2.id, order_item_id: burgerResult.insertId, qty: 1, price: 2 }
            ],
            shift_id: cashierShiftId,
            subtotal: 7.00,
            tax: 0.32,
            total: 7.32,
            payment_method: 'cash',
            amount_tendered: 7.32,
            change_due: 0,
            table_id: SEED.table.id
        });

        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/refresh/i);
    });

    it('order_id business date follows settle time across 06:00 in shared sequence mode', async () => {
        await openShift();

        await pool.query(
            `INSERT INTO daily_sequences (sequence_date, current_value)
             VALUES ('2026-06-30', 7), ('2026-07-01', 0)
             ON DUPLICATE KEY UPDATE current_value = VALUES(current_value)`
        );

        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', '2026-07-01 02:58:00')`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await bindLiveTableOrder(SEED.table.id, invoiceId);

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-07-01T03:02:00Z'));

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table.id
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.order_id).toBe(1);

        const [[order]] = await pool.query(
            'SELECT order_id, order_seq_scope, created_at, invoice_issued_at FROM orders WHERE invoice_id = ?',
            [invoiceId]
        );
        expect(order.order_id).toBe(1);
        expect(order.order_seq_scope).toBe('date:2026-07-01');
        expect(order.created_at).toEqual(new Date('2026-07-01T02:58:00Z'));
        expect(order.invoice_issued_at).toEqual(new Date('2026-07-01T03:02:00Z'));
    });

    it('returns the original success payload when a settled table checkout is retried with the same idempotency key', async () => {
        await openShift();

        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (700005, ?, ?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table2.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 2, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await bindLiveTableOrder(SEED.table2.id, invoiceId);

        const payload = {
            edit_invoice_id: invoiceId,
            cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
            shift_id: cashierShiftId,
            subtotal: 10.00, tax: 1.60, total: 11.60,
            payment_method: 'cash', amount_tendered: 11.60, change_due: 0,
            table_id: SEED.table2.id,
            idempotency_key: 'table-settle-idem-retry-1'
        };

        const first = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);
        expect(first.statusCode).toBe(200);
        expect(first.body.success).toBe(true);

        const retry = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(retry.statusCode).toBe(200);
        expect(retry.body.success).toBe(true);
        expect(retry.body.message).toMatch(/duplicate request/i);
        expect(retry.body.invoice_id).toBe(first.body.invoice_id);
        expect(retry.body.order_id).toBe(first.body.order_id);
    });

    it('lets a cashier settle a table with a server-bound service charge without apply-service-charge permission', async () => {
        // The snapshot freezes the rates that authorized the saved fee.
        await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'service_charge_enabled'");
        await openShift();
        await pool.query(
            "DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'pos.service_charge'",
            [SEED.cashierUser.id]
        );
        invalidateUserSessions(SEED.cashierUser.id);

        // Seed an unpaid table order: 1 drink + a saved Auto-Gratuity line.
        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, subtotal, tax, total, payment_method, created_at)
             VALUES (700006, ?, ?, ?, 2.20, 0.00, 2.20, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id]
        );
        const invoiceId = ins.insertId;
        const snapshotId = '00000000-0000-4000-8000-000000000636';
        await pool.query(`INSERT INTO service_charge_snapshots
            (id, percentage, tax_rate, state, holder_type, holder_id, created_by)
            VALUES (?, 10, 0, 'open_order', 'order', ?, ?)`,
        [snapshotId, String(invoiceId), SEED.adminUser.id]);
        await pool.query('UPDATE orders SET service_charge_snapshot_id=? WHERE invoice_id=?', [snapshotId, invoiceId]);
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Drink', 1, 2.00, 0, '')",
            [invoiceId, SEED.product2.id]
        );
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, NULL, '10% Service Charge', 1, 0.20, 0, 'Auto-Gratuity')",
            [invoiceId]
        );
        await bindLiveTableOrder(SEED.table.id, invoiceId);

        // Settle sending the SAME items (drink + service charge), unchanged.
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [
                    { id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0, note: '' },
                    { id: 'FEE_1', qty: 1, price: 0.20, tax_rate: 0, note: 'Auto-Gratuity' }
                ],
                service_charge_snapshot: { id: snapshotId, version: 1 },
                shift_id: cashierShiftId,
                subtotal: 2.20, tax: 0.00, total: 2.20,
                payment_method: 'cash', amount_tendered: 2.20, change_due: 0,
                table_id: SEED.table.id
            });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        const [[order]] = await pool.query('SELECT payment_method, total FROM orders WHERE invoice_id = ?', [invoiceId]);
        expect(order.payment_method).toBe('cash');
        expect(Number(order.total)).toBe(2.2);
        const [[fee]] = await pool.query(
            "SELECT price_at_sale FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity'",
            [invoiceId]
        );
        expect(Number(fee.price_at_sale)).toBe(0.2);
        const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table.id]);
        expect(table).toEqual({ status: 'available', current_order_id: null });
    });

    // 2. Discount checks (prohibits discount without privilege or override)
    it('should enforce discount permissions (Admin allowed without PIN, Cashier requires manager PIN override)', async () => {
        await openShift();

        // Step 1: Login Admin
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        const cart = [
            { id: SEED.product2.id, qty: 1, price: SEED.product2.price } // Drink = 2.00
        ];

        // 10% discount: total = 1.80
        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 2.00,
            tax: 0.00,
            total: 1.80,
            payment_method: 'cash',
            amount_tendered: 2.00,
            change_due: 0.20,
            order_discount_type: 'percent',
            order_discount_value: 10
        };

        // Admin checks out with discount -> allowed immediately without manager PIN override
        const resAdmin = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({ ...payload, idempotency_key: 'admin_discount_key' });
        expect(resAdmin.statusCode).toBe(200);
        expect(resAdmin.body.success).toBe(true);

        // Cashier checks out with discount -> rejected with 403 unless PIN provided
        const resCashierNoPin = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({ ...payload, idempotency_key: 'cashier_discount_no_pin' });
        expect(resCashierNoPin.statusCode).toBe(403);
        expect(resCashierNoPin.body.message).toContain('Manager PIN required to apply discounts');

        // Cashier checks out with discount and manager PIN -> allowed
        const resCashierWithPin = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({ ...payload, manager_pin: SEED.adminUser.pin, idempotency_key: 'cashier_discount_with_pin' });
        expect(resCashierWithPin.statusCode).toBe(200);
        expect(resCashierWithPin.body.success).toBe(true);
    });

    // 3. Service charge validation
    it('should validate service charge calculations and reject checkouts on settings mismatches', async () => {
        await openShift();

        // Step 1: Enable service charge settings in DB
        await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'service_charge_enabled'");
        await pool.query("UPDATE settings SET setting_value = '10' WHERE setting_key = 'service_charge_percentage'");
        await pool.query("UPDATE settings SET setting_value = '16' WHERE setting_key = 'service_charge_tax_rate'");

        const cart = [
            { id: SEED.product1.id, qty: 1, price: SEED.product1.price }, // burger: 5.00, 16% tax -> 5.80
            {
                id: 'FEE_1',
                name: '10% Service Charge',
                price: 0.50, // 10% of 5.00 is 0.50
                qty: 1,
                tax_rate: 16,
                note: 'Auto-Gratuity'
            }
        ];

        // Total: Subtotal = 5.50 (5.00 + 0.50 fee). Tax: burger = 0.80, fee = 0.08. Total = 6.38
        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 5.50,
            tax: 0.88,
            total: 6.38,
            payment_method: 'cash',
            amount_tendered: 10.00,
            change_due: 3.62
        };

        // Without the pos.service_charge grant the cashier is forbidden from applying it
        // (this gate runs before the price validation below).
        const resNoPerm = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({ ...JSON.parse(JSON.stringify(payload)), idempotency_key: 'svc_charge_no_perm' });
        expect(resNoPerm.statusCode).toBe(403);

        // Grant the permission for the remaining price-validation checks. Evict the cached
        // session so requireAuth reloads the cashier's permissions from the DB on next request.
        await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'pos.service_charge')", [SEED.cashierUser.id]);
        invalidateUserSessions(SEED.cashierUser.id);
        const snapshotId = '00000000-0000-4000-8000-000000000101';
        await pool.query(`INSERT INTO service_charge_snapshots
            (id, percentage, tax_rate, state, holder_type, created_by, version, expires_at)
            VALUES (?, 10, 16, 'draft', 'none', ?, 1, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
            [snapshotId, SEED.cashierUser.id]);
        payload.service_charge_snapshot = { id: snapshotId, version: 1 };

        // Try with mismatched fee price (e.g. 0.40 instead of 0.50)
        const mismatchedPayload = JSON.parse(JSON.stringify(payload));
        mismatchedPayload.cart[1].price = 0.40;
        mismatchedPayload.subtotal = 5.40;
        mismatchedPayload.total = 6.26;
        const resMismatch = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(mismatchedPayload);
        expect(resMismatch.statusCode).toBe(409); // exact canonical fee mismatch

        // Success path with correct service charge calculations
        const resSuccess = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({ ...payload, idempotency_key: 'svc_charge_with_perm' });
        expect(resSuccess.statusCode).toBe(200);
        expect(resSuccess.body.success).toBe(true);

        // F1 — a correct unit price with an inflated qty must still be rejected: the fee is
        // anchored on the SUMMED line-total (0.50 × 10 = 5.00 injected), not the unit price.
        const qtyBypass = JSON.parse(JSON.stringify(payload));
        qtyBypass.cart[1].qty = 10;      // 0.50 × 10 = 5.00 fee total, expected 0.50
        qtyBypass.subtotal = 10.00;      // 5.00 burger + 5.00 fee
        qtyBypass.tax = 1.60;            // 0.80 burger + 0.80 fee (both 16%)
        qtyBypass.total = 11.60;
        qtyBypass.idempotency_key = 'svc_charge_qty_bypass';
        const qtySnapshotId = '00000000-0000-4000-8000-000000000102';
        await pool.query(`INSERT INTO service_charge_snapshots
            (id, percentage, tax_rate, state, holder_type, created_by, version, expires_at)
            VALUES (?, 10, 16, 'draft', 'none', ?, 1, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
            [qtySnapshotId, SEED.cashierUser.id]);
        qtyBypass.service_charge_snapshot = { id: qtySnapshotId, version: 1 };
        const resQtyBypass = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(qtyBypass);
        expect(resQtyBypass.statusCode).toBe(400);
        expect(resQtyBypass.body.message).toMatch(/service.?charge/i);

        // Reset settings and the granted permission
        await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'service_charge_enabled'");
        await pool.query("DELETE FROM user_permissions WHERE user_id = ? AND perm_key = 'pos.service_charge'", [SEED.cashierUser.id]);
        invalidateUserSessions(SEED.cashierUser.id);
    });

    describe('Socket.IO Isolation Checks', () => {
        it('should broadcast new_order and inventory_changed strictly to staff room post-commit', async () => {
            await openShift();
            // Enable stock setting in DB so both events fire
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'stock_enabled'");

            const payload = {
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 10.00,
                change_due: 4.20
            };

            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(payload);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify Socket.IO staff room isolation for new_order and inventory_changed
            expect(global.__mockTo__).toHaveBeenCalledWith('staff');
            expect(global.__mockEmit__).toHaveBeenCalledWith('new_order', expect.any(Object));
            await vi.waitFor(() => expect(global.__mockEmit__).toHaveBeenCalledWith('inventory_changed', { scope: 'stock', productIds: [SEED.product1.id] }));

            // Reset stock setting
            await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'stock_enabled'");
        });
    });

    it('should rollback transaction and release connection back to pool on unexpected database query failures', async () => {
        await openShift();

        const originalGetConnection = pool.getConnection;
        let released = false;
        let rolledBack = false;

        pool.getConnection = async function() {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            const originalRollback = conn.rollback;
            const originalRelease = conn.release;

            conn.query = async function(sql, params) {
                if (typeof sql === 'string' && sql.includes('FROM order_types')) {
                    throw new Error('Database crash simulated');
                }
                return originalQuery.call(this, sql, params);
            };

            conn.rollback = async function() {
                rolledBack = true;
                return originalRollback.call(this);
            };

            conn.release = function() {
                released = true;
                conn.query = originalQuery;
                conn.rollback = originalRollback;
                conn.release = originalRelease;
                pool.getConnection = originalGetConnection;
                return originalRelease.call(this);
            };

            return conn;
        };

        const cart = [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }];
        const payload = {
            cart,
            shift_id: cashierShiftId,
            subtotal: 5.00,
            tax: 0.80,
            total: 5.80,
            payment_method: 'cash',
            amount_tendered: 10.00,
            change_due: 4.20,
            order_type_id: 1,
            order_type_is_deferred_settlement: false
        };

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(res.statusCode).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toBe("Checkout failed. Please try again and contact support if the issue persists.");

        expect(rolledBack).toBe(true);
        expect(released).toBe(true);

    });

    it('checkout response carries server-authoritative subtotal/tax/total', async () => {
      await openShift();
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Cookie', cashierCookie)
        .send({
          cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
          shift_id: cashierShiftId,
          subtotal: 5.00,
          tax: 0.01,
          total: 5.80,
          payment_method: 'cash',
          amount_tendered: 10.00,
          change_due: 4.20
        });
      expect(res.statusCode).toBe(200);
      expect(Number(res.body.tax)).toBeCloseTo(0.80, 2);
      expect(Number(res.body.total)).toBeCloseTo(5.80, 2);
      expect(Number(res.body.subtotal)).toBeCloseTo(5.00, 2);
      expect(res.body.payment_method).toBe('cash');
      expect(Number(res.body.amount_tendered)).toBeCloseTo(10.00, 2);
    });

    it('checkout rejects when client total diverges from server total (B4 guard)', async () => {
      await openShift();
      // Server total = 5.80 (burger 5.00 + 16% tax 0.80).
      // Send client total wrong by ~1.70 but amount_tendered/change_due self-consistent
      // with the SERVER total so validatePayments passes cleanly — only
      // assertNearMoney('Total') can fire, proving the guard is not vacuous.
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Cookie', cashierCookie)
        .send({
          cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
          shift_id: cashierShiftId,
          subtotal: 5.00,
          tax: 0.80,
          total: 4.10,        // tampered: ~1.70 below server total 5.80
          payment_method: 'cash',
          amount_tendered: 5.80,  // consistent with SERVER total
          change_due: 0.00         // consistent: 5.80 - 5.80 = 0
        });
      expect(res.statusCode).toBe(400);
      // Must match specifically "Total mismatch", not any error containing "total"
      expect(res.body.message).toMatch(/Total mismatch/i);
    });

    it('checkout response carries real discount amount for discounted orders (Finding 1)', async () => {
      await openShift();
      // 10% order discount on burger (5.00):
      //   discountedSubtotal = 5.00 * 0.90 = 4.50
      //   discount amount    = 5.00 - 4.50 = 0.50
      //   tax                = 4.50 * 16%  = 0.72
      //   total              = 4.50 + 0.72 = 5.22
      // Cashier needs manager PIN for discount permission.
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Cookie', cashierCookie)
        .send({
          cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
          shift_id: cashierShiftId,
          subtotal: 5.00,
          tax: 0.72,
          total: 5.22,
          payment_method: 'cash',
          amount_tendered: 5.22,
          change_due: 0.00,
          order_discount_type: 'percent',
          order_discount_value: 10,
          manager_pin: SEED.adminUser.pin,
          idempotency_key: 'discount_amount_f1_test'
        });
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      // Pre-fix this was always 0 because calculateExpectedTotals returned no discount key.
      expect(Number(res.body.discount)).toBeCloseTo(0.50, 2);
    });

    it('records line and order discounts on a register checkout with the authorizing manager', async () => {
      await openShift();
      const res = await request(app)
        .post('/api/pos/checkout')
        .set('Cookie', cashierCookie)
        .send({
          cart: [{
            id: SEED.product1.id,
            qty: 2,
            price: SEED.product1.price,
            discountType: 'percent',
            discountValue: 10
          }],
          shift_id: cashierShiftId,
          subtotal: 9.00,
          tax: 1.28,
          total: 9.28,
          payment_method: 'cash',
          amount_tendered: 10.00,
          change_due: 0.72,
          order_discount_type: 'fixed',
          order_discount_value: 1,
          manager_pin: SEED.adminUser.pin,
          idempotency_key: 'discount-audit-register'
        });

      expect(res.statusCode).toBe(200);
      const [events] = await pool.query(
        `SELECT event_type, user_id, manager_id, old_value, new_value
           FROM audit_events
          WHERE entity_type='order' AND entity_id=?
            AND event_type IN ('line_discount_changed', 'order_discount_changed')
          ORDER BY event_type`,
        [res.body.invoice_id]
      );
      expect(events).toHaveLength(2);
      expect(events.every(event => event.user_id === SEED.cashierUser.id)).toBe(true);
      expect(events.every(event => event.manager_id === SEED.adminUser.id)).toBe(true);

      const lineEvent = events.find(event => event.event_type === 'line_discount_changed');
      expect(lineEvent.old_value).toBeNull();
      expect(JSON.parse(lineEvent.new_value)).toMatchObject({
        line: {
          product_id: SEED.product1.id,
          item_name: SEED.product1.name,
          quantity: 2,
          unit_price: Number(SEED.product1.price)
        },
        discount: { type: 'percent', value: 10, amount: 1 }
      });

      const orderEvent = events.find(event => event.event_type === 'order_discount_changed');
      expect(orderEvent.old_value).toBeNull();
      expect(JSON.parse(orderEvent.new_value)).toEqual({ type: 'fixed', value: 1, amount: 1 });
    });

    // D1 — price-override capability gate (applyDatabasePrices keys on canPriceOverride, not isAdminUser)
    it('non-admin with pos.price_override can checkout at a manual price (B2 fix)', async () => {
        // priceOverrideUser is cashier role, explicitly holds pos.price_override
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.priceOverrideUser.user_number });
        const overrideCookie = loginRes.headers['set-cookie'][0];

        const shiftRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', overrideCookie)
            .send({ user_id: SEED.priceOverrideUser.id, starting_cash: 0 });
        expect(shiftRes.statusCode).toBe(200);

        const [shiftRows] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.priceOverrideUser.id]
        );
        const overrideShiftId = shiftRows[0].id;

        // Product1 DB price = 5.00. Manual price = 8.00.
        // subtotal=8.00, tax=8.00*16%=1.28, total=9.28
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', overrideCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 8.00 }],
                shift_id: overrideShiftId,
                subtotal: 8.00,
                tax: 1.28,
                total: 9.28,
                payment_method: 'cash',
                amount_tendered: 10.00,
                change_due: 0.72
            });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        // Confirm DB stores the MANUAL price (not reset to 5.00)
        const [orders] = await pool.query("SELECT subtotal, total FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
        expect(Number(orders[0].subtotal)).toBeCloseTo(8.00, 2);
        expect(Number(orders[0].total)).toBeCloseTo(9.28, 2);
    });

    it('F3: records a price_override audit row when a manager sets a manual price', async () => {
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.priceOverrideUser.user_number });
        const overrideCookie = loginRes.headers['set-cookie'][0];

        // Ensure we open a shift if not already open
        await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', overrideCookie)
            .send({ user_id: SEED.priceOverrideUser.id, starting_cash: 0 });

        const [shiftRows] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.priceOverrideUser.id]
        );
        const overrideShiftId = shiftRows[0].id;

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', overrideCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 1.00 }], // DB base is 5.00
                shift_id: overrideShiftId,
                subtotal: 1.00, tax: 0.16, total: 1.16,
                payment_method: 'cash', amount_tendered: 1.16, change_due: 0.00,
                order_discount_type: null, order_discount_value: 0,
                idempotency_key: `f3_override_${Date.now()}`
            });

        expect(res.statusCode).toBe(200);

        const [audits] = await pool.query(
            "SELECT old_value, new_value FROM audit_events WHERE event_type = 'price_override' AND entity_id = ?",
            [SEED.product1.id]
        );
        expect(audits.length).toBe(1);
        expect(JSON.parse(audits[0].new_value).override).toBe(1);
    });

    it('cashier without pos.price_override is blocked (400) on manual price subtotal (anti-tamper)', async () => {
        // Standard cashier (id=2) has no pos.price_override.
        // Off-price subtotal is rejected by the subtotal assert.
        await openShift();
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 8.00 }],
                shift_id: cashierShiftId,
                subtotal: 8.00,
                tax: 1.28,
                total: 9.28,
                payment_method: 'cash',
                amount_tendered: 10.00,
                change_due: 0.72
            });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('Subtotal mismatch');
    });

    it('cashier without pos.price_override succeeds with base subtotal but price resets to DB base', async () => {
        await openShift();
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 8.00 }],
                shift_id: cashierShiftId,
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 10.00,
                change_due: 4.20
            });
        expect(res.statusCode).toBe(200);

        // Confirm DB stores the base price (5.00), not the manual price (8.00)
        const [orders] = await pool.query("SELECT subtotal, total FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
        expect(Number(orders[0].subtotal)).toBeCloseTo(5.00, 2);
    });

    // ── Public Invoice Number tests (Task 3) ──────────────────────────────────

    it('assigns a public invoice_number to a normal register checkout', async () => {
        await openShift();

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
                subtotal: 5,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 5.80,
                change_due: 0,
                shift_id: cashierShiftId,
                idempotency_key: 'invoice-number-register-1'
            });

        expect(res.body.success).toBe(true);
        expect(res.body.invoice_id).toBeTruthy();
        expect(res.body.order_id).toBeTruthy();
        expect(res.body.invoice_number).toBe(1);
        expect(res.body.invoice_display_no).toBe('1');

        const [[order]] = await pool.query(
            'SELECT invoice_id, order_id, invoice_number, invoice_issued_at FROM orders WHERE invoice_id = ?',
            [res.body.invoice_id]
        );
        expect(order.invoice_number).toBe(1);
        expect(order.invoice_issued_at).toBeTruthy();
    });

    it('idempotent retry returns the same public invoice_number', async () => {
        await openShift();

        const payload = {
            cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
            subtotal: 5,
            tax: 0.80,
            total: 5.80,
            payment_method: 'cash',
            amount_tendered: 5.80,
            change_due: 0,
            shift_id: cashierShiftId,
            idempotency_key: 'invoice-number-idem-1'
        };

        const first = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(payload);
        const second = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(payload);

        expect(second.body.success).toBe(true);
        expect(second.body.invoice_id).toBe(first.body.invoice_id);
        expect(second.body.invoice_number).toBe(first.body.invoice_number);
        expect(second.body.invoice_display_no).toBe(String(first.body.invoice_number));
    });

    it('concurrent register checkouts receive unique public invoice numbers', async () => {
        await openShift();

        const requests = Array.from({ length: 5 }, (_, i) =>
            request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
                    subtotal: 5,
                    tax: 0.80,
                    total: 5.80,
                    payment_method: 'cash',
                    amount_tendered: 5.80,
                    change_due: 0,
                    shift_id: cashierShiftId,
                    idempotency_key: `invoice-number-concurrent-${i}`
                })
        );

        const responses = await Promise.all(requests);
        const numbers = responses.map(r => r.body.invoice_number).sort((a, b) => a - b);
        expect(new Set(numbers).size).toBe(5);
        expect(numbers.every(n => Number.isInteger(n) && n > 0)).toBe(true);
    });

    it('paid split-check child receives its own public invoice number', async () => {
        await openShift();

        const [parent] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
             VALUES (44, ?, ?, ?, ?, 10, 0, 10, 'unpaid_table')`,
            [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id, cashierShiftId]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                is_split: true,
                parent_invoice_id: parent.insertId,
                parent_order_id: 44,
                cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
                subtotal: 5,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 5.80,
                change_due: 0,
                shift_id: cashierShiftId,
                idempotency_key: 'invoice-number-split-child-1'
            });

        expect(res.body.success).toBe(true);
        expect(res.body.invoice_number).toBeTruthy();
        expect(res.body.invoice_display_no).toBe(String(res.body.invoice_number));

        const [[parentOrder]] = await pool.query(
            'SELECT invoice_number FROM orders WHERE invoice_id = ?',
            [parent.insertId]
        );
        expect(parentOrder.invoice_number).toBeNull();
    });

    it('fresh checkout over an old table ghost voids the ghost without burning an invoice number', async () => {
        await openShift();

        // Admin bypasses the table-create gate (cashier cannot create new orders on a table)
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        const [ghost] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
             VALUES (55, ?, ?, ?, ?, 10, 0, 10, 'unpaid_table')`,
            [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id, cashierShiftId]
        );

        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
             VALUES (?, ?, ?, 1, 10, 0, 0)`,
            [ghost.insertId, SEED.product1.id, SEED.product1.name]
        );

        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [ghost.insertId, SEED.table.id]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
                subtotal: 5,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 5.80,
                change_due: 0,
                shift_id: cashierShiftId,
                idempotency_key: 'invoice-number-table-ghost-1'
            });

        expect(res.body.success).toBe(true);
        expect(res.body.invoice_id).not.toBe(ghost.insertId);
        expect(res.body.invoice_number).toBeTruthy();

        const [[ghostOrder]] = await pool.query(
            'SELECT payment_method, invoice_number, total FROM orders WHERE invoice_id = ?',
            [ghost.insertId]
        );
        expect(ghostOrder.payment_method).toBe('voided');
        expect(ghostOrder.invoice_number).toBeNull();
        expect(Number(ghostOrder.total)).toBe(0);
    });

    it('rejects a saved table/invoice cross-bind without mutating either table or order', async () => {
        await openShift();
        const orderA = await seedSettlementTable({ tableId: SEED.table.id });
        const orderB = await seedSettlementTable({
            tableId: SEED.table2.id,
            product: SEED.product2
        });
        const before = await snapshotSettlementState(
            [orderA.invoiceId, orderB.invoiceId],
            [SEED.table.id, SEED.table2.id]
        );

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(settlementCheckoutPayload({
                tableId: SEED.table2.id,
                fixture: orderA,
                key: 'table-cross-bind-regression'
            }));

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('TABLE_SESSION_CONFLICT');
        expect(await snapshotSettlementState(
            [orderA.invoiceId, orderB.invoiceId],
            [SEED.table.id, SEED.table2.id]
        )).toEqual(before);
    });

    it('settles and releases the server-bound table when checkout omits table_id', async () => {
        await openShift();
        const fixture = await seedSettlementTable({ tableId: SEED.table.id });
        const payload = settlementCheckoutPayload({
            tableId: SEED.table.id,
            fixture,
            key: 'table-server-bound-id-regression'
        });
        delete payload.table_id;

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(payload);

        expect(response.statusCode).toBe(200);
        const [[order]] = await pool.query(
            'SELECT payment_method,table_id FROM orders WHERE invoice_id=?',
            [fixture.invoiceId]
        );
        const [[table]] = await pool.query(
            'SELECT status,current_order_id FROM restaurant_tables WHERE id=?',
            [SEED.table.id]
        );
        expect(order.payment_method).toBe('cash');
        expect(Number(order.table_id)).toBe(SEED.table.id);
        expect(table).toEqual(expect.objectContaining({
            status: 'available',
            current_order_id: null
        }));
    });

    it('answers a retry of a saved-table settle with CHECKOUT_IN_PROGRESS while the original is still running', async () => {
        await openShift();
        const fixture = await seedSettlementTable({ tableId: SEED.table.id });
        const key = 'table-settle-original-still-running';
        const payload = settlementCheckoutPayload({ tableId: SEED.table.id, fixture, key });
        const status = () => request(app).post('/api/pos/checkout/jofotara/status')
            .set('Cookie', cashierCookie).send({ idempotency_key: key, shift_id: cashierShiftId });

        // Holding the shift row lock stalls the original after it registered as in flight.
        const holder = await pool.getConnection();
        let original;
        try {
            await holder.beginTransaction();
            await holder.query('SELECT id FROM shifts WHERE id = ? FOR UPDATE', [cashierShiftId]);
            original = request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(payload).then(res => res);
            await new Promise(resolve => setTimeout(resolve, 500));

            const retry = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(payload);
            expect(retry.statusCode).toBe(409);
            expect(retry.body.code).toBe('CHECKOUT_IN_PROGRESS');
            expect((await status()).statusCode).toBe(404);
        } finally {
            await holder.rollback();
            holder.release();
        }
        expect((await original).statusCode).toBe(200);
        expect((await status()).statusCode).toBe(200);
    });

    it('restores an omitted bound service line and settles at the saved total', async () => {
        await openShift();
        const fixture = await seedSettlementTable({
            tableId: SEED.table.id,
            withServiceCharge: true
        });
        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(settlementCheckoutPayload({
                tableId: SEED.table.id,
                fixture,
                key: 'table-omitted-bound-fee'
            }));

        expect(response.statusCode).toBe(200);
        const [[order]] = await pool.query(
            'SELECT total,payment_method FROM orders WHERE invoice_id=?',
            [fixture.invoiceId]
        );
        expect(order.payment_method).toBe('cash');
        expect(Number(order.total)).toBe(fixture.total);
        const [[fee]] = await pool.query(
            `SELECT price_at_sale FROM order_items
              WHERE invoice_id=? AND note='Auto-Gratuity'`,
            [fixture.invoiceId]
        );
        expect(Number(fee.price_at_sale)).toBe(fixture.fee);
    });

    it('does not apply the register default order type to a table settlement', async () => {
        await openShift();
        await pool.query(
            "INSERT INTO settings (setting_key, setting_value) VALUES ('default_order_type_id', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",
            [String(SEED.orderType.id)]
        );
        const fixture = await seedSettlementTable({ tableId: SEED.table.id });

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(settlementCheckoutPayload({
                tableId: SEED.table.id,
                fixture,
                key: 'table-does-not-use-register-default'
            }));

        expect(response.statusCode).toBe(200);
        const [[order]] = await pool.query(
            'SELECT order_type_id FROM orders WHERE invoice_id = ?',
            [fixture.invoiceId]
        );
        expect(order.order_type_id).toBeNull();
    });

    it('preserves stored line and order discounts without a new cashier discount grant', async () => {
        await openShift();
        const fixture = await seedSettlementTable({
            tableId: SEED.table.id,
            lineDiscountType: 'fixed',
            lineDiscountValue: 1,
            orderDiscountType: 'percent',
            orderDiscountValue: 10
        });
        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(settlementCheckoutPayload({
                tableId: SEED.table.id,
                fixture,
                key: 'table-stored-discounts'
            }));

        expect(response.statusCode).toBe(200);
        const [[order]] = await pool.query(
            `SELECT total,discount_type,discount_value,payment_method
               FROM orders WHERE invoice_id=?`,
            [fixture.invoiceId]
        );
        expect(order.payment_method).toBe('cash');
        expect(Number(order.total)).toBe(fixture.total);
        expect(order.discount_type).toBe('percent');
        expect(Number(order.discount_value)).toBe(10);
        const [[item]] = await pool.query(
            `SELECT discount_type,discount_value
               FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL`,
            [fixture.invoiceId]
        );
        expect(item.discount_type).toBe('fixed');
        expect(Number(item.discount_value)).toBe(1);
        const [[discountAudit]] = await pool.query(
            `SELECT COUNT(*) AS count
               FROM audit_events
              WHERE entity_type='order' AND entity_id=?
                AND event_type IN ('line_discount_changed', 'order_discount_changed')`,
            [fixture.invoiceId]
        );
        expect(Number(discountAudit.count)).toBe(0);
    });

    it('rolls back the exact pooled connection when an edit invoice is missing', async () => {
        await openShift();
        const originalGetConnection = pool.getConnection;
        let checkoutConnection = null;
        pool.getConnection = async function captureCheckoutConnection() {
            const connection = await originalGetConnection.call(this);
            checkoutConnection = connection;
            pool.getConnection = originalGetConnection;
            return connection;
        };

        let response;
        try {
            response = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    edit_invoice_id: 999999,
                    table_id: SEED.table.id,
                    shift_id: cashierShiftId,
                    cart: [{
                        id: SEED.product1.id,
                        product_id: SEED.product1.id,
                        name: SEED.product1.name,
                        qty: 1,
                        price: SEED.product1.price
                    }],
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8,
                    payment_method: 'cash',
                    amount_tendered: 5.8,
                    change_due: 0,
                    idempotency_key: 'missing-edit-rollback'
                });
        } finally {
            pool.getConnection = originalGetConnection;
        }

        expect([404, 409]).toContain(response.statusCode);
        expect(checkoutConnection).toBeTruthy();
        const [[transactionState]] = await checkoutConnection.query(
            'SELECT @@in_transaction AS active'
        );
        if (Number(transactionState.active) !== 0) {
            await checkoutConnection.rollback();
        }
        expect(Number(transactionState.active)).toBe(0);
    });

    it('rejects a progressive split settle if the table was illegally rebound to another order', async () => {
        await openShift();

        // Admin cookie for the split route (checkSplitBillPermission) — cashier lacks it.
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        // 1. Seed ORIGINAL unpaid table order A on SEED.table and point the table at it.
        const [insA] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const orderA = insA.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [orderA, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [orderA, SEED.table.id]
        );

        // 2. Split A into one seat — this VOIDS A and FREES the table (detaches the split).
        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: orderA,
                splits: [
                    { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                ]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[held]] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");
        const splitCheckId = held.id;

        // 3. Re-seat the SAME table with a brand-new unpaid order B (live, unpaid).
        const [insB] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 2.00, 0.00, 2.00, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const orderB = insB.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Drink', 1, 2.00, 0, '')",
            [orderB, SEED.product2.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [orderB, SEED.table.id]
        );

        // 4. Settle the DETACHED split seat. The client legitimately sends table_id on a split
        //    settle (see checkout.js comment). This must NOT touch table B.
        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                split_check_id: splitCheckId,
                parent_invoice_id: orderA,
                is_split: true,
                table_id: SEED.table.id,
                idempotency_key: 'p0-1-split-reseat'
            });
        expect(payRes.statusCode).toBe(409);
        expect(payRes.body.success).toBe(false);

        // 5. Order B is untouched and the table is still occupied by B.
        const [[bRow]] = await pool.query(
            "SELECT payment_method FROM orders WHERE invoice_id = ?", [orderB]
        );
        expect(bRow.payment_method).toBe('unpaid_table');

        const [[tRow]] = await pool.query(
            "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]
        );
        expect(tRow.status).toBe('occupied');
        expect(tRow.current_order_id).toBe(orderB);
        const [[heldAfter]] = await pool.query('SELECT COUNT(*) count FROM held_orders WHERE id=?', [splitCheckId]);
        expect(Number(heldAfter.count)).toBe(1);
    });

    it('P0-1 guard: a normal unpaid_table settle (no split) still frees the table', async () => {
        await openShift();

        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table2.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [invoiceId, SEED.table2.id]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table2.id
            });
        expect(res.statusCode).toBe(200);

        const [[tRow]] = await pool.query(
            "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]
        );
        expect(tRow.status).toBe('available');
        expect(tRow.current_order_id).toBeNull();
    });

    it('P0-2: rejects a split settle whose split_check_id belongs to a DIFFERENT table (409), no collateral delete', async () => {
        await openShift();
        const adminRes = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        // Order A on table T1, split it → held row records cart_data.parent_invoice_id = A (A.table_id = T1).
        const [insA] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const orderA = insA.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 2, 5.00, 16, '')",
            [orderA, SEED.product1.id]
        );
        await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?", [orderA, SEED.table.id]);

        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: orderA,
                splits: [
                    { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                    { referenceName: 'Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                ]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[held]] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");
        const splitCheckId = held.id;

        // Settle THAT split check but naming a DIFFERENT table (T2) — must be rejected before any mutation.
        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                split_check_id: splitCheckId,
                table_id: SEED.table2.id,     // WRONG table — the split belongs to T1
                idempotency_key: 'p0-2-cross-table'
            });
        expect(payRes.statusCode).toBe(409);

        // The unrelated held row must NOT have been deleted (no collateral data loss).
        const [[stillThere]] = await pool.query("SELECT COUNT(*) AS c FROM held_orders WHERE id = ?", [splitCheckId]);
        expect(Number(stillThere.c)).toBe(1);
    });

    it('P0-2: allows a split settle that names the split check\'s own table', async () => {
        await openShift();
        const adminRes = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        const [insA] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const orderA = insA.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 2, 5.00, 16, '')",
            [orderA, SEED.product1.id]
        );
        await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?", [orderA, SEED.table.id]);

        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: orderA,
                splits: [
                    { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                    { referenceName: 'Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                ]
            });
        expect(splitRes.statusCode).toBe(200);

        const [[held]] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");
        const splitCheckId = held.id;

        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                split_check_id: splitCheckId,
                table_id: SEED.table.id,      // correct table — the split belongs to T1
                idempotency_key: 'p0-2-same-table'
            });
        expect(payRes.statusCode).toBe(200);

        // The settled split check is consumed.
        const [[gone]] = await pool.query("SELECT COUNT(*) AS c FROM held_orders WHERE id = ?", [splitCheckId]);
        expect(Number(gone.c)).toBe(0);
    });

    it('settles a legacy split with the matched parent tax rate, not carried JSON tax', async () => {
        await openShift();
        const [orderResult] = await pool.query(
            `INSERT INTO orders (user_id, table_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at)
             VALUES (?, ?, ?, 5.00, 0.80, 5.80, 'voided', 0, NOW())`,
            [SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const parentInvoiceId = orderResult.insertId;
        const [itemResult] = await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [parentInvoiceId, SEED.product1.id]
        );
        const [heldResult] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Table 1 - Legacy tax', 5.00, ?)`,
            [SEED.adminUser.id, JSON.stringify({
                parent_invoice_id: parentInvoiceId,
                tax_inclusive_at_sale: 0,
                is_split: true,
                items: [{
                    id: SEED.product1.id,
                    product_id: SEED.product1.id,
                    order_item_id: itemResult.insertId,
                    name: 'Test Burger',
                    qty: 1,
                    price: 5,
                    tax_rate: 99
                }]
            })]
        );
        await pool.query(
            `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, new_value)
             VALUES ('split_check_created', ?, 'held_order', ?, ?)`,
            [
                SEED.adminUser.id,
                heldResult.insertId,
                JSON.stringify({ parent_invoice_id: parentInvoiceId, bundle_snapshot_version: 1 })
            ]
        );

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                order_item_id: itemResult.insertId,
                qty: 1,
                price: 5,
                tax_rate: 99
            }],
            shift_id: cashierShiftId,
            subtotal: 5.00,
            tax: 0.80,
            total: 5.80,
            payment_method: 'cash',
            amount_tendered: 5.80,
            change_due: 0,
            split_check_id: heldResult.insertId,
            table_id: SEED.table.id,
            idempotency_key: 'legacy-split-parent-tax'
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.tax).toBe(0.80);
        expect(res.body.total).toBe(5.80);
    });

    it('rejects malformed allocated split money without consuming the held seat', async () => {
        const { parentInvoiceId, held } = await createAllocatedSplitFixture();
        const payload = JSON.parse(held[1].cart_data);
        payload.split_money_cents = null;
        await pool.query('UPDATE held_orders SET cart_data=? WHERE id=?', [
            JSON.stringify(payload), held[1].id
        ]);

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(allocatedSplitCheckoutPayload({
                held: held[1], parentInvoiceId, subtotal: 2.04, total: 2.37,
                key: 'malformed-allocated-split'
            }));

        expect(res.statusCode).toBe(409);
        const [[stillHeld]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [held[1].id]);
        expect(Number(stillHeld.count)).toBe(1);
    });

    it('rejects a one-cent stale client subtotal for an allocated split', async () => {
        const { parentInvoiceId, held } = await createAllocatedSplitFixture();
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send(allocatedSplitCheckoutPayload({
                held: held[1], parentInvoiceId, subtotal: 2.05, total: 2.37,
                key: 'stale-allocated-split'
            }));

        expect(res.statusCode).toBe(400);
        const [[stillHeld]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id=?', [held[1].id]);
        expect(Number(stillHeld.count)).toBe(1);
    });

    it('settles a legacy split with zero tax when its parent item row is unavailable', async () => {
        await openShift();
        expect(Number(SEED.product1.tax_rate)).toBeGreaterThan(0);
        const [orderResult] = await pool.query(
            `INSERT INTO orders (user_id, table_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at)
             VALUES (?, ?, ?, 5.00, 0, 5.00, 'voided', 0, NOW())`,
            [SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const parentInvoiceId = orderResult.insertId;
        const missingParentItemId = 999999;
        const [heldResult] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Table 1 - Legacy missing parent tax', 5.00, ?)`,
            [SEED.adminUser.id, JSON.stringify({
                parent_invoice_id: parentInvoiceId,
                tax_inclusive_at_sale: 0,
                is_split: true,
                items: [{
                    id: SEED.product1.id,
                    product_id: SEED.product1.id,
                    order_item_id: missingParentItemId,
                    name: SEED.product1.name,
                    qty: 1,
                    price: 5,
                    tax_rate: 99
                }]
            })]
        );
        await pool.query(
            `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, new_value)
             VALUES ('split_check_created', ?, 'held_order', ?, ?)`,
            [
                SEED.adminUser.id,
                heldResult.insertId,
                JSON.stringify({ parent_invoice_id: parentInvoiceId, bundle_snapshot_version: 1 })
            ]
        );

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                order_item_id: missingParentItemId,
                qty: 1,
                price: 5,
                tax_rate: 99
            }],
            shift_id: cashierShiftId,
            subtotal: 5.00,
            tax: 0,
            total: 5.00,
            payment_method: 'cash',
            amount_tendered: 5.00,
            change_due: 0,
            split_check_id: heldResult.insertId,
            table_id: SEED.table.id,
            idempotency_key: 'legacy-split-missing-parent-zero-tax'
        });

        expect(res.statusCode).toBe(200);
        expect(res.body.tax).toBe(0);
        expect(res.body.total).toBe(5.00);
        const [[settledItem]] = await pool.query(
            'SELECT tax_rate, tax_amount FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [res.body.invoice_id]
        );
        expect(Number(settledItem.tax_rate)).toBe(0);
        expect(Number(settledItem.tax_amount)).toBe(0);
    });

    it('price_override holder checks out a manual price with NO manager PIN', async () => {
        const loginRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.priceOverrideUser.user_number });
        const overrideUserCookie = loginRes.headers['set-cookie'][0];

        const shiftRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', overrideUserCookie)
            .send({ user_id: SEED.priceOverrideUser.id, starting_cash: 0 });
        const overrideShiftId = (await pool.query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1", [SEED.priceOverrideUser.id]))[0][0].id;

        const res = await request(app).post('/api/pos/checkout').set('Cookie', overrideUserCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price + 2 }],
            shift_id: overrideShiftId,
            subtotal: SEED.product1.price + 2, tax: 1.12, total: 8.12, amount_tendered: 10, payment_method: 'cash', change_due: 1.88
        });
        expect(res.statusCode).toBe(200);
        const [[line]] = await pool.query('SELECT price_at_sale FROM order_items WHERE invoice_id = ?', [res.body.invoice_id]);
        const [[order]] = await pool.query('SELECT total FROM orders WHERE invoice_id = ?', [res.body.invoice_id]);
        expect(Number(line.price_at_sale)).toBe(7);
        expect(Number(order.total)).toBe(8.12);
    });

    it('cashier checks out with a structured modifier surcharge', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ name: 'Size', options: [{ name: 'Large', price: 0.50 }] }]);
        await pool.query("UPDATE products SET modifiers = ? WHERE id = 1", [modifiersJson]);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                qty: 1,
                price: 5.50,
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.50 }]
            }],
            shift_id: cashierShiftId,
            subtotal: 5.43, tax: 0.87, total: 6.30, amount_tendered: 10, payment_method: 'cash', change_due: 3.70
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);

        const resFailed = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                qty: 1,
                price: 10.00,
                note: 'add cheese (5 JD)'
            }],
            shift_id: cashierShiftId,
            subtotal: 10.00, tax: 1.60, total: 11.60, amount_tendered: 20, payment_method: 'cash', change_due: 8.40
        });
        expect(resFailed.statusCode).toBe(400);

        const resOk = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                qty: 1,
                price: 10.00,
                note: 'add cheese (5 JD)'
            }],
            shift_id: cashierShiftId,
            subtotal: 5.00, tax: 0.80, total: 5.80, amount_tendered: 10, payment_method: 'cash', change_due: 4.20
        });
        expect(resOk.statusCode).toBe(200);
    });

    it('stores a 0.15 modifier as gross and derives its included tax from the parent product 8% rate', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ name: 'Extra', options: [{ name: 'Cheese', price: 0.15 }] }]);
        await pool.query("UPDATE products SET price = 5.00, tax_rate = 8.00, modifiers = ? WHERE id = ?", [modifiersJson, SEED.product1.id]);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                qty: 1,
                price: 999,
                tax_rate: 99,
                modifier_surcharge: 999,
                modifier_tax_amount: 999,
                selectedModifiers: [{ group: 'Extra', option: 'Cheese', price: 999 }]
            }],
            shift_id: cashierShiftId,
            subtotal: 5.14,
            tax: 0.41,
            total: 5.55,
            amount_tendered: 10,
            payment_method: 'cash',
            change_due: 4.45,
            idempotency_key: 'modifier-inherits-parent-tax-8'
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, subtotal: 5.14, tax: 0.41, total: 5.55 });
        const [[line]] = await pool.query(
            `SELECT price_at_sale, tax_rate, tax_amount, modifier_surcharge, modifier_tax_amount
               FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL`,
            [res.body.invoice_id]
        );
        expect(Number(line.price_at_sale)).toBe(5.15);
        expect(Number(line.tax_rate)).toBe(8);
        expect(Number(line.modifier_surcharge)).toBe(0.15);
        expect(Number(line.modifier_tax_amount)).toBeCloseTo(0.011111, 6);
        expect(Number(line.tax_amount)).toBeCloseTo(0.411111, 6);
    });

    it('recalculates inherited modifier tax through line and order discounts', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ name: 'Extra', options: [{ name: 'Cheese', price: 0.15 }] }]);
        await pool.query("UPDATE products SET price = 5.00, tax_rate = 8.00, modifiers = ? WHERE id = ?", [modifiersJson, SEED.product1.id]);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                qty: 1,
                price: 5.15,
                selectedModifiers: [{ group: 'Extra', option: 'Cheese', price: 0.15 }],
                discountType: 'percent',
                discountValue: 10
            }],
            order_discount_type: 'percent',
            order_discount_value: 20,
            manager_pin: SEED.adminUser.pin,
            shift_id: cashierShiftId,
            subtotal: 4.63,
            tax: 0.30,
            total: 4.00,
            amount_tendered: 10,
            payment_method: 'cash',
            change_due: 6.00,
            idempotency_key: 'modifier-inherited-tax-with-discounts'
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, subtotal: 4.63, tax: 0.30, total: 4.00 });
        const [[line]] = await pool.query(
            `SELECT price_at_sale, tax_rate, tax_amount, modifier_surcharge, modifier_tax_amount,
                    discount_type, discount_value
               FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL`,
            [res.body.invoice_id]
        );
        expect(Number(line.price_at_sale)).toBe(5.15);
        expect(Number(line.tax_rate)).toBe(8);
        expect(Number(line.modifier_surcharge)).toBe(0.15);
        expect(Number(line.modifier_tax_amount)).toBeCloseTo(0.011111, 6);
        expect(Number(line.tax_amount)).toBeCloseTo(0.296, 6);
        expect(line.discount_type).toBe('percent');
        expect(Number(line.discount_value)).toBe(10);
    });

    it('settles a table order with frozen price even if the menu price has changed (anti-tamper/trust frozen)', async () => {
        await openShift();

        // 1. Seed an unpaid table order with a burger priced at 5.00 (frozen price)
        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (700007, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
            [invoiceId, SEED.product1.id]
        );
        await bindLiveTableOrder(SEED.table.id, invoiceId);

        // 2. Change the live menu after the table has been saved.
        await pool.query("UPDATE products SET price = 6.00, name = 'Renamed Burger' WHERE id = 1");

        // 3. Cashier (no pos.price_override) settles the table order at the frozen price 5.00.
        // It must succeed (200) and preserve 5.00, not recalculate to 6.00 (which would cause a subtotal mismatch 400).
        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 6.00, change_due: 0.20,
                table_id: SEED.table.id
            });
        
        // Restore menu fields for subsequent tests.
        await pool.query("UPDATE products SET price = 5.00, name = 'Test Burger' WHERE id = 1");

        expect(res.statusCode).toBe(200);
        
        // Assert DB has payment_method cash and subtotal 5.00
        const [orders] = await pool.query("SELECT payment_method, subtotal FROM orders WHERE invoice_id = ?", [invoiceId]);
        expect(orders[0].payment_method).toBe('cash');
        expect(Number(orders[0].subtotal)).toBeCloseTo(5.00, 2);
        const [[item]] = await pool.query("SELECT item_name FROM order_items WHERE invoice_id = ?", [invoiceId]);
        expect(item.item_name).toBe('Test Burger');
    });

    describe('Cash Checkout Validation (Task 12)', () => {
        beforeEach(async () => {
            await openShift();
        });

        it('should reject cash checkout with negative amount_tendered', async () => {
            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    shift_id: cashierShiftId,
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    payment_method: 'cash', amount_tendered: -1.00, change_due: 0
                });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('cannot be negative');
        });

        it('should reject cash checkout with blank/non-numeric amount_tendered', async () => {
            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    shift_id: cashierShiftId,
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    payment_method: 'cash', amount_tendered: 'invalid', change_due: 0
                });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('must be a number');
        });

        it('should reject cash checkout with insufficient amount_tendered', async () => {
            const res = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    shift_id: cashierShiftId,
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    payment_method: 'cash', amount_tendered: 4.00, change_due: 0
                });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('less than the order total');
        });
    });

    it('P1-3: a rollback after the ghost void_checkout writes NO phantom audit row', async () => {
        await openShift();

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        // Seed a ghost unpaid table order and point the table at it.
        const [ghost] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
             VALUES (NULL, ?, ?, ?, ?, 10, 0, 10, 'unpaid_table')`,
            [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id, cashierShiftId]
        );
        const ghostId = ghost.insertId;
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
             VALUES (?, ?, 'Test Burger', 1, 10, 0, 0)`,
            [ghostId, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [ghostId, SEED.table.id]
        );

        // Force the invoice-number reservation (runs after the ghost-void payload is captured,
        // before commit) to throw, rolling back the whole checkout.
        failNextConnectionQuery(
            sql => typeof sql === 'string' && sql.includes('INSERT INTO invoice_sequences'),
            'Simulated crash after ghost void audit'
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
                subtotal: 5, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                shift_id: cashierShiftId,
                idempotency_key: 'p1-3-ghost-rollback'
            });
        expect(res.statusCode).toBe(500);

        expect(await waitForAuditCount('void_checkout', ghostId, 0)).toBe(0);

        // The ghost void rolled back: it is still a live unpaid table order.
        const [[o]] = await pool.query(
            "SELECT payment_method FROM orders WHERE invoice_id = ?", [ghostId]
        );
        expect(o.payment_method).toBe('unpaid_table');
    });

    it('rolls back the ghost checkout void when its audit insert fails', async () => {
        await openShift();

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        const [ghost] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
             VALUES (NULL, ?, ?, ?, ?, 10, 0, 10, 'unpaid_table')`,
            [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id, cashierShiftId]
        );
        const ghostId = ghost.insertId;
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
             VALUES (?, ?, 'Test Burger', 1, 10, 0, 0)`,
            [ghostId, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [ghostId, SEED.table.id]
        );

        failNextConnectionQuery(
            (sql, params) => typeof sql === 'string' && sql.includes('INSERT INTO audit_events') && params?.[0] === 'void_checkout',
            'Simulated audit insert failure'
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
                subtotal: 5, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                shift_id: cashierShiftId,
                idempotency_key: 'p1-3-ghost-audit-failure'
            });
        expect(res.statusCode).toBe(500);

        expect(await waitForAuditCount('void_checkout', ghostId, 0)).toBe(0);

        const [[o]] = await pool.query(
            "SELECT payment_method, total FROM orders WHERE invoice_id = ?", [ghostId]
        );
        expect(o.payment_method).toBe('unpaid_table');
        expect(Number(o.total)).toBe(10);

        const [[t]] = await pool.query(
            "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]
        );
        expect(t.status).toBe('occupied');
        expect(t.current_order_id).toBe(ghostId);
    });

    it('writes exactly one void_checkout audit row on a SUCCESSFUL ghost-table checkout (insert not dropped)', async () => {
        await openShift();

        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        const adminCookie = adminRes.headers['set-cookie'][0];

        // Seed a ghost unpaid table order and point the table at it.
        const [ghost] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
             VALUES (NULL, ?, ?, ?, ?, 10, 0, 10, 'unpaid_table')`,
            [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table.id, cashierShiftId]
        );
        const ghostId = ghost.insertId;
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
             VALUES (?, ?, 'Test Burger', 1, 10, 0, 0)`,
            [ghostId, SEED.product1.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [ghostId, SEED.table.id]
        );

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
                subtotal: 5, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                shift_id: cashierShiftId,
                idempotency_key: 'p1-3-ghost-success'
            });
        expect(res.statusCode).toBe(200);

        expect(await waitForAuditCount('void_checkout', ghostId, 1)).toBe(1);
    });

    describe('Split settle freezes split-time prices (P3-7)', () => {
        it('charges the split-time price even when the catalog price changed after the split', async () => {
            // Admin (has pos.split_checks) creates a table order and splits it
            const adminRes = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
            const adminCookie = adminRes.headers['set-cookie'][0];

            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({ table_id: SEED.table.id, cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }], subtotal: 5.00, tax: 0.80, total: 5.80 });
            expect(orderRes.statusCode).toBe(200);
            const parentInvoiceId = orderRes.body.order_id;

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id, currentOrderId: parentInvoiceId,
                    splits: [{ referenceName: 'Table 1 - Solo', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }]
                });
            expect(splitRes.statusCode).toBe(200);
            const [[held]] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");

            // Catalog price jumps 5.00 → 8.00 AFTER the split
            await pool.query("UPDATE products SET price = 8.00 WHERE id = ?", [SEED.product1.id]);

            // Non-manager cashier settles the split at the split-time totals
            await openShift();
            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
                    shift_id: cashierShiftId,
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    payment_method: 'cash', amount_tendered: 5.80, change_due: 0.00,
                    split_check_id: held.id,
                    table_id: SEED.table.id,
                    order_discount_type: null, order_discount_value: 0,
                    idempotency_key: `split_freeze_${held.id}`
                });
            expect(payRes.statusCode).toBe(200);
            expect(payRes.body.success).toBe(true);

            // The settled line is frozen at the split-time price (5.00), NOT the new catalog 8.00
            const [items] = await pool.query("SELECT price_at_sale FROM order_items WHERE invoice_id = ?", [payRes.body.invoice_id]);
            expect(items).toHaveLength(1);
            expect(Number(items[0].price_at_sale)).toBe(5.00);
            const [[settled]] = await pool.query("SELECT total FROM orders WHERE invoice_id = ?", [payRes.body.invoice_id]);
            expect(Number(settled.total)).toBe(5.80);
        });

        it('rejects a split settle when the request cart omits items from the held split', async () => {
            const adminRes = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
            const adminCookie = adminRes.headers['set-cookie'][0];

            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                    subtotal: 10.00,
                    tax: 1.60,
                    total: 11.60
                });
            expect(orderRes.statusCode).toBe(200);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: orderRes.body.order_id,
                    splits: [{
                        referenceName: 'Table 1 - Solo',
                        subtotal: 11.60,
                        items: [{ id: SEED.product1.id, qty: 2, price: 5.00, tax_rate: 16 }]
                    }]
                });
            expect(splitRes.statusCode).toBe(200);
            const [[held]] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");

            await openShift();
            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
                    shift_id: cashierShiftId,
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80,
                    payment_method: 'cash',
                    amount_tendered: 5.80,
                    change_due: 0.00,
                    split_check_id: held.id,
                    table_id: SEED.table.id,
                    idempotency_key: `split_tamper_${held.id}`
                });
            expect(payRes.statusCode).toBe(400);
            expect(payRes.body.message).toMatch(/mismatch/i);

            const [heldAfter] = await pool.query("SELECT id FROM held_orders WHERE id = ?", [held.id]);
            expect(heldAfter).toHaveLength(1);
        });
    });

    describe('Discount validation tests', () => {
        // checkout — order level
        it('rejects a negative order discount with a specific 400', async () => {
            await openShift();  // cashier: value <= 0 skips the discount permission gate, reaches normalizeDiscount
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                order_discount_type: 'fixed', order_discount_value: -5, idempotency_key: 'disc_ord_neg'
            });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/discount cannot be negative/i);
        });
        it('rejects an order discount over 100% with a specific 400', async () => {
            // ADMIN: a positive discount hits the permission gate first — cashier would get 403 here, not the value error
            const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: null, subtotal: 5.00, tax: 0.80, total: 5.80,   // admin is shift-exempt
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                order_discount_type: 'percent', order_discount_value: 150, idempotency_key: 'disc_ord_over'
            });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/cannot exceed 100/i);
        });
        // checkout — line level (negative fixed, percent > 100)
        it('rejects a negative line discount with a specific 400', async () => {
            await openShift();  // cashier: line discounts are validated in normalizeCartItems BEFORE the permission gate
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: 'fixed', discountValue: -5 }],
                shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0, idempotency_key: 'disc_line_neg'
            });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/discount cannot be negative/i);
        });
        it('rejects a line discount over 100% with a specific 400', async () => {
            await openShift();  // cashier: line discounts validated in normalizeCartItems BEFORE the permission gate
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: 'percent', discountValue: 150 }],
                shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0, idempotency_key: 'disc_line_over'
            });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/cannot exceed 100/i);
        });
    });

    describe('Service charge forgery tests', () => {
        it('rejects a qty-inflated Auto-Gratuity fee at checkout (service charge enabled)', async () => {
            await pool.query("UPDATE settings SET setting_value = '1'  WHERE setting_key = 'service_charge_enabled'");
            await pool.query("UPDATE settings SET setting_value = '10' WHERE setting_key = 'service_charge_percentage'");
            const snapshotId = '00000000-0000-4000-8000-000000000201';
            await pool.query(`INSERT INTO service_charge_snapshots
                (id, percentage, tax_rate, state, holder_type, created_by, version, expires_at)
                VALUES (?, 10, 0, 'draft', 'none', ?, 1, DATE_ADD(NOW(), INTERVAL 1 DAY))`, [snapshotId, SEED.adminUser.id]);
            // Base item 5.00 → correct fee 0.50; forge qty 10 so the fee line-total is 5.00.
            // ADMIN required: cashier lacks the service-charge permission → 403 before the amount guard.
            const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
                cart: [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: null, name: '10% Service Charge', note: 'Auto-Gratuity', qty: 10, price: 0.50, tax_rate: 0 }
                ],
                service_charge_snapshot: { id: snapshotId, version: 1 },
                shift_id: null, subtotal: 10.00, tax: 0.80, total: 10.80,   // admin is shift-exempt
                payment_method: 'cash', amount_tendered: 10.80, change_due: 0, idempotency_key: 'svc_forge_qty'
            });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/service.?charge/i);   // NOT /disabled/ — the amount guard fired
        });

        it('rejects a forged second Auto-Gratuity fee line at checkout (service charge enabled)', async () => {
            await pool.query("UPDATE settings SET setting_value = '1'  WHERE setting_key = 'service_charge_enabled'");
            await pool.query("UPDATE settings SET setting_value = '10' WHERE setting_key = 'service_charge_percentage'");
            const snapshotId = '00000000-0000-4000-8000-000000000202';
            await pool.query(`INSERT INTO service_charge_snapshots
                (id, percentage, tax_rate, state, holder_type, created_by, version, expires_at)
                VALUES (?, 10, 0, 'draft', 'none', ?, 1, DATE_ADD(NOW(), INTERVAL 1 DAY))`, [snapshotId, SEED.adminUser.id]);
            // Base item 5.00 → correct fee line is qty: 1, price: 0.50. We add a second one.
            const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
                cart: [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: null, name: '10% Service Charge', note: 'Auto-Gratuity', qty: 1, price: 0.50, tax_rate: 0 },
                    { id: null, name: '10% Service Charge Extra', note: 'Auto-Gratuity', qty: 1, price: 0.50, tax_rate: 0 }
                ],
                service_charge_snapshot: { id: snapshotId, version: 1 },
                shift_id: null, subtotal: 6.00, tax: 0.80, total: 6.80,   // admin is shift-exempt
                payment_method: 'cash', amount_tendered: 6.80, change_due: 0, idempotency_key: 'svc_forge_second'
            });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/service.?charge/i);
        });
    });

    describe('Held-order tamper (5d)', () => {
        it.each(['platform', 'cash'])('settles a restored platform hold using server-owned settlement despite browser %s', async method => {
            await openShift();
            await pool.query("INSERT INTO order_types (id,name,is_active,is_deferred_settlement) VALUES (3,'Platform',1,1)");
            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'Platform pickup', subtotal: 5,
                cart: { order_type_id: 3, items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] }
            });
            expect(held.statusCode).toBe(200);
            const claim = await claimHeldForCheckout(held.body.id, 'b'.repeat(64));
            const response = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: JSON.parse(claim.order.cart_data).items, held_order_context: claim.context,
                shift_id: cashierShiftId, order_type_id: null, subtotal: 5, tax: 0.8, total: 5.8,
                payment_method: method, amount_tendered: 20, change_due: 14.2, idempotency_key: 'held-platform-' + method
            });
            expect(response.statusCode).toBe(200);
            expect(response.body).toMatchObject({ payment_method: 'platform', cash_amount: 0, card_amount: 0, change_due: 0 });
            const [[invoice]] = await pool.query('SELECT order_type_id,payment_method,cash_amount,card_amount FROM orders WHERE invoice_id=?', [response.body.invoice_id]);
            expect(invoice.order_type_id).toBe(3); expect(invoice.payment_method).toBe('platform');
            expect(Number(invoice.cash_amount)).toBe(0); expect(Number(invoice.card_amount)).toBe(0);
        });

        it('treats a Table-prefixed ordinary hold as display text through checkout', async () => {
            await openShift();
            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'Table pickup customer',
                subtotal: 5,
                cart: {
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });
            expect(held.statusCode).toBe(200);

            const claim = await claimHeldForCheckout(held.body.id, 'c'.repeat(64));
            const response = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: JSON.parse(claim.order.cart_data).items,
                held_order_context: claim.context,
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'table-prefix-display-checkout'
            });

            expect(response.statusCode).toBe(200);
            const [[remaining]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id = ?', [held.body.id]);
            expect(Number(remaining.count)).toBe(0);
        });

        it('settles a claimed ordinary held order after its historical order type is deactivated', async () => {
            await openShift();
            await pool.query(
                "INSERT INTO order_types (id, name, is_active, is_deferred_settlement) VALUES (3, 'Historical Counter', 1, 0)"
            );
            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'historical-order-type',
                subtotal: 5,
                cart: {
                    order_type_id: 3,
                    items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                }
            });
            expect(held.statusCode).toBe(200);
            await pool.query('UPDATE order_types SET is_active = 0 WHERE id = 3');

            const claim = await claimHeldForCheckout(held.body.id, 'd'.repeat(64));
            const response = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: JSON.parse(claim.order.cart_data).items,
                held_order_context: claim.context,
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0.8,
                total: 5.8,
                payment_method: 'cash',
                amount_tendered: 5.8,
                change_due: 0,
                idempotency_key: 'historical-order-type-checkout'
            });

            expect(response.statusCode).toBe(200);
            const [[order]] = await pool.query(
                'SELECT order_type_id, payment_method FROM orders WHERE idempotency_key = ?',
                ['historical-order-type-checkout']
            );
            expect(order).toEqual({ order_type_id: 3, payment_method: 'cash' });
            const [[remaining]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id = ?', [held.body.id]);
            expect(Number(remaining.count)).toBe(0);
        });

        it('copies phone source from the locked held row while keeping the cashier as seller', async () => {
            await openShift();
            await pool.query("INSERT INTO users (id, user_number, name, role, is_active) VALUES (70, '9070', 'Phone Desk', 'call_center', 1)");
            const cart = {
                order_type_id: 1,
                customer_name: 'Phone Customer', customer_phone: '0791234567', customer_address: 'Amman',
                items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
            };
            const [held] = await pool.query(
                `INSERT INTO held_orders (user_id, call_center_user_id, reference_name, cart_data, subtotal)
                 VALUES (70, 70, 'Phone #source', ?, 5)`,
                [JSON.stringify(cart)]
            );
            const claim = await claimHeldForCheckout(held.insertId, '7'.repeat(64));
            const response = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: JSON.parse(claim.order.cart_data).items,
                held_order_context: claim.context,
                call_center_user_id: 999,
                shift_id: cashierShiftId,
                subtotal: 5, tax: 0.8, total: 5.8,
                payment_method: 'cash', amount_tendered: 5.8, change_due: 0,
                idempotency_key: 'phone-source-checkout'
            });
            expect(response.statusCode).toBe(200);
            const [[order]] = await pool.query("SELECT user_id, call_center_user_id FROM orders WHERE idempotency_key='phone-source-checkout'");
            expect(order).toEqual({ user_id: SEED.cashierUser.id, call_center_user_id: 70 });
            const [[audit]] = await pool.query(
                "SELECT new_value FROM audit_events WHERE event_type='held_order_consumed' AND entity_id=? ORDER BY id DESC LIMIT 1",
                [held.insertId]
            );
            expect(JSON.parse(audit.new_value)).toMatchObject({ call_center_user_id: 70 });
        });

        it('keeps a claimed held order recoverable when checkout validation fails', async () => {
            await openShift();
            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'checkout-validation-recovery',
                subtotal: 5,
                cart: { items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] }
            });
            expect(held.statusCode).toBe(200);
            const claim = await claimHeldForCheckout(held.body.id, 'c'.repeat(64));
            const items = JSON.parse(claim.order.cart_data).items;

            const rejected = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: items,
                held_order_context: claim.context,
                shift_id: cashierShiftId,
                subtotal: 5,
                tax: 0,
                total: 1,
                payment_method: 'cash',
                amount_tendered: 1,
                change_due: 0,
                idempotency_key: 'held-validation-recovery'
            });
            expect(rejected.statusCode).toBe(400);

            const [[row]] = await pool.query(
                'SELECT id, claimed_by_user_id, claim_token_hash FROM held_orders WHERE id=?',
                [held.body.id]
            );
            expect(row).toMatchObject({ id: held.body.id, claimed_by_user_id: SEED.cashierUser.id });
            expect(row.claim_token_hash).toBeTruthy();
        });

        it('reprices a held base-price tamper to the DB price at checkout', async () => {
            await openShift();
            // Real FE hold shape: cart is an OBJECT with items[]. Tamper the line price below DB (5.00).
            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'tamper-base', subtotal: 1.00,   // client lie
                cart: { items: [{ id: SEED.product1.id, qty: 1, price: 1.00, tax_rate: 16 }] }
            });
            expect(held.statusCode).toBe(200);

            const claim = await claimHeldForCheckout(held.body.id);
            const items = JSON.parse(claim.order.cart_data).items;

            const net = 5.00; // DB price
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: items, held_order_context: claim.context, shift_id: cashierShiftId,
                subtotal: net, tax: net * 0.16, total: net * 1.16,
                payment_method: 'cash', amount_tendered: net * 1.16, change_due: 0, idempotency_key: 'held_base_tamper'
            });
            expect(res.statusCode).toBe(200);
            const [[paid]] = await pool.query("SELECT invoice_id, subtotal FROM orders WHERE idempotency_key = 'held_base_tamper'");
            expect(Number(paid.subtotal)).toBe(5.00); // recomputed DB price, NOT client 1.00

            // Line-level guard (symmetry with the modifier case): the persisted line was stamped from DB.
            const [[line]] = await pool.query(
                "SELECT price_at_sale, tax_amount FROM order_items WHERE invoice_id = ? AND product_id = ?",
                [paid.invoice_id, SEED.product1.id]
            );
            expect(Number(line.price_at_sale)).toBe(5.00);
            expect(Number(line.tax_amount)).toBe(0.80);
        });

        it('charges DB base + DB modifier surcharge when a held modifier line is tampered', async () => {
            await openShift();
            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'tamper-mod', subtotal: 1.00,   // client lie
                cart: { items: [{ id: SEED.modifierProduct.id, qty: 1, price: 1.00, tax_rate: 16,
                                  selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.00 }] }] }
            });
            expect(held.statusCode).toBe(200);

            const claim = await claimHeldForCheckout(held.body.id, 'f'.repeat(64));
            const items = JSON.parse(claim.order.cart_data).items;

            // DB base 5.00 + DB "Large" surcharge 2.00 gross. The modifier's
            // embedded 16% tax is 0.275862, so the legal subtotal is 6.724138.
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: items, held_order_context: claim.context, shift_id: cashierShiftId,
                subtotal: 6.72, tax: 1.08, total: 7.80,
                payment_method: 'cash', amount_tendered: 7.80, change_due: 0, idempotency_key: 'held_mod_tamper'
            });
            expect(res.statusCode).toBe(200);
            const [[paid]] = await pool.query("SELECT invoice_id, subtotal, tax FROM orders WHERE idempotency_key = 'held_mod_tamper'");
            expect(Number(paid.subtotal)).toBe(6.72);   // modifier gross is split into net + inherited tax
            expect(Number(paid.tax)).toBe(1.08);

            // Line-level guard: the persisted line was stamped from the recomputed DB base + surcharge.
            const [[line]] = await pool.query(
                "SELECT price_at_sale, tax_amount FROM order_items WHERE invoice_id = ? AND product_id = ?",
                [paid.invoice_id, SEED.modifierProduct.id]
            );
            expect(Number(line.price_at_sale)).toBe(7.00);
            expect(Number(line.tax_amount)).toBeCloseTo(1.075862, 6);
        });

        it('checkout succeeds after adding an unrouted item to a fired order (deadlock regression)', async () => {
            await openShift();
            await pool.query("INSERT INTO categories (id, name, is_active) VALUES (2, 'Unrouted Drinks', 1)");
            const [unrouted] = await pool.query(
                "INSERT INTO products (name, price, tax_rate, jofotara_tax_category, category_id, is_active) VALUES ('Unrouted Cola', 2.00, 0, 'O', 2, 1)"
            );
            const unroutedId = unrouted.insertId;
            const [printer] = await pool.query(
                "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Checkout Kitchen', 'kitchen', 'windows', 'Checkout Kitchen', 'checkout-deadlock')"
            );
            await pool.query('INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)', [printer.insertId, SEED.category.id]);

            const held = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
                reference_name: 'deadlock-unrouted-add',
                subtotal: 5,
                cart: { items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] }
            });
            expect(held.statusCode).toBe(200);

            const [[fireRow]] = await pool.query('SELECT kitchen_fired FROM held_orders WHERE id=?', [held.body.id]);
            expect(Number(fireRow.kitchen_fired)).toBe(1);

            const editClaim = await claimHeldForCheckout(held.body.id, '8'.repeat(64));
            const cart = JSON.parse(editClaim.order.cart_data);
            cart.items.push({ id: unroutedId, qty: 1, price: 2, tax_rate: 0, category_id: 2 });
            const saved = await request(app).patch(`/api/pos/held_orders/${held.body.id}`).set('Cookie', cashierCookie).send({
                operation_id: `deadlock-edit-${held.body.id}`,
                claim_token: editClaim.claim.claimToken,
                expected_version: editClaim.claim.version,
                cart,
                subtotal: 7
            });
            expect(saved.statusCode).toBe(200);

            const claim = await claimHeldForCheckout(held.body.id, '9'.repeat(64));
            const checkout = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: JSON.parse(claim.order.cart_data).items,
                held_order_context: claim.context,
                shift_id: cashierShiftId,
                subtotal: 7, tax: 0.8, total: 7.8,
                payment_method: 'cash', amount_tendered: 7.8, change_due: 0,
                idempotency_key: 'held-unrouted-deadlock'
            });
            expect(checkout.statusCode).toBe(200);
        });
    });

    describe('Tax-inclusive customer receipt snapshot (B1)', () => {
        it('keeps normal sale tax and stores the customer receipt preference separately', async () => {
            await openShift();
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            // product1 = 5.00 @16%. The setting is now presentation-only: the sale remains
            // net 5.00 + 0.80 tax, while the customer copy snapshot is inclusive.
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId,
                subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                idempotency_key: 'b1_inclusive'
            });
            expect(res.statusCode).toBe(200);
            const [[order]] = await pool.query("SELECT invoice_id, subtotal, tax, total, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale FROM orders WHERE idempotency_key = 'b1_inclusive'");
            expect(Number(order.subtotal)).toBe(5);
            expect(Number(order.tax)).toBe(0.8);
            expect(Number(order.total)).toBe(5.8);
            expect(Number(order.tax_inclusive_at_sale)).toBe(0);
            expect(Number(order.receipt_tax_inclusive_at_sale)).toBe(1);
            const [[line]] = await pool.query(
                "SELECT tax_amount FROM order_items WHERE invoice_id = ? AND product_id = ?",
                [order.invoice_id, SEED.product1.id]
            );
            expect(Number(line.tax_amount)).toBeCloseTo(0.8, 6);
        });
    });

    describe('Receipt Tax-Mode Integration tests (Task 2)', () => {
        it('freezes accounting and customer-copy modes independently on a new direct checkout', async () => {
            await openShift();
            // 1. set the setting to 0 (exclusive)
            await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            let res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                idempotency_key: 'tax_mode_direct_1'
            });
            expect(res.statusCode).toBe(200);
            let [[order]] = await pool.query("SELECT tax_inclusive_at_sale, receipt_tax_inclusive_at_sale, tax, total FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
            expect(Number(order.tax_inclusive_at_sale)).toBe(0);
            expect(Number(order.receipt_tax_inclusive_at_sale)).toBe(0);
            expect(Number(order.tax)).toBeCloseTo(0.8, 6);
            expect(Number(order.total)).toBeCloseTo(5.8, 6);

            // 2. set the setting to 1 (inclusive)
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                idempotency_key: 'tax_mode_direct_2'
            });
            expect(res.statusCode).toBe(200);
            [[order]] = await pool.query("SELECT tax_inclusive_at_sale, receipt_tax_inclusive_at_sale, tax, total FROM orders WHERE invoice_id = ?", [res.body.invoice_id]);
            expect(Number(order.tax_inclusive_at_sale)).toBe(0);
            expect(Number(order.receipt_tax_inclusive_at_sale)).toBe(1);
            expect(Number(order.tax)).toBeCloseTo(0.8, 6);
            expect(Number(order.total)).toBeCloseTo(5.8, 6);
        });
    });

    describe('Receipt Presentation Sources Integration Tests', () => {
        it('returns DB-authoritative v1 from order_details and ignores current tax setting', async () => {
            await openShift();
            // Create paid order in exclusive mode
            await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                idempotency_key: 'pres_auth_1'
            });
            expect(res.statusCode).toBe(200);
            
            // Flip global mode to inclusive
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            
            // GET order details and assert
            const detailRes = await request(app).get(`/api/admin/order_details?id=${res.body.invoice_id}`).set('Cookie', adminCookie);
            expect(detailRes.statusCode).toBe(200);
            expect(detailRes.body.receipt_display_v1).toBeDefined();
            expect(detailRes.body.receipt_display_v1.taxMode).toBe('exclusive');
            expect(detailRes.body.receipt_display_v1.summary.taxAmount).toBe(0.80);
        });

        it('returns identical original and duplicate-checkout presentation money', async () => {
            await openShift();
            const body = {
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: cashierShiftId, subtotal: 5.00, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                idempotency_key: 'pres_auth_dup'
            };
            const first = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
            expect(first.statusCode).toBe(200);
            
            const second = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send(body);
            expect(second.statusCode).toBe(200);
            expect(first.body.receipt_display_v1).toBeDefined();
            expect(second.body.receipt_display_v1).toBeDefined();
            expect(second.body.receipt_display_v1).toEqual(first.body.receipt_display_v1);
        });

        it('completes an over-discount sale and clamps the presented discount to the subtotal', async () => {
            // A fixed order discount larger than the cart is a legal charge path:
            // calculateExpectedTotals floors the discounted subtotal at 0, so the sale
            // charges 0. The pre-commit v1 build must clamp the presented discount to
            // the actual money deducted (= subtotal) instead of failing the checkout.
            // ADMIN: positive discount hits the permission gate; admin is shift-exempt.
            const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                shift_id: null, subtotal: 5.00, tax: 0, total: 0,
                payment_method: 'cash', amount_tendered: 0, change_due: 0,
                order_discount_type: 'fixed', order_discount_value: 15, idempotency_key: 'pres_over_disc'
            });
            expect(res.statusCode).toBe(200);
            expect(res.body.receipt_display_v1).toBeDefined();
            expect(res.body.receipt_display_v1.summary.orderDiscountAmount).toBe(5.00);
            expect(res.body.receipt_display_v1.summary.total).toBe(0);
            expect(res.body.receipt_display_v1.summary.roundingAdjustment).toBe(0);

            // The same clamp must hold on the DB-authoritative read path.
            const detailRes = await request(app).get(`/api/admin/order_details?id=${res.body.invoice_id}`).set('Cookie', adminCookie);
            expect(detailRes.statusCode).toBe(200);
            expect(detailRes.body.receipt_display_v1).toBeDefined();
            expect(detailRes.body.receipt_display_v1.summary.orderDiscountAmount).toBe(5.00);
        });

        it('falls back only for an irreconcilable pre-v1 historical order', async () => {
            const currentShiftId = await openShift();
            // Create a legacy pre-v1 order directly in DB with null tax_inclusive_at_sale
            // We set subtotal = 5.00, tax = 0.80, total = 5.80
            // but the item price is 5.01 (mismatch of 1 cent between item price sum and header subtotal)
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope)
                 VALUES (1, ?, 5.00, 0.80, 5.80, 'cash', NULL, NOW(), 'test-scope')`,
                [currentShiftId]
            );
            const invoiceId = orderRes.insertId;

            // Insert matching item
            await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                 VALUES (?, ?, 'Legacy product', 1, 5.01, 16.00, 0.80)`,
                [invoiceId, SEED.product1.id]
            );

            // GET order details and assert fallback
            const detailRes = await request(app).get(`/api/admin/order_details?id=${invoiceId}`).set('Cookie', adminCookie);
            expect(detailRes.statusCode).toBe(200);
            expect(detailRes.body.receipt_display_v1).toBeUndefined();
            expect(detailRes.body.receipt_display_legacy_reason).toBe('PRE_V1_CENT_MISMATCH');

             // Repeat with non-null tax_inclusive_at_sale and assert 422 (never fallback)
            await pool.query("UPDATE orders SET tax_inclusive_at_sale = 0 WHERE invoice_id = ?", [invoiceId]);
            const errorRes = await request(app).get(`/api/admin/order_details?id=${invoiceId}`).set('Cookie', adminCookie);
            expect(errorRes.statusCode).toBe(422);
            expect(errorRes.body.success).toBe(false);
            expect(errorRes.body.message).toContain('Invalid receipt presentation');
        });
    });

    it('persists a DB-canonical selected_modifiers snapshot on checkout', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 0.50 }] }]);
        await pool.query("UPDATE products SET modifiers = ? WHERE id = 1", [modifiersJson]);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id,
                qty: 1,
                price: 5.50,
                note: 'Size: Large (0.50 JD)',
                // client lies about price + sends junk field — snapshot must store DB truth
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 99, junk: 'x' }]
            }],
            shift_id: cashierShiftId,
            subtotal: 5.43, tax: 0.87, total: 6.30, amount_tendered: 10, payment_method: 'cash', change_due: 3.70
        });
        expect(res.statusCode).toBe(200);

        const [[row]] = await pool.query(
            "SELECT selected_modifiers FROM order_items WHERE invoice_id = ? AND product_id = 1",
            [res.body.invoice_id]
        );
        expect(JSON.parse(row.selected_modifiers)).toEqual([
            { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
        ]);
        await pool.query("UPDATE products SET modifiers = NULL WHERE id = 1");
    });

    // The reported defect verbatim: three 2.70 units each carrying a 0.20 note. The
    // server used to price the note at zero, so three lines came back 0.60 light and
    // assertNearMoney rejected the whole sale. One line would only prove the snapshot;
    // three prove the surcharge is applied per line and reaches the order total.
    it('[priced note] checks out three 2.70 units with a 0.20 note at 8.70', async () => {
        await openShift();
        const [category] = await pool.query(
            "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
        );
        const [note] = await pool.query(
            "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
            [category.insertId]
        );
        await pool.query("UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category='O' WHERE id=?", [SEED.product1.id]);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [1, 2, 3].map(index => ({
                id: SEED.product1.id,
                cartId: `priced-note-line-${index}`,
                qty: 1,
                price: 999,
                selectedModifiers: [{ noteProductId: note.insertId, group: 'stale', option: 'stale', price: 99 }],
                note: 'Two slices (+0.20)'
            })),
            shift_id: cashierShiftId,
            subtotal: 8.70, tax: 0, total: 8.70,
            payment_method: 'cash', amount_tendered: 10, change_due: 1.30,
            idempotency_key: 'priced-note-three-units'
        });

        expect(res.statusCode).toBe(200);
        const [[order]] = await pool.query('SELECT subtotal, total FROM orders WHERE invoice_id=?', [res.body.invoice_id]);
        expect(Number(order.subtotal)).toBe(8.7);
        expect(Number(order.total)).toBe(8.7);

        const [lines] = await pool.query(
            'SELECT price_at_sale, modifier_surcharge, selected_modifiers FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
            [res.body.invoice_id]
        );
        expect(lines).toHaveLength(3);
        for (const line of lines) {
            expect(Number(line.price_at_sale)).toBe(2.9);
            expect(Number(line.modifier_surcharge)).toBe(0.2);
            expect(JSON.parse(line.selected_modifiers)).toEqual([
                { noteProductId: note.insertId, group: 'Two slices', option: 'Two slices', price: 0.2 }
            ]);
        }
    });

    it('[priced note] rejects an unavailable note with its public code, not a subtotal mismatch', async () => {
        await openShift();
        const [category] = await pool.query(
            "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
        );
        const [note] = await pool.query(
            "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
            [category.insertId]
        );
        await pool.query("UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category='O' WHERE id=?", [SEED.product1.id]);
        await pool.query('UPDATE products SET is_active=0 WHERE id=?', [note.insertId]);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 2.90, selectedModifiers: [{ noteProductId: note.insertId }] }],
            shift_id: cashierShiftId,
            subtotal: 2.90, tax: 0, total: 2.90,
            payment_method: 'cash', amount_tendered: 3, change_due: 0.10,
            idempotency_key: 'priced-note-unavailable'
        });

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('NOTE_PRODUCT_UNAVAILABLE');
    });

    it('[priced note] refuses a note-category product as a top-level line even for an admin', async () => {
        await openShift();
        const [category] = await pool.query(
            "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
        );
        const [note] = await pool.query(
            "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
            [category.insertId]
        );

        // Admin carries pos.price_override; the guard must fire before that can turn
        // the misuse into an accepted manual price.
        const res = await request(app).post('/api/pos/checkout').set('Cookie', adminCookie).send({
            cart: [{ id: note.insertId, qty: 1, price: 0.20 }],
            shift_id: cashierShiftId,
            subtotal: 0.20, tax: 0, total: 0.20,
            payment_method: 'cash', amount_tendered: 1, change_due: 0.80,
            idempotency_key: 'priced-note-top-level-admin'
        });

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('NOTE_PRODUCT_REQUIRES_ITEM');
    });

    // The note is what the customer reads to check their own order. It persists
    // correctly and prints on the kitchen ticket; three receipt row mappers used to
    // drop it on the way to receipt_display_v1, so the customer copy showed nothing.
    it('[priced note] renders the item note on the fresh receipt and on a reprint', async () => {
        await openShift();
        const [category] = await pool.query(
            "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
        );
        const [note] = await pool.query(
            "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
            [category.insertId]
        );
        await pool.query("UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category='O' WHERE id=?", [SEED.product1.id]);
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Note Front', 'receipt', 'windows', 'Note Front', 'primary')"
        );
        const itemNote = ['No onion', 'Two slices (+0.20)'].join('\n');

        const checkout = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{
                id: SEED.product1.id, qty: 1, price: 2.90,
                note: itemNote,
                selectedModifiers: [{ noteProductId: note.insertId }]
            }],
            shift_id: cashierShiftId,
            subtotal: 2.90, tax: 0, total: 2.90,
            payment_method: 'cash', amount_tendered: 3, change_due: 0.10,
            idempotency_key: 'receipt-note-render'
        });
        expect(checkout.statusCode).toBe(200);
        // A receipt the cashier never reprints is the common case, so assert the
        // fresh response before touching the reprint route.
        expect(checkout.body.receipt_display_v1.rows[0].note).toBe(itemNote);

        const printed = await request(app).post('/api/print/print').set('Cookie', cashierCookie).send({
            print_type: 'receipt', invoice_id: checkout.body.invoice_id, receipt_printer_id: printer.insertId,
            print_request_id: `checkout-receipt:${checkout.body.invoice_id}:primary`
        });
        expect(printed.statusCode).toBe(200);

        const [[job]] = await pool.query("SELECT payload FROM print_queue WHERE print_type='receipt' ORDER BY id DESC LIMIT 1");
        const data = JSON.parse(job.payload).data;
        expect(data.receipt_display_v1.rows[0].note).toBe(itemNote);
        expect(data.compiled_document_v1.html).toContain('No onion');
        expect(data.compiled_document_v1.html).toContain('Two slices');
    });

    it('stores NULL selected_modifiers for plain lines', async () => {
        await openShift();
        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
            shift_id: cashierShiftId,
            subtotal: 5.00, tax: 0.80, total: 5.80, amount_tendered: 10, payment_method: 'cash', change_due: 4.20
        });
        expect(res.statusCode).toBe(200);
        const [[row]] = await pool.query(
            "SELECT selected_modifiers FROM order_items WHERE invoice_id = ?",
            [res.body.invoice_id]
        );
        expect(row.selected_modifiers).toBeNull();
    });

    it('settles a saved table row with its server-owned selected_modifiers when the client omits them', async () => {
        await openShift();
        const savedSnapshot = JSON.stringify([
            { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
        ]);
        const note = 'Size: Large (0.50 JD)';
        const [order] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at)
             VALUES (700008, ?, ?, ?, ?, 5.50, 0.88, 6.38, 'unpaid_table', 0, NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const [line] = await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note, selected_modifiers)
             VALUES (?, ?, NULL, 1, 5.50, 16, ?, ?)`,
            [order.insertId, SEED.product1.id, note, savedSnapshot]
        );
        await bindLiveTableOrder(SEED.table.id, order.insertId);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            edit_invoice_id: order.insertId,
            cart: [{ id: SEED.product1.id, order_item_id: line.insertId, qty: 1, price: 5.50, note }],
            shift_id: cashierShiftId,
            subtotal: 5.50,
            tax: 0.88,
            total: 6.38,
            payment_method: 'cash',
            amount_tendered: 6.38,
            change_due: 0,
            table_id: SEED.table.id
        });
        expect(res.statusCode).toBe(200);

        const [[settled]] = await pool.query(
            "SELECT selected_modifiers FROM order_items WHERE invoice_id = ? AND product_id = ?",
            [res.body.invoice_id, SEED.product1.id]
        );
        expect(JSON.parse(settled.selected_modifiers)).toEqual(JSON.parse(savedSnapshot));
    });

    it('does not record client-injected selectedModifiers while settling a saved plain table row', async () => {
        await openShift();
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 0.50 }] }]),
            SEED.product1.id
        ]);

        try {
            const [order] = await pool.query(
                `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at)
                 VALUES (700009, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', 0, NOW())`,
                [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
            );
            const [line] = await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note, selected_modifiers)
                 VALUES (?, ?, NULL, 1, 5.00, 16, '', NULL)`,
                [order.insertId, SEED.product1.id]
            );
            await bindLiveTableOrder(SEED.table.id, order.insertId);

            const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                edit_invoice_id: order.insertId,
                cart: [{
                    id: SEED.product1.id,
                    order_item_id: line.insertId,
                    qty: 1,
                    price: 5.00,
                    note: '',
                    selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }]
                }],
                shift_id: cashierShiftId,
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80,
                payment_method: 'cash',
                amount_tendered: 5.80,
                change_due: 0,
                table_id: SEED.table.id
            });
            expect(res.statusCode).toBe(200);

            const [[settled]] = await pool.query(
                "SELECT selected_modifiers FROM order_items WHERE invoice_id = ? AND product_id = ?",
                [res.body.invoice_id, SEED.product1.id]
            );
            expect(settled.selected_modifiers).toBeNull();
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
        }
    });

    it('settles no-id duplicate table lines with the matching saved selected_modifiers snapshot', async () => {
        await openShift();
        const note = 'Shared note';
        const smallSnapshot = JSON.stringify([
            { gid: 'g_size', oid: 'o_small', group: 'Size', option: 'Small', price: 0 }
        ]);
        const largeSnapshot = JSON.stringify([
            { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0 }
        ]);
        const [order] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at)
             VALUES (700010, ?, ?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table', 0, NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note, selected_modifiers)
             VALUES (?, ?, NULL, 1, 5.00, 16, ?, ?), (?, ?, NULL, 1, 5.00, 16, ?, ?)`,
            [order.insertId, SEED.product1.id, note, smallSnapshot, order.insertId, SEED.product1.id, note, largeSnapshot]
        );
        await bindLiveTableOrder(SEED.table.id, order.insertId);

        const res = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            edit_invoice_id: order.insertId,
            cart: [
                {
                    id: SEED.product1.id,
                    qty: 1,
                    price: 5.00,
                    note,
                    selectedModifiers: [{ gid: 'g_size', oid: 'o_small', group: 'Size', option: 'Small', price: 0 }]
                },
                {
                    id: SEED.product1.id,
                    qty: 1,
                    price: 5.00,
                    note,
                    selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0 }]
                }
            ],
            shift_id: cashierShiftId,
            subtotal: 10.00,
            tax: 1.60,
            total: 11.60,
            payment_method: 'cash',
            amount_tendered: 11.60,
            change_due: 0,
            table_id: SEED.table.id
        });
        expect(res.statusCode).toBe(200);

        const [settled] = await pool.query(
            "SELECT selected_modifiers FROM order_items WHERE invoice_id = ? AND product_id = ? ORDER BY id",
            [res.body.invoice_id, SEED.product1.id]
        );
        expect(settled.map(row => JSON.parse(row.selected_modifiers))).toEqual([
            JSON.parse(smallSnapshot),
            JSON.parse(largeSnapshot)
        ]);
    });

    it('checks out a held modifier line at DB surcharge after the option was renamed (stable id match) (Task 7)', async () => {
        await openShift();
        const modifiersJson = JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]);
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [modifiersJson, SEED.modifierProduct.id]);

        const holdRes = await request(app).post('/api/pos/held_orders').set('Cookie', cashierCookie).send({
            reference_name: 'rename-probe',
            cart: { items: [{
                id: SEED.modifierProduct.id, qty: 1, price: 7.00, tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2.00 }]
            }] },
            subtotal: 7.00
        });
        expect(holdRes.body.success).toBe(true);
        const [[heldRow]] = await pool.query('SELECT cart_data FROM held_orders WHERE id = ?', [holdRes.body.id]);
        expect(Number(JSON.parse(heldRow.cart_data).items[0].modifier_surcharge)).toBe(2);

        // Rename BOTH group and option (ids preserved) — the old name-match would now fail.
        const renamedJson = JSON.stringify([{ id: 'g_size', name: 'Cup Size', options: [{ id: 'o_large', name: 'Grande', price: 2.00 }] }]);
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [renamedJson, SEED.modifierProduct.id]);

        const claim = await claimHeldForCheckout(holdRes.body.id, 'a'.repeat(64));
        const claimedItems = JSON.parse(claim.order.cart_data).items;
        expect(Number(claimedItems[0].modifier_surcharge)).toBe(2);
        expect(claim.response.body.pricing_context_changed.total).toBe(false);

        const pay = await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
            cart: claimedItems,
            held_order_context: claim.context,
            shift_id: cashierShiftId,
            subtotal: 6.72,
            tax: 1.08,
            total: 7.80,
            payment_method: 'cash',
            amount_tendered: 7.80,
            change_due: 0,
            idempotency_key: 'held_mod_rename_stable_id'
        });
        expect(pay.statusCode).toBe(200);

        const [[line]] = await pool.query(
            'SELECT price_at_sale, tax_amount FROM order_items WHERE invoice_id = ? AND product_id = ?',
            [pay.body.invoice_id, SEED.modifierProduct.id]
        );
        expect(Number(line.price_at_sale)).toBe(7.00);
        expect(Number(line.tax_amount)).toBeCloseTo(1.075862, 6);
        await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
    });

    it('settles no-id mixed-surcharge table lines from the saved server rows', async () => {
        await openShift();
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.modifierProduct.id
        ]);

        const [ins] = await pool.query(
            `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
             VALUES (NULL, ?, ?, ?, ?, 14.00, 2.24, 16.24, 'unpaid_table', NOW())`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const invoiceId = ins.insertId;
        await pool.query(
            `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES 
             (?, ?, 'Modifier Product', 1, 7.00, 16, 'Size: Large (2.00 JD)'),
             (?, ?, 'Modifier Product', 1, 7.00, 16, 'Size: Large (2.00 JD)')`,
            [invoiceId, SEED.modifierProduct.id, invoiceId, SEED.modifierProduct.id]
        );
        await pool.query(
            "UPDATE restaurant_tables SET status = 'occupied', current_order_id = ? WHERE id = ?",
            [invoiceId, SEED.table.id]
        );

        const [items] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ? ORDER BY id ASC', [invoiceId]);
        await pool.query('UPDATE order_items SET modifier_surcharge = 2.00, tax_amount = 0.80 WHERE id = ?', [items[0].id]);
        await pool.query('UPDATE order_items SET modifier_surcharge = NULL, tax_amount = 1.12 WHERE id = ?', [items[1].id]);

        const res = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [
                    {
                        id: SEED.modifierProduct.id,
                        qty: 1,
                        price: 7.00,
                        tax_rate: 16,
                        note: 'Size: Large (2.00 JD)',
                        selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                    },
                    {
                        id: SEED.modifierProduct.id,
                        qty: 1,
                        price: 7.00,
                        tax_rate: 16,
                        note: 'Size: Large (2.00 JD)',
                        selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                    }
                ],
                shift_id: cashierShiftId,
                subtotal: 14.00, tax: 1.92, total: 15.92,
                payment_method: 'cash', amount_tendered: 15.92, change_due: 0.00,
                table_id: SEED.table.id
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.invoice_id).toBe(invoiceId);

        const [settledItems] = await pool.query(
            `SELECT modifier_surcharge, tax_amount
             FROM order_items
             WHERE invoice_id = ?
             ORDER BY id ASC`,
            [invoiceId]
        );
        expect(settledItems.map(row => Number(row.modifier_surcharge || 0))).toEqual([2, 0]);
        expect(settledItems.map(row => Number(row.tax_amount))).toEqual([0.8, 1.12]);

        await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
    });

    it('bundle corruption: rejects a saved unpaid table before rewrite and preserves order, items, table, and stock', async () => {
        await openShift();
        const [orderRes] = await pool.query(
            `INSERT INTO orders (user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method)
             VALUES (?, ?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table')`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id, cashierShiftId]
        );
        const invoiceId = orderRes.insertId;
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            const [parent] = await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note)
                 VALUES (?, ?, 'Broken Bundle', 0, 10.00, 16, '')`,
                [invoiceId, SEED.bundleProduct.id]
            );
            await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note, parent_item_id)
                 VALUES (?, ?, 'Test Burger', 1, 0, 0, '', ?)`,
                [invoiceId, SEED.product1.id, parent.insertId]
            );
        });
        await pool.query(
            "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?",
            [invoiceId, SEED.table.id]
        );
        const [[stockBefore]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                edit_invoice_id: invoiceId,
                cart: [{ id: SEED.bundleProduct.id, qty: 1, price: 10, bundleItems: [
                    { product_id: SEED.product1.id, qty: 1, removed: false },
                    { product_id: SEED.product2.id, qty: 1, removed: false }
                ] }],
                shift_id: cashierShiftId,
                subtotal: 10, tax: 1.60, total: 11.60,
                payment_method: 'cash', amount_tendered: 11.60, change_due: 0,
                table_id: SEED.table.id,
                idempotency_key: 'bundle-corrupt-saved-table'
            });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[orderAfter]] = await pool.query(
            'SELECT payment_method FROM orders WHERE invoice_id=?', [invoiceId]
        );
        expect(orderAfter.payment_method).toBe('unpaid_table');
        const [itemsAfter] = await pool.query(
            'SELECT quantity, parent_item_id FROM order_items WHERE invoice_id=? ORDER BY id', [invoiceId]
        );
        expect(Number(itemsAfter[0].quantity)).toBe(0);
        expect(itemsAfter[1].parent_item_id).toBeTruthy();
        const [[tableAfter]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
        expect(tableAfter).toEqual({ status: 'occupied', current_order_id: invoiceId });
        const [[stockAfter]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);
        expect(stockAfter.stock).toBe(stockBefore.stock);
        const [newOrders] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', ['bundle-corrupt-saved-table']);
        expect(newOrders).toHaveLength(0);
    });

    it('bundle corruption: admin table cashout validates hidden current_order_id before fresh checkout or void audit', async () => {
        const [orderRes] = await pool.query(
            `INSERT INTO orders (user_id, waiter_id, table_id, subtotal, tax, total, payment_method)
             VALUES (?, ?, ?, 10.00, 1.60, 11.60, 'unpaid_table')`,
            [SEED.adminUser.id, SEED.adminUser.id, SEED.table.id]
        );
        const invoiceId = orderRes.insertId;
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            const [parent] = await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note)
                 VALUES (?, ?, 'Broken Bundle', 0, 10.00, 16, '')`,
                [invoiceId, SEED.bundleProduct.id]
            );
            await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note, parent_item_id)
                 VALUES (?, ?, 'Test Burger', 1, 0, 0, '', ?)`,
                [invoiceId, SEED.product1.id, parent.insertId]
            );
        });
        await pool.query(
            "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?",
            [invoiceId, SEED.table.id]
        );
        const [[auditBefore]] = await pool.query('SELECT COUNT(*) AS c FROM audit_events');

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table.id,
                idempotency_key: 'bundle-corrupt-admin-table'
            });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[oldOrder]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id=?', [invoiceId]);
        expect(oldOrder.payment_method).toBe('unpaid_table');
        const [[tableAfter]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
        expect(tableAfter).toEqual({ status: 'occupied', current_order_id: invoiceId });
        const [newOrders] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', ['bundle-corrupt-admin-table']);
        expect(newOrders).toHaveLength(0);
        const [[auditAfter]] = await pool.query('SELECT COUNT(*) AS c FROM audit_events');
        expect(Number(auditAfter.c)).toBe(Number(auditBefore.c));
    });

    it('bundle corruption: duplicate checkout rethrows corrupt finalized receipt instead of returning success', async () => {
        const key = 'bundle-corrupt-duplicate';
        const [orderRes] = await pool.query(
            `INSERT INTO orders (user_id, subtotal, tax, total, payment_method, idempotency_key)
             VALUES (?, 10.00, 1.60, 11.60, 'cash', ?)`,
            [SEED.adminUser.id, key]
        );
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            const [parent] = await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note)
                 VALUES (?, ?, 'Broken Bundle', 0, 10.00, 16, '')`,
                [orderRes.insertId, SEED.bundleProduct.id]
            );
            await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note, parent_item_id)
                 VALUES (?, ?, 'Test Burger', 1, 0, 0, '', ?)`,
                [orderRes.insertId, SEED.product1.id, parent.insertId]
            );
        });

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                idempotency_key: key
            });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [orders] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', [key]);
        expect(orders).toHaveLength(1);
    });

    it('bundle corruption: ER_DUP recovery preserves the baseline status/message-only response', async () => {
        const key = 'bundle-corrupt-duplicate-race';
        const [orderRes] = await pool.query(
            `INSERT INTO orders (user_id, subtotal, tax, total, payment_method, idempotency_key)
             VALUES (?, 10.00, 1.60, 11.60, 'cash', ?)`,
            [SEED.adminUser.id, key]
        );
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            const [parent] = await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note)
                 VALUES (?, ?, 'Broken Bundle', 0, 10.00, 16, '')`,
                [orderRes.insertId, SEED.bundleProduct.id]
            );
            await conn.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note, parent_item_id)
                 VALUES (?, ?, 'Test Burger', 1, 0, 0, '', ?)`,
                [orderRes.insertId, SEED.product1.id, parent.insertId]
            );
        });
        const restoreConnection = hideNextIdempotencyPreflight();
        let response;
        try {
            response = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', adminCookie)
                .send({
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                    subtotal: 5, tax: 0.80, total: 5.80,
                    payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                    idempotency_key: key
                });
        } finally {
            restoreConnection();
        }

        expect(restoreConnection.wasHidden()).toBe(true);
        expect(response.statusCode).toBe(409);
        expect(response.body.message).toBe(BUNDLE_ORDER_CORRUPT_MESSAGE);
        expect(response.body).not.toHaveProperty('code');
        expect(response.body).not.toHaveProperty('publicCode');
    });

    it('bundle corruption: split held payload is rejected before deletion and preserves its service-charge snapshot', async () => {
        const [parentOrder] = await pool.query(
            `INSERT INTO orders (user_id, table_id, subtotal, tax, total, payment_method)
             VALUES (?, ?, 10.00, 1.60, 11.60, 'voided')`,
            [SEED.adminUser.id, SEED.table.id]
        );
        const [held] = await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data)
             VALUES (?, 'Corrupt split bundle', 10.00, ?)`,
            [SEED.adminUser.id, JSON.stringify({
                parent_invoice_id: parentOrder.insertId,
                is_split: true,
                items: [{
                    id: SEED.bundleProduct.id,
                    product_id: SEED.bundleProduct.id,
                    qty: 0,
                    price: 10,
                    is_bundle: true,
                    bundleItems: [{ product_id: SEED.product1.id, qty: 1, removed: false }]
                }]
            })]
        );
        const snapshotId = '00000000-0000-4000-8000-000000000902';
        await pool.query(
            `INSERT INTO service_charge_snapshots
             (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
             VALUES (?, 10, 0, 'held', 'held_order', ?, ?, 1)`,
            [snapshotId, String(held.insertId), SEED.adminUser.id]
        );
        await pool.query('UPDATE held_orders SET service_charge_snapshot_id=? WHERE id=?', [snapshotId, held.insertId]);

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', adminCookie)
            .send({
                cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                subtotal: 5, tax: 0.80, total: 5.80,
                payment_method: 'cash', amount_tendered: 5.80, change_due: 0,
                table_id: SEED.table.id,
                split_check_id: held.insertId,
                idempotency_key: 'bundle-corrupt-split-held'
            });

        expect(response.statusCode).toBe(409);
        expect(response.body.code).toBe('BUNDLE_ORDER_CORRUPT');
        const [[heldAfter]] = await pool.query('SELECT id FROM held_orders WHERE id=?', [held.insertId]);
        expect(heldAfter.id).toBe(held.insertId);
        const [[snapshotAfter]] = await pool.query('SELECT state, version FROM service_charge_snapshots WHERE id=?', [snapshotId]);
        expect(snapshotAfter).toEqual({ state: 'held', version: 1 });
        const [paid] = await pool.query('SELECT invoice_id FROM orders WHERE idempotency_key=?', ['bundle-corrupt-split-held']);
        expect(paid).toHaveLength(0);
    });

    it('rejects call center at both the HTTP and direct checkout boundaries before DB work', async () => {
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (20, '9020', 'Call Center Checkout', 'call_center', 1)
        `);
        await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (20, 'pos.checkout')");
        const login = await request(app).post('/api/auth/login').send({ user_number: '9020' });

        const response = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', login.headers['set-cookie'][0])
            .send({
                cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                subtotal: 2,
                tax: 0,
                total: 2,
                payment_method: 'cash',
                amount_tendered: 2,
                change_due: 0,
            });
        expect(response.statusCode).toBe(403);

        const getConnection = vi.spyOn(pool, 'getConnection');
        try {
            await expect(executeCheckout({
                user: { id: 20, role: 'call_center', permissions: ['pos.checkout'] },
                input: { cart: [], payment_method: 'unpaid_table' },
                authorizeManagerOverride: async () => ({ allowed: true }),
            })).rejects.toMatchObject({ statusCode: 403 });
            expect(getConnection).not.toHaveBeenCalled();
        } finally {
            getConnection.mockRestore();
        }

        const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
        expect(Number(orders.count)).toBe(0);
    });
});
