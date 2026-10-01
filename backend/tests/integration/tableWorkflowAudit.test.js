const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { seedLegacySharedSeats } = require('../fixtures/legacySharedSeats');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { invalidateUserSessions } = require('../../middleware/auth');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('table workflow audit regressions', () => {
    let cookie;
    const cart = [{ id: SEED.product2.id, qty: 2, price: 2, tax_rate: 0 }];
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const save = (tableId = SEED.table.id) => post('table_order', {
        table_id: tableId, cart, subtotal: 4, tax: 0, total: 4
    });
    const updates = () => global.__mockEmit__.mock.calls
        .filter(([name, payload]) => name === 'table_update' && payload?.table)
        .map(([, payload]) => payload.table);

    beforeEach(async () => {
        if (process.env.POSAPP_REVIEW_CONNECTION_LIMIT) {
            expect(pool.pool.config.connectionLimit).toBe(Number(process.env.POSAPP_REVIEW_CONNECTION_LIMIT));
        }
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        cookie = login.headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it.each([0, 1])('reads split audit policy once and preserves its existing behavior (xyz=%s)', async xyz => {
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        await pool.query('UPDATE users SET xyz=? WHERE id=?', [xyz, SEED.adminUser.id]);
        const getConnection = pool.getConnection.bind(pool);
        let policyReads = 0;
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await getConnection();
            const query = conn.query.bind(conn);
            conn.query = (sql, ...args) => {
                if (/SELECT COALESCE\(MAX\(xyz\)/.test(String(sql))) policyReads++;
                return query(sql, ...args);
            };
            return conn;
        });
        try {
            const split = await post('table_splits/split', {
                tableId: SEED.table.id, currentOrderId: saved.body.invoice_id,
                splits: [1, 2].map(seat => ({ referenceName: `Seat ${seat}`, subtotal: 2, items: [{ ...cart[0], qty: 1 }] }))
            });
            expect(split.statusCode, JSON.stringify(split.body)).toBe(200);
        } finally { spy.mockRestore(); }
        const [held] = await pool.query('SELECT id,subtotal FROM held_orders WHERE parent_invoice_id=? ORDER BY id', [saved.body.invoice_id]);
        expect(held.map(row => Number(row.subtotal))).toEqual([2, 2]);
        const [events] = await pool.query("SELECT event_type,user_id,entity_id,new_value FROM audit_events WHERE event_type IN ('split_check_created','split_check_opened') ORDER BY id");
        if (xyz) expect(events).toEqual([]);
        else {
            expect(events.map(row => row.event_type)).toEqual(['split_check_created', 'split_check_created', 'split_check_opened']);
            expect(events.map(row => row.user_id)).toEqual([SEED.adminUser.id, SEED.adminUser.id, SEED.adminUser.id]);
            expect(events.map(row => row.entity_id)).toEqual([...held.map(row => row.id), saved.body.invoice_id]);
            expect(events.map(row => JSON.parse(row.new_value))).toEqual([
                { parent_invoice_id: saved.body.invoice_id, bundle_snapshot_version: 1 },
                { parent_invoice_id: saved.body.invoice_id, bundle_snapshot_version: 1 },
                { split_count: 2, table_id: SEED.table.id }
            ]);
        }
        expect(policyReads).toBe(1);
    });

    it('rolls back every new split and its provenance when an audit insert fails', async () => {
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        const [[before]] = await pool.query('SELECT * FROM orders WHERE invoice_id=?', [saved.body.invoice_id]);
        const getConnection = pool.getConnection.bind(pool);
        let auditInserts = 0;
        const spy = vi.spyOn(pool, 'getConnection').mockImplementation(async () => {
            const conn = await getConnection();
            const query = conn.query.bind(conn);
            conn.query = (sql, ...args) => {
                if (/INSERT INTO audit_events/.test(String(sql)) && ++auditInserts === 1) throw new Error('Injected audit batch failure');
                return query(sql, ...args);
            };
            return conn;
        });
        let split;
        try {
            split = await post('table_splits/split', {
                tableId: SEED.table.id, currentOrderId: saved.body.invoice_id,
                splits: [1, 2].map(seat => ({ referenceName: `Seat ${seat}`, subtotal: 2, items: [{ ...cart[0], qty: 1 }] }))
            });
        } finally { spy.mockRestore(); }
        expect(split.statusCode).toBeGreaterThanOrEqual(400);
        expect(auditInserts).toBe(1);
        const [held] = await pool.query('SELECT id FROM held_orders WHERE parent_invoice_id=?', [saved.body.invoice_id]);
        expect(held).toEqual([]);
        const [events] = await pool.query("SELECT id FROM audit_events WHERE event_type IN ('split_check_created','split_check_opened')");
        expect(events).toEqual([]);
        const [[after]] = await pool.query('SELECT * FROM orders WHERE invoice_id=?', [saved.body.invoice_id]);
        expect(after).toEqual(before);
    });

    it('returns the selected waiter grants on the floor plan', async () => {
        const grants = ['waiter.edit_locked', 'waiter.transfer_table', 'waiter.merge_tables', 'waiter.override_tables', 'waiter.checkout'];
        await pool.query('DELETE FROM user_permissions WHERE user_id=?', [SEED.waiterUser.id]);
        await pool.query('INSERT INTO user_permissions (user_id,perm_key) VALUES ?', [grants.map(key => [SEED.waiterUser.id, key])]);
        invalidateUserSessions(SEED.waiterUser.id);
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        const response = await request(app).get('/api/pos/get_tables').set('Cookie', login.headers['set-cookie'][0]);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.permissions).toEqual({
            can_update_table: true, can_transfer_table: true, can_join_tables: true,
            can_override_tables: true, can_checkout_table: true
        });
    });

    it('deduplicates new table numbers within one bulk request', async () => {
        const response = await post('table_manager', {
            action: 'bulk_add_tables', section_id: SEED.section.id, tables: ['Audit 50', 'Audit 50', ' audit 50 ']
        });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect(response.body.count).toBe(1);
        const [[result]] = await pool.query('SELECT COUNT(*) count FROM restaurant_tables WHERE table_number=?', ['Audit 50']);
        expect(Number(result.count)).toBe(1);
    });

    it('does not let an operator without table-edit rights clear an empty joined group', async () => {
        expect((await post('tables/join', { parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] })).statusCode).toBe(200);
        await pool.query('DELETE FROM user_permissions WHERE user_id=?', [SEED.waiterUser.id]);
        invalidateUserSessions(SEED.waiterUser.id);
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.waiterUser.user_number });
        const response = await request(app).post('/api/pos/table_order').set('Cookie', login.headers['set-cookie'][0])
            .send({ table_id: SEED.table.id, cart: [] });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(403);
        const [[child]] = await pool.query('SELECT seating_parent_id FROM restaurant_tables WHERE id=?', [SEED.table2.id]);
        expect(child.seating_parent_id).toBe(SEED.table.id);
    });

    it.each(['join', 'disjoin'])('preserves open split bills when a terminal changes seating with %s', async action => {
        expect((await post('tables/join', { parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] })).statusCode).toBe(200);
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        expect((await post('table_splits/split', {
            tableId: SEED.table.id, currentOrderId: saved.body.invoice_id,
            splits: [{ referenceName: 'Seat 1', subtotal: 4, items: cart }]
        })).statusCode).toBe(200);
        const before = (await pool.query('SELECT * FROM held_orders ORDER BY id'))[0];
        const response = await post(`tables/${action}`, action === 'join'
            ? { parentTableId: SEED.table.id, childTableIds: [SEED.table2.id] }
            : { tableIds: [SEED.table2.id] });
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        expect((await pool.query('SELECT * FROM held_orders ORDER BY id'))[0]).toEqual(before);
        const [[child]] = await pool.query('SELECT parent_table_id,current_order_id,seating_parent_id FROM restaurant_tables WHERE id=?', [SEED.table2.id]);
        expect(child).toEqual({ parent_table_id: null, current_order_id: null, seating_parent_id: action === 'join' ? SEED.table.id : null });
    });

    it.each(['transfer', 'swap', 'merge'])('%s broadcasts both groups through one pooled read', async action => {
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        if (action !== 'transfer') expect((await save(SEED.table2.id)).statusCode).toBe(200);
        const intent = await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action });
        const query = pool.query;
        const reads = [];
        pool.query = function (sql, ...args) {
            if (/FROM restaurant_tables/.test(String(sql))) reads.push(String(sql));
            return query.call(this, sql, ...args);
        };
        global.__mockEmit__.mockClear();
        try {
            const response = await post('tables/transfer', intent);
            expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
            expect(reads).toHaveLength(1);
            expect(updates().map(table => Number(table.id)).sort((a, b) => a - b)).toEqual([SEED.table.id, SEED.table2.id]);
        } finally { pool.query = query; }
    });

    it('returns a committed transfer as success when the floor-plan refresh read fails', async () => {
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        const intent = await tableActionIntent(pool, { sourceTableId: SEED.table.id, targetTableId: SEED.table2.id, action: 'transfer' });
        const query = pool.query;
        pool.query = function (sql, ...args) {
            if (/FROM restaurant_tables/.test(String(sql))) return Promise.reject(new Error('Injected refresh read failure'));
            return query.call(this, sql, ...args);
        };
        let response;
        try {
            response = await post('tables/transfer', intent);
        } finally { pool.query = query; }
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const [tables] = await pool.query('SELECT id,status,current_order_id FROM restaurant_tables WHERE id IN (?,?) ORDER BY id', [SEED.table.id, SEED.table2.id]);
        expect(tables).toEqual([
            expect.objectContaining({ status: 'available', current_order_id: null }),
            expect.objectContaining({ status: 'occupied', current_order_id: saved.body.invoice_id })
        ]);
    });

    it.each([false, true])('broadcasts the same split count and remaining amount as a fresh floor-plan read (joined=%s)', async isJoined => {
        if (isJoined) {
            await seedLegacySharedSeats(pool, SEED.table.id, [SEED.table2.id]);
        }
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        const item = { ...cart[0], qty: 1 };
        global.__mockEmit__.mockClear();
        const split = await post('table_splits/split', {
            tableId: SEED.table.id, currentOrderId: saved.body.invoice_id,
            splits: [{ referenceName: 'Seat 1', subtotal: 2, items: [item] }, { referenceName: 'Seat 2', subtotal: 2, items: [item] }]
        });
        expect(split.statusCode, JSON.stringify(split.body)).toBe(200);
        for (const table of updates()) {
            expect(Number(table.active_split_count)).toBe(2);
            expect(Number(table.active_order_total)).toBe(4);
        }
        expect(updates()).toHaveLength(isJoined ? 2 : 1);
        const [[held]] = await pool.query('SELECT id FROM held_orders WHERE parent_invoice_id=? ORDER BY id LIMIT 1', [saved.body.invoice_id]);
        global.__mockEmit__.mockClear();
        const paid = await post('checkout', {
            cart: [item], subtotal: 2, tax: 0, total: 2, payment_method: 'cash', amount_tendered: 2, change_due: 0,
            split_check_id: held.id, table_id: SEED.table.id, idempotency_key: 'table-realtime-partial-split'
        });
        expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
        const floor = await request(app).get('/api/pos/get_tables').set('Cookie', cookie);
        expect(floor.statusCode).toBe(200);
        for (const live of updates()) {
            const fresh = floor.body.tables.find(table => Number(table.id) === Number(live.id));
            expect(Number(live.active_split_count)).toBe(1);
            expect(Number(live.active_order_total)).toBe(2);
            expect(live.active_split_count).toEqual(fresh.active_split_count);
            expect(live.active_order_total).toEqual(fresh.active_order_total);
        }
        expect(updates()).toHaveLength(isJoined ? 2 : 1);
    });

    it('accepts equal fractional saved quantities without floating-point grouping errors', async () => {
        const saved = await post('table_order', {
            table_id: SEED.table.id, subtotal: 0.6, tax: 0, total: 0.6,
            cart: [0.1, 0.2].map(qty => ({ id: SEED.product2.id, qty, price: 2, tax_rate: 0 }))
        });
        expect(saved.statusCode, JSON.stringify(saved.body)).toBe(200);
        const settle = qty => post('checkout', {
            cart: [{ id: SEED.product2.id, qty, price: 2, tax_rate: 0 }],
            table_id: SEED.table.id, edit_invoice_id: saved.body.invoice_id,
            subtotal: 0.6, tax: 0, total: 0.6, payment_method: 'cash', amount_tendered: 0.6, change_due: 0,
            idempotency_key: `fractional-table-${qty}`
        });
        const changed = await settle(0.300001);
        expect(changed.statusCode, JSON.stringify(changed.body)).toBe(403);
        const paid = await settle(0.3);
        expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
        const [items] = await pool.query('SELECT quantity FROM order_items WHERE invoice_id=? ORDER BY id', [saved.body.invoice_id]);
        expect(items.map(item => Number(item.quantity))).toEqual([0.1, 0.2]);
        const [[order]] = await pool.query('SELECT total,payment_method FROM orders WHERE invoice_id=?', [saved.body.invoice_id]);
        expect(order).toEqual({ total: '0.60', payment_method: 'cash' });
    });

    it.each(['create', 'rewrite', 'cancel'])('preserves successful split %s when a socket notification fails', async operation => {
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        const splitBody = {
            tableId: SEED.table.id, currentOrderId: saved.body.invoice_id,
            splits: [{ referenceName: 'Seat 1', subtotal: 4, items: cart }]
        };
        let held;
        if (operation !== 'create') {
            expect((await post('table_splits/split', splitBody)).statusCode).toBe(200);
            [[held]] = await pool.query('SELECT id,cart_data FROM held_orders WHERE parent_invoice_id=?', [saved.body.invoice_id]);
        }
        global.__mockEmit__.mockImplementation(event => {
            if (event === 'held_orders_changed') throw new Error('Injected held-list notification failure');
        });
        let response;
        try {
            if (operation === 'create') response = await post('table_splits/split', splitBody);
            else if (operation === 'rewrite') {
                const payload = JSON.parse(held.cart_data);
                response = await request(app).put('/api/pos/table_splits').set('Cookie', cookie).send({
                    splitId: held.id, expectedChecks: [{ id: held.id, revision: payload.split_revision }],
                    splits: [{ id: held.id, items: payload.items }]
                });
            } else response = await request(app).delete(`/api/pos/table_splits?id=${held.id}`).set('Cookie', cookie);
        } finally { global.__mockEmit__.mockReset(); }
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        const [remaining] = await pool.query('SELECT cart_data FROM held_orders WHERE parent_invoice_id=?', [saved.body.invoice_id]);
        expect(remaining).toHaveLength(operation === 'cancel' ? 0 : 1);
        if (operation === 'rewrite') expect(JSON.parse(remaining[0].cart_data).split_revision).toBe(2);
    });

    it('rejects stale split edits and payments after another terminal changes the revision', async () => {
        const saved = await save();
        expect(saved.statusCode).toBe(200);
        expect((await post('table_splits/split', {
            tableId: SEED.table.id, currentOrderId: saved.body.invoice_id,
            splits: [{ referenceName: 'Seat 1', subtotal: 4, items: cart }]
        })).statusCode).toBe(200);
        const [[held]] = await pool.query('SELECT id,cart_data FROM held_orders WHERE parent_invoice_id=?', [saved.body.invoice_id]);
        const payload = JSON.parse(held.cart_data);
        const edit = () => request(app).put('/api/pos/table_splits').set('Cookie', cookie).send({
            splitId: held.id, expectedChecks: [{ id: held.id, revision: payload.split_revision }],
            splits: [{ id: held.id, items: payload.items }]
        });
        expect((await edit()).statusCode).toBe(200);
        const staleEdit = await edit();
        expect(staleEdit.statusCode).toBe(409);
        expect(staleEdit.body.code).toBe('SPLIT_GROUP_CHANGED');
        const stalePayment = await post('checkout', {
            cart, subtotal: 4, tax: 0, total: 4, payment_method: 'cash', amount_tendered: 4, change_due: 0,
            split_check_id: held.id, split_revision: payload.split_revision, table_id: SEED.table.id,
            idempotency_key: 'stale-split-table-audit'
        });
        expect(stalePayment.statusCode, JSON.stringify(stalePayment.body)).toBe(409);
        const [[remaining]] = await pool.query('SELECT cart_data FROM held_orders WHERE id=?', [held.id]);
        expect(JSON.parse(remaining.cart_data).split_revision).toBe(2);
        const [[paid]] = await pool.query('SELECT COUNT(*) count FROM orders WHERE parent_invoice_id=?', [saved.body.invoice_id]);
        expect(Number(paid.count)).toBe(0);
    });

    it('manages a floor table and rotates public QR access while keeping staff draft access', async () => {
        expect((await post('table_manager', { action: 'add_section', name: 'Audit section' })).statusCode).toBe(200);
        const [[section]] = await pool.query('SELECT id FROM sections WHERE name=?', ['Audit section']);
        expect((await post('table_manager', { action: 'add_table', section_id: section.id, table_number: 'Audit table' })).statusCode).toBe(200);
        const [[table]] = await pool.query('SELECT id,qr_code_token FROM restaurant_tables WHERE section_id=?', [section.id]);
        const draft = [{ product_id: SEED.product2.id, qty: 1 }];
        await pool.query('INSERT INTO qr_table_drafts (table_id,cart_data) VALUES (?,?)', [table.id, JSON.stringify(draft)]);
        const read = token => request(app).get(`/api/pos/table-draft/${table.id}${token ? `?token=${token}` : ''}`);
        expect((await read()).statusCode).toBe(403);
        expect((await read('incorrect-token')).statusCode).toBe(403);
        expect((await read(table.qr_code_token)).body.cart).toEqual(draft);
        expect((await read().set('Cookie', cookie)).body.cart).toEqual(draft);
        const [[before]] = await pool.query('SELECT x_pos,y_pos FROM restaurant_tables WHERE id=?', [table.id]);
        expect((await post('table_manager', { action: 'update_position', id: table.id, x_pos: 25, y_pos: 40 })).statusCode).toBe(400);
        const [[position]] = await pool.query('SELECT x_pos,y_pos FROM restaurant_tables WHERE id=?', [table.id]);
        expect(position).toEqual(before);
        const rotation = await post('table_manager', { action: 'regenerate_qr_token', id: table.id });
        expect(rotation.statusCode).toBe(200);
        expect(rotation.body.qr_code_token).not.toBe(table.qr_code_token);
        expect((await read(table.qr_code_token)).statusCode).toBe(403);
        expect((await read(rotation.body.qr_code_token)).body.cart).toEqual(draft);
        expect((await request(app).delete(`/api/pos/table-draft/${table.id}`).set('Cookie', cookie)).statusCode).toBe(200);
        expect((await read(rotation.body.qr_code_token)).body.cart).toEqual([]);
        expect((await post('table_manager', { action: 'delete_table', id: table.id })).statusCode).toBe(200);
        expect((await read(rotation.body.qr_code_token)).statusCode).toBe(404);
        expect((await post('table_manager', { action: 'delete_section', id: section.id })).statusCode).toBe(200);
    });
});
