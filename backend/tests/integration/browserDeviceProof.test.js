const crypto = require('node:crypto');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { serializePublicJwk } = require('../../services/browserDeviceCrypto');
const { hashOpaque } = require('../../services/webauthn/ceremonies');
const { createSession, findActiveSession, touchSession } = require('../../services/staffSessions');
const { invalidateAuthModeCache } = require('../../services/deviceAccess');

const ORIGIN = 'http://localhost:3001';
const PROGRAMMER = { id: 30, user_number: '87654321', name: 'Support Programmer' };

function createBrowserKey() {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function sign(privateKey, message) {
    return crypto.sign('sha256', Buffer.from(message), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}

async function insertCredential(userId, publicKey, label) {
    const credentialId = crypto.randomBytes(32);
    const [result] = await pool.query(
        `INSERT INTO webauthn_credentials
            (user_id, credential_lookup, credential_id, public_key, device_type,
             backed_up, authenticator_attachment, device_label)
         VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'singleDevice', 0, 'platform', ?)`,
        [userId, credentialId, credentialId, serializePublicJwk(publicKey.export({ format: 'jwk' })), label]
    );
    return result.insertId;
}

describe('prompt-free registered-browser proof', () => {
    beforeAll(async () => {
        process.env.DEVICE_AUTH_ALLOWED_ORIGINS = ORIGIN;
        await seedDatabase();
        await pool.query(
            `INSERT INTO users (id, user_number, name, role, is_active, xyz)
             VALUES (?, ?, ?, 'programmer', 1, 0)`,
            [PROGRAMMER.id, PROGRAMMER.user_number, PROGRAMMER.name]
        );
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query("UPDATE settings SET setting_value='enforced' WHERE setting_key='staff_device_auth_mode'");
        invalidateAuthModeCache();
        await pool.query('DELETE FROM auth_sessions');
        await pool.query('DELETE FROM webauthn_ceremonies');
        await pool.query('DELETE FROM webauthn_credentials');
    });

    it('creates a session only after the registered browser signs the exact one-use message', async () => {
        const key = createBrowserKey();
        await insertCredential(SEED.cashierUser.id, key.publicKey, 'Counter browser');

        const options = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });
        expect(options.statusCode).toBe(200);
        expect(options.body).toMatchObject({ success: true, ceremony_id: expect.any(String), message: expect.stringContaining('posapp-browser-device-v1') });

        const verified = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({
            ceremony_id: options.body.ceremony_id,
            signature: sign(key.privateKey, options.body.message),
        });
        expect(verified.statusCode).toBe(200);
        expect(verified.body.user).toMatchObject({ id: SEED.cashierUser.id, role: 'cashier' });
        expect(verified.headers['set-cookie']?.[0]).toContain('pos_token=');

        const replay = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({
            ceremony_id: options.body.ceremony_id,
            signature: sign(key.privateKey, options.body.message),
        });
        expect(replay.statusCode).not.toBe(200);
    });

    it('rejects another browser, altered messages, and the wrong origin', async () => {
        const registered = createBrowserKey();
        const attacker = createBrowserKey();
        await insertCredential(SEED.cashierUser.id, registered.publicKey, 'Counter browser');
        const options = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });

        const wrongKey = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({ ceremony_id: options.body.ceremony_id, signature: sign(attacker.privateKey, options.body.message) });
        expect(wrongKey.statusCode).toBe(401);
        const missing = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({ ceremony_id: crypto.randomUUID(), signature: wrongKey.body.message });
        const repeated = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({ ceremony_id: options.body.ceremony_id, signature: sign(registered.privateKey, options.body.message) });
        expect(missing.statusCode).toBe(401);
        expect(repeated.statusCode).toBe(401);
        expect(wrongKey.body).toEqual(missing.body);
        expect(repeated.body).toEqual(missing.body);
        const [[deleted]] = await pool.query('SELECT COUNT(*) AS count FROM webauthn_ceremonies WHERE id=?', [options.body.ceremony_id]);
        expect(Number(deleted.count)).toBe(0);

        const secondOptions = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });
        const altered = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({ ceremony_id: secondOptions.body.ceremony_id, signature: sign(registered.privateKey, `${secondOptions.body.message}x`) });
        expect(altered.statusCode).toBe(401);

        const wrongOrigin = await request(app).post('/api/auth/webauthn/login/options').set('Origin', 'https://attacker.example').send({ user_number: SEED.cashierUser.user_number });
        expect(wrongOrigin.statusCode).toBe(403);
    });

    it('does not encode a known user or decoy marker into the public proof subject', async () => {
        const known = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });
        const unknown = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: '99999999' });

        for (const [response, oldIdentity] of [[known, SEED.cashierUser.id], [unknown, 'decoy']]) {
            expect(response.statusCode).toBe(200);
            const [, , , ceremonyId, subject, challenge] = response.body.message.split('\n');
            expect(subject).toBe(hashOpaque(`posapp-device-subject-v2:${ceremonyId}:${challenge}`));
            expect(subject).not.toBe(hashOpaque(`posapp-device-subject-v1:${oldIdentity}:${challenge}`));
        }
    });

    it('returns one failure for unusable login ids without mutating other ceremony flows', async () => {
        const cases = [
            { flow: 'authentication', state: 'pending', attempts: 0, expires: -1 },
            { flow: 'authentication', state: 'consumed', attempts: 1, expires: 2 },
            { flow: 'authentication', state: 'pending', attempts: 3, expires: 2 },
            { flow: 'enrollment_registration', state: 'pending', attempts: 0, expires: 2 },
            { flow: 'step_up', state: 'pending', attempts: 0, expires: 2 },
        ];
        const missing = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN)
            .send({ ceremony_id: crypto.randomUUID(), signature: 'invalid' });
        expect(missing.statusCode).toBe(401);

        for (const entry of cases) {
            const id = crypto.randomUUID();
            await pool.query(
                `INSERT INTO webauthn_ceremonies (id, flow, user_id, challenge, terminal_state, attempt_count, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? SECOND))`,
                [id, entry.flow, SEED.cashierUser.id, crypto.randomBytes(32), entry.state, entry.attempts, entry.expires]
            );
            const response = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN)
                .send({ ceremony_id: id, signature: 'invalid' });
            expect(response.statusCode).toBe(401);
            expect(response.body).toEqual(missing.body);
            const [[stored]] = await pool.query('SELECT flow, terminal_state, attempt_count FROM webauthn_ceremonies WHERE id=?', [id]);
            expect(stored).toMatchObject({ flow: entry.flow, terminal_state: entry.state, attempt_count: entry.attempts });
        }
    });

    it('keeps known and unknown option responses uniform after the old decoy cap', async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const response = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: 'unknown-candidate' });
            expect(response.statusCode).toBe(200);
        }
        const unknown = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: 'unknown-candidate' });
        const known = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });
        expect(unknown.statusCode).toBe(known.statusCode);
        expect(unknown.body).toMatchObject({ success: true, ceremony_id: expect.any(String), message: expect.any(String) });
        expect(known.body).toMatchObject({ success: true, ceremony_id: expect.any(String), message: expect.any(String) });
    });

    it('keeps unknown options stateless while real users keep working under churn', async () => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const response = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: `unknown-${attempt}` });
            expect(response.statusCode).toBe(200);
        }
        const [[unknownRows]] = await pool.query("SELECT COUNT(*) AS count FROM webauthn_ceremonies WHERE flow='authentication' AND user_id IS NULL");
        expect(Number(unknownRows.count)).toBe(0);
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const known = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });
            expect(known.statusCode).toBe(200);
        }
    });

    it('treats programmer browser options as a decoy and rejects a directly inserted credential', async () => {
        const key = createBrowserKey();
        const credentialId = await insertCredential(PROGRAMMER.id, key.publicKey, 'Forbidden programmer browser');
        const options = await request(app)
            .post('/api/auth/webauthn/login/options')
            .set('Origin', ORIGIN)
            .send({ user_number: PROGRAMMER.user_number });
        expect(options.statusCode).toBe(200);
        const [[ceremony]] = await pool.query('SELECT user_id, is_decoy FROM webauthn_ceremonies WHERE id=?', [options.body.ceremony_id]);
        expect(ceremony).toBeUndefined();

        const verified = await request(app)
            .post('/api/auth/webauthn/login/verify')
            .set('Origin', ORIGIN)
            .send({ ceremony_id: options.body.ceremony_id, signature: sign(key.privateKey, options.body.message) });
        expect(verified.statusCode).toBe(401);
        const [[sessions]] = await pool.query('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
        expect(Number(sessions.count)).toBe(0);

        const directSession = await createSession({ userId: PROGRAMMER.id, credentialId });
        await expect(findActiveSession(directSession.rawToken)).resolves.toBeNull();
        await expect(touchSession(directSession.id)).resolves.toBe(false);
    });

    it('treats the configured order-intake actor as a decoy even with a registered credential', async () => {
        const previousActorId = process.env.ORDER_INTAKE_ACTOR_USER_ID;
        const key = createBrowserKey();
        await insertCredential(SEED.cashierUser.id, key.publicKey, 'Forbidden intake actor browser');
        try {
            delete process.env.ORDER_INTAKE_ACTOR_USER_ID;
            const issuedBeforeReservation = await request(app)
                .post('/api/auth/webauthn/login/options')
                .set('Origin', ORIGIN)
                .send({ user_number: SEED.cashierUser.user_number });
            process.env.ORDER_INTAKE_ACTOR_USER_ID = String(SEED.cashierUser.id);
            const rejectedAfterReservation = await request(app)
                .post('/api/auth/webauthn/login/verify')
                .set('Origin', ORIGIN)
                .send({
                    ceremony_id: issuedBeforeReservation.body.ceremony_id,
                    signature: sign(key.privateKey, issuedBeforeReservation.body.message),
                });
            expect(rejectedAfterReservation.statusCode).toBe(401);
            expect(rejectedAfterReservation.body.code).toBe('WEBAUTHN_AUTHENTICATION_FAILED');

            const options = await request(app)
                .post('/api/auth/webauthn/login/options')
                .set('Origin', ORIGIN)
                .send({ user_number: SEED.cashierUser.user_number });
            expect(options.statusCode).toBe(200);
            const [[ceremony]] = await pool.query('SELECT user_id FROM webauthn_ceremonies WHERE id=?', [options.body.ceremony_id]);
            expect(ceremony).toBeUndefined();

            const verified = await request(app)
                .post('/api/auth/webauthn/login/verify')
                .set('Origin', ORIGIN)
                .send({ ceremony_id: options.body.ceremony_id, signature: sign(key.privateKey, options.body.message) });
            expect(verified.statusCode).toBe(401);
            expect(verified.body.code).toBe('WEBAUTHN_AUTHENTICATION_FAILED');
            const [[sessions]] = await pool.query('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
            expect(Number(sessions.count)).toBe(0);
        } finally {
            if (previousActorId == null) delete process.env.ORDER_INTAKE_ACTOR_USER_ID;
            else process.env.ORDER_INTAKE_ACTOR_USER_ID = previousActorId;
        }
    });

    it('does not create a session when the user is deactivated after options are issued', async () => {
        const key = createBrowserKey();
        await insertCredential(SEED.cashierUser.id, key.publicKey, 'Counter browser');
        const options = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });

        await pool.query('UPDATE users SET is_active=0 WHERE id=?', [SEED.cashierUser.id]);
        try {
            const verified = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({
                ceremony_id: options.body.ceremony_id,
                signature: sign(key.privateKey, options.body.message),
            });
            expect(verified.statusCode).toBe(401);
            expect(verified.body.code).toBe('WEBAUTHN_AUTHENTICATION_FAILED');
            const [[sessions]] = await pool.query('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
            expect(Number(sessions.count)).toBe(0);
        } finally {
            await pool.query('UPDATE users SET is_active=1 WHERE id=?', [SEED.cashierUser.id]);
        }
    });

    it('revalidates cached-session eligibility after direct database mutations', async () => {
        await pool.query("UPDATE settings SET setting_value='staged' WHERE setting_key='staff_device_auth_mode'");
        invalidateAuthModeCache();
        const inactiveSession = await createSession({ userId: SEED.cashierUser.id });
        await pool.query('UPDATE users SET is_active=0 WHERE id=?', [SEED.cashierUser.id]);
        await expect(touchSession(inactiveSession.id)).resolves.toBe(false);
        await pool.query('UPDATE users SET is_active=1 WHERE id=?', [SEED.cashierUser.id]);

        const key = createBrowserKey();
        const credentialId = await insertCredential(SEED.cashierUser.id, key.publicKey, 'Revoked cache credential');
        const credentialSession = await createSession({ userId: SEED.cashierUser.id, credentialId });
        await pool.query("UPDATE webauthn_credentials SET status='revoked', revoked_at=CURRENT_TIMESTAMP WHERE id=?", [credentialId]);
        await expect(touchSession(credentialSession.id)).resolves.toBe(false);

        const unboundSession = await createSession({ userId: SEED.cashierUser.id });
        await pool.query("UPDATE settings SET setting_value='enforced' WHERE setting_key='staff_device_auth_mode'");
        invalidateAuthModeCache();
        await expect(touchSession(unboundSession.id)).resolves.toBe(true);
        await insertCredential(SEED.cashierUser.id, createBrowserKey().publicKey, 'Enforced cache credential');
        await expect(touchSession(unboundSession.id)).resolves.toBe(false);
    });

    it('allows one browser key to be independently bound to users without sharing their slots', async () => {
        const shared = createBrowserKey();
        await insertCredential(SEED.cashierUser.id, shared.publicKey, 'Shared counter');
        await insertCredential(SEED.adminUser.id, shared.publicKey, 'Shared counter');

        for (const user of [SEED.cashierUser, SEED.adminUser]) {
            const options = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: user.user_number });
            const verified = await request(app).post('/api/auth/webauthn/login/verify').set('Origin', ORIGIN).send({ ceremony_id: options.body.ceremony_id, signature: sign(shared.privateKey, options.body.message) });
            expect(verified.statusCode).toBe(200);
            expect(verified.body.user.id).toBe(user.id);
        }
        const [rows] = await pool.query("SELECT user_id, COUNT(*) AS count FROM webauthn_credentials WHERE status='active' GROUP BY user_id ORDER BY user_id");
        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ user_id: SEED.adminUser.id, count: 1 }),
            expect.objectContaining({ user_id: SEED.cashierUser.id, count: 1 }),
        ]));
    });
});
