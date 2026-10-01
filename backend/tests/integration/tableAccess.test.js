const { currentTableRevision } = require('../fixtures/tableOrderRevision');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { invalidateUserSessions } = require('../../middleware/auth');
const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { seedLegacySharedSeats } = require('../fixtures/legacySharedSeats');

describe('table section and QR draft access', () => {
    let admin, waiter;
    const cart = [{ id: 2, qty: 2, price: 2, tax_rate: 0 }];
    const login = async number => (await request(app).post('/api/auth/login').send({ user_number: number })).headers['set-cookie'][0];
    const post = (path, body, cookie = admin) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const ok = response => { expect(response.statusCode, JSON.stringify(response.body)).toBe(200); return response.body; };
    const save = (id, cookie = admin, extra = {}) => post('table_order', { table_id: id, cart, subtotal: 4, tax: 0, total: 4, ...extra }, cookie);
    const load = (id, cookie = admin) => request(app).get(`/api/pos/table_order?order_id=${id}`).set('Cookie', cookie);
    const scope = async (value, id = 3) => {
        await pool.query("UPDATE users SET table_access_scope='selected', allowed_sections=? WHERE id=?", [value, id]);
        invalidateUserSessions(id);
    };
    const grant = async (id, keys) => {
        await pool.query('INSERT IGNORE INTO user_permissions(user_id,perm_key) VALUES ?', [keys.map(key => [id, key])]);
        invalidateUserSessions(id);
    };
    const state = async () => {
        const result = {};
        for (const name of ['restaurant_tables', 'sections', 'orders', 'order_items', 'held_orders', 'qr_table_drafts', 'table_action_operations', 'products', 'stock_movements', 'audit_events', 'service_charge_snapshots', 'print_queue', 'refunds', 'refund_items', 'recipe_ledger_lines', 'shifts', 'invoice_sequences']) {
            result[name] = (await pool.query(`SELECT * FROM ${name} ORDER BY 1`))[0];
        }
        return result;
    };
    const denied = async operation => {
        const before = await state();
        global.__mockEmit__.mockClear();
        const response = await operation();
        expect(response.statusCode, JSON.stringify(response.body)).toBe(403);
        expect(await state()).toEqual(before);
        expect(global.__mockEmit__).not.toHaveBeenCalled();
    };
    const makeSplit = async (id = 2) => {
        const saved = ok(await save(id));
        ok(await post('table_splits/split', { tableId: id, currentOrderId: saved.invoice_id,
            splits: [1, 2].map(seat => ({ referenceName: `Seat ${seat}`, subtotal: 2, items: [{ ...cart[0], qty: 1 }] })) }));
        const [rows] = await pool.query('SELECT * FROM held_orders WHERE parent_invoice_id=? ORDER BY id', [saved.invoice_id]);
        return { saved, rows };
    };
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO sections(id,name) VALUES(2,'Restricted')");
        await pool.query('UPDATE restaurant_tables SET section_id=2 WHERE id=2');
        await pool.query("INSERT INTO restaurant_tables(id,section_id,table_number) VALUES(3,1,'3'),(4,2,'4')");
        admin = await login('9001');
        waiter = await login('9003');
    });
    afterAll(async () => { await pool.end(); });

    it('rejects direct saves to a table hidden on the floor', async () => {
        const floor = ok(await request(app).get('/api/pos/get_tables').set('Cookie', waiter));
        expect(floor.tables.map(table => table.id)).toEqual([1, 3]);
        await denied(() => save(2, waiter));
    });
    it.each([null, '', '0', '1oops', '1.5'])('fails closed for a waiter section assignment %j', async sections => {
        await scope(sections);
        const floor = ok(await request(app).get('/api/pos/get_tables').set('Cookie', waiter));
        expect(floor.tables).toEqual([]);
        await denied(() => save(1, waiter));
    });
    it('accepts trimmed duplicate section IDs and retains waiter access without an explicit floor grant', async () => {
        await scope(' 1, 1, 2 ');
        await pool.query("DELETE FROM user_permissions WHERE user_id=3 AND perm_key='tables.access'");
        invalidateUserSessions(3);
        ok(await save(2, waiter));
    });
    it.each(['read', 'save', 'mark printed', 'void', 'clear', 'split', 'checkout'])('rejects an out-of-section live bill %s without side effects', async kind => {
        const saved = ok(await save(2));
        const loaded = ok(await load(saved.invoice_id));
        await grant(3, ['waiter.override_tables', 'waiter.checkout', 'pos.void_item', 'pos.void_printed_item', 'shift.open']);
        await pool.query('UPDATE orders SET waiter_id=3 WHERE invoice_id=?', [saved.invoice_id]);
        if (kind === 'checkout') ok(await request(app).post('/api/auth/shifts?action=open').set('Cookie', waiter).send({ user_id: 3, starting_cash: 20 }));
        const operations = {
            read: () => load(saved.invoice_id, waiter),
            save: () => save(2, waiter, { current_order_id: saved.invoice_id, expected_version: loaded.version, cart: loaded.cart }),
            'mark printed': () => post('table_order', { action: 'mark_printed', table_id: 2, expected_invoice_id: saved.invoice_id }, waiter),
            void: async () => post('refunds', { invoice_id: saved.invoice_id, expected_version: await currentTableRevision(saved.invoice_id), intent: 'void', items: [{ order_item_id: loaded.cart[0].order_item_id, qty: 1 }] }, waiter),
            clear: async () => post('refunds', { invoice_id: saved.invoice_id, expected_version: await currentTableRevision(saved.invoice_id), intent: 'void' }, waiter),
            split: () => post('table_splits/split', { tableId: 2, currentOrderId: saved.invoice_id, splits: [{ referenceName: 'Seat', subtotal: 4, items: loaded.cart }] }, waiter),
            checkout: () => post('checkout', { table_id: 2, edit_invoice_id: saved.invoice_id, cart: loaded.cart, subtotal: 4, tax: 0, total: 4, payment_method: 'cash', amount_tendered: 4, change_due: 0 }, waiter)
        };
        await denied(operations[kind]);
    });
    it('rejects clearing a legacy shared group containing a hidden child', async () => {
        await seedLegacySharedSeats(pool, 1, [2]);
        await denied(() => save(1, waiter, { cart: [] }));
    });
    it('rejects saving through an allowed child of a hidden root', async () => {
        await seedLegacySharedSeats(pool, 2, [1]);
        await denied(() => save(1, waiter));
    });
    it.each(['read', 'delete'])('rejects staff QR draft %s with zero cashier grants and no guest token', async verb => {
        await pool.query('DELETE FROM user_permissions WHERE user_id=2'); invalidateUserSessions(2);
        await pool.query('INSERT INTO qr_table_drafts(table_id,cart_data) VALUES(2,?)', [JSON.stringify(cart)]);
        const cashier = await login('9002');
        await denied(() => request(app)[verb === 'read' ? 'get' : 'delete']('/api/pos/table-draft/2').set('Cookie', cashier));
    });
    it.each(['get', 'delete'])('rejects an out-of-section staff QR draft %s', async verb => {
        await pool.query('INSERT INTO qr_table_drafts(table_id,cart_data) VALUES(2,?)', [JSON.stringify(cart)]);
        await denied(() => request(app)[verb]('/api/pos/table-draft/2').set('Cookie', waiter));
    });
    it('preserves the exact guest-token read path, even alongside a restricted staff cookie', async () => {
        await pool.query('INSERT INTO qr_table_drafts(table_id,cart_data) VALUES(2,?)', [JSON.stringify(cart)]);
        await pool.query("UPDATE restaurant_tables SET qr_code_token='fixture-guest-token' WHERE id=2");
        for (const cookie of [null, waiter]) {
            const query = request(app).get('/api/pos/table-draft/2?token=fixture-guest-token');
            if (cookie) query.set('Cookie', cookie);
            expect(ok(await query).cart).toEqual(cart);
        }
        expect((await request(app).get('/api/pos/table-draft/2?token=wrong')).statusCode).toBe(403);
        expect((await request(app).delete('/api/pos/table-draft/2?token=fixture-guest-token')).statusCode).toBe(401);
        expect((await pool.query('SELECT * FROM qr_table_drafts WHERE table_id=2'))[0]).toHaveLength(1);
    });
    it('allows an authorized cashier draft read and clear and respects later scope changes', async () => {
        await grant(2, ['tables.access']);
        const cashier = await login('9002');
        await pool.query('INSERT INTO qr_table_drafts(table_id,cart_data) VALUES(2,?)', [JSON.stringify(cart)]);
        expect(ok(await request(app).get('/api/pos/table-draft/2').set('Cookie', cashier)).cart).toEqual(cart);
        await scope('1', 2);
        await denied(() => request(app).delete('/api/pos/table-draft/2').set('Cookie', cashier));
        await scope('1,2', 2);
        ok(await request(app).delete('/api/pos/table-draft/2').set('Cookie', cashier));
        expect((await pool.query('SELECT * FROM qr_table_drafts'))[0]).toEqual([]);
    });
    it('deletes the QR draft only while it still has the imported hash', async () => {
        await pool.query('INSERT INTO qr_table_drafts(table_id,cart_data) VALUES(3,?)', [JSON.stringify(cart)]);
        const read = ok(await request(app).get('/api/pos/table-draft/3').set('Cookie', admin));
        expect(read.draft_hash).toMatch(/^[0-9a-f]{64}$/);
        const changed = JSON.stringify([...cart, { id: 1, qty: 1 }]);
        await pool.query('UPDATE qr_table_drafts SET cart_data=? WHERE table_id=3', [changed]);
        const conflict = await request(app).delete('/api/pos/table-draft/3').set('Cookie', admin).send({ expected_hash: read.draft_hash });
        expect(conflict.statusCode).toBe(409);
        expect(conflict.body.code).toBe('DRAFT_CHANGED');
        expect((await pool.query('SELECT * FROM qr_table_drafts WHERE table_id=3'))[0]).toHaveLength(1);
        const fresh = ok(await request(app).get('/api/pos/table-draft/3').set('Cookie', admin)).draft_hash;
        ok(await request(app).delete('/api/pos/table-draft/3').set('Cookie', admin).send({ expected_hash: fresh }));
        expect((await pool.query('SELECT * FROM qr_table_drafts WHERE table_id=3'))[0]).toEqual([]);
        // A retried dismiss whose first answer was lost finds nothing and succeeds.
        ok(await request(app).delete('/api/pos/table-draft/3').set('Cookie', admin).send({ expected_hash: fresh }));
        expect((await request(app).delete('/api/pos/table-draft/3').set('Cookie', admin).send({ expected_hash: 'nope' })).statusCode).toBe(400);
    });
    it.each(['transfer source', 'transfer target', 'swap', 'merge', 'join parent', 'join child', 'disjoin parent', 'disjoin child', 'transfer hidden group'])('checks every affected section for %s', async kind => {
        await grant(3, ['waiter.transfer_table', 'waiter.merge_tables', 'waiter.override_tables']);
        if (kind.startsWith('disjoin')) {
            const parent = kind.endsWith('parent') ? 2 : 1, child = parent === 1 ? 2 : 1;
            ok(await post('tables/join', { parentTableId: parent, childTableIds: [child] }));
            await denied(() => post('tables/disjoin', { tableIds: [child] }, waiter));
        } else if (kind.startsWith('join')) {
            const parent = kind.endsWith('parent') ? 2 : 1;
            await denied(() => post('tables/join', { parentTableId: parent, childTableIds: [parent === 1 ? 2 : 1] }, waiter));
        } else {
            const source = kind === 'transfer source' ? 2 : 1;
            const target = kind === 'transfer hidden group' ? 3 : (source === 1 ? 2 : 1);
            ok(await save(source));
            if (['swap', 'merge'].includes(kind)) ok(await save(target));
            if (kind === 'transfer hidden group') await seedLegacySharedSeats(pool, 1, [2]);
            const payload = await tableActionIntent(pool, { sourceTableId: source, targetTableId: target, action: ['swap', 'merge'].includes(kind) ? kind : 'transfer' });
            await denied(() => post('tables/transfer', payload, waiter));
        }
    });
    it('keeps transfer ownership policy and committed recovery after the actor section changes', async () => {
        const saved = ok(await save(1));
        await grant(3, ['waiter.transfer_table']);
        const payload = await tableActionIntent(pool, { sourceTableId: 1, targetTableId: 3, action: 'transfer' });
        const moved = ok(await post('tables/transfer', payload, waiter));
        await scope('2');
        const before = await state(); global.__mockEmit__.mockClear();
        expect(ok(await request(app).get(`/api/pos/tables/transfer/${payload.operation_id}`).set('Cookie', waiter)).result.operation_id).toBe(payload.operation_id);
        expect(ok(await post('tables/transfer', payload, waiter))).toEqual(moved);
        expect(await state()).toEqual(before); expect(global.__mockEmit__).not.toHaveBeenCalled();
        expect((await pool.query('SELECT current_order_id FROM restaurant_tables WHERE id=3'))[0][0].current_order_id).toBe(saved.invoice_id);
    });
    it('filters the split board before loading presentations', async () => {
        const visible = await makeSplit(1); await makeSplit(2);
        const list = ok(await request(app).get('/api/pos/table_splits').set('Cookie', waiter));
        expect(list.data.map(row => row.parent_invoice_id)).toEqual([visible.saved.invoice_id, visible.saved.invoice_id]);
    });
    it('hides a split group whose visible parent has a hidden child', async () => {
        await seedLegacySharedSeats(pool, 1, [2]);
        await makeSplit(1);
        expect(ok(await request(app).get('/api/pos/table_splits').set('Cookie', waiter)).data).toEqual([]);
    });
    it('rejects a legacy split reference to a hidden table', async () => {
        const { rows } = await makeSplit();
        await pool.query('UPDATE held_orders SET cart_data=? WHERE id=?', [JSON.stringify({ items: cart }), rows[0].id]);
        await denied(() => request(app).delete(`/api/pos/table_splits?id=${rows[0].id}`).set('Cookie', waiter));
    });
    it.each([false, true])('checks dynamically resolved table sections (existing section=%s)', async exists => {
        await pool.query("UPDATE settings SET setting_value='dynamic' WHERE setting_key='table_mode'");
        if (exists) await pool.query("INSERT INTO sections(id,name) VALUES(5,'Dynamic')");
        await denied(() => post('table_order', { table_number: '50', cart, subtotal: 4, tax: 0, total: 4 }, waiter));
        if (!exists) await pool.query("INSERT INTO sections(id,name) VALUES(5,'Dynamic')");
        await scope('1,5');
        ok(await post('table_order', { table_number: '50', cart, subtotal: 4, tax: 0, total: 4 }, waiter));
    });
    it('does not turn a manager-authorized join into a lasting section or role override', async () => {
        ok(await post('tables/join', { parentTableId: 1, childTableIds: [3], managerPin: '1234' }, waiter));
        const floor = ok(await request(app).get('/api/pos/get_tables').set('Cookie', waiter));
        expect(floor.tables.map(table => table.id)).toEqual([1, 3]);
        expect(floor.permissions.can_join_tables).toBe(false);
        const response = await post('tables/join', { parentTableId: 1, childTableIds: [2], managerPin: '1234' }, waiter);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(403);
        expect((await pool.query('SELECT parent_table_id FROM restaurant_tables WHERE id=2'))[0][0].parent_table_id).toBeNull();
    });

    it('scopes manager-authorized separation to this action and the employee sections', async () => {
        ok(await post('tables/join', { parentTableId: 1, childTableIds: [3] }));
        ok(await post('tables/join', { parentTableId: 2, childTableIds: [4] }));
        ok(await post('tables/disjoin', { tableIds: [3], managerPin: '1234' }, waiter));
        const floor = ok(await request(app).get('/api/pos/get_tables').set('Cookie', waiter));
        expect(floor.permissions.can_join_tables).toBe(false);
        const before = (await pool.query('SELECT * FROM restaurant_tables ORDER BY id'))[0];
        expect((await post('tables/disjoin', { tableIds: [4], managerPin: '1234' }, waiter)).statusCode).toBe(403);
        expect((await pool.query('SELECT * FROM restaurant_tables ORDER BY id'))[0]).toEqual(before);
        const me = ok(await request(app).get('/api/auth/me').set('Cookie', waiter));
        expect(me.user.role).toBe('waiter');
        expect(me.user.allowed_sections).toBe('1');
    });
    it.each(['delete', 'rewrite', 'checkout'])('rejects out-of-section split %s', async kind => {
        const { rows } = await makeSplit();
        await grant(3, ['waiter.checkout', 'shift.open']);
        if (kind === 'checkout') ok(await request(app).post('/api/auth/shifts?action=open').set('Cookie', waiter).send({ user_id: 3, starting_cash: 20 }));
        const payload = JSON.parse(rows[0].cart_data);
        const operations = {
            delete: () => request(app).delete(`/api/pos/table_splits?id=${rows[0].id}`).set('Cookie', waiter),
            rewrite: () => request(app).put('/api/pos/table_splits').set('Cookie', waiter).send({ splitId: rows[0].id,
                expectedChecks: rows.map(row => ({ id: row.id, revision: JSON.parse(row.cart_data).split_revision || 1 })),
                splits: [{ referenceName: 'Combined', items: cart }] }),
            checkout: () => post('checkout', { ...payload, split_check_id: rows[0].id, table_id: 2, cart: payload.items, subtotal: 2, tax: 0, total: 2, payment_method: 'cash', amount_tendered: 2, change_due: 0 }, waiter)
        };
        await denied(operations[kind]);
    });
    it('retains the broader split-board management grant inside the assigned section', async () => {
        const { rows } = await makeSplit(1);
        ok(await request(app).delete(`/api/pos/table_splits?id=${rows[0].id}`).set('Cookie', waiter));
        expect((await pool.query('SELECT id FROM held_orders'))[0]).toEqual([]);
    });
    it.each(['receipt', 'kitchen', 'guest', 'held'])('rejects out-of-section %s printing before queueing', async kind => {
        await pool.query("INSERT INTO printers(name,role,type,windows_name,is_active) VALUES('Access fixture','receipt','windows','Not-installed-F5',1)");
        await grant(3, ['pos.reprint_receipt', 'waiter.checkout', 'waiter.override_tables']);
        let saved, rows;
        if (kind === 'held') ({ saved, rows } = await makeSplit()); else saved = ok(await save(2));
        const body = kind === 'guest'
            ? { print_type: 'receipt', invoice_id: 'GUEST CHECK', source_invoice_id: saved.invoice_id, provisional: true, table_number: '2', items: cart }
            : { print_type: kind === 'kitchen' ? 'kitchen' : 'receipt', invoice_id: kind === 'held' ? rows[0].id : saved.invoice_id, ...(kind === 'held' ? { payment_method: 'held' } : {}) };
        await denied(() => request(app).post('/api/print/print').set('Cookie', waiter).send(body));
    });
});
