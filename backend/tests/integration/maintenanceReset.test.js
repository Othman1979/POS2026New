const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { loginSeedUser } = require('../helpers/auth');
const { insertShift, insertPaidOrder, insertOrderItem } = require('../helpers/fixtures');
const cache = require('../../config/cache');
const {
    getLatestFailedPrintJobsCount,
    refreshFailedPrintJobsCount,
    resetLatestFailedPrintJobsCount
} = require('../../services/printQueueWatchdog');

describe('admin operational data reset', () => {
    const testPassword = 'integration-reset-secret';
    const originalPasswordHash = process.env.MAINTENANCE_RESET_PASSWORD_HASH;
    let adminCookie;
    let cashierCookie;

    beforeEach(async () => {
        process.env.MAINTENANCE_RESET_PASSWORD_HASH = crypto
            .createHash('sha256')
            .update(testPassword)
            .digest('hex');
        await seedDatabase();
        adminCookie = await loginSeedUser(request, app, 'adminUser');
        cashierCookie = await loginSeedUser(request, app, 'cashierUser');

        const shiftId = await insertShift(pool);
        const invoiceId = await insertPaidOrder(pool, { shift_id: shiftId });
        await insertOrderItem(pool, { invoice_id: invoiceId });
        await pool.query(
            'INSERT INTO held_orders (user_id, reference_name, cart_data, subtotal) VALUES (?, ?, ?, ?)',
            [SEED.cashierUser.id, 'Reset fixture', '[]', 5]
        );
        await pool.query(`
            INSERT INTO order_intake_requests
                (client_id,external_request_id,request_hash,held_order_id,result_json)
            VALUES ('reset-test','reset-request-0001',REPEAT('a',64),1,'{"id":1}')
        `);
        await pool.query(
            `INSERT INTO jofotara_documents
             (source_key, order_invoice_id, document_kind, document_number, document_uuid, status)
             VALUES (?, ?, 'invoice', ?, ?, 'pending')`,
            ['reset-fixture', invoiceId, 'RESET-1', '00000000-0000-4000-8000-000000000001']
        );
        await pool.query('INSERT INTO invoice_sequences (sequence_name, current_value) VALUES (?, ?)', ['invoice', 10]);
        await pool.query('INSERT INTO daily_sequences (sequence_date, current_value) VALUES (?, ?)', ['2026-08-05', 10]);
        await pool.query(
            "UPDATE restaurant_tables SET current_order_id = ?, status = 'occupied' WHERE id = ?",
            [invoiceId, SEED.table.id]
        );
    });

    afterAll(async () => {
        if (originalPasswordHash === undefined) delete process.env.MAINTENANCE_RESET_PASSWORD_HASH;
        else process.env.MAINTENANCE_RESET_PASSWORD_HASH = originalPasswordHash;
        await pool.end();
    });

    it('rejects an invalid password without deleting operational data', async () => {
        const response = await request(app)
            .post('/api/admin/maintenance/reset-operational-data')
            .set('Cookie', adminCookie)
            .send({ password: 'wrong-password' });

        expect(response.statusCode).toBe(403);
        const [[counts]] = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM orders) AS orders_count,
                (SELECT COUNT(*) FROM held_orders) AS held_count
        `);
        expect(Number(counts.orders_count)).toBe(1);
        expect(Number(counts.held_count)).toBe(1);
    });

    it('does not allow a cashier to reset data even with the maintenance password', async () => {
        const response = await request(app)
            .post('/api/admin/maintenance/reset-operational-data')
            .set('Cookie', cashierCookie)
            .send({ password: testPassword });

        expect(response.statusCode).toBe(403);
        const [[counts]] = await pool.query('SELECT COUNT(*) AS orders_count FROM orders');
        expect(Number(counts.orders_count)).toBe(1);
    });

    it('preserves source invoices when product stock authority has been activated', async () => {
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='stock_enabled'");
        await pool.query('UPDATE products SET stock=10 WHERE id=?', [SEED.product2.id]);
        const activated = await request(app).post(`/api/admin/stock/products/${SEED.product2.id}/activate`)
            .set('Cookie', adminCookie).send({ expected_stock_version: '0', request_key: crypto.randomUUID() });
        expect(activated.status, JSON.stringify(activated.body)).toBe(200);
        const response = await request(app).post('/api/admin/maintenance/reset-operational-data')
            .set('Cookie', adminCookie).send({ password: testPassword });
        expect(response.status).toBe(409);
        expect((await pool.query('SELECT invoice_id FROM orders'))[0]).toHaveLength(1);
        expect((await pool.query('SELECT id FROM held_orders'))[0]).toHaveLength(1);
        expect((await pool.query('SELECT id FROM stock_movements'))[0]).toHaveLength(1);
        expect((await pool.query("SELECT id FROM audit_events WHERE event_type='operational_data_reset'"))[0]).toHaveLength(0);
    });

    it('refreshes the failed print count cache and wakes the watchdog after the reset commits', async () => {
        const original = app.get('printQueueWatchdog');
        const calls = [];
        const wake = vi.fn(() => calls.push('wake'));
        const refreshStale = vi.fn(async () => { calls.push('refreshStale'); });
        app.set('printQueueWatchdog', { wake, refreshStale });
        // the badge count cached and published before print_queue is emptied
        await refreshFailedPrintJobsCount({ query: async () => [[{ count: 3 }]] }, () => {});
        global.__mockEmit__.mockClear();
        try {
            const response = await request(app)
                .post('/api/admin/maintenance/reset-operational-data')
                .set('Cookie', adminCookie)
                .send({ password: testPassword });
            expect(response.statusCode).toBe(200);
            expect(getLatestFailedPrintJobsCount()).toBe(0);
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'failed_print_jobs_count'))
                .toEqual([['failed_print_jobs_count', 0]]);
            expect(wake).toHaveBeenCalledTimes(1);
            expect(refreshStale).toHaveBeenCalledTimes(1); // stale-station cache refreshed before the response
        } finally {
            app.set('printQueueWatchdog', original);
            resetLatestFailedPrintJobsCount();
        }
    });

    it('a failing stale-station refresh does not skip the failed count refresh', async () => {
        const original = app.get('printQueueWatchdog');
        app.set('printQueueWatchdog', { wake: vi.fn(), refreshStale: async () => { throw new Error('stale query down'); } });
        await refreshFailedPrintJobsCount({ query: async () => [[{ count: 3 }]] }, () => {});
        global.__mockEmit__.mockClear();
        try {
            const response = await request(app)
                .post('/api/admin/maintenance/reset-operational-data')
                .set('Cookie', adminCookie)
                .send({ password: testPassword });
            expect(response.statusCode).toBe(200);
            expect(global.__mockEmit__.mock.calls.filter(([event]) => event === 'failed_print_jobs_count'))
                .toEqual([['failed_print_jobs_count', 0]]);
        } finally {
            app.set('printQueueWatchdog', original);
            resetLatestFailedPrintJobsCount();
        }
    });

    it('clears operational data while preserving the restaurant setup', async () => {
        await pool.query("INSERT INTO daily_order_type_sequences VALUES('2026-09-12',1,1,4)");
        const [[before]] = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM products) AS products_count,
                (SELECT COUNT(*) FROM categories) AS categories_count,
                (SELECT COUNT(*) FROM users) AS users_count
        `);

        const response = await request(app)
            .post('/api/admin/maintenance/reset-operational-data')
            .set('Cookie', adminCookie)
            .send({ password: testPassword });

        expect(response.statusCode).toBe(200);
        expect(response.body.success).toBe(true);

        const [[after]] = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM orders) AS orders_count,
                (SELECT COUNT(*) FROM order_items) AS items_count,
                (SELECT COUNT(*) FROM held_orders) AS held_count,
                (SELECT COUNT(*) FROM shifts) AS shifts_count,
                (SELECT COUNT(*) FROM jofotara_documents) AS jofotara_count,
                (SELECT COUNT(*) FROM invoice_sequences) AS invoice_sequences_count,
                (SELECT COUNT(*) FROM daily_sequences) AS daily_sequences_count,
                (SELECT COUNT(*) FROM daily_order_type_sequences) AS type_sequences_count,
                (SELECT COUNT(*) FROM products) AS products_count,
                (SELECT COUNT(*) FROM categories) AS categories_count,
                (SELECT COUNT(*) FROM users) AS users_count,
                (SELECT COUNT(*) FROM order_intake_requests) AS intake_requests_count,
                (SELECT COUNT(*) FROM audit_events WHERE event_type = 'operational_data_reset') AS audit_count
        `);

        expect(Number(after.orders_count)).toBe(0);
        expect(Number(after.items_count)).toBe(0);
        expect(Number(after.held_count)).toBe(0);
        expect(Number(after.shifts_count)).toBe(0);
        expect(Number(after.jofotara_count)).toBe(0);
        expect(Number(after.invoice_sequences_count)).toBe(0);
        expect(Number(after.daily_sequences_count)).toBe(0);
        expect(Number(after.type_sequences_count)).toBe(0);
        expect(Number(after.products_count)).toBe(Number(before.products_count));
        expect(Number(after.categories_count)).toBe(Number(before.categories_count));
        expect(Number(after.users_count)).toBe(Number(before.users_count));
        expect(Number(after.intake_requests_count)).toBe(1);
        expect(Number(after.audit_count)).toBe(1);

        const [[table]] = await pool.query(
            'SELECT status, current_order_id FROM restaurant_tables WHERE id = ?',
            [SEED.table.id]
        );
        expect(table.status).toBe('available');
        expect(table.current_order_id).toBeNull();
    });

    it('rejects reset while ingredient history must retain its source records', async () => {
        const [ingredient] = await pool.query(`
            INSERT INTO ingredients
              (name, measure, display_unit, unit_cost, is_active)
            VALUES ('_reset_chicken', 'weight', 'kg', 0.0045, 1)
        `);
        await pool.query(
            'INSERT INTO product_recipe_lines (product_id, ingredient_id, qty_per_unit, sort_order) VALUES (?, ?, 200, 0)',
            [SEED.product1.id, ingredient.insertId]
        );
        await pool.query("\n            INSERT INTO stock_movements(movement_type,ingredient_id, kind, qty, source_type, business_date, client_key)\n            VALUES ('ingredient',?, 'receipt', 10000, 'manual', '2026-09-05', 'reset-ledger-receipt')\n        ", [ingredient.insertId]);

        const response = await request(app)
            .post('/api/admin/maintenance/reset-operational-data')
            .set('Cookie', adminCookie)
            .send({ password: testPassword });

        expect(response.statusCode).toBe(409);
        const [[counts]] = await pool.query("\n            SELECT\n                (SELECT COUNT(*) FROM ingredients WHERE id = ?) AS ingredients_count,\n                (SELECT COUNT(*) FROM product_recipe_lines WHERE product_id = ?) AS recipe_lines_count,\n                (SELECT COUNT(*) FROM stock_movements WHERE movement_type='ingredient' AND client_key = 'reset-ledger-receipt') AS movements_count\n        ", [ingredient.insertId, SEED.product1.id]);
        expect(Number(counts.ingredients_count)).toBe(1);
        expect(Number(counts.recipe_lines_count)).toBe(1);
        expect(Number(counts.movements_count)).toBe(1);
    });

    it.each(['drawer expense', 'outside expense', 'platform reversal'])(
        'resets a database containing %s without violating constraints', async (scenario) => {
            const [[shift]] = await pool.query('SELECT id FROM shifts LIMIT 1');
            if (scenario.endsWith('expense')) {
                const [category] = await pool.query("INSERT INTO expense_categories (name) VALUES ('Reset category')");
                await pool.query(`INSERT INTO expenses (category_id, amount, source, shift_id, created_by)
                    VALUES (?, 0, ?, ?, ?)`, [category.insertId, scenario.startsWith('drawer') ? 'drawer' : 'outside',
                    scenario.startsWith('drawer') ? shift.id : null, SEED.adminUser.id]);
            } else if (scenario === 'platform reversal') {
                const [original] = await pool.query(`INSERT INTO platform_remittances
                    (order_type_id, provider_name_at_entry, settled_on, net_received, recorded_by, idempotency_key)
                    VALUES (?, 'Test provider', CURRENT_DATE, 10, ?, 'reset-original')`, [SEED.orderType.id, SEED.adminUser.id]);
                await pool.query(`INSERT INTO platform_remittances
                    (order_type_id, provider_name_at_entry, kind, settled_on, net_received, recorded_by,
                     idempotency_key, reverses_remittance_id, reason)
                    VALUES (?, 'Test provider', 'reversal', CURRENT_DATE, 10, ?, 'reset-reversal', ?, 'Correction')`,
                [SEED.orderType.id, SEED.adminUser.id, original.insertId]);
            }
            const response = await request(app).post('/api/admin/maintenance/reset-operational-data')
                .set('Cookie', adminCookie).send({ password: testPassword });
            expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
            for (const table of ['expenses', 'platform_remittances', 'shifts', 'orders']) {
                const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
                expect(Number(row.count), table).toBe(0);
            }
            if (scenario.endsWith('expense')) {
                const [[row]] = await pool.query("SELECT COUNT(*) AS count FROM expense_categories WHERE name = 'Reset category'");
                expect(Number(row.count)).toBe(1);
            }
        }
    );

    it('clears last printed with the print jobs it was derived from', async () => {
        const [created] = await pool.query(`INSERT INTO printers (name, role, type, windows_name, spooler_id, last_printed_at)
            VALUES ('Reset stamp', 'kitchen', 'windows', 'W-reset-stamp', 'reset-stamp', '2026-05-01 10:00:00')`);
        const printer = { id: created.insertId };
        const response = await request(app).post('/api/admin/maintenance/reset-operational-data')
            .set('Cookie', adminCookie).send({ password: testPassword });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const [[row]] = await pool.query('SELECT last_printed_at FROM printers WHERE id = ?', [printer.id]);
        expect(row.last_printed_at).toBeNull();
    });

    it('waits for a sync holding a station row instead of deleting the queue under it', async () => {
        await pool.query("INSERT INTO spooler_stations (spooler_id, delivery_protocol) VALUES ('reset-lock', 'v2') ON DUPLICATE KEY UPDATE delivery_protocol = 'v2'");
        const [job] = await pool.query("INSERT INTO print_queue (payload, status) VALUES ('{}', 'acknowledged')");
        const sync = await pool.getConnection();
        let response;
        try {
            await sync.beginTransaction();
            await sync.query("SELECT spooler_id FROM spooler_stations WHERE spooler_id = 'reset-lock' FOR UPDATE");
            response = request(app).post('/api/admin/maintenance/reset-operational-data')
                .set('Cookie', adminCookie).send({ password: testPassword }).then(value => value);
            await new Promise(resolve => setTimeout(resolve, 600));
            const [[held]] = await pool.query('SELECT COUNT(*) AS n FROM print_queue WHERE id = ?', [job.insertId]);
            expect(held.n, 'reset must wait for the station lock').toBe(1);
        } finally {
            await sync.commit();
            sync.release();
        }
        const done = await response;
        expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
        const [[gone]] = await pool.query('SELECT COUNT(*) AS n FROM print_queue WHERE id = ?', [job.insertId]);
        expect(gone.n).toBe(0);
    });

    it('clears recovery snapshots and print jobs, preserves setup and never reuses queue IDs', async () => {
        await pool.query("INSERT INTO spooler_stations (spooler_id, delivery_protocol) VALUES ('reset-station', 'v2')");
        await pool.query(`INSERT INTO spooler_agents (agent_id, spooler_id, token_hash, status)
            VALUES (?, 'reset-station', ?, 'active')`, [crypto.randomUUID(), '0'.repeat(64)]);
        await pool.query(`INSERT INTO audit_report_documents
            (report_type, serial_no, serial_label, business_date, business_start_at, business_end_at,
             payload_json, payload_hash, issued_by_user_id)
            VALUES ('x_audit', 1, 'X-1', CURRENT_DATE, NOW(), NOW(), '{}', ?, ?)`, ['0'.repeat(64), SEED.adminUser.id]);
        await pool.query("INSERT INTO qr_table_drafts (table_id, cart_data) VALUES (?, '[]')", [SEED.table.id]);
        await pool.query(`INSERT INTO master_held
            (business_start_at, business_end_at, report_payload, held_orders_payload, expires_at)
            VALUES (NOW(), NOW(), '{}', '[]', DATE_ADD(NOW(), INTERVAL 1 DAY))`);
        const parent = crypto.randomUUID();
        await pool.query(`INSERT INTO service_charge_snapshots (id, percentage, tax_rate, state, created_by)
            VALUES (?, 10, 0, 'finalized', ?)`, [parent, SEED.adminUser.id]);
        await pool.query(`INSERT INTO service_charge_snapshots (id, percentage, tax_rate, state, created_by, parent_snapshot_id)
            VALUES (?, 10, 0, 'draft', ?, ?)`, [crypto.randomUUID(), SEED.adminUser.id, parent]);
        const [job] = await pool.query("INSERT INTO print_queue (payload, status) VALUES ('{}', 'acknowledged')");
        await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('y_order_type_id', '1') ON DUPLICATE KEY UPDATE setting_value = '1'");
        const retainedTables = ['users', 'user_permissions', 'customers', 'products', 'categories', 'settings',
            'auth_sessions', 'webauthn_credentials', 'webauthn_recovery_codes', 'spooler_agents', 'spooler_stations',
            'printers', 'print_templates', 'print_template_revisions', 'schema_migrations'];
        const before = {};
        for (const table of retainedTables) [before[table]] = await pool.query(`SELECT * FROM ${table}`);
        cache.setCachedCatalog({ stale: true }, 'stale');
        const response = await request(app).post('/api/admin/maintenance/reset-operational-data')
            .set('Cookie', adminCookie).send({ password: testPassword });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(cache.getCachedCatalog()).toBeNull();
        expect(global.__mockEmit__).toHaveBeenCalledWith('inventory_changed');
        for (const table of ['master_held', 'service_charge_snapshots', 'print_queue', 'audit_report_documents', 'qr_table_drafts']) {
            const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
            expect(Number(row.count), table).toBe(0);
        }
        // Authentication may update last_seen_at while serving the request.
        for (const table of retainedTables.filter(name => name !== 'auth_sessions')) {
            const [after] = await pool.query(`SELECT * FROM ${table}`);
            expect(after, table).toEqual(before[table]);
        }
        const [sessions] = await pool.query('SELECT id FROM auth_sessions');
        expect(sessions.map(row => row.id).sort()).toEqual(before.auth_sessions.map(row => row.id).sort());
        const [next] = await pool.query("INSERT INTO print_queue (payload) VALUES ('{}')");
        expect(next.insertId).toBeGreaterThan(job.insertId);
    });

    it('rolls back a late failure without clearing cached state or announcing success', async () => {
        const conn = await pool.getConnection();
        const query = conn.query.bind(conn);
        const spy = vi.spyOn(pool, 'getConnection').mockResolvedValueOnce(conn);
        conn.query = (...args) => {
            if (String(args[0]).includes('INSERT INTO audit_events')) throw new Error('Injected audit failure');
            return query(...args);
        };
        cache.setCachedCatalog({ retained: true }, 'retained');
        try {
            const response = await request(app).post('/api/admin/maintenance/reset-operational-data')
                .set('Cookie', adminCookie).send({ password: testPassword });
            expect(response.statusCode).toBe(500);
            const [[orders]] = await pool.query('SELECT COUNT(*) AS count FROM orders');
            const [[shifts]] = await pool.query('SELECT COUNT(*) AS count FROM shifts');
            expect(Number(orders.count)).toBe(1);
            expect(Number(shifts.count)).toBe(1);
            expect(cache.getCachedCatalog()).toEqual({ retained: true });
            expect(global.__mockEmit__).not.toHaveBeenCalledWith('inventory_changed');
        } finally {
            conn.query = query;
            spy.mockRestore();
            cache.invalidateCatalogCache();
        }
    });
});
