const { seedLegacySharedSeats } = require('../fixtures/legacySharedSeats');
const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { currentTableRevision } = require('../fixtures/tableOrderRevision');
// integration/tables.test.js — Integration tests for table bill splitting
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { invalidateUserSessions } = require('../../middleware/auth');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { withBundleIntegrityChecksDisabled } = require('../helpers/bundleIntegrityFixtures');
const { getBusinessDate } = require('../../utils/businessDate');
const { parseDailyReportPeriod } = require('../../services/dailyReportPeriod');
const { buildDailySummary } = require('../../services/dailyReportBuilder');
const { buildDailySalesDetails } = require('../../services/dailySalesDetailsBuilder');
const { buildCategoryItemsReportPayload } = require('../../services/categoryItemsReportBuilder');
const {
    calculateLineSubtotal,
    deriveModifierTaxAmount,
    taxableLineTotal,
    roundMoney
} = require('../../services/PosCalculator');

describe('Table Bill Split Integration Tests', () => {
    let adminCookie;
    let cashierCookie;
    let waiterCookie;
    let cashierShiftId;

    beforeEach(async () => {
        await seedDatabase();

        // Login admin (has all permissions)
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];

        // Login cashier + open their shift
        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];

        // Login waiter
        const waiterRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        waiterCookie = waiterRes.headers['set-cookie'][0];

        const shiftRes = await request(app)
            .post('/api/auth/shifts?action=open')
            .set('Cookie', cashierCookie)
            .send({ user_id: SEED.cashierUser.id, starting_cash: 50.00 });
        expect(shiftRes.statusCode).toBe(200);

        const [rows] = await pool.query(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' LIMIT 1",
            [SEED.cashierUser.id]
        );
        cashierShiftId = rows[0].id;
    });

    afterAll(async () => {
        await pool.end();
    });

    // Helper: create a table order via the tables API and return the invoice_id
    async function createTableOrder(cookie, tableId, items, subtotal, tax, total) {
        const pricedModifierItems = items.map(item => {
            const surcharge = Array.isArray(item.selectedModifiers)
                ? item.selectedModifiers.reduce((sum, modifier) => sum + Math.max(0, Number(modifier.price) || 0), 0)
                : 0;
            if (!(surcharge > 0)) return item;
            return {
                ...item,
                modifier_surcharge: surcharge,
                modifier_tax_amount: deriveModifierTaxAmount(surcharge, Number(item.tax_rate) || 0)
            };
        });
        if (pricedModifierItems.some(item => item.modifier_tax_amount != null)) {
            subtotal = roundMoney(pricedModifierItems.reduce(
                (sum, item) => sum + calculateLineSubtotal(item, Number(item.tax_rate) || 0, false),
                0
            ));
            tax = roundMoney(pricedModifierItems.reduce(
                (sum, item) => sum + taxableLineTotal(item, Number(item.tax_rate) || 0, false) * ((Number(item.tax_rate) || 0) / 100),
                0
            ));
            total = roundMoney(subtotal + tax);
        }
        let service_charge_snapshot = null;
        if (items.some(item => item.note === 'Auto-Gratuity')) {
            const draft = await request(app).post('/api/pos/service_charge_snapshots')
                .set('Cookie', cookie).send({});
            expect(draft.statusCode).toBe(200);
            service_charge_snapshot = { id: draft.body.snapshot.id, version: draft.body.snapshot.version };
        }
        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', cookie)
            .send({ table_id: tableId, cart: items, subtotal, tax, total, service_charge_snapshot });
        expect(res.statusCode).toBe(200);
        return res.body.order_id; // invoice_id returned as order_id by that endpoint
    }

    async function grantWaiterForSplit(keys) {
        await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [SEED.waiterUser.id]);
        if (keys.length) {
            await pool.query(
                "INSERT INTO user_permissions (user_id, perm_key) VALUES ?",
                [keys.map(key => [SEED.waiterUser.id, key])]
            );
        }
        invalidateUserSessions(SEED.waiterUser.id);
        const res = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.waiterUser.user_number });
        return res.headers['set-cookie'][0];
    }

    const singleSeatSplit = (tableId, invoiceId) => ({
        tableId,
        currentOrderId: invoiceId,
        splits: [{
            referenceName: 'Table 1 - Seat 1',
            subtotal: 2.00,
            items: [{ id: SEED.product2.id, name: SEED.product2.name, qty: 1, price: 2.00, tax_rate: 0 }]
        }]
    });

    async function corruptOrderParent(invoiceId) {
        const [[parent]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [invoiceId]
        );
        await withBundleIntegrityChecksDisabled(pool, async conn => {
            await conn.query('UPDATE order_items SET quantity = 0 WHERE id = ?', [parent.id]);
            await conn.query(
                `INSERT INTO order_items
                   (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount, parent_item_id)
                 VALUES (?, ?, 'Corrupt child', 1, 0, 0, 0, ?)`,
                [invoiceId, SEED.product1.id, parent.id]
            );
        });
    }

    async function snapshotCorruptionMutationState(invoiceIds, tableIds) {
        const state = { orders: [], items: [], tables: [], held: [], audits: [], stock: [] };
        for (const invoiceId of invoiceIds) {
            const [orders] = await pool.query('SELECT * FROM orders WHERE invoice_id = ?', [invoiceId]);
            const [items] = await pool.query('SELECT * FROM order_items WHERE invoice_id = ? ORDER BY id', [invoiceId]);
            const [audits] = await pool.query('SELECT * FROM audit_events WHERE entity_id = ? ORDER BY id', [invoiceId]);
            state.orders.push(...orders);
            state.items.push(...items);
            state.audits.push(...audits);
        }
        for (const tableId of tableIds) {
            const [tables] = await pool.query('SELECT * FROM restaurant_tables WHERE id = ?', [tableId]);
            state.tables.push(...tables);
        }
        [state.held] = await pool.query('SELECT * FROM held_orders ORDER BY id');
        [state.stock] = await pool.query('SELECT id, stock FROM products ORDER BY id');
        return state;
    }

    function captureConnectionQueries() {
        const observed = [];
        const originalGetConnection = pool.getConnection;
        pool.getConnection = async function () {
            const conn = await originalGetConnection.call(this);
            const originalQuery = conn.query;
            const originalRelease = conn.release;
            conn.query = async function (sql, params) {
                observed.push(String(sql));
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
        return observed;
    }

    it('locks the table group before its order and items when updating a saved table', async () => {
        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
            5.00, 0.80, 5.80
        );
        const [[savedItem]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
            [invoiceId]
        );
        const lockTrace = captureConnectionQueries();
        global.__mockEmit__.mockClear();

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: SEED.product1.price,
                    order_item_id: savedItem.id
                }],
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80
            });

        expect(res.statusCode).toBe(200);
        const tableLock = lockTrace.findIndex(sql => /FROM\s+restaurant_tables[\s\S]+FOR UPDATE/i.test(sql));
        const orderLock = lockTrace.findIndex(sql => /FROM\s+orders[\s\S]+FOR UPDATE/i.test(sql));
        const itemLock = lockTrace.findIndex(sql => /FROM\s+order_items[\s\S]+FOR UPDATE/i.test(sql));
        expect(tableLock).toBeGreaterThanOrEqual(0);
        expect(orderLock).toBeGreaterThan(tableLock);
        expect(itemLock).toBeGreaterThan(orderLock);
        const tableUpdate = global.__mockEmit__.mock.calls
            .filter(([event]) => event === 'table_update')
            .map(([, payload]) => payload.table)
            .find(table => Number(table.id) === SEED.table.id);
        expect(Number(tableUpdate.waiter_id)).toBe(SEED.adminUser.id);
    });

    it('still saves a table containing an item that became sold out after the first save', async () => {
        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
            5.00, 0.80, 5.80
        );
        const [[savedItem]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL',
            [invoiceId]
        );
        await pool.query('UPDATE products SET is_available = 0, price_override_locked = 1 WHERE id = ?', [SEED.product1.id]);

        const reopened = await request(app)
            .get(`/api/pos/table_order?order_id=${invoiceId}`)
            .set('Cookie', adminCookie);
        expect(reopened.statusCode).toBe(200);
        expect(reopened.body.cart[0]).toMatchObject({ is_available: 0, can_sell: 0, price_override_locked: 1 });

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: SEED.product1.price,
                    order_item_id: savedItem.id
                }],
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80
            });

        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('lets the settlement context take the first table lock for a dynamic joined group', async () => {
        const [section] = await pool.query("INSERT INTO sections (name) VALUES ('Dynamic')");
        await pool.query(
            `INSERT INTO restaurant_tables (id, section_id, table_number, status)
             VALUES (20, ?, '77', 'available')`,
            [section.insertId]
        );
        await pool.query(
            `INSERT INTO restaurant_tables
                (id, section_id, table_number, status, parent_table_id)
             VALUES (10, ?, '78', 'available', 20)`,
            [section.insertId]
        );
        const invoiceId = await createTableOrder(
            adminCookie,
            20,
            [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
            5.00, 0.80, 5.80
        );
        const [[savedItem]] = await pool.query(
            'SELECT id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
            [invoiceId]
        );
        await pool.query(
            "UPDATE settings SET setting_value='dynamic' WHERE setting_key='table_mode'"
        );
        const lockTrace = captureConnectionQueries();

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_number: '77',
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: SEED.product1.price,
                    order_item_id: savedItem.id
                }],
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80
            });

        expect(res.statusCode).toBe(200);
        const tableLocks = lockTrace.filter(sql => (
            /FROM\s+restaurant_tables[\s\S]+FOR UPDATE/i.test(sql)
        ));
        expect(tableLocks[0]).toMatch(/WHERE id=\? OR parent_table_id=\?/i);
        expect(tableLocks[0]).toMatch(/ORDER BY id/i);
    });

    it('keeps save and checkout atomic when both race on the same table', async () => {
        for (let run = 0; run < 5; run++) {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const [[savedItem]] = await pool.query(
                'SELECT id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
                [invoiceId]
            );
            const cart = [{
                id: SEED.product1.id,
                qty: 1,
                price: SEED.product1.price,
                order_item_id: savedItem.id
            }];

            const [save, checkout] = await Promise.all([
                request(app)
                    .post('/api/pos/table_order')
                    .set('Cookie', adminCookie)
                    .send({
                        table_id: SEED.table.id,
                        current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                        cart,
                        subtotal: 5.00,
                        tax: 0.80,
                        total: 5.80
                    }),
                request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        edit_invoice_id: invoiceId,
                        table_id: SEED.table.id,
                        shift_id: cashierShiftId,
                        cart,
                        subtotal: 5.00,
                        tax: 0.80,
                        total: 5.80,
                        payment_method: 'cash',
                        amount_tendered: 6.00,
                        change_due: 0.20,
                        idempotency_key: `table-save-checkout-race-${run}`
                    })
            ]);

            expect([200, 409]).toContain(save.statusCode);
            expect([200, 409]).toContain(checkout.statusCode);
            const [[table]] = await pool.query(
                'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
                [SEED.table.id]
            );
            const [[order]] = await pool.query(
                'SELECT payment_method FROM orders WHERE invoice_id=?',
                [invoiceId]
            );
            const stillOpen = order.payment_method === 'unpaid_table'
                && Number(table.current_order_id) === invoiceId
                && (table.status === 'occupied' || table.status === 'printed');
            const settled = order.payment_method !== 'unpaid_table'
                && table.status === 'available'
                && table.current_order_id == null;
            expect(stillOpen || settled).toBe(true);

            if (stillOpen) {
                await pool.query('DELETE FROM order_items WHERE invoice_id=?', [invoiceId]);
                await pool.query('DELETE FROM orders WHERE invoice_id=?', [invoiceId]);
                await pool.query(
                    "UPDATE restaurant_tables SET status='available', current_order_id=NULL, parent_table_id=NULL WHERE id=?",
                    [SEED.table.id]
                );
            }
        }
    });

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
                    throw message instanceof Error ? message : new Error(message);
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

    describe('Active table order loading', () => {
        it('stores the catalog name with a new product line', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const [[item]] = await pool.query(
                'SELECT product_id, item_name FROM order_items WHERE invoice_id = ?',
                [invoiceId]
            );
            expect(item.product_id).toBe(SEED.product1.id);
            expect(item.item_name).toBe(SEED.product1.name);
        });

        it('rejects a missing table invoice instead of returning an empty active order', async () => {
            const res = await request(app)
                .get('/api/pos/table_order?order_id=999999')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(404);
            expect(res.body.message).toMatch(/not found/i);
        });

        it('rejects an old table invoice that is no longer linked to a live table', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            await pool.query(
                "UPDATE orders SET payment_method = 'cash' WHERE invoice_id = ?",
                [invoiceId]
            );
            await pool.query(
                "UPDATE restaurant_tables SET status = 'available', current_order_id = NULL WHERE id = ?",
                [SEED.table.id]
            );

            const res = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toMatch(/no longer active/i);
        });

        it('lets a settle-only cashier load another waiter table but still rejects save', async () => {
            const invoiceId = await createTableOrder(
                waiterCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const read = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', cashierCookie);

            expect(read.statusCode).toBe(200);
            expect(read.body.invoice_id).toBe(invoiceId);

            const save = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: read.body.cart,
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });

            expect(save.statusCode).toBe(403);
        });
    });

    describe('bundle corruption guards', () => {
        async function expectCorruptMergeUntouched(corruptSide) {
            const sourceInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const targetInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            await corruptOrderParent(corruptSide === 'source' ? sourceInvoiceId : targetInvoiceId);
            const before = await snapshotCorruptionMutationState(
                [sourceInvoiceId, targetInvoiceId],
                [SEED.table.id, SEED.table2.id]
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge' }));

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('BUNDLE_ORDER_CORRUPT');
            expect(await snapshotCorruptionMutationState(
                [sourceInvoiceId, targetInvoiceId],
                [SEED.table.id, SEED.table2.id]
            )).toEqual(before);
        }

        it('rejects a corrupt source table before merge copies or deletes rows', async () => {
            await expectCorruptMergeUntouched('source');
        });

        it('rejects a corrupt target table before merge copies or deletes rows', async () => {
            await expectCorruptMergeUntouched('target');
        });

        it('rejects a corrupt parent invoice before split creates held seats or releases its table', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            await corruptOrderParent(invoiceId);
            const before = await snapshotCorruptionMutationState([invoiceId], [SEED.table.id]);

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Corrupt seat',
                        subtotal: 5.80,
                        items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }]
                    }]
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('BUNDLE_ORDER_CORRUPT');
            expect(await snapshotCorruptionMutationState([invoiceId], [SEED.table.id])).toEqual(before);
        });

        it('rejects corrupt split data before filling a missing frozen tax mode', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            await pool.query('UPDATE orders SET tax_inclusive_at_sale = NULL WHERE invoice_id = ?', [invoiceId]);
            await corruptOrderParent(invoiceId);
            const queries = captureConnectionQueries();

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Corrupt tax seat',
                        subtotal: 5.80,
                        items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }]
                    }]
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('BUNDLE_ORDER_CORRUPT');
            expect(queries.some(sql => /UPDATE orders SET\b[\s\S]*\btax_inclusive_at_sale\s*=/i.test(sql))).toBe(false);
        });

        it('rejects corrupt raw split bundle items before normalization or table mutation', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const before = await snapshotCorruptionMutationState([invoiceId], [SEED.table.id]);

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Invalid bundle seat',
                        subtotal: 5.80,
                        items: [{
                            id: SEED.bundleProduct.id,
                            product_id: SEED.bundleProduct.id,
                            qty: 0,
                            price: SEED.bundleProduct.price,
                            bundleItems: [{ product_id: SEED.product1.id, qty: 1, removed: false }]
                        }]
                    }]
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('BUNDLE_ORDER_CORRUPT');
            expect(await snapshotCorruptionMutationState([invoiceId], [SEED.table.id])).toEqual(before);
        });
    });

    describe('Bill Split Calculations & Seat Totals', () => {
        const expectHeldConservesParentCents = async (parent, expectedTotals = null) => {
            const [held] = await pool.query(
                'SELECT id, reference_name, subtotal, cart_data FROM held_orders ORDER BY id'
            );
            const allocations = held.map(row => JSON.parse(row.cart_data).split_money_cents);

            expect(allocations.every(Boolean)).toBe(true);
            expect(allocations.reduce((sum, value) => sum + value.subtotal, 0)).toBe(parent.subtotal);
            expect(allocations.reduce((sum, value) => sum + value.discount, 0)).toBe(parent.discount);
            expect(allocations.reduce((sum, value) => sum + value.tax, 0)).toBe(parent.tax);
            expect(allocations.reduce((sum, value) => sum + value.total, 0)).toBe(parent.total);
            expect(allocations.every(value => value.subtotal - value.discount + value.tax === value.total)).toBe(true);
            expect(held.map(row => Math.round(Number(row.subtotal) * 100)))
                .toEqual(allocations.map(value => value.total));
            if (expectedTotals) expect(allocations.map(value => value.total)).toEqual(expectedTotals);
            return { held, allocations };
        };

        it('conserves parent cents when tax-exclusive halves round down independently', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: 4.092, tax_rate: 16 }],
                4.09, 0.66, 4.75
            );

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        // Each seat sends its allocated payable cents, as the POS does.
                        { referenceName: 'Table 1 - Cent Seat A', subtotal: 2.38, items: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }] },
                        { referenceName: 'Table 1 - Cent Seat B', subtotal: 2.37, items: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }] }
                    ]
                });

            expect(splitRes.statusCode).toBe(200);
            const { held } = await expectHeldConservesParentCents(
                { subtotal: 409, discount: 0, tax: 66, total: 475 },
                [238, 237]
            );

            const listRes = await request(app)
                .get(`/api/pos/table_splits?table_id=${SEED.table.id}`)
                .set('Cookie', adminCookie);
            expect(listRes.statusCode).toBe(200);
            const secondSeat = listRes.body.data.find(row => row.id === held[1].id);
            expect(secondSeat.receipt_display_v1.summary.subtotal).toBe(2.04);
            expect(secondSeat.receipt_display_v1.summary.taxAmount).toBe(0.33);
            expect(secondSeat.receipt_display_v1.summary.total).toBe(2.37);
            expect(secondSeat.receipt_display_v1.rows[0].netAmount).toBe(2.04);

            const badPayload = JSON.parse(held[0].cart_data);
            badPayload.split_money_cents = null;
            await pool.query('UPDATE held_orders SET cart_data = ? WHERE id = ?', [
                JSON.stringify(badPayload), held[0].id
            ]);
            const isolatedRes = await request(app)
                .get(`/api/pos/table_splits?table_id=${SEED.table.id}`)
                .set('Cookie', adminCookie);
            const badSeat = isolatedRes.body.data.find(row => row.id === held[0].id);
            const stillValidSeat = isolatedRes.body.data.find(row => row.id === held[1].id);
            expect(badSeat.receipt_display_v1).toBeNull();
            expect(badSeat.receipt_display_error).toBe('RECEIPT_PRESENTATION_INVALID');
            expect(stillValidSeat.receipt_display_v1.summary.total).toBe(2.37);
        });

        it.each([
            ['exclusive', '0', 11.6, [5, 5], [5.8, 5.8]],
            ['inclusive', '1', 10, [4.31, 4.31], [5, 5]]
        ])('accepts only the payable total as a %s seat amount', async (_, inclusive, parentTotal, preTax, payable) => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: 5, tax_rate: 16 }],
                10, 1.6, 11.6
            );
            // A legacy inclusive parent is stored as subtotal=gross, tax=0, total=gross-discount,
            // so pre-tax equals payable there; only the exclusive case fails without the narrowing.
            if (inclusive === '1') await pool.query('UPDATE orders SET tax_inclusive_at_sale=1, subtotal=10, tax=0, total=10 WHERE invoice_id=?', [invoiceId]);
            const [[parent]] = await pool.query('SELECT total FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(Number(parent.total)).toBeCloseTo(parentTotal, 2);
            const splitWith = amounts => request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: amounts.map((amount, index) => ({
                        referenceName: `Table 1 - Payable ${index + 1}`,
                        subtotal: amount,
                        items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                    }))
                });

            const preTaxRes = await splitWith(preTax);
            expect(preTaxRes.statusCode).toBe(400);
            const [[{ heldCount }]] = await pool.query('SELECT COUNT(*) AS heldCount FROM held_orders');
            expect(heldCount).toBe(0);

            const payableRes = await splitWith(payable);
            expect(payableRes.statusCode, JSON.stringify(payableRes.body)).toBe(200);
        });


        it('settles both allocated split children without losing header or line-tax cents', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: 4.092, tax_rate: 16 }],
                4.09, 0.66, 4.75
            );
            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Table 1 - Settle A', subtotal: 2.38, items: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }] },
                        { referenceName: 'Table 1 - Settle B', subtotal: 2.37, items: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }] }
                    ]
                });
            expect(splitRes.statusCode).toBe(200);

            const [held] = await pool.query('SELECT id, cart_data FROM held_orders ORDER BY id');
            for (const [index, row] of held.entries()) {
                const allocation = JSON.parse(row.cart_data).split_money_cents;
                const payRes = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: [{ id: SEED.product1.id, qty: 0.5, price: 4.092, tax_rate: 16 }],
                        shift_id: cashierShiftId,
                        subtotal: allocation.subtotal / 100,
                        tax: allocation.tax / 100,
                        total: allocation.total / 100,
                        payment_method: 'cash',
                        amount_tendered: allocation.total / 100,
                        change_due: 0,
                        split_check_id: row.id,
                        parent_invoice_id: invoiceId,
                        is_split: true,
                        table_id: SEED.table.id,
                        idempotency_key: `allocated-split-settle-${index}`
                    });
                expect(payRes.statusCode).toBe(200);
            }

            const [children] = await pool.query(
                `SELECT invoice_id, subtotal, tax, total
                   FROM orders WHERE parent_invoice_id=? ORDER BY invoice_id`,
                [invoiceId]
            );
            expect(children.map(child => Math.round(Number(child.total) * 100))).toEqual([238, 237]);
            expect(children.reduce((sum, child) => sum + Math.round(Number(child.subtotal) * 100), 0)).toBe(409);
            expect(children.reduce((sum, child) => sum + Math.round(Number(child.tax) * 100), 0)).toBe(66);
            expect(children.reduce((sum, child) => sum + Math.round(Number(child.total) * 100), 0)).toBe(475);
            for (const child of children) {
                const [[taxSum]] = await pool.query(
                    `SELECT ROUND(SUM(tax_amount) * 100) AS cents
                       FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL`,
                    [child.invoice_id]
                );
                expect(Number(taxSum.cents)).toBe(Math.round(Number(child.tax) * 100));
            }

            const businessDate = getBusinessDate();
            const period = parseDailyReportPeriod({ startDate: businessDate, endDate: businessDate });
            const [summary, salesDetails, categoryReport] = await Promise.all([
                buildDailySummary(pool, period),
                buildDailySalesDetails(pool, period),
                buildCategoryItemsReportPayload(pool, { businessDate, generatedByUser: SEED.adminUser })
            ]);
            expect(summary.summary.sales_processed).toBe(4.75);
            expect(salesDetails.products.find(row => row.product_id === SEED.product1.id)?.sold_amount).toBe(4.75);
            expect(categoryReport.items.find(row => row.item_name === SEED.product1.name)?.gross_revenue).toBe(4.75);
            expect(categoryReport.categories.reduce((sum, row) => sum + row.gross_revenue, 0)).toBe(4.75);
        });

        it.each([
            [[0.333333, 0.333333, 0.333334], 'thirds', [0.67, 0.67, 0.66]],
            [[0.166667, 0.166667, 0.166667, 0.166667, 0.166667, 0.166665], 'sixths', [0.34, 0.34, 0.33, 0.33, 0.33, 0.33]]
        ])('persists paid split %s without changing the conserved parent quantity', async (quantities, _, payable) => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }],
                2, 0, 2
            );
            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: quantities.map((qty, index) => ({
                        referenceName: `Table 1 - Precision ${index + 1}`,
                        subtotal: payable[index],
                        items: [{ id: SEED.product2.id, qty, price: 2, tax_rate: 0 }]
                    }))
                });
            expect(splitRes.statusCode).toBe(200);

            const [held] = await pool.query(
                'SELECT id, cart_data FROM held_orders WHERE parent_invoice_id=? ORDER BY id',
                [invoiceId]
            );
            for (const [index, row] of held.entries()) {
                const payload = JSON.parse(row.cart_data);
                const allocation = payload.split_money_cents;
                const payRes = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: payload.items,
                        shift_id: cashierShiftId,
                        subtotal: allocation.subtotal / 100,
                        tax: allocation.tax / 100,
                        total: allocation.total / 100,
                        payment_method: 'cash',
                        amount_tendered: allocation.total / 100,
                        change_due: 0,
                        split_check_id: row.id,
                        parent_invoice_id: invoiceId,
                        is_split: true,
                        table_id: SEED.table.id,
                        idempotency_key: `split-quantity-precision-${quantities.length}-${index}`
                    });
                expect(payRes.statusCode).toBe(200);
            }

            const [[saved]] = await pool.query(
                `SELECT CAST(SUM(oi.quantity) AS CHAR) quantity
                   FROM order_items oi
                   JOIN orders o ON o.invoice_id=oi.invoice_id
                  WHERE o.parent_invoice_id=? AND oi.parent_item_id IS NULL`,
                [invoiceId]
            );
            expect(saved.quantity).toBe('1.000000');
        });

        it.each([
            [2, [0.5, 0.5], [276, 275]],
            [3, [0.3333, 0.3333, 0.3334], [185, 183, 183]],
            [4, [0.25, 0.25, 0.25, 0.25], [138, 138, 138, 137]]
        ])('conserves parent cents for a normally taxed 4.75 split across %i seats', async (_, quantities, expectedTotals) => {
            await pool.query(
                "UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'"
            );
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: 4.75, tax_rate: 16 }],
                4.75, 0, 4.75
            );

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: quantities.map((qty, index) => ({
                        referenceName: `Table 1 - Cent Seat ${index + 1}`,
                        subtotal: expectedTotals[index] / 100,
                        items: [{ id: SEED.product1.id, qty, price: 4.75, tax_rate: 16 }]
                    }))
                });

            expect(splitRes.statusCode).toBe(200);
            await expectHeldConservesParentCents(
                { subtotal: 475, discount: 0, tax: 76, total: 551 },
                expectedTotals
            );
        });

        it('conserves parent cents and derives fixed child discounts from the parent', async () => {
            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product2.id, qty: 3, price: 2 }],
                    order_discount_type: 'fixed',
                    order_discount_value: 1,
                    subtotal: 6,
                    tax: 0,
                    total: 5
                });
            expect(orderRes.statusCode).toBe(200);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: orderRes.body.order_id,
                    splits: [1.66, 1.67, 1.67].map((subtotal, index) => ({
                        referenceName: `Table 1 - Fixed Cent Seat ${index + 1}`,
                        subtotal,
                        order_discount: { type: 'fixed', value: index === 0 ? 0.34 : 0.33 },
                        items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }]
                    }))
                });

            expect(splitRes.statusCode).toBe(200);
            const { held, allocations } = await expectHeldConservesParentCents(
                { subtotal: 600, discount: 100, tax: 0, total: 500 },
                [166, 167, 167]
            );
            expect(held.map(row => JSON.parse(row.cart_data).order_discount.value))
                .toEqual(allocations.map(value => value.discount / 100));
        });

        it('conserves parent cents and ignores an equivalent forged child discount rule', async () => {
            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product2.id, qty: 2, price: 2 }],
                    order_discount_type: 'percent',
                    order_discount_value: 10,
                    subtotal: 4,
                    tax: 0,
                    total: 3.60
                });
            expect(orderRes.statusCode).toBe(200);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: orderRes.body.order_id,
                    splits: [
                        { referenceName: 'Table 1 - Percent Cent Seat A', subtotal: 1.80, order_discount: { type: 'fixed', value: 0.20 }, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] },
                        { referenceName: 'Table 1 - Percent Cent Seat B', subtotal: 1.80, order_discount: { type: 'percent', value: 10 }, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                    ]
                });

            expect(splitRes.statusCode).toBe(200);
            const { held } = await expectHeldConservesParentCents(
                { subtotal: 400, discount: 40, tax: 0, total: 360 },
                [180, 180]
            );
            expect(held.map(row => JSON.parse(row.cart_data).order_discount))
                .toEqual([{ type: 'percent', value: 10 }, { type: 'percent', value: 10 }]);
        });

        it('conserves parent cents with an allocated service charge', async () => {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='service_charge_enabled'");
            await pool.query("UPDATE settings SET setting_value='10' WHERE setting_key='service_charge_percentage'");
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 },
                    { id: null, name: '10% Service Charge', qty: 1, price: 0.50, tax_rate: 0, note: 'Auto-Gratuity' }
                ],
                5.50, 0.80, 6.30
            );

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [0.3333, 0.3333, 0.3334].map((qty, index) => ({
                        referenceName: `Table 1 - Service Cent Seat ${index + 1}`,
                        subtotal: [2.11, 2.10, 2.09][index],
                        items: [{ id: SEED.product1.id, qty, price: 5, tax_rate: 16 }]
                    }))
                });

            expect(splitRes.statusCode).toBe(200);
            const { held } = await expectHeldConservesParentCents(
                { subtotal: 550, discount: 0, tax: 80, total: 630 }
            );
            expect(held.reduce(
                (sum, row) => sum + JSON.parse(row.cart_data).service_charge_allocation_cents,
                0
            )).toBe(50);
        });

        it('rejects a parent money mismatch larger than one cent without mutating the table', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
                5, 0.80, 5.80
            );
            await pool.query('UPDATE orders SET total=5.83 WHERE invoice_id=?', [invoiceId]);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Table 1 - Invalid Cent Seat',
                        subtotal: 5.83,
                        items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                    }]
                });

            expect(splitRes.statusCode).toBe(400);
            expect(splitRes.body.message).toMatch(/parent totals.*reconcile/i);
            const [held] = await pool.query('SELECT id FROM held_orders');
            expect(held).toHaveLength(0);
            const [[parent]] = await pool.query(
                'SELECT payment_method FROM orders WHERE invoice_id=?',
                [invoiceId]
            );
            expect(parent.payment_method).toBe('unpaid_table');
            const [[table]] = await pool.query(
                'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
                [SEED.table.id]
            );
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(invoiceId);
        });

        it('should split a table order into two seats and store both in held_orders', async () => {
            // 1. Create table order: 2x burger = 10.00 subtotal, 1.60 tax, 11.60 total
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // 2. Split into 2 equal seats: Seat A = 1 burger (5.00+0.80=5.80), Seat B = 1 burger
            const splitPayload = {
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [
                    {
                        referenceName: 'Seat A',
                        subtotal: 5.80,
                        items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }]
                    },
                    {
                        referenceName: 'Seat B',
                        subtotal: 5.80,
                        items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }]
                    }
                ]
            };

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send(splitPayload);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toContain('split successfully');

            // 3. Verify two held_order records are created
            const [splits] = await pool.query(
                "SELECT reference_name, subtotal, cart_data FROM held_orders ORDER BY id ASC"
            );
            expect(splits).toHaveLength(2);
            expect(splits[0].reference_name).toBe('Seat A');
            expect(splits[1].reference_name).toBe('Seat B');
            expect(Number(splits[0].subtotal)).toBe(5.80);
            expect(Number(splits[1].subtotal)).toBe(5.80);

            // 4. Verify cart_data has is_split flag and parent_invoice_id
            const cartA = JSON.parse(splits[0].cart_data);
            expect(cartA.is_split).toBe(true);
            expect(cartA.parent_invoice_id).toBe(invoiceId);

            // 5. The original remains the live financial/table authority until final payment.
            const [orders] = await pool.query(
                "SELECT payment_method, total, original_total FROM orders WHERE invoice_id = ?",
                [invoiceId]
            );
            expect(orders[0].payment_method).toBe('unpaid_table');
            expect(Number(orders[0].total)).toBe(11.60);
            expect(orders[0].original_total).toBeNull();

            // 6. The table remains occupied while split balances remain.
            const [tables] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            expect(tables[0].status).toBe('occupied');
            expect(Number(tables[0].current_order_id)).toBe(invoiceId);
        });

        it('should propagate parent_invoice_id into each split held_order', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product2.id, qty: 3, price: SEED.product2.price }],
                6.00, 0.00, 6.00
            );

            const splitPayload = {
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Person 1', subtotal: 2.00, items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }] },
                    { referenceName: 'Person 2', subtotal: 2.00, items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }] },
                    { referenceName: 'Person 3', subtotal: 2.00, items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }] }
                ]
            };

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send(splitPayload);

            expect(res.statusCode).toBe(200);

            const [splits] = await pool.query(
                "SELECT cart_data FROM held_orders ORDER BY id ASC"
            );
            expect(splits).toHaveLength(3);

            for (const split of splits) {
                const cart = JSON.parse(split.cart_data);
                expect(cart.parent_invoice_id).toBe(invoiceId);
                expect(cart.is_split).toBe(true);
            }
        });

        it('should reject split attempt on a non-existent table', async () => {
            const splitPayload = {
                tableId: 9999, // does not exist
                currentOrderId: 999,
                splits: [
                    { referenceName: 'Ghost', subtotal: 5.00, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                ]
            };

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send(splitPayload);

            // Canonical settlement context returns a recoverable table-session conflict.
            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
            expect(res.body.success).toBe(false);
        });

        it('should reject split if currentOrderId does not match table current_order_id', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const splitPayload = {
                tableId: SEED.table.id,
                currentOrderId: invoiceId + 9999, // wrong invoice ID
                splits: [
                    { referenceName: 'S1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                ]
            };

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send(splitPayload);

            expect(res.statusCode).toBe(409);
            expect(res.body.success).toBe(false);
        });

        it('S1: rejects a split with a phantom item-less seat padding the reconciliation', async () => {
            // Parent: 2x product1 @5.00, 16% tax => subtotal 10.00, tax 1.60, total 11.60
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Real',    subtotal: 1.00, items: [{ id: SEED.product1.id, qty: 2, price: 0.50, tax_rate: 16 }] },
                        { referenceName: 'Phantom', subtotal: 9.00, items: [] }
                    ]
                });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);

            // No held checks created, parent NOT voided (transaction rolled back).
            const [held] = await pool.query("SELECT id FROM held_orders");
            expect(held).toHaveLength(0);
            const [[parent]] = await pool.query("SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(parent.payment_method).toBe('unpaid_table');
        });

        it('S1: rejects a phantom-seat split even when the real seat is priced at 0', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Real',    subtotal: 0.00, items: [{ id: SEED.product1.id, qty: 2, price: 0.00, tax_rate: 16 }] },
                        { referenceName: 'Phantom', subtotal: 10.00, items: [] }
                    ]
                });

            expect(res.statusCode).toBe(400);
            const [held] = await pool.query("SELECT id FROM held_orders");
            expect(held).toHaveLength(0);
        });

        it('S1/F2: an accepted single-seat split persists the PARENT price, never the forged item price', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // One seat, all items, HONEST declared subtotal (10.00) but forged item price 0.50.
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Seat 1', subtotal: 11.60, items: [{ id: SEED.product1.id, qty: 2, price: 0.50, tax_rate: 16 }] }
                    ]
                });

            expect(res.statusCode).toBe(200);
            const [held] = await pool.query("SELECT cart_data FROM held_orders ORDER BY id DESC LIMIT 1");
            const cart = JSON.parse(held[0].cart_data);
            // The stored price MUST be the parent price, not the forged 0.50 — else settle charges 0.50.
            expect(Number(cart.items[0].price)).toBe(Number(SEED.product1.price));
        });

        it('F4: with service charge ENABLED, a forged seat fee is pinned to the parent fee, not persisted forged', async () => {
            await pool.query("UPDATE settings SET setting_value = '1'  WHERE setting_key = 'service_charge_enabled'");
            await pool.query("UPDATE settings SET setting_value = '10' WHERE setting_key = 'service_charge_percentage'");

            // Parent carries a valid 10% service charge line (0.50 = 10% of 5.00).
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: null, name: '10% Service Charge', qty: 1, price: 0.50, tax_rate: 0, note: 'Auto-Gratuity' }
                ],
                5.50, 0.80, 6.30
            );

            // Service charge STAYS enabled; the seat submits a forged fee of 1.30.
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Seat 1', subtotal: 6.30,
                        items: [
                            { id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 },
                            { id: null, name: '10% Service Charge', qty: 1, price: 1.30, tax_rate: 0, note: 'Auto-Gratuity' }
                        ]
                    }]
                });

            expect(res.statusCode).toBe(200);
            const [held] = await pool.query("SELECT cart_data FROM held_orders ORDER BY id DESC LIMIT 1");
            const fee = JSON.parse(held[0].cart_data).items.find(i => i.note === 'Auto-Gratuity');
            expect(Number(fee.price)).toBe(0.50); // pinned to the parent fee; forged 1.30 discarded
        });

        it('C2: allocates service-charge cents from pinned parent prices, not submitted seat prices', async () => {
            await pool.query("UPDATE settings SET setting_value = '1'  WHERE setting_key = 'service_charge_enabled'");
            await pool.query("UPDATE settings SET setting_value = '10' WHERE setting_key = 'service_charge_percentage'");

            // Parent goods are 5.00 + 2.00, so its frozen 10% fee is 0.70. The
            // right split is 0.50 + 0.20. Client line prices below deliberately
            // swap the apparent bases; price pinning must happen before allocation.
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product2.id, qty: 1, price: SEED.product2.price },
                    { id: null, name: '10% Service Charge', qty: 1, price: 0.70, tax_rate: 0, note: 'Auto-Gratuity' }
                ],
                7.70, 0.80, 8.50
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        // Saved price is 5.00, submitted price is 7.00. Subtotal is the
                        // authoritative post-pin charge: 5.00 + 0.50 + 0.80 tax.
                        { referenceName: 'Seat A', subtotal: 6.30, items: [{ id: SEED.product1.id, qty: 1, price: 7.00, tax_rate: 16 }] },
                        // Saved price is 2.00, submitted price is 0.00. Its post-pin charge
                        // carries the remaining 0.20 service-charge allocation.
                        { referenceName: 'Seat B', subtotal: 2.20, items: [{ id: SEED.product2.id, qty: 1, price: 0.00, tax_rate: 0 }] }
                    ]
                });

            expect(res.statusCode).toBe(200);
            const [held] = await pool.query('SELECT reference_name, cart_data FROM held_orders ORDER BY id ASC');
            const feeBySeat = Object.fromEntries(held.map(row => [
                row.reference_name,
                Number(JSON.parse(row.cart_data).items.find(item => item.note === 'Auto-Gratuity')?.price || 0)
            ]));
            expect(feeBySeat).toEqual({ 'Seat A': 0.50, 'Seat B': 0.20 });
        });

        it('P1: two same-product/same-note lines at different prices each pin to their OWN parent price', async () => {
            // Two separate lines of product1 (admin is a price-override user, so both persist at 5.00).
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price }
                ],
                10.00, 1.60, 11.60
            );

            // Simulate a manager price-override on ONE of the two identical lines: 5.00 -> 1.00,
            // and reflect it on the parent order so reconciliation has a consistent anchor.
            const [lines] = await pool.query(
                "SELECT id FROM order_items WHERE invoice_id = ? AND product_id = ? ORDER BY id ASC",
                [invoiceId, SEED.product1.id]
            );
            const fullLineId = lines[0].id;   // stays 5.00
            const cheapLineId = lines[1].id;  // becomes 1.00
            await pool.query("UPDATE order_items SET price_at_sale = 1.00 WHERE id = ?", [cheapLineId]);
            await pool.query("UPDATE orders SET subtotal = 6.00, tax = 0.96, total = 6.96 WHERE invoice_id = ?", [invoiceId]);

            // Split: seat 1 gets the 5.00 line, seat 2 gets the 1.00 line — each carries its order_item_id.
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, order_item_id: fullLineId,  qty: 1, price: SEED.product1.price, tax_rate: 16 }] },
                        { referenceName: 'Seat 2', subtotal: 1.16, items: [{ id: SEED.product1.id, order_item_id: cheapLineId, qty: 1, price: 1.00,               tax_rate: 16 }] }
                    ]
                });

            expect(res.statusCode).toBe(200);
            const [held] = await pool.query("SELECT reference_name, cart_data FROM held_orders ORDER BY id ASC");
            const seat1 = JSON.parse(held.find(h => h.reference_name === 'Seat 1').cart_data);
            const seat2 = JSON.parse(held.find(h => h.reference_name === 'Seat 2').cart_data);
            expect(Number(seat1.items[0].price)).toBe(Number(SEED.product1.price)); // pinned to its own 5.00 line
            expect(Number(seat2.items[0].price)).toBe(1.00);                        // pinned to its own 1.00 line
        });

        // Full settlement: the strongest shape for a money bug — split, then PAY, then assert
        // the persisted paid order total (not just held_orders.cart_data).
        it('P1 (settle): a split of two same-product different-price lines pays 6.00, not the collapsed price', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price }
                ],
                10.00, 1.60, 11.60
            );
            const [lines] = await pool.query(
                "SELECT id FROM order_items WHERE invoice_id = ? AND product_id = ? ORDER BY id ASC",
                [invoiceId, SEED.product1.id]
            );
            await pool.query("UPDATE order_items SET price_at_sale = 1.00 WHERE id = ?", [lines[1].id]);
            await pool.query("UPDATE orders SET subtotal = 6.00, tax = 0.96, total = 6.96 WHERE invoice_id = ?", [invoiceId]);

            // Split BOTH lines into ONE seat, each carrying its order_item_id.
            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Solo', subtotal: 6.96,
                        items: [
                            { id: SEED.product1.id, order_item_id: lines[0].id, qty: 1, price: SEED.product1.price, tax_rate: 16 },
                            { id: SEED.product1.id, order_item_id: lines[1].id, qty: 1, price: 1.00,               tax_rate: 16 }
                        ]
                    }]
                });
            expect(splitRes.statusCode).toBe(200);

            const [held] = await pool.query("SELECT id, cart_data FROM held_orders ORDER BY id DESC LIMIT 1");
            const splitCheckId = held[0].id;
            const storedItems = JSON.parse(held[0].cart_data).items; // carry order_item_id (persisted normalizedItems)

            const key = `p1_settle_${splitCheckId}`;
            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: storedItems,
                    shift_id: cashierShiftId,
                    subtotal: 6.00, tax: 0.96, total: 6.96,
                    payment_method: 'cash', amount_tendered: 6.96, change_due: 0.00,
                    split_check_id: splitCheckId,
                    parent_invoice_id: invoiceId,
                    is_split: true,
                    table_id: SEED.table.id,
                    order_discount_type: null, order_discount_value: 0,
                    idempotency_key: key
                });

            expect(payRes.statusCode).toBe(200);
            const [[paid]] = await pool.query("SELECT subtotal, total FROM orders WHERE idempotency_key = ?", [key]);
            expect(Number(paid.subtotal)).toBe(6.00); // NOT 2.00 (collapsed) and NOT rejected
            expect(Number(paid.total)).toBe(6.96);
        });

        // Same collapse exists on the unpaid-table cashout path (shared frozen-price loop).
        it('P1 (table settle): cashing out a table with two same-product different-price lines charges 6.00', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price }
                ],
                10.00, 1.60, 11.60
            );
            const [lines] = await pool.query(
                "SELECT id FROM order_items WHERE invoice_id = ? AND product_id = ? ORDER BY id ASC",
                [invoiceId, SEED.product1.id]
            );
            await pool.query("UPDATE order_items SET price_at_sale = 1.00 WHERE id = ?", [lines[1].id]);
            await pool.query("UPDATE orders SET subtotal = 6.00, tax = 0.96, total = 6.96 WHERE invoice_id = ?", [invoiceId]);

            const key = `p1_table_settle_${invoiceId}`;
            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [
                        { id: SEED.product1.id, order_item_id: lines[0].id, qty: 1, price: SEED.product1.price, tax_rate: 16 },
                        { id: SEED.product1.id, order_item_id: lines[1].id, qty: 1, price: 1.00,               tax_rate: 16 }
                    ],
                    shift_id: cashierShiftId,
                    edit_invoice_id: invoiceId,
                    subtotal: 6.00, tax: 0.96, total: 6.96,
                    payment_method: 'cash', amount_tendered: 6.96, change_due: 0.00,
                    table_id: SEED.table.id,
                    order_discount_type: null, order_discount_value: 0,
                    idempotency_key: key
                });

            expect(payRes.statusCode).toBe(200);
            const [[paid]] = await pool.query("SELECT subtotal FROM orders WHERE idempotency_key = ?", [key]);
            expect(Number(paid.subtotal)).toBe(6.00);
        });

        // Security: on the unpaid-table cashout path the client cart IS trusted for line identity,
        // so a client must not be able to point BOTH duplicate lines at the one cheap line id
        // (price-line swap) to pay 2.00 instead of 6.00. (Split settle rebuilds the cart from the
        // server-stored held row, so it is not reachable there.)
        it('P1 (security): a table settle reusing one cheap line id for both duplicate lines is rejected, nothing charged', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price }
                ],
                10.00, 1.60, 11.60
            );
            const [lines] = await pool.query(
                "SELECT id FROM order_items WHERE invoice_id = ? AND product_id = ? ORDER BY id ASC",
                [invoiceId, SEED.product1.id]
            );
            await pool.query("UPDATE order_items SET price_at_sale = 1.00 WHERE id = ?", [lines[1].id]);
            await pool.query("UPDATE orders SET subtotal = 6.00, tax = 0.96, total = 6.96 WHERE invoice_id = ?", [invoiceId]);

            // Attack: both cart lines claim the cheap parent line id (1.00) → would pay 2.00.
            const key = `p1_swap_${invoiceId}`;
            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [
                        { id: SEED.product1.id, order_item_id: lines[1].id, qty: 1, price: 1.00, tax_rate: 16 },
                        { id: SEED.product1.id, order_item_id: lines[1].id, qty: 1, price: 1.00, tax_rate: 16 }
                    ],
                    shift_id: cashierShiftId,
                    edit_invoice_id: invoiceId,
                    subtotal: 2.00, tax: 0.32, total: 2.32,
                    payment_method: 'cash', amount_tendered: 2.32, change_due: 0.00,
                    table_id: SEED.table.id,
                    order_discount_type: null, order_discount_value: 0,
                    idempotency_key: key
                });

            // Rejected as a stale/invalid saved-row identity, before money is accepted.
            expect(payRes.statusCode).toBe(409);
            expect(payRes.body.code).toBe('TABLE_SESSION_CONFLICT');
            const [paid] = await pool.query("SELECT invoice_id FROM orders WHERE idempotency_key = ?", [key]);
            expect(paid).toHaveLength(0); // nothing charged
        });

        it('canonicalizes name-only selectedModifiers before writing split held rows', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 0.50 }] }]),
                SEED.product1.id
            ]);

            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: 5.50,
                    tax_rate: 16,
                    note: 'Size: Large (0.50 JD)',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.50 }]
                }],
                5.50, 0.80, 6.30
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Seat A',
                        subtotal: 6.30,
                        items: [{
                            id: SEED.product1.id,
                            qty: 1,
                            price: 5.50,
                            tax_rate: 16,
                            note: 'Size: Large (0.50 JD)',
                            selectedModifiers: [{ group: 'Size', option: 'Large', price: 999 }]
                        }]
                    }]
                });
            expect(res.statusCode).toBe(200);

            const [[held]] = await pool.query('SELECT cart_data FROM held_orders WHERE reference_name = ?', ['Seat A']);
            const parsed = JSON.parse(held.cart_data);
            expect(parsed.items[0].selectedModifiers).toEqual([
                { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
            ]);
        });
    });

    describe('Split Concurrency Conflict (Double Pay → 409)', () => {
        it('should return conflict error when a split check is paid twice', async () => {
            // 1. Create table order and split it into 1 seat
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );

            const splitPayload = {
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Solo', subtotal: 2.00, items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }] }
                ]
            };

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send(splitPayload);
            expect(splitRes.statusCode).toBe(200);

            // 2. Fetch the held_order ID
            const [splits] = await pool.query("SELECT id FROM held_orders ORDER BY id DESC LIMIT 1");
            const splitCheckId = splits[0].id;

            // 3. First checkout of the split check (should succeed)
            const checkoutPayload1 = {
                cart: [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                shift_id: cashierShiftId,
                subtotal: 2.00,
                tax: 0.00,
                total: 2.00,
                payment_method: 'cash',
                amount_tendered: 2.00,
                change_due: 0.00,
                split_check_id: splitCheckId,
                parent_invoice_id: invoiceId,
                is_split: true,
                table_id: SEED.table.id,
                order_discount_type: null,
                order_discount_value: 0,
                idempotency_key: `split_pay_1_${splitCheckId}`
            };

            const payRes1 = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(checkoutPayload1);
            expect(payRes1.statusCode).toBe(200);
            expect(payRes1.body.success).toBe(true);

            // 4. Second checkout with same split_check_id (now deleted → conflict)
            const checkoutPayload2 = {
                ...checkoutPayload1,
                idempotency_key: `split_pay_2_${splitCheckId}` // different key to bypass idempotency
            };

            const payRes2 = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send(checkoutPayload2);

            expect(payRes2.statusCode).toBe(409);
            expect(payRes2.body.success).toBe(false);
            const [[paid]] = await pool.query(
                'SELECT COUNT(*) AS count FROM orders WHERE idempotency_key IN (?, ?)',
                [checkoutPayload1.idempotency_key, checkoutPayload2.idempotency_key]
            );
            expect(Number(paid.count)).toBe(1);
        });
    });

    describe('Split-check table-state and ownership authorization', () => {
        it('allows a waiter with split permission to split their own red table', async () => {
            const cookie = await grantWaiterForSplit(['tables.access', 'pos.split_checks']);
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await pool.query('UPDATE orders SET waiter_id = ? WHERE invoice_id = ?', [SEED.waiterUser.id, invoiceId]);

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', cookie)
                .send(singleSeatSplit(SEED.table.id, invoiceId));

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('rejects another waiter\'s red table without override permission', async () => {
            const cookie = await grantWaiterForSplit(['tables.access', 'pos.split_checks']);
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', cookie)
                .send(singleSeatSplit(SEED.table.id, invoiceId));

            expect(res.statusCode).toBe(403);
            expect(res.body.success).toBe(false);
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(String(table.current_order_id)).toBe(String(invoiceId));
        });

        it('allows another waiter\'s red table with both split and override permissions', async () => {
            const cookie = await grantWaiterForSplit(['tables.access', 'pos.split_checks', 'waiter.override_tables']);
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', cookie)
                .send(singleSeatSplit(SEED.table.id, invoiceId));

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });

        it('rejects a blue table for a waiter even with split and override permissions', async () => {
            const cookie = await grantWaiterForSplit(['tables.access', 'pos.split_checks', 'waiter.override_tables']);
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await pool.query("UPDATE restaurant_tables SET status = 'printed' WHERE id = ?", [SEED.table.id]);

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', cookie)
                .send(singleSeatSplit(SEED.table.id, invoiceId));

            expect(res.statusCode).toBe(403);
            expect(res.body.success).toBe(false);
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table.id]);
            expect(table.status).toBe('printed');
            expect(String(table.current_order_id)).toBe(String(invoiceId));
        });

        it('allows an admin to split a blue table', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await pool.query("UPDATE restaurant_tables SET status = 'printed' WHERE id = ?", [SEED.table.id]);

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send(singleSeatSplit(SEED.table.id, invoiceId));

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('Split Requires Valid Splits Data', () => {
        it('should reject parentless split requests and create no held checks', async () => {
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: null,
                    currentOrderId: null,
                    splits: [{
                        referenceName: 'Split Order - Seat 1',
                        subtotal: 2.00,
                        items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }]
                    }]
                });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toMatch(/table/i);

            const [held] = await pool.query("SELECT id FROM held_orders");
            expect(held).toHaveLength(0);
        });

        it('should reject table split requests without a saved current order id', async () => {
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: null,
                    splits: [{
                        referenceName: 'Table 1 - Seat 1',
                        subtotal: 2.00,
                        items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }]
                    }]
                });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toMatch(/saved/i);

            const [held] = await pool.query("SELECT id FROM held_orders");
            expect(held).toHaveLength(0);
        });

        it('should return 400 when splits array is empty', async () => {
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({ tableId: SEED.table.id, currentOrderId: 1, splits: [] });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Missing splits data');
        });

        it('should return 400 when splits key is missing entirely', async () => {
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({ tableId: SEED.table.id, currentOrderId: 1 });

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
        });
    });

    describe('Table Operations (Transfer, Swap, Merge, Join, Disjoin, Redirection)', () => {
        const tableStructureRows = async () => {
            const [rows] = await pool.query(
                `SELECT id, status, current_order_id, parent_table_id, seating_parent_id
                   FROM restaurant_tables
                  ORDER BY id`
            );
            return rows;
        };

        it.each([
            ['self join', () => [SEED.table.id]],
            ['duplicate child', () => [SEED.table2.id, SEED.table2.id]],
            ['missing child', () => [999999]]
        ])('rejects %s without changing table structure', async (_label, childIds) => {
            const before = await tableStructureRows();
            const res = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({
                    parentTableId: SEED.table.id,
                    childTableIds: childIds()
                });

            expect([400, 404, 409]).toContain(res.statusCode);
            expect(await tableStructureRows()).toEqual(before);
        });

        it('rejects a cycle-producing join without changing table structure', async () => {
            await pool.query(
                'UPDATE restaurant_tables SET seating_parent_id=? WHERE id=?',
                [SEED.table2.id, SEED.table.id]
            );
            const before = await tableStructureRows();

            const res = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({
                    parentTableId: SEED.table.id,
                    childTableIds: [SEED.table2.id]
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
            expect(await tableStructureRows()).toEqual(before);
        });

        it('rejects transfer from a joined child without moving or duplicating its order', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            await pool.query(
                `UPDATE restaurant_tables
                    SET parent_table_id=?, status='occupied', current_order_id=?
                  WHERE id=?`,
                [SEED.table.id, invoiceId, SEED.table2.id]
            );
            await pool.query(
                "INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')"
            );
            const before = await tableStructureRows();

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table2.id,
                    targetTableId: 3,
                    action: 'transfer'
                }));

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
            expect(await tableStructureRows()).toEqual(before);
            const [[order]] = await pool.query(
                'SELECT table_id FROM orders WHERE invoice_id=?',
                [invoiceId]
            );
            expect(Number(order.table_id)).toBe(SEED.table.id);
        });

        it('should successfully transfer an active order to an empty table', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'transfer'
                }));

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify tables states
            const [t1Rows] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1Rows[0].status).toBe('available');
            expect(t1Rows[0].current_order_id).toBeNull();

            const [t2Rows] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2Rows[0].status).toBe('occupied');
            expect(t2Rows[0].current_order_id).toBe(invoiceId);

            // Verify order table reference
            const [orders] = await pool.query("SELECT table_id FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(orders[0].table_id).toBe(SEED.table2.id);

            // Verify Socket.IO staff room isolation
            expect(global.__mockTo__).toHaveBeenCalledWith('staff');
        });

        it('transfers printed status to every joined target child (legacy shared bill)', async () => {
            await pool.query(
                "INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')"
            );
            await seedLegacySharedSeats(pool, SEED.table2.id, [3]);


            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const printed = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table.id,
                    expected_invoice_id: invoiceId
                });
            expect(printed.statusCode).toBe(200);

            const transferred = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'transfer'
                }));
            expect(transferred.statusCode).toBe(200);

            const [targetGroup] = await pool.query(
                'SELECT id, status, current_order_id FROM restaurant_tables WHERE id IN (?, ?) ORDER BY id',
                [SEED.table2.id, 3]
            );
            expect(targetGroup).toEqual([
                expect.objectContaining({ id: SEED.table2.id, status: 'printed', current_order_id: invoiceId }),
                expect.objectContaining({ id: 3, status: 'printed', current_order_id: invoiceId })
            ]);

            const reprint = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    action: 'mark_printed',
                    table_id: 3,
                    expected_invoice_id: invoiceId
                });
            expect(reprint.statusCode).toBe(200);
        });

        it('rejects transfer when a joined target child owns a different live order', async () => {
            await pool.query(
                "INSERT INTO restaurant_tables (id, section_id, table_number, status, parent_table_id) VALUES (3, 1, '3', 'available', ?)",
                [SEED.table2.id]
            );
            const sourceInvoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const [foreignOrder] = await pool.query(
                `INSERT INTO orders
                    (user_id, waiter_id, table_id, subtotal, tax, total, payment_method)
                 VALUES (?, ?, 3, 2.00, 0.00, 2.00, 'unpaid_table')`,
                [SEED.adminUser.id, SEED.adminUser.id]
            );
            await pool.query(
                `INSERT INTO order_items
                    (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                 VALUES (?, ?, ?, 1, 2.00, 0, 0)`,
                [foreignOrder.insertId, SEED.product2.id, SEED.product2.name]
            );
            await pool.query(
                "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=3",
                [foreignOrder.insertId]
            );

            const transferred = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'transfer'
                }));

            expect(transferred.statusCode).toBe(409);
            expect(transferred.body.code).toBe('TABLE_SESSION_CONFLICT');
            const [tables] = await pool.query(
                'SELECT id, status, current_order_id, parent_table_id FROM restaurant_tables WHERE id IN (1,2,3) ORDER BY id'
            );
            expect(tables).toEqual([
                expect.objectContaining({ id: 1, status: 'occupied', current_order_id: sourceInvoiceId }),
                expect.objectContaining({ id: 2, status: 'available', current_order_id: null }),
                expect.objectContaining({ id: 3, status: 'occupied', current_order_id: foreignOrder.insertId, parent_table_id: 2 })
            ]);
            const [[foreignStillLive]] = await pool.query(
                'SELECT payment_method, table_id FROM orders WHERE invoice_id=?',
                [foreignOrder.insertId]
            );
            expect(foreignStillLive).toMatchObject({ payment_method: 'unpaid_table', table_id: 3 });
        });

        it('transfers a saved table order without changing items, totals, or checkout identity', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 2, price: SEED.product1.price },
                    { id: SEED.product2.id, qty: 1, price: SEED.product2.price }
                ],
                12.00, 1.60, 13.60
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'transfer'
                }));

            expect(res.statusCode).toBe(200);

            const [[order]] = await pool.query(
                `SELECT table_id, payment_method, subtotal, tax, total, order_id, invoice_number, invoice_issued_at
                   FROM orders WHERE invoice_id = ?`,
                [invoiceId]
            );
            expect(order.table_id).toBe(SEED.table2.id);
            expect(order.payment_method).toBe('unpaid_table');
            expect(Number(order.subtotal)).toBe(12.00);
            expect(Number(order.tax)).toBe(1.60);
            expect(Number(order.total)).toBe(13.60);
            expect(order.order_id).toBeNull();
            expect(order.invoice_number).toBeNull();
            expect(order.invoice_issued_at).toBeNull();

            const [items] = await pool.query(
                "SELECT product_id, quantity, price_at_sale FROM order_items WHERE invoice_id = ? ORDER BY product_id ASC",
                [invoiceId]
            );
            expect(items.map(i => ({
                product_id: i.product_id,
                quantity: Number(i.quantity),
                price_at_sale: Number(i.price_at_sale)
            }))).toEqual([
                { product_id: SEED.product1.id, quantity: 2, price_at_sale: Number(SEED.product1.price) },
                { product_id: SEED.product2.id, quantity: 1, price_at_sale: Number(SEED.product2.price) }
            ]);

            const reload = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(reload.statusCode).toBe(200);
            expect(reload.body.table_display_no).toBe(String(SEED.table2.table_number));
            expect(reload.body.order_display_no).toBeNull();
            expect(reload.body.invoice_display_no).toBeNull();
            expect(reload.body.cart).toHaveLength(2);
        });

        it('refuses a plain transfer to an occupied table without mutating either order', async () => {
            const sourceInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const targetInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'transfer'
                }));

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('TARGET_OCCUPIED');

            const [[sourceTable]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            const [[targetTable]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(sourceTable.status).toBe('occupied');
            expect(sourceTable.current_order_id).toBe(sourceInvoiceId);
            expect(targetTable.status).toBe('occupied');
            expect(targetTable.current_order_id).toBe(targetInvoiceId);

            const [orders] = await pool.query(
                "SELECT invoice_id, table_id FROM orders WHERE invoice_id IN (?, ?) ORDER BY invoice_id ASC",
                [sourceInvoiceId, targetInvoiceId]
            );
            expect(orders.map(o => ({ invoice_id: o.invoice_id, table_id: o.table_id }))).toEqual([
                { invoice_id: sourceInvoiceId, table_id: SEED.table.id },
                { invoice_id: targetInvoiceId, table_id: SEED.table2.id }
            ]);
        });

        it('rejects unknown table transfer actions', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'teleport'
                }));

            expect(res.statusCode).toBe(400);
            expect(res.body.message).toContain('Invalid table action');

            const [[sourceTable]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            const [[targetTable]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(sourceTable.status).toBe('occupied');
            expect(sourceTable.current_order_id).toBe(invoiceId);
            expect(targetTable.status).toBe('available');
            expect(targetTable.current_order_id).toBeNull();
        });

        it('should successfully swap orders between two occupied tables', async () => {
            const invoiceId1 = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const invoiceId2 = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'swap'
                }));

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify swapped order IDs
            const [t1Rows] = await pool.query("SELECT current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1Rows[0].current_order_id).toBe(invoiceId2);

            const [t2Rows] = await pool.query("SELECT current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2Rows[0].current_order_id).toBe(invoiceId1);

            // Verify orders table references
            const [order1] = await pool.query("SELECT table_id FROM orders WHERE invoice_id = ?", [invoiceId1]);
            expect(order1[0].table_id).toBe(SEED.table2.id);

            const [order2] = await pool.query("SELECT table_id FROM orders WHERE invoice_id = ?", [invoiceId2]);
            expect(order2[0].table_id).toBe(SEED.table.id);
        });

        it('swaps status and order identity across both joined table groups (legacy shared bill)', async () => {
            await pool.query(
                `INSERT INTO restaurant_tables (id, section_id, table_number, status)
                 VALUES (3, 1, '3', 'available'), (4, 1, '4', 'available')`
            );
            await seedLegacySharedSeats(pool, SEED.table.id, [3]);
            await seedLegacySharedSeats(pool, SEED.table2.id, [4]);

            const sourceInvoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const targetInvoiceId = await createTableOrder(
                adminCookie, SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            expect((await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table2.id,
                    expected_invoice_id: targetInvoiceId
                })).statusCode).toBe(200);

            const swapped = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'swap'
                }));
            expect(swapped.statusCode).toBe(200);

            const [groups] = await pool.query(
                'SELECT id, status, current_order_id FROM restaurant_tables WHERE id IN (1,2,3,4) ORDER BY id'
            );
            expect(groups).toEqual([
                expect.objectContaining({ id: 1, status: 'printed', current_order_id: targetInvoiceId }),
                expect.objectContaining({ id: 2, status: 'occupied', current_order_id: sourceInvoiceId }),
                expect.objectContaining({ id: 3, status: 'printed', current_order_id: targetInvoiceId }),
                expect.objectContaining({ id: 4, status: 'occupied', current_order_id: sourceInvoiceId })
            ]);

            const reprint = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    action: 'mark_printed',
                    table_id: 3,
                    expected_invoice_id: targetInvoiceId
                });
            expect(reprint.statusCode).toBe(200);
        });

        it('should successfully merge orders and recalculate totals correctly', async () => {
            const invoiceId1 = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }], // 5.00 subtotal, 0.80 tax
                5.00, 0.80, 5.80
            );
            const invoiceId2 = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }], // 2.00 subtotal, 0.00 tax
                2.00, 0.00, 2.00
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'merge'
                }));

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            // Source table should be empty
            const [t1Rows] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1Rows[0].status).toBe('available');
            expect(t1Rows[0].current_order_id).toBeNull();

            // Target table should contain merged order
            const [t2Rows] = await pool.query("SELECT current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2Rows[0].current_order_id).toBe(invoiceId2);

            // Target order total should be recalculated (subtotal=7.00, tax=0.80, total=7.80)
            const [orders] = await pool.query("SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?", [invoiceId2]);
            expect(Number(orders[0].subtotal)).toBe(7.00);
            expect(Number(orders[0].tax)).toBe(0.80);
            expect(Number(orders[0].total)).toBe(7.80);

            // Items of target order should include both products
            const [items] = await pool.query("SELECT product_id, quantity FROM order_items WHERE invoice_id = ?", [invoiceId2]);
            expect(items).toHaveLength(2);
        });

        it('rejects merge when a table points at a finalized source invoice', async () => {
            const sourceInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const targetInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await pool.query(
                "UPDATE orders SET payment_method = 'cash', amount_tendered = total, cash_amount = total, invoice_number = 991, invoice_issued_at = NOW() WHERE invoice_id = ?",
                [sourceInvoiceId]
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'merge'
                }));

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toMatch(/finalized/i);

            const [[sourceOrder]] = await pool.query(
                "SELECT payment_method FROM orders WHERE invoice_id = ?",
                [sourceInvoiceId]
            );
            expect(sourceOrder.payment_method).toBe('cash');

            const [[sourceTable]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            expect(sourceTable.status).toBe('occupied');
            expect(Number(sourceTable.current_order_id)).toBe(Number(sourceInvoiceId));

            const [[targetTable]] = await pool.query(
                "SELECT current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(Number(targetTable.current_order_id)).toBe(Number(targetInvoiceId));
        });

        it('restamps merged line tax so later item voids use correct tax math', async () => {
            const sourceInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const targetInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const mergeRes = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'merge'
                }));

            expect(mergeRes.statusCode).toBe(200);
            expect(mergeRes.body.success).toBe(true);

            const [[order]] = await pool.query(
                "SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?",
                [targetInvoiceId]
            );
            expect(Number(order.subtotal)).toBe(10);
            expect(Number(order.tax)).toBe(1.6);
            expect(Number(order.total)).toBe(11.6);

            const [items] = await pool.query(
                "SELECT id, quantity, tax_amount FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL",
                [targetInvoiceId]
            );
            expect(items).toHaveLength(1);
            expect(Number(items[0].quantity)).toBe(2);
            expect(Number(items[0].tax_amount)).toBeCloseTo(1.6, 2);

            const [[sumTax]] = await pool.query(
                "SELECT ROUND(SUM(tax_amount), 2) AS line_tax FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL",
                [targetInvoiceId]
            );
            expect(Number(sumTax.line_tax)).toBe(Number(order.tax));

            const voidRes = await request(app)
                .post('/api/pos/refunds')
                .set('Cookie', adminCookie)
                .send({
                    invoice_id: targetInvoiceId,
                    expected_version: await currentTableRevision(targetInvoiceId), intent: 'void',
                    items: [{ order_item_id: items[0].id, qty: 1 }]
                });

            expect(voidRes.statusCode).toBe(200);

            const [[refundItem]] = await pool.query(
                "SELECT line_tax FROM refund_items WHERE order_item_id = ? ORDER BY id DESC LIMIT 1",
                [items[0].id]
            );
            expect(Number(refundItem.line_tax)).toBe(0.8);

            const [[remainingOrder]] = await pool.query(
                "SELECT subtotal, tax, total, payment_method, refund_status FROM orders WHERE invoice_id = ?",
                [targetInvoiceId]
            );
            expect(Number(remainingOrder.subtotal)).toBe(5);
            expect(Number(remainingOrder.tax)).toBe(0.8);
            expect(Number(remainingOrder.total)).toBe(5.8);
            expect(remainingOrder.payment_method).toBe('unpaid_table');
            expect(remainingOrder.refund_status).toBe('partial');

            const [[sourceTable]] = await pool.query(
                "SELECT current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            expect(sourceTable.current_order_id).toBeNull();

            const [[sourceOrderCount]] = await pool.query(
                "SELECT COUNT(*) AS count FROM orders WHERE invoice_id = ?",
                [sourceInvoiceId]
            );
            expect(Number(sourceOrderCount.count)).toBe(0);
        });

        it('rejects transfer without permission even when a manager PIN is supplied', async () => {
            await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const resNoPin = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', waiterCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'transfer'
                }));
            expect(resNoPin.statusCode).toBe(403);
            expect(resNoPin.body.message).toContain('Transfer table permission required');

            const resWithPin = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', waiterCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table.id,
                    targetTableId: SEED.table2.id,
                    action: 'transfer',
                    managerPin: SEED.adminUser.pin
                }));
            expect(resWithPin.statusCode).toBe(403);
            expect(resWithPin.body.message).toContain('Transfer table permission required');

            const [[sourceTable]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            const [[targetTable]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(sourceTable.status).toBe('occupied');
            expect(sourceTable.current_order_id).not.toBeNull();
            expect(targetTable.status).toBe('available');
            expect(targetTable.current_order_id).toBeNull();
        });

        it('should successfully join and disjoin child tables', async () => {
            // Join T2 to T1
            const joinRes = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({
                    parentTableId: SEED.table.id,
                    childTableIds: [SEED.table2.id]
                });
            expect(joinRes.statusCode).toBe(200);

            let [t2Rows] = await pool.query("SELECT seating_parent_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2Rows[0].seating_parent_id).toBe(SEED.table.id);

            // Separating T2
            const disjoinRes = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({
                    tableIds: [SEED.table2.id]
                });
            expect(disjoinRes.statusCode).toBe(200);

            [t2Rows] = await pool.query("SELECT seating_parent_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2Rows[0].seating_parent_id).toBeNull();
        });

        it('should redirect order saving on child table to parent table context (legacy shared bill)', async () => {
            // 1. Join T2 to T1
            await seedLegacySharedSeats(pool, SEED.table.id, [SEED.table2.id]);

            // 2. Save order on child table T2
            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table2.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });
            expect(orderRes.statusCode).toBe(200);
            const invoiceId = orderRes.body.order_id; // the order invoice ID

            // 3. Verify order table ID is redirected to T1 (parent) in database
            const [orders] = await pool.query("SELECT table_id FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(orders[0].table_id).toBe(SEED.table.id);

            // 4. Verify parent T1 and child T2 both have current_order_id set to invoiceId
            const [t1Rows] = await pool.query("SELECT current_order_id, status FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1Rows[0].current_order_id).toBe(invoiceId);
            expect(t1Rows[0].status).toBe('occupied');

            const [t2Rows] = await pool.query("SELECT current_order_id, status FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2Rows[0].current_order_id).toBe(invoiceId);
            expect(t2Rows[0].status).toBe('occupied');
        });

        it('should release parent and child tables upon payment checkout finalization (legacy shared bill)', async () => {
            // 1. Join T2 to T1
            await seedLegacySharedSeats(pool, SEED.table.id, [SEED.table2.id]);

            // 2. Save order on T1 (parent) -> occupies both
            const orderId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            // 3. Checkout (finalize payment)
            const checkoutRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    edit_invoice_id: orderId,
                    edit_order_id: 1,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    shift_id: cashierShiftId,
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80,
                    payment_method: 'cash',
                    amount_tendered: 10.00,
                    change_due: 4.20,
                    table_id: SEED.table.id
                });
            expect(checkoutRes.statusCode).toBe(200);

            // 4. Verify both parent and child tables are released (status=available, current_order_id=NULL, parent_table_id=NULL)
            const [t1Rows] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1Rows[0].status).toBe('available');
            expect(t1Rows[0].current_order_id).toBeNull();

            const [t2Rows] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2Rows[0].status).toBe('available');
            expect(t2Rows[0].current_order_id).toBeNull();
            expect(t2Rows[0].parent_table_id).toBeNull();
        });

        it('should lock source and target tables in ascending ID order to prevent deadlocks', async () => {
            await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );

            const originalGetConnection = pool.getConnection;
            const lockBatches = [];

            pool.getConnection = async function() {
                const conn = await originalGetConnection.call(this);
                const originalExecute = conn.execute;
                const originalRelease = conn.release;

                conn.execute = async function(sql, params) {
                    if (typeof sql === 'string' && sql.includes('FOR UPDATE') && sql.includes('restaurant_tables')) {
                        lockBatches.push(params.map(Number));
                    }
                    return originalExecute.call(this, sql, params);
                };

                conn.release = function () {
                    conn.execute = originalExecute;
                    conn.release = originalRelease;
                    pool.getConnection = originalGetConnection;
                    return originalRelease.call(this);
                };

                return conn;
            };

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, {
                    sourceTableId: SEED.table2.id,
                    targetTableId: SEED.table.id,
                    action: 'swap'
                }));

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            const sortedIds = [Number(SEED.table.id), Number(SEED.table2.id)].sort((a, b) => a - b);
            expect(lockBatches).toEqual([[...sortedIds, ...sortedIds]]);

        });

        it('P1-4: transfer fully releases the source table joined children (no ghost occupied) (legacy shared bill)', async () => {
            // empty transfer target (seed only ships tables 1 & 2)
            await pool.query("INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')");

            // order on source T1
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            // join T2 as a child of T1 (mirrors T1's order + occupied status)
            await seedLegacySharedSeats(pool, SEED.table.id, [SEED.table2.id]);


            // transfer T1 -> empty T3
            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: 3, action: 'transfer' }));
            expect(res.statusCode).toBe(200);

            // order moved to T3
            const [[t3]] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = 3");
            expect(t3.status).toBe('occupied');
            expect(t3.current_order_id).toBe(invoiceId);
            const [[ord]] = await pool.query("SELECT table_id FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(ord.table_id).toBe(3);

            // source T1 released
            const [[t1]] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1.status).toBe('available');
            expect(t1.current_order_id).toBeNull();

            // child T2 FULLY released — never a ghost (occupied with null order + dangling parent)
            const [[t2]] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2.status).toBe('available');
            expect(t2.current_order_id).toBeNull();
            expect(t2.parent_table_id).toBeNull();
        });

        it('P2-5: merge writes a table_merge audit event snapshotting the deleted source order', async () => {
            // source order with 2+ items so the snapshot array is non-trivial
            const sourceInvoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product2.id, qty: 1, price: SEED.product2.price }
                ],
                7.00, 0.80, 7.80
            );
            const targetInvoiceId = await createTableOrder(
                adminCookie, SEED.table2.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge' }));
            expect(res.statusCode).toBe(200);

            const [events] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'table_merge' AND entity_id = ? ORDER BY id DESC",
                [sourceInvoiceId]
            );
            expect(events.length).toBeGreaterThan(0);

            const ev = events[0];
            expect(ev.user_id).toBe(SEED.adminUser.id);
            expect(ev.entity_type).toBe('order');

            const oldVal = JSON.parse(ev.old_value);
            const newVal = JSON.parse(ev.new_value);
            expect(Array.isArray(oldVal.items)).toBe(true);
            expect(oldVal.items.length).toBeGreaterThanOrEqual(2);
            const burgerLine = oldVal.items.find(i => i.product_id === SEED.product1.id);
            expect(burgerLine).toBeDefined();
            expect(Number(burgerLine.quantity)).toBe(1);
            expect(newVal.target_invoice_id).toBe(targetInvoiceId);
            expect(newVal.source_table_id).toBe(SEED.table.id);
            expect(newVal.target_table_id).toBe(SEED.table2.id);
        });

        it('P3-12: merge clears parent_table_id on released source children (no phantom Joined badge) (legacy shared bill)', async () => {
            // empty merge target
            await pool.query("INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')");

            // source order on T1
            await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            // target order on T3 (merge requires an occupied target)
            await createTableOrder(
                adminCookie, 3,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            // join T2 as a child of the source T1
            await seedLegacySharedSeats(pool, SEED.table.id, [SEED.table2.id]);


            // merge source T1 -> target T3
            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: 3, action: 'merge' }));
            expect(res.statusCode).toBe(200);

            // child T2 fully released — parent link cleared
            const [[t2]] = await pool.query(
                "SELECT parent_table_id, status, current_order_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(t2.parent_table_id).toBeNull();
            expect(t2.status).toBe('available');
            expect(t2.current_order_id).toBeNull();
        });

        it('preserves selected_modifiers during order merge (Task 5)', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 0.50 }] }]),
                SEED.product1.id
            ]);

            const invoiceId1 = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: 5.50,
                    tax_rate: 16,
                    note: 'Size: Large (0.50 JD) - A',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.50 }]
                }],
                5.50, 0.88, 6.38
            );
            const invoiceId2 = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{
                    id: SEED.product1.id,
                    qty: 1,
                    price: 5.50,
                    tax_rate: 16,
                    note: 'Size: Large (0.50 JD) - B',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.50 }]
                }],
                5.50, 0.88, 6.38
            );

            try {
                const res = await request(app)
                    .post('/api/pos/tables/transfer')
                    .set('Cookie', adminCookie)
                    .send(await tableActionIntent(pool, {
                        sourceTableId: SEED.table.id,
                        targetTableId: SEED.table2.id,
                        action: 'merge'
                    }));

                expect(res.statusCode).toBe(200);
                expect(res.body.success).toBe(true);

                const [rows] = await pool.query(
                    "SELECT selected_modifiers FROM order_items WHERE invoice_id = ? AND product_id = ? ORDER BY id DESC LIMIT 1",
                    [invoiceId2, SEED.product1.id]
                );
                expect(JSON.parse(rows[0].selected_modifiers)).toEqual([
                    { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
                ]);
            } finally {
                await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
            }
        });

        it('table merge copies a seeded modifier_surcharge and does not collapse rows with different surcharges', async () => {
            await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
                JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
                SEED.modifierProduct.id
            ]);

            const invoiceId1 = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{
                    id: SEED.modifierProduct.id,
                    qty: 1,
                    price: 7.00,
                    tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                }],
                7.00, 1.12, 8.12
            );

            const invoiceId2 = await createTableOrder(
                adminCookie,
                SEED.table2.id,
                [{
                    id: SEED.modifierProduct.id,
                    qty: 1,
                    price: 5.00,
                    tax_rate: 16,
                    note: 'Size: Regular',
                    selectedModifiers: []
                }],
                5.00, 0.80, 5.80
            );

            const [sourceItems] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ?', [invoiceId1]);
            await pool.query('UPDATE order_items SET modifier_surcharge = 2.00, tax_amount = 0.80 WHERE id = ?', [sourceItems[0].id]);
            await pool.query('UPDATE orders SET tax = 0.80, total = 7.80 WHERE invoice_id = ?', [invoiceId1]);

            try {
                const res = await request(app)
                    .post('/api/pos/tables/transfer')
                    .set('Cookie', adminCookie)
                    .send(await tableActionIntent(pool, {
                        sourceTableId: SEED.table.id,
                        targetTableId: SEED.table2.id,
                        action: 'merge'
                    }));

                expect(res.statusCode).toBe(200);

                const [rows] = await pool.query(
                    "SELECT quantity, modifier_surcharge, tax_amount FROM order_items WHERE invoice_id = ? ORDER BY id ASC",
                    [invoiceId2]
                );
                expect(rows).toHaveLength(2);
                expect(rows[0].modifier_surcharge).toBeNull();
                expect(Number(rows[1].modifier_surcharge)).toBe(2);
                expect(Number(rows[1].tax_amount)).toBeCloseTo(1.075862, 6);

                const [[targetOrder]] = await pool.query("SELECT tax, total FROM orders WHERE invoice_id = ?", [invoiceId2]);
                expect(Number(targetOrder.tax)).toBeCloseTo(1.88, 2);
                expect(Number(targetOrder.total)).toBeCloseTo(13.60, 2);
            } finally {
                await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
            }
        });
    });

    describe('Disjoin guard (P2-4)', () => {
        it('rejects disjoining a standalone (non-child) seat and leaves it untouched', async () => {
            // Seat a standalone table — parent_table_id IS NULL, has an open order.
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({ tableIds: [SEED.table.id] });

            expect(res.statusCode).toBeGreaterThanOrEqual(400);
            expect(res.statusCode).toBeLessThan(500);
            expect(res.body.success).toBe(false);

            // Untouched: still occupied, order still referenced (not orphaned).
            const [[t1]] = await pool.query(
                "SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?",
                [SEED.table.id]
            );
            expect(t1.status).toBe('occupied');
            expect(t1.current_order_id).toBe(invoiceId);
            expect(t1.parent_table_id).toBeNull();
        });

        it('releases a genuine joined child and writes a table_disjoin audit event', async () => {
            // Join T2 as a child of T1 (parent has no order — child mirrors available/null).
            const joinRes = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });
            expect(joinRes.statusCode).toBe(200);

            const res = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({ tableIds: [SEED.table2.id] });
            expect(res.statusCode).toBe(200);

            const [[t2]] = await pool.query(
                "SELECT seating_parent_id FROM restaurant_tables WHERE id = ?",
                [SEED.table2.id]
            );
            expect(t2.seating_parent_id).toBeNull();

            const [events] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'table_disjoin' AND entity_id = ? ORDER BY id DESC",
                [SEED.table.id]
            );
            expect(events.length).toBeGreaterThan(0);
            const ev = events[0];
            expect(ev.user_id).toBe(SEED.adminUser.id);
            const newVal = JSON.parse(ev.new_value);
            expect(newVal.separated_ids).toContain(SEED.table2.id);
        });

        it('disjoins same-parent children as a sorted, de-duplicated batch', async () => {
            await pool.query("INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available')");

            const joinRes = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id, 3] });
            expect(joinRes.statusCode).toBe(200);

            const res = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({ tableIds: [3, SEED.table2.id, SEED.table2.id] });
            expect(res.statusCode).toBe(200);

            const [children] = await pool.query(
                "SELECT id, seating_parent_id FROM restaurant_tables WHERE id IN (?, ?) ORDER BY id",
                [SEED.table2.id, 3]
            );
            expect(children).toEqual([
                expect.objectContaining({ id: SEED.table2.id, seating_parent_id: null }),
                expect.objectContaining({ id: 3, seating_parent_id: null }),
            ]);

            const [events] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'table_disjoin' AND entity_id = ? ORDER BY id DESC",
                [SEED.table.id]
            );
            expect(events.length).toBeGreaterThan(0);
            const newVal = JSON.parse(events[0].new_value);
            expect(newVal.separated_ids).toEqual([SEED.table2.id, 3]);
        });

        it('rejects mixed-parent disjoin batches and leaves all children joined', async () => {
            await pool.query(
                "INSERT INTO restaurant_tables (id, section_id, table_number, status) VALUES (3, 1, '3', 'available'), (4, 1, '4', 'available')"
            );

            const joinFirstParent = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });
            expect(joinFirstParent.statusCode).toBe(200);

            const joinSecondParent = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: 3, childTableIds: [4] });
            expect(joinSecondParent.statusCode).toBe(200);

            const res = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({ tableIds: [SEED.table2.id, 4] });
            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);

            const [children] = await pool.query(
                "SELECT id, seating_parent_id FROM restaurant_tables WHERE id IN (?, ?) ORDER BY id",
                [SEED.table2.id, 4]
            );
            expect(children).toEqual([
                expect.objectContaining({ id: SEED.table2.id, seating_parent_id: SEED.table.id }),
                expect.objectContaining({ id: 4, seating_parent_id: 3 }),
            ]);
        });

        it('rolls back a merge when the table_merge audit insert fails', async () => {
            // source order
            const sourceInvoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            // target order
            const targetInvoiceId = await createTableOrder(
                adminCookie, SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );

            // Fail table_merge query
            failNextConnectionQuery(
                (sql, params) => typeof sql === 'string' && sql.includes('INSERT INTO audit_events') && params?.[0] === 'table_merge',
                'Simulated table_merge audit insert failure'
            );

            const res = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge' }));
            expect(res.statusCode).toBe(500);

            // Verify rollback: source table order still exists on T1, target order on T2 unchanged
            const [[t1]] = await pool.query("SELECT current_order_id, status FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1.current_order_id).toBe(sourceInvoiceId);
            expect(t1.status).toBe('occupied');

            const [[t2]] = await pool.query("SELECT current_order_id, status FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2.current_order_id).toBe(targetInvoiceId);
            expect(t2.status).toBe('occupied');

            // Verify order items were not deleted
            const [srcItems] = await pool.query("SELECT id FROM order_items WHERE invoice_id = ?", [sourceInvoiceId]);
            expect(srcItems.length).toBe(1);

            const [targetItems] = await pool.query(
                "SELECT product_id, quantity, price_at_sale FROM order_items WHERE invoice_id = ?",
                [targetInvoiceId]
            );
            expect(targetItems.length).toBe(1);
            expect(targetItems[0].product_id).toBe(SEED.product2.id);
            expect(Number(targetItems[0].quantity)).toBeCloseTo(1);
            expect(Number(targetItems[0].price_at_sale)).toBeCloseTo(SEED.product2.price);

            const [[targetOrder]] = await pool.query(
                "SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?",
                [targetInvoiceId]
            );
            expect(Number(targetOrder.subtotal)).toBeCloseTo(2.00);
            expect(Number(targetOrder.tax)).toBeCloseTo(0.00);
            expect(Number(targetOrder.total)).toBeCloseTo(2.00);
        });

        it('rolls back a disjoin when the table_disjoin audit insert fails', async () => {
            // Join T2 to T1
            const joinRes = await request(app)
                .post('/api/pos/tables/join')
                .set('Cookie', adminCookie)
                .send({ parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] });
            expect(joinRes.statusCode).toBe(200);

            // Fail table_disjoin query
            failNextConnectionQuery(
                (sql, params) => typeof sql === 'string' && sql.includes('INSERT INTO audit_events') && params?.[0] === 'table_disjoin',
                'Simulated table_disjoin audit insert failure'
            );

            const res = await request(app)
                .post('/api/pos/tables/disjoin')
                .set('Cookie', adminCookie)
                .send({ tableIds: [SEED.table2.id] });
            expect(res.statusCode).toBe(500);

            // Verify rollback: T2 still joined to T1
            const [[t2]] = await pool.query("SELECT seating_parent_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2.seating_parent_id).toBe(SEED.table.id);
        });
    });

    describe('Legacy table-save void path is closed', () => {
        it('rejects an item reduction without writing legacy void audit data', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });
            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('Saved items must be removed with the Remove action.');
            expect(await waitForAuditCount('void_item', invoiceId, 0)).toBe(0);
            const [[item]] = await pool.query(
                'SELECT quantity FROM order_items WHERE invoice_id=? AND product_id=?',
                [invoiceId, SEED.product1.id]
            );
            expect(Number(item.quantity)).toBe(2);
        });
    });

    describe('P1-3: void_item audit is committed only after the transaction', () => {
        it('writes NO phantom void_item audit row when a post-audit validation rolls the txn back', async () => {
            // Saved table order with 2 burgers (admin holds void + printed-bypass perms).
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // Re-save that REDUCES the burger 2 -> 1 (builds auditedVoidItems) AND attaches a
            // forged bundle line: product2 is NOT a bundle, so validateBundleCartLines throws
            // 400 AFTER the audit insert but BEFORE commit -> whole transaction rolls back.
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [
                        { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                        { id: SEED.product2.id, qty: 1, price: 2.00, bundleItems: [{ product_id: SEED.product1.id, qty: 1 }] }
                    ],
                    subtotal: 7.00, tax: 0.80, total: 7.80
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/bundle/i);

            expect(await waitForAuditCount('void_item', invoiceId, 0)).toBe(0);

            // The reduction rolled back: the burger is still qty 2.
            const [items] = await pool.query(
                "SELECT quantity FROM order_items WHERE invoice_id = ? AND product_id = ?",
                [invoiceId, SEED.product1.id]
            );
            expect(Number(items[0].quantity)).toBe(2);
        });

        it('rejects a saved-item reduction before any legacy void_item audit insert', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            failNextConnectionQuery(
                (sql, params) => typeof sql === 'string' && sql.includes('INSERT INTO audit_events') && params?.[0] === 'void_item',
                'Simulated audit insert failure'
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(409);

            expect(await waitForAuditCount('void_item', invoiceId, 0)).toBe(0);

            const [items] = await pool.query(
                "SELECT quantity FROM order_items WHERE invoice_id = ? AND product_id = ?",
                [invoiceId, SEED.product1.id]
            );
            expect(Number(items[0].quantity)).toBe(2);
        });

        it('never writes a void_item audit row through table-save reduction', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(409);

            expect(await waitForAuditCount('void_item', invoiceId, 0)).toBe(0);
        });
    });

    describe('P1-3: void_order (empty-cart) audit is committed only after the transaction', () => {
        it('rejects empty saved cart before table release mutation', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            // Force the table-release UPDATE (runs after the void_order payload is captured,
            // before commit) to throw, so the whole void transaction rolls back.
            failNextConnectionQuery(
                sql => typeof sql === 'string' && sql.includes("SET status = 'available'"),
                'Simulated crash after void audit'
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart: [] });
            expect(res.statusCode).toBe(409);

            expect(await waitForAuditCount('void_order', invoiceId, 0)).toBe(0);

            // The void rolled back: still a live unpaid table order.
            const [[o]] = await pool.query(
                "SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]
            );
            expect(o.payment_method).toBe('unpaid_table');
        });

        it('rejects empty saved cart before any legacy void_order audit insert', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            failNextConnectionQuery(
                (sql, params) => typeof sql === 'string' && sql.includes('INSERT INTO audit_events') && params?.[0] === 'void_order',
                'Simulated audit insert failure'
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart: [] });
            expect(res.statusCode).toBe(409);

            expect(await waitForAuditCount('void_order', invoiceId, 0)).toBe(0);

            const [[o]] = await pool.query(
                "SELECT payment_method, total FROM orders WHERE invoice_id = ?", [invoiceId]
            );
            expect(o.payment_method).toBe('unpaid_table');
            expect(Number(o.total)).toBe(5.80);

            const [[t]] = await pool.query(
                "SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]
            );
            expect(t.status).toBe('occupied');
            expect(t.current_order_id).toBe(invoiceId);
        });

        it('never writes void_order through table-save empty cart', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart: [] });
            expect(res.statusCode).toBe(409);

            expect(await waitForAuditCount('void_order', invoiceId, 0)).toBe(0);
        });
    });

    describe('progressive split-open audit is committed only with the transaction', () => {
        it('writes no phantom split-open audit when bucket persistence rolls back', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // Force the first held_orders INSERT (runs after the void_split payload is
            // captured, before commit) to throw, rolling back the whole split.
            failNextConnectionQuery(
                sql => typeof sql === 'string' && sql.includes('INSERT INTO held_orders'),
                'Simulated crash after split audit'
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                        { referenceName: 'Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                    ]
                });
            expect(res.statusCode).toBe(500);

            expect(await waitForAuditCount('split_check_opened', invoiceId, 0)).toBe(0);

            // The split rolled back: the original order is NOT voided.
            const [[o]] = await pool.query(
                "SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]
            );
            expect(o.payment_method).toBe('unpaid_table');
        });

        it('rolls back a bill split when the split-open audit insert fails', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            failNextConnectionQuery(
                (sql, params) => typeof sql === 'string'
                    && sql.includes('INSERT INTO audit_events')
                    && params?.[0]?.some(row => row[0] === 'split_check_opened'),
                'Simulated audit insert failure'
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                        { referenceName: 'Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                    ]
                });
            expect(res.statusCode).toBe(500);

            expect(await waitForAuditCount('split_check_opened', invoiceId, 0)).toBe(0);

            const [[o]] = await pool.query(
                "SELECT payment_method FROM orders WHERE invoice_id = ?", [invoiceId]
            );
            expect(o.payment_method).toBe('unpaid_table');
            const [[{ c: heldCount }]] = await pool.query(
                "SELECT COUNT(*) AS c FROM held_orders WHERE reference_name LIKE 'Seat %'"
            );
            expect(Number(heldCount)).toBe(0);
        });

        it('writes exactly one split-open audit row on a successful split', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                        { referenceName: 'Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                    ]
                });
            expect(res.statusCode).toBe(200);

            expect(await waitForAuditCount('split_check_opened', invoiceId, 1)).toBe(1);
        });
    });

    describe('mark_printed authorization (check-drop)', () => {
        it('lets a cashier drop the check on a table order (legit guest-check flow)', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            expect(invoiceId).toBeTruthy();

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table.id,
                    expected_invoice_id: invoiceId
                });
            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                status: 'printed',
                invoice_id: invoiceId,
                table_ids: [SEED.table.id]
            });

            const [[row]] = await pool.query("SELECT status FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(row.status).toBe('printed');
        });

        it('rejects mark_printed from a user with no check-drop capability (IDOR guard)', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            // Strip the cashier down to a permission set with no checkout/edit rights,
            // then re-login so the session cache reflects it.
            await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [SEED.cashierUser.id]);
            await pool.query("INSERT INTO user_permissions (user_id, perm_key) VALUES (?, 'shift.open')", [SEED.cashierUser.id]);
            invalidateUserSessions(SEED.cashierUser.id);
            const relog = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.cashierUser.user_number });
            const strippedCookie = relog.headers['set-cookie'][0];

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', strippedCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table.id,
                    expected_invoice_id: invoiceId
                });
            expect(res.statusCode).toBe(403);

            const [[row]] = await pool.query("SELECT status FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(row.status).not.toBe('printed');
        });

        it('requires the expected invoice id', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({ action: 'mark_printed', table_id: SEED.table.id });
            expect(res.statusCode).toBe(400);
        });

        it('returns 409 when the table has no open order to print', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table.id,
                    expected_invoice_id: 999999
                });
            expect(res.statusCode).toBe(409);
        });

        it('returns 404 for a non-existent table', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({ action: 'mark_printed', table_id: 999999, expected_invoice_id: 1 });
            expect(res.statusCode).toBe(404);
        });

        it('rejects a stale expected invoice and leaves the live table occupied', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table.id,
                    expected_invoice_id: invoiceId + 1
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
            const [[table]] = await pool.query(
                'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
                [SEED.table.id]
            );
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(invoiceId);
        });

        it('marks the root and every joined child as printed together', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            await pool.query(
                `UPDATE restaurant_tables
                    SET status='occupied', current_order_id=?, parent_table_id=?
                  WHERE id=?`,
                [invoiceId, SEED.table.id, SEED.table2.id]
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table2.id,
                    expected_invoice_id: invoiceId
                });

            expect(res.statusCode).toBe(200);
            expect(res.body.table_ids).toEqual([SEED.table.id, SEED.table2.id]);
            const [tables] = await pool.query(
                'SELECT id, status, current_order_id FROM restaurant_tables WHERE id IN (?,?) ORDER BY id',
                [SEED.table.id, SEED.table2.id]
            );
            expect(tables).toEqual([
                expect.objectContaining({ id: SEED.table.id, status: 'printed', current_order_id: invoiceId }),
                expect.objectContaining({ id: SEED.table2.id, status: 'printed', current_order_id: invoiceId })
            ]);
        });

        it('checkout racing mark-printed never leaves printed with a null order', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const [[savedItem]] = await pool.query(
                'SELECT id FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
                [invoiceId]
            );
            const [mark, checkout] = await Promise.all([
                request(app)
                    .post('/api/pos/table_order')
                    .set('Cookie', cashierCookie)
                    .send({
                        action: 'mark_printed',
                        table_id: SEED.table.id,
                        expected_invoice_id: invoiceId
                    }),
                request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        edit_invoice_id: invoiceId,
                        table_id: SEED.table.id,
                        shift_id: cashierShiftId,
                        cart: [{
                            id: SEED.product1.id,
                            qty: 1,
                            price: SEED.product1.price,
                            order_item_id: savedItem.id
                        }],
                        subtotal: 5.00,
                        tax: 0.80,
                        total: 5.80,
                        payment_method: 'cash',
                        amount_tendered: 6.00,
                        change_due: 0.20,
                        idempotency_key: `mark-checkout-race-${invoiceId}`
                    })
            ]);

            expect([200, 409]).toContain(mark.statusCode);
            expect([200, 409]).toContain(checkout.statusCode);
            const [[table]] = await pool.query(
                'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
                [SEED.table.id]
            );
            expect(table.status === 'printed' && table.current_order_id == null).toBe(false);
        });

        it('allows the same live invoice to be marked printed again for a reprint', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const payload = {
                action: 'mark_printed',
                table_id: SEED.table.id,
                expected_invoice_id: invoiceId
            };

            const first = await request(app).post('/api/pos/table_order')
                .set('Cookie', cashierCookie).send(payload);
            const second = await request(app).post('/api/pos/table_order')
                .set('Cookie', cashierCookie).send(payload);

            expect(first.statusCode).toBe(200);
            expect(second.statusCode).toBe(200);
            expect(second.body).toMatchObject({ status: 'printed', invoice_id: invoiceId });
        });

        it('returns a table-session conflict on a mark-printed deadlock without changing state', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const deadlock = new Error('simulated deadlock');
            deadlock.code = 'ER_LOCK_DEADLOCK';
            deadlock.errno = 1213;
            failNextConnectionQuery(
                sql => /UPDATE\s+restaurant_tables[\s\S]+SET\s+status='printed'/i.test(String(sql)),
                deadlock
            );

            const res = await request(app).post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({
                    action: 'mark_printed',
                    table_id: SEED.table.id,
                    expected_invoice_id: invoiceId
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
            const [[table]] = await pool.query(
                'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
                [SEED.table.id]
            );
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(invoiceId);
        });
    });

    describe('Saved-item modification boundaries', () => {
        // Grant the waiter an exact permission set and return a fresh authenticated cookie.
        async function grantWaiter(keys) {
            await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [SEED.waiterUser.id]);
            if (keys.length) {
                await pool.query("INSERT INTO user_permissions (user_id, perm_key) VALUES ?", [keys.map(k => [SEED.waiterUser.id, k])]);
            }
            invalidateUserSessions(SEED.waiterUser.id);
            const relog = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.waiterUser.user_number });
            return relog.headers['set-cookie'][0];
        }

        it('lets an edit-capable waiter increase a saved item quantity (adding up)', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 3, price: SEED.product1.price }],
                    subtotal: 15.00, tax: 2.40, total: 17.40
                });
            expect(res.statusCode).toBe(200);

            const [items] = await pool.query("SELECT quantity FROM order_items WHERE invoice_id = ?", [invoiceId]);
            expect(Number(items[0].quantity)).toBe(3);
        });

        it('rejects a waiter reduction with the canonical route-boundary response', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    void_reason: 'trying to reduce',
                    manager_pin: SEED.adminUser.pin // valid PIN must NOT unlock the reduction
                });
            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('Saved items must be removed with the Remove action.');

            // Quantity unchanged — the reduction was blocked.
            const [items] = await pool.query("SELECT quantity FROM order_items WHERE invoice_id = ?", [invoiceId]);
            expect(Number(items[0].quantity)).toBe(2);
        });

        it('rejects an admin reduction because void authority belongs to the refund route', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(409);

            const [items] = await pool.query("SELECT quantity FROM order_items WHERE invoice_id = ?", [invoiceId]);
            expect(Number(items[0].quantity)).toBe(2);
        });

        it('rejects a permitted waiter reduction because permissions cannot bypass the route boundary', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked', 'pos.void_item', 'pos.void_printed_item']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(409);

            const [items] = await pool.query("SELECT quantity FROM order_items WHERE invoice_id = ?", [invoiceId]);
            expect(Number(items[0].quantity)).toBe(2);
        });

        it('rejects an empty saved cart regardless of table void permissions', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked', 'pos.void_item']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart: [] });

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('Saved items must be removed with the Remove action.');

            // Order stays open + table stays occupied — nothing was voided or freed.
            const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(order.payment_method).toBe('unpaid_table');
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(Number(invoiceId));
        });

        it('does not let both void permissions bypass the empty-cart route boundary', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked', 'pos.void_item', 'pos.void_printed_item']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cookie)
                .send({ table_id: SEED.table.id, current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId), cart: [] });

            expect(res.statusCode).toBe(409);

            const [[order]] = await pool.query('SELECT payment_method FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(order.payment_method).toBe('unpaid_table');
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id = ?', [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(Number(invoiceId));
        });
    });

    describe('Tax-exempt table lifecycle', () => {
        it('requires a boolean and permission before opening an exempt table order', async () => {
            // Reach the tax-exemption boundary with table access, but without
            // granting the independent tax exemption permission.
            await pool.query("INSERT IGNORE INTO user_permissions(user_id,perm_key) VALUES(?, 'tables.access')", [SEED.cashierUser.id]);
            invalidateUserSessions(SEED.cashierUser.id);
            const denied = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', cashierCookie)
                .send({
                    table_id: SEED.table.id,
                    tax_exempt: true,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8
                });
            expect(denied.statusCode).toBe(403);
            expect(denied.body.code).toBe('TAX_EXEMPT_PERMISSION_REQUIRED');

            const malformed = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    tax_exempt: 'true',
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8
                });
            expect(malformed.statusCode).toBe(400);
            expect(malformed.body.code).toBe('TAX_EXEMPT_BOOLEAN_REQUIRED');
        });

        it('persists the source price while settling a new exempt table at zero tax', async () => {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    tax_exempt: true,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                    subtotal: 5,
                    tax: 0,
                    total: 5
                });
            expect(saveRes.statusCode).toBe(200);
            const invoiceId = saveRes.body.order_id;

            const [[savedOrder]] = await pool.query(
                'SELECT tax_exempt_at_sale, subtotal, tax, total FROM orders WHERE invoice_id=?',
                [invoiceId]
            );
            const [[savedItem]] = await pool.query(
                'SELECT price_at_sale, price_before_tax_exemption, tax_amount FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
                [invoiceId]
            );
            expect(Number(savedOrder.tax_exempt_at_sale)).toBe(1);
            expect(Number(savedOrder.tax)).toBe(0);
            expect(Number(savedOrder.total)).toBeCloseTo(5, 2);
            expect(Number(savedItem.price_at_sale)).toBeCloseTo(5, 5);
            expect(Number(savedItem.price_before_tax_exemption)).toBeCloseTo(5, 6);
            expect(Number(savedItem.tax_amount)).toBe(0);

            const getRes = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(getRes.statusCode).toBe(200);
            expect(getRes.body.tax_exempt_at_sale).toBe(true);
            expect(Number(getRes.body.cart[0].price)).toBeCloseTo(5, 6);

            const settleRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', adminCookie)
                .send({
                    edit_invoice_id: invoiceId,
                    table_id: SEED.table.id,
                    cart: getRes.body.cart,
                    subtotal: 5,
                    tax: 0,
                    total: 5,
                    payment_method: 'cash',
                    amount_tendered: 5,
                    change_due: 0
                });
            expect(settleRes.statusCode).toBe(200);
            const [[settledOrder]] = await pool.query(
                'SELECT tax_exempt_at_sale, tax, total FROM orders WHERE invoice_id=?',
                [invoiceId]
            );
            expect(Number(settledOrder.tax_exempt_at_sale)).toBe(1);
            expect(Number(settledOrder.tax)).toBe(0);
            expect(Number(settledOrder.total)).toBeCloseTo(5, 2);
        });

        it('recalculates a saved exempt table with normal tax when exemption is removed', async () => {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    tax_exempt: true,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                    subtotal: 5,
                    tax: 0,
                    total: 5
                });
            expect(saveRes.statusCode).toBe(200);

            const invoiceId = saveRes.body.order_id;
            const loaded = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(loaded.statusCode).toBe(200);

            const update = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    tax_exempt: false,
                    cart: loaded.body.cart,
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8
                });
            expect(update.statusCode).toBe(200);

            const [[order]] = await pool.query(
                'SELECT tax_exempt_at_sale, subtotal, tax, total FROM orders WHERE invoice_id=?',
                [invoiceId]
            );
            const [[item]] = await pool.query(
                'SELECT price_at_sale, price_before_tax_exemption FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL',
                [invoiceId]
            );
            expect(Number(order.tax_exempt_at_sale)).toBe(0);
            expect(Number(order.subtotal)).toBe(5);
            expect(Number(order.tax)).toBeCloseTo(0.8, 2);
            expect(Number(order.total)).toBe(5.8);
            expect(Number(item.price_at_sale)).toBe(5);
            expect(item.price_before_tax_exemption).toBeNull();
        });

        it('recalculates a saved exempt table with normal tax during settlement', async () => {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    tax_exempt: true,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                    subtotal: 5,
                    tax: 0,
                    total: 5
                });
            expect(saveRes.statusCode).toBe(200);

            const invoiceId = saveRes.body.order_id;
            const loaded = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(loaded.statusCode).toBe(200);

            const settle = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', adminCookie)
                .send({
                    edit_invoice_id: invoiceId,
                    table_id: SEED.table.id,
                    tax_exempt: false,
                    cart: loaded.body.cart,
                    subtotal: 5,
                    tax: 0.8,
                    total: 5.8,
                    payment_method: 'cash',
                    amount_tendered: 5.8,
                    change_due: 0
                });
            expect(settle.statusCode).toBe(200);
            expect(settle.body).toMatchObject({ tax_exempt: false, subtotal: 5, tax: 0.8, total: 5.8 });

            const [[order]] = await pool.query(
                'SELECT tax_exempt_at_sale, subtotal, tax, total FROM orders WHERE invoice_id=?',
                [invoiceId]
            );
            expect(Number(order.tax_exempt_at_sale)).toBe(0);
            expect(Number(order.subtotal)).toBe(5);
            expect(Number(order.tax)).toBeCloseTo(0.8, 2);
            expect(Number(order.total)).toBe(5.8);
        });

        it('rejects merging taxable and exempt table orders without mutating either order', async () => {
            const sourceInvoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: 5 }],
                5,
                0.8,
                5.8
            );
            const targetRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table2.id,
                    tax_exempt: true,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5 }],
                    subtotal: 5,
                    tax: 0,
                    total: 5
                });
            expect(targetRes.statusCode).toBe(200);
            const targetInvoiceId = targetRes.body.order_id;

            const mergeRes = await request(app)
                .post('/api/pos/tables/transfer')
                .set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'merge' }));
            expect(mergeRes.statusCode).toBe(409);
            expect(mergeRes.body.code).toBe('TAX_EXEMPT_CONTEXT_MISMATCH');
            const [[sourceOrder]] = await pool.query('SELECT invoice_id FROM orders WHERE invoice_id=?', [sourceInvoiceId]);
            const [[targetOrder]] = await pool.query('SELECT invoice_id FROM orders WHERE invoice_id=?', [targetInvoiceId]);
            expect(sourceOrder).toBeTruthy();
            expect(targetOrder).toBeTruthy();
        });

        it('preserves the exempt source price through reload, split, and settlement', async () => {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='tax_inclusive_pricing'");
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    tax_exempt: true,
                    cart: [{ id: SEED.product1.id, qty: 2, price: 5, tax_rate: 16 }],
                    subtotal: 10,
                    tax: 0,
                    total: 10
                });
            expect(saveRes.statusCode).toBe(200);
            const invoiceId = saveRes.body.order_id;

            const freshLogin = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.adminUser.user_number });
            const freshAdminCookie = freshLogin.headers['set-cookie'][0];
            const loaded = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', freshAdminCookie);
            expect(loaded.statusCode).toBe(200);
            expect(loaded.body.tax_exempt_at_sale).toBe(true);
            expect(Number(loaded.body.cart[0].price)).toBe(5);

            const split = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', freshAdminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        {
                            referenceName: 'Exempt Seat A',
                            subtotal: 5,
                            items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                        },
                        {
                            referenceName: 'Exempt Seat B',
                            subtotal: 5,
                            items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }]
                        }
                    ]
                });
            expect(split.statusCode).toBe(200);

            const [held] = await pool.query(
                'SELECT id, cart_data FROM held_orders WHERE parent_invoice_id=? ORDER BY id',
                [invoiceId]
            );
            expect(held).toHaveLength(2);
            for (const [index, row] of held.entries()) {
                const payload = JSON.parse(row.cart_data);
                expect(payload.tax_exempt_at_hold).toBe(true);
                expect(payload.split_money_cents).toMatchObject({ subtotal: 500, tax: 0, total: 500 });
                expect(Number(payload.items[0].price)).toBe(5);

                const settle = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: payload.items,
                        shift_id: cashierShiftId,
                        subtotal: 5,
                        tax: 0,
                        total: 5,
                        payment_method: 'cash',
                        amount_tendered: 5,
                        change_due: 0,
                        split_check_id: row.id,
                        parent_invoice_id: invoiceId,
                        is_split: true,
                        table_id: SEED.table.id,
                        idempotency_key: `tax-exempt-split-settle-${index}`
                    });
                expect(settle.statusCode).toBe(200);
                expect(settle.body).toMatchObject({ tax_exempt: true, tax: 0, total: 5 });
            }

            const [children] = await pool.query(
                `SELECT invoice_id, tax_exempt_at_sale, subtotal, tax, total
                   FROM orders WHERE parent_invoice_id=? ORDER BY invoice_id`,
                [invoiceId]
            );
            expect(children).toHaveLength(2);
            for (const child of children) {
                expect(Number(child.tax_exempt_at_sale)).toBe(1);
                expect(Number(child.subtotal)).toBeCloseTo(5, 2);
                expect(Number(child.tax)).toBe(0);
                expect(Number(child.total)).toBeCloseTo(5, 2);
                const [[line]] = await pool.query(
                    `SELECT price_at_sale, price_before_tax_exemption, tax_amount
                       FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL`,
                    [child.invoice_id]
                );
                expect(Number(line.price_at_sale)).toBeCloseTo(5, 5);
                expect(Number(line.price_before_tax_exemption)).toBe(5);
                expect(Number(line.tax_amount)).toBe(0);
            }
        });
    });

    describe('Table Order Discount Persistence (B3)', () => {
        it('records discount changes and removals when a saved table is updated', async () => {
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{
                        id: SEED.product1.id,
                        qty: 2,
                        price: SEED.product1.price,
                        discountType: 'percent',
                        discountValue: 10
                    }],
                    subtotal: 9.00,
                    tax: 1.30,
                    total: 9.40,
                    order_discount_type: 'percent',
                    order_discount_value: 10
                });
            expect(saveRes.statusCode).toBe(200);
            const invoiceId = saveRes.body.order_id;

            const getRes = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(getRes.statusCode).toBe(200);
            await pool.query(
                "DELETE FROM audit_events WHERE entity_type='order' AND entity_id=? AND event_type LIKE '%discount_changed'",
                [invoiceId]
            );

            const updateRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: getRes.body.cart.map(item => ({
                        ...item,
                        discountType: null,
                        discountValue: 0
                    })),
                    subtotal: 10.00,
                    tax: 1.44,
                    total: 10.44,
                    order_discount_type: 'fixed',
                    order_discount_value: 1
                });
            expect(updateRes.statusCode).toBe(200);

            const [events] = await pool.query(
                `SELECT event_type, user_id, old_value, new_value
                   FROM audit_events
                  WHERE entity_type='order' AND entity_id=?
                    AND event_type IN ('line_discount_changed', 'order_discount_changed')
                  ORDER BY event_type`,
                [invoiceId]
            );
            expect(events).toHaveLength(2);
            expect(events.every(event => event.user_id === SEED.adminUser.id)).toBe(true);

            const lineEvent = events.find(event => event.event_type === 'line_discount_changed');
            expect(JSON.parse(lineEvent.old_value).discount).toEqual({ type: 'percent', value: 10, amount: 1 });
            expect(JSON.parse(lineEvent.new_value).discount).toBeNull();

            const orderEvent = events.find(event => event.event_type === 'order_discount_changed');
            expect(JSON.parse(orderEvent.old_value)).toEqual({ type: 'percent', value: 10, amount: 0.9 });
            expect(JSON.parse(orderEvent.new_value)).toEqual({ type: 'fixed', value: 1, amount: 1 });
        });

        it('table_order POST persists discount and GET returns it', async () => {
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                    subtotal: 10.00,
                    tax: 1.44,
                    total: 10.44,
                    order_discount_type: 'percent',
                    order_discount_value: 10
                });
            expect(saveRes.statusCode).toBe(200);
            const invoiceId = saveRes.body.order_id;

            const [rows] = await pool.query(
                "SELECT discount_type, discount_value FROM orders WHERE invoice_id = ?",
                [invoiceId]
            );
            expect(rows[0].discount_type).toBe('percent');
            expect(Number(rows[0].discount_value)).toBe(10);

            const getRes = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(getRes.statusCode).toBe(200);
            expect(getRes.body.order_discount_type).toBe('percent');
            expect(Number(getRes.body.order_discount_value)).toBe(10);
        });

        it('C1: SUM(order_items.tax_amount) equals orders.tax when order discount present', async () => {
            // 2 lines of product1 @ 10.00 (tax_rate 16%) + 10% order discount
            // discountRatio = 0.9; correct per-line tax = 10.00*0.9*0.16 = 1.44 each → SUM = 2.88
            // Before fix: lines stamped WITHOUT discountRatio → SUM = 3.20 ≠ orders.tax 2.88
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, qty: 1, price: 10.00 },
                        { id: SEED.product1.id, qty: 1, price: 10.00 }
                    ],
                    subtotal: 20.00,
                    tax: 2.88,
                    total: 20.88,
                    order_discount_type: 'percent',
                    order_discount_value: 10
                });
            expect(saveRes.statusCode).toBe(200);
            const invoiceId = saveRes.body.order_id;

            const [[o]] = await pool.query(
                "SELECT tax FROM orders WHERE invoice_id = ?",
                [invoiceId]
            );
            const [[s]] = await pool.query(
                "SELECT ROUND(SUM(tax_amount), 2) AS sum FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL",
                [invoiceId]
            );
            expect(Number(s.sum)).toBeCloseTo(Number(o.tax), 2);
        });

        it('settle a table order with discount: correct charged total', async () => {
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table2.id,
                    cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                    subtotal: 10.00,
                    tax: 1.44,
                    total: 10.44,
                    order_discount_type: 'percent',
                    order_discount_value: 10
                });
            expect(saveRes.statusCode).toBe(200);
            const invoiceId = saveRes.body.order_id;

            const settleRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', adminCookie)
                .send({
                    edit_invoice_id: invoiceId,
                    cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                    subtotal: 10.00,
                    tax: 1.44,
                    total: 10.44,
                    order_discount_type: 'percent',
                    order_discount_value: 10,
                    payment_method: 'cash',
                    amount_tendered: 11.00,
                    change_due: 0.56,
                    table_id: SEED.table2.id
                });
            expect(settleRes.statusCode).toBe(200);

            const [orders] = await pool.query(
                "SELECT total, discount_type, discount_value FROM orders WHERE invoice_id = ?",
                [invoiceId]
            );
            expect(Number(orders[0].total)).toBeCloseTo(10.44, 2);
            expect(orders[0].discount_type).toBe('percent');
            expect(Number(orders[0].discount_value)).toBe(10);
        });
    });

    // ── E2: Price Override Gate on table-save ────────────────────────────────
    describe('Price Override Gate — table-save', () => {
        let priceOverrideWaiterCookie;

        beforeEach(async () => {
            const r = await request(app)
                .post('/api/auth/login')
                .send({ user_number: SEED.priceOverrideWaiter.user_number });
            expect(r.statusCode).toBe(200);
            priceOverrideWaiterCookie = r.headers['set-cookie'][0];
        });

        it('non-override user saving manual price with off-price subtotal returns 400 subtotal mismatch', async () => {
            // waiterUser (id=3) has no pos.price_override capability. Grant waiter.edit_locked.
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'waiter.edit_locked')", [SEED.waiterUser.id]);
            invalidateUserSessions(SEED.waiterUser.id);

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', waiterCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 3.00 }], // DB is 5.00
                    subtotal: 3.00,
                    tax: 0.48,
                    total: 3.48
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/subtotal mismatch/i);
        });

        it('non-override user saving manual price with base subtotal succeeds but resets price to DB base', async () => {
            // waiterUser (id=3) has no pos.price_override capability. Grant waiter.edit_locked.
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'waiter.edit_locked')", [SEED.waiterUser.id]);
            invalidateUserSessions(SEED.waiterUser.id);

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', waiterCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 3.00 }],
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });
            expect(res.statusCode).toBe(200);

            const orderId = res.body.order_id;
            const [items] = await pool.query(
                "SELECT price_at_sale FROM order_items WHERE invoice_id = ?",
                [orderId]
            );
            expect(items.length).toBe(1);
            expect(Number(items[0].price_at_sale)).toBeCloseTo(5.00, 2);
        });

        it('keeps table saves on base pricing even when the product category owns an override', async () => {
            await pool.query('UPDATE categories SET price_list_root_id = id WHERE id = ?', [SEED.category.id]);
            await pool.query(
                'INSERT INTO product_price_overrides (price_list_root_id, product_id, price) VALUES (?, ?, ?)',
                [SEED.category.id, SEED.product1.id, 99]
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', waiterCookie)
                .send({
                    table_id: SEED.table.id,
                    sales_context: 'register',
                    price_list_root_id: SEED.category.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 99 }],
                    subtotal: 5,
                    tax: 0.80,
                    total: 5.80,
                    order_type_id: 2
                });

            expect(res.statusCode).toBe(200);
            const [[line]] = await pool.query(
                'SELECT price_at_sale, tax_rate FROM order_items WHERE invoice_id = ?',
                [res.body.order_id]
            );
            expect(Number(line.price_at_sale)).toBe(5);
            expect(Number(line.tax_rate)).toBe(16);
        });

        const savedLinePrice = async (res) => {
            const [[line]] = await pool.query('SELECT price_at_sale FROM order_items WHERE invoice_id = ?', [res.body.order_id]);
            return Number(line.price_at_sale);
        };

        // (d-admin) admin saves manual price — no PIN required (admin short-circuit)
        it('(d-admin) admin can save manual price without manager PIN', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 3.00 }],
                    subtotal: 3.00,
                    tax: 0.48,
                    total: 3.48
                });
            expect(res.statusCode).toBe(200);
            expect(await savedLinePrice(res)).toBe(3);
        });

        // (d) waiter saves DB-price lines — no PIN needed, unaffected
        it('(d) normal-price table-save requires no PIN and succeeds', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', priceOverrideWaiterCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });
            expect(res.statusCode).toBe(200);
            expect(await savedLinePrice(res)).toBe(5);
        });

        it('price_override holder saves a manual price on a table with NO manager PIN', async () => {
            const res = await request(app).post('/api/pos/table_order').set('Cookie', priceOverrideWaiterCookie).send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price + 2 }],
                subtotal: SEED.product1.price + 2, tax: 1.12, total: 8.12
            });
            expect(res.statusCode).toBe(200);
            expect(await savedLinePrice(res)).toBe(7);
        });
    });

    describe('Custom (open) item validation', () => {
        it('rejects creating a new custom (open) item on a fresh table order', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ name: 'Open Thing', price: 9.99, qty: 1, tax_rate: 0 }],
                    subtotal: 9.99, tax: 0, total: 9.99
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/open item|custom item|not available/i);
        });
    });

    describe('Frozen Price Preservation', () => {
        it('preserves frozen price on table resave when menu price has changed', async () => {
            // waiterUser (id=3) has no pos.price_override capability. Grant them waiter.edit_locked.
            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'waiter.edit_locked')", [SEED.waiterUser.id]);
            invalidateUserSessions(SEED.waiterUser.id);

            // 1. Seed table order with burger at 5.00
            const [ins] = await pool.query(
                `INSERT INTO orders (order_id, user_id, waiter_id, table_id, shift_id, subtotal, tax, total, payment_method, created_at)
                 VALUES (740001, ?, ?, ?, ?, 5.00, 0.80, 5.80, 'unpaid_table', NOW())`,
                [SEED.waiterUser.id, SEED.waiterUser.id, SEED.table2.id, 1] // shiftId=1 from SEED
            );
            const invoiceId = ins.insertId;
            await pool.query(
                "INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, note) VALUES (?, ?, 'Test Burger', 1, 5.00, 16, '')",
                [invoiceId, SEED.product1.id]
            );
            await pool.query("UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?", [invoiceId, SEED.table2.id]);

            // 2. Change the menu price of the burger to 6.00
            await pool.query("UPDATE products SET price = 6.00 WHERE id = 1");

            // 3. Waiter (no pos.price_override) resaves the order at the frozen 5.00 price (adding no new items).
            // It should succeed (200) and keep the price at 5.00.
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', waiterCookie)
                .send({
                    table_id: SEED.table2.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5.00 }],
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });

            // Restore menu price
            await pool.query("UPDATE products SET price = 5.00 WHERE id = 1");

            expect(res.statusCode).toBe(200);

            // Confirm order items price_at_sale in DB is still 5.00
            const [items] = await pool.query("SELECT price_at_sale FROM order_items WHERE invoice_id = ?", [invoiceId]);
            expect(Number(items[0].price_at_sale)).toBeCloseTo(5.00, 2);
        });

        it('rejects table resave when current_order_id points at a finalized invoice', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            await pool.query(
                "UPDATE orders SET payment_method = 'cash', amount_tendered = total, cash_amount = total, invoice_number = 992, invoice_issued_at = NOW() WHERE invoice_id = ?",
                [invoiceId]
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                    subtotal: 10.00,
                    tax: 1.60,
                    total: 11.60
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toMatch(/finalized/i);

            const [[order]] = await pool.query(
                "SELECT payment_method, subtotal, total FROM orders WHERE invoice_id = ?",
                [invoiceId]
            );
            expect(order.payment_method).toBe('cash');
            expect(Number(order.subtotal)).toBe(5.00);
            expect(Number(order.total)).toBe(5.80);

            const [items] = await pool.query(
                "SELECT quantity FROM order_items WHERE invoice_id = ?",
                [invoiceId]
            );
            expect(items).toHaveLength(1);
            expect(Number(items[0].quantity)).toBe(1);
        });
    });

    describe('Public Invoice Number — Table Identity', () => {
        // adminCookie used for saves: admin bypasses waiter.edit_locked gate.
        // adminCookie used for get_tables: cashier lacks tables.access; waiter role bypasses
        // the explicit-grant check but admin is simpler and unambiguous.
        // cashierCookie used for checkout: user 2 has pos.checkout.

        it('saving a table order does not assign a public invoice number', async () => {
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 0 }],
                    subtotal: 5,
                    tax: 0,
                    total: 5,
                    shift_id: cashierShiftId
                });

            expect(saveRes.body.success).toBe(true);
            expect(saveRes.body.invoice_number).toBeNull();
            expect(saveRes.body.invoice_id).toBe(saveRes.body.order_id);
            // Task 3: order_id is NULL at save — display numbers only appear at checkout
            expect(saveRes.body.ticket_display_no).toBeNull();

            const [[order]] = await pool.query(
                'SELECT payment_method, order_id, invoice_number FROM orders WHERE invoice_id = ?',
                [saveRes.body.invoice_id]
            );
            expect(order.payment_method).toBe('unpaid_table');
            expect(order.invoice_number).toBeNull();
            expect(order.order_id).toBeNull();
            expect(saveRes.body.order_display_no).toBeNull();
            expect(saveRes.body.ticket_display_no).toBeNull();
        });

        it('table list exposes ticket display fields without using current_order_id as the label', async () => {
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 0 }],
                    subtotal: 5,
                    tax: 0,
                    total: 5,
                    shift_id: cashierShiftId
                });

            expect(saveRes.body.success).toBe(true);

            const list = await request(app)
                .get('/api/pos/get_tables')
                .set('Cookie', adminCookie);

            expect(list.body.success).toBe(true);
            const table = list.body.tables.find(t => Number(t.id) === Number(SEED.table.id));
            expect(table.current_order_id).toBe(saveRes.body.invoice_id);
            expect(table.order_display_no).toBe(saveRes.body.order_display_no);
            expect(table.ticket_display_no).toBe(saveRes.body.ticket_display_no);
        });

        it('table-save kitchen tickets print table identity and order-taken time, not invoice/order numbers', async () => {
            const [printerRes] = await pool.query(
                `INSERT INTO printers (name, role, type, windows_name, is_active)
                 VALUES ('Kitchen Printer', 'kitchen', 'windows', 'Kitchen-1', 1)`
            );
            await pool.query(
                'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
                [printerRes.insertId, 1]
            );

            await pool.query(
                `INSERT INTO orders (order_id, user_id, shift_id, subtotal, tax, total, payment_method)
                 VALUES (10, 1, ?, 1, 0, 1, 'cash')`,
                [cashierShiftId]
            );

            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 16 }],
                    subtotal: 5,
                    tax: 0.80,
                    total: 5.80,
                    shift_id: cashierShiftId
                });

            expect(saveRes.body.success).toBe(true);
            expect(String(saveRes.body.invoice_id)).not.toBe(saveRes.body.order_display_no);

            const [queued] = await pool.query('SELECT payload FROM print_queue ORDER BY id DESC LIMIT 1');
            expect(queued).toHaveLength(1);
            const payload = JSON.parse(queued[0].payload);

            expect(payload.print_type).toBe('kitchen');
            expect(payload.data.invoice_id).toBe(saveRes.body.invoice_id);
            expect(payload.data.internal_invoice_id).toBe(saveRes.body.invoice_id);
            expect(payload.data.order_id).toBeNull();
            expect(payload.data.order_display_no).toBeNull();
            expect(payload.data.ticket_display_no).toBeNull();
            expect(payload.data.invoice_display_no).toBeNull();
            expect(payload.data.table_number).toBe(String(SEED.table.table_number));
            expect(payload.data.order_taken_at).toBeTruthy();
            expect(payload.data.date).toBe(payload.data.order_taken_at);
            expect(payload.data.print_batch_id).toBe(`table-${saveRes.body.invoice_id}-v${saveRes.body.version}`);
        });

        it('settling a saved table order assigns a public invoice number to the same internal order', async () => {
            // Use product2 (tax_rate=0) so tax math is trivial: subtotal=tax=0, total=2
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product2.id, name: SEED.product2.name, price: 2, qty: 1, tax_rate: 0 }],
                    subtotal: 2,
                    tax: 0,
                    total: 2,
                    shift_id: cashierShiftId
                });

            expect(saveRes.body.success).toBe(true);
            const internalInvoiceId = saveRes.body.invoice_id;

            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    edit_invoice_id: internalInvoiceId,
                    edit_order_id: Number(saveRes.body.order_display_no),
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product2.id, name: SEED.product2.name, price: 2, qty: 1, tax_rate: 0 }],
                    subtotal: 2,
                    tax: 0,
                    total: 2,
                    payment_method: 'cash',
                    amount_tendered: 2,
                    change_due: 0,
                    shift_id: cashierShiftId,
                    idempotency_key: 'invoice-number-table-settle-1'
                });

            expect(payRes.body.success).toBe(true);
            expect(payRes.body.invoice_id).toBe(internalInvoiceId);
            expect(payRes.body.invoice_number).toBeTruthy();

            const [[order]] = await pool.query(
                'SELECT payment_method, invoice_number FROM orders WHERE invoice_id = ?',
                [internalInvoiceId]
            );
            expect(order.payment_method).toBe('cash');
            expect(order.invoice_number).toBe(payRes.body.invoice_number);
        });

        it('split held checks carry parent display identity without exposing parent invoice_id as a label', async () => {
            const saveRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 0 },
                        { id: SEED.product2.id, name: SEED.product2.name, price: 2, qty: 1, tax_rate: 0 }
                    ],
                    subtotal: 7,
                    tax: 0,
                    total: 7,
                    shift_id: cashierShiftId
                });

            expect(saveRes.body.success).toBe(true);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: saveRes.body.invoice_id,
                    splits: [
                        {
                            referenceName: 'Seat 1',
                            subtotal: 5.8,
                            items: [{ id: SEED.product1.id, name: SEED.product1.name, price: 5, qty: 1, tax_rate: 0 }]
                        },
                        {
                            referenceName: 'Seat 2',
                            subtotal: 2,
                            items: [{ id: SEED.product2.id, name: SEED.product2.name, price: 2, qty: 1, tax_rate: 0 }]
                        }
                    ],
                    voidReason: 'split check'
                });

            expect(splitRes.body.success).toBe(true);

            const [splits] = await pool.query(
                'SELECT cart_data FROM held_orders ORDER BY id DESC LIMIT 2'
            );
            expect(splits.length).toBeGreaterThan(0);

            const splitCheck = splits.find(s => {
                const cd = JSON.parse(s.cart_data);
                return cd.parent_invoice_id === saveRes.body.invoice_id;
            });
            expect(splitCheck).toBeTruthy();

            const cart = JSON.parse(splitCheck.cart_data);
            expect(cart.parent_invoice_id).toBe(saveRes.body.invoice_id);
            expect(cart.parent_invoice_display_no).toBeNull();
            expect(cart.parent_order_display_no).toBe(saveRes.body.order_display_no);
            expect(cart.parent_ticket_display_no).toBe(saveRes.body.ticket_display_no);
        });
    });

    describe('Bill Split — joined child→parent resolution (P3-10)', () => {
        it('keeps the resolved parent and all siblings live when a split targets a joined child id (legacy shared bill)', async () => {
            // Join child T2 under parent T1
            await seedLegacySharedSeats(pool, SEED.table.id, [SEED.table2.id]);

            // Save an order on the PARENT → both T1 and T2 occupied on the same order
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );
            const lockTrace = captureConnectionQueries();

            // Split using the CHILD id (T2) — the child shares the parent's propagated current_order_id
            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table2.id,            // CHILD id, not the parent
                    currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Seat A', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }] },
                        { referenceName: 'Seat B', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, tax_rate: 16 }] }
                    ]
                });
            expect(res.statusCode).toBe(200);

            // Parent and child remain one occupied group until the last bucket settles.
            const [[t1]] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(t1.status).toBe('occupied');
            expect(Number(t1.current_order_id)).toBe(invoiceId);

            // Child T2 remains joined to the live parent.
            const [[t2]] = await pool.query("SELECT status, current_order_id, parent_table_id FROM restaurant_tables WHERE id = ?", [SEED.table2.id]);
            expect(t2.status).toBe('occupied');
            expect(Number(t2.current_order_id)).toBe(invoiceId);
            expect(Number(t2.parent_table_id)).toBe(SEED.table.id);

            const groupLock = lockTrace.findIndex(sql => (
                /FROM\s+restaurant_tables[\s\S]+parent_table_id=\?[\s\S]+ORDER BY id[\s\S]+FOR UPDATE/i.test(sql)
            ));
            const orderLock = lockTrace.findIndex(sql => /FROM\s+orders[\s\S]+FOR UPDATE/i.test(sql));
            const itemLock = lockTrace.findIndex(sql => /FROM\s+order_items[\s\S]+FOR UPDATE/i.test(sql));
            const settingsRead = lockTrace.findIndex(sql => /FROM\s+settings/i.test(sql));
            expect(groupLock).toBeGreaterThanOrEqual(0);
            expect(orderLock).toBeGreaterThan(groupLock);
            expect(itemLock).toBeGreaterThan(orderLock);
            expect(settingsRead).toBeGreaterThan(groupLock);
        });

        it('rejects a split when the table points at another table\'s order', async () => {
            const foreignInvoiceId = await createTableOrder(
                adminCookie, SEED.table2.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await pool.query(
                "UPDATE restaurant_tables SET status='occupied', current_order_id=? WHERE id=?",
                [foreignInvoiceId, SEED.table.id]
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: foreignInvoiceId,
                    splits: [{
                        referenceName: 'Foreign seat',
                        subtotal: 2.00,
                        items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }]
                    }]
                });

            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('TABLE_SESSION_CONFLICT');
            const [[order]] = await pool.query(
                'SELECT payment_method, table_id FROM orders WHERE invoice_id=?',
                [foreignInvoiceId]
            );
            expect(order).toMatchObject({
                payment_method: 'unpaid_table',
                table_id: SEED.table2.id
            });
            const [[ownerTable]] = await pool.query(
                'SELECT status, current_order_id FROM restaurant_tables WHERE id=?',
                [SEED.table2.id]
            );
            expect(ownerTable).toMatchObject({
                status: 'occupied',
                current_order_id: foreignInvoiceId
            });
        });
    });

    describe('Bill Split — discard audit (P3-9)', () => {
        it('writes an audit event when an unpaid split group is cancelled', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id, currentOrderId: invoiceId,
                    splits: [{ referenceName: 'Table 1 - Solo', subtotal: 2.00, items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }] }]
                });
            const [[held]] = await pool.query("SELECT id, subtotal FROM held_orders ORDER BY id DESC LIMIT 1");

            const delRes = await request(app)
                .delete(`/api/pos/table_splits?id=${held.id}`)
                .set('Cookie', adminCookie);
            expect(delRes.statusCode).toBe(200);

            // Held row is gone
            const [heldAfter] = await pool.query("SELECT id FROM held_orders WHERE id = ?", [held.id]);
            expect(heldAfter).toHaveLength(0);

            const [[audit]] = await pool.query(
                "SELECT * FROM audit_events WHERE event_type = 'split_group_cancelled' AND entity_id = ?",
                [invoiceId]
            );
            expect(audit).not.toBeNull();
            expect(audit.user_id).toBe(SEED.adminUser.id);
            const oldVal = JSON.parse(audit.old_value);
            expect(oldVal.split_ids).toContain(held.id);
        });

        it('rolls back split cancellation when the group audit insert fails', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id, currentOrderId: invoiceId,
                    splits: [{ referenceName: 'Table 1 - Solo', subtotal: 2.00, items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }] }]
                });
            const [[held]] = await pool.query("SELECT id, subtotal FROM held_orders ORDER BY id DESC LIMIT 1");

            failNextConnectionQuery(
                (sql, params) => typeof sql === 'string' && sql.includes('INSERT INTO audit_events') && params?.[0] === 'split_group_cancelled',
                'Simulated audit insert failure'
            );

            const delRes = await request(app)
                .delete(`/api/pos/table_splits?id=${held.id}`)
                .set('Cookie', adminCookie);
            expect(delRes.statusCode).toBe(500);

            // Held row is NOT gone (rolled back)
            const [heldAfter] = await pool.query("SELECT id FROM held_orders WHERE id = ?", [held.id]);
            expect(heldAfter).toHaveLength(1);
        });
    });

    describe('Concurrent split discard', () => {
        it('allows only one winner when the same split check is discarded concurrently', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: SEED.product2.price }],
                2.00, 0.00, 2.00
            );
            await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Table 1 - Concurrent',
                        subtotal: 2.00,
                        items: [{ id: SEED.product2.id, qty: 1, price: 2.00, tax_rate: 0 }]
                    }]
                });
            const [[held]] = await pool.query(
                "SELECT id FROM held_orders WHERE reference_name = 'Table 1 - Concurrent'"
            );

            const [first, second] = await Promise.all([
                request(app).delete(`/api/pos/table_splits?id=${held.id}`).set('Cookie', adminCookie),
                request(app).delete(`/api/pos/table_splits?id=${held.id}`).set('Cookie', adminCookie)
            ]);

            expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual([200, 404]);
            const [[audit]] = await pool.query(
                "SELECT COUNT(*) AS c FROM audit_events WHERE event_type = 'split_group_cancelled' AND entity_id = ?",
                [invoiceId]
            );
            expect(Number(audit.c)).toBe(1);
        });
    });

    describe('Split settle re-applies the distributed order discount (P2-3)', () => {
        it('persists + re-applies each seat discount server-side, reconciling to the parent discounted total', async () => {
            // Parent: 50 drinks @2.00 = 100 subtotal, 10% order discount → 90 total, 0 tax
            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product2.id, qty: 50, price: SEED.product2.price }],
                    order_discount_type: 'percent', order_discount_value: 10,
                    subtotal: 100.00, tax: 0.00, total: 90.00
                });
            expect(orderRes.statusCode).toBe(200);
            const invoiceId = orderRes.body.order_id;

            // Split into two seats of 25 each; each carries its distributed discounted
            // subtotal (45) + order_discount share (mirrors the fixed Task-4 FE output).
            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id, currentOrderId: invoiceId,
                    splits: [
                        { referenceName: 'Table 1 - Seat A', subtotal: 45.00, order_discount: { type: 'percent', value: 10 }, items: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }] },
                        { referenceName: 'Table 1 - Seat B', subtotal: 45.00, order_discount: { type: 'percent', value: 10 }, items: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }] }
                    ]
                });
            expect(splitRes.statusCode).toBe(200);

            // Discount persisted into each held check
            const [held] = await pool.query("SELECT id, cart_data FROM held_orders ORDER BY id ASC");
            expect(held).toHaveLength(2);
            expect(JSON.parse(held[0].cart_data).order_discount).toEqual({ type: 'percent', value: 10 });

            // A non-manager cashier settles each seat. The server re-applies the persisted
            // discount (server-sourced) and does NOT require a fresh discount authorization.
            // The payload deliberately omits any order discount.
            let charged = 0;
            for (const seat of held) {
                const payRes = await request(app)
                    .post('/api/pos/checkout')
                    .set('Cookie', cashierCookie)
                    .send({
                        cart: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }],
                        shift_id: cashierShiftId,
                        subtotal: 50.00, tax: 0.00, total: 45.00,     // pre-discount subtotal, discounted total
                        payment_method: 'cash', amount_tendered: 45.00, change_due: 0.00,
                        split_check_id: seat.id,
                        table_id: SEED.table.id,
                        order_discount_type: null, order_discount_value: 0,   // omitted on purpose
                        idempotency_key: `split_disc_${seat.id}`
                    });
                expect(payRes.statusCode).toBe(200);
                const [[o]] = await pool.query("SELECT total FROM orders WHERE invoice_id = ?", [payRes.body.invoice_id]);
                expect(Number(o.total)).toBe(45.00);
                charged += Number(o.total);
            }
            expect(charged).toBe(90.00);   // == parent DISCOUNTED total, not 100
        });

        it('rejects split seat money hints that are stale by more than one cent', async () => {
            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product2.id, qty: 50, price: SEED.product2.price }],
                    order_discount_type: 'percent',
                    order_discount_value: 10,
                    subtotal: 100.00,
                    tax: 0.00,
                    total: 90.00
                });
            expect(orderRes.statusCode).toBe(200);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: orderRes.body.order_id,
                    splits: [
                        {
                            referenceName: 'Table 1 - Seat A',
                            subtotal: 44.98,
                            order_discount: { type: 'percent', value: 20 },
                            items: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }]
                        },
                        {
                            referenceName: 'Table 1 - Seat B',
                            subtotal: 45.02,
                            order_discount: { type: 'percent', value: 10 },
                            items: [{ id: SEED.product2.id, qty: 25, price: 2.00, tax_rate: 0 }]
                        }
                    ]
                });
            expect(splitRes.statusCode).toBe(400);
            expect(splitRes.body.message).toMatch(/subtotal/i);

            const [held] = await pool.query("SELECT id FROM held_orders");
            expect(held).toHaveLength(0);
        });

        it('rejects a table split whose seat items do not conserve the saved parent items', async () => {
            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });
            expect(orderRes.statusCode).toBe(200);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: orderRes.body.order_id,
                    splits: [{
                        referenceName: 'Table 1 - Seat A',
                        subtotal: 5.80,
                        items: [{ id: SEED.product2.id, qty: 2.5, price: 2.00, tax_rate: 0 }]
                    }]
                });
            expect(splitRes.statusCode).toBe(400);
            expect(splitRes.body.message).toMatch(/items/i);

            const [held] = await pool.query("SELECT id FROM held_orders");
            expect(held).toHaveLength(0);

            const [[table]] = await pool.query("SELECT status, current_order_id FROM restaurant_tables WHERE id = ?", [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(table.current_order_id).toBe(orderRes.body.order_id);
        });

        it('allows splitting a saved table at its frozen line price after the menu price changes', async () => {
            const orderRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }],
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80
                });
            expect(orderRes.statusCode).toBe(200);

            await pool.query("UPDATE products SET price = 8.00 WHERE id = ?", [SEED.product1.id]);

            const splitRes = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: orderRes.body.order_id,
                    splits: [{
                        referenceName: 'Table 1 - Seat A',
                        subtotal: 5.80,
                        items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }]
                    }]
                });
            expect(splitRes.statusCode).toBe(200);

            const [[held]] = await pool.query("SELECT subtotal, cart_data FROM held_orders ORDER BY id DESC LIMIT 1");
            expect(Number(held.subtotal)).toBe(5.80);
            expect(JSON.parse(held.cart_data).items[0].price).toBe(5.00);
        });
    });

    describe('table_manager admin actions', () => {
        it('rejects a duplicate table number in the same section with 409', async () => {
            // Seed section 1 already contains table_number '1'
            const res = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'add_table', section_id: 1, table_number: '1' });
            expect(res.statusCode).toBe(409);
            expect(res.body.message).toMatch(/exist/i);
        });

        it('rejects an empty/whitespace table number with 400', async () => {
            const res = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'add_table', section_id: 1, table_number: '   ' });
            expect(res.statusCode).toBe(400);
        });

        it('adds a unique table number with 200', async () => {
            const res = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'add_table', section_id: 1, table_number: 'T-99' });
            expect(res.statusCode).toBe(200);
        });

        it('rejects an empty/whitespace section name with 400', async () => {
            const res = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'add_section', name: '   ' });
            expect(res.statusCode).toBe(400);
        });

        it('refuses to delete a section that still has tables (400)', async () => {
            // Seed section 1 contains tables '1' and '2'
            const res = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'delete_section', id: 1 });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/table/i);
        });

        it('deletes an empty section (200)', async () => {
            const addRes = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'add_section', name: 'Empty Patio' });
            expect(addRes.statusCode).toBe(200);

            const [rows] = await pool.query(
                "SELECT id FROM sections WHERE name = 'Empty Patio' LIMIT 1"
            );
            const secId = rows[0].id;

            const delRes = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'delete_section', id: secId });
            expect(delRes.statusCode).toBe(200);
        });

        it('blocks deleting a table referenced by a historical order', async () => {
            const tableNumber = `History-${Date.now()}`;
            const addRes = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'add_table', section_id: 1, table_number: tableNumber });
            expect(addRes.statusCode).toBe(200);

            const [[table]] = await pool.query(
                'SELECT id FROM restaurant_tables WHERE table_number=? ORDER BY id DESC LIMIT 1',
                [tableNumber]
            );
            const [orderInsert] = await pool.query(
                `INSERT INTO orders (user_id, table_id, subtotal, tax, total, payment_method)
                 VALUES (?, ?, 1.00, 0.00, 1.00, 'cash')`,
                [SEED.adminUser.id, table.id]
            );

            const deleted = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'delete_table', id: table.id });

            expect(deleted.statusCode).toBe(409);
            expect(deleted.body.code).toBe('TABLE_HAS_HISTORY');

            await pool.query('DELETE FROM orders WHERE invoice_id=?', [orderInsert.insertId]);
            const cleanup = await request(app)
                .post('/api/pos/table_manager')
                .set('Cookie', adminCookie)
                .send({ action: 'delete_table', id: table.id });
            expect(cleanup.statusCode).toBe(200);
        });
    });

    describe('Auto-Gratuity service-charge validation (P2-7)', () => {
        beforeEach(async () => {
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'service_charge_enabled'");
        });

        it('rejects a table order whose Auto-Gratuity fee is not subtotal × percentage', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5.00, qty: 1, tax_rate: 16 },
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 5.00, qty: 1, tax_rate: 0 } // forged: should be 0.50
                    ],
                    subtotal: 10.00, tax: 0.80, total: 10.80
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/service charge/i);
        });

        it('accepts a table order whose Auto-Gratuity fee equals subtotal × percentage', async () => {
            const draft = await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({});
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5.00, qty: 1, tax_rate: 16 },
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 0.50, qty: 1, tax_rate: 0 } // 10% of 5.00
                    ],
                    service_charge_snapshot: { id: draft.body.snapshot.id, version: 1 },
                    subtotal: 5.50, tax: 0.80, total: 6.30
                });
            expect(res.statusCode).toBe(200);
            const [[order]] = await pool.query('SELECT total FROM orders WHERE invoice_id = ?', [res.body.order_id]);
            const [[fee]] = await pool.query(
                "SELECT price_at_sale FROM order_items WHERE invoice_id = ? AND note = 'Auto-Gratuity'",
                [res.body.order_id]
            );
            expect(Number(order.total)).toBe(6.3);
            expect(Number(fee.price_at_sale)).toBe(0.5);
        });

        // F1 — the unit-price check alone is bypassable: the fee is anchored on the SUMMED
        // line-total of every Auto-Gratuity line, so a correct unit price with an inflated qty
        // must still be rejected (0.50 × 10 = 5.00 injected, not the expected 0.50).
        it('rejects an Auto-Gratuity line with a correct unit price but inflated qty (F1)', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5.00, qty: 1, tax_rate: 16 },
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 0.50, qty: 10, tax_rate: 0 } // 5.00 total, not 0.50
                    ],
                    subtotal: 10.00, tax: 0.80, total: 10.80
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/service charge/i);
        });

        // F1 — a second injected Auto-Gratuity line must not slip past a first valid one
        // (the old `find` validated only the first). Summed fee = 0.50 + 5.00 = 5.50 ≠ 0.50.
        it('rejects a second forged Auto-Gratuity line hidden behind a valid one (F1)', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5.00, qty: 1, tax_rate: 16 },
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 0.50, qty: 1, tax_rate: 0 }, // valid
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 5.00, qty: 1, tax_rate: 0 }  // forged extra
                    ],
                    subtotal: 10.50, tax: 0.80, total: 11.30
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/service charge/i);
        });

        // F2 — a missing tax_rate parses to NaN, and `NaN > 0.001` is false, which silently
        // skipped the tax check. The fee amount is correct here, so tax must be the only reason
        // for rejection — the validation must fail closed on a non-finite rate.
        it('stamps a missing Auto-Gratuity tax_rate from the frozen snapshot', async () => {
            const draft = await request(app).post('/api/pos/service_charge_snapshots').set('Cookie', adminCookie).send({});
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [
                        { id: SEED.product1.id, name: SEED.product1.name, price: 5.00, qty: 1, tax_rate: 16 },
                        { name: 'Auto-Gratuity', note: 'Auto-Gratuity', price: 0.50, qty: 1 } // tax_rate omitted
                    ],
                    service_charge_snapshot: { id: draft.body.snapshot.id, version: 1 },
                    subtotal: 5.50, tax: 0.80, total: 6.30
                });
            expect(res.statusCode).toBe(200);
            const [[fee]] = await pool.query(
                "SELECT tax_rate FROM order_items WHERE invoice_id=? AND note='Auto-Gratuity'",
                [res.body.invoice_id]
            );
            expect(fee.tax_rate).toBe('0.00');
        });
    });

    describe('Waiter section access — blank fails closed (P2-9)', () => {
        it('lets a waiter enter the floor plan without a cashier tables grant', async () => {
            await pool.query('DELETE FROM user_permissions WHERE user_id = ?', [SEED.waiterUser.id]);
            invalidateUserSessions(SEED.waiterUser.id);
            const login = await request(app).post('/api/auth/login')
                .send({ user_number: SEED.waiterUser.user_number });

            const res = await request(app).get('/api/pos/get_tables')
                .set('Cookie', login.headers['set-cookie'][0]);

            expect(res.statusCode).toBe(200);
        });

        it('a waiter with blank allowed_sections sees no tables (fail closed)', async () => {
            await pool.query("UPDATE users SET allowed_sections = '' WHERE id = ?", [SEED.waiterUser.id]);
            // Production user-security edits invalidate cached authority and
            // revoke sessions. This direct fixture edit must invalidate it too.
            invalidateUserSessions(SEED.waiterUser.id);
            const res = await request(app).get('/api/pos/get_tables').set('Cookie', waiterCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.tables).toEqual([]);
            expect(res.body.sections).toEqual([]);
        });

        it('an admin with blank allowed_sections still sees all tables', async () => {
            const res = await request(app).get('/api/pos/get_tables').set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            expect(res.body.tables.length).toBeGreaterThan(0);
        });
    });

    describe('Floor-plan waiter badge shows owner not last editor (P3-17)', () => {
        async function grantWaiter(keys) {
            await pool.query("DELETE FROM user_permissions WHERE user_id = ?", [SEED.waiterUser.id]);
            if (keys.length) {
                await pool.query("INSERT INTO user_permissions (user_id, perm_key) VALUES ?", [keys.map(k => [SEED.waiterUser.id, k])]);
            }
            invalidateUserSessions(SEED.waiterUser.id);
            const relog = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
            return relog.headers['set-cookie'][0];
        }

        it('active_order_waiter_name reflects the owning waiter after a cross-user override save', async () => {
            const cookie = await grantWaiter(['tables.access', 'waiter.edit_locked']);
            const invoiceId = await createTableOrder(
                cookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );

            // Admin (override) re-saves the SAME items — no reduction, so no void gate trips.
            const editRes = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                    subtotal: 10.00, tax: 1.60, total: 11.60
                });
            expect(editRes.statusCode).toBe(200);

            // user_id is now the admin (last editor); waiter_id stays the owner.
            const [[o]] = await pool.query("SELECT user_id, waiter_id FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(o.user_id).toBe(SEED.adminUser.id);
            expect(o.waiter_id).toBe(SEED.waiterUser.id);

            const list = await request(app).get('/api/pos/get_tables').set('Cookie', adminCookie);
            const table = list.body.tables.find(t => Number(t.id) === Number(SEED.table.id));
            expect(table.active_order_waiter_name).toBe(SEED.waiterUser.name); // owner, not editor
            expect(table.waiter_id).toBe(SEED.waiterUser.id);

            const order = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(order.body.waiter_id).toBe(SEED.waiterUser.id);
        });
    });

    describe('void route catalog-name snapshot', () => {
        it('refund_items records the catalog name for a NULL saved item_name', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );
            await pool.query(
                'UPDATE order_items SET item_name=NULL WHERE invoice_id=? AND product_id=?',
                [invoiceId, SEED.product1.id]
            );
            const [[savedItem]] = await pool.query(
                'SELECT id FROM order_items WHERE invoice_id=? AND product_id=?',
                [invoiceId, SEED.product1.id]
            );
            const res = await request(app)
                .post('/api/pos/refunds')
                .set('Cookie', adminCookie)
                .send({
                    invoice_id: invoiceId,
                    expected_version: await currentTableRevision(invoiceId), intent: 'void',
                    items: [{ order_item_id: savedItem.id, qty: 1 }]
                });
            expect(res.statusCode).toBe(200);
            const [[refundItem]] = await pool.query(
                `SELECT ri.item_name
                   FROM refund_items ri
                   JOIN refunds r ON r.id=ri.refund_id
                  WHERE r.invoice_id=?`,
                [invoiceId]
            );
            expect(refundItem.item_name).toBe(SEED.product1.name);
        });
    });

    describe('same-product different-note distinct kitchen lines (Task 3)', () => {
        it('table-save kitchen ticket keeps same-product different-note lines distinct when cartId is missing', async () => {
            const [printerResult] = await pool.query(
                `INSERT INTO printers (name, role, type, windows_name, is_active)
                 VALUES ('Kitchen Different Notes', 'kitchen', 'windows', 'Kitchen-Diff-Notes', 1)`
            );
            const printerId = printerResult.insertId;
            await pool.query(
                'INSERT INTO printer_categories (printer_id, category_id) VALUES (?, ?)',
                [printerId, SEED.category.id]
            );

            await pool.query("INSERT IGNORE INTO user_permissions (user_id, perm_key) VALUES (?, 'waiter.edit_locked')", [SEED.waiterUser.id]);
            invalidateUserSessions(SEED.waiterUser.id);

            try {
                const createRes = await request(app)
                    .post('/api/pos/table_order')
                    .set('Cookie', waiterCookie)
                    .send({
                        require_update_permission: true,
                        user_id: SEED.waiterUser.id,
                        shift_id: null,
                        table_id: SEED.table.id,
                        table_number: '1',
                        current_order_id: null,
                        cart: [
                            { id: SEED.product1.id, product_id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, note: 'no salt', category_id: 999 },
                            { id: SEED.product1.id, product_id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16, note: 'extra spicy', category_id: 999 }
                        ],
                        subtotal: 10,
                        tax: 1.6,
                        total: 11.6
                    });

                expect(createRes.statusCode).toBe(200);

                const [[job]] = await pool.query(
                    "SELECT payload FROM print_queue WHERE print_type = 'kitchen' ORDER BY id DESC LIMIT 1"
                );
                const payload = JSON.parse(job.payload);
                const primaryItems = payload.data.items.filter(item => !item._isOther);

                expect(primaryItems).toHaveLength(2);
                expect(primaryItems.map(item => item.note).sort()).toEqual(['extra spicy', 'no salt']);
                expect(new Set(primaryItems.map(item => item.cartId)).size).toBe(2);
                expect(primaryItems.map(item => item.category_id)).toEqual([SEED.category.id, SEED.category.id]);
            } finally {
                await pool.query('DELETE FROM printer_categories WHERE printer_id = ?', [printerId]);
                await pool.query('DELETE FROM printers WHERE id = ?', [printerId]);
            }
        });
    });

    describe('Table order discount validation tests', () => {
        it('rejects a negative order discount with a specific 400', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    order_discount_type: 'fixed', order_discount_value: -5
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/discount cannot be negative/i);
        });

        it('rejects an order discount over 100% with a specific 400', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80,
                    order_discount_type: 'percent', order_discount_value: 150
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/cannot exceed 100/i);
        });

        it('rejects a negative line discount with a specific 400', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: 'fixed', discountValue: -5 }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/discount cannot be negative/i);
        });

        it('rejects a line discount over 100% with a specific 400', async () => {
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price, discountType: 'percent', discountValue: 150 }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(400);
            expect(res.body.message).toMatch(/cannot exceed 100/i);
        });
    });

    describe('Tax-inclusive table save (B1)', () => {
        it('keeps normal table accounting and stores the customer receipt preference separately', async () => {
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            // product1 = 5.00 @16%. The setting is presentation-only for a new table.
            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                    subtotal: 5.00, tax: 0.80, total: 5.80
                });
            expect(res.statusCode).toBe(200);
            const invoiceId = res.body.order_id;
            const [[order]] = await pool.query("SELECT subtotal, tax, total, tax_inclusive_at_sale, receipt_tax_inclusive_at_sale FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(Number(order.subtotal)).toBe(5);
            expect(Number(order.tax)).toBe(0.8);
            expect(Number(order.total)).toBe(5.8);
            expect(Number(order.tax_inclusive_at_sale)).toBe(0);
            expect(Number(order.receipt_tax_inclusive_at_sale)).toBe(1);
            const [[line]] = await pool.query(
                "SELECT tax_amount FROM order_items WHERE invoice_id = ? AND product_id = ? AND parent_item_id IS NULL",
                [invoiceId, SEED.product1.id]
            );
            expect(Number(line.tax_amount)).toBeCloseTo(0.8, 6);

            const reload = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(reload.statusCode).toBe(200);
            expect(Number(reload.body.receipt_tax_inclusive_at_sale)).toBe(1);
        });
    });

    describe('Receipt Tax-Mode Integration tests (Task 2)', () => {
        it('rejects saved-table line IDs that belong to a different product', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product2.id, qty: 1, price: SEED.product2.price }
                ],
                7.00,
                0.80,
                7.80
            );
            const [lines] = await pool.query(
                'SELECT id, product_id FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL ORDER BY product_id',
                [invoiceId]
            );
            const burger = lines.find(line => line.product_id === SEED.product1.id);
            const drink = lines.find(line => line.product_id === SEED.product2.id);

            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [
                    { id: SEED.product1.id, order_item_id: drink.id, qty: 1, price: 5 },
                    { id: SEED.product2.id, order_item_id: burger.id, qty: 1, price: 2 }
                ],
                subtotal: 7.00,
                tax: 0.80,
                total: 7.80
            });

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toMatch(/refresh/i);
        });

        it('uses an unambiguous saved tax rate when a submitted line ID is stale', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00,
                0.80,
                5.80
            );
            await pool.query('UPDATE products SET tax_rate = 0 WHERE id = ?', [SEED.product1.id]);

            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{
                    id: SEED.product1.id,
                    order_item_id: 999999,
                    qty: 1,
                    price: SEED.product1.price
                }],
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80
            });

            expect(res.statusCode).toBe(200);
            const [[order]] = await pool.query('SELECT tax, total FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(Number(order.tax)).toBe(0.80);
            expect(Number(order.total)).toBe(5.80);
        });

        it('rejects a stale line ID with conflicting saved contexts without replacing saved rows', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price },
                    { id: SEED.product1.id, qty: 1, price: SEED.product1.price }
                ],
                10.00,
                1.60,
                11.60
            );
            const [savedRows] = await pool.query(
                'SELECT * FROM order_items WHERE invoice_id = ? AND parent_item_id IS NULL ORDER BY id',
                [invoiceId]
            );
            await pool.query('UPDATE order_items SET price_at_sale = 6.00 WHERE id = ?', [savedRows[1].id]);
            const [beforeRejection] = await pool.query(
                'SELECT * FROM order_items WHERE invoice_id = ? ORDER BY id',
                [invoiceId]
            );

            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{
                    id: SEED.product1.id,
                    order_item_id: 999999,
                    qty: 1,
                    price: SEED.product1.price
                }],
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80
            });

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('Saved item context is stale or ambiguous. Refresh the order and try again.');
            const [afterRejection] = await pool.query(
                'SELECT * FROM order_items WHERE invoice_id = ? ORDER BY id',
                [invoiceId]
            );
            expect(afterRejection).toEqual(beforeRejection);
        });

        it('stamps the current tax mode on a new unpaid table only once', async () => {
            // Save table under setting = 0
            await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            let res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00, tax: 0.80, total: 5.80
            });
            expect(res.statusCode).toBe(200);
            const invoiceId = res.body.order_id;
            let [[order]] = await pool.query("SELECT tax_inclusive_at_sale FROM orders WHERE invoice_id = ?", [invoiceId]);
            expect(order.tax_inclusive_at_sale).toBe(0);

            // Switch setting to 1
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            // Save same table order again
            res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
            expect(res.statusCode).toBe(200);
            [[order]] = await pool.query("SELECT tax_inclusive_at_sale FROM orders WHERE invoice_id = ?", [invoiceId]);
            // Should remain 0
            expect(order.tax_inclusive_at_sale).toBe(0);
        });

        it('copies the parent tax mode into every split payload', async () => {
            // 1. Create table order with setting = 1
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            let res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
            expect(res.statusCode).toBe(200);
            const invoiceId = res.body.order_id;

            // Set setting to 0 (to make sure it copies the parent's flag instead of using current setting)
            await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");

            // 2. Perform table split
            const splitPayload = {
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                    { referenceName: 'Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                ]
            };
            const splitRes = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send(splitPayload);
            expect(splitRes.statusCode).toBe(200);

            // 3. Fetch the split held_orders and verify accounting/display snapshots are independent.
            const [splits] = await pool.query("SELECT cart_data FROM held_orders ORDER BY id DESC LIMIT 2");
            expect(splits).toHaveLength(2);
            for (const s of splits) {
                const cart = JSON.parse(s.cart_data);
                expect(cart.tax_inclusive_at_sale).toBe(0);
                expect(cart.receipt_tax_inclusive_at_hold).toBe(1);
            }
        });

        it('creates a split under the parent frozen mode after the global setting flips', async () => {
            // Exclusive parent saved under setting 0...
            await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            let res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                cart: [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                subtotal: 10.00, tax: 1.60, total: 11.60
            });
            expect(res.statusCode).toBe(200);
            const invoiceId = res.body.order_id;

            // ...then the venue flips to inclusive BEFORE the bill is split. Seat totals
            // and conservation must run under the parent's frozen exclusive mode.
            await pool.query("UPDATE settings SET setting_value = '1' WHERE setting_key = 'tax_inclusive_pricing'");
            try {
                const splitRes = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [
                        // 'Table %' prefix required: GET /table_splits filters on it.
                        { referenceName: 'Table 1 - Flip Seat A', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] },
                        { referenceName: 'Table 1 - Flip Seat B', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5.00, tax_rate: 16 }] }
                    ]
                });
                expect(splitRes.statusCode).toBe(200);

                const [splits] = await pool.query("SELECT id, cart_data FROM held_orders ORDER BY id DESC LIMIT 2");
                for (const s of splits) {
                    expect(JSON.parse(s.cart_data).tax_inclusive_at_sale).toBe(0);
                }

                // The split cards' v1 must present the frozen exclusive mode with tax,
                // not the now-current inclusive setting.
                const listRes = await request(app).get('/api/pos/table_splits').set('Cookie', adminCookie);
                expect(listRes.statusCode).toBe(200);
                for (const s of splits) {
                    const card = listRes.body.data.find(h => h.id === s.id);
                    expect(card.receipt_display_v1).toBeDefined();
                    expect(card.receipt_display_v1.taxMode).toBe('exclusive');
                    expect(card.receipt_display_v1.summary.taxAmount).toBe(0.80);
                    expect(card.receipt_display_v1.summary.total).toBe(5.80);
                }
            } finally {
                await pool.query("UPDATE settings SET setting_value = '0' WHERE setting_key = 'tax_inclusive_pricing'");
            }
        });

        it('pins every versioned split catalog line to the parent tax rate', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00,
                0.80,
                5.80
            );
            const [[parentLine]] = await pool.query(
                'SELECT id FROM order_items WHERE invoice_id = ? AND product_id = ?',
                [invoiceId, SEED.product1.id]
            );
            await pool.query('UPDATE products SET tax_rate = 0 WHERE id = ?', [SEED.product1.id]);

            const splitRes = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [{
                    referenceName: 'Table 1 - Frozen tax',
                    subtotal: 5.80,
                    items: [{
                        id: SEED.product1.id,
                        order_item_id: parentLine.id,
                        qty: 1,
                        price: 5.00,
                        tax_rate: 99
                    }]
                }]
            });

            expect(splitRes.statusCode).toBe(200);
            const [[held]] = await pool.query(
                "SELECT cart_data FROM held_orders WHERE reference_name = 'Table 1 - Frozen tax'"
            );
            const payload = JSON.parse(held.cart_data);
            expect(payload.items[0].tax_rate).toBe(16);
        });

        it('rebuilds split v1 from lifecycle-authoritative tax evidence', async () => {
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope)
                 VALUES (1, ?, 10.00, 1.60, 11.60, 'cash', 0, NOW(), 'split-scope')`,
                [cashierShiftId || 1]
            );
            const parentId = orderRes.insertId;

            const [itemRes] = await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                 VALUES (?, ?, 'Product 1', 2, 5.00, 16.00, 1.60)`,
                [parentId, SEED.product1.id]
            );
            const parentItemId = itemRes.insertId;

            await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data, parent_invoice_id, table_id)
                 VALUES (1, 'Table 1 - Seat 1', 5.00, ?, ?, ?)`,
                [JSON.stringify({
                    parent_invoice_id: parentId,
                    parent_order_id: 1,
                    is_split: true,
                    tax_inclusive_at_sale: 0,
                    order_discount: { type: 'percent', value: 10 },
                    items: [{
                        product_id: SEED.product1.id,
                        order_item_id: parentItemId,
                        name: 'Product 1',
                        price: 5.00,
                        qty: 1,
                        tax_rate: 99.00
                    }]
                }), parentId, SEED.table.id]
            );

            const res = await request(app).get(`/api/pos/table_splits?table_id=${SEED.table.id}`).set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);

            const list = res.body.data;
            const seat1 = list.find(s => s.reference_name === 'Table 1 - Seat 1');
            expect(seat1.receipt_display_v1).toBeDefined();
            expect(seat1.receipt_display_v1.summary.orderDiscountAmount).toBe(0.50);
            expect(seat1.receipt_display_v1.summary.taxAmount).toBe(0.72);
            expect(seat1.receipt_display_v1.summary.total).toBe(5.22);
        });

        it('proves a service-charge seat preserves allocated cents and does not recompute the fee line', async () => {
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope, table_id)
                 VALUES (1, ?, 10.00, 1.60, 11.60, 'cash', 0, NOW(), 'split-scope-sc', ?)`,
                [cashierShiftId || 1, SEED.table.id]
            );
            const parentId = orderRes.insertId;

            await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data, parent_invoice_id, table_id)
                 VALUES (1, 'Table 1 - Seat SC', 6.55, ?, ?, ?)`,
                [JSON.stringify({
                    parent_invoice_id: parentId,
                    parent_order_id: 1,
                    is_split: true,
                    tax_inclusive_at_sale: 0,
                    items: [
                        {
                            product_id: SEED.product1.id,
                            name: 'Product 1',
                            price: 5.00,
                            qty: 1,
                            tax_rate: 16
                        },
                        {
                            product_id: null,
                            name: 'Service Charge',
                            note: 'Auto-Gratuity',
                            price: 1.55,
                            qty: 1,
                            tax_rate: 0
                        }
                    ]
                }), parentId, SEED.table.id]
            );

            const res = await request(app).get(`/api/pos/table_splits?table_id=${SEED.table.id}`).set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);

            const seat = res.body.data.find(s => s.reference_name === 'Table 1 - Seat SC');
            expect(seat.receipt_display_v1).toBeDefined();
            const scRow = seat.receipt_display_v1.rows.find(r => r.name === 'Service Charge');
            expect(scRow).toBeDefined();
            expect(scRow.netAmount).toBe(1.55);
            expect(seat.receipt_display_v1.summary.total).toBe(7.35); // 5.00 * 1.16 = 5.80 + 1.55 = 7.35
        });

        it('proves split card summary.total equals eventual settled child total', async () => {
            const [orderRes] = await pool.query(
                `INSERT INTO orders (user_id, shift_id, subtotal, tax, total, payment_method, tax_inclusive_at_sale, created_at, order_seq_scope, table_id)
                 VALUES (1, ?, 10.00, 1.60, 11.60, 'cash', 0, NOW(), 'split-settle-scope', ?)`,
                [cashierShiftId || 1, SEED.table.id]
            );
            const parentId = orderRes.insertId;

            const [itemRes] = await pool.query(
                `INSERT INTO order_items (invoice_id, product_id, item_name, quantity, price_at_sale, tax_rate, tax_amount)
                 VALUES (?, ?, 'Product 1', 2, 5.00, 16.00, 1.60)`,
                [parentId, SEED.product1.id]
            );
            const parentItemId = itemRes.insertId;

            const [seatRes] = await pool.query(
                `INSERT INTO held_orders (user_id, reference_name, subtotal, cart_data, parent_invoice_id, table_id)
                 VALUES (1, 'Table 1 - Seat TotalSettle', 5.00, ?, ?, ?)`,
                [JSON.stringify({
                    parent_invoice_id: parentId,
                    parent_order_id: 1,
                    is_split: true,
                    tax_inclusive_at_sale: 0,
                    items: [{
                        product_id: SEED.product1.id,
                        order_item_id: parentItemId,
                        name: 'Product 1',
                        price: 5.00,
                        qty: 1,
                        tax_rate: 16.00
                    }]
                }), parentId, SEED.table.id]
            );
            const splitCheckId = seatRes.insertId;
            await pool.query(
                `INSERT INTO audit_events (event_type, user_id, entity_type, entity_id, new_value)
                 VALUES ('split_check_created', ?, 'held_order', ?, ?)`,
                [1, splitCheckId, JSON.stringify({ parent_invoice_id: parentId, bundle_snapshot_version: 1 })]
            );

            const listRes = await request(app).get(`/api/pos/table_splits?table_id=${SEED.table.id}`).set('Cookie', adminCookie);
            const seat = listRes.body.data.find(s => s.id === splitCheckId);
            expect(seat.receipt_display_v1.summary.total).toBe(5.80);

            const payRes = await request(app)
                .post('/api/pos/checkout')
                .set('Cookie', cashierCookie)
                .send({
                    cart: [{ id: SEED.product1.id, order_item_id: parentItemId, qty: 1, price: 5.00, tax_rate: 16 }],
                    shift_id: cashierShiftId,
                    subtotal: 5.00,
                    tax: 0.80,
                    total: 5.80,
                    payment_method: 'cash',
                    amount_tendered: 5.80,
                    change_due: 0.00,
                    split_check_id: splitCheckId,
                    parent_invoice_id: parentId,
                    is_split: true,
                    table_id: SEED.table.id,
                    order_discount_type: null,
                    order_discount_value: 0,
                    idempotency_key: `split_settle_test_${splitCheckId}`
                });

            expect(payRes.statusCode).toBe(200);
            expect(payRes.body.total).toBe(5.80);
            expect(payRes.body.receipt_display_v1.summary.total).toBe(5.80);
        });
    });

    it('GET table_order emits structured modifiers (Task 6)', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 0.50 }] }]),
            SEED.product1.id
        ]);

        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [{
                id: SEED.product1.id,
                qty: 1,
                price: 5.50,
                tax_rate: 16,
                note: 'Size: Large (0.50 JD)',
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 0.50 }]
            }],
            5.50, 0.88, 6.38
        );

        try {
            const res = await request(app)
                .get(`/api/pos/table_order?order_id=${invoiceId}`)
                .set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            const line = res.body.cart.find((i) => i.id === SEED.product1.id);
            expect(line.selectedModifiers).toEqual([
                { gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 0.5 }
            ]);
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.product1.id]);
        }
    });

    it('partial-void recomputes order totals using the stored modifier_surcharge', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.modifierProduct.id
        ]);

        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [
                {
                    id: SEED.modifierProduct.id,
                    qty: 1,
                    price: 7.00,
                    tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                },
                {
                    id: SEED.product1.id,
                    qty: 1,
                    price: 5.00,
                    tax_rate: 16
                }
            ],
            12.00, 1.92, 13.92
        );

        const [items] = await pool.query('SELECT id, product_id FROM order_items WHERE invoice_id = ?', [invoiceId]);
        const line1 = items.find(it => Number(it.product_id) === Number(SEED.modifierProduct.id));
        const line2 = items.find(it => Number(it.product_id) === Number(SEED.product1.id));

        await pool.query('UPDATE order_items SET modifier_surcharge = 2.00, modifier_tax_amount = 0.275862, tax_amount = 1.075862 WHERE id = ?', [line1.id]);
        await pool.query('UPDATE orders SET subtotal = 11.72, tax = 1.88, total = 13.60 WHERE invoice_id = ?', [invoiceId]);

        try {
            const res = await request(app)
                .post('/api/pos/refunds')
                .set('Cookie', adminCookie)
                .send({
                    invoice_id: invoiceId,
                    expected_version: await currentTableRevision(invoiceId), intent: 'void',
                    items: [{ order_item_id: line2.id, qty: 1 }]
                });

            expect(res.statusCode).toBe(200);

            const [[order]] = await pool.query('SELECT subtotal, tax, total FROM orders WHERE invoice_id = ?', [invoiceId]);
            expect(Number(order.subtotal)).toBe(6.72);
            expect(Number(order.tax)).toBeCloseTo(1.08, 2);
            expect(Number(order.total)).toBeCloseTo(7.80, 2);

            const [[row]] = await pool.query(
                'SELECT modifier_surcharge, tax_amount FROM order_items WHERE id = ?', [line1.id]);
            expect(Number(row.modifier_surcharge)).toBe(2.00);
            expect(Number(row.tax_amount)).toBeCloseTo(1.075862, 6);
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
        }
    });

    it('table settle pins a seeded modifier_surcharge (reduced tax) and legacy NULL rows keep old math', async () => {
        const paidTaxes = async (res) => {
            const [[order]] = await pool.query('SELECT tax, total FROM orders WHERE invoice_id = ?', [res.body.invoice_id]);
            const [[line]] = await pool.query(
                'SELECT tax_amount, modifier_tax_amount FROM order_items WHERE invoice_id = ?',
                [res.body.invoice_id]
            );
            return {
                order: { tax: Number(order.tax), total: Number(order.total) },
                line: {
                    tax_amount: Number(line.tax_amount),
                    modifier_tax_amount: line.modifier_tax_amount == null ? null : Number(line.modifier_tax_amount)
                }
            };
        };
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.modifierProduct.id
        ]);

        const invoiceIdA = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [{
                id: SEED.modifierProduct.id,
                qty: 1,
                price: 7.00,
                tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
            }],
            7.00, 0.80, 7.80
        );

        const [itemsA] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ?', [invoiceIdA]);
        await pool.query('UPDATE order_items SET modifier_surcharge = 2.00, modifier_tax_amount = 0.275862, tax_amount = 1.075862 WHERE id = ?', [itemsA[0].id]);
        await pool.query('UPDATE orders SET subtotal = 6.72, tax = 1.08, total = 7.80 WHERE invoice_id = ?', [invoiceIdA]);

        const payResA = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{
                    id: SEED.modifierProduct.id,
                    qty: 1,
                    price: 7.00,
                    tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    order_item_id: itemsA[0].id,
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                }],
                shift_id: cashierShiftId,
                subtotal: 6.72, tax: 1.08, total: 7.80,
                payment_method: 'cash', amount_tendered: 7.80, change_due: 0.00,
                edit_invoice_id: invoiceIdA,
                table_id: SEED.table.id
            });
        expect(payResA.statusCode).toBe(200);
        expect(await paidTaxes(payResA)).toEqual({
            order: { tax: 1.08, total: 7.8 },
            line: { tax_amount: 1.075862, modifier_tax_amount: 0.275862 }
        });

        const invoiceIdB = await createTableOrder(
            adminCookie,
            SEED.table2.id,
            [{
                id: SEED.modifierProduct.id,
                qty: 1,
                price: 7.00,
                tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
            }],
            7.00, 0.80, 7.80
        );
        const [itemsB] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ?', [invoiceIdB]);
        await pool.query('UPDATE order_items SET modifier_surcharge = NULL, modifier_tax_amount = NULL, tax_amount = 1.12 WHERE id = ?', [itemsB[0].id]);
        await pool.query('UPDATE orders SET subtotal = 7.00, tax = 1.12, total = 8.12 WHERE invoice_id = ?', [invoiceIdB]);

        const payResB = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: [{
                    id: SEED.modifierProduct.id,
                    qty: 1,
                    price: 7.00,
                    tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    order_item_id: itemsB[0].id,
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                }],
                shift_id: cashierShiftId,
                subtotal: 7.00, tax: 1.12, total: 8.12,
                payment_method: 'cash', amount_tendered: 8.12, change_due: 0.00,
                edit_invoice_id: invoiceIdB,
                table_id: SEED.table2.id
            });
        expect(payResB.statusCode).toBe(200);
        expect(await paidTaxes(payResB)).toEqual({
            order: { tax: 1.12, total: 8.12 },
            line: { tax_amount: 1.12, modifier_tax_amount: null }
        });

        await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
    });

    it('table re-save rejects mixed surcharge group when client line lacks order_item_id', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.modifierProduct.id
        ]);

        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [
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
            14.00, 2.24, 16.24
        );

        const [items] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ? ORDER BY id ASC', [invoiceId]);
        await pool.query('UPDATE order_items SET modifier_surcharge = 2.00, tax_amount = 0.80 WHERE id = ?', [items[0].id]);
        await pool.query('UPDATE order_items SET modifier_surcharge = NULL, tax_amount = 1.12 WHERE id = ?', [items[1].id]);

        const res = await request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
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
                subtotal: 14.00, tax: 1.92, total: 15.92
            });

        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/Saved item context is stale or ambiguous/i);

        const [rows] = await pool.query('SELECT modifier_surcharge FROM order_items WHERE invoice_id = ? ORDER BY id ASC', [invoiceId]);
        expect(Number(rows[0].modifier_surcharge)).toBe(2.00);
        expect(rows[1].modifier_surcharge).toBeNull();

        await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
    });

    it('split seats pin a seeded parent surcharge into cart_data and settle at reduced tax', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.modifierProduct.id
        ]);

        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [{
                id: SEED.modifierProduct.id,
                qty: 1,
                price: 7.00,
                tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
            }],
            7.00, 1.12, 8.12
        );

        const [items] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ?', [invoiceId]);
        await pool.query('UPDATE order_items SET modifier_surcharge = 2.00, modifier_tax_amount = 0.275862, tax_amount = 1.075862 WHERE id = ?', [items[0].id]);
        await pool.query('UPDATE orders SET subtotal = 6.72, tax = 1.08, total = 7.80 WHERE invoice_id = ?', [invoiceId]);

        const splitRes = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [{
                    referenceName: 'Seat 1',
                    subtotal: 7.80,
                    items: [{
                        order_item_id: items[0].id,
                        qty: 1,
                        product_id: SEED.modifierProduct.id,
                        name: 'Modifier Product',
                        price: 7.00,
                        tax_rate: 16,
                        note: 'Size: Large (2.00 JD)',
                        selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                    }]
                }]
            });
        expect(splitRes.statusCode).toBe(200);

        const [held] = await pool.query('SELECT id, cart_data FROM held_orders');
        const matchedHeld = held.filter(h => {
            try {
                return JSON.parse(h.cart_data).parent_invoice_id === invoiceId;
            } catch (_) { return false; }
        });
        expect(matchedHeld).toHaveLength(1);
        const parsedCart = JSON.parse(matchedHeld[0].cart_data);
        expect(Number(parsedCart.items[0].modifier_surcharge)).toBe(2);

        const payRes = await request(app)
            .post('/api/pos/checkout')
            .set('Cookie', cashierCookie)
            .send({
                cart: parsedCart.items,
                shift_id: cashierShiftId,
                subtotal: 6.72, tax: 1.08, total: 7.80,
                payment_method: 'cash', amount_tendered: 7.80, change_due: 0.00,
                split_check_id: matchedHeld[0].id,
                parent_invoice_id: invoiceId,
                is_split: true,
                table_id: SEED.table.id
            });
        expect(payRes.statusCode).toBe(200);

        const [[paidItem]] = await pool.query('SELECT tax_amount, modifier_tax_amount FROM order_items WHERE invoice_id = ?', [payRes.body.invoice_id]);
        expect(Number(paidItem.tax_amount)).toBe(1.08);
        expect(Number(paidItem.modifier_tax_amount)).toBeCloseTo(0.275862, 6);

        await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
    });

    it('table re-save keeps the saved modifier snapshot when a client submits a different valid option', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [
                { id: 'o_large', name: 'Large', price: 2.00 },
                { id: 'o_xl', name: 'XL', price: 3.00 }
            ] }]),
            SEED.modifierProduct.id
        ]);

        try {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{
                    id: SEED.modifierProduct.id,
                    qty: 1,
                    price: 7.00,
                    tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2.00 }]
                }],
                7.00, 0.80, 7.80
            );
            const [[saved]] = await pool.query(
                'SELECT id, selected_modifiers FROM order_items WHERE invoice_id = ?', [invoiceId]
            );

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [{
                        id: SEED.modifierProduct.id,
                        order_item_id: saved.id,
                        qty: 1,
                        price: 7.00,
                        tax_rate: 16,
                        note: 'Size: Large (2.00 JD)',
                        selectedModifiers: [{ gid: 'g_size', oid: 'o_xl', group: 'Size', option: 'XL', price: 3.00 }]
                    }],
                    subtotal: 6.72,
                    tax: 1.08,
                    total: 7.80
                });
            expect(res.statusCode).toBe(200);

            const [[row]] = await pool.query(
                'SELECT selected_modifiers FROM order_items WHERE invoice_id = ?', [invoiceId]
            );
            expect(row.selected_modifiers).toBe(saved.selected_modifiers);
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
        }
    });

    it('table re-save rejects an id-less group with conflicting saved modifier snapshots', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [
                { id: 'o_large', name: 'Large', price: 2.00 },
                { id: 'o_xl', name: 'XL', price: 3.00 }
            ] }]),
            SEED.modifierProduct.id
        ]);

        try {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [
                    { id: SEED.modifierProduct.id, qty: 1, price: 7, tax_rate: 16, note: 'Size: Large (2.00 JD)', selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }] },
                    { id: SEED.modifierProduct.id, qty: 1, price: 7, tax_rate: 16, note: 'Size: Large (2.00 JD)', selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }] }
                ],
                14.00, 1.60, 15.60
            );
            const [rows] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ? ORDER BY id', [invoiceId]);
            await pool.query('UPDATE order_items SET selected_modifiers = ? WHERE id = ?', [
                JSON.stringify([{ gid: 'g_size', oid: 'o_xl', group: 'Size', option: 'XL', price: 3 }]),
                rows[1].id
            ]);

            const res = await request(app)
                .post('/api/pos/table_order')
                .set('Cookie', adminCookie)
                .send({
                    table_id: SEED.table.id,
                    current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                    cart: [
                        { id: SEED.modifierProduct.id, qty: 1, price: 7, tax_rate: 16, note: 'Size: Large (2.00 JD)', selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }] },
                        { id: SEED.modifierProduct.id, qty: 1, price: 7, tax_rate: 16, note: 'Size: Large (2.00 JD)', selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2 }] }
                    ],
                    subtotal: 14.00,
                    tax: 1.60,
                    total: 15.60
                });
            expect(res.statusCode).toBe(409);
            expect(res.body.message).toMatch(/stale or ambiguous/i);
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
        }
    });

    it('split cart_data keeps the parent modifier snapshot when a client submits a different valid option', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [
                { id: 'o_large', name: 'Large', price: 2.00 },
                { id: 'o_xl', name: 'XL', price: 3.00 }
            ] }]),
            SEED.modifierProduct.id
        ]);

        try {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{
                    id: SEED.modifierProduct.id,
                    qty: 1,
                    price: 7.00,
                    tax_rate: 16,
                    note: 'Size: Large (2.00 JD)',
                    selectedModifiers: [{ gid: 'g_size', oid: 'o_large', group: 'Size', option: 'Large', price: 2.00 }]
                }],
                7.00, 0.80, 7.80
            );
            const [[saved]] = await pool.query(
                'SELECT id, selected_modifiers FROM order_items WHERE invoice_id = ?', [invoiceId]
            );

            const res = await request(app)
                .post('/api/pos/table_splits/split')
                .set('Cookie', adminCookie)
                .send({
                    tableId: SEED.table.id,
                    currentOrderId: invoiceId,
                    splits: [{
                        referenceName: 'Snapshot seat',
                        subtotal: 7.80,
                        items: [{
                            order_item_id: saved.id,
                            product_id: SEED.modifierProduct.id,
                            name: 'Modifier Product',
                            qty: 1,
                            price: 7.00,
                            tax_rate: 16,
                            note: 'Size: Large (2.00 JD)',
                            selectedModifiers: [{ gid: 'g_size', oid: 'o_xl', group: 'Size', option: 'XL', price: 3.00 }]
                        }]
                    }]
                });
            expect(res.statusCode).toBe(200);

            const [held] = await pool.query('SELECT cart_data FROM held_orders WHERE reference_name = ?', ['Snapshot seat']);
            expect(JSON.stringify(JSON.parse(held[0].cart_data).items[0].selectedModifiers)).toBe(saved.selected_modifiers);
        } finally {
            await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
        }
    });

    it('split creation rejects mixed surcharge group without usable order_item_id', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.modifierProduct.id
        ]);

        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [
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
            14.00, 2.24, 16.24
        );

        const [items] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ? ORDER BY id ASC', [invoiceId]);
        await pool.query('UPDATE order_items SET modifier_surcharge = 2.00, modifier_tax_amount = 0.275862, tax_amount = 1.075862 WHERE id = ?', [items[0].id]);
        await pool.query('UPDATE order_items SET modifier_surcharge = NULL, modifier_tax_amount = NULL, tax_amount = 1.12 WHERE id = ?', [items[1].id]);
        await pool.query('UPDATE orders SET subtotal = 13.72, tax = 2.20, total = 15.92 WHERE invoice_id = ?', [invoiceId]);

        const res = await request(app)
            .post('/api/pos/table_splits/split')
            .set('Cookie', adminCookie)
            .send({
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [
                    {
                        subtotal: 7.96,
                        items: [{
                            qty: 1,
                            product_id: SEED.modifierProduct.id,
                            name: 'Modifier Product',
                            price: 7.00,
                            tax_rate: 16,
                            note: 'Size: Large (2.00 JD)',
                            selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                        }]
                    },
                    {
                        subtotal: 7.96,
                        items: [{
                            qty: 1,
                            product_id: SEED.modifierProduct.id,
                            name: 'Modifier Product',
                            price: 7.00,
                            tax_rate: 16,
                            note: 'Size: Large (2.00 JD)',
                            selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
                        }]
                    }
                ]
            });

        if (res.statusCode !== 400) {
            console.log('REJECT SPLIT BODY:', res.body);
        }
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Split items mismatch/i);

        const [held] = await pool.query('SELECT cart_data FROM held_orders');
        const matched = held.filter(h => {
            try {
                return JSON.parse(h.cart_data).parent_invoice_id === invoiceId;
            } catch (_) { return false; }
        });
        expect(matched).toHaveLength(0);

        await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
    });

    it('GET table_order emits structured modifiers (Task 6)', async () => {
        await pool.query('UPDATE products SET modifiers = ? WHERE id = ?', [
            JSON.stringify([{ id: 'g_size', name: 'Size', options: [{ id: 'o_large', name: 'Large', price: 2.00 }] }]),
            SEED.modifierProduct.id
        ]);

        const invoiceId = await createTableOrder(
            adminCookie,
            SEED.table.id,
            [{
                id: SEED.modifierProduct.id,
                qty: 1,
                price: 7.00,
                tax_rate: 16,
                note: 'Size: Large (2.00 JD)',
                selectedModifiers: [{ group: 'Size', option: 'Large', price: 2.00 }]
            }],
            7.00, 1.12, 8.12
        );

        const [items] = await pool.query('SELECT id FROM order_items WHERE invoice_id = ?', [invoiceId]);
        await pool.query('UPDATE order_items SET modifier_surcharge = 2.00 WHERE id = ?', [items[0].id]);

        const res = await request(app)
            .get('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .query({ order_id: invoiceId });

        expect(res.statusCode).toBe(200);
        expect(res.body.cart[0].modifier_surcharge).toBe(2.00);

        await pool.query('UPDATE products SET modifiers = NULL WHERE id = ?', [SEED.modifierProduct.id]);
    });

    describe('saved product removals use void endpoint', () => {
        async function snapshotSavedOrder(invoiceId) {
            const [orders] = await pool.query('SELECT * FROM orders WHERE invoice_id=?', [invoiceId]);
            const [items] = await pool.query('SELECT * FROM order_items WHERE invoice_id=? ORDER BY id', [invoiceId]);
            const [tables] = await pool.query('SELECT * FROM restaurant_tables WHERE id=?', [SEED.table.id]);
            const [refunds] = await pool.query('SELECT * FROM refunds WHERE invoice_id=? ORDER BY id', [invoiceId]);
            const [refundItems] = await pool.query(
                'SELECT ri.* FROM refund_items ri JOIN refunds r ON r.id=ri.refund_id WHERE r.invoice_id=? ORDER BY ri.id',
                [invoiceId]
            );
            const [audits] = await pool.query('SELECT * FROM audit_events WHERE entity_id=? ORDER BY id', [invoiceId]);
            const [stock] = await pool.query('SELECT id, stock FROM products ORDER BY id');
            return { orders, items, tables, refunds, refundItems, audits, stock };
        }

        it('rejects a saved quantity reduction before any mutation', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );
            const before = await snapshotSavedOrder(invoiceId);

            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                subtotal: 5.00,
                tax: 0.80,
                total: 5.80
            });

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('Saved items must be removed with the Remove action.');
            expect(await snapshotSavedOrder(invoiceId)).toEqual(before);
        });

        it('rejects an empty saved table payload before any mutation', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );
            const before = await snapshotSavedOrder(invoiceId);

            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: []
            });

            expect(res.statusCode).toBe(409);
            expect(res.body.message).toBe('Saved items must be removed with the Remove action.');
            expect(await snapshotSavedOrder(invoiceId)).toEqual(before);
        });

        it('still permits increasing a saved row and adding a new product', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 1, price: SEED.product1.price }],
                5.00, 0.80, 5.80
            );

            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [
                    { id: SEED.product1.id, qty: 2, price: SEED.product1.price },
                    { id: SEED.product2.id, qty: 1, price: SEED.product2.price }
                ],
                subtotal: 12.00,
                tax: 1.60,
                total: 13.60
            });

            expect(res.statusCode).toBe(200);
            const [items] = await pool.query(
                'SELECT product_id, quantity FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL ORDER BY product_id',
                [invoiceId]
            );
            expect(items.map(item => [item.product_id, Number(item.quantity)])).toEqual([
                [SEED.product1.id, 2],
                [SEED.product2.id, 1]
            ]);
        });
    });

    describe('progressive split lifecycle', () => {
        it('keeps the parent, table group, and original inventory live after creating split buckets', async () => {
            const invoiceId = await createTableOrder(
                adminCookie,
                SEED.table.id,
                [{ id: SEED.product1.id, qty: 2, price: SEED.product1.price }],
                10.00, 1.60, 11.60
            );
            const [[stockBefore]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);

            const res = await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id,
                currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Seat 1', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] },
                    { referenceName: 'Table 1 - Seat 2', subtotal: 5.80, items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }] }
                ]
            });

            expect(res.statusCode).toBe(200);
            const [[parent]] = await pool.query('SELECT payment_method, subtotal, tax, total FROM orders WHERE invoice_id=?', [invoiceId]);
            expect(parent).toMatchObject({ payment_method: 'unpaid_table', subtotal: '10.00', tax: '1.60', total: '11.60' });
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(invoiceId);
            const [held] = await pool.query('SELECT parent_invoice_id, table_id FROM held_orders ORDER BY id');
            expect(held).toHaveLength(2);
            expect(held.every(row => Number(row.parent_invoice_id) === invoiceId && Number(row.table_id) === SEED.table.id)).toBe(true);
            const [[stockAfter]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product1.id]);
            expect(stockAfter.stock).toBe(stockBefore.stock);
        });

        it('keeps the table open after one bucket and releases it exactly on the final payment without double stock deduction', async () => {
            const invoiceId = await createTableOrder(
                adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 2, price: 2 }],
                4, 0, 4
            );
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Seat 1', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] },
                    { referenceName: 'Table 1 - Seat 2', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                ]
            }).expect(200);
            const [held] = await pool.query('SELECT id FROM held_orders ORDER BY id');
            const [[stockAfterSave]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);
            const pay = id => request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }],
                shift_id: cashierShiftId, subtotal: 2, tax: 0, total: 2,
                payment_method: 'cash', cash_amount: 2, amount_tendered: 2, change_due: 0,
                split_check_id: id, table_id: SEED.table.id,
                idempotency_key: `progressive_${id}`
            });

            const first = await pay(held[0].id);
            expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
            let [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(invoiceId);
            let [[parent]] = await pool.query('SELECT payment_method, total FROM orders WHERE invoice_id=?', [invoiceId]);
            expect(parent.payment_method).toBe('unpaid_table');
            expect(Number(parent.total)).toBe(4);
            let [[stock]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);
            expect(stock.stock).toBe(stockAfterSave.stock);

            const second = await pay(held[1].id);
            expect(second.statusCode).toBe(200);
            [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
            expect(table).toMatchObject({ status: 'available', current_order_id: null });
            [[parent]] = await pool.query('SELECT payment_method, total, original_total FROM orders WHERE invoice_id=?', [invoiceId]);
            expect(parent.payment_method).toBe('voided');
            expect(Number(parent.total)).toBe(0);
            expect(Number(parent.original_total)).toBe(4);
            [[stock]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);
            expect(stock.stock).toBe(stockAfterSave.stock);
            const [[children]] = await pool.query('SELECT COUNT(*) count, SUM(total) total FROM orders WHERE parent_invoice_id=?', [invoiceId]);
            expect(Number(children.count)).toBe(2);
            expect(Number(children.total)).toBe(4);
        });

        it('rejects editing the live parent while progressive buckets are open', async () => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: 2 }], 2, 0, 2);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie)
                .send(singleSeatSplit(SEED.table.id, invoiceId)).expect(200);

            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie).send({
                table_id: SEED.table.id,
                current_order_id: invoiceId, expected_version: await currentTableRevision(invoiceId),
                cart: [{ id: SEED.product2.id, qty: 2, price: 2 }],
                subtotal: 4, tax: 0, total: 4
            });
            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('SPLIT_CHECKS_OPEN');
        });

        it('rejects transferring a table while progressive buckets are open', async () => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 1, price: 2 }], 2, 0, 2);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie)
                .send(singleSeatSplit(SEED.table.id, invoiceId)).expect(200);

            const res = await request(app).post('/api/pos/tables/transfer').set('Cookie', adminCookie).send(await tableActionIntent(pool, {
                sourceTableId: SEED.table.id,
                targetTableId: SEED.table2.id,
                action: 'transfer'
            }));
            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('SPLIT_CHECKS_OPEN');
        });

        it('cancels the entire unpaid group back to its unchanged live parent', async () => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 2, price: 2 }], 4, 0, 4);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Seat 1', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] },
                    { referenceName: 'Table 1 - Seat 2', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                ]
            }).expect(200);
            const [[held]] = await pool.query('SELECT id FROM held_orders ORDER BY id LIMIT 1');
            const [[stockBefore]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);

            const res = await request(app).delete(`/api/pos/table_splits?id=${held.id}`).set('Cookie', adminCookie);
            expect(res.statusCode).toBe(200);
            const [[left]] = await pool.query('SELECT COUNT(*) count FROM held_orders WHERE parent_invoice_id=?', [invoiceId]);
            expect(Number(left.count)).toBe(0);
            const [[parent]] = await pool.query('SELECT payment_method, total FROM orders WHERE invoice_id=?', [invoiceId]);
            expect(parent.payment_method).toBe('unpaid_table');
            expect(Number(parent.total)).toBe(4);
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
            expect(table.status).toBe('occupied');
            expect(Number(table.current_order_id)).toBe(invoiceId);
            const [[stockAfter]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);
            expect(stockAfter.stock).toBe(stockBefore.stock);
        });

        it('refuses cancellation after any split child has been paid', async () => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 2, price: 2 }], 4, 0, 4);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Seat 1', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] },
                    { referenceName: 'Table 1 - Seat 2', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                ]
            }).expect(200);
            const [held] = await pool.query('SELECT id FROM held_orders ORDER BY id');
            await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product2.id, qty: 1, price: 2 }],
                shift_id: cashierShiftId, subtotal: 2, tax: 0, total: 2,
                payment_method: 'cash', cash_amount: 2, amount_tendered: 2, change_due: 0,
                split_check_id: held[0].id, table_id: SEED.table.id,
                idempotency_key: `cancel_after_pay_${held[0].id}`
            }).expect(200);

            const res = await request(app).delete(`/api/pos/table_splits?id=${held[1].id}`).set('Cookie', adminCookie);
            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('SPLIT_ALREADY_PAID');
            const [[remaining]] = await pool.query('SELECT COUNT(*) count FROM held_orders WHERE id=?', [held[1].id]);
            expect(Number(remaining.count)).toBe(1);
        });

        it('serializes simultaneous payments for different buckets and closes the table once', async () => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 2, price: 2 }], 4, 0, 4);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Seat 1', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] },
                    { referenceName: 'Table 1 - Seat 2', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                ]
            }).expect(200);
            const [held] = await pool.query('SELECT id FROM held_orders ORDER BY id');
            const pay = id => request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product2.id, qty: 1, price: 2 }],
                shift_id: cashierShiftId, subtotal: 2, tax: 0, total: 2,
                payment_method: 'cash', cash_amount: 2, amount_tendered: 2, change_due: 0,
                split_check_id: id, table_id: SEED.table.id,
                idempotency_key: `concurrent_bucket_${id}`
            });
            const results = await Promise.all(held.map(row => pay(row.id)));
            expect(results.map(result => result.statusCode)).toEqual([200, 200]);
            const [[table]] = await pool.query('SELECT status, current_order_id FROM restaurant_tables WHERE id=?', [SEED.table.id]);
            expect(table).toMatchObject({ status: 'available', current_order_id: null });
            const [[audit]] = await pool.query("SELECT COUNT(*) count FROM audit_events WHERE event_type='split_parent_completed' AND entity_id=?", [invoiceId]);
            expect(Number(audit.count)).toBe(1);
        });

        it('atomically rewrites only the unpaid split group and rejects stale editors', async () => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 3, price: 2 }], 6, 0, 6);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Remaining Check', split_role: 'remainder', subtotal: 4, items: [{ id: SEED.product2.id, qty: 2, price: 2, tax_rate: 0 }] },
                    { referenceName: 'Table 1 - Check 2', split_role: 'check', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                ]
            }).expect(200);

            const [before] = await pool.query('SELECT id, cart_data FROM held_orders WHERE parent_invoice_id=? ORDER BY id', [invoiceId]);
            const parsed = before.map(row => ({ ...row, payload: JSON.parse(row.cart_data) }));
            expect(parsed.map(row => row.payload.split_role)).toEqual(['remainder', 'check']);
            const canonicalItem = parsed[0].payload.items.find(item => item.note !== 'Auto-Gratuity');
            const [[stockBeforeEdit]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);
            const [[printsBeforeEdit]] = await pool.query('SELECT COUNT(*) count FROM print_queue');
            const expectedChecks = parsed.map(row => ({ id: row.id, revision: row.payload.split_revision }));
            const foreignLine = await request(app).put('/api/pos/table_splits').set('Cookie', adminCookie).send({
                splitId: parsed[0].id,
                expectedChecks,
                splits: [
                    { id: parsed[0].id, split_role: 'remainder', items: [{ ...canonicalItem, order_item_id: 999999, qty: 2 }] },
                    { id: parsed[1].id, split_role: 'check', items: [{ ...canonicalItem, qty: 1 }] }
                ]
            });
            expect(foreignLine.statusCode).toBe(409);
            expect(foreignLine.body.code).toBe('SPLIT_ITEMS_MISMATCH');
            const editPayload = {
                splitId: parsed[0].id,
                expectedChecks,
                splits: [
                    { id: parsed[0].id, split_role: 'remainder', items: [{ ...canonicalItem, qty: 1 }] },
                    { id: parsed[1].id, split_role: 'check', items: [{ ...canonicalItem, qty: 1 }] },
                    { split_role: 'check', items: [{ ...canonicalItem, qty: 1 }] }
                ]
            };

            const edit = await request(app).put('/api/pos/table_splits').set('Cookie', adminCookie).send(editPayload);
            expect(edit.statusCode).toBe(200);
            const [after] = await pool.query('SELECT id, subtotal, cart_data FROM held_orders WHERE parent_invoice_id=? ORDER BY id', [invoiceId]);
            expect(after).toHaveLength(3);
            const afterPayloads = after.map(row => JSON.parse(row.cart_data));
            expect(afterPayloads.reduce((sum, payload) => sum + payload.items.filter(item => item.note !== 'Auto-Gratuity').reduce((qty, item) => qty + Number(item.qty), 0), 0)).toBe(3);
            expect(afterPayloads.reduce((sum, payload) => sum + payload.split_money_cents.total, 0)).toBe(600);
            expect(afterPayloads.map(payload => payload.split_revision)).toEqual([2, 2, 1]);

            const stale = await request(app).put('/api/pos/table_splits').set('Cookie', adminCookie).send(editPayload);
            expect(stale.statusCode).toBe(409);
            expect(stale.body.code).toBe('SPLIT_GROUP_CHANGED');
            const [[unchanged]] = await pool.query('SELECT COUNT(*) count FROM held_orders WHERE parent_invoice_id=?', [invoiceId]);
            expect(Number(unchanged.count)).toBe(3);

            const removePayloads = after.map(row => JSON.parse(row.cart_data));
            const remove = await request(app).put('/api/pos/table_splits').set('Cookie', adminCookie).send({
                splitId: after[0].id,
                expectedChecks: after.map((row, index) => ({ id: row.id, revision: removePayloads[index].split_revision })),
                splits: [
                    { id: after[0].id, split_role: 'remainder', items: [{ ...canonicalItem, qty: 1 }] },
                    { id: after[1].id, split_role: 'check', items: [{ ...canonicalItem, qty: 2 }] }
                ]
            });
            expect(remove.statusCode).toBe(200);
            const [[removed]] = await pool.query('SELECT COUNT(*) count FROM held_orders WHERE parent_invoice_id=?', [invoiceId]);
            expect(Number(removed.count)).toBe(2);
            const [[stockAfterEdit]] = await pool.query('SELECT stock FROM products WHERE id=?', [SEED.product2.id]);
            const [[printsAfterEdit]] = await pool.query('SELECT COUNT(*) count FROM print_queue');
            expect(stockAfterEdit.stock).toBe(stockBeforeEdit.stock);
            expect(Number(printsAfterEdit.count)).toBe(Number(printsBeforeEdit.count));
        });

        it('never rewrites a paid child when the unpaid remainder is edited', async () => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 2, price: 2 }], 4, 0, 4);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Remaining Check', split_role: 'remainder', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] },
                    { referenceName: 'Table 1 - Check 2', split_role: 'check', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                ]
            }).expect(200);
            const [held] = await pool.query('SELECT id, cart_data FROM held_orders WHERE parent_invoice_id=? ORDER BY id', [invoiceId]);
            const remainder = held.find(row => JSON.parse(row.cart_data).split_role === 'remainder');
            const paid = held.find(row => JSON.parse(row.cart_data).split_role === 'check');
            await request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product2.id, qty: 1, price: 2 }],
                shift_id: cashierShiftId, subtotal: 2, tax: 0, total: 2,
                payment_method: 'cash', cash_amount: 2, amount_tendered: 2, change_due: 0,
                split_check_id: paid.id, table_id: SEED.table.id,
                idempotency_key: `paid_before_edit_${paid.id}`
            }).expect(200);
            const payload = JSON.parse(remainder.cart_data);
            const item = payload.items.find(value => value.note !== 'Auto-Gratuity');
            const edit = await request(app).put('/api/pos/table_splits').set('Cookie', adminCookie).send({
                splitId: remainder.id,
                expectedChecks: [{ id: remainder.id, revision: payload.split_revision }],
                splits: [
                    { id: remainder.id, split_role: 'remainder', items: [{ ...item, qty: 0.5 }] },
                    { split_role: 'check', items: [{ ...item, qty: 0.5 }] }
                ]
            });
            expect(edit.statusCode).toBe(200);
            const [[paidOrder]] = await pool.query(
                "SELECT COUNT(*) count, SUM(total) total FROM orders WHERE parent_invoice_id=? AND payment_method='cash'",
                [invoiceId]
            );
            expect(Number(paidOrder.count)).toBe(1);
            expect(Number(paidOrder.total)).toBe(2);
            const [unpaid] = await pool.query('SELECT cart_data FROM held_orders WHERE parent_invoice_id=?', [invoiceId]);
            expect(unpaid).toHaveLength(2);
            expect(unpaid.reduce((sum, row) => sum + JSON.parse(row.cart_data).split_money_cents.total, 0)).toBe(200);
            const board = await request(app).get('/api/pos/table_splits').set('Cookie', adminCookie);
            const groupRows = board.body.data.filter(row => Number(row.parent_invoice_id) === invoiceId);
            expect(groupRows).toHaveLength(2);
            expect(groupRows.every(row => Number(row.paid_split_count) === 1)).toBe(true);
        });

        it('reallocates service charge cents and creates a held snapshot for an added check', async () => {
            await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='service_charge_enabled'");
            await pool.query("UPDATE settings SET setting_value='10' WHERE setting_key='service_charge_percentage'");
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id, [
                { id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 },
                { id: null, name: '10% Service Charge', qty: 1, price: 0.50, tax_rate: 0, note: 'Auto-Gratuity' }
            ], 5.50, 0.80, 6.30);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Remaining Check', split_role: 'remainder', subtotal: 3.15, items: [{ id: SEED.product1.id, qty: 0.5, price: 5, tax_rate: 16 }] },
                    { referenceName: 'Table 1 - Check 2', split_role: 'check', subtotal: 3.15, items: [{ id: SEED.product1.id, qty: 0.5, price: 5, tax_rate: 16 }] }
                ]
            }).expect(200);
            const [held] = await pool.query('SELECT id, cart_data FROM held_orders WHERE parent_invoice_id=? ORDER BY id', [invoiceId]);
            const payloads = held.map(row => JSON.parse(row.cart_data));
            const item = payloads[0].items.find(value => value.note !== 'Auto-Gratuity');
            const edit = await request(app).put('/api/pos/table_splits').set('Cookie', adminCookie).send({
                splitId: held[0].id,
                expectedChecks: held.map((row, index) => ({ id: row.id, revision: payloads[index].split_revision })),
                splits: [
                    { id: held[0].id, split_role: 'remainder', items: [{ ...item, qty: 0.25 }] },
                    { id: held[1].id, split_role: 'check', items: [{ ...item, qty: 0.25 }] },
                    { split_role: 'check', items: [{ ...item, qty: 0.5 }] }
                ]
            });
            expect(edit.statusCode).toBe(200);
            const [after] = await pool.query(
                `SELECT h.cart_data, s.state, s.parent_snapshot_id
                   FROM held_orders h
                   JOIN service_charge_snapshots s ON s.id=h.service_charge_snapshot_id
                  WHERE h.parent_invoice_id=?`,
                [invoiceId]
            );
            expect(after).toHaveLength(3);
            expect(after.every(row => row.state === 'held' && row.parent_snapshot_id)).toBe(true);
            expect(after.reduce((sum, row) => sum + JSON.parse(row.cart_data).service_charge_allocation_cents, 0)).toBe(50);
        });

        // Resolves with the ids of `count` other connections in this database
        // that have been running one statement for at least 200 ms, i.e. are
        // blocked. The live PROCESSLIST is read, never the InnoDB cache views,
        // and filtered by database because isolated runs share one server.
        async function waitForBlocked(count, excludeIds) {
            let ids;
            await vi.waitFor(async () => {
                const [rows] = await pool.query(
                    `SELECT ID AS id FROM information_schema.PROCESSLIST
                      WHERE DB=DATABASE() AND COMMAND='Query' AND TIME_MS>=1500
                        AND ID<>CONNECTION_ID() AND ID NOT IN (?)`,
                    [excludeIds]
                );
                expect(rows, 'blocked connections').toHaveLength(count);
                ids = rows.map(row => Number(row.id));
            }, { timeout: 10000, interval: 100 });
            return ids;
        }

        // Both orderings, each proven concurrent: the loser is sent only after the
        // winner holds the table lock, and must be seen waiting on the winner.
        it.each([
            { winner: 'edit', loserStatus: 409 },
            { winner: 'payment', loserStatus: 404 }
        ])('allows only one winner when payment races an unpaid-group edit ($winner wins)', async ({ winner, loserStatus }) => {
            const invoiceId = await createTableOrder(adminCookie, SEED.table.id,
                [{ id: SEED.product2.id, qty: 2, price: 2 }], 4, 0, 4);
            await request(app).post('/api/pos/table_splits/split').set('Cookie', adminCookie).send({
                tableId: SEED.table.id, currentOrderId: invoiceId,
                splits: [
                    { referenceName: 'Table 1 - Remaining Check', split_role: 'remainder', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] },
                    { referenceName: 'Table 1 - Check 2', split_role: 'check', subtotal: 2, items: [{ id: SEED.product2.id, qty: 1, price: 2, tax_rate: 0 }] }
                ]
            }).expect(200);
            const [held] = await pool.query('SELECT id, cart_data FROM held_orders WHERE parent_invoice_id=? ORDER BY id', [invoiceId]);
            const payloads = held.map(row => JSON.parse(row.cart_data));
            const item = payloads[0].items.find(value => value.note !== 'Auto-Gratuity');
            // .then() makes supertest send immediately.
            const editRequest = () => request(app).put('/api/pos/table_splits').set('Cookie', adminCookie).send({
                splitId: held[0].id,
                expectedChecks: held.map((row, index) => ({ id: row.id, revision: payloads[index].split_revision })),
                splits: [
                    { id: held[0].id, split_role: 'remainder', items: [{ ...item, qty: 0.5 }] },
                    { id: held[1].id, split_role: 'check', items: [{ ...item, qty: 1.5 }] }
                ]
            }).then(result => result);
            const payRequest = () => request(app).post('/api/pos/checkout').set('Cookie', cashierCookie).send({
                cart: [{ id: SEED.product2.id, qty: 1, price: 2 }],
                shift_id: cashierShiftId, subtotal: 2, tax: 0, total: 2,
                payment_method: 'cash', cash_amount: 2, amount_tendered: 2, change_due: 0,
                split_check_id: held[0].id, split_revision: payloads[0].split_revision,
                table_id: SEED.table.id, idempotency_key: `pay_edit_race_${held[0].id}`
            }).then(result => result);
            const [sendWinner, sendLoser] = winner === 'edit' ? [editRequest, payRequest] : [payRequest, editRequest];

            // Hold the group's check rows: the winner takes the table lock, then stops here.
            const blocker = await pool.getConnection();
            let winnerPending;
            let loserPending;
            try {
                await blocker.beginTransaction();
                await blocker.query('SELECT id FROM held_orders WHERE parent_invoice_id=? FOR UPDATE', [invoiceId]);
                const [[{ id: blockerId }]] = await blocker.query('SELECT CONNECTION_ID() AS id');
                winnerPending = sendWinner();
                // The winner holds the table rows and waits on the blocked check rows.
                // Held for 1.5 s: the blocker never releases until the end, so a merely
                // slow statement is not mistaken for this wait.
                const [winnerId] = await waitForBlocked(1, [blockerId]);
                loserPending = sendLoser();
                // Only the winner holds the table rows, so the loser waits on the winner.
                expect(await waitForBlocked(2, [blockerId])).toContain(winnerId);
            } finally {
                await blocker.rollback();
                blocker.release();
                await Promise.allSettled([winnerPending, loserPending]);
            }
            const [won, lost] = await Promise.all([winnerPending, loserPending]);
            expect(won.statusCode, JSON.stringify(won.body)).toBe(200);
            // A paid check is gone (404 to the edit); an edited check has a new revision (409 to the payment).
            expect(lost.statusCode, JSON.stringify(lost.body)).toBe(loserStatus);

            const [remaining] = await pool.query('SELECT cart_data FROM held_orders WHERE parent_invoice_id=?', [invoiceId]);
            const heldCents = remaining.reduce((sum, row) => sum + JSON.parse(row.cart_data).split_money_cents.total, 0);
            const [[paid]] = await pool.query(
                "SELECT COALESCE(SUM(total),0) total FROM orders WHERE parent_invoice_id=? AND payment_method IN ('cash','card','split')",
                [invoiceId]
            );
            expect(Math.round(Number(paid.total) * 100)).toBe(winner === 'payment' ? 200 : 0);
            expect(heldCents + Math.round(Number(paid.total) * 100)).toBe(400);
        });
    });
    describe('[priced note] catalog-backed note products', () => {
        let noteA;
        let noteB;

        const saveTable = (tableId, cart) => request(app)
            .post('/api/pos/table_order')
            .set('Cookie', adminCookie)
            .send({ table_id: tableId, cart, subtotal: 2.90, tax: 0, total: 2.90 });

        const parentLines = (invoiceId) => pool.query(
            'SELECT quantity, price_at_sale, modifier_surcharge, selected_modifiers FROM order_items WHERE invoice_id=? AND parent_item_id IS NULL ORDER BY id',
            [invoiceId]
        ).then(([rows]) => rows);

        beforeEach(async () => {
            const [category] = await pool.query(
                "INSERT INTO categories (name, is_notes, is_active) VALUES ('Paid notes', 1, 1)"
            );
            // Deliberately identical name and price: only the catalog ID separates them.
            const [a] = await pool.query(
                "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
                [category.insertId]
            );
            const [b] = await pool.query(
                "INSERT INTO products (category_id, name, price, tax_rate, jofotara_tax_category, is_active) VALUES (?, 'Two slices', 0.20, 0, 'O', 1)",
                [category.insertId]
            );
            noteA = a.insertId;
            noteB = b.insertId;
            await pool.query("UPDATE products SET price=2.70, tax_rate=0, jofotara_tax_category='O' WHERE id=?", [SEED.product1.id]);
        });

        it('[priced note] freezes the saved table row against later catalog changes', async () => {
            const saved = await saveTable(SEED.table.id, [{
                id: SEED.product1.id, qty: 1, price: 2.90, tax_rate: 0,
                selectedModifiers: [{ noteProductId: noteA, group: 'forged', option: 'forged', price: 99 }]
            }]);
            expect(saved.statusCode).toBe(200);

            const [before] = await parentLines(saved.body.order_id);
            expect(Number(before.price_at_sale)).toBe(2.90);
            expect(Number(before.modifier_surcharge)).toBe(0.20);
            expect(JSON.parse(before.selected_modifiers)).toEqual([
                { noteProductId: noteA, group: 'Two slices', option: 'Two slices', price: 0.2 }
            ]);

            await pool.query('UPDATE products SET is_active=0, price=9.99 WHERE id=?', [noteA]);

            const [after] = await parentLines(saved.body.order_id);
            expect(Number(after.price_at_sale)).toBe(2.90);
            expect(Number(after.modifier_surcharge)).toBe(0.20);
            expect(after.selected_modifiers).toBe(before.selected_modifiers);
        });

        it('[priced note] keeps two same-name notes distinct when tables are merged', async () => {
            const target = await saveTable(SEED.table.id, [{
                id: SEED.product1.id, qty: 1, price: 2.90, tax_rate: 0,
                selectedModifiers: [{ noteProductId: noteA }]
            }]);
            expect(target.statusCode).toBe(200);
            const source = await saveTable(SEED.table2.id, [{
                id: SEED.product1.id, qty: 1, price: 2.90, tax_rate: 0,
                selectedModifiers: [{ noteProductId: noteB }]
            }]);
            expect(source.statusCode).toBe(200);

            const merged = await request(app).post('/api/pos/tables/transfer').set('Cookie', adminCookie)
                .send(await tableActionIntent(pool, { sourceTableId: SEED.table2.id, targetTableId: SEED.table.id, action: 'merge' }));
            expect(merged.statusCode).toBe(200);

            // Same product, price, note text and money — only selected_modifiers differs.
            // Without that column in the merge match these collapse into one qty-2 row.
            const lines = await parentLines(target.body.order_id);
            expect(lines).toHaveLength(2);
            expect(lines.map(line => Number(line.quantity))).toEqual([1, 1]);
            expect(lines.map(line => JSON.parse(line.selected_modifiers)[0].noteProductId).sort((x, y) => x - y))
                .toEqual([noteA, noteB].sort((x, y) => x - y));
        });

        it('[priced note] refuses a note-category product as a top-level table line', async () => {
            const res = await request(app).post('/api/pos/table_order').set('Cookie', adminCookie)
                .send({ table_id: SEED.table.id, cart: [{ id: noteA, qty: 1, price: 0.20, tax_rate: 0 }], subtotal: 0.20, tax: 0, total: 0.20 });
            expect(res.statusCode).toBe(409);
            expect(res.body.code).toBe('NOTE_PRODUCT_REQUIRES_ITEM');
        });
    });
});
