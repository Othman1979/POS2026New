const request = require('supertest');
const { io: createClient } = require('socket.io-client');
const { app, server, io, customerCartWriter } = require('../../../server');
const pool = require('../../config/db');
const logger = require('../../config/logger');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('customer QR menu socket', () => {
    let base, adminCookie;
    const clients = [];
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const connect = (tableId, token) => new Promise((resolve, reject) => {
        const client = createClient(base, { transports: ['websocket'], auth: { type: 'customer', tableId, token }, reconnection: false, forceNew: true });
        clients.push(client);
        client.once('connect', () => resolve(client));
        client.once('connect_error', reject);
    });
    const draft = async id => (await pool.query('SELECT cart_data FROM qr_table_drafts WHERE table_id = ?', [id]))[0][0];
    const sqlText = sql => String(sql?.sql ?? sql);
    const line = n => ({ product_id: 1, qty: n, price: 1, name: 'x' });

    beforeAll(async () => {
        // Real Socket.IO delivery, not the suite's double.
        vi.restoreAllMocks();
        await seedDatabase();
        adminCookie = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        for (const client of clients) client.disconnect();
        await new Promise(resolve => io.close(resolve));
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await pool.end();
    });
    beforeEach(async () => { await pool.query('DELETE FROM qr_table_drafts'); });
    // Writer state must not leak into the next test.
    afterEach(async () => {
        for (let i = 0; i < 40 && customerCartWriter.size() > 0; i++) await wait(50);
    });

    it('ignores a cart that is not a bounded array of lines and broadcasts nothing', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        const broadcast = vi.spyOn(io, 'to');
        for (const cart of ['x', { length: 3 }, null, 5, [1], [null], Array.from({ length: 101 }, () => line(1))]) {
            c.emit('customer_cart_updated', { tableId: 1, cart });
        }
        await wait(700);
        expect(await draft(1)).toBeUndefined();
        expect(broadcast).not.toHaveBeenCalled();
        broadcast.mockRestore();
        const full = Array.from({ length: 100 }, (_, i) => line(i + 1));
        c.emit('customer_cart_updated', { tableId: 1, cart: full });
        await wait(300);
        expect(JSON.parse((await draft(1)).cart_data)).toEqual(full);
    });

    it('disconnects a client that sends a 150 KB frame', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        const closed = new Promise(resolve => c.once('disconnect', resolve));
        c.emit('customer_cart_updated', { tableId: 1, cart: [{ ...line(1), name: 'x'.repeat(150_000) }] });
        await closed;
        expect(c.connected).toBe(false);
        expect(await draft(1)).toBeUndefined();
    });

    it('coalesces a burst into at most two writes and stores the last cart', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        const spy = vi.spyOn(pool, 'query');
        for (let n = 1; n <= 10; n++) { c.emit('customer_cart_updated', { tableId: 1, cart: [line(n)] }); await wait(5); }
        await wait(1000);
        const writes = spy.mock.calls.filter(([sql]) => /qr_table_drafts/.test(sqlText(sql)) && /INSERT|DELETE/.test(sqlText(sql))).length;
        spy.mockRestore();
        expect(writes).toBeGreaterThanOrEqual(1);
        expect(writes).toBeLessThanOrEqual(2);
        expect(JSON.parse((await draft(1)).cart_data)).toEqual([line(10)]);
    });

    it('keeps 500 ms between writes even when the previous write already finished', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1)] });
        await wait(150); // first write done, nothing pending
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(2)] });
        await wait(100);
        expect(JSON.parse((await draft(1)).cart_data)).toEqual([line(1)]);
        await wait(600);
        expect(JSON.parse((await draft(1)).cart_data)).toEqual([line(2)]);
        await wait(600); // the entry lives through the second cooldown, then goes
        expect(customerCartWriter.size()).toBe(0);
    });

    it('writes a queued cart after its socket disconnects and then frees the table entry', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1)] });
        await wait(150); // first write done; the next one waits out the 500 ms cooldown
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(2)] });
        await wait(50);
        c.disconnect();
        await wait(900);
        expect(JSON.parse((await draft(1)).cart_data)).toEqual([line(2)]);
        expect(customerCartWriter.size()).toBe(0);
    });

    it('two sockets on one table store the last cart received, in order', async () => {
        const a = await connect(1, 'test_qr_token_abc123');
        const b = await connect(1, 'test_qr_token_abc123');
        const send = (client, n) => client.emit('customer_cart_updated', { tableId: 1, cart: [line(n)] });
        send(a, 1); await wait(30);
        send(b, 2); await wait(30);
        send(b, 3); await wait(30);
        send(a, 4); // last received; a's older write slot would fire first per socket
        await wait(1500);
        expect(JSON.parse((await draft(1)).cart_data)).toEqual([line(4)]);
        expect(customerCartWriter.size()).toBe(0);
    });

    it('serves the latest cart, even one still waiting out the cooldown, to a draft read', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1)] });
        await wait(150);
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1), line(2)] });
        await wait(50);
        const res = await request(app).get('/api/pos/table-draft/1').set('Cookie', adminCookie);
        expect(res.statusCode).toBe(200);
        expect((res.body.data ?? res.body).cart).toEqual([line(1), line(2)]);
    });

    it('does not resurrect an imported draft after it is read and deleted', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1)] });
        await wait(150);
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1), line(2)] });
        await wait(50);
        const read = await request(app).get('/api/pos/table-draft/1').set('Cookie', adminCookie);
        const hash = (read.body.data ?? read.body).draft_hash;
        const del = await request(app).delete('/api/pos/table-draft/1').set('Cookie', adminCookie).send({ expected_hash: hash });
        expect(del.statusCode).toBe(200);
        await wait(1100);
        expect(await draft(1)).toBeUndefined();
        expect(customerCartWriter.size()).toBe(0);
    });

    it('rejects a dismiss when a cart arrived between import and dismiss', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1)] });
        await wait(150);
        const read = await request(app).get('/api/pos/table-draft/1').set('Cookie', adminCookie);
        const hash = (read.body.data ?? read.body).draft_hash;
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1), line(2)] }); // inside the cooldown
        await wait(50);
        const del = await request(app).delete('/api/pos/table-draft/1').set('Cookie', adminCookie).send({ expected_hash: hash });
        expect(del.statusCode).toBe(409);
        expect(JSON.parse((await draft(1)).cart_data)).toEqual([line(1), line(2)]);
    });

    it('a guest draft read keeps the write cooldown', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(1)] });
        await wait(150);
        c.emit('customer_cart_updated', { tableId: 1, cart: [line(2)] });
        await wait(50);
        const res = await request(app).get('/api/pos/table-draft/1?token=test_qr_token_abc123');
        expect(res.statusCode).toBe(200);
        expect((res.body.data ?? res.body).cart).toEqual([line(1)]);
    });

    it('drops a queued cart when the token is regenerated', async () => {
        const c = await connect(2, 'test_qr_token_def456');
        c.emit('customer_cart_updated', { tableId: 2, cart: [line(1)] });
        await wait(150);
        c.emit('customer_cart_updated', { tableId: 2, cart: [line(1), line(2)] });
        await wait(50);
        const res = await request(app).post('/api/pos/table_manager').set('Cookie', adminCookie).send({ action: 'regenerate_qr_token', id: 2 });
        expect(res.statusCode).toBe(200);
        await pool.query("UPDATE restaurant_tables SET qr_code_token = 'test_qr_token_def456' WHERE id = 2");
        await wait(1100);
        expect(JSON.parse((await draft(2)).cart_data)).toEqual([line(1)]);
        expect(customerCartWriter.size()).toBe(0);
    });

    it('disconnects connected customers when the token is regenerated or the table is deleted', async () => {
        const a = await connect(2, 'test_qr_token_def456');
        const aClosed = new Promise(resolve => a.once('disconnect', resolve));
        const res = await request(app).post('/api/pos/table_manager').set('Cookie', adminCookie).send({ action: 'regenerate_qr_token', id: 2 });
        expect(res.statusCode).toBe(200);
        await aClosed;
        await expect(connect(2, 'test_qr_token_def456')).rejects.toThrow();

        const b = await connect(2, res.body.data?.qr_code_token ?? res.body.qr_code_token);
        const bClosed = new Promise(resolve => b.once('disconnect', resolve));
        const del = await request(app).post('/api/pos/table_manager').set('Cookie', adminCookie).send({ action: 'delete_table', id: 2 });
        expect(del.statusCode).toBe(200);
        await bClosed;
    });

    it('does not log the token a rejected caller supplied', async () => {
        const warn = vi.spyOn(logger, 'warn');
        await expect(connect(1, 'guessed-secret-token-zzz')).rejects.toThrow();
        const logged = JSON.stringify(warn.mock.calls);
        warn.mockRestore();
        expect(logged).toContain('invalid qr_code_token');
        expect(logged).not.toContain('guessed-secret-token-zzz');
    });

    it('rejects a noncanonical table id for regenerate and delete and touches nothing', async () => {
        const c = await connect(1, 'test_qr_token_abc123');
        let dropped = false;
        c.once('disconnect', () => { dropped = true; });
        for (const id of ['1e2', '01', '1abc', 0, -1, 1.5, null, '']) {
            for (const action of ['regenerate_qr_token', 'delete_table']) {
                const res = await request(app).post('/api/pos/table_manager').set('Cookie', adminCookie).send({ action, id });
                expect(res.statusCode, `${action} ${JSON.stringify(id)}`).toBe(400);
            }
        }
        await wait(100);
        expect(dropped).toBe(false);
        const [[row]] = await pool.query('SELECT qr_code_token FROM restaurant_tables WHERE id = 1');
        expect(row.qr_code_token).toBe('test_qr_token_abc123');
        // The canonical string form still works and is normalized once.
        const ok = await request(app).post('/api/pos/table_manager').set('Cookie', adminCookie).send({ action: 'regenerate_qr_token', id: '1' });
        expect(ok.statusCode).toBe(200);
        await pool.query("UPDATE restaurant_tables SET qr_code_token = 'test_qr_token_abc123' WHERE id = 1");
    });
});
