const request = require('supertest');
const { io: createClient } = require('socket.io-client');
const { app, server, io } = require('../../../server');
const pool = require('../../config/db');
const { invalidateToken, parseCookies } = require('../../middleware/auth');
const { seedDatabase, SEED } = require('../fixtures/seed');

// A staff socket handshake and connect should not repeat work the server already did:
// the session is read once when cold and not at all when warm, and the print badge
// state is answered from memory.
describe('staff socket connect cost', () => {
    let baseUrl;
    let cookie;
    let rawToken;
    let queries;

    const connect = () => new Promise((resolve, reject) => {
        const client = createClient(baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false, timeout: 3000 });
        const events = [];
        client.on('failed_print_jobs_count', count => events.push(['failed_print_jobs_count', count]));
        client.on('stale_print_stations', payload => events.push(['stale_print_stations', payload]));
        client.once('connect', () => setTimeout(() => { client.disconnect(); resolve(events); }, 150));
        client.once('connect_error', error => { client.close(); reject(error); });
    });

    const count = fragment => queries.filter(sql => sql.includes(fragment)).length;

    beforeAll(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cookie = login.headers['set-cookie'][0].split(';')[0];
        rawToken = parseCookies(cookie).pos_token;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        await app.get('printQueueWatchdog').start(); // startup produces the print state once
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    beforeEach(() => {
        queries = [];
        const realQuery = pool.query.bind(pool);
        vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) => {
            queries.push(String(sql));
            return realQuery(sql, ...rest);
        });
    });

    afterEach(() => vi.restoreAllMocks());

    afterAll(async () => {
        await app.get('printQueueWatchdog').stop();
        await new Promise(resolve => io.close(resolve));
        await pool.end();
    });

    it('reads the session 0 times on a warm handshake and once on a cold one', async () => {
        await request(app).get('/api/auth/me').set('Cookie', cookie); // warm the cache
        queries = [];
        await connect();
        expect(count('FROM auth_sessions')).toBe(0);

        invalidateToken(rawToken);
        queries = [];
        await connect();
        expect(count('FROM auth_sessions')).toBe(1);
    });

    it('arms the session deadline from the cached binding, so a connected socket makes no session query', async () => {
        await request(app).get('/api/auth/me').set('Cookie', cookie); // warm the cache
        queries = [];
        const client = createClient(baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false, timeout: 3000 });
        await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
        await new Promise(resolve => setTimeout(resolve, 1500)); // past the 1 s minimum re-check a missing deadline would cause
        client.disconnect();
        expect(count('FROM auth_sessions')).toBe(0);
    });

    it('disconnects a socket whose session is revoked between the handshake check and the room joins', async () => {
        await request(app).get('/api/auth/me').set('Cookie', cookie); // warm the cache
        // Runs after the auth middleware and before the connection handler joins the rooms.
        io.use((socket, next) => { invalidateToken(rawToken); next(); });
        const client = createClient(baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false, timeout: 3000 });
        const outcome = await new Promise((resolve) => {
            client.once('disconnect', () => resolve('disconnected'));
            client.once('connect_error', () => resolve('refused'));
            setTimeout(() => resolve('still connected'), 1500);
        });
        const staffSockets = [...io.sockets.sockets.values()].filter(s => s.rawSessionToken === rawToken);
        client.close();
        io._nsps.get('/')._fns.pop();
        expect({ outcome, lingering: staffSockets.length }).toEqual({ outcome: 'disconnected', lingering: 0 });
    });

    it('runs no print queries on connect but still sends both print events', async () => {
        queries = [];
        const events = await connect();
        expect(count('FROM print_queue')).toBe(0);
        expect(queries.filter(sql => sql.includes('spooler_agents'))).toEqual([]);
        expect(events.map(([name]) => name).sort()).toEqual(['failed_print_jobs_count', 'stale_print_stations']);
        expect(typeof events.find(([name]) => name === 'failed_print_jobs_count')[1]).toBe('number');
    });

    it('still refuses a session revoked through the real path after the cache was warm', async () => {
        await request(app).get('/api/auth/me').set('Cookie', cookie); // warm the cache
        await request(app).post('/api/auth/logout').set('Cookie', cookie); // real revocation path must clear the cache
        await expect(connect()).rejects.toThrow(/Unauthorized/);
    });
});
