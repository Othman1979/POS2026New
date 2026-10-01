import { describe, it, expect, beforeEach, afterAll } from 'vitest';
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');
const { seedReceiptPrinter } = require('../helpers/fixtures');
const { expectMoney } = require('../helpers/assertions');
const { buildYHeldItemsReportPayload } = require('../../services/yHeldItemsReportBuilder');

describe('Y held-items report', () => {
    let adminCookie;

    beforeEach(async () => {
        await seedDatabase();
        await pool.query(
            "UPDATE settings SET setting_value = ? WHERE setting_key = 'y_order_type_id'",
            [String(SEED.orderType.id)]
        );
        adminCookie = await loginSeedUser(request, app, 'adminUser');
    });

    afterAll(async () => {
        await pool.end();
    });

    it('narrows a business-day report before reading the historical held backlog', async () => {
        const cart = JSON.stringify({ order_type_id: SEED.orderType.id, items: [
            { id: SEED.product1.id, product_id: SEED.product1.id, name: SEED.product1.name,
                qty: 1, price: 5, tax_rate: 16, category_id: SEED.category.id },
        ] });
        await pool.query(`INSERT INTO held_orders (user_id,reference_name,cart_data,created_at) VALUES ?`,
            [Array.from({ length: 4000 }, () => [2, 'Historical hold', cart, '2025-01-01 08:00:00'])]);
        await pool.query(`INSERT INTO held_orders (user_id,reference_name,cart_data,created_at)
            VALUES (2,'Selected hold',?,'2026-07-01 08:00:00')`, [cart]);
        await pool.query('ANALYZE TABLE held_orders');
        const conn = await pool.getConnection();
        try {
            const read = async () => Number((await conn.query("SHOW SESSION STATUS LIKE 'Rows_read'"))[0][0].Value);
            const before = await read();
            const payload = await buildYHeldItemsReportPayload(conn, { businessDate: '2026-07-01' });
            expect(payload.orders).toHaveLength(1);
            expect((await read()) - before).toBeLessThan(100);
        } finally { conn.release(); }
    });

    it('returns and archives only Y holds with exact discounts, tax, totals, categories, and item quantities', async () => {
        const cartData = JSON.stringify({
            tax_context_version: 1,
            tax_inclusive_at_hold: 0,
            order_type_id: SEED.orderType.id,
            order_discount: { type: 'percent', value: 10 },
            items: [
                {
                    id: SEED.product1.id,
                    product_id: SEED.product1.id,
                    name: SEED.product1.name,
                    category_id: SEED.category.id,
                    qty: 2,
                    price: 5,
                    tax_rate: 16,
                    discountType: 'percent',
                    discountValue: 10,
                },
                {
                    id: SEED.product2.id,
                    product_id: SEED.product2.id,
                    name: SEED.product2.name,
                    category_id: SEED.category.id,
                    qty: 1,
                    price: 2,
                    tax_rate: 0,
                    discountType: null,
                    discountValue: 0,
                },
            ],
        });

        const [yRow] = await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, kitchen_fired, created_at)
             VALUES (?, 'Y report row', ?, 11.00, 1, '2026-07-01 08:00:00')`,
            [SEED.cashierUser.id, cartData]
        );
        const ordinaryCartData = JSON.stringify({ ...JSON.parse(cartData), order_type_id: 2 });
        const [ordinaryRow] = await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'ordinary hold', ?, 11.00, '2026-07-01 09:00:00')`,
            [SEED.cashierUser.id, ordinaryCartData]
        );
        const [outsideRow] = await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Y outside report', ?, 11.00, '2026-07-02 08:00:00')`,
            [SEED.cashierUser.id, cartData]
        );

        const response = await request(app)
            .post('/api/admin/audit-reports/print-y')
            .set('Cookie', adminCookie)
            .send({ business_date: '2026-07-01' });

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);

        const payload = response.body.print_payload;
        expect(payload.print_type).toBe('y_held_items_report');
        expect(payload.summary.order_count).toBe(1);
        expectMoney(payload.summary.subtotal, 11.00);
        expectMoney(payload.summary.line_discount, 1.00);
        expectMoney(payload.summary.order_discount, 1.10);
        expectMoney(payload.summary.discount_total, 2.10);
        expectMoney(payload.summary.tax, 1.30);
        expectMoney(payload.summary.total, 11.20);

        const burger = payload.items.find(item => item.item_name === SEED.product1.name);
        const drink = payload.items.find(item => item.item_name === SEED.product2.name);
        expect(burger.qty_sold).toBe(2);
        expectMoney(burger.gross_revenue, 9.40);
        expect(drink.qty_sold).toBe(1);
        expectMoney(drink.gross_revenue, 1.80);

        expect(payload.categories).toHaveLength(1);
        expect(payload.categories[0].category_name).toBe(SEED.category.name);
        expect(payload.categories[0].qty_sold).toBe(3);
        expectMoney(payload.categories[0].gross_revenue, 11.20);
        expect(payload.orders).toHaveLength(1);
        expect(payload.orders[0]).toMatchObject({
            held_order_id: Number(yRow.insertId),
            reference_name: 'Y report row',
            cashier_name: SEED.cashierUser.name,
            kitchen_fired: true,
        });
        expect(payload.orders[0].items).toHaveLength(2);
        expect(payload.orders[0].items[0]).toMatchObject({
            item_name: SEED.product1.name,
            qty: 2,
        });
        expectMoney(payload.orders[0].summary.tax, 1.30);
        expectMoney(payload.orders[0].summary.total, 11.20);

        const [remaining] = await pool.query('SELECT id FROM held_orders ORDER BY id');
        const remainingIds = remaining.map(row => Number(row.id));
        expect(remainingIds).not.toContain(Number(yRow.insertId));
        expect(remainingIds).toContain(Number(ordinaryRow.insertId));
        expect(remainingIds).toContain(Number(outsideRow.insertId));

        const [[archive]] = await pool.query('SELECT * FROM master_held');
        expect(archive).toBeTruthy();
        const archivedRows = JSON.parse(archive.held_orders_payload);
        expect(archivedRows).toHaveLength(1);
        expect(Number(archivedRows[0].id)).toBe(Number(yRow.insertId));
        expect(archivedRows[0].reference_name).toBe('Y report row');
        expect(JSON.parse(archive.report_payload).summary.total).toBe(payload.summary.total);
        const retentionHours = (new Date(archive.expires_at) - new Date(archive.created_at)) / 3_600_000;
        expect(retentionHours).toBeCloseTo(24, 2);
        expect(response.body.archive_id).toBe(Number(archive.id));
        const [[{ queued }]] = await pool.query('SELECT COUNT(*) AS queued FROM print_queue');
        expect(Number(queued)).toBe(0);
    });

    it('archives Y holds and returns the payload when no receipt printer is configured', async () => {
        const cartData = JSON.stringify({
            order_type_id: SEED.orderType.id,
            items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
        });
        const [held] = await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Y without printer', ?, 5, '2026-07-01 08:00:00')`,
            [SEED.cashierUser.id, cartData]
        );

        const response = await request(app)
            .post('/api/admin/audit-reports/print-y')
            .set('Cookie', adminCookie)
            .send({ business_date: '2026-07-01' });

        expect(response.statusCode).toBe(200);
        expect(response.body.print_payload.print_type).toBe('y_held_items_report');
        const [[remaining]] = await pool.query('SELECT COUNT(*) AS count FROM held_orders WHERE id = ?', [held.insertId]);
        const [[archives]] = await pool.query('SELECT COUNT(*) AS count FROM master_held');
        expect(Number(remaining.count)).toBe(0);
        expect(Number(archives.count)).toBe(1);
    });

    it('keeps modifier surcharge, fixed order discount, and service-charge tax in balance', async () => {
        const cartData = JSON.stringify({
            tax_context_version: 1,
            tax_inclusive_at_hold: 0,
            order_type_id: SEED.orderType.id,
            order_discount: { type: 'fixed', value: 1 },
            items: [
                {
                    id: 10,
                    product_id: 10,
                    name: 'Modifier Product',
                    category_id: SEED.category.id,
                    qty: 1,
                    price: 7,
                    tax_rate: 16,
                    modifier_surcharge: 2,
                    selectedModifiers: [{ group: 'Size', option: 'Large', price: 2 }],
                },
                {
                    product_id: null,
                    name: 'Service Charge',
                    category_id: null,
                    qty: 1,
                    price: 0.56,
                    tax_rate: 8,
                    note: 'Auto-Gratuity',
                },
            ],
        });
        await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Y modifier and service', ?, 7.56, '2026-07-01 10:00:00')`,
            [SEED.cashierUser.id, cartData]
        );

        const payload = await buildYHeldItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        expectMoney(payload.summary.subtotal, 7.56);
        expectMoney(payload.summary.order_discount, 1.00);
        expectMoney(payload.summary.tax, 0.73);
        expectMoney(payload.summary.total, 7.29);
        expectMoney(payload.items.reduce((sum, item) => sum + item.gross_revenue, 0), 7.29);
        expect(payload.items.find(item => item.item_name === 'Modifier Product').qty_sold).toBe(1);
        expect(payload.items.find(item => item.item_name === 'Service Charge').qty_sold).toBe(1);
    });

    it('counts bundle children without assigning them revenue in inclusive-tax mode', async () => {
        const cartData = JSON.stringify({
            tax_context_version: 1,
            tax_inclusive_at_hold: 1,
            order_type_id: SEED.orderType.id,
            items: [{
                id: SEED.bundleProduct.id,
                product_id: SEED.bundleProduct.id,
                name: SEED.bundleProduct.name,
                category_id: SEED.category.id,
                qty: 2,
                price: 10,
                tax_rate: 16,
                is_bundle: true,
                bundleItems: [
                    { product_id: SEED.product1.id, name: SEED.product1.name, category_id: SEED.category.id, qty: 1, removed: false },
                    { product_id: SEED.product2.id, name: SEED.product2.name, category_id: SEED.category.id, qty: 1, removed: false },
                ],
            }],
        });
        await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Y bundle', ?, 20.00, '2026-07-01 11:00:00')`,
            [SEED.cashierUser.id, cartData]
        );

        const payload = await buildYHeldItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        expectMoney(payload.summary.tax, 0);
        expectMoney(payload.summary.total, 20);
        expectMoney(payload.items.find(item => item.item_name === SEED.bundleProduct.name).gross_revenue, 20);
        expect(payload.items.find(item => item.item_name === SEED.product1.name)).toMatchObject({ qty_sold: 2, gross_revenue: 0 });
        expect(payload.items.find(item => item.item_name === SEED.product2.name)).toMatchObject({ qty_sold: 2, gross_revenue: 0 });
    });

    it('uses the currently configured special order type instead of a stale Y flag', async () => {
        const cartFor = orderTypeId => JSON.stringify({
            order_type_id: orderTypeId,
            items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
        });
        await pool.query(
            `INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Old Y type', ?, 5, '2026-07-01 09:00:00'),
                    (?, 'Current Y type', ?, 5, '2026-07-01 10:00:00')`,
            [SEED.cashierUser.id, cartFor(SEED.orderType.id), SEED.cashierUser.id, cartFor(2)]
        );
        await pool.query(
            "UPDATE settings SET setting_value = '2' WHERE setting_key = 'y_order_type_id'"
        );

        const payload = await buildYHeldItemsReportPayload(pool, {
            businessDate: '2026-07-01',
            generatedByUser: SEED.adminUser,
        });

        expect(payload.orders).toHaveLength(1);
        expect(payload.orders[0].reference_name).toBe('Current Y type');
    });

    it('restores the exact held rows from a report archive during the 24-hour safety window', async () => {
        await seedReceiptPrinter(pool);
        await pool.query("INSERT INTO users (id, user_number, name, role, is_active) VALUES (70, '9070', 'Phone Desk', 'call_center', 1)");
        const cartData = JSON.stringify({
            order_type_id: SEED.orderType.id,
            items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
        });
        const [held] = await pool.query(
            `INSERT INTO held_orders
             (user_id, call_center_user_id, reference_name, cart_data, subtotal, kitchen_fired, parent_invoice_id, table_id, created_at)
             VALUES (?, 70, 'Recover Y', ?, 5, 1, ?, ?, '2026-07-01 12:00:00')`,
            [SEED.cashierUser.id, cartData, null, SEED.table.id]
        );

        await pool.query("UPDATE held_orders SET order_id=17,order_seq_scope='date:2026-07-01' WHERE id=?", [held.insertId]);

        const printed = await request(app)
            .post('/api/admin/audit-reports/print-y')
            .set('Cookie', adminCookie)
            .send({ business_date: '2026-07-01' });
        expect(printed.statusCode).toBe(200);

        const status = await request(app)
            .get('/api/admin/audit-reports/y-archive-status')
            .set('Cookie', adminCookie);
        expect(status.statusCode).toBe(200);
        expect(status.body.archive.id).toBe(printed.body.archive_id);
        expect(status.body.archive.order_count).toBe(1);

        const reopened = await request(app)
            .get(`/api/admin/audit-reports/y-archives/${printed.body.archive_id}/print-payload`)
            .set('Cookie', adminCookie);
        expect(reopened.statusCode).toBe(200);
        expect(reopened.body.print_payload).toEqual(printed.body.print_payload);

        const restored = await request(app)
            .post('/api/admin/audit-reports/restore-y')
            .set('Cookie', adminCookie)
            .send({ archive_id: printed.body.archive_id });

        expect(restored.statusCode).toBe(200);
        expect(restored.body.restored_count).toBe(1);
        const [[row]] = await pool.query('SELECT * FROM held_orders WHERE id = ?', [held.insertId]);
        expect(row.reference_name).toBe('Recover Y');
        expect(row.order_id).toBe(17);
        expect(row.order_seq_scope).toBe('date:2026-07-01');
        expect(Number(row.kitchen_fired)).toBe(1);
        expect(Number(row.table_id)).toBe(SEED.table.id);
        expect(row.parent_invoice_id).toBeNull();
        expect(Number(row.call_center_user_id)).toBe(70);
        expect(row.claimed_by_user_id).toBeNull();
        expect(row.claim_token_hash).toBeNull();
        expect(JSON.parse(row.cart_data)).toEqual(JSON.parse(cartData));
        const [[archive]] = await pool.query('SELECT restored_at FROM master_held WHERE id = ?', [printed.body.archive_id]);
        expect(archive.restored_at).toBeTruthy();

        const reopenedAfterRestore = await request(app)
            .get(`/api/admin/audit-reports/y-archives/${printed.body.archive_id}/print-payload`)
            .set('Cookie', adminCookie);
        expect(reopenedAfterRestore.statusCode).toBe(409);
    });

    it('does not restore an expired Y report archive', async () => {
        await seedReceiptPrinter(pool);
        const cartData = JSON.stringify({
            order_type_id: SEED.orderType.id,
            items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
        });
        const [held] = await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Expired Y', ?, 5, '2026-07-01 13:00:00')`,
            [SEED.cashierUser.id, cartData]
        );
        const snapshotId = '00000000-0000-4000-8000-000000000777';
        await pool.query(
            `INSERT INTO service_charge_snapshots
                (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
             VALUES (?, 10, 0, 'held', 'held_order', ?, ?, 1)`,
            [snapshotId, String(held.insertId), SEED.cashierUser.id]
        );
        await pool.query(
            'UPDATE held_orders SET service_charge_snapshot_id = ? WHERE id = ?',
            [snapshotId, held.insertId]
        );
        const printed = await request(app)
            .post('/api/admin/audit-reports/print-y')
            .set('Cookie', adminCookie)
            .send({ business_date: '2026-07-01' });
        await pool.query(
            'UPDATE master_held SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?',
            [printed.body.archive_id]
        );

        const reopened = await request(app)
            .get(`/api/admin/audit-reports/y-archives/${printed.body.archive_id}/print-payload`)
            .set('Cookie', adminCookie);
        expect(reopened.statusCode).toBe(410);

        const restored = await request(app)
            .post('/api/admin/audit-reports/restore-y')
            .set('Cookie', adminCookie)
            .send({ archive_id: printed.body.archive_id });

        expect(restored.statusCode).toBe(410);
        const [[heldCount]] = await pool.query("SELECT COUNT(*) AS count FROM held_orders WHERE reference_name = 'Expired Y'");
        expect(Number(heldCount.count)).toBe(0);
        const [[snapshotCount]] = await pool.query('SELECT COUNT(*) AS count FROM service_charge_snapshots WHERE id = ?', [snapshotId]);
        expect(Number(snapshotCount.count)).toBe(0);
    });

    it('keeps a service snapshot needed by a newer unexpired Y archive', async () => {
        await seedReceiptPrinter(pool);
        const [held] = await pool.query(
            `INSERT INTO held_orders
             (user_id, reference_name, cart_data, subtotal, created_at)
             VALUES (?, 'Re-archived Y', ?, 5, '2026-07-01 14:00:00')`,
            [SEED.cashierUser.id, JSON.stringify({
                order_type_id: SEED.orderType.id,
                items: [{ id: SEED.product1.id, qty: 1, price: 5, tax_rate: 16 }],
            })]
        );
        const snapshotId = '00000000-0000-4000-8000-000000000778';
        await pool.query(
            `INSERT INTO service_charge_snapshots
                (id, percentage, tax_rate, state, holder_type, holder_id, created_by, version)
             VALUES (?, 10, 0, 'held', 'held_order', ?, ?, 1)`,
            [snapshotId, String(held.insertId), SEED.cashierUser.id]
        );
        await pool.query('UPDATE held_orders SET service_charge_snapshot_id = ? WHERE id = ?', [snapshotId, held.insertId]);

        const first = await request(app).post('/api/admin/audit-reports/print-y')
            .set('Cookie', adminCookie).send({ business_date: '2026-07-01' });
        await request(app).post('/api/admin/audit-reports/restore-y')
            .set('Cookie', adminCookie).send({ archive_id: first.body.archive_id });
        const second = await request(app).post('/api/admin/audit-reports/print-y')
            .set('Cookie', adminCookie).send({ business_date: '2026-07-01' });
        await pool.query(
            'UPDATE master_held SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE id = ?',
            [first.body.archive_id]
        );

        const status = await request(app).get('/api/admin/audit-reports/y-archive-status').set('Cookie', adminCookie);
        expect(status.body.archive.id).toBe(second.body.archive_id);
        const [[snapshotCount]] = await pool.query('SELECT COUNT(*) AS count FROM service_charge_snapshots WHERE id = ?', [snapshotId]);
        expect(Number(snapshotCount.count)).toBe(1);
    });

    it('rejects invalid and missing Y archive payload ids without changing rows', async () => {
        const invalid = await request(app)
            .get('/api/admin/audit-reports/y-archives/not-a-number/print-payload')
            .set('Cookie', adminCookie);
        expect(invalid.statusCode).toBe(400);

        const missing = await request(app)
            .get('/api/admin/audit-reports/y-archives/999999/print-payload')
            .set('Cookie', adminCookie);
        expect(missing.statusCode).toBe(404);

        const [[{ archives }]] = await pool.query('SELECT COUNT(*) AS archives FROM master_held');
        expect(Number(archives)).toBe(0);
    });
});
