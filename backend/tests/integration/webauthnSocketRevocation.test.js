const crypto = require('crypto');
const { io: createClient } = require('socket.io-client');
const request = require('supertest');
const { app, server, io } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { invalidateAuthModeCache } = require('../../services/deviceAccess');
const { hashSessionToken } = require('../../services/staffSessions');

function futureDate(minutes = 30) {
    return new Date(Date.now() + minutes * 60 * 1000);
}

function connect(url, token) {
    return new Promise((resolve, reject) => {
        const client = createClient(url, {
            transports: ['websocket'],
            extraHeaders: { Cookie: `pos_token=${token}` },
            reconnection: false,
            forceNew: true,
        });
        client.once('connect', () => resolve(client));
        client.once('connect_error', reject);
    });
}

describe('WebAuthn credential socket revocation', () => {
    let baseUrl;
    let firstClient;
    let secondClient;
    let firstCredentialId;
    let secondCredentialId;
    let firstToken;
    let secondToken;

    beforeAll(async () => {
        io.to.mockRestore?.();
        await seedDatabase();
        await pool.query("UPDATE settings SET setting_value='staged' WHERE setting_key='staff_device_auth_mode'");

        const credentials = [];
        for (const label of ['Admin terminal A', 'Admin terminal B']) {
            const credentialId = crypto.randomBytes(32);
            const [result] = await pool.query(
                `INSERT INTO webauthn_credentials
                    (user_id, credential_lookup, credential_id, public_key, device_type,
                     backed_up, authenticator_attachment, transports, device_label)
                 VALUES (?, ?, ?, ?, 'singleDevice', 0, 'platform', '["internal"]', ?)`,
                [SEED.adminUser.id, crypto.createHash('sha256').update(credentialId).digest(), credentialId, Buffer.from('test-public-key'), label]
            );
            credentials.push(Number(result.insertId));
        }
        firstCredentialId = credentials[0];
        secondCredentialId = credentials[1];

        const sessions = [];
        for (const credentialId of credentials) {
            const token = crypto.randomBytes(32).toString('hex');
            const sessionId = crypto.randomUUID();
            const expires = futureDate();
            await pool.query(
                `INSERT INTO auth_sessions
                    (id, token_hash, user_id, credential_id, idle_expires_at, absolute_expires_at,
                     webauthn_verified_at)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [sessionId, hashSessionToken(token), SEED.adminUser.id, credentialId, expires, futureDate(120)]
            );
            sessions.push({ token, sessionId });
        }
        firstToken = sessions[0].token;
        secondToken = sessions[1].token;

        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://localhost:${server.address().port}`;
        process.env.DEVICE_AUTH_ALLOWED_ORIGINS = baseUrl;
        firstClient = await connect(baseUrl, sessions[0].token);
        secondClient = await connect(baseUrl, sessions[1].token);
    });

    afterAll(async () => {
        firstClient?.disconnect();
        secondClient?.disconnect();
        await new Promise((resolve) => io.close(resolve));
        await new Promise((resolve) => server.close(() => resolve()));
        await pool.end();
    });

    it('joins bound sessions to exact credential rooms', () => {
        const firstSocket = io.sockets.sockets.get(firstClient.id);
        const secondSocket = io.sockets.sockets.get(secondClient.id);

        expect(firstSocket.rooms.has(`user:${SEED.adminUser.id}`)).toBe(true);
        expect(firstSocket.rooms.has(`session:${firstSocket.authSession.session_id}`)).toBe(true);
        expect(firstSocket.rooms.has(`credential:${firstCredentialId}`)).toBe(true);
        expect(secondSocket.rooms.has(`credential:${secondSocket.authSession.credential_id}`)).toBe(true);
        expect(firstSocket.authSession.credential_id).not.toBe(secondSocket.authSession.credential_id);
    });

    it('disconnects only the revoked credential and evicts its cached token', async () => {
        expect(io.sockets.sockets.get(secondClient.id).rooms.has(`credential:${firstCredentialId}`)).toBe(false);
        const disconnected = new Promise((resolve) => firstClient.once('disconnect', resolve));
        let secondDisconnectReason;
        secondClient.once('disconnect', (reason) => { secondDisconnectReason = reason; });

        const response = await fetch(`${baseUrl}/api/admin/device-access/credentials/${firstCredentialId}/revoke`, {
            method: 'POST',
            headers: {
                Cookie: `pos_token=${firstToken}`,
                Origin: baseUrl,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ reason: 'test_credential_revoked' }),
        });
        expect(response.status).toBe(200);

        await disconnected;
        expect(firstClient.connected).toBe(false);
        expect({ connected: secondClient.connected, reason: secondDisconnectReason }).toEqual({ connected: true, reason: undefined });

        const [rows] = await pool.query(
            'SELECT revoked_at, revoke_reason FROM auth_sessions WHERE token_hash=?',
            [hashSessionToken(firstToken)]
        );
        expect(rows[0].revoked_at).not.toBeNull();
        expect(rows[0].revoke_reason).toBe('credential_revoked');
    });

    it('disconnects the exact socket when that browser logs out', async () => {
        const disconnected = new Promise((resolve) => secondClient.once('disconnect', resolve));
        const response = await fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { Cookie: `pos_token=${secondToken}` },
        });
        expect(response.status).toBe(200);
        await disconnected;
        expect(secondClient.connected).toBe(false);

        const [rows] = await pool.query('SELECT revoked_at, revoke_reason FROM auth_sessions WHERE token_hash=?', [hashSessionToken(secondToken)]);
        expect(rows[0].revoked_at).not.toBeNull();
        expect(rows[0].revoke_reason).toBe('logout');
    });

    it('disconnects a socket when its durable session expires', async () => {
        const token = crypto.randomBytes(32).toString('hex');
        const sessionId = crypto.randomUUID();
        await pool.query(
            `INSERT INTO auth_sessions
                (id, token_hash, user_id, credential_id, idle_expires_at, absolute_expires_at, webauthn_verified_at)
             VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE), DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 3 SECOND), CURRENT_TIMESTAMP)`,
            [sessionId, hashSessionToken(token), SEED.adminUser.id, secondCredentialId]
        );
        const client = await connect(baseUrl, token);
        const disconnected = new Promise((resolve) => client.once('disconnect', resolve));
        await disconnected;
        expect(client.connected).toBe(false);
    }, 7000);
    it('disconnects the pre-bootstrap session sockets when bootstrap upgrades the session', async () => {
        const secret = 'test-bootstrap-secret-with-more-than-256-bits-000000000000000000000000';
        process.env.DEVICE_AUTH_BOOTSTRAP_SECRET = secret;
        await pool.query("UPDATE settings SET setting_value='disabled' WHERE setting_key='staff_device_auth_mode'");
        invalidateAuthModeCache();
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='webauthn_bootstrap_consumed'");
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE flow='bootstrap_registration' AND terminal_state='pending'");
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `INSERT INTO auth_sessions
                (id, token_hash, user_id, credential_id, idle_expires_at, absolute_expires_at, webauthn_verified_at)
             VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
            [crypto.randomUUID(), hashSessionToken(token), SEED.adminUser.id, futureDate(), futureDate(120)]
        );
        const client = await connect(baseUrl, token);
        const disconnected = new Promise((resolve) => client.once('disconnect', resolve));
        const started = await request(app)
            .post('/api/admin/device-access/bootstrap/options')
            .set('Cookie', `pos_token=${token}`)
            .set('Origin', baseUrl)
            .send({ bootstrap_secret: secret, device_label: 'Bootstrap socket terminal' });
        expect(started.body, JSON.stringify(started.body)).toMatchObject({ success: true });
        const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const signature = crypto.sign('sha256', Buffer.from(started.body.message), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        const verified = await request(app)
            .post('/api/admin/device-access/bootstrap/verify')
            .set('Cookie', `pos_token=${token}`)
            .set('Origin', baseUrl)
            .send({ ceremony_id: started.body.ceremony_id, secret, public_key: pair.publicKey.export({ format: 'jwk' }), signature });
        expect(verified.statusCode).toBe(200);
        await disconnected;
        expect(client.connected).toBe(false);
    }, 7000);

    it('sends the new cookie before the old session sockets are disconnected', async () => {
        const secret = 'test-bootstrap-secret-with-more-than-256-bits-000000000000000000000000';
        await pool.query("UPDATE settings SET setting_value='disabled' WHERE setting_key='staff_device_auth_mode'");
        invalidateAuthModeCache();
        await pool.query(`UPDATE webauthn_credentials SET status='revoked' WHERE user_id=${SEED.adminUser.id}`);
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='webauthn_bootstrap_consumed'");
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE flow='bootstrap_registration' AND terminal_state='pending'");
        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `INSERT INTO auth_sessions
                (id, token_hash, user_id, credential_id, idle_expires_at, absolute_expires_at, webauthn_verified_at)
             VALUES (?, ?, ?, NULL, ?, ?, NULL)`,
            [crypto.randomUUID(), hashSessionToken(token), SEED.adminUser.id, futureDate(), futureDate(120)]
        );
        const client = await connect(baseUrl, token);
        const started = await request(app)
            .post('/api/admin/device-access/bootstrap/options')
            .set('Cookie', `pos_token=${token}`)
            .set('Origin', baseUrl)
            .send({ bootstrap_secret: secret, device_label: 'Bootstrap order terminal' });
        expect(started.body, JSON.stringify(started.body)).toMatchObject({ success: true });
        const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        const signature = crypto.sign('sha256', Buffer.from(started.body.message), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
        let responseFinished = false;
        let finishedAtDisconnect = null;
        const onRequest = (req, res) => {
            if (req.url.includes('/bootstrap/verify')) res.once('finish', () => { responseFinished = true; });
        };
        server.on('request', onRequest);
        const realTo = io.to.bind(io);
        const toSpy = vi.spyOn(io, 'to').mockImplementation((room) => {
            const target = realTo(room);
            return new Proxy(target, { get: (t, key) => key === 'disconnectSockets'
                ? (...args) => { finishedAtDisconnect = responseFinished; return t.disconnectSockets(...args); }
                : Reflect.get(t, key) });
        });
        const disconnected = new Promise((resolve) => client.once('disconnect', resolve));
        const verified = await request(baseUrl)
            .post('/api/admin/device-access/bootstrap/verify')
            .set('Cookie', `pos_token=${token}`)
            .set('Origin', baseUrl)
            .send({ ceremony_id: started.body.ceremony_id, secret, public_key: pair.publicKey.export({ format: 'jwk' }), signature });
        toSpy.mockRestore();
        server.off('request', onRequest);
        expect(verified.statusCode, JSON.stringify(verified.body)).toBe(200);
        expect(verified.headers['set-cookie'].join(';')).toContain('pos_token=');
        await disconnected;
        expect(finishedAtDisconnect).toBe(true);
    }, 7000);
});
