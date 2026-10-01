const { withUserEditVersion } = require('../helpers/adminUsers');
const request = require('supertest');
const { io: createClient } = require('socket.io-client');
const { app, server, io } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { safePublishSpoolerSyncWake } = require('../../services/spoolerSyncWake');

const connect = (url, cookie) => new Promise((resolve, reject) => {
    const client = createClient(url, {
        transports: ['websocket'],
        extraHeaders: { Cookie: cookie },
        reconnection: false
    });
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
});

describe('Socket role isolation', () => {
    let baseUrl;
    let adminCookie;
    let cashier;
    let callCenter;

    beforeAll(async () => {
        // This file verifies real delivery, not the suite's normal Socket.IO double.
        vi.restoreAllMocks();
        await seedDatabase();
        await pool.query(`
            INSERT INTO users (id, user_number, name, role, is_active)
            VALUES (20, '9020', 'Call Center Socket', 'call_center', 1)
        `);

        const cashierLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        const callCenterLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: '9020' });
        const adminLogin = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminLogin.headers['set-cookie'][0];

        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        cashier = await connect(baseUrl, cashierLogin.headers['set-cookie'][0]);
        callCenter = await connect(baseUrl, callCenterLogin.headers['set-cookie'][0]);
    });

    afterAll(async () => {
        cashier?.disconnect();
        callCenter?.disconnect();
        await new Promise((resolve) => io.close(resolve));
        await pool.end();
    });

    it('keeps call-center sockets out of staff rooms and ignores forged room requests', async () => {
        const cashierSocket = io.sockets.sockets.get(cashier.id);
        const callCenterSocket = io.sockets.sockets.get(callCenter.id);

        expect(cashierSocket.rooms.has('staff')).toBe(true);
        expect(callCenterSocket.rooms.has('staff')).toBe(false);

        callCenter.emit('join-section', 1);
        cashier.emit('join-section', 1);
        await new Promise((resolve) => setTimeout(resolve, 25));
        for (const roomSocket of [callCenterSocket, cashierSocket]) {
            expect([...roomSocket.rooms].some(room => room.startsWith('section:'))).toBe(false);
        }
        expect([...callCenterSocket.rooms].some(room => room.startsWith('table-access:'))).toBe(false);
    });

    it('sends print cancellation updates only to staff sockets', async () => {
        const callCenterEvents = [];
        callCenter.on('print_queue_updated', payload => callCenterEvents.push(payload));
        // The cancel also wakes the spooler, which announces a queue change first; wait for the cancel's own update.
        const staffUpdate = new Promise(resolve => {
            const onUpdate = payload => { if (payload?.queueId !== undefined) { cashier.off('print_queue_updated', onUpdate); resolve(payload); } };
            cashier.on('print_queue_updated', onUpdate);
        });
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name) VALUES ('Socket Cancel', 'receipt', 'windows', 'Socket-Cancel')"
        );
        const [queue] = await pool.query(
            "INSERT INTO print_queue (payload, printer_id, print_type, status) VALUES ('{}', ?, 'receipt', 'sent')",
            [printer.insertId]
        );

        const response = await request(baseUrl)
            .post(`/api/admin/print-queue/${queue.insertId}/cancel`)
            .set('Cookie', adminCookie);

        expect(response.statusCode).toBe(200);
        expect(await staffUpdate).toEqual({ queueId: queue.insertId, status: 'cancel_requested' });
        // Socket.IO delivers in order per connection, so once the call-center
        // socket sees a later broadcast, any earlier update would already be here.
        const barrier = new Promise(resolve => callCenter.once('isolation-barrier', resolve));
        io.emit('isolation-barrier');
        await barrier;
        expect(callCenterEvents).toEqual([]);
    });

    it('tells a newly joined staff socket which print stations are stale', async () => {
        const [printer] = await pool.query(
            "INSERT INTO printers (name, role, type, windows_name, spooler_id) VALUES ('Stale', 'kitchen', 'windows', 'Stale', 'unreachable-station')"
        );
        await pool.query(
            "INSERT INTO print_queue (payload, printer_id, print_type, status) VALUES ('{}', ?, 'kitchen', 'pending')",
            [printer.insertId]
        );
        // The watchdog keeps the stale list in memory; a connecting socket is told from there.
        const watchdog = app.get('printQueueWatchdog');
        await watchdog.start();
        const admin = createClient(baseUrl, {
            transports: ['websocket'],
            extraHeaders: { Cookie: adminCookie },
            reconnection: false,
            autoConnect: false
        });
        let deadline;
        try {
            const announced = new Promise((resolve, reject) => {
                admin.once('stale_print_stations', resolve);
                deadline = setTimeout(() => reject(new Error('no stale_print_stations on connect')), 2000);
            });
            admin.connect();
            const { stations } = await announced;
            expect(stations).toContainEqual({ spooler_id: 'unreachable-station', last_sync_at: null, queued: 1 });
        } finally {
            clearTimeout(deadline);
            admin.disconnect();
            await watchdog.stop();
            await pool.query('DELETE FROM print_queue WHERE printer_id = ?', [printer.insertId]);
            await pool.query('DELETE FROM printers WHERE id = ?', [printer.insertId]);
        }
    });

    it('tells staff sockets, not call center, when a print job is enqueued', async () => {
        const callCenterEvents = [];
        callCenter.on('print_queue_updated', payload => callCenterEvents.push(payload));
        const staffUpdate = new Promise(resolve => cashier.once('print_queue_updated', resolve));
        safePublishSpoolerSyncWake();
        await expect(staffUpdate).resolves.toEqual({ source: 'enqueue' });
        io.emit('enqueue-barrier');
        await new Promise(resolve => setTimeout(resolve, 25));
        expect(callCenterEvents).toEqual([]);
    });

    it('disconnects an existing staff socket on role change and isolates its next session', async () => {
        const disconnected = new Promise((resolve) => cashier.once('disconnect', resolve));
        const update = await request(baseUrl)
            .put('/api/admin/users')
            .set('Cookie', adminCookie)
            .send(await withUserEditVersion(app, adminCookie, {
                id: SEED.cashierUser.id,
                name: SEED.cashierUser.name,
                user_number: SEED.cashierUser.user_number,
                role: 'call_center',
                permissions: [],
                allowed_sections: ''
            }));

        expect(update.statusCode).toBe(200);
        await disconnected;

        const relogin = await request(baseUrl)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        const reconnected = await connect(baseUrl, relogin.headers['set-cookie'][0]);
        try {
            const serverSocket = io.sockets.sockets.get(reconnected.id);
            expect(serverSocket.user.role).toBe('call_center');
            expect(serverSocket.rooms.has('staff')).toBe(false);
        } finally {
            reconnected.disconnect();
        }
    });
});
