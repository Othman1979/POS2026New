const request = require('supertest');
const { io: createClient } = require('socket.io-client');
const { app, server, io } = require('../../../server');
const pool = require('../../config/db');
const { invalidateToken, parseCookies } = require('../../middleware/auth');
const { seedDatabase, SEED } = require('../fixtures/seed');

// A database failure while checking a session is not an expired session. The
// POS logs the cashier out on 401 SESSION_* and on a socket "Unauthorized:"
// refusal, so a blip must answer with a retryable error instead.
describe('session checks during a database failure', () => {
    let baseUrl;
    let cookie;
    let rawToken;
    let failures;
    const unhandled = [];
    const onUnhandled = reason => unhandled.push(reason);

    const failSessionQueries = count => {
        failures = count;
        const realQuery = pool.query.bind(pool);
        vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) => {
            if (failures > 0 && String(sql).includes('FROM auth_sessions')) {
                failures -= 1;
                return Promise.reject(Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' }));
            }
            return realQuery(sql, ...rest);
        });
    };

    const handshake = () => new Promise(resolve => {
        const client = createClient(baseUrl, { transports: ['websocket'], extraHeaders: { Cookie: cookie }, reconnection: false, timeout: 3000 });
        client.once('connect', () => { client.disconnect(); resolve({ connected: true }); });
        client.once('connect_error', error => { client.close(); resolve({ connected: false, message: error.message }); });
    });

    beforeAll(async () => {
        await seedDatabase();
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        cookie = login.headers['set-cookie'][0].split(';')[0];
        rawToken = parseCookies(cookie).pos_token;
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        process.on('unhandledRejection', onUnhandled);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        unhandled.length = 0;
    });

    afterAll(async () => {
        process.off('unhandledRejection', onUnhandled);
        await new Promise(resolve => io.close(resolve));
        await pool.end();
    });

    it('answers an HTTP request 503 and keeps the session when the session check fails', async () => {
        invalidateToken(rawToken); // cold cache: the check must read the database
        failSessionQueries(1);
        const blip = await request(app).get('/api/auth/me').set('Cookie', cookie);
        expect(blip.statusCode).toBe(503);
        expect(blip.body.code).toBe('SESSION_CHECK_UNAVAILABLE');
        expect(blip.headers['retry-after']).toBeDefined();
        const recovered = await request(app).get('/api/auth/me').set('Cookie', cookie);
        expect(recovered.statusCode).toBe(200);
    });

    it('refuses a socket with a retryable error, not "Unauthorized:", when the cold session check fails', async () => {
        invalidateToken(rawToken);
        failSessionQueries(1);
        const refused = await handshake();
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(unhandled).toEqual([]);
        expect(refused).toEqual({ connected: false, message: 'Service unavailable.' });
        expect(await handshake()).toEqual({ connected: true });
    });

    it('refuses a QR menu socket with a retryable error when the table check fails, and still rejects a wrong token', async () => {
        const customer = token => new Promise(resolve => {
            const client = createClient(baseUrl, { transports: ['websocket'], auth: { type: 'customer', tableId: 1, token }, reconnection: false, timeout: 3000 });
            client.once('connect', () => { client.disconnect(); resolve({ connected: true }); });
            client.once('connect_error', error => { client.close(); resolve({ connected: false, message: error.message }); });
        });
        const realQuery = pool.query.bind(pool);
        let tableFailures = 1;
        vi.spyOn(pool, 'query').mockImplementation((sql, ...rest) => {
            if (tableFailures > 0 && String(sql).includes('FROM restaurant_tables')) {
                tableFailures -= 1;
                return Promise.reject(Object.assign(new Error('Connection lost: The server closed the connection.'), { code: 'PROTOCOL_CONNECTION_LOST' }));
            }
            return realQuery(sql, ...rest);
        });
        expect(await customer('test_qr_token_abc123')).toEqual({ connected: false, message: 'Service unavailable.' });
        expect(await customer('test_qr_token_abc123')).toEqual({ connected: true });
        expect((await customer('wrong-token')).message).toBe('Unauthorized: Invalid qr_code_token.');
    });

    it('still refuses an invalid session as unauthorized', async () => {
        cookie = 'pos_token=not-a-real-session-token-0000000000000000';
        const refused = await handshake();
        expect(refused.connected).toBe(false);
        expect(refused.message.startsWith('Unauthorized:')).toBe(true);
    });
});
