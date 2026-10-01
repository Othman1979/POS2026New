const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');
const { tableActionIntent } = require('../fixtures/tableActionIntent');
const { seedLegacySharedSeats } = require('../fixtures/legacySharedSeats');

describe('table action intent and durable recovery', () => {
    let cookie;
    const post = (path, body) => request(app).post(`/api/pos/${path}`).set('Cookie', cookie).send(body);
    const ok = response => {
        expect(response.statusCode, JSON.stringify(response.body)).toBe(200);
        return response.body;
    };
    const save = async (id = 1) => ok(await post('table_order', {
        table_id: id, cart: [{ id: 2, qty: 2, price: 2, tax_rate: 0, note: `bill ${id}` }],
        subtotal: 4, tax: 0, total: 4
    })).invoice_id;
    const intent = (source = 1, target = 2, action = 'transfer') => tableActionIntent(pool, {
        sourceTableId: source, targetTableId: target, action
    });
    const move = payload => post('tables/transfer', payload);
    const state = async () => {
        const result = {};
        for (const table of ['orders', 'order_items', 'restaurant_tables', 'audit_events', 'products', 'stock_movements', 'service_charge_snapshots', 'print_queue']) {
            result[table] = (await pool.query(`SELECT * FROM ${table}`))[0];
        }
        return result;
    };
    const unchangedConflict = async payload => {
        const before = await state();
        global.__mockEmit__.mockClear();
        const response = await move(payload);
        expect(response.statusCode, JSON.stringify(response.body)).toBe(409);
        expect(response.body.code).toBe('TABLE_ACTION_CONFLICT');
        expect(await state()).toEqual(before);
        expect(global.__mockEmit__).not.toHaveBeenCalled();
    };
    beforeEach(async () => {
        await seedDatabase();
        await pool.query("INSERT INTO restaurant_tables(id,section_id,table_number) VALUES (3,1,'3'),(4,1,'4'),(5,1,'5')");
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9001' })).headers['set-cookie'][0];
    });
    afterAll(async () => { await pool.end(); });

    it('rejects a delayed transfer after the selected bill is moved and replaced', async () => {
        const original = await save();
        const delayed = await intent();
        ok(await move(await intent(1, 3)));
        const replacement = await save();
        expect(replacement).not.toBe(original);
        await unchangedConflict(delayed);
    });

    it.each(['swap', 'merge'])('rejects a replacement destination bill for %s', async action => {
        await save(); await save(2);
        const delayed = await intent(1, 2, action);
        ok(await move(await intent(2, 3)));
        await save(2);
        await unchangedConflict(delayed);
    });

    it.each(['source join', 'target join', 'source disjoin', 'target disjoin', 'printed'])('rejects changed legacy bill alias state: %s', async change => {
        await save();
        if (change.includes('disjoin')) await seedLegacySharedSeats(pool, change.startsWith('source') ? 1 : 2, [4]);
        const delayed = await intent();
        if (change.includes('disjoin')) await pool.query("UPDATE restaurant_tables SET parent_table_id=NULL,current_order_id=NULL,status='available' WHERE id=4");
        else if (change.includes('join')) await seedLegacySharedSeats(pool, change.startsWith('source') ? 1 : 2, [4]);
        else await pool.query("UPDATE restaurant_tables SET status='printed' WHERE id=1");
        await unchangedConflict(delayed);
    });

    it.each([undefined, null, [], [{ id: 1 }]].map(value => [value]))('requires a complete valid expected group (%j)', async expected => {
        await save();
        await unchangedConflict({ ...await intent(), expected_tables: expected });
    });

    it.each([undefined, '', true, 'short', 'a'.repeat(65)])('requires a valid durable operation key (%j)', async operationId => {
        await save();
        const before = await state();
        const response = await move({ ...await intent(), operation_id: operationId });
        expect(response.statusCode).toBe(400);
        expect(response.body.code).toBe('TABLE_ACTION_KEY_REQUIRED');
        expect(await state()).toEqual(before);
    });

    it.each(['transfer', 'swap', 'merge'])('returns the original committed %s result on replay without further mutations', async action => {
        await save();
        if (action !== 'transfer') await save(2);
        const payload = await intent(1, 2, action);
        const first = ok(await move(payload));
        const before = await state();
        global.__mockEmit__.mockClear();
        const second = ok(await move(JSON.parse(JSON.stringify(payload))));
        expect(second).toEqual(first);
        expect(await state()).toEqual(before);
        expect(global.__mockEmit__).not.toHaveBeenCalled();
        const status = ok(await request(app).get(`/api/pos/tables/transfer/${payload.operation_id}`).set('Cookie', cookie));
        expect(status).toMatchObject({ committed: true, result: { operation_id: payload.operation_id } });
    });

    it('cannot reverse a swap with a fresh key but stale expected groups', async () => {
        await save(); await save(2);
        const payload = await intent(1, 2, 'swap');
        ok(await move(payload));
        await unchangedConflict({ ...payload, operation_id: randomUUID() });
    });

    it('serializes duplicate swaps and lets only one distinct same-state operation commit', async () => {
        const a = await save(), b = await save(2);
        const payload = await intent(1, 2, 'swap');
        const duplicate = await Promise.all([move(payload), move(payload)]);
        expect(duplicate.map(r => r.statusCode)).toEqual([200, 200]);
        const [rows] = await pool.query('SELECT current_order_id FROM restaurant_tables WHERE id IN (1,2) ORDER BY id');
        expect(rows.map(row => row.current_order_id)).toEqual([b, a]);
        const fresh = await intent(1, 2, 'swap');
        const distinct = await Promise.all([move(fresh), move({ ...fresh, operation_id: randomUUID() })]);
        expect(distinct.map(r => r.statusCode).sort()).toEqual([200, 409]);
    });

    it('binds an operation key to its actor and exact intent', async () => {
        await save();
        const payload = await intent();
        ok(await move(payload));
        const before = await state();
        const changed = await move({ ...payload, targetTableId: 3 });
        expect(changed.statusCode).toBe(409);
        expect(changed.body.code).toBe('TABLE_ACTION_KEY_CONFLICT');
        await pool.query("INSERT IGNORE INTO user_permissions (user_id,perm_key) VALUES (3,'waiter.transfer_table')");
        cookie = (await request(app).post('/api/auth/login').send({ user_number: '9003' })).headers['set-cookie'][0];
        expect((await move(payload)).statusCode).toBe(409);
        expect((await request(app).get(`/api/pos/tables/transfer/${payload.operation_id}`).set('Cookie', cookie)).statusCode).toBe(404);
        expect(await state()).toEqual(before);
    });

    it('retains replay evidence after another move and replacement orders', async () => {
        await save(); await save(2);
        const swap = await intent(1, 2, 'swap');
        const result = ok(await move(swap));
        ok(await move(await intent(1, 3)));
        await save();
        const before = await state();
        expect(ok(await move(swap))).toEqual(result);
        expect(await state()).toEqual(before);
    });

    it.each(['before commit', 'lost committed reply', 'destroy before commit', 'destroy after commit'])('recovers %s with exactly one release per attempt', async phase => {
        const committed = ['lost committed reply', 'destroy after commit'].includes(phase);
        await save(); await save(2);
        const payload = await intent(1, 2, 'swap');
        const before = await state();
        const acquire = pool.getConnection;
        let releases = 0;
        pool.getConnection = async function (...args) {
            const conn = await acquire.apply(this, args), commit = conn.commit, release = conn.release;
            conn.commit = async function () {
                if (committed) await commit.call(this);
                if (phase.startsWith('destroy')) conn.destroy();
                throw new Error('Injected commit transport loss');
            };
            conn.release = function () { releases++; conn.commit = commit; conn.release = release; return release.call(this); };
            return conn;
        };
        try { expect((await move(payload)).statusCode).toBe(500); }
        finally { pool.getConnection = acquire; }
        expect(releases).toBe(1);
        const after = await state();
        if (!committed) expect(after).toEqual(before);
        else expect(after.restaurant_tables).not.toEqual(before.restaurant_tables);
        const status = ok(await request(app).get(`/api/pos/tables/transfer/${payload.operation_id}`).set('Cookie', cookie));
        expect(status.committed).toBe(committed);
        ok(await move(payload));
        if (committed) expect(await state()).toEqual(after);
        const [receipts] = await pool.query('SELECT * FROM table_action_operations WHERE operation_id=?', [payload.operation_id]);
        expect(receipts).toHaveLength(1);
    });

    it('transfers the whole current group and preserves all money, lines, stock and print identities', async () => {
        const invoice = await save();
        await seedLegacySharedSeats(pool, 1, [3]);
        await seedLegacySharedSeats(pool, 2, [4, 5]);
        const before = await state();
        ok(await move(await intent()));
        const after = await state();
        expect(after.orders).toEqual(before.orders.map(row => ({ ...row, table_id: 2 })));
        for (const key of ['order_items','products','stock_movements','service_charge_snapshots','print_queue']) expect(after[key]).toEqual(before[key]);
        expect(after.restaurant_tables.filter(row => [2,4,5].includes(row.id)).map(row => row.current_order_id)).toEqual([invoice,invoice,invoice]);
        expect(after.restaurant_tables.filter(row => [1,3].includes(row.id)).every(row => row.parent_table_id == null && row.current_order_id == null && row.status === 'available')).toBe(true);
    });

    it('retains replay protection through an operational reset', async () => {
        await save();
        const payload = await intent();
        const result = ok(await move(payload));
        const { resetOperationalData } = require('../../services/operationalDataReset');
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await resetOperationalData(conn, { userId: 1 });
            await conn.commit();
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        const before = await state();
        expect(before.orders).toEqual([]);
        expect(ok(await move(payload))).toEqual(result);
        expect(await state()).toEqual(before);
    });
});
