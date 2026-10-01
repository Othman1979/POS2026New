const { withUserEditVersion } = require('../helpers/adminUsers');
const request = require('supertest');
const { io: createClient } = require('socket.io-client');
const { app, server, io } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase } = require('../fixtures/seed');

describe('table access on real staff sockets', () => {
    let adminCookie, clients = [], base;
    const login = async number => (await request(app).post('/api/auth/login').send({ user_number: number })).headers['set-cookie'][0];
    const connect = (cookie, auth) => new Promise((resolve, reject) => {
        const client = createClient(base, { transports: ['websocket'], ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}), auth, reconnection: false, forceNew: true });
        clients.push(client); client.once('connect', () => resolve(client)); client.once('connect_error', reject);
    });
    const barrier = async () => {
        const received = clients.filter(client => client.connected).map(client => new Promise(resolve => client.once('f5-barrier', resolve)));
        io.emit('f5-barrier'); await Promise.all(received);
    };
    beforeAll(async () => {
        // This file verifies real delivery, not the suite's normal Socket.IO double.
        vi.restoreAllMocks();
        await seedDatabase();
        await pool.query("INSERT INTO sections(id,name) VALUES(2,'Hidden')");
        await pool.query("UPDATE restaurant_tables SET section_id=2,qr_code_token='hidden-guest-token' WHERE id=2");
        await pool.query('DELETE FROM user_permissions WHERE user_id=2');
        adminCookie = await login('9001');
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        for (const client of clients) client.disconnect();
        await new Promise(resolve => io.close(resolve));
        if (server.listening) await new Promise(resolve => server.close(resolve));
        await pool.end();
    });
    it('delivers table content only to authorized sections, rejects forged subscriptions, and preserves guest reads', async () => {
        const admin = await connect(adminCookie), waiter = await connect(await login('9003')), cashier = await connect(await login('9002'));
        const visible = [], hidden = [], zeroGrants = [];
        admin.on('table_update', event => visible.push(event));
        waiter.on('table_update', event => hidden.push(event));
        cashier.on('table_update', event => zeroGrants.push(event));
        waiter.emit('join-section', 2); cashier.emit('join-section', 2);
        const save = id => request(app).post('/api/pos/table_order').set('Cookie', adminCookie)
            .send({ table_id: id, cart: [{ id: 2, qty: 1, price: 2, tax_rate: 0 }], subtotal: 2, tax: 0, total: 2 });
        expect((await save(2)).statusCode).toBe(200); await barrier();
        expect(visible.some(event => event.table?.id === 2)).toBe(true);
        expect(hidden).toEqual([]); expect(zeroGrants).toEqual([]);
        expect((await save(1)).statusCode).toBe(200); await barrier();
        expect(hidden.map(event => event.table?.id)).toEqual([1]); expect(zeroGrants).toEqual([]);
        expect(visible.some(event => event.table && Object.hasOwn(event.table, 'qr_code_token'))).toBe(false);

        await pool.query('INSERT INTO qr_table_drafts(table_id,cart_data) VALUES(2,?)', [JSON.stringify([{ product_id: 2, qty: 1 }])]);
        const draftEvents = [];
        waiter.on('table_draft_changed', event => draftEvents.push(event));
        expect((await request(app).delete('/api/pos/table-draft/2').set('Cookie', adminCookie)).statusCode).toBe(200);
        await barrier(); expect(draftEvents).toEqual([]);
        const guest = await request(app).get('/api/pos/table-draft/2?token=hidden-guest-token');
        expect(guest.statusCode).toBe(200); expect(guest.body.cart).toEqual([]);

        const guestSocket = await connect(null, { type: 'customer', tableId: 2, token: 'hidden-guest-token' });
        const notification = new Promise(resolve => admin.once('table_draft_changed', resolve));
        guestSocket.emit('customer_cart_updated', { tableId: 2, cart: [{ product_id: 2, qty: 3 }] });
        expect(await notification).toEqual({ tableId: 2, itemCount: 1 });
        await barrier(); expect(draftEvents).toEqual([]);
        expect((await request(app).get('/api/pos/table-draft/2?token=hidden-guest-token')).body.cart).toEqual([{ product_id: 2, qty: 3 }]);

        // Production user edits already revoke durable sessions and disconnect
        // their sockets; a previously authorized section room cannot survive.
        const disconnected = new Promise(resolve => waiter.once('disconnect', resolve));
        const changed = await request(app).put('/api/admin/users').set('Cookie', adminCookie)
            .send(await withUserEditVersion(app, adminCookie, { id: 3, user_number: '9003', name: 'Restricted Waiter', role: 'waiter', allowed_sections: '2', permissions: [] }));
        expect(changed.statusCode, JSON.stringify(changed.body)).toBe(200);
        await disconnected; expect(waiter.connected).toBe(false);
    });
});
